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

  /** 二次 Bezier 航向：起点 ENE → 略偏北 ENE/NE 顶点（大弧振幅）→ 满 ENE；禁止纯北/NW 顶点 */
  function bezierHeading(a0, a1, a2, t) {
    const ab = lerpAngle(a0, a1, t);
    const bc = lerpAngle(a1, a2, t);
    return lerpAngle(ab, bc, t);
  }

  /**
   * 引导气流：两区制（绿线 = guidingNorthernEdgeLat，与绘制一致）
   *   A) [edge−APPROACH_NORTH_BAND_DEG, edge) ≈ [edge−0.3°, edge)：完全往北（u = 0）
   *      ——纯北带只在绿线以南；带宽=0.3°（≈1/3 of 0.9°）；绝不用 edge+N° / 弧长当南侧带宽
   *      ——整带强制 u = 0（不是 u≤0／偏北 NW）；禁止东/西分量；禁止往南
   *   B) lat >= edge：从踏入绿线以北第一步起就是东北偏东（ENE），非「先北后 NE」
   *      ——大振幅 Bezier 缓入满 ENE；onset 东分量已主导；禁止直角急转 / 纯北起点
   *   C) lat <= edge−0.3°：基础引导场 only
   * 所有 westerly / Bezier / ENE 项必须门控在 lat >= edge。
   * RECURVE_ARC_DEG 只描述绿线以北弧长，≠ 南侧 0.3° 接近带宽度。
   */
  // 绿线以北完成「大弧→满 ENE」的纬度尺度（仅 lat≥edge）；与南侧 0.3° 带宽无关
  const RECURVE_ARC_DEG = 7.0;

  function steeringAt(lon, lat, cfg, fugenList, hole) {
    let u = cfg.steerU;
    let v = cfg.steerV;

    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG; // ≈0.3°（1/3 of 0.9°）；仅用于绿线以南
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      // 目标 NE：东向西风 + 适度北分（仅 lat >= edge 使用）
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      if (northOf >= RECURVE_ARC_DEG) {
        // 弧已完成：满西风 NE
        u = wU;
        v = wV;
      } else if (northOf >= 0) {
        // B) 绿线以北：从 onset 起东北偏东（ENE）。东分量主导，非先北后 NE / 纯北
        const t = northOf / RECURVE_ARC_DEG; // 0@绿线 → 1@弧完成
        const te = 1 - Math.pow(1 - t, 1.35); // 前载东分量，大弧仍光滑
        // 目标满 ENE：压低北分，使航向偏东（东北偏东 ≈ 15–28° from east）
        const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42); // ENE 终点北分上限
        const angENE = Math.atan2(wVE, Math.max(0.01, wU));
        // onset@edge：已是 ENE（约 22–32°），u>v；绝不用 π/2 / NE~50°+ 起点
        const ang0 = Math.atan2(Math.max(1.0, wU * 0.28), Math.max(2.4, wU * 0.78));
        // 顶点：略抬北做大弧振幅，但仍 <45°（禁纯北/NW）；保持 ENE 族
        const ang1 = Math.atan2(Math.max(1.4, wU * 0.38), Math.max(2.0, wU * 0.72));
        const ang2 = angENE;
        const ang = bezierHeading(ang0, ang1, ang2, te);
        const spdW = Math.hypot(wU, wVE);
        const spd0 = Math.hypot(Math.max(2.4, wU * 0.78), Math.max(1.0, wU * 0.28));
        const spd = spd0 * (1 - te) + spdW * te;
        // 轻量中段北鼓包做大弧；绝不把航向拽过 NE 到纯北
        const midBulge = 1.4 * te * (1 - te);
        u = Math.cos(ang) * spd;
        v = Math.sin(ang) * spd + midBulge;
        // 硬：绿线以北第一步起东分量必须主导（ENE：u 显著 > 0，且不低于轻北分）
        if (u < 1.6) u = 1.6 + te * Math.max(0, wU - 1.6);
        // 保 ENE 族：onset/弧中 u 不得被北鼓包压成「偏北 NE」
        if (v > u * 0.95) v = u * 0.95;
      } else if (northOf >= -band) {
        // A) 绿线以南 [edge−0.3, edge)：完全往北（due north）。u 必须 = 0，不是 ≤0／偏北
        //    南界 inclusive：lat >= edge−band && lat < edge
        const t = clamp((northOf + band) / band, 0, 1); // 0@南界 → 1@绿线
        u = 0; // 强制纯北：禁东、禁西（u≤0 仍会露出 NW 偏北）
        v = Math.max(0, v * (1 - t) + 4.6 * t); // 主导北向，禁止往南
      }
      // C) northOf < -band：基础场，无西风、无接近带加成

      // 硬门控：接近带内强制 u=0；带外以南只杀东向（防 slide/混合泄漏）
      if (northOf < 0) {
        if (northOf >= -band) u = 0;
        else u = Math.min(u, 0);
      }
    } else if (lat >= 32) {
      u = cfg.westerlyU;
      v = 1.5;
    }

    if (G.inFugenSolid(lon, lat, fugenList, hole)) {
      u *= 0.2;
      v *= 0.2;
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
    if (Math.abs(along) < 0.4) {
      const stSign = (Math.abs(u) + Math.abs(v)) > 0.01 ? 1 : 1;
      along = 1.2 * (along >= 0 ? 1 : -1) * stSign;
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

    // 两区强化：南≈0.3° 只加北向；绿线处以北立刻东/ENE 大弧（禁止先北后 NE）。
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG; // 仅 [edge−0.3, edge)
    if (edge != null && !G.inFugenSolid(lon, lat, fugenList, hole)) {
      if (lat >= edge) {
        const t = clamp((lat - edge) / RECURVE_ARC_DEG, 0, 1);
        const te = 1 - Math.pow(1 - t, 1.35); // 与 steeringAt 同前载
        // B) onset@edge 即东向 ENE；轻北鼓包做大弧——禁止 early west / 先北后 NE
        u += 2.05 * (0.72 + 0.28 * te);
        v += 0.85 * Math.sin(Math.PI * Math.max(te, 0.08)) * (0.55 + 0.45 * (1 - te));
        // 保 ENE：加成后仍要东分量主导
        if (v > u * 0.95) v = u * 0.95;
      } else if (lat >= edge - band) {
        // A) 仅绿线以南 ≈0.3°：完全往北（u=0）；南界 inclusive；禁止偏北 NW / 东漏
        const t = clamp((lat - (edge - band)) / band, 0, 1);
        u = 0;          // 强制纯北：不做轻西加成（那会变成偏北）
        v += 2.2 * t;   // 北向加成
        if (v < 0) v = 0;
      }
    }
    // 硬门控（必须在 beta + slideAlongFugen 之后）：接近带内 u=0；带外以南只杀东向
    // slide 可能重新引入东向，故在此再杀一次
    if (edge != null && lat < edge) {
      if (lat >= edge - band) u = 0;
      else u = Math.min(u, 0);
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
