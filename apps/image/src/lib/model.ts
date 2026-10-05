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
  name: string;
  visible: boolean;
  /** 0〜100 */
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
  filters: Filters;
};

export type ImageLayer = LayerBase & {
  type: "image";
  /** Assets のキー */
  asset: string;
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

export type Layer = ImageLayer | ShapeLayer | TextLayer | PathLayer;
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
  name,
  visible: true,
  opacity: 100,
  x: Math.round((doc.width - width) / 2),
  y: Math.round((doc.height - height) / 2),
  width,
  height,
  filters: { ...defaultFilters },
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
  };
};

export const duplicateLayer = (layer: Layer): Layer => ({
  ...structuredClone(layer),
  id: newId(),
  name: `${layer.name} のコピー`,
  x: layer.x + 16,
  y: layer.y + 16,
});

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
