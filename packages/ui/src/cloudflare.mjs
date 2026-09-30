// @ts-check
import * as path from "node:path";
import * as url from "node:url";
import * as buildOutput from "@cloudflare/build-output-utils";
import * as cfConfig from "@cloudflare/config";

/**
 * Astro のビルド後に、app の cloudflare.config.ts と dist/ から
 * cf CLI が読む Build Output（.cloudflare/output/）を書き出す。
 * 静的サイトなので Worker のコードは持たず、dist/ をそのまま static assets として配信する。
 *
 * @returns {import("astro").AstroIntegration}
 */
export function cloudflareBuildOutput() {
  /** @type {string} */
  let root = "";
  return {
    name: "toolbox:cloudflare-build-output",
    hooks: {
      "astro:config:done": ({ config }) => {
        root = url.fileURLToPath(config.root);
      },
      "astro:build:done": async ({ logger }) => {
        const configPath = path.join(root, "cloudflare.config.ts");
        const context = {
          isPreview: process.env["CLOUDFLARE_PREVIEW_BUILD"] === "true",
          mode: process.env["CLOUDFLARE_ENV"],
        };
        const { result } = await cfConfig.loadAndParseConfig(
          configPath,
          context,
        );
        if (!result.success) throw result.error;
        if (!result.data.worker) {
          throw new Error(`${configPath} に worker がありません。`);
        }
        const { worker, containers: _containers, ...settings } = result.data;
        await buildOutput.cleanBuildOutputDir(root);
        await buildOutput.writeRootConfig(root, settings, context);
        await buildOutput.writeWorkerConfig({ root, config: worker });
        // base 付きの app（/calendar など）も dist/ 全体を配信するので outDir ではなく dist/ を渡す
        await buildOutput.writeAssets({
          root,
          sourceDirectory: path.join(root, "dist"),
        });
        logger.info("Cloudflare の Build Output を書き出しました。");
      },
    },
  };
}
