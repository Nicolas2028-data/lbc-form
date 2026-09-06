# 設計 — 顔認証機能 Phase 1

## 実装アプローチ

### 全体方針

- **フロントエンド完結型**: 顔検出・embedding 生成・照合はすべて iPad ブラウザで実行
- **GAS 側は保存/取得のみ**: embedding の write と read の 2 アクションだけ追加
- **既存フロー無改変**: 電話番号照合フローは変更せず、顔認証を「新しい入口」として追加

### データフロー

```
[初回問診票]
  1. 患者が電話番号入力 + 個人情報入力 + 顔登録同意(オプトイン)
  2. 同意時: フロントで顔検出 → 3枚の embedding を平均化 → 128次元 float 配列
  3. GAS submitAll に face_embedding パラメータを追加
  4. GAS: 顧客マスタの新規列に JSON 文字列として保存
  ↓
[再来院時の問診票]
  1. 「カメラで確認」ボタン(初回来院ボタンと並列)
  2. 押下 → フロントカメラ起動 → 顔検出
  3. GAS faceMatchList アクションで全 embedding を取得(active な顧客のみ)
  4. フロント側で euclideanDistance で全照合 → 最短距離 < THRESHOLD なら候補確定
  5. 候補が 1人: 「本人ですか?」確認 → 決定
  6. 候補が複数 or ゼロ: 電話番号照合フローへフォールバック
```

### face-auth-test.html からの主な変更点

| 項目 | プロトタイプ | Phase 1 |
|---|---|---|
| 保存先 | `localStorage` | 顧客マスタ face_embedding 列 |
| 取得 | `localStorage` | `getFaceEmbeddings` action で GAS 経由取得 |
| 登録画面 | 独立画面 | questionnaire.html の同意欄と統合 |
| 照合画面 | 独立画面 | questionnaire.html の再来院フロー冒頭に統合 |
| モデル URL | CDN 直リンク | 同じ(Phase 2 で Service Worker 検討) |
| 言語 | 日本語のみ | ja / es / pt |
| 閾値 | 0.5 | 0.5 で暫定(staging で調整) |

## 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `questionnaire.html` | 顔登録同意 UI + 顔認証ボタン + face-api.js 統合 |
| `i18n/ja.json` / `es.json` / `pt.json` | 顔認証関連 UI 文言 3言語 |
| `js/common.js` | 顔認証共通処理(embedding 生成・照合ヘルパー) |
| `gas/Code.js` | `submitAll` に face_embedding 保存追加、`getFaceEmbeddings` action 追加 |
| `SPEC.md` | 2章に顧客マスタの新規列 `face_embedding` を追記 |

## データ構造の変更

**顧客マスタタブ:** 末尾に 1 列追加
- 列名: `face_embedding`
- 列インデックス: 15(既存 15列の後)
- 型: JSON 文字列(128 個の float、区切りカンマ)
- 未登録者: 空文字
- CM 定義に追加: `face_embedding: 15`

**Notion 同期対象からは除外**(SPEC 11.5.2 より、embedding は表示不要)

**新 GAS アクション:** `getFaceEmbeddings`
- doPost で受ける(照合の高速化のため一括取得)
- 認証: **不要**(embedding は復元不能な数値。生画像でないので個人特定困難)
- 返却: `[{customerId, name, embedding}]` の配列(active な顧客のみ)
- レスポンスサイズ: 128 float × 30名 ≈ 15KB(問題なし)

## 影響範囲

- **questionnaire.html**: 新規 3画面追加(顔登録同意 / 顔認証画面 / 結果確認)
- **顧客マスタスキーマ**: 1 列追加(末尾なので既存コード無影響)
- **face-api.js 依存**: 新規外部依存(CDN)
- **iPad ブラウザ**: Safari 13+ 必須(WebRTC + WebGL 依存)
- **同期・Notion**: 影響なし(新列は sync 対象外)
- **予約フォーム(index.html)**: 完全に影響なし(触らない)

## SPEC.md 7原則との整合チェック

- [x] シートが正 / Notion は表示専用 — 変更なし
- [x] 台帳は追記専用 — 顧客マスタ列追加のみ、既存行の書き換えは既存の updateCustomerRow のみ
- [x] 冪等性 — submitAll には既存の requestId パスがあり、face_embedding パラメータは楽観的上書き
- [x] 認可はサーバー側 — 顔認証成功だけでは操作許可を与えず、必ず本人確認画面を挟む
- [x] SPEC 11.5.1: 既存パイプライン非汚染 — 別 doPost アクションで実装
- [x] SPEC 11.5.2: 生顔画像非保存 — フロント側で embedding 化して破棄
- [x] SPEC 11.5.3: オプトアウト — 電話番号照合フローを維持
- [x] SPEC 11.5.4: フォールバック — 候補ゼロ/複数時は電話番号へ
- [x] SPEC 11.5.7: GAS 6分制限 — フロント側完結、GAS はサイズの小さい JSON I/O のみ

## 検討した他の案

| 案 | 採用しなかった理由 |
|---|---|
| GAS 側で embedding 比較 | 6分制限で 30名超えると危険。フロント完結が正解 |
| MediaPipe FaceMesh | 精度は高いがモデルサイズ大(数十MB)。iPad で読み込み遅い |
| Notion に embedding 保存 | Notion API のレート制限を圧迫。Sheets が適切 |
| localStorage 継続使用 | 端末変更時にデータ喪失。中央管理が必須 |
| 認証 API に統合(auth ゲート) | 顔認証は「本人特定」であって「認可」ではない。既存の password 認可とは別レイヤ |

## セキュリティ考慮

- **face_embedding は個人情報**(照合可能なため PII 扱い)
- 顧客マスタタブのアクセス権は既存通り(Nicolas / Lucas のみ)
- getFaceEmbeddings API は認証不要だが、embedding のみ返却(氏名+customerId は含めるがマスキングは不要 — Lucas しか iPad を扱わない前提)
- **要判断:** getFaceEmbeddings に password 認証を付けるか?→ 患者側 iPad で毎回パスワード入力は非現実的なので付けない方針だが security エージェントに相談推奨

## 段階リリース

1. staging(ENV=staging + STAGING_LEDGER)で Nicolas + Lucas 2名テスト
2. 誤認識率・処理時間を計測(目標: 認識 3秒以内、精度 90%以上)
3. 閾値を staging データで調整
4. Lucas から親しい患者 3〜5名に協力依頼して実運用テスト
5. 問題なければ本番切替
