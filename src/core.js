/*
 * SodaCore — 탄산수 속 CO₂ 용해도 시뮬레이터의 과학 모델과 내장 자연어 해석기
 * DOM·THREE·fetch를 쓰지 않는 순수 로직이다. (classic script)
 */
(function (root) {
  'use strict';

  // ───────────────────────── 상수 ─────────────────────────
  var ATM_HPA = 1013.25;            // 1 atm = 1013.25 hPa
  var M_CO2 = 44.01;                // g/mol
  var OPEN_CO2_FRACTION = 0.0004;   // 대기 중 CO₂ 비율(약 0.04 %)
  var T_REF = 298.15;               // K
  var RAMP_SEC = 1.5;               // 온도·압력 변화 시간(실제 초)
  var DRINK_RAMP_SEC = 2;           // 마시기 온도 상승 시간
  var DRINK_TEMP = 37;              // 체온(℃)
  var SHAKE_DEFAULT = 3;            // 흔들기 기본 시간(초)
  var SHAKE_FACTOR = 6;             // 흔들기 중 k_out 배율
  var K_IN = 0.008;                 // 1/s
  var BUBBLE_SHARE = 0.8;           // 감소분 중 기포로 빠져나가는 비율
  var SAT_TOL = 0.03;               // 포화 평형 판정 허용 오차(3 %)
  var HISTORY_WINDOW = 60;          // 시간 그래프 창(시뮬레이션 초)
  var HISTORY_DT = 0.25;            // 기록 간격(시뮬레이션 초)
  var MAX_SUBSTEP = 0.05;           // 적분 부분 단계(실제 초)

  var GASES = {
    CO2: { k298: 0.034, C: 2400, M: 44.01, name: 'CO₂' },
    O2: { k298: 0.0013, C: 1500, M: 32.00, name: 'O₂' },
    N2: { k298: 0.00061, C: 1300, M: 28.01, name: 'N₂' }
  };

  var LIMITS = {
    T: { min: 0, max: 80, unit: '℃', name: '온도' },
    P_bottle: { min: 0, max: 6000, unit: 'hPa', name: '병 속 CO₂ 압력' },
    P_amb: { min: 300, max: 2000, unit: 'hPa', name: '주변 기압' },
    speed: { min: 0.25, max: 20, unit: '배', name: '속도' },
    shake: { min: 0.5, max: 10, unit: '초', name: '흔들기 시간' }
  };

  var INITIAL = { T: 5, P_bottle: 3500, P_amb: 1013.25 };

  var EXAMPLES = ['온도 10도 올려줘', '뚜껑 열어줘', '압력 5000hPa로 맞춰줘'];

  var ACTION_SPECS = {
    setTemperature: { value: 'number' },
    changeTemperature: { delta: 'number' },
    setPressure: { value: 'number' },
    changePressure: { delta: 'number' },
    setAmbientPressure: { value: 'number' },
    changeAmbientPressure: { delta: 'number' },
    openCap: {},
    closeCap: {},
    shake: { seconds: 'number?' },
    drink: {},
    setSpeed: { multiplier: 'number' },
    pause: {},
    resume: {},
    reset: {},
    record: {},
    explain: { question: 'string?' },
    unknown: {}
  };

  // ───────────────────────── 숫자 표시 ─────────────────────────
  /** 소수 둘째 자리까지. 0.01보다 작은 양수는 유효숫자 2개로 보여 준다. */
  function fmt(x, digits) {
    if (digits === undefined) digits = 2;
    if (typeof x !== 'number' || !isFinite(x)) return '–';
    if (x !== 0 && Math.abs(x) < 0.01) return String(Number(x.toPrecision(2)));
    return x.toFixed(digits);
  }
  /** 짧은 표기: 불필요한 0을 지운다(5.00 → 5, 1013.25 → 1013.25). */
  function fmtShort(x) {
    if (typeof x !== 'number' || !isFinite(x)) return '–';
    if (x !== 0 && Math.abs(x) < 0.01) return String(Number(x.toPrecision(2)));
    return String(Number(x.toFixed(2)));
  }
  function signed(x) { return (x >= 0 ? '+' : '−') + fmtShort(Math.abs(x)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // ───────────────────────── 과학 모델 ─────────────────────────
  /** 헨리 상수 k_H(T) [mol/(L·atm)] */
  function henryK(gas, T_C) {
    var g = GASES[normalizeGas(gas)];
    var T = T_C + 273.15;
    return g.k298 * Math.exp(g.C * (1 / T - 1 / T_REF));
  }
  function normalizeGas(gas) {
    var k = String(gas || 'CO2').toUpperCase().replace(/[₂]/g, '2').replace(/[^A-Z0-9]/g, '');
    if (!GASES[k]) throw new Error('알 수 없는 기체: ' + gas);
    return k;
  }
  /** 주어진 온도(℃)·CO₂ 압력(hPa)에서 CO₂ 평형 용해도 [g/L] */
  function solubilityAt(T_C, P_hPa) {
    return henryK('CO2', T_C) * (P_hPa / ATM_HPA) * M_CO2;
  }
  /** 1 atm 순수 기체 기준 몰 용해도 [mmol/L] */
  function molarSolubility(gas, T_C, P_atm) {
    if (P_atm === undefined) P_atm = 1;
    return henryK(gas, T_C) * P_atm * 1000;
  }
  /** 유효 CO₂ 압력 [hPa] */
  function effectivePCO2(state) {
    return state.capOpen ? state.P_amb * OPEN_CO2_FRACTION : state.P_bottle;
  }
  function equilibriumSolubility(state) {
    return solubilityAt(state.T, effectivePCO2(state));
  }
  function isShaking(state) { return state.shakeRemaining > 0; }
  function kOut(state) {
    return 0.02 * (1 + (state.T - 5) / 25) * (isShaking(state) ? SHAKE_FACTOR : 1);
  }

  function saturationStatus(state) {
    var Ceq = equilibriumSolubility(state);
    var C = state.C;
    var rel;
    if (Ceq > 1e-12) rel = (C - Ceq) / Ceq;
    else rel = C > 1e-6 ? Infinity : 0;
    var key, label, short, color;
    if (Math.abs(rel) < SAT_TOL) {
      key = 'saturated'; label = '포화 평형'; short = '포화'; color = 'green';
    } else if (rel > 0) {
      key = 'supersaturated'; label = '과포화 → 기포 발생'; short = '과포화'; color = 'orange';
    } else {
      key = 'unsaturated'; label = '불포화 → 기체가 녹아 들어감'; short = '불포화'; color = 'blue';
    }
    return { key: key, label: label, short: short, color: color, rel: rel, C: C, Ceq: Ceq };
  }

  // ───────────────────────── 상태 ─────────────────────────
  function createState() {
    var s = {
      time: 0,
      T: INITIAL.T,
      P_bottle: INITIAL.P_bottle,
      P_amb: INITIAL.P_amb,
      target: { T: INITIAL.T, P_bottle: INITIAL.P_bottle, P_amb: INITIAL.P_amb },
      ramps: { T: null, P_bottle: null, P_amb: null },
      capOpen: false,
      C: 0,
      speed: 1,
      paused: false,
      shakeRemaining: 0,
      shakeDuration: 0,
      rates: { release: 0, bubble: 0, surface: 0, absorb: 0 },
      totals: { bubble: 0, surface: 0, absorbed: 0 },
      drink: null,
      history: [],
      historyTimer: 0,
      records: [],
      lastCause: 'initial',
      version: 0
    };
    s.C = equilibriumSolubility(s);
    pushHistory(s);
    return s;
  }

  /** 기록·이력을 뺀 가벼운 복사본(예측용) */
  function cloneLite(s) {
    return {
      time: s.time, T: s.T, P_bottle: s.P_bottle, P_amb: s.P_amb,
      target: { T: s.target.T, P_bottle: s.target.P_bottle, P_amb: s.target.P_amb },
      ramps: { T: null, P_bottle: null, P_amb: null },
      capOpen: s.capOpen, C: s.C, speed: s.speed, paused: s.paused,
      shakeRemaining: s.shakeRemaining, shakeDuration: s.shakeDuration,
      rates: { release: 0, bubble: 0, surface: 0, absorb: 0 },
      totals: { bubble: 0, surface: 0, absorbed: 0 },
      drink: null, history: [], historyTimer: 0, records: [],
      lastCause: s.lastCause, version: s.version
    };
  }

  /** 목표값이 모두 도달했다고 가정한 평형 용해도(예측용) */
  function targetEquilibrium(s) {
    var P = s.capOpen ? s.target.P_amb * OPEN_CO2_FRACTION : s.target.P_bottle;
    return solubilityAt(s.target.T, P);
  }

  function setTarget(s, key, value, dur) {
    s.target[key] = value;
    s.ramps[key] = { from: s[key], to: value, elapsed: 0, dur: dur || RAMP_SEC };
  }
  /** 값을 목표로 즉시 맞춘다(뚜껑 여닫기처럼 순간적인 변화). */
  function setNow(s, key, value) {
    s.target[key] = value;
    s.ramps[key] = null;
    s[key] = value;
  }

  function advanceRamps(s, dt) {
    ['T', 'P_bottle', 'P_amb'].forEach(function (key) {
      var r = s.ramps[key];
      if (!r) return;
      r.elapsed += dt;
      var u = Math.min(1, r.elapsed / r.dur);
      var e = u * u * (3 - 2 * u);
      s[key] = r.from + (r.to - r.from) * e;
      if (u >= 1) { s[key] = r.to; s.ramps[key] = null; }
    });
  }

  function pushHistory(s) {
    s.history.push({ t: s.time, C: s.C, Ceq: equilibriumSolubility(s), T: s.T });
    var cutoff = s.time - HISTORY_WINDOW - 2;
    while (s.history.length > 2 && s.history[0].t < cutoff) s.history.shift();
  }

  function chemistry(s, h) {
    var Ceq = equilibriumSolubility(s);
    var C0 = s.C;
    var rates = { release: 0, bubble: 0, surface: 0, absorb: 0 };
    if (h > 0) {
      if (C0 > Ceq) {
        var C1 = Ceq + (C0 - Ceq) * Math.exp(-kOut(s) * h);
        var d = C0 - C1;
        s.C = C1;
        rates.release = d / h;
        rates.bubble = rates.release * BUBBLE_SHARE;
        rates.surface = rates.release * (1 - BUBBLE_SHARE);
        s.totals.bubble += d * BUBBLE_SHARE;
        s.totals.surface += d * (1 - BUBBLE_SHARE);
      } else if (C0 < Ceq) {
        var C2 = Ceq - (Ceq - C0) * Math.exp(-K_IN * h);
        rates.absorb = (C2 - C0) / h;
        s.totals.absorbed += C2 - C0;
        s.C = C2;
      }
      s.time += h;
      s.historyTimer += h;
      if (s.historyTimer >= HISTORY_DT) {
        s.historyTimer %= HISTORY_DT;
        pushHistory(s);
      }
    }
    s.rates = rates;
  }

  /**
   * dt: 실제 경과 시간(초). 화학 변화에는 속도 배율이 곱해지고,
   * 온도·압력의 부드러운 변화(1.5초)와 흔들기 시간은 실제 시간으로 흐른다.
   */
  function step(state, dt) {
    if (!(dt > 0)) return state;
    var remaining = dt;
    while (remaining > 1e-9) {
      var h = Math.min(remaining, MAX_SUBSTEP);
      remaining -= h;
      advanceRamps(state, h);
      if (state.shakeRemaining > 0) state.shakeRemaining = Math.max(0, state.shakeRemaining - h);
      if (state.paused) {
        state.rates = { release: 0, bubble: 0, surface: 0, absorb: 0 };
        continue;
      }
      chemistry(state, h * state.speed);
    }
    return state;
  }

  // ───────────────────────── 액션 적용 ─────────────────────────
  function rangeWarning(lim, raw, used) {
    return lim.name + '는 ' + fmtShort(lim.min) + '~' + fmtShort(lim.max) + ' ' + lim.unit +
      ' 범위만 가능해요. ' + fmtShort(raw) + ' ' + lim.unit + ' → ' + fmtShort(used) + ' ' + lim.unit + '로 제한했어요.';
  }
  function clampWithWarning(limKey, raw) {
    var lim = LIMITS[limKey];
    var v = clamp(raw, lim.min, lim.max);
    return { value: v, warning: v !== raw ? rangeWarning(lim, raw, v) : null };
  }

  function makeRecord(s) {
    var st = saturationStatus(s);
    return {
      no: s.records.length + 1,
      time: s.time,
      T: s.T,
      P_eff: effectivePCO2(s),
      P_amb: s.P_amb,
      capOpen: s.capOpen,
      C: s.C,
      Ceq: st.Ceq,
      status: st.short
    };
  }

  function applyTemperature(s, raw, isDelta, dur) {
    var from = s.target.T;
    var desired = isDelta ? from + raw : raw;
    var cw = clampWithWarning('T', desired);
    setTarget(s, 'T', cw.value, dur);
    var to = cw.value;
    if (to > from) s.lastCause = 'tempUp';
    else if (to < from) s.lastCause = 'tempDown';
    var msg = isDelta
      ? '온도 ' + signed(to - from) + '℃ (' + fmtShort(from) + '℃ → ' + fmtShort(to) + '℃)'
      : '온도 설정 (' + fmtShort(from) + '℃ → ' + fmtShort(to) + '℃)';
    return { message: msg, warning: cw.warning };
  }

  function applyAmbient(s, raw, isDelta) {
    var from = s.target.P_amb;
    var desired = isDelta ? from + raw : raw;
    var cw = clampWithWarning('P_amb', desired);
    setTarget(s, 'P_amb', cw.value);
    var to = cw.value;
    s.lastCause = 'ambient';
    var msg = isDelta
      ? '주변 기압 ' + signed(to - from) + ' hPa (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa)'
      : '주변 기압 설정 (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa)';
    return { message: msg, warning: cw.warning };
  }

  function applyBottle(s, raw, isDelta) {
    var from = s.target.P_bottle;
    var desired = isDelta ? from + raw : raw;
    var cw = clampWithWarning('P_bottle', desired);
    setTarget(s, 'P_bottle', cw.value);
    var to = cw.value;
    if (to > from) s.lastCause = 'pressUp';
    else if (to < from) s.lastCause = 'pressDown';
    var msg = isDelta
      ? '병 속 CO₂ 압력 ' + signed(to - from) + ' hPa (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa)'
      : '병 속 CO₂ 압력 설정 (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa)';
    return { message: msg, warning: cw.warning };
  }

  function num(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * action을 상태에 적용한다. state를 직접 바꾸고 {state, message, warning}을 돌려준다.
   */
  function applyAction(state, action) {
    var s = state;
    var r = { message: '', warning: null };
    var a = action || {};
    var type = a.type;

    var needNumber = { setTemperature: 'value', changeTemperature: 'delta', setPressure: 'value', changePressure: 'delta', setAmbientPressure: 'value', changeAmbientPressure: 'delta', setSpeed: 'multiplier' };
    if (needNumber[type] && !num(a[needNumber[type]])) {
      return { state: s, message: '숫자 값을 읽지 못했어요', warning: '"' + type + '" 명령에 올바른 숫자(' + needNumber[type] + ')가 없어요.' };
    }

    switch (type) {
      case 'setTemperature': r = applyTemperature(s, a.value, false); break;
      case 'changeTemperature': r = applyTemperature(s, a.delta, true); break;
      case 'setPressure':
        if (s.capOpen) {
          r = applyAmbient(s, a.value, false);
          r.message += ' — 뚜껑이 열려 있어 주변 기압을 바꿨어요';
        } else r = applyBottle(s, a.value, false);
        break;
      case 'changePressure':
        if (s.capOpen) {
          r = applyAmbient(s, a.delta, true);
          r.message += ' — 뚜껑이 열려 있어 주변 기압을 바꿨어요';
        } else r = applyBottle(s, a.delta, true);
        break;
      case 'setAmbientPressure': r = applyAmbient(s, a.value, false); break;
      case 'changeAmbientPressure': r = applyAmbient(s, a.delta, true); break;
      case 'openCap':
        if (s.capOpen) { r.message = '뚜껑은 이미 열려 있어요'; break; }
        var pBefore = effectivePCO2(s);
        s.capOpen = true;
        // 병 속 CO₂가 빠져나가 병 속 압력도 대기 수준이 된다.
        setNow(s, 'P_bottle', s.P_amb * OPEN_CO2_FRACTION);
        s.lastCause = 'open';
        r.message = '뚜껑 열기 (유효 CO₂ 압력 ' + fmtShort(pBefore) + ' → ' + fmtShort(effectivePCO2(s)) + ' hPa)';
        break;
      case 'closeCap':
        if (!s.capOpen) { r.message = '뚜껑은 이미 닫혀 있어요'; break; }
        s.capOpen = false;
        setNow(s, 'P_bottle', s.P_amb * OPEN_CO2_FRACTION);
        s.lastCause = 'close';
        r.message = '뚜껑 닫기 (병 속 CO₂ 압력 ' + fmtShort(s.P_bottle) + ' hPa에서 시작)';
        break;
      case 'shake':
        var sec = num(a.seconds) ? a.seconds : SHAKE_DEFAULT;
        var cs = clampWithWarning('shake', sec);
        s.shakeRemaining = cs.value;
        s.shakeDuration = cs.value;
        s.lastCause = 'shake';
        r.message = '병 흔들기 ' + fmtShort(cs.value) + '초 (기포 방출 속도 ×' + SHAKE_FACTOR + ')';
        r.warning = cs.warning;
        break;
      case 'drink':
        var before = s.C;
        if (!s.capOpen) {
          s.capOpen = true;
          setNow(s, 'P_bottle', s.P_amb * OPEN_CO2_FRACTION);
        }
        var fromT = s.target.T;
        setTarget(s, 'T', DRINK_TEMP, DRINK_RAMP_SEC);
        var eq37 = solubilityAt(DRINK_TEMP, effectivePCO2(s));
        s.drink = { before: before, eq37: eq37, released: Math.max(0, before - eq37), time: s.time };
        s.lastCause = 'drink';
        r.message = '마시기: 뚜껑 열림, 온도 ' + fmtShort(fromT) + '℃ → 37℃(체온)';
        break;
      case 'setSpeed':
        var csp = clampWithWarning('speed', a.multiplier);
        var oldSp = s.speed;
        s.speed = csp.value;
        r.message = '속도 ×' + fmtShort(oldSp) + ' → ×' + fmtShort(csp.value);
        r.warning = csp.warning;
        break;
      case 'pause': s.paused = true; r.message = '일시정지'; break;
      case 'resume': s.paused = false; r.message = '다시 진행'; break;
      case 'reset':
        var keepRecords = s.records;
        var keepSpeed = s.speed;
        var fresh = createState();
        Object.keys(fresh).forEach(function (k) { s[k] = fresh[k]; });
        s.records = keepRecords;
        s.speed = keepSpeed;
        s.lastCause = 'reset';
        r.message = '초기화: 5℃, 3500 hPa, 뚜껑 닫힘(냉장고에서 꺼낸 탄산수)';
        break;
      case 'record':
        var rec = makeRecord(s);
        s.records.push(rec);
        r.message = '기록 #' + rec.no + ' 저장 (t = ' + fmt(rec.time) + ' s)';
        break;
      case 'explain':
        r.message = '질문: ' + (a.question ? String(a.question) : '(설명 요청)');
        break;
      case 'unknown':
        r.message = '명령을 이해하지 못했어요';
        break;
      default:
        r.message = '지원하지 않는 명령';
        r.warning = '알 수 없는 action 종류: ' + String(type);
    }
    s.version++;
    return { state: s, message: r.message, warning: r.warning || null };
  }

  // ───────────────────────── 검증 ─────────────────────────
  function validateCommand(obj) {
    var errors = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: ['최상위 값이 객체가 아니에요'], command: null };
    }
    if (!Array.isArray(obj.actions)) errors.push('actions 배열이 없어요');
    else if (obj.actions.length === 0) errors.push('actions가 비어 있어요');
    else if (obj.actions.length > 12) errors.push('actions가 너무 많아요(최대 12개)');
    if (typeof obj.reply !== 'string') errors.push('reply 문자열이 없어요');
    var clean = [];
    if (Array.isArray(obj.actions)) {
      obj.actions.forEach(function (a, i) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push('actions[' + i + ']가 객체가 아니에요'); return; }
        var spec = ACTION_SPECS[a.type];
        if (!spec) { errors.push('actions[' + i + '].type "' + a.type + '"는 지원하지 않아요'); return; }
        var out = { type: a.type };
        Object.keys(spec).forEach(function (field) {
          var kind = spec[field];
          var optional = kind.charAt(kind.length - 1) === '?';
          var base = optional ? kind.slice(0, -1) : kind;
          var v = a[field];
          if (v === undefined || v === null) {
            if (!optional) errors.push('actions[' + i + '].' + field + ' 값이 필요해요');
            return;
          }
          if (base === 'number' && !num(v)) { errors.push('actions[' + i + '].' + field + '는 유한한 숫자여야 해요'); return; }
          if (base === 'string' && typeof v !== 'string') { errors.push('actions[' + i + '].' + field + '는 문자열이어야 해요'); return; }
          out[field] = v;
        });
        clean.push(out);
      });
    }
    if (errors.length) return { ok: false, errors: errors, command: null };
    return { ok: true, errors: [], command: { actions: clean, reply: obj.reply } };
  }

  // ───────────────────────── 내장 자연어 해석기 ─────────────────────────
  var NATIVE_TENS = [['스물', 20], ['스무', 20], ['서른', 30], ['마흔', 40], ['쉰', 50], ['예순', 60], ['일흔', 70], ['여든', 80], ['아흔', 90], ['열', 10]];
  var NATIVE_UNITS = [['하나', 1], ['다섯', 5], ['여섯', 6], ['일곱', 7], ['여덟', 8], ['아홉', 9], ['한', 1], ['둘', 2], ['두', 2], ['셋', 3], ['세', 3], ['석', 3], ['넷', 4], ['네', 4]];
  var SINO_DIGIT = { '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '륙': 6, '칠': 7, '팔': 8, '구': 9 };
  var SINO_UNIT = { '십': 10, '백': 100, '천': 1000 };
  var UNIT_HEAD = /^(도|℃|℉|켈빈|화씨|섭씨|헥토파스칼|킬로파스칼|파스칼|hpa|kpa|pa|기압|atm|mmhg|bar|배|초|퍼센트|%)/;

  function startsWithAt(word, i, tok) { return word.substr(i, tok.length) === tok; }

  function parseNative(word) {
    var i = 0, value = 0, any = false;
    for (var a = 0; a < NATIVE_TENS.length; a++) {
      if (startsWithAt(word, 0, NATIVE_TENS[a][0])) { value += NATIVE_TENS[a][1]; i = NATIVE_TENS[a][0].length; any = true; break; }
    }
    for (var b = 0; b < NATIVE_UNITS.length; b++) {
      if (startsWithAt(word, i, NATIVE_UNITS[b][0])) { value += NATIVE_UNITS[b][1]; i += NATIVE_UNITS[b][0].length; any = true; break; }
    }
    return any ? { value: value, len: i } : null;
  }

  function parseSino(word) {
    var total = 0, cur = 0, i = 0, any = false;
    while (i < word.length) {
      var ch = word.charAt(i);
      if (Object.prototype.hasOwnProperty.call(SINO_DIGIT, ch)) {
        if (cur) break;
        cur = SINO_DIGIT[ch];
      } else if (Object.prototype.hasOwnProperty.call(SINO_UNIT, ch)) {
        total += (cur || 1) * SINO_UNIT[ch];
        cur = 0;
      } else break;
      i++; any = true;
    }
    return any ? { value: total + cur, len: i } : null;
  }

  /** 한글 수사 뒤에 단위가 올 때만 아라비아 숫자로 바꾼다("열 도" → "10 도", "열어"는 그대로). */
  function convertKoreanNumerals(text) {
    return text.replace(/[가-힣]+/g, function (word, offset, whole) {
      var n = parseNative(word), s = parseSino(word);
      var best = n;
      if (s && (!best || s.len > best.len)) best = s;
      if (!best) return word;
      var numText = word.slice(0, best.len);
      var rest = word.slice(best.len);
      var follow = rest || whole.slice(offset + word.length).replace(/^\s+/, '');
      var m = follow.match(UNIT_HEAD);
      if (!m) return word;
      if (numText === '이' && !rest && m[1] === '기압') return word; // "이 기압"(this pressure)
      // "구도", "사배"처럼 한 글자 한자어 수사가 붙은 일반 낱말은 그대로 둔다.
      if (rest && best.len === 1 && Object.prototype.hasOwnProperty.call(SINO_DIGIT, numText)) return word;
      return String(best.value) + (rest ? ' ' + rest : '');
    });
  }

  function normalizeText(text) {
    var t = String(text || '');
    if (t.normalize) t = t.normalize('NFKC');
    t = t.toLowerCase();
    t = t.replace(/°\s*c/g, '℃').replace(/°\s*f/g, '℉').replace(/°/g, '도');
    t = t.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
    t = t.replace(/[−–]/g, '-').replace(/영하\s*(\d)/g, function (_, d) { return '-' + d; });
    t = t.replace(/(\d)\s*천/g, function (_, d) { return d + '000'; })
      .replace(/(\d)\s*백(?!분)/g, function (_, d) { return d + '00'; });
    t = convertKoreanNumerals(t);
    return t.replace(/\s+/g, ' ').trim();
  }

  var SPLIT_MARK = '\u0001';
  function splitClauses(t) {
    var s = t
      .replace(/그리고|그런\s*다음에?|그\s*다음에?|그러고\s*나서|그\s*후에?|한\s*(?:뒤|후)에?/g, SPLIT_MARK)
      .replace(/[,;!]|\.(?!\d)/g, SPLIT_MARK)
      .replace(/([가-힣])(?:고|며|면서)(\s+|$)/g, '$1' + SPLIT_MARK);
    return s.split(SPLIT_MARK).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  var RE = {
    question: /[?？]|왜|어떻게\s*(?:돼|되|될|하면|해서)|뭐야|뭔가요|뭘까|무엇|이유|설명|원리|궁금|일까|을까|ㄹ까|나요|인가요|가요\??$|알려|면\s*어때/,
    reset: /초기화|처음\s*으로|처음\s*상태|리셋|reset|원래\s*대로|원상\s*복구/,
    record: /기록|저장|메모|측정해/,
    close: /닫|잠가|잠궈|잠그|밀봉|막아/,
    open: /^(?:뚜껑\s*(?:을|를)?\s*)?열$|열어|열고|열자|열기|열래|열면|연다|개봉|오픈|open|뚜껑[^0-9]*열|(?:뚜껑|병)\s*(?:을|를)?\s*따/,
    shake: /흔들|흔드|쉐이크|셰이크|shake/,
    drink: /마셔|마시|마심|먹어|먹자|들이켜|한\s*모금|drink/,
    pause: /멈춰|멈추|멈춤|정지|스톱|stop|pause|잠깐/,
    resume: /재개|다시\s*(?:시작|재생|움직|진행|돌려|켜)|계속|재생|resume|play|^다시$|^다시\s*해/,
    speedWord: /속도|배속|빠르게|빨리|느리게|천천히|시간\s*을?\s*(?:빨|느)/,
    tempWord: /온도|수온|℃|℉|데워|데우|데펴|식혀|식히|차갑|차게|따뜻|따듯|뜨겁|뜨거|시원|가열|냉각|켈빈|화씨|섭씨|냉장|체온|실온|상온|어는점|\d\s*(?:도|k(?![a-z])|켈빈)/,
    pressWord: /압력|기압|hpa|헥토|kpa|킬로파스칼|파스칼|atm|mmhg|bar|\d\s*pa(?![a-z])/,
    ambient: /주변|대기압|대기\s*압|대기|바깥|외부|밖의/,
    inc: /올려|올리|올라|높여|높이|증가|늘려|늘리|키워|더해|더\s|더$|데워|데우|데펴|가열|따뜻|따듯|뜨겁|뜨거|up/,
    dec: /내려|내리|낮춰|낮추|감소|줄여|줄이|빼|식혀|식히|냉각|차갑|차게|시원|down/,
    setWord: /맞춰|맞추|설정|세팅|변경|바꿔|바꾸|만들어|되게|되도록|로\s*해|으로\s*해|로\s*하|까지/,
    small: /조금|살짝|약간|좀|소폭/,
    large: /많이|크게|훨씬|확\s|팍|엄청|아주|대폭|왕창/
  };

  var QTY_RE = /(-?\d+(?:\.\d+)?)\s*(℃|도씨|도|켈빈|k(?![a-z])|℉|화씨|hpa|헥토파스칼|kpa|킬로파스칼|mmhg|atm|기압|pa(?![a-z])|파스칼|bar|배속|배|%|퍼센트|초)?/g;

  function unitKind(u) {
    if (!u) return 'none';
    if (/^(℃|도씨|도)$/.test(u)) return 'C';
    if (/^(켈빈|k)$/.test(u)) return 'K';
    if (/^(℉|화씨)$/.test(u)) return 'F';
    if (/^(hpa|헥토파스칼)$/.test(u)) return 'hPa';
    if (/^(kpa|킬로파스칼)$/.test(u)) return 'kPa';
    if (u === 'mmhg') return 'mmHg';
    if (/^(atm|기압)$/.test(u)) return 'atm';
    if (/^(pa|파스칼)$/.test(u)) return 'Pa';
    if (u === 'bar') return 'bar';
    if (u === '배') return 'times';
    if (u === '배속') return 'speed';
    if (/^(%|퍼센트)$/.test(u)) return 'percent';
    if (u === '초') return 'sec';
    return 'none';
  }
  var TEMP_KINDS = { C: 1, K: 1, F: 1 };
  var PRESS_KINDS = { hPa: 1, kPa: 1, mmHg: 1, atm: 1, Pa: 1, bar: 1 };

  function quantities(c) {
    var out = [], m;
    QTY_RE.lastIndex = 0;
    while ((m = QTY_RE.exec(c))) {
      var end = m.index + m[0].length;
      out.push({ value: parseFloat(m[1]), unit: m[2] || '', kind: unitKind(m[2]), index: m.index, end: end, after: c.slice(end) });
    }
    return out;
  }

  function toHPa(v, kind) {
    switch (kind) {
      case 'kPa': return v * 10;
      case 'mmHg': return v * 1.33322;
      case 'atm': return v * ATM_HPA;
      case 'Pa': return v / 100;
      case 'bar': return v * 1000;
      default: return v;
    }
  }
  function toCelsius(v, kind, isDelta) {
    if (kind === 'K') return isDelta ? v : v - 273.15;
    if (kind === 'F') return isDelta ? v * 5 / 9 : (v - 32) * 5 / 9;
    return v;
  }
  function round2(x) { return Math.round(x * 100) / 100; }

  function direction(c, qty, fallback) {
    if (qty && /^\s*(?:으로|로|에\s*맞|까지)/.test(qty.after)) return 'set';
    if (qty && RE.setWord.test(c)) return 'set';
    var dec = RE.dec.test(c), inc = RE.inc.test(c);
    if (dec) return 'dec';
    if (inc) return 'inc';
    if (fallback) return fallback;
    if (qty) return 'set';
    if (RE.setWord.test(c)) return 'set';
    return null;
  }

  function parseQuantity(c, target, ctx, dirFallback) {
    // target: 'temp' | 'press'
    var qs = quantities(c).filter(function (q) {
      if (q.kind === 'sec' || q.kind === 'speed') return false;
      if (target === 'temp') return !PRESS_KINDS[q.kind];
      return !TEMP_KINDS[q.kind];
    });
    var setQ = null;
    for (var i = 0; i < qs.length; i++) if (/^\s*(?:으로|로|에\s*맞|까지)/.test(qs[i].after)) { setQ = qs[i]; break; }
    var q = setQ || qs[0] || null;
    if (/절반|반\s*으로|반만/.test(c)) q = { value: 0.5, kind: 'times', after: '', half: true };
    var dir = direction(c, q, dirFallback);
    return { q: q, dir: dir };
  }

  function presetTemperature(c) {
    if (/냉장/.test(c)) return 5;
    if (/체온|입\s*안|입속|입\s*속/.test(c)) return 37;
    if (/실온|상온/.test(c)) return 25;
    if (/어는점|얼음물|얼기\s*직전/.test(c)) return 0;
    return null;
  }

  function parseTemp(c, ctx, dirFallback) {
    var pq = parseQuantity(c, 'temp', ctx, dirFallback);
    var q = pq.q, dir = pq.dir;
    if (!q) {
      var preset = presetTemperature(c);
      if (preset !== null && !RE.inc.test(c) && !RE.dec.test(c)) return { type: 'setTemperature', value: preset };
      if (dir !== 'inc' && dir !== 'dec') return null;
      var amt = RE.small.test(c) ? 5 : RE.large.test(c) ? 20 : 10;
      return { type: 'changeTemperature', delta: dir === 'inc' ? amt : -amt };
    }
    if (q.kind === 'times' || q.kind === 'percent') {
      var f = q.kind === 'times' ? q.value : 1 + (dir === 'dec' ? -q.value : q.value) / 100;
      if (q.kind === 'times' && !q.half && dir === 'dec' && f > 1) f = 1 / f;
      return { type: 'setTemperature', value: round2(ctx.target.T * f) };
    }
    if (dir === 'inc' || dir === 'dec') {
      var d = Math.abs(toCelsius(q.value, q.kind, true));
      return { type: 'changeTemperature', delta: round2(dir === 'inc' ? d : -d) };
    }
    return { type: 'setTemperature', value: round2(toCelsius(q.value, q.kind, false)) };
  }

  function parsePress(c, ctx, dirFallback) {
    var ambient = RE.ambient.test(c);
    var pq = parseQuantity(c, 'press', ctx, dirFallback);
    var q = pq.q, dir = pq.dir;
    var setType = ambient ? 'setAmbientPressure' : 'setPressure';
    var chType = ambient ? 'changeAmbientPressure' : 'changePressure';
    if (!q) {
      if (dir !== 'inc' && dir !== 'dec') return null;
      var amt = RE.small.test(c) ? 100 : RE.large.test(c) ? 500 : 200;
      var o = { type: chType }; o.delta = dir === 'inc' ? amt : -amt; return o;
    }
    if (q.kind === 'times' || q.kind === 'percent') {
      var base = ambient || ctx.capOpen ? ctx.target.P_amb : ctx.target.P_bottle;
      var f = q.kind === 'times' ? q.value : 1 + (dir === 'dec' ? -q.value : q.value) / 100;
      if (q.kind === 'times' && !q.half && dir === 'dec' && f > 1) f = 1 / f;
      return { type: setType, value: round2(base * f) };
    }
    var v = round2(toHPa(q.value, q.kind));
    if (dir === 'inc' || dir === 'dec') return { type: chType, delta: dir === 'inc' ? Math.abs(v) : -Math.abs(v) };
    return { type: setType, value: v };
  }

  function firstIndex(re, c) {
    var m = c.match(re);
    return m ? m.index : -1;
  }

  /** 한 절(clause)을 해석해 action 배열을 돌려준다. */
  function parseClause(c, ctx, memo) {
    if (RE.reset.test(c)) return [{ type: 'reset' }];
    if (RE.record.test(c)) return [{ type: 'record' }];
    if (RE.close.test(c)) return [{ type: 'closeCap' }];
    if (RE.open.test(c)) return [{ type: 'openCap' }];
    if (RE.shake.test(c)) {
      var sm = c.match(/(\d+(?:\.\d+)?)\s*초/);
      return [{ type: 'shake', seconds: sm ? parseFloat(sm[1]) : SHAKE_DEFAULT }];
    }
    if (RE.drink.test(c)) return [{ type: 'drink' }];

    var hasT = RE.tempWord.test(c), hasP = RE.pressWord.test(c);
    var qs = quantities(c);
    var hasNumber = qs.length > 0;
    if (!hasT && !hasP && !RE.speedWord.test(c) && (hasNumber || RE.inc.test(c) || RE.dec.test(c)) && memo.lastTarget) {
      hasT = memo.lastTarget === 'temp';
      hasP = memo.lastTarget === 'press';
    }
    if (hasT && hasP) {
      var iT = firstIndex(RE.tempWord, c), iP = firstIndex(RE.pressWord, c);
      var cut = Math.max(iT, iP);
      var first = c.slice(0, cut), second = c.slice(cut);
      var dirAll = direction(c, null);
      var out = [];
      var a1 = iT < iP ? parseTemp(first, ctx, dirAll) : parsePress(first, ctx, dirAll);
      var a2 = iT < iP ? parsePress(second, ctx, dirAll) : parseTemp(second, ctx, dirAll);
      if (a1) out.push(a1);
      if (a2) out.push(a2);
      memo.lastTarget = iT < iP ? 'press' : 'temp';
      return out;
    }
    if (hasT) { memo.lastTarget = 'temp'; var t = parseTemp(c, ctx); return t ? [t] : []; }
    if (hasP) { memo.lastTarget = 'press'; var p = parsePress(c, ctx); return p ? [p] : []; }

    if (RE.speedWord.test(c) || qs.some(function (q) { return q.kind === 'speed'; })) {
      var mm = c.match(/(\d+(?:\.\d+)?)\s*(?:배속|배)/) || c.match(/[x×]\s*(\d+(?:\.\d+)?)/) || c.match(/(\d+(?:\.\d+)?)/);
      if (mm) return [{ type: 'setSpeed', multiplier: parseFloat(mm[1]) }];
      var levels = [1, 5, 20];
      var cur = ctx.speed;
      if (/느리게|천천히|느리|늦/.test(c)) {
        var down = 1;
        for (var i = levels.length - 1; i >= 0; i--) if (levels[i] < cur) { down = levels[i]; break; }
        return [{ type: 'setSpeed', multiplier: down }];
      }
      if (/보통|원래|기본/.test(c)) return [{ type: 'setSpeed', multiplier: 1 }];
      var up = 20;
      for (var j = 0; j < levels.length; j++) if (levels[j] > cur) { up = levels[j]; break; }
      return [{ type: 'setSpeed', multiplier: up }];
    }
    if (RE.pause.test(c)) return [{ type: 'pause' }];
    if (RE.resume.test(c)) return [{ type: 'resume' }];
    // 대상어 없이 "데워줘", "차갑게 해줘"
    return [];
  }

  // ───────────────────────── 설명 문장(템플릿) ─────────────────────────
  function stateSummary(s) {
    var st = saturationStatus(s);
    return '지금은 ' + fmtShort(s.T) + '℃, 유효 CO₂ 압력 ' + fmtShort(effectivePCO2(s)) + ' hPa에서 평형 용해도가 ' +
      fmt(st.Ceq) + ' g/L이고, 녹아 있는 CO₂는 ' + fmt(s.C) + ' g/L로 ' + st.label + ' 상태예요.';
  }

  function explainText(question, s) {
    var q = String(question || '');
    if (/물고기|어류|산소|o2|o₂|수온/.test(q)) {
      var o10 = molarSolubility('O2', 10), o30 = molarSolubility('O2', 30);
      return '수온이 오르면 O₂ 같은 기체의 용해도가 줄어요. 1 atm 순수 O₂ 기준으로 10℃에서 ' + fmt(o10) + ' mmol/L, 30℃에서 ' + fmt(o30) +
        ' mmol/L이라 따뜻한 물에는 산소가 적게 녹아 물고기가 숨쉬기 힘들어져요.';
    }
    if (/잠수|다이버|감압|혈액|질소|n2|n₂|잠함/.test(q)) {
      return '깊은 물속에서는 압력이 커서 헨리 법칙에 따라 혈액에 N₂가 많이 녹아요. 빨리 올라오면 압력이 갑자기 줄어 혈액이 과포화되고, 탄산수 뚜껑을 딴 것처럼 N₂ 기포가 생겨 감압병이 생길 수 있어요.';
    }
    if (/흔들/.test(q)) {
      return '흔들면 액체 속에 작은 기포(핵)가 많이 생겨, 과포화된 CO₂가 그 기포로 한꺼번에 빠져나가요. 그래서 흔든 탄산수를 열면 거품이 넘쳐요.';
    }
    if (/마시|입|트림|탄산감|톡/.test(q)) {
      var eq = solubilityAt(DRINK_TEMP, s.P_amb * OPEN_CO2_FRACTION);
      return '입 안은 37℃이고 뚜껑도 열린 상태라 CO₂ 평형 용해도가 ' + fmt(eq) + ' g/L로 아주 작아요. 녹아 있던 CO₂가 과포화되어 기포로 빠져나오며 혀를 톡 쏘는 탄산감을 만들어요.';
    }
    if (/뚜껑|김\s*빠|김빠|열면/.test(q)) {
      return '뚜껑을 열면 CO₂ 부분압력이 병 속 압력(수천 hPa)에서 대기 중 CO₂ 압력(약 0.4 hPa)으로 떨어져요. 헨리 법칙에 따라 용해도도 거의 0이 되므로 과포화된 CO₂가 기포로 빠져나가 김이 빠져요.';
    }
    if (/기포|거품|과포화|방울/.test(q)) {
      return '녹아 있는 CO₂가 평형 용해도보다 많으면 과포화 상태예요. 남는 CO₂가 병 바닥과 벽의 작은 흠에서 기포로 모여 떠오르고, 평형 용해도에 가까워질수록 기포가 줄어들어요.';
    }
    if (/압력|기압|헨리/.test(q)) {
      return '헨리 법칙: 기체의 용해도는 그 기체의 부분압력에 비례해요. 병 속 CO₂ 압력을 2배로 하면 녹을 수 있는 CO₂ 양도 2배가 돼요. ' + stateSummary(s);
    }
    if (/온도|따뜻|차가|미지근|데우|식히/.test(q)) {
      var c5 = solubilityAt(5, ATM_HPA), c25 = solubilityAt(25, ATM_HPA);
      return '온도가 높을수록 기체 분자의 운동이 활발해져 물에서 빠져나가기 쉬워지므로 기체의 용해도는 감소해요. 1 atm CO₂ 기준으로 5℃에서 ' + fmt(c5) + ' g/L, 25℃에서 ' + fmt(c25) + ' g/L예요.';
    }
    return stateSummary(s) + ' 온도를 올리거나 뚜껑을 열면 용해도가 줄어 과포화가 되고, 압력을 높이거나 온도를 낮추면 불포화가 되어 CO₂가 다시 녹아 들어가요.';
  }

  function actionSentence(a, before, after) {
    switch (a.type) {
      case 'setTemperature':
      case 'changeTemperature':
        if (after.target.T > before.target.T) return '온도가 올라가면 CO₂ 분자의 운동이 활발해져 물에서 빠져나가기 쉬워지므로 용해도가 줄어요.';
        if (after.target.T < before.target.T) return '온도가 내려가면 기체의 용해도가 커져서 CO₂가 더 많이 녹을 수 있어요.';
        return '온도는 그대로예요.';
      case 'setPressure':
      case 'changePressure':
        if (before.capOpen) return '뚜껑이 열려 있어 주변 기압이 바뀌는데, CO₂ 부분압력은 그 0.04 %뿐이라 용해도 변화는 아주 작아요.';
        if (after.target.P_bottle > before.target.P_bottle) return '헨리 법칙에 따라 병 속 CO₂ 압력이 커지면 용해도도 압력에 비례해 커져요.';
        if (after.target.P_bottle < before.target.P_bottle) return '헨리 법칙에 따라 병 속 CO₂ 압력이 작아지면 용해도도 비례해 줄어요.';
        return '압력은 그대로예요.';
      case 'setAmbientPressure':
      case 'changeAmbientPressure':
        if (before.capOpen) return '뚜껑이 열려 있을 때 CO₂ 부분압력은 주변 기압의 0.04 %뿐이라, 주변 기압을 바꿔도 용해도는 거의 변하지 않아요.';
        return '뚜껑이 닫혀 있으면 병 속 CO₂ 압력이 용해도를 결정하므로 주변 기압은 지금 용해도에 영향을 주지 않아요.';
      case 'openCap':
        if (before.capOpen) return '뚜껑은 이미 열려 있어요.';
        return '뚜껑을 열면 CO₂ 부분압력이 ' + fmtShort(effectivePCO2(before)) + ' hPa에서 ' + fmtShort(effectivePCO2(after)) + ' hPa로 급감해 용해도가 거의 0이 되고, 과포화된 CO₂가 기포로 빠져나가요.';
      case 'closeCap':
        if (!before.capOpen) return '뚜껑은 이미 닫혀 있어요.';
        return '뚜껑을 닫아 CO₂가 병 밖으로 날아가지 않아요. 병 속 CO₂ 압력을 높이면 다시 탄산을 녹일 수 있어요.';
      case 'shake':
        return '흔들면 기포가 생길 자리(핵)가 많아져 과포화된 CO₂가 한꺼번에 기포로 빠져나가요.' +
          (saturationStatus(before).key === 'supersaturated' ? '' : ' 다만 지금은 과포화가 아니라 기포가 많이 생기지 않아요.');
      case 'drink':
        var d = after.drink;
        return '입 안(37℃)은 훨씬 따뜻하고 뚜껑도 열려 있어 용해도가 ' + fmt(d.eq37) + ' g/L로 줄어요. 약 ' + fmt(d.released) + ' g/L의 CO₂가 입 안에서 기포로 빠져나가며 톡 쏘는 탄산감을 줘요.';
      case 'setSpeed': return '시간 흐름을 ×' + fmtShort(after.speed) + '로 바꿨어요.';
      case 'pause': return '시간을 멈췄어요. "다시 시작"이라고 하면 이어서 진행해요.';
      case 'resume': return '시간이 다시 흘러요.';
      case 'reset': return '냉장고에서 막 꺼낸 밀봉 탄산수(5℃, 3500 hPa)로 돌아갔어요. 지금은 포화 평형 상태예요.';
      case 'record': return '현재 상태를 실험 기록 표에 저장했어요.';
      case 'explain': return explainText(a.question, before);
      default: return '';
    }
  }

  var STATE_CHANGING = { setTemperature: 1, changeTemperature: 1, setPressure: 1, changePressure: 1, setAmbientPressure: 1, changeAmbientPressure: 1, openCap: 1, closeCap: 1 };

  function predictionSentence(start, end) {
    var eq0 = targetEquilibrium(start), eq1 = targetEquilibrium(end);
    var C = start.C;
    var rel = eq1 > 1e-12 ? (C - eq1) / eq1 : (C > 1e-6 ? Infinity : 0);
    var head = '예상: 평형 용해도 ' + fmt(eq0) + ' → ' + fmt(eq1) + ' g/L';
    if (Math.abs(rel) < SAT_TOL) return head + ', 녹아 있는 ' + fmt(C) + ' g/L와 거의 같아 포화 평형에 가까워요.';
    if (rel > 0) return head + '. 녹아 있는 ' + fmt(C) + ' g/L보다 작아져 과포화 → 기포가 생기며 CO₂가 빠져나가요.';
    return head + '. 녹아 있는 ' + fmt(C) + ' g/L보다 커져 불포화 → CO₂가 물에 녹아 들어가요.';
  }

  function buildReply(state, actions) {
    var sim = cloneLite(state);
    var start = cloneLite(state);
    var sentences = [];
    var changed = false;
    actions.forEach(function (a) {
      var before = cloneLite(sim);
      applyAction(sim, a);
      var sentence = actionSentence(a, before, sim);
      if (sentence && sentences.indexOf(sentence) < 0) sentences.push(sentence);
      if (STATE_CHANGING[a.type]) changed = true;
    });
    if (changed && !actions.some(function (a) { return a.type === 'drink' || a.type === 'reset'; })) {
      sentences.push(predictionSentence(start, sim));
    }
    return sentences.join(' ');
  }

  function unknownReply() {
    return '명령을 이해하지 못했어요. 이렇게 말해 보세요: "' + EXAMPLES.join('", "') + '"';
  }

  /**
   * 내장 규칙 기반 해석기. 반환: {actions, reply}
   */
  function parseCommand(text, state) {
    var s = state || createState();
    var norm = normalizeText(text);
    var clauses = splitClauses(norm);
    var ctx = cloneLite(s);
    var memo = { lastTarget: null };
    var actions = [];
    clauses.forEach(function (c) {
      var acts;
      if (RE.question.test(c)) acts = [{ type: 'explain', question: c }];
      else acts = parseClause(c, ctx, memo);
      acts.forEach(function (a) {
        actions.push(a);
        applyAction(ctx, a); // 이어지는 절이 바뀐 상태(뚜껑 등)를 기준으로 해석되도록
      });
    });
    if (!actions.length) return { actions: [{ type: 'unknown' }], reply: unknownReply() };
    return { actions: actions, reply: buildReply(s, actions) };
  }

  // ───────────────────────── 화면용 보조 함수 ─────────────────────────
  var CAUSE_TEXT = {
    initial: '냉장고에서 꺼낸 밀봉 탄산수',
    reset: '처음 상태(5℃, 3500 hPa, 밀봉)',
    tempUp: '온도 상승 → 용해도 감소',
    tempDown: '온도 하강 → 용해도 증가',
    pressUp: 'CO₂ 압력 증가 → 용해도 증가',
    pressDown: 'CO₂ 압력 감소 → 용해도 감소',
    ambient: '주변 기압 변화',
    open: '뚜껑 열림 → CO₂ 압력 급감 → 용해도 급감',
    close: '뚜껑 닫힘',
    shake: '흔들기 → 기포 핵 증가',
    drink: '마시기 → 37℃ + 뚜껑 열림 → 용해도 급감'
  };
  var STATUS_TEXT = {
    supersaturated: '과포화 → 기포 발생!',
    saturated: '포화 평형 (녹는 속도 = 빠져나가는 속도)',
    unsaturated: '불포화 → CO₂가 물에 녹아 들어감'
  };
  function caption(state) {
    var st = saturationStatus(state);
    var cause = CAUSE_TEXT[state.lastCause] || '';
    if (state.lastCause === 'ambient') cause += state.capOpen ? ' → CO₂ 부분압력 변화는 아주 작음' : ' → 뚜껑이 닫혀 있어 영향 없음';
    return (cause ? cause + ' → ' : '') + STATUS_TEXT[st.key];
  }

  function formulas(state) {
    var T = state.T, P = effectivePCO2(state), k = henryK('CO2', T);
    var Patm = P / ATM_HPA;
    var Ceq = k * Patm * M_CO2;
    var kTxt = k.toFixed(4);
    var pTxt = Patm >= 0.01 ? Patm.toFixed(2) : String(Number(Patm.toPrecision(2)));
    return {
      k: 'k_H = 0.034 × exp(2400 × (1/' + (T + 273.15).toFixed(2) + ' − 1/298.15)) = ' + kTxt + ' mol/(L·atm)',
      p: 'P_CO₂ = ' + (state.capOpen ? fmt(state.P_amb) + ' hPa × 0.0004 = ' : '') + fmt(P) + ' hPa ÷ 1013.25 = ' + pTxt + ' atm',
      ceq: 'C_eq = ' + kTxt + ' × ' + pTxt + ' atm × 44.01 = ' + fmt(Ceq) + ' g/L',
      rate: (function () {
        if (state.C > Ceq) return 'dC/dt = −k_out(C − C_eq) = −' + kOut(state).toFixed(3) + ' × (' + fmt(state.C) + ' − ' + fmt(Ceq) + ') = −' + fmt(kOut(state) * (state.C - Ceq)) + ' g/(L·s)';
        if (state.C < Ceq) return 'dC/dt = +k_in(C_eq − C) = 0.008 × (' + fmt(Ceq) + ' − ' + fmt(state.C) + ') = +' + fmt(K_IN * (Ceq - state.C)) + ' g/(L·s)';
        return 'dC/dt = 0';
      })()
    };
  }

  /** 3D 장면에 그릴 분자 수 */
  function displayCounts(state) {
    return {
      dissolved: Math.min(150, Math.max(0, Math.round(state.C / 12 * 150))),
      headspace: Math.min(60, Math.max(0, Math.round(60 * effectivePCO2(state) / LIMITS.P_bottle.max)))
    };
  }

  var RECORD_HEADERS = ['번호', '시간(s)', '온도(℃)', '유효 CO₂ 압력(hPa)', '주변 기압(hPa)', '뚜껑', '용존 CO₂(g/L)', '평형 용해도(g/L)', '상태'];
  function recordRow(r) {
    return [String(r.no), fmt(r.time), fmt(r.T), fmt(r.P_eff), fmt(r.P_amb), r.capOpen ? '열림' : '닫힘', fmt(r.C), fmt(r.Ceq), r.status];
  }
  function recordsToCSV(records) {
    var esc = function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [RECORD_HEADERS.map(esc).join(',')];
    records.forEach(function (r) { lines.push(recordRow(r).map(esc).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }
  function recordsToTSV(records) {
    var lines = [RECORD_HEADERS.join('\t')];
    records.forEach(function (r) { lines.push(recordRow(r).join('\t')); });
    return lines.join('\n');
  }

  /** LLM에게 보낼 시스템 프롬프트 */
  function buildLLMPrompt(state) {
    var st = saturationStatus(state);
    var snapshot = {
      simTime_s: round2(state.time),
      temperature_C: round2(state.T),
      targetTemperature_C: round2(state.target.T),
      bottleCO2Pressure_hPa: round2(state.target.P_bottle),
      ambientPressure_hPa: round2(state.target.P_amb),
      capOpen: state.capOpen,
      effectiveCO2Pressure_hPa: round2(effectivePCO2(state)),
      dissolvedCO2_gL: round2(state.C),
      equilibriumSolubility_gL: Number(st.Ceq.toPrecision(4)),
      status: st.label,
      speed: state.speed,
      paused: state.paused
    };
    return [
      '너는 고등학교 화학 수업용 "탄산수 속 CO₂ 용해도 시뮬레이터"의 명령 해석기다.',
      '학생의 한국어 명령을 아래 JSON 스키마의 명령 하나로 바꿔라.',
      '',
      '## 현재 상태(JSON)',
      JSON.stringify(snapshot),
      '',
      '## 출력 스키마',
      '{ "actions": [ {...}, ... ], "reply": "학생에게 보여줄 한두 문장의 한국어 설명" }',
      'action 종류:',
      '- {"type":"setTemperature","value":℃} / {"type":"changeTemperature","delta":℃}',
      '- {"type":"setPressure","value":hPa} / {"type":"changePressure","delta":hPa} : 뚜껑이 닫혀 있으면 병 속 CO₂ 압력, 열려 있으면 주변 기압을 바꾼다.',
      '- {"type":"setAmbientPressure","value":hPa} / {"type":"changeAmbientPressure","delta":hPa} : 학생이 "주변 기압", "대기압"이라고 명시하면 항상 이것을 쓴다.',
      '- {"type":"openCap"} / {"type":"closeCap"}',
      '- {"type":"shake","seconds":초} (기본 3)',
      '- {"type":"drink"} : 뚜껑을 열고 온도를 37℃로 올린다.',
      '- {"type":"setSpeed","multiplier":1|5|20}',
      '- {"type":"pause"} / {"type":"resume"} / {"type":"reset"} / {"type":"record"}',
      '- {"type":"explain","question":"질문"} : 질문에 답만 할 때',
      '- {"type":"unknown"} : 해석할 수 없을 때',
      '',
      '## 값 범위(넘으면 그대로 보내도 시뮬레이터가 잘라 낸다)',
      '온도 0~80℃, 병 속 CO₂ 압력 0~6000 hPa, 주변 기압 300~2000 hPa, 속도 0.25~20배, 흔들기 0.5~10초',
      '',
      '## 단위 변환 규칙(항상 ℃와 hPa로 바꿔서 출력)',
      '- K → ℃: −273.15 (온도 차이는 그대로) / ℉ → ℃: (℉−32)×5/9 (온도 차이는 ×5/9)',
      '- kPa ×10, atm ×1013.25, "기압"(예: 2기압) ×1013.25, mmHg ×1.33322, Pa ÷100, bar ×1000',
      '',
      '## 정도 표현 규칙',
      '- "조금/살짝/약간"은 5℃ 또는 100 hPa, "많이/크게"는 20℃ 또는 500 hPa, 정도 표현이 없으면 10℃ 또는 200 hPa',
      '- "2배", "절반" 같은 배수는 현재 목표값에 곱해서 set 명령으로 보낸다.',
      '- "~로", "~으로", "맞춰", "설정"은 set, "올려/높여/더/데워"는 증가, "내려/낮춰/줄여/식혀"는 감소',
      '',
      '## 복합 명령',
      '여러 동작이 이어지면(쉼표, 그리고, ~고) 말한 순서대로 actions 배열에 담는다.',
      '',
      '## reply 작성',
      '고등학생에게 예상되는 현상을 기체 용해도 개념(온도↑→용해도↓, 헨리 법칙: 용해도∝부분압력, 과포화→기포, 불포화→기체가 녹아 들어감)으로 한두 문장에 설명한다.',
      '',
      '## 출력 형식',
      '오직 JSON 객체 하나만 출력한다. 코드 펜스(```)나 다른 글을 붙이지 않는다.'
    ].join('\n');
  }

  root.SodaCore = {
    // 상수
    ATM_HPA: ATM_HPA, M_CO2: M_CO2, OPEN_CO2_FRACTION: OPEN_CO2_FRACTION, GASES: GASES, LIMITS: LIMITS,
    INITIAL: INITIAL, EXAMPLES: EXAMPLES, ACTION_TYPES: Object.keys(ACTION_SPECS),
    DRINK_TEMP: DRINK_TEMP, HISTORY_WINDOW: HISTORY_WINDOW, SAT_TOL: SAT_TOL,
    // 모델
    createState: createState,
    henryK: henryK,
    solubilityAt: solubilityAt,
    molarSolubility: molarSolubility,
    equilibriumSolubility: equilibriumSolubility,
    effectivePCO2: effectivePCO2,
    kOut: kOut,
    isShaking: isShaking,
    step: step,
    applyAction: applyAction,
    saturationStatus: saturationStatus,
    // 해석기
    parseCommand: parseCommand,
    validateCommand: validateCommand,
    normalizeText: normalizeText,
    splitClauses: splitClauses,
    buildReply: buildReply,
    explainText: explainText,
    buildLLMPrompt: buildLLMPrompt,
    // 화면 보조
    caption: caption,
    formulas: formulas,
    displayCounts: displayCounts,
    recordsToCSV: recordsToCSV,
    recordsToTSV: recordsToTSV,
    RECORD_HEADERS: RECORD_HEADERS,
    recordRow: recordRow,
    fmt: fmt,
    fmtShort: fmtShort
  };
})(globalThis);
