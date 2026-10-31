/**
 * Precompute IBTrACS WP landfall places (country / CN province) offline.
 * Reuses Natural Earth land mask (js/land-mask-data.js) for sea→land crossings.
 * Output: data/ibtracs/wp/landfall-index.json
 *
 * Usage: node scripts/build-landfall-index.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WP = path.join(ROOT, 'data', 'ibtracs', 'wp');
const OUT = path.join(WP, 'landfall-index.json');
const YEAR_MIN = 1949;
const YEAR_MAX = 2026;

// —— land mask ——
const maskCode = fs.readFileSync(path.join(ROOT, 'js', 'land-mask-data.js'), 'utf8');
const maskCtx = { globalThis: {} };
vm.runInNewContext(maskCode, maskCtx);
const MASK = maskCtx.globalThis.TY_LAND_MASK;
if (!MASK || !MASK.LAND_POLYS) {
  console.error('Failed to load TY_LAND_MASK');
  process.exit(1);
}
const LAND_RINGS = MASK.LAND_POLYS.map((ring) => ring.map((p) => [p[1], p[0]]));
const LAND_BBOXES = MASK.LAND_BBOXES;

function pointInRing(lon, lat, ring) {
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

function isLand(lon, lat) {
  const n = LAND_RINGS.length;
  for (let i = 0; i < n; i++) {
    if (LAND_BBOXES && LAND_BBOXES.length === n) {
      const b = LAND_BBOXES[i];
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    }
    if (pointInRing(lon, lat, LAND_RINGS[i])) return true;
  }
  return false;
}

function coastCrossing(a, b) {
  let lo = 0, hi = 1, lon = b.lon, lat = b.lat;
  for (let k = 0; k < 18; k++) {
    const m = (lo + hi) * 0.5;
    const x = a.lon + (b.lon - a.lon) * m;
    const y = a.lat + (b.lat - a.lat) * m;
    if (isLand(x, y)) { hi = m; lon = x; lat = y; }
    else lo = m;
  }
  return { lon, lat };
}

/**
 * Region table: first match wins (more specific first).
 * Rings are [lon,lat] closed-ish polygons covering coastal landfall zones.
 * kind: 'province' (CN) | 'country'
 */
const REGIONS = [
  // —— CN provinces (coastal) ——
  {
    id: '台湾', kind: 'province', country: '中国',
    rings: [[
      [119.8, 21.7], [122.2, 21.7], [122.2, 25.6], [121.4, 25.6],
      [120.0, 25.3], [119.8, 23.5], [119.8, 21.7]
    ]]
  },
  {
    id: '海南', kind: 'province', country: '中国',
    rings: [[
      [108.4, 18.0], [111.2, 18.0], [111.2, 20.15], [110.6, 20.15],
      [108.6, 19.6], [108.4, 18.0]
    ]]
  },
  {
    id: '广东', kind: 'province', country: '中国',
    rings: [[
      [109.4, 20.15], [117.3, 20.15], [117.3, 25.6], [115.5, 25.6],
      [112.0, 24.8], [110.0, 22.5], [109.4, 21.5], [109.4, 20.15]
    ]]
  },
  {
    id: '广西', kind: 'province', country: '中国',
    rings: [[
      [105.5, 20.8], [109.5, 20.8], [109.5, 22.8], [108.0, 23.5],
      [105.5, 22.5], [105.5, 20.8]
    ]]
  },
  {
    id: '浙江', kind: 'province', country: '中国',
    rings: [[
      [118.5, 27.05], [123.2, 27.05], [123.2, 31.4], [121.0, 31.4],
      [120.0, 30.0], [118.5, 28.5], [118.5, 27.05]
    ]]
  },
  {
    id: '福建', kind: 'province', country: '中国',
    rings: [[
      [116.8, 23.4], [120.55, 23.4], [120.55, 27.1], [119.0, 27.1],
      [117.0, 26.0], [116.8, 23.4]
    ]]
  },
  {
    id: '上海', kind: 'province', country: '中国',
    rings: [[
      [120.8, 30.6], [122.2, 30.6], [122.2, 31.9], [120.8, 31.9], [120.8, 30.6]
    ]]
  },
  {
    id: '江苏', kind: 'province', country: '中国',
    rings: [[
      [118.4, 31.3], [122.2, 31.3], [122.2, 35.2], [119.0, 35.2],
      [118.4, 33.0], [118.4, 31.3]
    ]]
  },
  {
    id: '山东', kind: 'province', country: '中国',
    rings: [[
      [117.5, 34.8], [122.9, 34.8], [122.9, 38.5], [120.5, 38.5],
      [118.5, 37.5], [117.5, 36.0], [117.5, 34.8]
    ]]
  },
  {
    id: '辽宁', kind: 'province', country: '中国',
    rings: [[
      [119.5, 38.5], [125.0, 38.5], [125.0, 41.5], [121.0, 41.5],
      [119.5, 40.0], [119.5, 38.5]
    ]]
  },
  {
    id: '河北', kind: 'province', country: '中国',
    rings: [[
      [117.4, 38.0], [119.9, 38.0], [119.9, 40.2], [117.4, 40.2], [117.4, 38.0]
    ]]
  },
  // —— countries ——
  {
    id: '菲律宾', kind: 'country',
    rings: [
      // Luzon + Visayas + Mindanao envelope
      [
        [116.8, 4.8], [127.0, 4.8], [127.0, 19.0], [121.5, 19.0],
        [119.5, 16.0], [116.8, 10.0], [116.8, 4.8]
      ]
    ]
  },
  {
    id: '日本', kind: 'country',
    rings: [
      // Main islands
      [
        [129.0, 30.5], [146.0, 30.5], [146.0, 45.8], [139.0, 45.8],
        [130.5, 41.0], [129.0, 34.0], [129.0, 30.5]
      ],
      // Ryukyu / Okinawa
      [
        [122.5, 24.0], [131.5, 24.0], [131.5, 30.6], [127.0, 30.6],
        [122.5, 26.5], [122.5, 24.0]
      ]
    ]
  },
  {
    id: '韩国', kind: 'country',
    rings: [[
      [124.5, 33.0], [132.2, 33.0], [132.2, 38.7], [126.0, 38.7],
      [124.5, 36.0], [124.5, 33.0]
    ]]
  },
  {
    id: '朝鲜', kind: 'country',
    rings: [[
      [124.0, 37.6], [130.8, 37.6], [130.8, 43.1], [124.0, 43.1], [124.0, 37.6]
    ]]
  },
  {
    id: '越南', kind: 'country',
    rings: [[
      [102.0, 8.3], [109.8, 8.3], [109.8, 23.5], [105.0, 23.5],
      [102.0, 18.0], [102.0, 8.3]
    ]]
  },
  {
    id: '柬埔寨', kind: 'country',
    rings: [[
      [102.2, 10.2], [104.9, 10.2], [104.9, 12.0], [102.2, 12.0], [102.2, 10.2]
    ]]
  },
  {
    id: '老挝', kind: 'country',
    rings: [[
      [100.0, 13.8], [107.8, 13.8], [107.8, 22.6], [100.0, 22.6], [100.0, 13.8]
    ]]
  },
  {
    id: '泰国', kind: 'country',
    rings: [[
      [97.0, 5.5], [105.0, 5.5], [105.0, 16.0], [100.0, 16.0], [97.0, 12.0], [97.0, 5.5]
    ]]
  },
  {
    id: '马来西亚', kind: 'country',
    rings: [
      [[99.5, 1.0], [104.8, 1.0], [104.8, 7.0], [99.5, 7.0], [99.5, 1.0]],
      [[109.0, 0.8], [119.5, 0.8], [119.5, 7.5], [109.0, 7.5], [109.0, 0.8]]
    ]
  },
  {
    id: '俄罗斯', kind: 'country',
    rings: [[
      [130.0, 42.5], [160.0, 42.5], [160.0, 55.0], [130.0, 55.0], [130.0, 42.5]
    ]]
  },
  // CN mainland inland fallback (after province miss)
  {
    id: '中国', kind: 'country',
    rings: [[
      [100.0, 18.0], [125.0, 18.0], [125.0, 42.0], [100.0, 42.0], [100.0, 18.0]
    ]]
  }
];

// Precompute bboxes
for (const r of REGIONS) {
  r.bboxes = r.rings.map((ring) => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lo, la] of ring) {
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
    }
    return [minLon, minLat, maxLon, maxLat];
  });
}

function classifyPoint(lon, lat) {
  for (const r of REGIONS) {
    for (let i = 0; i < r.rings.length; i++) {
      const b = r.bboxes[i];
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (pointInRing(lon, lat, r.rings[i])) {
        return r;
      }
    }
  }
  return null;
}

function landfallsForTrack(points) {
  const places = new Set();
  const hits = [];
  if (!points || points.length < 2) return { places, hits };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a == null || b == null) continue;
    const lonA = +a.lon, latA = +a.lat, lonB = +b.lon, latB = +b.lat;
    if (!Number.isFinite(lonA) || !Number.isFinite(latA) ||
        !Number.isFinite(lonB) || !Number.isFinite(latB)) continue;
    if (!isLand(lonA, latA) && isLand(lonB, latB)) {
      const c = coastCrossing({ lon: lonA, lat: latA }, { lon: lonB, lat: latB });
      const reg = classifyPoint(c.lon, c.lat);
      if (!reg) continue;
      hits.push({ lon: +c.lon.toFixed(2), lat: +c.lat.toFixed(2), place: reg.id, kind: reg.kind });
      places.add(reg.id);
      if (reg.kind === 'province' && reg.country) places.add(reg.country);
    }
  }
  return { places, hits };
}

const placeCatalog = [];
const seenPlace = new Set();
for (const r of REGIONS) {
  if (seenPlace.has(r.id)) continue;
  seenPlace.add(r.id);
  placeCatalog.push({
    id: r.id,
    kind: r.kind,
    country: r.country || null
  });
}

const stormsOut = Object.create(null);
let stormCount = 0;
let withLf = 0;

for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
  const fp = path.join(WP, y + '.json');
  if (!fs.existsSync(fp)) continue;
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  for (const s of (data.storms || [])) {
    stormCount++;
    const { places, hits } = landfallsForTrack(s.points);
    if (!places.size) continue;
    withLf++;
    const arr = Array.from(places);
    // provinces first then countries for stable UX, then alpha
    arr.sort((a, b) => {
      const ka = placeCatalog.find((p) => p.id === a);
      const kb = placeCatalog.find((p) => p.id === b);
      const oa = ka && ka.kind === 'province' ? 0 : 1;
      const ob = kb && kb.kind === 'province' ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b, 'zh');
    });
    stormsOut[s.id] = arr;
  }
  process.stdout.write('\r' + y + '  storms=' + stormCount + '  withLandfall=' + withLf);
}

const payload = {
  source: 'IBTrACS WP + Natural Earth land mask + offline region table',
  built: new Date().toISOString(),
  ver: '20261031j',
  yearMin: YEAR_MIN,
  yearMax: YEAR_MAX,
  stormCount,
  withLandfall: withLf,
  places: placeCatalog,
  // id -> [placeIds...]
  storms: stormsOut
};

fs.writeFileSync(OUT, JSON.stringify(payload));
console.log('\nWrote', OUT, 'bytes=', fs.statSync(OUT).size);

// Spot-check known storms if present
const checks = [
  ['2019214N15134', '利奇马/Lekima → expect 浙江'],
  ['2018250N12170', '山竹/Mangkhut → 广东+菲律宾'],
  ['2006216N07151', '桑美/Saomai → 浙江'],
];
for (const [id, note] of checks) {
  console.log(' check', id, stormsOut[id] || '(none)', note);
}
