// 移行用の中継サーバー(このPCの中だけ: 127.0.0.1)。
// Supabase の SQL エディタ(ブラウザ)が、個人情報を含む import.sql をここから読み込む(外部にアップロードしない)。
// 照合結果(患者番号と数字だけ)は POST /actual で out/actual.json に保存する。
//   node scripts/migrate/serve.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/import.sql': join(here, 'out', 'import.sql'),
  '/reset.sql': join(here, 'reset.sql'),
  '/verify.sql': join(here, 'verify.sql'),
};
const ORIGIN = 'https://supabase.com';

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');   // 公開サイト → localhost の許可(Chrome)
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin && req.headers.origin !== ORIGIN) { res.writeHead(403); res.end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && FILES[req.url] && existsSync(FILES[req.url])) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readFileSync(FILES[req.url]));
    console.log(new Date().toISOString(), 'GET', req.url);
    return;
  }
  if (req.method === 'POST' && req.url === '/actual') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try {
        JSON.parse(body);
        writeFileSync(join(here, 'out', 'actual.json'), body);
        res.writeHead(200); res.end('ok');
        console.log(new Date().toISOString(), 'POST /actual', body.length, 'bytes');
      } catch { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(8787, '127.0.0.1', () => console.log('serving on http://127.0.0.1:8787'));
