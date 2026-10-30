/**
 * 台风纪录（IBTrACS 西北太平洋 1949–2026）— 按年按需加载
 */
(function (global) {
  'use strict';

  const YEAR_MIN = 1949;
  const YEAR_MAX = 2026;
  const DATA_BASE = 'data/ibtracs/wp';

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
    return fetchJson(DATA_BASE + '/' + y + '.json').then(function (data) {
      cache[y] = data;
      return data;
    });
  }

  function yearsList() {
    const ys = [];
    for (let y = YEAR_MAX; y >= YEAR_MIN; y--) ys.push(y);
    return ys;
  }

  /**
   * Draw all storms for a year onto layerGroup.
   * @param {object} opts { scale, selectedId, onSelect }
   */
  function drawYear(layerGroup, data, opts) {
    opts = opts || {};
    const G = global.TyGeo;
    const scale = opts.scale || (G && G.INTENSITY_SCALE_CMA) || 'cma';
    const selectedId = opts.selectedId || null;
    layerGroup.clearLayers();
    if (!data || !data.storms) return;

    data.storms.forEach(function (storm) {
      const pts = storm.points || [];
      if (pts.length < 2) return;
      const selected = selectedId && storm.id === selectedId;
      const latlngs = pts.map(function (p) { return [p.lat, p.lon]; });
      const line = L.polyline(latlngs, {
        color: selected ? '#1a5276' : '#5d6d7e',
        weight: selected ? 3.2 : 1.6,
        opacity: selected ? 0.95 : 0.55,
        interactive: true
      });
      line.bindTooltip(
        (storm.name || 'UNNAMED') + ' · ' + storm.season +
        (storm.maxVmax != null ? (' · 峰值 ' + storm.maxVmax.toFixed(0) + ' m/s') : ''),
        { sticky: true, opacity: 0.92 }
      );
      if (typeof opts.onSelect === 'function') {
        line.on('click', function () { opts.onSelect(storm.id); });
      }
      line.addTo(layerGroup);

      // Intensity dots: every point if few; else ~6h-ish (IBTrACS often 3/6h)
      const step = pts.length > 80 ? 2 : 1;
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i];
        const hex = G.intensityTrackColor(p.vmax, scale);
        const r = selected ? 4.5 : 3.2;
        const c = L.circleMarker([p.lat, p.lon], {
          radius: r,
          color: '#222',
          weight: 0.6,
          fillColor: hex,
          fillOpacity: selected ? 0.95 : 0.75,
          opacity: selected ? 0.9 : 0.55,
          interactive: false
        });
        c.addTo(layerGroup);
      }

      // Start / end marks for selected
      if (selected) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        L.circleMarker([a.lat, a.lon], {
          radius: 6, color: '#145a32', weight: 2, fillColor: '#82e0aa', fillOpacity: 0.95, interactive: false
        }).bindTooltip('起点', { direction: 'top' }).addTo(layerGroup);
        L.circleMarker([b.lat, b.lon], {
          radius: 6, color: '#7b241c', weight: 2, fillColor: '#f5b7b1', fillOpacity: 0.95, interactive: false
        }).bindTooltip('终点', { direction: 'top' }).addTo(layerGroup);
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

  global.TyHistory = {
    YEAR_MIN: YEAR_MIN,
    YEAR_MAX: YEAR_MAX,
    yearsList: yearsList,
    loadIndex: loadIndex,
    loadYear: loadYear,
    drawYear: drawYear,
    clear: clear,
    fitStorm: fitStorm
  };
})(typeof window !== 'undefined' ? window : globalThis);
