// @ts-check
// @ts-expect-error @gosfc/vite は型定義を同梱していない
import gosfcVite from "@gosfc/vite";

/**
 * Go で書いたページの処理を読み込むための Vite プラグイン。各 app の astro.config.mjs の `vite.plugins` に渡す。
 * gosfc が `go:<import path>` の import を goesm で TypeScript に変換し、Vite が他のモジュールと同じようにバンドルする。
 * @returns {NonNullable<NonNullable<import("astro").AstroUserConfig["vite"]>["plugins"]>}
 */
export const vitePlugins = () => [gosfcVite()];
