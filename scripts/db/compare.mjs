// 2 つの指紋 JSON を比べて違いを表示: node scripts/db/compare.mjs local.json remote.json
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
let diffs = 0;
for (const sec of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const x = a[sec]; const y = b[sec];
  if (typeof x === 'string' || typeof y === 'string' || x == null || y == null) {
    if (x !== y) { console.log(`✖ ${sec}: 異なる`); diffs++; }
    continue;
  }
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (x[k] === y[k]) continue;
    diffs++;
    console.log(`✖ ${sec} ${k}: ${x[k] === undefined ? 'リポジトリに無い' : y[k] === undefined ? 'DB に無い' : '内容が異なる'}`);
  }
}
console.log(diffs ? `\n${diffs} 件の差分` : '✔ 一致(リポジトリのマイグレーションと DB の中身は同じ)');
process.exit(diffs ? 1 : 0);
