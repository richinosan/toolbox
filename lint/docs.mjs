// 各ツールのヘルプ（技術仕様の ？ ポップオーバー）とチュートリアル（ツアー）の検査。
// どちらも apps/<app>/src/pages/index.astro の <Layout spec={...} tour={...}> に書く（以下「ヘルプ」）。
//
//   node lint/docs.mjs          … mise run docs-check から。spec と tour があり、tour の target / reveal が実在するかを見る
//   node lint/docs.mjs --stale  … main から app のコードを変えたのにヘルプを変えていない app を表示する（終了コード 1）
//   node lint/docs.mjs --hook   … Claude Code の Stop hook から。--stale と同じ判定で、該当すれば一度だけ停止を止めて更新を促す
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiDir = "packages/ui/src";

const apps = fs
  .readdirSync(path.join(root, "apps"))
  .filter((app) => fs.existsSync(path.join(root, pagePath(app))))
  .toSorted();

function pagePath(app) {
  return `apps/${app}/src/pages/index.astro`;
}

/** index.astro から <Layout ...> の開始タグ（spec と tour を含む部分）を取り出す */
function helpBlock(source) {
  const start = source.search(/^<Layout\b/m);
  if (start === -1) return undefined;
  const end = source.indexOf("\n>", start);
  return end === -1 ? undefined : source.slice(start, end + 2);
}

function git(args) {
  return childProcess
    .execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    .trim();
}

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...listFiles(child));
    else if (/\.(astro|ts|mjs)$/.test(entry.name)) result.push(child);
  }
  return result;
}

// ---- docs-check ----

function check() {
  const errors = [];
  const uiSource = listFiles(uiDir)
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  for (const app of apps) {
    const page = pagePath(app);
    const block = helpBlock(fs.readFileSync(path.join(root, page), "utf8"));
    if (!block) {
      errors.push(`${page}: <Layout> が見つかりません`);
      continue;
    }
    for (const key of ["overview", "network", "storage", "libraries"]) {
      if (!new RegExp(`\\b${key}:`).test(block)) {
        errors.push(`${page}: 技術仕様（spec）に ${key} がありません`);
      }
    }
    if (!/\btour=\{\[/.test(block)) {
      errors.push(`${page}: チュートリアル（tour）がありません`);
    }
    // tour の対象が無いステップは黙って飛ばされるので、ここで実在を確かめる
    const source =
      listFiles(`apps/${app}/src`)
        .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
        .join("\n") +
      "\n" +
      uiSource;
    for (const match of block.matchAll(/\b(target|reveal): "([^"]+)"/g)) {
      const selector = match[2];
      for (const id of selector.matchAll(/#([\w-]+)/g)) {
        if (!source.includes(`id="${id[1]}"`)) {
          errors.push(
            `${page}: tour の ${match[1]} "${selector}" の #${id[1]} がありません`,
          );
        }
      }
      for (const name of selector.matchAll(/\.([\w-]+)/g)) {
        if (!new RegExp(`class="[^"]*\\b${name[1]}\\b`).test(source)) {
          errors.push(
            `${page}: tour の ${match[1]} "${selector}" の .${name[1]} がありません`,
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`ヘルプ・チュートリアル・技術仕様: ${apps.length} app OK`);
}

// ---- --stale / --hook ----

function mergeBase() {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]);
    } catch {
      // 次の候補を試す
    }
  }
  return undefined;
}

/** main から app のコードを変えたのに、ヘルプ（<Layout> の spec・tour）を変えていない app */
function staleApps() {
  const base = mergeBase();
  if (!base) return [];
  const changed = new Set([
    ...git(["diff", "--name-only", base, "--", "apps"]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard", "--", "apps"]).split(
      "\n",
    ),
  ]);
  const stale = [];
  for (const app of apps) {
    const page = pagePath(app);
    const codeChanged = [...changed].some(
      (file) => file.startsWith(`apps/${app}/src/`) && file !== page,
    );
    let before = "";
    try {
      before = git(["show", `${base}:${page}`]);
    } catch {
      // main に無い新しい app
    }
    const after = fs.readFileSync(path.join(root, page), "utf8");
    const helpChanged = helpBlock(before) !== helpBlock(after);
    // index.astro だけを変えたときは、ヘルプ以外の部分が変わったかで判定する
    const pageChanged =
      changed.has(page) &&
      before.replace(helpBlock(before) ?? "", "") !==
        after.replace(helpBlock(after) ?? "", "");
    if ((codeChanged || pageChanged) && !helpChanged) stale.push(app);
  }
  return stale;
}

function staleMessage(stale) {
  return [
    `次の app はコードを変えましたが、ヘルプ・チュートリアル・技術仕様を更新していません: ${stale.join(", ")}`,
    "",
    "変更した機能が次のどれかに関わるなら、apps/<app>/src/pages/index.astro の <Layout> を更新してください。",
    "- spec.overview / network / storage / libraries（処理の場所、通信、保存する情報、ライブラリ）",
    "- tour（各ステップの説明文、新しい操作・ボタン、target / reveal のセレクター）",
    "更新したら mise run docs-check で tour の対象が実在するか確かめます。",
    "どれにも関わらない（不具合の修正など）なら更新は不要です。その場合は返信でそう判断した理由を一言添えてください。",
  ].join("\n");
}

const mode = process.argv[2];
if (mode === "--stale") {
  const stale = staleApps();
  if (stale.length > 0) {
    console.error(staleMessage(stale));
    process.exit(1);
  }
  console.log("ヘルプの更新漏れはありません");
} else if (mode === "--hook") {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    // 入力が読めなくても判定はできる
  }
  // 一度促したあとの停止は止めない（更新が不要な変更で止まり続けないように）
  if (input.stop_hook_active) process.exit(0);
  try {
    const stale = staleApps();
    if (stale.length > 0) {
      console.log(
        JSON.stringify({ decision: "block", reason: staleMessage(stale) }),
      );
    }
  } catch {
    // git が使えないなどで判定できないときは何もしない
  }
} else {
  check();
}
