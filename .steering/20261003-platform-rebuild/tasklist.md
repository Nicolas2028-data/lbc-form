# タスク: LBC Care 基盤の作り直し

**設計: [design.md](design.md) / 作業ブランチ: `platform-rebuild`(テスト環境のみ。本番切替まで main の現行システムには触らない)**

凡例: [ ] 未着手 / [~] 作業中 / [x] 完了 / 🙋 Nicolas の操作が必要

## 0. 横断
- [x] デバッグ: DB・画面のコードレビュー(確定 22 件)を修正、再現テスト・ファズのモデル更新・staging 反映(migration 0011)
- [x] DB 管理: スキーマの指紋によるずれ照合(scripts/db)、Supabase Advisors 対応(migration 0010)、スキーマの自動検査(lint.test.mjs)、docs/database.md
- [x] デザイン刷新(shadcn/Linear 風、ライト/ダーク、iPad 向け)
- [x] ロジックのファズテスト(300 シナリオ × 40 操作、CI では 100)

## 1. 土台
- [x] 1-1 `supabase/migrations/`: 組織・人・メニュー(stores, staff, customers, customer_consents, menus, products)+ RLS + 共通関数(updated_at, audit)
- [x] 1-2 DB テスト基盤(Docker なしで動く PGlite + auth スタブ)と RLS テスト
- [x] 1-3 `app/`: Vite + React + TS + i18next(ja/es/pt)+ Supabase クライアント + PWA の雛形
- [x] 1-4 スタッフログイン画面
- [x] 1-5 GitHub Actions: テスト(PR ごと)
- [x] 1-6 🙋 Supabase アカウント作成 → `lbc-staging` プロジェクト(東京)作成 → アクセストークン発行
- [ ] 1-7 🙋 Cloudflare アカウント作成 → Pages にリポジトリ接続(`platform-rebuild` ブランチ = テスト環境)
- [~] 1-8 テスト環境へマイグレーション適用 ✅(SQL エディタで適用・supabase_migrations に記録済み)、スタッフ作成 🙋
- [ ] 1-9 日次バックアップ(pg_dump → 暗号化 → R2)🙋 R2 バケットと鍵の作成

## 2. 施術記録・お金・移行
- [x] 2-1 migrations: visits, sales, credit_entries, passes, pass_uses, orders, audit_log
- [x] 2-2 DB 関数: record_visit / void_visit / get_patient_card / expire_credits
- [x] 2-3 DB テスト: FIFO・失効・紹介 3 件上限・自己紹介拒否・残高超過拒否・回数券・赤伝・冪等性
- [x] 2-4 画面: 患者検索・施術記録・訂正・顧客詳細(履歴・編集・アーカイブ・クレジット履歴・問診表示)
- [x] 2-5 画面: ダッシュボード(ビュー v_monthly_*)
- [x] 2-6 移行スクリプト(シート → Supabase)+ 突き合わせ検証 — 2026-10-04 本番台帳を lbc-staging に取り込み、照合すべて一致(顧客36・来院5・施術なし1・取消5・売上¥36,000・回数券4・問診36)。顧客マスタに無い P001〜P003 の7月の記録3件(テストデータ)と、重複整理の跡の取消3件は移行しない(Nicolas 確認済み。元のスプレッドシートが記録として残る)。台帳 xlsx と out/ は削除済み
- [x] 2-8 Notion から脱却(Nicolas 判断 2026-10-04): 受付(今日の一覧)・カルテメモ(編集履歴)・写真・カルテ一覧・注意事項・前回のカルテ表示(migration 0013〜0015、テスト 81 件)。独立レビュー 9 件を修正。Notion の施術カルテ 44 ページを調査 → 問診の自動まとめ以外の書き込み 10 ページのうち、新システムにいる患者の 3 件をカルテメモとして取り込み(残り 7 件は P001〜P005 = 7〜8 月のテスト期の患者で顧客マスタに無い)
- [ ] 2-9 🙋 本番切替時に Notion の取り込みをやり直す(scripts/migrate/notion-export.mjs → notion-notes.mjs → スタッフ画面で取り込み)。切替後に Notion の施術カルテ・顧客管理DB と GAS の Notion 同期を止める
- [ ] 2-7 ルカスにテスト環境で記録業務を試してもらう

## 3. 問診・予約(→ 本番切替)
> 予約は 2026-10-03 Nicolas の判断で一時停止(画面非表示・未ログインからの実行停止)。問診は継続
- [x] 3-1 questionnaires + submit_questionnaire + 画像(Storage)
- [x] 3-2 予約枠(staff_schedules, schedule_exceptions, bookings + 排他制約)+ get_available_slots / create_booking / cancel_booking
- [x] 3-3 画面: 予約(/book)・予約確認/キャンセル(/b/:token)・問診(/q)(ja/es/pt)、予約管理・営業時間/休み設定(スタッフ)
- [ ] 3-4 予約確認メール(Resend)🙋 Resend アカウント
- [ ] 3-5 本番環境構築 → 切替手順のリハーサル → 🙋 切替日の決定

## 4〜8. 新機能
- [-] 4 リマインド(予約の一時停止に伴い保留)
- [ ] 5 Stripe(回数券・サブスク購入、Webhook)🙋 Stripe アカウント
- [ ] 6 マイページ(LINE ログイン)🙋 LINE ログインチャネル
- [ ] 7 複数スタッフ・複数店舗の管理画面
- [ ] 8 売上分析・確定申告 CSV

## TODO: 仕様の判断待ち(Nicolas)
ファズテスト(2026-10-03)で見つかった「エラーではないが、ルールの決めが必要な挙動」。決まるまで現状の挙動のまま。

- [ ] **紹介割引が料金より大きいとき**: 回数券で支払う来店(¥0)などに紹介を付けると、¥1,000 の割引は使われずに消えるが、紹介者には ¥1,000 のクレジットが付く(今のメニューは全て ¥4,000 以上なので通常は起きない)
  - A. 現状のまま / B. 料金が ¥1,000 未満のときは紹介を付けられないようにする
- [ ] **紹介者のクレジット残高がマイナスになる**: A が B を紹介 → A に ¥1,000 → A が使用 → B の来店を取消 → A の付与も取消され A の残高が −¥1,000
  - A. マイナスのまま(次の付与から相殺)/ B. 紹介クレジット使用済みなら B の来店取消は owner のみ / C. B の来店を取り消しても A の紹介クレジットは残す
