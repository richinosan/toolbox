// @ts-check
import { defineConfig } from "astro/config";
import { fonts } from "#ui/fonts.mjs";

// 静的ビルドした dist/ を Worker の static assets として配信する。
export default defineConfig({
  site: "https://toolbox.richinosan.com",
  trailingSlash: "never",
  fonts,
});
