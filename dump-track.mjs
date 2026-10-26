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
    vmax: +m.vmax.toFixed(1),
    phase: m.phase,
    land: !!G.isLand(m.lon, m.lat),
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
const arcDone = samples.find(s => s.sAcc >= 1) || endArc;
const dlon = a0 && endArc ? endArc.lon - a0.lon : 0;
const dlat = a0 && endArc ? endArc.lat - a0.lat : 0;
const dlonArc = a0 && arcDone ? arcDone.lon - a0.lon : 0;
const dlatArc = a0 && arcDone ? arcDone.lat - a0.lat : 0;

let out = 'PROOF track start 20N 140E under main ridge — ?v=20261026f\n';
out += 'FIX: yellow@edge-0.15; clear WNW south; Y→G due-N; post-G NE slight-E smooth semicircle; life Δlon≈12–14 (>26e~10, not ~20); sea slower.\n';
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

out += '\n--- SOUTH OF YELLOW (want clear WNW: |u|>v, hdg~140–160 / fromN≈−50~−70) ---\n';
const sy = southYellow.slice(-8);
for (const s of sy) out += `${s.lon},${s.lat} northOf=${s.northOf} hdg=${s.hdg} fromN=${s.fromN} u=${s.u} v=${s.v}\n`;
const syDeep = sy.filter(s => s.northOf < -0.4 && !s.inLeg);
const syOk = syDeep.length && syDeep.every(s => s.u <= -3.8 && s.u >= -7.5 && s.hdg >= 135 && s.hdg <= 165 && Math.abs(s.u) >= s.v * 0.95);

out += '\n--- YELLOW→GREEN / N-leg (want hdg≈90, u≈0) ---\n';
for (const s of yellowGreen.slice(0, 12)) {
  out += `${s.lon},${s.lat} northOf=${s.northOf} hdg=${s.hdg} u=${s.u} inLeg=${s.inLeg}\n`;
}
const ygOk = yellowGreen.length >= 2 && yellowGreen.every(s => Math.abs(s.u) < 0.5 && s.hdg >= 75);

out += '\n--- POST-GREEN (want fromN≈40–55 NE slight E; NOT deep ENE fromN>60 / hdg<30) ---\n';
const pg = postGreen.filter((_, i) => i % 2 === 0).slice(0, 16);
for (const s of pg) out += `${s.lon},${s.lat} s=${s.sAcc} hdg=${s.hdg} fromN=${s.fromN} u=${s.u} v=${s.v}\n`;
const mid = postGreen.filter(s => s.sAcc >= 0.25 && s.sAcc <= 0.95);
const late = postGreen.filter(s => s.sAcc >= 0.7 && s.sAcc <= 1.01);
const avgFromN = mid.length ? mid.reduce((a, s) => a + s.fromN, 0) / mid.length : null;
// 半圆：中段 fromN 可从偏北渐入；收束段须 NE slight-E（~40–55），全程勿深 ENE
const pgOk = mid.length && mid.every(s => s.fromN >= 8 && s.fromN <= 58)
  && late.length && late.every(s => s.fromN >= 36 && s.fromN <= 56)
  && avgFromN != null && avgFromN >= 28 && avgFromN <= 52;

out += `\nNORTH LEG pts: ${yellowGreen.length}\n`;
if (yellowGreen.length) {
  const a = yellowGreen[0], b = yellowGreen[yellowGreen.length - 1];
  out += `  ${a.lon},${a.lat} → ${b.lon},${b.lat} Δlat=${(b.lat-a.lat).toFixed(2)} Δlon=${(b.lon-a.lon).toFixed(2)}\n`;
}
out += `\nPost-green turn Δlon (to sAcc≥1): ${dlonArc.toFixed(1)} Δlat: ${dlatArc.toFixed(1)}\n`;
out += `Post-green life Δlon (to end): ${dlon.toFixed(1)} Δlat: ${dlat.toFixed(1)} (want ≈12–14 slightly > prior ~10; not old ~20)\n`;
if (a0 && arcDone) {
  out += `  clear: ${a0.lon},${a0.lat} hdg=${a0.hdg} fromN=${a0.fromN} s=${a0.sAcc}\n`;
  out += `  arc1:  ${arcDone.lon},${arcDone.lat} hdg=${arcDone.hdg} fromN=${arcDone.fromN} s=${arcDone.sAcc}\n`;
}
if (a0 && endArc) {
  out += `  end:   ${endArc.lon},${endArc.lat} hdg=${endArc.hdg} fromN=${endArc.fromN} s=${endArc.sAcc} vmax=${endArc.vmax}\n`;
}
out += `  avg fromN (mid-arc): ${avgFromN == null ? 'n/a' : avgFromN.toFixed(1)}\n`;
out += `  max sAcc=${Math.max(...samples.map(s => s.sAcc))}\n`;

// intensity: sea vs land mean |dV| proxies via vmax longevity
const seaPts = samples.filter(s => !s.land && s.lat >= 20 && s.lat <= 36);
const landPts = samples.filter(s => s.land);
const vmaxAtClear = a0 ? a0.vmax : null;
const vmaxAtArc1 = arcDone ? arcDone.vmax : null;
const vmaxAtEnd = endArc ? endArc.vmax : null;
const hoursAlive = samples.length;
out += `\n--- INTENSITY (want sea weaken slower; land near prior) ---\n`;
out += `hoursAlive=${hoursAlive} vmax@start=${samples[0]?.vmax} @clear=${vmaxAtClear} @arc1=${vmaxAtArc1} @end=${vmaxAtEnd}\n`;
if (seaPts.length >= 4) {
  const a = seaPts[0], b = seaPts[Math.floor(seaPts.length * 0.5)], c = seaPts[seaPts.length - 1];
  out += `sea vmax: ${a.vmax}(${a.lat}N) → ${b.vmax}(${b.lat}N) → ${c.vmax}(${c.lat}N) phase_end_sea=${c.phase}\n`;
}
if (landPts.length) {
  out += `land hits=${landPts.length} first vmax=${landPts[0].vmax}@${landPts[0].lat}N last=${landPts[landPts.length-1].vmax}\n`;
}
// Spot-check tendency at open ocean vs land
const tendSeaCold = P.intensityTendency(145, 32, 40, 24);
const tendSeaWarm = P.intensityTendency(140, 22, 40, 29);
const tendLand = P.intensityTendency(121, 31, 40, 26);
out += `dV spot: seaWarm28N? ${tendSeaWarm.dV.toFixed(2)} (${tendSeaWarm.phase}); seaCold32N ${tendSeaCold.dV.toFixed(2)} (${tendSeaCold.phase}); land ${tendLand.dV.toFixed(2)} (${tendLand.phase})\n`;
out += `  expect: |seaCold dV| << |land dV|; seaCold milder than pre-26e (~-2.2 at 40ms/24SST)\n`;

const dlonOk = dlon >= 11.0 && dlon <= 15.5; // slightly larger than prior ~10; not old ~20
const seaSlowOk = tendSeaCold.dV > -1.35 && tendLand.dV < -2.5; // sea milder vs old~-2.2; land still strong
// smoothness: consecutive fromN steps during arc stay gentle — semicircle, no tip kink
const arcSamples = samples.filter(s => s.clear != null && s.sAcc > 0 && s.sAcc <= 1.01);
let maxDFromN = 0;
for (let i = 1; i < arcSamples.length; i++) {
  const df = Math.abs(arcSamples[i].fromN - arcSamples[i - 1].fromN);
  if (df > maxDFromN) maxDFromN = df;
}
const early = arcSamples.filter(s => s.sAcc <= 0.3);
let earlyJump = 0;
for (let i = 1; i < early.length; i++) {
  earlyJump = Math.max(earlyJump, Math.abs(early[i].fromN - early[i - 1].fromN));
}
const smoothOk = maxDFromN <= 16 && earlyJump <= 12;
out += `SMOOTH: max|ΔfromN|step=${maxDFromN} earlyJump=${earlyJump} (want continuous semicircle, no tip kink)\n`;
out += `\nCHECKS: southWNW=${syOk} yellowGreenN=${ygOk} postNe=${pgOk} dlonBump=${dlonOk} (lifeΔlon=${dlon.toFixed(1)} arc=${dlonArc.toFixed(1)}) seaSlow=${seaSlowOk} smooth=${smoothOk}\n`;
out += `PASS=${syOk && ygOk && pgOk && dlonOk && seaSlowOk && smoothOk}\n`;

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
fs.writeFileSync(`${root}/track-proof-20261026f.txt`, out);
console.log(out);
