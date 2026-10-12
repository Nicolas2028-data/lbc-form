# 本番切替ガイド（Notion 脱却・新システム移行）

**最終更新: 2026-10-12**

新システム（Supabase + React / lbc-care.pages.dev）への完全移行手順。
実行者: Nicolas。Claude は手順の準備と確認まで。実際の実行は Nicolas が行う。

---

## 前提条件（切替前に全て完了していること）

- [ ] ルカスが lbc-care.pages.dev でテスト済み（タスク 2-7）
- [ ] migration 0001〜最新が staging で通過済み
- [ ] `npm run test:db` / `cd app && npx vitest run` が全パス

---

## Phase 1: 本番 Supabase プロジェクト作成（🙋 Nicolas）

### 1-1. プロジェクト作成
1. Supabase ダッシュボード → 組織「LBC Care」→「New project」
2. 設定:
   - Name: `lbc-prod`
   - Region: Northeast Asia (Tokyo)
   - Password: 安全なパスワード（誰にも見せない・どこにも保存しない）
3. プロジェクト ref（例: `abcdefghijklmnop`）をメモしておく

### 1-2. migration 適用
全 migration を **staging と同じ手順**（SQL エディタ）で本番に適用。
docs/database.md 6.2 の手順を参照。

```
supabase/migrations/ 以下のファイルを番号順に全て実行
→ supabase_migrations.schema_migrations に手動で記録
→ scripts/db で指紋照合
```

### 1-3. メニュー・営業時間の初期データ投入
staging の初期データ（storeId, menus, staff_schedules）を確認して本番にも挿入。
SQL エディタで直接 INSERT（個人情報は含まないのでこのファイルにサンプルを書いてよい）:

```sql
-- store
INSERT INTO stores (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'LBC整体院');

-- menus（staging の値を確認して合わせる）
-- staff_schedules（実際の営業時間: 月〜土 10:00-19:00 など Nicolas に確認）
```

### 1-4. スタッフアカウント作成（🙋 Nicolas）
Supabase ダッシュボード → Authentication → Users → 「Add user」:
- Lucas: `lucas@lbc-care.jp`（仮。実際のメールを確認）
- Nicolas: `v.nico2003@gmail.com`

---

## Phase 2: データ移行（🙋 Nicolas、Claude に個人情報を見せない）

### 2-1. Notion トークン設定
```bash
echo "NOTION_TOKEN=secret_..." > scripts/migrate/.env.local
# 値は Notion → Settings → Integrations → LBC Care integration のトークン
```

### 2-2. Notion データエクスポート
```bash
node scripts/migrate/notion-export.mjs
# → scripts/migrate/out/notion.json（カルテ・顧客DBのテキスト）
# → scripts/migrate/out/notion-images/（添付画像）
# 出力: 件数のみ（氏名・本文は出力しない）
```

### 2-3. Notion カルテメモ抽出
```bash
node scripts/migrate/notion-notes.mjs
# → scripts/migrate/out/notion-notes.json
# 出力: 件数と患者番号のみ
```

### 2-4. シート台帳 → 本番 Supabase 移行
```bash
# build.mjs で import.sql を生成（台帳 xlsx が必要）
node scripts/migrate/build.mjs
node scripts/migrate/serve.mjs  # 127.0.0.1:8787 で起動
```
ブラウザで Supabase SQL エディタを開き、`http://127.0.0.1:8787/push.html` も開く。
→ push.html 経由で import.sql が SQL エディタに流れる（データはブラウザの中だけ）。
→ 実行後 verify.sql で件数照合。

### 2-5. Notion カルテメモ取り込み（ブラウザ経由）
`serve.mjs` が起動中の状態で、ログイン済みの lbc-care.pages.dev（本番）を開く。
スタッフ画面の「Notion メモ取り込み」機能（実装済み）を使って notion-notes.json を取り込む。

---

## Phase 3: Cloudflare Pages を本番に切替（🙋 Nicolas）

### 3-1. 環境変数を本番 Supabase に更新
Cloudflare Pages → lbc-care プロジェクト → Settings → Environment Variables:
- `VITE_SUPABASE_URL` → `https://<本番 ref>.supabase.co`
- `VITE_SUPABASE_ANON_KEY` → 本番プロジェクトの publishable key
- `VITE_STORE_ID` → `00000000-0000-4000-8000-000000000001`（同じ）

変数を更新すると自動で再デプロイが走る。

### 3-2. ルカスにリンクを案内
```
https://lbc-care.pages.dev/staff/login
```
ルカスが自分のメール/パスワードでログインできることを確認。

---

## Phase 4: 旧システム廃止

### 4-1. GAS の syncToNotion トリガーを停止（🙋 Nicolas）
GAS エディタ → 時計アイコン（トリガー） → `syncToNotion` を削除。
他のトリガー（sendDailySummary, backupLedgerToLucas）も不要なら同様に削除。

### 4-2. 1 週間の様子見
- 問題なし → Phase 5 へ
- 問題あり → 旧システムは GAS @144 のまま生きているので、ルカスを一時的に戻せる

### 4-3. GAS ウェブアプリを削除（🙋 Nicolas）
GAS エディタ → デプロイ → デプロイを管理 → `@144` を削除。
※ GAS スクリプト自体は削除しなくてよい（記録として残す）。

### 4-4. Notion の停止
- 施術カルテ DB と顧客管理 DB: アーカイブ or 読み取り専用に変更
- GAS の `NOTION_*` スクリプトプロパティは削除しなくてよい（GAS 自体を使わなくなるため）

### 4-5. GitHub Pages の旧ページ無効化（オプション）
`main` ブランチの questionnaire.html / treatment-record.html / dashboard.html は残してよい（GAS が死んでいれば機能しない）。
気になるなら `main` の index.html 等に「このシステムは新しいシステムに移行しました」のメッセージを追加。

---

## チェックリスト（切替当日）

```
[ ] 本番 Supabase にすべての migration が入っている
[ ] 本番に台帳データが入っている（件数照合済み）
[ ] 本番に Notion カルテメモが取り込まれている
[ ] ルカスが本番でログインできる
[ ] 施術記録 → 記録できる
[ ] 顧客検索 → 患者が出る
[ ] ダッシュボード → 売上が出る
[ ] 問診票 /q → 送信できる
[ ] GAS の syncToNotion トリガーを停止した
[ ] ルカスに新 URL を案内した
```

---

## 切替後に確認すること（1 週間）

- エラーが出ていないか（Supabase ダッシュボード → Logs）
- ルカスから操作上の問題報告がないか
- staging のテスト患者 P042「テスト 確認用」を削除

---

## 緊急ロールバック手順

新システムで重大な問題が発生した場合:
1. ルカスに旧 URL（GitHub Pages）を案内
   - 施術記録: `https://nicolas2028-data.github.io/lbc-form/treatment-record.html`
   - 問診票: `https://nicolas2028-data.github.io/lbc-form/questionnaire.html`
2. GAS @144 は生きているのでそのまま使える
3. GAS の syncToNotion トリガーを再設定（必要なら）
4. 問題を特定・修正してから再切替
