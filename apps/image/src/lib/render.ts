// レイヤーの描画。レイヤーごとにフィルター込みの画像を作ってキャッシュし、それを重ねて 1 枚にする。
import * as filters from "./filters";
import * as fonts from "./fonts";
import * as model from "./model";
import * as text from "./text";

/**
 * テキストの内容や大きさが変わったとき、枠の大きさを測り直す。
 * 左揃えは左端、中央揃えは中心、右揃えは右端の位置を保つ。
 */
export const fitText = (layer: model.TextLayer) => {
  const size = text.measure(layer);
  if (size.width === layer.width && size.height === layer.height) return false;
  const anchor =
    layer.align === "left" ? 0 : layer.align === "center" ? 0.5 : 1;
  layer.x = Math.round(layer.x + (layer.width - size.width) * anchor);
  layer.width = size.width;
  layer.height = size.height;
  return true;
};

/** テキストで使うフォントを読み込む（文字の範囲ごとに分かれたファイルの、必要な分だけ） */
export const loadFonts = (layer: model.TextLayer) =>
  Promise.all(
    text
      .fontUsage(layer.runs)
      .map((usage) => fonts.ensure(usage.font, usage.bold, usage.text)),
  );

const textPad = (layer: model.TextLayer | model.PathLayer, size: number) =>
  text.overflow(layer.strokeWidth, layer.shadow, size);

/** 拡大・縮小したパスの、一番大きな文字の大きさ */
const pathSize = (layer: model.PathLayer) =>
  layer.size *
  Math.min(layer.width / layer.baseWidth, layer.height / layer.baseHeight);

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

/** レイヤーを描く canvas が、レイヤーの枠からどれだけ外に広がるか（ぼかし・縁取りなど） */
export const layerPadding = (layer: model.Layer) => {
  const blurPad =
    layer.type === "image" ? 0 : filters.blurPadding(layer.filters.blur);
  return (
    (layer.type === "text"
      ? textPad(layer, text.maxSize(layer.runs))
      : layer.type === "path"
        ? textPad(layer, pathSize(layer))
        : 0) + blurPad
  );
};

/**
 * レイヤー 1 枚をフィルター込みで描く（位置・不透明度・表示は含まない）。
 * 画像はぼかしても枠の外に広げず端を延長し、図形とテキストは外側に広げる。
 */
export const renderLayer = (
  layer: model.Layer,
  assets: model.Assets,
): Rendered => {
  const pad = layerPadding(layer);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(layer.width) + pad * 2);
  canvas.height = Math.max(1, Math.round(layer.height) + pad * 2);
  const context = canvas.getContext("2d", { willReadFrequently: false })!;
  context.imageSmoothingQuality = "high";
  if (layer.type === "image") {
    const asset = assets.get(layer.asset);
    if (asset) context.drawImage(asset.image, 0, 0, layer.width, layer.height);
  } else if (layer.type === "text") {
    if (text.usesOutline(layer) && layer.outline) {
      text.drawParts(context, layer.outline.parts, {
        ...layer,
        size: text.maxSize(layer.runs),
        ox: pad,
        oy: pad,
      });
    } else text.draw(context, layer, pad, pad);
  } else if (layer.type === "path") {
    text.drawParts(context, layer.parts, {
      ...layer,
      size: pathSize(layer),
      ox: pad,
      oy: pad,
      scaleX: layer.width / layer.baseWidth,
      scaleY: layer.height / layer.baseHeight,
    });
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
    JSON.stringify(rest) +
    (layer.type === "text" ? `#${fontVersion}#${fonts.getVersion()}` : "")
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
  /** キャンバス上で編集中のテキスト（編集欄の文字を見せるので描かない） */
  hidden: string | null = null,
) => {
  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0 || layer.id === hidden) continue;
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
