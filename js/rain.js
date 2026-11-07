/**
 * 台风降水场：运行中只积分累计格、不画瞬时雨墙；路径结束后再画累计降水（mm）雷达阶梯填色。
 * 累计色标（绿→蓝→黄→橙→紫→红，绝对 mm）：同族阶梯带；雨强采样算法不变。
 * 外圈平滑余弦非对称（大风侧肥，非象限阶梯）；山地迎风极强增强/背风极弱；折向=分离北侧弱雨带（轻雨桥）；无移速雨因子；无眼干区。
 */
(function (global) {
  'use strict';

  const G = global.TyGeo;

  /** CMA 档峰值雨强 mm/h [lo, hi]：眼墙/12级环附近 */
  const PEAK_BY_CAT = [
    { name: 'TD', vmaxLo: 0, vmaxHi: 17.2, lo: 8, hi: 15 },
    { name: 'TS', vmaxLo: 17.2, vmaxHi: 24.5, lo: 20, hi: 35 },
    { name: 'STS', vmaxLo: 24.5, vmaxHi: 32.7, lo: 40, hi: 60 },
    { name: 'TY', vmaxLo: 32.7, vmaxHi: 41.5, lo: 70, hi: 100 },
    { name: 'STY', vmaxLo: 41.5, vmaxHi: 50.9, lo: 110, hi: 140 },
    { name: 'SuperTY', vmaxLo: 50.9, vmaxHi: 120, lo: 150, hi: 200 }
  ];

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 由 vmax 取档内插值的峰值雨强 mm/h */
  function peakRainMmH(vmaxMs) {
    const v = +vmaxMs || 0;
    for (let i = 0; i < PEAK_BY_CAT.length; i++) {
      const c = PEAK_BY_CAT[i];
      if (v < c.vmaxHi || i === PEAK_BY_CAT.length - 1) {
        const span = Math.max(1e-6, c.vmaxHi - c.vmaxLo);
        const t = clamp01((v - c.vmaxLo) / span);
        return lerp(c.lo, c.hi, t);
      }
    }
    return 150;
  }

  /** TY / 十二级 vmax 下限 (m/s) — 雨场影响范围基准 */
  const RAIN_EXTENT_TY_VMAX = 32.7;
  /** over=1 约在十七级门槛 56.1 m/s；scale=1+K·over → G17≈1.20×TY（不再收缩） */
  const RAIN_EXTENT_OVER_REF = 56.1 - 32.7;
  const RAIN_EXTENT_GROW_K = 0.2;

  /**
   * 雨场足迹半径（度）。≤十二级/TY 跟风圈；强于 TY 时相对 TY 基准轻微放大
   * （scale=1+K·over，连续、无断崖；远小于风圈随 vmax 的膨胀）。峰值仍由 peakRainMmH 抬升。
   * 返回 { meanR7, meanR12 }，保持 R12/R7 比例。
   */
  function rainFootprintRadii(vmaxMs) {
    const vmax = +vmaxMs || 0;
    let meanR7 = G.windRadiusDeg(vmax) * 1.2;
    let meanR12 = meanR7 * 0.34;
    if (G.windRadiiForGrades) {
      const rings = G.windRadiiForGrades(vmax);
      for (let i = 0; i < rings.length; i++) {
        if (rings[i].grade === 7) meanR7 = rings[i].radiusDeg;
        if (rings[i].grade === 12) meanR12 = rings[i].radiusDeg;
      }
    }
    if (vmax < RAIN_EXTENT_TY_VMAX) {
      meanR12 = Math.max(0.15, meanR7 * 0.28);
    } else if (vmax > RAIN_EXTENT_TY_VMAX) {
      const tyR7 = G.windRadiusDeg(RAIN_EXTENT_TY_VMAX) * 1.2;
      const over = (vmax - RAIN_EXTENT_TY_VMAX) / RAIN_EXTENT_OVER_REF;
      const scale = 1 + RAIN_EXTENT_GROW_K * Math.max(0, over);
      const targetR7 = tyR7 * scale;
      const k = targetR7 / Math.max(1e-6, meanR7);
      meanR7 = targetR7;
      meanR12 = Math.max(0.12, meanR12 * k);
    }
    return { meanR7: meanR7, meanR12: meanR12 };
  }

  /**
   * 径向廓线（无眼）：中心→R12 近峰值；R12→R7 衰减；R7 外继续衰减。
   * rNorm = dist / localR7；r12frac = localR12 / localR7
   */
  /**
   * 径向廓线（相对 localR7）。保留给外缘衰减；主色带由 shellRateMmH 按地理壳层控制。
   */
  function radialProfile(rNorm, r12frac) {
    if (!(rNorm >= 0) || !isFinite(rNorm)) return 0;
    const f12 = Math.max(0.12, Math.min(0.55, +r12frac || 0.34));
    if (rNorm <= f12) return 1;
    if (rNorm <= 1) {
      const t = (rNorm - f12) / Math.max(1e-6, 1 - f12);
      const s = t * t * (3 - 2 * t);
      return lerp(1, 0.14, Math.pow(s, 1.25));
    }
    // 主场外缘更快衰减（再收紧累计雨痕；与 shellRateMmH 外圈一致）
    return 0.14 * Math.exp(-(rNorm - 1) / 0.09);
  }

  /**
   * 雨场局地 R7：连续余弦方位调制（大风侧更肥），禁止四象限常半径+短角拼接。
   * 峰向与风圈同一套 windPeakRayFromHeading；振幅范围同风圈 (~0.52–1+A)，
   * 但不继承 CMA 阶梯 → 外缘绿/蓝等值线为光滑卵形，无东西 G 角。
   */
  function rainLocalR7(meanR7, headingRad, rayRad, amp) {
    const r0 = Math.max(1e-6, +meanR7 || 1);
    const A = Math.max(0, +amp || 0);
    if (!G) return r0;
    const peakRay = G.windPeakRayFromHeading
      ? G.windPeakRayFromHeading(headingRad)
      : ((+headingRad || 0) + Math.PI / 2);
    const c = Math.cos((+rayRad || 0) - peakRay);
    return Math.max(r0 * 0.52, r0 * (1 + A * c));
  }

  /** 折向北侧弱雨带脊：相对 R7 北缘 ~4.8°（略南移；仍远于 3° 轻推） */
  const NORTH_RIDGE_MID = 3.6;
  /** 北带峰值 ~10 mm/h（蓝档内）；永不抬到黄/橙，故重核不会与主体桥接 */
  const NORTH_BAND_PEAK = 10;
  /** 可选轻雨桥上限（绿/蓝）；桥区超过此值则软封顶 */
  const NORTH_BRIDGE_CAP = 8;

  /**
   * Soft envelope merge of core + north band (replaces Math.max union G-corners).
   * Hypot/power-mean p=2: exact when either side is 0; rounds the crossing.
   */
  function mergeNorthBand(rate, band) {
    const aa = Math.max(0, +rate || 0);
    const bb = Math.max(0, +band || 0);
    if (bb <= 1e-9) return aa;
    if (aa <= 1e-9) return bb;
    return Math.hypot(aa, bb);
  }

  /**
   * 折向时的分离北侧弱雨带（E–W 薄叶，脊在 R7 北缘以北 NORTH_RIDGE_MID）。
   * 与主体壳软合并：南足仅绿/毛毛雨–浅蓝桥（≤~BRIDGE_CAP），重核（黄+）不连通。
   * 软门控，禁止硬 Math.max 并集轮廓角。
   */
  /** 北带仅在折向北段（N/NNE）出现；航向偏东 >20° 起渐隐，≥40°（NE/ENE）完全消失 */
  function northBandHeadingFade(headingRad) {
    let h = +headingRad || 0;
    h = Math.atan2(Math.sin(h), Math.cos(h)) * 180 / Math.PI;
    if (h <= 20) return 1;
    if (h >= 40) return 0;
    const t = (h - 20) / 20;
    return 1 - t * t * (3 - 2 * t);
  }

  /** 北带椭圆半轴（1 mm/h 等值线，度）：十二级参考尺寸 = 02f/02g 中点 */
  const NORTH_ELL_A = 3.3;
  const NORTH_ELL_B = 1.3;
  /** 强度缩放：仅大小温和变化，形状（长宽比）恒定。32.7 m/s → 1.0 */
  function northBandScale(vmax) {
    const v = +vmax || 0;
    return Math.max(0.85, Math.min(1.15, 1 + 0.25 * (v - 32.7) / 24.3));
  }

  /**
   * 折向时的分离北侧弱雨带：单一光滑 E–W 椭圆（无经/纬分离门控、无平台、无矩形角）。
   * d² = (dx/a)² + (dy/b)²；rate = PEAK·exp(-ln10·d²)，d=1 即 1 mm/h 边界。
   * 中心在 R7 北缘以北 NORTH_RIDGE_MID；a、b 同比例随强度温和缩放。
   */
  function rainbandNorthMmH(lat, lon, stormLat, stormLon, r7NorthLat, headingRad, vmax) {
    if (!isRecurvingNorth(headingRad)) return 0;
    const fade = northBandHeadingFade(headingRad);
    if (fade <= 0) return 0;
    const sc = northBandScale(vmax);
    const dy = (lat - r7NorthLat) - NORTH_RIDGE_MID;
    const cosLat = Math.cos(stormLat * Math.PI / 180);
    const dx = (lon - stormLon) * Math.max(0.2, cosLat);
    const ea = NORTH_ELL_A * sc;
    const eb = NORTH_ELL_B * sc;
    const d2 = (dx / ea) * (dx / ea) + (dy / eb) * (dy / eb);
    if (d2 > 2.25) return 0;
    let band = NORTH_BAND_PEAK * fade * Math.exp(-2.302585 * d2);
    if (lat - r7NorthLat < NORTH_RIDGE_MID - 1.225 && band > NORTH_BRIDGE_CAP) band = NORTH_BRIDGE_CAP;
    return band;
  }

  /**
   * 嵌套壳雨强（mm/h）：圆形 R12 内 = peak（满盘红核 + 外接紫壳的起点）；
   * 其外按「出核距离 / 风圈局地半径比」拉伸：大风侧壳更宽更强，绝非正圆靶心。
   * 控制点保证 红→紫→橙→黄→蓝→绿 不跳档。
   */
  function shellRateMmH(dist, meanR12, meanR7, localR7, peak) {
    const p = Math.max(0, +peak || 0);
    const r12 = Math.max(1e-6, +meanR12 || 0.3);
    const r7 = Math.max(r12 * 1.2, +meanR7 || 1);
    if (dist <= r12) return p;
    // 跟风圈非对称同量级：局地 R7 / 平均 R7（约 0.52–1.55）；北带不再拉伸主壳
    const stretchRaw = (+localR7 || r7) / r7;
    const stretch = Math.max(0.52, Math.min(1.55, stretchRaw));
    const d = (dist - r12) / stretch;
    const purpleMid = Math.min(72, Math.max(55, p * 0.58));
    // 紫壳用接近圆形的最小宽度，外圈随 stretch 明显拉长
    const purpleW = 0.20 * r7;
    const pts = [
      { d: 0, v: p },
      { d: 0.08 * r7, v: Math.min(p * 0.92, 95) },
      { d: purpleW, v: purpleMid },
      { d: 0.34 * r7, v: 40 },
      { d: 0.38 * r7, v: 18 },
      { d: 0.42 * r7, v: 7 },
      { d: 0.50 * r7, v: 1.6 },
      { d: 0.63 * r7, v: 0.2 }
    ];
    let rate;
    if (d >= pts[pts.length - 1].d) {
      const last = pts[pts.length - 1];
      rate = last.v * Math.exp(-(d - last.d) / (0.06 * r7));
    } else {
      rate = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        if (d <= pts[i + 1].d) {
          const span = pts[i + 1].d - pts[i].d;
          const t = span > 1e-9 ? (d - pts[i].d) / span : 0;
          const s = t * t * (3 - 2 * t);
          rate = lerp(pts[i].v, pts[i + 1].v, s);
          break;
        }
      }
    }
    // 大风侧外圈再略抬强（不作用于 R12 内核）
    const intenBias = Math.pow(stretch, 0.55);
    return rate * intenBias;
  }

  /**
   * 山地迎风/背风（坡向相对风暴）：
   * 比较「朝风暴」与「背风暴」两侧山地权重——向风暴侧变低 = 迎风坡；变高 = 背风坡。
   * 旧逻辑「朝风暴一步仍是山→背风」在宽脊（台湾中央山脉 elev≥700m）上会把大半脊误判背风，
   * 迎风麓地又不在掩码内，导致中央山脉迎风坡看不到抬升。
   * 迎风 ≈5.0×、背风 ≈0.18；迎风麓地（平原贴山、山在背风暴侧）亦软抬升；非山地远场 = 1。
   */
  function isMountainFast(lon, lat, grid) {
    if (grid && grid.mtn) {
      const i = Math.round((lon - grid.lon0) / grid.deg);
      const j = Math.round((lat - grid.lat0) / grid.deg);
      if (i < 0 || j < 0 || i >= grid.nlon || j >= grid.nlat) return false;
      return grid.mtn[grid.idx(i, j)] === 1;
    }
    return !!(G && G.isMountain && G.isMountain(lon, lat));
  }

  /** 山地遮罩双线性采样 0..1，避免 0.22° 方格造成垂直/水平硬接缝 */
  function mountainWeightSoft(lon, lat, grid) {
    if (grid && grid.mtn) {
      const u = (lon - grid.lon0) / grid.deg;
      const v = (lat - grid.lat0) / grid.deg;
      const i0 = Math.floor(u);
      const j0 = Math.floor(v);
      if (i0 < -1 || j0 < -1 || i0 >= grid.nlon || j0 >= grid.nlat) return 0;
      const fx = u - i0;
      const fy = v - j0;
      function sample(ii, jj) {
        if (ii < 0 || jj < 0 || ii >= grid.nlon || jj >= grid.nlat) return 0;
        return grid.mtn[grid.idx(ii, jj)] ? 1 : 0;
      }
      const w00 = sample(i0, j0);
      const w10 = sample(i0 + 1, j0);
      const w01 = sample(i0, j0 + 1);
      const w11 = sample(i0 + 1, j0 + 1);
      return (w00 * (1 - fx) + w10 * fx) * (1 - fy) + (w01 * (1 - fx) + w11 * fx) * fy;
    }
    return isMountainFast(lon, lat, grid) ? 1 : 0;
  }

  /** 台湾地形高度（m），TAIWAN_ELEV 0.05° 格双线性；域外/无数据 = 0 */
  function taiwanElevM(lon, lat) {
    const T = global.TAIWAN_ELEV;
    if (!T) return 0;
    const u = (lon - T.lon0) / T.d;
    const v = (lat - T.lat0) / T.d;
    const i0 = Math.floor(u), j0 = Math.floor(v);
    if (i0 < 0 || j0 < 0 || i0 >= T.nlon - 1 || j0 >= T.nlat - 1) return 0;
    const fx = u - i0, fy = v - j0;
    const e = function (i, j) { return T.dm[j * T.nlon + i] * 10; };
    return (e(i0, j0) * (1 - fx) + e(i0 + 1, j0) * fx) * (1 - fy) +
      (e(i0, j0 + 1) * (1 - fx) + e(i0 + 1, j0 + 1) * fx) * fy;
  }
  /** 0.22° 累计格内高度：取格心周围 ±0.08° 九点最大值（山脊不被平滑掉） */
  function taiwanCellElevM(lon, lat) {
    let m = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      m = Math.max(m, taiwanElevM(lon + a * 0.08, lat + b * 0.08));
    }
    return m;
  }

  function mountainSideFactor(lon, lat, stormLon, stormLat, grid) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dLat = stormLat - lat;
    const dLonRaw = stormLon - lon;
    const dLon = dLonRaw * Math.max(0.2, cosLat);
    const dist = Math.hypot(dLat, dLon);
    if (dist < 1e-4) return 1;

    // ~30 km 主步长（分辨中央山脉东西坡）+ 半步局部边沿
    const step = 0.28;
    const step2 = 0.14;
    const ux = dLonRaw / dist;
    const uy = dLat / dist;
    const tLon = lon + ux * step;
    const tLat = lat + uy * step;
    const aLon = lon - ux * step;
    const aLat = lat - uy * step;
    const t2Lon = lon + ux * step2;
    const t2Lat = lat + uy * step2;
    const a2Lon = lon - ux * step2;
    const a2Lat = lat - uy * step2;

    const w0 = mountainWeightSoft(lon, lat, grid);
    const wT = 0.6 * mountainWeightSoft(tLon, tLat, grid) +
      0.4 * mountainWeightSoft(t2Lon, t2Lat, grid);
    const wA = 0.6 * mountainWeightSoft(aLon, aLat, grid) +
      0.4 * mountainWeightSoft(a2Lon, a2Lat, grid);

    // 迎风麓地：点不在山，但背风暴侧贴山、朝风暴侧开阔（台湾东岸典型）
    if (w0 <= 1e-3) {
      if (wA > 0.35 && wT < 0.25) {
        const prox = clamp01(wA);
        const side = 5.0;
        return 1 + (side - 1) * prox * 0.85;
      }
      return 1;
    }

    // 在山上：山地权重向风暴降低 = 迎风坡；升高 = 背风坡
    const score = (wA - wT) + 0.35 * (w0 - wT);
    let windward;
    if (Math.abs(score) < 0.08) windward = wT <= wA;
    else windward = score > 0;
    let side = windward ? 5.0 : 0.18;
    // 迎风抬升随高度增长（台湾）：上部迎风坡/主脊最大，而非仅坡度最陡的中坡
    if (windward) {
      const el = taiwanCellElevM(lon, lat);
      if (el > 0) side = 5.0 * (0.75 + 0.5 * clamp01((el - 700) / 2300));
    }
    return 1 + (side - 1) * w0;
  }

  /**
   * WNW→N 折向：航向接近北向时启用分离北侧弱雨带（脊 ~NORTH_RIDGE_MID，峰值 ~10 mm/h）。
   */
  function isRecurvingNorth(headingRad) {
    let h = +headingRad || 0;
    h = Math.atan2(Math.sin(h), Math.cos(h));
    // WNW(~-67°) 已转北：航向 (−50°, +40°)
    return h > -50 * Math.PI / 180 && h < 40 * Math.PI / 180;
  }

  /**
   * 单点雨强 mm/h。
   * storm: { lat, lon, vmax, u, v }
   * 外圈非对称：连续余弦指向大风侧（更宽更强），不走四象限阶梯。
   * 折向北时叠加分离北侧弱雨带（hypot 软并，轻雨桥）；R12 内核仍为满盘红核+紫壳。
   */
  function rainRateAt(lat, lon, storm, opts) {
    if (!storm || !G) return 0;
    const grid = opts && opts.grid;
    const lat0 = +storm.lat;
    const lon0 = +storm.lon;
    const vmax = +storm.vmax || 0;
    if (vmax < 10) return 0;

    const u = +storm.u || 0;
    const v = +storm.v || 0;
    const speed = Math.hypot(u, v);
    const hdg = G.motionHeadingRad(u, v);
    // 雨场几何跟 7 级满振幅包络；不另用移速乘子改峰值
    const amp7 = G.windAsymAmp(speed, vmax);
    const fp = rainFootprintRadii(vmax);
    const meanR7 = fp.meanR7;
    const meanR12 = fp.meanR12;

    const cosLat = Math.cos(lat0 * Math.PI / 180);
    const dlat = lat - lat0;
    const dlon = (lon - lon0) * Math.max(0.2, cosLat);
    const dist = Math.hypot(dlat, dlon);
    const ray = dist < 1e-9 ? 0 : Math.atan2(dlon, dlat);

    // 平滑余弦非对称（大风侧更肥）；主壳不再北突
    const localR7 = rainLocalR7(meanR7, hdg, ray, amp7);

    const peak = peakRainMmH(vmax);
    const coreW = dist <= meanR12 ? 1 : (dist < meanR12 + 0.18 * meanR7
      ? 1 - ((dist - meanR12) / (0.18 * meanR7))
      : 0);

    // 嵌套壳：满盘红核+紫壳；外圈随大风侧明显拉宽拉强（光滑卵形，无象限阶梯）
    let rate = shellRateMmH(dist, meanR12, meanR7, localR7, peak);

    // 北侧折向弱雨带：hypot soft envelope（禁 Math.max 硬并集 → 东西 G角）
    const r7North = lat0 + rainLocalR7(meanR7, hdg, 0, amp7);
    const band = (opts && opts.noBand) ? 0 : rainbandNorthMmH(lat, lon, lat0, lon0, r7North, hdg, vmax);
    rate = mergeNorthBand(rate, band);

    // 山地软调制：R12 内核只抹平背风抑制（避免红核被挖洞），迎风抬升仍保留
    let mtn = mountainSideFactor(lon, lat, lon0, lat0, grid);
    if (coreW > 0 && mtn < 1) mtn = mtn + (1 - mtn) * coreW;
    rate *= mtn;
    if (opts && opts.out) opts.out.mtn = mtn;

    if (rate < 0.15) return 0;
    return rate;
  }

  /**
   * 瞬时雨强绝对色标（mm/h）— 仍供 rainRateAt / 积分用；运行时不再上图。
   * 累计色标见 ACCUM_BINS（mm 总量，同色族阶梯）。
   */
  // 绝对分档上界（mm/h）：[0.4,3) 毛毛雨 … [85,∞) 大暴雨（含 130+）
  const RATE_BINS = [
    { max: 3,   r: 70,  g: 200, b: 90,  a: 150 },  // 毛毛雨
    { max: 12,  r: 50,  g: 120, b: 230, a: 160 },  // 小雨
    { max: 28,  r: 245, g: 215, b: 30,  a: 168 },  // 中雨
    { max: 50,  r: 245, g: 140, b: 25,  a: 175 },  // 大雨
    { max: 85,  r: 150, g: 50,  b: 210, a: 180 },  // 暴雨
    { max: Infinity, r: 220, g: 35, b: 40, a: 185 } // 大暴雨 ≥85（130+）
  ];

  // 累计降水绝对分档上界（mm）：同色族雷达阶梯
  const ACCUM_BINS = [
    { max: 10,  r: 70,  g: 200, b: 90,  a: 150 },  // <10
    { max: 25,  r: 50,  g: 120, b: 230, a: 160 },  // 10–25
    { max: 100, r: 245, g: 215, b: 30,  a: 168 },  // 25–100
    { max: 150, r: 245, g: 140, b: 25,  a: 175 },  // 100–150
    { max: 300, r: 150, g: 50,  b: 210, a: 180 },  // 150–300
    { max: 400, r: 220, g: 35, b: 40, a: 185 },     // 300–400
    { max: Infinity, r: 200, g: 20, b: 110, a: 175 }  // ≥400 亮品红绯红 #c8146e 半透明（仅台湾中央山脉高处迎风坡）
  ];

  function colorForRate(mmh) {
    const x = +mmh || 0;
    if (x < 0.4) return [0, 0, 0, 0];
    for (let i = 0; i < RATE_BINS.length; i++) {
      const b = RATE_BINS[i];
      if (x < b.max) return [b.r, b.g, b.b, b.a];
    }
    const last = RATE_BINS[RATE_BINS.length - 1];
    return [last.r, last.g, last.b, last.a];
  }

  function colorForAccum(mm) {
    const x = +mm || 0;
    if (x < 1.5) return [0, 0, 0, 0];
    for (let i = 0; i < ACCUM_BINS.length; i++) {
      const b = ACCUM_BINS[i];
      if (x < b.max) return [b.r, b.g, b.b, b.a];
    }
    const last = ACCUM_BINS[ACCUM_BINS.length - 1];
    return [last.r, last.g, last.b, last.a];
  }

  function colorForMm(mm, maxMm, alphaScale) {
    const c = colorForAccum(mm);
    if (alphaScale != null && alphaScale !== 1 && c[3] > 0) {
      c[3] = Math.round(c[3] * alphaScale);
    }
    return c;
  }

  function binIndexForAccum(mm) {
    const x = +mm || 0;
    if (x < 1.5) return 0;
    for (let i = 0; i < ACCUM_BINS.length; i++) {
      if (x < ACCUM_BINS[i].max) return i + 1;
    }
    return ACCUM_BINS.length;
  }

  function colorForAccumBin(bin) {
    if (bin <= 0) return [0, 0, 0, 0];
    const b = ACCUM_BINS[Math.min(ACCUM_BINS.length, bin) - 1];
    return [b.r, b.g, b.b, b.a];
  }

  /**
   * 累计显示值（mm）：普通海面/平地/其它山地软饱和，渐近 ~380（<400 深红阈值）；
   * 仅台湾中央山脉（含东岸迎风麓）且迎风增幅明显时额外抬升，才可能 ≥400 深红。
   * <120 mm 恒等，不改低档分布。
   */
  const ACCUM_SOFT_KNEE = 120;
  const ACCUM_SOFT_SPAN = 260; // 渐近 = KNEE + SPAN = 380
  function accumSoft(x) {
    if (x <= ACCUM_SOFT_KNEE) return x;
    return ACCUM_SOFT_KNEE + ACCUM_SOFT_SPAN * (1 - Math.exp(-(x - ACCUM_SOFT_KNEE) / ACCUM_SOFT_SPAN));
  }
  function inTaiwanCmrBox(lat, lon) {
    return lon >= 120.4 && lon <= 122.05 && lat >= 21.9 && lat <= 25.35;
  }
  function accumDisplayMm(raw, flat, lat, lon) {
    let v = accumSoft(raw);
    if (inTaiwanCmrBox(lat, lon) && flat > 1e-6) {
      const ratio = raw / flat; // 迎风 >1（最高 ~5），背风 <1
      const w = clamp01((ratio - 1.6) / 1.6);
      // 高度权重：<1500 m 不抬升，≥2700 m 全额 → 深红只落在高处迎风坡/主脊
      const el = taiwanCellElevM(lon, lat);
      const ew = clamp01((el - 1500) / 1200);
      v *= 1 + 0.6 * w * ew;
    }
    return v;
  }

  /**
   * 累计格点：覆盖 DOMAIN，分辨率 deg。
   * 连续填色靠细格 + canvas 拉伸，避免 coarse tile 块感。
   */
  function AccumGrid(deg) {
    this.deg = deg || 0.25;
    this.lon0 = G.DOMAIN.lonMin;
    this.lat0 = G.DOMAIN.latMin;
    this.nlon = Math.ceil((G.DOMAIN.lonMax - G.DOMAIN.lonMin) / this.deg) + 1;
    this.nlat = Math.ceil((G.DOMAIN.latMax - G.DOMAIN.latMin) / this.deg) + 1;
    this.data = new Float32Array(this.nlon * this.nlat);
    this.raw = new Float32Array(this.nlon * this.nlat);  // 含山地调制原始累计
    this.flat = new Float32Array(this.nlon * this.nlat); // 去山地调制累计
    this.mtn = null; // Int8: 0 sea/plain, 1 windward-ish cache unused; bitmask mountain
    this._mtnReady = false;
    this.maxVal = 0;
    this.hoursIntegrated = 0;
    this.band = { w: 0, lat: 0, lon: 0, sc: 0, sLat: 0, sLon: 0, sW: 0, posW: 0, vpk: 0 }; // 北带权重/诊断
    this.bandAcc = new Float32Array(this.nlon * this.nlat); // 北带逐小时累计（与 raw 分离）
    this.bandBox = null;
  }

  AccumGrid.prototype.idx = function (i, j) {
    return j * this.nlon + i;
  };

  AccumGrid.prototype.clear = function () {
    this.data.fill(0);
    if (this.raw) this.raw.fill(0);
    if (this.flat) this.flat.fill(0);
    if (this.bandAcc) this.bandAcc.fill(0);
    else this.bandAcc = new Float32Array(this.nlon * this.nlat);
    this.maxVal = 0;
    this.hoursIntegrated = 0;
    this.band = { w: 0, lat: 0, lon: 0, sc: 0, sLat: 0, sLon: 0, sW: 0, posW: 0, vpk: 0 };
    this.bandBox = null;
    this.bandFrozenLat = null; this.bandOff = false; this.bandLog = [];
  };

  /**
   * 累计北带：逐小时沿「当时」R7 北缘 + NORTH_RIDGE_MID 落薄 E–W 椭圆，路过处留下雨痕。
   * 每小时南北更薄、雨强更低 → 1–2 日北上段仍读作东西向拉长的浅迹；平地峰值软封 ~40 mm。
   * 线尺度随强度（northBandAccumScale）；大台风中心略北移保持与主雨分离。
   */
  /** 累计单小时中心雨强 mm/h（×fade×地形）；低于瞬时 NORTH_BAND_PEAK，避免拖条过重 */
  const NORTH_BAND_ACCUM_RATE = 9.5;
  /** 累计椭圆相对瞬时轴：东西略放大、南北明显压薄 */
  const NORTH_BAND_ACCUM_EW = 1.15;
  const NORTH_BAND_ACCUM_NS = 0.55;
  /** 平地北带单格软封顶（~40 mm 量级）；地形可再抬，非台湾仍 <300 */
  const NORTH_BAND_FLAT_CAP = 42;
  /** 大台风北带中心北移系数（°/单位尺度增量）；scale 1.3 → +K·0.3° */
  const NORTH_BAND_BIG_SHIFT = 2.0;
  const NB_SCALE_PTS = [[18, 0.75], [25, 0.85], [33, 1.0], [43, 1.15], [57, 1.3]];
  function northBandAccumScale(vmax) {
    const v = +vmax || 33;
    const P = NB_SCALE_PTS;
    let f;
    if (v <= P[0][0]) f = P[0][1] - (P[0][0] - v) * (0.1 / 7);
    else if (v >= P[P.length - 1][0]) f = P[P.length - 1][1];
    else {
      for (let i = 0; i < P.length - 1; i++) {
        if (v <= P[i + 1][0]) {
          const tt = (v - P[i][0]) / (P[i + 1][0] - P[i][0]);
          const s = tt * tt * (3 - 2 * tt);
          f = P[i][1] + (P[i + 1][1] - P[i][1]) * (0.5 * tt + 0.5 * s);
          break;
        }
      }
    }
    return Math.max(0.7, Math.min(1.35, f));
  }

  /**
   * 北带逐小时沉积：中心跟随当前风暴北侧偏移；航向 fade（≤20°=1，≥40°=0）。
   * 写入 bandAcc，再合成到 data（主雨每小时会重写 data，故 band 必须独立累加）。
   * 测试可通过 stub 本方法禁用北带。
   */
  AccumGrid.prototype._applyBand = function (storm, dtHours, meanR7, amp7, hdg) {
    if (!storm || !(dtHours > 0)) return;
    // 转向后：一旦航向 ≥40°（东北）即永久关闭；转向开始（fade<1）冻结纬度，不再随风暴北移
    let hDeg = Math.atan2(Math.sin(+hdg || 0), Math.cos(+hdg || 0)) * 180 / Math.PI;
    if (this.bandFrozenLat != null && hDeg >= 40) this.bandOff = true;
    const fade = this.bandOff ? 0 : northBandHeadingFade(hdg);
    if (this.bandLog) this.bandLog.push({ lat: storm.lat, h: hDeg, fade: fade, cLat: null });
    if (fade <= 0 || !isRecurvingNorth(hdg)) return;
    const vmax = +storm.vmax || 33;
    const scV = northBandAccumScale(vmax);
    const r7N = storm.lat + rainLocalR7(meanR7, hdg, 0, amp7);
    // 大台风略北移，保持与主雨断开
    let cLat = r7N + NORTH_RIDGE_MID + NORTH_BAND_BIG_SHIFT * Math.max(0, scV - 1);
    if (fade < 1 && hDeg > 0) {
      if (this.bandFrozenLat == null) this.bandFrozenLat = this.bandLastLat != null ? this.bandLastLat : cLat;
      cLat = this.bandFrozenLat;
    } else this.bandLastLat = cLat;
    if (this.bandLog && this.bandLog.length) this.bandLog[this.bandLog.length - 1].cLat = cLat;
    const cLon = storm.lon;
    const ea = NORTH_ELL_A * NORTH_BAND_ACCUM_EW * scV;
    const eb = NORTH_ELL_B * NORTH_BAND_ACCUM_NS * scV;
    const cos = Math.max(0.2, Math.cos(cLat * Math.PI / 180));
    const box = {
      latMin: cLat - 1.5 * eb,
      latMax: cLat + 1.5 * eb,
      lonMin: cLon - 1.5 * ea / cos,
      lonMax: cLon + 1.5 * ea / cos
    };
    if (!this.bandAcc) this.bandAcc = new Float32Array(this.nlon * this.nlat);
    this.ensureMountainMask();
    const self = this;
    const amp = NORTH_BAND_ACCUM_RATE * fade * dtHours;
    const sLat = storm.lat, sLon = storm.lon;
    const i0 = Math.max(0, Math.floor((box.lonMin - self.lon0) / self.deg));
    const i1 = Math.min(self.nlon - 1, Math.ceil((box.lonMax - self.lon0) / self.deg));
    const j0 = Math.max(0, Math.floor((box.latMin - self.lat0) / self.deg));
    const j1 = Math.min(self.nlat - 1, Math.ceil((box.latMax - self.lat0) / self.deg));
    for (let j = j0; j <= j1; j++) {
      const lat = self.lat0 + j * self.deg;
      for (let i = i0; i <= i1; i++) {
        const lon = self.lon0 + i * self.deg;
        const dx = (lon - cLon) * cos, dy = lat - cLat;
        // 靠风暴一侧（南足）更薄，保持与主雨断开；北侧用全 eb
        const ebUse = dy < 0 ? eb * 0.62 : eb;
        const d2 = (dx / ea) * (dx / ea) + (dy / ebUse) * (dy / ebUse);
        if (d2 > 2.25) continue;
        let add = amp * Math.exp(-2.302585 * d2);
        // 轻雨桥：靠近 R7 北缘的南足封顶，避免与主核黄+相连
        if (lat < Math.min(r7N, cLat - NORTH_RIDGE_MID) + NORTH_RIDGE_MID * 0.55 && add > NORTH_BRIDGE_CAP * dtHours * 0.5)
          add = NORTH_BRIDGE_CAP * dtHours * 0.5;
        const mtn = mountainSideFactor(lon, lat, sLon, sLat, self);
        add *= mtn;
        const k = self.idx(i, j);
        let nv = self.bandAcc[k] + add;
        // 平地硬封 ~40 mm；迎风地形可抬，非台湾硬顶 <300
        if (mtn <= 1.05 && nv > NORTH_BAND_FLAT_CAP) nv = NORTH_BAND_FLAT_CAP;
        if (!inTaiwanCmrBox(lat, lon) && nv > 299) nv = 299;
        self.bandAcc[k] = nv;
        const main = self.raw[k] > 0 ? accumDisplayMm(self.raw[k], self.flat[k], lat, lon) : 0;
        let shown = main + nv;
        if (!inTaiwanCmrBox(lat, lon) && shown >= 400) shown = 399;
        self.data[k] = shown;
        if (shown > self.maxVal) self.maxVal = shown;
      }
    }
    // 诊断：活跃权重与路径积分中心
    const w = fade * dtHours;
    this.band.w += w;
    this.band.vpk = Math.max(this.band.vpk || 0, vmax);
    this.band.lat += w * cLat;
    this.band.lon += w * cLon;
    this.band.sc += w * scV;
    this.band.posW = (this.band.posW || 0) + w;
    this.band.sLat = (this.band.sLat || 0) + w * sLat;
    this.band.sLon = (this.band.sLon || 0) + w * sLon;
    this.band.sW = (this.band.sW || 0) + w;
    if (!this.bandBox) this.bandBox = box;
    else {
      this.bandBox.latMin = Math.min(this.bandBox.latMin, box.latMin);
      this.bandBox.latMax = Math.max(this.bandBox.latMax, box.latMax);
      this.bandBox.lonMin = Math.min(this.bandBox.lonMin, box.lonMin);
      this.bandBox.lonMax = Math.max(this.bandBox.lonMax, box.lonMax);
    }
  };

  /** 用与风圈相同的路径移向 UV（windMotionUVFromTrack）累加 track[i] 这一段 */
  AccumGrid.prototype.addTrackPoint = function (track, i, dtHours) {
    const b = track[i];
    if (!b) return;
    let u = b.u, v = b.v;
    const uv = G.windMotionUVFromTrack ? G.windMotionUVFromTrack(track, i) : null;
    if (uv && Math.hypot(uv.u, uv.v) >= 0.25) {
      const sp = Math.hypot(uv.u, uv.v);
      const ph = Math.hypot(+b.u || 0, +b.v || 0);
      const k = (sp < 1.2 && ph > sp + 0.15) ? ph / sp : 1;
      u = uv.u * k; v = uv.v * k;
    }
    this.addStormHour({ lat: b.lat, lon: b.lon, vmax: b.vmax, u: u, v: v }, dtHours);
  };

  AccumGrid.prototype.ensureMountainMask = function () {
    if (this._mtnReady) return;
    const n = this.nlon * this.nlat;
    this.mtn = new Uint8Array(n);
    for (let j = 0; j < this.nlat; j++) {
      const lat = this.lat0 + j * this.deg;
      for (let i = 0; i < this.nlon; i++) {
        const lon = this.lon0 + i * this.deg;
        this.mtn[this.idx(i, j)] = G.isMountain(lon, lat) ? 1 : 0;
      }
    }
    this._mtnReady = true;
  };

  /**
   * 将一场风暴一小时雨强累加到格点。
   * 只遍历风暴影响盒（含北侧雨带），保持流畅。
   */
  AccumGrid.prototype.addStormHour = function (storm, dtHours) {
    if (!storm || !(dtHours > 0)) return;
    this.ensureMountainMask();
    const vmax = +storm.vmax || 0;
    if (vmax < 10) return;

    const u = +storm.u || 0;
    const v = +storm.v || 0;
    const speed = Math.hypot(u, v);
    const amp7 = G.windAsymAmp(speed, vmax);
    const meanR7 = rainFootprintRadii(vmax).meanR7;
    const maxR = meanR7 * (1 + amp7) * 0.72 + 0.05;
    const recurveN = isRecurvingNorth(G.motionHeadingRad(u, v));
    const bandExtra = recurveN ? (NORTH_RIDGE_MID + NORTH_BAND_BIG_SHIFT * 0.35 + 1.5 * NORTH_ELL_B * NORTH_BAND_ACCUM_NS * 1.35 + 0.15) : 0; // 累计薄北带外缘

    const latMin = Math.max(this.lat0, storm.lat - maxR - 0.5);
    const latMax = Math.min(G.DOMAIN.latMax, storm.lat + maxR + bandExtra + 0.5);
    const cos = Math.max(0.2, Math.cos(storm.lat * Math.PI / 180));
    const lonPad = (maxR + 4 + (recurveN ? Math.max(5.5, 1.5 * NORTH_ELL_A * 1.15 - 4) : 0)) / cos; // 椭圆北带 E–W 外缘
    const lonMin = Math.max(this.lon0, storm.lon - lonPad);
    const lonMax = Math.min(G.DOMAIN.lonMax, storm.lon + lonPad);

    const i0 = Math.max(0, Math.floor((lonMin - this.lon0) / this.deg));
    const i1 = Math.min(this.nlon - 1, Math.ceil((lonMax - this.lon0) / this.deg));
    const j0 = Math.max(0, Math.floor((latMin - this.lat0) / this.deg));
    const j1 = Math.min(this.nlat - 1, Math.ceil((latMax - this.lat0) / this.deg));

    const s = {
      lat: storm.lat,
      lon: storm.lon,
      vmax: storm.vmax,
      u: storm.u,
      v: storm.v
    };

    const out = { mtn: 1 };
    const opt = { grid: this, out: out, noBand: true };
    for (let j = j0; j <= j1; j++) {
      const lat = this.lat0 + j * this.deg;
      for (let i = i0; i <= i1; i++) {
        const lon = this.lon0 + i * this.deg;
        out.mtn = 1;
        const rate = rainRateAt(lat, lon, s, opt);
        if (rate <= 0) continue;
        const k = this.idx(i, j);
        this.raw[k] += rate * dtHours;
        this.flat[k] += rate / Math.max(0.05, out.mtn) * dtHours;
        const nv = accumDisplayMm(this.raw[k], this.flat[k], lat, lon);
        const bAdd = this.bandAcc ? this.bandAcc[k] : 0;
        let shown = nv + bAdd;
        if (!inTaiwanCmrBox(lat, lon) && shown >= 400) shown = 399;
        this.data[k] = shown;
        if (shown > this.maxVal) this.maxVal = shown;
      }
    }
    this.hoursIntegrated += dtHours;
    // 北带：逐小时在当前偏移位置沉积（fade 管折向后消失，避免 ENE 北侧大瓣）
    const hdgB = G.motionHeadingRad(u, v);
    this._applyBand(storm, dtHours, meanR7, amp7, hdgB);
  };

  /** 从 track[0..endIdx] 重建累计（回看用） */
  AccumGrid.prototype.rebuildFromTrack = function (track, endIdx) {
    this.clear();
    if (!track || track.length < 2) return;
    const last = Math.max(1, Math.min(track.length - 1, endIdx | 0));
    for (let i = 1; i <= last; i++) {
      const a = track[i - 1];
      const b = track[i];
      let dt = (b.t != null && a.t != null) ? (+b.t - +a.t) : 1;
      if (!(dt > 0)) dt = 1;
      // 用段末状态代表该小时
      this.addTrackPoint(track, i, dt);
    }
  };

  /** 图例：累计降水 mm（路径结束后显示） */
  function accumLegendItems() {
    return [
      { hex: 'rgba(70,200,90,0.85)', text: '<10 mm' },
      { hex: 'rgba(50,120,230,0.85)', text: '10–25 mm' },
      { hex: 'rgba(245,215,30,0.88)', text: '25–100 mm' },
      { hex: 'rgba(245,140,25,0.9)', text: '100–150 mm' },
      { hex: 'rgba(150,50,210,0.9)', text: '150–300 mm' },
      { hex: 'rgba(220,35,40,0.92)', text: '300–400 mm' },
      { hex: 'rgba(200,20,110,0.9)', text: '≥400 mm' }
    ];
  }

  function rateLegendItems() {
    return [
      { hex: 'rgba(70,200,90,0.85)', text: '毛毛雨 <3 mm/h' },
      { hex: 'rgba(50,120,230,0.85)', text: '小雨 3–12 mm/h' },
      { hex: 'rgba(245,215,30,0.88)', text: '中雨 12–28 mm/h' },
      { hex: 'rgba(245,140,25,0.9)', text: '大雨 28–50 mm/h' },
      { hex: 'rgba(150,50,210,0.9)', text: '暴雨 50–85 mm/h' },
      { hex: 'rgba(220,35,40,0.92)', text: '大暴雨 ≥85 mm/h' }
    ];
  }

  /** 分档序号：0 无雨，1 毛毛雨 … 6 大暴雨（与 RATE_BINS 顺序一致） */
  function binIndexForRate(mmh) {
    const x = +mmh || 0;
    if (x < 0.4) return 0;
    for (let i = 0; i < RATE_BINS.length; i++) {
      if (x < RATE_BINS[i].max) return i + 1;
    }
    return RATE_BINS.length;
  }

  function colorForBin(bin) {
    if (bin <= 0) return [0, 0, 0, 0];
    const b = RATE_BINS[Math.min(RATE_BINS.length, bin) - 1];
    return [b.r, b.g, b.b, b.a];
  }

  /** 3×3 盒式模糊（原地两次缓冲），抹平山地等硬崖，便于分档后形成嵌套等值带 */
  function blurRateField(src, w, h, passes) {
    const n = w * h;
    let a = src;
    let b = new Float32Array(n);
    const p = Math.max(1, passes | 0);
    for (let pass = 0; pass < p; pass++) {
      for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? y - 1 : y;
        const y1 = y;
        const y2 = y + 1 < h ? y + 1 : y;
        for (let x = 0; x < w; x++) {
          const x0 = x > 0 ? x - 1 : x;
          const x1 = x;
          const x2 = x + 1 < w ? x + 1 : x;
          const s =
            a[y0 * w + x0] + a[y0 * w + x1] + a[y0 * w + x2] +
            a[y1 * w + x0] + a[y1 * w + x1] + a[y1 * w + x2] +
            a[y2 * w + x0] + a[y2 * w + x1] + a[y2 * w + x2];
          b[y * w + x] = s / 9;
        }
      }
      const tmp = a; a = b; b = tmp;
    }
    if (a !== src) src.set(a);
    return src;
  }

  /**
   * 强制分档只与邻档接壤（绿↔蓝↔黄↔橙↔紫↔红），禁止红贴蓝等跳档。
   * 策略：高档像素若与更低邻档差 >1，则逐级下调；贴透明外缘则逐级降到 1。
   * protectMask[i]>0 的像素不降档（用于保护 R12 红核，避免形态学掏成「1/4 红」）。
   */
  function enforceNestedBins(bins, w, h, protectMask) {
    const n = w * h;
    const cur = new Int8Array(bins);
    const next = new Int8Array(n);
    for (let pass = 0; pass < 16; pass++) {
      next.set(cur);
      let changed = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const b = cur[i];
          if (b <= 0) continue;
          if (protectMask && protectMask[i]) {
            next[i] = b;
            continue;
          }
          let target = b;
          const nbs = [];
          if (x > 0) nbs.push(cur[i - 1]);
          if (x + 1 < w) nbs.push(cur[i + 1]);
          if (y > 0) nbs.push(cur[i - w]);
          if (y + 1 < h) nbs.push(cur[i + w]);
          for (let k = 0; k < nbs.length; k++) {
            const bn = nbs[k];
            // 每次只降一档，逐步填出中间壳，避免高核被一次抽塌
            if (bn <= 0) {
              if (target > 1) target = target - 1;
            } else if (target > bn + 1) {
              target = target - 1;
            }
          }
          if (target !== b) {
            next[i] = target;
            changed = true;
          }
        }
      }
      cur.set(next);
      if (!changed) break;
    }
    bins.set(cur);
    return bins;
  }

  /**
   * 保证大红核外侧有暴雨紫壳（邻接红的只能是紫，不能直接橙/黄/蓝）。
   * 对红核做 1–2 px 膨胀环，环内低于紫的抬到 5。
   */
  function ensurePurpleShellAroundRed(bins, w, h) {
    const n = w * h;
    const isRed = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (bins[i] >= 6) isRed[i] = 1;
    const ring = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (isRed[i]) continue;
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dy * dy > 4) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (isRed[ny * w + nx]) near = true;
          }
        }
        if (near) ring[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) {
      if (ring[i] && bins[i] < 5) bins[i] = 5;
    }
    return bins;
  }

  /**
   * 把雨强场绘到 ImageData：采样 → 轻平滑 → 硬分档 → 嵌套约束 → 档内纯色。
   * R12 内核顶档受保护，形态学不会掏成「1/4 红」；外圈仍可非对称。
   * bounds: [[latMin,lonMin],[latMax,lonMax]]；w,h 像素
   */
  function paintRateImageData(imgData, w, h, bounds, storm, grid) {
    const latMin = bounds[0][0];
    const lonMin = bounds[0][1];
    const latMax = bounds[1][0];
    const lonMax = bounds[1][1];
    const data = imgData.data;
    const opt = grid ? { grid: grid } : null;
    const rates = new Float32Array(w * h);
    const rawBins = new Int8Array(w * h);
    const protect = new Uint8Array(w * h);

    // 圆形 R12（与 rainRateAt 内核一致），用于保护中心满盘顶档
    let coreR = 0.4;
    if (storm && G) {
      const vmax = +storm.vmax || 0;
      coreR = rainFootprintRadii(vmax).meanR12;
    }
    const lat0 = storm ? +storm.lat : 0;
    const lon0 = storm ? +storm.lon : 0;
    const cosLat = Math.cos(lat0 * Math.PI / 180);

    for (let y = 0; y < h; y++) {
      const lat = latMax - (y + 0.5) / h * (latMax - latMin);
      for (let x = 0; x < w; x++) {
        const lon = lonMin + (x + 0.5) / w * (lonMax - lonMin);
        const i = y * w + x;
        const rate = rainRateAt(lat, lon, storm, opt);
        rates[i] = rate;
        rawBins[i] = binIndexForRate(rate);
        const dlat = lat - lat0;
        const dlon = (lon - lon0) * Math.max(0.2, cosLat);
        const dist = Math.hypot(dlat, dlon);
        // 仅保护内核大红（档6）；紫壳在 R12 外形成，勿把 ≥5 整圈冻死
        if (dist <= coreR * 0.98 && rawBins[i] >= 6) protect[i] = 1;
      }
    }
    // 轻平滑即可；过重会把圆核对成偏心斑
    blurRateField(rates, w, h, 2);

    const bins = new Int8Array(w * h);
    for (let i = 0; i < rates.length; i++) {
      bins[i] = binIndexForRate(rates[i]);
      // 模糊后仍用原始内核顶档回填，保证强台中心整盘红
      if (protect[i] && rawBins[i] > bins[i]) bins[i] = rawBins[i];
    }
    enforceNestedBins(bins, w, h, protect);
    // 嵌套约束后再回填一次保护核，防止邻域剥蚀渗入
    for (let i = 0; i < bins.length; i++) {
      if (protect[i] && rawBins[i] > bins[i]) bins[i] = rawBins[i];
    }
    // 红外必有紫壳：红核外侧一圈若跳到橙及以下，抬到暴雨紫
    ensurePurpleShellAroundRed(bins, w, h);

    for (let i = 0; i < bins.length; i++) {
      const c = colorForBin(bins[i]);
      const p = i * 4;
      data[p] = c[0];
      data[p + 1] = c[1];
      data[p + 2] = c[2];
      data[p + 3] = c[3];
    }
    return imgData;
  }

  function paintAccumImageData(imgData, w, h, bounds, grid) {
    const latMin = bounds[0][0];
    const lonMin = bounds[0][1];
    const latMax = bounds[1][0];
    const lonMax = bounds[1][1];
    const data = imgData.data;
    const deg = grid.deg;
    for (let y = 0; y < h; y++) {
      const lat = latMax - (y + 0.5) / h * (latMax - latMin);
      const jf = (lat - grid.lat0) / deg;
      const j0 = Math.floor(jf);
      const tj = jf - j0;
      for (let x = 0; x < w; x++) {
        const lon = lonMin + (x + 0.5) / w * (lonMax - lonMin);
        const if_ = (lon - grid.lon0) / deg;
        const i0 = Math.floor(if_);
        const ti = if_ - i0;
        let mm = 0;
        if (i0 >= 0 && j0 >= 0 && i0 + 1 < grid.nlon && j0 + 1 < grid.nlat) {
          const v00 = grid.data[grid.idx(i0, j0)];
          const v10 = grid.data[grid.idx(i0 + 1, j0)];
          const v01 = grid.data[grid.idx(i0, j0 + 1)];
          const v11 = grid.data[grid.idx(i0 + 1, j0 + 1)];
          mm = lerp(lerp(v00, v10, ti), lerp(v01, v11, ti), tj);
        }
        const p = (y * w + x) * 4;
        const c = colorForAccum(mm);
        data[p] = c[0];
        data[p + 1] = c[1];
        data[p + 2] = c[2];
        data[p + 3] = c[3];
      }
    }
    // ≥400 深红区细描边（更深酒红，半透明 a=220）：与红档/淡山地分界更清楚
    const top = ACCUM_BINS[ACCUM_BINS.length - 1];
    const isDeep = function (q) {
      return data[q] === top.r && data[q + 1] === top.g && data[q + 2] === top.b && data[q + 3] === top.a;
    };
    const edge = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        if (!isDeep(p)) continue;
        if ((x > 0 && !isDeep(p - 4)) || (x < w - 1 && !isDeep(p + 4)) ||
          (y > 0 && !isDeep(p - w * 4)) || (y < h - 1 && !isDeep(p + w * 4))) edge.push(p);
      }
    }
    for (let k = 0; k < edge.length; k++) {
      const p = edge[k];
      data[p] = 140; data[p + 1] = 0; data[p + 2] = 70; data[p + 3] = 200;
    }
    return imgData;
  }

  global.TyRain = {
    peakRainMmH: peakRainMmH,
    rainRateAt: rainRateAt,
    rainFootprintRadii: rainFootprintRadii,
    shellRateMmH: shellRateMmH,
    rainLocalR7: rainLocalR7,
    AccumGrid: AccumGrid,
    colorForRate: colorForRate,
    colorForBin: colorForBin,
    binIndexForRate: binIndexForRate,
    colorForAccum: colorForAccum,
    colorForMm: colorForMm,
    binIndexForAccum: binIndexForAccum,
    colorForAccumBin: colorForAccumBin,
    accumLegendItems: accumLegendItems,
    rateLegendItems: rateLegendItems,
    paintRateImageData: paintRateImageData,
    paintAccumImageData: paintAccumImageData,
    ACCUM_BINS: ACCUM_BINS,
    isRecurvingNorth: isRecurvingNorth,
    mountainSideFactor: mountainSideFactor,
    rainbandNorthMmH: rainbandNorthMmH,
    mergeNorthBand: mergeNorthBand,
    NORTH_RIDGE_MID: NORTH_RIDGE_MID,
    NORTH_BAND_PEAK: NORTH_BAND_PEAK,
    NORTH_BRIDGE_CAP: NORTH_BRIDGE_CAP,
    northBandScale: northBandScale
  };
})(typeof window !== 'undefined' ? window : globalThis);
