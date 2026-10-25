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
   * 根因（20261025z）：
   *   1) 西缘圆角绿线随经度抬升 → 路径贴边，[edge−0.15,edge) 被跳过，看不见往北；
   *   2) northOf≈0 抖动使旧 arcProgress 反复清零 → 半弧/振幅起不来；
   *   3) 绿北曾强制 u≥1.2 → 绿线处立刻 ENE。
   *
   * 状态机（arcState）：
   *   A) 首次进入绿南 ~0.22°：legTargetLat=max(edge,lat+0.15)，u≡0 往北直到越过；
   *   B) 越过后锁存 arcLat0，大振幅 ENE 半弧（不因 edge 回追重置）；s=0=due-N；
   *      目标 Δlon≈20–25°+。C) 更南基础场；F) 深 fringe 预备。
   */
  const NORTH_LEG_DEG = 0.15;
  const RECURVE_ARC_DEG = 7.0;
  const POST_GREEN_ARC_DEG = 6.0;
  const TARGET_ARC_DLON_DEG = 22;
  const ARC_BOW_LON_DEG = 15;
  const ENE_MAX_HDG = 52 * Math.PI / 180;
  const LEG_TRIGGER_DEG = 0.22;
  /** 越绿后先再往北抬这么多，脱离圆角贴边，再放大振幅东折 */
  const CLEAR_NORTH_DEG = 0.85;
  /** 短清脊后尽早东折；半弧前段压低 v 从九州南侧过海，目标 Δlon≥20 */
  const CLEAR_LAT_MIN = 28.3;
  const CLEAR_NORTHOF_MIN = 0.45;

  function approachNorthUV(northOf, band, spdW) {
    const u = 0;
    let v = Math.max(5.8, spdW * 0.72);
    if (v < 0) v = 0;
    return { u, v, ta: clamp((northOf + band) / Math.max(1e-9, band), 0, 1) };
  }

  function postGreenArcUV(sRaw, lat, wU, wVE, spdW) {
    const s = clamp(sRaw, 0, 1);
    const angENE = Math.atan2(wVE, Math.max(0.01, wU));
    // s=0 due-N 接竖段；很快转到深东（压低 v，九州南侧过海以拉 Δlon）；终点满 ENE
    const ang0 = Math.PI * 0.5;
    const angMid = Math.min(angENE, 6 * Math.PI / 180);
    let ang;
    if (s < 0.12) {
      ang = lerpAngle(ang0, 35 * Math.PI / 180, smoothstep(s / 0.12));
    } else {
      ang = bezierHeading(35 * Math.PI / 180, angMid, angENE, smoothstep((s - 0.12) / 0.88));
    }
    const spd = Math.max(spdW, 9.0);
    let u = Math.cos(ang) * spd;
    let v = Math.sin(ang) * spd;
    // 强东鼓：目标 Δlon 20–25°+
    const bowU = (3.6 * ARC_BOW_LON_DEG) * Math.sin(Math.PI * Math.pow(s, 0.7));
    u += bowU;
    if (s < 0.08) {
      if (u < 0) u = 0;
    } else {
      // 前中段压低北分，优先东向振幅
      const maxV = u * Math.tan(Math.min(ENE_MAX_HDG, (28 - 10 * smoothstep((s - 0.08) / 0.35)) * Math.PI / 180));
      if (v > maxV) v = Math.max(maxV, u * 0.12);
      if (u < spd * 0.35) u = spd * (0.35 + 0.5 * smoothstep((s - 0.08) / 0.2));
    }
    if (v < 0) v = 0;
    return { u, v, s };
  }

  function ensureLegTarget(northOf, lat, edge, arcState) {
    if (!arcState) return null;
    if (arcState.legTargetLat != null) return arcState.legTargetLat;
    if (northOf >= -LEG_TRIGGER_DEG && northOf < 0) {
      arcState.legTargetLat = Math.max(edge, lat + NORTH_LEG_DEG);
      return arcState.legTargetLat;
    }
    if (northOf >= 0) {
      arcState.legTargetLat = (northOf < 0.12) ? (lat + NORTH_LEG_DEG) : lat;
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
    // 东向振幅优先：lon 进度权重提高
    let s = clamp(Math.max(sLat * 0.7, sLon * 0.85), 0, 1);
    s = clamp(Math.min(s, (arcState.sAcc || 0) + 0.14), 0, 1);
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
      } else if (arcActive) {
        const clearLat = Math.max(
          CLEAR_LAT_MIN,
          (arcState.legTargetLat != null ? arcState.legTargetLat : lat) + CLEAR_NORTH_DEG
        );
        const cleared = lat >= clearLat || northOf >= CLEAR_NORTHOF_MIN;
        const needClear = (arcState.clearLon0 == null) && !cleared;
        if (needClear) {
          // B0) 先抬北取得净空，再东折半弧（避免圆角贴边）
          const base = arcState.arcLat0 != null ? arcState.arcLat0 : lat;
          const span = Math.max(1e-3, clearLat - base);
          const tc = clamp((lat - base) / span, 0, 1);
          const spd = Math.max(spdW, 8.0);
          u = spd * (0.04 + 0.28 * smoothstep(tc));
          v = spd * (0.99 - 0.18 * smoothstep(tc));
        } else {
          const s = arcProgress(lat, lon, arcState, false);
          if (s < 1) {
            const b = postGreenArcUV(s, lat, wU, wVE, spdW);
            u = b.u;
            v = b.v;
          } else {
            u = wU;
            v = wVE;
          }
        }
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        const t = (northOf + RECURVE_ARC_DEG) / (RECURVE_ARC_DEG - band);
        const te = clamp(t, 0, 1);
        u = Math.min(u, 0) * (1 - te);
        v = Math.max(0, v) * (1 - te) + 4.6 * te;
      }

      if (inNorthLeg) {
        u = 0;
      } else if (northOf < 0 && !arcActive) {
        if (northOf >= -band) u = 0;
        else u = Math.min(u, 0);
      }
    } else if (lat >= 32) {
      u = cfg.westerlyU;
      v = 1.5;
    }

    const arcOn = !!(arcState && (
      (arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) ||
      (arcState.arcLat0 != null && arcState.clearLon0 == null)
    ));
    if (G.inFugenSolid(lon, lat, fugenList, hole)) {
      if (arcState && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) {
        // 东折半弧：轻阻尼，允许穿脊；不抬 v，避免过早撞日本
        u *= 0.9;
        v *= 0.9;
        u = Math.max(u, 5.0);
      } else if (arcOn) {
        v = Math.max(v, 8.0);
        u = Math.max(0, Math.min(u, 3.0));
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
        const clearLat = Math.max(
          CLEAR_LAT_MIN,
          (arcState.legTargetLat != null ? arcState.legTargetLat : lat) + CLEAR_NORTH_DEG
        );
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
          u = spd * (0.04 + 0.28 * smoothstep(tc));
          v = Math.max(spd * (0.99 - 0.18 * smoothstep(tc)), 7.5);
          if (G.inFugenSolid(lon, lat, fugenList, hole) || northOf < 0.5) {
            u = Math.min(u, spd * 0.18);
            v = Math.max(v, 10.0);
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
            u = b.u + beta.u * 0.1 * smoothstep(s);
            v = b.v + beta.v * 0.1;
            // 前 60% 半弧：强东、压北，从九州南侧过海以拉大 Δlon
            if (s < 0.7) {
              u = Math.max(u, 18);
              const cap = u * Math.tan((9 + 7 * s) * Math.PI / 180);
              if (v > cap) v = cap;
            } else {
              const minU = 1.3 * smoothstep(Math.max(0, (s - 0.05) / 0.28));
              if (u < minU) u = minU;
            }
            if (northOf < -0.35) {
              v = Math.max(v, 3.5);
              u = Math.max(u, 8);
            }
            if (s >= 0.08 && u > 0.4 && Math.atan2(v, u) > ENE_MAX_HDG) {
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
        }
      } else if (onFringe && northOf >= -RECURVE_ARC_DEG) {
        u = Math.min(u, 0);
        v += 1.2;
        if (v < 0) v = 0;
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
      // 细步仅用于往北腿；半弧进行中勿因 edge 贴边把东向步长掐成 0.02
      if (inLeg) stepLim = 0.02;
      else if (arcOn && arcState.clearLon0 == null) stepLim = 0.09; // 清脊抬北
      else if (arcOn && arcState.clearLon0 != null && (arcState.sAcc || 0) < 1) stepLim = 0.5;
      else if (arcOn && arcState.clearLon0 == null) stepLim = 0.09;
      else if (!arcOn && dist <= band + 0.08) stepLim = 0.022;
      else if (northOf >= 0 && sArc <= 1.05) stepLim = 0.08;
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
      if (inLeg) n = Math.max(n, Math.min(18, Math.ceil(dtHours / 0.1)));
      else if (arcState && arcState.arcLat0 != null && (arcState.sAcc || 0) < 1) n = Math.max(n, Math.min(12, Math.ceil(dtHours / 0.22)));
      else if (!(arcState && arcState.arcLat0) && dist <= G.APPROACH_NORTH_BAND_DEG + 0.1) n = Math.max(n, Math.min(16, Math.ceil(dtHours / 0.12)));
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
      arcLat0: null, // 半弧锁存纬度原点（完成后不重置）
      arcLon0: null, // 半弧锁存经度原点（辅助 Δlon 进度）
      legTargetLat: null, // 往北腿目标纬度（保 ≥0.15° 竖段）
      sAcc: 0,     // 半弧进度缓增累加器
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
