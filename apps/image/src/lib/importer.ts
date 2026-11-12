// デザインファイル（PSD・AI・PDF・TIFF・SVG）の読み込み。
// ブラウザがそのままでは開けない形式を、レイヤーごとの canvas にして返す。
// デコーダは大きいので、その形式を開くときにだけ読み込む。
import * as model from "./model";

export type Kind = "psd" | "pdf" | "tiff" | "svg";

export type ImportedLayer = {
  name: string;
  x: number;
  y: number;
  visible: boolean;
  /** 0〜100 */
  opacity: number;
  canvas: HTMLCanvasElement;
};

export type Imported = {
  width: number;
  height: number;
  /** 下から上の順 */
  layers: ImportedLayer[];
  /** 読み込んだあとに伝えること（縮めた・再現できないものがある、など） */
  notes: string[];
};

/** 開けない理由をそのまま画面に出せるエラー */
export class ImportError extends Error {}

/** ファイル選択で選べるようにする拡張子 */
export const extensions = [
  ".psd",
  ".psb",
  ".ai",
  ".pdf",
  ".tif",
  ".tiff",
  ".svg",
];

const startsWith = (bytes: Uint8Array, text: string) =>
  [...text].every((char, index) => bytes[index] === char.charCodeAt(0));

/**
 * ファイルの先頭を見て形式を決める（拡張子や MIME は当てにならないことがある）。
 * 対象の形式でなければ null。開けない形式だと分かったときは ImportError
 */
export const detect = async (file: Blob, name = ""): Promise<Kind | null> => {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const lower = name.toLowerCase();
  if (startsWith(head, "8BPS")) return "psd";
  // PDF の印は先頭から少し後ろにあることがある
  const text = String.fromCharCode(...head);
  if (text.includes("%PDF-")) return "pdf";
  if (startsWith(head, "II*\0") || startsWith(head, "MM\0*")) return "tiff";
  if (text.includes("%!PS-Adobe") || /\.(ai|eps)$/.test(lower))
    throw new ImportError(
      lower.endsWith(".ai")
        ? "この AI ファイルは開けません。Illustrator で「PDF 互換ファイルを作成」を有効にして保存し直してください。"
        : "EPS ファイルは開けません。PDF か AI（PDF 互換）で保存し直してください。",
    );
  if (file.type === "image/svg+xml" || lower.endsWith(".svg")) return "svg";
  if (/\.(psd|psb)$/.test(lower))
    throw new ImportError("この PSD ファイルは壊れているため開けません。");
  return null;
};

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
};

const scaled = (source: CanvasImageSource, width: number, height: number) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const shrunkNote = "大きいので、扱える大きさまで縮めました。";

/** ベクター（PDF・SVG）を画素にするときの倍率。小さいものは、ぼやけないよう整数倍にする */
const vectorScale = (width: number, height: number) => {
  const wanted = Math.max(1, Math.ceil(1000 / Math.max(width, height)));
  const fit = model.fitSize(width * wanted, height * wanted);
  return fit.scaled ? fit.width / width : wanted;
};

type PsdLayer = import("ag-psd").Layer;

const readPsd = async (file: Blob): Promise<Imported> => {
  const agPsd = await import("ag-psd");
  let psd: import("ag-psd").Psd;
  try {
    psd = agPsd.readPsd(await file.arrayBuffer(), { skipThumbnail: true });
  } catch {
    throw new ImportError("この PSD ファイルは開けませんでした。");
  }
  const size = model.fitSize(psd.width, psd.height);
  const scale = size.width / psd.width;
  const notes: string[] = [];
  if (size.scaled) notes.push(shrunkNote);

  // グループは無くして 1 列にする。グループの表示・不透明度は中身に掛ける
  const layers: ImportedLayer[] = [];
  let unsupported = false;
  const walk = (list: PsdLayer[], visible: boolean, opacity: number) => {
    for (const layer of list) {
      const shown = visible && !layer.hidden;
      const alpha = opacity * (layer.opacity ?? 1);
      if (
        (layer.blendMode &&
          layer.blendMode !== "normal" &&
          layer.blendMode !== "pass through") ||
        layer.clipping ||
        layer.mask ||
        layer.adjustment ||
        (layer.effects && !layer.effects.disabled)
      )
        unsupported = true;
      if (layer.children) {
        walk(layer.children, shown, alpha);
        continue;
      }
      const canvas = layer.canvas;
      if (!canvas || canvas.width === 0 || canvas.height === 0) continue;
      layers.push({
        name: layer.name ?? "",
        x: Math.round((layer.left ?? 0) * scale),
        y: Math.round((layer.top ?? 0) * scale),
        visible: shown,
        opacity: Math.round(alpha * 100),
        canvas: size.scaled
          ? scaled(canvas, canvas.width * scale, canvas.height * scale)
          : canvas,
      });
    }
  };
  walk(psd.children ?? [], true, 1);

  // レイヤーの無い PSD（背景だけ）は、まとめた画像を 1 枚のレイヤーにする
  if (layers.length === 0) {
    if (!psd.canvas)
      throw new ImportError("この PSD ファイルには画像が入っていません。");
    layers.push({
      name: "",
      x: 0,
      y: 0,
      visible: true,
      opacity: 100,
      canvas: size.scaled
        ? scaled(psd.canvas, size.width, size.height)
        : psd.canvas,
    });
  } else if (unsupported)
    notes.push(
      "描画モード・マスク・レイヤー効果・調整レイヤーは再現できないので、見た目が変わることがあります。",
    );
  return { width: size.width, height: size.height, layers, notes };
};

const readPdf = async (file: Blob): Promise<Imported> => {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const assetBase = `${import.meta.env.BASE_URL}/pdfjs/`;
  const task = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
  });
  try {
    const pdf = await task.promise.catch((error: unknown) => {
      throw new ImportError(
        error instanceof Error && error.name === "PasswordException"
          ? "パスワードの掛かったファイルは開けません。"
          : "このファイルは開けませんでした。",
      );
    });
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: vectorScale(base.width, base.height),
    });
    const canvas = createCanvas(viewport.width, viewport.height);
    // 背景は塗らず、透明のままにする
    await page.render({
      canvas,
      viewport,
      background: "rgba(0, 0, 0, 0)",
    }).promise;
    const notes: string[] = [];
    if (pdf.numPages > 1)
      notes.push(`${pdf.numPages} ページのうち、1 ページ目を開きました。`);
    return {
      width: canvas.width,
      height: canvas.height,
      layers: [{ name: "", x: 0, y: 0, visible: true, opacity: 100, canvas }],
      notes,
    };
  } finally {
    void task.destroy();
  }
};

/** TIFF の 1 画像分の面積（幅と高さのタグから） */
const tiffArea = (ifd: import("utif2").IFD) => {
  const [width, height] = [ifd["t256"], ifd["t257"]].map((tag) =>
    Array.isArray(tag) ? Number(tag[0]) : 0,
  );
  return (width ?? 0) * (height ?? 0);
};

const readTiff = async (file: Blob): Promise<Imported> => {
  const module = await import("utif2");
  // CommonJS のライブラリなので、バンドラによっては default に入る
  const utif =
    (module as unknown as { default?: typeof module }).default ?? module;
  const buffer = await file.arrayBuffer();
  try {
    // サムネイルなども入っているので、一番大きい画像を使う
    const page = utif
      .decode(buffer)
      .filter((ifd) => tiffArea(ifd) > 0)
      .toSorted((a, b) => tiffArea(b) - tiffArea(a))[0];
    if (!page) throw new Error("empty");
    utif.decodeImage(buffer, page);
    const rgba = utif.toRGBA8(page);
    const full = createCanvas(page.width, page.height);
    full
      .getContext("2d")!
      .putImageData(
        new ImageData(new Uint8ClampedArray(rgba), page.width, page.height),
        0,
        0,
      );
    const size = model.fitSize(page.width, page.height);
    return {
      width: size.width,
      height: size.height,
      layers: [
        {
          name: "",
          x: 0,
          y: 0,
          visible: true,
          opacity: 100,
          canvas: size.scaled ? scaled(full, size.width, size.height) : full,
        },
      ],
      notes: size.scaled ? [shrunkNote] : [],
    };
  } catch {
    throw new ImportError("この TIFF ファイルは開けませんでした。");
  }
};

const readSvg = async (file: Blob): Promise<Imported> => {
  // createImageBitmap は SVG を開けないブラウザがあるので、img で読み込む
  const url = URL.createObjectURL(
    file.type === "image/svg+xml"
      ? file
      : new Blob([file], { type: "image/svg+xml" }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("size");
    const scale = vectorScale(image.naturalWidth, image.naturalHeight);
    const canvas = scaled(
      image,
      image.naturalWidth * scale,
      image.naturalHeight * scale,
    );
    return {
      width: canvas.width,
      height: canvas.height,
      layers: [{ name: "", x: 0, y: 0, visible: true, opacity: 100, canvas }],
      notes: [],
    };
  } catch {
    throw new ImportError("この SVG ファイルは開けませんでした。");
  } finally {
    URL.revokeObjectURL(url);
  }
};

const readers = { psd: readPsd, pdf: readPdf, tiff: readTiff, svg: readSvg };

export const read = (file: Blob, kind: Kind) => readers[kind](file);

/** レイヤーを重ねて 1 枚にする（今の作品に 1 つのレイヤーとして追加するとき用） */
export const flatten = (imported: Imported): HTMLCanvasElement => {
  const only = imported.layers[0];
  if (
    imported.layers.length === 1 &&
    only &&
    // 非表示や半透明のときは、下で重ねてその見た目にする
    only.visible &&
    only.opacity === 100 &&
    only.x === 0 &&
    only.y === 0 &&
    only.canvas.width === imported.width &&
    only.canvas.height === imported.height
  )
    return only.canvas;
  const canvas = createCanvas(imported.width, imported.height);
  const context = canvas.getContext("2d")!;
  for (const layer of imported.layers) {
    if (!layer.visible) continue;
    context.globalAlpha = layer.opacity / 100;
    context.drawImage(layer.canvas, layer.x, layer.y);
  }
  return canvas;
};
