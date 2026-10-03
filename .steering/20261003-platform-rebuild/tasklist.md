# タスク: LBC Care 基盤の作り直し

**設計: [design.md](design.md) / 作業ブランチ: `platform-rebuild`(テスト環境のみ。本番切替まで main の現行システムには触らない)**

凡例: [ ] 未着手 / [~] 作業中 / [x] 完了 / 🙋 Nicolas の操作が必要

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
- [~] 2-4 画面: 患者検索・施術記録・訂正(送信は request_id + 自動再送)は完了。顧客詳細(履歴一覧・情報編集)は未着手
- [x] 2-5 画面: ダッシュボード(ビュー v_monthly_*)
- [ ] 2-6 移行スクリプト(シート → Supabase)+ 突き合わせ検証
- [ ] 2-7 ルカスにテスト環境で記録業務を試してもらう

## 3. 問診・予約(→ 本番切替)
- [ ] 3-1 questionnaires + submit_questionnaire + 画像(Storage)
- [ ] 3-2 予約枠(staff_schedules, schedule_exceptions, bookings + 排他制約)+ get_available_slots / create_booking / cancel_booking
- [ ] 3-3 画面: 予約・問診(ja/es/pt)、予約管理(スタッフ)
- [ ] 3-4 予約確認メール(Resend)🙋 Resend アカウント
- [ ] 3-5 本番環境構築 → 切替手順のリハーサル → 🙋 切替日の決定

## 4〜8. 新機能
- [ ] 4 リマインド(メール → LINE)🙋 LINE 公式アカウント・Messaging API チャネル
- [ ] 5 Stripe(回数券・サブスク購入、Webhook)🙋 Stripe アカウント
- [ ] 6 マイページ(LINE ログイン)🙋 LINE ログインチャネル
- [ ] 7 複数スタッフ・複数店舗の管理画面
- [ ] 8 売上分析・確定申告 CSV
