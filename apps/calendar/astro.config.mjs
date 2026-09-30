// @ts-check
import { defineConfig } from "astro/config";
import { fonts } from "#ui/fonts.mjs";

// /calendar 配下を担当する Worker。
// Worker は URL パスそのままで assets を引くため、出力も dist/calendar/ に置き
// wrangler.jsonc の assets.directory は dist/ を指す。
export default defineConfig({
  site: "https://toolbox.richinosan.com",
  base: "/calendar",
  outDir: "./dist/calendar",
  trailingSlash: "never",
  fonts,
});
