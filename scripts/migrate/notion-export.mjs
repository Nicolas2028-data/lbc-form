// Notion のカルテ(施術カルテ DB・顧客管理 DB のページ本文と画像)を書き出す。
//   node scripts/migrate/notion-export.mjs
// トークンは scripts/migrate/.env.local の NOTION_TOKEN=... (コミットしない)か環境変数から読む。
// 出力: scripts/migrate/out/notion.json と out/notion-images/(個人情報を含む。コミットしない)
// 画面に出すのは件数と、テンプレートの見出し(3 ページ以上で同じもの)だけ。氏名やメモの中身は出さない
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, 'out');
const IMG = join(OUT, 'notion-images');
const KARTE_DB = '1fe16e73641344d5ba61a56cd235b7b5';      // 施術カルテ
const CUSTOMER_DB = 'bafca36866c74bb7812965c2e966cd51';   // 顧客管理DB

function token() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN.trim();
  const f = join(here, '.env.local');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^\s*NOTION_TOKEN\s*=\s*(\S+)/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  console.error('NOTION_TOKEN がありません。scripts/migrate/.env.local に NOTION_TOKEN=... を書いてください');
  process.exit(1);
}
const TOKEN = token();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 6) throw new Error(`Notion API ${res.status} ${path}`);
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const j = await res.json();
    if (!res.ok) throw new Error(`Notion API ${res.status} ${j.code ?? ''} ${path}`);
    await sleep(340);   // 3 回/秒まで
    return j;
  }
}

async function queryAll(db) {
  const rows = [];
  let cursor;
  do {
    const r = await api(`/databases/${db}/query`, { page_size: 100, start_cursor: cursor });
    rows.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return rows;
}

async function children(id) {
  const out = [];
  let cursor;
  do {
    const r = await api(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

const plain = (rt) => (rt ?? []).map((x) => x.plain_text).join('');
const prop = (p) => {
  if (!p) return null;
  switch (p.type) {
    case 'title': return plain(p.title);
    case 'rich_text': return plain(p.rich_text);
    case 'select': return p.select?.name ?? null;
    case 'date': return p.date?.start?.slice(0, 10) ?? null;
    case 'number': return p.number;
    case 'checkbox': return p.checkbox;
    default: return null;
  }
};

const typeCount = {};
const headingCount = {};
let imageCount = 0;
let imageFailed = 0;

// ブロック → テキスト行 + 画像
async function walk(blocks, depth, acc) {
  for (const b of blocks) {
    typeCount[b.type] = (typeCount[b.type] ?? 0) + 1;
    const d = b[b.type] ?? {};
    const pad = '  '.repeat(depth);
    const text = plain(d.rich_text);
    switch (b.type) {
      case 'heading_1': case 'heading_2': case 'heading_3':
        acc.lines.push(`${pad}■ ${text}`);
        headingCount[text] = (headingCount[text] ?? 0) + 1;
        break;
      case 'bulleted_list_item': acc.lines.push(`${pad}・${text}`); break;
      case 'numbered_list_item': acc.lines.push(`${pad}- ${text}`); break;
      case 'to_do': acc.lines.push(`${pad}${d.checked ? '☑' : '☐'} ${text}`); break;
      case 'quote': case 'callout': acc.lines.push(`${pad}${text}`); break;
      case 'paragraph': case 'toggle': acc.lines.push(text ? `${pad}${text}` : ''); break;
      case 'divider': acc.lines.push('―――'); break;
      case 'image': case 'file': case 'pdf': {
        const url = d.type === 'external' ? d.external?.url : d.file?.url;
        if (url) acc.images.push({ block: b.id, url, caption: plain(d.caption), kind: b.type, name: d.name ?? null });
        break;
      }
      case 'embed': case 'bookmark': case 'link_preview':
        if (d.url) acc.lines.push(`${pad}${d.url}`);
        break;
      default: break;
    }
    if (b.has_children && !['child_page', 'child_database'].includes(b.type)) {
      await walk(await children(b.id), depth + 1, acc);
    }
  }
}

async function exportPage(page) {
  const acc = { lines: [], images: [] };
  await walk(await children(page.id), 0, acc);
  const text = acc.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, images: acc.images };
}

async function download(img) {
  const ext = (() => {
    const m = new URL(img.url).pathname.match(/\.(jpe?g|png|webp|gif|heic|pdf)$/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'bin';
  })();
  const file = join(IMG, `${img.block}.${ext}`);
  if (existsSync(file)) return `${img.block}.${ext}`;
  try {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(String(res.status));
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    imageCount++;
    return `${img.block}.${ext}`;
  } catch {
    imageFailed++;
    return null;
  }
}

mkdirSync(IMG, { recursive: true });
const result = { exported_at: new Date().toISOString(), karte: [], customers: [] };

const kartes = await queryAll(KARTE_DB);
for (const p of kartes) {
  const pr = p.properties;
  const body = await exportPage(p);
  for (const img of body.images) img.file = await download(img);
  result.karte.push({
    page: p.id,
    code: prop(pr['診察番号']),
    date: prop(pr['日付']) ?? p.created_time.slice(0, 10),
    status: prop(pr['ステータス']),
    change: prop(pr['前回から変化']),
    memo: prop(pr['施術メモ']),
    text: body.text,
    images: body.images.filter((i) => i.file).map(({ block, file, caption, kind }) => ({ block, file, caption, kind })),
  });
}

const customers = await queryAll(CUSTOMER_DB);
for (const p of customers) {
  const body = await exportPage(p);
  for (const img of body.images) img.file = await download(img);
  result.customers.push({
    page: p.id,
    code: prop(p.properties['診察番号']),
    text: body.text,
    images: body.images.filter((i) => i.file).map(({ block, file, caption, kind }) => ({ block, file, caption, kind })),
  });
}

writeFileSync(join(OUT, 'notion.json'), JSON.stringify(result, null, 1));

// ── 報告(件数のみ)──
const withText = (xs) => xs.filter((x) => x.text).length;
const withImg = (xs) => xs.filter((x) => x.images.length).length;
console.log(`施術カルテ: ${kartes.length} ページ(本文あり ${withText(result.karte)}・画像あり ${withImg(result.karte)}・診察番号なし ${result.karte.filter((k) => !k.code).length})`);
console.log(`顧客管理DB: ${customers.length} ページ(本文あり ${withText(result.customers)}・画像あり ${withImg(result.customers)})`);
console.log(`画像: ${imageCount} 件ダウンロード(失敗 ${imageFailed})`);
console.log('ブロックの種類:', JSON.stringify(typeCount));
const templ = Object.entries(headingCount).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
console.log('見出し(3 ページ以上で同じもの):', JSON.stringify(Object.fromEntries(templ)));
