# 設計: LBC Care 基盤の作り直し

**作成: 2026-10-03 / ステータス: Nicolas 承認済み (2026-10-03) / 要件: [requirements.md](requirements.md)**

---

## 1. 全体構成

```
 [iPad (ルカス) / 顧客のスマホ]
        │  HTTPS(Supabase クライアント SDK)
        ▼
 [Cloudflare Pages]  ← 画面(静的ファイルのみ。サーバー処理なし)
        │
        ▼
 [Supabase (東京リージョン)] ← 正本
   ├─ PostgreSQL : 全データ。業務ロジックは DB 関数(RPC)で 1 トランザクション実行
   ├─ Auth       : スタッフ・顧客のログイン
   ├─ RLS        : 行単位の権限(誰がどの行を読める/書けるか)を DB が強制
   ├─ Storage    : 問診の画像(非公開バケット)
   ├─ Edge Functions : 外部連携(Stripe・LINE・メール)の受け口と送信
   └─ pg_cron    : 定期処理(リマインド、クレジット失効、日次サマリ)

 [外部] Stripe(決済) / LINE Messaging API / Resend(メール)
 [バックアップ] GitHub Actions → 暗号化 → Cloudflare R2
```

### 1.1 設計原則(現行 SPEC.md の原則を引き継ぎ、DB で強制する)

1. **DB が正。** シート・Notion は出力先。逆方向の同期はしない
2. **お金・予約は追記の台帳。** 残高・回数券の残りは記録から導出。訂正は取消記録+訂正記録
3. **業務ロジックは DB 関数に置く。** 画面は「お願い」するだけで、金額計算・残高チェック・上限チェックはサーバー(DB)で行う。画面から送られた金額は信用しない
4. **書き込みは冪等。** すべての書き込みはクライアント生成の `request_id` を持ち、DB の一意制約で二重記録を防ぐ。だから通信失敗時に安心して自動再送できる
5. **権限は RLS で強制。** 画面の出し分けは補助
6. **最初から複数店舗・複数スタッフ前提。** 全業務テーブルに `store_id` を持つ

### 1.2 技術選定

| 役割 | 採用 | 理由 / 却下した候補 |
|---|---|---|
| DB・認証・ストレージ | **Supabase Free**(2 プロジェクト = テスト用+本番用) | Postgres の制約・トランザクション・RLS で正しさを DB が保証。東京リージョン。料金ページに Free の商用利用禁止の記載なし(契約前に規約を再確認) |
| 画面の公開 | **Cloudflare Pages Free** | 帯域無制限。商用利用禁止の記載なし(同上)。**Vercel Hobby は規約で商用利用禁止と明記されているため不可** |
| 画面の作り | **Vite + React + TypeScript**(SPA / PWA) | サーバー処理が不要(データは全部 Supabase)なので Next.js は過剰。型で保守性を確保 |
| 多言語 | i18next(ja/es/pt の JSON。現行 i18n/ を移植) | |
| データ取得 | TanStack Query | 読込の自動リトライ・キャッシュ・オフライン時の再送 |
| 決済 | **Stripe**(月額 0 円・決済ごと 3.6%) | 回数券・サブスク・返金まで対応。Square / PAY.JP は 8 章で最終確認 |
| メール | **Resend Free**(3,000 通/月・100 通/日) | |
| LINE | **LINE 公式アカウント コミュニケーションプラン**(0 円・200 通/月) | 超過分はメールに自動切替(5.6) |
| バックアップ先 | **Cloudflare R2 Free**(10GB) | |
| ※ GitHub リポジトリ | **公開リポジトリ** のため、秘密情報・バックアップは絶対に置かない | |

### 1.3 無料枠の制約と対策

| 制約 | 影響 | 対策 |
|---|---|---|
| Supabase: **7 日間アクセスがないと一時停止** | テスト環境が止まる | 日次バックアップ(GitHub Actions)が毎日アクセスするので両環境とも止まらない |
| Supabase: **自動バックアップなし** | 障害時に復元不可 | 毎晩 `pg_dump` → 暗号化 → R2 へ保存(30 日保持)。復元手順を文書化し、受け入れ時に 1 回実演 |
| Supabase: DB 500MB / Storage 1GB | | 月数十人規模では数年で数十 MB の見込み。問診画像は端末側で縮小(長辺 1600px・JPEG)してから保存。使用量を日次サマリに表示し 70% で警告 |
| LINE: 200 通/月 | 予約が月 200 件を超えるとリマインドが送れない | 残り通数を DB で数え、尽きたらメールに切替。必要になったらライトプラン(月 5,000 円)を Nicolas が判断 |
| Resend: 100 通/日 | | 予約確認・リマインドの規模では十分。超過時は翌日に回す |
| Cloudflare Pages: 月 500 ビルド | | 十分 |

---

## 2. データ設計

全テーブル: 主キー `id uuid`、`created_at` / `updated_at`。物理削除はしない(`status` や取消記録で表す)。

### 2.1 組織・人

| テーブル | 主な列 | 備考 |
|---|---|---|
| `stores` | name, timezone, address, settings(jsonb) | 店舗。最初は LBC 1 件 |
| `staff` | user_id(auth), store_id, role(`owner`/`staff`), display_name, active | 1 人が複数店舗に所属可能(store ごとに 1 行) |
| `customers` | code(`P001`…), name, furigana, phone_normalized, email, birth_date, lang, how_found, address, notes, status(`active`/`archived`), referred_by(customer), user_id(auth・マイページ用・任意), line_user_id(任意) | **店舗をまたいで共通**(店舗が増えても同じお客さんは 1 人)。code は現行の診察番号を引き継ぐ |
| `customer_consents` | customer_id, kind(`privacy`/`line`/`email`), granted_at, revoked_at | 個人情報・通知の同意記録 |

### 2.2 メニュー・商品

| テーブル | 主な列 | 備考 |
|---|---|---|
| `menus` | store_id, name(jsonb: ja/es/pt), duration_min, price, active, sort | 施術コース(カイロ ¥4,000 等) |
| `products` | store_id, kind(`ticket`/`subscription`), name(jsonb), price, uses, valid_days, menu_ids, stripe_price_id | 回数券・サブスク。**現行の「月2回プラン」は `ticket`(2 回・当月末まで)として表す** |

### 2.3 来店・施術

| テーブル | 主な列 | 備考 |
|---|---|---|
| `visits` | store_id, customer_id, staff_id, booking_id, visit_date, attended, no_show_reason, menu_id, change_from_last(`none`/`changed`), memo, status(`recorded`/`voided`), voided_by_visit_id, request_id(**unique**) | 1 来店 = 1 行。来院回数 = `attended and status='recorded'` の件数 |

### 2.4 お金(すべて追記の台帳)

| テーブル | 主な列 | 備考 |
|---|---|---|
| `sales` | store_id, customer_id, visit_id, order_id, amount(±), method(`cash`/`card`/`paypay`/`stripe`/`unpaid`), kind(`sale`/`refund`/`void`), reverses_id, occurred_at, request_id(**unique**) | 売上。取消は負の行を追加 |
| `credit_entries` | customer_id, kind(`grant`/`use`/`expire`/`void`), amount(±), reason(`referral`/`manual`/`migration`…), expires_at(grant のみ), visit_id, reverses_id, request_id | 現行クレジット台帳と同じ考え方。残高 = SUM |
| `passes` | customer_id, product_id, store_id, total_uses, valid_from, valid_until, order_id, status | 購入した回数券・サブスクの権利 |
| `pass_uses` | pass_id, visit_id, delta(-1 / 取消で +1), request_id | 回数券の消化。残り = total_uses + SUM(delta) |
| `orders` | customer_id, store_id, product_id, amount, status(`pending`/`paid`/`refunded`), stripe_session_id, stripe_payment_intent | オンライン決済の注文 |

### 2.5 問診

| テーブル | 主な列 | 備考 |
|---|---|---|
| `questionnaires` | customer_id, store_id, submitted_at, lang, answers(jsonb), pain_areas(text[]), image_paths(text[]), request_id | 回答は設問の追加に強い jsonb。画像は Storage の非公開バケット |

### 2.6 予約

| テーブル | 主な列 | 備考 |
|---|---|---|
| `staff_schedules` | staff_id, store_id, weekday, start_time, end_time | 通常の勤務枠 |
| `schedule_exceptions` | staff_id, store_id, date, kind(`off`/`extra`), start_time, end_time | 休み・臨時枠 |
| `bookings` | store_id, staff_id, customer_id, menu_id, period(**tstzrange**), status(`confirmed`/`cancelled`/`completed`/`no_show`), source(`web`/`staff`/`mypage`), request_id(unique) | **二重予約は DB の排他制約で防ぐ**: `EXCLUDE USING gist (staff_id WITH =, period WITH &&) WHERE (status = 'confirmed')` |

空き枠は「勤務枠 − 予約 − 例外」を DB 関数 `get_available_slots(store, menu, date_from, date_to)` で計算する。

### 2.7 通知・運用

| テーブル | 主な列 | 備考 |
|---|---|---|
| `notifications` | customer_id, channel(`line`/`email`), template, payload(jsonb), scheduled_at, sent_at, attempts, last_error, dedupe_key(unique) | 送信待ちの箱(アウトボックス)。予約確定時に「前日リマインド」を積む → cron が送る |
| `audit_log` | actor, action, table_name, row_id, diff(jsonb), at | 誰が何を変えたか |

### 2.8 集計(ダッシュボード・分析・確定申告)

DB のビュー(`v_monthly_sales`, `v_monthly_visits`, `v_customer_summary` など)で出す。テーブルに集計値を持たない(ズレないように)。確定申告用は `sales` を期間指定で CSV 出力する。

---

## 3. 業務ロジック(DB 関数)

画面は以下の関数を呼ぶだけ。各関数は 1 トランザクションで、全部成功か全部失敗。

| 関数 | 内容 |
|---|---|
| `record_visit(payload)` | 施術記録。①request_id が既存なら前回の結果を返す(冪等)②顧客が active か・スタッフがその店舗所属か確認 ③金額は `menus` から DB が決める ④クレジット使用は残高以下か確認(超過はエラー)⑤回数券使用は残りがあるか確認 ⑥`visits`・`sales`・`credit_entries`・`pass_uses` を書く ⑦紹介者がいれば ¥1,000 付与(自分自身の紹介は不可、紹介者 1 人あたり最大 3 件)⑧結果を返す |
| `void_visit(visit_id, reason, request_id)` | 赤伝訂正。スタッフは当日分のみ、owner は過去日も可。売上・クレジット・回数券をすべて打ち消す行を追加 |
| `get_patient_card(customer_id)` | 記録画面用: 来院回数・前回日・残高・期限が近いクレジット・使える回数券・当日の記録 |
| `submit_questionnaire(payload)` | 初回問診。電話番号で既存顧客と照合(現行 SPEC 4.3 のルールを継続)→ 新規顧客を採番・作成 → 問診保存 |
| `get_available_slots(...)` / `create_booking(payload)` / `cancel_booking(...)` | 予約。作成時は排他制約が最後の砦。確定時に通知を積む |
| `expire_credits()` | cron で毎日: 期限切れの grant 残を `expire` 行で打ち消す |

**顧客(ログインしていない人)が使う関数**(問診・予約)は、引数を厳密に検証し、返す情報を最小限にする。同じ電話番号からの連続送信は回数制限する。

---

## 4. 認証・権限

| 利用者 | ログイン方法 | できること(RLS で強制) |
|---|---|---|
| owner(Nicolas) | メール+パスワード | 所属店舗の全データ、過去日の訂正、メニュー・スタッフ管理 |
| staff(ルカス) | メール+パスワード(iPad に保存・ログイン状態は自動延長) | 所属店舗の顧客・施術・予約。当日分の訂正のみ |
| 顧客(マイページ) | LINE ログイン | **自分の**予約・回数券・残高・履歴のみ。問診の中身や他人のデータは不可 |
| 未ログイン | — | 問診送信・空き枠表示・予約作成(上記の検証付き関数のみ) |

- 現行の端末トークン方式は廃止
- `service_role` キー(全権限)は Edge Functions と GitHub Actions の秘密設定にのみ置き、画面・リポジトリには絶対に置かない

---

## 5. 画面

### 5.1 スタッフ用(`/staff`、iPad 想定・PWA)
- ログイン / 今日の予約・来店一覧 / 患者検索 / **施術記録**(現行 treatment-record.html の操作を踏襲)/ 顧客詳細(履歴・残高・回数券・問診)/ 予約管理(枠・休み)/ ダッシュボード / メニュー・商品・スタッフ管理(owner)/ CSV 出力(owner)

### 5.2 顧客用(ja/es/pt)
- 予約(空き枠から選ぶ)/ 問診(初回)/ マイページ(予約確認・変更・キャンセル、回数券・残高、履歴)/ 回数券・サブスクの購入(Stripe の決済画面へ)

### 5.3 「失敗しない」ための画面側の作り
- 読込: TanStack Query で自動リトライ(最大 3 回、指数バックオフ)。前回のデータを先に表示
- 送信: `request_id` を生成 → 入力内容を端末に保存 → 送信。失敗したら同じ `request_id` で自動再送(DB が二重記録を防ぐ)。成功で端末の保存を削除
- 未送信のものがあれば画面上部に件数を表示

### 5.4 Stripe・LINE・メール(Edge Functions)
- `stripe-webhook`: 決済完了 → `orders` を paid に → `passes`・`sales` を作成(Stripe のイベント ID で冪等)
- `send-notifications`(cron で 5 分毎): `notifications` から送信時刻を過ぎたものを送る。LINE 連携済みかつ月の残り通数があれば LINE、なければメール
- `line-webhook`: LINE 友だち追加・連携(顧客と `line_user_id` を結ぶ)
- `daily-summary`(cron で毎晩): 当日の来院・売上・未記録・DB 使用量を owner にメール

---

## 6. 環境・リポジトリ・テスト

### 6.1 環境
| | テスト | 本番 |
|---|---|---|
| Supabase | `lbc-staging` | `lbc-prod` |
| Cloudflare Pages | `staging` ブランチのプレビュー URL | `main` ブランチ |
| Stripe / LINE | テストモード / テスト用チャネル | 本番 |

DB の変更はすべて `supabase/migrations/` の SQL で管理し、テスト → 本番の順に適用する(手で DB を触らない)。

### 6.2 リポジトリ構成(同じリポジトリ lbc-form に追加)
```
app/                 新しい画面(Vite + React + TS)
supabase/
  migrations/        DB の変更履歴(SQL)
  functions/         Edge Functions
  tests/             DB のテスト(業務ルール・RLS)
scripts/migrate/     現行シート → Supabase の移行スクリプト
.github/workflows/   バックアップ・テスト・デプロイ
(既存の *.html, gas/ は本番切替まで現状維持 → 切替後に archive/ へ)
```

### 6.3 テスト
- **DB テスト**(pgTAP): 業務ルール(クレジット FIFO・失効・紹介 3 件・残高超過拒否・赤伝・回数券・二重予約)と RLS(他店舗・他人のデータが見えない)
- **画面のテスト**(Vitest): 金額表示・入力チェック・再送処理
- **通しのテスト**(Playwright): テスト環境で ログイン→記録→訂正、予約→キャンセル、問診 を自動実行
- GitHub Actions で PR ごとに実行

---

## 7. データ移行と本番切替

### 7.1 移行(テスト環境で何度でもやり直せるようにする)
1. 現行の LBC台帳(シート)を読み込む(Sheets API。Notion は移行元にしない=シートが正)
2. 変換: 顧客マスタ → `customers`(code=P001… を維持)/ 施術台帳 → `visits`+`sales`(void は打ち消し行として)/ クレジット台帳 → `credit_entries` / 月2回プラン → `passes`+`pass_uses` / 問診台帳 → `questionnaires`(画像は Drive から Storage へコピー)
3. 検証: 顧客数・来院数・月別売上・顧客ごとのクレジット残高を、現行 GAS の計算結果と突き合わせ、全件一致するまで直す

### 7.2 切替
1. テスト環境でルカスに一通り使ってもらい、受け入れ条件(requirements 5 章)を満たす
2. 切替日を決める → 前日夜に GAS の書き込みを止める(フォームに「メンテナンス中」表示)
3. 本番へ最終移行・検証
4. 予約・問診の URL(Instagram・Google マップ・QR)を新システムに向ける。旧 URL は新 URL へ転送するページに置き換える
5. GAS のトリガーを停止。GAS とシートは 1 か月 読み取り専用で残してから終了

---

## 8. 作る順番

| # | 内容 | 終わったら何ができるか |
|---|---|---|
| 1 | 土台: Supabase 2 環境・Cloudflare Pages・CI・日次バックアップ・スタッフログイン・`stores`/`staff`/`customers`/`menus` | テスト環境にログインできる |
| 2 | 施術記録・クレジット・回数券(月2回プラン)・赤伝・顧客詳細・ダッシュボード + 移行スクリプト | **ルカスがテスト環境で現行の記録業務を全部できる**(今回の問題の解決) |
| 3 | 問診・予約(現行と同等)+ 予約枠管理(N1)+ 予約確認メール | **GAS を止められる → 本番切替** |
| 4 | リマインド(N2: メール → LINE) | |
| 5 | 回数券・サブスクのオンライン購入(N3: Stripe) | |
| 6 | 顧客マイページ(N5) | |
| 7 | 複数スタッフ・複数店舗の管理画面(N4)※データ構造は 1 から対応済み | |
| 8 | 売上分析・確定申告出力(N6) | |

### 8.1 新機能の受け入れ条件
- **N1 予約枠:** 同じ枠に同時に 2 件予約しようとしても 1 件しか入らない(並行テストで確認)。休み・臨時枠が空き枠に反映される
- **N2 リマインド:** 前日の指定時刻に 1 回だけ届く(再送や二重送信がない)。キャンセル済みには届かない。LINE の残り通数が尽きたらメールで届く
- **N3 決済:** テストモードで 購入 → 回数券付与 → 使用 → 返金 が一致する。Webhook が二重に届いても二重付与しない
- **N4 複数店舗:** 店舗 A のスタッフは店舗 B のデータを読めない(RLS テスト)
- **N5 マイページ:** 自分以外の予約・履歴・問診にアクセスできない(RLS テスト)。予約の変更・キャンセルが空き枠に即反映される
- **N6 分析:** 月別売上・来院数がダッシュボードと CSV で一致。CSV が会計ソフトに取り込める形式

---

## 9. 決定事項(2026-10-03 Nicolas 確認済み)

- [x] **スタッフのログイン方式**: メール+パスワード
- [x] **顧客マイページのログイン**: LINE ログイン
- [x] **決済サービス**: Stripe。店頭の PayPay・カード決済は当面 現行どおり「手入力の記録」
- [x] **作る順番(8 章)**: この順で、まずテスト環境で進める。実装の判断は Claude に一任

## 10. リスク

| リスク | 対策 |
|---|---|
| Supabase 無料枠の条件変更 | 標準の Postgres なので、最悪は有料プラン(月 25 ドル)か他の Postgres へ移せる。日次バックアップがあれば移行可能 |
| 作り直しに時間がかかり、現行の不安定さが続く | 現行は運用開始前なので実害は限定的。順番 2 の時点でテスト環境で記録業務を始められる |
| 移行でお金のデータがずれる | 7.1 の全件突き合わせ。一致するまで切替しない |
| 健康情報の漏えい | RLS の自動テスト・service_role キーの管理・Storage 非公開・監査ログ |
