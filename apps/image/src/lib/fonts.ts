// テキストに使うフォントの管理。
// - 標準: LINE Seed JP（サイトのフォント。Astro の Fonts API が配信する）
// - Web フォント: Fontsource のフォントを、使うときだけ jsDelivr から読み込む（文字の範囲ごとに分かれたファイルの必要な分だけ）
// - 端末のフォント: Local Font Access API（Chrome / Edge）で一覧を読み、local() で使う
// - ファイル: 読み込んだ .ttf / .otf / .woff / .woff2 をそのまま使う（ページを閉じると消える）
// どのフォントも canvas では別名（tb-…）で登録し、同じ名前のフォントが端末にあっても取り違えないようにする。

export type FontSource = "builtin" | "web" | "local" | "file";

export type FontRef = {
  source: FontSource;
  /** builtin: キー / web: Fontsource の id / local・file: ファミリー名 */
  id: string;
  /** 画面に出す名前 */
  family: string;
  /** web: 用意されている太さ */
  weights?: number[];
  /** local: 標準と太字の PostScript 名（local() に使う） */
  faces?: { regular: string; bold?: string };
};

export type FontStatus = "ready" | "loading" | "missing";

export const builtin: FontRef = {
  source: "builtin",
  id: "line-seed",
  family: "LINE Seed JP",
};

export const keyOf = (ref: FontRef) => `${ref.source}:${ref.id}`;

export const sameFont = (a: FontRef, b: FontRef) => keyOf(a) === keyOf(b);

const FONTSOURCE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const CDN = "https://cdn.jsdelivr.net/npm/@fontsource";
const CATALOG = "https://api.fontsource.org/v1/fonts";

export type CatalogFont = {
  id: string;
  family: string;
  weights: number[];
  category: string;
  japanese: boolean;
};

/** よく使うフォント（最初に一覧に出す）。太さは Fontsource の情報どおり */
export const recommended: readonly CatalogFont[] = [
  [
    "noto-sans-jp",
    "Noto Sans JP",
    [100, 200, 300, 400, 500, 600, 700, 800, 900],
    "sans-serif",
    true,
  ],
  [
    "noto-serif-jp",
    "Noto Serif JP",
    [200, 300, 400, 500, 600, 700, 800, 900],
    "serif",
    true,
  ],
  [
    "m-plus-rounded-1c",
    "M PLUS Rounded 1c",
    [100, 300, 400, 500, 700, 800, 900],
    "sans-serif",
    true,
  ],
  [
    "zen-maru-gothic",
    "Zen Maru Gothic",
    [300, 400, 500, 700, 900],
    "sans-serif",
    true,
  ],
  [
    "zen-kaku-gothic-new",
    "Zen Kaku Gothic New",
    [300, 400, 500, 700, 900],
    "sans-serif",
    true,
  ],
  ["biz-udpgothic", "BIZ UDPGothic", [400, 700], "sans-serif", true],
  ["kosugi-maru", "Kosugi Maru", [400], "sans-serif", true],
  ["dela-gothic-one", "Dela Gothic One", [400], "display", true],
  ["rocknroll-one", "RocknRoll One", [400], "sans-serif", true],
  ["mochiy-pop-one", "Mochiy Pop One", [400], "sans-serif", true],
  ["reggae-one", "Reggae One", [400], "display", true],
  ["potta-one", "Potta One", [400], "display", true],
  ["train-one", "Train One", [400], "display", true],
  ["dotgothic16", "DotGothic16", [400], "sans-serif", true],
  ["yusei-magic", "Yusei Magic", [400], "sans-serif", true],
  ["hachi-maru-pop", "Hachi Maru Pop", [400], "handwriting", true],
  ["klee-one", "Klee One", [400, 600], "handwriting", true],
  ["yomogi", "Yomogi", [400], "handwriting", true],
  [
    "shippori-mincho",
    "Shippori Mincho",
    [400, 500, 600, 700, 800],
    "serif",
    true,
  ],
  [
    "zen-old-mincho",
    "Zen Old Mincho",
    [400, 500, 600, 700, 900],
    "serif",
    true,
  ],
  ["kaisei-decol", "Kaisei Decol", [400, 500, 700], "serif", true],
  ["bebas-neue", "Bebas Neue", [400], "sans-serif", false],
  ["anton", "Anton", [400], "sans-serif", false],
  ["oswald", "Oswald", [200, 300, 400, 500, 600, 700], "sans-serif", false],
  [
    "montserrat",
    "Montserrat",
    [100, 200, 300, 400, 500, 600, 700, 800, 900],
    "sans-serif",
    false,
  ],
  [
    "poppins",
    "Poppins",
    [100, 200, 300, 400, 500, 600, 700, 800, 900],
    "sans-serif",
    false,
  ],
  [
    "inter",
    "Inter",
    [100, 200, 300, 400, 500, 600, 700, 800, 900],
    "sans-serif",
    false,
  ],
  [
    "playfair-display",
    "Playfair Display",
    [400, 500, 600, 700, 800, 900],
    "serif",
    false,
  ],
  ["lobster", "Lobster", [400], "display", false],
  ["pacifico", "Pacifico", [400], "handwriting", false],
  ["permanent-marker", "Permanent Marker", [400], "handwriting", false],
].map(([id, family, weights, category, japanese]) => ({
  id: id as string,
  family: family as string,
  weights: weights as number[],
  category: category as string,
  japanese: japanese as boolean,
}));

export const categoryLabels: Record<string, string> = {
  "sans-serif": "ゴシック",
  serif: "明朝・セリフ",
  display: "デザイン",
  handwriting: "手書き",
  monospace: "等幅",
};

export const webRef = (font: CatalogFont): FontRef => ({
  source: "web",
  id: font.id,
  family: font.family,
  weights: font.weights,
});

// ---- 状態の通知 ----

const listeners = new Set<() => void>();
/** フォントの読み込みや追加で状態が変わったら呼ばれる（描画のキャッシュを捨てるため） */
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
let version = 0;
export const getVersion = () => version;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

// ---- 太さ ----

/** 指定した太さに一番近い、用意されている太さ */
const nearestWeight = (weights: readonly number[], target: number) =>
  weights.reduce(
    (best, weight) =>
      Math.abs(weight - target) < Math.abs(best - target) ? weight : best,
    weights[0] ?? 400,
  );

/** 太字にしたとき、実際のフォントに太字があるか（無ければブラウザが擬似的に太くする） */
export const hasRealBold = (ref: FontRef) => {
  switch (ref.source) {
    case "builtin":
      return true;
    case "web":
      return (ref.weights ?? [400]).some((weight) => weight >= 600);
    case "local":
      return Boolean(ref.faces?.bold);
    case "file":
      return (fileFaces.get(ref.id) ?? []).some((face) => face.weight >= 600);
  }
};

/** web フォントで読み込む太さのファイル（太字が無いフォントは標準の太さを読み、ブラウザに太らせる） */
const webWeight = (ref: FontRef, bold: boolean) => {
  const weights = ref.weights?.length ? ref.weights : [400];
  const heavy = weights.filter((w) => w >= 600);
  return bold && heavy.length > 0
    ? nearestWeight(heavy, 700)
    : nearestWeight(weights, 400);
};

// ---- canvas・CSS に渡す名前 ----

const quote = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

/** 別名に使えるよう、文字列を短い英数字にする */
const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

const alias = (ref: FontRef) => `tb-${ref.source}-${hash(ref.id)}`;

const builtinFamily = () => {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-line-seed-jp")
    .trim();
  return value || "system-ui, sans-serif";
};

/** canvas の font や CSS の font-family に使う値（代わりのフォントも付ける） */
export const cssFamily = (ref: FontRef) =>
  ref.source === "builtin"
    ? builtinFamily()
    : `${quote(alias(ref))}, ${builtinFamily()}`;

/** canvas の font 指定。web フォントは実際に用意されている太さを使う */
export const fontString = (ref: FontRef, size: number, bold: boolean) => {
  // 太字が無いフォントでも 700 を指定すれば、ブラウザが擬似的に太らせる
  const weight =
    ref.source === "web" && !(bold && !hasRealBold(ref))
      ? webWeight(ref, bold)
      : bold
        ? 700
        : 400;
  return `${weight} ${size}px ${cssFamily(ref)}`;
};

/**
 * document.fonts.load に渡す font 指定。代わりのフォントを含めると、端末に無い代わりのフォント
 * （local("Arial") など）の読み込みに失敗して全体が失敗するので、そのフォントだけを指定する
 */
const loadString = (ref: FontRef, bold: boolean) => {
  const family =
    ref.source === "builtin"
      ? (builtinFamily().split(",")[0] ?? "sans-serif")
      : quote(alias(ref));
  return fontString(ref, 16, bold).replace(cssFamily(ref), family);
};

// ---- 読み込み ----

type WebFace = {
  url: string;
  weight: number;
  ranges: [number, number][];
};

const statuses = new Map<string, FontStatus>();
const webFaces = new Map<string, WebFace[]>();
const webCss = new Map<string, Promise<WebFace[]>>();

export const status = (ref: FontRef): FontStatus => {
  if (ref.source === "builtin") return "ready";
  return statuses.get(keyOf(ref)) ?? "loading";
};

const setStatus = (ref: FontRef, next: FontStatus) => {
  if (statuses.get(keyOf(ref)) === next) return;
  statuses.set(keyOf(ref), next);
  changed();
};

const parseRanges = (value: string): [number, number][] =>
  value
    .split(",")
    .map((part) => part.trim().replace(/^U\+/i, ""))
    .filter(Boolean)
    .map((part) => {
      if (part.includes("?")) {
        return [
          Number.parseInt(part.replace(/\?/g, "0"), 16),
          Number.parseInt(part.replace(/\?/g, "f"), 16),
        ];
      }
      const [start, end] = part.split("-");
      const a = Number.parseInt(start ?? "0", 16);
      return [a, end ? Number.parseInt(end, 16) : a];
    });

/** Fontsource の CSS を読み、@font-face を別名で登録する */
const loadWebWeight = (ref: FontRef, weight: number) => {
  const key = `${ref.id}@${weight}`;
  let pending = webCss.get(key);
  if (!pending) {
    pending = (async () => {
      if (!FONTSOURCE_ID.test(ref.id)) throw new Error("invalid font id");
      const cssUrl = `${CDN}/${ref.id}@5/${weight}.css`;
      const response = await fetch(cssUrl);
      if (!response.ok) throw new Error(`font css ${response.status}`);
      const css = await response.text();
      const faces: WebFace[] = [];
      for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
        if (/font-style:\s*italic/.test(block)) continue;
        const url = /url\(([^)]+?\.woff2)\)/.exec(block)?.[1];
        if (!url) continue;
        const absolute = new URL(url.replace(/["']/g, ""), cssUrl).href;
        if (!absolute.startsWith(`${CDN}/`)) continue;
        const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
        const face = new FontFace(
          alias(ref),
          `url(${absolute}) format("woff2")`,
          {
            weight: String(weight),
            display: "swap",
            ...(range ? { unicodeRange: range } : {}),
          },
        );
        document.fonts.add(face);
        faces.push({
          url: absolute,
          weight,
          ranges: range ? parseRanges(range) : [[0, 0x10ffff]],
        });
      }
      webFaces.set(key, faces);
      return faces;
    })();
    webCss.set(key, pending);
    pending.catch(() => webCss.delete(key));
  }
  return pending;
};

const localFaces = new Map<string, Map<string, FontData>>();

/** text に使う文字のフォントを読み込む。使えるようになったら true */
export const ensure = async (
  ref: FontRef,
  bold: boolean,
  text: string,
): Promise<boolean> => {
  const sample = text || "A";
  try {
    switch (ref.source) {
      case "builtin":
        await document.fonts.load(loadString(ref, bold), sample);
        return true;
      case "web":
        await loadWebWeight(ref, webWeight(ref, bold));
        await document.fonts.load(loadString(ref, bold), sample);
        setStatus(ref, "ready");
        return true;
      case "local":
        await registerLocal(ref);
        return status(ref) === "ready";
      case "file":
        if (!fileFaces.has(ref.id)) {
          setStatus(ref, "missing");
          return false;
        }
        return true;
    }
  } catch {
    setStatus(ref, "missing");
    return false;
  }
};

// ---- 端末のフォント ----

type FontData = {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob: () => Promise<Blob>;
};

type LocalWindow = Window & {
  queryLocalFonts?: () => Promise<FontData[]>;
};

export const canQueryLocal = () =>
  typeof (window as LocalWindow).queryLocalFonts === "function";

export type LocalFamily = { family: string; ref: FontRef };

const isBoldStyle = (style: string) => /bold|heavy|black|w[6-9]/i.test(style);
const isRegularStyle = (style: string) =>
  /^(regular|normal|book|roman|w[34]|medium)$/i.test(style.trim());

/** 端末のフォントの一覧（ファミリーごと）。読めないときは null */
export const queryLocal = async (): Promise<LocalFamily[] | null> => {
  const query = (window as LocalWindow).queryLocalFonts;
  if (!query) return null;
  const list = await query.call(window);
  const families = new Map<string, FontData[]>();
  for (const data of list) {
    const faces = families.get(data.family) ?? [];
    faces.push(data);
    families.set(data.family, faces);
  }
  const result: LocalFamily[] = [];
  for (const [family, faces] of families) {
    const byName = new Map(faces.map((face) => [face.postscriptName, face]));
    localFaces.set(family, byName);
    const regular =
      faces.find((face) => isRegularStyle(face.style)) ??
      faces.find(
        (face) =>
          !isBoldStyle(face.style) && !/italic|oblique/i.test(face.style),
      ) ??
      faces[0]!;
    const bold = faces.find(
      (face) => isBoldStyle(face.style) && !/italic|oblique/i.test(face.style),
    );
    result.push({
      family,
      ref: {
        source: "local",
        id: family,
        family,
        faces: {
          regular: regular.postscriptName,
          ...(bold ? { bold: bold.postscriptName } : {}),
        },
      },
    });
  }
  return result.toSorted((a, b) => a.family.localeCompare(b.family, "ja"));
};

const localRegistered = new Map<string, Promise<void>>();

/** 端末のフォントを local() で別名に登録する。見つからなければ missing にする */
const registerLocal = (ref: FontRef) => {
  const key = keyOf(ref);
  let pending = localRegistered.get(key);
  if (!pending) {
    pending = (async () => {
      const faces = ref.faces ?? { regular: ref.id };
      const entries: [string, number][] = [[faces.regular, 400]];
      if (faces.bold) entries.push([faces.bold, 700]);
      const loaded = await Promise.all(
        entries.map(async ([name, weight]) => {
          const face = new FontFace(alias(ref), `local(${quote(name)})`, {
            weight: String(weight),
          });
          try {
            await face.load();
            document.fonts.add(face);
            return true;
          } catch {
            return false;
          }
        }),
      );
      setStatus(ref, loaded[0] ? "ready" : "missing");
    })();
    localRegistered.set(key, pending);
  }
  return pending;
};

// ---- ファイルから読み込んだフォント ----

type FileFace = { weight: number; data: ArrayBuffer; postscriptName?: string };
const fileFaces = new Map<string, FileFace[]>();

/** フォントファイルを登録する。ファミリー名と太さはファイルから読む */
export const addFile = async (file: File): Promise<FontRef> => {
  const data = await file.arrayBuffer();
  const fontkit = await import("fontkit");
  const parsed = fontkit.create(new Uint8Array(data) as never);
  const font = "fonts" in parsed ? parsed.fonts[0] : parsed;
  if (!font) throw new Error("empty font collection");
  const family = (font.familyName || file.name.replace(/\.[^.]+$/, "")).slice(
    0,
    100,
  );
  const os2 = (font as unknown as { "OS/2"?: { usWeightClass?: number } })[
    "OS/2"
  ];
  const weight =
    os2?.usWeightClass ?? (/bold/i.test(font.subfamilyName) ? 700 : 400);
  const ref: FontRef = { source: "file", id: family, family };
  const face = new FontFace(alias(ref), data, { weight: String(weight) });
  await face.load();
  document.fonts.add(face);
  const faces = fileFaces.get(family) ?? [];
  faces.push({
    weight,
    data,
    ...("fonts" in parsed ? { postscriptName: font.postscriptName } : {}),
  });
  fileFaces.set(family, faces);
  statuses.set(keyOf(ref), "ready");
  changed();
  return ref;
};

// ---- 文字の形（パス）を作るためのフォントのデータ ----

export type FontBinary = {
  data: ArrayBuffer;
  postscriptName?: string;
  /** 太字が無く、太らせて描く必要がある */
  synthetic: boolean;
};

const binaryCache = new Map<string, Promise<ArrayBuffer>>();
const fetchBinary = (url: string) => {
  let pending = binaryCache.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`font ${response.status}`);
      return response.arrayBuffer();
    });
    binaryCache.set(url, pending);
    pending.catch(() => binaryCache.delete(url));
  }
  return pending;
};

const inRanges = (ranges: [number, number][], codePoint: number) =>
  ranges.some(([a, b]) => codePoint >= a && codePoint <= b);

/** CSSOM の font-weight（"bold" や "normal" になることもある）を数にする */
const cssWeight = (value: string) => {
  const v = value.trim();
  if (v === "bold") return 700;
  return Number.parseInt(v, 10) || 400;
};

/** LINE Seed JP は、ページの CSS の @font-face から URL を読む */
const builtinFaces = (): WebFace[] => {
  const family = builtinFamily().split(",")[0]?.trim().replace(/["']/g, "");
  const faces: WebFace[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const style = rule.style;
      if (
        style.getPropertyValue("font-family").replace(/["']/g, "").trim() !==
        family
      )
        continue;
      const src = /url\(["']?([^"')]+)["']?\)/.exec(
        style.getPropertyValue("src"),
      )?.[1];
      if (!src) continue;
      const range = style.getPropertyValue("unicode-range");
      faces.push({
        url: new URL(src, sheet.href ?? location.href).href,
        weight: cssWeight(style.getPropertyValue("font-weight")),
        ranges: range ? parseRanges(range) : [[0, 0x10ffff]],
      });
    }
  }
  return faces;
};

/**
 * 1 文字分のフォントのデータ。web フォントと LINE Seed JP は文字の範囲ごとにファイルが分かれているので、
 * その文字を含むファイルを返す。手に入らなければ null。
 */
export const binaryFor = async (
  ref: FontRef,
  bold: boolean,
  codePoint: number,
): Promise<(FontBinary & { key: string }) | null> => {
  switch (ref.source) {
    case "builtin":
    case "web": {
      let weight: number;
      let faces: WebFace[];
      if (ref.source === "web") {
        weight = webWeight(ref, bold);
        faces = await loadWebWeight(ref, weight);
      } else {
        // ページの CSS にある太さの中から選ぶ（太字が無ければ標準の太さを太らせて描く）
        const all = builtinFaces();
        const weights = [...new Set(all.map((face) => face.weight))];
        const heavy = weights.filter((w) => w >= 600);
        weight =
          bold && heavy.length > 0
            ? nearestWeight(heavy, 700)
            : nearestWeight(weights, 400);
        faces = all.filter((face) => face.weight === weight);
      }
      const face = faces.find((f) => inRanges(f.ranges, codePoint));
      if (!face) return null;
      return {
        key: face.url,
        data: await fetchBinary(face.url),
        synthetic: bold && weight < 600,
      };
    }
    case "file": {
      const faces = fileFaces.get(ref.id) ?? [];
      const face =
        faces.find((f) => (bold ? f.weight >= 600 : f.weight < 600)) ??
        faces[0];
      if (!face) return null;
      return {
        key: `file:${ref.id}:${face.weight}`,
        data: face.data,
        ...(face.postscriptName ? { postscriptName: face.postscriptName } : {}),
        synthetic: bold && face.weight < 600,
      };
    }
    case "local": {
      const faces = ref.faces ?? { regular: ref.id };
      const name = bold && faces.bold ? faces.bold : faces.regular;
      let data = localFaces.get(ref.id)?.get(name);
      if (!data) {
        // ページを開き直したあとは、もう一度一覧を読む（許可済みなら確認は出ない）
        try {
          await queryLocal();
        } catch {
          return null;
        }
        data = localFaces.get(ref.id)?.get(name);
      }
      if (!data) return null;
      const blob = await data.blob();
      return {
        key: `local:${name}`,
        data: await blob.arrayBuffer(),
        postscriptName: name,
        synthetic: bold && !faces.bold,
      };
    }
  }
};

// ---- Fontsource の一覧（検索用） ----

let catalog: Promise<CatalogFont[]> | null = null;

export const loadCatalog = () => {
  catalog ??= fetch(CATALOG)
    .then((response) => {
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      return response.json() as Promise<unknown>;
    })
    .then((data) =>
      (Array.isArray(data) ? data : [])
        .filter(
          (
            item,
          ): item is {
            id: string;
            family: string;
            weights: number[];
            category: string;
            subsets: string[];
          } =>
            typeof item === "object" &&
            item !== null &&
            typeof item.id === "string" &&
            FONTSOURCE_ID.test(item.id) &&
            typeof item.family === "string" &&
            Array.isArray(item.weights) &&
            Array.isArray(item.subsets) &&
            item.category !== "icons",
        )
        .map((item) => ({
          id: item.id,
          family: item.family,
          weights: item.weights.filter((w) => typeof w === "number"),
          category: String(item.category),
          japanese: item.subsets.includes("japanese"),
        })),
    );
  catalog.catch(() => {
    catalog = null;
  });
  return catalog;
};

/** 作品ファイルから読んだフォント指定を確かめる */
export const readRef = (value: unknown): FontRef => {
  if (typeof value !== "object" || value === null) return builtin;
  const v = value as Record<string, unknown>;
  const source = v["source"];
  const id = typeof v["id"] === "string" ? v["id"].slice(0, 200) : "";
  const family =
    typeof v["family"] === "string" ? v["family"].slice(0, 200) : id;
  if (!id) return builtin;
  switch (source) {
    case "web": {
      if (!FONTSOURCE_ID.test(id)) return builtin;
      const weights = Array.isArray(v["weights"])
        ? v["weights"]
            .filter(
              (w): w is number =>
                typeof w === "number" && w >= 100 && w <= 1000,
            )
            .slice(0, 20)
        : [400];
      return { source, id, family, weights: weights.length ? weights : [400] };
    }
    case "local": {
      const faces = v["faces"] as Record<string, unknown> | undefined;
      const regular =
        typeof faces?.["regular"] === "string"
          ? faces["regular"].slice(0, 200)
          : id;
      const bold =
        typeof faces?.["bold"] === "string"
          ? faces["bold"].slice(0, 200)
          : undefined;
      return {
        source,
        id,
        family,
        faces: { regular, ...(bold ? { bold } : {}) },
      };
    }
    case "file":
      return { source, id, family };
    default:
      return builtin;
  }
};
