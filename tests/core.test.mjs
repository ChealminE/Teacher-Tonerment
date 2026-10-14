import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8'), { filename: 'src/core.js' });
const S = globalThis.SodaCore;

/** dt초를 작은 간격으로 나눠 진행한다(브라우저 프레임과 비슷하게). */
function run(state, seconds, frame = 0.1) {
  let t = 0;
  while (t < seconds - 1e-9) {
    const h = Math.min(frame, seconds - t);
    S.step(state, h);
    t += h;
  }
  return state;
}
function applyAll(state, actions) {
  return actions.map((a) => S.applyAction(state, a));
}
function oneAtm(T) {
  const s = S.createState();
  s.capOpen = false;
  s.P_bottle = s.target.P_bottle = S.ATM_HPA;
  s.T = s.target.T = T;
  return S.equilibriumSolubility(s);
}

test('1. 물리값: 1 atm CO₂ 평형 용해도', () => {
  const ranges = [[0, 3.0, 3.4], [25, 1.4, 1.6], [37, 1.0, 1.2], [40, 0.9, 1.1]];
  for (const [T, lo, hi] of ranges) {
    const c = oneAtm(T);
    assert.ok(c >= lo && c <= hi, `${T}℃: ${c.toFixed(3)} g/L 가 ${lo}~${hi} 범위 밖`);
    assert.ok(Math.abs(S.solubilityAt(T, S.ATM_HPA) - c) < 1e-12);
  }
  // 헨리 상수 자체와 다른 기체
  assert.ok(Math.abs(S.henryK('CO2', 25) - 0.034) < 1e-3);
  assert.ok(S.henryK('O2', 10) > S.henryK('O2', 30));
  assert.ok(S.molarSolubility('CO2', 25) > S.molarSolubility('O2', 25));
  assert.ok(S.molarSolubility('O2', 25) > S.molarSolubility('N2', 25));
});

test('2. 초기 상태는 포화 평형', () => {
  const s = S.createState();
  assert.equal(s.T, 5);
  assert.equal(s.P_bottle, 3500);
  assert.equal(s.P_amb, 1013.25);
  assert.equal(s.capOpen, false);
  const st = S.saturationStatus(s);
  assert.equal(st.key, 'saturated');
  assert.equal(st.label, '포화 평형');
  assert.ok(Math.abs(s.C - S.equilibriumSolubility(s)) < 1e-9);
  // 시간이 지나도 평형 유지
  run(s, 30);
  assert.equal(S.saturationStatus(s).key, 'saturated');
});

test('3. "온도 20도 올려줘" → changeTemperature +20 → 25℃ 과포화 → 용존량 감소', () => {
  const s = S.createState();
  const r = S.parseCommand('온도 20도 올려줘', s);
  assert.deepEqual(r.actions, [{ type: 'changeTemperature', delta: 20 }]);
  assert.ok(r.reply.length > 0);
  const res = S.applyAction(s, r.actions[0]);
  assert.equal(res.warning, null);
  assert.match(res.message, /\+20℃ \(5℃ → 25℃\)/);
  // 1.5초 동안 부드럽게 변한다
  run(s, 0.75);
  assert.ok(s.T > 5 && s.T < 25, `중간 온도 ${s.T}`);
  run(s, 0.85);
  assert.ok(Math.abs(s.T - 25) < 1e-9, `온도 ${s.T}`);
  assert.equal(S.saturationStatus(s).key, 'supersaturated');
  const c0 = s.C;
  run(s, 60);
  assert.ok(s.C < c0, `용존량 ${c0} → ${s.C}`);
  assert.ok(s.C > S.equilibriumSolubility(s), '평형 아래로 내려가지 않음');
});

test('4. "뚜껑 열어줘" → 유효 P_CO₂ ≈ 0.405 hPa, 과포화', () => {
  const s = S.createState();
  const r = S.parseCommand('뚜껑 열어줘', s);
  assert.deepEqual(r.actions, [{ type: 'openCap' }]);
  applyAll(s, r.actions);
  assert.equal(s.capOpen, true);
  assert.ok(Math.abs(S.effectivePCO2(s) - 0.405) <= 0.01, `P = ${S.effectivePCO2(s)}`);
  run(s, 0.5);
  assert.equal(S.saturationStatus(s).key, 'supersaturated');
});

test('5. 뚜껑 연 상태에서 "주변 기압 10hPa 올려줘" → 1023.25 hPa, 용해도 변화 < 2 %', () => {
  const s = S.createState();
  S.applyAction(s, { type: 'openCap' });
  const before = S.equilibriumSolubility(s);
  const r = S.parseCommand('주변 기압 10hPa 올려줘', s);
  assert.deepEqual(r.actions, [{ type: 'changeAmbientPressure', delta: 10 }]);
  applyAll(s, r.actions);
  run(s, 2);
  assert.ok(Math.abs(s.P_amb - 1023.25) < 1e-9, `P_amb = ${s.P_amb}`);
  const after = S.equilibriumSolubility(s);
  const change = Math.abs(after - before) / before;
  assert.ok(change < 0.02, `변화율 ${(change * 100).toFixed(2)} %`);
});

test('6. "뚜껑 닫고 압력 5000hPa로 해줘" → [closeCap, setPressure 5000] → 불포화에서 용존량 증가', () => {
  for (const startOpen of [false, true]) {
    const s = S.createState();
    if (startOpen) { S.applyAction(s, { type: 'openCap' }); run(s, 5); }
    const r = S.parseCommand('뚜껑 닫고 압력 5000hPa로 해줘', s);
    assert.deepEqual(r.actions, [{ type: 'closeCap' }, { type: 'setPressure', value: 5000 }]);
    applyAll(s, r.actions);
    assert.equal(s.capOpen, false);
    run(s, 2);
    assert.equal(s.P_bottle, 5000);
    assert.equal(S.saturationStatus(s).key, 'unsaturated');
    const c0 = s.C;
    run(s, 20);
    assert.ok(s.C > c0, `용존량 ${c0} → ${s.C}`);
  }
});

test('7. "마셔줘" → drink → 목표 온도 37℃, 뚜껑 열림', () => {
  const s = S.createState();
  const c0 = s.C;
  const r = S.parseCommand('마셔줘', s);
  assert.deepEqual(r.actions, [{ type: 'drink' }]);
  applyAll(s, r.actions);
  assert.equal(s.target.T, 37);
  assert.equal(s.capOpen, true);
  assert.ok(s.drink);
  assert.ok(Math.abs(s.drink.before - c0) < 1e-9);
  assert.ok(Math.abs(s.drink.released - (c0 - S.solubilityAt(37, S.effectivePCO2(s)))) < 1e-9);
  run(s, 2.1);
  assert.ok(Math.abs(s.T - 37) < 1e-9);
  assert.equal(S.saturationStatus(s).key, 'supersaturated');
  assert.ok(s.rates.release > 0);
});

test('8. "300도로 올려줘" → 80℃로 제한 + warning', () => {
  const s = S.createState();
  const r = S.parseCommand('300도로 올려줘', s);
  assert.deepEqual(r.actions, [{ type: 'setTemperature', value: 300 }]);
  const res = S.applyAction(s, r.actions[0]);
  assert.equal(s.target.T, 80);
  assert.ok(res.warning && res.warning.length > 0);
  run(s, 2);
  assert.equal(s.T, 80);
  // 압력·기압 범위도 잘린다
  assert.ok(S.applyAction(s, { type: 'setPressure', value: 9000 }).warning);
  assert.equal(s.target.P_bottle, 6000);
  assert.ok(S.applyAction(s, { type: 'setAmbientPressure', value: 100 }).warning);
  assert.equal(s.target.P_amb, 300);
});

test('9. 한글 수사 "온도 열 도 내려줘" → changeTemperature −10', () => {
  const s = S.createState();
  assert.deepEqual(S.parseCommand('온도 열 도 내려줘', s).actions, [{ type: 'changeTemperature', delta: -10 }]);
  assert.deepEqual(S.parseCommand('온도 스물다섯 도로 맞춰줘', s).actions, [{ type: 'setTemperature', value: 25 }]);
  assert.deepEqual(S.parseCommand('온도를 이십 도 올려', s).actions, [{ type: 'changeTemperature', delta: 20 }]);
  assert.deepEqual(S.parseCommand('압력 백 헥토파스칼 올려줘', s).actions, [{ type: 'changePressure', delta: 100 }]);
  // "열어"의 '열'은 수사가 아니다
  assert.deepEqual(S.parseCommand('뚜껑 열어', s).actions, [{ type: 'openCap' }]);
});

test('10. 해석 불가 "안녕" → unknown + 예시 안내', () => {
  const r = S.parseCommand('안녕', S.createState());
  assert.deepEqual(r.actions, [{ type: 'unknown' }]);
  const shown = S.EXAMPLES.filter((e) => r.reply.includes(e));
  assert.ok(shown.length >= 3, r.reply);
});

test('11. validateCommand: 스키마 위반 거부, 정상 명령 통과', () => {
  const bad = [
    null, 42, 'text', [],
    {},
    { actions: 'openCap', reply: 'x' },
    { actions: [], reply: 'x' },
    { actions: [{ type: 'openCap' }] },
    { actions: [{ type: 'fly' }], reply: 'x' },
    { actions: [{ type: 'setTemperature' }], reply: 'x' },
    { actions: [{ type: 'setTemperature', value: '20' }], reply: 'x' },
    { actions: [{ type: 'changePressure', delta: NaN }], reply: 'x' },
    { actions: [{ type: 'setSpeed', multiplier: Infinity }], reply: 'x' },
    { actions: [null], reply: 'x' }
  ];
  for (const b of bad) assert.equal(S.validateCommand(b).ok, false, JSON.stringify(b));
  const good = { actions: [{ type: 'closeCap' }, { type: 'setPressure', value: 5000, extra: 1 }, { type: 'shake' }], reply: '설명' };
  const v = S.validateCommand(good);
  assert.equal(v.ok, true, v.errors.join());
  assert.deepEqual(v.command.actions, [{ type: 'closeCap' }, { type: 'setPressure', value: 5000 }, { type: 'shake' }]);
  // 내장 해석기의 결과는 항상 스키마를 통과한다
  for (const t of ['온도 10도 올려줘', '안녕', '왜 기포가 생겨?', '뚜껑 닫고 압력 5000hPa로 해줘']) {
    assert.equal(S.validateCommand(S.parseCommand(t, S.createState())).ok, true, t);
  }
});

test('추가: 복합 명령·단위 변환·기타 명령', () => {
  const s = S.createState();
  const P = (t) => S.parseCommand(t, s).actions;
  assert.deepEqual(P('주변 기압 10hPa 올려줘'), [{ type: 'changeAmbientPressure', delta: 10 }]);
  assert.deepEqual(P('뚜껑 열어줘'), [{ type: 'openCap' }]);
  assert.deepEqual(P('병 흔들어줘'), [{ type: 'shake', seconds: 3 }]);
  assert.deepEqual(P('지금 상태 기록해줘'), [{ type: 'record' }]);
  assert.deepEqual(P('2기압으로 맞춰'), [{ type: 'setPressure', value: 2026.5 }]);
  assert.deepEqual(P('300K로 해줘'), [{ type: 'setTemperature', value: 26.85 }]);
  assert.deepEqual(P('50℉로 맞춰'), [{ type: 'setTemperature', value: 10 }]);
  assert.deepEqual(P('압력 100 kPa 올려'), [{ type: 'changePressure', delta: 1000 }]);
  assert.deepEqual(P('온도 조금 올려'), [{ type: 'changeTemperature', delta: 5 }]);
  assert.deepEqual(P('압력 많이 낮춰'), [{ type: 'changePressure', delta: -500 }]);
  assert.deepEqual(P('압력 2배로'), [{ type: 'setPressure', value: 7000 }]);
  assert.deepEqual(P('열고 흔들고 마셔'), [{ type: 'openCap' }, { type: 'shake', seconds: 3 }, { type: 'drink' }]);
  assert.deepEqual(P('온도 30도로 올리고, 그리고 기록해줘'), [{ type: 'setTemperature', value: 30 }, { type: 'record' }]);
  assert.deepEqual(P('속도 20배'), [{ type: 'setSpeed', multiplier: 20 }]);
  assert.deepEqual(P('멈춰'), [{ type: 'pause' }]);
  assert.deepEqual(P('다시 시작'), [{ type: 'resume' }]);
  assert.deepEqual(P('처음으로'), [{ type: 'reset' }]);
  assert.equal(P('수온이 오르면 물고기에게 어떤 일이?')[0].type, 'explain');
  // 뚜껑이 열려 있으면 setPressure는 주변 기압을 바꾼다
  const o = S.createState();
  S.applyAction(o, { type: 'openCap' });
  S.applyAction(o, { type: 'setPressure', value: 1500 });
  assert.equal(o.target.P_amb, 1500);
  // 흔들기는 k_out을 6배로
  const k = S.createState();
  const k0 = S.kOut(k);
  S.applyAction(k, { type: 'shake', seconds: 3 });
  assert.ok(Math.abs(S.kOut(k) - 6 * k0) < 1e-12);
  run(k, 3.1);
  assert.equal(S.isShaking(k), false);
  // 기록과 CSV
  S.applyAction(k, { type: 'record' });
  const csv = S.recordsToCSV(k.records);
  assert.match(csv, /^번호,시간\(s\),온도/);
  assert.equal(csv.trim().split('\r\n').length, 2);
  // 초기화
  S.applyAction(k, { type: 'openCap' });
  S.applyAction(k, { type: 'reset' });
  assert.equal(k.capOpen, false);
  assert.equal(k.T, 5);
  assert.equal(k.records.length, 1, '기록은 초기화해도 남는다');
  // 식 표시
  const f = S.formulas(S.createState());
  assert.match(f.ceq, /^C_eq = 0\.06\d\d × 3\.45 atm × 44\.01 = 9\.22 g\/L$/);
  // 표시 분자 수
  assert.deepEqual(S.displayCounts(S.createState()), { dissolved: 115, headspace: 35 });
  // 프롬프트에 필요한 내용
  const prompt = S.buildLLMPrompt(S.createState());
  for (const word of ['"capOpen":false', 'kPa', 'mmHg', '조금', '많이', '코드 펜스', 'actions']) assert.ok(prompt.includes(word), word);
});

test('일시정지 중에는 화학 변화가 멈춘다', () => {
  const s = S.createState();
  S.applyAction(s, { type: 'openCap' });
  S.applyAction(s, { type: 'pause' });
  const c0 = s.C, t0 = s.time;
  run(s, 5);
  assert.equal(s.C, c0);
  assert.equal(s.time, t0);
  S.applyAction(s, { type: 'resume' });
  S.applyAction(s, { type: 'setSpeed', multiplier: 5 });
  run(s, 1);
  assert.ok(Math.abs(s.time - t0 - 5) < 1e-6);
  assert.ok(s.C < c0);
});

test('12. 빌드 결과물 검사 (docs/index.html)', () => {
  const file = path.join(ROOT, 'docs/index.html');
  assert.ok(fs.existsSync(file), 'docs/index.html이 없어요. 먼저 npm run build를 실행하세요.');
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(/<!--\s*INLINE:[A-Z]+\s*-->/.test(html), false, '자리표시 주석이 남아 있어요');
  assert.ok(/\.THREE\s*=\s*\{\}|THREE=\{\}/.test(html) || html.includes('THREE'), 'THREE 정의 없음');
  assert.ok(html.includes('Three.js Authors'), 'three.js 라이선스 주석 보존');
  assert.equal(/<script[^>]*\bsrc\s*=/i.test(html), false, '외부 script src가 있어요');
  assert.equal(/cdnjs|unpkg|jsdelivr/i.test(html), false, 'CDN 주소가 있어요');
  assert.equal(/<link[^>]+href\s*=\s*["']https?:/i.test(html), false, '외부 스타일시트가 있어요');
  assert.equal(/localStorage\s*[.\[]|sessionStorage\s*[.\[]/.test(html.replace(/<script id="three-lib"[\s\S]*?<\/script>/, '')), false, 'localStorage 사용 금지');

  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(blocks.length >= 3, `script 블록 수 ${blocks.length}`);
  let checked = 0;
  for (const [, attrs, body] of blocks) {
    if (/id="three-lib"/.test(attrs)) continue;
    assert.doesNotThrow(() => new Function(body), `script${attrs} 문법 오류`);
    checked++;
  }
  assert.ok(checked >= 2, 'core.js와 app.js 블록이 있어야 해요');
  assert.ok(html.includes('root.SodaCore'), 'core.js 인라인');
});
