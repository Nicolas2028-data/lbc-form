# LBC Care — オペレーション管理システム

三重県四日市市の整体院 LBC Care の予約・問診・施術記録システム。

## 構成

```
index.html            予約フォーム（凍結中。変更禁止）
questionnaire.html    問診票（ja/es/pt）
treatment-record.html 施術記録シート（日本語のみ）
i18n/
  i18n.js             問診票の翻訳文字列（ja/es/pt）
gas/
  Code.js             GAS バックエンド（clasp で管理）
  appsscript.json     GAS マニフェスト
docs/
  manual-lucas.md     ルカス向け運用マニュアル
```

## アーキテクチャ

```
[GitHub Pages (questionnaire.html / treatment-record.html)]
        │ fetch POST/GET
        ▼
[GAS Webアプリ (doPost/doGet)]
  - スタッフ認証（brute-force 保護付き）
  - バリデーション・採番
  - Google スプレッドシート台帳に追記して即応答
  - 予約確認メール送信（予約フォームのみ）
        ▼
[Google スプレッドシート = 原本 (Source of Truth)]
  - 顧客マスタ / 施術台帳 / 問診台帳 / クレジット台帳 / アクセスログ
        ↓ 1分毎の時間トリガー (syncToNotion)
[Notion ダッシュボード = 表示専用]
  - 顧客マスタ DB / 施術カルテ DB
```

公開URL: https://nicolas2028-data.github.io/lbc-form

## GAS (clasp) 開発手順

### 前提
- Node.js インストール済み
- clasp インストール: `npm install --prefix ~/.local @google/clasp`
- 初回ログイン: `~/.local/bin/clasp login`
- Apps Script API を有効化: https://script.google.com/home/usersettings

### 日常操作

```bash
# GAS → ローカルに同期（確認用）
~/.local/bin/clasp pull

# ローカル → GAS に反映
~/.local/bin/clasp push

# GAS エディタをブラウザで開く
~/.local/bin/clasp open
```

### GAS プロジェクト情報
- Script ID: `1DWGR2YgD6nZejBB6ak8fDHwvwvEtsBBokb7TacvsjZK-DHtsJRyMhixc`
- rootDir: `./gas`

## スクリプトプロパティ（GAS エディタで設定）

| キー | 説明 |
|------|------|
| `NOTION_TOKEN` | Notion API トークン |
| `CUSTOMER_DB_ID` | 顧客マスタ DB ID |
| `KARTE_DB_ID` | 施術カルテ DB ID |
| `DRIVE_FOLDER_ID` | 人体図保存フォルダ ID |
| `STAFF_PASSWORD` | 施術記録シートのパスワード |
| `SITE_URL` | `https://nicolas2028-data.github.io/lbc-form` |
| `NOTIFY_EMAIL` | エラー通知先メール |
| `ENV` | `production` / `staging` |
| `LEDGER_SPREADSHEET_ID` | 台帳スプレッドシート ID（本番） |

## 運用ルール

- **シートが正。** Notion は表示専用ダッシュボード。Notion 側を直接編集しない
- **台帳は追記専用。** 施術台帳・クレジット台帳の既存行は書き換えない
- **index.html は凍結。** 予約フォームと予約系 API は変更禁止
- 過去日の施術記録訂正はシートに赤伝行を手動追記する運用

## 問診票の電話番号照合について

問診票は電話番号のみで患者を照合する設計です（再来院時は名前入力不要）。

### リスクと対処

| リスク | 対処 |
|--------|------|
| **家族で同じ番号を共用している** | 複数ヒット時は患者選択画面を表示。該当する方を選んでもらう |
| **電話番号を変更した** | 旧番号と新番号で別の顧客として登録される。スタッフが台帳シートで顧客マスタを手動統合（旧行を `archived` に変更、施術台帳の customer_id を新 ID に更新） |
| **初回に番号を誤入力した** | 2件の顧客レコードが存在する状態になる。同上の手順で統合 |

### 番号変更の統合手順
1. 顧客マスタで旧行の `ステータス` を `archived` に変更
2. 施術台帳・問診台帳・クレジット台帳の旧 `診察番号` を新しい番号に統一（赤伝方式は不要、直接書き換え可）
3. Notion は次の同期サイクルで自動更新される

## 本番環境切替（初回セットアップ）

ステージング検証完了後、GAS エディタから以下の手順を実施する。

### 手順

1. **本番 Notion DB を準備**
   - ステージング DB をコピーして本番用 DB を作成（または既存 DB を使用）
   - インテグレーションに接続する

2. **GAS スクリプトプロパティを設定**（GAS エディタ → プロジェクトの設定 → スクリプトのプロパティ）
   - `CUSTOMER_DB_ID` — 本番 顧客マスタ DB ID
   - `KARTE_DB_ID` — 本番 施術カルテ DB ID
   - `STAFF_PASSWORD` — ルカスのパスワード（4文字以上）

3. **GAS エディタから `setupProduction()` を実行**
   - 本番台帳スプレッドシートが自動作成される
   - `LEDGER_SPREADSHEET_ID` と `ENV=production` が自動設定される
   - トリガー（1分同期・日次サマリ）が再設定される

4. **本番疎通確認**
   - 問診票でテスト送信 → Notion に反映されることを確認
   - 施術記録シートにログイン → 記録送信 → スプレッドシートに追記されることを確認
   - 翌朝の日次サマリメールを確認

### 緊急時のロールバック

本番で問題が発生した場合は、GAS エディタでスクリプトプロパティの `ENV` を `staging` に戻す（即時反映）。
