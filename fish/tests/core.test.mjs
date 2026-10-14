import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'fish/src/core.js'), 'utf8'), { filename: 'fish/src/core.js' });
const F = globalThis.FishCore;

/** minutes분을 작은 간격으로 나눠 진행한다(브라우저 프레임과 비슷하게). */
function run(state, minutes, frame = 0.5) {
  let t = 0;
  while (t < minutes - 1e-9) {
    const h = Math.min(frame, minutes - t);
    F.step(state, h);
    t += h;
  }
  return state;
}
function applyAll(state, actions) {
  return actions.map((a) => F.applyAction(state, a));
}
const inRange = (v, lo, hi, msg) => assert.ok(v >= lo && v <= hi, `${msg}: ${v} 가 ${lo}~${hi} 범위 밖`);

test('1. 포화 DO(1013.25 hPa) 범위', () => {
  const ranges = [[0, 14.4, 14.8], [10, 11.1, 11.5], [20, 8.9, 9.3], [30, 7.4, 7.8], [40, 6.2, 6.6]];
  for (const [T, lo, hi] of ranges) inRange(F.doSaturation(T, 1013.25), lo, hi, `${T}℃`);
  // 온도가 오를수록 단조 감소
  for (let T = 0; T < 40; T++) assert.ok(F.doSaturation(T + 1, 1013.25) < F.doSaturation(T, 1013.25));
  // 수증기압(20℃ ≈ 23.4 hPa)
  inRange(F.vaporPressure(20), 23.2, 23.6, 'P_wv(20℃)');
});

test('2. 해발 2000 m: 기압 790~800 hPa, 20℃ 포화 DO 6.9~7.3 mg/L', () => {
  const P = F.altitudeToPressure(2000);
  inRange(P, 790, 800, 'altitudeToPressure(2000)');
  inRange(F.doSaturation(20, P), 6.9, 7.3, '20℃·2000 m 포화 DO');
  // 역산
  assert.ok(Math.abs(F.pressureToAltitude(P) - 2000) < 1e-6);
  assert.ok(Math.abs(F.altitudeToPressure(0) - 1013.25) < 1e-9);
});

test('3. 초기 상태: 송어 쾌적, 120분 뒤에도 생존률 ≥ 99 %', () => {
  const s = F.createState();
  assert.equal(s.T, 20);
  assert.equal(s.P, 1013.25);
  assert.equal(s.pump, false);
  assert.equal(s.species, 'trout');
  assert.equal(s.fishBase, 20);
  const ss = F.doSaturation(20, 1013.25) - 20 * F.respirationRate(20) / F.KA_OFF;
  assert.ok(Math.abs(s.DO - ss) < 1e-9, '초기 DO = 정상상태 값');
  assert.equal(F.speciesStatus(s).label, '쾌적');
  run(s, 120);
  assert.ok(s.S * 100 >= 99, `생존률 ${s.S * 100}`);
  assert.ok(Math.abs(s.DO - ss) < 1e-6, '정상상태 유지');
  assert.equal(F.aliveCount(s), 20);
});

test('4. "수온 10도 올려줘" → +10 → 30℃, 포화 DO 감소, 송어 생존률 120분 안에 < 20 %', () => {
  const s = F.createState();
  const r = F.parseCommand('수온 10도 올려줘', s);
  assert.deepEqual(r.actions, [{ type: 'changeTemperature', delta: 10 }]);
  assert.ok(r.reply.length > 0);
  const c0 = F.doSaturation(s.T, s.P);
  const res = F.applyAction(s, r.actions[0]);
  assert.equal(res.warning, null);
  assert.match(res.message, /\+10℃ \(20℃ → 30℃\)/);
  run(s, 2);
  assert.ok(Math.abs(s.T - 30) < 1e-9, `수온 ${s.T}`);
  assert.ok(F.doSaturation(s.T, s.P) < c0, '포화 DO 감소');
  run(s, 118);
  assert.ok(s.S * 100 < 20, `생존률 ${(s.S * 100).toFixed(1)} %`);
});

test('5. 같은 30℃에서 잉어로 바꾸면 120분 뒤 생존률 ≥ 90 %', () => {
  const s = F.createState();
  const r = F.parseCommand('잉어로 바꿔줘', s);
  assert.deepEqual(r.actions, [{ type: 'setSpecies', species: 'carp' }]);
  applyAll(s, r.actions);
  F.applyAction(s, { type: 'changeTemperature', delta: 10 });
  run(s, 120);
  assert.equal(s.T, 30);
  assert.ok(s.S * 100 >= 90, `생존률 ${(s.S * 100).toFixed(1)} %`);
});

test('6. 잉어·33℃·50마리: 에어펌프 켬이 끔보다 DO와 생존률 모두 높다', () => {
  const make = (pump) => {
    const s = F.createState();
    applyAll(s, [{ type: 'setSpecies', species: 'carp' }, { type: 'setTemperature', value: 33 }, { type: 'setFishCount', value: 50 }, { type: pump ? 'pumpOn' : 'pumpOff' }]);
    return run(s, 120);
  };
  const off = make(false), on = make(true);
  assert.ok(on.DO > off.DO, `DO 켬 ${on.DO} vs 끔 ${off.DO}`);
  assert.ok(on.S > off.S, `생존률 켬 ${on.S} vs 끔 ${off.S}`);
});

test('7. 같은 수온에서 물고기가 많을수록 정상상태 DO가 낮다', () => {
  let prev = Infinity;
  for (const n of [0, 10, 20, 40, 60]) {
    const ss = F.steadyStateDO(20, 1013.25, n, false);
    assert.ok(ss < prev || (ss === 0 && prev === 0), `${n}마리: ${ss}`);
    prev = ss;
    // 실제 시뮬레이션으로도 확인
    const s = F.createState();
    F.applyAction(s, { type: 'setFishCount', value: n });
    F.applyAction(s, { type: 'pumpOn' });
    run(s, 60);
    assert.ok(Math.abs(s.DO - F.steadyStateDO(20, 1013.25, n * s.S, true)) < 0.05, `${n}마리 수렴`);
  }
});

test('8. "주변 기압 10hPa 내려줘" → 1003.25 hPa, 포화 DO 약 1 % 감소', () => {
  const s = F.createState();
  const c0 = F.doSaturation(s.T, s.P);
  const r = F.parseCommand('주변 기압 10hPa 내려줘', s);
  assert.deepEqual(r.actions, [{ type: 'changePressure', delta: -10 }]);
  applyAll(s, r.actions);
  run(s, 2);
  assert.ok(Math.abs(s.P - 1003.25) < 1e-9, `P = ${s.P}`);
  const drop = (c0 - F.doSaturation(s.T, s.P)) / c0 * 100;
  inRange(drop, 0.8, 1.2, '감소율(%)');
});

test('9. "해발 2000m 호수로 옮겨줘" → setAltitude 2000', () => {
  const s = F.createState();
  const r = F.parseCommand('해발 2000m 호수로 옮겨줘', s);
  assert.deepEqual(r.actions, [{ type: 'setAltitude', value: 2000 }]);
  applyAll(s, r.actions);
  run(s, 2);
  inRange(s.P, 790, 800, '기압');
  assert.ok(Math.abs(F.pressureToAltitude(s.P) - 2000) < 1, '고도 역산');
});

test('10. "에어펌프 켜고 물고기 열 마리 빼줘" → [pumpOn, changeFishCount −10]', () => {
  const s = F.createState();
  const r = F.parseCommand('에어펌프 켜고 물고기 열 마리 빼줘', s);
  assert.deepEqual(r.actions, [{ type: 'pumpOn' }, { type: 'changeFishCount', delta: -10 }]);
  applyAll(s, r.actions);
  assert.equal(s.pump, true);
  assert.equal(s.fishBase, 10);
});

test('11. "수온 100도로 해줘" → 40℃로 제한 + warning', () => {
  const s = F.createState();
  const r = F.parseCommand('수온 100도로 해줘', s);
  assert.deepEqual(r.actions, [{ type: 'setTemperature', value: 100 }]);
  const res = F.applyAction(s, r.actions[0]);
  assert.equal(s.target.T, 40);
  assert.ok(res.warning && res.warning.length > 0);
  run(s, 2);
  assert.equal(s.T, 40);
  // 다른 범위도 잘린다
  assert.ok(F.applyAction(s, { type: 'setPressure', value: 300 }).warning);
  assert.equal(s.target.P, 500);
  assert.ok(F.applyAction(s, { type: 'setAltitude', value: 9000 }).warning);
  inRange(s.target.P, 539, 541, '5000 m 기압');
  assert.ok(F.applyAction(s, { type: 'setFishCount', value: 99 }).warning);
  assert.equal(s.fishBase, 60);
});

test('12. "안녕" → unknown + 예시 안내', () => {
  const r = F.parseCommand('안녕', F.createState());
  assert.deepEqual(r.actions, [{ type: 'unknown' }]);
  const shown = F.EXAMPLES.filter((e) => r.reply.includes(e));
  assert.ok(shown.length >= 3, r.reply);
});

test('13. validateCommand: 스키마 위반 거부, 정상 명령 통과', () => {
  const bad = [
    null, 42, 'text', [],
    {},
    { actions: 'pumpOn', reply: 'x' },
    { actions: [], reply: 'x' },
    { actions: [{ type: 'pumpOn' }] },
    { actions: [{ type: 'fly' }], reply: 'x' },
    { actions: [{ type: 'toString' }], reply: 'x' },
    { actions: [{ type: 'setTemperature' }], reply: 'x' },
    { actions: [{ type: 'setTemperature', value: '20' }], reply: 'x' },
    { actions: [{ type: 'changePressure', delta: NaN }], reply: 'x' },
    { actions: [{ type: 'setSpeed', multiplier: Infinity }], reply: 'x' },
    { actions: [{ type: 'setSpecies', species: 'salmon' }], reply: 'x' },
    { actions: [{ type: 'scenario', name: 'tsunami' }], reply: 'x' },
    { actions: [{ type: 'scenario' }], reply: 'x' },
    { actions: [null], reply: 'x' }
  ];
  for (const b of bad) assert.equal(F.validateCommand(b).ok, false, JSON.stringify(b));
  const good = { actions: [{ type: 'pumpOn' }, { type: 'setAltitude', value: 2000, extra: 1 }, { type: 'scenario', name: 'heatwave' }, { type: 'setSpecies', species: 'carp' }], reply: '설명' };
  const v = F.validateCommand(good);
  assert.equal(v.ok, true, v.errors.join());
  assert.deepEqual(v.command.actions, [{ type: 'pumpOn' }, { type: 'setAltitude', value: 2000 }, { type: 'scenario', name: 'heatwave' }, { type: 'setSpecies', species: 'carp' }]);
  // 내장 해석기의 결과는 항상 스키마를 통과한다
  for (const t of ['수온 10도 올려줘', '안녕', '왜 물고기가 죽어?', '에어펌프 켜고 물고기 열 마리 빼줘', '폭염 시작해줘', '잉어로 바꿔줘']) {
    assert.equal(F.validateCommand(F.parseCommand(t, F.createState())).ok, true, t);
  }
});

test('추가: 예시 칩·복합 명령·시나리오·기록', () => {
  const s = F.createState();
  const P = (t) => F.parseCommand(t, s).actions;
  assert.deepEqual(P('수온 5도 올려줘'), [{ type: 'changeTemperature', delta: 5 }]);
  assert.deepEqual(P('에어펌프 켜줘'), [{ type: 'pumpOn' }]);
  assert.deepEqual(P('물고기 30마리 더 넣어줘'), [{ type: 'changeFishCount', delta: 30 }]);
  assert.deepEqual(P('폭염 시작해줘'), [{ type: 'scenario', name: 'heatwave' }]);
  assert.deepEqual(P('지금 상태 기록해줘'), [{ type: 'record' }]);
  assert.deepEqual(P('고산 호수로 옮겨줘'), [{ type: 'scenario', name: 'highland' }]);
  assert.deepEqual(P('과밀 양식 해줘'), [{ type: 'scenario', name: 'overcrowded' }]);
  assert.deepEqual(P('에어펌프 비상 가동'), [{ type: 'scenario', name: 'emergencyPump' }]);
  assert.deepEqual(P('수온 조금 올려'), [{ type: 'changeTemperature', delta: 2 }]);
  assert.deepEqual(P('물 온도 많이 식혀줘'), [{ type: 'changeTemperature', delta: -10 }]);
  assert.deepEqual(P('기압 조금 낮춰'), [{ type: 'changePressure', delta: -10 }]);
  assert.deepEqual(P('기압 많이 올려'), [{ type: 'changePressure', delta: 100 }]);
  assert.deepEqual(P('수온 스물다섯 도로 맞춰줘'), [{ type: 'setTemperature', value: 25 }]);
  assert.deepEqual(P('해발 2천 미터로'), [{ type: 'setAltitude', value: 2000 }]);
  assert.deepEqual(P('폭기 꺼줘'), [{ type: 'pumpOff' }]);
  assert.deepEqual(P('무지개송어로 바꿔줘'), [{ type: 'setSpecies', species: 'trout' }]);
  assert.deepEqual(P('수온 30도, 기압 900hPa로 해줘'), [{ type: 'setTemperature', value: 30 }, { type: 'setPressure', value: 900 }]);
  assert.deepEqual(P('에어펌프 끄고 수온 3도 올리고 기록해줘'), [{ type: 'pumpOff' }, { type: 'changeTemperature', delta: 3 }, { type: 'record' }]);
  assert.deepEqual(P('속도 60배'), [{ type: 'setSpeed', multiplier: 60 }]);
  assert.deepEqual(P('멈춰'), [{ type: 'pause' }]);
  assert.deepEqual(P('다시 시작'), [{ type: 'resume' }]);
  assert.deepEqual(P('처음으로'), [{ type: 'reset' }]);
  assert.equal(P('탄산수는 왜 차갑게 보관할까?')[0].type, 'explain');
  assert.equal(P('잠수부가 빨리 올라오면 혈액 속 N₂는?')[0].type, 'explain');

  // 폭염: 1℃/분씩 32℃까지
  const h = F.createState();
  F.applyAction(h, { type: 'scenario', name: 'heatwave' });
  run(h, 5, 0.1);
  assert.ok(Math.abs(h.T - 25) < 1e-6, `5분 뒤 수온 ${h.T}`);
  run(h, 20, 0.1);
  assert.equal(h.T, 32);
  assert.equal(h.heatwave, null);
  // 고산 호수·과밀 양식·비상 가동
  const g = F.createState();
  F.applyAction(g, { type: 'scenario', name: 'highland' });
  inRange(g.target.P, 790, 800, '고산 호수 기압');
  F.applyAction(g, { type: 'scenario', name: 'overcrowded' });
  assert.equal(g.fishBase, 50);
  F.applyAction(g, { type: 'scenario', name: 'emergencyPump' });
  assert.equal(g.pump, true);

  // 물고기를 넣거나 빼면 기준 마릿수를 다시 잡는다
  const d = F.createState();
  F.applyAction(d, { type: 'setTemperature', value: 30 });
  run(d, 60);
  const alive = F.aliveCount(d);
  assert.ok(alive < 20);
  F.applyAction(d, { type: 'changeFishCount', delta: 5 });
  assert.equal(d.fishBase, alive + 5);
  assert.equal(d.S, 1);

  // 상태 배지: 등급 순서
  const b = F.createState();
  b.DO = 6; assert.equal(F.speciesStatus(b).label, '주의');
  b.DO = 4; assert.equal(F.speciesStatus(b).label, '위험');
  b.DO = 2; assert.equal(F.speciesStatus(b).label, '치사');
  b.DO = 9; b.T = 26; assert.equal(F.speciesStatus(b).label, '치사');
  assert.equal(F.speciesStatus(b).behaviorLabel, '수면 호흡');

  // 기록과 CSV
  const k = F.createState();
  F.applyAction(k, { type: 'record' });
  const csv = F.recordsToCSV(k.records);
  assert.match(csv, /^시뮬레이션 시간\(분\),수온\(℃\),기압\(hPa\),고도\(m\),에어펌프,어종,생존\/전체,포화 DO\(mg\/L\),실제 DO\(mg\/L\),생존률\(%\),상태\r\n/);
  assert.match(csv, /0\.0,20\.0,1013\.3,0,끔,무지개송어,20\/20마리,9\.09,7\.49,100\.0,쾌적/);
  F.applyAction(k, { type: 'reset' });
  assert.equal(k.records.length, 1, '기록은 초기화해도 남는다');

  // 헨리 법칙 해석 문장
  assert.match(F.formulas(F.createState()).henry, /0\.2095 × \(P − P_wv\) = .* = 0\.20\d atm → 포화량 9\.09 mg\/L$/);
  // 표시 분자 수
  assert.deepEqual(F.displayCounts(F.createState()), { dissolved: 60, airO2: 24, airN2: 96 });
  assert.equal(F.displayCounts({ DO: 30, P: 1013.25 }).dissolved, 120);
  // 프롬프트에 필요한 내용
  const prompt = F.buildLLMPrompt(F.createState());
  for (const word of ['무지개송어', '잉어', '치사 수온', '0~40℃', '500~1100 hPa', '0~5000 m', '0~60마리', 'setAltitude', 'scenario', '코드 펜스', 'actions']) assert.ok(prompt.includes(word), word);
  // 기체 비교(1 atm 순수 기체)
  assert.ok(F.molarSolubility('CO2', 20) > F.molarSolubility('O2', 20));
  assert.ok(F.molarSolubility('O2', 20) > F.molarSolubility('N2', 20));
});

test('일시정지 중에는 DO와 생존률이 변하지 않는다', () => {
  const s = F.createState();
  F.applyAction(s, { type: 'setTemperature', value: 30 });
  F.applyAction(s, { type: 'pause' });
  const do0 = s.DO, t0 = s.time;
  for (let i = 0; i < 50; i++) F.tick(s, 0.1);
  assert.equal(s.DO, do0);
  assert.equal(s.time, t0);
  assert.equal(s.T, 30, '부드러운 변화는 실제 시간으로 계속 진행');
  F.applyAction(s, { type: 'resume' });
  F.applyAction(s, { type: 'setSpeed', multiplier: 10 });
  F.tick(s, 1);
  assert.ok(Math.abs(s.time - t0 - 10) < 1e-6);
  assert.ok(s.DO < do0);
});

test('14. 빌드 결과물 검사 (docs/fish/index.html)', () => {
  const file = path.join(ROOT, 'docs/fish/index.html');
  assert.ok(fs.existsSync(file), 'docs/fish/index.html이 없어요. 먼저 npm run build:fish를 실행하세요.');
  const html = fs.readFileSync(file, 'utf8');
  assert.equal(/<!--\s*INLINE:[A-Z]+\s*-->/.test(html), false, '자리표시 주석이 남아 있어요');
  assert.ok(/<script id="three-lib">[\s\S]*THREE[\s\S]*<\/script>/.test(html), 'THREE 정의 없음');
  assert.ok(html.includes('Three.js Authors'), 'three.js 라이선스 주석 보존');
  assert.equal(/<script[^>]*\bsrc\s*=/i.test(html), false, '외부 script src가 있어요');
  assert.equal(/cdnjs|unpkg|jsdelivr|fonts\.googleapis/i.test(html), false, 'CDN 주소가 있어요');
  assert.equal(/<link[^>]+href\s*=\s*["']https?:/i.test(html), false, '외부 스타일시트가 있어요');
  assert.equal(/<img[^>]+src\s*=\s*["']https?:/i.test(html), false, '외부 이미지가 있어요');
  assert.equal(/localStorage\s*[.\[]|sessionStorage\s*[.\[]/.test(html.replace(/<script id="three-lib"[\s\S]*?<\/script>/, '')), false, 'localStorage 사용 금지');
  assert.ok(html.includes('href="../index.html"'), '탄산수 시뮬레이터로 가는 링크');

  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(blocks.length >= 3, `script 블록 수 ${blocks.length}`);
  let checked = 0;
  for (const [, attrs, body] of blocks) {
    if (/id="three-lib"/.test(attrs)) continue;
    assert.doesNotThrow(() => new Function(body), `script${attrs} 문법 오류`);
    checked++;
  }
  assert.ok(checked >= 2, 'core.js와 app.js 블록이 있어야 해요');
  assert.ok(html.includes('root.FishCore'), 'core.js 인라인');
  assert.ok(html.includes('globalThis.FishCore'), 'app.js 인라인');
});

test('15. 탄산수 앱과 독립: 기존 빌드 결과물에는 물고기 코드가 없다', () => {
  const soda = path.join(ROOT, 'docs/index.html');
  if (!fs.existsSync(soda)) return;
  const html = fs.readFileSync(soda, 'utf8');
  assert.equal(html.includes('FishCore'), false);
  assert.ok(html.includes('root.SodaCore'));
});
