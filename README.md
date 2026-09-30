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

```sh
pnpm install
pnpm build          # 全 app をビルド
pnpm check          # 型チェック（astro check / tsc）
pnpm lint           # ESLint
pnpm format:check   # Prettier
```
