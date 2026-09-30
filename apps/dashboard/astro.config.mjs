// @ts-check
import { defineConfig } from "astro/config";

// 静的ビルドした dist/ を Worker の static assets として配信する。
export default defineConfig({
  site: "https://toolbox.richinosan.com",
  trailingSlash: "never",
});
