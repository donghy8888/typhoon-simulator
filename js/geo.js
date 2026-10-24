/**
 * 地理与环境场：陆掩码、山地、SST 区域、副高多边形工具
 * 西北太平洋域：lon 100–180°E, lat 0–50°N
 */
(function (global) {
  'use strict';

  const DOMAIN = { lonMin: 100, lonMax: 180, latMin: 0, latMax: 50 };

  /** 简化陆地多边形 [lat, lon]（Leaflet 用）— 粗略海岸 */
  const LAND_POLYS = [
    // 中国大陆 + 中南半岛北部
    [
      [18.0, 108.5], [20.0, 110.5], [21.5, 109.0], [22.0, 113.5], [22.5, 114.5],
      [23.5, 117.0], [24.5, 118.5], [25.5, 119.5], [26.5, 120.0], [28.0, 121.5],
      [30.0, 122.0], [31.5, 121.8], [32.5, 121.0], [34.0, 120.5], [35.5, 119.5],
      [37.5, 122.0], [38.5, 121.5], [39.5, 123.5], [40.5, 124.5], [41.5, 128.0],
      [42.5, 130.5], [43.0, 131.5], [45.0, 131.0], [48.0, 130.0], [50.0, 128.0],
      [50.0, 100.0], [18.0, 100.0]
    ],
    // 台湾
    [
      [21.9, 120.7], [22.2, 120.5], [23.0, 120.1], [24.0, 120.5], [25.0, 121.5],
      [25.3, 121.8], [24.8, 122.0], [23.5, 121.6], [22.5, 121.0], [21.9, 120.9]
    ],
    // 海南
    [
      [18.2, 108.6], [18.5, 110.0], [19.5, 110.8], [20.0, 110.5], [19.8, 109.0],
      [18.8, 108.5], [18.2, 108.6]
    ],
    // 菲律宾（吕宋+维萨亚+棉兰老粗轮廓）
    [
      [5.5, 125.5], [6.5, 126.5], [8.0, 126.5], [9.5, 125.5], [10.5, 125.0],
      [11.5, 124.5], [12.5, 124.0], [13.5, 123.5], [14.5, 122.5], [16.0, 122.0],
      [18.0, 122.2], [18.5, 120.8], [16.5, 119.8], [14.5, 120.0], [13.5, 120.5],
      [12.0, 120.5], [10.5, 122.0], [9.0, 123.0], [7.5, 122.0], [6.0, 121.5],
      [5.5, 124.0], [5.5, 125.5]
    ],
    // 日本本州+四国+九州粗轮廓
    [
      [31.0, 130.5], [32.0, 130.0], [33.0, 129.5], [34.0, 131.0], [34.5, 132.5],
      [34.8, 134.0], [35.5, 135.5], [35.8, 136.5], [36.5, 137.0], [37.5, 138.5],
      [38.5, 139.5], [39.5, 140.0], [41.0, 141.0], [41.5, 140.5], [40.5, 139.5],
      [39.0, 139.0], [37.5, 137.0], [36.0, 136.0], [35.0, 134.5], [34.0, 133.0],
      [33.0, 131.5], [32.0, 130.5], [31.2, 130.8], [31.0, 130.5]
    ],
    // 北海道
    [
      [41.5, 140.0], [42.0, 140.0], [43.0, 141.0], [44.0, 143.0], [45.0, 142.5],
      [45.5, 141.5], [44.5, 141.0], [43.5, 140.5], [42.5, 140.0], [41.5, 140.0]
    ],
    // 朝鲜半岛
    [
      [34.5, 126.0], [35.5, 126.5], [36.5, 126.0], [37.5, 126.5], [38.5, 128.0],
      [39.0, 128.5], [40.0, 128.0], [41.5, 129.5], [42.0, 130.0], [41.0, 129.5],
      [39.5, 127.5], [38.0, 125.5], [37.0, 125.0], [35.5, 126.0], [34.5, 126.0]
    ]
  ];

  /** 山地示意多边形（加速衰减） */
  const MOUNTAIN_POLYS = [
    // 台湾中央山脉
    [[22.5, 120.8], [23.5, 121.0], [24.5, 121.2], [24.2, 121.5], [23.2, 121.3], [22.5, 121.0]],
    // 中国东南丘陵/武夷一带示意
    [[24.0, 116.0], [25.5, 117.5], [27.0, 118.5], [28.0, 119.0], [27.5, 120.0], [26.0, 119.0], [24.5, 117.5]],
    // 日本中部山地
    [[35.0, 137.0], [36.0, 137.5], [36.5, 138.5], [35.8, 139.0], [35.0, 138.0]],
    // 菲律宾科迪勒拉示意
    [[16.0, 120.8], [17.5, 121.0], [17.2, 121.5], [16.0, 121.2]],
    // 海南中部
    [[18.8, 109.3], [19.2, 109.7], [19.0, 110.0], [18.6, 109.6]]
  ];

  /** 默认 SST 区域框：{id, name, lon0, lon1, lat0, lat1, sst} */
  function defaultSstRegions() {
    return [
      { id: 'scs', name: '南海', lon0: 105, lon1: 121, lat0: 5, lat1: 23, sst: 29.0 },
      { id: 'ps', name: '菲律宾海', lon0: 121, lon1: 145, lat0: 5, lat1: 25, sst: 29.5 },
      { id: 'ecs', name: '东海', lon0: 120, lon1: 130, lat0: 23, lat1: 33, sst: 27.5 },
      { id: 'ys', name: '黄渤海', lon0: 117, lon1: 127, lat0: 33, lat1: 41, sst: 24.0 },
      { id: 'trp', name: '热带西太', lon0: 130, lon1: 160, lat0: 0, lat1: 15, sst: 29.0 },
      { id: 'st', name: '副热带西太', lon0: 130, lon1: 165, lat0: 15, lat1: 30, sst: 28.0 },
      { id: 'ne', name: '东北西太', lon0: 140, lon1: 175, lat0: 30, lat1: 45, sst: 24.5 },
      { id: 'eqe', name: '赤道中西太', lon0: 150, lon1: 180, lat0: 0, lat1: 15, sst: 28.5 }
    ];
  }

  /**
   * 默认副高：若干矩形/多边形块（lngLat 环，[lon, lat]）
   * 北部大块 + 东部延伸
   */
  function defaultFugen() {
    return [
      {
        id: 'wnp_main',
        name: '西北太主副高',
        // 顺时针环 [lon, lat]
        ring: [
          [125, 22], [155, 20], [170, 25], [172, 32], [160, 36], [140, 35], [128, 30], [125, 22]
        ]
      },
      {
        id: 'wnp_east',
        name: '东伸脊',
        ring: [
          [155, 18], [175, 16], [178, 22], [170, 26], [158, 24], [155, 18]
        ]
      }
    ];
  }

  function pointInRing(lon, lat, ring) {
    // ray casting, ring = [[lon,lat],...]
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolysLatLon(lat, lon, polys) {
    for (let i = 0; i < polys.length; i++) {
      const ring = polys[i].map(p => [p[1], p[0]]); // to [lon,lat]
      if (pointInRing(lon, lat, ring)) return true;
    }
    return false;
  }

  function isLand(lon, lat) {
    return pointInPolysLatLon(lat, lon, LAND_POLYS);
  }

  function isMountain(lon, lat) {
    return pointInPolysLatLon(lat, lon, MOUNTAIN_POLYS);
  }

  function getSst(lon, lat, regions) {
    let best = null;
    let bestArea = Infinity;
    for (const r of regions) {
      if (lon >= r.lon0 && lon <= r.lon1 && lat >= r.lat0 && lat <= r.lat1) {
        const area = (r.lon1 - r.lon0) * (r.lat1 - r.lat0);
        if (area < bestArea) {
          bestArea = area;
          best = r.sst;
        }
      }
    }
    if (best != null) return best;
    // 域外/未覆盖：按纬度粗估
    return Math.max(18, 30 - lat * 0.18);
  }

  /** 点是否在任一副高实体内（扣除空洞后） */
  function inFugenSolid(lon, lat, fugenList, hole) {
    for (const f of fugenList) {
      if (!pointInRing(lon, lat, f.ring)) continue;
      if (hole && hole.fugenId === f.id) {
        const dlon = (lon - hole.lon) * Math.cos(lat * Math.PI / 180);
        const dlat = lat - hole.lat;
        const distDeg = Math.sqrt(dlon * dlon + dlat * dlat);
        if (distDeg < hole.radiusDeg) continue; // 空洞内不算副高
      }
      return true;
    }
    return false;
  }

  /** 到副高边界的近似梯度（指向实体内部为正）与是否在内部 */
  function fugenGradient(lon, lat, fugenList, hole) {
    const epsList = [0.35, 0.8, 1.5];
    const c = inFugenSolid(lon, lat, fugenList, hole) ? 1 : 0;
    let gx = 0, gy = 0;
    for (const eps of epsList) {
      const xp = inFugenSolid(lon + eps, lat, fugenList, hole) ? 1 : 0;
      const xm = inFugenSolid(lon - eps, lat, fugenList, hole) ? 1 : 0;
      const yp = inFugenSolid(lon, lat + eps, fugenList, hole) ? 1 : 0;
      const ym = inFugenSolid(lon, lat - eps, fugenList, hole) ? 1 : 0;
      gx += (xp - xm) / (2 * eps);
      gy += (yp - ym) / (2 * eps);
    }
    gx /= epsList.length;
    gy /= epsList.length;
    // 若仍接近 0 且在内部：用到各环顶点的排斥启发
    if (c === 1 && Math.hypot(gx, gy) < 1e-4) {
      let bx = 0, by = 0, n = 0;
      for (const f of fugenList) {
        for (const pt of f.ring) {
          const dx = lon - pt[0];
          const dy = lat - pt[1];
          const d2 = dx * dx + dy * dy + 0.01;
          bx += dx / d2;
          by += dy / d2;
          n++;
        }
      }
      // 指向内部 ≈ 与到边界方向相反
      gx = -bx;
      gy = -by;
    }
    return { inside: c === 1, gx, gy };
  }

  /** 副高北缘纬度（对当前位置附近）— 用于西风带判定 */
  function northernFugenEdgeLat(lon, fugenList, hole) {
    let maxLat = null;
    for (let lat = DOMAIN.latMax; lat >= DOMAIN.latMin; lat -= 0.5) {
      if (inFugenSolid(lon, lat, fugenList, hole)) {
        maxLat = lat;
        break;
      }
    }
    return maxLat;
  }

  /** 风圈半径（度）：由最大风速估算外缘（约 7 级风圈） */
  function windRadiusDeg(vmaxMs) {
    // 经验：更强 → 更大风圈；约 1.2°–4.5°
    const r = 0.8 + (Math.max(0, vmaxMs - 14) / 50) * 3.5;
    return Math.min(4.5, Math.max(0.9, r));
  }

  /** 空圈半径略大于风圈 */
  function holeRadiusDeg(vmaxMs) {
    return windRadiusDeg(vmaxMs) * 1.25 + 0.15;
  }

  /** km/h 近似：1° lat ≈ 111 km；经向随纬度变化 */
  function degPerHourFromMs(uMs, vMs, lat) {
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
    const dlat = (vMs * 3600) / mPerDegLat;
    const dlon = (uMs * 3600) / Math.max(1e3, mPerDegLon);
    return { dlon, dlat };
  }

  /** 中国风力等级（蒲福） */
  function beaufortGrade(ms) {
    if (ms < 0.3) return 0;
    if (ms < 1.6) return 1;
    if (ms < 3.4) return 2;
    if (ms < 5.5) return 3;
    if (ms < 8.0) return 4;
    if (ms < 10.8) return 5;
    if (ms < 13.9) return 6;
    if (ms < 17.2) return 7;
    if (ms < 20.8) return 8;
    if (ms < 24.5) return 9;
    if (ms < 28.5) return 10;
    if (ms < 32.7) return 11;
    if (ms < 37.0) return 12;
    if (ms < 41.5) return 13;
    if (ms < 46.2) return 14;
    if (ms < 50.9) return 15;
    if (ms < 56.1) return 16;
    return 17;
  }

  function gradeLabel(ms) {
    const g = beaufortGrade(ms);
    return g + '级';
  }

  global.TyGeo = {
    DOMAIN,
    LAND_POLYS,
    MOUNTAIN_POLYS,
    defaultSstRegions,
    defaultFugen,
    pointInRing,
    isLand,
    isMountain,
    getSst,
    inFugenSolid,
    fugenGradient,
    northernFugenEdgeLat,
    windRadiusDeg,
    holeRadiusDeg,
    degPerHourFromMs,
    beaufortGrade,
    gradeLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
