/** アイコン名。実体は #ui/ToolIcon.astro で解決する。 */
export type ToolIconName = "calendar" | "em-buttons";

export type ToolDefinition = {
  id: string;
  name: string;
  /** ツールが何であるかの短い説明（画面には出さず、ページの meta description に使う） */
  description: string;
  /** toolbox.richinosan.com 配下のパス。各ツール Worker の route と一致させる。 */
  href: string;
  icon: ToolIconName;
};

export const tools: readonly ToolDefinition[] = [
  {
    id: "calendar",
    name: "Calendar",
    description: "暦に関連するツール",
    href: "/calendar",
    icon: "calendar",
  },
  {
    id: "em-buttons",
    name: "em-buttons",
    description: "コピー＆ペーストで埋め込めるカスタムボタンを作るツール",
    href: "/em-buttons",
    icon: "em-buttons",
  },
];
