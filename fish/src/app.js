/*
 * 수온과 용존산소: 물고기 생존 AI 시뮬레이터 — 화면(UI), 3D 장면, 그래프, LLM 호출, 채팅 기록
 * core.js가 만든 globalThis.FishCore를 사용한다.
 */
(function () {
  'use strict';

  var F = globalThis.FishCore;
  var THREE = globalThis.THREE;
  var state = F.createState();
  var fmt = F.fmt;
  var fmtShort = F.fmtShort;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  var EXAMPLE_CHIPS = ['수온 5도 올려줘', '주변 기압 10hPa 내려줘', '해발 2000m 호수로 옮겨줘', '에어펌프 켜줘', '물고기 30마리 더 넣어줘', '잉어로 바꿔줘', '폭염 시작해줘', '지금 상태 기록해줘'];

  // ═════════════════════════ 3D 장면 ═════════════════════════
  var TX = 3.0;          // 수조 반폭(x)
  var TZ = 1.5;          // 수조 반깊이(z)
  var TH = 3.8;          // 수조 높이
  var WL = 3.0;          // 수면 높이
  var SAND = 0.28;       // 모래 두께
  var LIQ = { x: TX - 0.16, z: TZ - 0.14, y0: SAND + 0.12, y1: WL - 0.08 };
  var AIR = { x: TX - 0.16, z: TZ - 0.14, y0: WL + 0.14, y1: TH + 0.55 };
  var SWIM = { x: TX - 0.5, z: TZ - 0.32, y0: SAND + 0.3, y1: WL - 0.16 };
  var MAX_O2 = 230;
  var MAX_N2 = 110;
  var MAX_BUBBLES = 90;
  var MAX_FISH = 60;
  var N_WATER = 18;
  var MPU = 120 / 15;    // 표시 분자 수 / (mg/L)
  var STONE = { x: 2.15, y: SAND + 0.07, z: 0.55 };

  var FISH_COLORS = {
    trout: { body: 0xc9d1d9, stripe: 0xf472b6, fin: 0x9aa7b4 },
    carp: { body: 0xc8952e, stripe: 0xb4801f, fin: 0xa8701c },
    dead: { body: 0x8d9196, stripe: 0x80848a, fin: 0x6d7277 }
  };

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  function createScene(canvas, container) {
    if (!THREE || !webglAvailable()) return null;
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) { return null; }
    renderer.setClearColor(0x000000, 0);
    var pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.8));
    var key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(4, 10, 7);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0xbfdcff, 0.35);
    rim.position.set(-6, 3, -6);
    scene.add(rim);

    var world = new THREE.Group();
    scene.add(world);

    // 받침대
    var stand = new THREE.Mesh(new THREE.BoxGeometry(TX * 2 + 0.6, 0.18, TZ * 2 + 0.6), new THREE.MeshPhongMaterial({ color: 0x6b4f3a, shininess: 20 }));
    stand.position.y = -0.1;
    world.add(stand);

    // 유리 수조(윗면은 열림)
    var glassMat = new THREE.MeshPhongMaterial({ color: 0xd6ecff, specular: 0xffffff, shininess: 120, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    function glassPanel(w, h, pos, rotY, rotX) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
      m.position.copy(pos);
      if (rotY) m.rotation.y = rotY;
      if (rotX) m.rotation.x = rotX;
      m.renderOrder = 3;
      world.add(m);
    }
    glassPanel(TX * 2, TH, new THREE.Vector3(0, TH / 2, TZ));
    glassPanel(TX * 2, TH, new THREE.Vector3(0, TH / 2, -TZ));
    glassPanel(TZ * 2, TH, new THREE.Vector3(TX, TH / 2, 0), Math.PI / 2);
    glassPanel(TZ * 2, TH, new THREE.Vector3(-TX, TH / 2, 0), Math.PI / 2);
    var edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(TX * 2, TH, TZ * 2));
    var edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0x9cc9e8, transparent: true, opacity: 0.8 }));
    edges.position.y = TH / 2;
    world.add(edges);

    // 모래 바닥
    var sand = new THREE.Mesh(new THREE.BoxGeometry(TX * 2 - 0.02, SAND, TZ * 2 - 0.02), new THREE.MeshPhongMaterial({ color: 0xd9c08f, shininess: 5 }));
    sand.position.y = SAND / 2;
    world.add(sand);
    // 자갈
    var rockMat = new THREE.MeshPhongMaterial({ color: 0x8b8f94, shininess: 15 });
    [[-2.2, 0.6, 0.22], [-1.6, -0.9, 0.16], [0.9, 0.95, 0.19], [1.6, -1.0, 0.14]].forEach(function (r) {
      var rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r[2], 0), rockMat);
      rock.position.set(r[0], SAND + r[2] * 0.4, r[1]);
      rock.rotation.set(rand(0, 3), rand(0, 3), 0);
      world.add(rock);
    });

    // 수초(단순 도형): 흔들리는 가는 원뿔 묶음
    var plantMat = new THREE.MeshPhongMaterial({ color: 0x2f9e44, shininess: 25 });
    var plantMat2 = new THREE.MeshPhongMaterial({ color: 0x5cb85c, shininess: 25 });
    var plants = [];
    [[-2.5, -0.95], [-2.3, -0.7], [-1.0, -1.1], [0.2, -1.15], [2.6, -0.9], [-2.6, 0.9], [1.3, 1.05]].forEach(function (p, idx) {
      var g = new THREE.Group();
      g.position.set(p[0], SAND, p[1]);
      var blades = 3 + (idx % 3);
      for (var b = 0; b < blades; b++) {
        var h = rand(0.9, 1.9);
        var geo = new THREE.ConeGeometry(0.06, h, 5);
        geo.translate(0, h / 2, 0);
        var blade = new THREE.Mesh(geo, b % 2 ? plantMat : plantMat2);
        blade.position.set(rand(-0.12, 0.12), 0, rand(-0.1, 0.1));
        blade.rotation.set(rand(-0.25, 0.25), rand(0, 3), rand(-0.25, 0.25));
        blade.scale.z = 0.4;
        g.add(blade);
      }
      g.userData.phase = rand(0, 6.28);
      plants.push(g);
      world.add(g);
    });

    // 물
    var waterMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.14, shininess: 60, depthWrite: false });
    var water = new THREE.Mesh(new THREE.BoxGeometry(TX * 2 - 0.04, WL - SAND, TZ * 2 - 0.04), waterMat);
    water.position.y = SAND + (WL - SAND) / 2;
    water.renderOrder = 2;
    world.add(water);
    var surfaceMat = new THREE.MeshPhongMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, shininess: 100 });
    var surface = new THREE.Mesh(new THREE.PlaneGeometry(TX * 2 - 0.04, TZ * 2 - 0.04), surfaceMat);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = WL;
    surface.renderOrder = 2;
    world.add(surface);
    var surfEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(TX * 2 - 0.04, TZ * 2 - 0.04)), new THREE.LineBasicMaterial({ color: 0x38bdf8 }));
    surfEdge.rotation.x = -Math.PI / 2;
    surfEdge.position.y = WL;
    world.add(surfEdge);

    // 에어스톤, 호스, 펌프
    var stoneMat = new THREE.MeshPhongMaterial({ color: 0x9fb4c7, shininess: 10 });
    var stone = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.14, 16), stoneMat);
    stone.position.set(STONE.x, STONE.y, STONE.z);
    world.add(stone);
    var hoseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(STONE.x, STONE.y + 0.05, STONE.z),
      new THREE.Vector3(STONE.x + 0.3, SAND + 0.5, STONE.z + 0.4),
      new THREE.Vector3(TX - 0.18, WL - 0.4, TZ - 0.18),
      new THREE.Vector3(TX - 0.12, TH + 0.1, TZ - 0.15),
      new THREE.Vector3(TX + 0.25, TH + 0.12, TZ - 0.15),
      new THREE.Vector3(TX + 0.55, 1.4, TZ - 0.2),
      new THREE.Vector3(TX + 0.6, 0.45, TZ - 0.4)
    ]);
    var hose = new THREE.Mesh(new THREE.TubeGeometry(hoseCurve, 80, 0.035, 8, false), new THREE.MeshPhongMaterial({ color: 0x94d3a2, transparent: true, opacity: 0.85, shininess: 60 }));
    world.add(hose);
    var pumpBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.5), new THREE.MeshPhongMaterial({ color: 0x475569, shininess: 40 }));
    pumpBox.position.set(TX + 0.65, 0.2, TZ - 0.55);
    world.add(pumpBox);
    var pumpLed = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial({ color: 0x334155 }));
    pumpLed.position.set(TX + 0.65, 0.3, TZ - 0.29);
    world.add(pumpLed);

    // ── 분자 모형(InstancedMesh) ──
    function molSet(atomColor, atomR, bondCount, cap, opacity) {
      var transparent = opacity < 1;
      var aMat = new THREE.MeshPhongMaterial({ color: atomColor, shininess: 60, transparent: transparent, opacity: opacity, depthWrite: !transparent });
      var bMat = new THREE.MeshPhongMaterial({ color: 0xd1d5db, shininess: 30, transparent: transparent, opacity: opacity, depthWrite: !transparent });
      var atoms = new THREE.InstancedMesh(new THREE.SphereGeometry(atomR, 12, 8), aMat, cap * 2);
      var bonds = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.011, 0.011, 0.12, 6), bMat, cap * bondCount);
      [atoms, bonds].forEach(function (m) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.count = 0;
        if (transparent) m.renderOrder = 1;
        world.add(m);
      });
      return { atoms: atoms, bonds: bonds, bondCount: bondCount, n: 0 };
    }
    var o2Liquid = molSet(0xef4444, 0.056, 2, MAX_O2, 1);
    var o2Air = molSet(0xf87171, 0.056, 2, MAX_O2, 0.5);
    var n2Air = molSet(0x3b82f6, 0.052, 3, MAX_N2, 0.42);
    var rotZ = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    var L_ATOM = [new THREE.Matrix4().makeTranslation(0.06, 0, 0), new THREE.Matrix4().makeTranslation(-0.06, 0, 0)];
    var L_BOND2 = [0.02, -0.02].map(function (o) { return new THREE.Matrix4().makeTranslation(0, o, 0).multiply(rotZ); });
    var L_BOND3 = [[0, 0.022], [0.019, -0.011], [-0.019, -0.011]].map(function (o) { return new THREE.Matrix4().makeTranslation(0, o[0], o[1]).multiply(rotZ); });

    // ── 물 분자(H–O–H 104.5°) ──
    var half = 104.5 / 2 * Math.PI / 180;
    var OH = 0.12;
    var hPos = [new THREE.Vector3(Math.sin(half) * OH, Math.cos(half) * OH, 0), new THREE.Vector3(-Math.sin(half) * OH, Math.cos(half) * OH, 0)];
    var wOMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.065, 12, 8), new THREE.MeshPhongMaterial({ color: 0xf87171, transparent: true, opacity: 0.3, depthWrite: false }), N_WATER);
    var wHMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.042, 10, 8), new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }), N_WATER * 2);
    var wBMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.011, 0.011, OH, 6), new THREE.MeshPhongMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.3, depthWrite: false }), N_WATER * 2);
    var L_WH = hPos.map(function (p) { return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z); });
    var L_WB = hPos.map(function (p) {
      var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
      return new THREE.Matrix4().compose(p.clone().multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    });
    var waterGroup = new THREE.Group();
    [wOMesh, wHMesh, wBMesh].forEach(function (m) { m.frustumCulled = false; m.renderOrder = 1; waterGroup.add(m); });
    waterGroup.visible = false;
    world.add(waterGroup);
    var waters = [];
    for (var w = 0; w < N_WATER; w++) {
      waters.push({ pos: randomLiquidPos(new THREE.Vector3()), rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)), av: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)), vel: new THREE.Vector3() });
    }

    // ── 기포 ──
    var bubbleMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x1e3a5f, specular: 0xffffff, shininess: 140, transparent: true, opacity: 0.55, depthWrite: false }),
      MAX_BUBBLES
    );
    bubbleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bubbleMesh.frustumCulled = false;
    bubbleMesh.renderOrder = 4;
    bubbleMesh.count = 0;
    world.add(bubbleMesh);
    var bubbles = [];
    for (var j = 0; j < MAX_BUBBLES; j++) bubbles.push({ active: false, pos: new THREE.Vector3(), r: 0, vy: 0, ph: 0 });

    // ── 물고기(InstancedMesh: 몸통·줄무늬·꼬리·등지느러미·가슴지느러미·눈·아가미·입) ──
    function fishMesh(geo, mat, perFish, colored) {
      var m = new THREE.InstancedMesh(geo, mat, MAX_FISH * perFish);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 인스턴스 색 버퍼는 첫 렌더 전에, 최대 개수 크기로 직접 만든다(r128의 setColorAt은 count 크기로 만든다).
      if (colored) {
        var arr = new Float32Array(MAX_FISH * perFish * 3);
        arr.fill(1);
        m.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      m.frustumCulled = false;
      m.count = 0;
      world.add(m);
      return m;
    }
    var colorMat = function () { return new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 70, specular: 0x666666 }); };
    var bodyGeo = new THREE.SphereGeometry(1, 18, 12); bodyGeo.scale(0.3, 0.12, 0.075);
    var stripeGeo = new THREE.SphereGeometry(1, 16, 8); stripeGeo.scale(0.25, 0.022, 0.078); stripeGeo.translate(-0.01, 0.006, 0);
    var tailGeo = new THREE.ConeGeometry(0.11, 0.18, 4); tailGeo.rotateZ(-Math.PI / 2); tailGeo.scale(1, 1, 0.22); tailGeo.translate(-0.09, 0, 0);
    var finGeo = new THREE.ConeGeometry(0.06, 0.13, 3); finGeo.scale(1, 1, 0.2); finGeo.rotateZ(0.5); finGeo.translate(0.0, 0.15, 0);
    var pecGeo = new THREE.ConeGeometry(0.035, 0.1, 3); pecGeo.scale(1, 1, 0.25); pecGeo.rotateZ(Math.PI / 2 + 0.5); pecGeo.translate(-0.04, 0, 0);
    var eyeGeo = new THREE.SphereGeometry(0.021, 10, 8);
    var gillGeo = new THREE.SphereGeometry(1, 10, 8); gillGeo.scale(0.012, 0.045, 0.014);
    var mouthGeo = new THREE.SphereGeometry(0.03, 10, 8);
    var fBody = fishMesh(bodyGeo, colorMat(), 1, true);
    var fStripe = fishMesh(stripeGeo, colorMat(), 1, true);
    var fTail = fishMesh(tailGeo, colorMat(), 1, true);
    var fFin = fishMesh(finGeo, colorMat(), 1, true);
    var fPec = fishMesh(pecGeo, colorMat(), 2, true);
    var fEye = fishMesh(eyeGeo, new THREE.MeshPhongMaterial({ color: 0x111111, shininess: 120 }), 2);
    var fGill = fishMesh(gillGeo, new THREE.MeshPhongMaterial({ color: 0xb91c1c, shininess: 30 }), 2);
    var fMouth = fishMesh(mouthGeo, new THREE.MeshPhongMaterial({ color: 0x3b0d0d, shininess: 30 }), 1);
    var tmpColor = new THREE.Color();

    var fish = [];
    var curSpecies = null;
    function newFish() {
      var f = {
        pos: randomSwimPos(new THREE.Vector3()), vel: new THREE.Vector3(rand(-0.2, 0.2), 0, rand(-0.1, 0.1)),
        target: randomSwimPos(new THREE.Vector3()),
        yaw: rand(0, 6.28), pitch: 0, roll: 0, size: rand(0.85, 1.15),
        wag: rand(0, 6.28), gill: rand(0, 6.28), mouth: rand(0, 6.28), dead: false, deadT: 0, id: ++fishSerial
      };
      return f;
    }
    var fishSerial = 0;
    function fishColor(f) { return f.dead ? FISH_COLORS.dead : (FISH_COLORS[curSpecies] || FISH_COLORS.trout); }

    function randomLiquidPos(v) { return v.set(rand(-LIQ.x, LIQ.x), rand(LIQ.y0, LIQ.y1), rand(-LIQ.z, LIQ.z)); }
    function randomAirPos(v) { return v.set(rand(-AIR.x, AIR.x), rand(AIR.y0, AIR.y1), rand(-AIR.z, AIR.z)); }
    function randomSwimPos(v) { return v.set(rand(-SWIM.x, SWIM.x), rand(SWIM.y0, SWIM.y1), rand(-SWIM.z, SWIM.z)); }

    // ── 분자 풀 ──
    var mols = [];
    for (var i = 0; i < MAX_O2; i++) mols.push({ active: false, gas: 'O2', region: 'liquid', pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), av: new THREE.Vector3(), s: 0, dying: false, fish: null, t: 0 });
    var n2s = [];
    for (var k2 = 0; k2 < MAX_N2; k2++) n2s.push({ active: false, region: 'air', pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), av: new THREE.Vector3(), s: 0, dying: false });

    function initMol(m, region, instant) {
      m.active = true; m.dying = false; m.region = region; m.fish = null; m.t = 0;
      m.vel.set(rand(-0.2, 0.2), rand(-0.2, 0.2), rand(-0.2, 0.2));
      m.rot.set(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3));
      m.av.set(rand(-2, 2), rand(-2, 2), rand(-2, 2));
      m.s = instant ? 1 : 0.01;
      return m;
    }
    function spawn(pool, region, posFn, instant) {
      for (var k = 0; k < pool.length; k++) {
        if (!pool[k].active) { var m = initMol(pool[k], region, instant); posFn(m.pos); return m; }
      }
      return null;
    }
    function count(pool, pred) {
      var n = 0;
      for (var k = 0; k < pool.length; k++) { var m = pool[k]; if (m.active && !m.dying && pred(m)) n++; }
      return n;
    }
    function isLiquid(m) { return m.region === 'liquid' || m.region === 'enter'; }
    function isAir(m) { return m.region === 'air' || m.region === 'rise'; }

    var quality = 1;
    var budgets = { eat: 0, dissolve: 0, escape: 0, fixAdd: 0, fixRemove: 0, airAdd: 0, airRemove: 0, n2: 0, bubble: 0 };
    var clock = 0;
    var showN2 = true;

    function targets(st) {
      var c = F.displayCounts(st);
      return { L: Math.round(c.dissolved * quality), A: Math.round(c.airO2 * quality), N: showN2 ? Math.round(c.airN2 * quality) : 0 };
    }

    function fill(st) {
      mols.forEach(function (m) { m.active = false; });
      n2s.forEach(function (m) { m.active = false; });
      bubbles.forEach(function (b) { b.active = false; });
      var t = targets(st);
      for (var a = 0; a < t.L; a++) spawn(mols, 'liquid', randomLiquidPos, true);
      for (var b = 0; b < t.A; b++) spawn(mols, 'air', randomAirPos, true);
      for (var c = 0; c < t.N; c++) spawn(n2s, 'air', randomAirPos, true);
      fish = [];
      curSpecies = st.species;
      syncFish(st);
    }

    function aliveFish() { return fish.filter(function (f) { return !f.dead; }); }

    /** 물고기 배열을 상태(전체 수·생존 수·어종)에 맞춘다. */
    function syncFish(st) {
      var total = st.fishBase, alive = F.aliveCount(st);
      if (st.species !== curSpecies) { curSpecies = st.species; fish = fish.filter(function (f) { return !f.dead; }); }
      if (st.S >= 1 - 1e-12) {
        // 기준 마릿수를 다시 잡은 직후: 폐사한 물고기는 건져 내고 수를 맞춘다.
        if (fish.some(function (f) { return f.dead; })) fish = fish.filter(function (f) { return !f.dead; });
        while (fish.length < total) fish.push(newFish());
        while (fish.length > total) fish.splice(Math.floor(Math.random() * fish.length), 1);
        return;
      }
      while (fish.length < total) fish.push(newFish());
      var living = aliveFish();
      var excess = living.length - alive;
      while (excess > 0 && living.length) {
        var idx = Math.floor(Math.random() * living.length);
        living[idx].dead = true;
        living.splice(idx, 1);
        excess--;
      }
    }

    function nearestFishPoint(f, out) {
      // 아가미(머리 쪽) 위치
      var dx = Math.cos(f.yaw), dz = -Math.sin(f.yaw);
      return out.set(f.pos.x + dx * 0.14 * f.size, f.pos.y, f.pos.z + dz * 0.14 * f.size);
    }

    function eatEvent() {
      var living = aliveFish();
      if (!living.length) return false;
      var f = living[Math.floor(Math.random() * living.length)];
      var best = null, bestD = Infinity;
      for (var k = 0; k < mols.length; k++) {
        var m = mols[k];
        if (!m.active || m.dying || m.region !== 'liquid') continue;
        var d = m.pos.distanceToSquared(f.pos);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (!best) return false;
      best.region = 'eaten';
      best.fish = f;
      best.t = 0;
      return true;
    }

    function dissolveEvent(st) {
      var active = [];
      if (st.pump) for (var k = 0; k < bubbles.length; k++) if (bubbles[k].active) active.push(bubbles[k]);
      if (active.length && Math.random() < 0.75) {
        var b = active[Math.floor(Math.random() * active.length)];
        var m = spawn(mols, 'liquid', function (v) { v.copy(b.pos); }, false);
        if (m) { var a = rand(0, 6.28); m.vel.set(Math.cos(a) * 0.5, rand(-0.1, 0.2), Math.sin(a) * 0.5); }
        return;
      }
      // 공기층의 O₂가 수면을 통해 녹아 들어온다
      var low = null;
      for (var j2 = 0; j2 < mols.length; j2++) {
        var g = mols[j2];
        if (g.active && !g.dying && g.region === 'air' && (!low || g.pos.y < low.pos.y)) low = g;
      }
      if (low) {
        low.region = 'enter';
        low.vel.set(low.vel.x * 0.3, -0.7, low.vel.z * 0.3);
      } else {
        var nm = spawn(mols, 'enter', function (v) { randomAirPos(v); v.y = WL + 0.3; }, false);
        if (nm) nm.vel.set(0, -0.7, 0);
      }
    }

    function escapeEvent() {
      var cands = [];
      for (var k = 0; k < mols.length; k++) { var m = mols[k]; if (m.active && !m.dying && m.region === 'liquid') cands.push(m); }
      if (!cands.length) return;
      cands.sort(function (a, b) { return b.pos.y - a.pos.y; });
      var top = cands[Math.floor(Math.random() * Math.min(6, cands.length))];
      top.region = 'rise';
      top.vel.set(rand(-0.1, 0.1), 0.7, rand(-0.1, 0.1));
    }

    function spawnBubble() {
      for (var k = 0; k < bubbles.length; k++) {
        var b = bubbles[k];
        if (b.active) continue;
        b.active = true;
        b.pos.set(STONE.x + rand(-0.1, 0.1), STONE.y + 0.08, STONE.z + rand(-0.1, 0.1));
        b.r = rand(0.025, 0.05);
        b.vy = rand(0.5, 0.8);
        b.ph = rand(0, 6.3);
        return;
      }
    }

    function keepInBox(m, B) {
      if (m.pos.x > B.x) { m.pos.x = B.x; if (m.vel.x > 0) m.vel.x = -m.vel.x; }
      if (m.pos.x < -B.x) { m.pos.x = -B.x; if (m.vel.x < 0) m.vel.x = -m.vel.x; }
      if (m.pos.z > B.z) { m.pos.z = B.z; if (m.vel.z > 0) m.vel.z = -m.vel.z; }
      if (m.pos.z < -B.z) { m.pos.z = -B.z; if (m.vel.z < 0) m.vel.z = -m.vel.z; }
      if (m.pos.y < B.y0) { m.pos.y = B.y0; if (m.vel.y < 0) m.vel.y = -m.vel.y; }
      if (m.pos.y > B.y1) { m.pos.y = B.y1; if (m.vel.y > 0) m.vel.y = -m.vel.y; }
    }
    function jitter(m, speed, mdt) {
      m.vel.x += rand(-1, 1) * 3 * speed * mdt;
      m.vel.y += rand(-1, 1) * 3 * speed * mdt;
      m.vel.z += rand(-1, 1) * 3 * speed * mdt;
      limitSpeed(m.vel, speed);
      m.pos.addScaledVector(m.vel, mdt);
    }
    function limitSpeed(v, max) {
      var l = v.length();
      if (l > max) v.multiplyScalar(max / l);
    }
    function runBudget(key, rate, mdt, fn, cap) {
      budgets[key] += Math.min(rate, cap || 30) * mdt;
      var guard = 0;
      while (budgets[key] >= 1 && guard++ < 40) { budgets[key] -= 1; fn(); }
      if (budgets[key] > 3) budgets[key] = 3;
    }

    var tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4(), tmpM3 = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpE = new THREE.Euler(0, 0, 0, 'YZX'), tmpV = new THREE.Vector3();

    function writeMol(set, m, scale) {
      tmpQ.setFromEuler(m.rot);
      var sc = Math.max(0.001, m.s) * scale;
      tmpS.set(sc, sc, sc);
      tmpM.compose(m.pos, tmpQ, tmpS);
      var n = set.n;
      set.atoms.setMatrixAt(n * 2, tmpM2.multiplyMatrices(tmpM, L_ATOM[0]));
      set.atoms.setMatrixAt(n * 2 + 1, tmpM2.multiplyMatrices(tmpM, L_ATOM[1]));
      var L = set.bondCount === 3 ? L_BOND3 : L_BOND2;
      for (var b = 0; b < set.bondCount; b++) set.bonds.setMatrixAt(n * set.bondCount + b, tmpM2.multiplyMatrices(tmpM, L[b]));
      set.n++;
    }
    function finishSet(set) {
      set.atoms.count = set.n * 2;
      set.bonds.count = set.n * set.bondCount;
      set.atoms.instanceMatrix.needsUpdate = true;
      set.bonds.instanceMatrix.needsUpdate = true;
      set.n = 0;
    }

    function update(dt, st) {
      clock += dt;
      var mdt = st.paused ? 0 : dt;
      var status = F.speciesStatus(st);
      var vT = 0.16 * (1 + st.T / 20);   // 수온이 높을수록 빠른 열운동

      plants.forEach(function (g) { g.rotation.z = Math.sin(clock * 0.9 + g.userData.phase) * 0.06; g.rotation.x = Math.cos(clock * 0.7 + g.userData.phase) * 0.04; });
      pumpLed.material.color.setHex(st.pump ? 0x22c55e : 0x334155);

      syncFish(st);

      // ── 분자 수와 흐름(용해·방출·호흡) ──
      if (mdt > 0) {
        var t = targets(st);
        var flux = st.speed * MPU * quality;   // (mg/L/분) → 분자/초
        var ex = st.rates.exchange, cons = st.rates.consume;
        if (aliveFish().length) runBudget('eat', cons * flux, mdt, eatEvent, 25);
        if (ex > 0) runBudget('dissolve', ex * flux, mdt, function () { dissolveEvent(st); }, 25);
        else budgets.dissolve = 0;
        if (ex < 0) runBudget('escape', -ex * flux, mdt, escapeEvent, 25);
        else budgets.escape = 0;
        // 표시 개수가 목표에서 벗어나면 보정
        var nL = count(mols, isLiquid);
        var diff = nL - t.L;
        if (diff > 2) runBudget('fixRemove', diff * 1.5, mdt, function () { if (st.DO > F.doSaturation(st.T, st.P) || !eatEvent()) escapeEvent(); });
        else budgets.fixRemove = 0;
        if (diff < -2) runBudget('fixAdd', -diff * 1.5, mdt, function () { dissolveEvent(st); });
        else budgets.fixAdd = 0;
        // 공기층 O₂·N₂ 개수 유지
        var nA = count(mols, function (m) { return m.region === 'air'; });
        if (nA < t.A) runBudget('airAdd', Math.max(6, (t.A - nA) * 2), mdt, function () { spawn(mols, 'air', function (v) { randomAirPos(v); v.y = rand(AIR.y1 - 0.4, AIR.y1); }, false); });
        else budgets.airAdd = 0;
        if (nA > t.A + 2) {
          runBudget('airRemove', Math.max(3, (nA - t.A) * 1.5), mdt, function () {
            var hi = null;
            for (var k = 0; k < mols.length; k++) { var m = mols[k]; if (m.active && !m.dying && m.region === 'air' && (!hi || m.pos.y > hi.pos.y)) hi = m; }
            if (hi) hi.dying = true;
          });
        } else budgets.airRemove = 0;
        var nN = count(n2s, function () { return true; });
        if (nN !== t.N) {
          runBudget('n2', Math.max(10, Math.abs(nN - t.N) * 3), mdt, function () {
            if (nN < t.N) { spawn(n2s, 'air', randomAirPos, false); nN++; }
            else if (nN > t.N) { for (var k = 0; k < n2s.length; k++) if (n2s[k].active && !n2s[k].dying) { n2s[k].dying = true; break; } nN--; }
          }, 80);
        }
        // 에어펌프 기포
        if (st.pump) runBudget('bubble', 16 * Math.max(0.4, quality), mdt, spawnBubble, 40);
      }

      // ── 기포 ──
      var nb = 0;
      for (var bi = 0; bi < bubbles.length; bi++) {
        var b = bubbles[bi];
        if (!b.active) continue;
        if (mdt > 0) {
          b.vy = Math.min(1.4, b.vy + 0.6 * mdt);
          b.pos.y += b.vy * mdt;
          b.pos.x += Math.sin(clock * 6 + b.ph) * 0.12 * mdt - 0.05 * mdt;
          b.pos.z += Math.cos(clock * 5 + b.ph) * 0.12 * mdt;
          b.r = Math.min(0.09, b.r + 0.01 * mdt);
          if (b.pos.y + b.r >= WL) { b.active = false; continue; }
        }
        tmpS.set(b.r, b.r, b.r);
        tmpQ.identity();
        tmpM.compose(b.pos, tmpQ, tmpS);
        bubbleMesh.setMatrixAt(nb++, tmpM);
      }
      bubbleMesh.count = nb;
      bubbleMesh.instanceMatrix.needsUpdate = true;

      // ── O₂ 분자 이동 ──
      for (var mi = 0; mi < mols.length; mi++) {
        var m = mols[mi];
        if (!m.active) continue;
        if (mdt > 0) {
          if (m.dying) {
            m.s -= mdt * 4;
            if (m.s <= 0) { m.active = false; continue; }
          } else if (m.s < 1) m.s = Math.min(1, m.s + mdt * 3);
          var speed = vT;
          switch (m.region) {
            case 'liquid':
              jitter(m, speed, mdt);
              keepInBox(m, LIQ);
              break;
            case 'air':
              jitter(m, speed * 1.8, mdt);
              keepInBox(m, AIR);
              break;
            case 'rise':
              m.pos.addScaledVector(m.vel, mdt);
              keepInBox(m, { x: LIQ.x, z: LIQ.z, y0: LIQ.y0, y1: AIR.y1 });
              if (m.pos.y > WL + 0.25) m.region = 'air';
              break;
            case 'enter':
              m.vel.y = -0.7;
              m.pos.addScaledVector(m.vel, mdt);
              keepInBox(m, { x: LIQ.x, z: LIQ.z, y0: LIQ.y0, y1: AIR.y1 });
              if (m.pos.y < WL - 0.25) { m.region = 'liquid'; m.vel.set(rand(-0.1, 0.1), -0.1, rand(-0.1, 0.1)); }
              break;
            case 'eaten':
              var f = m.fish;
              m.t += mdt;
              if (!f || f.dead || fish.indexOf(f) < 0) { m.region = 'liquid'; m.fish = null; break; }
              nearestFishPoint(f, tmpV);
              tmpV.sub(m.pos);
              var dist = tmpV.length();
              if (dist < 0.09 || m.t > 3) { m.dying = true; m.s = Math.min(m.s, 0.6); break; }
              m.vel.copy(tmpV.multiplyScalar(Math.min(1.6, 0.6 + m.t) / dist));
              m.pos.addScaledVector(m.vel, mdt);
              break;
          }
          m.rot.x += m.av.x * speed * 2 * mdt;
          m.rot.y += m.av.y * speed * 2 * mdt;
          m.rot.z += m.av.z * speed * 2 * mdt;
        }
        writeMol(m.region === 'air' || (m.region === 'rise' && m.pos.y > WL) || (m.region === 'enter' && m.pos.y > WL) ? o2Air : o2Liquid, m, m.region === 'eaten' ? 0.8 : 1);
      }
      finishSet(o2Liquid);
      finishSet(o2Air);

      // ── N₂ 분자(공기층) ──
      for (var ni = 0; ni < n2s.length; ni++) {
        var nm = n2s[ni];
        if (!nm.active) continue;
        if (mdt > 0) {
          if (nm.dying) { nm.s -= mdt * 4; if (nm.s <= 0) { nm.active = false; continue; } }
          else if (nm.s < 1) nm.s = Math.min(1, nm.s + mdt * 3);
          jitter(nm, vT * 1.8, mdt);
          keepInBox(nm, AIR);
          nm.rot.x += nm.av.x * vT * 2 * mdt; nm.rot.y += nm.av.y * vT * 2 * mdt; nm.rot.z += nm.av.z * vT * 2 * mdt;
        }
        writeMol(n2Air, nm, 1);
      }
      finishSet(n2Air);

      // ── 물 분자 ──
      if (waterGroup.visible) {
        for (var wi = 0; wi < waters.length; wi++) {
          var wm = waters[wi];
          if (mdt > 0) {
            wm.vel.x += rand(-1, 1) * 0.4 * mdt; wm.vel.y += rand(-1, 1) * 0.4 * mdt; wm.vel.z += rand(-1, 1) * 0.4 * mdt;
            limitSpeed(wm.vel, vT * 0.6);
            wm.pos.addScaledVector(wm.vel, mdt);
            keepInBox(wm, LIQ);
            wm.rot.x += wm.av.x * mdt * 0.6; wm.rot.y += wm.av.y * mdt * 0.6; wm.rot.z += wm.av.z * mdt * 0.6;
          }
          tmpQ.setFromEuler(wm.rot);
          tmpS.set(1, 1, 1);
          tmpM.compose(wm.pos, tmpQ, tmpS);
          wOMesh.setMatrixAt(wi, tmpM);
          for (var hh = 0; hh < 2; hh++) {
            wHMesh.setMatrixAt(wi * 2 + hh, tmpM2.multiplyMatrices(tmpM, L_WH[hh]));
            wBMesh.setMatrixAt(wi * 2 + hh, tmpM2.multiplyMatrices(tmpM, L_WB[hh]));
          }
        }
        wOMesh.instanceMatrix.needsUpdate = true;
        wHMesh.instanceMatrix.needsUpdate = true;
        wBMesh.instanceMatrix.needsUpdate = true;
      }

      updateFish(mdt, st, status);
      updateCamera(dt);
      renderer.render(scene, camera);
      updateTip();
      measureFps(dt);
    }

    // ── 물고기 움직임과 그리기 ──
    var colorsDirty = true;
    var lastColorKey = '';
    function updateFish(mdt, st, status) {
      var act = clamp(0.55 + st.T / 40, 0.5, 1.5);   // 수온이 높을수록 활발
      var beh = status.behavior;
      var colorKey = curSpecies + ':' + fish.map(function (f) { return f.dead ? 1 : 0; }).join('');
      if (colorKey !== lastColorKey) { lastColorKey = colorKey; colorsDirty = true; }
      for (var i = 0; i < fish.length && i < MAX_FISH; i++) {
        var f = fish[i];
        if (mdt > 0) {
          if (f.dead) {
            f.deadT += mdt;
            f.vel.multiplyScalar(Math.max(0, 1 - mdt * 3));
            f.roll += (Math.PI - f.roll) * Math.min(1, mdt * 1.2);
            f.pitch += (0 - f.pitch) * Math.min(1, mdt * 2);
            if (f.pos.y < WL - 0.1) f.pos.y = Math.min(WL - 0.1, f.pos.y + 0.12 * mdt);   // 천천히 수면으로 떠오른다
          } else {
            var surfaceMode = beh === 'surface';
            if (surfaceMode && f.target.y < WL - 0.3) f.target.set(clamp(f.pos.x + rand(-1, 1), -SWIM.x, SWIM.x), WL - rand(0.13, 0.2), clamp(f.pos.z + rand(-0.5, 0.5), -SWIM.z, SWIM.z));
            var spd = (surfaceMode ? 0.18 : beh === 'gasping' ? 0.42 : 0.34) * act * f.size;
            tmpV.copy(f.target).sub(f.pos);
            var d = tmpV.length();
            if (d < 0.25) {
              if (surfaceMode) f.target.set(clamp(f.pos.x + rand(-0.8, 0.8), -SWIM.x, SWIM.x), WL - rand(0.13, 0.2), clamp(f.pos.z + rand(-0.4, 0.4), -SWIM.z, SWIM.z));
              else randomSwimPos(f.target);
            } else {
              tmpV.multiplyScalar(spd / d);
              f.vel.lerp(tmpV, Math.min(1, mdt * 1.4));
            }
            f.pos.addScaledVector(f.vel, mdt);
            f.pos.x = clamp(f.pos.x, -SWIM.x, SWIM.x);
            f.pos.z = clamp(f.pos.z, -SWIM.z, SWIM.z);
            f.pos.y = clamp(f.pos.y, SWIM.y0, surfaceMode ? WL - 0.1 : SWIM.y1);
            var hz = Math.hypot(f.vel.x, f.vel.z);
            if (hz > 0.02) {
              var yawT = Math.atan2(-f.vel.z, f.vel.x);
              var dy = yawT - f.yaw;
              while (dy > Math.PI) dy -= Math.PI * 2;
              while (dy < -Math.PI) dy += Math.PI * 2;
              f.yaw += dy * Math.min(1, mdt * 3);
            }
            var pitchT = surfaceMode && f.pos.y > WL - 0.35 ? 0.5 : clamp(Math.atan2(f.vel.y, Math.max(0.05, hz)), -0.45, 0.45);
            f.pitch += (pitchT - f.pitch) * Math.min(1, mdt * 3);
            f.roll += (0 - f.roll) * Math.min(1, mdt * 3);
            f.wag += mdt * (5 + 14 * f.vel.length());
            f.gill += mdt * (beh === 'normal' ? 4 : beh === 'gasping' ? 18 : 22);
            f.mouth += mdt * (surfaceMode ? 9 : 3);
          }
        }
        // 행렬 계산
        tmpE.set(f.roll, f.yaw, f.pitch, 'YZX');
        tmpQ.setFromEuler(tmpE);
        tmpS.set(f.size, f.size, f.size);
        tmpM.compose(f.pos, tmpQ, tmpS);
        fBody.setMatrixAt(i, tmpM);
        fStripe.setMatrixAt(i, tmpM);
        var wagA = f.dead ? 0 : Math.sin(f.wag) * 0.45;
        tmpM3.makeRotationY(wagA).premultiply(tmpM2.makeTranslation(-0.26, 0, 0));
        fTail.setMatrixAt(i, tmpM2.multiplyMatrices(tmpM, tmpM3));
        fFin.setMatrixAt(i, tmpM);
        for (var side = 0; side < 2; side++) {
          var sgn = side ? 1 : -1;
          var flap = f.dead ? 0.2 : 0.35 + Math.sin(f.wag * 0.7 + side) * 0.25;
          tmpM3.makeRotationY(sgn * flap).premultiply(tmpM2.makeTranslation(0.09, -0.06, sgn * 0.055));
          fPec.setMatrixAt(i * 2 + side, tmpM2.multiplyMatrices(tmpM, tmpM3));
          tmpM3.makeTranslation(0.215, 0.03, sgn * 0.047);
          fEye.setMatrixAt(i * 2 + side, tmpM2.multiplyMatrices(tmpM, tmpM3));
          var open = f.dead ? 0 : (beh === 'normal' ? 0.25 : 0.55) * (0.5 + 0.5 * Math.sin(f.gill));
          tmpM3.makeRotationY(sgn * open * 0.8).premultiply(tmpM2.makeTranslation(0.13, -0.005, sgn * 0.066));
          fGill.setMatrixAt(i * 2 + side, tmpM2.multiplyMatrices(tmpM, tmpM3));
        }
        var mo = f.dead ? 0.15 : beh === 'surface' ? 0.15 + 0.85 * Math.abs(Math.sin(f.mouth)) : 0.3;
        tmpM3.makeScale(0.8, mo, 0.8).premultiply(tmpM2.makeTranslation(0.292, -0.012, 0));
        fMouth.setMatrixAt(i, tmpM2.multiplyMatrices(tmpM, tmpM3));
        if (colorsDirty) {
          var c = fishColor(f);
          fBody.setColorAt(i, tmpColor.setHex(c.body));
          fStripe.setColorAt(i, tmpColor.setHex(c.stripe));
          fTail.setColorAt(i, tmpColor.setHex(c.fin));
          fFin.setColorAt(i, tmpColor.setHex(c.fin));
          fPec.setColorAt(i * 2, tmpColor.setHex(c.fin));
          fPec.setColorAt(i * 2 + 1, tmpColor.setHex(c.fin));
        }
      }
      var nf = Math.min(fish.length, MAX_FISH);
      [fBody, fStripe, fTail, fFin, fMouth].forEach(function (m) { m.count = nf; m.instanceMatrix.needsUpdate = true; });
      [fPec, fEye, fGill].forEach(function (m) { m.count = nf * 2; m.instanceMatrix.needsUpdate = true; });
      if (colorsDirty) {
        [fBody, fStripe, fTail, fFin, fPec].forEach(function (m) { if (m.instanceColor) m.instanceColor.needsUpdate = true; });
        colorsDirty = false;
      }
    }

    // ── 물고기 선택(클릭·탭) → 말풍선 ──
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    var tipFish = null, tipUntil = 0;
    var tipEl = $('fishTip');
    function pickFish(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      var hits = raycaster.intersectObject(fBody);
      if (!hits.length) {
        // 작은 물고기도 쉽게 고를 수 있도록 화면에서 가장 가까운 물고기를 찾는다
        var best = null, bestD = 28;
        fish.forEach(function (f) {
          tmpV.copy(f.pos).project(camera);
          var sx = (tmpV.x + 1) / 2 * rect.width, sy = (1 - tmpV.y) / 2 * rect.height;
          var dd = Math.hypot(sx - (clientX - rect.left), sy - (clientY - rect.top));
          if (dd < bestD && tmpV.z < 1) { bestD = dd; best = f; }
        });
        return best;
      }
      return fish[hits[0].instanceId] || null;
    }
    function showTip(f) {
      tipFish = f;
      tipUntil = performance.now() + 6000;
      tipEl.hidden = !f;
    }
    function updateTip() {
      if (!tipFish) return;
      if (performance.now() > tipUntil || fish.indexOf(tipFish) < 0) { tipFish = null; tipEl.hidden = true; return; }
      var rect = canvas.getBoundingClientRect();
      tmpV.copy(tipFish.pos);
      tmpV.y += 0.18;
      tmpV.project(camera);
      var x = (tmpV.x + 1) / 2 * rect.width, y = (1 - tmpV.y) / 2 * rect.height;
      tipEl.style.left = clamp(x, 90, rect.width - 90) + 'px';
      tipEl.style.top = clamp(y, 90, rect.height) + 'px';
      var st = F.speciesStatus(state);
      var name = F.SPECIES[state.species].name;
      var text, grade;
      if (tipFish.dead) { text = '폐사 — 움직임을 멈추고 수면으로 떠올랐어요.'; grade = 'lethal'; }
      else {
        grade = st.key;
        text = st.behaviorLabel + ' (' + st.label + ')' + (st.behavior === 'surface' ? ' — 수면 가까이에서 입을 뻐끔거려요.' : st.behavior === 'gasping' ? ' — 아가미가 빠르게 움직여요.' : ' — 편안하게 헤엄쳐요.');
      }
      var head = '🐟 ' + name + ' #' + tipFish.id;
      var detail = 'DO ' + fmt(state.DO) + ' mg/L · 수온 ' + fmt(state.T, 1) + '℃';
      var html = head + '|' + text + '|' + detail;
      if (tipEl.getAttribute('data-html') !== html) {
        tipEl.setAttribute('data-html', html);
        tipEl.textContent = '';
        var b = document.createElement('b'); b.textContent = head; tipEl.appendChild(b);
        tipEl.appendChild(document.createTextNode(text));
        var sm = document.createElement('div'); sm.textContent = detail; sm.style.color = 'var(--muted)'; tipEl.appendChild(sm);
      }
      tipEl.setAttribute('data-grade', grade);
    }

    // ── 카메라 조작(드래그 회전·휠/핀치 확대) ──
    var DEFAULT_VIEW = { theta: 0.42, phi: 1.24, radius: 11.5, target: new THREE.Vector3(0, 1.8, 0) };
    var CLOSE_VIEW = { theta: 0.3, phi: 1.36, radius: 4.2, target: new THREE.Vector3(0.4, WL, 0) };
    var cam = { theta: DEFAULT_VIEW.theta, phi: DEFAULT_VIEW.phi, radius: DEFAULT_VIEW.radius, target: DEFAULT_VIEW.target.clone() };
    var camGoal = null;

    function updateCamera(dt) {
      if (camGoal) {
        var k = Math.min(1, dt * 5);
        cam.theta += (camGoal.theta - cam.theta) * k;
        cam.phi += (camGoal.phi - cam.phi) * k;
        cam.radius += (camGoal.radius - cam.radius) * k;
        cam.target.lerp(camGoal.target, k);
        if (Math.abs(camGoal.radius - cam.radius) < 0.01 && Math.abs(camGoal.theta - cam.theta) < 0.002) camGoal = null;
      }
      var sp = Math.sin(cam.phi);
      camera.position.set(
        cam.target.x + cam.radius * sp * Math.sin(cam.theta),
        cam.target.y + cam.radius * Math.cos(cam.phi),
        cam.target.z + cam.radius * sp * Math.cos(cam.theta)
      );
      camera.lookAt(cam.target);
    }
    function goTo(view) {
      var th = view.theta;
      while (th - cam.theta > Math.PI) th -= Math.PI * 2;
      while (th - cam.theta < -Math.PI) th += Math.PI * 2;
      camGoal = { theta: th, phi: view.phi, radius: view.radius * fitFactor(), target: view.target.clone() };
    }
    function fitFactor() {
      var a = camera.aspect || 1;
      return a < 1.35 ? Math.min(2.3, 1.35 / a) : 1;
    }

    var pointers = new Map();
    var pinchDist = 0;
    var downAt = null;
    canvas.addEventListener('pointerdown', function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      downAt = pointers.size === 1 ? { x: ev.clientX, y: ev.clientY, moved: 0 } : null;
      if (pointers.size === 2) pinchDist = pointerDistance();
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      var p = pointers.get(ev.pointerId);
      var dx = ev.clientX - p.x, dy = ev.clientY - p.y;
      p.x = ev.clientX; p.y = ev.clientY;
      if (downAt) downAt.moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 1) {
        if (downAt && downAt.moved < 5) return;
        camGoal = null;
        cam.theta -= dx * 0.008;
        cam.phi = clamp(cam.phi - dy * 0.008, 0.25, 1.75);
      } else if (pointers.size === 2) {
        camGoal = null;
        var d = pointerDistance();
        if (pinchDist > 0 && d > 0) cam.radius = clamp(cam.radius * pinchDist / d, 2.5, 26);
        pinchDist = d;
      }
    });
    function endPointer(ev) {
      if (ev.type === 'pointerup' && downAt && downAt.moved < 6 && pointers.size === 1) showTip(pickFish(ev.clientX, ev.clientY));
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (!pointers.size) downAt = null;
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('lostpointercapture', function (ev) { pointers.delete(ev.pointerId); if (pointers.size < 2) pinchDist = 0; });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      camGoal = null;
      cam.radius = clamp(cam.radius * (1 + clamp(ev.deltaY, -200, 200) * 0.0012), 2.5, 26);
    }, { passive: false });
    function pointerDistance() {
      var pts = Array.from(pointers.values());
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    function resize() {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (window.ResizeObserver) new ResizeObserver(resize).observe(container);
    window.addEventListener('resize', resize);
    resize();
    cam.radius = DEFAULT_VIEW.radius * fitFactor();

    // ── 성능 감시: 30fps 아래면 분자 수를 줄인다 ──
    var fpsAcc = 0, fpsFrames = 0, windows = 0, goodWindows = 0;
    function measureFps(dt) {
      fpsAcc += dt; fpsFrames++;
      if (fpsAcc < 1.5) return;
      var fps = fpsFrames / fpsAcc;
      fpsAcc = 0; fpsFrames = 0; windows++;
      if (windows <= 2) return; // 첫 셰이더 컴파일 구간은 건너뛴다
      if (fps < 30) {
        goodWindows = 0;
        if (pixelRatio > 1) { pixelRatio = 1; renderer.setPixelRatio(1); resize(); }
        else if (quality > 0.3) quality = Math.max(0.3, quality * 0.75);
      } else if (fps > 55) {
        goodWindows++;
        if (goodWindows >= 3 && quality < 1) { quality = Math.min(1, quality + 0.1); goodWindows = 0; }
      }
      onQuality(quality, fps);
    }
    var onQuality = function () {};

    fill(state);
    updateCamera(0);

    return {
      update: update,
      reset: function (st) { fill(st); goTo(DEFAULT_VIEW); showTip(null); },
      resetCamera: function () { goTo(DEFAULT_VIEW); },
      closeUp: function () { goTo(CLOSE_VIEW); },
      setWaterVisible: function (v) { waterGroup.visible = v; },
      setN2Visible: function (v) { showN2 = v; },
      onQuality: function (fn) { onQuality = fn; },
      render: function () { renderer.render(scene, camera); }
    };
  }

  // ═════════════════════════ 그래프 (Canvas 2D) ═════════════════════════
  var graphCanvas = $('graph');
  var currentTab = 'curve';
  var colors = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['--graph-axis', '--graph-grid', '--graph-curve', '--graph-ref', '--graph-co2', '--graph-o2', '--graph-n2', '--graph-do', '--graph-surv', '--text', '--muted', '--surface',
      '--green', '--yellow', '--orange', '--red', '--band-comfort', '--band-caution', '--band-danger', '--band-lethal', '--band-temp'].forEach(function (k) {
      colors[k.slice(2)] = cs.getPropertyValue(k).trim() || '#888';
    });
  }
  readColors();
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { readColors(); drawGraph(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }
  var GRADE_COLOR = { comfort: 'green', caution: 'yellow', danger: 'orange', lethal: 'red' };

  function niceStep(range, count) {
    var raw = range / Math.max(1, count);
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / p;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * p;
  }
  function niceMax(v, count) {
    if (!(v > 0)) return 1;
    var st = niceStep(v, count);
    return Math.ceil(v / st) * st;
  }
  function tickLabel(v, step) {
    var d = Math.abs(step - Math.round(step)) < 1e-9 ? 0 : Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2;
    return v.toFixed(d);
  }

  function setupCanvas() {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = graphCanvas.clientWidth, h = graphCanvas.clientHeight;
    if (!w || !h) return null;
    var W = Math.round(w * dpr), Hh = Math.round(h * dpr);
    if (graphCanvas.width !== W || graphCanvas.height !== Hh) { graphCanvas.width = W; graphCanvas.height = Hh; }
    var ctx = graphCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  /** 축, 눈금, 축 이름을 그리고 좌표 변환 함수를 돌려준다. o.y2가 있으면 오른쪽 축도 그린다. */
  function drawAxes(g, o) {
    var ctx = g.ctx;
    var A = { l: 58, r: g.w - (o.y2 ? 50 : 14), t: o.legendRows * 18 + 12, b: g.h - 40 };
    var sx = function (x) { return A.l + (x - o.x0) / (o.x1 - o.x0) * (A.r - A.l); };
    var sy;
    if (o.log) {
      var l0 = Math.log10(o.y0), l1 = Math.log10(o.y1);
      sy = function (y) { return A.b - (Math.log10(Math.max(y, o.y0 * 0.5)) - l0) / (l1 - l0) * (A.b - A.t); };
    } else {
      sy = function (y) { return A.b - (y - o.y0) / (o.y1 - o.y0) * (A.b - A.t); };
    }
    var sy2 = o.y2 ? function (y) { return A.b - (y - o.y2.y0) / (o.y2.y1 - o.y2.y0) * (A.b - A.t); } : null;
    ctx.font = '12px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors['graph-grid'];
    ctx.fillStyle = colors['graph-axis'];
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    o.yTicks.forEach(function (t) {
      var y = Math.round(sy(t.v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(A.l, y); ctx.lineTo(A.r, y); ctx.stroke();
      ctx.fillText(t.label, A.l - 6, y);
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    o.xTicks.forEach(function (t) {
      var x = Math.round(sx(t.v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, A.t); ctx.lineTo(x, A.b); ctx.stroke();
      ctx.fillText(t.label, x, A.b + 5);
    });
    ctx.strokeStyle = colors['graph-axis'];
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(A.l, A.t); ctx.lineTo(A.l, A.b); ctx.lineTo(A.r, A.b); ctx.stroke();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(o.xLabel, (A.l + A.r) / 2, g.h - 4);
    ctx.save();
    ctx.translate(14, (A.t + A.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(o.yLabel, 0, 0);
    ctx.restore();
    if (o.y2) {
      ctx.strokeStyle = o.y2.color || colors['graph-axis'];
      ctx.beginPath(); ctx.moveTo(A.r, A.t); ctx.lineTo(A.r, A.b); ctx.stroke();
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = o.y2.color || colors['graph-axis'];
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      o.y2.ticks.forEach(function (t) { ctx.fillText(t.label, A.r + 5, sy2(t.v)); });
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.save();
      ctx.translate(g.w - 8, (A.t + A.b) / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(o.y2.label, 0, 0);
      ctx.restore();
    }
    return { A: A, sx: sx, sy: sy, sy2: sy2 };
  }

  function legendRowsNeeded(g, items) {
    var ctx = g.ctx;
    ctx.font = '12px system-ui, sans-serif';
    var x = 58, rows = 1;
    items.forEach(function (it) {
      var w = 28 + ctx.measureText(it.label).width + 14;
      if (x + w > g.w - 8 && x > 58) { rows++; x = 58; }
      x += w;
    });
    return rows;
  }
  function drawLegend(g, items) {
    var ctx = g.ctx;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var x = 58, y = 12;
    items.forEach(function (it) {
      var w = 28 + ctx.measureText(it.label).width + 14;
      if (x + w > g.w - 8 && x > 58) { x = 58; y += 18; }
      ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = it.width || 2.5;
      ctx.setLineDash(it.dash || []);
      if (it.dot) { ctx.beginPath(); ctx.arc(x + 11, y, 5, 0, Math.PI * 2); ctx.fill(); }
      else if (it.box) { ctx.fillRect(x + 2, y - 6, 18, 12); }
      else { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 22, y); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = colors.text;
      ctx.fillText(it.label, x + 28, y);
      x += w;
    });
  }

  function plotFn(ctx, ax, f, x0, x1, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    for (var i = 0; i <= 160; i++) {
      var x = x0 + (x1 - x0) * i / 160;
      var px = ax.sx(x), py = ax.sy(f(x));
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function ticksLinear(y0, y1, count) {
    var st = niceStep(y1 - y0, count), out = [];
    for (var v = y0; v <= y1 + st * 0.001; v += st) out.push({ v: v, label: tickLabel(v, st) });
    return out;
  }
  var X40 = [0, 5, 10, 15, 20, 25, 30, 35, 40].map(function (v) { return { v: v, label: String(v) }; });

  function drawCurveTab(g) {
    var ctx = g.ctx;
    var P = state.P;
    var sp = F.SPECIES[state.species];
    var f = function (T) { return F.doSaturation(T, P); };
    var ref = function (T) { return F.doSaturation(T, F.ATM_HPA); };
    var yMax = niceMax(Math.max(f(0), ref(0), state.DO) * 1.04, 5);
    var st = F.speciesStatus(state);
    var Csat = f(state.T);
    var col = colors[GRADE_COLOR[st.key]];
    var items = [
      { label: '현재 기압 ' + fmt(P, 0) + ' hPa 포화 곡선', color: colors['graph-curve'] },
      { label: '1013.25 hPa (해수면)', color: colors['graph-ref'], dash: [6, 5], width: 2 },
      { label: '현재 상태 (수온, 실제 DO)', color: col, dot: true },
      { label: '치사 수온', color: colors.red, width: 2 }
    ];
    var ax = drawAxes(g, {
      x0: 0, x1: 40, y0: 0, y1: yMax, legendRows: legendRowsNeeded(g, items),
      xTicks: X40, yTicks: ticksLinear(0, yMax, 5),
      xLabel: '수온 (℃)', yLabel: '용존산소 DO (mg/L)'
    });
    drawLegend(g, items);
    var A = ax.A;
    ctx.save();
    ctx.beginPath(); ctx.rect(A.l, A.t - 2, A.r - A.l + 2, A.b - A.t + 4); ctx.clip();
    // 어종 DO 기준 색 띠
    var bands = [
      ['lethal', 0, sp.DO.danger], ['danger', sp.DO.danger, sp.DO.caution],
      ['caution', sp.DO.caution, sp.DO.comfort], ['comfort', sp.DO.comfort, yMax]
    ];
    bands.forEach(function (b) {
      ctx.fillStyle = colors['band-' + b[0]];
      var y0 = ax.sy(b[2]), y1 = ax.sy(b[1]);
      ctx.fillRect(A.l, y0, A.r - A.l, y1 - y0);
    });
    // 쾌적 수온 범위(세로 띠)
    var cx0 = ax.sx(sp.comfortT[0]), cx1 = ax.sx(sp.comfortT[1]);
    ctx.fillStyle = colors['band-temp'];
    ctx.fillRect(cx0, A.t, cx1 - cx0, A.b - A.t);
    ctx.strokeStyle = colors.green; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
    [cx0, cx1].forEach(function (x) { ctx.beginPath(); ctx.moveTo(x, A.t); ctx.lineTo(x, A.b); ctx.stroke(); });
    ctx.setLineDash([]);
    // 치사 수온
    var lx = ax.sx(sp.lethalT);
    ctx.strokeStyle = colors.red; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lx, A.t); ctx.lineTo(lx, A.b); ctx.stroke();
    plotFn(ctx, ax, ref, 0, 40, colors['graph-ref'], 2, [6, 5]);
    plotFn(ctx, ax, f, 0, 40, colors['graph-curve'], 2.8);
    // 현재 점과 산소 결핍량 화살표
    var px = ax.sx(state.T), py = ax.sy(Math.min(state.DO, yMax)), pc = ax.sy(Math.min(Csat, yMax));
    var deficit = Csat - state.DO;
    if (Math.abs(py - pc) > 8) {
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, pc); ctx.stroke();
      var dir = pc < py ? -1 : 1;
      ctx.beginPath(); ctx.moveTo(px, pc); ctx.lineTo(px - 5, pc - dir * 9); ctx.lineTo(px + 5, pc - dir * 9); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = col; ctx.strokeStyle = colors.surface; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    // 띠 이름
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    bands.forEach(function (b) {
      var yTop = ax.sy(Math.min(b[2], yMax)), yBot = ax.sy(b[1]);
      if (yBot - yTop < 12) return;
      ctx.fillStyle = colors[GRADE_COLOR[b[0]]];
      ctx.fillText('DO ' + F.GRADES[b[0]].label, A.r - 4, (yTop + yBot) / 2);
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.green;
    ctx.fillText('쾌적 수온', (cx0 + cx1) / 2, A.t + 2);
    ctx.fillStyle = colors.red;
    ctx.textAlign = lx > A.r - 60 ? 'right' : 'left';
    ctx.fillText('치사 ' + sp.lethalT + '℃', lx + (lx > A.r - 60 ? -4 : 4), A.t + 16);
    // 결핍량 라벨
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = col;
    var alignRight = px > (A.l + A.r) / 2;
    ctx.textAlign = alignRight ? 'right' : 'left';
    var tx = alignRight ? px - 12 : px + 12;
    var lab = deficit > 0.05 ? '산소 결핍 ' + fmt(deficit) + ' mg/L' : deficit < -0.05 ? '과포화 +' + fmt(-deficit) + ' mg/L' : '포화 상태';
    ctx.textBaseline = 'middle';
    ctx.fillText(lab, tx, clamp((py + pc) / 2, A.t + 30, A.b - 24));
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = colors.muted;
    ctx.fillText('(' + fmt(state.T, 1) + ' ℃, ' + fmt(state.DO) + ' mg/L)', tx, clamp((py + pc) / 2 + 16, A.t + 46, A.b - 8));
  }

  function drawTimeTab(g) {
    var ctx = g.ctx;
    var W = F.HISTORY_WINDOW;
    var now = state.time;
    var x0 = Math.max(0, now - W), x1 = Math.max(W, now);
    var data = state.history.filter(function (p) { return p.t >= x0 - 0.5; });
    var peak = 0;
    data.forEach(function (p) { peak = Math.max(peak, p.DO, p.Csat); });
    peak = Math.max(peak, state.DO, F.doSaturation(state.T, state.P), 1);
    var yMax = niceMax(peak * 1.08, 5);
    var items = [
      { label: '포화 DO (mg/L)', color: colors['graph-curve'], dash: [6, 5] },
      { label: '실제 DO (mg/L)', color: colors['graph-do'] },
      { label: '생존률 (%, 오른쪽 축)', color: colors['graph-surv'] }
    ];
    var xt = [];
    for (var v = Math.ceil(x0 / 20) * 20; v <= x1 + 0.001; v += 20) xt.push({ v: v, label: String(Math.round(v)) });
    var ax = drawAxes(g, {
      x0: x0, x1: x1, y0: 0, y1: yMax, legendRows: legendRowsNeeded(g, items),
      xTicks: xt, yTicks: ticksLinear(0, yMax, 5),
      xLabel: '시뮬레이션 시간 (분) — 최근 120분', yLabel: 'DO (mg/L)',
      y2: { y0: 0, y1: 100, label: '생존률 (%)', color: colors['graph-surv'], ticks: [0, 25, 50, 75, 100].map(function (t) { return { v: t, label: String(t) }; }) }
    });
    drawLegend(g, items);
    ctx.save();
    ctx.beginPath(); ctx.rect(ax.A.l, ax.A.t - 2, ax.A.r - ax.A.l + 2, ax.A.b - ax.A.t + 4); ctx.clip();
    var pts = data.concat([{ t: now, DO: state.DO, Csat: F.doSaturation(state.T, state.P), surv: state.S * 100 }]);
    [['Csat', colors['graph-curve'], [6, 5], ax.sy], ['DO', colors['graph-do'], [], ax.sy], ['surv', colors['graph-surv'], [], ax.sy2]].forEach(function (sr) {
      ctx.strokeStyle = sr[1]; ctx.lineWidth = 2.5; ctx.setLineDash(sr[2]);
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var px = ax.sx(Math.max(p.t, x0)), py = sr[3](p[sr[0]]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.fillStyle = colors['graph-do'];
    ctx.beginPath(); ctx.arc(ax.sx(now), ax.sy(state.DO), 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors['graph-surv'];
    ctx.beginPath(); ctx.arc(ax.sx(now), ax.sy2(state.S * 100), 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawGasTab(g) {
    var ctx = g.ctx;
    var log = $('gasLog').checked;
    var gases = [['CO2', 'CO₂', colors['graph-co2']], ['O2', 'O₂', colors['graph-o2']], ['N2', 'N₂', colors['graph-n2']]];
    var items = gases.map(function (gs) { return { label: gs[1] + ' (1 atm 순수 기체)', color: gs[2] }; });
    items.push({ label: '현재 수온', color: colors.muted, dash: [3, 4], width: 1.5 });
    var opts = {
      x0: 0, x1: 40, legendRows: legendRowsNeeded(g, items),
      xTicks: X40,
      xLabel: '수온 (℃)', yLabel: '몰 용해도 (mmol/L)' + (log ? ' · 로그' : '')
    };
    if (log) {
      opts.log = true; opts.y0 = 0.1; opts.y1 = 100;
      opts.yTicks = [0.1, 1, 10, 100].map(function (v) { return { v: v, label: String(v) }; });
    } else {
      opts.y0 = 0; opts.y1 = 80;
      opts.yTicks = ticksLinear(0, 80, 4);
    }
    var ax = drawAxes(g, opts);
    drawLegend(g, items);
    ctx.save();
    ctx.beginPath(); ctx.rect(ax.A.l, ax.A.t - 2, ax.A.r - ax.A.l + 2, ax.A.b - ax.A.t + 4); ctx.clip();
    gases.forEach(function (gs) {
      plotFn(ctx, ax, function (T) { return F.molarSolubility(gs[0], T); }, 0, 40, gs[2], 2.6);
    });
    var x = ax.sx(state.T);
    ctx.strokeStyle = colors.muted; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x, ax.A.t); ctx.lineTo(x, ax.A.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    gases.forEach(function (gs) {
      var v = F.molarSolubility(gs[0], state.T);
      var y = ax.sy(v);
      ctx.fillStyle = gs[2];
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = x > (ax.A.l + ax.A.r) / 2 ? 'right' : 'left';
      ctx.fillText(gs[1] + ' ' + fmt(v) + ' mmol/L', x + (ctx.textAlign === 'right' ? -8 : 8), y - 9);
    });
    ctx.restore();
  }

  function drawGraph() {
    var g = setupCanvas();
    if (!g) return;
    if (currentTab === 'curve') drawCurveTab(g);
    else if (currentTab === 'time') drawTimeTab(g);
    else drawGasTab(g);
  }

  // ═════════════════════════ 상태 카드·슬라이더·기록 ═════════════════════════
  var els = {
    badge: $('statusBadge'), vT: $('vT'), vP: $('vP'), vPump: $('vPump'), vSpecies: $('vSpecies'), vFish: $('vFish'),
    vSurv: $('vSurv'), vCsat: $('vCsat'), vDO: $('vDO'), vReason: $('vReason'), vTime: $('vTime'), vSpeed: $('vSpeed'),
    fHenry: $('fHenry'), fCsat: $('fCsat'), fRate: $('fRate'), fSteady: $('fSteady'),
    caption: $('caption'),
    sT: $('sT'), sP: $('sP'), sN: $('sN'), oT: $('oT'), oP: $('oP'), oN: $('oN'),
    btnPump: $('btnPump'), btnPause: $('btnPause'), speciesHint: $('speciesHint')
  };

  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  var sliderHold = { sT: 0, sP: 0, sN: 0 };
  var lastCauseVersion = -1;

  function updateStatus() {
    var st = F.speciesStatus(state);
    var sp = F.SPECIES[state.species];
    var Csat = F.doSaturation(state.T, state.P);
    var tT = state.heatwave ? state.heatwave.to : state.target.T;
    setText(els.vT, fmt(state.T, 1) + ' ℃' + (Math.abs(state.T - tT) > 0.05 ? ' → ' + fmt(tT, 1) : '') + (state.heatwave ? ' 🔥' : ''));
    setText(els.vP, fmt(state.P, 1) + ' hPa (' + F.altitudeText(state.P) + ')');
    setText(els.vPump, state.pump ? '💨 켬' : '끔');
    setText(els.vSpecies, sp.name + ' (' + sp.kind + ')');
    setText(els.vFish, F.aliveCount(state) + ' / ' + state.fishBase + '마리');
    setText(els.vSurv, fmt(state.S * 100, 1) + ' %');
    setText(els.vCsat, fmt(Csat) + ' mg/L');
    setText(els.vDO, fmt(state.DO) + ' mg/L');
    setText(els.badge, sp.short + ' 기준: ' + st.label);
    els.badge.className = 'badge ' + st.key;
    setText(els.vReason, st.reasons.length ? '📋 ' + st.reasons.join(', ') + ' → 물고기: ' + st.behaviorLabel : '📋 수온과 용존산소 모두 ' + sp.name + '에게 쾌적해요.');
    setText(els.vTime, fmt(state.time, 1) + '분');
    setText(els.vSpeed, '속도 ×' + fmtShort(state.speed) + ' (실제 1초 = ' + fmtShort(state.speed) + '분)' + (state.paused ? ' · ⏸ 일시정지 중' : ''));
    var f = F.formulas(state);
    setText(els.fHenry, f.henry); setText(els.fCsat, f.csat); setText(els.fRate, f.rate); setText(els.fSteady, f.steady);

    var cap = F.caption(state);
    setText(els.caption, cap.text);
    els.caption.setAttribute('data-grade', cap.grade);

    var now = performance.now();
    if (now > sliderHold.sT) els.sT.value = String(tT);
    if (now > sliderHold.sP) els.sP.value = String(state.target.P);
    if (now > sliderHold.sN) els.sN.value = String(F.aliveCount(state));
    setText(els.oT, fmt(tT, 1) + ' ℃');
    setText(els.oP, fmt(state.target.P, 0) + ' hPa · ' + F.altitudeText(state.target.P).replace('해발 ', ''));
    setText(els.oN, F.aliveCount(state) + '마리');
    setText(els.btnPump, state.pump ? '💨 에어펌프 끄기' : '💨 에어펌프 켜기');
    els.btnPump.setAttribute('aria-pressed', String(state.pump));
    setText(els.btnPause, state.paused ? '▶ 다시 진행' : '⏸ 일시정지');
    document.querySelectorAll('.seg-btn[data-speed]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-speed')) === state.speed));
    });
    document.querySelectorAll('.species-btn').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-species') === state.species));
    });
    setText(els.speciesHint, sp.name + '(' + sp.kind + '): 쾌적 수온 ' + sp.comfortT[0] + '~' + sp.comfortT[1] + '℃, 치사 수온 ' + sp.lethalT +
      '℃ · DO 쾌적 ≥' + sp.DO.comfort + ', 주의 ' + sp.DO.caution + '~' + sp.DO.comfort + ', 위험 ' + sp.DO.danger + '~' + sp.DO.caution + ', 치사 <' + sp.DO.danger + ' mg/L');
  }

  function flashCaption() {
    if (state.version === lastCauseVersion) return;
    lastCauseVersion = state.version;
    els.caption.classList.remove('flash');
    void els.caption.offsetWidth;
    els.caption.classList.add('flash');
  }

  // 기록 표
  var recHead = $('recHead'), recBody = $('recBody');
  F.RECORD_HEADERS.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; recHead.appendChild(th); });
  var renderedRecords = -1;
  function renderRecords() {
    if (renderedRecords === state.records.length) return;
    renderedRecords = state.records.length;
    recBody.textContent = '';
    if (!state.records.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = F.RECORD_HEADERS.length;
      td.className = 'empty';
      td.textContent = '아직 기록이 없어요. "지금 상태 기록해줘"라고 말하거나 📌 지금 기록 버튼을 눌러 보세요.';
      tr.appendChild(td); recBody.appendChild(tr);
      return;
    }
    state.records.forEach(function (r) {
      var tr = document.createElement('tr');
      F.recordRow(r).forEach(function (cell, i) {
        var td = document.createElement('td');
        td.textContent = cell;
        if (i === 4 || i === 5) td.style.textAlign = 'center';
        if (i === 10) td.className = 'st-' + cell;
        tr.appendChild(td);
      });
      recBody.appendChild(tr);
    });
    var wrap = recBody.closest('.table-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  $('btnCsv').addEventListener('click', function () {
    if (!state.records.length) { toast('먼저 기록을 남겨 주세요.'); return; }
    var blob = new Blob(['﻿' + F.recordsToCSV(state.records)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '물고기_용존산소_실험기록.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('CSV 파일을 저장했어요.');
  });
  $('btnCopy').addEventListener('click', function () {
    if (!state.records.length) { toast('먼저 기록을 남겨 주세요.'); return; }
    var text = F.recordsToTSV(state.records);
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? '표를 복사했어요. 엑셀이나 한글 문서에 붙여 넣어 보세요.' : '복사하지 못했어요. CSV 저장을 이용해 주세요.');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('표를 복사했어요. 엑셀이나 한글 문서에 붙여 넣어 보세요.'); }, fallback);
    } else fallback();
  });

  // ═════════════════════════ 액션 실행 ═════════════════════════
  var scene3d = null;

  function runAction(action) {
    var res = F.applyAction(state, action);
    if (action.type === 'reset' && scene3d) scene3d.reset(state);
    renderRecords();
    updateStatus();
    flashCaption();
    drawGraph();
    return res;
  }

  function manual(action) {
    var res = runAction(action);
    addLog('manual', res.message);
    if (res.warning) addLog('warn', '⚠ ' + res.warning);
  }

  // 상단 바
  document.querySelectorAll('.seg-btn[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () { manual({ type: 'setSpeed', multiplier: Number(b.getAttribute('data-speed')) }); });
  });
  els.btnPause.addEventListener('click', function () { manual({ type: state.paused ? 'resume' : 'pause' }); });
  $('btnReset').addEventListener('click', function () { manual({ type: 'reset' }); });

  // 수동 조작
  els.btnPump.addEventListener('click', function () { manual({ type: state.pump ? 'pumpOff' : 'pumpOn' }); });
  document.querySelectorAll('.species-btn').forEach(function (b) {
    b.addEventListener('click', function () { manual({ type: 'setSpecies', species: b.getAttribute('data-species') }); });
  });
  document.querySelectorAll('.scn').forEach(function (b) {
    b.addEventListener('click', function () { manual({ type: 'scenario', name: b.getAttribute('data-scenario') }); });
  });
  $('btnRecord').addEventListener('click', function () { manual({ type: 'record' }); });

  var lastSliderMsg = {};
  function bindSlider(id, makeAction) {
    var el = els[id];
    el.addEventListener('input', function () {
      sliderHold[id] = performance.now() + 600;
      var res = runAction(makeAction(Number(el.value)));
      lastSliderMsg[id] = res;
    });
    el.addEventListener('change', function () {
      sliderHold[id] = performance.now() + 300;
      var res = lastSliderMsg[id];
      if (res) {
        addLog('manual', res.message);
        if (res.warning) addLog('warn', '⚠ ' + res.warning);
      }
      lastSliderMsg[id] = null;
    });
  }
  bindSlider('sT', function (v) { return { type: 'setTemperature', value: v }; });
  bindSlider('sP', function (v) { return { type: 'setPressure', value: v }; });
  bindSlider('sN', function (v) { return { type: 'setFishCount', value: v }; });

  // 3D 버튼
  $('btnCamReset').addEventListener('click', function () { if (scene3d) scene3d.resetCamera(); });
  $('btnCloseUp').addEventListener('click', function () { if (scene3d) scene3d.closeUp(); });
  function bindToggle(id, fn) {
    $(id).addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', String(on));
      if (scene3d) fn(on);
    });
  }
  bindToggle('btnWater', function (on) { scene3d.setWaterVisible(on); });
  bindToggle('btnN2', function (on) { scene3d.setN2Visible(on); });

  // 그래프 탭
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      currentTab = t.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (o) { o.setAttribute('aria-selected', String(o === t)); });
      $('gasExtra').hidden = currentTab !== 'gas';
      drawGraph();
    });
  });
  $('gasLog').addEventListener('change', drawGraph);
  document.querySelectorAll('.question').forEach(function (q) {
    q.addEventListener('click', function () { handleCommand(q.getAttribute('data-ask')); });
  });

  // ═════════════════════════ 채팅 기록 ═════════════════════════
  var chatLog = $('chatLog');
  var TAGS = { user: '학생 입력', parse: '해석 결과', ai: 'AI 설명', warn: '주의', note: '알림', manual: '수동 조작' };
  function addLog(kind, text) {
    var row = document.createElement('div');
    row.className = 'msg ' + kind;
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = TAGS[kind] || kind;
    var body = document.createElement('span');
    body.className = 'body';
    body.textContent = text;
    row.appendChild(tag); row.appendChild(body);
    chatLog.appendChild(row);
    while (chatLog.children.length > 200) chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ═════════════════════════ LLM 해석기 ═════════════════════════
  var DEFAULT_MODELS = { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', custom: '' };
  function looksLikeClaudePreview() {
    var hay = '';
    try {
      hay = location.hostname + ' ' + document.referrer;
      if (location.ancestorOrigins) hay += ' ' + Array.prototype.join.call(location.ancestorOrigins, ' ');
    } catch (e) { hay = ''; }
    return /claude\.ai|claudeusercontent|anthropic\.com/i.test(hay);
  }
  // API 키는 이 변수(메모리)에만 보관한다. 저장소·브라우저 저장공간·화면·콘솔에 남기지 않는다.
  var settings = { enabled: looksLikeClaudePreview(), provider: 'anthropic', model: DEFAULT_MODELS.anthropic, key: '', baseUrl: '' };
  var keylessFailed = false;

  function aiActive() {
    if (!settings.enabled) return false;
    if (settings.provider === 'anthropic') return !!settings.key || !keylessFailed;
    if (settings.provider === 'custom') return !!settings.baseUrl;
    return !!settings.key;
  }
  function updateModeBadge() {
    var b = $('modeBadge');
    var on = aiActive();
    b.className = 'mode-badge' + (on ? ' ai' : '');
    b.textContent = '';
    var long = document.createElement('span');
    long.className = 'long';
    long.textContent = on ? '🤖 AI 모드(' + (settings.model || '기본 모델') + ')' : '🧩 내장 해석기';
    var short = document.createElement('span');
    short.className = 'short';
    short.textContent = on ? '🤖 AI' : '🧩 내장';
    b.appendChild(long); b.appendChild(short);
    b.title = on ? 'AI 모드: ' + (settings.model || '') + ' (실패하면 내장 해석기로 자동 전환)' : '내장 규칙 기반 해석기 (오프라인에서도 동작)';
  }

  function HttpError(status) { this.name = 'HttpError'; this.status = status; this.message = 'HTTP ' + status; }
  HttpError.prototype = Object.create(Error.prototype);

  function postJSON(url, headers, body, signal) {
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal }).then(function (res) {
      if (!res.ok) throw new HttpError(res.status);
      return res.json();
    });
  }

  var PROVIDERS = {
    anthropic: function (sys, text, signal) {
      var headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      if (settings.key) headers['x-api-key'] = settings.key;
      return postJSON('https://api.anthropic.com/v1/messages', headers, {
        model: settings.model || DEFAULT_MODELS.anthropic,
        max_tokens: 1000,
        system: sys,
        messages: [{ role: 'user', content: text }]
      }, signal).then(function (d) {
        return (d.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      });
    },
    openai: function (sys, text, signal) {
      return postJSON('https://api.openai.com/v1/chat/completions', {
        'content-type': 'application/json', authorization: 'Bearer ' + settings.key
      }, {
        model: settings.model || DEFAULT_MODELS.openai,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
        response_format: { type: 'json_object' }
      }, signal).then(function (d) { return d.choices[0].message.content; });
    },
    gemini: function (sys, text, signal) {
      var model = settings.model || DEFAULT_MODELS.gemini;
      return postJSON('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        'content-type': 'application/json', 'x-goog-api-key': settings.key
      }, {
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: 'user', parts: [{ text: text }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1000 }
      }, signal).then(function (d) {
        return d.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
      });
    },
    custom: function (sys, text, signal) {
      var url = settings.baseUrl.replace(/\/+$/, '');
      if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
      var headers = { 'content-type': 'application/json' };
      if (settings.key) headers.authorization = 'Bearer ' + settings.key;
      return postJSON(url, headers, {
        model: settings.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: text }],
        temperature: 0.2
      }, signal).then(function (d) { return d.choices[0].message.content; });
    }
  };

  function parseLLMJson(raw) {
    var t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').replace(/```/g, '').trim();
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i < 0 || j < i) throw new SyntaxError('JSON 없음');
    return JSON.parse(t.slice(i, j + 1));
  }

  function callLLM(text) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        var e = new Error('timeout'); e.name = 'TimeoutError'; reject(e);
      }, 8000);
    });
    var sys = F.buildLLMPrompt(state);
    var request = PROVIDERS[settings.provider](sys, text, ctrl ? ctrl.signal : undefined).then(function (raw) {
      var obj = parseLLMJson(raw);
      var v = F.validateCommand(obj);
      if (!v.ok) { var e = new Error(v.errors[0]); e.name = 'ValidationError'; throw e; }
      return v.command;
    });
    return Promise.race([request, timeout]).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
  }

  function failureReason(e) {
    if (!e) return '알 수 없는 오류';
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return '8초 안에 응답이 없음';
    if (e.name === 'HttpError') return e.status === 401 || e.status === 403 ? 'API 키 인증 실패(HTTP ' + e.status + ')' : 'HTTP ' + e.status;
    if (e.name === 'SyntaxError') return '응답을 JSON으로 읽지 못함';
    if (e.name === 'ValidationError') return '명령 형식 검증 실패: ' + e.message;
    if (e.name === 'TypeError') return '네트워크 오류';
    return '오류';
  }

  // ═════════════════════════ 명령 처리 ═════════════════════════
  var busy = false;
  var dock = $('dock'), input = $('cmdInput'), sendBtn = $('btnSend');

  function setBusy(b) {
    busy = b;
    input.disabled = b;
    sendBtn.disabled = b;
    dock.classList.toggle('busy', b);
    sendBtn.setAttribute('aria-busy', String(b));
    document.querySelectorAll('.chip').forEach(function (c) { c.disabled = b; });
    if (!b) input.focus({ preventScroll: true });
  }

  function handleCommand(text) {
    text = String(text || '').trim();
    if (!text || busy) return Promise.resolve();
    setBusy(true);
    addLog('user', text);
    input.value = '';
    var usedKeyless = settings.provider === 'anthropic' && !settings.key;
    var first = aiActive()
      ? callLLM(text).then(function (cmd) { return { cmd: cmd, note: null }; }, function (e) {
        var reason = failureReason(e);
        if (usedKeyless) { keylessFailed = true; updateModeBadge(); }
        return { cmd: null, note: 'AI 응답 실패(' + reason + ') → 🧩 내장 해석기로 처리했어요.' };
      })
      : Promise.resolve({ cmd: null, note: null });

    return first.then(function (r) {
      if (r.note) addLog('note', r.note);
      var cmd = r.cmd || F.parseCommand(text, state);
      var i = 0;
      function next() {
        if (i >= cmd.actions.length) {
          if (cmd.reply) addLog('ai', cmd.reply);
          return Promise.resolve();
        }
        var a = cmd.actions[i];
        var wait = i === 0 ? Promise.resolve() : sleep(300);
        i++;
        return wait.then(function () {
          var res = runAction(a);
          addLog('parse', res.message);
          if (res.warning) addLog('warn', '⚠ ' + res.warning);
          return next();
        });
      }
      return next();
    }).catch(function () {
      addLog('warn', '명령을 처리하는 중 문제가 생겼어요. 다시 시도해 주세요.');
    }).then(function () { setBusy(false); });
  }

  $('cmdForm').addEventListener('submit', function (e) {
    e.preventDefault();
    handleCommand(input.value);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault(); // 한글 조합 중 Enter 무시
  });

  // 예시 칩
  var chips = $('chips');
  EXAMPLE_CHIPS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = t;
    b.addEventListener('click', function () { handleCommand(t); });
    chips.appendChild(b);
  });

  // 음성 입력 (Web Speech API, ko-KR)
  (function setupSpeech() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var mic = $('btnMic');
    if (!SR) { mic.hidden = true; return; }
    mic.hidden = false;
    var rec = null, listening = false;
    mic.addEventListener('click', function () {
      if (busy) return;
      if (listening && rec) { rec.stop(); return; }
      try {
        rec = new SR();
        rec.lang = 'ko-KR';
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = function (ev) {
          var said = ev.results[0][0].transcript;
          input.value = said;
          handleCommand(said);
        };
        rec.onerror = function (ev) { toast(ev.error === 'not-allowed' ? '마이크 권한을 허용해 주세요.' : '음성을 알아듣지 못했어요.'); };
        rec.onend = function () { listening = false; mic.classList.remove('listening'); };
        rec.start();
        listening = true;
        mic.classList.add('listening');
      } catch (e) { toast('음성 입력을 시작하지 못했어요.'); }
    });
  })();

  // ═════════════════════════ AI 설정 대화상자 ═════════════════════════
  var dlg = $('settings');
  var fProvider = $('setProvider'), fModel = $('setModel'), fKey = $('setKey'), fBase = $('setBaseUrl'), fEnabled = $('setEnabled');
  var dlgProvider = settings.provider;
  function syncProviderUI() { $('rowBaseUrl').hidden = fProvider.value !== 'custom'; }
  fProvider.addEventListener('change', function () {
    var prev = dlgProvider;
    if (!fModel.value || fModel.value === DEFAULT_MODELS[prev]) fModel.value = DEFAULT_MODELS[fProvider.value];
    dlgProvider = fProvider.value;
    syncProviderUI();
  });
  $('btnSettings').addEventListener('click', function () {
    fEnabled.checked = settings.enabled;
    fProvider.value = settings.provider;
    dlgProvider = settings.provider;
    fModel.value = settings.model;
    fBase.value = settings.baseUrl;
    fKey.value = '';
    fKey.placeholder = settings.key ? '키가 입력되어 있어요(바꾸려면 새로 입력)' : '키는 이 탭의 메모리에만 보관돼요';
    syncProviderUI();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
  function closeDialog() { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  $('setCancel').addEventListener('click', function (e) { e.preventDefault(); closeDialog(); });
  $('setClearKey').addEventListener('click', function () {
    settings.key = '';
    fKey.value = '';
    fKey.placeholder = '키는 이 탭의 메모리에만 보관돼요';
    keylessFailed = false;
    updateModeBadge();
    toast('API 키를 지웠어요.');
  });
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var changedProvider = settings.provider !== fProvider.value;
    settings.enabled = fEnabled.checked;
    settings.provider = fProvider.value;
    settings.model = fModel.value.trim() || DEFAULT_MODELS[settings.provider];
    settings.baseUrl = fBase.value.trim();
    if (fKey.value) settings.key = fKey.value.trim();
    else if (changedProvider) settings.key = '';
    fKey.value = '';
    keylessFailed = false;
    updateModeBadge();
    closeDialog();
    var msg = aiActive() ? 'AI 모드를 켰어요: ' + settings.model : '내장 해석기를 사용해요.';
    if (settings.enabled && !aiActive()) msg = 'API 키(또는 주소)가 없어 내장 해석기를 사용해요.';
    addLog('note', msg);
  });

  // ═════════════════════════ 시작 ═════════════════════════
  var viewer = $('viewer');
  try {
    scene3d = createScene($('scene'), viewer);
  } catch (e) {
    scene3d = null;
  }
  if (!scene3d) {
    $('scene').hidden = true;
    $('glFallback').hidden = false;
    document.querySelector('.view-tools').hidden = true;
  } else {
    scene3d.onQuality(function (q) {
      setText($('quality'), q < 0.999 ? '성능 조절: 분자 ' + Math.round(q * 100) + '%' : '');
    });
  }

  // 모바일에서 고정된 입력창 높이만큼 본문 아래 여백을 둔다
  function syncDockHeight() { document.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px'); }
  if (window.ResizeObserver) new ResizeObserver(syncDockHeight).observe(dock);
  syncDockHeight();
  if (window.ResizeObserver) new ResizeObserver(function () { drawGraph(); }).observe(graphCanvas);

  updateModeBadge();
  renderRecords();
  updateStatus();
  drawGraph();
  addLog('note', '수온 20℃, 해발 0 m 수조(100 L)에 무지개송어 20마리가 있어요. 아래 입력창에 "수온 5도 올려줘"처럼 명령하거나 시나리오 버튼을 눌러 보세요.');

  var rafId = 0, lastT = 0, uiTimer = 0, graphTimer = 0;
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!lastT) lastT = now;
    var dt = Math.min(0.25, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    F.tick(state, dt);
    if (scene3d) scene3d.update(dt, state);
    uiTimer += dt; graphTimer += dt;
    if (uiTimer >= 0.1) { uiTimer = 0; updateStatus(); }
    if (graphTimer >= 0.066) { graphTimer = 0; drawGraph(); }
  }
  function start() { if (!rafId) { lastT = 0; rafId = requestAnimationFrame(loop); } }
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
  // 탭이 숨겨지면 시뮬레이션과 렌더링을 멈춘다
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
  if (!document.hidden) start();

  // 자동 점검용(콘솔에서 상태 확인)
  globalThis.FishApp = { getState: function () { return state; }, run: handleCommand };
})();
