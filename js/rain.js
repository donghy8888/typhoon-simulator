/**
 * 台风降水场：仅瞬时雨强（mm/h）雷达阶梯填色；不画累计。
 * 色标（绝对 mm/h 嵌套阶梯带）：毛毛雨绿 / 小雨蓝 / 中雨黄 / 大雨橙 / 暴雨紫 / 大暴雨红；邻接仅限相邻档。
 * 外圈平滑余弦非对称（大风侧肥，非象限阶梯）；山地迎/背风 7:3；折向=分离北侧弱雨带（轻雨桥）；无移速雨因子；无眼干区。
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
    return 0.14 * Math.exp(-(rNorm - 1) / 0.62);
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

  /** 折向北侧弱雨带脊：相对 R7 北缘 ~5.5°（≈600 km） */
  const NORTH_RIDGE_MID = 5.5;
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
  function rainbandNorthMmH(lat, lon, stormLat, stormLon, r7NorthLat, headingRad) {
    if (!isRecurvingNorth(headingRad)) return 0;
    const dNorth = lat - r7NorthLat; // degrees relative to R7 north edge
    // 仅从 R7 北缘稍北起叶；北侧在脊外 ~2.3° 熄灭
    if (dNorth < 0.05 || dNorth > NORTH_RIDGE_MID + 2.4) return 0;
    const cosLat = Math.cos(stormLat * Math.PI / 180);
    const dLon = (lon - stormLon) * Math.max(0.2, cosLat);
    // 轻微弯弧 + 软抖动，避免完美椭圆/体育场轮廓
    const arc = 0.10 * Math.sin(dLon * 0.58) + 0.05 * Math.sin(dLon * 1.38 + 0.85);
    const dN = dNorth - arc;
    // E–W 半宽：中等横带，西略宽；软高斯+外缘跌落（无硬截断墙）
    const halfW = dLon < 0 ? 4.4 : 3.8;
    const u = Math.abs(dLon) / Math.max(0.4, halfW);
    const lonGate = Math.exp(-1.15 * u * u) * Math.exp(-0.70 * Math.pow(u, 3.4));
    if (lonGate < 0.02) return 0;
    const wobble = 1.0 + 0.045 * Math.sin(dLon * 2.05 + dNorth * 2.9) *
      Math.sin(dLon * 0.9 - 0.4);
    // 非对称径向门：北侧紧、南侧长尾 → 脊分离；南足只留下轻雨桥
    const mid = NORTH_RIDGE_MID;
    const span = dN < mid ? 2.55 : 0.88;
    const radGate = Math.exp(-Math.pow((dN - mid) / span, 2));
    const edgeFade = clamp01((dNorth - 0.15) / 0.85);
    const northCap = clamp01((mid + 2.05 - dNorth) / 0.95);
    let band = NORTH_BAND_PEAK * radGate * lonGate * wobble * edgeFade * northCap;
    // 桥区（脊以南较远处）封顶，确保黄/橙/紫/红绝不跨缝
    if (dNorth < mid - 1.15 && band > NORTH_BRIDGE_CAP) band = NORTH_BRIDGE_CAP;
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
      { d: 0.50 * r7, v: 18 },
      { d: 0.70 * r7, v: 7 },
      { d: 0.95 * r7, v: 1.6 },
      { d: 1.40 * r7, v: 0.2 }
    ];
    let rate;
    if (d >= pts[pts.length - 1].d) {
      const last = pts[pts.length - 1];
      rate = last.v * Math.exp(-(d - last.d) / (0.45 * r7));
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
   * 山地迎风/背风：朝风暴中心方向一步仍是山 → 背风；否则迎风。
   * 比例约 70:30（迎风保持≈1，背风≈0.43）；非山地 = 1。
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

  function mountainSideFactor(lon, lat, stormLon, stormLat, grid) {
    const wMtn = mountainWeightSoft(lon, lat, grid);
    if (wMtn <= 1e-3) return 1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dLat = stormLat - lat;
    const dLon = (stormLon - lon) * Math.max(0.2, cosLat);
    const dist = Math.hypot(dLat, dLon);
    if (dist < 1e-4) return 1;
    const step = 0.18; // ~20 km
    const tLat = lat + (dLat / dist) * step;
    const tLon = lon + ((stormLon - lon) / dist) * step;
    const wAhead = mountainWeightSoft(tLon, tLat, grid);
    // 迎风偏 1，背风偏 3/7；按软权重混合，无方块边
    const windward = wAhead < 0.45;
    const side = windward ? 1 : (3 / 7);
    return 1 + (side - 1) * wMtn;
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
    const rings = G.windRadiiForGrades(vmax);
    let meanR7 = G.windRadiusDeg(vmax) * 1.2;
    let meanR12 = meanR7 * 0.34;
    for (let i = 0; i < rings.length; i++) {
      if (rings[i].grade === 7) meanR7 = rings[i].radiusDeg;
      if (rings[i].grade === 12) meanR12 = rings[i].radiusDeg;
    }
    // 未达 12 级时眼墙环取内圈比例
    if (vmax < 32.7) meanR12 = Math.max(0.15, meanR7 * 0.28);

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
    const band = rainbandNorthMmH(lat, lon, lat0, lon0, r7North, hdg);
    rate = mergeNorthBand(rate, band);

    // 山地软调制：R12 内核不打洞
    let mtn = mountainSideFactor(lon, lat, lon0, lat0, grid);
    if (coreW > 0) mtn = mtn + (1 - mtn) * coreW;
    rate *= mtn;

    if (rate < 0.15) return 0;
    return rate;
  }

  /**
   * 瞬时雨强绝对色标（mm/h）— 雷达阶梯/分档填色（filled-contour）：
   * 毛毛雨绿 / 小雨蓝 / 中雨黄 / 大雨橙 / 暴雨紫 / 大暴雨红
   * 硬边界、档内纯色，不做档间插值，也不按帧 maxVal 拉伸。
   * 半透明固定 alpha，底图可读。累计层已移除。
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

  /** 累计已停用 */
  function colorForAccum(mm) {
    return [0, 0, 0, 0];
  }

  function colorForMm(mm, maxMm, alphaScale) {
    const c = colorForRate(mm);
    if (alphaScale != null && alphaScale !== 1 && c[3] > 0) {
      c[3] = Math.round(c[3] * alphaScale);
    }
    return c;
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
    this.mtn = null; // Int8: 0 sea/plain, 1 windward-ish cache unused; bitmask mountain
    this._mtnReady = false;
    this.maxVal = 0;
    this.hoursIntegrated = 0;
  }

  AccumGrid.prototype.idx = function (i, j) {
    return j * this.nlon + i;
  };

  AccumGrid.prototype.clear = function () {
    this.data.fill(0);
    this.maxVal = 0;
    this.hoursIntegrated = 0;
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
    const meanR7 = (G.windRadiiForGrades(vmax).find(function (r) { return r.grade === 7; }) ||
      { radiusDeg: G.windRadiusDeg(vmax) * 1.2 }).radiusDeg;
    const maxR = meanR7 * (1 + amp7) * 1.15 + 0.8;
    const recurveN = isRecurvingNorth(G.motionHeadingRad(u, v));
    const bandExtra = recurveN ? (NORTH_RIDGE_MID + 3.0) : 0; // 分离北带脊~5.5° + 北缘熄灭

    const latMin = Math.max(this.lat0, storm.lat - maxR - 0.5);
    const latMax = Math.min(G.DOMAIN.latMax, storm.lat + maxR + bandExtra + 0.5);
    const cos = Math.max(0.2, Math.cos(storm.lat * Math.PI / 180));
    const lonPad = (maxR + 4 + (recurveN ? 3.5 : 0)) / cos; // 北带中等 E–W 半宽
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

    for (let j = j0; j <= j1; j++) {
      const lat = this.lat0 + j * this.deg;
      for (let i = i0; i <= i1; i++) {
        const lon = this.lon0 + i * this.deg;
        const rate = rainRateAt(lat, lon, s, { grid: this });
        if (rate <= 0) continue;
        const k = this.idx(i, j);
        const add = rate * dtHours;
        const nv = this.data[k] + add;
        this.data[k] = nv;
        if (nv > this.maxVal) this.maxVal = nv;
      }
    }
    this.hoursIntegrated += dtHours;
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
      this.addStormHour(b, dt);
    }
  };

  /** 图例：仅瞬时雨强（累计已移除） */
  function accumLegendItems() {
    return [];
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
      const rings = G.windRadiiForGrades(vmax);
      let meanR7 = G.windRadiusDeg(vmax) * 1.2;
      let meanR12 = meanR7 * 0.34;
      for (let i = 0; i < rings.length; i++) {
        if (rings[i].grade === 7) meanR7 = rings[i].radiusDeg;
        if (rings[i].grade === 12) meanR12 = rings[i].radiusDeg;
      }
      if (vmax < 32.7) meanR12 = Math.max(0.15, meanR7 * 0.28);
      coreR = meanR12;
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
    // 累计层已移除：保持透明
    const data = imgData.data;
    data.fill(0);
    return imgData;
  }

  global.TyRain = {
    peakRainMmH: peakRainMmH,
    rainRateAt: rainRateAt,
    shellRateMmH: shellRateMmH,
    rainLocalR7: rainLocalR7,
    AccumGrid: AccumGrid,
    colorForRate: colorForRate,
    colorForBin: colorForBin,
    binIndexForRate: binIndexForRate,
    colorForAccum: colorForAccum,
    colorForMm: colorForMm,
    accumLegendItems: accumLegendItems,
    rateLegendItems: rateLegendItems,
    paintRateImageData: paintRateImageData,
    paintAccumImageData: paintAccumImageData,
    isRecurvingNorth: isRecurvingNorth,
    mountainSideFactor: mountainSideFactor,
    rainbandNorthMmH: rainbandNorthMmH,
    mergeNorthBand: mergeNorthBand,
    NORTH_RIDGE_MID: NORTH_RIDGE_MID,
    NORTH_BAND_PEAK: NORTH_BAND_PEAK,
    NORTH_BRIDGE_CAP: NORTH_BRIDGE_CAP
  };
})(typeof window !== 'undefined' ? window : globalThis);
