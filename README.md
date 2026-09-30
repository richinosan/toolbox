# toolbox

toolbox.richinosan.com

小さな Web ツールを `toolbox.richinosan.com` 配下で提供するモノレポです。
1 tool = 1 Astro app = 1 Cloudflare Worker を基本とし、依存バージョン・共通 UI は workspace で共有します。

## 構成

```
apps/          # 1 tool = 1 Astro app = 1 Worker
packages/
  ui/          # 共通レイアウト・グローバル CSS（LINE Seed JP）
```

- 依存バージョンは `pnpm-workspace.yaml` の `catalog` で一元管理し、各 `package.json` からは `catalog:` で参照します。
- 各 app は自分の `astro.config.mjs` と `wrangler.jsonc`（Worker 名・route・assets）を持ち、単独でビルド・デプロイできます。

## コマンド

node / pnpm / ni は [mise](https://mise.jdx.dev/) で管理し、コマンドはすべて mise task に集約しています（`mise tasks` で一覧）。

```sh
mise install          # node / pnpm / ni を入れる
mise run install      # 依存パッケージをインストール
mise run build        # 全 app をビルド
mise run check        # 型チェック（astro check / tsc）
mise run lint         # oxlint + 型チェック
mise run format       # Prettier で整形
mise run tests        # lint + 整形チェック
mise run dev <app>    # app を開発サーバーで起動
mise run deploy <app> # app をビルドしてデプロイ
```
