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
    timer: null
  };

  // —— 地图 ——
  const map = L.map('map', {
    center: [22, 135],
    zoom: 4,
    minZoom: 3,
    maxZoom: 8,
    worldCopyJump: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 8
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
    color: '#666', weight: 1, fill: false, dashArray: '4 3'
  }).addTo(map);

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

  // —— 副高绘制（含空洞近似：用 polygon with hole 若支持） ——
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

  function redrawFugen() {
    layerGroups.fugen.clearLayers();
    fugenPolygons = [];
    if (!state.layers.fugen) return;

    state.fugen.forEach((f, idx) => {
      const outer = ringToLatLng(f.ring);
      let latlngs = outer;
      // Leaflet polygon with hole: [outer, hole1, ...]
      if (state.hole && state.hole.fugenId === f.id) {
        latlngs = [outer, circleHoleLatLngs(state.hole)];
      }
      const poly = L.polygon(latlngs, {
        color: '#6b3fa0',
        weight: 1.5,
        fillColor: '#c9a0dc',
        fillOpacity: 0.4,
        pmIgnore: false
      }).addTo(layerGroups.fugen);

      poly.bindTooltip(f.name, { sticky: true });
      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectFugen(idx);
      });

      // 可拖角点（简单编辑）
      if (state.selectedFugen === idx) {
        f.ring.forEach((pt, pi) => {
          const marker = L.circleMarker([pt[1], pt[0]], {
            radius: 5, color: '#333', fillColor: '#fff', fillOpacity: 1, weight: 1
          }).addTo(layerGroups.fugen);
          marker.on('mousedown', function (ev) {
            L.DomEvent.stopPropagation(ev);
            map.dragging.disable();
            function onMove(e2) {
              const ll = e2.latlng;
              f.ring[pi] = [ll.lng, ll.lat];
              redrawFugen();
              renderFugenList();
            }
            function onUp() {
              map.off('mousemove', onMove);
              map.off('mouseup', onUp);
              map.dragging.enable();
              redrawFugen();
            }
            map.on('mousemove', onMove);
            map.on('mouseup', onUp);
          });
        });
      }
      fugenPolygons.push(poly);
    });

    // 空洞描边提示
    if (state.hole && state.layers.fugen) {
      L.circle([state.hole.lat, state.hole.lon], {
        radius: state.hole.radiusDeg * 111320,
        color: '#8e44ad',
        weight: 2,
        dashArray: '6 4',
        fillOpacity: 0
      }).bindTooltip('副高空圈（随风圈变化）').addTo(layerGroups.fugen);
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
    state.fugen.forEach((f, idx) => {
      const div = document.createElement('div');
      div.className = 'fugen-item';
      div.innerHTML = '<span>' + (state.selectedFugen === idx ? '▶ ' : '') + f.name + '</span>';
      const btnSel = document.createElement('button');
      btnSel.type = 'button';
      btnSel.textContent = '选中';
      btnSel.onclick = () => selectFugen(idx);
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = '删除';
      btnDel.onclick = () => {
        state.fugen.splice(idx, 1);
        if (state.selectedFugen === idx) state.selectedFugen = null;
        renderFugenList();
        redrawFugen();
      };
      div.appendChild(btnSel);
      div.appendChild(btnDel);
      el.appendChild(div);
    });
  }

  // —— SST 等值线（按区域框画 26.5 / 28 边界示意） ——
  function redrawSst() {
    layerGroups.sst.clearLayers();
    if (!state.layers.sst) return;

    state.sstRegions.forEach(r => {
      const bounds = [[r.lat0, r.lon0], [r.lat1, r.lon1]];
      // 区域淡色
      let fill = '#aed6f1';
      if (r.sst >= 28) fill = '#f5b7b1';
      else if (r.sst >= 26.5) fill = '#f9e79f';
      else fill = '#d6eaf8';
      L.rectangle(bounds, {
        color: '#888', weight: 0.5, fillColor: fill, fillOpacity: 0.18
      }).bindTooltip(r.name + ' ' + r.sst.toFixed(1) + '℃').addTo(layerGroups.sst);

      // 关键等值线：用区域边框颜色表示阈值
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
        ' <span style="font-weight:normal;color:#666">(' +
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

  // —— 引导风箭头 ——
  function redrawSteer() {
    layerGroups.steer.clearLayers();
    if (!state.layers.steer) return;
    const cfg = cfgFromUI();
    const stepLon = 8, stepLat = 5;
    for (let lat = 5; lat <= 45; lat += stepLat) {
      for (let lon = 105; lon <= 175; lon += stepLon) {
        const st = P.steeringAt(lon, lat, cfg, state.fugen, state.hole);
        const beta = P.betaDrift(lat, cfg.betaStrength);
        const u = st.u + beta.u * 0.5; // 箭头略含 β
        const v = st.v + beta.v * 0.5;
        const spd = Math.hypot(u, v);
        if (spd < 0.3) continue;
        const scale = 0.35;
        const endLat = lat + v * scale * 0.15;
        const endLon = lon + u * scale * 0.15 / Math.cos(lat * Math.PI / 180);
        L.polyline([[lat, lon], [endLat, endLon]], {
          color: '#2c3e50', weight: 1, opacity: 0.65
        }).addTo(layerGroups.steer);
        // 箭头尖
        const ang = Math.atan2(v, u);
        const ah = 0.35;
        const a1 = ang + Math.PI * 0.8;
        const a2 = ang - Math.PI * 0.8;
        const p1 = [endLat + Math.sin(a1) * ah * 0.4, endLon + Math.cos(a1) * ah * 0.4 / Math.cos(lat * Math.PI / 180)];
        const p2 = [endLat + Math.sin(a2) * ah * 0.4, endLon + Math.cos(a2) * ah * 0.4 / Math.cos(lat * Math.PI / 180)];
        L.polyline([p1, [endLat, endLon], p2], {
          color: '#2c3e50', weight: 1, opacity: 0.65
        }).addTo(layerGroups.steer);
      }
    }
  }

  // —— 风暴与路径 ——
  function redrawStorm() {
    layerGroups.track.clearLayers();
    layerGroups.ensemble.clearLayers();
    layerGroups.storm.clearLayers();

    if (!state.members.length) return;

    const main = state.members[0];

    // 集合路径
    if (state.layers.ensemble && state.members.length > 1) {
      for (let i = 1; i < state.members.length; i++) {
        const m = state.members[i];
        if (m.track.length < 2) continue;
        const latlngs = m.track.map(p => [p.lat, p.lon]);
        L.polyline(latlngs, {
          color: '#95a5a6', weight: 1.5, opacity: 0.7
        }).addTo(layerGroups.ensemble);
      }
    }

    // 主路径
    if (state.layers.track && main.track.length >= 1) {
      const latlngs = main.track.map(p => [p.lat, p.lon]);
      if (latlngs.length >= 2) {
        L.polyline(latlngs, { color: '#2980b9', weight: 2.5 }).addTo(layerGroups.track);
      }
      // 风圈
      if (main.alive || main.vmax >= P.DISSIPATE_MS) {
        const rDeg = G.windRadiusDeg(main.vmax);
        L.circle([main.lat, main.lon], {
          radius: rDeg * 111320,
          color: '#2980b9',
          weight: 2,
          fillColor: '#3498db',
          fillOpacity: 0.15
        }).addTo(layerGroups.track);
      }
    }

    // 中心符号
    if (main.track.length || true) {
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:18px;height:18px;border:2px solid #c0392b;border-radius:50%;background:rgba(231,76,60,0.35);text-align:center;line-height:14px;font-size:12px;color:#922;font-weight:bold">台</div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
      L.marker([main.lat, main.lon], { icon }).addTo(layerGroups.storm);
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
    // 主成员：无扰动
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

    const dt = 1.0; // 1 小时一步
    const cfg = cfgFromUI();
    const main = state.members[0];

    // 更新空圈
    if (state.hole) {
      P.updateHole(state.hole, main.lon, main.lat, main.vmax);
      // 若中心已离开原副高实体范围且空洞不再需要——仍保持跟随直到风暴离开该副高环
      const stillInParent = state.fugen.some(f =>
        f.id === state.hole.fugenId && G.pointInRing(main.lon, main.lat, f.ring)
      );
      // 保持空洞直到消亡；中心移出多边形后可清除
      if (!stillInParent && !G.inFugenSolid(main.lon, main.lat, state.fugen, null)) {
        // 离开母体多边形后保留空洞一会无妨；简化：移出后清除
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

    // 每步刷新显示（速度高时可降采样，这里简单每步刷）
    redrawFugen();
    redrawStorm();
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
      // 重新放置
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
    const baseMs = 400; // 1× 时每步间隔
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
    state.hours = 0;
    state.members = [];
    state.hole = null;
    redrawFugen();
    redrawStorm();
    updateStatus();
  }

  // —— 事件 ——
  map.on('click', function (e) {
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
    const d = 4;
    state.fugen.push({
      id,
      name: '自定义副高' + state.fugen.length,
      ring: [
        [c.lng - d, c.lat - d * 0.6],
        [c.lng + d, c.lat - d * 0.6],
        [c.lng + d, c.lat + d * 0.6],
        [c.lng - d, c.lat + d * 0.6],
        [c.lng - d, c.lat - d * 0.6]
      ]
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
