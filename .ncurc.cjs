// npm-check-updates（mise run update）の設定。
// 基本は全パッケージを最新にする。最新にすると検査が動かなくなるものだけ、ここで上げ幅を絞る。
const targets = {
  // astro check が TypeScript 7 に未対応のため、6.0 系のパッチ更新だけにする（対応したらこの行を消す）
  typescript: "patch",
};

module.exports = {
  target: (name) => targets[name] ?? "latest",
};
