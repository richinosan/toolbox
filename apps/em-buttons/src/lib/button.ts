// em-buttons のボタン設計とコード生成。ブラウザの API には依存しない（DOM は使わない）。

export type Size = "s" | "m" | "l";
export type Shadow = "none" | "soft" | "strong";
export type Hover = "none" | "dark" | "lift";
export type Output = "style" | "inline";

export type Settings = {
  label: string;
  url: string;
  newTab: boolean;
  /** 背景（グラデーションのときは上 → 下の開始色） */
  background: string;
  gradient: boolean;
  /** グラデーションの終了色 */
  backgroundEnd: string;
  color: string;
  borderWidth: number;
  borderColor: string;
  radius: number;
  pill: boolean;
  size: Size;
  bold: boolean;
  shadow: Shadow;
  hover: Hover;
  fullWidth: boolean;
};

export const defaultSettings: Settings = {
  label: "ボタン",
  url: "https://example.com",
  newTab: true,
  background: "#067a35",
  gradient: false,
  backgroundEnd: "#05642b",
  color: "#ffffff",
  borderWidth: 0,
  borderColor: "#05642b",
  radius: 8,
  pill: false,
  size: "m",
  bold: true,
  shadow: "soft",
  hover: "dark",
  fullWidth: false,
};

export const MAX_RADIUS = 32;
export const MAX_BORDER = 8;

const sizes = {
  s: { fontSize: 14, paddingY: 8, paddingX: 16 },
  m: { fontSize: 16, paddingY: 12, paddingX: 24 },
  l: { fontSize: 20, paddingY: 16, paddingX: 32 },
} satisfies Record<Size, unknown>;

const shadows = {
  none: "none",
  soft: "0 2px 6px rgba(0,0,0,.18)",
  strong: "0 6px 16px rgba(0,0,0,.32)",
} satisfies Record<Shadow, string>;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const isHex = (value: string) => HEX.test(value);

/** #rgb を #rrggbb にそろえ、小文字にする。不正な値は fallback を返す。 */
export const normalizeHex = (value: string, fallback: string) => {
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) return fallback;
  const lower = trimmed.toLowerCase();
  if (lower.length === 4) {
    const [, r, g, b] = lower;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? Math.round(value) : min),
  );

// ---- リンク URL ----

export type UrlCheck =
  { ok: true; href: string } | { ok: false; reason: string };

// javascript: などのスキームを通さないよう、使えるものだけを許可する
const ALLOWED_URL = /^(?:https?:\/\/|mailto:|tel:|\/|\.{1,2}\/|#)/i;

export const checkUrl = (raw: string): UrlCheck => {
  const url = raw.trim();
  // 空や # だけのリンクは、押すと貼り付け先のページを開き直したり先頭へ戻したりするので出力しない
  if (url === "" || url === "#")
    return { ok: false, reason: "リンク先の URL を入力してください。" };
  // 空白・改行・制御文字を含む URL は貼り付けミスなので弾く
  if (/[\s\p{Cc}]/u.test(url))
    return { ok: false, reason: "URL に空白や改行は使えません。" };
  if (!ALLOWED_URL.test(url))
    return {
      ok: false,
      reason:
        "https:// から始まる URL を入力してください（mailto: と tel: も使えます）。",
    };
  const invalid = {
    ok: false,
    reason: "URL の形式が正しくありません。",
  } as const;
  // http(s) は URL として解釈できて、ホスト名があるものだけを通す（https:// だけ、などを弾く）
  if (/^https?:/i.test(url)) {
    if (!URL.canParse(url) || new URL(url).hostname === "") return invalid;
  } else if (/^(?:mailto|tel):/i.test(url) && /^[^:]+:\/*$/.test(url)) {
    return invalid;
  }
  return { ok: true, href: url };
};

// ---- コントラスト ----

const channel = (hex: string, index: number) =>
  Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;

const luminance = (hex: string) => {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const c = channel(hex, i);
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG のコントラスト比（1〜21）。引数は #rrggbb。 */
export const contrastRatio = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted(
    (x, y) => y - x,
  ) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** 2 色を sRGB の値のまま（CSS の linear-gradient と同じ補間で）混ぜる。t は 0〜1。 */
const mix = (from: string, to: string, t: number) =>
  `#${[0, 1, 2]
    .map((i) => {
      const a = Math.round(channel(from, i) * 255);
      const b = Math.round(channel(to, i) * 255);
      return Math.round(a + (b - a) * t)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;

const GRADIENT_SAMPLES = 16;

/** 文字色と背景のうち、いちばん低い比。グラデーションは途中の色も含めて調べる（両端が良くても中間で悪くなることがある）。 */
export const worstContrast = (settings: Settings) => {
  const backgrounds = settings.gradient
    ? Array.from({ length: GRADIENT_SAMPLES + 1 }, (_, i) =>
        mix(settings.background, settings.backgroundEnd, i / GRADIENT_SAMPLES),
      )
    : [settings.background];
  return Math.min(
    ...backgrounds.map((bg) => contrastRatio(settings.color, bg)),
  );
};

// ---- コード生成 ----

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const radiusOf = (settings: Settings) =>
  settings.pill ? 9999 : clamp(settings.radius, 0, MAX_RADIUS);

/** ボタン本体の宣言（`property:value` の配列）。 */
const baseDeclarations = (settings: Settings, extras: readonly string[]) => {
  const size = sizes[settings.size];
  const border = clamp(settings.borderWidth, 0, MAX_BORDER);
  const background = settings.gradient
    ? `linear-gradient(180deg,${settings.background},${settings.backgroundEnd})`
    : settings.background;
  return [
    settings.fullWidth ? "display:block" : "display:inline-block",
    ...(settings.fullWidth ? ["width:100%"] : []),
    "box-sizing:border-box",
    `padding:${size.paddingY}px ${size.paddingX}px`,
    `font-family:inherit`,
    `font-size:${size.fontSize}px`,
    `font-weight:${settings.bold ? 700 : 400}`,
    "line-height:1.4",
    "text-align:center",
    "text-decoration:none",
    "cursor:pointer",
    `color:${settings.color}`,
    `background:${background}`,
    border > 0
      ? `border:${border}px solid ${settings.borderColor}`
      : "border:0",
    `border-radius:${radiusOf(settings)}px`,
    `box-shadow:${shadows[settings.shadow]}`,
    ...extras,
  ];
};

const anchor = (settings: Settings, href: string, attrs: string) => {
  const target = settings.newTab
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
  return `<a ${attrs}href="${escapeHtml(href)}"${target}>${escapeHtml(settings.label.trim())}</a>`;
};

/** 同じ設計なら同じ名前になる、短いハッシュ（他のサイトのクラス名とぶつからないように付ける） */
const hash = (text: string) => {
  let value = 5381;
  for (const char of text) value = (value * 33) ^ char.codePointAt(0)!;
  return (value >>> 0).toString(36).slice(0, 6).padStart(6, "0");
};

export type Snippet = { code: string; className: string };

/** `<style>` と `<a>` を 1 つにしたコード。hover・フォーカス・視差効果の設定まで含める。 */
export const buildStyleSnippet = (settings: Settings, href: string) => {
  const transition = "transition:filter .15s,transform .15s,box-shadow .15s";
  const base = baseDeclarations(settings, [transition]);
  const className = `emb-${hash(base.join(";") + settings.hover)}`;
  const rules = [`.${className}{${base.join(";")}}`];
  if (settings.hover === "dark")
    rules.push(`.${className}:hover{filter:brightness(.9)}`);
  if (settings.hover === "lift")
    rules.push(
      `.${className}:hover{transform:translateY(-2px);box-shadow:0 8px 18px rgba(0,0,0,.3)}`,
    );
  rules.push(
    `.${className}:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}`,
    `@media (prefers-reduced-motion:reduce){.${className}{transition:none}.${className}:hover{transform:none}}`,
  );
  const code = `<style>\n${rules.join("\n")}\n</style>\n${anchor(settings, href, `class="${className}" `)}`;
  return { code, className } satisfies Snippet;
};

/** `style` 属性だけのコード。`<style>` を取り除くメールや一部の CMS 向け（hover は効かない）。 */
export const buildInlineSnippet = (settings: Settings, href: string) => {
  const style = baseDeclarations(settings, []).join(";");
  return anchor(settings, href, `style="${style}" `);
};

export const buildSnippet = (
  settings: Settings,
  href: string,
  output: Output,
) =>
  output === "style"
    ? buildStyleSnippet(settings, href).code
    : buildInlineSnippet(settings, href);

// ---- プリセット ----

export type Preset = { id: string; name: string; settings: Partial<Settings> };

export const presets: readonly Preset[] = [
  { id: "green", name: "グリーン", settings: {} },
  {
    id: "outline",
    name: "アウトライン",
    settings: {
      background: "#ffffff",
      color: "#1b1f24",
      borderWidth: 2,
      borderColor: "#1b1f24",
      shadow: "none",
      hover: "dark",
    },
  },
  {
    id: "dark",
    name: "ダーク",
    settings: {
      background: "#1b1f24",
      color: "#ffffff",
      radius: 4,
      shadow: "none",
      hover: "lift",
    },
  },
  {
    id: "gradient",
    name: "グラデーション",
    settings: {
      background: "#1a86d9",
      backgroundEnd: "#0b4f9c",
      gradient: true,
      color: "#ffffff",
      radius: 12,
      shadow: "strong",
      hover: "lift",
    },
  },
  {
    id: "pill",
    name: "ピル",
    settings: {
      background: "#ffd43b",
      color: "#1b1f24",
      pill: true,
      size: "l",
      shadow: "soft",
      hover: "lift",
    },
  },
];
