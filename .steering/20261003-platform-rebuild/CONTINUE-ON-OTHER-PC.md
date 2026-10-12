# 別PCでの続行ガイド(新基盤 Supabase 版)

**作成: 2026-10-12 / このファイルだけ読めば続きを再開できる**

> 古いガイド `.steering/20260927-notion-native-record/CONTINUE-ON-OTHER-PC.md` は Notion 中心案のもの。
> 2026-10-03 に方針転換(GAS 不安定 → Supabase 中心に作り直し)、2026-10-04 に Notion からも脱却したので **使わない**。

---

## STEP 0: 別PCの Claude Code にそのまま貼るプロンプト

```
LBC Care プロジェクトの続きをやります。私は Nicolas Ventura
(v.nico2003@gmail.com / GitHub: Nicolas2028-data)。返答は必ず日本語で。

まず状況把握:
1. リポジトリ ~/Development/lbc-care(無ければ
   git clone https://github.com/Nicolas2028-data/lbc-form.git lbc-care)
2. git fetch → git switch platform-rebuild → git status -sb で最新か確認
3. .steering/20261003-platform-rebuild/CONTINUE-ON-OTHER-PC.md(このファイル)、
   tasklist.md、design.md、docs/database.md、docs/accounts.md、reports/ の最新日を読む
4. このファイルの「別PCの準備」をやる(npm ci、app/.env.local)

方針: GAS+シート+Notion をやめて Supabase(東京)を正本にした新システムへ移行中。
作業はテスト環境 lbc-staging と platform-rebuild ブランチだけ。本番 GAS・main には触らない。
次にやることは「次のタスク候補」から私が選ぶ。
```

---

## 別PCの準備(初回だけ)

1. **ツール**: Git、Node.js 20 以上(このPCは v24)。Supabase CLI・Docker は不要(DB テストは PGlite で動く)。
2. **取得**
   ```
   git clone https://github.com/Nicolas2028-data/lbc-form.git lbc-care
   cd lbc-care
   git switch platform-rebuild
   npm ci              # ルート: DB テスト・移行スクリプト用
   cd app && npm ci    # 画面
   ```
3. **`app/.env.local` を作る**(gitignore。`app/.env.example` をコピー)
   - `VITE_SUPABASE_URL=https://lnatpitfcqxmgxxmmqzr.supabase.co`
   - `VITE_SUPABASE_ANON_KEY=` … Supabase ダッシュボード → lbc-staging → Project Settings → API Keys の **publishable key**(公開してよい鍵)。`service_role` / secret key は絶対に書かない
   - `VITE_STORE_ID=00000000-0000-4000-8000-000000000001`
4. **`scripts/migrate/.env.local`**(Notion トークン)は本番切替時の Notion 取り込み(タスク 2-9)でだけ使う。必要になったら Nicolas が入れる。Claude はトークンを表示・コミットしない。
5. **起動**: `cd app && npx vite --host` → `http://localhost:5173/staff/login`(iPad は同じ Wi-Fi で `http://<PCのIP>:5173/staff/login`)。問診は `/q`。
   - ログインは Supabase の Auth ユーザー(Nicolas がダッシュボードの「Create new user」で作成。パスワードは本人が入力し、Claude は扱わない)。
6. **テスト**
   - `npm run test:db`(82 件)/ `cd app && npx vitest run`(13 件)/ `npm run test:fuzz`(重い。`FUZZ_SCENARIOS` で件数調整)/ `npm run test:migrate`
   - 2026-10-12 時点: test:db 82/82、app 13/13 通過を確認済み。

---

## 現在の状態(2026-10-12 時点)

- ブランチ `platform-rebuild`(GitHub に push 済み)。
- **現行本番(旧システム)**: GAS **@144**(デプロイ ID `AKfycbxCBqtgb...QfX06PQ`、URL 不変)+ GitHub Pages(main `a4b6cb9`)。2026-10-12 に本番 @144 のコードを取得して main の `gas/Code.js` と照合 → 先頭の BOM 以外は一致。
  - 2026-10-11 に別PCで main に 9 コミット(questionnaire / treatment-record / dashboard の UI 刷新、問診の顔出し設問の表示修正、GAS の端末トークン関連)。
  - ⚠️ **セキュリティ(決定済み・現状維持)**: 1457bf7 で `STAFF_TOKEN_ACTIONS` を空にし、施術記録系 API(getPatientList / getPatientDetails / submitTreatmentRecord / submitVoidRecord)は**再びトークン無しで呼べる**状態(CLAUDE.md ルール 4 に合わせた戻し)。b4e2af9 でダッシュボードのトークン認証も撤廃。**2026-10-12 Nicolas 決定: とりあえず現状のまま残す(変更しない)。経緯は履歴として残す。** 新基盤への切替で解消する。
  - `platform-rebuild` には main の 10-11 の変更は入っていない(新基盤は app/ と supabase/ が別物なので通常は取り込み不要。切替前に main をマージするかは要判断)。
- **公開リンク(テスト環境)**: **https://lbc-care.pages.dev**(スタッフ `/staff/login`、問診 `/q`)。Cloudflare Pages(アカウント v.nico2003@gmail.com、ID `ddf479e13f9ead9ee161be5097f2d634`、プロジェクト `lbc-care`)。`platform-rebuild` に push すると自動でビルド・公開。設定: Root `app` / `npm run build` / 出力 `dist` / Node 22(`app/.node-version`)/ 環境変数 VITE_SUPABASE_URL・VITE_SUPABASE_ANON_KEY(publishable)・VITE_STORE_ID。GitHub App「Cloudflare Workers and Pages」は Nicolas2028-data の `lbc-form` だけ許可。ログイン画面は誰でも見られるが、データは Supabase の RLS とログインで保護。リンクはルカス以外に配らない。
  - 同じ Cloudflare アカウントに別件の `bella-beauty-workers` / `bella-market-workers` がある(LBC とは無関係。触らない)。
- **Supabase**: 組織「LBC Care」(Free)/ プロジェクト `lbc-staging`(ref `lnatpitfcqxmgxxmmqzr`、東京)。
- **migration 0001〜0016 を staging に適用済み**(`supabase/migrations/`)。
- **データ**: 本番台帳を staging に移行済み、照合すべて一致(顧客36・来院5・施術なし1・取消5・売上¥36,000・回数券4・問診36)。**実在の患者情報が入っている**。
- **画面(app/、Vite + React + TS、ja/es/pt)**
  | パス | 内容 |
  |---|---|
  | `/staff` | ホーム(売上の 3D グラフ・メニュー) |
  | `/staff/today` | 今日の一覧(受付) |
  | `/staff/patients` | 患者検索(DB 関数 search_customers。全件読み込みはしない) |
  | `/staff/record/:customerId` | 施術記録 |
  | `/staff/customers/:customerId` | 顧客詳細(履歴・カルテメモ・写真・クレジット・問診) |
  | `/staff/customers/:customerId/print` | カルテ印刷(A4) |
  | `/staff/charts` | カルテ一覧 |
  | `/staff/dashboard` | ダッシュボード |
  | `/q` | 問診票(お客さん用) |
  - 予約(`/book` など)は 2026-10-03 Nicolas の判断で**非表示**(コードと migration 0008 は残す。再開手順は docs/database.md 6.4)。
- **テーマ**: ネオン(`app/src/theme-neon.css`)。Nicolas「派手はいいけど、わかりやすさを大事に」→ 業務画面は白文字・控えめな光。
- 詳しい履歴: `reports/2026-10-04.md`、`tasklist.md`、DB は `docs/database.md`。

---

## 次のタスク候補(どれからやるかは Nicolas が決める)

1. **2-7 ルカスにテスト環境で試してもらう**(https://lbc-care.pages.dev で可能になった)
2. **1-10 PWA**(iPad のホーム画面アイコン・全画面)
3. **1-11 安全対策**: 要配慮個人情報の同意文、プライバシーポリシー、スタッフの二段階認証、カルテ閲覧記録、本番は Supabase Pro + PITR
4. **1-9 日次バックアップ** 🙋 R2(Cloudflare アカウントは作成済み)
6. 連携(Google カレンダー / LINE / Webhook)、Resend、Stripe など(tasklist 4〜8)

### 判断待ち・残作業
- 仕様の判断待ち 2 件(tasklist 末尾): 紹介割引が料金より大きいとき / 紹介者のクレジットがマイナスになるとき
- staging の**テスト患者 P042「テスト 確認用」を削除**する
- staging の**営業時間は仮**(月〜土 10-19)→ 実際の時間を Nicolas に確認

### アカウント・鍵
**どのサービスにどのアカウントで入るか、鍵がどこにあるかは [docs/accounts.md](../../docs/accounts.md)**。リポジトリは公開なので、鍵の値・個人情報はリポジトリに書かない。

### このリポジトリに入っていないもの(別PCで用意する)
| もの | 場所 | 用意の仕方 |
|---|---|---|
| `app/.env.local` | gitignore | 上の「別PCの準備」3 |
| `scripts/migrate/.env.local`(NOTION_TOKEN) | gitignore | 2-9 のときだけ Nicolas が入れる |
| `.clasp.json` / `~/.clasprc.json` | リポジトリ外 | 現行 GAS を触るときだけ。`clasp login`、Script ID は `1DWGR2YgD6nZejBB6ak8fDHwvwvEtsBBokb7TacvsjZK-DHtsJRyMhixc` |
| Supabase のスタッフアカウント | Supabase Auth | ダッシュボードで Nicolas が作成 |
| Supabase の DB パスワード | 誰も保持していない | 必要ならダッシュボードでリセット |

---

## 作業のルール・注意(これまでの教訓)

### 方針
- 本番 GAS・main・現行シートには触らない。現行 GAS への場当たり的なリトライ追加なども提案しない。
- DB 変更は必ず新しい migration ファイル + テスト(`supabase/tests/`)。モデルに頼らない不変条件のテストも併用(ファズのモデルが DB と同じアルゴリズムだとバグを見逃した前例あり)。大きな変更は独立レビュー(サブエージェント)を通す。
- 多言語は ja/es/pt を同時に更新。
- 作業の終わりに tasklist.md と `reports/YYYY-MM-DD.md` を更新して push。

### staging への migration 適用(Supabase CLI は使っていない)
- DB パスワードは誰も保持していない → SQL エディタで流す。手順は docs/database.md 6.2。
- SQL エディタへの流し込み: `monaco.editor.getModels()[0].setValue(...)`(raw.githubusercontent の内容)→ Run → `supabase_migrations.schema_migrations` に手動で記録。
- DROP を含むと「destructive operations」確認ダイアログ → dialog 内の「Run query」を押す。
- 遷移直後の 1 回目の Run が効かないことがある → 結果欄で確認。
- 新テーブルは自動公開 OFF・自動 RLS ON の設定 → migration で明示的に grant が必要。
- 適用後は `scripts/db`(スキーマの指紋)でリポジトリとのずれを照合。

### 個人情報
- staging には実在の患者データがある。画面や DB を読むとき、**患者一覧を丸ごと文脈に入れない**。テスト患者の行だけに絞る。
- 個人情報を含む SQL(データ移行)は Claude の文脈を通さない: `scripts/migrate/serve.mjs`(127.0.0.1:8787)の push.html をユーザーがクリックして開き、postMessage で SQL エディタへ渡す方式。
- 台帳 xlsx・`scripts/migrate/out/` は使い終わったら削除。

### ブラウザ操作(Claude in Chrome)
- Chrome のウィンドウが裏(visibilityState=hidden)だと座標クリック・スクショが効かない → JS で `button.click()`、結果は `window.fetch` を差し替えて応答を拾う。
- LAN の http では `crypto.randomUUID` が無い → `lib/rpc` の `newRequestId` を使う。

### その他
- Supabase の既定 SMTP は組織メンバー宛にしか送れない(サインアップ OFF、スタッフはダッシュボードで作成)。
- 漏えいパスワード防止は Pro 限定。
- PGlite は長時間使うと stack depth エラー → ファズは 50 シナリオごとに DB を作り直している。
- Supabase API は 1 回 1,000 件上限 → 一覧・集計は DB 関数で(migration 0012)。
- Windows: Bash の heredoc に多言語文字列を入れると失敗することがある → ファイルに書いて node で実行。`node --test` はディレクトリ指定でなくファイルを明示。
- 作業前に `git fetch` → `git status -sb` で別PCの作業が無いか確認。
