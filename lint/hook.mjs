// Claude Code の Stop hook（.claude/settings.json）。次の順に実行する。
//   1. mise run tests … アップデート（mise upgrade --bump + npm-check-updates）→ 脆弱性の検査（pnpm audit）→ lint・型チェック → 整形チェック・ヘルプの検査
//   2. node lint/docs.mjs --hook … ヘルプ・チュートリアル・技術仕様の更新漏れの確認
// 1 が失敗したら、出力の末尾を添えて一度だけ停止を止める。
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  // 入力が読めなくても検査はできる
}
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  // 同上
}
// 一度止めたあとの停止は止めない（直せない失敗で止まり続けないように）
if (input.stop_hook_active) process.exit(0);

const tests = childProcess.spawnSync("mise", ["run", "tests"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (tests.error) {
  // mise が無い環境では検査できないので、更新漏れの確認だけ行う
  console.error(`mise を実行できませんでした: ${tests.error.message}`);
} else if (tests.status !== 0) {
  const tail = `${tests.stdout}\n${tests.stderr}`
    .trim()
    .split("\n")
    .slice(-60)
    .join("\n");
  console.log(
    JSON.stringify({
      decision: "block",
      reason: [
        "mise run tests（アップデート → 脆弱性の検査 → lint・型チェック → 整形チェック・ヘルプの検査）が失敗しました。直してから終わってください。",
        "アップデートで入った新しいバージョンが原因のときは、コードを追従させるか、.ncurc.cjs でそのパッケージの上げ幅を絞ります。",
        "pnpm audit の失敗は、修正版へ上げて直します（間接依存は pnpm-workspace.yaml の overrides）。修正版が無いときだけ、理由を添えて auditConfig.ignoreGhsas に書きます。",
        "",
        tail,
      ].join("\n"),
    }),
  );
  process.exit(0);
}

const docs = childProcess.spawnSync(
  process.execPath,
  [path.join(root, "lint/docs.mjs"), "--hook"],
  { cwd: root, input: raw, encoding: "utf8" },
);
if (docs.stdout) process.stdout.write(docs.stdout);
