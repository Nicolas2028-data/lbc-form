# タスクリスト — 顔認証機能 Phase 1

## 進捗

0 / 18 完了

## タスク

### Phase A: GAS 側の準備(バックエンド先行)

- [x] A-1. `SPEC.md` 2.1 の顧客マスタ表に `face_embedding` 列を追記(2026-09-06)
- [x] A-2. `gas/Code.js` の CM 定義に `face_embedding: 15` を追加
- [x] A-3. `SHEET_DEFS['顧客マスタ']` のヘッダー配列末尾に `'[顔認証]'` を追加
- [x] A-4. 本番 顧客マスタシートに列追加(applySheetHeaders 実行で自動化、lastCol=16 確認済)
- [x] A-5. `appendCustomer` および `handleUpdateCustomerInfo` に `data.faceEmbedding` 受け取り追加(handleSubmitAll → appendCustomer 経由で自動)
- [x] A-6. `handleGetFaceEmbeddings` 実装(staff password 必須で customerId+name+embedding 返却)
- [x] A-7. `doPost` に `getFaceEmbeddings` action 追加
- [x] A-8. 本番 push + 疎通確認(GAS @76、ヘッダー migration 成功)

### Phase B: フロント側 — 初回登録のみ実装(2026-09-06)

- [x] B-1. `i18n/ja.json` `es.json` `pt.json` に顔認証関連文言 15 キー追加
- [x] B-2. `questionnaire.html` に face-api.js CDN の lazy-load 実装(同意時のみ読み込み)
- [x] B-3. 初回来院フローに「顔登録同意」チェックボックス追加、未成年(18歳未満)は自動で非表示
- [x] B-4. 顔登録画面:カメラ起動 → 3枚キャプチャ → 128次元 float 平均化 → `Q.faceEmbedding` に保存 → `submitAll` payload に追加
- [ ] B-5〜B-8: **Phase C へ延期**(照合フローは kiosk password unlock UI が必要で別工数)

### Phase C: フロント側 — 再来院時の顔認証照合(未着手)

- [ ] C-Fa-1. Kiosk mode: 朝一 staff password 入力 → sessionStorage 保持 UI
- [ ] C-Fa-2. 再来院フロー冒頭に「📸 カメラで確認」ボタン(電話番号入力の上)
- [ ] C-Fa-3. face-api.js で embedding 生成 + `getFaceEmbeddings` API 呼出(staff password 添付)
- [ ] C-Fa-4. euclideanDistance で全照合 → 候補確定(THRESHOLD 未満で最短)
- [ ] C-Fa-5. 候補確認モーダル(名前表示 + はい/いいえ)、いいえで電話番号照合へフォールバック
- [ ] C-Fa-6. `js/common.js` に共通ヘルパー抽出(現状は questionnaire.html 内)

### Phase C: テスト・検証(face-auth-specialist + tester)

- [ ] C-1. staging で Nicolas + Lucas の顔登録
- [ ] C-2. 認識精度・処理時間の測定レポート作成(整体院の照明を再現)
- [ ] C-3. staging で THRESHOLD 調整(0.4 / 0.5 / 0.6 で比較)
- [ ] C-4. 3言語 UI の目視確認(問診票 3画面 × 3言語)

### Phase D: 本番切替(条件付き)

- [ ] D-1. Lucas から親しい患者 3〜5名に協力依頼(協力得られない場合は次期)
- [ ] D-2. 本番顧客マスタに face_embedding 列を手動追加(Nicolas 作業)
- [ ] D-3. `gas/Code.js` を本番デプロイ(gas-ops → clasp deploy -i {本番ID})
- [ ] D-4. 実患者テスト → SPEC.md 11.5.5 のプライバシー審査完了

## 完了条件

- Nicolas / Lucas 環境で 90% 以上の認識精度を staging で確認
- 3言語 UI が全画面で表示される
- 顔認証を使わない患者フロー(電話番号照合)は既存通り動作
- 誤認識時のフォールバックが正しく動作
- 生顔画像がどこにも保存されていないこと(コードレビュー完了)
- 患者が顔データ削除を依頼したときの手順書(docs/manual-lucas.md に追記)

## メモ

- face-api.js の tinyFaceDetector は約 200KB。CDN 読み込みで問題なし
- Phase 2 では Service Worker でモデルをキャッシュ検討(オフライン対応強化)
- 閾値 0.5 はプロトタイプ暫定値。staging で最適化必須
- 未成年判定は既存 dob フィールドから算出(問診票 initial の生年月日入力後)
- iOS Safari は WebRTC + WebGL 対応必須(iPad Air 5世代以降は OK)
