/** アイコン名。実体は #ui/ToolIcon.astro で解決する。 */
export type ToolIconName = "calendar";

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
];
