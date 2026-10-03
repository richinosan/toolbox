// @ts-check
import * as astroConfig from "astro/config";
import * as uiCloudflare from "#ui/cloudflare.mjs";
import * as uiFonts from "#ui/fonts.mjs";

// /image 配下を担当する Worker。
// Worker は URL パスそのままで assets を引くため、出力も dist/image/ に置き
// Worker の static assets には dist/ 全体を渡す（#ui/cloudflare.mjs）。
export default astroConfig.defineConfig({
  site: "https://toolbox.richinosan.com",
  base: "/image",
  outDir: "./dist/image",
  trailingSlash: "never",
  fonts: uiFonts.fonts,
  integrations: [uiCloudflare.cloudflareBuildOutput()],
});
