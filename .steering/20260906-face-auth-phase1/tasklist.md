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

### Phase B: フロント側(問診票 UI 統合)

- [ ] B-1. `i18n/ja.json` `es.json` `pt.json` に顔認証関連文言追加
  - 例: `face_register_prompt`, `face_register_button`, `face_lookup_button`, `face_scanning`, `face_match_found`, `face_no_match`
- [ ] B-2. `questionnaire.html` にface-api.js CDN 読み込み追加
- [ ] B-3. 初回来院フローに「顔登録同意」チェックボックス追加(未成年除外ロジック)
- [ ] B-4. 顔登録画面: カメラ起動 → 3枚キャプチャ → embedding 平均化 → 送信ペイロードに含める
- [ ] B-5. 再来院フロー冒頭に「カメラで確認」ボタン追加(電話番号入力より上)
- [ ] B-6. 顔認証画面: `getFaceEmbeddings` で全 embedding 取得 → euclideanDistance で照合 → 候補表示
- [ ] B-7. 候補確認画面: 「はい/いいえ」の 3言語ボタン、いいえなら電話番号照合へフォールバック
- [ ] B-8. `js/common.js` に `faceApiLoader()`, `computeEmbedding(videoElm)`, `euclideanDistance(a,b)` を追加

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
