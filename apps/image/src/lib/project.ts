// 作品ファイル（.tbimg）の保存と読み込み。
// 作品はブラウザ内には保存せず、端末のファイルとして書き出す。
// File System Access API が使えるブラウザでは同じファイルに上書き保存し、使えないブラウザではダウンロードする。
import * as model from "./model";

export const EXTENSION = ".tbimg";
const FORMAT = "toolbox-image";
const VERSION = 1;
const MIME = "application/x-toolbox-image";

type Writable = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

export type FileHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<Writable>;
};

type PickerType = {
  description: string;
  accept: Record<string, string[]>;
};

type FsWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: PickerType[];
  }) => Promise<FileHandle>;
  showOpenFilePicker?: (options: {
    types?: PickerType[];
    multiple?: boolean;
  }) => Promise<FileHandle[]>;
};

const fsWindow = () => window as FsWindow;

const projectType: PickerType = {
  description: "IMAGE の作品",
  accept: { [MIME]: [EXTENSION] },
};

const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
];

export const canPickFiles = () =>
  typeof fsWindow().showSaveFilePicker === "function";

const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });

/** 作品を 1 つの JSON にまとめる（画像は data URL で埋め込む） */
export const serialize = async (doc: model.Doc, assets: model.Assets) => {
  const used = new Set(
    doc.layers.flatMap((layer) =>
      layer.type === "image" ? [layer.asset] : [],
    ),
  );
  const embedded: Record<string, string> = {};
  for (const id of used) {
    const asset = assets.get(id);
    if (asset) embedded[id] = await blobToDataUrl(asset.blob);
  }
  return new Blob(
    [
      JSON.stringify({
        format: FORMAT,
        version: VERSION,
        doc,
        assets: embedded,
      }),
    ],
    { type: MIME },
  );
};

// ---- 読み込み（ファイルの中身は信用せず、型と範囲を確かめながら組み立てる） ----

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? model.clamp(value, min, max)
    : fallback;

const int = (value: unknown, fallback: number, min: number, max: number) =>
  Math.round(num(value, fallback, min, max));

const str = (value: unknown, fallback: string, maxLength = 10_000) =>
  typeof value === "string" ? value.slice(0, maxLength) : fallback;

const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

const hex = (value: unknown, fallback: string) =>
  typeof value === "string" && model.isHex(value)
    ? value.toLowerCase()
    : fallback;

const oneOf = <T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T =>
  typeof value === "string" && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

const POSITION = 100_000;

const readFilters = (value: unknown): model.Filters => {
  const f = isObject(value) ? value : {};
  const d = model.defaultFilters;
  return {
    preset: oneOf(
      f["preset"],
      model.filterPresets.map(([key]) => key),
      d.preset,
    ),
    brightness: num(f["brightness"], d.brightness, -100, 100),
    contrast: num(f["contrast"], d.contrast, -100, 100),
    saturation: num(f["saturation"], d.saturation, -100, 100),
    hue: num(f["hue"], d.hue, -180, 180),
    tint: hex(f["tint"], d.tint),
    tintAmount: num(f["tintAmount"], d.tintAmount, 0, 100),
    blur: num(f["blur"], d.blur, 0, 100),
  };
};

const readLayer = (
  value: unknown,
  assetIds: Set<string>,
): model.Layer | null => {
  if (!isObject(value)) return null;
  const base = {
    id: model.newId(),
    name: str(value["name"], "レイヤー", 200),
    visible: bool(value["visible"], true),
    opacity: num(value["opacity"], 100, 0, 100),
    x: int(value["x"], 0, -POSITION, POSITION),
    y: int(value["y"], 0, -POSITION, POSITION),
    width: int(value["width"], 100, 1, model.MAX_SIDE * 4),
    height: int(value["height"], 100, 1, model.MAX_SIDE * 4),
    filters: readFilters(value["filters"]),
  };
  switch (value["type"]) {
    case "image": {
      const asset = str(value["asset"], "");
      return assetIds.has(asset) ? { ...base, type: "image", asset } : null;
    }
    case "rect":
    case "ellipse":
      return {
        ...base,
        type: value["type"],
        fill: hex(value["fill"], "#06c755"),
        fillEnabled: bool(value["fillEnabled"], true),
        stroke: hex(value["stroke"], "#ffffff"),
        strokeWidth: num(value["strokeWidth"], 0, 0, 500),
        radius: num(value["radius"], 0, 0, 5000),
      };
    case "text":
      return {
        ...base,
        type: "text",
        text: str(value["text"], ""),
        font: oneOf(
          value["font"],
          model.fontOptions.map(([key]) => key),
          "line-seed",
        ),
        fontSize: num(value["fontSize"], 48, 1, 2000),
        bold: bool(value["bold"], true),
        color: hex(value["color"], "#ffffff"),
        align: oneOf(value["align"], ["left", "center", "right"], "center"),
        lineHeight: num(value["lineHeight"], 130, 50, 300),
        strokeColor: hex(value["strokeColor"], "#1b1f24"),
        strokeWidth: num(value["strokeWidth"], 0, 0, 200),
        shadow: bool(value["shadow"], false),
      };
    default:
      return null;
  }
};

export class ProjectError extends Error {}

/** .tbimg を読み込む。画像は ImageBitmap にして返す */
export const deserialize = async (file: Blob) => {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new ProjectError("IMAGE の作品ファイルとして読み込めませんでした。");
  }
  if (!isObject(data) || data["format"] !== FORMAT || !isObject(data["doc"]))
    throw new ProjectError("IMAGE の作品ファイルではありません。");
  if (typeof data["version"] !== "number" || data["version"] > VERSION)
    throw new ProjectError(
      "新しい形式の作品ファイルです。ページを再読み込みしてから開いてください。",
    );

  const assets: model.Assets = new Map();
  const embedded = isObject(data["assets"]) ? data["assets"] : {};
  for (const [id, url] of Object.entries(embedded)) {
    if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
    try {
      const blob = await (await fetch(url)).blob();
      assets.set(id, { blob, image: await createImageBitmap(blob) });
    } catch {
      // 壊れた画像はレイヤーごと読み飛ばす
    }
  }

  const source = data["doc"];
  const size = model.fitSize(
    int(source["width"], 1920, 1, model.MAX_SIDE),
    int(source["height"], 1080, 1, model.MAX_SIDE),
  );
  const ids = new Set(assets.keys());
  const layers = Array.isArray(source["layers"])
    ? source["layers"]
        .slice(0, 500)
        .map((layer) => readLayer(layer, ids))
        .filter((layer) => layer !== null)
    : [];
  const doc: model.Doc = {
    name: str(source["name"], "無題", 200) || "無題",
    width: size.width,
    height: size.height,
    background:
      source["background"] === null
        ? null
        : hex(source["background"], "#ffffff"),
    layers,
  };
  return { doc, assets };
};

// ---- ファイルの保存と選択 ----

/** ファイル名に使えない文字（記号と制御文字）を置き換える */
export const safeName = (name: string) =>
  [...name]
    .map((char) =>
      char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? "_" : char,
    )
    .join("")
    .trim() || "無題";

export const download = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/**
 * 作品を保存する。handle があればそのファイルに上書きし、無ければ保存先を選ぶ（選べないブラウザではダウンロード）。
 * 戻り値は保存したファイルの handle（ダウンロードしたときは null）。キャンセルされたら undefined。
 */
export const save = async (
  blob: Blob,
  name: string,
  handle: FileHandle | null,
): Promise<FileHandle | null | undefined> => {
  const picker = fsWindow().showSaveFilePicker;
  let target = handle;
  if (!target && picker) {
    try {
      target = await picker.call(window, {
        suggestedName: `${safeName(name)}${EXTENSION}`,
        types: [projectType],
      });
    } catch (error) {
      if (isAbort(error)) return undefined;
      target = null;
    }
  }
  if (target) {
    const writable = await target.createWritable();
    await writable.write(blob);
    await writable.close();
    return target;
  }
  download(blob, `${safeName(name)}${EXTENSION}`);
  return null;
};

/** ファイルを選ぶ（作品ファイルと画像）。File System Access API が使えれば handle も返す */
export const pickFile = async (
  fallbackInput: HTMLInputElement,
): Promise<{ file: File; handle: FileHandle | null } | null> => {
  const picker = fsWindow().showOpenFilePicker;
  if (picker) {
    try {
      const [handle] = await picker.call(window, {
        types: [
          {
            description: "IMAGE の作品・画像",
            accept: {
              [MIME]: [EXTENSION],
              "image/*": [
                ".png",
                ".jpg",
                ".jpeg",
                ".webp",
                ".gif",
                ".avif",
                ".bmp",
              ],
            },
          },
        ],
        multiple: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return { file, handle: isProjectFile(file) ? handle : null };
    } catch (error) {
      if (isAbort(error)) return null;
      // 使えなかったときは通常のファイル選択に切り替える
    }
  }
  return new Promise((resolve) => {
    fallbackInput.value = "";
    fallbackInput.addEventListener(
      "change",
      () => {
        const file = fallbackInput.files?.[0];
        resolve(file ? { file, handle: null } : null);
      },
      { once: true },
    );
    fallbackInput.addEventListener("cancel", () => resolve(null), {
      once: true,
    });
    fallbackInput.click();
  });
};

export const isProjectFile = (file: File) =>
  file.name.toLowerCase().endsWith(EXTENSION) || file.type === MIME;

export const isImageFile = (file: Blob) =>
  file.type.startsWith("image/") || imageTypes.includes(file.type);

export const baseName = (filename: string) =>
  filename.replace(/\.[^.]+$/, "") || "無題";

export const accept = `${EXTENSION},image/*`;
