// @ts-check
import * as astroConfig from "astro/config";
import * as uiFonts from "#ui/fonts.mjs";

// 静的ビルドした dist/ を Worker の static assets として配信する。
export default astroConfig.defineConfig({
  site: "https://toolbox.richinosan.com",
  trailingSlash: "never",
  fonts: uiFonts.fonts,
});
