// IMAGE のドキュメント（キャンバスとレイヤー）のデータ構造。
// 座標・大きさはすべてドキュメントのピクセル単位（整数）で持つ。
import * as fonts from "./fonts";

/** 一度に扱えるキャンバスの最大面積（iOS Safari の canvas の上限 16,777,216px に合わせる） */
export const MAX_AREA = 4096 * 4096;
/** キャンバスの 1 辺の最大長 */
export const MAX_SIDE = 8192;

export type FilterPreset =
  "none" | "mono" | "sepia" | "invert" | "vivid" | "warm" | "cool" | "fade";

export const filterPresets: readonly (readonly [FilterPreset, string])[] = [
  ["none", "なし"],
  ["mono", "モノクロ"],
  ["sepia", "セピア"],
  ["vivid", "ビビッド"],
  ["warm", "暖色"],
  ["cool", "寒色"],
  ["fade", "フェード"],
  ["invert", "反転"],
];

export type Filters = {
  preset: FilterPreset;
  /** -100〜100（0 で変化なし） */
  brightness: number;
  /** -100〜100 */
  contrast: number;
  /** -100〜100 */
  saturation: number;
  /** -180〜180（度） */
  hue: number;
  /** 色かぶせの色（明るさを保ったまま、この色味に寄せる） */
  tint: string;
  /** 色かぶせの強さ 0〜100 */
  tintAmount: number;
  /** ガウスぼかしの半径（標準偏差・px）0〜100 */
  blur: number;
};

export const defaultFilters: Filters = {
  preset: "none",
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  tint: "#ff8a00",
  tintAmount: 0,
  blur: 0,
};

type LayerBase = {
  id: string;
  /**
   * 入っているフレームの id（フレームに入っていなければ null）。
   * レイヤーは下から上の順の 1 列で持ち、フレームの中身はフレームのすぐ上に続けて並べる
   */
  parent: string | null;
  name: string;
  visible: boolean;
  /** 0〜100 */
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
  filters: Filters;
  /**
   * 背面のフィルター（CSS の backdrop-filter と同じ考え方）。
   * レイヤーの形の範囲だけ、下に重なっている絵にフィルターを掛けてから、その上にレイヤーを描く
   */
  backdrop: Filters;
};

/** 上・右・下・左（CSS の padding と同じ順） */
export type Sides = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/**
 * ボックス（CSS のボックスモデル）。レイヤーの枠の内側に、外から順に枠線・余白・中身が入る（box-sizing: border-box）
 */
export type Box = {
  /** 内側の余白（padding） */
  padding: Sides;
  /** 背景（background-color） */
  fill: string;
  fillEnabled: boolean;
  /** 枠線（border）の太さ */
  borderWidth: number;
  borderColor: string;
  /** 角の丸さ（border-radius） */
  radius: number;
};

export const defaultBox = (): Box => ({
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  fill: "#ffffff",
  fillEnabled: false,
  borderWidth: 0,
  borderColor: "#1b1f24",
  radius: 0,
});

export type ImageLayer = LayerBase & {
  type: "image";
  /** Assets のキー */
  asset: string;
  box: Box;
};

/**
 * フレームの中身の並べ方。
 * free は自由に置く（position: absolute）、row・column は flex、grid は grid
 */
export type LayoutMode = "free" | "row" | "column" | "grid";
export type AlignValue = "start" | "center" | "end";

export type FrameLayout = {
  mode: LayoutMode;
  /** 中身どうしの間隔（gap） */
  gap: number;
  /** 横・縦の揃え（画面の向きで持つ。flex では並ぶ向きに合わせて justify / align に読み替える） */
  alignX: AlignValue;
  alignY: AlignValue;
  /** 並ぶ向きに均等に配置する（justify-content: space-between） */
  distribute: boolean;
  /** 並ぶ向きと直角の向きに伸ばす（align-items: stretch）。グリッドではセルいっぱいに広げる */
  stretch: boolean;
  /** グリッドの列の数（grid-template-columns: repeat(n, 1fr)） */
  columns: number;
  /** フレームの大きさを中身に合わせる（width / height: fit-content） */
  hug: boolean;
};

export const layoutModes: readonly (readonly [LayoutMode, string])[] = [
  ["free", "自由"],
  ["row", "横並び"],
  ["column", "縦並び"],
  ["grid", "グリッド"],
];

/** 中身を並べる入れ物（HTML の div のようなもの） */
export type FrameLayer = LayerBase & {
  type: "frame";
  box: Box;
  layout: FrameLayout;
};

export type ShapeLayer = LayerBase & {
  type: "rect" | "ellipse";
  fill: string;
  fillEnabled: boolean;
  stroke: string;
  strokeWidth: number;
  /** 角の丸さ（四角のみ） */
  radius: number;
};

export type TextAlign = "left" | "center" | "right";

/** 文字ごとの書式 */
export type CharStyle = {
  font: fonts.FontRef;
  /** 文字の大きさ（px） */
  size: number;
  color: string;
  bold: boolean;
};

/** 同じ書式が続く文字のまとまり。改行（\n）も文字として含む */
export type TextRun = { text: string; style: CharStyle };

/** 保存時に作る、文字の形のパス（フォントが無い端末でも同じ見た目で表示するため） */
export type TextOutline = {
  /** パスを作ったときの文字と書式（変わっていたら使わない） */
  key: string;
  width: number;
  height: number;
  /** レイヤーの左上を原点にした SVG のパス */
  parts: { d: string; color: string; bold: boolean }[];
};

export type TextLayer = LayerBase & {
  type: "text";
  runs: TextRun[];
  align: TextAlign;
  /** 行の高さ（各行の一番大きな文字に対する倍率 ×100） */
  lineHeight: number;
  strokeColor: string;
  /** 縁取りの太さ（px） */
  strokeWidth: number;
  shadow: boolean;
  outline: TextOutline | null;
  box: Box;
};

/** テキストを「パスに変換」したレイヤー */
export type PathLayer = LayerBase & {
  type: "path";
  /** パスの座標の基準の大きさ（width / height との比で拡大・縮小する） */
  baseWidth: number;
  baseHeight: number;
  parts: { d: string; color: string; bold: boolean }[];
  /** 変換したときの一番大きな文字の大きさ（影の大きさに使う） */
  size: number;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
};

export type Layer =
  ImageLayer | ShapeLayer | TextLayer | PathLayer | FrameLayer;
export type LayerType = Layer["type"];

export type Doc = {
  name: string;
  width: number;
  height: number;
  /** 背景色。null は透明 */
  background: string | null;
  /** 下から上の順 */
  layers: Layer[];
};

export type Asset = {
  blob: Blob;
  image: ImageBitmap;
};

export type Assets = Map<string, Asset>;

/** トリミングの比率のプリセット。size があるものは、その大きさ（px）に合わせることもできる */
export type CropPreset = {
  id: string;
  label: string;
  /** 幅 ÷ 高さ。null は自由 */
  ratio: number | null;
  size: readonly [number, number] | null;
  /** 名前の横に小さく出す説明 */
  note?: string;
};

export const cropPresets: readonly CropPreset[] = [
  { id: "free", label: "自由", ratio: null, size: null },
  { id: "square", label: "1:1", ratio: 1, size: null, note: "正方形" },
  { id: "4-5", label: "4:5", ratio: 4 / 5, size: null },
  { id: "16-9", label: "16:9", ratio: 16 / 9, size: null },
  { id: "ogp", label: "OGP", ratio: 1200 / 630, size: [1200, 630] },
  { id: "x", label: "X（Twitter）", ratio: 16 / 9, size: [1600, 900] },
  { id: "a4-portrait", label: "A4 縦", ratio: 1 / Math.SQRT2, size: null },
  { id: "a4-landscape", label: "A4 横", ratio: Math.SQRT2, size: null },
];

export const layerTypeLabels: Record<LayerType, string> = {
  image: "画像",
  rect: "四角",
  ellipse: "丸",
  text: "テキスト",
  path: "パス",
  frame: "フレーム",
};

export const newId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const base = (
  doc: Doc,
  name: string,
  width: number,
  height: number,
): LayerBase => ({
  id: newId(),
  parent: null,
  name,
  visible: true,
  opacity: 100,
  x: Math.round((doc.width - width) / 2),
  y: Math.round((doc.height - height) / 2),
  width,
  height,
  filters: { ...defaultFilters },
  backdrop: { ...defaultFilters },
});

/** 同じ種類のレイヤーの数から「テキスト 2」のような名前を付ける */
const nextName = (doc: Doc, type: LayerType) => {
  const label = layerTypeLabels[type];
  const count = doc.layers.filter((layer) => layer.type === type).length;
  return count === 0 ? label : `${label} ${count + 1}`;
};

export const createShape = (doc: Doc, type: "rect" | "ellipse"): ShapeLayer => {
  const size = Math.max(16, Math.round(Math.min(doc.width, doc.height) * 0.3));
  return {
    ...base(doc, nextName(doc, type), size, size),
    type,
    fill: type === "rect" ? "#06c755" : "#1a73e8",
    fillEnabled: true,
    stroke: "#ffffff",
    strokeWidth: 0,
    radius: 0,
  };
};

export const createText = (doc: Doc, style?: CharStyle): TextLayer => {
  const size = Math.max(12, Math.round(Math.min(doc.width, doc.height) / 10));
  return {
    // 大きさは文字から決まるので、描画時に測った値で上書きする
    ...base(doc, nextName(doc, "text"), size * 4, size),
    type: "text",
    runs: [
      {
        text: "テキスト",
        style: style ?? {
          font: fonts.builtin,
          size,
          color: "#ffffff",
          bold: true,
        },
      },
    ],
    align: "center",
    lineHeight: 130,
    strokeColor: "#1b1f24",
    strokeWidth: Math.max(1, Math.round(size / 12)),
    shadow: false,
    outline: null,
    box: defaultBox(),
  };
};

export const defaultLayout = (): FrameLayout => ({
  mode: "row",
  gap: 16,
  alignX: "center",
  alignY: "center",
  distribute: false,
  stretch: false,
  columns: 2,
  hug: false,
});

/** 新しいフレーム。余白と間隔はキャンバスの大きさに合わせる */
export const createFrame = (doc: Doc): FrameLayer => {
  const unit = Math.max(4, Math.round(Math.min(doc.width, doc.height) / 40));
  const width = Math.max(32, Math.round(doc.width * 0.5));
  const height = Math.max(32, Math.round(doc.height * 0.3));
  return {
    ...base(doc, nextName(doc, "frame"), width, height),
    type: "frame",
    box: {
      ...defaultBox(),
      padding: { top: unit, right: unit, bottom: unit, left: unit },
      // 白い背景の上でも見えるよう、薄い灰色にする
      fill: "#eceff3",
      fillEnabled: true,
      radius: unit,
    },
    layout: { ...defaultLayout(), gap: unit },
  };
};

export const createImage = (
  doc: Doc,
  asset: string,
  imageWidth: number,
  imageHeight: number,
  name: string,
): ImageLayer => {
  // キャンバスに収まる大きさまで縮める（拡大はしない）
  const scale = Math.min(1, doc.width / imageWidth, doc.height / imageHeight);
  const width = Math.max(1, Math.round(imageWidth * scale));
  const height = Math.max(1, Math.round(imageHeight * scale));
  return {
    ...base(doc, name || nextName(doc, "image"), width, height),
    type: "image",
    asset,
    box: defaultBox(),
  };
};

/** ボックスを持つレイヤー（テキスト・画像・フレーム） */
export const hasBox = (
  layer: Layer,
): layer is TextLayer | ImageLayer | FrameLayer =>
  layer.type === "text" || layer.type === "image" || layer.type === "frame";

/** 枠線と余白を合わせた、中身までの距離 */
export const insets = (layer: Layer): Sides => {
  if (!hasBox(layer)) return { top: 0, right: 0, bottom: 0, left: 0 };
  const { padding, borderWidth } = layer.box;
  return {
    top: padding.top + borderWidth,
    right: padding.right + borderWidth,
    bottom: padding.bottom + borderWidth,
    left: padding.left + borderWidth,
  };
};

/** ボックスに見た目があるか（背景・枠線・角の丸さ・余白のどれか） */
export const boxVisible = (box: Box) => box.fillEnabled || box.borderWidth > 0;

// ---- フレームの入れ子 ----
// レイヤーは 1 列に並べ、フレームの中身（子孫すべて）はフレームのすぐ上に続けて置く。
// こうすると描く順（下から上）は今までどおり 1 列のままで、フレームは中身の背景になる。

/** index のレイヤーと、その中身（子孫）の範囲 [index, end) の end */
export const subtreeEnd = (layers: readonly Layer[], index: number) => {
  const ids = new Set([layers[index]!.id]);
  let end = index + 1;
  while (end < layers.length && ids.has(layers[end]!.parent ?? "")) {
    ids.add(layers[end]!.id);
    end++;
  }
  return end;
};

/** 中身（子孫）も含めたレイヤー */
export const subtree = (layers: readonly Layer[], layer: Layer) => {
  const index = layers.indexOf(layer);
  return index < 0 ? [] : layers.slice(index, subtreeEnd(layers, index));
};

/** 直接の中身（下から上の順） */
export const childrenOf = (layers: readonly Layer[], id: string) =>
  layers.filter((layer) => layer.parent === id);

/** 入れ子の深さ（フレームに入っていなければ 0） */
export const depthOf = (layers: readonly Layer[], layer: Layer) => {
  let depth = 0;
  let parent = layer.parent;
  while (parent) {
    depth++;
    parent = layers.find((l) => l.id === parent)?.parent ?? null;
  }
  return depth;
};

/** 入っているフレーム */
export const parentOf = (layers: readonly Layer[], layer: Layer) =>
  layer.parent
    ? ((layers.find((l) => l.id === layer.parent) as FrameLayer | undefined) ??
      null)
    : null;

/** フレームのレイアウトで位置が決まるレイヤーか（自由配置でないフレームの中身） */
export const isLaidOut = (layers: readonly Layer[], layer: Layer) => {
  const parent = parentOf(layers, layer);
  return parent !== null && parent.layout.mode !== "free" && layer.visible;
};

/**
 * 入れ子の決まり（親はフレームで、中身はすぐ上に続く）を守っていないレイヤーを、フレームの外に出す。
 * 読み込んだファイルが壊れていても描けるようにする
 */
export const repairTree = (layers: Layer[]) => {
  const stack: string[] = [];
  for (const layer of layers) {
    if (layer.parent) {
      while (stack.length > 0 && stack.at(-1) !== layer.parent) stack.pop();
      if (stack.length === 0) layer.parent = null;
    } else stack.length = 0;
    if (layer.type === "frame") stack.push(layer.id);
  }
};

/**
 * 親をたどった表示・不透明度（フレームを隠すと中身も隠れ、フレームの不透明度は中身にも掛かる）
 */
export const effective = (layers: readonly Layer[]) => {
  const out = new Map<string, { visible: boolean; opacity: number }>();
  for (const layer of layers) {
    const parent = layer.parent ? out.get(layer.parent) : undefined;
    out.set(layer.id, {
      visible: layer.visible && (parent?.visible ?? true),
      opacity: (layer.opacity / 100) * (parent?.opacity ?? 1),
    });
  }
  return out;
};

/** 中身も含めて複製する（中身の親は、複製したフレームに付け替える） */
export const duplicateSubtree = (layers: readonly Layer[]): Layer[] => {
  const ids = new Map<string, string>();
  return layers.map((layer, i) => {
    const copy = structuredClone(layer);
    copy.id = newId();
    ids.set(layer.id, copy.id);
    if (i === 0) copy.name = `${layer.name} のコピー`;
    else copy.parent = ids.get(layer.parent ?? "") ?? copy.parent;
    copy.x += 16;
    copy.y += 16;
    return copy;
  });
};

/** キャンバスの大きさを上限内に収める（縦横比は保つ） */
export const fitSize = (width: number, height: number) => {
  const scale = Math.min(
    1,
    MAX_SIDE / width,
    MAX_SIDE / height,
    Math.sqrt(MAX_AREA / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scaled: scale < 1,
  };
};

export const hasFilters = (filters: Filters) =>
  filters.preset !== "none" ||
  filters.brightness !== 0 ||
  filters.contrast !== 0 ||
  filters.saturation !== 0 ||
  filters.hue !== 0 ||
  filters.tintAmount !== 0 ||
  filters.blur !== 0;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
