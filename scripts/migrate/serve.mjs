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
  '/notion-notes.json': join(here, 'out', 'notion-notes.json'),
};
const ORIGIN = 'https://supabase.com';
// スタッフ画面(開発サーバー)からも読めるようにする(Notion のメモはログイン中のスタッフとして取り込む)
const APP_ORIGINS = ['http://192.168.3.6:5173', 'http://localhost:5173'];

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGINS.includes(req.headers.origin) ? req.headers.origin : ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');   // 公開サイト → localhost の許可(Chrome)
  res.setHeader('Cache-Control', 'no-store');
  // 他のサイトからの読み込みは拒否(同じ 127.0.0.1 のページ・Supabase のページ・直接アクセスのみ)
  if (req.headers.origin && ![ORIGIN, 'http://127.0.0.1:8787', ...APP_ORIGINS].includes(req.headers.origin)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && FILES[req.url] && existsSync(FILES[req.url])) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readFileSync(FILES[req.url]));
    console.log(new Date().toISOString(), 'GET', req.url);
    return;
  }
  // Supabase のページは通信先が制限されている(CSP)ため、ここで開いたページから
  // window.opener.postMessage で SQL を渡す(データはブラウザの中だけを通る)
  if (req.method === 'GET' && req.url.startsWith('/push.html')) {
    const name = new URL(req.url, 'http://x').searchParams.get('f');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    void name;
    res.end(`<!doctype html><meta charset="utf-8"><title>LBC 移行</title>
      <body style="font:14px sans-serif;padding:12px">LBC 移行の中継中…(このウィンドウは閉じないでください)<pre id="log"></pre><script>
      const O = ${JSON.stringify(ORIGIN)};
      const log = (s) => { document.getElementById('log').textContent += s + '\\n'; };
      window.addEventListener('message', async (e) => {
        if (e.origin !== O) return;
        if (e.data?.lbcGet) {
          const t = await fetch('/' + e.data.lbcGet).then((r) => r.text());
          window.opener.postMessage({ lbcSql: t, name: e.data.lbcGet }, O);
          log('送信: ' + e.data.lbcGet + ' (' + t.length + ' 文字)');
        }
        if (e.data?.lbcActual) {
          await fetch('/actual', { method: 'POST', body: e.data.lbcActual });
          log('照合結果を保存しました。このウィンドウは閉じてかまいません');
        }
      });
      window.opener.postMessage({ lbcReady: true }, O);
      log('準備完了');
    </script>`);
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
