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

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("画像を作れませんでした。")),
      type,
      quality,
    ),
  );

/** 1 枚の画像にする。JPEG は透明を扱えないので、透明な背景は白で埋める */
export const flatImage = async (
  doc: model.Doc,
  assets: model.Assets,
  cache: render.LayerCache,
  format: Exclude<Format, "psd">,
  quality: number,
) => {
  const background =
    format === "jpeg" ? (doc.background ?? "#ffffff") : doc.background;
  const canvas = render.flatten(doc, assets, cache, background);
  return toBlob(canvas, mimeTypes[format], quality);
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
) => {
  const blob =
    format === "psd"
      ? await psd(doc, assets, cache)
      : await flatImage(doc, assets, cache, format, quality);
  // WebP に対応していないブラウザは PNG で返すので、拡張子も実際の形式に合わせる
  const actual = format !== "psd" && blob.type === "image/png" ? "png" : format;
  project.download(blob, `${project.safeName(doc.name)}${extensions[actual]}`);
  return { requested: format, actual };
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
