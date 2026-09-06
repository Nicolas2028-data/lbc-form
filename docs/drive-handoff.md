# Drive 整理 — 完了報告

2026-09-06 実施。Google Drive を **Nicolas のマイドライブに全面移行** し、Nicolas 100% 所有 + Lucas 共有(writer)の状態にした。

---

## 新構成

**ルート**: マイドライブ / `LBC整体院` (`1AQQy4wYowfAZQzPAATxCiSoBkapqdLKS`)

```
LBC整体院/
├── 01_運用/
│   ├── LBC台帳 [本番]          ← GAS の LEDGER_SPREADSHEET_ID(ID 不変)
│   ├── 患者画像/                ← GAS の DRIVE_FOLDER_ID(ID 不変)
│   │   ├── 人体図/  署名/  old/
│   └── old/
├── 02_ドキュメント/
│   ├── 設計資料/  報告資料/  old/
├── 03_マーケティング/
│   ├── 販促素材/
│   │   └── old/  (MOV × 4 + 店販 PNG を退避)
│   ├── Gifts Designs/
│   │   ├── Feed/ (3 PNG)  Story/ (3 PNG)
│   └── old/
├── 04_問診票資料/
│   ├── ネット問診票/ (問診票アイディア Doc + 人体図.png)
│   └── old/ (旧手書き問診票 Doc/PDF、Nome PNG × 2、空サブフォルダ)
└── old/
    ├── 旧LBC人体図_初期テスト_P003-P009/
    └── 売上/ (空)
```

## 影響

- **GAS: 影響ゼロ**。`LEDGER_SPREADSHEET_ID` `DRIVE_FOLDER_ID` はどちらも Nicolas 所有のため ID 不変
- **Lucas: 全て編集者権限で共有済み**。ルート `LBC整体院` にアクセス可

## 残タスク(任意)

1. **LUCAS-LOGO ショートカット** — 未対応。必要なら Drive UI で `03_マーケティング/` に作り直し
2. **DRIVE_FOLDER_ID の実値確認** — `gas/Code.js` に追加した `showDriveFolderId()` を GAS で実行して確認(gas-ops エージェント経由で clasp push)
3. **旧 STAGING #1**(現 `old/旧LBC人体図_初期テスト_P003-P009/`) — 台帳の P003-P009 が実患者データかテストかを確認、テストなら削除可
4. **旧 LBC整体院** (`1LbNj6X...`, Lucas 所有) — 放置方針。Lucas 側でいずれ削除するか判断

## 命名規則

- ルート直下は `01_` `02_` `03_` `04_` の連番プレフィックス(KMDS 記事に倣う)
- 各フォルダに必ず `old/` サブフォルダを設置
- 古くなったファイル・フォルダは同階層の `old/` へ隔離
- フォルダ名末尾のスペース禁止

新しいフォルダを追加するときも上記に従うこと。
