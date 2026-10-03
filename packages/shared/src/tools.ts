/** アイコン名。実体は #ui/ToolIcon.astro で解決する。 */
export type ToolIconName = "calendar";

export type ToolDefinition = {
  id: string;
  name: string;
  /** ツールが何であるかの短い説明 */
  description: string;
  /** ツールでできること（説明とは分けて管理する） */
  features: readonly string[];
  /** toolbox.richinosan.com 配下のパス。各ツール Worker の route と一致させる。 */
  href: string;
  icon: ToolIconName;
};

export const tools: readonly ToolDefinition[] = [
  {
    id: "calendar",
    name: "Calendar",
    description: "暦に関連するツール",
    features: ["日付から曜日を確認する", "日付から Unix time（秒）を確認する"],
    href: "/calendar",
    icon: "calendar",
  },
];
