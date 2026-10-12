# アカウント・鍵の管理表

**最終更新: 2026-10-12**。サービスを追加したり、アカウント・鍵を変えたりしたら、ここを必ず更新する。

> ⚠️ **このリポジトリ(Nicolas2028-data/lbc-form)は公開(public)**。誰でも読める。
> ここには **パスワード・鍵・トークンの値、スタッフや患者の個人情報は絶対に書かない**。「どこにあるか」「誰が管理するか」だけを書く。

---

## 1. サービスとログインするアカウント

| サービス | 何に使う | ログインするアカウント | 管理者 | 状態 |
|---|---|---|---|---|
| **GitHub** | コード(`lbc-form`)。`main` = 現行本番(GitHub Pages)、`platform-rebuild` = 新システム | **Nicolas2028-data**(2 段階認証あり) | Nicolas | 使用中 |
| **Google**(Gmail アカウント v.nico2003) | 現行本番: GAS・台帳スプレッドシート・Drive(患者画像・ハンドオフ資料)・clasp | v.nico2003@gmail.com | Nicolas | 使用中(新システムへの切替後に段階的に引退) |
| **Notion**(Plus プラン) | 現行本番の表示用 DB(顧客管理・施術カルテ)。インテグレーション「LBC Care」 | Nicolas の Notion アカウント | Nicolas | 新システムへの切替後に停止予定(タスク 2-9) |
| **Supabase** | 新システムのデータベース・ログイン・写真の保存。組織「LBC Care」(Free)/ プロジェクト `lbc-staging`(東京、ref `lnatpitfcqxmgxxmmqzr`) | ダッシュボード上の表示名は **Nicolas2028-data**(GitHub でサインインしていると思われる。要確認) | Nicolas | 使用中(テスト環境。本番用プロジェクトは未作成) |
| **Cloudflare** | 新システムの画面の公開(Pages プロジェクト `lbc-care` → https://lbc-care.pages.dev) | **v.nico2003@gmail.com**(アカウント ID `ddf479e13f9ead9ee161be5097f2d634`) | Nicolas | 使用中(2026-10-12 から) |

- 同じ Cloudflare アカウントに、LBC とは無関係の `bella-beauty-workers` / `bella-market-workers` がある。触らない。
- GitHub には別アカウント **vnico2003-eng** もあるが、`lbc-form` への書き込み権限はない。PC の git 認証がこちらになっていると push が 403 になる(対処は下の 5 章)。
- GitHub の組織 `dotslineinc` にもアクセスできるが、LBC では使っていない。

### まだ作っていない(必要になったら作る)
| サービス | 用途 | タスク |
|---|---|---|
| Cloudflare R2 | 日次バックアップの保存先(Cloudflare アカウントは作成済み) | 1-9 |
| Resend | 予約確認メール | 3-4 |
| Stripe | 回数券・サブスクのオンライン決済 | 5 |
| LINE(ログインチャネル・公式アカウント) | マイページ・リマインド | 4・6 |
| Supabase 本番プロジェクト(Pro + PITR を想定) | 本番切替 | 1-11・3-5 |

---

## 2. サービス間の連携(誰が何にアクセスできるか)

| 連携 | 許可している範囲 | 設定した日 |
|---|---|---|
| GitHub App「Cloudflare Workers and Pages」 | Nicolas2028-data の **`lbc-form` だけ**(Only select repositories) | 2026-10-12 |
| Cloudflare Pages `lbc-care` | `platform-rebuild` ブランチに push すると自動でビルド・公開(Root `app`、`npm run build`、出力 `dist`、Node 22) | 2026-10-12 |
| GAS → Notion | インテグレーション「LBC Care」のトークン(GAS のスクリプトプロパティ) | 2026-09 以前 |
| clasp → GAS | v.nico2003@gmail.com で `clasp login`(各 PC の `~/.clasprc.json`) | PC ごと |

---

## 3. 鍵・トークン・パスワードの置き場所(値はここに書かない)

| もの | 置き場所 | 公開してよいか | 備考 |
|---|---|---|---|
| Supabase **publishable key**(`sb_publishable_…`) | Cloudflare Pages の環境変数 `VITE_SUPABASE_ANON_KEY`、各 PC の `app/.env.local`(gitignore) | よい(画面の JavaScript に必ず入る。データは RLS とログインで保護) | Supabase → Project Settings → API Keys |
| Supabase **secret key**(`sb_secret_…`) | Supabase ダッシュボードだけ | **だめ** | どこにもコピーしない。画面・Cloudflare・リポジトリに入れない |
| Supabase DB パスワード | 誰も保持していない | — | 必要ならダッシュボードでリセット。migration は SQL エディタで適用(docs/database.md 6.2) |
| Notion トークン | GAS スクリプトプロパティ `NOTION_TOKEN`、このPCの `scripts/migrate/.env.local`(gitignore) | **だめ** | 半年ごとに更新(docs/token-rotation.md) |
| GAS `STAFF_PASSWORD` | GAS スクリプトプロパティ(Nicolas が記憶) | **だめ** | 管理系 API 用 |
| GAS `STAFF_ACCESS_TOKEN` | GAS スクリプトプロパティ | **だめ** | 2026-10-11 以降、施術記録系 API では使っていない(tasklist「決定の記録」) |
| GAS のその他のプロパティ(DB ID・シート ID・フォルダ ID・`SITE_URL`・`NOTIFY_EMAIL`・`STAGING_*`) | GAS スクリプトプロパティ | ID 類は秘密ではないが、まとめて公開はしない | 一覧は README.md |
| clasp のログイン情報 | 各 PC の `~/.clasprc.json` | **だめ** | |
| 各サービスのパスワード・2 段階認証 | Nicolas 本人 | **だめ** | Claude はパスワード・鍵を入力しない |

---

## 4. 新システムのログイン用アカウント(Supabase Auth)

- 新規サインアップは**無効**。スタッフのアカウントは Nicolas が Supabase ダッシュボード → Authentication → Users → **Create new user** で作る(パスワードは本人が入力)。
- 役割(オーナー / スタッフ)は DB の `staff` テーブルで決まる(docs/database.md 4 章)。全員分の Excel 出力などはオーナーだけ。
- Supabase の標準メール送信は組織メンバー宛にしか届かないので、パスワード再設定メールはスタッフに届かない。
- **2026-10-12 時点で Auth ユーザーは約 10 件(Supabase の推定値)**。開発中のテスト用アカウントが含まれていると思われる → **棚卸しが必要**(不要なものを消す・ルカスのアカウントがあるか確認)。
- 二段階認証はまだ無い(タスク 1-11)。

---

## 5. 困ったとき

- **git push が 403**: PC の Git Credential Manager に vnico2003-eng のトークンが残っている。`git credential-manager erase` で github.com の認証を消し、Nicolas2028-data でサインインし直す。
- **GitHub の権限変更で「Confirm access」**: 2 段階認証(GitHub Mobile など)が必要。Nicolas 本人が操作する。
- **Cloudflare にどのアカウントで入っているかわからない**: https://dash.cloudflare.com/profile を開く。LBC は v.nico2003@gmail.com のアカウント。
- **人が抜けた・PC をなくした・鍵が漏れたかもしれない**: 該当する鍵を作り直す(Notion トークン、Supabase の secret key、GAS の STAFF_PASSWORD)→ このファイルの「置き場所」を全部更新。Supabase Auth のユーザーを無効化。
