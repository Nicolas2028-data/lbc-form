# データベース(新基盤 / Supabase)設計・運用ガイド

> 対象: `platform-rebuild` ブランチの新基盤。現行の GAS + スプレッドシートについては `SPEC.md` を参照。
> 正本はリポジトリの `supabase/migrations/*.sql`。この文書は「どういう考えで作っているか」と「どう運用するか」をまとめたもの。

---

## 1. 全体像

| 項目 | 内容 |
|---|---|
| DB | Supabase(PostgreSQL 17)/ 東京リージョン |
| 環境 | テスト: `lbc-staging`(ref `lnatpitfcqxmgxxmmqzr`)/ 本番: 未作成 |
| スキーマ | `public`(API に公開。全テーブル RLS 必須)/ `private`(API 非公開の内部関数・冪等性テーブル)/ `extensions`(拡張機能) |
| 画面からのアクセス | Supabase クライアント(公開キー)+ ログインしたユーザーの権限。**service_role キーは画面・リポジトリに置かない** |

### 1.1 設計の原則

1. **DB が正本。** 金額・残高・回数・権限はすべて DB が決める。画面から来た金額は使わない
2. **お金・来店は追記の台帳。** 残高は記録の合計から計算。訂正は取消行(赤伝)を追加し、物理削除しない
3. **書き込みは DB 関数(RPC)で 1 トランザクション。** 全部成功か全部失敗。テーブルへの直接書き込みはマスタ(顧客・メニュー等)だけ
4. **書き込みは冪等。** クライアントが `request_id`(UUID)を付け、同じ ID の再送には前回の結果を返す(`private.idempotency`)。
   前回の結果を返すのは「同じ関数・同じ実行者」のときだけ(別人・別の処理なら `request_id_conflict`)。行ロックの後にも再確認し、同時再送でも二重にならない
5. **権限は RLS と関数内のチェックで強制。** 画面の出し分けは補助
6. **最初から複数店舗前提。** 業務テーブルは `store_id` を持つ(顧客とクレジットは店舗をまたいで共通)

---

## 2. テーブル

### 2.1 組織・人
| テーブル | 用途 | 主な制約 |
|---|---|---|
| `stores` | 店舗。`settings`(jsonb)に予約の刻み・締切などの設定 | |
| `staff` | スタッフ(auth ユーザー × 店舗)。`role` = owner / staff | (user_id, store_id) 一意 |
| `customers` | 患者(店舗共通)。`code` = P001…(1000 人目以降は P1000) | code 一意、電話・メールは保存時に正規化(トリガー)、`first_visit_date` は来店の追加・取消で自動再計算 |
| `customer_consents` | 個人情報・通知の同意記録 | |
| `menus` / `products` | 施術コース / 回数券・サブスク(月2回プラン = 当月末まで 2 回) | (store_id, code) 一意 |

### 2.2 来店・お金(追記の台帳)
| テーブル | 用途 | ポイント |
|---|---|---|
| `visits` | 来店 1 回 = 1 行。施術なし(no-show)も記録 | `status` = recorded / voided(取消は状態のみ変更)、`request_id` 一意 |
| `sales` | 売上。取消は負の `void` 行 | `reverses_id` 一意(二重取消防止)、未払いは `method='unpaid'` で金額どおり計上 |
| `credit_entries` | クレジットの付与・使用・失効・取消 | 付与から 1 年で失効 |
| `credit_allocations` | 使用ごとに「どの付与からいくら使ったか」 | §2.5 |
| `passes` / `pass_uses` | 回数券と、その消化(-1)・取消(+1) | 残り回数 = total_uses + Σdelta |
| `orders` | オンライン決済(将来) | |
| `questionnaires` | 問診票(回答は jsonb、画像は Storage のパス) | `request_id` 一意 |
| `audit_log` | 顧客情報の変更履歴(owner のみ閲覧) | |

### 2.5 クレジットの計算(2026-10-03 作り直し)
- **使用した時点で**、その日に有効な付与(`expires_on >= 使用日`)へ、期限の近い順に割り当てて `credit_allocations` に記録する
- 付与の残り = 付与額 + 失効・取消(負)− 取り消されていない使用の割当
- 使える残高(指定日) = 期限内の付与の残りの合計 − 不足分(取り消された紹介付与がすでに使われていた分)
- 失効処理 `expire_credits()` は **pg_cron で毎日 00:05(日本時間)** に実行し、期限切れの付与の残りを `expire` 行で打ち消す。
  失効処理の前でも期限切れの付与には割り当てないので、二重使用は起きない
- 来店の取消で使用を取り消すと、割当ごと元の付与に戻る(元の付与が期限切れなら、次の失効処理で失効する)
- 以前は「使用の合計を期限順に配り直す」方式で、期限切れ分の二重使用・取消で残高が増えるバグがあった(コードレビューで発見、migration 0011 で修正)

### 2.3 予約(一時停止中)
`staff_schedules` / `schedule_exceptions` / `bookings`。二重予約は排他制約 `bookings_no_overlap`(同じスタッフの confirmed の時間帯が重ならない)で防ぐ。
2026-10-03 に画面を非表示・未ログインからの関数実行を停止(migration 0009)。再開手順は §6.4。

### 2.4 集計
`v_monthly_stats`(ビュー、`security_invoker`): 店舗 × 月の来院数・新規・売上(未払い除く)・未収・客単価。新規 = 取消されていない最初の来院がその月にある患者。

---

## 3. 業務ロジック(DB 関数)

| 関数 | 呼べる人 | 内容 |
|---|---|---|
| `record_visit(p)` | スタッフ | 施術記録。来院日 `visit_date` は今日か前日(送信待ちが翌日に届いても記録した日の日付になる。料金・期限は来院日で判定)。料金はメニュー・商品から決定、紹介(初回のみ ¥1,000 引き・紹介者に ¥1,000・3 件まで)、クレジット(残高・料金を超えない)、回数券、同じ日の 2 件目は `allow_same_day` 必須 |
| `void_visit(p)` | スタッフ(当日)/ owner(過去日) | 赤伝取消。売上・クレジット・回数券をすべて打ち消す |
| `get_patient_card(customer)` | スタッフ | 記録画面用(来院回数・残高・期限の近いクレジット・使える回数券・当日の記録) |
| `expire_credits(as_of)` | service_role(定期実行用) | 期限切れのクレジットを失効 |
| `submit_questionnaire(p)` | **未ログイン可** | 問診票。入力を厳密に検証、電話+氏名で照合(家族の電話共有は別人)。既存患者に一致したときはマスタを上書きせず `matched_existing` を付ける(スタッフが本人確認)。同じ電話は 1 日 5 件・店舗全体で 1 日 100 件まで、返すのは受付結果のみ |
| `public_store(id)` | **未ログイン可** | 店舗名と ID のみ |
| 予約系(`get_available_slots` ほか) | スタッフのみ(停止中) | |

業務エラーは `raise exception '<code>' using errcode = 'P0001'` で返し、画面は `<code>` を各言語の文言に変換する(`app/src/locales/*.json` の `errors`)。

### 3.1 security definer について
Supabase Advisors は「security definer の関数をログインユーザー/未ログインが実行できる」と警告するが、**上表の関数は意図して公開している**。どれも関数の中で権限(スタッフか・どの店舗か)を確認し、`search_path` を固定している(`lint.test.mjs` で検査)。

---

## 4. 権限モデル

| 利用者 | できること |
|---|---|
| 未ログイン(anon) | メニュー・商品の閲覧、問診票の送信、問診画像のアップロード(`q/<request_id>/` のみ、2MB まで、読み取り不可) |
| スタッフ | 自店舗の来店・売上・回数券・問診・予約の閲覧、全顧客の閲覧・登録・編集(物理削除不可。編集できる列は氏名・連絡先・メモ・状態などに限定し、患者番号・ログインの紐づけ・紹介者は変えられない)、上表の関数 |
| owner | スタッフの権限 + メニュー・商品・スタッフ・通常の営業時間の管理、過去日の取消、監査ログ |
| 患者本人(将来のマイページ) | 自分の顧客情報と同意記録のみ |

- `public` の全テーブルで RLS 有効。anon / authenticated に TRUNCATE・TRIGGER・REFERENCES を付けない(TRUNCATE は RLS で止まらない)。既定権限(default privileges)からも外してある
- 関数の実行権限は既定で閉じ(default privileges)、使う関数だけ明示的に開ける。未ログインは `public_store`・`submit_questionnaire` のみ(`lint.test.mjs` の `ANON_ALLOWED`)
- Supabase は public の関数に anon の実行権限を直接付けるため、関数を追加するたびに staging で §6.3 の照合をする

---

## 5. テスト

| コマンド | 内容 |
|---|---|
| `npm run test:db` | 業務ルール・権限・問診・予約・スキーマの自動検査(PGlite = Docker 不要の Postgres) |
| `review.test.mjs`(test:db に含む) | コードレビューで見つかったバグの再現テスト(修正前はすべて失敗) |
| `npm run test:fuzz` | ロジックのファズテスト。ランダムな操作を DB と独立モデルに流して突き合わせ(既定 300 シナリオ × 40 操作、`FUZZ_SEED` で再現) |
| `node scripts/db/fingerprint.mjs` | スキーマの指紋(§6.3) |

GitHub Actions(`.github/workflows/test.yml`)で push ごとに実行(ファズは 100 シナリオ)。

---

## 6. 運用手順

### 6.1 スキーマを変更するとき
1. `supabase/migrations/<YYYYMMDDHHMMSS>_<名前>.sql` を**新しく追加**する(適用済みのファイルは書き換えない)
2. 関数を変えるときは `create or replace` で全体を書き直す(差分適用はできない)
3. `npm run test:db` と `npm run test:fuzz` を通す。新しいルールにはテストを足す
4. コミット・push → §6.2 でテスト環境に適用 → §6.3 で照合 → Advisors 確認

### 6.2 テスト環境への適用(現状: SQL エディタで手動)
1. Supabase ダッシュボード → SQL Editor
2. `begin;` + マイグレーションの中身 + `insert into supabase_migrations.schema_migrations (version, name) values ('<version>', '<name>');` + `commit;` を実行
3. ポリシーの削除などを含むと「destructive operations」の確認が出る。内容を確認してから実行
4. `select version, name from supabase_migrations.schema_migrations order by version;` で適用済み一覧を確認

> 今後: Supabase CLI(`supabase link` → `supabase db push`)に移行すると、適用漏れ・二重適用が起きなくなる。CLI のログインは Nicolas が行う(アクセストークンを Claude が扱わないため)。

### 6.3 リポジトリと DB のずれの照合
1. ローカル: `node scripts/db/fingerprint.mjs > local.json`
2. DB: SQL エディタで `scripts/db/fingerprint.sql` を実行し、結果の JSON を `remote.json` に保存
3. `node scripts/db/compare.mjs local.json remote.json`

既知の差分(問題なし): `public.rls_auto_enable()`(プロジェクト作成時の「RLS 自動有効化」設定が作る関数)、btree_gist 拡張の関数群。

### 6.4 予約機能を再開するとき
1. `app/src/App.tsx` に `/book`・`/b/:token`・`/staff/bookings` のルートを戻し、`StaffLayout.tsx` にメニューを戻す
2. migration 0009 の revoke を grant に戻す migration を追加
3. `bookings.test.mjs` の「一時停止中」テストを削除し、`lint.test.mjs` の `ANON_ALLOWED` に予約系関数を追加

### 6.5 Supabase Advisors(診断)
ダッシュボード → Advisors。2026-10-03 時点の残り:
- 「security definer の関数を実行できる」: §3.1 のとおり意図的
- 「漏えいしたパスワードの利用防止」がオフ: Auth の設定。利用可能なプランかを確認して判断(TODO)
- 未使用の索引・外部キーの索引(INFO): データが少ない今は影響なし。本番運用で遅くなったら見直す

### 6.6 バックアップ(未実装・TODO)
無料プランは自動バックアップなし。設計(design.md 1.3)では GitHub Actions で毎晩 `pg_dump` → 暗号化 → Cloudflare R2。DB の接続文字列と R2 の鍵を GitHub の Secrets に登録する作業が必要(Nicolas)。

---

## 7. 変更履歴(マイグレーション)

| # | ファイル | 内容 |
|---|---|---|
| 0001 | core | 店舗・スタッフ・顧客・メニュー・商品・監査・冪等性・RLS |
| 0002 | visits_money | 来店・売上・クレジット・回数券、record_visit / void_visit / get_patient_card / expire_credits / 月別集計 |
| 0003 | same_day_guard | 同じ患者・同じ日の二重記録防止(Nicolas 指摘) |
| 0004 | first_visit_fix | 初回来院日の再計算・集計の「新規」修正(ファズで発見) |
| 0005 | customer_code_overflow | P999 → P1000(ファズで発見) |
| 0006 | customer_phone_normalize | 電話・メールを保存時に正規化 |
| 0007 | questionnaires | 問診票・画像の非公開保存 |
| 0008 | bookings | 予約 |
| 0009 | bookings_paused | 予約の一時停止 |
| 0010 | hardening | 拡張の移動・危険な権限の除去・RLS の性能改善・索引(Advisors と照合で発見) |
| 0011 | review_fixes | コードレビューで確定したバグの修正: クレジットの割当方式・pg_cron・冪等キーの範囲・取消時のロック・患者カードの店舗限定・問診の検証と上書き防止・列単位の権限・関数の実行権限・来院日 |
