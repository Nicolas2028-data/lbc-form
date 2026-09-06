# CLAUDE.md — LBC Care オペレーション管理システム

Claude Code はこのファイルを毎回読み込みます。プロジェクトの絶対ルールと参照先を定義します。

---

## プロジェクト概要

| 項目 | 内容 |
|---|---|
| 対象 | 三重県四日市市の整体院 **LBC Care** |
| 規模 | 月6〜12人 |
| 術者 | ルカス(ポルトガル語話者。日本語は限定的) |
| 開発者 | Nicolas Ventura |
| 患者言語 | 日本語 / スペイン語 / ポルトガル語 |
| 予算制約 | すべて無料枠(GAS / Sheets / Notion / Looker Studio) |

---

## アーキテクチャ(要約)

```
GitHub Pages (questionnaire.html / treatment-record.html / dashboard.html)
  → GAS Webアプリ (doPost/doGet)
  → Google スプレッドシート = 原本 (Source of Truth)
  → Notion = 表示専用ダッシュボード (1分毎トリガーで同期)
```

詳細は `SPEC.md` を参照。

---

## 絶対に守るルール

### 1. 最終的な意思決定は必ず人間が行う

以下は Claude Code が勝手に決めてはいけません。

- 技術構成の変更
- スプレッドシート台帳・Notion DB スキーマの変更
- GAS スクリプトプロパティの変更
- Drive フォルダ構成の変更
- 本番デプロイ(`clasp push` の実行)

**判断に迷ったら止まって聞いてください。推測で進めないでください。**

### 2. `index.html`(予約フォーム)は一切触らない

- HTML/JS/CSS どれも変更禁止
- `getSlots` / `submitBooking` / `JSONP` 経路も変更禁止
- 予約枠の排他制御・リマインダーも改修対象外

**理由:** 稼働中で影響が読めない。改修は別プロジェクト扱い。

### 3. シートが正。Notion は表示専用

- Notion からの読み戻しは行わない
- 台帳は追記専用。訂正は**赤伝方式**(void 行 + correction 行)
- 物理削除禁止。論理削除のみ

### 4. 認可はサーバー側

- スタッフ系 API は毎リクエスト GAS 側で `STAFF_PASSWORD` を検証
- フロントの画面ゲートは UX。認可ではない
- 顧客の個人情報を外部 AI に送らない

### 5. STEP の完了条件を無視して次に進まない

`TASKS.md` の各 Step の「完了条件」を満たしてから次へ。

---

## 禁止事項

| ❌ してはいけないこと | 理由 |
|---|---|
| `index.html` の変更 | 稼働中。影響読めない |
| 台帳の既存行の書き換え | 追記専用が原則(訂正は赤伝) |
| Notion → シート方向の同期 | シートが正。逆同期は不整合の元 |
| ID・パスワードのハードコード | すべて `getConfig()` 経由 |
| 顧客情報を外部 AI に送信 | 個人情報保護 |
| `clasp push` の勝手な実行 | 本番影響。必ず確認を取る |
| Drive の共有設定を「リンクを知っている全員」にする | 患者写真が含まれるため |
| スタッフパスワード付きの API を認証なしで呼ぶ実装 | 認可回避になる |

---

## 技術スタック

| 領域 | 採用 |
|---|---|
| フロント | Vanilla HTML/JS + Chart.js(ダッシュボードのみ) |
| ホスティング | GitHub Pages |
| バックエンド | Google Apps Script (Web アプリ) |
| データ原本 | Google スプレッドシート(台帳) |
| 表示 | Notion(DB 2つ) |
| 画像保管 | Google Drive + Notion File Upload |
| メール | Gmail(GAS 経由) |
| 多言語 | 問診票のみ ja / es / pt (`i18n/*.json`) |
| GAS 管理 | clasp |

---

## ドキュメントの分類

### 1. 永続的ドキュメント(常に最新に保つ)

| ファイル | 内容 |
|---|---|
| `SPEC.md` | 実装仕様書(スキーマ・同期仕様・認可・訂正モード等) |
| `TASKS.md` | Step 0〜6 のタスクリストと進捗 |
| `README.md` | セットアップ・clasp 手順・スクリプトプロパティ一覧 |
| `docs/manual-lucas.md` | ルカス向け運用マニュアル |

**実装を始める前に、最低限この3つを読んでください。**

1. `CLAUDE.md`(このファイル)
2. `SPEC.md` の該当セクション
3. `TASKS.md` の該当 Step

### 2. 作業単位のドキュメント(`.steering/`)

新規/大きめの改修を始めるときは、`.steering/[YYYYMMDD]-[タイトル]/` に3ファイルを作ります。

| ファイル | 内容 |
|---|---|
| `requirements.md` | 今回の要求内容・受け入れ条件・制約 |
| `design.md` | 実装アプローチ・変更範囲・影響分析 |
| `tasklist.md` | 具体的なタスクと進捗 |

`/new-work [タイトル]` で雛形が生成されます。

### 3. 日次報告(`reports/`)

`/daily-report` を実行して `reports/YYYY-MM-DD.md` に記録を残します。

---

## エージェントの使い分け

| エージェント | 呼ぶ場面 |
|---|---|
| `implementer` | 通常の実装(GAS / HTML / JS) |
| `architect` | 設計判断・スキーマ変更・同期方式の見直し |
| `tester` | GAS 関数テスト・手動動作確認 |
| `reviewer` | 実装完了時のコードレビュー |
| `security` | 認可・個人情報・Drive 権限のチェック |
| `researcher` | 技術調査・費用調査・API 仕様調査 |
| `documenter` | `SPEC.md` / `docs/` / `.steering/` の更新 |
| `gas-ops` | clasp 操作・GAS デプロイ・スクリプトプロパティ管理 |
| `face-auth-specialist` | 顔認証機能(次期主要機能)の設計・実装 |

呼び出し方:
```
architect を使って顔認証のデータ設計を見直して
gas-ops で staging に push して
```

---

## スラッシュコマンド

| コマンド | 動作 |
|---|---|
| `/new-work [タイトル]` | `.steering/[日付]-[タイトル]/` に3ファイル作成 |
| `/daily-report` | 当日の作業を要約して `reports/` に記録 |
| `/check` | GAS 構文チェック(clasp) + HTML の簡易検証 |

---

## 開発プロセス

### 新しい作業を始めるとき

```
1. /new-work [タイトル] を実行
   → .steering/[日付]-[タイトル]/ が作られる

2. requirements.md を埋める(何をするか)
   → Nicolas の確認を得る

3. design.md を埋める(どう作るか)
   → 必要なら architect に相談
   → Nicolas の確認を得る

4. tasklist.md を埋める(作業分解)

5. 実装を開始する
```

### 機能修正のとき

```
1. 影響分析
   → SPEC.md / TASKS.md への影響を確認
   → 基本設計に影響するなら SPEC.md を更新

2. .steering/ に新規ディレクトリを作る

3. 以降は同じ流れ
```

### 1日の終わりに

```
/daily-report
```

---

## 品質チェック

コミット前に `/check` を実行:

```bash
# GAS 構文チェック
~/.local/bin/clasp push --dry-run
# HTML/JS の目視確認 → questionnaire / treatment-record / dashboard の3画面
```

**staging(`ENV=staging`)で動作確認してから本番に反映。**

---

## 並行作業

`git worktree` は最大2つまで。

```
lbc-care/                 ← メインの実装
lbc-care-face-auth/       ← 顔認証などの重い作業
```

**3つ以上開かない。レビューが追いつかず品質が落ちる。**

**GAS スクリプトへの同時 push は禁止。** どちらかが `clasp push` 中は他方を止める。

---

## 用語

| 日本語 | 意味 |
|---|---|
| 台帳 | Google スプレッドシートの追記専用タブ群 |
| 赤伝 | 訂正方式。取消行 + 訂正行を追記する |
| マスタ | 顧客マスタ等の上書き可能なタブ |
| _sync | シートに1つ置く同期用インクリメントセル |
| カルテ | Notion 側の施術記録ページ |

---

## 現状(2026-09-06)

- Step 0〜6 のうち **45/46 タスク完了**
- 残り: Step 6-4(本番切替後1週間の監視)
- 次期: **顔認証機能**(`face-auth-test.html` にプロトタイプあり)

詳細は `TASKS.md` を参照。
