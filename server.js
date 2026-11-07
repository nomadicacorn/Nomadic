// 의존성 없는 정적 파일 서버 (원내 PC/태블릿용).
//  - 기본: http://localhost:8080  (같은 PC 의 브라우저는 localhost 에서 카메라 사용 가능)
//  - 태블릿 등 다른 기기에서 접속해 카메라를 쓰려면 HTTPS 필요:
//      SSL_KEY=./certs/key.pem SSL_CERT=./certs/cert.pem npm start
//  - 환자 사진은 서버로 전송되지 않는다(업로드 API 자체가 없음). 서버는 정적 파일만 제공한다.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW = ['index.html', 'css', 'js', 'favicon.ico'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob: mediastream:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS).end();
    return;
  }
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const top = rel.split('/')[0];
  if (!file.startsWith(ROOT + path.sep) || !ALLOW.includes(top)) {
    res.writeHead(404, SECURITY_HEADERS).end('Not found');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const { SSL_KEY, SSL_CERT } = process.env;
const server = SSL_KEY && SSL_CERT
  ? https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const proto = SSL_KEY && SSL_CERT ? 'https' : 'http';
  console.log(`스마일 시뮬레이터: ${proto}://localhost:${PORT}`);
  if (proto === 'http') console.log('※ 다른 기기(태블릿)에서 카메라를 쓰려면 HTTPS 로 실행하세요 (README 참고).');
});
