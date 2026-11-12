// @ts-check
// 共有部分（ヘッダー・フッター・メニュー）のバージョン。
// ヘッダーなどは各 app のビルドに焼き込まれるので、全 app を同じ内容からビルドしたときだけ挙動が揃う。
// 共有部分のソース（packages/ui, packages/shared）と依存のバージョン（pnpm-lock.yaml）からハッシュを作り、
// 各ページの <meta name="toolbox-chrome"> に入れる。本番の全ページで一致するかは lint/chrome.mjs が検査する。
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sources = ["packages/ui/src", "packages/shared/src"];
const files = ["pnpm-lock.yaml"];

/** @param {string} dir */
function listFiles(dir) {
  /** @type {string[]} */
  const result = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), {
    withFileTypes: true,
  })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...listFiles(child));
    else result.push(child);
  }
  return result;
}

/** 共有部分のバージョン（内容が同じなら、どの app・どの環境でビルドしても同じ値） */
export function chromeVersion() {
  const hash = crypto.createHash("sha256");
  const all = [...sources.flatMap((dir) => listFiles(dir)), ...files];
  for (const file of all.toSorted()) {
    hash.update(file);
    hash.update("\0");
    // 改行コードの違い（checkout の設定）で値が変わらないようにする
    hash.update(
      fs
        .readFileSync(path.join(repoRoot, file), "utf8")
        .replaceAll("\r\n", "\n"),
    );
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * 共有部分のバージョンを import.meta.env.TOOLBOX_CHROME_VERSION として #ui/Layout.astro に渡す。
 *
 * @returns {import("astro").AstroIntegration}
 */
export function chromeVersionIntegration() {
  return {
    name: "toolbox:chrome-version",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            define: {
              "import.meta.env.TOOLBOX_CHROME_VERSION":
                JSON.stringify(chromeVersion()),
            },
          },
        });
      },
    },
  };
}
