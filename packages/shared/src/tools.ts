/** アイコン名。実体は #ui/ToolIcon.astro で解決する。 */
export type ToolIconName = "calendar";

export type ToolDefinition = {
  id: string;
  name: string;
  description: string;
  /** toolbox.richinosan.com 配下のパス。各ツール Worker の route と一致させる。 */
  href: string;
  icon: ToolIconName;
};

export const tools: readonly ToolDefinition[] = [
  {
    id: "calendar",
    name: "Calendar",
    description: "日付から曜日と Unix time を確認するツール",
    href: "/calendar",
    icon: "calendar",
  },
];
