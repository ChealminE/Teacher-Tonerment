/*
 * 탄산수 속 CO₂ 용해도 AI 시뮬레이터 — 화면(UI), 3D 장면, 그래프, LLM 호출, 채팅 기록
 * core.js가 만든 globalThis.SodaCore를 사용한다.
 */
(function () {
  'use strict';

  var S = globalThis.SodaCore;
  var THREE = globalThis.THREE;
  var state = S.createState();
  var fmt = S.fmt;
  var fmtShort = S.fmtShort;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  var EXAMPLE_CHIPS = ['온도 10도 올려줘', '주변 기압 10hPa 올려줘', '뚜껑 열어줘', '병 흔들어줘', '마셔줘', '지금 상태 기록해줘'];

  // ═════════════════════════ 3D 장면 ═════════════════════════
  var R = 1.0;          // 병 반지름
  var H = 4.2;          // 병 높이
  var WT = 2.9;         // 수면 높이
  var LIQ_R = 0.8;      // 분자가 움직이는 액체 영역 반지름
  var GAS_TOP = H - 0.22;
  var MAX_MOL = 300;
  var MAX_BUBBLES = 120;
  var N_WATER = 16;
  var MOL_SCALE = 0.78;  // 화면이 붐비지 않도록 분자 모형 크기 조절(그래도 실제보다 훨씬 크다)

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

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.75));
    var key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(5, 9, 6);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0xbfdcff, 0.35);
    rim.position.set(-5, 3, -6);
    scene.add(rim);

    // 받침
    var floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 48),
      new THREE.MeshPhongMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.25, depthWrite: false })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    scene.add(floor);

    var bottle = new THREE.Group();
    scene.add(bottle);

    // 유리 병
    var glassMat = new THREE.MeshPhongMaterial({
      color: 0xd6ecff, specular: 0xffffff, shininess: 120,
      transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false
    });
    var glassGeo = new THREE.CylinderGeometry(R, R, H, 56, 1, true);
    glassGeo.translate(0, H / 2, 0);
    var glass = new THREE.Mesh(glassGeo, glassMat);
    glass.renderOrder = 3;
    bottle.add(glass);
    var glassBottom = new THREE.Mesh(new THREE.CircleGeometry(R, 56), glassMat);
    glassBottom.rotation.x = -Math.PI / 2;
    glassBottom.position.y = 0.005;
    bottle.add(glassBottom);
    var rimMat = new THREE.MeshPhongMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.55, shininess: 80 });
    [0.01, H].forEach(function (y) {
      var ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.025, 8, 64), rimMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      bottle.add(ring);
    });

    // 물
    var waterMat = new THREE.MeshPhongMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.2, shininess: 60, depthWrite: false });
    var waterGeo = new THREE.CylinderGeometry(R * 0.975, R * 0.975, WT, 56, 1, true);
    waterGeo.translate(0, WT / 2, 0);
    var water = new THREE.Mesh(waterGeo, waterMat);
    water.renderOrder = 2;
    bottle.add(water);
    var surfaceMat = new THREE.MeshPhongMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false, shininess: 100 });
    var surface = new THREE.Mesh(new THREE.CircleGeometry(R * 0.975, 56), surfaceMat);
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = WT;
    surface.renderOrder = 2;
    bottle.add(surface);
    var surfRing = new THREE.Mesh(new THREE.TorusGeometry(R * 0.975, 0.012, 6, 64), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    surfRing.rotation.x = Math.PI / 2;
    surfRing.position.y = WT;
    bottle.add(surfRing);

    // 뚜껑
    var capGroup = new THREE.Group();
    var capMat = new THREE.MeshPhongMaterial({ color: 0xdc2626, shininess: 50 });
    var capBody = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.06, R * 1.06, 0.32, 40), capMat);
    capGroup.add(capBody);
    var capTop = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.9, R * 1.06, 0.06, 40), new THREE.MeshPhongMaterial({ color: 0xef4444, shininess: 70 }));
    capTop.position.y = 0.19;
    capGroup.add(capTop);
    for (var g = 0; g < 24; g++) {
      var ridge = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.05), new THREE.MeshPhongMaterial({ color: 0xb91c1c }));
      var ang = g / 24 * Math.PI * 2;
      ridge.position.set(Math.cos(ang) * R * 1.075, 0, Math.sin(ang) * R * 1.075);
      ridge.rotation.y = -ang;
      capGroup.add(ridge);
    }
    var CAP_Y = H + 0.16;
    capGroup.position.y = CAP_Y;
    bottle.add(capGroup);

    // ── CO₂ 분자(InstancedMesh: C, O, 결합 막대) ──
    var cMat = new THREE.MeshPhongMaterial({ color: 0x374151, shininess: 60 });
    var oMat = new THREE.MeshPhongMaterial({ color: 0xef4444, shininess: 60 });
    var bondMat = new THREE.MeshPhongMaterial({ color: 0xd1d5db, shininess: 30 });
    var cMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 14, 10), cMat, MAX_MOL);
    var oMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.066, 14, 10), oMat, MAX_MOL * 2);
    var bMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 6), bondMat, MAX_MOL * 4);
    [cMesh, oMesh, bMesh].forEach(function (m) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      bottle.add(m);
    });

    var L_O = [new THREE.Matrix4().makeTranslation(0.2, 0, 0), new THREE.Matrix4().makeTranslation(-0.2, 0, 0)];
    var L_B = [];
    var rotZ = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    [1, -1].forEach(function (side) {
      [0.024, -0.024].forEach(function (off) {
        L_B.push(new THREE.Matrix4().makeTranslation(side * 0.1, off, 0).multiply(rotZ));
      });
    });

    // ── 물 분자(H–O–H 104.5°) ──
    var half = 104.5 / 2 * Math.PI / 180;
    var OH = 0.13;
    var hPos = [new THREE.Vector3(Math.sin(half) * OH, Math.cos(half) * OH, 0), new THREE.Vector3(-Math.sin(half) * OH, Math.cos(half) * OH, 0)];
    var wOMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshPhongMaterial({ color: 0xf87171, transparent: true, opacity: 0.35, depthWrite: false }), N_WATER);
    var wHMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }), N_WATER * 2);
    var wBMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, OH, 6), new THREE.MeshPhongMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.35, depthWrite: false }), N_WATER * 2);
    var L_WH = hPos.map(function (p) { return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z); });
    var L_WB = hPos.map(function (p) {
      var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
      return new THREE.Matrix4().compose(p.clone().multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    });
    var waterGroup = new THREE.Group();
    [wOMesh, wHMesh, wBMesh].forEach(function (m) { m.frustumCulled = false; m.renderOrder = 1; waterGroup.add(m); });
    bottle.add(waterGroup);
    var waters = [];
    for (var w = 0; w < N_WATER; w++) {
      waters.push({ pos: randomLiquidPos(new THREE.Vector3()), rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)), av: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)), vel: new THREE.Vector3() });
    }

    // ── 기포 ──
    var bubbleMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0x1e3a5f, specular: 0xffffff, shininess: 140, transparent: true, opacity: 0.55, depthWrite: false }),
      MAX_BUBBLES
    );
    bubbleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bubbleMesh.frustumCulled = false;
    bubbleMesh.renderOrder = 4;
    bubbleMesh.count = 0;
    bottle.add(bubbleMesh);

    // ── 분자·기포 풀 ──
    var mols = [];
    for (var i = 0; i < MAX_MOL; i++) {
      mols.push({ active: false, region: 'liquid', pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), av: new THREE.Vector3(), s: 0, dying: false });
    }
    var bubbles = [];
    for (var j = 0; j < MAX_BUBBLES; j++) bubbles.push({ active: false, pos: new THREE.Vector3(), r: 0, r0: 0, y0: 0, vy: 0, ph: 0 });

    function randomLiquidPos(v) {
      var a = rand(0, Math.PI * 2), rr = LIQ_R * Math.sqrt(Math.random());
      return v.set(Math.cos(a) * rr, rand(0.18, WT - 0.18), Math.sin(a) * rr);
    }
    function randomGasPos(v) {
      var a = rand(0, Math.PI * 2), rr = LIQ_R * Math.sqrt(Math.random());
      return v.set(Math.cos(a) * rr, rand(WT + 0.2, GAS_TOP), Math.sin(a) * rr);
    }
    function freeMol() {
      for (var k = 0; k < mols.length; k++) if (!mols[k].active) return mols[k];
      return null;
    }
    function spawnMol(region, posFn, instant) {
      var m = freeMol();
      if (!m) return null;
      m.active = true; m.dying = false; m.region = region;
      posFn(m.pos);
      m.vel.set(rand(-0.2, 0.2), rand(-0.2, 0.2), rand(-0.2, 0.2));
      m.rot.set(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3));
      m.av.set(rand(-2, 2), rand(-2, 2), rand(-2, 2));
      m.s = instant ? 1 : 0.01;
      return m;
    }

    var quality = 1;
    var pendingBubbleCO2 = 0;
    var budgets = { remove: 0, add: 0, gasAdd: 0, gasRemove: 0, bubble: 0 };
    var capAnim = 0;
    var clock = 0;

    function countRegion(pred) {
      var n = 0;
      for (var k = 0; k < mols.length; k++) { var m = mols[k]; if (m.active && !m.dying && pred(m)) n++; }
      return n;
    }
    function isLiquid(m) { return m.region === 'liquid' || m.region === 'enter'; }
    function isGas(m) { return m.region === 'gas'; }

    function targets(st) {
      var c = S.displayCounts(st);
      return { L: Math.round(c.dissolved * quality), G: Math.round(c.headspace * quality) };
    }

    function fill(st) {
      mols.forEach(function (m) { m.active = false; });
      bubbles.forEach(function (b) { b.active = false; });
      pendingBubbleCO2 = 0;
      var t = targets(st);
      for (var a = 0; a < t.L; a++) spawnMol('liquid', randomLiquidPos, true);
      for (var b = 0; b < t.G; b++) spawnMol('gas', randomGasPos, true);
      capAnim = st.capOpen ? 1 : 0;
    }

    function removeLiquidMolecule() {
      var cands = [];
      for (var k = 0; k < mols.length; k++) { var m = mols[k]; if (m.active && !m.dying && m.region === 'liquid') cands.push(m); }
      if (!cands.length) return;
      if (Math.random() < 0.2) {
        // 20 %: 수면 확산 — 수면 가까운 분자가 위로 빠져나간다
        cands.sort(function (a, b) { return b.pos.y - a.pos.y; });
        var top = cands[Math.floor(Math.random() * Math.min(5, cands.length))];
        top.region = 'rise';
        top.vel.set(rand(-0.1, 0.1), 0.6, rand(-0.1, 0.1));
      } else {
        // 80 %: 기포 속으로 모여 사라진다
        var m2 = cands[Math.floor(Math.random() * cands.length)];
        m2.dying = true;
        pendingBubbleCO2++;
      }
    }

    function addLiquidMolecule(st) {
      var gasM = null;
      if (!st.capOpen) {
        for (var k = 0; k < mols.length; k++) { var m = mols[k]; if (m.active && !m.dying && m.region === 'gas') { if (!gasM || m.pos.y < gasM.pos.y) gasM = m; } }
      }
      if (gasM) {
        gasM.region = 'enter';
        gasM.vel.set(gasM.vel.x * 0.3, -0.8, gasM.vel.z * 0.3);
      } else {
        var nm = spawnMol('enter', function (v) { randomGasPos(v); v.y = Math.min(v.y, WT + 0.45); }, false);
        if (nm) nm.vel.set(0, -0.8, 0);
      }
    }

    function spawnBubble() {
      var b = null;
      var limit = Math.floor(MAX_BUBBLES * Math.max(0.4, quality));
      var active = 0;
      for (var k = 0; k < bubbles.length; k++) { if (bubbles[k].active) active++; else if (!b) b = bubbles[k]; }
      if (!b || active >= limit) return;
      b.active = true;
      var a = rand(0, Math.PI * 2);
      if (Math.random() < 0.5) {
        var rr = (R - 0.12) * Math.sqrt(Math.random());
        b.pos.set(Math.cos(a) * rr, 0.08, Math.sin(a) * rr);
      } else {
        b.pos.set(Math.cos(a) * (R - 0.09), rand(0.15, WT - 0.4), Math.sin(a) * (R - 0.09));
      }
      b.r0 = rand(0.016, 0.03);
      b.r = b.r0;
      b.y0 = b.pos.y;
      b.vy = rand(0.15, 0.35);
      b.ph = rand(0, 6.3);
    }

    function popBubble(b, st) {
      b.active = false;
      var n = Math.random() < 0.5 ? 2 : 3;
      if (countRegion(function (m) { return m.region === 'rise' || m.region === 'escape'; }) > 45) n = 0; // 화면이 너무 붐비지 않게
      for (var k = 0; k < n; k++) {
        var px = b.pos.x, pz = b.pos.z;
        var m = spawnMol('rise', function (v) { v.set(px + rand(-0.08, 0.08), WT + 0.04, pz + rand(-0.08, 0.08)); }, false);
        if (m) m.vel.set(rand(-0.25, 0.25), rand(0.7, 1.1), rand(-0.25, 0.25));
      }
      pendingBubbleCO2 = Math.max(0, pendingBubbleCO2 - n);
    }

    function keepInCylinder(m, rmax, ymin, ymax) {
      var rr = Math.hypot(m.pos.x, m.pos.z);
      if (rr > rmax) {
        var nx = m.pos.x / rr, nz = m.pos.z / rr;
        m.pos.x = nx * rmax; m.pos.z = nz * rmax;
        var vn = m.vel.x * nx + m.vel.z * nz;
        if (vn > 0) { m.vel.x -= 2 * vn * nx; m.vel.z -= 2 * vn * nz; }
      }
      if (m.pos.y < ymin) { m.pos.y = ymin; if (m.vel.y < 0) m.vel.y = -m.vel.y; }
      if (m.pos.y > ymax) { m.pos.y = ymax; if (m.vel.y > 0) m.vel.y = -m.vel.y; }
    }

    var tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();

    function update(dt, st) {
      clock += dt;
      var mdt = st.paused ? 0 : dt;

      // 뚜껑 애니메이션: 떠오르며 회전
      var capGoal = st.capOpen ? 1 : 0;
      capAnim += clamp(capGoal - capAnim, -dt * 1.4, dt * 1.4);
      var e = capAnim * capAnim * (3 - 2 * capAnim);
      capGroup.position.set(e * 1.55, CAP_Y + e * 0.85, 0);
      capGroup.rotation.set(0, e * Math.PI * 3, -e * 0.55);

      // 흔들기
      var env = 0;
      if (st.shakeRemaining > 0) env = Math.min(1, st.shakeRemaining / 0.4, (st.shakeDuration - st.shakeRemaining) / 0.15 + 0.2);
      bottle.rotation.z = Math.sin(clock * 22) * 0.16 * env;
      bottle.position.x = Math.sin(clock * 17) * 0.1 * env;

      // ── 분자 수 맞추기 ──
      if (mdt > 0) {
        var t = targets(st);
        var nL = countRegion(isLiquid);
        var excess = nL - t.L;
        if (excess > 0) {
          budgets.remove += mdt * Math.max(6, excess * 2.5);
          while (budgets.remove >= 1 && excess > 0) { budgets.remove -= 1; excess--; removeLiquidMolecule(); }
        } else budgets.remove = 0;
        var deficit = t.L - nL;
        if (deficit > 0) {
          budgets.add += mdt * Math.max(4, deficit * 2);
          while (budgets.add >= 1 && deficit > 0) { budgets.add -= 1; deficit--; addLiquidMolecule(st); }
        } else budgets.add = 0;

        if (st.capOpen) {
          mols.forEach(function (m) {
            if (m.active && m.region === 'gas') { m.region = 'escape'; m.vel.set(rand(-0.3, 0.3), rand(1.4, 2.4), rand(-0.3, 0.3)); }
          });
        } else {
          var nG = countRegion(isGas);
          if (nG < t.G) {
            budgets.gasAdd += mdt * Math.max(10, (t.G - nG) * 3);
            while (budgets.gasAdd >= 1 && nG < t.G) {
              budgets.gasAdd -= 1; nG++;
              spawnMol('gas', function (v) { randomGasPos(v); v.y = rand(GAS_TOP - 0.3, GAS_TOP); }, false);
            }
          } else budgets.gasAdd = 0;
          if (nG > t.G + 2) {
            budgets.gasRemove += mdt * 4;
            while (budgets.gasRemove >= 1 && nG > t.G) {
              budgets.gasRemove -= 1; nG--;
              for (var k = 0; k < mols.length; k++) { if (mols[k].active && !mols[k].dying && mols[k].region === 'gas') { mols[k].dying = true; break; } }
            }
          } else budgets.gasRemove = 0;
        }

        // ── 기포 생성: 과포화 정도에 비례 ──
        var stt = S.saturationStatus(st);
        var rate = 0;
        if (stt.key === 'supersaturated') {
          var ratio = Math.min(stt.rel, 3);
          var absEx = clamp((st.C - stt.Ceq) / 1.5, 0.12, 1);
          rate = 16 * ratio * absEx * (S.isShaking(st) ? 4 : 1) * Math.min(3, Math.sqrt(st.speed));
          if (pendingBubbleCO2 > 6) rate += 6;
        }
        budgets.bubble += rate * mdt;
        while (budgets.bubble >= 1) { budgets.bubble -= 1; spawnBubble(); }
      }

      // ── 기포 이동 ──
      var nb = 0;
      for (var bi = 0; bi < bubbles.length; bi++) {
        var b = bubbles[bi];
        if (!b.active) continue;
        if (mdt > 0) {
          b.vy = Math.min(2.0, b.vy + 1.0 * mdt);
          b.pos.y += b.vy * mdt;
          b.pos.x += Math.sin(clock * 6 + b.ph) * 0.05 * mdt;
          b.pos.z += Math.cos(clock * 5 + b.ph) * 0.05 * mdt;
          b.r = Math.min(0.11, b.r0 + (b.pos.y - b.y0) * 0.025);
          if (b.pos.y + b.r >= WT) { popBubble(b, st); continue; }
        }
        tmpS.set(b.r, b.r, b.r);
        tmpQ.identity();
        tmpM.compose(b.pos, tmpQ, tmpS);
        bubbleMesh.setMatrixAt(nb++, tmpM);
      }
      bubbleMesh.count = nb;
      bubbleMesh.instanceMatrix.needsUpdate = true;

      // ── 분자 이동 ──
      var vT = 0.28 * (1 + st.T / 25) * (1 + 2 * env);
      var n = 0;
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
              m.vel.x += rand(-1, 1) * 3 * speed * mdt;
              m.vel.y += rand(-1, 1) * 3 * speed * mdt;
              m.vel.z += rand(-1, 1) * 3 * speed * mdt;
              limitSpeed(m.vel, speed);
              m.pos.addScaledVector(m.vel, mdt);
              keepInCylinder(m, LIQ_R, 0.16, WT - 0.14);
              break;
            case 'gas':
              speed *= 1.7;
              m.vel.x += rand(-1, 1) * 3 * speed * mdt;
              m.vel.y += rand(-1, 1) * 3 * speed * mdt;
              m.vel.z += rand(-1, 1) * 3 * speed * mdt;
              limitSpeed(m.vel, speed);
              m.pos.addScaledVector(m.vel, mdt);
              keepInCylinder(m, LIQ_R, WT + 0.16, GAS_TOP);
              break;
            case 'rise':
              m.pos.addScaledVector(m.vel, mdt);
              keepInCylinder(m, LIQ_R, 0.1, H + 5);
              if (m.pos.y > WT + 0.3) {
                if (st.capOpen) { m.region = 'escape'; m.vel.y = rand(1.4, 2.2); }
                else { m.region = 'gas'; }
              }
              break;
            case 'enter':
              m.vel.y = -0.8;
              m.pos.addScaledVector(m.vel, mdt);
              keepInCylinder(m, LIQ_R, 0.16, H);
              if (m.pos.y < WT - 0.25) { m.region = 'liquid'; m.vel.set(rand(-0.1, 0.1), -0.1, rand(-0.1, 0.1)); }
              break;
            case 'escape':
              m.vel.x += rand(-1, 1) * mdt;
              m.vel.z += rand(-1, 1) * mdt;
              m.pos.addScaledVector(m.vel, mdt);
              if (m.pos.y < H) keepInCylinder(m, LIQ_R, WT + 0.1, H + 10);
              else m.vel.x += (m.pos.x >= 0 ? 0.6 : -0.6) * mdt;
              if (m.pos.y > H + 0.4) m.s = Math.min(m.s, Math.max(0, 1 - (m.pos.y - H - 0.4) / 1.4));
              if (m.pos.y > H + 1.8) { m.active = false; continue; }
              break;
          }
          m.rot.x += m.av.x * speed * 2 * mdt;
          m.rot.y += m.av.y * speed * 2 * mdt;
          m.rot.z += m.av.z * speed * 2 * mdt;
        }
        tmpQ.setFromEuler(m.rot);
        var sc = Math.max(0.001, m.s) * MOL_SCALE;
        tmpS.set(sc, sc, sc);
        tmpM.compose(m.pos, tmpQ, tmpS);
        cMesh.setMatrixAt(n, tmpM);
        oMesh.setMatrixAt(n * 2, tmpM2.multiplyMatrices(tmpM, L_O[0]));
        oMesh.setMatrixAt(n * 2 + 1, tmpM2.multiplyMatrices(tmpM, L_O[1]));
        for (var bb = 0; bb < 4; bb++) bMesh.setMatrixAt(n * 4 + bb, tmpM2.multiplyMatrices(tmpM, L_B[bb]));
        n++;
      }
      cMesh.count = n; oMesh.count = n * 2; bMesh.count = n * 4;
      cMesh.instanceMatrix.needsUpdate = true;
      oMesh.instanceMatrix.needsUpdate = true;
      bMesh.instanceMatrix.needsUpdate = true;

      // ── 물 분자 ──
      if (waterGroup.visible) {
        for (var wi = 0; wi < waters.length; wi++) {
          var wm = waters[wi];
          if (mdt > 0) {
            wm.vel.x += rand(-1, 1) * 0.4 * mdt; wm.vel.y += rand(-1, 1) * 0.4 * mdt; wm.vel.z += rand(-1, 1) * 0.4 * mdt;
            limitSpeed(wm.vel, vT * 0.5);
            wm.pos.addScaledVector(wm.vel, mdt);
            keepInCylinder(wm, LIQ_R, 0.2, WT - 0.2);
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

      updateCamera(dt);
      renderer.render(scene, camera);
      measureFps(dt);
    }

    function limitSpeed(v, max) {
      var l = v.length();
      if (l > max) v.multiplyScalar(max / l);
    }

    // ── 카메라 조작(드래그 회전·휠/핀치 확대) ──
    var DEFAULT_VIEW = { theta: 0.55, phi: 1.22, radius: 10, target: new THREE.Vector3(0, 2.3, 0) };
    var CLOSE_VIEW = { theta: 0.35, phi: 1.33, radius: 3.4, target: new THREE.Vector3(0, WT, 0) };
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
      // 가장 가까운 방향으로 돌아가도록 각도를 맞춘다
      var th = view.theta;
      while (th - cam.theta > Math.PI) th -= Math.PI * 2;
      while (th - cam.theta < -Math.PI) th += Math.PI * 2;
      camGoal = { theta: th, phi: view.phi, radius: view.radius * fitFactor(), target: view.target.clone() };
    }
    function fitFactor() {
      var a = camera.aspect || 1;
      return a < 0.9 ? Math.min(1.6, 0.9 / a) : 1;
    }

    var pointers = new Map();
    var pinchDist = 0;
    canvas.addEventListener('pointerdown', function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      camGoal = null;
      if (pointers.size === 2) pinchDist = pointerDistance();
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      var p = pointers.get(ev.pointerId);
      var dx = ev.clientX - p.x, dy = ev.clientY - p.y;
      p.x = ev.clientX; p.y = ev.clientY;
      if (pointers.size === 1) {
        cam.theta -= dx * 0.008;
        cam.phi = clamp(cam.phi - dy * 0.008, 0.25, 1.75);
      } else if (pointers.size === 2) {
        var d = pointerDistance();
        if (pinchDist > 0 && d > 0) cam.radius = clamp(cam.radius * pinchDist / d, 2, 18);
        pinchDist = d;
      }
    });
    function endPointer(ev) {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinchDist = 0;
    }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('lostpointercapture', endPointer);
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      camGoal = null;
      cam.radius = clamp(cam.radius * (1 + clamp(ev.deltaY, -200, 200) * 0.0012), 2, 18);
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
      reset: function (st) { fill(st); goTo(DEFAULT_VIEW); },
      resetCamera: function () { goTo(DEFAULT_VIEW); },
      closeUp: function () { goTo(CLOSE_VIEW); },
      setWaterVisible: function (v) { waterGroup.visible = v; },
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
    ['--graph-axis', '--graph-grid', '--graph-curve', '--graph-ref', '--graph-co2', '--graph-o2', '--graph-n2', '--graph-c', '--text', '--muted', '--orange', '--green', '--blue', '--surface'].forEach(function (k) {
      colors[k.slice(2)] = cs.getPropertyValue(k).trim() || '#888';
    });
  }
  readColors();
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { readColors(); drawGraph(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }

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

  /** 축, 눈금, 축 이름을 그리고 좌표 변환 함수를 돌려준다. */
  function drawAxes(g, o) {
    var ctx = g.ctx;
    var A = { l: 58, r: g.w - 14, t: o.legendRows * 18 + 12, b: g.h - 40 };
    var sx = function (x) { return A.l + (x - o.x0) / (o.x1 - o.x0) * (A.r - A.l); };
    var sy;
    if (o.log) {
      var l0 = Math.log10(o.y0), l1 = Math.log10(o.y1);
      sy = function (y) { return A.b - (Math.log10(Math.max(y, o.y0 * 0.5)) - l0) / (l1 - l0) * (A.b - A.t); };
    } else {
      sy = function (y) { return A.b - (y - o.y0) / (o.y1 - o.y0) * (A.b - A.t); };
    }
    ctx.font = '12px system-ui, sans-serif';
    ctx.lineWidth = 1;
    // 격자와 눈금
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
    // 축선
    ctx.strokeStyle = colors['graph-axis'];
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(A.l, A.t); ctx.lineTo(A.l, A.b); ctx.lineTo(A.r, A.b); ctx.stroke();
    // 축 이름
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
    return { A: A, sx: sx, sy: sy };
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
  function statusColor(key) { return key === 'supersaturated' ? colors.orange : key === 'saturated' ? colors.green : colors.blue; }

  function drawCurveTab(g) {
    var ctx = g.ctx;
    var P = S.effectivePCO2(state);
    var f = function (T) { return S.solubilityAt(T, P); };
    var ref = function (T) { return S.solubilityAt(T, S.ATM_HPA); };
    var yMax = niceMax(Math.max(f(0), ref(0), state.C) * 1.08, 5);
    var st = S.saturationStatus(state);
    var items = [
      { label: '현재 P_CO₂ ' + fmt(P) + ' hPa (' + fmtShort(P / S.ATM_HPA) + ' atm)', color: colors['graph-curve'] },
      { label: '1 atm 기준', color: colors['graph-ref'], dash: [6, 5], width: 2 },
      { label: '현재 상태 (온도, 용존 CO₂)', color: statusColor(st.key), dot: true }
    ];
    var ax = drawAxes(g, {
      x0: 0, x1: 80, y0: 0, y1: yMax, legendRows: legendRowsNeeded(g, items),
      xTicks: [0, 10, 20, 30, 40, 50, 60, 70, 80].map(function (v) { return { v: v, label: String(v) }; }),
      yTicks: ticksLinear(0, yMax, 5),
      xLabel: '온도 (℃)', yLabel: 'CO₂ 용해도 (g/L)'
    });
    drawLegend(g, items);
    ctx.save();
    ctx.beginPath(); ctx.rect(ax.A.l, ax.A.t - 2, ax.A.r - ax.A.l + 2, ax.A.b - ax.A.t + 4); ctx.clip();
    plotFn(ctx, ax, ref, 0, 80, colors['graph-ref'], 2, [6, 5]);
    plotFn(ctx, ax, f, 0, 80, colors['graph-curve'], 2.8);
    // 현재 점 → 곡선(평형)으로 향하는 화살표
    var px = ax.sx(state.T), py = ax.sy(Math.min(state.C, yMax)), pe = ax.sy(Math.min(st.Ceq, yMax));
    var col = statusColor(st.key);
    if (Math.abs(py - pe) > 10) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, pe); ctx.stroke(); ctx.setLineDash([]);
      var dir = pe > py ? 1 : -1;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(px, pe); ctx.lineTo(px - 5, pe - dir * 9); ctx.lineTo(px + 5, pe - dir * 9); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = col; ctx.strokeStyle = colors.surface; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    // 라벨
    var lab = st.key === 'supersaturated' ? '과포화 (곡선 위)' : st.key === 'unsaturated' ? '불포화 (곡선 아래)' : '포화 (곡선 위의 점)';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = col;
    ctx.textBaseline = 'bottom';
    var tx = px + 10, alignRight = px > (ax.A.l + ax.A.r) / 2;
    ctx.textAlign = alignRight ? 'right' : 'left';
    if (alignRight) tx = px - 10;
    var ty = Math.max(ax.A.t + 16, py - 8);
    ctx.fillText(lab, tx, ty);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = colors.muted;
    ctx.textBaseline = 'top';
    ctx.fillText('(' + fmt(state.T) + ' ℃, ' + fmt(state.C) + ' g/L)', tx, Math.min(ax.A.b - 16, py + 8));
  }

  function drawTimeTab(g) {
    var ctx = g.ctx;
    var now = state.time;
    var x0 = Math.max(0, now - S.HISTORY_WINDOW), x1 = Math.max(S.HISTORY_WINDOW, now);
    if (now > S.HISTORY_WINDOW) x0 = now - S.HISTORY_WINDOW;
    var data = state.history.filter(function (p) { return p.t >= x0 - 0.5; });
    var peak = 0;
    data.forEach(function (p) { peak = Math.max(peak, p.C, p.Ceq); });
    peak = Math.max(peak, state.C, S.equilibriumSolubility(state), 1);
    var yMax = niceMax(peak * 1.12, 5);
    var items = [
      { label: '용존 CO₂ C (g/L)', color: colors['graph-c'] },
      { label: '평형 용해도 C_eq (g/L)', color: colors['graph-curve'], dash: [6, 5] }
    ];
    var step = 10, xt = [];
    for (var v = Math.ceil(x0 / step) * step; v <= x1 + 0.001; v += step) xt.push({ v: v, label: String(Math.round(v)) });
    var ax = drawAxes(g, {
      x0: x0, x1: x1, y0: 0, y1: yMax, legendRows: legendRowsNeeded(g, items),
      xTicks: xt, yTicks: ticksLinear(0, yMax, 5),
      xLabel: '시뮬레이션 시간 (s) — 최근 60초', yLabel: 'CO₂ 농도 (g/L)'
    });
    drawLegend(g, items);
    ctx.save();
    ctx.beginPath(); ctx.rect(ax.A.l, ax.A.t - 2, ax.A.r - ax.A.l + 2, ax.A.b - ax.A.t + 4); ctx.clip();
    var pts = data.concat([{ t: now, C: state.C, Ceq: S.equilibriumSolubility(state) }]);
    [['Ceq', colors['graph-curve'], [6, 5]], ['C', colors['graph-c'], []]].forEach(function (sr) {
      ctx.strokeStyle = sr[1]; ctx.lineWidth = 2.5; ctx.setLineDash(sr[2]);
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var px = ax.sx(Math.max(p.t, x0)), py = ax.sy(p[sr[0]]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.fillStyle = colors['graph-c'];
    ctx.beginPath(); ctx.arc(ax.sx(now), ax.sy(state.C), 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawGasTab(g) {
    var ctx = g.ctx;
    var log = $('gasLog').checked;
    var gases = [['CO2', 'CO₂', colors['graph-co2']], ['O2', 'O₂', colors['graph-o2']], ['N2', 'N₂', colors['graph-n2']]];
    var items = gases.map(function (gs) { return { label: gs[1] + ' (1 atm 순수 기체)', color: gs[2] }; });
    items.push({ label: '현재 온도', color: colors.muted, dash: [3, 4], width: 1.5 });
    var opts = {
      x0: 0, x1: 80, legendRows: legendRowsNeeded(g, items),
      xTicks: [0, 10, 20, 30, 40, 50, 60, 70, 80].map(function (v) { return { v: v, label: String(v) }; }),
      xLabel: '온도 (℃)', yLabel: '몰 용해도 (mmol/L)' + (log ? ' · 로그' : '')
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
      plotFn(ctx, ax, function (T) { return S.molarSolubility(gs[0], T); }, 0, 80, gs[2], 2.6);
    });
    var x = ax.sx(state.T);
    ctx.strokeStyle = colors.muted; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x, ax.A.t); ctx.lineTo(x, ax.A.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    gases.forEach(function (gs) {
      var v = S.molarSolubility(gs[0], state.T);
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
    badge: $('statusBadge'), vT: $('vT'), vPb: $('vPb'), vPa: $('vPa'), vCap: $('vCap'), vC: $('vC'), vCeq: $('vCeq'),
    vTime: $('vTime'), vPeff: $('vPeff'), vSpeed: $('vSpeed'),
    fK: $('fK'), fP: $('fP'), fCeq: $('fCeq'), fRate: $('fRate'),
    caption: $('caption'),
    sT: $('sT'), sPb: $('sPb'), sPa: $('sPa'), oT: $('oT'), oPb: $('oPb'), oPa: $('oPa'),
    btnCap: $('btnCap'), btnPause: $('btnPause'),
    drinkPanel: $('drinkPanel'), drinkReleased: $('drinkReleased'), drinkEq: $('drinkEq'), drinkSip: $('drinkSip'),
    gaugeFill: $('gaugeFill'), gaugeText: $('gaugeText'), gauge: $('gauge')
  };

  function withTarget(cur, target, unit) {
    var s = fmt(cur) + ' ' + unit;
    if (Math.abs(cur - target) > 0.005) s += ' → ' + fmt(target);
    return s;
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  var sliderHold = { sT: 0, sPb: 0, sPa: 0 };
  var lastCaption = '';
  var lastCauseVersion = -1;

  function updateStatus() {
    var st = S.saturationStatus(state);
    setText(els.vT, withTarget(state.T, state.target.T, '℃'));
    setText(els.vPb, withTarget(state.P_bottle, state.target.P_bottle, 'hPa'));
    setText(els.vPa, withTarget(state.P_amb, state.target.P_amb, 'hPa'));
    setText(els.vCap, state.capOpen ? '🔓 열림' : '🔒 닫힘');
    setText(els.vC, fmt(state.C) + ' g/L');
    setText(els.vCeq, fmt(st.Ceq) + ' g/L');
    setText(els.badge, st.label);
    els.badge.className = 'badge ' + st.key;
    setText(els.vTime, fmt(state.time) + ' s');
    setText(els.vPeff, fmt(S.effectivePCO2(state)) + ' hPa');
    setText(els.vSpeed, '속도 ×' + fmtShort(state.speed) + (state.paused ? ' · ⏸ 일시정지 중' : ''));
    var f = S.formulas(state);
    setText(els.fK, f.k); setText(els.fP, f.p); setText(els.fCeq, f.ceq); setText(els.fRate, f.rate);

    var cap = S.caption(state);
    if (cap !== lastCaption) { setText(els.caption, cap); lastCaption = cap; }
    els.caption.setAttribute('data-status', st.key);

    var now = performance.now();
    if (now > sliderHold.sT) els.sT.value = String(state.target.T);
    if (now > sliderHold.sPb) els.sPb.value = String(state.target.P_bottle);
    if (now > sliderHold.sPa) els.sPa.value = String(state.target.P_amb);
    setText(els.oT, fmt(state.target.T) + ' ℃');
    setText(els.oPb, fmt(state.target.P_bottle) + ' hPa');
    setText(els.oPa, fmt(state.target.P_amb) + ' hPa');
    els.sPb.disabled = state.capOpen;
    els.sPb.title = state.capOpen ? '뚜껑이 열려 있어 병 속 압력은 대기 수준이에요' : '';
    setText(els.btnCap, state.capOpen ? '🔒 뚜껑 닫기' : '🔓 뚜껑 열기');
    setText(els.btnPause, state.paused ? '▶ 다시 진행' : '⏸ 일시정지');
    document.querySelectorAll('.seg-btn').forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-speed')) === state.speed));
    });
    updateDrink();
  }

  function flashCaption() {
    if (state.version === lastCauseVersion) return;
    lastCauseVersion = state.version;
    els.caption.classList.remove('flash');
    void els.caption.offsetWidth;
    els.caption.classList.add('flash');
  }

  var drinkDismissed = false;
  function updateDrink() {
    if (!state.drink || drinkDismissed) { els.drinkPanel.hidden = true; return; }
    els.drinkPanel.hidden = false;
    var d = state.drink;
    setText(els.drinkReleased, fmt(d.released));
    setText(els.drinkEq, '= 마시기 직전 용존량 ' + fmt(d.before) + ' g/L − 37℃ 평형 용해도 ' + fmt(d.eq37) + ' g/L');
    setText(els.drinkSip, '한 모금(30 mL)이면 약 ' + fmt(d.released * 30) + ' mg의 CO₂가 입 안에서 기포로 나와요.');
    var rate = state.rates.release;
    var level = clamp(rate / 0.45, 0, 1);
    els.gaugeFill.style.width = (level * 100).toFixed(1) + '%';
    els.gauge.setAttribute('aria-valuenow', String(Math.round(level * 100)));
    var word = state.paused ? '일시정지' : level < 0.02 ? '김 빠짐' : level < 0.2 ? '약함' : level < 0.45 ? '보통' : level < 0.75 ? '강함' : '짜릿!';
    setText(els.gaugeText, word + ' · ' + fmt(rate) + ' g/(L·s)');
  }

  // 기록 표
  var recHead = $('recHead'), recBody = $('recBody');
  S.RECORD_HEADERS.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; recHead.appendChild(th); });
  var renderedRecords = -1;
  function renderRecords() {
    if (renderedRecords === state.records.length) return;
    renderedRecords = state.records.length;
    recBody.textContent = '';
    if (!state.records.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = S.RECORD_HEADERS.length;
      td.className = 'empty';
      td.textContent = '아직 기록이 없어요. "지금 상태 기록해줘"라고 말하거나 📌 지금 기록 버튼을 눌러 보세요.';
      tr.appendChild(td); recBody.appendChild(tr);
      return;
    }
    state.records.forEach(function (r) {
      var tr = document.createElement('tr');
      S.recordRow(r).forEach(function (cell, i) {
        var td = document.createElement('td');
        td.textContent = cell;
        if (i === 5) td.style.textAlign = 'center';
        if (i === 8) td.className = 'st-' + cell;
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
    var blob = new Blob(['﻿' + S.recordsToCSV(state.records)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '탄산수_CO2_실험기록.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('CSV 파일을 저장했어요.');
  });
  $('btnCopy').addEventListener('click', function () {
    if (!state.records.length) { toast('먼저 기록을 남겨 주세요.'); return; }
    var text = S.recordsToTSV(state.records);
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
    var res = S.applyAction(state, action);
    if (action.type === 'reset') {
      drinkDismissed = false;
      if (scene3d) scene3d.reset(state);
    }
    if (action.type === 'drink') drinkDismissed = false;
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
  document.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { manual({ type: 'setSpeed', multiplier: Number(b.getAttribute('data-speed')) }); });
  });
  els.btnPause.addEventListener('click', function () { manual({ type: state.paused ? 'resume' : 'pause' }); });
  $('btnReset').addEventListener('click', function () { manual({ type: 'reset' }); });

  // 수동 조작
  els.btnCap.addEventListener('click', function () { manual({ type: state.capOpen ? 'closeCap' : 'openCap' }); });
  $('btnShake').addEventListener('click', function () { manual({ type: 'shake', seconds: 3 }); });
  $('btnDrink').addEventListener('click', function () { manual({ type: 'drink' }); });
  $('btnRecord').addEventListener('click', function () { manual({ type: 'record' }); });
  $('drinkClose').addEventListener('click', function () { drinkDismissed = true; els.drinkPanel.hidden = true; });

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
  bindSlider('sPb', function (v) { return { type: 'setPressure', value: v }; });
  bindSlider('sPa', function (v) { return { type: 'setAmbientPressure', value: v }; });

  // 3D 버튼
  $('btnCamReset').addEventListener('click', function () { if (scene3d) scene3d.resetCamera(); });
  $('btnCloseUp').addEventListener('click', function () { if (scene3d) scene3d.closeUp(); });
  $('btnWater').addEventListener('click', function () {
    var on = this.getAttribute('aria-pressed') !== 'true';
    this.setAttribute('aria-pressed', String(on));
    if (scene3d) scene3d.setWaterVisible(on);
  });

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
    var sys = S.buildLLMPrompt(state);
    var request = PROVIDERS[settings.provider](sys, text, ctrl ? ctrl.signal : undefined).then(function (raw) {
      var obj = parseLLMJson(raw);
      var v = S.validateCommand(obj);
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
      var cmd = r.cmd || S.parseCommand(text, state);
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
  addLog('note', '냉장고에서 꺼낸 밀봉 탄산수(5℃, 병 속 CO₂ 3500 hPa)예요. 아래 입력창에 "온도 10도 올려줘"처럼 명령해 보세요.');

  var rafId = 0, lastT = 0, uiTimer = 0, graphTimer = 0;
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!lastT) lastT = now;
    var dt = Math.min(0.25, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    S.step(state, dt);
    if (scene3d) scene3d.update(dt, state);
    uiTimer += dt; graphTimer += dt;
    if (uiTimer >= 0.1) { uiTimer = 0; updateStatus(); }
    if (graphTimer >= 0.066) { graphTimer = 0; drawGraph(); }
  }
  function start() { if (!rafId) { lastT = 0; rafId = requestAnimationFrame(loop); } }
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
  // 탭이 숨겨지면 렌더링을 멈춘다
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
  if (!document.hidden) start();

  // 자동 점검용(콘솔에서 상태 확인)
  globalThis.SodaApp = { getState: function () { return state; }, run: handleCommand };
})();
