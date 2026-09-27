# 別PCでの続行ガイド（Notion内完結 記録フロー）

**作成: 2026-09-27 / このファイルだけ読めば続きを再開できる**

---

## STEP 0: 別PCのClaude Codeにそのまま貼るプロンプト

```
LBC Care プロジェクトの続きをやります。私は Nicolas Ventura
(v.nico2003@gmail.com / GitHub: Nicolas2028-data)。

まず状況把握:
1. リポジトリ ~/Development/lbc-care（無ければ
   git clone https://github.com/Nicolas2028-data/lbc-form.git lbc-care）
2. .steering/20260927-notion-native-record/ の requirements.md /
   design.md / tasklist.md / このファイル(CONTINUE-ON-OTHER-PC.md) を読む
3. Google Drive のハンドオフフォルダ(1ixFrYkQY4PxpXUpiUcKPmp1Nc5yof01T)も参照

やりたいこと（Notion内で完結する記録フロー）:
- 2回目以降の客は何もしない。ルカスがNotionで顧客を開き、施術カルテ
  リレーションの「＋新規」でカルテ作成→前回から変化/コース/売上等を入力。
- お金の計算はシート台帳=正のまま、GASが裏でNotion→シート取込＆計算＆書き戻し。

次にやるのは design.md の「案N」のGASバックエンド実装（tasklist.md 参照）。
進行方針: 全権譲渡。本番デプロイ(clasp push+deploy)の直前だけ1行通知。
```

---

## 現在の状態（2026-09-27 時点）

### 完了・本番反映済み
- リポジトリ最新コミット: **3255b5d**（このガイド追加時点。要 `git log` 確認）。
- GAS本番デプロイ: **@123**（デプロイID AKfycbxCBqtgb...QfX06PQ、URL不変）。
- treatment-record.html に「前回から変化 なし/あり」トグル追加済（commit c6c5eb9）。
- GAS: 施術メモ先頭に【変化なし/変化あり】記録＋syncTreatmentでNotion「前回から変化」反映済。
- Notion 施術カルテDBに「前回から変化」select 追加済（MCP）。
- Notion 顧客管理DBに数式リンク「▶ 記録する」追加済（→ただし方針転換で保留。消してよい）。

### 方針（ユーザー確定）
- **サイト(Webアプリ)に飛ばずNotion内で完結**したい。
- ボタン/オートメーションはUI専用で、現Windows環境はNotionのブラウザ操作スクショが真っ黒で作成困難。
  → **別PC（画面が見える環境）でならUI手作業でButton/テンプレート作成が可能**。design.md 末尾に手順あり。
- ボタン無しでも「顧客ページ→施術カルテ リレーション→＋新規」で今すぐNotire内完結は可能。

---

## 次にやるタスク（優先順）

1. **（別PCで画面が見えるなら）Notion UIで整備**
   - 施術カルテDBに**データベーステンプレート**作成（ステータス=🔴未記録 既定、日付=今日を促す）。
   - もしくは顧客管理DBに**ボタン**「本日カルテ作成」(design.md 手順)。
   - Notionカルテに「本日の未記録」ビュー作成。

2. **GASバックエンド実装（案N・Claudeがコードで実施可）**
   - `pollNotionKarte()` を新設: 施術カルテDBを定期読取 → ステータス=✅完了 かつ 未取込 のカルテを検出。
   - 施術台帳シートへ記録 → クレジット残高/紹介上限3件/売上を計算 → Notionへ書き戻し。
   - 冪等性: Notion page_id を施術台帳 notion_page_id と突合（重複取込防止）。
   - 既存の handleSubmitTreatmentRecord / syncTreatment / computeCreditBalance / countReferralGrants を再利用。
   - 時間トリガー登録（例5分毎）。staging で検証してから本番。

3. **数式リンク「▶ 記録する」の後始末**（残す/消す判断）。

4. **実機E2Eテスト**（テスト顧客 P008 / P031）→ ルカスへ運用説明。

---

## 環境セットアップ（別PCが新規の場合）
- Doc 09「全コード移植チェックリスト」/ Doc 07「別PCセットアップ手順」に従う。
- 要: Node20+ / git / clasp（`npm i -g @google/clasp` → `clasp login` で v.nico2003）。
- MCP認証: Notion / Google Drive を接続。
- ⚠️ GitHub認証は **Nicolas2028-data** アカウントで（別アカウントだと push が403）。
- ⚠️ macなら手順そのまま。Windowsは PowerShell 読み替え・PATH再読込に注意（memory参照）。

## 主要ID
| 対象 | ID |
|---|---|
| GAS Script | 1DWGR2YgD6nZejBB6ak8fDHwvwvEtsBBokb7TacvsjZK-DHtsJRyMhixc |
| GAS本番デプロイ | AKfycbxCBqtgbRKjKHwynwzb7NkZyjujoocCWRbHsMggiJg30myE9l6xIoQmc46xcw-QfX06PQ (@123) |
| 顧客管理DB (data source) | ab06aa76-cac8-454f-8bfd-d829bd7f59dd |
| 施術カルテDB (data source) | 74a75dcc-9470-46e7-b3f8-a4538e6ef34e |
| Notionダッシュボード page | 35388446-d062-811e-ba98-c07c12ac1e8d |
| LBC台帳 Sheet | 1UL1kU7_Am-EzXGcDFoFMwgVT5UM18ifUSzVxo9HUiBQ |
| Driveハンドオフフォルダ | 1ixFrYkQY4PxpXUpiUcKPmp1Nc5yof01T |

## 注意点（ハマりどころ）
- Notion「診察番号」= customer_id（P001..）。同一。
- ボタン・オートメーション・DBテンプレートは Notion UI専用（API/MCP作成不可）。
- 数式 `link()` はAPIで作れるがiPadタップ挙動が不安定だった（予約サイトへのキャッシュ事象）。
- お金ロジックは必ずシート台帳=正。Notionは表示＋入口。逆同期はGASが冪等に。
