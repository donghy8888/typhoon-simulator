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

  /** 二次 Bezier 航向：起点 due-N → 偏北 NE 顶点（中等弧振幅）→ 满 ENE（在副高北缘/绿线处完成） */
  function bezierHeading(a0, a1, a2, t) {
    const ab = lerpAngle(a0, a1, t);
    const bc = lerpAngle(a1, a2, t);
    return lerpAngle(ab, bc, t);
  }

  /**
   * 是否贴在副高北缘 fringe（实体内，或外侧近邻探测到红区）。
   * 中段 Bezier 只在此门控下启用——禁止把 7° NE 弧刷到绿线以南开阔洋面。
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
   *   A) 开阔洋面 [edge−APPROACH_NORTH_BAND_DEG, edge) ≈ [edge−0.3°, edge)：完全往北（u = 0）
   *      ——硬规则：绿线以南开阔洋禁东北；带宽=0.3°；绝不用 RECURVE_ARC 当南侧带宽
   *   A-arc) 副高北缘 fringe（inFugen / 贴红区北缘滑动）且 lat < edge：中等 Bezier 转向弧
   *      ——弧振幅在副高最北边（绿线）收束到满 ENE；FORBIDDEN：弧越过绿线以北
   *      ——FORBIDDEN：把 7° NE 刷到绿线以南开阔洋（仅 fringe 门控）
   *   B) lat >= edge：立即满东北偏东（ENE），恒定，无过渡带、无 Bezier、无北鼓
   *   C) 更南开阔洋：基础引导场 only（杀东向）
   */
  // 弧长中等(~7°)：仅描述 fringe 内深度尺度；振幅中间档（禁 midBulge 3.85）
  const RECURVE_ARC_DEG = 7.0;

  function steeringAt(lon, lat, cfg, fugenList, hole) {
    let u = cfg.steerU;
    let v = cfg.steerV;

    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG; // ≈0.3°；开阔洋面纯北接近带
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42); // ENE 北分上限 ~23°
      const angENE = Math.atan2(wVE, Math.max(0.01, wU));
      const spdW = Math.hypot(wU, wVE);
      const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);

      if (northOf >= 0) {
        // B) 绿线以北：立即满 ENE，无弧、无过渡
        u = wU;
        v = wV;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        // A-arc) 副高北缘 fringe（仍南于绿线）：Bezier 弧，在 edge 收束满 ENE
        const t = (northOf + RECURVE_ARC_DEG) / RECURVE_ARC_DEG; // 0@深 fringe → 1@绿线
        const te = 1 - Math.pow(1 - t, 1.35);
        const ang0 = Math.PI * 0.5; // due north 起点
        const ang1 = Math.atan2(Math.max(4.6, wU * 0.88), Math.max(2.7, wU * 0.50));
        const ang2 = angENE;
        const ang = bezierHeading(ang0, ang1, ang2, te);
        const spd0 = Math.max(4.6, spdW * 0.55);
        const spd = spd0 * (1 - te) + spdW * te;
        const midBulge = 2.2 * Math.sin(Math.PI * te) * (1 - 0.18 * te);
        u = Math.cos(ang) * spd;
        v = Math.sin(ang) * spd + midBulge;
        if (te < 0.12) u = 0;
        if (te >= 0.55 && u < 1.2) u = 1.2 + (te - 0.55) / 0.45 * Math.max(0, wU - 1.2);
        if (v < 0) v = 0;
        if (te >= 0.35 && u > 0) {
          const hLim = Math.tan(68 * Math.PI / 180);
          if (v > u * hLim) v = u * hLim;
        }
      } else if (northOf >= -band) {
        // A) 开阔洋面 [edge−0.3, edge)：完全往北（due north）
        const t = clamp((northOf + band) / band, 0, 1);
        u = 0;
        v = Math.max(0, v * (1 - t) + 4.6 * t);
      }
      // C) 更南开阔洋：基础场

      // 硬门控（绿线以南）
      if (northOf < 0) {
        if (onFringe && northOf >= -RECURVE_ARC_DEG) {
          const tGate = (northOf + RECURVE_ARC_DEG) / RECURVE_ARC_DEG;
          const teGate = 1 - Math.pow(1 - tGate, 1.35);
          if (teGate < 0.12) u = 0;
        } else if (northOf >= -band) {
          u = 0;
        } else {
          u = Math.min(u, 0); // 开阔洋面杀东向：禁长 ENE 过渡
        }
      }
    } else if (lat >= 32) {
      u = cfg.westerlyU;
      v = 1.5;
    }

    if (G.inFugenSolid(lon, lat, fugenList, hole)) {
      // 副高内仍阻尼，但不可几乎停住（0.2 太慢）；~0.58 保持可感推进
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

  /** 贴边时只去掉穿入分量，保留原引导风切向，轻微外推——避免巨尺状折线 */
  function slideAlongFugen(lon, lat, u, v, fugenList, hole) {
    const probes = [0.25, 0.55, 0.9];
    let hit = false;
    for (const probe of probes) {
      const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
      if (G.inFugenSolid(lon + dlon * probe, lat + dlat * probe, fugenList, hole)) {
        hit = true;
        break;
      }
    }
    // 已贴在外侧很近时也软修正
    const near = G.inFugenSolid(lon, lat + 0.15, fugenList, hole) ||
      G.inFugenSolid(lon + 0.15, lat, fugenList, hole) ||
      G.inFugenSolid(lon - 0.15, lat, fugenList, hole) ||
      G.inFugenSolid(lon, lat - 0.15, fugenList, hole);

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

  function moveStepOnce(lon, lat, vmax, dtHours, cfg, fugenList, hole) {
    ({ lon, lat } = pushOutOfFugen(lon, lat, fugenList, hole));

    const st = steeringAt(lon, lat, cfg, fugenList, hole);
    const beta = betaDrift(lat, cfg.betaStrength);
    let u = st.u + beta.u;
    let v = st.v + beta.v;

    ({ u, v } = slideAlongFugen(lon, lat, u, v, fugenList, hole));

    // 强化：绿线以北只保满 ENE；fringe 中段弧轻加成；开阔洋面 0.3° 纯北。
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG;
    const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);
    if (edge != null) {
      const northOf = lat - edge;
      if (northOf >= 0) {
        // B) 绿线以北：无弧加成；只保证满 ENE 东分量
        if (u < 1.2) u = 1.2;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        // A-arc) fringe 中段北鼓轻加成；近绿线抬东向收束
        const t = clamp((northOf + RECURVE_ARC_DEG) / RECURVE_ARC_DEG, 0, 1);
        const te = 1 - Math.pow(1 - t, 1.35);
        if (te < 0.12) {
          u = 0;
          v += 2.2 * te;
        } else {
          u += 2.0 * (0.72 + 0.28 * te) * te;
          v += 1.65 * Math.sin(Math.PI * Math.max(te, 0.12)) * (0.55 + 0.45 * (1 - te));
          if (te >= 0.55 && u < 1.2) u = 1.2;
          const hLim = Math.tan(68 * Math.PI / 180);
          if (u > 0 && v > u * hLim) v = u * hLim;
        }
        if (v < 0) v = 0;
      } else if (northOf >= -band) {
        // A) 开阔洋面 ≈0.3°：完全往北
        const t = clamp((northOf + band) / band, 0, 1);
        u = 0;
        v += 2.2 * t;
        if (v < 0) v = 0;
      }
    }
    // 硬门控（beta + slide 之后）
    if (edge != null && lat < edge) {
      const northOf = lat - edge;
      if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        const tGate = (northOf + RECURVE_ARC_DEG) / RECURVE_ARC_DEG;
        const teGate = 1 - Math.pow(1 - tGate, 1.35);
        if (teGate < 0.12) u = 0;
      } else if (northOf >= -band) {
        u = 0;
      } else {
        u = Math.min(u, 0);
      }
    }

    const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
    // 单步位移上限（度），抑制锯齿
    let stepLon = dlon * dtHours;
    let stepLat = dlat * dtHours;
    const stepLim = 0.55;
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

  function moveStep(lon, lat, vmax, dtHours, cfg, fugenList, hole) {
    // 大时间步拆成子步，贴边更顺滑
    const n = Math.max(1, Math.min(6, Math.ceil(dtHours / 0.75)));
    const sub = dtHours / n;
    let u = 0, v = 0, st = null;
    for (let i = 0; i < n; i++) {
      const r = moveStepOnce(lon, lat, vmax, sub, cfg, fugenList, hole);
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

    const moved = moveStep(m.lon, m.lat, m.vmax, dtHours, cfg, fugenList, holeRef);
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
    RECURVE_ARC_DEG,
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
