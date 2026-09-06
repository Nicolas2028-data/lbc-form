# NOTION_TOKEN ローテーション運用手順書

作成日: 2026-09-06
対象: Nicolas Ventura(唯一の権限保持者)
頻度: **半年に1回**(3月/9月 目安)

---

## なぜローテーションが必要か

- LBC Care は Notion API に無期限トークンで接続している
- 万一トークンが漏洩した場合、攻撃者は共有 DB(顧客マスタ・カルテ)に無制限アクセス可能
- ローテーションで:過去に漏れていた場合の被害期間を最大半年に抑える
- Notion 公式もローテーションを推奨(セキュリティ上のベストプラクティス)

## 実施タイミング

- **毎年 3月と 9月の第一週**(半年ごと)
- Google カレンダーで繰り返しリマインダー設定推奨
- 大量退職・PC 紛失・GitHub リポジトリの誤公開等の事故時は即座に実施

---

## 手順(所要時間 15分)

### 1. 新トークン発行

1. https://www.notion.so/profile/integrations にアクセス
2. `LBC Care` インテグレーション(既存のもの)を選択
3. 「Internal Integration Secret」の右側「Show」→「Refresh」または「Rotate secret」ボタン
4. 新しい `ntn_` から始まるトークンをコピー(**この画面を閉じると再表示不可**)

### 2. GAS スクリプトプロパティ更新

1. GAS エディタを開く:
   ```bash
   ~/.local/bin/clasp open
   ```
   または https://script.google.com/d/1DWGR2YgD6nZejBB6ak8fDHwvwvEtsBBokb7TacvsjZK-DHtsJRyMhixc/edit
2. 左メニュー「プロジェクトの設定」→「スクリプトプロパティ」
3. `NOTION_TOKEN` の値を新トークンで上書き
4. 保存

### 3. 疎通確認

GAS エディタで以下を実行:

```javascript
function testNotionToken() {
  var cfg = getConfig();
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/users/me', {
    headers: { 'Authorization': 'Bearer ' + cfg.NOTION_TOKEN, 'Notion-Version': '2022-06-28' },
    muteHttpExceptions: true,
  });
  Logger.log('HTTP ' + res.getResponseCode());
  Logger.log(res.getContentText());
}
```

**期待:** HTTP 200、ユーザー情報 JSON

### 4. 同期の動作確認

- 1〜2分待つ(自動同期トリガーの次サイクル)
- 台帳シートに軽微な変更(例: 顧客の氏名末尾にスペース追加 → 削除)
- 1分後、Notion 顧客マスタ DB に反映されているか確認

### 5. 変更履歴の記録

`reports/YYYY-MM-DD.md` に記録:

```markdown
# ローテーション記録 YYYY-MM-DD

- 対象: NOTION_TOKEN
- 旧トークン最終使用: (Notion 側の履歴で確認)
- 新トークン反映: HH:MM
- 疎通確認: OK
- 次回予定: YYYY-MM-DD(6ヶ月後)
```

---

## トラブルシューティング

### 疎通確認で 401 Unauthorized

- スクリプトプロパティに古いトークンが残っている可能性
- 実値確認:GAS エディタで実行:
  ```javascript
  function showTokenPrefix() {
    Logger.log(PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN').slice(0, 12) + '...');
  }
  ```
- 新トークンの先頭 12文字と一致しなければ、再度スクリプトプロパティを更新

### 同期エラーが 5回以上出る

- `showDriveFolderId()` と `assertProductionConfig()` を実行して設定確認
- Notion 側でインテグレーションが DB に接続されているか確認(旧トークンを削除すると接続が切れる場合あり)
- 手順で「Rotate secret」ではなく「Delete」してから「Create new」した場合、接続を再度手動で追加

---

## 参考

- [Notion API 認証ドキュメント](https://developers.notion.com/docs/authorization)
- 関連ファイル: `gas/Code.js` — NOTION_TOKEN を使用する全箇所は `cfg.NOTION_TOKEN` 経由
- 関連プロパティ: `CUSTOMER_DB_ID`、`KARTE_DB_ID`(こちらは基本不変。DB 再作成時のみ更新)
