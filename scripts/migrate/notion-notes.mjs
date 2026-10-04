// notion.json から「問診の自動まとめ以外の書き込み」を取り出し、カルテメモとして取り込む形にする。
//   node scripts/migrate/notion-notes.mjs  → out/notion-notes.json(個人情報を含む。コミットしない)
// 取り込みはブラウザ(ログイン中のスタッフ画面)で行う。報告は件数と患者番号だけ
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'out', 'notion.json'), 'utf8'));

// GAS の問診テンプレートは「問診票 …」で始まり「署名」の次の 1 行で終わる。その外側を書き込みとみなす
export function extraLines(text) {
  const out = [];
  let inT = false, a = -1;
  for (const l of text.split('\n')) {
    if (/^問診票　/.test(l.trim())) { inT = true; a = -1; continue; }
    if (inT) {
      if (l.trim() === '署名') { a = 1; continue; }
      if (a === 1) { a = 0; inT = false; continue; }
      continue;
    }
    out.push(l);
  }
  return out.join('\n').replace(/^(―――\n?)+|(\n?―――)+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

const notes = [];
for (const k of data.karte) {
  const body = extraLines(k.text);
  if (!body.replace(/―――/g, '').trim()) continue;
  notes.push({ ref: `notion:${k.page}`, code: k.code, date: k.date, body: `【Notion から移行 ${k.date}】\n${body}` });
}
for (const c of data.customers) {
  if (!c.text.trim()) continue;
  notes.push({ ref: `notion:${c.page}`, code: c.code, date: null, body: `【Notion から移行】\n${c.text}` });
}
writeFileSync(join(here, 'out', 'notion-notes.json'), JSON.stringify(notes));
console.log(`取り込むメモ: ${notes.length} 件(患者番号: ${[...new Set(notes.map((n) => n.code))].join(', ')})`);
