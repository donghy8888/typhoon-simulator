/**
 * 台风纪录（IBTrACS 西北太平洋 1949–2026）— 按年按需加载
 */
(function (global) {
  'use strict';

  const YEAR_MIN = 1949;
  const YEAR_MAX = 2026;
  const DATA_BASE = 'data/ibtracs/wp';
  const DATA_VER = '20261031j';

  const cache = Object.create(null); // year -> payload
  let indexPromise = null;

  function fetchJson(url) {
    return fetch(url, { cache: 'force-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return r.json();
    });
  }

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetchJson(DATA_BASE + '/index.json').catch(function (e) {
        indexPromise = null;
        throw e;
      });
    }
    return indexPromise;
  }

  function loadYear(year) {
    const y = year | 0;
    if (cache[y]) return Promise.resolve(cache[y]);
    return fetchJson(DATA_BASE + '/' + y + '.json?v=' + DATA_VER).then(function (data) {
      cache[y] = data;
      return data;
    });
  }

  function yearsList() {
    const ys = [];
    for (let y = YEAR_MAX; y >= YEAR_MIN; y--) ys.push(y);
    return ys;
  }

  function chineseName(storm) {
    const NZ = global.TyNamesZh;
    if (!storm) return null;
    if (storm.nameZh) return storm.nameZh;
    if (NZ && typeof NZ.chineseName === 'function') return NZ.chineseName(storm.name);
    return null;
  }

  function stormLabel(storm, withZh) {
    const en = (storm && storm.name) ? storm.name : 'UNNAMED';
    if (withZh === false) return en;
    const zh = chineseName(storm);
    return zh ? (zh + ' (' + en + ')') : en;
  }

  /** Substring match on Chinese (partial) and English (case-insensitive). */
  function stormMatchesQuery(storm, query) {
    const q = (query || '').trim();
    if (!q) return true;
    const en = ((storm && storm.name) || '').toLowerCase();
    const zh = chineseName(storm) || '';
    const ql = q.toLowerCase();
    if (zh && zh.indexOf(q) !== -1) return true;
    if (en && en.indexOf(ql) !== -1) return true;
    // also match latin parts inside query against english
    if (/[a-z]/i.test(q) && en && en.indexOf(ql) !== -1) return true;
    return false;
  }

  let nameIndexPromise = null;
  function loadNameIndex() {
    if (!nameIndexPromise) {
      nameIndexPromise = fetchJson(DATA_BASE + '/name-index.json?v=' + DATA_VER).catch(function (e) {
        nameIndexPromise = null;
        throw e;
      });
    }
    return nameIndexPromise;
  }

  /** Find cross-year matches by Chinese/English substring. */
  function searchNameIndex(query) {
    const q = (query || '').trim();
    if (!q) return Promise.resolve([]);
    return loadNameIndex().then(function (idx) {
      const ql = q.toLowerCase();
      const out = [];
      (idx.storms || []).forEach(function (s) {
        const zh = s.zh || '';
        const en = (s.n || '').toLowerCase();
        if ((zh && zh.indexOf(q) !== -1) || (en && en.indexOf(ql) !== -1)) {
          out.push(s);
        }
      });
      // newest first
      out.sort(function (a, b) { return (b.y - a.y) || String(a.n).localeCompare(String(b.n)); });
      return out;
    });
  }

  // —— 登陆地索引（离线预计算：海→陆穿越 + 国家/省份表）——
  let landfallIndexPromise = null;
  let landfallIndexCache = null;

  /** Curated chip order for weather-office UI (others still filterable if present). */
  const PLACE_COUNTRY_ORDER = ['中国', '菲律宾', '日本', '越南', '韩国', '朝鲜', '泰国', '马来西亚', '俄罗斯'];
  const PLACE_PROVINCE_ORDER = ['广东', '福建', '浙江', '台湾', '海南', '广西', '江苏', '上海', '山东', '辽宁', '河北'];

  function loadLandfallIndex() {
    if (landfallIndexCache) return Promise.resolve(landfallIndexCache);
    if (!landfallIndexPromise) {
      landfallIndexPromise = fetchJson(DATA_BASE + '/landfall-index.json?v=' + DATA_VER).then(function (idx) {
        landfallIndexCache = idx || { places: [], storms: {} };
        return landfallIndexCache;
      }).catch(function (e) {
        landfallIndexPromise = null;
        throw e;
      });
    }
    return landfallIndexPromise;
  }

  function placesForStorm(stormOrId, idx) {
    if (!idx || !idx.storms) return [];
    const id = typeof stormOrId === 'string' ? stormOrId : (stormOrId && stormOrId.id);
    if (!id) return [];
    return idx.storms[id] || [];
  }

  function stormMatchesPlaces(storm, placeIds, idx) {
    const want = placeIds || [];
    if (!want.length) return true;
    const have = placesForStorm(storm, idx);
    if (!have.length) return false;
    for (let i = 0; i < want.length; i++) {
      if (have.indexOf(want[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Filter by Chinese/English name query and/or landfall place ids (OR within places).
   * Empty query + empty places → all.
   */
  function filterStorms(storms, query, placeIds, landfallIdx) {
    const list = storms || [];
    const q = (query || '').trim();
    const places = placeIds || [];
    if (!q && !places.length) return list.slice();
    return list.filter(function (s) {
      if (q && !stormMatchesQuery(s, q)) return false;
      if (places.length && !stormMatchesPlaces(s, places, landfallIdx)) return false;
      return true;
    });
  }

  function placeCatalog(idx) {
    const all = (idx && idx.places) || [];
    function ordered(kind, order) {
      const byId = Object.create(null);
      all.forEach(function (p) {
        if (p && p.kind === kind) byId[p.id] = p;
      });
      const out = [];
      order.forEach(function (id) {
        if (byId[id]) { out.push(byId[id]); delete byId[id]; }
      });
      Object.keys(byId).sort(function (a, b) { return a.localeCompare(b, 'zh'); })
        .forEach(function (id) { out.push(byId[id]); });
      return out;
    }
    return {
      countries: ordered('country', PLACE_COUNTRY_ORDER),
      provinces: ordered('province', PLACE_PROVINCE_ORDER)
    };
  }


  /** Zoomed-out: sparse ~6h marks; zoomed-in: dense ~2h marks. */
  const HIST_MARK_DT_H_SPARSE = 6;
  const HIST_MARK_DT_H_DENSE = 2;
  /** Leaflet zoom at/above which dense (2h) marks are used (overview / no selection). */
  const HIST_MARK_ZOOM_DENSE = 5;

  /**
   * Cadence for intensity marks.
   * @param {number} zoom Leaflet zoom
   * @param {boolean} [selected] when true (inspecting one storm), always dense 2h —
   *   fitStorm for long WP tracks often lands at zoom 3–5 and never hit the old ≥6 gate.
   */
  function markDtHoursForZoom(zoom, selected) {
    if (selected) return HIST_MARK_DT_H_DENSE;
    const z = zoom == null ? NaN : +zoom;
    if (isFinite(z) && z >= HIST_MARK_ZOOM_DENSE) return HIST_MARK_DT_H_DENSE;
    return HIST_MARK_DT_H_SPARSE;
  }

  function parsePointTimeMs(t) {
    if (t == null) return null;
    if (typeof t === 'number' && isFinite(t)) {
      // hours-from-epoch style is unused; treat large values as ms, small as hours
      return t > 1e11 ? t : t * 3600 * 1000;
    }
    if (typeof t === 'string') {
      const s = t.trim();
      // "YYYY-MM-DD HH:MM:SS" → UTC
      const iso = s.indexOf('T') >= 0 ? s : s.replace(' ', 'T');
      const ms = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
      return isFinite(ms) ? ms : null;
    }
    return null;
  }

  /**
   * Format UTC ms as "YYYY-MM-DD HH:MM:SS" (same shape as IBTrACS year JSON).
   */
  function formatPointTimeUtc(ms) {
    const d = new Date(ms);
    if (!isFinite(d.getTime())) return null;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  /**
   * Dense marks: place points on a true dtHours timeline along the track by
   * linear time-interpolation of lon/lat/vmax between adjacent timed IBTrACS
   * fixes. Does not invent storms — only densifies between real fixes.
   * Falls back to every real fix when fewer than 2 timed points exist.
   */
  function densifyMarksAlongTrack(pts, dtHours) {
    const out = [];
    if (!pts || !pts.length) return out;
    const timed = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const ms = parsePointTimeMs(p && p.t);
      if (ms == null) continue;
      if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
      timed.push({ p: p, ms: ms });
    }
    if (timed.length < 2) {
      // No usable timeline — keep real fixes (dense fallback = every point).
      for (let i = 0; i < pts.length; i++) out.push(pts[i]);
      return out;
    }
    const stepMs = dtHours * 3600 * 1000;
    if (!(stepMs > 0)) return out;
    const t0 = timed[0].ms;
    const tEnd = timed[timed.length - 1].ms;
    let seg = 0;
    // Inclusive end within 1ms so an exact last-fix grid hit is kept.
    for (let t = t0; t <= tEnd + 1; t += stepMs) {
      while (seg < timed.length - 2 && timed[seg + 1].ms < t) seg++;
      const a = timed[seg];
      const b = timed[seg + 1];
      const span = b.ms - a.ms;
      let lon, lat, vmax;
      if (span <= 0 || t <= a.ms) {
        lon = a.p.lon; lat = a.p.lat; vmax = a.p.vmax;
      } else if (t >= b.ms) {
        lon = b.p.lon; lat = b.p.lat; vmax = b.p.vmax;
      } else {
        const f = (t - a.ms) / span;
        lon = a.p.lon + f * (b.p.lon - a.p.lon);
        lat = a.p.lat + f * (b.p.lat - a.p.lat);
        const va = a.p.vmax == null ? null : +a.p.vmax;
        const vb = b.p.vmax == null ? null : +b.p.vmax;
        vmax = (va == null || vb == null || !isFinite(va) || !isFinite(vb))
          ? (isFinite(va) ? va : (isFinite(vb) ? vb : null))
          : va + f * (vb - va);
      }
      out.push({
        lon: lon,
        lat: lat,
        vmax: vmax,
        t: formatPointTimeUtc(t),
        _interp: !(t === a.ms || t === b.ms)
      });
    }
    return out;
  }

  /**
   * Sparse (zoom<6, ~6h): keep first fix, then next real fixes only when
   * ≥ dtHours since last kept mark. Fallback if times missing: every other
   * point (~6h from ~3h IBTrACS).
   * Dense (selected OR zoom>=5, 2h): true 2-hour timeline via densifyMarksAlongTrack.
   */
  function selectIntensityMarkPoints(pts, dtHours) {
    dtHours = dtHours == null ? HIST_MARK_DT_H_SPARSE : dtHours;
    const out = [];
    if (!pts || !pts.length) return out;

    // Dense cadence: interpolate on a true dtHours clock (IBTrACS is ~3-hourly).
    if (dtHours <= HIST_MARK_DT_H_DENSE) {
      return densifyMarksAlongTrack(pts, dtHours);
    }

    let lastMs = null;
    let lastIdx = -1;
    const minMs = dtHours * 3600 * 1000 - 1;
    const idxStep = 2; // sparse fallback for ~3h fixes → ~6h
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const ms = parsePointTimeMs(p && p.t);
      if (ms == null) {
        if (lastIdx < 0 || i - lastIdx >= idxStep) {
          out.push(p);
          lastIdx = i;
        }
        continue;
      }
      if (lastMs == null || (ms - lastMs) >= minMs) {
        out.push(p);
        lastMs = ms;
        lastIdx = i;
      }
    }
    return out;
  }

  /**
   * Draw storms for a year onto layerGroup.
   * @param {object} opts { scale, selectedId, onSelect, hideOthers }
   *   hideOthers (default true): when a storm is selected, omit other tracks.
   *   onSelect(id): click handler; pass same id again from app to toggle off.
   */
  function drawYear(layerGroup, data, opts) {
    opts = opts || {};
    const G = global.TyGeo;
    const scale = opts.scale || (G && G.INTENSITY_SCALE_CMA) || 'cma';
    const selectedId = opts.selectedId || null;
    const hideOthers = opts.hideOthers !== false;
    layerGroup.clearLayers();
    if (!data || !data.storms) return;

    const filterQuery = opts.filterQuery || '';
    const filterPlaces = opts.filterPlaces || [];
    const landfallIdx = opts.landfallIndex || landfallIndexCache;
    const storms = (filterQuery || (filterPlaces && filterPlaces.length))
      ? filterStorms(data.storms, filterQuery, filterPlaces, landfallIdx)
      : data.storms;

    storms.forEach(function (storm) {
      const pts = storm.points || [];
      if (pts.length < 2) return;
      const selected = !!(selectedId && storm.id === selectedId);
      const dimmed = !!(selectedId && !selected);

      if (dimmed && hideOthers) return; // 选中时只画该台

      const latlngs = pts.map(function (p) { return [p.lat, p.lon]; });
      const line = L.polyline(latlngs, {
        color: selected ? '#0b3d5c' : '#5d6d7e',
        weight: selected ? 4 : 1.7,
        opacity: selected ? 0.98 : (dimmed ? 0.18 : 0.55),
        interactive: true
      });
      const tip =
        stormLabel(storm) + ' · ' + storm.season +
        (storm.maxVmax != null ? (' · 峰值 ' + storm.maxVmax.toFixed(0) + ' m/s') : '');
      line.bindTooltip(tip, { sticky: true, opacity: 0.92 });
      if (typeof opts.onSelect === 'function') {
        line.on('click', function (e) {
          if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
          opts.onSelect(storm.id);
        });
      }
      line.addTo(layerGroup);

      // Intensity dots — zoom-aware cadence (sparse ~6h / dense ~2h); polyline uses every fix.
      const markDt = opts.markDtHours != null
        ? opts.markDtHours
        : markDtHoursForZoom(opts.zoom);
      const markPts = selectIntensityMarkPoints(pts, markDt);
      for (let i = 0; i < markPts.length; i++) {
        const p = markPts[i];
        const hex = G.intensityTrackColor(p.vmax, scale);
        const r = selected ? 5 : 3.2;
        const c = L.circleMarker([p.lat, p.lon], {
          radius: r,
          color: selected ? '#0b3d5c' : '#222',
          weight: selected ? 1.2 : 0.6,
          fillColor: hex,
          fillOpacity: selected ? 0.98 : 0.75,
          opacity: selected ? 0.95 : 0.55,
          interactive: true
        });
        if (typeof opts.onSelect === 'function') {
          c.on('click', function (e) {
            if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
            opts.onSelect(storm.id);
          });
        }
        c.addTo(layerGroup);
      }

      if (selected) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        L.circleMarker([a.lat, a.lon], {
          radius: 7, color: '#145a32', weight: 2, fillColor: '#82e0aa', fillOpacity: 0.95, interactive: false
        }).bindTooltip('起点', { direction: 'top' }).addTo(layerGroup);
        L.circleMarker([b.lat, b.lon], {
          radius: 7, color: '#7b241c', weight: 2, fillColor: '#f5b7b1', fillOpacity: 0.95, interactive: false
        }).bindTooltip('终点', { direction: 'top' }).addTo(layerGroup);

        // Name badge near peak / mid track
        let peak = pts[0];
        for (let i = 1; i < pts.length; i++) {
          if ((pts[i].vmax || 0) > (peak.vmax || 0)) peak = pts[i];
        }
        const nameHtml =
          '<div class="hist-name-badge">' +
          '<strong>' + stormLabel(storm) + '</strong>' +
          (storm.maxVmax != null ? ('<span>' + storm.maxVmax.toFixed(0) + ' m/s</span>') : '') +
          '</div>';
        L.marker([peak.lat, peak.lon], {
          interactive: false,
          keyboard: false,
          zIndexOffset: 400,
          icon: L.divIcon({
            className: 'hist-name-icon',
            html: nameHtml,
            iconSize: [150, 40],
            iconAnchor: [75, 42]
          })
        }).addTo(layerGroup);
      }
    });
  }

  function clear(layerGroup) {
    if (layerGroup) layerGroup.clearLayers();
  }

  function fitStorm(map, storm) {
    if (!map || !storm || !storm.points || storm.points.length < 2) return;
    const bounds = L.latLngBounds(storm.points.map(function (p) { return [p.lat, p.lon]; }));
    try { map.fitBounds(bounds.pad(0.2), { maxZoom: 7, animate: true }); } catch (e) { /* ignore */ }
  }

  // —— 相似度（压缩索引 similarity-index.json）——
  let simIndexPromise = null;
  function loadSimilarityIndex() {
    if (!simIndexPromise) {
      simIndexPromise = fetchJson(DATA_BASE + '/similarity-index.json?v=' + DATA_VER).catch(function (e) {
        simIndexPromise = null;
        throw e;
      });
    }
    return simIndexPromise;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toR) * Math.cos(lat2 * toR) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Resample track [{lat,lon},...] to N points along cumulative distance. */
  function resampleTrack(points, n) {
    n = n || 16;
    const pts = (points || []).filter(function (p) {
      return p && isFinite(+p.lat) && isFinite(+p.lon);
    });
    if (!pts.length) return null;
    if (pts.length === 1) {
      const out = [];
      for (let i = 0; i < n; i++) out.push([+pts[0].lat, +pts[0].lon]);
      return out;
    }
    const dists = [0];
    for (let i = 1; i < pts.length; i++) {
      dists.push(dists[i - 1] + haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
    }
    const total = dists[dists.length - 1];
    const out = [];
    if (total < 1) {
      for (let i = 0; i < n; i++) out.push([+pts[0].lat, +pts[0].lon]);
      return out;
    }
    for (let k = 0; k < n; k++) {
      const target = total * k / (n - 1);
      let j = 0;
      while (j < dists.length - 1 && dists[j + 1] < target) j++;
      if (j >= pts.length - 1) {
        out.push([+pts[pts.length - 1].lat, +pts[pts.length - 1].lon]);
      } else {
        const seg = dists[j + 1] - dists[j];
        const f = seg < 1e-9 ? 0 : (target - dists[j]) / seg;
        out.push([
          pts[j].lat * (1 - f) + pts[j + 1].lat * f,
          pts[j].lon * (1 - f) + pts[j + 1].lon * f
        ]);
      }
    }
    return out;
  }

  function peakVmaxFromTrack(points) {
    let m = 0;
    (points || []).forEach(function (p) {
      const v = +p.vmax;
      if (isFinite(v) && v > m) m = v;
    });
    return m;
  }

  /**
   * Score: lower = more similar.
   * mean track distance (km)/500 + |Δvmax|/40 + month-window penalty.
   */
  function scorePair(simPts, simVmax, hist, preferMonth) {
    const hp = hist.p;
    if (!simPts || !hp || simPts.length !== hp.length) return 1e9;
    let sum = 0;
    for (let i = 0; i < simPts.length; i++) {
      sum += haversineKm(simPts[i][0], simPts[i][1], hp[i][0], hp[i][1]);
    }
    const meanKm = sum / simPts.length;
    const trackTerm = meanKm / 500;
    const vmaxTerm = Math.abs((simVmax || 0) - (hist.v || 0)) / 40;
    let monthPen = 0;
    if (preferMonth != null && hist.m != null) {
      let dm = Math.abs(preferMonth - hist.m);
      if (dm > 6) dm = 12 - dm;
      if (dm >= 2) monthPen = 0.15 * (dm - 1);
    }
    const unnamed = (!hist.n || hist.n === 'UNNAMED' || hist.n === 'NOT_NAMED') ? 0.08 : 0;
    return trackTerm + vmaxTerm + monthPen + unnamed;
  }

  /**
   * Find best historical match for a simulated track.
   * @returns Promise<match|null>
   */
  function findBestMatch(trackPoints, opts) {
    opts = opts || {};
    const preferMonth = opts.month != null ? (opts.month | 0) : null;
    const simVmax = opts.maxVmax != null ? +opts.maxVmax : peakVmaxFromTrack(trackPoints);
    return loadSimilarityIndex().then(function (idx) {
      const nPts = (idx && idx.pts) || 16;
      const simPts = resampleTrack(trackPoints, nPts);
      if (!simPts) return null;
      let best = null;
      let bestScore = 1e9;
      const storms = (idx && idx.storms) || [];
      for (let i = 0; i < storms.length; i++) {
        const h = storms[i];
        if (!h.p || h.p.length !== nPts) continue;
        if ((h.v || 0) < 17) continue;
        const sc = scorePair(simPts, simVmax, h, preferMonth);
        if (sc < bestScore) {
          bestScore = sc;
          best = h;
        }
      }
      if (!best) return null;
      const zh = chineseName({ name: best.n });
      const labelCore = zh ? (best.y + ' ' + zh) : (best.y + ' ' + (best.n || 'UNNAMED'));
      return {
        id: best.id,
        name: best.n,
        year: best.y,
        month: best.m,
        maxVmax: best.v,
        durationH: best.d,
        fingerprint: best.p,
        score: bestScore,
        zh: zh,
        label: labelCore,
        labelText: '最像：' + labelCore
      };
    });
  }

  /** Draw a faint overlay of fingerprint / storm track onto layerGroup. */
  function drawMatchOverlay(layerGroup, fingerprintOrStorm, opts) {
    opts = opts || {};
    if (!layerGroup) return;
    layerGroup.clearLayers();
    let latlngs = null;
    if (fingerprintOrStorm && Array.isArray(fingerprintOrStorm) && fingerprintOrStorm.length &&
        Array.isArray(fingerprintOrStorm[0])) {
      latlngs = fingerprintOrStorm.map(function (p) { return [p[0], p[1]]; });
    } else if (fingerprintOrStorm && fingerprintOrStorm.points) {
      latlngs = fingerprintOrStorm.points.map(function (p) { return [p.lat, p.lon]; });
    } else if (fingerprintOrStorm && fingerprintOrStorm.p) {
      latlngs = fingerprintOrStorm.p.map(function (p) { return [p[0], p[1]]; });
    } else if (fingerprintOrStorm && fingerprintOrStorm.fingerprint) {
      latlngs = fingerprintOrStorm.fingerprint.map(function (p) { return [p[0], p[1]]; });
    }
    if (!latlngs || latlngs.length < 2) return;
    L.polyline(latlngs, {
      color: opts.color || '#5d6d7e',
      weight: opts.weight || 2.5,
      opacity: opts.opacity != null ? opts.opacity : 0.45,
      dashArray: opts.dashArray || '6 8',
      interactive: false
    }).addTo(layerGroup);
  }

  global.TyHistory = {
    YEAR_MIN: YEAR_MIN,
    YEAR_MAX: YEAR_MAX,
    HIST_MARK_DT_H_SPARSE: HIST_MARK_DT_H_SPARSE,
    HIST_MARK_DT_H_DENSE: HIST_MARK_DT_H_DENSE,
    HIST_MARK_ZOOM_DENSE: HIST_MARK_ZOOM_DENSE,
    markDtHoursForZoom: markDtHoursForZoom,
    selectIntensityMarkPoints: selectIntensityMarkPoints,
    densifyMarksAlongTrack: densifyMarksAlongTrack,
    yearsList: yearsList,
    loadIndex: loadIndex,
    loadYear: loadYear,
    loadNameIndex: loadNameIndex,
    searchNameIndex: searchNameIndex,
    drawYear: drawYear,
    clear: clear,
    fitStorm: fitStorm,
    stormLabel: stormLabel,
    chineseName: chineseName,
    stormMatchesQuery: stormMatchesQuery,
    filterStorms: filterStorms,
    loadLandfallIndex: loadLandfallIndex,
    placesForStorm: placesForStorm,
    stormMatchesPlaces: stormMatchesPlaces,
    placeCatalog: placeCatalog,
    loadSimilarityIndex: loadSimilarityIndex,
    resampleTrack: resampleTrack,
    findBestMatch: findBestMatch,
    drawMatchOverlay: drawMatchOverlay,
    peakVmaxFromTrack: peakVmaxFromTrack
  };
})(typeof window !== 'undefined' ? window : globalThis);
