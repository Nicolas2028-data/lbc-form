// ローカルのスキーマ指紋を出力する: node scripts/db/fingerprint.mjs > local.json
import { readFileSync } from 'node:fs';
import { createDb } from '../../supabase/tests/harness.mjs';
const db = await createDb();
const sql = readFileSync(new URL('./fingerprint.sql', import.meta.url), 'utf8');
console.log(JSON.stringify((await db.query(sql)).rows[0].fp, null, 1));
