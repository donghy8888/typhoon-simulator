/**
 * 西北太平洋台风模拟器 — 地图与界面
 */
(function () {
  'use strict';

  const G = window.TyGeo;
  const P = window.TyPhysics;

  // —— 状态 ——
  const state = {
    running: false,
    paused: false,
    hours: 0,
    speed: 4,
    members: [],
    hole: null,
    fugen: G.defaultFugen(),
    sstRegions: G.defaultSstRegions(),
    layers: {
      fugen: true,
      sst: true,
      steer: true,
      terrain: true,
      track: true,
      ensemble: true
    },
    selectedFugen: null,
    _draggingVertex: false,
    _draggingBlock: false,
    timer: null
  };

  // —— 地图（Canvas 渲染，缩放更顺）——
  const map = L.map('map', {
    center: [22, 135],
    zoom: 4,
    minZoom: 3,
    maxZoom: 8,
    worldCopyJump: false,
    preferCanvas: true,
    zoomAnimation: true,
    markerZoomAnimation: false,
    fadeAnimation: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 8,
    updateWhenZooming: false,
    updateWhenIdle: true,
    keepBuffer: 2,
    maxNativeZoom: 8
  }).addTo(map);

  map.setMaxBounds([[-5, 95], [55, 185]]);

  const layerGroups = {
    terrain: L.layerGroup().addTo(map),
    fugen: L.layerGroup().addTo(map),
    sst: L.layerGroup().addTo(map),
    steer: L.layerGroup().addTo(map),
    track: L.layerGroup().addTo(map),
    ensemble: L.layerGroup().addTo(map),
    storm: L.layerGroup().addTo(map)
  };

  // 域边框
  L.rectangle([[G.DOMAIN.latMin, G.DOMAIN.lonMin], [G.DOMAIN.latMax, G.DOMAIN.lonMax]], {
    color: '#888', weight: 1, fill: false, dashArray: '4 3', opacity: 0.7
  }).addTo(map);

  // 引导风箭头共用一个 Canvas renderer。
  // clearLayers() 不会从地图移除 canvas renderer；每次 redraw 新建 L.canvas()
  // 会堆积孤儿 canvas → 内存暴涨 / 崩溃。务必单例复用。
  const steerRenderer = L.canvas({ padding: 0.5 });

  // 副高空圈与风暴图层的可复用引用（tick 时原地更新，避免每小时 clear+重建）
  let holeCircleLayer = null;
  const stormRefs = {
    trackLine: null,
    ensembleLines: [],
    windCircles: {},
    marker: null
  };

  function clearStormRefs() {
    layerGroups.track.clearLayers();
    layerGroups.ensemble.clearLayers();
    layerGroups.storm.clearLayers();
    stormRefs.trackLine = null;
    stormRefs.ensembleLines = [];
    stormRefs.windCircles = {};
    stormRefs.marker = null;
  }

  function cfgFromUI() {
    return {
      steerU: parseFloat(document.getElementById('steerU').value),
      steerV: parseFloat(document.getElementById('steerV').value),
      westerlyU: parseFloat(document.getElementById('westerlyU').value),
      betaStrength: parseFloat(document.getElementById('betaStrength').value)
    };
  }

  // —— 地形绘制 ——
  function redrawTerrain() {
    layerGroups.terrain.clearLayers();
    if (!state.layers.terrain) return;
    G.LAND_POLYS.forEach(ring => {
      L.polygon(ring, {
        color: '#7a8a6a', weight: 1, fillColor: '#c5d5b5', fillOpacity: 0.35
      }).addTo(layerGroups.terrain);
    });
    G.MOUNTAIN_POLYS.forEach(ring => {
      L.polygon(ring, {
        color: '#6b5344', weight: 1, fillColor: '#8b7355', fillOpacity: 0.5
      }).addTo(layerGroups.terrain);
    });
  }

  // —— 副高绘制 ——
  let fugenPolygons = [];

  function ringToLatLng(ring) {
    return ring.map(p => [p[1], p[0]]);
  }

  function circleHoleLatLngs(hole, n) {
    n = n || 48;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const dlon = (hole.radiusDeg * Math.cos(a)) / Math.cos(hole.lat * Math.PI / 180);
      const dlat = hole.radiusDeg * Math.sin(a);
      pts.push([hole.lat + dlat, hole.lon + dlon]);
    }
    return pts;
  }

  function applyPolyLatLngs(poly, f) {
    const outer = ringToLatLng(f.ring);
    let latlngs = outer;
    if (state.hole && state.hole.fugenId === f.id) {
      latlngs = [outer, circleHoleLatLngs(state.hole)];
    }
    poly.setLatLngs(latlngs);
  }

  function translateRing(ring, dLon, dLat) {
    for (let i = 0; i < ring.length; i++) {
      ring[i][0] += dLon;
      ring[i][1] += dLat;
    }
  }

  function redrawFugen(opts) {
    opts = opts || {};
    layerGroups.fugen.clearLayers();
    fugenPolygons = [];
    holeCircleLayer = null;
    if (!state.layers.fugen) {
      if (opts.refreshSteer !== false) redrawSteerSoon();
      return;
    }

    state.fugen.forEach((f, idx) => {
      const outer = ringToLatLng(f.ring);
      let latlngs = outer;
      if (state.hole && state.hole.fugenId === f.id) {
        latlngs = [outer, circleHoleLatLngs(state.hole)];
      }
      const selected = state.selectedFugen === idx;
      const poly = L.polygon(latlngs, {
        color: selected ? '#922b21' : '#c0392b',
        weight: selected ? 2.5 : 2,
        opacity: 0.9,
        fillColor: '#e74c3c',
        fillOpacity: selected ? 0.42 : 0.32,
        className: selected ? 'fugen-draggable-fill' : '',
        bubblingMouseEvents: false
      }).addTo(layerGroups.fugen);

      poly.bindTooltip(
        f.name + (selected ? '（拖内部平移 · 拖圆点改形）' : '（点击选中）'),
        { sticky: true, opacity: 0.92 }
      );

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectFugen(idx);
      });

      // 整块拖动：选中后在填充区按下并拖动（非顶点）
      if (selected) {
        poly.on('mousedown', function (e) {
          if (state._draggingVertex) return;
          // 仅左键
          if (e.originalEvent && e.originalEvent.button !== 0) return;
          L.DomEvent.stopPropagation(e);
          L.DomEvent.preventDefault(e);

          state._draggingBlock = true;
          map.dragging.disable();
          map.doubleClickZoom.disable();

          const start = e.latlng;
          let last = start;

          function onMove(ev) {
            if (!state._draggingBlock) return;
            const ll = ev.latlng;
            const dLon = ll.lng - last.lng;
            const dLat = ll.lat - last.lat;
            if (dLon === 0 && dLat === 0) return;
            translateRing(f.ring, dLon, dLat);
            last = ll;
            applyPolyLatLngs(poly, f);
            // 同步顶点 marker 位置
            layerGroups.fugen.eachLayer(function (ly) {
              if (ly instanceof L.Marker && ly._fugenVertexIndex != null) {
                const pt = f.ring[ly._fugenVertexIndex];
                if (pt) ly.setLatLng([pt[1], pt[0]]);
              }
            });
          }

          function onUp() {
            state._draggingBlock = false;
            map.off('mousemove', onMove);
            map.off('mouseup', onUp);
            map.dragging.enable();
            map.doubleClickZoom.enable();
            redrawFugen();
            renderFugenList();
          }

          map.on('mousemove', onMove);
          map.on('mouseup', onUp);
        });
      }

      // 可拖角点：draggable marker；拖动时只改多边形顶点
      if (selected && !state._draggingVertex) {
        // 去掉闭合重复末点，避免叠两个手柄
        const ringPts = f.ring.slice();
        if (ringPts.length >= 2) {
          const a = ringPts[0], b = ringPts[ringPts.length - 1];
          if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) {
            ringPts.pop();
          }
        }
        // 若顶点过多，仍全部可拖（顺滑环约 20–40 点）
        ringPts.forEach((pt, pi) => {
          const marker = L.marker([pt[1], pt[0]], {
            draggable: true,
            autoPan: false,
            zIndexOffset: 1000,
            icon: L.divIcon({
              className: 'fugen-vertex',
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            })
          }).addTo(layerGroups.fugen);
          marker._fugenVertexIndex = pi;
          const el = marker.getElement();
          if (el) {
            L.DomEvent.disableClickPropagation(el);
            el.title = '拖动改形';
          }
          marker.on('dragstart', function (ev) {
            state._draggingVertex = true;
            state._draggingBlock = false;
            map.dragging.disable();
            map.doubleClickZoom.disable();
            L.DomEvent.stop(ev);
          });
          marker.on('drag', function (ev) {
            const ll = ev.target.getLatLng();
            // 写回开放环；若原 ring 闭合则同步末点
            const closed = f.ring.length >= 2 &&
              Math.abs(f.ring[0][0] - f.ring[f.ring.length - 1][0]) < 1e-9 &&
              Math.abs(f.ring[0][1] - f.ring[f.ring.length - 1][1]) < 1e-9;
            const openLen = closed ? f.ring.length - 1 : f.ring.length;
            if (pi >= openLen) return;
            f.ring[pi] = [ll.lng, ll.lat];
            if (closed) {
              f.ring[f.ring.length - 1] = [f.ring[0][0], f.ring[0][1]];
            }
            applyPolyLatLngs(poly, f);
          });
          marker.on('dragend', function () {
            state._draggingVertex = false;
            map.dragging.enable();
            map.doubleClickZoom.enable();
            redrawFugen();
            renderFugenList();
          });
        });
      }
      fugenPolygons.push(poly);
    });

    // 空洞描边提示
    if (state.hole && state.layers.fugen) {
      holeCircleLayer = L.circle([state.hole.lat, state.hole.lon], {
        radius: state.hole.radiusDeg * 111320,
        color: '#922b21',
        weight: 2,
        dashArray: '6 4',
        fillOpacity: 0
      }).bindTooltip('副高空圈（随风圈变化）').addTo(layerGroups.fugen);
    }
    // 用户编辑 / 选中 / 增删时立即刷新引导风；tick 路径不走这里
    if (opts.refreshSteer !== false) redrawSteerSoon();
  }

  /** tick 时原地更新空圈与副高挖洞，避免 clearLayers + 重建 */
  function updateHoleVisualInPlace() {
    if (!state.layers.fugen) return;

    state.fugen.forEach(function (f, idx) {
      const poly = fugenPolygons[idx];
      if (poly) applyPolyLatLngs(poly, f);
    });

    if (state.hole) {
      const latlng = [state.hole.lat, state.hole.lon];
      const radiusM = state.hole.radiusDeg * 111320;
      if (holeCircleLayer && layerGroups.fugen.hasLayer(holeCircleLayer)) {
        holeCircleLayer.setLatLng(latlng);
        holeCircleLayer.setRadius(radiusM);
      } else {
        holeCircleLayer = L.circle(latlng, {
          radius: radiusM,
          color: '#922b21',
          weight: 2,
          dashArray: '6 4',
          fillOpacity: 0
        }).bindTooltip('副高空圈（随风圈变化）').addTo(layerGroups.fugen);
      }
    } else if (holeCircleLayer) {
      if (layerGroups.fugen.hasLayer(holeCircleLayer)) {
        layerGroups.fugen.removeLayer(holeCircleLayer);
      }
      holeCircleLayer = null;
    }
  }

  function selectFugen(idx) {
    state.selectedFugen = idx;
    renderFugenList();
    redrawFugen();
  }

  function renderFugenList() {
    const el = document.getElementById('fugenList');
    el.innerHTML = '';
    if (!state.fugen.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '暂无副高块，可点「添加副高块」或「恢复默认」。';
      el.appendChild(empty);
      return;
    }
    state.fugen.forEach((f, idx) => {
      const div = document.createElement('div');
      div.className = 'fugen-item' + (state.selectedFugen === idx ? ' selected' : '');

      const dot = document.createElement('span');
      dot.className = 'dot';
      div.appendChild(dot);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'fugen-name-input';
      nameInput.value = f.name;
      nameInput.title = '可改名称';
      nameInput.onclick = (e) => e.stopPropagation();
      nameInput.onchange = () => {
        const v = nameInput.value.trim();
        if (v) f.name = v;
        else nameInput.value = f.name;
        redrawFugen();
      };
      div.appendChild(nameInput);

      const btnSel = document.createElement('button');
      btnSel.type = 'button';
      btnSel.className = 'small' + (state.selectedFugen === idx ? ' primary' : ' secondary');
      btnSel.textContent = state.selectedFugen === idx ? '已选' : '选中';
      btnSel.title = '选中后可拖动整块或顶点';
      btnSel.onclick = (e) => {
        e.stopPropagation();
        selectFugen(idx);
      };

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'small danger';
      btnDel.textContent = '删除';
      btnDel.title = '删除此副高块';
      btnDel.onclick = (e) => {
        e.stopPropagation();
        state.fugen.splice(idx, 1);
        if (state.selectedFugen === idx) state.selectedFugen = null;
        else if (state.selectedFugen != null && state.selectedFugen > idx) state.selectedFugen--;
        renderFugenList();
        redrawFugen();
      };

      div.appendChild(btnSel);
      div.appendChild(btnDel);
      div.onclick = () => selectFugen(idx);
      el.appendChild(div);
    });
  }

  // —— SST 等值线 ——
  function redrawSst() {
    layerGroups.sst.clearLayers();
    if (!state.layers.sst) return;

    state.sstRegions.forEach(r => {
      const bounds = [[r.lat0, r.lon0], [r.lat1, r.lon1]];
      let fill = '#aed6f1';
      if (r.sst >= 28) fill = '#f5b7b1';
      else if (r.sst >= 26.5) fill = '#f9e79f';
      else fill = '#d6eaf8';
      L.rectangle(bounds, {
        color: '#888', weight: 0.5, fillColor: fill, fillOpacity: 0.18
      }).bindTooltip(r.name + ' ' + r.sst.toFixed(1) + '℃').addTo(layerGroups.sst);

      if (r.sst >= 28) {
        L.rectangle(bounds, {
          color: '#c0392b', weight: 2, fill: false, dashArray: '2 2'
        }).addTo(layerGroups.sst);
      } else if (Math.abs(r.sst - 26.5) < 0.6 || (r.sst >= 26.5 && r.sst < 28)) {
        L.rectangle(bounds, {
          color: '#e67e22', weight: 1.5, fill: false, dashArray: '4 3'
        }).addTo(layerGroups.sst);
      }
    });
  }

  function renderSstControls() {
    const box = document.getElementById('sstControls');
    box.innerHTML = '';
    state.sstRegions.forEach(r => {
      const wrap = document.createElement('div');
      wrap.className = 'sst-block';
      wrap.innerHTML = '<div class="name">' + r.name +
        ' <span style="font-weight:normal;color:#6a7a8a">(' +
        r.lon0 + '–' + r.lon1 + '°E, ' + r.lat0 + '–' + r.lat1 + '°N)</span></div>';
      const row = document.createElement('div');
      row.className = 'form-row';
      const label = document.createElement('label');
      label.textContent = '海温';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '20';
      range.max = '32';
      range.step = '0.5';
      range.value = String(r.sst);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = r.sst.toFixed(1) + '℃';
      range.oninput = () => {
        r.sst = parseFloat(range.value);
        val.textContent = r.sst.toFixed(1) + '℃';
        redrawSst();
      };
      row.appendChild(label);
      row.appendChild(range);
      row.appendChild(val);
      wrap.appendChild(row);
      box.appendChild(wrap);
    });
  }

  // —— 引导风箭头（更密、更大；Canvas 下缩放更顺）——
  let _steerTimer = null;
  let _steerThrottleTimer = null;
  let _lastSteerAt = 0;
  const STEER_THROTTLE_MS = 750;
  // 空圈半径变化超过此阈值才因几何变化触发引导风刷新（tick 中的 lat 微调不算）
  const STEER_HOLE_RADIUS_EPS = 0.05;
  let _lastSteerHoleRadius = null;
  let _lastSteerHolePresent = false;

  function redrawSteerSoon() {
    if (_steerTimer) clearTimeout(_steerTimer);
    _steerTimer = setTimeout(redrawSteer, 80);
  }

  /** 模拟运行中节流刷新引导风（~750ms），避免每物理小时重建 */
  function redrawSteerThrottled() {
    const now = Date.now();
    if (now - _lastSteerAt >= STEER_THROTTLE_MS) {
      if (_steerThrottleTimer) {
        clearTimeout(_steerThrottleTimer);
        _steerThrottleTimer = null;
      }
      _lastSteerAt = now;
      redrawSteer();
      return;
    }
    // 已安排尾随刷新则不再重置，防止高频 tick 饿死回调
    if (_steerThrottleTimer) return;
    const wait = STEER_THROTTLE_MS - (now - _lastSteerAt);
    _steerThrottleTimer = setTimeout(function () {
      _steerThrottleTimer = null;
      _lastSteerAt = Date.now();
      redrawSteer();
    }, wait);
  }

  /**
   * tick 后：仅在空圈出现/消失，或半径跨阈值时考虑刷新引导风；
   * 运行中走节流，避免每次 lat 微移都重绘。
   */
  function maybeRefreshSteerAfterTick(holeJustChangedPresence) {
    if (!state.layers.steer) return;
    const present = !!state.hole;
    const radius = present ? state.hole.radiusDeg : null;
    let geometryChanged = holeJustChangedPresence;
    if (present && _lastSteerHoleRadius != null &&
        Math.abs(radius - _lastSteerHoleRadius) >= STEER_HOLE_RADIUS_EPS) {
      geometryChanged = true;
    }
    if (present !== _lastSteerHolePresent) geometryChanged = true;
    _lastSteerHolePresent = present;
    if (radius != null) _lastSteerHoleRadius = radius;
    else _lastSteerHoleRadius = null;

    if (holeJustChangedPresence) {
      redrawSteerSoon();
      return;
    }
    if (!present) return;
    // 有空圈时节流刷新（空圈移动会改引导场）；半径阈值变化同样走节流
    if (geometryChanged || present) redrawSteerThrottled();
  }

  function redrawSteer() {
    layerGroups.steer.clearLayers();
    if (!state.layers.steer) return;
    const cfg = cfgFromUI();
    // 复用模块级 steerRenderer，切勿每次 new L.canvas()
    const canvas = steerRenderer;

    // 绿线 = physics 的 guidingNorthernEdgeLat（含西侧 look-east），
    // 与 ENE onset 同一条边，避免「绿线西侧/南侧已往东北」。
    const edgePts = [];
    for (let lon = 105; lon <= 175; lon += 2) {
      const edge = G.guidingNorthernEdgeLat(lon, state.fugen, state.hole);
      if (edge != null) edgePts.push([edge, lon]);
    }
    if (edgePts.length >= 2) {
      L.polyline(edgePts, {
        color: '#1a7f4b', weight: 2.5, dashArray: '8 6', opacity: 0.9,
        renderer: canvas
      }).bindTooltip('副高北缘（绿线=引导北缘）；以南≈0.3°纯往北，以北东北偏东(ENE)', { sticky: true })
        .addTo(layerGroups.steer);
    }

    const stepLon = 4, stepLat = 3;
    const westSegs = [];
    const baseSegs = [];
    for (let lat = 5; lat <= 45; lat += stepLat) {
      for (let lon = 105; lon <= 175; lon += stepLon) {
        if (G.inFugenSolid(lon, lat, state.fugen, state.hole)) continue;
        const st = P.steeringAt(lon, lat, cfg, state.fugen, state.hole);
        const beta = P.betaDrift(lat, cfg.betaStrength);
        const u = st.u + beta.u * 0.5;
        const v = st.v + beta.v * 0.5;
        const spd = Math.hypot(u, v);
        if (spd < 0.25) continue;
        const inWest = G.inWesterlyBelt(lon, lat, state.fugen, state.hole);
        // 箭头更长更大
        const scale = 0.55 + Math.min(0.35, spd * 0.03);
        const coslat = Math.cos(lat * Math.PI / 180) || 0.2;
        const endLat = lat + v * scale * 0.22;
        const endLon = lon + u * scale * 0.22 / coslat;
        const ang = Math.atan2(v, u);
        const ah = 0.55;
        const a1 = ang + Math.PI * 0.78;
        const a2 = ang - Math.PI * 0.78;
        const p1 = [endLat + Math.sin(a1) * ah * 0.55, endLon + Math.cos(a1) * ah * 0.55 / coslat];
        const p2 = [endLat + Math.sin(a2) * ah * 0.55, endLon + Math.cos(a2) * ah * 0.55 / coslat];
        const shaft = [[lat, lon], [endLat, endLon]];
        const head = [p1, [endLat, endLon], p2];
        if (inWest) {
          westSegs.push(shaft, head);
        } else {
          baseSegs.push(shaft, head);
        }
      }
    }
    if (baseSegs.length) {
      L.polyline(baseSegs, {
        color: '#2c3e50', weight: 1.8, opacity: 0.75, renderer: canvas
      }).addTo(layerGroups.steer);
    }
    if (westSegs.length) {
      L.polyline(westSegs, {
        color: '#1a7f4b', weight: 2.1, opacity: 0.8, renderer: canvas
      }).addTo(layerGroups.steer);
    }
  }

  // —— 风暴与路径 ——
  function stormIcon() {
    return L.divIcon({
      className: '',
      html: '<div style="width:20px;height:20px;border:2px solid #c0392b;border-radius:50%;background:rgba(231,76,60,0.4);text-align:center;line-height:16px;font-size:12px;color:#922;font-weight:bold;box-shadow:0 1px 3px rgba(0,0,0,.25)">台</div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
  }

  /** 完整重建（放置 / 重置 / 图层开关） */
  function redrawStorm() {
    clearStormRefs();
    updateStormInPlace();
  }

  /** tick 时原地更新：setLatLng / setLatLngs / setRadius，避免每小时 clear+重建 */
  function updateStormInPlace() {
    if (!state.members.length) {
      clearStormRefs();
      return;
    }

    const main = state.members[0];

    if (state.layers.ensemble && state.members.length > 1) {
      for (let i = 1; i < state.members.length; i++) {
        const m = state.members[i];
        const latlngs = m.track.map(function (p) { return [p.lat, p.lon]; });
        const ei = i - 1;
        if (stormRefs.ensembleLines[ei]) {
          if (latlngs.length >= 2) stormRefs.ensembleLines[ei].setLatLngs(latlngs);
        } else if (latlngs.length >= 2) {
          stormRefs.ensembleLines[ei] = L.polyline(latlngs, {
            color: '#95a5a6', weight: 1.5, opacity: 0.7
          }).addTo(layerGroups.ensemble);
        }
      }
    }

    if (state.layers.track && main.track.length >= 1) {
      const latlngs = main.track.map(function (p) { return [p.lat, p.lon]; });
      if (latlngs.length >= 2) {
        if (stormRefs.trackLine) {
          stormRefs.trackLine.setLatLngs(latlngs);
        } else {
          stormRefs.trackLine = L.polyline(latlngs, {
            color: '#2980b9', weight: 2.5
          }).addTo(layerGroups.track);
        }
      }

      const rings = (main.alive || main.vmax >= P.DISSIPATE_MS)
        ? G.windRadiiForGrades(main.vmax)
        : [];
      const seen = {};
      rings.forEach(function (ring) {
        seen[ring.grade] = true;
        const existing = stormRefs.windCircles[ring.grade];
        const tip = ring.label + ' · 当前 ' + G.gradeLabel(main.vmax);
        if (existing) {
          existing.setLatLng([main.lat, main.lon]);
          existing.setRadius(ring.radiusDeg * 111320);
          existing.setStyle({
            color: ring.color,
            weight: ring.weight,
            fillColor: ring.fill,
            fillOpacity: ring.fillOpacity
          });
          if (existing.setTooltipContent) existing.setTooltipContent(tip);
          else if (existing.getTooltip()) existing.getTooltip().setContent(tip);
        } else {
          stormRefs.windCircles[ring.grade] = L.circle([main.lat, main.lon], {
            radius: ring.radiusDeg * 111320,
            color: ring.color,
            weight: ring.weight,
            fillColor: ring.fill,
            fillOpacity: ring.fillOpacity
          }).bindTooltip(tip, { sticky: true }).addTo(layerGroups.track);
        }
      });
      Object.keys(stormRefs.windCircles).forEach(function (g) {
        if (!seen[g]) {
          layerGroups.track.removeLayer(stormRefs.windCircles[g]);
          delete stormRefs.windCircles[g];
        }
      });
    }

    if (stormRefs.marker) {
      stormRefs.marker.setLatLng([main.lat, main.lon]);
    } else {
      stormRefs.marker = L.marker([main.lat, main.lon], { icon: stormIcon() })
        .addTo(layerGroups.storm);
    }
  }

  function updateStatus() {
    const clock = document.getElementById('clockBar');
    const days = Math.floor(state.hours / 24);
    const hrs = Math.floor(state.hours % 24);
    const mins = Math.floor((state.hours * 60) % 60);
    const timeStr = '第 ' + days + ' 天 ' + hrs + ' 小时' + (mins ? (' ' + mins + ' 分') : '');

    if (!state.members.length) {
      clock.textContent = '模拟时钟：未开始 · 点击地图放置台风后按「开始」';
      document.getElementById('stTime').textContent = '—';
      document.getElementById('stPos').textContent = '—';
      document.getElementById('stWind').textContent = '—';
      document.getElementById('stSst').textContent = '—';
      document.getElementById('stPhase').textContent = '待启动';
      document.getElementById('stSteer').textContent = '—';
      return;
    }

    const m = state.members[0];
    clock.textContent = '模拟时钟：' + timeStr +
      (m.alive ? (state.paused ? '（已暂停）' : (state.running ? '（运行中）' : '')) : ' · 已消亡');

    document.getElementById('stTime').textContent = timeStr;
    document.getElementById('stPos').textContent =
      m.lon.toFixed(2) + '°E, ' + m.lat.toFixed(2) + '°N';
    document.getElementById('stWind').textContent =
      m.vmax.toFixed(1) + ' m/s（' + G.gradeLabel(m.vmax) + '）';
    document.getElementById('stSst').textContent =
      (m.sst != null ? m.sst.toFixed(1) + '℃' : G.getSst(m.lon, m.lat, state.sstRegions).toFixed(1) + '℃');
    document.getElementById('stPhase').textContent = m.phase;
    document.getElementById('stSteer').textContent =
      'u=' + m.u.toFixed(1) + ' v=' + m.v.toFixed(1) + ' m/s';
  }

  function placeStorm(lon, lat, vmax) {
    lon = clamp(lon, G.DOMAIN.lonMin, G.DOMAIN.lonMax);
    lat = clamp(lat, G.DOMAIN.latMin, G.DOMAIN.latMax);
    document.getElementById('initLon').value = lon.toFixed(2);
    document.getElementById('initLat').value = lat.toFixed(2);
    if (vmax != null) document.getElementById('initWind').value = vmax;

    vmax = parseFloat(document.getElementById('initWind').value);
    const n = clamp(parseInt(document.getElementById('ensembleN').value, 10) || 1, 1, 20);
    document.getElementById('ensembleN').value = n;

    const cfg = cfgFromUI();
    state.hole = P.ensureBirthHole(lon, lat, vmax, state.fugen);
    state.hours = 0;
    state.members = [];

    const init = { lon, lat, vmax };
    const main = {
      lon, lat, vmax, alive: true, track: [{ lon, lat, vmax, t: 0 }],
      phase: '待启动', sst: G.getSst(lon, lat, state.sstRegions), u: 0, v: 0,
      cfgPerturb: null
    };
    state.members.push(main);

    for (let i = 1; i < n; i++) {
      const mem = P.createMember(1000 + i * 97 + Math.floor(lon * 10), init, cfg);
      mem.track = [{ lon: mem.lon, lat: mem.lat, vmax: mem.vmax, t: 0 }];
      mem.sst = G.getSst(mem.lon, mem.lat, state.sstRegions);
      state.members.push(mem);
    }

    redrawFugen();
    redrawStorm();
    updateStatus();
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function tick() {
    if (!state.running || state.paused) return;
    if (!state.members.length || !state.members[0].alive) {
      stopSim();
      updateStatus();
      return;
    }

    const dt = 1.0;
    const cfg = cfgFromUI();
    const main = state.members[0];

    const hadHole = !!state.hole;
    if (state.hole) {
      P.updateHole(state.hole, main.lon, main.lat, main.vmax);
      const stillInParent = state.fugen.some(f =>
        f.id === state.hole.fugenId && G.pointInRing(main.lon, main.lat, f.ring)
      );
      if (!stillInParent && !G.inFugenSolid(main.lon, main.lat, state.fugen, null)) {
        const parent = state.fugen.find(f => f.id === state.hole.fugenId);
        if (parent && !G.pointInRing(main.lon, main.lat, parent.ring)) {
          state.hole = null;
        }
      }
    }

    for (const m of state.members) {
      P.stepMember(m, dt, cfg, state.fugen, state.sstRegions, state.hole);
    }

    state.hours += dt;

    // 原地更新空圈 / 路径 / 风圈 / 标记；不每小时 clearLayers+重建
    const holePresenceChanged = hadHole !== !!state.hole;
    updateHoleVisualInPlace();
    updateStormInPlace();
    maybeRefreshSteerAfterTick(holePresenceChanged);
    updateStatus();

    if (!state.members[0].alive) {
      stopSim();
      document.getElementById('clockBar').textContent += ' — 风力已低于7级，模拟结束';
    }
  }

  function startSim() {
    if (!state.members.length) {
      const lon = parseFloat(document.getElementById('initLon').value);
      const lat = parseFloat(document.getElementById('initLat').value);
      placeStorm(lon, lat);
    }
    if (!state.members[0].alive) {
      const lon = parseFloat(document.getElementById('initLon').value);
      const lat = parseFloat(document.getElementById('initLat').value);
      placeStorm(lon, lat);
    }

    state.running = true;
    state.paused = false;
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnPause').disabled = false;
    document.getElementById('btnPause').textContent = '暂停';

    if (state.timer) clearInterval(state.timer);
    const baseMs = 400;
    const interval = Math.max(40, baseMs / state.speed);
    state.timer = setInterval(tick, interval);
    updateStatus();
  }

  function pauseSim() {
    if (!state.running) return;
    state.paused = !state.paused;
    document.getElementById('btnPause').textContent = state.paused ? '继续' : '暂停';
    updateStatus();
  }

  function stopSim() {
    state.running = false;
    state.paused = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
    document.getElementById('btnPause').textContent = '暂停';
  }

  function resetSim() {
    stopSim();
    if (_steerTimer) { clearTimeout(_steerTimer); _steerTimer = null; }
    if (_steerThrottleTimer) { clearTimeout(_steerThrottleTimer); _steerThrottleTimer = null; }
    state.hours = 0;
    state.members = [];
    state.hole = null;
    _lastSteerHoleRadius = null;
    _lastSteerHolePresent = false;
    clearStormRefs();
    // 副高全量重绘（会清 holeCircleLayer）；共用 steerRenderer，无孤儿 canvas
    redrawFugen();
    updateStatus();
  }

  // —— 事件 ——
  map.on('click', function (e) {
    if (state._draggingBlock || state._draggingVertex) return;
    if (state.running && !state.paused) return;
    const lon = e.latlng.lng;
    const lat = e.latlng.lat;
    if (lon < G.DOMAIN.lonMin || lon > G.DOMAIN.lonMax || lat < G.DOMAIN.latMin || lat > G.DOMAIN.latMax) {
      return;
    }
    stopSim();
    placeStorm(lon, lat);
  });

  document.getElementById('btnStart').onclick = startSim;
  document.getElementById('btnPause').onclick = pauseSim;
  document.getElementById('btnReset').onclick = resetSim;

  document.getElementById('simSpeed').oninput = function () {
    state.speed = parseInt(this.value, 10);
    document.getElementById('simSpeedVal').textContent = state.speed + '×';
    if (state.running && !state.paused) {
      clearInterval(state.timer);
      const interval = Math.max(40, 400 / state.speed);
      state.timer = setInterval(tick, interval);
    }
  };

  document.getElementById('initWindGrade').onchange = function () {
    if (this.value) {
      document.getElementById('initWind').value = this.value;
    }
  };

  ['steerU', 'steerV', 'westerlyU', 'betaStrength'].forEach(id => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + 'Val');
    el.oninput = () => {
      valEl.textContent = parseFloat(el.value).toFixed(1);
      redrawSteer();
    };
  });

  document.querySelectorAll('#layerToggles input').forEach(inp => {
    inp.onchange = () => {
      state.layers[inp.dataset.layer] = inp.checked;
      const g = layerGroups[inp.dataset.layer];
      if (g) {
        if (inp.checked) map.addLayer(g);
        else map.removeLayer(g);
      }
      if (inp.dataset.layer === 'fugen') redrawFugen();
      if (inp.dataset.layer === 'sst') redrawSst();
      if (inp.dataset.layer === 'steer') redrawSteer();
      if (inp.dataset.layer === 'terrain') redrawTerrain();
      if (inp.dataset.layer === 'track' || inp.dataset.layer === 'ensemble') redrawStorm();
    };
  });

  document.getElementById('btnAddFugen').onclick = () => {
    const c = map.getCenter();
    const id = 'user_' + Date.now();
    state.fugen.push({
      id,
      name: '自定义副高' + (state.fugen.length + 1),
      ring: G.makeSmoothFugenRing(c.lng, c.lat, 5.5, 3.2, 12)
    });
    selectFugen(state.fugen.length - 1);
  };

  document.getElementById('btnResetFugen').onclick = () => {
    state.fugen = G.defaultFugen();
    state.selectedFugen = null;
    state.hole = null;
    renderFugenList();
    redrawFugen();
  };

  // 初始绘制
  redrawTerrain();
  redrawFugen();
  redrawSst();
  redrawSteer();
  renderSstControls();
  renderFugenList();
  updateStatus();

  // 默认放置一个示范台风
  placeStorm(140, 15, 35);
})();
