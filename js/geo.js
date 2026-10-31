/**
 * 地理与环境场：陆掩码、山地、SST 区域、副高多边形工具
 * 西北太平洋域：lon 100–180°E, lat 0–66°N（北至白令海峡）
 */
(function (global) {
  'use strict';

  const DOMAIN = { lonMin: 100, lonMax: 180, latMin: 0, latMax: 66 };

  /**
   * 陆地多边形 [lat, lon] — 与 OSM 底图同为 WGS84。
   * 数据来自 Natural Earth 10m land（js/land-mask-data.js），对齐可见海岸线；
   * 不再使用手绘粗轮廓（会与底图错位，导致登陆旗落在海上/内陆）。
   */
  const _mask = (typeof global !== 'undefined' && global.TY_LAND_MASK) ||
    (typeof globalThis !== 'undefined' && globalThis.TY_LAND_MASK) ||
    (typeof window !== 'undefined' && window.TY_LAND_MASK) || null;
  const LAND_POLYS = (_mask && _mask.LAND_POLYS) ? _mask.LAND_POLYS : [];
  const LAND_BBOXES = (_mask && _mask.LAND_BBOXES) ? _mask.LAND_BBOXES : null;
  if (!LAND_POLYS.length) {
    console.warn('[TyGeo] land mask missing — load js/land-mask-data.js before geo.js');
  }
  /** 预转换 [lon,lat] 环，避免 isLand 热路径反复 map */
  const LAND_RINGS_LONLAT = LAND_POLYS.map(function (ring) {
    return ring.map(function (p) { return [p[1], p[0]]; });
  });

  /**
   * 山地多边形 [lat, lon] — 与 OSM / 陆掩码同为 WGS84。
   * mountain-data.js：terrarium z8 台湾≥800m（脊线）+ 华南≥550m；
   * z7 日/菲/韩/海南；仅北方 NE Range/mtn。inset 去域边假墙。
   */
  const _mtn = (typeof global !== 'undefined' && global.TY_MOUNTAIN_MASK) ||
    (typeof globalThis !== 'undefined' && globalThis.TY_MOUNTAIN_MASK) ||
    (typeof window !== 'undefined' && window.TY_MOUNTAIN_MASK) || null;
  const MOUNTAIN_POLYS = (_mtn && _mtn.MOUNTAIN_POLYS) ? _mtn.MOUNTAIN_POLYS : [];
  const MOUNTAIN_BBOXES = (_mtn && _mtn.MOUNTAIN_BBOXES) ? _mtn.MOUNTAIN_BBOXES : null;
  if (!MOUNTAIN_POLYS.length) {
    console.warn('[TyGeo] mountain mask missing — load js/mountain-data.js before geo.js');
  }
  /** 预转换 [lon,lat] 环，避免 isMountain 热路径反复 map */
  const MOUNTAIN_RINGS_LONLAT = MOUNTAIN_POLYS.map(function (ring) {
    return ring.map(function (p) { return [p[1], p[0]]; });
  });

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
   * Chaikin 角点切削：使多边形边缘更顺滑。
   * ring = [[lon,lat],...]，首尾可闭合（末点≈首点）或开放。
   * 返回闭合环（末点重复首点）。
   */
  function chaikinSmooth(ring, iterations) {
    iterations = iterations == null ? 1 : iterations;
    let pts = ring.slice();
    // 去掉闭合重复点
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
        pts = pts.slice(0, -1);
      }
    }
    for (let iter = 0; iter < iterations; iter++) {
      const next = [];
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        next.push([
          0.75 * p0[0] + 0.25 * p1[0],
          0.75 * p0[1] + 0.25 * p1[1]
        ]);
        next.push([
          0.25 * p0[0] + 0.75 * p1[0],
          0.25 * p0[1] + 0.75 * p1[1]
        ]);
      }
      pts = next;
    }
    pts.push([pts[0][0], pts[0][1]]);
    return pts;
  }

  /**
   * 生成圆角矩形 / 卵形副高环（[lon,lat]）。
   * 沿边界均匀取 n 点，四角用四分之一椭圆过渡，整体呈顺滑 blob。
   */
  function roundedRectRing(lon0, lon1, lat0, lat1, n, cornerFrac) {
    n = n || 20;
    cornerFrac = cornerFrac == null ? 0.28 : cornerFrac;
    const w = lon1 - lon0;
    const h = lat1 - lat0;
    const rx = Math.min(w, h) * cornerFrac * 0.5 + w * cornerFrac * 0.25;
    const ry = Math.min(w, h) * cornerFrac * 0.5 + h * cornerFrac * 0.25;
    const cx = (lon0 + lon1) / 2;
    const cy = (lat0 + lat1) / 2;
    // 半轴略大于矩形半宽，略扁椭圆 + 轻微起伏，更像副高脊
    const a = w / 2;
    const b = h / 2;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      // 超椭圆近似 (p≈2.4) + 轻微方位调制，避免正椭圆过于规整
      const p = 2.35;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const r = 1 / Math.pow(
        Math.pow(Math.abs(c), p) + Math.pow(Math.abs(s), p),
        1 / p
      );
      const wobble = 1 + 0.04 * Math.sin(2 * t) + 0.025 * Math.cos(3 * t);
      const lon = cx + a * r * c * wobble;
      const lat = cy + b * r * s * wobble * (1 + 0.03 * Math.sin(t));
      pts.push([lon, lat]);
    }
    pts.push([pts[0][0], pts[0][1]]);
    return chaikinSmooth(pts, 1);
  }

  /**
   * 在地图中心附近生成一块新的顺滑副高环。
   */
  function makeSmoothFugenRing(lonC, latC, halfW, halfH, n) {
    halfW = halfW == null ? 6 : halfW;
    halfH = halfH == null ? 3.5 : halfH;
    n = n || 12;
    return roundedRectRing(lonC - halfW, lonC + halfW, latC - halfH, latC + halfH, n, 0.32);
  }

  /**
   * 西太副高气候态单环：稀疏顶点（约 9–10 个），北缘弯脊（lon→lat 起伏），
   * 南界贴域底、东西贴 DOMAIN → 黄线以南一整块实体无缺口。不做 chaikin（避免编辑点爆炸）。
   * ridgeW2E: 北缘控制点，自西向东 [[lon,lat],...]，各点纬度必须有明显起伏。
   */
  function ridgeSlabRing(west, east, south, ridgeW2E, westMidLat) {
    const ridge = ridgeW2E.slice();
    // 保证脊两端贴东西界
    ridge[0] = [west, ridge[0][1]];
    ridge[ridge.length - 1] = [east, ridge[ridge.length - 1][1]];
    const pts = [];
    // 南界：西南 → 东南（黄线以南整片实体）
    pts.push([west, south]);
    pts.push([east, south]);
    // 北缘：自东向西沿弯脊（CCW）
    for (let i = ridge.length - 1; i >= 0; i--) {
      pts.push([ridge[i][0], ridge[i][1]]);
    }
    // 西界中点：经度盖广东一带，纬度落在华南沿海
    pts.push([west, westMidLat == null ? 18 : westMidLat]);
    pts.push([pts[0][0], pts[0][1]]); // 闭合
    return pts;
  }

  /**
   * 按月份气候态：域内黄线以南 = 一整块副热带高压（单多边形 wnp_slab，无多块）。
   * 绿线=弯脊北缘；黄线=绿线南约 0.15°。台风在实体内靠出生空圈移动。
   *   6 月：北缘 → 江南（弯脊起伏）
   *   7 月：北缘 → 黄淮；西界盖广东
   *   8 月：北缘 → 华北南缘；西界盖广东
   *   9 月：北缘南撤江南
   */
  function fugenForMonth(month) {
    const mo = Number(month) || 7;
    // 域内黄线以南整片实体：西/东贴 DOMAIN、南界贴 0°N；北缘弯脊（禁直线）；单块 wnp_slab
    // east 略过 lonMax：射线法在右边界偶发漏判，保证 180°E 仍实体内
    let west = DOMAIN.lonMin, east = DOMAIN.lonMax + 0.5, south = DOMAIN.latMin, westMid = 18.0, ridge;
    if (mo === 6) {
      // 江南：脊线 ~28–31°N，西低东有次峰
      ridge = [
        [100, 27.6],
        [118, 30.4],
        [128, 28.8],
        [142, 31.0],
        [155, 29.2],
        [180.5, 27.5]
      ];
    } else if (mo === 8) {
      // 华北南缘：脊线 ~34–38°N
      ridge = [
        [100, 32.8],
        [116, 35.6],
        [126, 37.4],
        [140, 38.1],
        [155, 36.2],
        [180.5, 33.8]
      ];
    } else if (mo === 9) {
      // 南撤江南
      ridge = [
        [100, 27.2],
        [117, 29.8],
        [129, 28.2],
        [143, 30.4],
        [156, 28.6],
        [180.5, 26.8]
      ];
    } else {
      // 7 月黄淮；西界盖广东并贴域西缘
      ridge = [
        [100, 31.2],
        [116, 33.8],
        [126, 35.6],
        [140, 36.3],
        [154, 34.5],
        [180.5, 32.2]
      ];
    }
    return [
      {
        id: 'wnp_slab',
        name: '西北太副高',
        ring: ridgeSlabRing(west, east, south, ridge, westMid)
      }
    ];
  }

  /** 默认副高：7 月气候态（黄淮） */
  function defaultFugen() {
    return fugenForMonth(7);
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

  /** 陆掩码：bbox 初筛 + 射线法；多边形与 OSM 底图同 datum（WGS84） */
  function isLand(lon, lat) {
    const n = LAND_RINGS_LONLAT.length;
    if (!n) return false;
    const boxes = LAND_BBOXES;
    for (let i = 0; i < n; i++) {
      if (boxes && boxes.length === n) {
        const b = boxes[i];
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      }
      if (pointInRing(lon, lat, LAND_RINGS_LONLAT[i])) return true;
    }
    return false;
  }

  function isMountain(lon, lat) {
    const n = MOUNTAIN_RINGS_LONLAT.length;
    if (!n) return false;
    const boxes = MOUNTAIN_BBOXES;
    for (let i = 0; i < n; i++) {
      if (boxes && boxes.length === n) {
        const b = boxes[i];
        if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      }
      if (pointInRing(lon, lat, MOUNTAIN_RINGS_LONLAT[i])) return true;
    }
    return false;
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

  /**
   * 副高北缘纬度（西风带南界 / 绿线）——贴红区北缘：
   *   - 以本经线为主，仅 ±1° 邻经做轻度加权软混合（消毛刺）
   *   - 无北偏：绿线 = 混合后的局地北缘本身（不再 +0.5°）
   * 绿线绘制与 guidingNorthernEdgeLat / steeringAt 完全一致（本经贴边；空档最高连接；开阔 look-east）。
   *
   * APPROACH_NORTH_BAND_DEG = 0.15° lat（≈50 km）= 黄线相对绿线的南偏。
   *   黄线以南：往西北偏西；黄→绿 [edge−0.15, edge)：纯往北 u≡0（锁存腿）；
   *   绿线以北：往东北稍微偏东（≈40–50° from N），小振幅 Δlon≈3–7°；非深 ENE。
   * 绿线 = 本经局地北缘 / gap 最高连接 / 开阔 look-east（见 guidingNorthernEdgeLat）。
   */
  const APPROACH_NORTH_BAND_DEG = 0.15;
  // [dlon, weight]：本经线权重大，±1° 轻柔平滑毛刺
  // [dlon, weight]：本经线权重大，±1° 轻柔平滑毛刺（勿扩到 ±2，以免南海脊污染两脊空档）
  const WESTERLY_EDGE_BLEND = [[0, 0.62], [-1, 0.19], [1, 0.19]];

  /** 单经线上的原始局地北缘（二分），无偏置 */
  function rawLocalFugenEdgeLat(lon, fugenList, hole) {
    if (lon < DOMAIN.lonMin || lon > DOMAIN.lonMax) return null;
    let approx = null;
    for (let lat = DOMAIN.latMax; lat >= DOMAIN.latMin; lat -= 0.15) {
      if (inFugenSolid(lon, lat, fugenList, hole)) {
        approx = lat;
        break;
      }
    }
    if (approx == null) return null;
    let hi = Math.min(DOMAIN.latMax, approx + 0.15);
    let lo = Math.max(DOMAIN.latMin, approx - 0.15);
    for (let k = 0; k < 10; k++) {
      const mid = (hi + lo) * 0.5;
      if (inFugenSolid(lon, mid, fugenList, hole)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  function northernFugenEdgeLat(lon, fugenList, hole) {
    if (!fugenList || !fugenList.length) return null;
    let sum = 0, wSum = 0;
    for (const [dlon, w] of WESTERLY_EDGE_BLEND) {
      const e = rawLocalFugenEdgeLat(lon + dlon, fugenList, hole);
      if (e == null) continue;
      sum += e * w;
      wSum += w;
    }
    if (wSum <= 0) return null;
    return sum / wSum; // 贴副高北缘，无北偏
  }

  /**
   * 引导用北缘（绿线）——与绘制 / steeringAt / inWesterlyBelt 完全一致：
   *
   * 1) 本经有副高实体：绿线 = 局地北缘（贴红区）。副高北边就是西风带，
   *    绝不再被 look-east max 抬到远处主脊高度——否则南海块以北、两块之间
   *    大片本应是西风带的区域会被误判成基础场。
   * 2) 本经无副高（空档 / 开阔）：
   *    - 若东西两侧都能看到副高块（两脊之间的 gap）：绿线 = 两侧最近北缘的
   *      较高者（最高连接绿线纬度）。gap 内 lat≥该连接绿线 → 全部西风带 ENE，
   *      不是空/基础场。
   *    - 若只有一侧（例如西侧开阔看主脊）：在 look 窗取 max lat，并向东看够远
   *      （+24°），避免西侧贴南海低纬块而够不到主脊。
   */
  const GUIDING_EDGE_LOOK_DLONS = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24,
    -1, -2, -3, -4
  ];
  function guidingNorthernEdgeLat(lon, fugenList, hole) {
    const local = northernFugenEdgeLat(lon, fugenList, hole);
    if (local != null) return local; // 贴本经红区北缘；北侧即西风带

    let best = null;
    let nearestWest = null, nearestEast = null;
    let distW = Infinity, distE = Infinity;
    for (const dlon of GUIDING_EDGE_LOOK_DLONS) {
      if (dlon === 0) continue;
      const e = northernFugenEdgeLat(lon + dlon, fugenList, hole);
      if (e == null) continue;
      if (best == null || e > best) best = e;
      if (dlon < 0) {
        const d = -dlon;
        if (d < distW) { distW = d; nearestWest = e; }
      } else {
        const d = dlon;
        if (d < distE) { distE = d; nearestEast = e; }
      }
    }
    // 两脊之间的空档：最高连接绿线 = 两侧最近北缘之 max
    if (nearestWest != null && nearestEast != null) {
      return Math.max(nearestWest, nearestEast);
    }
    // 开阔一侧：look 窗 max（向东够远追上主脊）
    return best;
  }

  /** 是否位于副高以北的西风带（不含副高实体内部） */
  function inWesterlyBelt(lon, lat, fugenList, hole) {
    if (inFugenSolid(lon, lat, fugenList, hole)) return false;
    const edge = guidingNorthernEdgeLat(lon, fugenList, hole);
    if (edge == null) return lat >= 32; // 无副高时的弱兜底
    return lat >= edge;
  }

  /** 7 级风圈半径（度）：由最大风速估算外缘 */
  function windRadiusDeg(vmaxMs) {
    // 经验：更强 → 更大风圈；约 0.9°–4.5°
    const r = 0.8 + (Math.max(0, vmaxMs - 14) / 50) * 3.5;
    return Math.min(4.5, Math.max(0.9, r));
  }

  /**
   * 同时给出 7 / 10 / 12 级风圈半径（度）。
   * 外圈=7级，中圈=10级，内圈=12级；若当前最大风速未达该等级则不返回该项。
   * WIND_CIRCLE_SCALE 只放大显示风圈，不影响 holeRadiusDeg / 空圈与路径。
   */
  const WIND_CIRCLE_SCALE = 1.2; // ~20% larger concentric rings (was 1.0)
  function windRadiiForGrades(vmaxMs) {
    // 只有达到该风力等级才显示对应风圈（蒲福：7≥13.9，10≥24.5，12≥32.7 m/s）
    const r7 = windRadiusDeg(vmaxMs) * WIND_CIRCLE_SCALE;
    const out = [];
    if (vmaxMs >= 13.9) {
      out.push({ grade: 7, radiusDeg: r7, color: '#2980b9', fill: '#3498db', fillOpacity: 0.05, weight: 2, label: '7级风圈' });
    }
    if (vmaxMs >= 24.5) {
      out.push({ grade: 10, radiusDeg: Math.max(0.35 * WIND_CIRCLE_SCALE, r7 * 0.58), color: '#e67e22', fill: '#f39c12', fillOpacity: 0.07, weight: 2, label: '10级风圈' });
    }
    if (vmaxMs >= 32.7) {
      out.push({ grade: 12, radiusDeg: Math.max(0.2 * WIND_CIRCLE_SCALE, r7 * 0.34), color: '#c0392b', fill: '#e74c3c', fillOpacity: 0.1, weight: 2.5, label: '12级风圈' });
    }
    return out;
  }

  /** 空圈：整块副高内台风进路；略放大便于沿引导移动 */
  function holeRadiusDeg(vmaxMs) {
    return windRadiusDeg(vmaxMs) * 1.6 + 0.5;
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

  /**
   * 路径强度色阶模式：
   *   cma   — 中国中央气象台路径点熟悉色（默认）
   *   sshws — 美国 NHC / Saffir–Simpson 飓风官方色
   */
  const INTENSITY_SCALE_CMA = 'cma';
  const INTENSITY_SCALE_SSHWS = 'sshws';

  /** CMA：TD绿 TS蓝 STS黄 TY橙 STY紫 Super红（用户定稿） */
  function intensityTrackColorCma(vmaxMs) {
    const g = beaufortGrade(vmaxMs);
    if (g < 8) return '#008000';
    if (g < 10) return '#0000FF';
    if (g < 12) return '#FFFF00';
    if (g < 14) return '#FFA500';
    if (g < 16) return '#800080';
    return '#FF0000';
  }

  /**
   * NHC / Saffir–Simpson 路径色（GIS 常用官方色）
   * 取值：TD #00A9E6 · TS #38A800 · C1 #E6E600 · C2 #FFAA00 · C3 #E60000 · C4 #FF00C5 · C5 #8400A8
   * 档位按 1-min 风速换算 m/s：<17.5 / <33 / <42.7 / <49.4 / <58.1 / <70.5 / ≥70.5
   */
  function intensityTrackColorSshws(vmaxMs) {
    const v = +vmaxMs || 0;
    if (v < 17.5) return '#00A9E6';  // TD
    if (v < 33.0) return '#38A800';  // TS
    if (v < 42.7) return '#E6E600';  // Cat 1
    if (v < 49.4) return '#FFAA00';  // Cat 2
    if (v < 58.1) return '#E60000';  // Cat 3
    if (v < 70.5) return '#FF00C5';  // Cat 4
    return '#8400A8';               // Cat 5
  }

  function intensityTrackColor(vmaxMs, scale) {
    if (scale === INTENSITY_SCALE_SSHWS) return intensityTrackColorSshws(vmaxMs);
    return intensityTrackColorCma(vmaxMs);
  }

  function intensityScaleLabel(vmaxMs, scale) {
    if (scale === INTENSITY_SCALE_SSHWS) {
      const v = +vmaxMs || 0;
      if (v < 17.5) return 'TD';
      if (v < 33.0) return 'TS';
      if (v < 42.7) return 'Cat 1';
      if (v < 49.4) return 'Cat 2';
      if (v < 58.1) return 'Cat 3';
      if (v < 70.5) return 'Cat 4';
      return 'Cat 5';
    }
    const g = beaufortGrade(vmaxMs);
    if (g < 8) return 'TD';
    if (g < 10) return 'TS';
    if (g < 12) return 'STS';
    if (g < 14) return 'TY';
    if (g < 16) return 'STY';
    return 'SuperTY';
  }

  /** 图例条目：[{hex, text}] */
  function intensityLegendItems(scale) {
    if (scale === INTENSITY_SCALE_SSHWS) {
      return [
        { hex: '#00A9E6', text: 'TD Depression' },
        { hex: '#38A800', text: 'TS Storm' },
        { hex: '#E6E600', text: 'Cat 1' },
        { hex: '#FFAA00', text: 'Cat 2' },
        { hex: '#E60000', text: 'Cat 3' },
        { hex: '#FF00C5', text: 'Cat 4' },
        { hex: '#8400A8', text: 'Cat 5' }
      ];
    }
    return [
      { hex: '#008000', text: 'TD 热带低压' },
      { hex: '#0000FF', text: 'TS 热带风暴' },
      { hex: '#FFFF00', text: 'STS 强热带风暴' },
      { hex: '#FFA500', text: 'TY 台风' },
      { hex: '#800080', text: 'STY 强台风' },
      { hex: '#FF0000', text: 'Super 超强台风' }
    ];
  }

  global.TyGeo = {
    DOMAIN,
    LAND_POLYS,
    MOUNTAIN_POLYS,
    defaultSstRegions,
    defaultFugen,
    fugenForMonth,
    roundedRectRing,
    makeSmoothFugenRing,
    chaikinSmooth,
    pointInRing,
    isLand,
    isMountain,
    getSst,
    inFugenSolid,
    fugenGradient,
    northernFugenEdgeLat,
    guidingNorthernEdgeLat,
    APPROACH_NORTH_BAND_DEG,
    inWesterlyBelt,
    windRadiusDeg,
    windRadiiForGrades,
    holeRadiusDeg,
    degPerHourFromMs,
    beaufortGrade,
    gradeLabel,
    INTENSITY_SCALE_CMA,
    INTENSITY_SCALE_SSHWS,
    intensityTrackColor,
    intensityTrackColorCma,
    intensityTrackColorSshws,
    intensityScaleLabel,
    intensityLegendItems
  };
})(typeof window !== 'undefined' ? window : globalThis);
