# タスクリスト＆作業ログ: Notion内完結 記録フロー

**最終更新: 2026-09-27**

## 作業ログ（このセッションで実施）

### Notion スキーマ変更（MCPで実施・本番Notion）
- ✅ 施術カルテDB(74a75dcc-9470-46e7-b3f8-a4538e6ef34e)に `前回から変化`(select: 変化なし/変化あり) 追加。
- ✅ 施術カルテDBに `同期済み`(checkbox) を追加 → 後で削除（未使用のため DROP）。
- ✅ 顧客管理DB(ab06aa76-cac8-454f-8bfd-d829bd7f59dd)に `▶ 記録する`(formula) 追加＝`link("▶ 記録する","https://nicolas2028-data.github.io/lbc-form/treatment-record.html?customer_id=" + prop("診察番号"))`。
  - ※ Notion「診察番号」= customer_id(P001..) と確認済（Sheet1列目=診察番号ラベル=customer_id）。
  - ※ ただしユーザー環境のiPadで「予約サイトしか出ない」事象。原因: Notionの旧リンクキャッシュ or 数式リンクのモバイル挙動。→ 方針転換により保留。

### コード変更（commit c6c5eb9, GitHub push済 / GAS本番 @123 デプロイ済）
- ✅ treatment-record.html: 「前回から変化 なし/あり」トグル(changeCard, name=changeFromLast)追加、payloadに changeFromLast 追加。
- ✅ gas/Code.js handleSubmitTreatmentRecord: 施術メモ先頭に【変化なし/変化あり】を記録。
- ✅ gas/Code.js syncTreatment: メモ先頭マーカーから Notionカルテ「前回から変化」select に反映。
- （注）施術台帳シートのスキーマ変更は回避（メモ先頭マーカー方式で代替）。

### 方針転換（ユーザー指示 2026-09-27）
- 「サイトに飛ぶのは嫌、Notion内で完結したい。オートメーション等で何とかして」。
- → 案②(数式リンク→Webアプリ)は保留。design.md の **案N(ネイティブ・リレーション＋GASポーリング)** を推奨。

## 次にやること（未着手）
- [ ] GASにポーリング関数を実装: 施術カルテDBを定期読取→未取込の完了カルテをシート台帳へ→残高/紹介/売上計算→Notion書き戻し。冪等性(notion_page_id突合)。
- [ ] 時間トリガー登録（例: 5分毎）。
- [ ] （任意・別PCの見える環境で）Button方式 or DBテンプレートをUI作成。
- [ ] 顧客管理DBの `▶ 記録する` 数式リンクの扱いを決定（残す/消す/差し替え）。
- [ ] Notionカルテのビュー整備（本日の未記録 等）。
- [ ] 実機E2Eテスト（テスト顧客 P008/P031）。

## 環境メモ（別PC継続用）
- リポジトリ: https://github.com/Nicolas2028-data/lbc-form （ローカル: ~/Development/lbc-care）
- 最新コミット: c6c5eb9。GAS本番デプロイ: @123（ID AKfycbxCBqtgb...QfX06PQ）。
- GAS Script ID: 1DWGR2YgD6nZejBB6ak8fDHwvwvEtsBBokb7TacvsjZK-DHtsJRyMhixc
- Notion: 顧客管理DB ab06aa76-... / 施術カルテDB 74a75dcc-... / ダッシュボード 35388446-...
- ⚠️ このWindows環境ではNotionのブラウザ自動化スクショが真っ黒。UI手作業は画面が見える別PCで。
- ⚠️ GitHub認証はアカウント要注意（過去 vnico2003-eng で403 → Nicolas2028-data で再認証して解決）。
