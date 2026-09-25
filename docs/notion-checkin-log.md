# Notion 来店ログ DB (2026-09-26)

## Database IDs

### 本番
- **DB ID:** `2c503d5e8679423c8a869532a661cea8`
- **Data Source ID (GAS API 用):** `f237cf61-117b-417f-b9f4-ea98980d1ded`
- **URL:** https://app.notion.com/p/2c503d5e8679423c8a869532a661cea8
- **親ページ:** LBC ダッシュボード (`35388446-d062-811e-ba98-c07c12ac1e8d`)

### STAGING
- **DB ID:** `0213c9361e63409c8c5ba21129c3712e`
- **Data Source ID (GAS API 用):** `2d03418e-0104-4f64-9a6a-cffda70d68b4`
- **URL:** https://app.notion.com/p/0213c9361e63409c8c5ba21129c3712e
- **親ページ:** LBC ダッシュボード (`35388446-d062-811e-ba98-c07c12ac1e8d`)

## GAS スクリプトプロパティ設定(Nicolas が手動で設定)

GAS エディタ → プロジェクトの設定 → スクリプトプロパティ から以下を追加:

| キー | 値 |
|---|---|
| `NOTION_CHECKIN_DB_ID` | `2c503d5e8679423c8a869532a661cea8` |
| `STAGING_NOTION_CHECKIN_DB_ID` | `0213c9361e63409c8c5ba21129c3712e` |

**注意:** GAS の Notion API 呼び出しでは Data Source ID(または DB ID)のどちらを使うかは、
実装コード側の `notionPost` の呼び出し方に依存する。現状の実装は DB ID を使用しているので、
`NOTION_CHECKIN_DB_ID` には **DB ID** を設定する。

## スキーマ

| プロパティ | 型 | 説明 |
|---|---|---|
| 顧客名 | Title | Sheet の customer_name |
| 状態 | Select | 🔴 未記録 / ✅ 済 / ⚫ 施術なし |
| 来店 | Date (datetime) | checkin_at |
| 経過 | Formula | 🟢 本日 / 🟡 1日経過 / 🟠 2〜6日経過 / 🔴 7日以上経過 |
| 📝 記録する | URL | 事前入力済み施術記録シート URL |
| メモ | Rich Text | no-show 理由等 |
| 診察番号 | Rich Text | customer_id (P001形式) |
| checkin_id | Rich Text | GAS 同期用 UUID (upsert キー) |

## ビュー

### 🚨 未記録 (Board)
- Filter: 状態 = 🔴 未記録
- Group by: 経過(本日 / 1日経過 / N日経過 の 3列)
- Sort: 来店 昇順

### 📊 全履歴 (Table)
- Sort: 来店 降順
- 全プロパティ表示

**「📅 今日の来店」ビュー** は view DSL が relative date filter(today)を
サポートしないため未作成。「📊 全履歴」で日付降順で今日のレコードが先頭に来る。
必要ならルカスと Nicolas で Notion UI から手動追加可能。

## 経過 Formula の実装ノート (2026-09-26 修正)

初版の `dateBetween(now(), 来店, "days")` は「完全な24時間経過」で日数を数えるため、
25日夜(JST)〜26日朝の患者が「🟢 本日」表示になるバグがあった。

修正版は `parseDate(formatDate(..., "YYYY-MM-DD"))` で **カレンダー日** に正規化してから
`dateBetween` で差分を取る。formatDate は Notion ワークスペースのタイムゾーンを使うため、
LBC ワークスペースが JST 設定である前提で JST カレンダー日で計算される。

## ダッシュボードページ再構成 (2026-09-26)

`LBC ダッシュボード` (`35388446-d062-811e-ba98-c07c12ac1e8d`) の構成を刷新:

1. トップ callout — 診療基本情報 + フォーム URL
2. **🚨 未記録リストの使い方** callout — ルカス向けガイド
3. **🚨 未記録リスト** セクション — 来店ログ DB 埋め込み
4. **📅 施術カルテ** セクション — 既存
5. **👥 患者検索** セクション(toggle) — 既存
6. **📊 施術ダッシュボード** セクション — dashboard.html 埋め込み
7. **月次レポート** ToC — 既存
