// notion.json を調べて「GAS が自動で書いた問診のまとめ」以外の内容(ルカスが手で書いたもの)があるか数える。
// 件数と患者番号だけを出す(中身は出さない)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'out', 'notion.json'), 'utf8'));

// GAS の問診テンプレート(gas/Code.js の karte 本文作成)は「問診票 …」の callout で始まり、
// 「署名」の次の 1 行(画像の URL か「未記入」)で終わる。その外側にある行を「手書き」とみなす
function extra(text) {
  const lines = text.split('\n');
  const out = [];
  let inTemplate = false;
  let afterSign = -1;
  for (const l of lines) {
    if (/^問診票　/.test(l.trim())) { inTemplate = true; afterSign = -1; continue; }
    if (inTemplate) {
      if (l.trim() === '署名') { afterSign = 1; continue; }
      if (afterSign === 1) { afterSign = 0; inTemplate = false; continue; }
      continue;
    }
    if (l.trim()) out.push(l);
  }
  return out;
}

let pagesWithExtra = 0, extraChars = 0, noTemplate = 0, templates = 0;
const codes = [];
for (const k of data.karte) {
  const n = (k.text.match(/^問診票　/gm) ?? []).length;
  templates += n;
  if (n === 0) noTemplate++;
  const ex = extra(k.text);
  if (ex.length) {
    pagesWithExtra++;
    extraChars += ex.join('').length;
    codes.push(`${k.code}(${k.date}, ${ex.length}行)`);
  }
}
const memo = data.karte.filter((k) => k.memo && k.memo.trim()).length;
const statuses = {};
for (const k of data.karte) statuses[k.status ?? '(なし)'] = (statuses[k.status ?? '(なし)'] ?? 0) + 1;
console.log(`施術カルテ ${data.karte.length} ページ: 問診のまとめ ${templates} 個 / まとめが無いページ ${noTemplate}`);
console.log(`まとめ以外の手書きがあるページ: ${pagesWithExtra}(合計 ${extraChars} 文字)`, codes.join(', '));
console.log(`施術メモ(プロパティ)あり: ${memo} ページ`);
console.log('ステータス:', JSON.stringify(statuses));
