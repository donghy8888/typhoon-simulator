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
   * 黄南 WNW→N 收束形函数（30b）：跨度 = WNW_EASE_DEG（相对 30a 稍南一丁点，仍黄南）；
   * 进度前载 —— 黄南中段已约一半航向，近黄已近 due-N。
   * pow>1：ease 从 1→0 时 u 在南半带掉得更快；端点仍 1/0。
   */
  const WNW_EASE_POWER = 2.55;
  function wnwEaseFade(ease) {
    ease = clamp(ease, 0, 1);
    return Math.pow(ease, WNW_EASE_POWER);
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
   * 分区/绿黄线用脊线：空圈打穿副高北缘时，带 hole 的 guidingNorthernEdgeLat
   * 会塌到空圈南侧，northOf 假变正 → 沿缘 WNW 突然锁北腿/半弧，路径出凸尖角。
   * 取 max(有洞, 无洞) 保住真副高北缘；不改 WNW / due-N / 绿后 ENE 分区与航向目标。
   */
  function ridgeGuidingEdgeLat(lon, fugenList, hole) {
    const e0 = G.guidingNorthernEdgeLat(lon, fugenList, null);
    if (!hole) return e0;
    const eH = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    if (e0 == null) return eH;
    if (eH == null) return e0;
    // hole 只删实体，塌边时 eH≪e0；取 max 即真脊
    return Math.max(e0, eH);
  }

  /**
   * 引导气流（绿线 = 真副高北缘 ridgeGuidingEdgeLat；黄线 = 绿线南 0.15°≈50km）
   *
   * 分区（20261030b）：
   *   黄线以南 (northOf < −0.15)：明确 WNW；起点明显北移（WNW_EASE→5.8，仍黄南不贴黄）；
   *             带内进度前载：黄南已约一半航向，近黄收束完 due-N → 连续圆滑弧
   *   黄→绿 (−0.15 ≤ northOf < 0)：纯往北 u≡0（锁存腿，leg 止于绿线）
   *   绿线以北：立刻东北偏东（≈55–58° from N / atan2≈32–35°；继承 28q ENE）；
   *             线北无 CLEAR / 无 N→ENE 过渡弧带；强 blend/antiKink 消北边直角。
   *
   * 状态机（arcState）：
   *   A) 进入黄线附近：legTargetLat=edge（止于绿），u≡0 往北；
   *   B) 越绿：sAcc=1，目标立刻 ENE（不启 post-green 半弧）；
   *      步间更紧 blendHeading + 更多轮 antiKink 消 due-N→ENE 折角。
   *
   * 30b：WNW_EASE 5.8→6.4（起点稍南一丁点）；POWER=2.55 中弧仍在黄南；
   *       北段 antiKink 保持，连续弧形无北边小直角。
   */
  const NORTH_LEG_DEG = 0.15;
  const RECURVE_ARC_DEG = 12.5;
  const POST_GREEN_ARC_DEG = 7.2;  // 半弧略拉长：Δheading 更大仍圆、少棱角（28q）
  const TARGET_ARC_DLON_DEG = 17.5; // life Δlon≈16–18（更东转向）
  const ARC_BOW_LON_DEG = 7.8;     // 东鼓加大：中段东分量更明显，仍不折肩
  /** atan2(v,u)≈33° → 地理约 57° from N（东北偏东 / 近 ENE） */
  const NE_TARGET_HDG = 33 * Math.PI / 180;
  /** 下限：允许东北偏东；拦死过扁正东（atan2 过小） */
  const NE_MIN_HDG = 28 * Math.PI / 180;
  /** 上限：半弧前半可略偏北，但尽快到更东的 NE/ENE */
  const NE_MAX_HDG = 52 * Math.PI / 180;
  /** 提前锁存往北腿，防西缘圆角 edge 突降跳过黄→绿带 */
  const LEG_TRIGGER_DEG = 0.55;
  /** 黄南 WNW→N 收束跨度（°）：到黄线 u→0；起点 = 黄线南 WNW_EASE_DEG（更南、幅度更大） */
  const WNW_EASE_DEG = 6.4;
  /** 28t/28u：线北不再做 CLEAR / 半弧；常量保留以免外部引用断裂 */
  const CLEAR_NORTH_DEG = 0.0;
  const CLEAR_LAT_MIN = 0;
  const CLEAR_NORTHOF_MIN = 0.0;

  function approachNorthUV(northOf, band, spdW) {
    const u = 0;
    let v = Math.max(5.8, spdW * 0.72);
    if (v < 0) v = 0;
    return { u, v, ta: clamp((northOf + band) / Math.max(1e-9, band), 0, 1) };
  }

  function enforceNeHeading(u, v, s) {
    // 半圆：只拦过扁正东（MIN≈28°）；勿用 MAX 把前半段从 due-N 瞬间夹到 ~52°（tip kink）
    if (u < 0) u = 0;
    if (v < 0) v = 0;
    if (s < 0.04 || u <= 0.08) return { u, v };
    let h = Math.atan2(v, u);
    const spd = Math.hypot(u, v) || 1;
    // 仅在弧中后段防止扁成正东；前半保持常数曲率半圆（允许东北偏东）
    if (s >= 0.62 && h < NE_MIN_HDG) {
      u = Math.cos(NE_MIN_HDG) * spd;
      v = Math.sin(NE_MIN_HDG) * spd;
    }
    return { u, v };
  }

  function postGreenArcUV(sRaw, lat, wU, wVE, spdW) {
    const s = clamp(sRaw, 0, 1);
    const ang0 = Math.PI * 0.5; // due-N 接竖段（C1：s=0 时 u≈0, dθ/ds≈0）
    const angEnd = NE_TARGET_HDG; // ~57° from N（东北偏东）
    // 半圆参数：smootherstep = 端点 C2，中段更圆，少棱角/折肩
    // （相对 cosine 再软一点；相对 pow 前载不会在绿线折尖）
    const te = smootherstep(s);
    let ang = lerpAngle(ang0, angEnd, te);
    const spd = Math.max(spdW * 1.12, 9.2);
    let u = Math.cos(ang) * spd;
    let v = Math.sin(ang) * spd;
    // 半椭圆东鼓：前段 lat 主导、东鼓稍后抬头 → 圆角半弧而非折肩
    const sBow = Math.pow(s, 1.40);
    const bowU = (1.08 * ARC_BOW_LON_DEG) * Math.sin(Math.PI * sBow);
    u += bowU;
    const uCap = Math.cos(NE_MIN_HDG) * spd + ARC_BOW_LON_DEG * (0.55 + 0.42 * Math.sin(Math.PI * sBow));
    if (u > uCap) u = uCap;
    if (s >= 0.34) ({ u, v } = enforceNeHeading(u, v, s));
    else {
      if (u < 0) u = 0;
      if (v < 0) v = 0;
    }
    return { u, v, s };
  }

  function ensureLegTarget(northOf, lat, edge, arcState) {
    if (!arcState) return null;
    if (arcState.legTargetLat != null) return arcState.legTargetLat;
    // 进入黄线附近即锁存：腿止于绿线（不越过）。转向弧在黄南已完成；
    // 黄→绿只跑 due-N，绿北直接 ENE（28t：禁 leg 推到绿线以北）。
    if (northOf >= -LEG_TRIGGER_DEG && northOf < 0) {
      arcState.legTargetLat = edge;
      return arcState.legTargetLat;
    }
    if (northOf >= 0) {
      // 已越绿：不再追加纯北腿；标腿已完成，交由 ENE
      arcState.legTargetLat = Math.min(lat, edge);
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
    let s = clamp(Math.max(sLat * 0.52, sLon * 0.88), 0, 1);
    s = clamp(Math.min(s, (arcState.sAcc || 0) + 0.038), 0, 1);
    if (write) arcState.sAcc = Math.max(arcState.sAcc || 0, s);
    return s;
  }

  function approachBendUV(northOf, arcDeg, wU, wVE, spdW) {
    const band = (typeof G !== 'undefined' && G.APPROACH_NORTH_BAND_DEG) ? G.APPROACH_NORTH_BAND_DEG : 0.15;
    if (northOf >= 0) {
      // 28t：绿北直接 ENE，不再走 post-green 半弧
      const spd = Math.max(spdW * 1.12, 11.0);
      return {
        u: Math.cos(NE_TARGET_HDG) * spd + 0.45,
        v: Math.sin(NE_TARGET_HDG) * spd,
        s: 1
      };
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

    const edge = ridgeGuidingEdgeLat(lon, fugenList, hole);
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
        // 28t：绿北立刻东北偏东（28q ENE）；线北无 CLEAR / 无过渡半弧
        if (arcState) {
          if (arcState.clearLon0 == null) {
            arcState.clearLon0 = lon;
            arcState.clearLat0 = lat;
            if (arcState.arcLat0 == null) arcState.arcLat0 = lat;
            if (arcState.arcLon0 == null) arcState.arcLon0 = lon;
          }
          arcState.sAcc = 1;
        }
        const spd = Math.max(spdW * 1.12, 11.0);
        u = Math.cos(NE_TARGET_HDG) * spd + 0.45;
        v = Math.sin(NE_TARGET_HDG) * spd;
      } else if (northOf < -band) {
        // 黄线以南：明确 WNW；转向在黄线更南完成（WNW_EASE），幅度加大
        const t = clamp((northOf + RECURVE_ARC_DEG) / (RECURVE_ARC_DEG - band), 0, 1);
        const te = smoothstep(t);
        let uBase = Math.min(u, 0);
        if (uBase < -4.2) uBase = -4.2 + (uBase + 4.2) * 0.28;
        // 深南明确 WNW；幅度靠更南的长收束（WNW_EASE）而非过猛西踢
        u = uBase * (1 - 0.1 * te) - 4.7 * te;
        v = Math.max(v, 0) * (1 - 0.55 * te) + (3.4 + 0.8 * te) * te;
        if (u < -6.8) u = -6.8;
        if (u > -4.7 && te > 0.18) u = -4.7 - 1.6 * te; // 西分量主导
        if (v > 4.5) v = 4.5;
        if (Math.abs(u) < v * 1.2) u = -Math.max(v * 1.2, 4.2); // |u|≥v → WNW not NNW
        // 黄南收束：跨度同 28w（WNW_EASE）；wnwEaseFade 前载 → 中弧在黄南
        const ease = clamp((-band - northOf) / WNW_EASE_DEG, 0, 1);
        const easeS = wnwEaseFade(ease);
        u *= easeS;
        const dueNV = Math.max(5.8, spdW * 0.72);
        v = v * easeS + dueNV * (1 - easeS);
      }

      if (inNorthLeg) {
        u = 0;
      } else if (northOf < 0 && !arcActive) {
        if (northOf >= -band) u = 0;          // 黄→绿：纯北
        else u = Math.min(u, 0);              // 黄南：不许东
      }
    } else if (lat >= 32) {
      // 无绿线兜底：东北偏东
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
  const TW_MTN_LON = 121.11;   // 中央山脉中心经度（elev 脊质心，WGS84）
  const TW_MTN_LAT = 23.76;    // 中央山脉中心纬度（elev 脊质心，WGS84）
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
    const edge = ridgeGuidingEdgeLat(lon, fugenList, hole);
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
    const edge = ridgeGuidingEdgeLat(lon, fugenList, hole);
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
      const strip = southOfGreen ? 0.55 : 0.82; // 绿北缘：留一点法向柔过渡，少锯齿尖
      u -= into * strip * nx;
      v -= into * strip * ny;
    }
    // 外推：绿南更轻；绿北缘也略收，避免弹离后折尖（28r）
    const outKick = southOfGreen ? 0.08 : 0.16;
    u -= nx * outKick;
    v -= ny * outKick;

    // 切向：加长贴缘滑行，航向与切向再融一层，抑 rim→NE 凸尖
    const tx = -ny, ty = nx;
    let along = u * tx + v * ty;
    if (Math.abs(along) < 0.55) {
      const prefer = along >= 0 ? 1 : -1;
      const boost = southOfGreen ? 2.8 : 2.7;
      along = boost * prefer;
      u = tx * along - nx * outKick;
      v = ty * along - ny * outKick;
    } else if (!southOfGreen) {
      // 北缘：速度更贴切向（长滑），再混回一点原引导，拐弯圆角
      const tl = Math.hypot(tx, ty) || 1;
      const spd = Math.hypot(u, v) || 1;
      const tu = (tx / tl) * Math.sign(along || 1) * spd;
      const tv = (ty / tl) * Math.sign(along || 1) * spd;
      u = 0.72 * tu + 0.28 * u;
      v = 0.72 * tv + 0.28 * v;
      u -= nx * outKick * 0.5;
      v -= ny * outKick * 0.5;
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

  /**
   * 贴缘折线消尖：若新点相对末两轨点外角过大，把新点沿弦向回拉，
   * 专打 along-副高 → NE 的凸尖/锯齿；不改分区航向目标。
   */
  function antiKinkPos(track, lon, lat, maxTurnDeg, minNewBlend) {
    if (!track || track.length < 2) return { lon, lat };
    const a = track[track.length - 2];
    const b = track[track.length - 1];
    const ax = b.lon - a.lon, ay = b.lat - a.lat;
    const bx = lon - b.lon, by = lat - b.lat;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-5 || lb < 1e-5) return { lon, lat };
    let ang = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    const maxRad = (maxTurnDeg * Math.PI) / 180;
    if (Math.abs(ang) <= maxRad) return { lon, lat };
    const tMin = (minNewBlend != null) ? minNewBlend : 0.28;
    const t = clamp(1 - (Math.abs(ang) - maxRad) / (Math.PI * 0.55), tMin, 0.85);
    // Continuity: blend new step toward previous heading chord
    const ux = ax / la, uy = ay / la;
    const nx = lon - b.lon, ny = lat - b.lat;
    const px = ux * lb, py = uy * lb;
    return { lon: b.lon + px * (1 - t) + nx * t, lat: b.lat + py * (1 - t) + ny * t };
  }

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
    const spd = 0.55 * spd1 + 0.45 * spd0;
    return { u: Math.cos(a) * spd, v: Math.sin(a) * spd };
  }

  function moveStepOnce(lon, lat, vmax, dtHours, cfg, fugenList, hole, arcState) {
    ({ lon, lat } = pushOutOfFugen(lon, lat, fugenList, hole));

    const st = steeringAt(lon, lat, cfg, fugenList, hole, arcState);
    const beta = betaDrift(lat, cfg.betaStrength);
    let u = st.u + beta.u;
    let v = st.v + beta.v;

    ({ u, v } = slideAlongFugen(lon, lat, u, v, fugenList, hole));

    const edge = ridgeGuidingEdgeLat(lon, fugenList, hole);
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
      } else if (arcActive || northOf >= 0) {
        // 28t：过绿立刻东北偏东；线北无 CLEAR、无 N→ENE 半弧（转向弧已在黄南完成）
        if (arcState) {
          if (arcState.clearLon0 == null) {
            arcState.clearLon0 = lon;
            arcState.clearLat0 = lat;
            if (arcState.arcLat0 == null) arcState.arcLat0 = lat;
            if (arcState.arcLon0 == null) arcState.arcLon0 = lon;
          }
          arcState.sAcc = 1;
        }
        const spd = Math.max(spdW * 1.12, 11.0);
        u = Math.cos(NE_TARGET_HDG) * spd + beta.u * 0.05 + 0.45;
        v = Math.sin(NE_TARGET_HDG) * spd + beta.v * 0.08;
        ({ u, v } = enforceNeHeading(u, v, 1));
      } else if (northOf < -band) {
        // 黄南：明确 WNW（西 ≥ 北），非 NNW；幅度靠 WNW_EASE 更南长收束
        let uBase = Math.min(u, 0);
        if (uBase < -4.2) uBase = -4.2 + (uBase + 4.2) * 0.28;
        u = Math.min(Math.max(uBase, -6.8) - 2.8, -4.7);
        if (u < -6.8) u = -6.8;
        v = Math.min(Math.max(v * 0.72 + 0.5, 3.2), 4.4);
        if (Math.abs(u) < v * 1.2) u = -Math.max(v * 1.2, 4.2);
        // 30b：WNW_EASE≈6.4（相对 30a 稍南一丁点）；wnwEaseFade 前载中弧在黄南
        // 到黄线 u→0；黄→绿纯北；绿北立刻 ENE（弧不得过绿）
        const ease = clamp((-band - northOf) / WNW_EASE_DEG, 0, 1);
        const easeS = wnwEaseFade(ease);
        u *= easeS;
        // 收束末段把北分量抬向 due-N，弧更圆、少贴黄折肩
        const dueNV = Math.max(5.8, spdW * 0.72);
        v = v * easeS + dueNV * (1 - easeS);
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
      if (inLeg) stepLim = 0.015;
      else if (!arcOn && northOf >= -LEG_TRIGGER_DEG && northOf < 0) stepLim = 0.016;
      else if (!arcOn && dist <= band + 0.35) stepLim = 0.028;
      else if (arcOn && arcState.clearLon0 == null) stepLim = 0.045; // 短净空更细
      else if (arcOn && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) stepLim = 0.085; // 半弧细步：少折线棱角（28o）
      else if (northOf >= 0 && northOf < 1.1 && (arcState.sAcc || 0) >= 1) stepLim = 0.022; // 30a：绿后更长细步，抹直角
      else if (northOf >= 0 && sArc <= 1.05) stepLim = 0.08;
      else if (dist <= 3.0) stepLim = 0.14;
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
    const edge = ridgeGuidingEdgeLat(lon, fugenList, hole);
    let n = Math.max(1, Math.min(6, Math.ceil(dtHours / 0.75)));
    if (edge != null) {
      const northOf = lat - edge;
      const dist = Math.abs(northOf);
      const inLeg = arcState && arcState.legTargetLat != null && lat < arcState.legTargetLat;
      const sArc = (arcState && arcState.arcLat0 != null)
        ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
        : northOf / POST_GREEN_ARC_DEG;
      if (inLeg) n = Math.max(n, Math.min(22, Math.ceil(dtHours / 0.07)));
      else if (!(arcState && arcState.arcLat0) && northOf >= -LEG_TRIGGER_DEG && northOf < 0.05)
        n = Math.max(n, Math.min(20, Math.ceil(dtHours / 0.085)));
      else if (arcState && arcState.arcLat0 != null && (arcState.sAcc || 0) < 1) n = Math.max(n, Math.min(22, Math.ceil(dtHours / 0.09)));
      else if (northOf >= 0 && northOf < 1.1 && arcState && (arcState.sAcc || 0) >= 1)
        n = Math.max(n, Math.min(32, Math.ceil(dtHours / 0.045))); // 30a：绿后更长加密
      else if (!(arcState && arcState.arcLat0) && dist <= G.APPROACH_NORTH_BAND_DEG + 0.25) n = Math.max(n, Math.min(18, Math.ceil(dtHours / 0.10)));
      else if (northOf >= 0 && sArc <= 1.1) n = Math.max(n, Math.min(14, Math.ceil(dtHours / 0.16)));
      else if (dist <= 3.0) n = Math.max(n, Math.min(12, Math.ceil(dtHours / 0.24)));
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
      const e = ridgeGuidingEdgeLat(moved.lon, fugenList, holeRef);
      if (e == null) return false;
      // 加宽缘带：沿副高滑行→NE 整段都限航向，专抑凸尖
      return Math.abs(moved.lat - e) < 7.5 || G.inFugenSolid(moved.lon, moved.lat, fugenList, holeRef);
    })();
    const arcTurning = m.clearLon0 != null && (m.sAcc || 0) < 1;
    const arcDone = m.clearLon0 != null && (m.sAcc || 0) >= 1;
    const edgeNow = ridgeGuidingEdgeLat(moved.lon, fugenList, holeRef);
    const northOfNow = edgeNow == null ? null : moved.lat - edgeNow;
    // 黄缘～绿北：易出小直角的北段（30a 加宽）
    const northShoulder = northOfNow != null && northOfNow >= -2.8 && northOfNow < 1.25;
    let ou = moved.u, ov = moved.v;
    if (arcTurning) {
      // 半弧：温和限幅即可（勿过紧拖死 ENE 目标角）；尖角已由真脊 edge 消除
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(16, 26 * Math.min(1, dtHours))));
    } else if (arcDone && nearEdge) {
      // 30a：目标仍立刻 ENE；长平滑限幅抹 due-N→ENE 直角
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(4.5, 7 * Math.min(1, dtHours))));
    } else if (nearEdge && northShoulder) {
      // 黄南收束末段 + 黄→绿：紧限幅，圆滑接入 due-N
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(5, 8 * Math.min(1, dtHours))));
    } else if (nearEdge && !arcDone) {
      // along-副高 / WNW→N 缘带：紧限幅 + 下方 antiKink，专打凸尖角
      ({ u: ou, v: ov } = blendHeading(m.u, m.v, moved.u, moved.v, Math.max(8, 13 * Math.min(1, dtHours))));
    }
    let nlon = moved.lon, nlat = moved.lat;
    // 折线消尖：北段更多轮、更紧，连续圆滑弧无北边直角
    if (arcDone && nearEdge) {
      for (let k = 0; k < 8; k++) {
        ({ lon: nlon, lat: nlat } = antiKinkPos(m.track, nlon, nlat, 5, 0.04));
      }
    } else if (nearEdge && northShoulder && !arcTurning) {
      for (let k = 0; k < 6; k++) {
        ({ lon: nlon, lat: nlat } = antiKinkPos(m.track, nlon, nlat, 8, 0.07));
      }
    } else if (nearEdge && !arcTurning && !arcDone) {
      ({ lon: nlon, lat: nlat } = antiKinkPos(m.track, nlon, nlat, 14));
    } else if (arcTurning) {
      ({ lon: nlon, lat: nlat } = antiKinkPos(m.track, nlon, nlat, 32));
    }
    m.lon = nlon;
    m.lat = nlat;
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
    WNW_EASE_DEG,
    WNW_EASE_POWER,
    POST_GREEN_ARC_DEG,
    TARGET_ARC_DLON_DEG,
    ARC_BOW_LON_DEG,
    NE_TARGET_HDG,
    NE_MIN_HDG,
    NE_MAX_HDG,
    ridgeGuidingEdgeLat,
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
