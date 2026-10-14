// fish/src/ 의 템플릿에 CSS·three.min.js·core.js·app.js를 인라인해 docs/fish/index.html 한 파일로 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const threePath = 'node_modules/three/build/three.min.js';
if (!fs.existsSync(path.join(ROOT, threePath))) {
  console.error(`✖ ${threePath} 가 없습니다. 먼저 "npm install"을 실행하세요.`);
  process.exit(1);
}

// </script> 가 코드 안에 있으면 HTML 파서가 블록을 일찍 닫으므로 이스케이프한다.
const safeScript = (code) => code.replace(/<\/(script)/gi, '<\\/$1');
const safeStyle = (code) => code.replace(/<\/(style)/gi, '<\\/$1');

const three = read(threePath);
if (!/@license/.test(three)) {
  console.error('✖ three.min.js 라이선스 주석을 찾지 못했습니다.');
  process.exit(1);
}

const pieces = {
  CSS: `<style>\n${safeStyle(read('fish/src/style.css'))}\n</style>`,
  THREE: `<script id="three-lib">\n${safeScript(three)}\n</script>`,
  CORE: `<script id="fish-core">\n${safeScript(read('fish/src/core.js'))}\n</script>`,
  APP: `<script id="fish-app">\n${safeScript(read('fish/src/app.js'))}\n</script>`
};

let html = read('fish/src/index.html');
for (const [key, value] of Object.entries(pieces)) {
  const marker = `<!-- INLINE:${key} -->`;
  if (!html.includes(marker)) {
    console.error(`✖ 템플릿에 ${marker} 자리표시가 없습니다.`);
    process.exit(1);
  }
  // split/join 치환: 코드 속 "$&" 같은 패턴이 해석되지 않도록 한다.
  html = html.split(marker).join(value);
}

if (/<!--\s*INLINE:/.test(html)) {
  console.error('✖ 처리되지 않은 자리표시가 남아 있습니다.');
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'docs/fish'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/fish/index.html'), html);
console.log(`✔ docs/fish/index.html 생성 (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
