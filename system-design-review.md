# LBC Care システム設計 — 査定用ドキュメント

## 0. プロジェクト概要

**LBC Care（Lucas Body Care）**
三重県四日市市の整体院。術者はルカス（ブラジル人）。顧客は日本人・ブラジル人・スペイン語話者が混在。

**目的:** 予約・問診・施術記録のオンライン化。多言語対応（ja / es / pt）。

**課題（Before）:** 紙の問診票、バラバラな予約経路、売上記録なし。

---

## 1. サイト・リンク一覧

| リソース | URL |
|---------|-----|
| **予約フォーム** | https://nicolas2028-data.github.io/lbc-form/index.html |
| **問診票** | https://nicolas2028-data.github.io/lbc-form/questionnaire.html |
| **施術記録シート** | https://nicolas2028-data.github.io/lbc-form/treatment-record.html |
| **GAS バックエンド** | `https://script.google.com/macros/s/AKfycbxCBqtgbRKjKHwynwzb7NkZyjujoocCWRbHsMggiJg30myE9l6xIoQmc46xcw-QfX06PQ/exec` |
| **Notion: 顧客マスタ DB** | https://app.notion.com/p/bafca36866c74bb7812965c2e966cd51 |
| **Notion: 施術カルテ DB** | https://app.notion.com/p/1fe16e73641344d5ba61a56cd235b7b5 |
| **Notion: LBC ダッシュボード（親ページ）** | https://app.notion.com/p/35388446d062811eba98c07c12ac1e8d |

---

## 2. システムアーキテクチャ

```
[ユーザー / iPad]
       │
       ├─ index.html（予約フォーム）          GitHub Pages で静的ホスト
       ├─ questionnaire.html（問診票）         （SSL, CDN, 無料）
       └─ treatment-record.html（施術記録）
               │
               │  fetch POST / GET（CORS: GAS Webアプリ）
               ▼
      [Google Apps Script]
        gas/Code.gs（1,138行）
               │
        ┌──────┼──────────┐
        ▼      ▼          ▼
  [Notion API] [Google Drive] [Gmail]
  顧客マスタDB  人体図・署名PNG  予約確認メール
  施術カルテDB  /preview URL経由
```

**認証:** GAS は「全員アクセス可能」のウェブアプリとして公開。スタッフ機能（施術記録）はパスワード認証（`STAFF_PASSWORD` スクリプトプロパティ）のみ。Notion API トークンはスクリプトプロパティで管理。

---

## 3. ファイル構成

| ファイル | 役割 | 行数 |
|----------|------|------|
| `index.html` | 予約フォーム（ja/es/pt 多言語） | 2,855 |
| `questionnaire.html` | 問診票（ja/es/pt、iPad 運用） | 2,126 |
| `treatment-record.html` | 施術記録シート（日本語のみ、ルカス専用） | 1,237 |
| `gas/Code.gs` | GAS バックエンド全関数 | 1,138 |
| `body-diagram.png` | 人体図 Canvas 背景画像 | — |

---

## 4. GAS バックエンド — API エンドポイント一覧

### POST アクション

| action | 説明 |
|--------|------|
| `lookupPatient` | 名前＋電話番号で顧客マスタを照合 |
| `submitBooking` | 予約フォームからの予約送信（顧客作成 or 更新 + カルテ作成 + 確認メール） |
| `submitAll` | 問診票送信のメインエントリ（顧客作成/更新 + カルテ作成 + 問診ブロック追記 + 画像保存） |
| `submitQuestionnaire` | 予約経路不明のスタンドアロン問診票送信 |
| `submitTreatmentRecord` | 施術記録シートからの施術完了記録（コース・売上・クレジット処理） |

### GET アクション

| action | 説明 |
|--------|------|
| `getSlots` | 月単位の空き時間取得（予約カレンダー表示用） |
| `verifyStaff` | スタッフパスワード検証 |
| `getPatientList` | 患者一覧取得（施術記録シートの患者選択用。当日未記録フラグ付き） |
| `getPatientDetails` | 個別患者詳細（クレジット残高・来院回数・初回判定・有効期限切れクレジット） |
| `?date=&callback=` | JSONP（カレンダーグレーアウト用、レガシー） |

---

## 5. Notion データベース設計

### 顧客マスタ（`👥 顧客マスタ`）

| プロパティ | 型 | 備考 |
|-----------|-----|------|
| 名前 | title | |
| 診察番号 | text | P001, P002... |
| フリガナ | text | |
| 電話番号 | phone_number | |
| メールアドレス | email | |
| 生年月日 | date | |
| 初回訪問日 | date | |
| 言語 | select | ja / es / pt |
| 来院のきっかけ | multi_select | 口コミ/Instagram/紹介/看板/その他/Google Maps/Google |
| 住所 | text | |
| クレジット残高 | number（¥） | 紹介割引の蓄積 |
| クレジット詳細 | text | JSON文字列でFIFO管理 `[{date, amount}]` |
| 施術カルテ | relation | → 施術カルテ DB（逆リレーション） |
| 累計来院回数 | rollup（count） | 自動集計 |
| 最終来院日 | rollup（最新日） | 自動集計 |

**ビュー:** Default / 顧客検索 / 来院頻度

### 施術カルテ（`📋 施術カルテ`）

| プロパティ | 型 | 備考 |
|-----------|-----|------|
| 名前 | title | `{患者名} (yyyy/MM/dd)` 形式 |
| 日付 | date | 受診日（GASが自動設定） |
| 予約日 | date | 予約日（グレーアウト用） |
| 予約時間 | text | HH:mm |
| ステータス | status | 未着手 / 進行中 / 完了 |
| コース | select | カイロプラクティック / 筋膜リリース / 吸い玉・カッピング / トータルケア / 未定 / 月2回コース |
| 対応言語 | select | 日本語 / Português / Español |
| 問診票 | checkbox | 提出済みフラグ |
| 売上金額 | number（¥） | 施術記録シートで入力 |
| 支払い方法 | select | 現金 / カード / PayPay / 未払い |
| 施術メモ | text | 施術記録シートで入力 |
| クレジット使用額 | number（¥） | |
| 紹介者名 | text | |
| 紹介割引適用 | checkbox | |
| 顧客マスタ | relation | → 顧客マスタ DB |

**ビュー:** Default / 今日の予約 / 今週の予約 / ステータス管理（Board） / 予約カレンダー / 今月の予約 / 問診票未提出

**ページ本文:** `appendQuestionnaireBlocks()` で問診内容をブロックとして追記（人体図・署名画像埋め込み含む）

---

## 6. 主要ビジネスロジック

### 顧客識別フロー
```
予約フォーム → email で顧客検索 → なければ新規作成
問診票       → 名前＋電話番号で照合 → あれば情報更新、なければ新規作成
施術記録     → customerId 直接渡し（frontend から）
```

### カルテ作成タイミング
- **予約時:** コース未確定でカルテ作成（問診票フラグ=false）
- **問診票送信時:** カルテ作成 + 問診ブロック追記（問診票フラグ=true）
- **施術記録時:** 当日カルテがなければ作成、あればコース・売上・メモを上書き

### コース選択の設計判断
- 問診票ではコース選択を非表示
- 施術記録シートでコースを確定 → カルテに書き込む
- Notion `コース` の有効値は `VALID_COURSES` で厳密にチェック（不正値は送らない）

### 診察番号生成
- 既存最大番号を取得し +1（`P001`, `P002`... 形式）
- 先着順で重複なし

### クレジット管理
- 付与: 紹介1人 = ¥1,000（施術完了時に紹介者に付与）
- 消費: FIFO（古い順に消費）
- `クレジット詳細` に JSON 文字列で履歴管理
- 60日以内に期限切れになるクレジットはフロントエンドに通知

---

## 7. 画像保存フロー（最新実装）

```
問診票 Canvas
  ├─ 人体図（Canvas toDataURL → base64 PNG）
  └─ 署名（Canvas toDataURL → base64 PNG）
         │
         │  GAS POST（submitAll）
         ▼
  saveBodyImage() in Code.gs
  ├─ base64 → Blob → Google Drive に PNG保存
  ├─ Drive ファイルを「リンクを知っている人」に共有設定
  └─ URL: https://drive.google.com/file/d/{id}/preview
         │
         ▼
  appendQuestionnaireBlocks()
  └─ embed ブロックとして Notion カルテページに埋め込み
```

**変遷履歴（直近コミット）:**
1. Notion File Upload API → Drive PDF → Drive PNG + `/preview` URL（現在）

---

## 8. スクリプトプロパティ（GAS 秘匿設定）

| キー | 値 |
|------|----|
| `NOTION_TOKEN` | Notion API トークン（`ntn_...`） |
| `CUSTOMER_DB_ID` | `bafca368-66c7-4bb7-8129-65c2e966cd51` |
| `KARTE_DB_ID` | `1fe16e73-6413-44d5-ba61-a56cd235b7b5` |
| `DRIVE_FOLDER_ID` | `1wbZ-dYw7doDdPk0mYHR-jLfJJL3JCgNk` |
| `STAFF_PASSWORD` | 施術記録シートのパスワード |
| `SITE_URL` | `https://nicolas2028-data.github.io/lbc-form` |

---

## 9. ビジネス情報

| 項目 | 内容 |
|------|------|
| 現在の月間顧客数 | 約6人 → 目標12人 |
| 月2回プラン | トータルケア×2 = ¥10,000（3名利用中） |
| 月3回プラン | 1名 |
| 紹介割引 | 1人紹介 = ¥1,000クレジット（最大3人分） |
| 決済端末 | 導入予定（審査約2ヶ月） |
| 長期目標 | LBCメソッドを教えるビジネス・チェーン展開 |

---

## 10. 開発フェーズ

- **Phase 1（現在）:** 問診票 + 施術記録の手動運用基盤 → ほぼ完成
- **Phase 2（今年末〜来年）:** AI予約・プランカウント管理・紹介割引自動化

---

## 11. 既知の課題・ペンディング

- 顧客照合が「名前の完全一致 + 電話番号」の単純比較のみ（表記揺れ・重複に弱い）
- GAS ウェブアプリが「全員アクセス可能」→ STAFF_PASSWORD のみが唯一のアクセス制御
- Drive `/preview` URL を Notion embed に使っているが、Notion の embed 表示はサービス依存で不安定なリスクがある
- 診察番号の採番がNotionへの最大値クエリに依存 → 並列リクエスト時の重複リスクが理論上存在
- クレジット有効期限が `addCredit()` 時に保存されず、`getPatientDetails()` で動的計算している → 付与日から1年固定

---

## 査定用プロンプト（別AIへの貼り付け用）

```
あなたはWebシステムのアーキテクチャ査定の専門家です。
以下のシステム設計ドキュメントを読み、下記の観点で詳細な査定を行ってください。

【背景】
三重県四日市市の小規模整体院（LBC Care）のオペレーション管理システムです。
月6〜12人規模。術者1人（ルカス）が施術し、開発者（ニコラス）が技術を担当。
多言語対応（日本語・スペイン語・ポルトガル語）が必要。

【査定観点】
1. アーキテクチャ全体 - 技術スタック（GitHub Pages + GAS + Notion API）の妥当性と限界。スケールや将来性への懸念。
2. データフロー - フォーム→GAS→Notion の設計に論理的な矛盾・ボトルネック・抜け漏れがないか。
3. セキュリティ - GASが全員公開、スタッフ認証がパスワードのみ、Notion トークンの管理、Drive画像の公開設定など。リスクの深刻度と対処の優先順位。
4. データ整合性 - 診察番号の採番競合リスク、クレジット管理のFIFO実装、顧客照合の堅牢性（表記揺れ等）。
5. 運用リスク - GASの実行制限（6分/クォータ）、Notion APIレート制限、Drive embed の安定性。
6. コードの保守性 - 1ファイルで1,100行超のGAS、HTML 3ファイルが2,000行超。現状の規模感で問題になる局面があるか。
7. Phase 2に向けた懸念 - AI予約・プランカウント管理・紹介割引自動化を追加する際に、現在の設計で詰まりそうな箇所。

【出力形式】
- 観点ごとに「問題の深刻度（高/中/低）」と「具体的な改善案」を示してください
- 現在の規模（月6〜12人）では問題にならないが将来問題になる点は明示して分けてください
- 良い設計判断についても評価してください（批判だけでなくバランスよく）

【システム設計ドキュメント】
（↑このファイルの内容を貼り付けてください）
```
