# toolbox

toolbox.richinosan.com

小さな Web ツールを `toolbox.richinosan.com` 配下で提供するモノレポです。
1 tool = 1 Astro app = 1 Cloudflare Worker を基本とし、依存・共通 UI・ツール定義はリポジトリ全体で共有します。

## 構成

```
apps/
  dashboard/   # /           ツール一覧（Worker: toolbox-dashboard）
  calendar/    # /calendar   日付 → 曜日・Unix time（Worker: toolbox-calendar）
  image/       # /image      画像に文字・図形をレイヤーで重ねる（Worker: toolbox-image）
packages/
  shared/      # ツール定義（tools.ts）
  ui/          # 共通レイアウト・アイコン・グローバル CSS（LINE Seed JP）
```

- `package.json` はルートの 1 つだけで、依存はすべてそこで管理します（app / package ごとに `package.json` を持たないルール）。
- 共通コードは npm パッケージにせず、ルート `package.json` の `imports`（`#ui/*`, `#shared`）で参照します。
- フォント（LINE Seed JP）は Astro の Fonts API で配信します。各 app の `astro.config.mjs` で `fonts` に `#ui/fonts.mjs` の設定を渡します（woff2 のみ・必要なサブセットだけ読み込み）。
- import は default import か namespace import（`import * as x from "..."`）のみ使います。named import は lint でエラーになります。
- 各 app は自分の `astro.config.mjs` と `cloudflare.config.ts`（Worker 名・route・assets の扱い）を持ち、単独でビルド・デプロイできます。
- Cloudflare の操作は [cf CLI](https://blog.cloudflare.com/cloudflare-cf-cli-launch) で行い、wrangler（`wrangler.jsonc` を含む）は使いません。各 app の `astro.config.mjs` で `#ui/cloudflare.mjs` の integration を読み込み、ビルド時に cf が読む Build Output を書き出します。
- 各 app は静的ビルドし、Worker の static assets として配信します。
  `/calendar` のようにサブパスを担当する app は `base` と `outDir: ./dist/<path>` を合わせ、URL パスと assets のパスを一致させています。
- route はより具体的なパターンが優先されるため、`toolbox.richinosan.com/*` を dashboard、`/calendar` と `/calendar/*` を calendar が処理します。
  （route を有効にするには `toolbox.richinosan.com` の DNS レコードが Cloudflare でプロキシされている必要があります。）

## コマンド

node / pnpm / ni は [mise](https://mise.jdx.dev/) で管理し、コマンドはすべて mise task に集約しています（`mise tasks` で一覧）。

```sh
mise install          # node / pnpm / ni を入れる
mise run install      # 依存パッケージをインストール
mise run build --all  # 全 app をビルド（--dashboard / --calendar のように app を指定することもできる）
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
3. ブラウザのタブに出る favicon として `apps/<tool>/public/icon.svg` を置く（`/<tool>/icon.svg` として、そのツールの Worker が配信する。ダッシュボードは `/icons/icon.svg`）。あわせて `apps/dashboard/public/sw.js` の `PRECACHE` にも `/<tool>/icon.svg` を足す

## デプロイ（GitHub Actions）

app 単位でデプロイします。`.github/workflows/deploy.yml` が [jdx/mise-action](https://github.com/jdx/mise-action) で mise.toml のツールを入れたうえで、`mise run install` → `mise run tests` → `mise run deploy <app>` の順に実行します（`main` への push では動きません）。

- タグ `<app>/v*` を push するとその app をデプロイします（例: `git tag calendar/v1.0.0 && git push origin calendar/v1.0.0`）。
- Actions の Run workflow（手動実行）で app 名を入力してもデプロイできます。
- リポジトリの Secrets に `CF_ID`（Cloudflare のアカウント ID）と `CF_TOKEN`（API トークン）を設定します。workflow が cf CLI の読む `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` として渡します。
- API トークンには Workers Scripts の編集権限と、route 用に対象 zone（richinosan.com）の Workers Routes の編集権限が必要です。
