// 모든 CSS·JS 를 하나의 HTML 로 묶는다 (정적 호스팅·오프라인 USB 배포·공유 링크용).
// 사용: node scripts/build-single.mjs [출력경로] [--hosted]
//  --hosted : 실시간 카메라(getUserMedia)를 쓸 수 없는 호스팅 환경용 → 기기 카메라 앱 촬영으로 대체,
//             결과 저장 설정 숨김. 문서 골격(<html>/<head>)과 CSP meta 를 제외한 본문만 출력.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const hosted = args.includes('--hosted');
const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', 'smile-simulator.html'));

// 의존 순서
const MODULES = [
  'js/core/color.js', 'js/core/geometry.js', 'js/core/imageops.js', 'js/core/shades.js',
  'js/core/segmentation.js', 'js/core/effects.js', 'js/core/ortho.js', 'js/core/template.js',
  'js/core/pipeline.js', 'js/ai/provider.js', 'js/ui/camera.js', 'js/ui/privacy.js', 'js/ui/demo.js',
  'js/ui/app.js',
];

const seen = new Map();
let js = '';
for (const rel of MODULES) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src = src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  src = src.replace(/^export\s+(?=(async\s+)?(function|class|const|let)\b)/gm, '');
  // 최상위 선언 이름 충돌 검사
  for (const m of src.matchAll(/^(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) throw new Error(`이름 충돌: ${m[1]} (${seen.get(m[1])}, ${rel})`);
    seen.set(m[1], rel);
  }
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`처리되지 않은 import/export: ${rel}`);
  js += `\n// ── ${rel} ──\n${src}`;
}
js = js.replace(/<\/script/gi, '<\\/script');

const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script type="module" src="js\/ui\/app.js"><\/script>/, '');

let page;
if (hosted) {
  const bodyHosted = body
    .replace(/<div class="field"><label><input type="checkbox" id="set-download" \/>[\s\S]*?<\/div>/, '<input type="checkbox" id="set-download" hidden />')
    .replace(/<div class="field"><label><input type="checkbox" id="set-mirror" \/>[\s\S]*?<\/div>/, '<input type="checkbox" id="set-mirror" hidden />');
  page = `<title>스마일 시뮬레이터</title>
<meta name="referrer" content="no-referrer" />
<style>${css}</style>
${bodyHosted}
<script>window.SMILESIM_NO_LIVE_CAMERA = true;</script>
<script type="module">${js}</script>
`;
} else {
  const head = html.slice(0, html.indexOf('</head>'))
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: mediastream:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />`)
    .replace(/<link rel="stylesheet" href="css\/styles.css" \/>/, `<style>${css}</style>`);
  page = `${head}</head>\n<body>${body}<script type="module">${js}</script>\n</body>\n</html>\n`;
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`built ${path.relative(process.cwd(), out)} (${(page.length / 1024).toFixed(0)} KB${hosted ? ', hosted' : ''})`);
