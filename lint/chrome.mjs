// 共有部分（ヘッダー・フッター・メニュー）が全 app で同じバージョンかを、配信中のページで検査する。
// 各ページの <meta name="toolbox-chrome">（#ui/version.mjs のハッシュ）を取得し、
// 全 app で一致し、手元のソースから計算した値とも一致することを確かめる。
//
//   node lint/chrome.mjs                 … mise run chrome-check から。本番（toolbox.richinosan.com）を検査する
//   node lint/chrome.mjs --wait          … デプロイ直後用。反映を待って数回やり直す（Deploy workflow から）
//   node lint/chrome.mjs --stale         … バージョンが違う app の名前を JSON の配列で出す（Deploy workflow が一緒にデプロイする app を決める）
//   node lint/chrome.mjs --origin <url>  … 検査先を変える（手元で配信したサイトなど）
import * as fs from "node:fs";
import * as path from "node:path";
import * as version from "../packages/ui/src/version.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const originIndex = args.indexOf("--origin");
const origin =
  originIndex === -1
    ? "https://toolbox.richinosan.com"
    : (args[originIndex + 1] ?? "").replace(/\/$/, "");
const attempts = args.includes("--wait") ? 12 : 1;
const interval = 10_000;

/** app ごとのページのパス（astro.config.mjs の base。無ければサイトのルート） */
const pages = fs
  .readdirSync(path.join(root, "apps"))
  .filter((app) =>
    fs.existsSync(path.join(root, "apps", app, "astro.config.mjs")),
  )
  .toSorted()
  .map((app) => {
    const config = fs.readFileSync(
      path.join(root, "apps", app, "astro.config.mjs"),
      "utf8",
    );
    return { app, path: /\bbase: "([^"]+)"/.exec(config)?.[1] ?? "/" };
  });

async function served(page) {
  try {
    const response = await fetch(origin + page.path, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return `HTTP ${response.status}`;
    const html = await response.text();
    return (
      /<meta name="toolbox-chrome" content="([^"]+)"/.exec(html)?.[1] ??
      "（バージョンの meta がありません）"
    );
  } catch (error) {
    return `取得できません: ${error instanceof Error ? error.message : error}`;
  }
}

const expected = version.chromeVersion();
let results = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  results = await Promise.all(
    pages.map(async (page) => ({ ...page, version: await served(page) })),
  );
  if (results.every((result) => result.version === expected)) break;
  if (attempt < attempts) {
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const stale = results.filter((result) => result.version !== expected);
if (args.includes("--stale")) {
  console.log(JSON.stringify(stale.map((result) => result.app)));
  process.exit(0);
}
for (const result of results) {
  const mark = result.version === expected ? "OK " : "NG ";
  console.log(
    `${mark} ${result.app.padEnd(12)} ${result.path.padEnd(14)} ${result.version}`,
  );
}
if (stale.length > 0) {
  console.error(
    [
      "",
      `共有部分（ヘッダー・フッター・メニュー）のバージョンが揃っていません。手元のソースのバージョン: ${expected}`,
      `バージョンが違う app: ${stale.map((result) => result.app).join(", ")}`,
      "Deploy workflow は、バージョンが違う app を指定した app と一緒にデプロイします。",
      "ここで失敗したときは、その app のデプロイが失敗していないかを確かめてください。",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`共有部分のバージョン: ${pages.length} app すべて ${expected}`);
