# 設計 — 顔認証廃止と来店フロー刷新

作成日: 2026-09-26

---

## 実装アプローチ

### 全体方針

- **既存のシート台帳 → Notion 一方向同期の設計原則を維持**
- **顔認証を全廃止し、電話番号+氏名照合に一本化**
- **来店ログを独立タブとして新設**(施術台帳とは分離、赤伝との整合を維持)
- **施術記録シートに施術有無トグルを追加**(no-show を明示化)
- **Notion 側にルカス向けの視認性の高いダッシュボードを再構築**

### データフロー(新)

```
[初回問診票]
  1. 患者が電話番号+氏名+全項目入力 → 送信
  2. GAS: customers に append + 施術台帳に record(status=received)
  3. GAS: 来店ログに append(status=received, recorded_at=空)
  4. 1分毎トリガーで Notion 同期
  ↓
[再来院問診票]
  1. 患者が電話番号+氏名だけ入力 → 照合
  2. 照合成功 → 「本人ですか?」確認 → 送信
  3. GAS: 来店ログに append(status=received, recorded_at=空)
  4. 1分毎トリガーで Notion 同期
  ↓
[Notion で未記録リスト確認]
  ルカスが Notion ダッシュボードを開く
  → 未記録ビュー(Board View)に該当患者が表示される
  → 「📝 記録する」リンクをクリック → treatment-record.html が事前入力で開く
  ↓
[施術記録シート]
  1. 「施術を受けた」/「受けなかった」を選択
  2a. 受けた → 通常の記録入力 → 送信 → 台帳に record 行(status=completed)
  2b. 受けなかった → 理由入力 → 送信 → 台帳に record 行(status=no_show)
  3. GAS: 同日・同 customer_id の来店ログを検索 → recorded_at + record_id + no_show_reason 更新
  4. 1分毎トリガーで Notion 同期 → 未記録ビューから消える
```

---

## 変更するファイル

### 削除するファイル

| ファイル | 備考 |
|---|---|
| `face-auth-test.html` | プロトタイプ、参考用 |
| `palm-auth-test.html` | プロトタイプ、参考用 |

### 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `questionnaire.html` | 顔認証 UI 全削除、Kiosk unlock 削除、送信後メッセージ改善 |
| `treatment-record.html` | 「施術有無」トグル追加、理由入力欄追加、URL パラメータ受け取り拡張、送信後メッセージ改善 |
| `gas/Code.js` | 顔認証関数削除、来店ログ書き込み追加、recorded_at 更新ロジック追加、normalizeName 追加、自動補完 + 通知 |
| `i18n/ja.json` | 顔認証キー削除、施術有無トグル文言追加 |
| `i18n/es.json` | 同上(問診票側のみ、施術記録シートは日本語のみ) |
| `i18n/pt.json` | 同上 |
| `js/common.js` | 顔認証ヘルパー削除 |
| `SPEC.md` | 11.5 顔認証セクション削除、来店ログタブスキーマ追記、Notion DB 一覧に来店ログ DB 追加 |
| `docs/manual-lucas.md` | 顔認証手順削除、未記録リストの見方追加、no-show 記録手順追加 |
| `dashboard.html` | 影響なし(既存維持) |
| `service-worker.js` | face-api.js キャッシュ削除(あれば) |
| `manifest.json` | 影響なし |

---

## データ構造

### シート: `来店ログ` タブ(新設)

| 列 | 列名 | 型 | 説明 |
|---|---|---|---|
| 1 | `checkin_id` | string (UUID) | 主キー、冪等性用 |
| 2 | `customer_id` | string | 顧客ID |
| 3 | `customer_name` | string | 顧客氏名(照合時点の値をスナップショット) |
| 4 | `phone_normalized` | string | 正規化済み電話番号 |
| 5 | `checkin_at` | datetime | 来店(問診票送信)時刻 |
| 6 | `checkin_date` | date | 来店日(YYYY-MM-DD) |
| 7 | `entry_type` | string | `initial`(初回) / `revisit`(再来院) / `auto_backfill`(自動補完) |
| 8 | `status` | string | `received` / `recorded` / `no_show` |
| 9 | `recorded_at` | datetime | 施術記録完了時刻(空=未記録) |
| 10 | `record_id` | string | 対応する施術台帳の record_id |
| 11 | `no_show_reason` | string | 施術を受けなかった理由 |
| 12 | `treatment_record_url` | string | 事前入力済みリンク |
| 13 | `updated_at` | datetime | 更新時刻 |
| 14 | `synced_at` | datetime | Notion 同期時刻 |
| 15 | `notes` | string | 予備 |

- 保護設定: シート編集は Nicolas / Lucas のみ
- onEdit トリガー対象: `updated_at` を自動更新
- 同期対象: `updated_at > synced_at` のレコードを Notion 来店ログ DB に upsert

### シート: `customers` タブ

- `face_embedding` 列 → **物理削除 or 空文字化**(Nicolas 判断)
  - 推奨: 空文字化(スキーマ変更なし、GAS の CM 定義から未使用に降格)
  - 物理削除する場合は列インデックスがずれるため、CM 定義と全参照箇所の更新が必要

### シート: `施術台帳` タブ

- `status` 列に `no_show` 値が入り得る(既存は `received` / `completed` / `void` / `correction`)
- `count_eligible` は `no_show` の場合 FALSE(売上・来院数集計から除外)
- 既存スキーマの変更なし

### Notion: `来店ログ` DB(新設)

**プロパティ:**

| プロパティ名 | 型 | 説明 |
|---|---|---|
| 顧客名 | Title | Sheet の customer_name |
| 状態 | Status | 色付きラベル: 🔴未記録(赤) / ✅済(緑) / ⚫施術なし(灰) |
| 来店 | Date | checkin_at |
| 経過 | Formula | `if(dateBetween(now(), prop("来店"), "days") == 0, "🟢 本日", if(...) )` |
| 📝 記録する | URL | treatment_record_url |
| メモ | Text | no_show_reason |
| checkin_id | Text (hidden) | GAS 同期用の一意キー |

**ビュー:**

| ビュー名 | タイプ | フィルタ | ソート | グループ化 |
|---|---|---|---|---|
| 🔴 未記録 | Board (カンバン) | `状態 = 未記録` | 来店 昇順 | 経過 (本日 / 1日経過 / 2日以上) |
| 📅 今日の来店 | Gallery | `checkin_date = today` | 来店 昇順 | なし |
| 📊 全履歴 | Table | なし | 来店 降順 | なし |

### Notion: ダッシュボードページ再構成

```
[Cover Image: LBC ブランド カバー]
[Icon: 🌿]

# 📋 LBC 運用ダッシュボード

/callout (色: yellow, 大きめ)
  🔥 TODAY
  🔴 未記録: [Rollup or 手動 formula で表示]
  ✅ 済: [同上]
  ⚫ 施術なし: [同上]

## 🚨 未記録リスト
[来店ログ DB を「🔴 未記録」ビューで埋め込み]
(空のとき: 🎉 ALL DONE! callout)

## 📅 今日の来店
[来店ログ DB を「📅 今日の来店」ビューで埋め込み]

## 📊 数字で見る運用
[dashboard.html 埋め込み]

## 👥 顧客マスタ
[既存 DB]

## 📋 施術カルテ
[既存 DB]
```

---

## GAS の変更点(詳細)

### 削除する関数

- `handleGetFaceEmbeddings`
- `handleMatchFace`
- `handleSaveFaceEmbedding`(存在すれば)
- `handleHasFaceEmbedding`(存在すれば)
- 上記への doPost 分岐

### 追加する関数

**`appendCheckinLog(customerId, customerName, phoneNormalized, entryType)`**
- 来店ログに 1行追加
- checkin_id は Utilities.getUuid()
- status=received、recorded_at=空
- treatment_record_url を組み立てて格納

**`updateCheckinLogOnRecord(recordId, customerId, treatmentDate, status, noShowReason)`**
- 同日・同 customer_id の未マッチ(recorded_at 空)な来店ログを古い順に検索
- 見つかれば recorded_at, record_id, status, no_show_reason を更新
- 見つからなければ appendCheckinLog(entry_type=auto_backfill) で補完 + NOTIFY_EMAIL に通知

**`normalizeName(name)`**
- 全角スペース → 半角スペース
- 前後トリム
- 連続スペース → 1つ
- 表記揺れ対策(旧字体対応は今回スコープ外)

### 変更する関数

**`handleSubmitAll` (初回問診票)**
- 既存の appendCustomer + 施術台帳 append の後、`appendCheckinLog(cid, name, phone, 'initial')` を呼ぶ

**`handleMatchByPhone` (再来院照合)**
- 電話番号+氏名(normalizeName 適用)で照合
- 一致確認後の送信フローで `appendCheckinLog(cid, name, phone, 'revisit')` を呼ぶ

**`handleSubmitTreatmentRecord` (施術記録受信)**
- 既存の record 追記の後、`updateCheckinLogOnRecord(recordId, cid, date, status, reason)` を呼ぶ
- status は「受けた」→ completed、「受けなかった」→ no_show

**`syncToNotion`**
- 既存の顧客マスタ・カルテ同期に加えて、来店ログ DB への upsert を追加
- `updated_at > synced_at` のレコードのみ処理

### スクリプトプロパティ追加

- `NOTION_CHECKIN_DB_ID` — Notion 来店ログ DB の ID(staging / production 両方)
- `STAGING_NOTION_CHECKIN_DB_ID`

---

## フロントエンドの変更点(詳細)

### `questionnaire.html`

**削除:**
- 顔登録同意チェックボックス + 説明
- 顔認証カメラ起動 UI
- Kiosk unlock (4連タップ + staff password モーダル)
- face-api.js CDN 読み込み
- 顔認証照合モーダル

**変更:**
- 送信完了画面: 「✅ 送信しました。ありがとうございます。」→ 「✅ 送信しました。ルカスが Notion で確認します。」(内部向けなので消しても可)
- 再来院照合: normalizeName を通して送信

### `treatment-record.html`

**追加:**
- URL パラメータ受け取り: `?customer_id=xxx&name=yyy&phone=zzz` を読んで氏名・電話番号を事前入力
- 施術有無トグル(ラジオボタン、最上部)
  - 「✅ 施術を受けた」→ 通常の記録入力(既存 UI)
  - 「⚫ 施術を受けなかった」→ 施術内容欄を非表示、理由入力欄を表示
- 送信ペイロードに `attended: true/false` と `no_show_reason` を追加
- 送信後メッセージ: 「✅ 記録しました。1分以内に Notion に反映されます」

### `i18n/{ja,es,pt}.json`

**削除:**
- `face_*` プレフィックスのキー全般

**追加(問診票の再来院フロー):**
- 特になし(既存の電話番号照合文言で十分)

**施術記録シートの追加(日本語のみ):**
- `attended_yes`: "✅ 施術を受けた"
- `attended_no`: "⚫ 施術を受けなかった"
- `no_show_reason_label`: "理由(急用でお帰り、体調不良で中止など)"
- `submitted_message`: "✅ 記録しました。1分以内に Notion に反映されます"

---

## 影響範囲

| 領域 | 影響 |
|---|---|
| **予約フォーム (index.html)** | 影響なし(触らない) |
| **問診票 (questionnaire.html)** | 顔認証削除で JS 軽量化 + UI シンプル化 |
| **施術記録 (treatment-record.html)** | 施術有無トグル追加、URL パラメータ対応 |
| **GAS (gas/Code.js)** | 顔認証削除 + 来店ログ関連追加 |
| **シート台帳** | `来店ログ` タブ新設、`face_embedding` 列の扱い決定 |
| **Notion** | 来店ログ DB 新設、ダッシュボードページ再構成 |
| **同期トリガー** | syncToNotion に来店ログ処理を追加(処理時間微増) |
| **ダッシュボード (dashboard.html)** | 影響なし |
| **PWA (manifest.json / service-worker.js)** | face-api.js キャッシュ削除のみ |
| **3言語 (i18n)** | 顔認証キー削除、施術記録シートの文言追加(日本語のみ) |

---

## SPEC.md 原則との整合チェック

- [x] **シートが正 / Notion は表示専用** — 来店ログもシート → Notion の一方向同期のみ
- [x] **台帳は追記専用(訂正は赤伝)** — 来店ログの recorded_at 更新は SPEC 3.5 の「集計対象フラグ更新」相当の限定編集として許容
- [x] **冪等性** — checkin_id (UUID) で来店ログの重複防止、既存 requestId は問診票側で維持
- [x] **認可はサーバー側** — 施術記録シートは既存の STAFF_PASSWORD 認可を維持
- [x] **`index.html` 不可触** — 変更なし
- [x] **予約系 API 不可触** — 変更なし
- [x] **ID・パスワードのハードコード禁止** — 新規プロパティは getConfig() 経由

---

## 検討した他の案(不採用)

| 案 | 不採用理由 |
|---|---|
| 施術台帳に相乗り (status=received 行を追記) | 赤伝ロジックが複雑化。独立タブが clean |
| 予約データを来店シグナルにする | 予約 ≠ 来店(no-show あり)。問診票の方が確実 |
| Notion 側で formula/relation で判定 | Notion 側の保守負担増。GAS 一元化が明快 |
| Notion → シート逆同期(ルカスが Notion で編集) | シートが正の原則を破壊。将来的にも避ける |
| 未記録は「今日のみ」表示 | 書き忘れ検知の目的と相反する |
| 名前を照合キーに含めない(電話番号のみ) | 家族で電話共有パターンでの誤照合リスク |

---

## セキュリティ考慮

- 来店ログ DB の Notion 共有設定は既存 DB と同じ(Nicolas + Lucas のみ)
- treatment_record_url に customer_id, name, phone を含む → **Notion カルテは非公開だが、URL 単体がスクショで漏れる可能性はあり**
  - リスク許容(社内利用のみ、iPad は物理的にルカス管理下)
  - 将来的な改善案: 短命トークン方式(URL に UUID を含め、GAS 側で照合)
- 顔認証削除に伴い、face-api.js CDN 依存を排除 → セキュリティ面ではプラス
- `face_embedding` の PII 削除: 物理削除選択時は個人情報保護観点で望ましい

---

## Nicolas への確認事項(実装時)

1. **`face_embedding` 列の削除方式** — 物理削除 or 空文字化?
2. **Notion 来店ログ DB の作成** — Nicolas が Notion 側で DB を作って ID を取得 → GAS スクリプトプロパティに設定
3. **ダッシュボードページのカバー画像** — 既存の LBC ロゴ or 新規デザイン?
4. **staging → 本番切替のタイミング** — 全機能揃ってからか、機能ごとの段階リリースか
