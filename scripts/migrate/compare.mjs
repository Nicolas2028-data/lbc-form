// 照合: node scripts/migrate/compare.mjs [expected.json] [actual.json]
// expected = シートから直接計算した数字(build.mjs)、actual = 新基盤で verify.sql を実行した結果
// 違いは患者番号と数字だけで表示する
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'out');
const [ef, af] = [process.argv[2] ?? join(out, 'expected.json'), process.argv[3] ?? join(out, 'actual.json')];
const e = JSON.parse(readFileSync(ef, 'utf8'));
const a = JSON.parse(readFileSync(af, 'utf8'));
let bad = 0;
const check = (label, x, y) => {
  const ok = Number(x ?? 0) === Number(y ?? 0);
  if (!ok) bad++;
  return ok;
};
const line = (label, x, y) => console.log(`${check(label, x, y) ? '✔' : '✖'} ${label}: シート=${x ?? 0} 新=${y ?? 0}`);

line('顧客数', e.customers.total, a.customers.total);
line('顧客数(有効)', e.customers.active, a.customers.active);
line('来院数(取消を除く)', e.visits.attended, a.visits.attended);
line('施術なし', e.visits.no_show, a.visits.no_show);
line('取消済み', e.visits.voided, a.visits.voided);
line('売上合計', e.salesTotal, a.salesTotal);
line('回数券', e.passes, a.passes);
line('問診', e.questionnaires, a.questionnaires);

const keyed = (label, ex, ac) => {
  const keys = [...new Set([...Object.keys(ex), ...Object.keys(ac)])].sort();
  const diffs = keys.filter((k) => !check(`${label} ${k}`, ex[k], ac[k]));
  console.log(`${diffs.length ? '✖' : '✔'} ${label}: ${keys.length} 件中 ${keys.length - diffs.length} 件一致`);
  for (const k of diffs.slice(0, 30)) console.log(`    ${k}: シート=${ex[k] ?? 0} 新=${ac[k] ?? 0}`);
};
keyed('月別売上', e.salesByMonth, a.salesByMonth);
keyed('患者ごとの来院回数', e.visitsByCustomer, a.visitsByCustomer);
keyed('患者ごとのクレジット残高(台帳の合計)', e.creditByCustomer, a.creditByCustomer);

// 参考: 新基盤で「今使える残高」(期限切れを除く)が台帳の合計と違う患者
const avail = Object.entries(a.creditAvailableByCustomer ?? {}).filter(([k, v]) => Number(v) !== Number(a.creditByCustomer?.[k] ?? 0));
console.log(`\n参考: 今使える残高が台帳の合計と違う患者 ${avail.length} 人(期限切れの未失効分・取消された紹介付与など。失効処理で揃う)`);
for (const [k, v] of avail.slice(0, 30)) console.log(`    ${k}: 台帳の合計=${a.creditByCustomer[k]} 今使える=${v}`);

console.log(bad ? `\n✖ 不一致 ${bad} 件` : '\n✔ すべて一致');
process.exit(bad ? 1 : 0);
