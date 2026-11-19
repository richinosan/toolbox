// 書き出し：PNG / JPEG / WebP の画像と、レイヤーを保った PSD。
import * as model from "./model";
import * as project from "./project";
import * as render from "./render";
import * as upscale from "./upscale";

export type Format = "png" | "jpeg" | "webp" | "psd";

export const formats: readonly (readonly [Format, string])[] = [
  ["png", "PNG"],
  ["jpeg", "JPEG"],
  ["webp", "WebP"],
  ["psd", "PSD"],
];

const mimeTypes = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

const extensions = { png: ".png", jpeg: ".jpg", webp: ".webp", psd: ".psd" };

export const toBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("画像を作れませんでした。")),
      type,
      quality,
    ),
  );

/** 拡大保存：書き出すときに、倍率と拡大方法を指定して大きくする */
export type Scaling = { factor: number; method: upscale.Method };

export const NO_SCALING: Scaling = { factor: 1, method: "nearest" };

/** 拡大後の大きさと、canvas に描ける大きさに収まるか（iOS Safari の上限に合わせる） */
export const scaledSize = (doc: model.Doc, scaling: Scaling) => {
  const { width, height } = upscale.size(doc.width, doc.height, scaling.factor);
  return {
    width,
    height,
    fits:
      width <= model.MAX_SIDE &&
      height <= model.MAX_SIDE &&
      width * height <= model.MAX_AREA,
  };
};

/** この作品を書き出せる一番大きい倍率（小数第 2 位で切り捨て） */
export const maxFactor = (doc: model.Doc) =>
  Math.max(
    upscale.MIN_FACTOR,
    Math.min(
      upscale.MAX_FACTOR,
      Math.floor(
        Math.min(
          model.MAX_SIDE / doc.width,
          model.MAX_SIDE / doc.height,
          Math.sqrt(model.MAX_AREA / (doc.width * doc.height)),
        ) * 100,
      ) / 100,
    ),
  );

/** canvas の画素を拡大した canvas。等倍ならそのまま返す */
const scaledCanvas = (
  source: HTMLCanvasElement,
  scaling: Scaling,
): HTMLCanvasElement => {
  const { width, height } = upscale.size(
    source.width,
    source.height,
    scaling.factor,
  );
  if (width === source.width && height === source.height) return source;
  if (source.width === 0 || source.height === 0) return source;
  const from = source
    .getContext("2d")!
    .getImageData(0, 0, source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const data = new ImageData(width, height);
  data.data.set(
    upscale.pixels(
      from.data,
      source.width,
      source.height,
      width,
      height,
      scaling.method,
    ),
  );
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvas;
};

/** 1 枚の画像の canvas。JPEG は透明を扱えないので、透明な背景は白で埋める */
const flatCanvas = (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Exclude<Format, "psd">,
  scaling: Scaling,
) =>
  scaledCanvas(
    render.flatten(
      doc,
      assets,
      cache,
      format === "jpeg" ? (doc.background ?? "#ffffff") : doc.background,
    ),
    scaling,
  );

export const flatImage = (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Exclude<Format, "psd">,
  quality: number,
  scaling: Scaling = NO_SCALING,
) =>
  toBlob(
    flatCanvas(doc, assets, cache, format, scaling),
    mimeTypes[format],
    quality,
  );

/** ファイルサイズの上限を指定して圧縮する（JPEG・WebP） */
export type Limit = {
  bytes: number;
  /** 画質を下げても収まらないとき、縦横の大きさも縮める */
  shrink: boolean;
};

/** 縮めるときに下げる画質の下限（これより下げると見た目が崩れやすいので、先に縮める） */
const SHRINK_QUALITY = 0.5;
const MIN_QUALITY = 0.05;
const MAX_QUALITY = 0.95;

const resized = (source: HTMLCanvasElement, scale: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

/**
 * 上限に収まる一番高い画質を二分探索で探す。
 * 下限の画質でも収まらず、縮めてよいときは、縦横を縮めてからもう一度探す。
 */
export const compress = async (
  original: HTMLCanvasElement,
  type: string,
  limit: Limit,
) => {
  const floor = limit.shrink ? SHRINK_QUALITY : MIN_QUALITY;
  let canvas = original;
  let smallest: { blob: Blob; quality: number } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const done = (blob: Blob, quality: number, fitted: boolean) => ({
      blob,
      quality,
      fitted,
      width: canvas.width,
      height: canvas.height,
    });
    const best = await toBlob(canvas, type, MAX_QUALITY);
    // 対応していない形式（PNG になった）は、画質では小さくできない
    if (best.type !== type || best.size <= limit.bytes)
      return done(best, MAX_QUALITY, best.size <= limit.bytes);
    const worst = await toBlob(canvas, type, floor);
    smallest = { blob: worst, quality: floor };
    if (worst.size <= limit.bytes) {
      let low = floor;
      let high = MAX_QUALITY;
      let found = worst;
      for (let i = 0; i < 7; i++) {
        const quality = (low + high) / 2;
        const blob = await toBlob(canvas, type, quality);
        if (blob.size <= limit.bytes) {
          found = blob;
          low = quality;
        } else high = quality;
      }
      return done(found, low, true);
    }
    if (!limit.shrink || Math.min(canvas.width, canvas.height) <= 16) break;
    // ファイルサイズはおおよそ面積に比例するので、その分だけ縮める
    const scale = Math.min(0.9, Math.sqrt(limit.bytes / worst.size) * 0.95);
    canvas = resized(
      original,
      (canvas.width * Math.max(0.25, scale)) / original.width,
    );
  }
  return {
    blob: smallest!.blob,
    quality: smallest!.quality,
    fitted: false,
    width: canvas.width,
    height: canvas.height,
  };
};

/**
 * レイヤーを保った PSD。各レイヤーはフィルター込みの画像として書き出す（テキストも画像になる）。
 * 背面のフィルターは、掛けた結果を別のレイヤーにする。フレームはグループにする。
 * 拡大保存では、レイヤーごとの画像と位置を同じ倍率で拡大する
 */
export const psd = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  scaling: Scaling = NO_SCALING,
) => {
  const { factor } = scaling;
  const size = upscale.size(doc.width, doc.height, factor);
  const place = (value: number) => Math.round(value * factor);
  // PSD の書き出しライブラリは大きいので、使うときだけ読み込む
  const agPsd = await import("ag-psd");
  const children: import("ag-psd").Layer[] = [];
  if (doc.background) {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = doc.background;
    context.fillRect(0, 0, size.width, size.height);
    children.push({ name: "背景", left: 0, top: 0, canvas });
  }
  type PsdLayer = import("ag-psd").Layer;
  // フレームはグループにして、フレームのボックスを一番下、中身をその上に入れる
  const groups = new Map<string, PsdLayer[]>();
  const listFor = (layer: model.Layer) =>
    (layer.parent ? groups.get(layer.parent) : undefined) ?? children;
  for (const [index, layer] of doc.layers.entries()) {
    const list = listFor(layer);
    let target = list;
    if (layer.type === "frame") {
      const group: PsdLayer = {
        name: layer.name,
        opened: true,
        opacity: layer.opacity / 100,
        hidden: !layer.visible,
        children: [],
      };
      list.push(group);
      groups.set(layer.id, group.children!);
      target = group.children!;
    }
    // グループの不透明度は中身にも掛かるので、フレームのボックスは不透明のまま入れる
    const opacity = layer.type === "frame" ? 1 : layer.opacity / 100;
    const hidden = layer.type === "frame" ? false : !layer.visible;
    // PSD には背面のフィルターが無いので、掛けた結果を 1 枚のレイヤーにしてすぐ下に置く
    const backdrop = model.hasFilters(layer.backdrop)
      ? cache.backdrop(doc, assets, index, null, doc.background)
      : null;
    if (backdrop)
      target.push({
        name: `${layer.name}（背面のフィルター）`,
        left: place(backdrop.x),
        top: place(backdrop.y),
        canvas: scaledCanvas(backdrop.canvas, scaling),
        opacity,
        hidden,
      });
    const { canvas, left, top } = cache.get(layer, assets);
    target.push({
      name: layer.type === "frame" ? `${layer.name}（ボックス）` : layer.name,
      left: place(Math.round(layer.x - left)),
      top: place(Math.round(layer.y - top)),
      canvas: scaledCanvas(canvas, scaling),
      opacity,
      hidden,
    });
  }
  const buffer = agPsd.writePsd(
    {
      width: size.width,
      height: size.height,
      children,
      canvas: scaledCanvas(render.flatten(doc, assets, cache), scaling),
    },
    { generateThumbnail: true, noBackground: true },
  );
  return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
};

export const exportFile = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Format,
  quality: number,
  limit: Limit | null = null,
  scaling: Scaling = NO_SCALING,
) => {
  const size = scaledSize(doc, scaling);
  if (!size.fits) throw new Error("拡大後の画像が大きすぎます。");
  let blob: Blob;
  let result: Awaited<ReturnType<typeof compress>> | null = null;
  if (format === "psd") blob = await psd(doc, assets, cache, scaling);
  else if (limit && format !== "png") {
    result = await compress(
      flatCanvas(doc, assets, cache, format, scaling),
      mimeTypes[format],
      limit,
    );
    blob = result.blob;
  } else blob = await flatImage(doc, assets, cache, format, quality, scaling);
  // WebP に対応していないブラウザは PNG で返すので、拡張子も実際の形式に合わせる
  const actual = format !== "psd" && blob.type === "image/png" ? "png" : format;
  project.download(blob, `${project.safeName(doc.name)}${extensions[actual]}`);
  return {
    requested: format,
    actual,
    size: blob.size,
    width: result?.width ?? size.width,
    height: result?.height ?? size.height,
    compressed: result && {
      quality: result.quality,
      fitted: result.fitted,
      width: result.width,
      height: result.height,
      shrunk: result.width !== size.width || result.height !== size.height,
    },
  };
};

/** PNG としてクリップボードにコピーする */
export const copyImage = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  scaling: Scaling = NO_SCALING,
) => {
  if (!scaledSize(doc, scaling).fits)
    throw new Error("拡大後の画像が大きすぎます。");
  const blob = flatImage(doc, assets, cache, "png", 1, scaling);
  // Safari はユーザー操作の直後に write を呼ぶ必要があるので、Blob の Promise のまま渡す
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
};
