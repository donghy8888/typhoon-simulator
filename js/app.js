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
    speed: 20,
    members: [],
    hole: null,
    fugen: G.fugenForMonth(7),
    sstRegions: G.defaultSstRegions(), // 固定默认背景场，无侧栏调节
    lastPlace: { lon: 140, lat: 15 },
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

  // 引导黄/绿线专用 pane：z 高于 overlay(400)，避免被副高 SVG 填充盖住
  // （黄线在绿线南 0.15°，落在副高实体内侧，canvas 箭头层会被 SVG 副高盖死）
  map.createPane('guides');
  map.getPane('guides').style.zIndex = 450;
  map.getPane('guides').style.pointerEvents = 'none';

  const layerGroups = {
    terrain: L.layerGroup().addTo(map),
    fugen: L.layerGroup().addTo(map),
    sst: L.layerGroup().addTo(map),
    steer: L.layerGroup().addTo(map),
    // guides 永远在地图上（黄/绿线）
    guides: L.layerGroup({ pane: 'guides' }).addTo(map),
    track: L.layerGroup().addTo(map),
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
  /** 路径强度圆点：每 0.25 天（6h）一个，固定像素大小，色=当时 vmax */
  const TRACK_MARK_DT_H = 6;

  const stormRefs = {
    trackLine: null,
    windCircles: {},
    intensityMarks: [],
    marker: null
  };

  function clearStormRefs() {
    layerGroups.track.clearLayers();
    layerGroups.storm.clearLayers();
    stormRefs.trackLine = null;
    stormRefs.windCircles = {};
    stormRefs.intensityMarks = [];
    stormRefs.marker = null;
  }

  function isQuarterDayMark(tHours) {
    const t = Math.round(tHours * 1000) / 1000;
    const rem = ((t % TRACK_MARK_DT_H) + TRACK_MARK_DT_H) % TRACK_MARK_DT_H;
    return rem < 1e-6 || rem > TRACK_MARK_DT_H - 1e-6;
  }

  function getIntensityScale() {
    const el = document.getElementById('intensityScale');
    const v = el && el.value;
    return v === G.INTENSITY_SCALE_SSHWS ? G.INTENSITY_SCALE_SSHWS : G.INTENSITY_SCALE_CMA;
  }

  function updateIntensityLegend() {
    const scale = getIntensityScale();
    const box = document.getElementById('intensityLegendItems');
    if (box) {
      const items = G.intensityLegendItems(scale);
      box.innerHTML = items.map(function (it) {
        return '<div><span class="swatch" style="background:' + it.hex +
          ';border-radius:50%"></span>' + it.text + '</div>';
      }).join('');
    }
    const hint = document.getElementById('intensityScaleHint');
    if (hint) {
      hint.textContent = scale === G.INTENSITY_SCALE_SSHWS
        ? '路径圆点：NHC TD/TS/Cat1–5'
        : '路径圆点：CMA 绿蓝黄橙紫红';
    }
  }

  function clearIntensityMarks() {
    stormRefs.intensityMarks.forEach(function (c) { layerGroups.track.removeLayer(c); });
    stormRefs.intensityMarks = [];
  }

  /** 按 track 增量补画 6h 强度圆点（不每 tick 全量重建）；色随当前色阶模式 */
  function syncIntensityMarks(track) {
    if (!track || !track.length) return;
    const scale = getIntensityScale();
    let have = stormRefs.intensityMarks.length;
    // track 被截断或重置时重来
    if (have && (track.length < have || !isQuarterDayMark(track[0].t))) {
      const expected = track.filter(function (p) { return isQuarterDayMark(p.t); });
      if (have > expected.length) {
        clearIntensityMarks();
        have = 0;
      }
    }
    const needed = [];
    for (let i = 0; i < track.length; i++) {
      if (isQuarterDayMark(track[i].t)) needed.push(track[i]);
    }
    for (let i = have; i < needed.length; i++) {
      const p = needed[i];
      const fill = G.intensityTrackColor(p.vmax, scale);
      const cat = G.intensityScaleLabel(p.vmax, scale);
      const tip = 't=' + (p.t / 24).toFixed(2) + '天 · ' + cat +
        ' · ' + G.gradeLabel(p.vmax) + ' · ' + p.vmax.toFixed(1) + ' m/s';
      const c = L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color: '#ffffff',
        weight: 1.2,
        fillColor: fill,
        fillOpacity: 0.92,
        opacity: 0.95
      });
      c._tyVmax = p.vmax;
      c.bindTooltip(tip, { sticky: true }).addTo(layerGroups.track);
      stormRefs.intensityMarks.push(c);
    }
  }

  /** 切换色阶后：已有圆点按新色阶重上色并刷新图例 */
  function recolorIntensityMarks() {
    const scale = getIntensityScale();
    updateIntensityLegend();
    stormRefs.intensityMarks.forEach(function (c) {
      const vmax = c._tyVmax;
      if (vmax == null) return;
      const fill = G.intensityTrackColor(vmax, scale);
      const cat = G.intensityScaleLabel(vmax, scale);
      c.setStyle({ fillColor: fill });
      // tip 尽量保留时间信息：从现有 tip 抽 t=…天
      let tPart = '';
      const old = c.getTooltip() && c.getTooltip().getContent();
      if (typeof old === 'string') {
        const m = old.match(/t=[0-9.]+天/);
        if (m) tPart = m[0] + ' · ';
      }
      c.setTooltipContent(tPart + cat + ' · ' + G.gradeLabel(vmax) + ' · ' + (+vmax).toFixed(1) + ' m/s');
    });
  }

  function cfgFromUI() {
    // 引导气流固定默认值（侧栏调整 UI 已移除）
    return {
      steerU: -3,
      steerV: 1.5,
      westerlyU: 8,
      betaStrength: 1
    };
  }

  // —— 地形绘制 ——
  function redrawTerrain() {
    layerGroups.terrain.clearLayers();
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

      // 可拖角点：源环已稀疏（气候态约 8–12）；手柄最多 12，写回真实 ring 索引
      if (selected && !state._draggingVertex) {
        const closed = f.ring.length >= 2 &&
          Math.abs(f.ring[0][0] - f.ring[f.ring.length - 1][0]) < 1e-9 &&
          Math.abs(f.ring[0][1] - f.ring[f.ring.length - 1][1]) < 1e-9;
        const openLen = closed ? f.ring.length - 1 : f.ring.length;
        const MAX_HANDLES = 12;
        const handleIdx = [];
        if (openLen <= MAX_HANDLES) {
          for (let i = 0; i < openLen; i++) handleIdx.push(i);
        } else {
          for (let h = 0; h < MAX_HANDLES; h++) {
            handleIdx.push(Math.round(h * (openLen - 1) / (MAX_HANDLES - 1)));
          }
        }
        handleIdx.forEach((pi) => {
          const pt = f.ring[pi];
          if (!pt) return;
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
            if (pi < 0 || pi >= openLen) return;
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
    if (state.hole) {
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
      empty.textContent = '暂无副高。可点「恢复本月默认」。';
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

  /**
   * 黄线 / 绿线：始终绘制到 guides pane。
   * yellowLat = greenEdge − 0.15°；同 lon 采样；亮黄 weight=3.5 同绿线；SVG 非 canvas，压在副高之上。
   */
  function redrawGuideLines() {
    layerGroups.guides.clearLayers();
    const edgePts = [];
    const yellowPts = [];
    const band = G.APPROACH_NORTH_BAND_DEG || 0.15;
    for (let lon = 105; lon <= 175; lon += 0.5) {
      const edge = G.guidingNorthernEdgeLat(lon, state.fugen, state.hole);
      if (edge != null) {
        const yellowLat = edge - band; // yellowLat = greenEdge - 0.15°
        edgePts.push([edge, lon]);
        yellowPts.push([yellowLat, lon]);
      }
    }
    // 绿线先画
    if (edgePts.length >= 2) {
      L.polyline(edgePts, {
        color: '#0a5c32', weight: 3.5, opacity: 1, pane: 'guides',
        interactive: true
      }).bindTooltip('绿线=引导北缘；以南黄→绿纯北；以北 NE≈45° fromN（小振幅）', { sticky: true })
        .addTo(layerGroups.guides);
    }
    // 黄线后画、压在绿线上沿：亮黄 #ffff00 weight 3.5（与绿线同粗、无衬底）
    if (yellowPts.length >= 2) {
      L.polyline(yellowPts, {
        color: '#ffff00', weight: 3.5, opacity: 1, pane: 'guides',
        interactive: true
      }).bindTooltip('黄线 yellowLat=绿线南0.15°：以南轻度WNW；黄→绿 u≡0 纯北', { sticky: true })
        .addTo(layerGroups.guides);
    }
  }

  function redrawSteer() {
    redrawGuideLines();
    layerGroups.steer.clearLayers();
    const cfg = cfgFromUI();
    // 复用模块级 steerRenderer，切勿每次 new L.canvas()
    const canvas = steerRenderer;

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

  /** 完整重建（放置 / 重置） */
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

    if (main.track.length >= 1) {
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
      syncIntensityMarks(main.track);

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
      return;
    }

    const m = state.members[0];
    let clockExtra = '';
    if (!m.alive) clockExtra = ' · 已消亡';
    else if (state.paused) clockExtra = '（已暂停）';
    else if (state.running) clockExtra = '（运行中）';
    else clockExtra = ' · 已放置，选风力等级更新强度/风圈，按「开始」运行';
    clock.textContent = '模拟时钟：' + timeStr + clockExtra;
  }

  function initVmaxFromGrade() {
    const el = document.getElementById('initWindGrade');
    const v = parseFloat(el && el.value);
    return isFinite(v) ? v : 32.7;
  }

  function placeStorm(lon, lat, vmax) {
    lon = clamp(lon, G.DOMAIN.lonMin, G.DOMAIN.lonMax);
    lat = clamp(lat, G.DOMAIN.latMin, G.DOMAIN.latMax);
    state.lastPlace = { lon, lat };
    if (vmax == null) vmax = initVmaxFromGrade();

    state.hole = P.ensureBirthHole(lon, lat, vmax, state.fugen);
    state.hours = 0;
    state.members = [];

    const main = {
      lon, lat, vmax, alive: true, track: [{ lon, lat, vmax, t: 0 }],
      phase: '待启动', sst: G.getSst(lon, lat, state.sstRegions), u: 0, v: 0,
      arcLat0: null,
      sAcc: 0,
      cfgPerturb: null
    };
    state.members.push(main);

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
      placeStorm(state.lastPlace.lon, state.lastPlace.lat);
    }
    if (!state.members[0].alive) {
      placeStorm(state.lastPlace.lon, state.lastPlace.lat);
    }
    // 尚未开跑时，用当前风力等级刷新已放置风暴
    if (!state.running && state.hours === 0) {
      applyInitWindToMember();
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


  /** 把风力等级同步到已放置风暴：更新 vmax、等级标签与 7/10/12 风圈；不启动模拟 */
  function applyInitWindToMember() {
    const vmax = initVmaxFromGrade();
    if (!state.members.length || !isFinite(vmax)) return vmax;
    const m = state.members[0];
    if (!m.alive && !state.running) return vmax;
    m.vmax = vmax;
    if (!state.running && m.track && m.track.length === 1) {
      m.track[0].vmax = vmax;
    }
    state.hole = P.ensureBirthHole(m.lon, m.lat, vmax, state.fugen);
    redrawFugen();
    redrawStorm();
    updateStatus();
    return vmax;
  }

  document.getElementById('intensityScale').onchange = function () {
    recolorIntensityMarks();
  };
  updateIntensityLegend();

  document.getElementById('initWindGrade').onchange = function () {
    // 已放置：立刻同步 vmax / 等级标签 / 七·十·十二级风圈；不自动开跑
    if (this.value) applyInitWindToMember();
  };


  function currentFugenMonth() {
    const el = document.getElementById('fugenMonth');
    return el ? Number(el.value) || 7 : 7;
  }

  function applyFugenMonth(keepSelection) {
    const month = currentFugenMonth();
    state.fugen = G.fugenForMonth(month);
    if (!keepSelection) state.selectedFugen = null;
    state.hole = null;
    if (state.members && state.members[0]) {
      const m = state.members[0];
      state.hole = P.ensureBirthHole(m.lon, m.lat, m.vmax, state.fugen);
    }
    renderFugenList();
    redrawFugen();
    redrawSteer();
    updateStatus();
  }

  document.getElementById('fugenMonth').onchange = function () {
    // 换月只刷新副高/绿黄线，不自动开跑
    applyFugenMonth(false);
  };

  document.getElementById('btnResetFugen').onclick = () => {
    applyFugenMonth(false);
  };

  // 初始绘制
  redrawTerrain();
  redrawFugen();
  redrawSst();
  redrawSteer();
  renderFugenList();
  updateStatus();

  // 默认放置一个示范台风
  placeStorm(140, 15);
})();
