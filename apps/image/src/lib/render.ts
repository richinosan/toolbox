// レイヤーの描画。レイヤーごとにフィルター込みの画像を作ってキャッシュし、それを重ねて 1 枚にする。
import * as filters from "./filters";
import * as model from "./model";

/** canvas に渡すフォント指定。LINE Seed JP は Astro の Fonts API が付けた名前を CSS 変数から読む */
const fontFamily = (font: model.FontKey) => {
  switch (font) {
    case "line-seed": {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-line-seed-jp")
        .trim();
      return value || "system-ui, sans-serif";
    }
    case "gothic":
      return '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif';
    case "mincho":
      return '"Hiragino Mincho ProN", "Noto Serif JP", "Yu Mincho", "YuMincho", serif';
  }
};

export const fontString = (layer: model.TextLayer) =>
  `${layer.bold ? 700 : 400} ${layer.fontSize}px ${fontFamily(layer.font)}`;

let measureContext: CanvasRenderingContext2D | null = null;
const measurer = () => {
  measureContext ??= document.createElement("canvas").getContext("2d")!;
  return measureContext;
};

const lines = (layer: model.TextLayer) => layer.text.split(/\r?\n/);

/** テキストの行の高さ（px） */
const lineHeight = (layer: model.TextLayer) =>
  (layer.fontSize * layer.lineHeight) / 100;

/** テキストレイヤーの枠の大きさ（縁取りと影は含まない） */
export const measureText = (layer: model.TextLayer) => {
  const context = measurer();
  context.font = fontString(layer);
  const width = Math.max(
    layer.fontSize * 0.5,
    ...lines(layer).map((line) => context.measureText(line).width),
  );
  return {
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(lines(layer).length * lineHeight(layer))),
  };
};

/**
 * テキストの内容や大きさが変わったとき、枠の大きさを測り直す。
 * 左揃えは左端、中央揃えは中心、右揃えは右端の位置を保つ。
 */
export const fitText = (layer: model.TextLayer) => {
  const size = measureText(layer);
  if (size.width === layer.width && size.height === layer.height) return false;
  const anchor =
    layer.align === "left" ? 0 : layer.align === "center" ? 0.5 : 1;
  layer.x = Math.round(layer.x + (layer.width - size.width) * anchor);
  layer.width = size.width;
  layer.height = size.height;
  return true;
};

/** テキストに使う文字のフォントを読み込む（LINE Seed JP は文字の範囲ごとに分かれている） */
export const loadFont = async (layer: model.TextLayer) => {
  if (!("fonts" in document)) return;
  try {
    await document.fonts.load(fontString(layer), layer.text || "A");
  } catch {
    // 読み込めなくても代わりのフォントで描く
  }
};

/** 縁取りと影が枠の外にはみ出す幅 */
const textOverflow = (layer: model.TextLayer) =>
  Math.ceil(layer.strokeWidth + (layer.shadow ? layer.fontSize * 0.25 : 0));

const drawText = (
  context: CanvasRenderingContext2D,
  layer: model.TextLayer,
  ox: number,
  oy: number,
) => {
  context.font = fontString(layer);
  context.textAlign = layer.align;
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.miterLimit = 2;
  const x =
    ox +
    (layer.align === "left"
      ? 0
      : layer.align === "center"
        ? layer.width / 2
        : layer.width);
  const step = lineHeight(layer);
  const textLines = lines(layer);
  const shadow = () => {
    context.shadowColor = "rgb(0 0 0 / 0.55)";
    context.shadowBlur = layer.fontSize * 0.12;
    context.shadowOffsetX = layer.fontSize * 0.04;
    context.shadowOffsetY = layer.fontSize * 0.06;
  };
  const noShadow = () => {
    context.shadowColor = "transparent";
  };
  if (layer.strokeWidth > 0) {
    // 縁取りは文字の外側だけに見えるよう、太さの 2 倍で描いた上に塗りを重ねる
    if (layer.shadow) shadow();
    context.strokeStyle = layer.strokeColor;
    context.lineWidth = layer.strokeWidth * 2;
    textLines.forEach((line, i) =>
      context.strokeText(line, x, oy + step * i + step / 2),
    );
    noShadow();
  } else if (layer.shadow) shadow();
  context.fillStyle = layer.color;
  textLines.forEach((line, i) =>
    context.fillText(line, x, oy + step * i + step / 2),
  );
  noShadow();
};

const drawShape = (
  context: CanvasRenderingContext2D,
  layer: model.ShapeLayer,
  ox: number,
  oy: number,
) => {
  // 線は図形の内側に収める
  const inset = layer.strokeWidth / 2;
  const w = Math.max(0, layer.width - layer.strokeWidth);
  const h = Math.max(0, layer.height - layer.strokeWidth);
  context.beginPath();
  if (layer.type === "ellipse") {
    context.ellipse(
      ox + layer.width / 2,
      oy + layer.height / 2,
      w / 2,
      h / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else {
    const radius = Math.min(layer.radius, w / 2, h / 2);
    context.roundRect(ox + inset, oy + inset, w, h, Math.max(0, radius));
  }
  if (layer.fillEnabled) {
    context.fillStyle = layer.fill;
    context.fill();
  }
  if (layer.strokeWidth > 0) {
    context.strokeStyle = layer.stroke;
    context.lineWidth = layer.strokeWidth;
    context.stroke();
  }
};

export type Rendered = {
  canvas: HTMLCanvasElement;
  /** canvas の左上がレイヤーの左上からどれだけ外側にあるか */
  pad: number;
};

/**
 * レイヤー 1 枚をフィルター込みで描く（位置・不透明度・表示は含まない）。
 * 画像はぼかしても枠の外に広げず端を延長し、図形とテキストは外側に広げる。
 */
export const renderLayer = (
  layer: model.Layer,
  assets: model.Assets,
): Rendered => {
  const blurPad =
    layer.type === "image" ? 0 : filters.blurPadding(layer.filters.blur);
  const pad = (layer.type === "text" ? textOverflow(layer) : 0) + blurPad;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(layer.width) + pad * 2);
  canvas.height = Math.max(1, Math.round(layer.height) + pad * 2);
  const context = canvas.getContext("2d", { willReadFrequently: false })!;
  context.imageSmoothingQuality = "high";
  if (layer.type === "image") {
    const asset = assets.get(layer.asset);
    if (asset) context.drawImage(asset.image, 0, 0, layer.width, layer.height);
  } else if (layer.type === "text") {
    drawText(context, layer, pad, pad);
  } else {
    drawShape(context, layer, pad, pad);
  }
  if (model.hasFilters(layer.filters)) {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    filters.applyColor(image.data, filters.colorMatrix(layer.filters));
    filters.applyBlur(
      image.data,
      canvas.width,
      canvas.height,
      layer.filters.blur,
    );
    context.putImageData(image, 0, 0);
  }
  return { canvas, pad };
};

/** 描画結果に影響する値だけを並べたキー（位置・不透明度・名前は含まない） */
const cacheKey = (layer: model.Layer, fontVersion: number) => {
  const { x: _x, y: _y, opacity: _o, visible: _v, name: _n, ...rest } = layer;
  return (
    JSON.stringify(rest) + (layer.type === "text" ? `#${fontVersion}` : "")
  );
};

export class LayerCache {
  #entries = new Map<string, { key: string; rendered: Rendered }>();
  /** フォントの読み込みが終わったら増やして、テキストを描き直す */
  fontVersion = 0;

  get(layer: model.Layer, assets: model.Assets) {
    const key = cacheKey(layer, this.fontVersion);
    const entry = this.#entries.get(layer.id);
    if (entry && entry.key === key) return entry.rendered;
    const rendered = renderLayer(layer, assets);
    this.#entries.set(layer.id, { key, rendered });
    return rendered;
  }

  /** ドキュメントに無くなったレイヤーのキャッシュを捨てる */
  prune(doc: model.Doc) {
    const ids = new Set(doc.layers.map((layer) => layer.id));
    for (const id of this.#entries.keys())
      if (!ids.has(id)) this.#entries.delete(id);
  }

  clear() {
    this.#entries.clear();
  }
}

/** ドキュメントを context に重ねて描く。context の変換はドキュメント座標に合わせておく */
export const drawLayers = (
  context: CanvasRenderingContext2D,
  doc: model.Doc,
  assets: model.Assets,
  cache: LayerCache,
) => {
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const { canvas, pad } = cache.get(layer, assets);
    context.globalAlpha = layer.opacity / 100;
    context.drawImage(canvas, layer.x - pad, layer.y - pad);
  }
  context.globalAlpha = 1;
};

/** 背景込みで 1 枚の画像にする（書き出し用） */
export const flatten = (
  doc: model.Doc,
  assets: model.Assets,
  cache: LayerCache,
  background: string | null = doc.background,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = doc.width;
  canvas.height = doc.height;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, doc.width, doc.height);
  }
  drawLayers(context, doc, assets, cache);
  return canvas;
};
