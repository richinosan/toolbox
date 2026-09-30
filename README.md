# toolbox

toolbox.richinosan.com

小さな Web ツールを `toolbox.richinosan.com` 配下で提供するモノレポです。
1 tool = 1 Astro app = 1 Cloudflare Worker を基本とし、依存・共通 UI はリポジトリ全体で共有します。

## 構成

```
apps/          # 1 tool = 1 Astro app = 1 Worker
packages/
  ui/          # 共通レイアウト・グローバル CSS（LINE Seed JP）
```

- `package.json` はルートの 1 つだけで、依存はすべてそこで管理します（app / package ごとに `package.json` を持たないルール）。
- 共通コードは npm パッケージにせず、ルート `package.json` の `imports`（例: `#ui/*`）で参照します。
- フォント（LINE Seed JP）は Astro の Fonts API で配信します。各 app の `astro.config.mjs` で `fonts` に `#ui/fonts.mjs` の設定を渡します（woff2 のみ・必要なサブセットだけ読み込み）。
- import は default import か namespace import（`import * as x from "..."`）のみ使います。named import は lint でエラーになります。
- 各 app は自分の `astro.config.mjs` と `cloudflare.config.ts`（Worker 名・route・assets の扱い）を持ち、単独でビルド・デプロイできます。`wrangler.jsonc` は使いません。

## コマンド

node / pnpm / ni は [mise](https://mise.jdx.dev/) で管理し、コマンドはすべて mise task に集約しています（`mise tasks` で一覧）。

```sh
mise install          # node / pnpm / ni を入れる
mise run install      # 依存パッケージをインストール
mise run build        # 全 app をビルド
mise run check        # 型チェック（astro check / tsc）
mise run lint         # oxlint（named import 禁止など独自ルールは lint/plugin.mjs）+ 型チェック
mise run format       # Prettier で整形
mise run tests        # lint + 整形チェック
mise run dev <app>    # app を開発サーバーで起動
mise run deploy <app> # app をビルドしてデプロイ
```
