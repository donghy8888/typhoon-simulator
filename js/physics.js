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
   * 引导气流（绿线 = guidingNorthernEdgeLat，与绘制一致）
   *
   * 根因（20261025y）：旧版把 N→ENE「大半圆」放在绿线以南的风场 Bezier + midBulge，
   * 绿线以北却是恒定满 ENE 直线。风场鼓包在地图上几乎看不见；用户要的振幅必须
   * 出现在绿线以北的 lat/lon 折线上。
   *
   *   A) 开阔 [edge−APPROACH≈0.15°, edge)：明显往北（u≈0）；末段轻微抬东，消绿线 tip
   *   B) lat ≥ edge：ENE（非 NNE）。在 POST_GREEN_ARC≈3.5° lat 内强制 lat/lon 半弧：
   *      折线相对弦东鼓 ARC_BOW_LON≈3°（Leaflet 上肉眼可见），再收束满 ENE
   *   C) 更南开阔洋：基础引导场 only（杀东向）
   *   F) 深 fringe：预备抬向 due-N
   */
  // 兼容旧导出名：弧窗不再南扩；可见转向在绿北
  const NORTH_LEG_DEG = 0.15;
  // 深 fringe 预备抬升（仅 onFringe）
  const RECURVE_ARC_DEG = 7.0;
  // 绿线以北可见半弧跨度（纬度）与东鼓峰值（经度）
  const POST_GREEN_ARC_DEG = 3.5;
  const ARC_BOW_LON_DEG = 3.8;
  // 绿北航向上限（自正东起算）：≤52° = NE 家族，严禁 NNE（~67°）
  const ENE_MAX_HDG = 52 * Math.PI / 180;

  /**
   * 绿线以南 APPROACH 带：往北。
   * 仅在距绿线 <0.045° 时抬东到 ~50°（与绿北弧连续）；
   * 不用 band 分数——西缘贴边时 edge 随纬度跟走，分数会永久≈1，竖段永远看不见。
   */
  function approachNorthUV(northOf, band, spdW) {
    let u = 0;
    let v = Math.max(5.8, spdW * 0.72);
    const ease = 0.045; // 绝对纬度，非 band 比例
    if (northOf > -ease) {
      const r = smoothstep((northOf + ease) / ease);
      const ang = lerpAngle(Math.PI * 0.5, 50 * Math.PI / 180, r); // N → NE
      const spd = v * (1 - 0.12 * r) + spdW * 0.18 * r;
      u = Math.cos(ang) * spd;
      v = Math.sin(ang) * spd;
    }
    if (v < 0) v = 0;
    return { u, v, ta: clamp((northOf + band) / Math.max(1e-9, band), 0, 1) };
  }

  /**
   * 绿线以北可见半弧 —— LAT/LON 位移几何保证东鼓。
   * s=0@edge → 1@edge+POST_GREEN_ARC：
   *   航向 NE(~50°) → 深东中点 → 满 ENE；
   *   叠加 u += K*sin(πs)（端点为 0，无绿线 tip；中点最大 → 折线东鼓数个经度）。
   * 注意：不可用 cos 导数型东鼓（s=0 最大）——那会在绿线处瞬间拉成 ENE 尖角。
   */
  function postGreenArcUV(sRaw, lat, wU, wVE, spdW) {
    const s = clamp(sRaw, 0, 1);
    const se = smoothstep(s);
    const angENE = Math.atan2(wVE, Math.max(0.01, wU));
    // 起点 NE(~50° 与 APPROACH 末连续)，中点更深东拉开半弧，终点满 ENE
    const ang0 = Math.max(angENE, 50 * Math.PI / 180);
    const angMid = Math.min(angENE, 15 * Math.PI / 180);
    const ang = bezierHeading(ang0, angMid, angENE, se);
    const spd = Math.max(spdW, 7.5);
    let u = Math.cos(ang) * spd;
    let v = Math.sin(ang) * spd;
    // sin 东鼓：端点 0（保绿线连续），中点最大。K 使峰值东鼓 ≈ ARC_BOW_LON_DEG
    // 粗估：∫_0^1 K sin(πs) ds / v_scale ≈ bow；取 K ≈ 2.2*BOW 经验可稳出 ≥2.5° 鼓
    const bowU = (2.35 * ARC_BOW_LON_DEG) * Math.sin(Math.PI * s);
    u += bowU;
    // 硬：ENE 家族，禁止 NNE
    if (u > 0.4) {
      const hdg = Math.atan2(v, u);
      if (hdg > ENE_MAX_HDG) v = u * Math.tan(ENE_MAX_HDG);
    } else {
      u = Math.max(u, spd * 0.55);
      v = Math.min(v, u * Math.tan(ENE_MAX_HDG));
    }
    if (v < 0) v = 0;
    return { u, v, s };
  }


  /** 读/写弧进度：仅写入时推进 sAcc（每子步只写一次，防 double-count） */
  function arcProgress(northOf, lat, arcState, write) {
    if (northOf < 0) {
      if (write && arcState && arcState.arcLat0 != null) {
        const sTmp = (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG;
        if (sTmp < 0.25) { arcState.arcLat0 = null; arcState.sAcc = 0; }
      }
      return -1;
    }
    if (arcState) {
      if (arcState.arcLat0 == null) arcState.arcLat0 = lat;
      if (arcState.sAcc == null) arcState.sAcc = 0;
    }
    let s = (arcState && arcState.arcLat0 != null)
      ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
      : northOf / POST_GREEN_ARC_DEG;
    s = clamp(s, 0, 1);
    if (arcState) {
      s = clamp(Math.min(s, arcState.sAcc + 0.12), 0, 1);
      if (write) arcState.sAcc = Math.max(arcState.sAcc, s);
    }
    return s;
  }

  /** 旧名保留：APPROACH 带委托；绿北委托 postGreenArcUV（诊断脚本可探） */
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
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42); // ENE 北分上限 ~23°
      const spdW = Math.hypot(wU, wVE);
      const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);

      if (northOf >= 0) {
        // B) 绿线以北：ENE + 可见 lat/lon 半弧（进度只读，写入在 moveStepOnce）
        const s = arcProgress(northOf, lat, arcState, false);
        if (s < 1) {
          const b = postGreenArcUV(s, lat, wU, wVE, spdW);
          u = b.u;
          v = b.v;
        } else {
          u = wU;
          v = wVE;
        }
      } else if (northOf >= -band) {
        // A) 开阔 [edge−0.15, edge)：往北（末段微抬东，消 tip）
        arcProgress(northOf, lat, arcState, false); // 可能重置闪烁弧原点
        const b = approachNorthUV(northOf, band, spdW);
        u = b.u;
        v = b.v;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        // F) 深 fringe 预备：抬向 due-N（不刷到开阔洋）
        const t = (northOf + RECURVE_ARC_DEG) / (RECURVE_ARC_DEG - band);
        const te = clamp(t, 0, 1);
        u = Math.min(u, 0) * (1 - te);
        v = Math.max(0, v) * (1 - te) + 4.6 * te;
      }
      // C) 更南开阔洋：基础场

      // 硬门控（绿线以南）：APPROACH 带允许末段微东；其南杀东向
      if (northOf < 0) {
        if (northOf >= -band) {
          // approachNorthUV 已处理；距绿线 ≥0.045° 必须 u=0（竖段）
          if (northOf <= -0.045) u = 0;
        } else {
          u = Math.min(u, 0);
        }
      }
    } else if (lat >= 32) {
      u = cfg.westerlyU;
      v = 1.5;
    }

    if (G.inFugenSolid(lon, lat, fugenList, hole)) {
      // 副高内仍阻尼；0.58 保持可感推进
      u *= 0.58;
      v *= 0.58;
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

    // 强化：绿北半弧不被 β/slide 掐扁；APPROACH 往北；禁 NNE。
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG;
    const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42);
      const spdW = Math.hypot(wU, wVE);
      if (northOf >= 0) {
        // B) 重施加绿北半弧；此处唯一写入 sAcc
        const s = arcProgress(northOf, lat, arcState, true);
        if (s < 1) {
          const b = postGreenArcUV(s, lat, wU, wVE, spdW);
          u = b.u + beta.u * 0.25;
          v = b.v + beta.v * 0.25;
          if (u < 1.2) u = 1.2;
          if (u > 0.4 && Math.atan2(v, u) > ENE_MAX_HDG) {
            v = u * Math.tan(ENE_MAX_HDG);
          }
        } else {
          if (u < 1.2) u = 1.2;
          const eneVcap = wVE + Math.abs(beta.v) * 0.35;
          if (v > eneVcap + 0.35) v = eneVcap + 0.35;
          if (u > 0.4 && Math.atan2(v, u) > ENE_MAX_HDG) {
            v = u * Math.tan(ENE_MAX_HDG);
          }
        }
      } else if (northOf >= -band) {
        // A) APPROACH：重施加往北
        arcProgress(northOf, lat, arcState, true);
        const b = approachNorthUV(northOf, band, spdW);
        u = b.u;
        v = Math.max(b.v, v * 0.35 + b.v * 0.65);
        if (northOf <= -0.045) u = 0;
        if (v < 0) v = 0;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        u = Math.min(u, 0);
        v += 1.2;
        if (v < 0) v = 0;
      }
    }
    // 硬门控（beta + slide 之后）
    if (edge != null && lat < edge) {
      const northOf = lat - edge;
      if (northOf >= -band) {
        if (northOf <= -0.045) u = 0;
      } else {
        u = Math.min(u, 0);
      }
    }

    const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
    // 单步位移上限：APPROACH 与绿北半弧必须细步，否则折线采样不足 → tip/直线
    let stepLon = dlon * dtHours;
    let stepLat = dlat * dtHours;
    let stepLim = 0.55;
    if (edge != null) {
      const northOf = lat - edge;
      const dist = Math.abs(northOf);
      const sArc = (arcState && arcState.arcLat0 != null)
        ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
        : northOf / POST_GREEN_ARC_DEG;
      if (dist <= band + 0.05) stepLim = 0.022;
      else if (northOf >= 0 && sArc <= 1.05) stepLim = 0.085;
      else if (dist <= 3.0) stepLim = 0.16;
    }
    const stepMag = Math.hypot(stepLon, stepLat);
    if (stepMag > stepLim) {
      stepLon *= stepLim / stepMag;
      stepLat *= stepLim / stepMag;
    }
    let nlon = lon + stepLon;
    let nlat = lat + stepLat;
    ({ lon: nlon, lat: nlat } = pushOutOfFugen(nlon, nlat, fugenList, hole));

    nlon = clamp(nlon, G.DOMAIN.lonMin + 0.2, G.DOMAIN.lonMax - 0.2);
    nlat = clamp(nlat, G.DOMAIN.latMin + 0.2, G.DOMAIN.latMax - 0.2);

    return { lon: nlon, lat: nlat, u, v, steer: st };
  }

  function moveStep(lon, lat, vmax, dtHours, cfg, fugenList, hole, arcState) {
    // 大时间步拆成子步；APPROACH 与绿北半弧加密采样
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    let n = Math.max(1, Math.min(6, Math.ceil(dtHours / 0.75)));
    if (edge != null) {
      const northOf = lat - edge;
      const dist = Math.abs(northOf);
      const sArc = (arcState && arcState.arcLat0 != null)
        ? (lat - arcState.arcLat0) / POST_GREEN_ARC_DEG
        : northOf / POST_GREEN_ARC_DEG;
      if (dist <= G.APPROACH_NORTH_BAND_DEG + 0.08) n = Math.max(n, Math.min(16, Math.ceil(dtHours / 0.12)));
      else if (northOf >= 0 && sArc <= 1.1) n = Math.max(n, Math.min(14, Math.ceil(dtHours / 0.18)));
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
      dV = -1.4 - (vmax / 35) * 1.6;
      if (mtn) dV -= 2.0;
      phase = mtn ? '登陆衰减（山地加速）' : '登陆衰减';
    } else {
      const gap = pot - vmax;
      if (sst < 26.5) {
        dV = -0.7 - (26.5 - sst) * 0.4;
        if (vmax > pot) dV -= 0.5;
        phase = '海上减弱';
      } else if (sst >= 28.0) {
        // 向 MPI 松弛；未达 MPI 且暖海时可 RI
        dV = gap * 0.045;
        if (gap > 8 && vmax < 50) dV += 0.25 + (sst - 28) * 0.2;
        if (lat > 28) dV -= (lat - 28) * 0.1;
        if (dV > 0.85) phase = '海上快速增强';
        else if (dV > 0.12) phase = '海上增强';
        else if (dV < -0.15) phase = '海上减弱';
        else phase = '海上维持';
      } else {
        dV = gap * 0.03 + (sst - 27.2) * 0.15;
        if (lat > 30) dV -= 0.2;
        phase = dV >= 0.1 ? '海上增强' : (dV < -0.1 ? '海上减弱' : '海上维持');
      }

      // 超过 MPI 回落
      if (vmax > pot) dV = Math.min(dV, -(vmax - pot) * 0.08 - 0.2);

      if (lat > 35 && sst < 27) {
        dV -= 0.5;
        phase = '海上减弱';
      }
    }

    if (vmax < 18 && dV < 0) dV *= 1.35;
    return { dV, phase, mpi: pot };
  }

  function createMember(seed, init, cfg) {
    const r = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    return {
      lon: init.lon + r() * 0.6,
      lat: init.lat + r() * 0.5,
      vmax: clamp(init.vmax + r() * 3, 14, 70),
      alive: true,
      track: [],
      phase: '待启动',
      sst: null,
      u: 0,
      v: 0,
      arcLat0: null, // 首次稳定越过绿线的纬度
      sAcc: 0,     // 半弧进度缓增累加器（防 edge 跳动）
      cfgPerturb: {
        steerU: cfg.steerU + r() * 1.2,
        steerV: cfg.steerV + r() * 0.8,
        westerlyU: cfg.westerlyU + r() * 1.5,
        betaStrength: clamp(cfg.betaStrength + r() * 0.2, 0, 2)
      }
    };
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
    const arcState = m; // 就地写入 arcLat0
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
    ARC_BOW_LON_DEG,
    mpi,
    steeringAt,
    betaDrift,
    moveStep,
    intensityTendency,
    createMember,
    stepMember,
    ensureBirthHole,
    updateHole
  };
})(typeof window !== 'undefined' ? window : globalThis);
