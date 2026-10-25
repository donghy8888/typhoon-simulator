import fs from 'fs';
import vm from 'vm';
const root = '/workspace/typhoon-simulator';
const sandbox = { console, Math };
sandbox.globalThis = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['js/geo.js', 'js/physics.js']) {
  vm.runInContext(fs.readFileSync(`${root}/${f}`, 'utf8'), sandbox, { filename: f });
}
const G = sandbox.TyGeo, P = sandbox.TyPhysics;
const cfg = { steerU: -3, steerV: 1.5, westerlyU: 8, betaStrength: 1 };
const fugen = G.defaultFugen(), sst = G.defaultSstRegions();
const band = G.APPROACH_NORTH_BAND_DEG;
const m = {
  lon: 140, lat: 20, vmax: 40, alive: true,
  track: [{ lon: 140, lat: 20, vmax: 40, t: 0 }],
  phase: 'x', sst: null, u: 0, v: 0,
  arcLat0: null, arcLon0: null, legTargetLat: null, clearLon0: null, clearLat0: null, sAcc: 0,
  cfgPerturb: { ...cfg }
};
const samples = [];
for (let i = 0; i < 500 && m.alive; i++) {
  P.stepMember(m, 1.0, cfg, fugen, sst, null);
  const edge = G.guidingNorthernEdgeLat(m.lon, fugen, null);
  const northOf = edge == null ? null : m.lat - edge;
  const hdg = Math.atan2(m.v, m.u) * 180 / Math.PI; // 90=N, 45=NE, 0=E
  const fromN = 90 - hdg; // geographic ° from north toward east
  samples.push({
    lon: +m.lon.toFixed(2), lat: +m.lat.toFixed(2),
    northOf: northOf == null ? null : +northOf.toFixed(3),
    sAcc: +(m.sAcc || 0).toFixed(2),
    hdg: +hdg.toFixed(0), fromN: +fromN.toFixed(0),
    u: +m.u.toFixed(2), v: +m.v.toFixed(2),
    inLeg: m.legTargetLat != null && m.lat < m.legTargetLat,
    legT: m.legTargetLat == null ? null : +m.legTargetLat.toFixed(2),
    clear: m.clearLon0 == null ? null : +m.clearLon0.toFixed(2)
  });
  if (m.lat > 42 || m.lon > 175) break;
}

// 仅取首次触及黄线之前的南侧段，避免越绿后 edge 跳动把后期点误算进黄南
let firstYellowHit = samples.findIndex(s => s.northOf != null && s.northOf >= -band);
if (firstYellowHit < 0) firstYellowHit = samples.length;
const southYellow = samples.slice(0, firstYellowHit).filter(s =>
  s.northOf != null && s.northOf < -band - 0.05 && s.northOf > -4);
const yellowGreen = samples.filter(s =>
  s.inLeg || (s.northOf != null && s.northOf >= -band - 0.02 && s.northOf < 0.05 && s.clear == null && s.sAcc < 0.05)
);
const nearGreen = samples.filter(s => s.northOf != null && s.northOf >= -0.2 && s.northOf <= 0.15);
const postGreen = samples.filter(s => s.clear != null && s.sAcc >= 0.15);
const clearIdx = samples.findIndex(s => s.clear != null);
const endArc = [...samples].reverse().find(s => s.sAcc > 0) || samples[samples.length - 1];
const a0 = clearIdx >= 0 ? samples[clearIdx] : samples.find(s => s.sAcc > 0);
const dlon = a0 && endArc ? endArc.lon - a0.lon : 0;
const dlat = a0 && endArc ? endArc.lat - a0.lat : 0;

let out = 'PROOF track start 20N 140E under main ridge — ?v=20261026b\n';
out += 'FIX: yellow@edge-0.15; mild WNW south; Y→G due-N; post-G NE tiny-E; small Δlon~3–7.\n';
out += `CONST: POST_GREEN=${P.POST_GREEN_ARC_DEG} TARGET_DLON=${P.TARGET_ARC_DLON_DEG} BOW=${P.ARC_BOW_LON_DEG} NORTH_LEG=${P.NORTH_LEG_DEG} NE_TARGET_deg=${(P.NE_TARGET_HDG*180/Math.PI).toFixed(0)}\n\n`;
out += 'lon\tlat\tnorthOf\tsAcc\thdg\tfromN\tu\n';

const seen = new Set();
function add(s) {
  const k = `${s.lon},${s.lat},${s.sAcc}`;
  if (seen.has(k)) return;
  seen.add(k);
  out += `${s.lon}\t${s.lat}\t${s.northOf}\t${s.sAcc}\t${s.hdg}\t${s.fromN}\t${s.u}\n`;
}
for (let i = 0; i < samples.length; i++) {
  const s = samples[i];
  if (s.northOf != null && s.northOf > -4 && s.northOf < -band - 0.05 && i % 5 === 0) add(s);
}
for (const s of nearGreen) add(s);
for (const s of yellowGreen) add(s);
if (clearIdx >= 0) {
  for (let i = clearIdx; i < samples.length; i++) {
    if (samples[i].sAcc <= 1.05 || i % 2 === 0) add(samples[i]);
  }
}

out += '\n--- SOUTH OF YELLOW (want WNW-ish: u<0, fromN~300–340 or hdg~110–160) ---\n';
const sy = southYellow.slice(-8);
for (const s of sy) out += `${s.lon},${s.lat} northOf=${s.northOf} hdg=${s.hdg} fromN=${s.fromN} u=${s.u} v=${s.v}\n`;
const syDeep = sy.filter(s => s.northOf < -0.4 && !s.inLeg);
const syOk = syDeep.length && syDeep.every(s => s.u <= 0.15 && s.u >= -3.6 && s.hdg >= 100 && s.hdg <= 145);

out += '\n--- YELLOW→GREEN / N-leg (want hdg≈90, u≈0) ---\n';
for (const s of yellowGreen.slice(0, 12)) {
  out += `${s.lon},${s.lat} northOf=${s.northOf} hdg=${s.hdg} u=${s.u} inLeg=${s.inLeg}\n`;
}
const ygOk = yellowGreen.length >= 2 && yellowGreen.every(s => Math.abs(s.u) < 0.5 && s.hdg >= 75);

out += '\n--- POST-GREEN (want fromN≈40–55 NE slight E; NOT deep ENE fromN>60 / hdg<30) ---\n';
const pg = postGreen.filter((_, i) => i % 2 === 0).slice(0, 16);
for (const s of pg) out += `${s.lon},${s.lat} s=${s.sAcc} hdg=${s.hdg} fromN=${s.fromN} u=${s.u} v=${s.v}\n`;
const mid = postGreen.filter(s => s.sAcc >= 0.25 && s.sAcc <= 0.95);
const avgFromN = mid.length ? mid.reduce((a, s) => a + s.fromN, 0) / mid.length : null;
const pgOk = mid.length && mid.every(s => s.fromN >= 32 && s.fromN <= 58) && avgFromN != null && avgFromN >= 38 && avgFromN <= 52;

out += `\nNORTH LEG pts: ${yellowGreen.length}\n`;
if (yellowGreen.length) {
  const a = yellowGreen[0], b = yellowGreen[yellowGreen.length - 1];
  out += `  ${a.lon},${a.lat} → ${b.lon},${b.lat} Δlat=${(b.lat-a.lat).toFixed(2)} Δlon=${(b.lon-a.lon).toFixed(2)}\n`;
}
out += `\nPost-green arc Δlon: ${dlon.toFixed(1)} Δlat: ${dlat.toFixed(1)} (want ≈3–7 small)\n`;
if (a0 && endArc) {
  out += `  start: ${a0.lon},${a0.lat} hdg=${a0.hdg} fromN=${a0.fromN} s=${a0.sAcc}\n`;
  out += `  end:   ${endArc.lon},${endArc.lat} hdg=${endArc.hdg} fromN=${endArc.fromN} s=${endArc.sAcc}\n`;
}
out += `  avg fromN (mid-arc): ${avgFromN == null ? 'n/a' : avgFromN.toFixed(1)}\n`;
out += `  max sAcc=${Math.max(...samples.map(s => s.sAcc))}\n`;

const dlonOk = dlon >= 2.5 && dlon <= 8;
out += `\nCHECKS: southWNW=${syOk} yellowGreenN=${ygOk} postNe=${pgOk} dlonMed=${dlonOk} (Δlon=${dlon.toFixed(1)})\n`;
out += `PASS=${syOk && ygOk && pgOk && dlonOk}\n`;

const all = samples.filter(s => s.lat >= 24);
if (all.length) {
  const lon0 = Math.min(...all.map(s => s.lon)), lon1 = Math.max(...all.map(s => s.lon));
  const lat0 = Math.min(...all.map(s => s.lat)), lat1 = Math.max(...all.map(s => s.lat));
  const W = 60, H = 24;
  const grid = Array.from({ length: H }, () => Array(W).fill(' '));
  for (const s of all) {
    const x = Math.round((s.lon - lon0) / Math.max(1e-6, lon1 - lon0) * (W - 1));
    const y = Math.round((1 - (s.lat - lat0) / Math.max(1e-6, lat1 - lat0)) * (H - 1));
    let ch = '*';
    if (s.inLeg || (s.northOf != null && s.northOf >= -band && s.northOf < 0.05 && s.sAcc < 0.05)) ch = '|';
    else if (s.sAcc > 0 && s.sAcc < 1) ch = 'o';
    else if (s.sAcc >= 1) ch = '#';
    if (y >= 0 && y < H && x >= 0 && x < W) grid[y][x] = ch;
  }
  out += `\nASCII (|=N-leg o=post-green NE arc #=settled)\nlon ${lon0.toFixed(1)} -> ${lon1.toFixed(1)}   lat ${lat0.toFixed(1)} -> ${lat1.toFixed(1)}\n`;
  out += grid.map(r => r.join('')).join('\n') + '\n';
}
fs.writeFileSync(`${root}/track-proof-20261026b.txt`, out);
console.log(out);
