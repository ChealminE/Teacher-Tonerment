/*
 * FishCore — 「수온과 용존산소: 물고기 생존 AI 시뮬레이터」의 과학 모델과 내장 자연어 해석기
 * DOM·THREE·fetch를 쓰지 않는 순수 로직이다. (classic script)
 * 시간 단위는 '시뮬레이션 분'이다. 속도 ×1은 실제 1초당 1분이다.
 */
(function (root) {
  'use strict';

  // ───────────────────────── 상수 ─────────────────────────
  var ATM_HPA = 1013.25;            // 1 atm = 1013.25 hPa
  var O2_FRACTION = 0.2095;         // 건조 공기 중 O₂ 몰분율
  var N2_FRACTION = 0.7808;         // 건조 공기 중 N₂ 몰분율
  var RAMP_SEC = 1.5;               // 수온·기압 변화 시간(실제 초)
  var KA_OFF = 0.05;                // 재폭기 계수(/분) — 에어펌프 끔
  var KA_ON = 0.30;                 // 재폭기 계수(/분) — 에어펌프 켬
  var R20 = 0.004;                  // 20℃에서 물고기 1마리의 산소 소비(mg/L/분)
  var Q10 = 2;                      // 10℃ 오를 때 호흡량 배율
  var TANK_L = 100;                 // 수조 부피(L)
  var MAX_SUBSTEP = 0.1;            // 적분 부분 단계(시뮬레이션 분)
  var HISTORY_WINDOW = 120;         // 시간 그래프 창(시뮬레이션 분)
  var HISTORY_DT = 0.5;             // 기록 간격(시뮬레이션 분)
  var HEATWAVE = { rate: 1, to: 32 };   // 폭염: 1℃/분씩 32℃까지
  var HIGHLAND_ALT = 2000;          // 고산 호수(m)
  var OVERCROWDED = 50;             // 과밀 양식(마리)

  var GASES = {
    CO2: { k298: 0.034, C: 2400, M: 44.01, name: 'CO₂' },
    O2: { k298: 0.0013, C: 1500, M: 32.00, name: 'O₂' },
    N2: { k298: 0.00061, C: 1300, M: 28.01, name: 'N₂' }
  };

  /*
   * 어종 기준(교육용 근사값). 무지개송어의 쾌적 수온 상한은 명세의 17℃에서 20℃로 넓혔다.
   * 초기 상태(20℃)가 '쾌적'으로 판정되어야 하기 때문이다(README 참고).
   */
  var SPECIES = {
    trout: {
      key: 'trout', name: '무지개송어', short: '송어', kind: '냉수성',
      comfortT: [10, 20], lethalT: 25,
      DO: { comfort: 7, caution: 5, danger: 3 }
    },
    carp: {
      key: 'carp', name: '잉어', short: '잉어', kind: '온수성',
      comfortT: [20, 28], lethalT: 35,
      DO: { comfort: 5, caution: 3, danger: 2 }
    }
  };

  var GRADES = {
    comfort: { key: 'comfort', label: '쾌적', color: 'green', rank: 0 },
    caution: { key: 'caution', label: '주의', color: 'yellow', rank: 1 },
    danger: { key: 'danger', label: '위험', color: 'orange', rank: 2 },
    lethal: { key: 'lethal', label: '치사', color: 'red', rank: 3 }
  };
  var GRADE_ORDER = ['comfort', 'caution', 'danger', 'lethal'];
  var H_DO = { comfort: 0, caution: 0.0002, danger: 0.002, lethal: 0.02 };   // /분
  var H_T_NEAR = 0.001;   // (치사 수온 − 3) 이상 ~ 치사 수온 미만
  var H_T_LETHAL = 0.02;  // 치사 수온 이상

  var BEHAVIOR = {
    normal: '정상',
    gasping: '호흡 가쁨',
    surface: '수면 호흡',
    dead: '폐사'
  };

  var LIMITS = {
    T: { min: 0, max: 40, unit: '℃', name: '수온' },
    P: { min: 500, max: 1100, unit: 'hPa', name: '기압' },
    alt: { min: 0, max: 5000, unit: 'm', name: '해발고도' },
    fish: { min: 0, max: 60, unit: '마리', name: '물고기 수' },
    speed: { min: 0.5, max: 60, unit: '배', name: '속도' }
  };

  var INITIAL = { T: 20, P: ATM_HPA, pump: false, species: 'trout', fish: 20 };

  var EXAMPLES = ['수온 5도 올려줘', '에어펌프 켜줘', '물고기 30마리 더 넣어줘', '해발 2000m 호수로 옮겨줘'];

  var SCENARIOS = {
    heatwave: '폭염',
    highland: '고산 호수',
    overcrowded: '과밀 양식',
    emergencyPump: '에어펌프 비상 가동'
  };

  var ACTION_SPECS = {
    setTemperature: { value: 'number' },
    changeTemperature: { delta: 'number' },
    setPressure: { value: 'number' },
    changePressure: { delta: 'number' },
    setAltitude: { value: 'number' },
    pumpOn: {},
    pumpOff: {},
    setFishCount: { value: 'number' },
    changeFishCount: { delta: 'number' },
    setSpecies: { species: 'enum:trout|carp' },
    scenario: { name: 'enum:heatwave|highland|overcrowded|emergencyPump' },
    setSpeed: { multiplier: 'number' },
    pause: {},
    resume: {},
    reset: {},
    record: {},
    explain: { question: 'string?' },
    unknown: {}
  };

  // ───────────────────────── 숫자 표시 ─────────────────────────
  function fmt(x, digits) {
    if (digits === undefined) digits = 2;
    if (typeof x !== 'number' || !isFinite(x)) return '–';
    if (x !== 0 && Math.abs(x) < 0.01 && digits >= 2) return String(Number(x.toPrecision(2)));
    return x.toFixed(digits);
  }
  function fmtShort(x) {
    if (typeof x !== 'number' || !isFinite(x)) return '–';
    if (x !== 0 && Math.abs(x) < 0.01) return String(Number(x.toPrecision(2)));
    return String(Number(x.toFixed(2)));
  }
  function signed(x) { return (x >= 0 ? '+' : '−') + fmtShort(Math.abs(x)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round2(x) { return Math.round(x * 100) / 100; }
  function num(v) { return typeof v === 'number' && isFinite(v); }

  // ───────────────────────── 과학 모델 ─────────────────────────
  /** 포화 수증기압 [hPa] (Magnus 식) */
  function vaporPressure(T_C) {
    return 6.112 * Math.exp(17.62 * T_C / (243.12 + T_C));
  }
  /** 1 atm(습윤 공기)에서 담수의 용존산소 포화량 [mg/L] (Benson–Krause) */
  function doSaturation1atm(T_C) {
    var T = T_C + 273.15;
    var ln = -139.34411 + 1.575701e5 / T - 6.642308e7 / (T * T) + 1.243800e10 / (T * T * T) - 8.621949e11 / (T * T * T * T);
    return Math.exp(ln);
  }
  /** 수온 T(℃), 기압 P(hPa)에서 용존산소 포화량 [mg/L] */
  function doSaturation(T_C, P_hPa) {
    if (P_hPa === undefined) P_hPa = ATM_HPA;
    var P = P_hPa / ATM_HPA;
    var Pwv = vaporPressure(T_C) / ATM_HPA;
    var c = doSaturation1atm(T_C) * (P - Pwv) / (1 - Pwv);
    return Math.max(0, c);
  }
  /** 공기 중 O₂ 부분압력 [atm] = 0.2095 × (P − P_wv) */
  function o2PartialPressure(T_C, P_hPa) {
    return O2_FRACTION * Math.max(0, P_hPa - vaporPressure(T_C)) / ATM_HPA;
  }
  /** 해발고도 h(m) → 기압(hPa) */
  function altitudeToPressure(h) {
    return ATM_HPA * Math.pow(1 - 2.25577e-5 * h, 5.25588);
  }
  /** 기압(hPa) → 해발고도(m) (위 식의 역산) */
  function pressureToAltitude(P) {
    return (1 - Math.pow(P / ATM_HPA, 1 / 5.25588)) / 2.25577e-5;
  }
  /** 물고기 1마리의 산소 소비 속도 r(T) [mg/L/분] (Q₁₀ = 2) */
  function respirationRate(T_C) {
    return R20 * Math.pow(Q10, (T_C - 20) / 10);
  }
  function aerationK(pumpOn) { return pumpOn ? KA_ON : KA_OFF; }
  /** 정상상태 DO = C_sat − n·r/k_a (0 아래로는 내려가지 않음) */
  function steadyStateDO(T_C, P_hPa, n, pumpOn) {
    return Math.max(0, doSaturation(T_C, P_hPa) - n * respirationRate(T_C) / aerationK(pumpOn));
  }

  /** 헨리 상수 k_H(T) [mol/(L·atm)] — 기체 비교 그래프용 */
  function henryK(gas, T_C) {
    var g = GASES[normalizeGas(gas)];
    var T = T_C + 273.15;
    return g.k298 * Math.exp(g.C * (1 / T - 1 / 298.15));
  }
  function normalizeGas(gas) {
    var k = String(gas || 'O2').toUpperCase().replace(/[₂]/g, '2').replace(/[^A-Z0-9]/g, '');
    if (!GASES[k]) throw new Error('알 수 없는 기체: ' + gas);
    return k;
  }
  /** 1 atm 순수 기체 기준 몰 용해도 [mmol/L] */
  function molarSolubility(gas, T_C, P_atm) {
    if (P_atm === undefined) P_atm = 1;
    return henryK(gas, T_C) * P_atm * 1000;
  }

  // ───────────────────────── 어종 판정 ─────────────────────────
  function speciesOf(s) { return SPECIES[s.species] || SPECIES.trout; }
  function doGrade(sp, DO) {
    if (DO >= sp.DO.comfort) return 'comfort';
    if (DO >= sp.DO.caution) return 'caution';
    if (DO >= sp.DO.danger) return 'danger';
    return 'lethal';
  }
  function tempGrade(sp, T) {
    if (T >= sp.lethalT) return 'lethal';
    if (T >= sp.lethalT - 3) return 'danger';
    if (T > sp.comfortT[1] || T < sp.comfortT[0]) return 'caution';
    return 'comfort';
  }
  function hazardT(sp, T) {
    if (T >= sp.lethalT) return H_T_LETHAL;
    if (T >= sp.lethalT - 3) return H_T_NEAR;
    return 0;
  }
  function worse(a, b) { return GRADES[a].rank >= GRADES[b].rank ? a : b; }

  function aliveExact(s) { return s.S * s.fishBase; }
  function aliveCount(s) { return Math.round(s.S * s.fishBase); }

  /** 어종 기준 상태: 용존산소 등급과 수온 등급 중 나쁜 쪽 */
  function speciesStatus(state) {
    var sp = speciesOf(state);
    var dg = doGrade(sp, state.DO);
    var tg = tempGrade(sp, state.T);
    var key = worse(dg, tg);
    var hDO = H_DO[dg], hT = hazardT(sp, state.T);
    // 물고기 행동: 차가운 물(쾌적 범위 아래)은 숨이 가빠지지 않으므로 수온의 '높은 쪽'만 반영
    var hot = state.T > sp.comfortT[1] ? tg : 'comfort';
    var bKey = worse(dg, hot);
    var behavior = bKey === 'comfort' ? 'normal' : bKey === 'caution' ? 'gasping' : 'surface';
    var reasons = [];
    if (dg !== 'comfort') reasons.push('용존산소 ' + fmt(state.DO) + ' mg/L(' + GRADES[dg].label + ')');
    if (tg !== 'comfort') {
      if (state.T < sp.comfortT[0]) reasons.push('수온이 쾌적 범위보다 낮음');
      else reasons.push('수온 ' + fmt(state.T, 1) + '℃(' + GRADES[tg].label + ')');
    }
    return {
      key: key, label: GRADES[key].label, color: GRADES[key].color,
      doGrade: dg, tempGrade: tg, hDO: hDO, hT: hT, hazard: hDO + hT,
      behavior: behavior, behaviorLabel: BEHAVIOR[behavior],
      species: sp.key, speciesName: sp.name,
      reasons: reasons
    };
  }

  // ───────────────────────── 상태 ─────────────────────────
  function createState() {
    var s = {
      time: 0,
      T: INITIAL.T,
      P: INITIAL.P,
      target: { T: INITIAL.T, P: INITIAL.P },
      ramps: { T: null, P: null },
      heatwave: null,
      pump: INITIAL.pump,
      species: INITIAL.species,
      fishBase: INITIAL.fish,
      S: 1,
      DO: 0,
      speed: 1,
      paused: false,
      rates: { exchange: 0, consume: 0 },
      history: [],
      historyTimer: 0,
      records: [],
      lastCause: 'initial',
      version: 0
    };
    s.DO = steadyStateDO(s.T, s.P, s.fishBase, s.pump);
    s.rates = currentRates(s);
    pushHistory(s);
    return s;
  }

  /** 기록·이력을 뺀 가벼운 복사본(예측용) */
  function cloneLite(s) {
    return {
      time: s.time, T: s.T, P: s.P,
      target: { T: s.target.T, P: s.target.P },
      ramps: { T: null, P: null },
      heatwave: s.heatwave ? { rate: s.heatwave.rate, to: s.heatwave.to } : null,
      pump: s.pump, species: s.species, fishBase: s.fishBase, S: s.S, DO: s.DO,
      speed: s.speed, paused: s.paused,
      rates: { exchange: 0, consume: 0 },
      history: [], historyTimer: 0, records: [],
      lastCause: s.lastCause, version: s.version
    };
  }

  function setTarget(s, key, value) {
    s.target[key] = value;
    s.ramps[key] = { from: s[key], to: value, elapsed: 0, dur: RAMP_SEC };
  }

  function advanceRamps(s, realDt) {
    ['T', 'P'].forEach(function (key) {
      var r = s.ramps[key];
      if (!r) return;
      r.elapsed += realDt;
      var u = Math.min(1, r.elapsed / r.dur);
      var e = u * u * (3 - 2 * u);
      s[key] = r.from + (r.to - r.from) * e;
      if (u >= 1) { s[key] = r.to; s.ramps[key] = null; }
    });
  }

  function pushHistory(s) {
    s.history.push({ t: s.time, DO: s.DO, Csat: doSaturation(s.T, s.P), surv: s.S * 100, T: s.T });
    var cutoff = s.time - HISTORY_WINDOW - 2;
    while (s.history.length > 2 && s.history[0].t < cutoff) s.history.shift();
  }

  function currentRates(s) {
    var Csat = doSaturation(s.T, s.P);
    return {
      exchange: aerationK(s.pump) * (Csat - s.DO),            // + 녹아 들어옴, − 빠져나감
      consume: s.DO > 1e-9 ? aliveExact(s) * respirationRate(s.T) : 0
    };
  }

  /** 한 부분 단계(h분) 동안 DO와 생존 비율을 적분한다. */
  function physics(s, h) {
    var Csat = doSaturation(s.T, s.P);
    var ka = aerationK(s.pump);
    var R = aliveExact(s) * respirationRate(s.T);
    var DOeq = Csat - R / ka;
    var DO1 = DOeq + (s.DO - DOeq) * Math.exp(-ka * h);
    s.DO = Math.max(0, DO1);
    var hz = speciesStatus(s).hazard;
    if (hz > 0 && s.fishBase > 0) s.S *= Math.exp(-hz * h);
    s.time += h;
    s.historyTimer += h;
    if (s.historyTimer >= HISTORY_DT - 1e-9) {
      s.historyTimer = 0;
      pushHistory(s);
    }
  }

  /**
   * dtMinutes: 진행할 시뮬레이션 시간(분).
   * 수온·기압의 부드러운 변화는 '실제 1.5초'에 걸쳐 일어나므로 dtMinutes ÷ 속도만큼 진행한다.
   */
  function step(state, dtMinutes) {
    if (!(dtMinutes > 0)) return state;
    var s = state;
    var sp = Math.max(1e-6, s.speed);
    var remaining = dtMinutes;
    while (remaining > 1e-9) {
      var h = Math.min(remaining, MAX_SUBSTEP);
      remaining -= h;
      advanceRamps(s, h / sp);
      if (s.heatwave) {
        var nt = Math.min(s.heatwave.to, s.T + s.heatwave.rate * h);
        s.ramps.T = null;
        s.T = s.target.T = nt;
        if (nt >= s.heatwave.to - 1e-9) { s.T = s.target.T = s.heatwave.to; s.heatwave = null; }
      }
      physics(s, h);
    }
    s.rates = currentRates(s);
    return s;
  }

  /** 화면용: 실제 경과 시간(초)만큼 진행. 일시정지 중에는 부드러운 변화만 진행한다. */
  function tick(state, dtRealSec) {
    if (!(dtRealSec > 0)) return state;
    if (state.paused) {
      advanceRamps(state, dtRealSec);
      state.rates = { exchange: 0, consume: 0 };
      return state;
    }
    return step(state, dtRealSec * state.speed);
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

  function altitudeText(P) {
    var h = pressureToAltitude(P);
    if (Math.abs(h) < 0.5) h = 0;
    return '해발 ' + (h < 0 ? '−' : '') + Math.round(Math.abs(h)) + ' m';
  }

  function applyTemperature(s, raw, isDelta) {
    var from = s.target.T;
    var hadHeatwave = !!s.heatwave;
    s.heatwave = null;
    var desired = isDelta ? from + raw : raw;
    var cw = clampWithWarning('T', desired);
    setTarget(s, 'T', cw.value);
    var to = cw.value;
    s.lastCause = to > from ? 'tempUp' : to < from ? 'tempDown' : s.lastCause;
    var msg = isDelta
      ? '수온 ' + signed(to - from) + '℃ (' + fmtShort(from) + '℃ → ' + fmtShort(to) + '℃)'
      : '수온 설정 (' + fmtShort(from) + '℃ → ' + fmtShort(to) + '℃)';
    if (hadHeatwave) msg += ' — 폭염 진행을 멈췄어요';
    return { message: msg, warning: cw.warning };
  }

  function applyPressure(s, raw, isDelta, viaAltitude) {
    var from = s.target.P;
    var desired = isDelta ? from + raw : raw;
    var cw = clampWithWarning('P', desired);
    setTarget(s, 'P', cw.value);
    var to = cw.value;
    s.lastCause = to < from ? 'pressDown' : to > from ? 'pressUp' : s.lastCause;
    var msg = isDelta
      ? '기압 ' + signed(to - from) + ' hPa (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa, ' + altitudeText(to) + ')'
      : '기압 설정 (' + fmtShort(from) + ' → ' + fmtShort(to) + ' hPa, ' + altitudeText(to) + ')';
    return { message: msg, warning: cw.warning };
  }

  function applyAltitude(s, raw) {
    var cw = clampWithWarning('alt', raw);
    var fromP = s.target.P;
    var fromH = pressureToAltitude(fromP);
    var P = round2(altitudeToPressure(cw.value));
    setTarget(s, 'P', P);
    s.lastCause = cw.value > fromH + 0.5 ? 'altUp' : cw.value < fromH - 0.5 ? 'altDown' : s.lastCause;
    var msg = '해발고도 ' + Math.round(Math.max(0, fromH)) + ' m → ' + fmtShort(cw.value) + ' m (기압 ' + fmtShort(fromP) + ' → ' + fmtShort(P) + ' hPa)';
    return { message: msg, warning: cw.warning };
  }

  function applyFish(s, raw, isDelta) {
    var alive = aliveCount(s);
    var dead = s.fishBase - alive;
    var desired = isDelta ? alive + raw : raw;
    var cw = clampWithWarning('fish', Math.round(desired));
    if (cw.warning === null && Math.round(desired) !== desired) cw.warning = '물고기 수는 정수로 반올림했어요.';
    s.fishBase = cw.value;
    s.S = 1;
    s.lastCause = cw.value > alive ? 'fishUp' : cw.value < alive ? 'fishDown' : s.lastCause;
    var msg = isDelta
      ? '물고기 ' + signed(cw.value - alive) + '마리 (' + alive + ' → ' + cw.value + '마리)'
      : '물고기 수 설정 (' + alive + ' → ' + cw.value + '마리)';
    if (dead > 0) msg += ' — 폐사한 ' + dead + '마리는 건져 냈어요';
    return { message: msg, warning: cw.warning };
  }

  function makeRecord(s) {
    var st = speciesStatus(s);
    return {
      time: s.time, T: s.T, P: s.P, alt: pressureToAltitude(s.P), pump: s.pump,
      species: speciesOf(s).name, alive: aliveCount(s), total: s.fishBase,
      Csat: doSaturation(s.T, s.P), DO: s.DO, survival: s.S * 100, status: st.label
    };
  }

  /** action을 상태에 적용한다. state를 직접 바꾸고 {state, message, warning}을 돌려준다. */
  function applyAction(state, action) {
    var s = state;
    var r = { message: '', warning: null };
    var a = action || {};
    var type = a.type;

    var needNumber = {
      setTemperature: 'value', changeTemperature: 'delta', setPressure: 'value', changePressure: 'delta',
      setAltitude: 'value', setFishCount: 'value', changeFishCount: 'delta', setSpeed: 'multiplier'
    };
    if (needNumber[type] && !num(a[needNumber[type]])) {
      return { state: s, message: '숫자 값을 읽지 못했어요', warning: '"' + type + '" 명령에 올바른 숫자(' + needNumber[type] + ')가 없어요.' };
    }

    switch (type) {
      case 'setTemperature': r = applyTemperature(s, a.value, false); break;
      case 'changeTemperature': r = applyTemperature(s, a.delta, true); break;
      case 'setPressure': r = applyPressure(s, a.value, false); break;
      case 'changePressure': r = applyPressure(s, a.delta, true); break;
      case 'setAltitude': r = applyAltitude(s, a.value); break;
      case 'pumpOn':
        if (s.pump) { r.message = '에어펌프는 이미 켜져 있어요'; break; }
        s.pump = true; s.lastCause = 'pumpOn';
        r.message = '에어펌프 켬 (k_a ' + KA_OFF + ' → ' + KA_ON + ' /분)';
        break;
      case 'pumpOff':
        if (!s.pump) { r.message = '에어펌프는 이미 꺼져 있어요'; break; }
        s.pump = false; s.lastCause = 'pumpOff';
        r.message = '에어펌프 끔 (k_a ' + KA_ON + ' → ' + KA_OFF + ' /분)';
        break;
      case 'setFishCount': r = applyFish(s, a.value, false); break;
      case 'changeFishCount': r = applyFish(s, a.delta, true); break;
      case 'setSpecies':
        if (!SPECIES[a.species]) { r.message = '지원하지 않는 어종'; r.warning = '어종은 trout(무지개송어) 또는 carp(잉어)만 가능해요.'; break; }
        if (s.species === a.species) { r.message = '이미 ' + SPECIES[a.species].name + '예요'; break; }
        var oldName = speciesOf(s).name;
        s.species = a.species;
        s.S = 1;
        s.lastCause = 'species';
        r.message = '어종 변경: ' + oldName + ' → ' + SPECIES[a.species].name + ' (' + s.fishBase + '마리 새로 입식)';
        break;
      case 'scenario':
        switch (a.name) {
          case 'heatwave':
            var T0 = s.target.T;
            if (T0 >= HEATWAVE.to) { r.message = '폭염: 이미 ' + fmtShort(T0) + '℃라 수온을 더 올리지 않아요'; break; }
            s.ramps.T = null;
            s.T = s.target.T = s.T;
            s.heatwave = { rate: HEATWAVE.rate, to: HEATWAVE.to };
            s.lastCause = 'heatwave';
            r.message = '시나리오 「폭염」: 수온이 1℃/분씩 ' + HEATWAVE.to + '℃까지 올라가요 (' + fmtShort(s.T) + '℃에서 시작)';
            break;
          case 'highland':
            r = applyAltitude(s, HIGHLAND_ALT);
            r.message = '시나리오 「고산 호수」: ' + r.message;
            s.lastCause = 'highland';
            break;
          case 'overcrowded':
            r = applyFish(s, OVERCROWDED, false);
            r.message = '시나리오 「과밀 양식」: ' + r.message;
            s.lastCause = 'overcrowded';
            break;
          case 'emergencyPump':
            var was = s.pump;
            s.pump = true;
            s.lastCause = 'emergencyPump';
            r.message = '시나리오 「에어펌프 비상 가동」: ' + (was ? '이미 켜져 있던 에어펌프를 최대로 가동해요' : '에어펌프 켬 (k_a ' + KA_OFF + ' → ' + KA_ON + ' /분)');
            break;
          default:
            r.message = '지원하지 않는 시나리오';
            r.warning = '시나리오는 heatwave, highland, overcrowded, emergencyPump만 가능해요.';
        }
        break;
      case 'setSpeed':
        var csp = clampWithWarning('speed', a.multiplier);
        var oldSp = s.speed;
        s.speed = csp.value;
        r.message = '속도 ×' + fmtShort(oldSp) + ' → ×' + fmtShort(csp.value) + ' (실제 1초 = ' + fmtShort(csp.value) + '분)';
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
        r.message = '초기화: 20℃, 해발 0 m, 에어펌프 끔, 무지개송어 20마리';
        break;
      case 'record':
        var rec = makeRecord(s);
        s.records.push(rec);
        r.message = '기록 #' + s.records.length + ' 저장 (t = ' + fmt(rec.time, 1) + '분)';
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
    s.rates = currentRates(s);
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
        var spec = Object.prototype.hasOwnProperty.call(ACTION_SPECS, a.type) ? ACTION_SPECS[a.type] : null;
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
          if (base.indexOf('enum:') === 0) {
            var allowed = base.slice(5).split('|');
            if (allowed.indexOf(v) < 0) { errors.push('actions[' + i + '].' + field + '는 ' + allowed.join(', ') + ' 중 하나여야 해요'); return; }
          }
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
  var UNIT_HEAD = /^(도|℃|℉|켈빈|화씨|섭씨|헥토파스칼|킬로파스칼|파스칼|hpa|kpa|pa|기압|atm|mmhg|bar|마리|미터|킬로미터|km|m(?![a-z])|배|초|분|퍼센트|%)/;

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

  /** 한글 수사 뒤에 단위가 올 때만 아라비아 숫자로 바꾼다("열 마리" → "10 마리", "열어"는 그대로). */
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
      // "구도", "사배", "오분"처럼 한 글자 한자어 수사가 붙은 일반 낱말은 그대로 둔다.
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
    heatwave: /폭염|무더위|불볕|열대야|찜통/,
    overcrowded: /과밀/,
    emergency: /비상/,
    highland: /고산\s*호수|고산\s*지대|높은\s*산\s*(?:위|속)?\s*호수/,
    pump: /에어\s*펌프|펌프|산소\s*공급|폭기|기포기|에어\s*스톤|공기\s*공급|산소\s*발생기/,
    pumpOff: /꺼|끄|끈|멈|정지|중지|off|끊|그만|중단/,
    trout: /무지개\s*송어|송어/,
    carp: /잉어/,
    pause: /멈춰|멈추|멈춤|정지|스톱|stop|pause|잠깐/,
    resume: /재개|다시\s*(?:시작|재생|움직|진행|돌려|켜)|계속|재생|resume|play|^다시$|^다시\s*해/,
    speedWord: /속도|배속|빠르게|빨리|느리게|천천히|시간\s*을?\s*(?:빨|느)/,
    tempWord: /온도|수온|℃|℉|데워|데우|데펴|식혀|식히|차갑|차게|따뜻|따듯|뜨겁|뜨거|시원|가열|냉각|켈빈|화씨|섭씨|실온|상온|어는점|\d\s*(?:도(?!시)|k(?![a-z])|켈빈)/,
    pressWord: /압력|기압|hpa|헥토|kpa|킬로파스칼|파스칼|atm|mmhg|bar|\d\s*pa(?![a-z])/,
    altWord: /해발|고도|고지대|고지|고산|저지대|평지|바닷가|해수면|높은\s*곳|낮은\s*곳|(?:^|\s)산(?=\s|으로|위|꼭대기|에|$)|\d\s*(?:m(?![a-z])|미터|km|킬로미터)/,
    fishWord: /물고기|마리|어류|개체|입식|치어|고기/,
    fishVerb: /넣어|넣고|넣자|추가|풀어/,
    inc: /올려|올리|올라|높여|높이|증가|늘려|늘리|키워|더해|더\s|더$|데워|데우|데펴|가열|따뜻|따듯|뜨겁|뜨거|up/,
    dec: /내려|내리|낮춰|낮추|감소|줄여|줄이|빼|식혀|식히|냉각|차갑|차게|시원|down/,
    setWord: /맞춰|맞추|설정|세팅|변경|바꿔|바꾸|만들어|되게|되도록|로\s*해|으로\s*해|로\s*하|까지/,
    small: /조금|살짝|약간|좀|소폭/,
    large: /많이|크게|훨씬|확\s|팍|엄청|아주|대폭|왕창/
  };

  var QTY_RE = /(-?\d+(?:\.\d+)?)\s*(℃|도씨|도(?!시)|켈빈|k(?![a-z])|℉|화씨|hpa|헥토파스칼|kpa|킬로파스칼|mmhg|atm|기압|pa(?![a-z])|파스칼|bar|km|킬로미터|미터|m(?![a-z])|마리|배속|배|%|퍼센트|초|분)?/g;

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
    if (/^(km|킬로미터)$/.test(u)) return 'km';
    if (/^(m|미터)$/.test(u)) return 'm';
    if (u === '마리') return 'fish';
    if (u === '배') return 'times';
    if (u === '배속') return 'speed';
    if (/^(%|퍼센트)$/.test(u)) return 'percent';
    if (u === '초') return 'sec';
    if (u === '분') return 'min';
    return 'none';
  }
  var TEMP_KINDS = { C: 1, K: 1, F: 1 };
  var PRESS_KINDS = { hPa: 1, kPa: 1, mmHg: 1, atm: 1, Pa: 1, bar: 1 };
  var ALT_KINDS = { m: 1, km: 1 };
  var OTHER_KINDS = { sec: 1, speed: 1, min: 1 };

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

  var SET_AFTER = /^\s*(?:으로|로|에\s*맞|까지)/;

  function direction(c, qty, fallback, incRe, decRe) {
    incRe = incRe || RE.inc; decRe = decRe || RE.dec;
    if (qty && SET_AFTER.test(qty.after)) return 'set';
    if (qty && RE.setWord.test(c)) return 'set';
    var dec = decRe.test(c), inc = incRe.test(c);
    if (dec) return 'dec';
    if (inc) return 'inc';
    if (fallback) return fallback;
    if (qty) return 'set';
    if (RE.setWord.test(c)) return 'set';
    return null;
  }

  /** target에 맞는 단위의 수량을 고른다('로/으로'가 붙은 값을 우선). */
  function pickQuantity(c, accept) {
    var qs = quantities(c).filter(function (q) { return !OTHER_KINDS[q.kind] && accept(q.kind); });
    for (var i = 0; i < qs.length; i++) if (SET_AFTER.test(qs[i].after)) return qs[i];
    var q = qs[0] || null;
    if (/절반|반\s*으로|반만/.test(c)) q = { value: 0.5, kind: 'times', after: '', half: true };
    return q;
  }
  function scaleFactor(q, dir) {
    var f = q.kind === 'times' ? q.value : 1 + (dir === 'dec' ? -q.value : q.value) / 100;
    if (q.kind === 'times' && !q.half && dir === 'dec' && f > 1) f = 1 / f;
    return f;
  }
  function amount(c, small, normal, large) {
    return RE.small.test(c) ? small : RE.large.test(c) ? large : normal;
  }

  function parseTemp(c, ctx, dirFallback) {
    var q = pickQuantity(c, function (k) { return !PRESS_KINDS[k] && !ALT_KINDS[k] && k !== 'fish'; });
    var dir = direction(c, q, dirFallback);
    if (!q) {
      if (/실온|상온/.test(c) && dir !== 'inc' && dir !== 'dec') return { type: 'setTemperature', value: 25 };
      if (/어는점|얼음물/.test(c) && dir !== 'inc' && dir !== 'dec') return { type: 'setTemperature', value: 0 };
      if (dir !== 'inc' && dir !== 'dec') return null;
      var amt = amount(c, 2, 5, 10);
      return { type: 'changeTemperature', delta: dir === 'inc' ? amt : -amt };
    }
    if (q.kind === 'times' || q.kind === 'percent') return { type: 'setTemperature', value: round2(ctx.target.T * scaleFactor(q, dir)) };
    if (dir === 'inc' || dir === 'dec') {
      var d = Math.abs(toCelsius(q.value, q.kind, true));
      return { type: 'changeTemperature', delta: round2(dir === 'inc' ? d : -d) };
    }
    return { type: 'setTemperature', value: round2(toCelsius(q.value, q.kind, false)) };
  }

  function parsePress(c, ctx, dirFallback) {
    var q = pickQuantity(c, function (k) { return !TEMP_KINDS[k] && !ALT_KINDS[k] && k !== 'fish'; });
    var dir = direction(c, q, dirFallback);
    if (!q) {
      if (dir !== 'inc' && dir !== 'dec') return null;
      var amt = amount(c, 10, 50, 100);
      return { type: 'changePressure', delta: dir === 'inc' ? amt : -amt };
    }
    if (q.kind === 'times' || q.kind === 'percent') return { type: 'setPressure', value: round2(ctx.target.P * scaleFactor(q, dir)) };
    var v = round2(toHPa(q.value, q.kind));
    if (dir === 'inc' || dir === 'dec') return { type: 'changePressure', delta: dir === 'inc' ? Math.abs(v) : -Math.abs(v) };
    return { type: 'setPressure', value: v };
  }

  function parseAlt(c, ctx, dirFallback) {
    var q = pickQuantity(c, function (k) { return ALT_KINDS[k] || k === 'none'; });
    var dir = direction(c, q, dirFallback);
    var cur = Math.max(0, pressureToAltitude(ctx.target.P));
    if (!q) {
      if (/해수면|바닷가|평지|저지대/.test(c) && dir !== 'inc') return { type: 'setAltitude', value: 0 };
      if (dir === 'inc' || dir === 'dec') {
        var amt = amount(c, 200, 500, 1000);
        return { type: 'setAltitude', value: Math.round(Math.max(0, cur + (dir === 'inc' ? amt : -amt))) };
      }
      if (/고산|고지|(?:^|\s)산|높은\s*곳/.test(c)) return { type: 'scenario', name: 'highland' };
      return null;
    }
    var v = q.kind === 'km' ? q.value * 1000 : q.value;
    if (dir === 'inc' || dir === 'dec') return { type: 'setAltitude', value: round2(Math.max(0, cur + (dir === 'inc' ? v : -v))) };
    return { type: 'setAltitude', value: round2(v) };
  }

  var FISH_INC = /넣|추가|늘려|늘리|더\s|더$|풀어|입식|키워|up/;
  var FISH_DEC = /빼|줄여|줄이|건져|꺼내|덜|내보내|down/;

  function parseFish(c, ctx, dirFallback) {
    var q = pickQuantity(c, function (k) { return k === 'fish' || k === 'none' || k === 'times' || k === 'percent'; });
    var dir = direction(c, q, dirFallback, FISH_INC, FISH_DEC);
    var alive = aliveCount(ctx);
    if (!q) {
      if (/전부|모두|다\s*(?:빼|건져|꺼내)/.test(c) && dir === 'dec') return { type: 'setFishCount', value: 0 };
      if (dir !== 'inc' && dir !== 'dec') return null;
      var amt = amount(c, 5, 10, 20);
      return { type: 'changeFishCount', delta: dir === 'inc' ? amt : -amt };
    }
    if (q.kind === 'times' || q.kind === 'percent') return { type: 'setFishCount', value: Math.round(alive * scaleFactor(q, dir)) };
    if (dir === 'inc' || dir === 'dec') return { type: 'changeFishCount', delta: dir === 'inc' ? Math.abs(q.value) : -Math.abs(q.value) };
    return { type: 'setFishCount', value: q.value };
  }

  /** 처음 일치하는 위치. "2000m", "30 마리"처럼 숫자로 시작하는 표현은 숫자 앞으로 당긴다. */
  function firstIndex(re, c) {
    var m = c.match(re);
    if (!m) return -1;
    var i = m.index;
    while (i > 0 && /[\d.\s-]/.test(c.charAt(i - 1))) i--;
    while (i < m.index && /\s/.test(c.charAt(i))) i++;
    return i;
  }

  function parseSpecies(c) {
    var m = c.match(/(무지개\s*송어|송어|잉어)\s*(?:으로|로)/);
    var word = m ? m[1] : null;
    if (!word) {
      var iT = c.search(RE.trout), iC = c.search(RE.carp);
      word = iT > iC ? '송어' : iC >= 0 ? '잉어' : iT >= 0 ? '송어' : null;
    }
    if (!word) return null;
    return { type: 'setSpecies', species: /잉어/.test(word) ? 'carp' : 'trout' };
  }

  var PARSERS = { temp: parseTemp, press: parsePress, alt: parseAlt, fish: parseFish };

  /** 한 절(clause)을 해석해 action 배열을 돌려준다. */
  function parseClause(c, ctx, memo) {
    if (RE.reset.test(c)) return [{ type: 'reset' }];
    if (RE.record.test(c)) return [{ type: 'record' }];
    var hasNumber = quantities(c).length > 0;
    if (RE.heatwave.test(c)) return [{ type: 'scenario', name: 'heatwave' }];
    if (RE.overcrowded.test(c) && !hasNumber) return [{ type: 'scenario', name: 'overcrowded' }];
    if (RE.emergency.test(c) && RE.pump.test(c)) return [{ type: 'scenario', name: 'emergencyPump' }];
    if (RE.highland.test(c) && !hasNumber) return [{ type: 'scenario', name: 'highland' }];
    if (RE.pump.test(c)) return [{ type: RE.pumpOff.test(c) ? 'pumpOff' : 'pumpOn' }];
    if (RE.trout.test(c) || RE.carp.test(c)) {
      var spa = parseSpecies(c);
      if (spa) {
        // "잉어 10마리 넣어줘"처럼 어종과 마릿수가 함께 나오면 둘 다 처리한다.
        var rest = c.replace(/무지개\s*송어|송어|잉어/g, ' ').replace(/(?:으로|로)\s*(?:바꿔|바꾸|변경|교체)\S*/, ' ');
        var more = quantities(rest).length || RE.fishVerb.test(rest) ? parseClause(rest, ctx, memo) : [];
        return [spa].concat(more);
      }
    }

    // 수온·기압·고도·물고기 수: 문장에 나온 순서대로 잘라서 해석한다.
    var found = [];
    var kinds = { temp: RE.tempWord, press: RE.pressWord, alt: RE.altWord, fish: RE.fishWord };
    Object.keys(kinds).forEach(function (k) {
      var i = firstIndex(kinds[k], c);
      if (i >= 0) found.push({ kind: k, index: i });
    });
    if (!found.length && RE.fishVerb.test(c)) found.push({ kind: 'fish', index: 0 });
    var isSpeed = RE.speedWord.test(c) || quantities(c).some(function (q) { return q.kind === 'speed'; });
    if (!found.length && !isSpeed && (hasNumber || RE.inc.test(c) || RE.dec.test(c)) && memo.lastTarget) {
      found.push({ kind: memo.lastTarget, index: 0 });
    }
    if (found.length) {
      found.sort(function (a, b) { return a.index - b.index; });
      // 같은 위치에서 시작하면 하나만 남긴다.
      found = found.filter(function (f, i) { return i === 0 || f.index !== found[i - 1].index; });
      var dirAll = found.length > 1 ? direction(c, null) : null;
      var out = [];
      for (var k = 0; k < found.length; k++) {
        var start = k === 0 ? 0 : found[k].index;
        var end = k + 1 < found.length ? found[k + 1].index : c.length;
        var part = c.slice(start, end);
        // 동사가 끝에 하나만 있으면("수온과 기압 조금 올려") 앞 조각도 그 방향을 따른다.
        var a = PARSERS[found[k].kind](part, ctx, dirAll);
        if (a) out.push(a);
        memo.lastTarget = found[k].kind;
      }
      return out;
    }

    if (isSpeed) {
      var mm = c.match(/(\d+(?:\.\d+)?)\s*(?:배속|배)/) || c.match(/[x×]\s*(\d+(?:\.\d+)?)/) || c.match(/(\d+(?:\.\d+)?)/);
      if (mm) return [{ type: 'setSpeed', multiplier: parseFloat(mm[1]) }];
      var levels = [1, 10, 60];
      var cur = ctx.speed;
      if (/느리게|천천히|느리|늦/.test(c)) {
        var down = 1;
        for (var i = levels.length - 1; i >= 0; i--) if (levels[i] < cur) { down = levels[i]; break; }
        return [{ type: 'setSpeed', multiplier: down }];
      }
      if (/보통|원래|기본/.test(c)) return [{ type: 'setSpeed', multiplier: 1 }];
      var up = 60;
      for (var j = 0; j < levels.length; j++) if (levels[j] > cur) { up = levels[j]; break; }
      return [{ type: 'setSpeed', multiplier: up }];
    }
    if (RE.pause.test(c)) return [{ type: 'pause' }];
    if (RE.resume.test(c)) return [{ type: 'resume' }];
    return [];
  }

  // ───────────────────────── 설명 문장(템플릿) ─────────────────────────
  function stateSummary(s) {
    var st = speciesStatus(s);
    return '지금은 수온 ' + fmtShort(round2(s.T)) + '℃, 기압 ' + fmtShort(round2(s.P)) + ' hPa에서 포화 DO가 ' + fmt(doSaturation(s.T, s.P)) +
      ' mg/L이고, 실제 DO는 ' + fmt(s.DO) + ' mg/L로 ' + speciesOf(s).name + ' 기준 「' + st.label + '」 상태예요.';
  }

  function explainText(question, s) {
    var q = String(question || '');
    if (/탄산수|콜라|사이다|차갑게|냉장/.test(q)) {
      var c5 = molarSolubility('CO2', 5), c25 = molarSolubility('CO2', 25);
      return '기체는 차가울수록 잘 녹아요. 1 atm CO₂ 기준 5℃에서 ' + fmt(c5) + ' mmol/L, 25℃에서 ' + fmt(c25) +
        ' mmol/L라서 차갑게 보관하면 CO₂가 덜 빠져나가 탄산이 오래 유지돼요. 물고기 수조에서 수온이 오르면 O₂가 빠져나가는 것과 같은 원리예요.';
    }
    if (/잠수|다이버|감압|혈액|질소|n2|n₂/.test(q)) {
      return '깊은 물속에서는 압력이 커서 헨리 법칙에 따라 혈액에 N₂가 많이 녹아요. 빨리 올라오면 압력이 갑자기 줄어 혈액이 과포화되고, 탄산수 뚜껑을 딴 것처럼 N₂ 기포가 생겨 감압병이 생길 수 있어요.';
    }
    if (/고산|고지|해발|고도|산|기압|헨리|부분\s*압력/.test(q)) {
      var c0 = doSaturation(20, ATM_HPA), c2 = doSaturation(20, altitudeToPressure(2000));
      return '헨리 법칙: 기체의 용해도는 그 기체의 부분압력에 비례해요. 해발 2000 m에서는 기압이 약 ' + fmt(altitudeToPressure(2000), 0) +
        ' hPa로 낮아 O₂ 부분압력도 줄어서, 20℃ 포화 DO가 ' + fmt(c0) + ' → ' + fmt(c2) + ' mg/L로 줄어요.';
    }
    if (/펌프|폭기|기포|에어/.test(q)) {
      return '에어펌프는 물속에 공기 방울을 만들어 공기와 물이 닿는 면적을 넓혀요. 그래서 산소가 녹아 들어오는 속도(k_a)가 0.05에서 0.30 /분으로 커지지만, 포화량(C_sat) 자체를 넘게 녹일 수는 없어요.';
    }
    if (/마리|과밀|많이\s*넣|빽빽|밀도/.test(q)) {
      return '물고기가 많을수록 산소를 쓰는 속도(n × r)가 커져요. 정상상태 DO = C_sat − n·r/k_a 이므로 물고기 수가 늘면 DO가 낮아지고, 에어펌프로 k_a를 키우면 덜 떨어져요.';
    }
    if (/폭염|여름|폐사|떼죽음|물고기|어류|수온|온도|따뜻|뜨거/.test(q)) {
      var s20 = doSaturation(20, ATM_HPA), s30 = doSaturation(30, ATM_HPA);
      return '수온이 오르면 이중 타격이 와요. ① 산소 용해도가 줄어(20℃ ' + fmt(s20) + ' → 30℃ ' + fmt(s30) + ' mg/L) 물에 녹을 수 있는 산소가 줄고, ② 물고기의 호흡량은 10℃마다 2배(Q₁₀ = 2)로 늘어요. 그래서 여름 폭염에 양식장 물고기가 집단 폐사할 수 있어요.';
    }
    if (/송어|잉어|어종|냉수|온수/.test(q)) {
      return '무지개송어 같은 냉수성 어종은 25℃ 근처에서 버티기 어렵고 DO도 7 mg/L 이상이 쾌적해요. 잉어 같은 온수성 어종은 35℃까지, DO 5 mg/L 이상이면 쾌적해 따뜻한 물에 더 강해요.';
    }
    return stateSummary(s) + ' 수온을 올리면 포화량은 줄고 호흡은 늘어 DO가 떨어지고, 에어펌프를 켜면 산소가 더 빨리 녹아 들어와요.';
  }

  function actionSentence(a, before, after) {
    switch (a.type) {
      case 'setTemperature':
      case 'changeTemperature':
        if (after.target.T > before.target.T) return '수온이 오르면 산소 용해도가 줄고 물고기의 호흡량은 늘어나 용존산소가 이중으로 부족해져요.';
        if (after.target.T < before.target.T) return '수온이 내려가면 산소가 더 많이 녹을 수 있고 물고기의 호흡량도 줄어요.';
        return '수온은 그대로예요.';
      case 'setPressure':
      case 'changePressure':
      case 'setAltitude':
        if (after.target.P < before.target.P) return '기압이 낮아지면 공기 중 O₂ 부분압력이 줄어, 헨리 법칙에 따라 물에 녹을 수 있는 산소(포화량)도 비례해 줄어요.';
        if (after.target.P > before.target.P) return '기압이 높아지면 O₂ 부분압력이 커져 헨리 법칙에 따라 포화량도 커져요.';
        return '기압은 그대로예요.';
      case 'pumpOn':
        return before.pump ? '에어펌프는 이미 켜져 있어요.' : '에어펌프를 켜면 기포 표면에서 산소가 빠르게 녹아 들어와(k_a 0.05 → 0.30 /분) 용존산소가 포화량 쪽으로 빨리 회복돼요.';
      case 'pumpOff':
        return !before.pump ? '에어펌프는 이미 꺼져 있어요.' : '에어펌프를 끄면 수면을 통해서만 산소가 천천히 녹아 들어와 용존산소가 떨어질 수 있어요.';
      case 'setFishCount':
      case 'changeFishCount':
        if (after.fishBase > aliveCount(before)) return '물고기가 많아지면 산소를 쓰는 속도가 커져 용존산소가 낮아져요.';
        if (after.fishBase < aliveCount(before)) return '물고기 수가 줄면 산소 소비가 줄어 용존산소가 올라가요.';
        return '물고기 수는 그대로예요.';
      case 'setSpecies':
        var sp = SPECIES[a.species];
        if (!sp) return '';
        return sp.name + '(' + sp.kind + ')은 치사 수온 ' + sp.lethalT + '℃, DO ' + sp.DO.comfort + ' mg/L 이상이 쾌적해요.';
      case 'scenario':
        if (a.name === 'heatwave') return '폭염: 수온이 1분에 1℃씩 32℃까지 올라가요. 포화량은 줄고 호흡은 늘어 용존산소가 빠르게 떨어질 거예요.';
        if (a.name === 'highland') return '해발 2000 m 고산 호수는 기압이 약 795 hPa라 O₂ 부분압력이 낮아 포화량이 해수면보다 약 22 % 적어요.';
        if (a.name === 'overcrowded') return '50마리를 키우면 산소 소비가 크게 늘어 정상상태 DO가 낮아져요.';
        if (a.name === 'emergencyPump') return '에어펌프를 비상 가동해 기포로 산소를 공급하면 용존산소가 포화량 쪽으로 빠르게 회복돼요.';
        return '';
      case 'setSpeed': return '시간 흐름을 ×' + fmtShort(after.speed) + '로 바꿨어요(실제 1초 = ' + fmtShort(after.speed) + '분).';
      case 'pause': return '시간을 멈췄어요. "다시 시작"이라고 하면 이어서 진행해요.';
      case 'resume': return '시간이 다시 흘러요.';
      case 'reset': return '처음 상태(20℃, 해발 0 m, 에어펌프 끔, 무지개송어 20마리)로 돌아갔어요.';
      case 'record': return '현재 상태를 실험 기록 표에 저장했어요.';
      case 'explain': return explainText(a.question, before);
      default: return '';
    }
  }

  var STATE_CHANGING = {
    setTemperature: 1, changeTemperature: 1, setPressure: 1, changePressure: 1, setAltitude: 1,
    pumpOn: 1, pumpOff: 1, setFishCount: 1, changeFishCount: 1, setSpecies: 1, scenario: 1
  };

  function predictionSentence(start, end) {
    var Tend = end.heatwave ? end.heatwave.to : end.target.T;
    var c0 = doSaturation(start.target.T, start.target.P), c1 = doSaturation(Tend, end.target.P);
    var ss0 = steadyStateDO(start.target.T, start.target.P, aliveExact(start), start.pump);
    var ss1 = steadyStateDO(Tend, end.target.P, aliveExact(end), end.pump);
    var sp = speciesOf(end);
    var g = worse(doGrade(sp, ss1), tempGrade(sp, Tend));
    return '예상: 포화 DO ' + fmt(c0) + ' → ' + fmt(c1) + ' mg/L, 정상상태 DO ' + fmt(ss0) + ' → ' + fmt(ss1) +
      ' mg/L (' + sp.name + ' 기준 「' + GRADES[g].label + '」).';
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
    if (changed && !actions.some(function (a) { return a.type === 'reset'; })) sentences.push(predictionSentence(start, sim));
    return sentences.join(' ');
  }

  function unknownReply() {
    return '명령을 이해하지 못했어요. 이렇게 말해 보세요: "' + EXAMPLES.join('", "') + '"';
  }

  /** 내장 규칙 기반 해석기. 반환: {actions, reply} */
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
        applyAction(ctx, a); // 이어지는 절이 바뀐 상태를 기준으로 해석되도록
      });
    });
    if (!actions.length) return { actions: [{ type: 'unknown' }], reply: unknownReply() };
    return { actions: actions, reply: buildReply(s, actions) };
  }

  // ───────────────────────── 화면용 보조 함수 ─────────────────────────
  /** 3D 뷰 위 상황 자막 */
  function caption(state) {
    var s = state;
    var sp = speciesOf(s);
    var Csat = doSaturation(s.T, s.P);
    var st = speciesStatus(s);
    var diff = s.DO - Csat;
    var alive = aliveCount(s);
    var hot = s.T > sp.comfortT[1];
    var parts;
    if (s.heatwave) {
      parts = '폭염: 수온 상승 → 산소 용해도 감소 + 물고기 호흡 증가 → 용존산소 부족!';
    } else if (alive > 0 && st.tempGrade === 'lethal') {
      parts = '수온 ' + fmt(s.T, 1) + '℃ ≥ ' + sp.short + '의 치사 수온 ' + sp.lethalT + '℃ → 산소가 있어도 견디기 어려워요!';
    } else if (alive > 0 && hot && st.doGrade !== 'comfort') {
      parts = '수온 상승 → 산소 용해도 감소 + 물고기 호흡 증가 → 용존산소 부족!';
    } else if (alive > 0 && st.tempGrade === 'danger') {
      parts = '수온 ' + fmt(s.T, 1) + '℃ → ' + sp.short + '의 치사 수온(' + sp.lethalT + '℃)에 가까워요';
    } else if (diff > 0.05) {
      parts = '과포화 (DO ' + fmt(s.DO) + ' > 포화 ' + fmt(Csat) + ') → 산소가 수면으로 빠져나가요';
    } else if (s.pump && diff < -0.3) {
      parts = '에어펌프 가동 → 기포 표면에서 산소가 녹아 들어와요';
    } else if (s.lastCause === 'highland' || s.lastCause === 'altUp' || s.lastCause === 'pressDown') {
      parts = '기압 낮음 → O₂ 부분압력 감소 → 포화량 감소 (헨리 법칙)';
    } else if (alive > 0 && st.doGrade !== 'comfort') {
      parts = '산소 소비 > 산소 공급 → 용존산소 부족!';
    } else if (s.lastCause === 'overcrowded' || s.lastCause === 'fishUp') {
      parts = '물고기 수 증가 → 산소 소비 증가 → 용존산소 감소';
    } else if (diff < -0.3) {
      parts = '불포화 → 공기 중 산소가 수면을 통해 녹아 들어와요';
    } else {
      parts = '녹아 들어오는 산소 ≈ 물고기가 쓰는 산소 (정상상태)';
    }
    if (s.fishBase > 0 && alive === 0) parts += ' · 물고기가 모두 폐사했어요';
    else if (alive > 0 && st.hazard >= H_DO.danger) parts += ' · 물고기 위험!';
    return { text: parts, grade: st.key };
  }

  /** 계산식 표시 */
  function formulas(state) {
    var s = state;
    var T = s.T, P = s.P;
    var pwv = vaporPressure(T);
    var c1 = doSaturation1atm(T);
    var Csat = doSaturation(T, P);
    var pO2 = o2PartialPressure(T, P);
    var ka = aerationK(s.pump);
    var r = respirationRate(T);
    var n = aliveExact(s);
    var dDO = (s.DO > 1e-9 || Csat - n * r / ka > 0) ? ka * (Csat - s.DO) - n * r : 0;
    return {
      henry: '공기 중 O₂ 부분압력 = 0.2095 × (P − P_wv) = 0.2095 × (' + fmt(P) + ' − ' + fmt(pwv) + ') hPa = ' + pO2.toFixed(3) + ' atm → 포화량 ' + fmt(Csat) + ' mg/L',
      csat: 'C_sat = C*(1 atm) × (P − P_wv)/(1 − P_wv) = ' + fmt(c1) + ' × (' + (P / ATM_HPA).toFixed(4) + ' − ' + (pwv / ATM_HPA).toFixed(4) + ')/(1 − ' + (pwv / ATM_HPA).toFixed(4) + ') = ' + fmt(Csat) + ' mg/L',
      rate: 'dDO/dt = k_a(C_sat − DO) − n·r(T) = ' + fmtShort(ka) + ' × (' + fmt(Csat) + ' − ' + fmt(s.DO) + ') − ' + fmt(n, 1) + ' × ' + r.toFixed(4) + ' = ' + (dDO >= 0 ? '+' : '−') + fmt(Math.abs(dDO), 3) + ' mg/(L·분)',
      steady: '정상상태 DO = C_sat − n·r/k_a = ' + fmt(Csat) + ' − ' + fmt(n, 1) + ' × ' + r.toFixed(4) + ' / ' + fmtShort(ka) + ' = ' + fmt(Csat - n * r / ka) + ' mg/L' + (Csat - n * r / ka < 0 ? ' → 0 (산소 고갈)' : '')
    };
  }

  /** 3D 장면에 그릴 분자 수 */
  function displayCounts(state) {
    var air = Math.round(24 * state.P / ATM_HPA);
    return {
      dissolved: Math.min(120, Math.max(0, Math.round(state.DO / 15 * 120))),
      airO2: air,
      airN2: air * 4
    };
  }

  var RECORD_HEADERS = ['시뮬레이션 시간(분)', '수온(℃)', '기압(hPa)', '고도(m)', '에어펌프', '어종', '생존/전체', '포화 DO(mg/L)', '실제 DO(mg/L)', '생존률(%)', '상태'];
  function recordRow(r) {
    return [fmt(r.time, 1), fmt(r.T, 1), fmt(r.P, 1), String(Math.round(r.alt)), r.pump ? '켬' : '끔', r.species,
      r.alive + '/' + r.total + '마리', fmt(r.Csat), fmt(r.DO), fmt(r.survival, 1), r.status];
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
    var st = speciesStatus(state);
    var snapshot = {
      simTime_min: round2(state.time),
      waterTemperature_C: round2(state.T),
      targetTemperature_C: round2(state.target.T),
      heatwaveRunning: !!state.heatwave,
      pressure_hPa: round2(state.target.P),
      altitude_m: Math.round(pressureToAltitude(state.target.P)),
      airPump: state.pump ? 'on' : 'off',
      species: state.species,
      fishAlive: aliveCount(state),
      fishTotal: state.fishBase,
      saturationDO_mgL: round2(doSaturation(state.T, state.P)),
      actualDO_mgL: round2(state.DO),
      survival_percent: round2(state.S * 100),
      status: st.label,
      speed: state.speed,
      paused: state.paused
    };
    return [
      '너는 고등학교 화학·생명과학 수업용 "수온과 용존산소: 물고기 생존 시뮬레이터"의 명령 해석기다.',
      '학생의 한국어 명령을 아래 JSON 스키마의 명령 하나로 바꿔라.',
      '',
      '## 현재 상태(JSON)',
      JSON.stringify(snapshot),
      '',
      '## 출력 스키마',
      '{ "actions": [ {...}, ... ], "reply": "학생에게 보여줄 한두 문장의 한국어 설명" }',
      'action 종류:',
      '- {"type":"setTemperature","value":℃} / {"type":"changeTemperature","delta":℃} : 수온',
      '- {"type":"setPressure","value":hPa} / {"type":"changePressure","delta":hPa} : 주변 기압',
      '- {"type":"setAltitude","value":m} : 해발고도(기압으로 환산됨)',
      '- {"type":"pumpOn"} / {"type":"pumpOff"} : 에어펌프(산소 공급, 폭기, 기포기)',
      '- {"type":"setFishCount","value":마리} / {"type":"changeFishCount","delta":마리}',
      '- {"type":"setSpecies","species":"trout"|"carp"} : trout = 무지개송어, carp = 잉어',
      '- {"type":"scenario","name":"heatwave"|"highland"|"overcrowded"|"emergencyPump"} : 폭염(1℃/분씩 32℃까지) / 고산 호수(해발 2000 m) / 과밀 양식(50마리) / 에어펌프 비상 가동',
      '- {"type":"setSpeed","multiplier":1|10|60} : 실제 1초 = multiplier 분',
      '- {"type":"pause"} / {"type":"resume"} / {"type":"reset"} / {"type":"record"}',
      '- {"type":"explain","question":"질문"} : 질문에 답만 할 때',
      '- {"type":"unknown"} : 해석할 수 없을 때',
      '',
      '## 값 범위(넘으면 그대로 보내도 시뮬레이터가 잘라 낸다)',
      '수온 0~40℃, 기압 500~1100 hPa, 고도 0~5000 m, 물고기 0~60마리, 속도 0.5~60배',
      '',
      '## 어종 기준표(교육용 근사값, DO 단위 mg/L)',
      '| 어종 | 쾌적 수온 | 상한 치사 수온 | DO 쾌적 | DO 주의 | DO 위험 | DO 치사 |',
      '| 무지개송어(trout, 냉수성) | 10~20℃ | 25℃ | ≥7 | 5~7 | 3~5 | <3 |',
      '| 잉어(carp, 온수성) | 20~28℃ | 35℃ | ≥5 | 3~5 | 2~3 | <2 |',
      '',
      '## 과학 모델',
      '- 포화 DO(C_sat): Benson–Krause 식, 기압 보정 C_sat = C*(1 atm) × (P − P_wv)/(1 − P_wv)',
      '- dDO/dt = k_a(C_sat − DO) − n × r(T), k_a = 0.05/분(펌프 끔) 또는 0.30/분(켬), r(T) = 0.004 × 2^((T−20)/10)',
      '',
      '## 단위 변환 규칙(항상 ℃, hPa, m로 바꿔서 출력)',
      '- K → ℃: −273.15 (온도 차이는 그대로) / ℉ → ℃: (℉−32)×5/9 (온도 차이는 ×5/9)',
      '- kPa ×10, atm ×1013.25, "기압"(예: 1기압) ×1013.25, mmHg ×1.33322, Pa ÷100, km ×1000',
      '',
      '## 정도 표현 규칙',
      '- "조금/살짝/약간"은 2℃ 또는 10 hPa, "많이/크게"는 10℃ 또는 100 hPa, 정도 표현이 없으면 5℃ 또는 50 hPa',
      '- 물고기 수: "조금" 5마리, "많이" 20마리, 표현이 없으면 10마리',
      '- "~로", "~으로", "맞춰", "설정"은 set, "올려/높여/더/데워/넣어"는 증가, "내려/낮춰/줄여/식혀/빼"는 감소',
      '- 고도를 올리거나 내리라는 말은 현재 고도(' + Math.round(Math.max(0, pressureToAltitude(state.target.P))) + ' m)에 더하거나 빼서 setAltitude로 보낸다.',
      '',
      '## 복합 명령',
      '여러 동작이 이어지면(쉼표, 그리고, ~고) 말한 순서대로 actions 배열에 담는다.',
      '',
      '## reply 작성',
      '고등학생에게 예상되는 현상을 기체 용해도 개념(수온↑ → 산소 용해도↓ + 물고기 호흡↑ 이중 타격, 헨리 법칙: 용해도 ∝ O₂ 부분압력이라 고지대에서는 포화량↓, 에어펌프는 녹는 속도↑)으로 한두 문장에 설명한다.',
      '',
      '## 출력 형식',
      '오직 JSON 객체 하나만 출력한다. 코드 펜스(```)나 다른 글을 붙이지 않는다.'
    ].join('\n');
  }

  root.FishCore = {
    // 상수
    ATM_HPA: ATM_HPA, O2_FRACTION: O2_FRACTION, N2_FRACTION: N2_FRACTION, GASES: GASES, SPECIES: SPECIES, GRADES: GRADES, GRADE_ORDER: GRADE_ORDER,
    LIMITS: LIMITS, INITIAL: INITIAL, EXAMPLES: EXAMPLES, SCENARIOS: SCENARIOS, ACTION_TYPES: Object.keys(ACTION_SPECS),
    KA_OFF: KA_OFF, KA_ON: KA_ON, TANK_L: TANK_L, HISTORY_WINDOW: HISTORY_WINDOW, BEHAVIOR: BEHAVIOR,
    // 모델
    createState: createState,
    doSaturation: doSaturation,
    doSaturation1atm: doSaturation1atm,
    vaporPressure: vaporPressure,
    o2PartialPressure: o2PartialPressure,
    altitudeToPressure: altitudeToPressure,
    pressureToAltitude: pressureToAltitude,
    respirationRate: respirationRate,
    aerationK: aerationK,
    steadyStateDO: steadyStateDO,
    henryK: henryK,
    molarSolubility: molarSolubility,
    aliveCount: aliveCount,
    step: step,
    tick: tick,
    applyAction: applyAction,
    speciesStatus: speciesStatus,
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
    altitudeText: altitudeText,
    fmt: fmt,
    fmtShort: fmtShort
  };
})(globalThis);
