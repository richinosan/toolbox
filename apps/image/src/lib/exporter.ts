// 書き出し：PNG / JPEG / WebP の画像と、レイヤーを保った PSD。
import * as model from "./model";
import * as project from "./project";
import * as render from "./render";

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

/** 1 枚の画像の canvas。JPEG は透明を扱えないので、透明な背景は白で埋める */
const flatCanvas = (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Exclude<Format, "psd">,
) =>
  render.flatten(
    doc,
    assets,
    cache,
    format === "jpeg" ? (doc.background ?? "#ffffff") : doc.background,
  );

export const flatImage = (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Exclude<Format, "psd">,
  quality: number,
) => toBlob(flatCanvas(doc, assets, cache, format), mimeTypes[format], quality);

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

/** レイヤーを保った PSD。各レイヤーはフィルター込みの画像として書き出す（テキストも画像になる） */
export const psd = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
) => {
  // PSD の書き出しライブラリは大きいので、使うときだけ読み込む
  const agPsd = await import("ag-psd");
  const children: import("ag-psd").Layer[] = [];
  if (doc.background) {
    const canvas = document.createElement("canvas");
    canvas.width = doc.width;
    canvas.height = doc.height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = doc.background;
    context.fillRect(0, 0, doc.width, doc.height);
    children.push({ name: "背景", left: 0, top: 0, canvas });
  }
  for (const layer of doc.layers) {
    const { canvas, pad } = cache.get(layer, assets);
    children.push({
      name: layer.name,
      left: Math.round(layer.x - pad),
      top: Math.round(layer.y - pad),
      canvas,
      opacity: layer.opacity / 100,
      hidden: !layer.visible,
    });
  }
  const buffer = agPsd.writePsd(
    {
      width: doc.width,
      height: doc.height,
      children,
      canvas: render.flatten(doc, assets, cache),
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
) => {
  let blob: Blob;
  let result: Awaited<ReturnType<typeof compress>> | null = null;
  if (format === "psd") blob = await psd(doc, assets, cache);
  else if (limit && format !== "png") {
    result = await compress(
      flatCanvas(doc, assets, cache, format),
      mimeTypes[format],
      limit,
    );
    blob = result.blob;
  } else blob = await flatImage(doc, assets, cache, format, quality);
  // WebP に対応していないブラウザは PNG で返すので、拡張子も実際の形式に合わせる
  const actual = format !== "psd" && blob.type === "image/png" ? "png" : format;
  project.download(blob, `${project.safeName(doc.name)}${extensions[actual]}`);
  return {
    requested: format,
    actual,
    size: blob.size,
    compressed: result && {
      quality: result.quality,
      fitted: result.fitted,
      width: result.width,
      height: result.height,
      shrunk: result.width !== doc.width || result.height !== doc.height,
    },
  };
};

/** PNG としてクリップボードにコピーする */
export const copyImage = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
) => {
  const blob = flatImage(doc, assets, cache, "png", 1);
  // Safari はユーザー操作の直後に write を呼ぶ必要があるので、Blob の Promise のまま渡す
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
};
