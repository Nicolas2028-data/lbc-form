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

## 現在の状態(2026-10-12 夜時点)

- ブランチ `platform-rebuild`(GitHub push 済み、最新コミット `a6e8a72`)。
- **現行本番(旧システム)**: GAS **@144** + GitHub Pages(main)。新基盤への切替が完了するまで触らない。⚠️ リポジトリが public のため患者 API がトークン無しで呼べる状態 → 再判断待ち(docs/accounts.md 0 章)。
- **公開リンク(テスト環境)**: **https://lbc-care.pages.dev**(スタッフ `/staff/login`、問診 `/q`、プライバシーポリシー `/privacy`)。`platform-rebuild` に push すると自動デプロイ。
- **Supabase**: 組織「LBC Care」(Free)/ プロジェクト `lbc-staging`(ref `lnatpitfcqxmgxxmmqzr`、東京)。
- **migration 0001〜0018 を staging に適用すること**
  - 0017(manual_discount): 🙋 Nicolas が SQL エディタで適用済み ✅
  - 0018(chart_view_log): 🙋 未適用 → SQL エディタで `supabase/migrations/20261012000018_chart_view_log.sql` を実行
- **データ**: 本番台帳を staging に移行済み(顧客36・売上¥36,000 等)。実在患者情報あり。
- **2026-10-12 に追加・完了した機能**
  - ホーム画面: 背骨 3D アニメーション(頸椎7+胸椎12+腰椎5+仙骨 S カーブ、Y 軸回転)+ 白×緑テーマ
  - PWA: manifest.webmanifest・sw.js・アイコン 192/512px
  - セキュリティヘッダー: app/public/_headers (CSP・X-Frame-Options・Referrer-Policy)
  - プライバシーポリシー: Privacy.tsx (/privacy、ja/es/pt、要配慮個人情報)
  - 問診同意文: 要配慮個人情報の明記 + /privacy リンク(3言語)
  - 施術記録: クレジット 1000円刻み・スポンサー割引(FC笹川 -2000円)・紹介割引手動入力(migration 0017)
  - カルテ閲覧記録: get_patient_card を audit_log に記録(migration 0018、1-11 対応)
- **画面(app/、Vite + React + TS、ja/es/pt)**
  | パス | 内容 |
  |---|---|
  | `/staff` | ホーム(背骨 3D アニメーション・メニュー・今月の数字) |
  | `/staff/today` | 今日の一覧(受付) |
  | `/staff/patients` | 患者検索 |
  | `/staff/record/:customerId` | 施術記録(スポンサー割引・手動割引含む) |
  | `/staff/customers/:customerId` | 顧客詳細 |
  | `/staff/charts` | カルテ一覧 |
  | `/staff/dashboard` | ダッシュボード |
  | `/q` | 問診票(お客さん用) |
  | `/privacy` | プライバシーポリシー |
  - 予約(`/book` など)は 2026-10-03 Nicolas の判断で非表示(コードは残す)。
- 詳しい履歴: `reports/2026-10-04.md`、`tasklist.md`、DB は `docs/database.md`。

---

## 次のタスク候補(どれからやるかは Nicolas が決める)

1. **🙋 migration 0018 を staging に適用** (SQL エディタ → `supabase/migrations/20261012000018_chart_view_log.sql` を実行 → `supabase_migrations.schema_migrations` に記録)
2. **2-7 ルカスにテスト環境で試してもらう**(https://lbc-care.pages.dev でログイン可能)
3. **本番切替(3-5)**: 本番 Supabase プロジェクト作成 → migration 適用 → Cloudflare 環境変数切替 → Notion 取り込み → GAS 停止(docs/production-cutover.md)
4. **1-9 日次バックアップ** 🙋 R2(Cloudflare アカウントは作成済み)
5. 連携(Google カレンダー / LINE / Webhook)、Resend、Stripe など(tasklist 4〜8)

### 判断待ち・残作業
- 仕様の判断待ち 2 件(tasklist 末尾): 紹介割引が料金より大きいとき / 紹介者のクレジットがマイナスになるとき
- 🔴 **最優先で再判断**: 現行本番の患者 API がトークン無しで誰でも呼べる件(リポジトリが公開のため実害が起きうる。docs/accounts.md 0 章)
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
