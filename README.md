# toolbox

toolbox.richinosan.com

小さな Web ツールを `toolbox.richinosan.com` 配下で提供するモノレポです。
1 tool = 1 Astro app = 1 Cloudflare Worker を基本とし、依存・共通 UI・ツール定義はリポジトリ全体で共有します。

## 構成

```
apps/
  dashboard/   # /           ツール一覧（Worker: toolbox-dashboard）
  calendar/    # /calendar   日付 → 曜日・Unix time（Worker: toolbox-calendar）
packages/
  shared/      # ツール定義（tools.ts）
  ui/          # 共通レイアウト・アイコン・グローバル CSS（LINE Seed JP）
```

- `package.json` はルートの 1 つだけで、依存はすべてそこで管理します（app / package ごとに `package.json` を持たないルール）。
- 共通コードは npm パッケージにせず、ルート `package.json` の `imports`（`#ui/*`, `#shared`）で参照します。
- フォント（LINE Seed JP）は Astro の Fonts API で配信します。各 app の `astro.config.mjs` で `fonts` に `#ui/fonts.mjs` の設定を渡します（woff2 のみ・必要なサブセットだけ読み込み）。
- import は default import か namespace import（`import * as x from "..."`）のみ使います。named import は lint でエラーになります。
- 各 app は自分の `astro.config.mjs` と `cloudflare.config.ts`（Worker 名・route・assets の扱い）を持ち、単独でビルド・デプロイできます。`wrangler.jsonc` は使いません。
- 各 app は静的ビルドし、Worker の static assets として配信します。
  `/calendar` のようにサブパスを担当する app は `base` と `outDir: ./dist/<path>` を合わせ、URL パスと assets のパスを一致させています。
- route はより具体的なパターンが優先されるため、`toolbox.richinosan.com/*` を dashboard、`/calendar` と `/calendar/*` を calendar が処理します。
  （route を有効にするには `toolbox.richinosan.com` の DNS レコードが Cloudflare でプロキシされている必要があります。）

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

## ツールの追加

1. `apps/<tool>/` を既存 app と同じ形で作成し、`base` / `outDir` / `cloudflare.config.ts` の route を `/<tool>` に合わせる
2. `packages/shared/src/tools.ts` にツール定義を追加する（アイコンは `packages/ui/src/icons/` に SVG コンポーネントを追加し、`packages/ui/src/ToolIcon.astro` に対応を追加）
