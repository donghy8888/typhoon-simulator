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
    timer: null,
    /** null = 跟随实时末端；数字 = 浏览 track[index]（只读，不改物理） */
    scrubIndex: null,
    /** 副高脊线累计纬向漂移（°，正北负南）；冷空气近中位时近 0 */
    ridgeLatOffset: 0,
    /** 'sim' | 'history' */
    mode: 'sim',
    histYear: null,
    histSelectedId: null,
    histData: null,
    histNameQuery: '',
    /** 登陆地多选（国家/省份 id）；空 = 不限 */
    histPlaces: [],
    histLandfallIndex: null,
    /** 模拟结束后的历史相似匹配 */
    simMatch: null,
    _matchToken: 0
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

  const SIM_MAX_BOUNDS = [[-5, 95], [70, 185]];
  const HIST_MAX_BOUNDS = [[-20, 80], [75, 240]]; // full WP best-tracks (dateline / ET)
  map.setMaxBounds(SIM_MAX_BOUNDS);

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
    storm: L.layerGroup().addTo(map),
    history: L.layerGroup(), // 仅历史模式挂到地图
    matchHist: L.layerGroup() // 模拟结束后淡显相似历史路径
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
    marker: null,
    landfallFlags: []
  };

  function clearStormRefs() {
    layerGroups.track.clearLayers();
    layerGroups.storm.clearLayers();
    stormRefs.trackLine = null;
    stormRefs.windCircles = {};
    stormRefs.intensityMarks = [];
    stormRefs.marker = null;
    stormRefs.landfallFlags = [];
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
      c._tyT = p.t;
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
    // 陆地填充不再手绘：陆掩码已与 OSM 底图海岸对齐；再叠粗填充会「地图对不齐」。
    // 山地：WGS84 elev/NE 数据（物理衰减同源），低透明以免盖住 OSM 海岸。
    G.MOUNTAIN_POLYS.forEach(ring => {
      L.polygon(ring, {
        color: '#6b5344', weight: 0.6, fillColor: '#8b7355', fillOpacity: 0.28,
        interactive: false
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

  /**
   * 冷空气强度：三段 5 日控制，每段 0–5（整数）。
   * 0=弱→脊北漂，5=强→脊南漂；中位≈2.5（默认 3 近中）。
   * 段内恒定；跨段可跳变。t∈[0,5)/[5,10)/[10,15)；≥15d 沿用 10–15 段。
   */
  const WESTERLY_MAX_DRIFT_DEG_PER_DAY = 0.45; // 极端 |率|（°/day）
  const WESTERLY_WOBBLE_AMP = 0.08;            // 近中位微摆 (°/day)
  const WESTERLY_WOBBLE_PERIOD_H = 72;         // ~3 天周期
  const WESTERLY_OFFSET_CLAMP = 8;            // 累计漂移上限 °
  const COLD_SEG_MID = 2.5;                   // 0–5 标尺近中位
  const COLD_SEG_IDS = ['coldSeg0', 'coldSeg1', 'coldSeg2'];

  /** 按模拟日选取冷空气段滑条 0–5 */
  function coldAirLevelFromUI(hours) {
    const days = (hours || 0) / 24;
    let idx = 2;
    if (days < 5) idx = 0;
    else if (days < 10) idx = 1;
    const el = document.getElementById(COLD_SEG_IDS[idx]);
    const v = el ? parseFloat(el.value) : 3;
    if (!isFinite(v)) return COLD_SEG_MID;
    return clamp(v, 0, 5);
  }

  /** 段等级 → 归一化 s∈[-1,1]：弱(−1)…中(0)…强(+1) */
  function westerlyNormFromLevel(level) {
    return clamp((level - COLD_SEG_MID) / COLD_SEG_MID, -1, 1);
  }

  function updateColdSegLabels() {
    COLD_SEG_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      const lab = document.getElementById(id + 'Val');
      if (!el || !lab) return;
      const v = parseFloat(el.value);
      lab.textContent = isFinite(v) ? String(Math.round(v)) : '3';
    });
  }

  /**
   * 脊线纬向漂移率 (°/sim-day)：弱→北(+)、强→南(−)；近中位净漂移≈0 带微摆。
   * 不改 WNW / due-N / ENE 分区规则，只平移副高实体（绿/黄随脊）。
   */
  function ridgeDriftRateDegPerDay(hours) {
    const s = westerlyNormFromLevel(coldAirLevelFromUI(hours));
    // 弱(s=-1)→北；强(s=+1)→南
    let base = -s * WESTERLY_MAX_DRIFT_DEG_PER_DAY;
    // 极近中位再压平（离散档难命中，保留兼容）
    if (Math.abs(s) < 0.06) base *= Math.abs(s) / 0.06;
    const midW = Math.exp(-(s * s) / (2 * 0.22 * 0.22));
    const wobble = WESTERLY_WOBBLE_AMP * Math.sin(2 * Math.PI * (hours || 0) / WESTERLY_WOBBLE_PERIOD_H) * midW;
    return base + wobble;
  }

  /** 对当前副高环施加 dLat，并原地更新多边形/顶点手柄 */
  function applyRidgeLatDrift(dLat) {
    if (!isFinite(dLat) || Math.abs(dLat) < 1e-12) return false;
    const next = clamp((state.ridgeLatOffset || 0) + dLat, -WESTERLY_OFFSET_CLAMP, WESTERLY_OFFSET_CLAMP);
    const applied = next - (state.ridgeLatOffset || 0);
    if (Math.abs(applied) < 1e-12) return false;
    state.ridgeLatOffset = next;
    state.fugen.forEach(function (f) { translateRing(f.ring, 0, applied); });
    state.fugen.forEach(function (f, idx) {
      const poly = fugenPolygons[idx];
      if (poly) applyPolyLatLngs(poly, f);
    });
    if (state.selectedFugen != null) {
      const f = state.fugen[state.selectedFugen];
      if (f) {
        layerGroups.fugen.eachLayer(function (ly) {
          if (ly instanceof L.Marker && ly._fugenVertexIndex != null) {
            const pt = f.ring[ly._fugenVertexIndex];
            if (pt) ly.setLatLng([pt[1], pt[0]]);
          }
        });
      }
    }
    return true;
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
      empty.textContent = '无';
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
      // 与 physics 分区同脊：真副高北缘（max hole/no-hole），避免空圈塌边把绿线画到弧南
      const edge = (P.ridgeGuidingEdgeLat
        ? P.ridgeGuidingEdgeLat(lon, state.fugen, state.hole)
        : G.guidingNorthernEdgeLat(lon, state.fugen, state.hole));
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

  /** 登陆点小红旗（无文字、无 tooltip/popup） */
  function landfallFlagIcon() {
    return L.divIcon({
      className: 'landfall-flag-wrap',
      html: '<div class="landfall-flag" aria-hidden="true">' +
        '<svg width="14" height="16" viewBox="0 0 14 16" xmlns="http://www.w3.org/2000/svg">' +
        '<line x1="2" y1="1" x2="2" y2="15" stroke="#5c4033" stroke-width="1.6" stroke-linecap="round"/>' +
        '<path d="M2.7 1.4 L12.2 5 L2.7 8.6 Z" fill="#c62828" stroke="#8e1b1b" stroke-width="0.45"/>' +
        '</svg></div>',
      iconSize: [14, 16],
      iconAnchor: [2, 15]
    });
  }

  /**
   * 海→陆段上二分逼近海岸线交点（落在陆侧边界），避免旗子挂在海上或深入陆地的轨点。
   * a 必须为海、b 必须为陆。
   */
  function coastCrossingPoint(a, b) {
    let lo = 0;
    let hi = 1;
    let lon = b.lon;
    let lat = b.lat;
    for (let k = 0; k < 20; k++) {
      const m = (lo + hi) * 0.5;
      const x = a.lon + (b.lon - a.lon) * m;
      const y = a.lat + (b.lat - a.lat) * m;
      if (G.isLand(x, y)) {
        hi = m;
        lon = x;
        lat = y;
      } else {
        lo = m;
      }
    }
    const m = hi;
    const tA = +a.t;
    const tB = +b.t;
    const t = (isFinite(tA) && isFinite(tB)) ? (tA + (tB - tA) * m) : tB;
    return { lon: lon, lat: lat, t: t };
  }

  /** 所有海→陆穿越点（海岸交点）；路径截断后仍保留更早登陆点 */
  function ensureLandfallPoints(member) {
    if (!member) return [];
    const track = member.track;
    if (!track || track.length < 2) return member.landfalls || [];

    // 轨长未变则复用（交点已按海岸插值）
    if (member.landfalls && member._landfallScanLen === track.length) {
      return member.landfalls;
    }

    const t0 = track[0] && isFinite(+track[0].t) ? +track[0].t : null;
    const kept = [];
    const seenKey = {};
    function keyOf(lf) {
      return (Math.round((+lf.t || 0) * 1000) / 1000) + ':' +
        (Math.round(+lf.lon * 200) / 200) + ':' + (Math.round(+lf.lat * 200) / 200);
    }
    (member.landfalls || []).forEach(function (lf) {
      if (!lf || !isFinite(lf.lon) || !isFinite(lf.lat)) return;
      // 保留已被 MAX_TRACK 裁掉的早期登陆点
      if (t0 != null && isFinite(+lf.t) && +lf.t < t0 - 1e-6) {
        const k = keyOf(lf);
        if (!seenKey[k]) { kept.push(lf); seenKey[k] = true; }
      }
    });

    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      if (!G.isLand(a.lon, a.lat) && G.isLand(b.lon, b.lat)) {
        const lf = coastCrossingPoint(a, b);
        const k = keyOf(lf);
        if (!seenKey[k]) {
          kept.push(lf);
          seenKey[k] = true;
        }
      }
    }
    kept.sort(function (x, y) { return (+x.t || 0) - (+y.t || 0); });
    member.landfalls = kept;
    member._landfallScanLen = track.length;
    return member.landfalls;
  }

  function syncLandfallFlags(member, untilT) {
    const all = ensureLandfallPoints(member);
    const visible = all.filter(function (lf) {
      return lf && isFinite(lf.lat) && isFinite(lf.lon) &&
        (untilT == null || lf.t <= untilT + 1e-6);
    });

    while (stormRefs.landfallFlags.length > visible.length) {
      const mk = stormRefs.landfallFlags.pop();
      layerGroups.track.removeLayer(mk);
    }

    for (let i = 0; i < visible.length; i++) {
      const lf = visible[i];
      if (i < stormRefs.landfallFlags.length) {
        stormRefs.landfallFlags[i].setLatLng([lf.lat, lf.lon]);
      } else {
        stormRefs.landfallFlags.push(L.marker([lf.lat, lf.lon], {
          icon: landfallFlagIcon(),
          interactive: false,
          keyboard: false,
          zIndexOffset: 200
        }).addTo(layerGroups.track));
      }
    }
  }

  /** 完整重建（放置 / 重置） */
  function redrawStorm() {
    clearStormRefs();
    updateStormInPlace();
  }

  function formatDayLabel(tHours) {
    const t = Math.max(0, +tHours || 0);
    const d = Math.floor(t / 24);
    const h = Math.floor(t % 24);
    return h ? ('Day ' + d + ' · ' + h + 'h') : ('Day ' + d);
  }

  function getMainTrack() {
    return (state.members[0] && state.members[0].track) || [];
  }

  function clearIntensityHighlight() {
    stormRefs.intensityMarks.forEach(function (c) {
      c.setStyle({ radius: 5, weight: 1.2, fillOpacity: 0.92, opacity: 0.95 });
    });
  }

  /** 高亮 scrub 时刻最近的强度圆点；之后的点变淡 */
  function highlightIntensityAt(tHours) {
    let best = -1;
    let bestDt = Infinity;
    stormRefs.intensityMarks.forEach(function (c, i) {
      const tt = c._tyT;
      if (tt == null || tt > tHours + 1e-6) return;
      const dt = Math.abs(tt - tHours);
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    });
    stormRefs.intensityMarks.forEach(function (c, i) {
      const tt = c._tyT;
      const past = tt != null && tt <= tHours + 1e-6;
      const isBest = i === best && past;
      c.setStyle({
        radius: isBest ? 8 : 5,
        weight: isBest ? 2.4 : 1.2,
        fillOpacity: past ? 0.92 : 0.22,
        opacity: past ? 0.95 : 0.28
      });
    });
  }

  function syncTimelineUI() {
    const range = document.getElementById('scrubRange');
    const dayEl = document.getElementById('scrubDayLabel');
    const maxEl = document.getElementById('scrubMaxLabel');
    const wrap = document.getElementById('timelineScrub');
    if (!range) return;
    const track = getMainTrack();
    if (wrap) wrap.classList.toggle('is-scrubbing', state.scrubIndex != null);
    if (track.length < 2) {
      range.disabled = true;
      range.min = '0';
      range.max = '0';
      range.value = '0';
      if (dayEl) dayEl.textContent = 'Day 0';
      if (maxEl) maxEl.textContent = 'Day 0';
      return;
    }
    const liveIdx = track.length - 1;
    const idx = state.scrubIndex != null
      ? Math.max(0, Math.min(liveIdx, state.scrubIndex))
      : liveIdx;
    range.disabled = false;
    range.min = '0';
    range.max = String(liveIdx);
    range.value = String(idx);
    if (dayEl) dayEl.textContent = formatDayLabel(track[idx].t);
    if (maxEl) maxEl.textContent = formatDayLabel(track[liveIdx].t);
  }

  /** 进入路径回看；离开末端即暂停。scrub 只读，不改成员物理状态。 */
  function setScrubIndex(idx) {
    const track = getMainTrack();
    if (track.length < 2) {
      state.scrubIndex = null;
      syncTimelineUI();
      return;
    }
    idx = Math.max(0, Math.min(track.length - 1, idx | 0));
    if (idx >= track.length - 1) {
      state.scrubIndex = null;
    } else {
      state.scrubIndex = idx;
      if (state.running && !state.paused) {
        state.paused = true;
        const btn = document.getElementById('btnPause');
        if (btn) btn.textContent = '继续';
      }
    }
    updateStormInPlace();
    updateStatus();
  }

  function exitScrubView() {
    if (state.scrubIndex == null) {
      syncTimelineUI();
      return;
    }
    state.scrubIndex = null;
    updateStormInPlace();
    updateStatus();
  }

  /**
   * 风圈振幅用的平移 UV（|V|）：优先路径折线（眼所见蓝线移速），
   * 其次轨迹上最近非零 u/v，再次引导气流，最后瞬时物理。
   * 峰锁地理正东（路径线东侧），UV 不决定鼓向。
   * 初生/停滞时用引导向量抬振幅，避免风圈仍是正圆误导。
   */
  function windEnvelopeMotionUV(main, track, idx, physU, physV) {
    const i = Math.max(0, idx | 0);
    const lat = (track[i] && track[i].lat != null) ? track[i].lat : (main && main.lat);
    const lon = (track[i] && track[i].lon != null) ? track[i].lon : (main && main.lon);
    const fromTrack = G.windMotionUVFromTrack(track, i);
    if (fromTrack && Math.hypot(fromTrack.u, fromTrack.v) >= 0.25) {
      // 路径方向清晰但极慢时，用引导/物理速度抬振幅，朝向仍跟蓝线
      const sp = Math.hypot(fromTrack.u, fromTrack.v);
      if (sp >= 1.2) return fromTrack;
      let floorSp = Math.hypot(+physU || 0, +physV || 0);
      try {
        const st = P.steeringAt(lon, lat, cfgFromUI(), state.fugen, state.hole);
        floorSp = Math.max(floorSp, Math.hypot(st.u || 0, st.v || 0));
      } catch (e) { /* ignore */ }
      if (floorSp > sp + 0.15) {
        const k = floorSp / sp;
        return { u: fromTrack.u * k, v: fromTrack.v * k };
      }
      return fromTrack;
    }
    for (let k = i; k >= 0; k--) {
      const p = track[k];
      if (!p) continue;
      const u = p.u, v = p.v;
      if (u != null && v != null && Math.hypot(u, v) >= 0.4) return { u: u, v: v };
    }
    try {
      const st = P.steeringAt(lon, lat, cfgFromUI(), state.fugen, state.hole);
      if (Math.hypot(st.u || 0, st.v || 0) >= 0.25) return { u: st.u, v: st.v };
    } catch (e) { /* ignore */ }
    if (main && Math.hypot(main.u || 0, main.v || 0) >= 0.25) {
      return { u: main.u, v: main.v };
    }
    return { u: +physU || 0, v: +physV || 0 };
  }

    /** tick 时原地更新：setLatLng / setLatLngs / setRadius，避免每小时 clear+重建 */
  function updateStormInPlace() {
    if (!state.members.length) {
      clearStormRefs();
      syncTimelineUI();
      return;
    }

    const main = state.members[0];
    const track = main.track || [];
    const liveIdx = Math.max(0, track.length - 1);
    const scrubbing = state.scrubIndex != null && track.length > 0;
    const idx = scrubbing
      ? Math.max(0, Math.min(liveIdx, state.scrubIndex))
      : liveIdx;
    const view = track.length ? track[idx] : null;
    const dLat = view ? view.lat : main.lat;
    const dLon = view ? view.lon : main.lon;
    const dVmax = view ? view.vmax : main.vmax;
    const dT = view ? view.t : state.hours;

    if (track.length >= 1) {
      const slice = scrubbing ? track.slice(0, idx + 1) : track;
      const latlngs = slice.map(function (p) { return [p.lat, p.lon]; });
      if (latlngs.length >= 2) {
        if (stormRefs.trackLine) {
          stormRefs.trackLine.setLatLngs(latlngs);
        } else {
          stormRefs.trackLine = L.polyline(latlngs, {
            color: '#2980b9', weight: 2.5
          }).addTo(layerGroups.track);
        }
      } else if (stormRefs.trackLine) {
        layerGroups.track.removeLayer(stormRefs.trackLine);
        stormRefs.trackLine = null;
      }
      syncIntensityMarks(track);
      syncLandfallFlags(main, scrubbing ? dT : null);

      const showRings = scrubbing
        ? (dVmax >= P.DISSIPATE_MS)
        : (main.alive || main.vmax >= P.DISSIPATE_MS);
      // 风圈 UV：只供振幅；峰锁路径线地理东侧；初生回退引导气流
      const physU = (view && view.u != null) ? view.u : (main.u || 0);
      const physV = (view && view.v != null) ? view.v : (main.v || 0);
      const envUV = windEnvelopeMotionUV(main, track, idx, physU, physV);
      const dU = envUV.u;
      const dV = envUV.v;
      const rings = showRings ? G.windRadiiForGrades(dVmax) : [];
      const seen = {};
      rings.forEach(function (ring) {
        seen[ring.grade] = true;
        // 十二级：正圆（amp=0）；七/十级：保留东侧鼓起的 CMA 阶梯包络
        const ampOv = (ring.grade === 12) ? 0 : null;
        const latlngs = G.windEnvelopeLatLngs(dLat, dLon, ring.radiusDeg, dU, dV, dVmax, 64, ampOv);
        const existing = stormRefs.windCircles[ring.grade];
        const tip = ring.label + ' · 当时 ' + G.gradeLabel(dVmax);
        const style = {
          color: ring.color,
          weight: ring.weight,
          fillColor: ring.fill,
          fillOpacity: ring.fillOpacity
        };
        // 非对称包络用 polygon（非同心圆）；旧 circle 层则替换
        if (existing && existing.setLatLngs) {
          existing.setLatLngs(latlngs);
          existing.setStyle(style);
          if (existing.setTooltipContent) existing.setTooltipContent(tip);
          else if (existing.getTooltip()) existing.getTooltip().setContent(tip);
        } else {
          if (existing) layerGroups.track.removeLayer(existing);
          stormRefs.windCircles[ring.grade] = L.polygon(latlngs, style)
            .bindTooltip(tip, { sticky: true })
            .addTo(layerGroups.track);
        }
      });
      Object.keys(stormRefs.windCircles).forEach(function (g) {
        if (!seen[g]) {
          layerGroups.track.removeLayer(stormRefs.windCircles[g]);
          delete stormRefs.windCircles[g];
        }
      });

      if (scrubbing) highlightIntensityAt(dT);
      else clearIntensityHighlight();
    }

    if (stormRefs.marker) {
      stormRefs.marker.setLatLng([dLat, dLon]);
    } else {
      stormRefs.marker = L.marker([dLat, dLon], { icon: stormIcon() })
        .addTo(layerGroups.storm);
    }
    syncTimelineUI();
  }

  function updateStatus() {
    const clock = document.getElementById('clockBar');
    const track = getMainTrack();
    let showHours = state.hours;
    if (state.scrubIndex != null && track.length) {
      const i = Math.max(0, Math.min(track.length - 1, state.scrubIndex));
      showHours = track[i].t;
    }
    const days = Math.floor(showHours / 24);
    const hrs = Math.floor(showHours % 24);
    const mins = Math.floor((showHours * 60) % 60);
    const timeStr = '第 ' + days + ' 天 ' + hrs + ' 小时' + (mins ? (' ' + mins + ' 分') : '');

    if (!state.members.length) {
      clock.textContent = '模拟时钟：未开始';
      return;
    }

    const m = state.members[0];
    let clockExtra = '';
    if (state.scrubIndex != null) {
      clockExtra = '（回看）';
    } else if (!m.alive) {
      clockExtra = ' · 已消亡';
    } else if (state.paused) {
      clockExtra = '（暂停）';
    } else if (state.running) {
      clockExtra = '（运行中）';
    }
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

    clearSimMatch();
    state.hole = P.ensureBirthHole(lon, lat, vmax, state.fugen);
    state.hours = 0;
    state.scrubIndex = null;
    state.members = [];

    // 初生即用引导气流速度画东侧鼓起的非对称风圈（勿等开跑后才鼓起）
    let birthU = 0, birthV = 0;
    try {
      const st0 = P.steeringAt(lon, lat, cfgFromUI(), state.fugen, state.hole);
      birthU = st0.u || 0;
      birthV = st0.v || 0;
    } catch (e) {
      birthU = -3;
      birthV = 1.5;
    }
    const main = {
      lon, lat, vmax, alive: true, track: [{ lon, lat, vmax, t: 0, u: birthU, v: birthV }],
      phase: '待启动', sst: G.getSst(lon, lat, state.sstRegions), u: birthU, v: birthV,
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

    // 冷空气强度 → 副高脊缓慢南北漂移（绿/黄随实体）
    const driftRate = ridgeDriftRateDegPerDay(state.hours);
    const drifted = applyRidgeLatDrift(driftRate * (dt / 24));

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
    // 脊漂移会改绿/黄线与引导场；即使空圈已消失也要节流刷新
    if (drifted) redrawSteerThrottled();
    updateStatus();

    if (!state.members[0].alive) {
      stopSim();
      document.getElementById('clockBar').textContent += ' · 结束';
      runSimilarityMatch();
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

    // 回看只读：开始后回到实时末端继续积分
    state.scrubIndex = null;
    clearSimMatch();
    closeIntroPanel();
    state.running = true;
    state.paused = false;
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnPause').disabled = false;
    document.getElementById('btnPause').textContent = '暂停';

    if (state.timer) clearInterval(state.timer);
    const baseMs = 400;
    const interval = Math.max(40, baseMs / state.speed);
    state.timer = setInterval(tick, interval);
    updateStormInPlace();
    updateStatus();
  }

  function pauseSim() {
    if (!state.running) return;
    state.paused = !state.paused;
    // 「继续」退出回看，恢复实时显示
    if (!state.paused) {
      state.scrubIndex = null;
      updateStormInPlace();
    }
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
    clearSimMatch();
    closeIntroPanel();
    state.hours = 0;
    state.members = [];
    state.hole = null;
    state.scrubIndex = null;
    _lastSteerHoleRadius = null;
    _lastSteerHolePresent = false;
    clearStormRefs();
    // 副高全量重绘（会清 holeCircleLayer）；共用 steerRenderer，无孤儿 canvas
    redrawFugen();
    syncTimelineUI();
    updateStatus();
  }

  // —— 事件 ——
  map.on('click', function (e) {
    if (state.mode === 'history') return;
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

  (function wireTimelineScrub() {
    const range = document.getElementById('scrubRange');
    if (!range) return;
    function onScrub() {
      setScrubIndex(parseInt(range.value, 10) || 0);
    }
    range.addEventListener('input', onScrub);
    range.addEventListener('change', onScrub);
  })();


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
    if (state.mode === 'history') redrawHistoryTracks();
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
    state.ridgeLatOffset = 0;
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

  (function wireColdAirSegments() {
    function onChange() { updateColdSegLabels(); }
    COLD_SEG_IDS.forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', onChange);
      el.addEventListener('change', onChange);
    });
    updateColdSegLabels();
  })();

  // —— 台风纪录（历史模式）——
  const H = window.TyHistory;
  const INTRO = window.TyIntros;

  function clearMatchOverlay() {
    if (layerGroups.matchHist) layerGroups.matchHist.clearLayers();
    if (map.hasLayer(layerGroups.matchHist)) map.removeLayer(layerGroups.matchHist);
  }

  function hideMatchChip() {
    const chip = document.getElementById('matchChip');
    if (chip) chip.hidden = true;
  }

  function showMatchChip(labelText) {
    const chip = document.getElementById('matchChip');
    const btn = document.getElementById('matchChipBtn');
    if (!chip || !btn) return;
    btn.textContent = labelText || '最像：—';
    chip.hidden = false;
  }

  function closeIntroPanel() {
    const panel = document.getElementById('introPanel');
    if (panel) panel.hidden = true;
  }

  function openIntroPanel(model) {
    if (!model) return;
    const panel = document.getElementById('introPanel');
    const title = document.getElementById('introTitle');
    const meta = document.getElementById('introMeta');
    const text = document.getElementById('introText');
    const dmg = document.getElementById('introDamage');
    if (!panel) return;
    if (title) title.textContent = model.title || '台风简介';
    let metaHtml = '';
    if (model.zh || model.name) {
      metaHtml += '<strong>' + (model.zh || model.name) + '</strong>';
      if (model.zh && model.name) metaHtml += '（' + model.name + '）';
    }
    if (model.year) metaHtml += (metaHtml ? ' · ' : '') + model.year + ' 年';
    if (model.maxVmax != null) metaHtml += ' · 峰值 ' + Number(model.maxVmax).toFixed(0) + ' m/s';
    if (meta) meta.innerHTML = metaHtml || '—';
    if (text) text.textContent = model.intro || '';
    if (dmg) dmg.textContent = model.damage || '破坏损失：本库暂未收录该台风的公开损失摘要';
    panel.hidden = false;
  }

  function openIntroForStorm(storm, extras) {
    if (!INTRO || !storm) return;
    openIntroPanel(INTRO.buildPanelModel(storm, extras || {}));
  }

  function openIntroForMatch(match) {
    if (!match) return;
    // Prefer curated by IBTrACS id; fall back to auto from match metadata
    if (INTRO) {
      const fakeStorm = {
        id: match.id,
        name: match.name,
        season: match.year,
        maxVmax: match.maxVmax,
        points: []
      };
      openIntroPanel(INTRO.buildPanelModel(fakeStorm, {
        id: match.id,
        name: match.name,
        year: match.year,
        maxVmax: match.maxVmax,
        durationH: match.durationH
      }));
      return;
    }
    openIntroPanel({
      title: match.label,
      zh: match.zh,
      name: match.name,
      year: match.year,
      maxVmax: match.maxVmax,
      intro: (match.label || '') + '。峰值风速约 ' + (match.maxVmax != null ? Number(match.maxVmax).toFixed(0) + ' m/s' : '—') + '。',
      damage: '破坏损失：本库暂未收录该台风的公开损失摘要'
    });
  }

  function clearSimMatch() {
    state.simMatch = null;
    state._matchToken = (state._matchToken || 0) + 1;
    hideMatchChip();
    clearMatchOverlay();
    if (state.mode !== 'history') closeIntroPanel();
  }

  function runSimilarityMatch() {
    if (!H || typeof H.findBestMatch !== 'function') return;
    if (state.mode !== 'sim') return;
    const track = getMainTrack();
    if (!track || track.length < 4) return;
    const monthEl = document.getElementById('fugenMonth');
    const month = monthEl ? (parseInt(monthEl.value, 10) || null) : null;
    const maxV = H.peakVmaxFromTrack ? H.peakVmaxFromTrack(track) : null;
    const token = (state._matchToken || 0) + 1;
    state._matchToken = token;
    H.findBestMatch(track, { month: month, maxVmax: maxV }).then(function (match) {
      if (token !== state._matchToken) return; // stale
      if (state.mode !== 'sim') return;
      if (!match) return;
      state.simMatch = match;
      showMatchChip(match.labelText);
      if (!map.hasLayer(layerGroups.matchHist)) layerGroups.matchHist.addTo(map);
      H.drawMatchOverlay(layerGroups.matchHist, match, { opacity: 0.42, weight: 2.4 });
    }).catch(function () { /* ignore */ });
  }

  function histPlacesSelected() {
    return (state.histPlaces && state.histPlaces.length) ? state.histPlaces.slice() : [];
  }

  function ensureHistPlaceChips() {
    if (!H || typeof H.loadLandfallIndex !== 'function') return Promise.resolve(null);
    if (state.histLandfallIndex && document.getElementById('histPlaceCountries') &&
        document.getElementById('histPlaceCountries').childElementCount) {
      return Promise.resolve(state.histLandfallIndex);
    }
    return H.loadLandfallIndex().then(function (idx) {
      state.histLandfallIndex = idx;
      renderHistPlaceChips(idx);
      return idx;
    }).catch(function () {
      return null;
    });
  }

  function renderHistPlaceChips(idx) {
    const cat = H.placeCatalog ? H.placeCatalog(idx) : { countries: [], provinces: [] };
    function fill(elId, list) {
      const el = document.getElementById(elId);
      if (!el) return;
      el.innerHTML = '';
      (list || []).forEach(function (p) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hist-place-chip';
        btn.dataset.place = p.id;
        btn.textContent = p.id;
        btn.setAttribute('aria-pressed', 'false');
        if (state.histPlaces && state.histPlaces.indexOf(p.id) !== -1) {
          btn.classList.add('is-on');
          btn.setAttribute('aria-pressed', 'true');
        }
        btn.addEventListener('click', function () {
          toggleHistPlace(p.id);
        });
        el.appendChild(btn);
      });
    }
    fill('histPlaceCountries', cat.countries);
    fill('histPlaceProvinces', cat.provinces);
  }

  function syncHistPlaceChipState() {
    const selected = histPlacesSelected();
    document.querySelectorAll('.hist-place-chip').forEach(function (btn) {
      const on = selected.indexOf(btn.dataset.place) !== -1;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function toggleHistPlace(id) {
    if (!id) return;
    const cur = histPlacesSelected();
    const i = cur.indexOf(id);
    if (i === -1) cur.push(id);
    else cur.splice(i, 1);
    state.histPlaces = cur;
    syncHistPlaceChipState();
    applyHistFilters({ allowJump: false });
  }

  function clearHistPlaces() {
    state.histPlaces = [];
    syncHistPlaceChipState();
    applyHistFilters({ allowJump: false });
  }

  function applyHistFilters(opts) {
    opts = opts || {};
    // name filter may cross-year jump; place filter stays in-year
    applyHistNameFilter(opts);
  }

    function populateHistYears() {
    const sel = document.getElementById('histYear');
    if (!sel || !H) return;
    sel.innerHTML = '';
    H.yearsList().forEach(function (y) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y) + ' 年';
      sel.appendChild(opt);
    });
    // 默认近年有完整纪录的年份
    sel.value = '2019';
  }

  function histQuery() {
    const el = document.getElementById('histNameQ');
    return el ? String(el.value || '').trim() : (state.histNameQuery || '');
  }

  function populateHistStorms(data, keepId) {
    const sel = document.getElementById('histStorm');
    if (!sel) return;
    const q = histQuery();
    const places = histPlacesSelected();
    const storms = (H && data && data.storms)
      ? H.filterStorms(data.storms, q, places, state.histLandfallIndex)
      : ((data && data.storms) || []);
    const prev = keepId != null ? keepId : (sel.value || '');
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    const total = (data && data.storms) ? data.storms.length : 0;
    if (q || places.length) {
      all.textContent = '（匹配 ' + storms.length + ' / ' + total + '）';
    } else {
      all.textContent = '（全部 · ' + total + ' 个）';
    }
    sel.appendChild(all);
    storms.forEach(function (s) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const peak = s.maxVmax != null ? (' · ' + s.maxVmax.toFixed(0) + 'm/s') : '';
      const label = H ? H.stormLabel(s) : (s.name || 'UNNAMED');
      opt.textContent = label + peak;
      sel.appendChild(opt);
    });
    if (prev && storms.some(function (s) { return s.id === prev; })) {
      sel.value = prev;
    } else {
      sel.value = '';
    }
  }

  function setHistStatus(msg) {
    const el = document.getElementById('histStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setHistMeta(data, selectedId) {
    const el = document.getElementById('histMeta');
    if (!el) return;
    if (!data) { el.innerHTML = ''; return; }
    const places = histPlacesSelected();
    const q = histQuery();
    let shown = data.count;
    if (H && (q || places.length)) {
      shown = H.filterStorms(data.storms || [], q, places, state.histLandfallIndex).length;
    }
    let html = '<strong>' + data.year + '</strong> 年 · ' +
      ((q || places.length) ? (shown + ' / ' + data.count) : data.count) + ' 个热带气旋';
    if (places.length) {
      html += '<br>登陆筛选：<strong>' + places.join('、') + '</strong>';
    }
    if (selectedId) {
      const s = (data.storms || []).find(function (x) { return x.id === selectedId; });
      if (s) {
        const label = H ? H.stormLabel(s) : (s.name || 'UNNAMED');
        html += '<br>当前：<strong>' + label + '</strong> · 峰值 ' +
          (s.maxVmax != null ? s.maxVmax.toFixed(1) + ' m/s' : '—') +
          ' · ' + (s.points ? s.points.length : 0) + ' 点';
      }
    } else {
      html += '<br><span style="color:#5a6a7a">点击路径或下拉选中单台（其余隐藏）；再点或「全部」恢复</span>';
    }
    el.innerHTML = html;
  }

  function selectHistStorm(id, opts) {
    opts = opts || {};
    // 再点同一台 → 取消选中，恢复全年
    if (id && state.histSelectedId === id && opts.toggle !== false) {
      id = null;
    }
    state.histSelectedId = id || null;
    const sel = document.getElementById('histStorm');
    if (sel) sel.value = state.histSelectedId || '';
    redrawHistoryTracks();
    if (state.histSelectedId && state.histData && opts.fit !== false) {
      const storm = (state.histData.storms || []).find(function (s) { return s.id === state.histSelectedId; });
      if (storm && H) H.fitStorm(map, storm);
    }
    setHistMeta(state.histData, state.histSelectedId);
    if (state.histSelectedId) {
      const s = (state.histData.storms || []).find(function (x) { return x.id === state.histSelectedId; });
      setHistStatus('已选中：' + (s && H ? H.stormLabel(s) : ((s && s.name) || 'UNNAMED')) + ' · 再点路径或「全部」可取消');
      if (s) openIntroForStorm(s);
    } else {
      setHistStatus('只读 · IBTrACS WP · ' + (state.histYear || '') + ' 年 · 点选路径或下拉单台');
      closeIntroPanel();
    }
  }

  function redrawHistoryTracks() {
    if (!H || !state.histData) return;
    const q = histQuery();
    const places = histPlacesSelected();
    H.drawYear(layerGroups.history, state.histData, {
      scale: getIntensityScale(),
      selectedId: state.histSelectedId,
      hideOthers: true,
      filterQuery: q,
      filterPlaces: places,
      landfallIndex: state.histLandfallIndex,
      onSelect: function (id) {
        selectHistStorm(id, { toggle: true, fit: true });
      }
    });
    setHistMeta(state.histData, state.histSelectedId);
  }

  function loadHistYear(year, opts) {
    if (!H) return;
    opts = opts || {};
    const y = year | 0;
    const pending = state._histPendingSelect || null;
    state._histPendingSelect = null;
    state.histYear = y;
    state.histSelectedId = null;
    setHistStatus('加载 ' + y + ' 年纪录…');
    H.loadYear(y).then(function (data) {
      state.histData = data;
      const q = histQuery();
      const places = histPlacesSelected();
      const matches = H.filterStorms(data.storms || [], q, places, state.histLandfallIndex);
      let pickId = null;
      if (pending && (data.storms || []).some(function (s) { return s.id === pending; })) {
        pickId = pending;
      } else if (q && !places.length && matches.length === 1) {
        pickId = matches[0].id;
      } else if (matches.length === 1 && (q || places.length)) {
        pickId = matches[0].id;
      }
      populateHistStorms(data, pickId || '');
      if (pickId) {
        selectHistStorm(pickId, { toggle: false, fit: true });
        if (opts.crossYearNote) setHistStatus(opts.crossYearNote);
      } else if (matches.length > 1 && (q || places.length)) {
        redrawHistoryTracks();
        const placeNote = places.length ? ('登陆:' + places.join('/') + ' · ') : '';
        const nameNote = q ? ('「' + q + '」') : '';
        setHistStatus(placeNote + nameNote + '本年度匹配 ' + matches.length + ' 个 · 下拉或点选');
        fitHistYearEnvelope(data, matches);
      } else if (matches.length === 0 && (q || places.length)) {
        redrawHistoryTracks();
        if (q && !places.length && !opts.skipJump) {
          setHistStatus('本年度无「' + q + '」· 正在跨年检索…');
          jumpToNameMatch(q, y);
        } else if (places.length) {
          setHistStatus('本年度无匹配登陆地（' + places.join('、') + '）' + (q ? ' +「' + q + '」' : ''));
        } else {
          setHistStatus('本年度无匹配「' + q + '」');
        }
      } else {
        redrawHistoryTracks();
        setHistStatus('只读 · IBTrACS WP · ' + y + ' 年已加载');
        fitHistYearEnvelope(data, null);
      }
    }).catch(function (err) {
      setHistStatus('加载失败：' + (err && err.message ? err.message : err));
    });
  }

  function fitHistYearEnvelope(data, stormSubset) {
    try {
      const all = [];
      const list = stormSubset || (data && data.storms) || [];
      list.forEach(function (s) {
        (s.points || []).forEach(function (p) { all.push([p.lat, p.lon]); });
      });
      if (all.length >= 2) map.fitBounds(L.latLngBounds(all).pad(0.08), { maxZoom: 5, animate: true });
    } catch (e) { /* ignore */ }
  }

  function jumpToNameMatch(q, excludeYear) {
    if (!H || !q) return;
    if (state._histJumping) return;
    state._histJumping = true;
    H.searchNameIndex(q).then(function (hits) {
      state._histJumping = false;
      const others = hits.filter(function (h) { return h.y !== excludeYear; });
      if (!hits.length) {
        setHistStatus('未找到中文名/英文名含「' + q + '」的纪录（覆盖 WMO 名单及除名台风）');
        return;
      }
      const pick = others[0] || hits[0];
      const yEl = document.getElementById('histYear');
      if (yEl) yEl.value = String(pick.y);
      state._histPendingSelect = pick.id;
      const note = '跨年定位：' + pick.zh + ' (' + pick.n + ') · ' + pick.y +
        (hits.length > 1 ? (' · 共 ' + hits.length + ' 条') : '');
      loadHistYear(pick.y, { skipJump: true, crossYearNote: note });
    }).catch(function () {
      state._histJumping = false;
      setHistStatus('跨年检索不可用');
    });
  }

  function applyHistNameFilter(opts) {
    opts = opts || {};
    const q = histQuery();
    const places = histPlacesSelected();
    state.histNameQuery = q;
    if (!state.histData) return;
    populateHistStorms(state.histData, state.histSelectedId);
    const matches = H.filterStorms(state.histData.storms || [], q, places, state.histLandfallIndex);
    if (!q && !places.length) {
      redrawHistoryTracks();
      setHistStatus('只读 · IBTrACS WP · ' + (state.histYear || '') + ' 年 · 点选路径或下拉单台');
      return;
    }
    if (matches.length === 1) {
      selectHistStorm(matches[0].id, { toggle: false, fit: true });
      return;
    }
    if (matches.length > 1) {
      if (state.histSelectedId && !matches.some(function (s) { return s.id === state.histSelectedId; })) {
        state.histSelectedId = null;
        const sel = document.getElementById('histStorm');
        if (sel) sel.value = '';
      }
      redrawHistoryTracks();
      const bits = [];
      if (places.length) bits.push('登陆:' + places.join('/'));
      if (q) bits.push('「' + q + '」');
      setHistStatus(bits.join(' · ') + ' 本年度匹配 ' + matches.length + ' 个');
      return;
    }
    redrawHistoryTracks();
    if (q && !places.length && opts.allowJump !== false) {
      setHistStatus('本年度无「' + q + '」· 正在跨年检索…');
      jumpToNameMatch(q, state.histYear);
    } else if (places.length) {
      setHistStatus('本年度无匹配登陆地（' + places.join('、') + '）' + (q ? ' +「' + q + '」' : ''));
    } else {
      setHistStatus('本年度无匹配「' + q + '」');
    }
  }

  function enterHistoryMode() {
    if (state.mode === 'history') return;
    stopSim();
    clearSimMatch();
    closeIntroPanel();
    state.mode = 'history';
    document.body.classList.add('mode-history');
    document.getElementById('btnModeSim').classList.remove('is-active');
    document.getElementById('btnModeSim').classList.add('secondary');
    document.getElementById('btnModeSim').classList.remove('primary');
    document.getElementById('btnModeHistory').classList.add('is-active');
    document.getElementById('btnModeHistory').classList.remove('secondary');
    document.getElementById('btnModeHistory').classList.add('primary');

    // 隐藏模拟风暴图层 + 副高/海温/引导（纪录模式不显示环境场）
    if (map.hasLayer(layerGroups.track)) map.removeLayer(layerGroups.track);
    if (map.hasLayer(layerGroups.storm)) map.removeLayer(layerGroups.storm);
    if (map.hasLayer(layerGroups.fugen)) map.removeLayer(layerGroups.fugen);
    if (map.hasLayer(layerGroups.sst)) map.removeLayer(layerGroups.sst);
    if (map.hasLayer(layerGroups.steer)) map.removeLayer(layerGroups.steer);
    if (!map.hasLayer(layerGroups.history)) layerGroups.history.addTo(map);
    map.setMaxBounds(HIST_MAX_BOUNDS);
    try { map.setMinZoom(2); } catch (e) { /* ignore */ }

    const clock = document.getElementById('clockBar');
    if (clock) clock.textContent = '台风纪录';
    const tb = document.getElementById('mapToolbar');
    if (tb) { tb.textContent = ''; tb.hidden = true; }

    populateHistYears();
    const yEl = document.getElementById('histYear');
    const y = yEl ? (parseInt(yEl.value, 10) || 2019) : 2019;
    ensureHistPlaceChips().then(function () {
      loadHistYear(y);
    });
  }

  function exitHistoryMode() {
    if (state.mode !== 'history') return;
    state.mode = 'sim';
    document.body.classList.remove('mode-history');
    document.getElementById('btnModeHistory').classList.remove('is-active');
    document.getElementById('btnModeHistory').classList.add('secondary');
    document.getElementById('btnModeHistory').classList.remove('primary');
    document.getElementById('btnModeSim').classList.add('is-active');
    document.getElementById('btnModeSim').classList.add('primary');
    document.getElementById('btnModeSim').classList.remove('secondary');

    if (H) H.clear(layerGroups.history);
    if (map.hasLayer(layerGroups.history)) map.removeLayer(layerGroups.history);
    if (!map.hasLayer(layerGroups.track)) layerGroups.track.addTo(map);
    if (!map.hasLayer(layerGroups.storm)) layerGroups.storm.addTo(map);
    if (!map.hasLayer(layerGroups.fugen)) layerGroups.fugen.addTo(map);
    if (!map.hasLayer(layerGroups.sst)) layerGroups.sst.addTo(map);
    if (!map.hasLayer(layerGroups.steer)) layerGroups.steer.addTo(map);
    map.setMaxBounds(SIM_MAX_BOUNDS);
    try { map.setMinZoom(3); } catch (e) { /* ignore */ }
    state.histData = null;
    state.histSelectedId = null;
    state.histNameQuery = '';
    state.histPlaces = [];
    state._histPendingSelect = null;
    state._histJumping = false;
    const nq = document.getElementById('histNameQ');
    if (nq) nq.value = '';
    syncHistPlaceChipState();
    closeIntroPanel();

    const tb = document.getElementById('mapToolbar');
    if (tb) { tb.textContent = ''; tb.hidden = true; }
    updateStormInPlace();
    updateStatus();
  }

  document.getElementById('btnModeHistory').onclick = enterHistoryMode;
  document.getElementById('btnModeSim').onclick = exitHistoryMode;
  document.getElementById('btnHistBack').onclick = exitHistoryMode;
  document.getElementById('histYear').onchange = function () {
    loadHistYear(parseInt(this.value, 10), { skipJump: true });
  };
  document.getElementById('histStorm').onchange = function () {
    selectHistStorm(this.value || null, { toggle: false, fit: !!this.value });
  };
  document.getElementById('btnHistClear').onclick = function () {
    selectHistStorm(null, { toggle: false, fit: false });
  };
  const btnHistPlaceClear = document.getElementById('btnHistPlaceClear');
  if (btnHistPlaceClear) {
    btnHistPlaceClear.onclick = function () { clearHistPlaces(); };
  }

  (function wireHistNameSearch() {
    const el = document.getElementById('histNameQ');
    if (!el) return;
    let t = null;
    el.addEventListener('input', function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () { applyHistNameFilter({ allowJump: false }); }, 180);
    });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (t) clearTimeout(t);
        applyHistNameFilter({ allowJump: true });
      }
    });
    el.addEventListener('search', function () {
      // clear (x) button
      applyHistNameFilter({ allowJump: false });
    });
  })();
  document.getElementById('btnHistFit').onclick = function () {
    if (!state.histData) return;
    if (state.histSelectedId) {
      const storm = (state.histData.storms || []).find(function (s) { return s.id === state.histSelectedId; });
      if (storm && H) H.fitStorm(map, storm);
      return;
    }
    const q = histQuery();
    const places = histPlacesSelected();
    const list = H
      ? H.filterStorms(state.histData.storms || [], q, places, state.histLandfallIndex)
      : (state.histData.storms || []);
    fitHistYearEnvelope(state.histData, list);
  };

  // 最像芯片 / 简介面板
  (function wireIntroUi() {
    const btn = document.getElementById('matchChipBtn');
    if (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (state.simMatch) openIntroForMatch(state.simMatch);
      });
    }
    const closeBtn = document.getElementById('introClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        closeIntroPanel();
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeIntroPanel();
    });
  })();

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
