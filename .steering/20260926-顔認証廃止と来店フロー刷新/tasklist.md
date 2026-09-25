# タスクリスト — 顔認証廃止と来店フロー刷新

作成日: 2026-09-26

## 進捗

0 / 42 完了

## 実装順序の考え方

破綻を避けるため以下の順で進める:

1. **設計文書更新** (SPEC.md, docs) — 実装前に真実の定義を確定
2. **来店ログタブのシート整備** — データ受け皿を先に作る
3. **GAS の来店ログ書き込みロジック追加** — 顔認証削除の前に新機能を動かす
4. **施術記録シートの施術有無トグル追加** — 記録側の対応
5. **顔認証コードの一括削除** — 新機能が動くのを確認してから削除
6. **Notion 側 DB 作成とダッシュボード再構成**
7. **同期ロジック拡張**
8. **staging で全シナリオテスト**
9. **本番切替**

---

## Phase 0: 設計文書とスキーマ確定

- [ ] 0-1. `SPEC.md` を更新
  - [ ] 11.5 顔認証セクションを削除
  - [ ] 2章に `来店ログ` タブスキーマを追記
  - [ ] 3章の同期仕様に来店ログ DB を追加
  - [ ] 5章に施術記録シートの施術有無トグル仕様を追記
- [ ] 0-2. `face_embedding` 列の扱い決定(Nicolas 判断)
  - 案A: 物理削除(スキーマ変更、CM 定義更新必要)
  - 案B: 空文字化(スキーマ維持、CM 定義から未使用に降格)
- [ ] 0-3. `docs/manual-lucas.md` を更新
  - [ ] 顔認証手順を削除
  - [ ] 未記録リストの見方を追加
  - [ ] no-show 記録手順を追加

---

## Phase 1: 来店ログタブのシート整備

- [ ] 1-1. staging シートに `来店ログ` タブを作成(SPEC 通り15列)
- [ ] 1-2. 列ヘッダー・保護設定・onEdit トリガー対象追加
- [ ] 1-3. `gas/Code.js` の `SHEET_DEFS` に `来店ログ` タブ定義を追加
- [ ] 1-4. `applySheetHeaders` を staging で実行して列確認
- [ ] 1-5. 本番シートに同じ設定で `来店ログ` タブを作成(Nicolas 承認後)

---

## Phase 2: GAS 側 — 来店ログ書き込みロジック

- [ ] 2-1. `normalizeName(name)` 関数を実装(全角半角スペース統一、前後トリム、連続スペース畳み込み)
- [ ] 2-2. `appendCheckinLog(customerId, customerName, phoneNormalized, entryType)` を実装
  - checkin_id = Utilities.getUuid()
  - treatment_record_url = 組み立て(customer_id, name, phone をクエリパラメータに)
  - status=received、recorded_at=空
- [ ] 2-3. `updateCheckinLogOnRecord(recordId, customerId, treatmentDate, status, noShowReason)` を実装
  - 同日・同 customer_id の未マッチ(recorded_at 空)を古い順に検索
  - 見つかれば更新、見つからなければ appendCheckinLog(entry_type=auto_backfill)+ NOTIFY_EMAIL 通知
- [ ] 2-4. `handleSubmitAll` に appendCheckinLog(entry_type=initial) 呼び出しを追加
- [ ] 2-5. `handleMatchByPhone` の照合成功後フローに appendCheckinLog(entry_type=revisit) 呼び出しを追加
- [ ] 2-6. `handleSubmitTreatmentRecord` に updateCheckinLogOnRecord 呼び出しを追加
- [ ] 2-7. staging で単体動作確認(問診票送信 → 来店ログ 1行、施術記録送信 → recorded_at 更新)

---

## Phase 3: 施術記録シートの施術有無トグル

- [ ] 3-1. `treatment-record.html` に URL パラメータ受け取り実装(customer_id, name, phone を事前入力)
- [ ] 3-2. 施術有無ラジオボタン(「✅ 施術を受けた」/「⚫ 施術を受けなかった」)を最上部に追加
- [ ] 3-3. 「受けなかった」選択時の UI 分岐(施術内容欄を非表示、理由入力欄を表示)
- [ ] 3-4. 送信ペイロードに `attended: true/false` と `no_show_reason` を追加
- [ ] 3-5. 送信後メッセージを「✅ 記録しました。1分以内に Notion に反映されます」に変更
- [ ] 3-6. `handleSubmitTreatmentRecord` を修正(attended=false の場合 status=no_show、count_eligible=FALSE で台帳追記)
- [ ] 3-7. staging で「受けた」「受けなかった」両パターン動作確認

---

## Phase 4: 顔認証コード一括削除

- [ ] 4-1. `questionnaire.html` から顔認証 UI・face-api.js CDN・Kiosk unlock を削除
- [ ] 4-2. `js/common.js` から顔認証ヘルパーを削除
- [ ] 4-3. `gas/Code.js` から `handleGetFaceEmbeddings` `handleMatchFace` および関連関数を削除
- [ ] 4-4. `doPost` の顔認証系 action 分岐を削除
- [ ] 4-5. `i18n/ja.json` `es.json` `pt.json` から `face_*` キーを削除
- [ ] 4-6. `face-auth-test.html` を削除
- [ ] 4-7. `palm-auth-test.html` を削除
- [ ] 4-8. `service-worker.js` から face-api.js キャッシュエントリを削除(あれば)
- [ ] 4-9. `face_embedding` 列を Phase 0-2 の決定に従い処理(物理削除 or 空文字化)
- [ ] 4-10. コードベース全体を `grep -ri "face" --include="*.html" --include="*.js" --include="*.json"` で削除漏れチェック

---

## Phase 5: Notion 側 DB 作成とダッシュボード再構成

- [ ] 5-1. Nicolas が Notion 側で staging 用の `来店ログ` DB を作成
  - プロパティ: 顧客名(Title) / 状態(Status) / 来店(Date) / 経過(Formula) / 📝 記録する(URL) / メモ(Text) / checkin_id(Text, hidden)
- [ ] 5-2. 3ビューを作成
  - 🔴 未記録(Board、Group by 経過、Sort by 来店 昇順)
  - 📅 今日の来店(Gallery、Filter by checkin_date=today、Sort by 来店 昇順)
  - 📊 全履歴(Table、Sort by 来店 降順)
- [ ] 5-3. スクリプトプロパティに `STAGING_NOTION_CHECKIN_DB_ID` を設定
- [ ] 5-4. ダッシュボードページ再構成
  - [ ] カバー画像設定(LBC ブランドカラー)
  - [ ] ページアイコン設定(🌿)
  - [ ] TODAY サマリ callout 配置
  - [ ] 🚨 未記録リスト セクション(Board View 埋め込み)
  - [ ] 📅 今日の来店 セクション(Gallery View 埋め込み)
  - [ ] 既存の dashboard.html 埋め込み(📊 数字で見る運用)
  - [ ] 既存 顧客マスタ / 施術カルテ の再配置
  - [ ] 未記録0件時の 🎉 ALL DONE! callout(手動配置または formula 表示)
- [ ] 5-5. staging Notion で見た目確認、ルカスと目視レビュー
- [ ] 5-6. 本番 Notion に同じ構成で反映(Nicolas 作業)
- [ ] 5-7. スクリプトプロパティに `NOTION_CHECKIN_DB_ID` (本番)を設定

---

## Phase 6: 同期ロジック拡張

- [ ] 6-1. `syncToNotion` に来店ログ DB への upsert 処理を追加
  - `updated_at > synced_at` のレコードを抽出
  - checkin_id で upsert(存在すれば update、なければ create)
  - 状態は status を Notion Status ラベルに変換(received → 🔴未記録、recorded → ✅済、no_show → ⚫施術なし)
  - synced_at 書き戻し
- [ ] 6-2. `_sync` セルの拡張(来店ログの変更もカウント対象に)
- [ ] 6-3. staging で同期動作確認(問診票送信 → 1分後 Notion 反映、施術記録送信 → 1分後 状態更新)
- [ ] 6-4. 5回失敗スキップ + 通知の既存ロジックが来店ログにも適用されることを確認

---

## Phase 7: staging で全シナリオテスト(受け入れ条件検証)

以下のシナリオを staging で走らせて確認:

- [ ] 7-1. シナリオ1: 典型的な2回目来店 → 記録 → 未記録から消える
- [ ] 7-2. シナリオ2: 初回来店 → 全項目入力 → 記録 → 未記録から消える
- [ ] 7-3. シナリオ3: no-show → 施術記録シート「受けなかった」+理由 → 未記録から消える + no_show_reason が Notion メモに反映
- [ ] 7-4. シナリオ4: 問診票なしで施術記録 → 来店ログ自動補完 + 通知メール
- [ ] 7-5. シナリオ5: 昨日の書き忘れ → 全期間表示ビューで残っている → 記録可能
- [ ] 7-6. シナリオ6: 訂正モード(赤伝)実行 → 来店ログの recorded_at は維持
- [ ] 7-7. シナリオ7: 1日2回来店(手動シミュレーション)→ checkin_id が個別発行、古い順マッチ
- [ ] 7-8. シナリオ8: 問診票二重送信 → requestId 冪等で 1行のみ
- [ ] 7-9. シナリオ9: 顔認証 UI が questionnaire.html に残っていない(目視確認)
- [ ] 7-10. シナリオ10: Kiosk 4連タップ unlock が消えている
- [ ] 7-11. シナリオ11: 予約なし飛び込み(初回) → 電話+氏名照合 0件 → 初回誘導
- [ ] 7-12. シナリオ13: 名前表記揺れ(全角/半角スペース)→ normalizeName で吸収して照合成功
- [ ] 7-13. シナリオ14: 施術記録送信後の UI に「1分以内に Notion 反映」表示
- [ ] 7-14. シナリオ15: 台帳手動編集 → onEdit → 同期
- [ ] 7-15. ダッシュボード視認性チェック(未記録リスト・TODAY サマリ・カラー分けが機能)

---

## Phase 8: 本番切替

- [ ] 8-1. 本番シートに Phase 1-5 の変更を反映
- [ ] 8-2. 本番 Notion に Phase 5-6 の変更を反映
- [ ] 8-3. 本番スクリプトプロパティに `NOTION_CHECKIN_DB_ID` 設定
- [ ] 8-4. clasp deploy で本番デプロイ
- [ ] 8-5. 本番で疎通確認(問診票送信 → 来店ログ → Notion 反映)
- [ ] 8-6. `docs/manual-lucas.md` の最新版をルカスに共有
- [ ] 8-7. ルカスに新運用の口頭説明(未記録リストの使い方、no-show の記録方法)
- [ ] 8-8. 切替後1週間の監視(日次サマリメール + 同期エラー件数を確認)

---

## 完了条件

- 全 Phase の受け入れ条件(`requirements.md`)を満たしている
- staging で全シナリオ(Phase 7)が PASS
- 顔認証関連コード・UI・文言・SPEC 記述が完全に消えている(grep で確認)
- Notion ダッシュボードでルカスが未記録リストを確認できる
- 本番切替後 1週間、日次サマリメールと同期エラーで異常なし
- `docs/manual-lucas.md` が最新化されている

---

## メモ

- **顔認証削除は「新機能が動くのを確認してから」**(Phase 2 → Phase 4 の順)
- Notion DB の作成は Nicolas 手作業(GAS では作れない)
- ダッシュボードページのカバー画像は既存の LBC ブランド素材があれば流用
- 段階リリースはあり得るが、来店ログと顔認証削除はセットで動くため一括切替が clean
- 実装中に発見した新たな破綻パターンは本ファイル末尾に追記して都度対応
