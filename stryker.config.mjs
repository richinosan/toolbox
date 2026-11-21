// ミューテーションテスト（mise run mutation）の設定。
// 実装をわざと少しずつ書き換え（ミュータント）、単体テストがそれを検出できるかを調べる。
import * as fs from "node:fs";

// 対象は、隣に *.test.ts がある実装だけ（テストの無いファイルを書き換えても、検出できないのが分かりきっている）。
// テストを足せば、ここを変えなくても対象に入る。
const tests = fs.globSync(["apps/**/*.test.ts", "packages/**/*.test.ts"], {
  exclude: (name) => name === "node_modules",
});

/** @type {import("@stryker-mutator/core").PartialStrykerOptions} */
export default {
  mutate: tests.map((test) => test.replace(/\.test\.ts$/, ".ts")),
  // 単体テスト（mise run unit）と同じコマンドで確かめる
  testRunner: "command",
  commandRunner: {
    command: "node --test 'apps/**/*.test.ts' 'packages/**/*.test.ts'",
  },
  ignorePatterns: ["**/dist", "**/.astro", "**/.wrangler", "**/.cloudflare"],
  tempDirName: "tmp/stryker",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "tmp/mutation/index.html" },
  jsonReporter: { fileName: "tmp/mutation/mutation.json" },
};
