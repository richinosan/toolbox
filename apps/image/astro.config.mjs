// @ts-check
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import * as astroConfig from "astro/config";
import * as uiCloudflare from "#ui/cloudflare.mjs";
import * as uiFonts from "#ui/fonts.mjs";

// /image 配下を担当する Worker。
// Worker は URL パスそのままで assets を引くため、出力も dist/image/ に置き
// Worker の static assets には dist/ 全体を渡す（#ui/cloudflare.mjs）。
/**
 * AI・PDF を開くときに pdf.js が必要に応じて読み込むファイル
 *（日本語などの文字コード表・標準フォント・画像のデコーダ）を、出力の pdfjs/ に置く。
 * ページの読み込みには含めず、そのファイルが必要な AI・PDF を開いたときだけ取りにいく。
 *
 * @returns {import("astro").AstroIntegration}
 */
function pdfjsAssets() {
  return {
    name: "toolbox:image-pdfjs-assets",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const from = path.dirname(
          url.fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
        );
        const to = path.join(url.fileURLToPath(dir), "pdfjs");
        for (const name of ["cmaps", "standard_fonts", "wasm"])
          await fs.cp(path.join(from, name), path.join(to, name), {
            recursive: true,
            // pdf.js のフォーム用スクリプト実行環境（quickjs）は使わない
            filter: (source) => !path.basename(source).startsWith("quickjs"),
          });
      },
    },
  };
}

export default astroConfig.defineConfig({
  site: "https://toolbox.richinosan.com",
  base: "/image",
  outDir: "./dist/image",
  trailingSlash: "never",
  fonts: uiFonts.fonts,
  integrations: [pdfjsAssets(), uiCloudflare.cloudflareBuildOutput()],
});
