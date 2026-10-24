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

  /**
   * 引导气流：基础场 + 副高北边整片西风带
   * 副高北缘以南：用基础引导；北缘以北（不含副高实体）：整片西风带。
   * 例：副高伸到长江以南 → 长江以北全是西风带，不再拖到更高纬度才起作用。
   */
  function steeringAt(lon, lat, cfg, fugenList, hole) {
    let u = cfg.steerU;
    let v = cfg.steerV;

    const edge = G.northernFugenEdgeLat(lon, fugenList, hole);
    if (edge != null) {
      // 跨越北缘约 1° 的窄过渡，以北即满西风
      const northOf = lat - edge;
      if (northOf >= 0) {
        u = cfg.westerlyU;
        v = 1.6 + Math.max(0, cfg.westerlyU) * 0.08;
      } else if (northOf > -1.0) {
        const w = (northOf + 1.0) / 1.0; // -1→0，0→1
        u = u * (1 - w) + cfg.westerlyU * w;
        v = v * (1 - w) + (1.6 + Math.max(0, cfg.westerlyU) * 0.08) * w;
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

  /** 从副高实体内推出 */
  function pushOutOfFugen(lon, lat, fugenList, hole, maxIter) {
    maxIter = maxIter || 12;
    for (let k = 0; k < maxIter; k++) {
      if (!G.inFugenSolid(lon, lat, fugenList, hole)) break;
      const gg = G.fugenGradient(lon, lat, fugenList, hole);
      let gl = Math.hypot(gg.gx, gg.gy);
      if (gl < 1e-6) {
        // 深陷内部：向南偏西退出（副高南缘通常开口）
        lon -= 0.35;
        lat -= 0.25;
      } else {
        lon -= (gg.gx / gl) * 0.4;
        lat -= (gg.gy / gl) * 0.4;
      }
    }
    return { lon, lat };
  }

  function moveStep(lon, lat, vmax, dtHours, cfg, fugenList, hole) {
    // 先保证不在实体内
    ({ lon, lat } = pushOutOfFugen(lon, lat, fugenList, hole));

    const st = steeringAt(lon, lat, cfg, fugenList, hole);
    const beta = betaDrift(lat, cfg.betaStrength);
    let u = st.u + beta.u;
    let v = st.v + beta.v;

    // 采样前向点，禁止穿入
    const probe = 0.6;
    const { dlon: pLon, dlat: pLat } = G.degPerHourFromMs(u, v, lat);
    const flon = lon + pLon * probe;
    const flat = lat + pLat * probe;
    if (G.inFugenSolid(flon, flat, fugenList, hole)) {
      const g = G.fugenGradient(lon, lat, fugenList, hole);
      // 也看前向梯度
      const g2 = G.fugenGradient(flon, flat, fugenList, hole);
      const gx = g.gx + g2.gx, gy = g.gy + g2.gy;
      const gl = Math.hypot(gx, gy) || 1;
      const nx = gx / gl, ny = gy / gl;
      const into = u * nx + v * ny;
      if (into > 0) {
        u -= into * nx;
        v -= into * ny;
      }
      // 沿边界切向滑动（使环流更顺）
      const tx = -ny, ty = nx;
      const along = u * tx + v * ty;
      const prefer = along >= 0 ? 1 : -1;
      u = tx * Math.max(1.5, Math.abs(along)) * prefer;
      v = ty * Math.max(1.5, Math.abs(along)) * prefer;
      // 略微外推
      u -= nx * 1.2;
      v -= ny * 1.2;
    }

    // 副高北缘进入西风带：加速向东北拐弯（整片北侧都属西风带）
    const edge = G.northernFugenEdgeLat(lon, fugenList, hole);
    if (edge != null && lat >= edge - 0.5 && !G.inFugenSolid(lon, lat, fugenList, hole)) {
      const deep = clamp((lat - edge) / 6, 0, 1); // 越往北西风影响越稳
      u += 1.2 + 2.2 * deep;
      v += 0.8 + 1.4 * deep;
    }

    const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
    let nlon = lon + dlon * dtHours;
    let nlat = lat + dlat * dtHours;
    ({ lon: nlon, lat: nlat } = pushOutOfFugen(nlon, nlat, fugenList, hole));

    nlon = clamp(nlon, G.DOMAIN.lonMin + 0.2, G.DOMAIN.lonMax - 0.2);
    nlat = clamp(nlat, G.DOMAIN.latMin + 0.2, G.DOMAIN.latMax - 0.2);

    return { lon: nlon, lat: nlat, u, v, steer: st };
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
