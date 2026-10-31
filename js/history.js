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

      // Intensity dots — every best-track fix (no thinning; full path)
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
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
    try { map.fitBounds(bounds.pad(0.2), { maxZoom: 6, animate: true }); } catch (e) { /* ignore */ }
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
