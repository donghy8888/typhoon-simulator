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

  /** 二次 Bezier 航向：起点 due-N → 深 NE 顶点（大半圆弧振幅）→ 满 ENE（在副高北缘/绿线处完成） */
  function bezierHeading(a0, a1, a2, t) {
    const ab = lerpAngle(a0, a1, t);
    const bc = lerpAngle(a1, a2, t);
    return lerpAngle(ab, bc, t);
  }

  /**
   * 是否贴在副高北缘 fringe（实体内，或外侧近邻探测到红区）。
   * 深 fringe 可用较长预备弧；开阔洋/gap 的可见转向不再依赖此门控。
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
   *   A) [edge−NORTH_LEG≈2.5°, edge)：所有路径 N→ENE 大半圆 Bezier（开阔洋/gap/fringe）
   *      ——APPROACH≈0.15° 处仍明显往北（teHold）；其后平滑收束到绿线满 ENE
   *      ——ang1 深 NE + midEast 东鼓 → 路径可见大半圆（非竖直贴线后尖折）
   *      ——FORBIDDEN：弧在绿线以北才开始；lat≥edge 保持 ENE；禁绿线 tip 角
   *   B) lat >= edge：满东北偏东（ENE = wU,wVE），无新弧、无北鼓
   *   C) 更南开阔洋：基础引导场 only（杀东向）
   *   F) 深 fringe（仍南于 NORTH_LEG）：预备抬向 due-N，不覆盖开阔洋
   */
  // 弧窗加宽：绿线以南 ~2.5° 走完可见大半圆（含 ~0.15° APPROACH 仍往北）
  const NORTH_LEG_DEG = 2.5;
  // 深 fringe 预备弧（仅 onFringe）；开阔洋不用
  const RECURVE_ARC_DEG = 7.0;
  // APPROACH 处 Bezier 进度上限：仍明显往北，再在最后 0.15° 收束到 ENE
  const APPROACH_TE_HOLD = 0.42;

  /**
   * 弧窗进度：南段缓入到 teHold（APPROACH 仍往北），末 0.15° 平滑 → 1（满 ENE，无尖角）。
   */
  function approachTe(t, arcDeg) {
    const approach = (typeof G !== 'undefined' && G.APPROACH_NORTH_BAND_DEG) ? G.APPROACH_NORTH_BAND_DEG : 0.15;
    const tHold = 1 - approach / Math.max(approach + 0.05, arcDeg);
    const teHold = APPROACH_TE_HOLD;
    if (t <= tHold) {
      return Math.pow(t / Math.max(1e-9, tHold), 1.22) * teHold;
    }
    return teHold + (1 - teHold) * Math.pow((t - tHold) / Math.max(1e-9, 1 - tHold), 1.12);
  }

  /**
   * 通用 N→ENE 大半圆 Bezier —— 所有接近绿线的路径（开阔洋/gap/fringe）。
   * 弧窗 = NORTH_LEG_DEG（~2.5°）：南端 due-N；APPROACH(~0.15°) 仍往北；edge 满 ENE。
   * ang1 深 NE + midEast 东向鼓包 → 地图上大半圆弧；te→1 连续收束，禁绿线尖角。
   */
  function approachBendUV(northOf, arcDeg, wU, wVE, spdW) {
    const t = clamp((northOf + arcDeg) / arcDeg, 0, 1); // 0@edge−arc → 1@edge
    const te = approachTe(t, arcDeg);
    const ang0 = Math.PI * 0.5; // due north
    // 顶点深 NE（~45–55°）：拉开大半圆；过北的 ang1 会把路径压成竖线+尖折
    const ang1 = Math.atan2(Math.max(5.6, wU * 0.78), Math.max(4.2, wU * 0.55));
    const angENE = Math.atan2(wVE, Math.max(0.01, wU));
    const ang = bezierHeading(ang0, ang1, angENE, te);
    // 南段稍慢以便东鼓拉开大半圆；APPROACH 处 v 仍明显（往北），末段收满 ENE
    const spd0 = Math.max(4.0, spdW * 0.42);
    const spd = spd0 * (1 - te) + spdW * te;
    const midEast = 11.5 * Math.sin(Math.PI * te) * (0.35 + 0.65 * te);
    const midBulge = 6.5 * Math.sin(Math.PI * te) * (1 - 0.22 * te);
    let u = Math.cos(ang) * spd + midEast;
    let v = Math.sin(ang) * spd + midBulge;
    if (te < 0.05) u = 0;
    if (te >= 0.18 && u < 2.2) u = 2.2 + (te - 0.18) / 0.82 * Math.max(0, wU - 2.2);
    // APPROACH 附近：禁止已接近 ENE（保“仍往北”）；中段允许 NE 以拉开振幅
    if (te >= APPROACH_TE_HOLD - 0.04 && te <= APPROACH_TE_HOLD + 0.03) {
      const maxU = Math.max(2.0, v * Math.tan(38 * Math.PI / 180)); // hdg >= ~52°
      if (u > maxU) u = maxU;
      if (v < Math.max(6.5, u * 1.05)) v = Math.max(6.5, u * 1.05);
    }
    if (te >= 0.84) {
      const s = (te - 0.84) / 0.16; // 近绿线贴满 ENE，消 Δhdg 尖角
      u = u * (1 - s) + wU * s;
      v = v * (1 - s) + wVE * s;
    }
    if (v < 0) v = 0;
    if (te >= 0.88 && u > 2.0) {
      const hLim = Math.tan(58 * Math.PI / 180);
      if (v > u * hLim + 1.2) v = u * hLim + 1.2;
    }
    return { u, v, te, t };
  }

  function steeringAt(lon, lat, cfg, fugenList, hole) {
    let u = cfg.steerU;
    let v = cfg.steerV;

    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    // APPROACH_NORTH_BAND_DEG(0.15°)：弧窗内“仍往北”的参考；实际弧窗 = NORTH_LEG_DEG
    if (edge != null) {
      const northOf = lat - edge;
      const wU = cfg.westerlyU;
      const wV = 2.2 + Math.max(0, cfg.westerlyU) * 0.08;
      const wVE = Math.min(wV, Math.max(0.01, wU) * 0.42); // ENE 北分上限 ~23°
      const angENE = Math.atan2(wVE, Math.max(0.01, wU));
      const spdW = Math.hypot(wU, wVE);
      const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);

      if (northOf >= 0) {
        // B) 绿线以北：满 ENE（与弧终点 wU,wVE 一致；弧已在 edge 南侧完成）
        u = wU;
        v = wVE;
      } else if (northOf >= -NORTH_LEG_DEG) {
        // A) 所有路径：NORTH_LEG 窗内 N→ENE 大半圆 Bezier
        //    ~APPROACH(0.15°) 处 te 仍偏低＝明显往北；edge 处满 ENE；连续无尖角
        const b = approachBendUV(northOf, NORTH_LEG_DEG, wU, wVE, spdW);
        u = b.u;
        v = b.v;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        // F) 深 fringe 预备：抬向 due-N（不刷到开阔洋）
        const t = (northOf + RECURVE_ARC_DEG) / (RECURVE_ARC_DEG - NORTH_LEG_DEG);
        const te = clamp(t, 0, 1);
        u = Math.min(u, 0) * (1 - te);
        v = Math.max(0, v) * (1 - te) + 4.6 * te;
      }
      // C) 更南开阔洋：基础场

      // 硬门控（绿线以南）——弧窗内允许东分量随 te 增长（禁整窗 u=0 掐死弧）
      if (northOf < 0) {
        if (northOf >= -NORTH_LEG_DEG) {
          const tGate = clamp((northOf + NORTH_LEG_DEG) / NORTH_LEG_DEG, 0, 1);
          const teGate = approachTe(tGate, NORTH_LEG_DEG);
          if (teGate < 0.05) u = 0;
        } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
          u = Math.min(u, 0);
        } else {
          u = Math.min(u, 0); // 开阔洋面杀东向
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

  function moveStepOnce(lon, lat, vmax, dtHours, cfg, fugenList, hole) {
    ({ lon, lat } = pushOutOfFugen(lon, lat, fugenList, hole));

    const st = steeringAt(lon, lat, cfg, fugenList, hole);
    const beta = betaDrift(lat, cfg.betaStrength);
    let u = st.u + beta.u;
    let v = st.v + beta.v;

    ({ u, v } = slideAlongFugen(lon, lat, u, v, fugenList, hole));

    // 强化：绿线以北满 ENE；~0.15° 弯带全路径大半圆加成；北段腿纯北。
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    const band = G.APPROACH_NORTH_BAND_DEG;
    const onFringe = nearNorthernFugenFringe(lon, lat, fugenList, hole);
    if (edge != null) {
      const northOf = lat - edge;
      if (northOf >= 0) {
        // B) 绿线以北：无弧加成；压回满 ENE（与 wVE 一致）
        if (u < 1.2) u = 1.2;
        const eneVcap = Math.min(
          2.2 + Math.max(0, cfg.westerlyU) * 0.08,
          Math.max(0.01, cfg.westerlyU) * 0.42
        ) + Math.abs(beta.v) * 0.35;
        if (v > eneVcap + 0.35) v = eneVcap + 0.35;
      } else if (northOf >= -NORTH_LEG_DEG) {
        // A) 全路径弧窗：东鼓为主 + 适度北鼓，与 steeringAt Bezier 同相（可见大半圆）
        const t = clamp((northOf + NORTH_LEG_DEG) / NORTH_LEG_DEG, 0, 1);
        const te = approachTe(t, NORTH_LEG_DEG);
        if (te < 0.05) {
          u = 0;
          v += 2.2 * Math.max(te, 0.02);
        } else {
          // 补偿 β 西漂并抬东鼓；APPROACH 处抬北保“仍往北”
          u += 4.8 * (0.35 + 0.65 * te) * te;
          v += 3.2 * Math.sin(Math.PI * Math.max(te, 0.05)) * (0.75 + 0.25 * (1 - te));
          if (te >= APPROACH_TE_HOLD - 0.04 && te <= APPROACH_TE_HOLD + 0.03) {
            const maxU = Math.max(2.0, v * Math.tan(38 * Math.PI / 180));
            if (u > maxU) u = maxU;
            if (v < Math.max(6.5, u * 1.05)) v = Math.max(6.5, u * 1.05);
          } else if (te >= 0.18 && u < 2.2) {
            u = 2.2;
          }
          if (te >= 0.88 && u > 2.0) {
            const hLim = Math.tan(58 * Math.PI / 180);
            if (v > u * hLim + 1.2) v = u * hLim + 1.2;
          }
        }
        if (v < 0) v = 0;
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        u = Math.min(u, 0);
        v += 1.2;
        if (v < 0) v = 0;
      }
    }
    // 硬门控（beta + slide 之后）——弧窗内勿整窗掐死 u
    if (edge != null && lat < edge) {
      const northOf = lat - edge;
      if (northOf >= -NORTH_LEG_DEG) {
        const tGate = clamp((northOf + NORTH_LEG_DEG) / NORTH_LEG_DEG, 0, 1);
        const teGate = approachTe(tGate, NORTH_LEG_DEG);
        if (teGate < 0.05) u = 0;
      } else {
        u = Math.min(u, 0);
      }
    }

    const { dlon, dlat } = G.degPerHourFromMs(u, v, lat);
    // 单步位移上限：近绿线/弯带必须细步，否则 0.15° 弧被一步跨过 → 尖角
    let stepLon = dlon * dtHours;
    let stepLat = dlat * dtHours;
    let stepLim = 0.55;
    if (edge != null) {
      const dist = Math.abs(lat - edge);
      if (dist <= band + 0.05) stepLim = 0.022;
      else if (dist <= NORTH_LEG_DEG + 0.2) stepLim = 0.10;
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

  function moveStep(lon, lat, vmax, dtHours, cfg, fugenList, hole) {
    // 大时间步拆成子步；近绿线加密，确保 0.15° 弯带被采样
    const edge = G.guidingNorthernEdgeLat(lon, fugenList, hole);
    let n = Math.max(1, Math.min(6, Math.ceil(dtHours / 0.75)));
    if (edge != null) {
      const dist = Math.abs(lat - edge);
      if (dist <= G.APPROACH_NORTH_BAND_DEG + 0.08) n = Math.max(n, Math.min(16, Math.ceil(dtHours / 0.12)));
      else if (dist <= NORTH_LEG_DEG + 0.25) n = Math.max(n, Math.min(12, Math.ceil(dtHours / 0.22)));
    }
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
    NORTH_LEG_DEG,
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
