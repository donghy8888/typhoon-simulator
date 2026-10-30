/**
 * 台风纪录（IBTrACS 西北太平洋 1949–2026）— 按年按需加载
 */
(function (global) {
  'use strict';

  const YEAR_MIN = 1949;
  const YEAR_MAX = 2026;
  const DATA_BASE = 'data/ibtracs/wp';
  const DATA_VER = '20261030d';

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

  function stormLabel(storm) {
    return (storm && storm.name) ? storm.name : 'UNNAMED';
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

    data.storms.forEach(function (storm) {
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
            iconSize: [120, 36],
            iconAnchor: [60, 40]
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

  global.TyHistory = {
    YEAR_MIN: YEAR_MIN,
    YEAR_MAX: YEAR_MAX,
    yearsList: yearsList,
    loadIndex: loadIndex,
    loadYear: loadYear,
    drawYear: drawYear,
    clear: clear,
    fitStorm: fitStorm,
    stormLabel: stormLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
