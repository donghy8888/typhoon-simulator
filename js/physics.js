/**
 * 台风运动与强度物理（简化但可感真实）
 */
(function (global) {
  'use strict';

  const G = global.TyGeo;
  const DISSIPATE_MS = 13.9; // 7级下限

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /** 海温决定的最大潜在强度 (m/s)；暖海须能撑到 SSHWS Cat5（≥70.5） */
  function mpi(sst) {
    if (sst < 26.0) return 18;
    if (sst < 26.5) return 22;
    if (sst < 28.0) return 28 + (sst - 26.5) * (40 / 3); // 26.5→28, 28→48
    // 28℃→48 · 29.5℃→72 · 30℃→80（菲律宾海 29.5 可过 Cat5 ≥70.5）
    return 48 + (sst - 28) * 16;
  }

  /** 最短路径角度插值（弧度） */
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
  }

  /** 最短航向 Bezier（弧度） */
  function bezierHeading(a0, a1, a2, t) {
    const ab = lerpAngle(a0, a1, t);
    const bc = lerpAngle(a1, a2, t);
    return lerpAngle(ab, bc, t);
  }

  function smoothstep(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** C2 缓入缓出：半弧航向更圆，端点二阶连续，少棱角 */
  function smootherstep(t) {
    t = clamp(t, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * 是否贴在副高北缘 fringe（实体内，或外侧近邻探测到红区）。
   * 深 fringe 可用较长预备抬升；可见转向几何不依赖此门控。
   */
  function nearNorthernFugenFringe(lon, lat, fugenList, hole) {
    if (G.inFugenSolid(lon, lat, fugenList, hole)) return true;
    const probes = [
      [0, 0.15], [0, -0.15], [0.15, 0], [-0.15, 0],
      [0, 0.35], [0, -0.35], [0.35, 0], [-0.35, 0],
      [0, 0.55], [0, -0.55]
    ];
    for (const [dlon, dlat] of probes) {
      if (G.inFugenSolid(lon + dlon, lat + dlat, fugenList, hole)) return true;
    }
    return false;
  }

  /**
   * 引导气流（绿线 = guidingNorthernEdgeLat；黄线 = 绿线南 0.15°≈50km）
   *
   * 分区（20261026f）：
   *   黄线以南 (northOf < −0.15)：明确 WNW 西北偏西（|u|>v，西多于北；非 NNW）
   *   黄→绿 (−0.15 ≤ northOf < 0)：纯往北 u≡0（锁存腿）
   *   绿线以北：NE 稍微偏东 ≈45° from N；杀深 ENE / 大 u；
   *             转向再稍微大一点 life Δlon≈12–14（相对 26e ~10；仍非旧 20°）；
   *             半圆光滑半弧：曲率连续 due-N→NE，无 tip kink / 棱角（20261028n 再圆）。
   *
   * 状态机（arcState）：
   *   A) 首次进入绿南 ~0.22°：legTargetLat=max(edge,lat+0.15)，u≡0 往北直到越过；
   *   B) 越过后锁存 arcLat0，常数曲率半圆 N→NE（不因 edge 回追重置）。
   */
  const NORTH_LEG_DEG = 0.15;
  const RECURVE_ARC_DEG = 7.0;
  const POST_GREEN_ARC_DEG = 5.9;  // 半弧 lat 再拉长：同 Δheading 更圆、少棱角
  const TARGET_ARC_DLON_DEG = 14.8; // life Δlon≈12–14（分区/目标不变）
  const ARC_BOW_LON_DEG = 5.8;     // 东鼓略收：中段鼓包别成折肩
  /** atan2(v,u)≈45° → 地理约 45° from N（NE 稍微偏东） */
  const NE_TARGET_HDG = 45 * Math.PI / 180;
  /** 下限：勿扁成东北偏东（atan2 过小 / fromN 过大 / 深 ENE） */
  const NE_MIN_HDG = 42 * Math.PI / 180;
  /** 上限：半弧前半可略偏北，但尽快到 NE */
  const NE_MAX_HDG = 52 * Math.PI / 180;
  /** 提前锁存往北腿，防西缘圆角 edge 突降跳过黄→绿带 */
  const LEG_TRIGGER_DEG = 0.55;
  /** 越绿后短净空再接 N→NE 半弧（略加长，避免竖段→弯瞬间折尖） */
  const CLEAR_NORTH_DEG = 0.10;
  const CLEAR_LAT_MIN = 0;
  const CLEAR_NORTHOF_MIN = 0.06;

  function approachNorthUV(northOf, band, spdW) {
    const u = 0;
    let v = Math.max(5.8, spdW * 0.72);
    if (v < 0) v = 0;
    return { u, v, ta: clamp((northOf + band) / Math.max(1e-9, band), 0, 1) };
  }

  function enforceNeHeading(u, v, s) {
    // 半圆：只拦深 ENE（MIN）；勿用 MAX 把前半段从 due-N 瞬间夹到 ~52°（那就是 tip kink）
    if (u < 0) u = 0;
    if (v < 0) v = 0;
    if (s < 0.04 || u <= 0.08) return { u, v };
    let h = Math.atan2(v, u);
    const spd = Math.hypot(u, v) || 1;
    // 仅在弧中后段防止扁成东北偏东；前半保持常数曲率半圆
    if (s >= 0.55 && h < NE_MIN_HDG) {
      u = Math.cos(NE_MIN_HDG) * spd;
      v = Math.sin(NE_MIN_HDG) * spd;
    }
    return { u, v };
  }

  function postGreenArcUV(sRaw, lat, wU, wVE, spdW) {
    const s = clamp(sRaw, 0, 1);
    const ang0 = Math.PI * 0.5; // due-N 接竖段（C1：s=0 时 u≈0, dθ/ds≈0）
    const angEnd = NE_TARGET_HDG; // NE ≈45° from N
    // 半圆参数：smootherstep = 端点 C2，中段更圆，少棱角/折肩
    // （相对 cosine 再软一点；相对 pow 前载不会在绿线折尖）
    const te = smootherstep(s);
    let ang = lerpAngle(ang0, angEnd, te);
    const spd = Math.max(spdW * 1.12, 9.2);
    let u = Math.cos(ang) * spd;
    let v = Math.sin(ang) * spd;
    // 半椭圆东鼓：前段 lat 主导、东鼓稍后抬头 → 圆角半弧而非折肩
    const sBow = Math.pow(s, 1.25);
    const bowU = (1.05 * ARC_BOW_LON_DEG) * Math.sin(Math.PI * sBow);
    u += bowU;
    const uCap = Math.cos(NE_MIN_HDG) * spd + ARC_BOW_LON_DEG * (0.50 + 0.40 * Math.sin(Math.PI * sBow));
    if (u > uCap) u = uCap;
    if (s >= 0.28) ({ u, v } = enforceNeHeading(u, v, s));
    else {
      if (u < 0) u = 0;
      if (v < 0) v = 0;
    }
    return { u, v, s };
  }

  function ensureLegTarget(northOf, lat, edge, arcState) {
    if (!arcState) return null;
    if (arcState.legTargetLat != null) return arcState.legTargetLat;
    // 进入黄线附近即锁存：目标至少到绿线，且自当前位置再抬 ≥0.15°，
    // 防止西缘圆角 edge 突降 / 单步跨带导致看不见纯北段。
    if (northOf >= -LEG_TRIGGER_DEG && northOf < 0) {
      arcState.legTargetLat = Math.max(edge + 0.02, lat + NORTH_LEG_DEG);
      return arcState.legTargetLat;
    }
    if (northOf >= 0) {
      // 已越绿仍未锁：强制再抬一段纯北，再进入 NE 弧
      arcState.legTargetLat = lat + NORTH_LEG_DEG;
      return arcState.legTargetLat;
    }
    return null;
  }

  function arcProgress(lat, lon, arcState, write) {
    if (!arcState) return 0;
    if (arcState.arcLat0 == null) {
      arcState.arcLat0 = lat;
      arcState.arcLon0 = lon;
      if (arcState.sAcc == null) arcState.sAcc = 0;
    }
    if (arcState.arcLon0 == null) arcState.arcLon0 = lon;
    const sLat = (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG;
    const sLon = (lon - arcState.arcLon0) / TARGET_ARC_DLON_DEG;
    // 半圆振幅：lon 主导收束；sAcc 每步限幅更小 → 航向连续、少棱角
    let s = clamp(Math.max(sLat * 0.55, sLon * 0.90), 0, 1);
    s = clamp(Math.min(s, (arcState.sAcc || 0) + 0.055), 0, 1);
    if (write) arcState.sAcc = Math.max(arcState.sAcc || 0, s);
    return s;
  }

  function approachBendUV(northOf, arcDeg, wU, wVE, spdW) {
    const band = (typeof G !== 'undefined' && G.APPROACH_NORTH_BAND_DEG) ? G.APPROACH_NORTH_BAND_DEG : 0.15;
    if (northOf >= 0) {
      return postGreenArcUV(northOf / POST_GREEN_ARC_DEG, 30, wU, wVE, spdW);
    }
    return approachNorthUV(northOf, band, spdW);
  }

  /**
   * @param {object} [arcState] 可选：{ arcLat0 } 以首次越过绿线的纬度为弧原点，
   *   避免西缘 edge 跳动把 northOf 瞬间抬到 1+、跳过半弧并在绿线造成 tip。
   */
  function steeringAt(lon, lat, cfg, fugenList, hole, arcState) {
    let u = cfg.steerU;
    let v = cfg.steerV;

    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = (typeof G !== 'undefined' && G.APPROACH_NORTH_BAND_DEG) ? G.APPROACH_NORTH_BAND_DEG : 0.15;
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42);
      const spdW = Math.hypot(wU, wVE);
      const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);

      const legTarget = ensureLegTarget(northOf, lat, edge, arcState);
      const inNorthLeg = legTarget != null && lat < legTarget;
      const arcActive = !!(arcState && arcState.arcLat0 != null) ||
        (legTarget != null && lat >= legTarget);

      if (inNorthLeg) {
        const b = approachNorthUV(northOf, band, spdW);
        u = 0;
        v = b.v;
      } else if (arcActive || northOf >= 0) {
        // 绿北：短净空后 N→NE；无 arcState 时按 northOf 直接给箭头/场
        const clearLat = Math.max(
          (arcState && arcState.legTargetLat != null ? arcState.legTargetLat : edge) + CLEAR_NORTH_DEG,
          edge + CLEAR_NORTH_DEG
        );
        const cleared = lat >= clearLat || northOf >= CLEAR_NORTHOF_MIN;
        const needClear = arcState && (arcState.clearLon0 == null) && !cleared && arcActive;
        if (needClear) {
          const base = arcState.arcLat0 != null ? arcState.arcLat0 : lat;
          const span = Math.max(1e-3, clearLat - base);
          const tc = clamp((lat - base) / span, 0, 1);
          const spd = Math.max(spdW, 8.0);
          // 极短净空：保持近正北，半圆弧 s=0 处以 due-N 连续接入（无尖角）
          u = spd * (0.005 * smoothstep(tc));
          v = spd * (0.999 - 0.01 * smoothstep(tc));
        } else {
          const s = arcState
            ? arcProgress(lat, lon, arcState, false)
            : clamp(northOf / POST_GREEN_ARC_DEG, 0, 1);
          if (s < 1) {
            const b = postGreenArcUV(s, lat, wU, wVE, spdW);
            u = b.u;
            v = b.v;
          } else {
            // 收束在东北稍微偏东，不落到满 ENE；略提速攒 life Δlon
            const spd = Math.max(spdW * 1.12, 11.0);
            u = Math.cos(NE_TARGET_HDG) * spd;
            v = Math.sin(NE_TARGET_HDG) * spd;
          }
        }
      } else if (northOf < -band) {
        // 黄线以南：明确 WNW 西北偏西（西分量 ≥ 北分量），非 NNW 西北偏北
        const t = clamp((northOf + RECURVE_ARC_DEG) / (RECURVE_ARC_DEG - band), 0, 1);
        const te = smoothstep(t);
        let uBase = Math.min(u, 0);
        if (uBase < -4.2) uBase = -4.2 + (uBase + 4.2) * 0.28;
        // 目标 hdg≈140–150（地理 ~300–310° / fromN≈−50~−60）：u≈−4.35~−6.5，v≈3.5~4.2（略更西仍 WNW）
        u = uBase * (1 - 0.1 * te) - 4.35 * te;
        v = Math.max(v, 0) * (1 - 0.55 * te) + (3.4 + 0.8 * te) * te;
        if (u < -6.5) u = -6.5;
        if (u > -4.5 && te > 0.18) u = -4.5 - 1.5 * te; // 西分量主导
        if (v > 4.5) v = 4.5;
        if (Math.abs(u) < v * 1.15) u = -Math.max(v * 1.15, 4.0); // |u|≥v → WNW not NNW
      }

      if (inNorthLeg) {
        u = 0;
      } else if (northOf < 0 && !arcActive) {
        if (northOf >= -band) u = 0;          // 黄→绿：纯北
        else u = Math.min(u, 0);              // 黄南：不许东
      }
    } else if (lat >= 32) {
      // 无绿线兜底：东北稍微偏东
      const spd = Math.max(Math.hypot(cfg.westerlyU, 2.2), 8);
      u = Math.cos(NE_TARGET_HDG) * spd;
      v = Math.sin(NE_TARGET_HDG) * spd;
    }

    const arcOn = !!(arcState && (
      (arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) ||
      (arcState.arcLat0 != null && arcState.clearLon0 == null)
    ));
    if (G.inFugenSolid(lon, lat, fugenList, hole)) {
      if (arcState && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) {
        // NE 半弧：轻阻尼；勿强推东
        u *= 0.9;
        v *= 0.9;
      } else if (arcOn) {
        v = Math.max(v, 8.0);
        u = Math.max(0, Math.min(u, 4.0));
      } else {
        u *= 0.58;
        v *= 0.58;
      }
    }
    // 台湾中央山脉弱吸引（显示场 + 与运动同源）
    const twA = taiwanMtnAttract(lon, lat);
    if (twA.applied) {
      u += twA.u;
      v += twA.v;
    }
    return { u, v };
  }

  function betaDrift(lat, strength) {
    const f = clamp(lat / 25, 0.3, 1.2);
    const speed = 1.2 * strength * f;
    return { u: -0.75 * speed, v: 0.85 * speed };
  }

  /**
   * 台湾中央山脉弱吸引（?v=20261028f）
   * 东岸（脊东）才触发：往岛内/中央山脉极弱拽；峰值仍 0.85，不压过引导。
   * 东北引导占优时表现为「先往山脉轻轻折一下再东北」。
   * 只改运动叠加，不改副高/黄绿线/陆地衰减/风圈缩放；单台风。
   */
  const TW_MTN_LON = 121.15;   // 中央山脉示意中心经度
  const TW_MTN_LAT = 23.55;    // 中央山脉示意中心纬度
  const TW_MTN_R_DEG = 3.8;    // 影响半径（°）— 覆盖东岸外海至 ~125E
  const TW_MTN_PEAK_MS = 0.85; // 峰值吸引 (m/s)；勿加档
  const TW_MTN_POWER = 1.5;    // (1−r/R)^p 远端很快≈0
  const TW_MTN_LAT0 = 21.2;    // 纬度门控：台湾岛段
  const TW_MTN_LAT1 = 26.2;
  /** 东岸硬门控：必须脊东（lon>脊），海峡/脊西不触发；与旧 120.85 软门区分 */
  const TW_MTN_EAST_GATE_LON = TW_MTN_LON;

  function taiwanMtnAttract(lon, lat) {
    if (lat < TW_MTN_LAT0 || lat > TW_MTN_LAT1) {
      return { u: 0, v: 0, mag: 0, dist: null, applied: false };
    }
    // 硬条件：只在中央山脉以东（东岸/外海）。旧版 GATE=120.85 让脊西也有权重，且易与
    // 引导锁存叠加后看不出「朝山」；脊西应完全关闭，避免海峡侧被拽回。
    if (!(lon > TW_MTN_EAST_GATE_LON)) {
      return { u: 0, v: 0, mag: 0, dist: null, applied: false };
    }
    // 脊东 0→1° 升到满权，东岸附近必生效
    const eastW = smoothstep((lon - TW_MTN_EAST_GATE_LON) / 1.0);
    if (eastW < 1e-3) {
      return { u: 0, v: 0, mag: 0, dist: null, applied: false };
    }
    const cos = Math.cos(TW_MTN_LAT * Math.PI / 180) || 1e-6;
    const dx = (lon - TW_MTN_LON) * cos; // 等面积平面：东为正（此处必 >0）
    const dy = lat - TW_MTN_LAT;
    const dist = Math.hypot(dx, dy);
    if (!(dist < TW_MTN_R_DEG) || dist < 1e-6) {
      return { u: 0, v: 0, mag: 0, dist, applied: false };
    }
    const tNorm = 1 - dist / TW_MTN_R_DEG;
    const envelope = Math.pow(Math.max(0, tNorm), TW_MTN_POWER) * eastW;
    const mag = TW_MTN_PEAK_MS * envelope;
    // 指向中央山脉（靠拢）：东岸 → 西向 u<0
    const u = mag * (-dx / dist);
    const v = mag * (-dy / dist);
    return { u, v, mag, dist, eastW, applied: mag > 1e-4 };
  }

  /** 平滑副高法向（指向实体内部）。多点加权，抑制多边形折角造成的法向翻转。 */
  function smoothedInwardNormal(lon, lat, fugenList, hole) {
    const samples = [
      [0, 0, 1.0],
      [0.25, 0, 0.55], [-0.25, 0, 0.55],
      [0, 0.25, 0.55], [0, -0.25, 0.55],
      [0.45, 0.15, 0.35], [-0.45, 0.15, 0.35],
      [0.45, -0.15, 0.35], [-0.45, -0.15, 0.35]
    ];
    let gx = 0, gy = 0, wSum = 0;
    for (const [dx, dy, w] of samples) {
      const g = G.fugenGradient(lon + dx, lat + dy, fugenList, hole);
      gx += g.gx * w;
      gy += g.gy * w;
      wSum += w;
    }
    gx /= wSum;
    gy /= wSum;
    let gl = Math.hypot(gx, gy);
    if (gl < 1e-6) return null;
    return { nx: gx / gl, ny: gy / gl, gl };
  }

  /** 从副高实体内小步推出（细步；仅在真穿入后加外侧微间隙） */
  function pushOutOfFugen(lon, lat, fugenList, hole, maxIter) {
    maxIter = maxIter || 28;
    const step = 0.045;
    let wasInside = G.inFugenSolid(lon, lat, fugenList, hole);
    for (let k = 0; k < maxIter; k++) {
      if (!G.inFugenSolid(lon, lat, fugenList, hole)) break;
      wasInside = true;
      const n = smoothedInwardNormal(lon, lat, fugenList, hole);
      if (!n) {
        lon -= 0.06;
        lat -= 0.04;
      } else {
        lon -= n.nx * step;
        lat -= n.ny * step;
      }
    }
    // 仅当本步确实从实体内推出时加微间隙；远处有梯度也绝不能外推（否则黄南北进被吃掉）
    if (wasInside && !G.inFugenSolid(lon, lat, fugenList, hole)) {
      const n = smoothedInwardNormal(lon, lat, fugenList, hole);
      if (n) {
        lon -= n.nx * 0.03;
        lat -= n.ny * 0.03;
      }
    }
    return { lon, lat };
  }

  /**
   * 穿入时沿边界裁剪并切向滑行（保留原步长），替代硬推出造成的锯齿尖角。
   * 绿北半弧（bowOn）不调用。
   */
  function clipAndSlide(lon, lat, nlon, nlat, u, v, fugenList, hole) {
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const southOfGreen = edge != null && lat < edge;

    if (!G.inFugenSolid(nlon, nlat, fugenList, hole)) {
      // 已在外侧：若几乎贴边，略外推保持间隙，不反向折返
      if (G.inFugenSolid(nlon, nlat + 0.08, fugenList, hole) ||
          G.inFugenSolid(nlon + 0.08, nlat, fugenList, hole) ||
          G.inFugenSolid(nlon - 0.08, nlat, fugenList, hole) ||
          G.inFugenSolid(nlon, nlat - 0.08, fugenList, hole)) {
        const n = smoothedInwardNormal(nlon, nlat, fugenList, hole);
        if (n) {
          nlon -= n.nx * 0.03;
          nlat -= n.ny * 0.03;
        }
      }
      return { lon: nlon, lat: nlat };
    }

    const stepLon = nlon - lon;
    const stepLat = nlat - lat;
    const stepLen = Math.hypot(stepLon, stepLat);
    // 二分找线段上最远的外侧点
    let lo = 0, hi = 1;
    let freeLon = lon, freeLat = lat;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) * 0.5;
      const mx = lon + stepLon * mid;
      const my = lat + stepLat * mid;
      if (G.inFugenSolid(mx, my, fugenList, hole)) hi = mid;
      else {
        lo = mid;
        freeLon = mx;
        freeLat = my;
      }
    }
    if (G.inFugenSolid(freeLon, freeLat, fugenList, hole) ||
        (Math.abs(freeLon - lon) < 1e-9 && Math.abs(freeLat - lat) < 1e-9 &&
         G.inFugenSolid(lon, lat, fugenList, hole))) {
      ({ lon: freeLon, lat: freeLat } = pushOutOfFugen(lon, lat, fugenList, hole));
    }

    const used = Math.hypot(freeLon - lon, freeLat - lat);
    let remain = Math.max(0, stepLen - used);
    const n = smoothedInwardNormal(freeLon, freeLat, fugenList, hole);
    if (!n || remain < 1e-6) {
      return pushOutOfFugen(freeLon, freeLat, fugenList, hole);
    }

    // 切向（与原速度同号）
    let tx = -n.ny, ty = n.nx;
    if (u * tx + v * ty < 0) { tx = -tx; ty = -ty; }

    // 绿南贴南缘：切向滑行混入原步进方向，保留北分量，避免纯西锯齿爬行
    let dx, dy;
    if (southOfGreen) {
      const ol = Math.hypot(stepLon, stepLat) || 1;
      const ox = stepLon / ol, oy = stepLat / ol;
      dx = 0.72 * tx + 0.28 * ox;
      dy = 0.72 * ty + 0.28 * oy;
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      // 南缘：法向约向北，略外推（向南）+ 保北向下限
      if (dy < 0.25 && oy > 0) dy = 0.25;
      const dl2 = Math.hypot(dx, dy) || 1;
      dx /= dl2; dy /= dl2;
    } else {
      dx = tx; dy = ty;
    }

    let sx = freeLon - n.nx * 0.035 + dx * remain;
    let sy = freeLat - n.ny * 0.035 + dy * remain;
    if (G.inFugenSolid(sx, sy, fugenList, hole)) {
      let rLo = 0, rHi = remain;
      sx = freeLon - n.nx * 0.035;
      sy = freeLat - n.ny * 0.035;
      for (let k = 0; k < 10; k++) {
        const mid = (rLo + rHi) * 0.5;
        const mx = freeLon - n.nx * 0.035 + dx * mid;
        const my = freeLat - n.ny * 0.035 + dy * mid;
        if (G.inFugenSolid(mx, my, fugenList, hole)) rHi = mid;
        else {
          rLo = mid;
          sx = mx;
          sy = my;
        }
      }
    }
    return { lon: sx, lat: sy };
  }

  /** 贴边时只去掉穿入分量，保留原引导风切向，轻柔外推——避免巨尺状折线。
   *  关键：绿线以南的北缘接近（N→ENE 弧窗）不得被 lat+ε “near” 探测掐掉北向，
   *  否则主脊下路径会竖直贴边后尖折成 ENE，大半圆永远看不见。
   *  20261027b：南缘滑行时外推更轻、法向更平滑，配合 clipAndSlide 消锯齿。
   */
  function slideAlongFugen(lon, lat, u, v, fugenList, hole) {
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const southOfGreen = edge != null && lat < edge;
    const probes = [0.35, 0.7, 1.05];
    let hit = false;
    for (const probe of probes) {
      const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
      if (G.inFugenSolid(lon + dlon * probe, lat + dlat * probe, fugenList, hole)) {
        hit = true;
        break;
      }
    }
    // 绿线以南：只用真实将穿入的 hit；勿用 lat+0.15 near 软修正（那会剥掉往北弧）
    const near = !southOfGreen && (
      G.inFugenSolid(lon, lat + 0.15, fugenList, hole) ||
      G.inFugenSolid(lon + 0.15, lat, fugenList, hole) ||
      G.inFugenSolid(lon - 0.15, lat, fugenList, hole) ||
      G.inFugenSolid(lon, lat - 0.15, fugenList, hole)
    );

    if (!hit && !near) return { u, v };

    const n = smoothedInwardNormal(lon, lat, fugenList, hole);
    if (!n) return { u, v };
    const nx = n.nx, ny = n.ny;

    // 去掉向内法向分量。绿南贴南缘时只去掉部分北向穿入，保留 WNW 北分量，
    // 否则路径会贴南缘纯西爬行，拖到南海脊经度触发假“绿北”尖折。
    const into = u * nx + v * ny;
    if (into > 0) {
      const strip = southOfGreen ? 0.55 : 1.0;
      u -= into * strip * nx;
      v -= into * strip * ny;
    }
    // 外推：绿南更轻，避免南北弹跳；仍靠 clipAndSlide 保外侧间隙
    const outKick = southOfGreen ? 0.08 : 0.28;
    u -= nx * outKick;
    v -= ny * outKick;

    // 切向：保持原速度在切向上的投影
    const tx = -ny, ty = nx;
    let along = u * tx + v * ty;
    if (Math.abs(along) < 0.55) {
      const prefer = along >= 0 ? 1 : -1;
      const boost = southOfGreen ? 2.8 : 2.4;
      along = boost * prefer;
      u = tx * along - nx * outKick;
      v = ty * along - ny * outKick;
    }

    // 绿南：强制保持 WNW 北分量下限，路径沿南缘斜上而非锯齿纯西
    if (southOfGreen) {
      if (v < 2.8) v = 2.8;
      if (u > -3.2) u = Math.min(u, -3.2);
      // 仍禁止明显穿入
      const into2 = u * nx + v * ny;
      if (into2 > 0.45) {
        u -= (into2 - 0.2) * nx;
        v -= (into2 - 0.2) * ny;
      }
    }

    const spd = Math.hypot(u, v);
    const maxSpd = 14;
    if (spd > maxSpd) {
      u *= maxSpd / spd;
      v *= maxSpd / spd;
    }
    return { u, v };
  }

  /** 步间航向限幅：抑制 fringe/slide 造成的尖角折转 */


  function blendHeading(prevU, prevV, u, v, maxTurnDeg) {
    if (prevU == null || prevV == null) return { u, v };
    const spd0 = Math.hypot(prevU, prevV);
    const spd1 = Math.hypot(u, v);
    if (spd0 < 0.2 || spd1 < 0.2) return { u, v };
    const a0 = Math.atan2(prevV, prevU);
    const a1 = Math.atan2(v, u);
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const maxRad = (maxTurnDeg * Math.PI) / 180;
    if (Math.abs(d) <= maxRad) return { u, v };
    const a = a0 + Math.sign(d) * maxRad;
    const spd = 0.65 * spd1 + 0.35 * spd0;
    return { u: Math.cos(a) * spd, v: Math.sin(a) * spd };
  }

  function moveStepOnce(lon, lat, vmax, dtHours, cfg, fugenList, hole, arcState) {
    ({ lon, lat } = pushOutOfFugen(lon, lat, fugenList, hole));

    const st = steeringAt(lon, lat, cfg, fugenList, hole, arcState);
    const beta = betaDrift(lat, cfg.betaStrength);
    let u = st.u + beta.u;
    let v = st.v + beta.v;

    ({ u, v } = slideAlongFugen(lon, lat, u, v, fugenList, hole));

    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG;
    const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42);
      const spdW = Math.hypot(wU, wVE);
      const legTarget = ensureLegTarget(northOf, lat, edge, arcState);
      const inNorthLeg = legTarget != null && lat < legTarget;
      const arcActive = !!(arcState && arcState.arcLat0 != null) ||
        (legTarget != null && lat >= legTarget);

      if (inNorthLeg) {
        const b = approachNorthUV(northOf, band, spdW);
        u = 0;
        v = Math.max(b.v, 5.5);
      } else if (arcActive) {
        const clearLat = (arcState.legTargetLat != null ? arcState.legTargetLat : edge) + CLEAR_NORTH_DEG;
        const cleared = lat >= clearLat || northOf >= CLEAR_NORTHOF_MIN;
        const needClear = (arcState.clearLon0 == null) && !cleared;
        if (needClear) {
          if (arcState.arcLat0 == null) {
            arcState.arcLat0 = lat;
            arcState.arcLon0 = lon;
            if (arcState.sAcc == null) arcState.sAcc = 0;
          }
          const span = Math.max(1e-3, clearLat - arcState.arcLat0);
          const tc = clamp((lat - arcState.arcLat0) / span, 0, 1);
          const spd = Math.max(spdW, 8.0);
          // 极短净空：近正北，半圆弧以 due-N 连续接入（无 tip kink）
          u = spd * (0.005 * smoothstep(tc));
          v = Math.max(spd * (0.999 - 0.01 * smoothstep(tc)), 7.5);
          if (G.inFugenSolid(lon, lat, fugenList, hole) || northOf < 0.35) {
            u = Math.min(u, spd * 0.04);
            v = Math.max(v, 9.0);
          }
        } else {
          if (arcState.clearLon0 == null) {
            arcState.clearLon0 = lon;
            arcState.clearLat0 = lat;
            arcState.arcLat0 = lat;
            arcState.arcLon0 = lon;
            arcState.sAcc = 0;
          }
          const s = arcProgress(lat, lon, arcState, true);
          if (s < 1) {
            const b = postGreenArcUV(s, lat, wU, wVE, spdW);
            // β 漂移轻微；勿把西向吃掉东北的东分量
            u = b.u + beta.u * 0.05 * smoothstep(s);
            v = b.v + beta.v * 0.08;
            ({ u, v } = enforceNeHeading(u, v, s));
          } else {
            // 弧末柔接入 NE 巡航：去掉 +2 东踢，避免收束折尖
            const spd = Math.max(spdW * 1.12, 11.0);
            u = Math.cos(NE_TARGET_HDG) * spd + beta.u * 0.05 + 0.55;
            v = Math.sin(NE_TARGET_HDG) * spd + beta.v * 0.08;
            ({ u, v } = enforceNeHeading(u, v, 1));
          }
        }
      } else if (northOf < -band) {
        // 黄南：明确 WNW（西 ≥ 北），非 NNW
        let uBase = Math.min(u, 0);
        if (uBase < -4.2) uBase = -4.2 + (uBase + 4.2) * 0.28;
        u = Math.min(Math.max(uBase, -6.5) - 2.6, -4.5);
        if (u < -6.5) u = -6.5;
        v = Math.min(Math.max(v * 0.72 + 0.5, 3.2), 4.4);
        if (Math.abs(u) < v * 1.15) u = -Math.max(v * 1.15, 4.0);
        // 接近黄线时渐收西向（不抬北速），避免 WNW→正北硬折，并保留黄→绿纯北腿
        // 接近黄线更早收西向：WNW→纯北过渡更圆（分区不变）
        const ease = clamp((-band - northOf) / 1.15, 0, 1);
        u *= smootherstep(ease);
      }
    }
    if (edge != null) {
      const northOf = lat - edge;
      const legTarget = arcState && arcState.legTargetLat;
      const inNorthLeg = legTarget != null && lat < legTarget;
      const arcActive = !!(arcState && arcState.arcLat0 != null);
      if (inNorthLeg) {
        u = 0;
      } else if (!arcActive && northOf < 0) {
        if (northOf >= -band) u = 0;
        else u = Math.min(u, 0);
      }
    }

    // 台湾中央山脉弱吸引：必须叠在全部引导锁存/WNW·NE 改写之后，否则会被盖掉（表现为「不触发」）
    // 东北占优时 u>0，叠上西向吸引 → 路径先往山脉轻轻折一下再继续东北
    {
      const twA = taiwanMtnAttract(lon, lat);
      if (twA.applied) {
        const inNorthLeg = arcState && arcState.legTargetLat != null && lat < arcState.legTargetLat;
        if (inNorthLeg) {
          // 纯北腿：允许西向（朝山）极弱先折；禁止东向破坏 u≡0
          if (twA.u < 0) u += twA.u;
          v += twA.v;
        } else {
          u += twA.u;
          v += twA.v;
        }
      }
    }

    const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
    let stepLon = dlon * dtHours;
    let stepLat = dlat * dtHours;
    let stepLim = 0.55;
    if (edge != null) {
      const northOf = lat - edge;
      const dist = Math.abs(northOf);
      const inLeg = arcState && arcState.legTargetLat != null && lat < arcState.legTargetLat;
      const arcOn = !!(arcState && arcState.arcLat0 != null);
      const sArc = arcOn
        ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
        : northOf / POST_GREEN_ARC_DEG;
      // 细步：往北腿 + 接近黄线，防圆角 tip 跳过黄→绿纯北段
      if (inLeg) stepLim = 0.018;
      else if (!arcOn && northOf >= -LEG_TRIGGER_DEG && northOf < 0) stepLim = 0.02;
      else if (!arcOn && dist <= band + 0.35) stepLim = 0.035;
      else if (arcOn && arcState.clearLon0 == null) stepLim = 0.06; // 短净空更细
      else if (arcOn && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) stepLim = 0.12; // 半弧细步：少折线棱角
      else if (northOf >= 0 && sArc <= 1.05) stepLim = 0.10;
      else if (dist <= 3.0) stepLim = 0.16;
    }
    const stepMag = Math.hypot(stepLon, stepLat);
    if (stepMag > stepLim) {
      stepLon *= stepLim / stepMag;
      stepLat *= stepLim / stepMag;
    }
    let nlon = lon + stepLon;
    let nlat = lat + stepLat;
    const bowOn = !!(arcState && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1);
    const clearOn = !!(arcState && arcState.arcLat0 != null && arcState.clearLon0 == null);
    if (bowOn) {
      // 东折半弧：不推出实体，让路径按几何东折（轻阻尼在 steering 里）
    } else if (clearOn && G.inFugenSolid(nlon, nlat, fugenList, hole)) {
      nlat += 0.1;
      for (let k = 0; k < 6 && G.inFugenSolid(nlon, nlat, fugenList, hole); k++) nlat += 0.08;
    } else {
      // 贴边滑行：裁剪 + 切向续行，避免 pushOut 南北弹跳锯齿
      ({ lon: nlon, lat: nlat } = clipAndSlide(lon, lat, nlon, nlat, u, v, fugenList, hole));
    }

    nlon = clamp(nlon, G.DOMAIN.lonMin + 0.2, G.DOMAIN.lonMax - 0.2);
    nlat = clamp(nlat, G.DOMAIN.latMin + 0.2, G.DOMAIN.latMax - 0.2);

    return { lon: nlon, lat: nlat, u, v, steer: st };
  }

  function moveStep(lon, lat, vmax, dtHours, cfg, fugenList, hole, arcState) {
    // 大时间步拆成子步；往北腿与绿北半弧加密采样
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    let n = Math.max(1, Math.min(6, Math.ceil(dtHours / 0.75)));
    if (edge != null) {
      const northOf = lat - edge;
      const dist = Math.abs(northOf);
      const inLeg = arcState && arcState.legTargetLat != null && lat < arcState.legTargetLat;
      const sArc = (arcState && arcState.arcLat0 != null)
        ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
        : northOf / POST_GREEN_ARC_DEG;
      if (inLeg) n = Math.max(n, Math.min(20, Math.ceil(dtHours / 0.08)));
      else if (!(arcState && arcState.arcLat0) && northOf >= -LEG_TRIGGER_DEG && northOf < 0.05)
        n = Math.max(n, Math.min(18, Math.ceil(dtHours / 0.1)));
      else if (arcState && arcState.arcLat0 != null && (arcState.sAcc || 0) < 1) n = Math.max(n, Math.min(18, Math.ceil(dtHours / 0.11)));
      else if (!(arcState && arcState.arcLat0) && dist <= G.APPROACH_NORTH_BAND_DEG + 0.25) n = Math.max(n, Math.min(16, Math.ceil(dtHours / 0.12)));
      else if (northOf >= 0 && sArc <= 1.1) n = Math.max(n, Math.min(12, Math.ceil(dtHours / 0.2)));
      else if (dist <= 3.0) n = Math.max(n, Math.min(10, Math.ceil(dtHours / 0.28)));
    }
    const sub = dtHours / n;
    let u = 0, v = 0, st = null;
    for (let i = 0; i < n; i++) {
      const r = moveStepOnce(lon, lat, vmax, sub, cfg, fugenList, hole, arcState);
      lon = r.lon;
      lat = r.lat;
      u = r.u;
      v = r.v;
      st = r.steer;
    }
    return { lon, lat, u, v, steer: st };
  }

  function intensityTendency(lon, lat, vmax, sst) {
    const land = G.isLand(lon, lat);
    const mtn = G.isMountain(lon, lat);
    let dV = 0;
    let phase = '海上维持';
    const pot = mpi(sst);

    if (land) {
      // 登陆衰减再放慢约一半量级（相对 k 的 ×0.58 再 ×~0.52）；山地相对平原仍稍快
      dV = -1.25 - (vmax / 35) * 1.45;
      if (mtn) dV -= 1.85;
      if (dV < 0) dV *= 0.30;
      phase = mtn ? '登陆衰减（山地加速）' : '登陆衰减';
    } else {
      const gap = pot - vmax;
      if (sst < 26.5) {
        // 冷海减弱再放慢：海上不要掉得太快
        dV = -0.14 - (26.5 - sst) * 0.08;
        if (vmax > pot) dV -= 0.06;
        phase = '海上减弱';
      } else if (sst >= 28.0) {
        // 向 MPI 松弛；未达 MPI 且暖海时可 RI；高纬扣减减弱
        dV = gap * 0.045;
        if (gap > 8 && vmax < 50) dV += 0.25 + (sst - 28) * 0.2;
        if (lat > 28) dV -= (lat - 28) * 0.035;
        if (dV > 0.85) phase = '海上快速增强';
        else if (dV > 0.12) phase = '海上增强';
        else if (dV < -0.15) phase = '海上减弱';
        else phase = '海上维持';
      } else {
        dV = gap * 0.03 + (sst - 27.2) * 0.15;
        if (lat > 30) dV -= 0.06;
        phase = dV >= 0.1 ? '海上增强' : (dV < -0.1 ? '海上减弱' : '海上维持');
      }

      // 超过 MPI 回落（海上加强拉取：近/超 MPI 的 Super 更易掉强度）
      if (vmax > pot) dV = Math.min(dV, -(vmax - pot) * 0.040 - 0.08);

      if (lat > 35 && sst < 27) {
        dV -= 0.10;
        phase = '海上减弱';
      }

      // 海上倾向分档：正增长再放慢；负倾向分档加快/保持弱档慢衰减（不改 MPI 公式本身）
      // 增长 dV>0：×0.80 稍微更慢一点
      // Super/强台风（vmax≥51）：减弱加快 ×2.0；中强档 ≥28：×0.95；弱 ≤24.5：KEEP ×0.55×0.5；中档 else ×0.55
      if (dV > 0) {
        dV *= 0.80;
      } else if (dV < 0) {
        if (vmax >= 51) dV *= 2.0;
        else if (vmax >= 28) dV *= 0.95;
        else if (vmax <= 24.5) dV *= 0.55 * 0.5;
        else dV *= 0.55;
      }
    }

    // 弱台风海上/陆地均不再额外加速消亡
    if (vmax < 18 && dV < 0) dV *= 1.0;
    return { dV, phase, mpi: pot };
  }

  function stepMember(m, dtHours, baseCfg, fugenList, sstRegions, holeRef) {
    if (!m.alive) return;

    const cfg = {
      steerU: m.cfgPerturb ? m.cfgPerturb.steerU : baseCfg.steerU,
      steerV: m.cfgPerturb ? m.cfgPerturb.steerV : baseCfg.steerV,
      westerlyU: m.cfgPerturb ? m.cfgPerturb.westerlyU : baseCfg.westerlyU,
      betaStrength: m.cfgPerturb ? m.cfgPerturb.betaStrength : baseCfg.betaStrength
    };

    if (m.arcLat0 === undefined) m.arcLat0 = null;
    if (m.arcLon0 === undefined) m.arcLon0 = null;
    if (m.legTargetLat === undefined) m.legTargetLat = null;
    if (m.clearLon0 === undefined) m.clearLon0 = null;
    if (m.clearLat0 === undefined) m.clearLat0 = null;
    const arcState = m; // 就地写入 arcLat0 / legTargetLat
    const moved = moveStep(m.lon, m.lat, m.vmax, dtHours, cfg, fugenList, holeRef, arcState);
    // 步间航向平滑：贴副高缘限幅消尖角；半弧内也做温和限幅（勿关死→折线棱角）
    const nearEdge = (() => {
      const e = G.guidingNorthernEdgeLat(moved.lon, fugenList, holeRef);
      if (e == null) return false;
      return Math.abs(moved.lat - e) < 4.5 || G.inFugenSolid(moved.lon, moved.lat, fugenList, holeRef);
    })();
    const arcTurning = m.clearLon0 != null && (m.sAcc || 0) < 1;
    let ou = moved.u, ov = moved.v;
    if (arcTurning) {
      // 半弧：允许转向，但掐掉单步尖折（比缘滑行更宽）
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(26, 38 * Math.min(1, dtHours))));
    } else if (nearEdge) {
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(18, 28 * Math.min(1, dtHours))));
    }
    m.lon = moved.lon;
    m.lat = moved.lat;
    m.u = ou;
    m.v = ov;

    const sst = G.getSst(m.lon, m.lat, sstRegions);
    m.sst = sst;
    const tend = intensityTendency(m.lon, m.lat, m.vmax, sst);
    m.vmax = clamp(m.vmax + tend.dV * dtHours, 5, Math.max(85, tend.mpi + 5));
    m.phase = tend.phase;

    const t0 = m.track.length ? m.track[m.track.length - 1].t : 0;
    m.track.push({ lon: m.lon, lat: m.lat, vmax: m.vmax, t: t0 + dtHours });
    // 限制路径点数量，避免长时间运行数组无限增长导致 OOM
    const MAX_TRACK_POINTS = 1000;
    if (m.track.length > MAX_TRACK_POINTS) {
      m.track.splice(0, m.track.length - MAX_TRACK_POINTS);
    }

    if (m.vmax < DISSIPATE_MS) {
      m.alive = false;
      m.phase = '消亡';
    }
  }

  function ensureBirthHole(lon, lat, vmax, fugenList) {
    for (const f of fugenList) {
      if (G.pointInRing(lon, lat, f.ring)) {
        return {
          fugenId: f.id,
          lon,
          lat,
          radiusDeg: G.holeRadiusDeg(vmax)
        };
      }
    }
    return null;
  }

  function updateHole(hole, lon, lat, vmax) {
    if (!hole) return null;
    hole.lon = lon;
    hole.lat = lat;
    hole.radiusDeg = G.holeRadiusDeg(vmax);
    return hole;
  }

  global.TyPhysics = {
    DISSIPATE_MS,
    NORTH_LEG_DEG,
    RECURVE_ARC_DEG,
    POST_GREEN_ARC_DEG,
    TARGET_ARC_DLON_DEG,
    ARC_BOW_LON_DEG,
    NE_TARGET_HDG,
    NE_MIN_HDG,
    NE_MAX_HDG,
    TW_MTN_LON,
    TW_MTN_LAT,
    TW_MTN_R_DEG,
    TW_MTN_PEAK_MS,
    TW_MTN_POWER,
    TW_MTN_LAT0,
    TW_MTN_LAT1,
    TW_MTN_EAST_GATE_LON,
    mpi,
    steeringAt,
    betaDrift,
    taiwanMtnAttract,
    moveStep,
    intensityTendency,
    stepMember,
    ensureBirthHole,
    updateHole
  };
})(typeof window !== 'undefined' ? window : globalThis);
