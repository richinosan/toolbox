// @ts-check
import * as astroConfig from "astro/config";

/**
 * 全 app 共通のフォント設定。各 app の astro.config.mjs の `fonts` に渡す。
 * Astro の Fonts API が woff2 だけの @font-face を生成し、必要なサブセットだけが読み込まれる。
 * @type {NonNullable<import("astro").AstroUserConfig["fonts"]>}
 */
export const fonts = [
  {
    provider: astroConfig.fontProviders.npm(),
    name: "LINE Seed JP",
    cssVariable: "--font-line-seed-jp",
    weights: [400, 700],
    styles: ["normal"],
    fallbacks: ["system-ui", "sans-serif"],
  },
];
