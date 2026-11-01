/**
 * 台风降水场：仅瞬时雨强（mm/h）雷达阶梯填色；不画累计。
 * 色标（绝对 mm/h 分档，硬边界）：毛毛雨绿 / 小雨蓝 / 中雨黄 / 大雨橙 / 暴雨紫 / 大暴雨红。
 * 与非对称风圈对齐；山地迎/背风 7:3；折向北侧弱雨带；无移速雨因子；无眼干区。
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
  function radialProfile(rNorm, r12frac) {
    if (!(rNorm >= 0) || !isFinite(rNorm)) return 0;
    const f12 = Math.max(0.12, Math.min(0.55, +r12frac || 0.34));
    if (rNorm <= f12) {
      // 平坦近峰值，略向眼墙抬一点（无干眼）
      const t = rNorm / f12;
      return 0.88 + 0.12 * t;
    }
    if (rNorm <= 1) {
      const t = (rNorm - f12) / Math.max(1e-6, 1 - f12);
      // 平滑降到外缘 ~0.12
      const s = t * t * (3 - 2 * t);
      return lerp(1, 0.12, s);
    }
    // 风圈外：再衰减
    const out = Math.exp(-(rNorm - 1) / 0.55);
    return 0.12 * out;
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

  function mountainSideFactor(lon, lat, stormLon, stormLat, grid) {
    if (!isMountainFast(lon, lat, grid)) return 1;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const dLat = stormLat - lat;
    const dLon = (stormLon - lon) * Math.max(0.2, cosLat);
    const dist = Math.hypot(dLat, dLon);
    if (dist < 1e-4) return 1;
    const step = 0.18; // ~20 km
    const tLat = lat + (dLat / dist) * step;
    const tLon = lon + ((stormLon - lon) / dist) * step;
    const windward = !isMountainFast(tLon, tLat, grid);
    // 迎风:背风 ≈ 70:30
    return windward ? 1 : (3 / 7);
  }

  /**
   * WNW→N 折向：航向接近北向时，在 7 级圈北缘以北加 ~10 mm/h 弱雨带，
   * 向北延伸约 1000–2000 km（域内）。
   */
  function isRecurvingNorth(headingRad) {
    let h = +headingRad || 0;
    h = Math.atan2(Math.sin(h), Math.cos(h));
    // WNW(~-67°) 已转北：航向 (−50°, +40°)
    return h > -50 * Math.PI / 180 && h < 40 * Math.PI / 180;
  }

  function rainbandNorthMmH(lat, lon, stormLat, stormLon, r7NorthLat, headingRad) {
    if (!isRecurvingNorth(headingRad)) return 0;
    if (!(lat > r7NorthLat)) return 0;
    const dNorth = lat - r7NorthLat; // degrees
    // 1000–2000 km ≈ 9–18°
    if (dNorth > 18) return 0;
    const cosLat = Math.cos(stormLat * Math.PI / 180);
    const dLon = (lon - stormLon) * Math.max(0.2, cosLat);
    // 经向宽度约 ±4°（随距离略展宽）
    const halfW = 3.2 + 0.15 * dNorth;
    if (Math.abs(dLon) > halfW) return 0;
    const lonGate = Math.cos((dLon / halfW) * (Math.PI / 2));
    // 峰值 ~10 mm/h，在 9–14° 一带，两端衰减
    const mid = 12;
    const span = 6;
    const radGate = Math.exp(-Math.pow((dNorth - mid) / span, 2));
    // 靠近北缘处较弱抬升，避免与主雨场硬接
    const edgeFade = clamp01((dNorth - 0.15) / 1.2);
    return 10 * radGate * lonGate * lonGate * edgeFade;
  }

  /**
   * 单点雨强 mm/h。
   * storm: { lat, lon, vmax, u, v }
   * 非对称与 7 级风圈同一套象限半径；大半径一侧雨强更强。
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

    const localR7 = G.windRadiusAtRay(meanR7, hdg, ray, amp7);
    const localR12 = G.windRadiusAtRay(meanR12, hdg, ray, 0); // 12 级环近圆
    const rNorm = localR7 > 1e-6 ? dist / localR7 : 99;
    const r12frac = localR7 > 1e-6 ? localR12 / localR7 : 0.34;

    const peak = peakRainMmH(vmax);
    // 大风圈一侧明显更强：按局地 R7 / 平均 R7
    const asymBoost = Math.pow(Math.max(0.55, localR7 / Math.max(1e-6, meanR7)), 1.65);

    let rate = peak * asymBoost * radialProfile(rNorm, r12frac);

    // 北侧折向雨带（风圈外）
    const r7North = lat0 + G.windRadiusAtRay(meanR7, hdg, 0, amp7);
    const band = rainbandNorthMmH(lat, lon, lat0, lon0, r7North, hdg);
    rate = Math.max(rate, band);

    rate *= mountainSideFactor(lon, lat, lon0, lat0, grid);

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
    const bandExtra = isRecurvingNorth(G.motionHeadingRad(u, v)) ? 18.5 : 0;

    const latMin = Math.max(this.lat0, storm.lat - maxR - 0.5);
    const latMax = Math.min(G.DOMAIN.latMax, storm.lat + maxR + bandExtra + 0.5);
    const cos = Math.max(0.2, Math.cos(storm.lat * Math.PI / 180));
    const lonPad = (maxR + 4) / cos;
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

  /**
   * 把雨强场绘到 ImageData（连续空间场采样 + 硬分档着色，非渐变）。
   * bounds: [[latMin,lonMin],[latMax,lonMax]]；w,h 像素
   */
  function paintRateImageData(imgData, w, h, bounds, storm, grid) {
    const latMin = bounds[0][0];
    const lonMin = bounds[0][1];
    const latMax = bounds[1][0];
    const lonMax = bounds[1][1];
    const data = imgData.data;
    const opt = grid ? { grid: grid } : null;
    for (let y = 0; y < h; y++) {
      const lat = latMax - (y + 0.5) / h * (latMax - latMin);
      for (let x = 0; x < w; x++) {
        const lon = lonMin + (x + 0.5) / w * (lonMax - lonMin);
        const rate = rainRateAt(lat, lon, storm, opt);
        const p = (y * w + x) * 4;
        if (rate <= 0) {
          data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
        } else {
          const c = colorForRate(rate);
          data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = c[3];
        }
      }
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
    AccumGrid: AccumGrid,
    colorForRate: colorForRate,
    colorForAccum: colorForAccum,
    colorForMm: colorForMm,
    accumLegendItems: accumLegendItems,
    rateLegendItems: rateLegendItems,
    paintRateImageData: paintRateImageData,
    paintAccumImageData: paintAccumImageData,
    isRecurvingNorth: isRecurvingNorth,
    mountainSideFactor: mountainSideFactor
  };
})(typeof window !== 'undefined' ? window : globalThis);
