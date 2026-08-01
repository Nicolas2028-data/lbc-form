# LBC Care — オペレーション管理システム

三重県四日市市の整体院 LBC Care の予約・問診・施術記録システム。

## 構成

```
index.html            予約フォーム（凍結中。変更禁止）
questionnaire.html    問診票（ja/es/pt）
treatment-record.html 施術記録シート（日本語のみ）
gas/
  Code.js             GAS バックエンド（clasp で管理）
  appsscript.json     GAS マニフェスト
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
