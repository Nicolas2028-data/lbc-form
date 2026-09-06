# .steering/ — 作業単位のドキュメント

特定の作業における **「今回何をするか」** を定義する一時的なドキュメントです。

作業完了後も参照用に残しますが、新しい作業では新しいディレクトリを作ります。

## 命名規則

```
.steering/[YYYYMMDD]-[開発タイトル]/
```

例:
- `.steering/20260910-face-auth-phase1/`
- `.steering/20260920-drive-cleanup/`
- `.steering/20261005-monitoring-dashboard/`

## 各ディレクトリの中身

| ファイル | 内容 |
|---|---|
| `requirements.md` | 今回の要求内容・受け入れ条件・制約事項 |
| `design.md` | 実装アプローチ・変更範囲・影響分析 |
| `tasklist.md` | 具体的な実装タスク・進捗状況・完了条件 |

## 作成方法

```
/new-work [タイトル]
```

このコマンドで3ファイルの雛形が生成されます。

## 進め方

1. `requirements.md` を埋める → **Nicolas の確認を得る**
2. `design.md` を埋める → **Nicolas の確認を得る**
3. `tasklist.md` に分解する
4. 実装する

**確認を飛ばして実装に入らないでください。**

## `SPEC.md` / `TASKS.md` との違い

| | `SPEC.md` / `TASKS.md` | `.steering/` |
|---|---|---|
| 性質 | 永続的 | 作業単位 |
| 更新 | 常に最新に保つ | 作業完了後は固定 |
| 内容 | 今どうなっているか | 今回何をするか |

作業を始めるときは `.steering/` に新規ディレクトリを作り、
その作業で `SPEC.md` に影響が出るなら `SPEC.md` も更新します(documenter が担当)。
