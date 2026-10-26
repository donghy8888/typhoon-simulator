/**
 * 台风运动与强度物理（简化但可感真实）
 */
(function (global) {
  'use strict';

  const G = global.TyGeo;
  const DISSIPATE_MS = 13.9; // 7级下限

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /** 海温决定的最大潜在强度 (m/s) */
  function mpi(sst) {
    if (sst < 26.0) return 18;
    if (sst < 26.5) return 22;
    if (sst < 28.0) return 28 + (sst - 26.5) * 8;
    return 40 + (sst - 28) * 6; // 28℃→40, 30℃→52
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
   *             半圆光滑半弧：曲率连续 due-N→NE，无 tip kink / 边角。
   *
   * 状态机（arcState）：
   *   A) 首次进入绿南 ~0.22°：legTargetLat=max(edge,lat+0.15)，u≡0 往北直到越过；
   *   B) 越过后锁存 arcLat0，常数曲率半圆 N→NE（不因 edge 回追重置）。
   */
  const NORTH_LEG_DEG = 0.15;
  const RECURVE_ARC_DEG = 7.0;
  const POST_GREEN_ARC_DEG = 4.7;  // 半弧 lat 跨度：较低纬收束，留 NE 巡航攒 lon
  const TARGET_ARC_DLON_DEG = 14.8; // 稍微大一小点 → life Δlon≈12–14
  const ARC_BOW_LON_DEG = 6.1;     // 半圆东鼓（sin 峰值中段，无尖角）
  /** atan2(v,u)≈45° → 地理约 45° from N（NE 稍微偏东） */
  const NE_TARGET_HDG = 45 * Math.PI / 180;
  /** 下限：勿扁成东北偏东（atan2 过小 / fromN 过大 / 深 ENE） */
  const NE_MIN_HDG = 42 * Math.PI / 180;
  /** 上限：半弧前半可略偏北，但尽快到 NE */
  const NE_MAX_HDG = 52 * Math.PI / 180;
  /** 提前锁存往北腿，防西缘圆角 edge 突降跳过黄→绿带 */
  const LEG_TRIGGER_DEG = 0.55;
  /** 越绿后立刻开始 N→NE 平滑弧（小真弯，非 tip kink） */
  const CLEAR_NORTH_DEG = 0.05;
  const CLEAR_LAT_MIN = 0;
  const CLEAR_NORTHOF_MIN = 0.04;

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
    // 半圆参数：余弦缓入缓出 = 端点曲率连续，无 tip kink / 边角
    // （相对 linear 更像半圆弧；相对 pow 前载不会在绿线折尖）
    const te = 0.5 * (1 - Math.cos(Math.PI * s));
    let ang = lerpAngle(ang0, angEnd, te);
    const spd = Math.max(spdW * 1.12, 9.2);
    let u = Math.cos(ang) * spd;
    let v = Math.sin(ang) * spd;
    // 半椭圆东鼓：sin(πs) 两端 0、中段最大 → 东向拉长的光滑半弧
    const bowU = (1.18 * ARC_BOW_LON_DEG) * Math.sin(Math.PI * s);
    u += bowU;
    const uCap = Math.cos(NE_MIN_HDG) * spd + ARC_BOW_LON_DEG * (0.55 + 0.45 * Math.sin(Math.PI * s));
    if (u > uCap) u = uCap;
    if (s >= 0.2) ({ u, v } = enforceNeHeading(u, v, s));
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
    // 半圆振幅：lon 主导收束，弧内先攒东移；lat 辅助
    let s = clamp(Math.max(sLat * 0.60, sLon * 0.95), 0, 1);
    s = clamp(Math.min(s, (arcState.sAcc || 0) + 0.10), 0, 1);
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
        // 目标 hdg≈140–150（地理 ~300–310° / fromN≈−50~−60）：u≈−4.6~−5.4，v≈3.5~4.2
        u = uBase * (1 - 0.1 * te) - 3.4 * te;
        v = Math.max(v, 0) * (1 - 0.55 * te) + (3.4 + 0.8 * te) * te;
        if (u < -5.5) u = -5.5;
        if (u > -3.6 && te > 0.18) u = -3.6 - 1.5 * te; // 西分量主导
        if (v > 4.5) v = 4.5;
        if (Math.abs(u) < v * 1.05) u = -Math.max(v * 1.1, 4.0); // |u|≥v → WNW not NNW
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
    return { u, v };
  }

  function betaDrift(lat, strength) {
    const f = clamp(lat / 25, 0.3, 1.2);
    const speed = 1.2 * strength * f;
    return { u: -0.75 * speed, v: 0.85 * speed };
  }

  /** 从副高实体内小步推出（步长小，避免贴边弹跳锯齿） */
  function pushOutOfFugen(lon, lat, fugenList, hole, maxIter) {
    maxIter = maxIter || 20;
    for (let k = 0; k < maxIter; k++) {
      if (!G.inFugenSolid(lon, lat, fugenList, hole)) break;
      const gg = G.fugenGradient(lon, lat, fugenList, hole);
      let gl = Math.hypot(gg.gx, gg.gy);
      if (gl < 1e-6) {
        lon -= 0.12;
        lat -= 0.08;
      } else {
        lon -= (gg.gx / gl) * 0.12;
        lat -= (gg.gy / gl) * 0.12;
      }
    }
    return { lon, lat };
  }

  /** 贴边时只去掉穿入分量，保留原引导风切向，轻微外推——避免巨尺状折线。
   *  关键：绿线以南的北缘接近（N→ENE 弧窗）不得被 lat+ε “near” 探测掐掉北向，
   *  否则主脊下路径会竖直贴边后尖折成 ENE，大半圆永远看不见。
   */
  function slideAlongFugen(lon, lat, u, v, fugenList, hole) {
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const southOfGreen = edge != null && lat < edge;
    const probes = [0.25, 0.55, 0.9];
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

    const g = G.fugenGradient(lon, lat, fugenList, hole);
    const g2 = G.fugenGradient(lon + 0.2, lat, fugenList, hole);
    const g3 = G.fugenGradient(lon, lat + 0.2, fugenList, hole);
    let gx = g.gx + 0.5 * g2.gx + 0.5 * g3.gx;
    let gy = g.gy + 0.5 * g2.gy + 0.5 * g3.gy;
    let gl = Math.hypot(gx, gy);
    if (gl < 1e-6) return { u, v };
    const nx = gx / gl, ny = gy / gl; // 指向副高内部

    // 去掉向内法向分量
    const into = u * nx + v * ny;
    if (into > 0) {
      u -= into * nx;
      v -= into * ny;
    }
    // 轻微外推，幅度远小于旧版，避免折返
    u -= nx * 0.35;
    v -= ny * 0.35;

    // 切向：保持原速度在切向上的投影，不强制改写方向
    const tx = -ny, ty = nx;
    let along = u * tx + v * ty;
    // 若几乎卡住，给一点沿切向的引导（取与原引导同号）
    if (Math.abs(along) < 0.55) {
      const stSign = (Math.abs(u) + Math.abs(v)) > 0.01 ? 1 : 1;
      along = 2.4 * (along >= 0 ? 1 : -1) * stSign; // 贴边卡住时更快切向推进
      u = tx * along - nx * 0.35;
      v = ty * along - ny * 0.35;
    }

    // 限速，防止单步飞出造成巨尺折线
    const spd = Math.hypot(u, v);
    const maxSpd = 14;
    if (spd > maxSpd) {
      u *= maxSpd / spd;
      v *= maxSpd / spd;
    }
    return { u, v };
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
            const spd = Math.max(spdW * 1.12, 11.0);
            u = Math.cos(NE_TARGET_HDG) * spd + beta.u * 0.05 + 2.0;
            v = Math.sin(NE_TARGET_HDG) * spd + beta.v * 0.08;
            ({ u, v } = enforceNeHeading(u, v, 1));
          }
        }
      } else if (northOf < -band) {
        // 黄南：明确 WNW（西 ≥ 北），非 NNW
        let uBase = Math.min(u, 0);
        if (uBase < -4.2) uBase = -4.2 + (uBase + 4.2) * 0.28;
        u = Math.min(Math.max(uBase, -5.5) - 2.0, -3.8);
        if (u < -5.5) u = -5.5;
        v = Math.min(Math.max(v * 0.72 + 0.5, 3.2), 4.4);
        if (Math.abs(u) < v * 1.05) u = -Math.max(v * 1.1, 4.0);
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
      else if (arcOn && arcState.clearLon0 == null) stepLim = 0.08; // 短净空
      else if (arcOn && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) stepLim = 0.28;
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
      ({ lon: nlon, lat: nlat } = pushOutOfFugen(nlon, nlat, fugenList, hole));
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
      else if (arcState && arcState.arcLat0 != null && (arcState.sAcc || 0) < 1) n = Math.max(n, Math.min(12, Math.ceil(dtHours / 0.22)));
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
      // 登陆衰减略缓（相对 26d），仍明显快于海上
      dV = -1.25 - (vmax / 35) * 1.45;
      if (mtn) dV -= 1.85;
      phase = mtn ? '登陆衰减（山地加速）' : '登陆衰减';
    } else {
      const gap = pot - vmax;
      if (sst < 26.5) {
        // 冷海减弱明显放慢：强度在海上更耐用
        dV = -0.32 - (26.5 - sst) * 0.18;
        if (vmax > pot) dV -= 0.15;
        phase = '海上减弱';
      } else if (sst >= 28.0) {
        // 向 MPI 松弛；未达 MPI 且暖海时可 RI；高纬扣减减弱
        dV = gap * 0.045;
        if (gap > 8 && vmax < 50) dV += 0.25 + (sst - 28) * 0.2;
        if (lat > 28) dV -= (lat - 28) * 0.05;
        if (dV > 0.85) phase = '海上快速增强';
        else if (dV > 0.12) phase = '海上增强';
        else if (dV < -0.15) phase = '海上减弱';
        else phase = '海上维持';
      } else {
        dV = gap * 0.03 + (sst - 27.2) * 0.15;
        if (lat > 30) dV -= 0.1;
        phase = dV >= 0.1 ? '海上增强' : (dV < -0.1 ? '海上减弱' : '海上维持');
      }

      // 超过 MPI 回落（海上放慢，尤其开阔洋面）
      if (vmax > pot) dV = Math.min(dV, -(vmax - pot) * 0.035 - 0.08);

      if (lat > 35 && sst < 27) {
        dV -= 0.22;
        phase = '海上减弱';
      }
    }

    if (vmax < 18 && dV < 0) dV *= 1.2;
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
    m.lon = moved.lon;
    m.lat = moved.lat;
    m.u = moved.u;
    m.v = moved.v;

    const sst = G.getSst(m.lon, m.lat, sstRegions);
    m.sst = sst;
    const tend = intensityTendency(m.lon, m.lat, m.vmax, sst);
    m.vmax = clamp(m.vmax + tend.dV * dtHours, 5, Math.max(75, tend.mpi + 5));
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
    mpi,
    steeringAt,
    betaDrift,
    moveStep,
    intensityTendency,
    stepMember,
    ensureBirthHole,
    updateHole
  };
})(typeof window !== 'undefined' ? window : globalThis);
