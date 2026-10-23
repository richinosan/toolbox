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
  const size = textSize(layer);
  if (size.width === layer.width && size.height === layer.height) return false;
  const anchor =
    layer.align === "left" ? 0 : layer.align === "center" ? 0.5 : 1;
  layer.x = Math.round(layer.x + (layer.width - size.width) * anchor);
  layer.width = size.width;
  layer.height = size.height;
  return true;
};

/** テキストの枠の大きさ（文字の大きさに、ボックスの余白と枠線を足す） */
export const textSize = (layer: model.TextLayer) => {
  const size = text.measure(layer);
  const inset = model.insets(layer);
  return {
    width: size.width + inset.left + inset.right,
    height: size.height + inset.top + inset.bottom,
  };
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

/** ボックスの形（角の丸さは枠の大きさに収める） */
const boxPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  context.beginPath();
  context.roundRect(
    x,
    y,
    Math.max(0, width),
    Math.max(0, height),
    Math.max(0, Math.min(radius, width / 2, height / 2)),
  );
};

/** ボックスの背景と枠線（枠線は枠の内側に描く。CSS の box-sizing: border-box と同じ） */
const drawBox = (
  context: CanvasRenderingContext2D,
  layer: model.Layer,
  ox: number,
  oy: number,
) => {
  if (!model.hasBox(layer)) return;
  const { box, width, height } = layer;
  if (box.fillEnabled) {
    boxPath(context, ox, oy, width, height, box.radius);
    context.fillStyle = box.fill;
    context.fill();
  }
  if (box.borderWidth > 0) {
    const half = box.borderWidth / 2;
    boxPath(
      context,
      ox + half,
      oy + half,
      width - box.borderWidth,
      height - box.borderWidth,
      box.radius - half,
    );
    context.strokeStyle = box.borderColor;
    context.lineWidth = box.borderWidth;
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
  // 画像はぼかしても枠の外に広げない（ボックスを付けた画像は、図形と同じように広げる）
  const blurPad =
    layer.type === "image" && !model.boxVisible(layer.box)
      ? 0
      : filters.blurPadding(layer.filters.blur);
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
  drawBox(context, layer, pad, pad);
  const inset = model.insets(layer);
  if (layer.type === "image") {
    const asset = assets.get(layer.asset);
    const { box } = layer;
    const width = layer.width - inset.left - inset.right;
    const height = layer.height - inset.top - inset.bottom;
    if (asset && width > 0 && height > 0) {
      context.save();
      // 余白が無いときは、画像の角も枠の角に合わせて丸める（CSS の overflow: hidden と同じ見た目）
      const { top, right, bottom, left } = box.padding;
      if (box.radius > 0 && !(top || right || bottom || left)) {
        boxPath(
          context,
          pad + inset.left,
          pad + inset.top,
          width,
          height,
          box.radius - box.borderWidth,
        );
        context.clip();
      }
      context.drawImage(
        asset.image,
        pad + inset.left,
        pad + inset.top,
        width,
        height,
      );
      context.restore();
    }
  } else if (layer.type === "text") {
    if (text.usesOutline(layer) && layer.outline) {
      text.drawParts(context, layer.outline.parts, {
        ...layer,
        size: text.maxSize(layer.runs),
        ox: pad + inset.left,
        oy: pad + inset.top,
      });
    } else text.draw(context, layer, pad + inset.left, pad + inset.top);
  } else if (layer.type === "frame") {
    // フレームはボックスだけ（中身はそれぞれのレイヤーとして上に重ねる）
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

/** 描画結果に影響する値だけを並べたキー（位置・不透明度・名前・親・背面のフィルターは含まない） */
const cacheKey = (layer: model.Layer, fontVersion: number) => {
  const {
    x: _x,
    y: _y,
    opacity: _o,
    visible: _v,
    name: _n,
    parent: _p,
    backdrop: _b,
    ...rest
  } = layer;
  return (
    JSON.stringify(rest) +
    (layer.type === "text" ? `#${fontVersion}#${fonts.getVersion()}` : "")
  );
};

/** 背面のフィルターを掛けた絵（レイヤーの形で切り抜き済み）。x, y はドキュメントの px */
export type Backdrop = { canvas: HTMLCanvasElement; x: number; y: number };

export class LayerCache {
  #entries = new Map<
    string,
    { key: string; rendered: Rendered; revision: number }
  >();
  #backdrops = new Map<string, { key: string; backdrop: Backdrop | null }>();
  #revision = 0;
  /** フォントの読み込みが終わったら増やして、テキストを描き直す */
  fontVersion = 0;

  get(layer: model.Layer, assets: model.Assets) {
    const key = cacheKey(layer, this.fontVersion);
    const entry = this.#entries.get(layer.id);
    if (entry && entry.key === key) return entry.rendered;
    const rendered = renderLayer(layer, assets);
    this.#entries.set(layer.id, { key, rendered, revision: ++this.#revision });
    return rendered;
  }

  /** 描き直すたびに変わる番号（下に重なるレイヤーが変わったかを見分ける） */
  revision(id: string) {
    return this.#entries.get(id)?.revision ?? 0;
  }

  /** index 番目のレイヤーの背面のフィルター。下のレイヤーも設定も変わっていなければ作り直さない */
  backdrop(
    doc: model.Doc,
    assets: model.Assets,
    index: number,
    hidden: string | null,
    background: string | null,
  ) {
    const layer = doc.layers[index]!;
    const rendered = this.get(layer, assets);
    const parts: unknown[] = [doc.width, doc.height, background, hidden];
    const shown = model.effective(doc.layers);
    for (const below of doc.layers.slice(0, index)) {
      const state = shown.get(below.id)!;
      if (!state.visible || state.opacity <= 0) continue;
      const drawn = below.id !== hidden;
      // 見えている下のレイヤーは、ここで描画を最新にしておく（番号が描画結果と合うように）
      if (drawn) this.get(below, assets);
      parts.push(
        below.id,
        drawn ? this.revision(below.id) : 0,
        below.x,
        below.y,
        state.opacity,
        JSON.stringify(below.backdrop),
      );
    }
    parts.push(
      layer.id,
      this.revision(layer.id),
      layer.x,
      layer.y,
      JSON.stringify(layer.backdrop),
    );
    const key = JSON.stringify(parts);
    const entry = this.#backdrops.get(layer.id);
    if (entry && entry.key === key) return entry.backdrop;
    const backdrop = renderBackdrop(
      doc,
      assets,
      this,
      index,
      rendered,
      hidden,
      background,
    );
    this.#backdrops.set(layer.id, { key, backdrop });
    return backdrop;
  }

  /** ドキュメントに無くなったレイヤーのキャッシュを捨てる */
  prune(doc: model.Doc) {
    const ids = new Set(doc.layers.map((layer) => layer.id));
    for (const id of this.#entries.keys())
      if (!ids.has(id)) this.#entries.delete(id);
    for (const id of this.#backdrops.keys())
      if (!ids.has(id)) this.#backdrops.delete(id);
  }

  clear() {
    this.#entries.clear();
    this.#backdrops.clear();
  }
}

/** 背面のフィルターの範囲を、レイヤーの形で切り抜く（図形とフレームは塗りの有無によらず形の内側） */
const drawBackdropMask = (
  context: CanvasRenderingContext2D,
  layer: model.Layer,
  rendered: Rendered,
  ox: number,
  oy: number,
) => {
  if (layer.type === "frame") {
    boxPath(context, ox, oy, layer.width, layer.height, layer.box.radius);
    context.fill();
  } else if (layer.type === "rect" || layer.type === "ellipse") {
    context.beginPath();
    if (layer.type === "ellipse") {
      context.ellipse(
        ox + layer.width / 2,
        oy + layer.height / 2,
        layer.width / 2,
        layer.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      const radius = Math.min(layer.radius, layer.width / 2, layer.height / 2);
      context.roundRect(ox, oy, layer.width, layer.height, Math.max(0, radius));
    }
    context.fill();
  } else {
    // 画像・テキスト・パスは、描いた絵の不透明な部分
    context.drawImage(rendered.canvas, ox - rendered.pad, oy - rendered.pad);
  }
};

/**
 * 背面のフィルターを作る。レイヤーの範囲（ぼかしで混ざる周りも含めて）の下の絵を描き、
 * フィルターを掛けて、レイヤーの形で切り抜く。ドキュメントの外は、端の色を延長して扱う。
 */
const renderBackdrop = (
  doc: model.Doc,
  assets: model.Assets,
  cache: LayerCache,
  index: number,
  rendered: Rendered,
  hidden: string | null,
  background: string | null,
): Backdrop | null => {
  const layer = doc.layers[index]!;
  const left = Math.max(0, Math.floor(layer.x - rendered.pad));
  const top = Math.max(0, Math.floor(layer.y - rendered.pad));
  const right = Math.min(
    doc.width,
    Math.ceil(layer.x - rendered.pad + rendered.canvas.width),
  );
  const bottom = Math.min(
    doc.height,
    Math.ceil(layer.y - rendered.pad + rendered.canvas.height),
  );
  if (right <= left || bottom <= top) return null;
  const spread = filters.blurPadding(layer.backdrop.blur);
  const sx = Math.max(0, left - spread);
  const sy = Math.max(0, top - spread);
  const sample = document.createElement("canvas");
  sample.width = Math.min(doc.width, right + spread) - sx;
  sample.height = Math.min(doc.height, bottom + spread) - sy;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true })!;
  sampleContext.imageSmoothingQuality = "high";
  if (background) {
    sampleContext.fillStyle = background;
    sampleContext.fillRect(0, 0, sample.width, sample.height);
  }
  sampleContext.translate(-sx, -sy);
  drawStack(sampleContext, doc, assets, cache, index, hidden, background);
  const image = sampleContext.getImageData(0, 0, sample.width, sample.height);
  filters.applyColor(image.data, filters.colorMatrix(layer.backdrop));
  filters.applyBlur(
    image.data,
    sample.width,
    sample.height,
    layer.backdrop.blur,
  );
  const canvas = document.createElement("canvas");
  canvas.width = right - left;
  canvas.height = bottom - top;
  const context = canvas.getContext("2d")!;
  context.putImageData(image, sx - left, sy - top);
  context.globalCompositeOperation = "destination-in";
  drawBackdropMask(context, layer, rendered, layer.x - left, layer.y - top);
  return { canvas, x: left, y: top };
};

/** 下から upto 枚目の手前までのレイヤーを重ねて描く */
const drawStack = (
  context: CanvasRenderingContext2D,
  doc: model.Doc,
  assets: model.Assets,
  cache: LayerCache,
  upto: number,
  hidden: string | null,
  background: string | null,
) => {
  const shown = model.effective(doc.layers);
  doc.layers.slice(0, upto).forEach((layer, index) => {
    // フレームを隠すと中身も隠れ、フレームの不透明度は中身にも掛かる
    const state = shown.get(layer.id)!;
    if (!state.visible || state.opacity <= 0) return;
    context.globalAlpha = state.opacity;
    // 背面のフィルターはレイヤーの背景として描くので、不透明度も一緒に掛かる（CSS と同じ）
    if (model.hasFilters(layer.backdrop)) {
      const backdrop = cache.backdrop(doc, assets, index, hidden, background);
      if (backdrop) context.drawImage(backdrop.canvas, backdrop.x, backdrop.y);
    }
    if (layer.id === hidden) return;
    const { canvas, pad } = cache.get(layer, assets);
    context.drawImage(canvas, layer.x - pad, layer.y - pad);
  });
  context.globalAlpha = 1;
};

/** ドキュメントを context に重ねて描く。context の変換はドキュメント座標に合わせておく */
export const drawLayers = (
  context: CanvasRenderingContext2D,
  doc: model.Doc,
  assets: model.Assets,
  cache: LayerCache,
  /** キャンバス上で編集中のテキスト（編集欄の文字を見せるので描かない） */
  hidden: string | null = null,
  /** 背面のフィルターが下の絵として使う背景（context にはこの色で塗ってあるものとする） */
  background: string | null = doc.background,
) =>
  drawStack(context, doc, assets, cache, doc.layers.length, hidden, background);

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
  drawLayers(context, doc, assets, cache, null, background);
  return canvas;
};
