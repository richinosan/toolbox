# toolbox

toolbox.richinosan.com

小さな Web ツールを `toolbox.richinosan.com` 配下で提供するモノレポです。
1 tool = 1 Astro app = 1 Cloudflare Worker を基本とし、依存バージョン・共通 UI・ツール定義は workspace で共有します。

## 構成

```
apps/
  dashboard/   # /           ツール一覧（Worker: toolbox-dashboard）
packages/
  shared/      # ツール定義（tools.ts）
  ui/          # 共通レイアウト・アイコン・グローバル CSS（LINE Seed JP）
```

- 依存バージョンは `pnpm-workspace.yaml` の `catalog` で一元管理し、各 `package.json` からは `catalog:` で参照します。
- 各 app は自分の `astro.config.mjs` と `wrangler.jsonc`（Worker 名・route・assets）を持ち、単独でビルド・デプロイできます。
- 各 app は静的ビルドし、Worker の static assets として配信します。
- dashboard は `toolbox.richinosan.com/*` を担当します。各ツールはより具体的な route（`/<tool>` と `/<tool>/*`）を持つため、そちらが優先されます。
  （route を有効にするには `toolbox.richinosan.com` の DNS レコードが Cloudflare でプロキシされている必要があります。）

## コマンド

```sh
pnpm install
pnpm build          # 全 app をビルド
pnpm check          # 型チェック（astro check / tsc）
pnpm lint           # oxlint + 型チェック
pnpm format:check   # Prettier

pnpm --filter @toolbox/dashboard dev      # 単体で開発
pnpm --filter @toolbox/dashboard deploy   # 単体でビルド + デプロイ
```
