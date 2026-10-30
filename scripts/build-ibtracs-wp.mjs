/**
 * Build per-year Northwest Pacific track JSON from NOAA IBTrACS WP CSV.
 * Full best-track positions (do not drop points for missing wind / soft domain).
 * Usage: node scripts/build-ibtracs-wp.mjs [/path/to/ibtracs.WP.list.v04r01.csv]
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'data', 'ibtracs', 'wp');
const YEAR_MIN = 1949;
const YEAR_MAX = 2026;
const KT_TO_MS = 0.514444;

const csvPath = process.argv[2] || '/tmp/ibtracs/ibtracs.WP.list.v04r01.csv';
if (!fs.existsSync(csvPath)) {
  console.error('Missing CSV:', csvPath);
  process.exit(1);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function num(v) {
  if (v == null || v === '' || v === ' ') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function windMs(cma, tokyo, usa, wmo) {
  const kt = cma ?? tokyo ?? usa ?? wmo;
  if (kt == null || kt < 0) return null;
  return +(kt * KT_TO_MS).toFixed(1);
}

function normLon(lon) {
  if (lon == null) return null;
  let x = lon;
  if (x < 0) x += 360;
  if (x > 360) x -= 360;
  return +x.toFixed(2);
}

fs.mkdirSync(OUT, { recursive: true });

const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
let header = null;
let idx = {};
let lineNo = 0;
/** @type {Map<string, any>} */
const storms = new Map();

for await (const line of rl) {
  lineNo++;
  if (lineNo === 1) {
    header = parseCsvLine(line);
    header.forEach((h, i) => { idx[h] = i; });
    continue;
  }
  if (lineNo === 2) continue; // units row
  if (!line || line.startsWith('#')) continue;
  const cols = parseCsvLine(line);
  const season = num(cols[idx.SEASON]);
  if (season == null || season < YEAR_MIN || season > YEAR_MAX) continue;
  const sid = cols[idx.SID];
  if (!sid) continue;

  // Prefer IBTrACS standardized LAT/LON for complete best-track geometry
  const lat = num(cols[idx.LAT]) ?? num(cols[idx.CMA_LAT]) ?? num(cols[idx.TOKYO_LAT]) ?? num(cols[idx.USA_LAT]);
  const lonRaw = num(cols[idx.LON]) ?? num(cols[idx.CMA_LON]) ?? num(cols[idx.TOKYO_LON]) ?? num(cols[idx.USA_LON]);
  const lon = normLon(lonRaw);
  if (lat == null || lon == null) continue;
  // Very wide sanity gate only (WP CSV already basin-scoped); do not clip track ends
  if (lat < -30 || lat > 80 || lon < 70 || lon > 250) continue;

  let vmax = windMs(
    num(cols[idx.CMA_WIND]),
    num(cols[idx.TOKYO_WIND]),
    num(cols[idx.USA_WIND]),
    num(cols[idx.WMO_WIND])
  );
  // Keep position even if wind missing — carry-forward applied after collect

  const iso = cols[idx.ISO_TIME] || '';
  const name = (cols[idx.NAME] || 'UNNAMED').trim();
  const key = sid;
  let s = storms.get(key);
  if (!s) {
    s = { id: sid, name: name === 'NOT_NAMED' ? 'UNNAMED' : name, season, points: [], maxVmax: 0 };
    storms.set(key, s);
  }
  if (name && name !== 'NOT_NAMED' && s.name === 'UNNAMED') s.name = name;
  s.points.push({ lon, lat, vmax, t: iso });
  if (vmax != null && vmax > s.maxVmax) s.maxVmax = vmax;
}

/** @type {Map<number, any[]>} */
const byYear = new Map();
for (const s of storms.values()) {
  if (s.points.length < 2) continue;
  // Deduplicate identical consecutive times; carry-forward vmax across gaps
  const pts = [];
  let lastT = null;
  let lastV = null;
  for (const p of s.points) {
    let vmax = p.vmax;
    if (vmax == null) vmax = lastV;
    if (vmax != null) lastV = vmax;
    const q = { lon: p.lon, lat: p.lat, vmax: vmax != null ? vmax : 0, t: p.t };
    if (p.t && p.t === lastT) {
      pts[pts.length - 1] = q;
      continue;
    }
    pts.push(q);
    lastT = p.t;
  }
  s.points = pts;
  if (s.points.length < 2) continue;
  s.maxVmax = s.points.reduce((m, p) => Math.max(m, p.vmax || 0), 0);
  const y = s.season;
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y).push({
    id: s.id,
    name: s.name,
    season: s.season,
    maxVmax: +s.maxVmax.toFixed(1),
    points: s.points
  });
}

const years = [];
for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
  const list = byYear.get(y) || [];
  list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const payload = {
    year: y,
    basin: 'WP',
    source: 'NOAA IBTrACS v04r01 WP',
    count: list.length,
    storms: list
  };
  const outFile = path.join(OUT, `${y}.json`);
  fs.writeFileSync(outFile, JSON.stringify(payload));
  years.push({ year: y, count: list.length, bytes: fs.statSync(outFile).size });
  console.log(`wrote ${y}.json storms=${list.length} bytes=${fs.statSync(outFile).size}`);
}

const index = {
  basin: 'WP',
  yearMin: YEAR_MIN,
  yearMax: YEAR_MAX,
  source: 'NOAA IBTrACS v04r01',
  wind: 'prefer CMA_WIND → TOKYO_WIND → USA_WIND → WMO_WIND (kt→m/s); carry-forward if missing',
  position: 'IBTrACS LAT/LON (full best-track); agency fallback',
  years: years.map((y) => y.year),
  yearMeta: years,
  built: new Date().toISOString()
};
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
const total = years.reduce((a, b) => a + b.bytes, 0);
console.log('DONE years', years.length, 'totalMB', (total / 1e6).toFixed(2));
