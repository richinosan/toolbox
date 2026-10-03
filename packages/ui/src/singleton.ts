// ClientRouter でツール（別ビルドのアプリ）をまたいで遷移すると、同じ内容のスクリプトが
// アプリごとに別の URL で読み込まれる。window / document に付けるリスナーが重複しないよう、
// 最初に読み込まれたコピーだけが登録する（以降のコピーは何もしない）。
const registry = window as unknown as Record<string, unknown>;

export const once = (name: string, register: () => void) => {
  const key = `__toolbox_${name}`;
  if (registry[key]) return;
  registry[key] = true;
  register();
};
