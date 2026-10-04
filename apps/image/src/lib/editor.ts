// IMAGE のエディター本体。ページの要素に操作を結び付け、ドキュメントの状態・履歴・描画を管理する。
import * as motion from "#ui/motion.ts";
import * as exporter from "./exporter";
import * as filters from "./filters";
import * as fontpicker from "./fontpicker";
import * as fonts from "./fonts";
import * as model from "./model";
import * as outline from "./outline";
import * as project from "./project";
import * as render from "./render";
import * as richedit from "./richedit";
import * as snap from "./snap";
import * as text from "./text";

const HISTORY_LIMIT = 100;
/** スナップが効く距離（画面上の px） */
const SNAP_DISTANCE = 8;
const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
/** 2 回のタップをダブルタップとみなす間隔（ms） */
const DOUBLE_TAP = 350;
/** 編集欄から離れても書式を変える範囲を見せるハイライトの名前 */
const HIGHLIGHT = "tb-text-selection";
/** キャンバスの下に置く拡大・縮小のボタンの分の余白（px） */
const ZOOM_BAR_SPACE = 52;

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  | {
      kind: "move";
      id: string;
      startX: number;
      startY: number;
      origin: model.Layer;
      moved: boolean;
    }
  | {
      kind: "resize";
      id: string;
      handle: Handle;
      startX: number;
      startY: number;
      origin: model.Layer;
    }
  | {
      kind: "crop-move" | "crop-resize";
      handle: Handle | null;
      startX: number;
      startY: number;
      origin: snap.Box;
    }
  | {
      kind: "pan";
      startX: number;
      startY: number;
      viewX: number;
      viewY: number;
      moved: boolean;
    }
  | {
      kind: "pinch";
      distance: number;
      midX: number;
      midY: number;
      scale: number;
      viewX: number;
      viewY: number;
    };

const $ = <T extends Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector)!;

/** 入力欄（スライダーや選択肢も含む）にフォーカスがあるときは、矢印キーや Delete をそちらに任せる */
const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLInputElement);

/** 大きすぎる画像はキャンバスの上限まで縮めてから使う */
const loadImage = async (file: Blob) => {
  const original = await createImageBitmap(file);
  const size = model.fitSize(original.width, original.height);
  if (!size.scaled) return { blob: file, image: original, scaled: false };
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(original, 0, 0, size.width, size.height);
  original.close();
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("resize"))),
      type,
      0.92,
    ),
  );
  return { blob, image: await createImageBitmap(blob), scaled: true };
};

const handlesFor = (layer: model.Layer): Handle[] =>
  layer.type === "text"
    ? ["nw", "ne", "se", "sw"]
    : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const handlePoint = (box: snap.Box, handle: Handle) => ({
  x: handle.includes("w")
    ? box.x
    : handle.includes("e")
      ? box.x + box.width
      : box.x + box.width / 2,
  y: handle.includes("n")
    ? box.y
    : handle.includes("s")
      ? box.y + box.height
      : box.y + box.height / 2,
});

const cursors: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

const typeIcons: Record<model.LayerType, string> = {
  image:
    '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3 3 3-3 5 5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
  rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  path: '<svg viewBox="0 0 24 24"><path d="M12 3 5 14l7 7 7-7z"/><circle cx="12" cy="13" r="1.6"/></svg>',
};

const eyeIcon = (visible: boolean) =>
  visible
    ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1"/></svg>';

const readProp = (layer: model.Layer, path: string): unknown => {
  if (path.startsWith("filters.")) {
    return (layer.filters as Record<string, unknown>)[path.slice(8)];
  }
  return (layer as Record<string, unknown>)[path];
};

/** 明るい色か（パネルの編集欄で、白っぽい文字を暗い背景で見せる） */
const isLight = (color: string) => {
  const value = Number.parseInt(color.slice(1), 16);
  const r = Math.floor(value / 65536) % 256;
  const g = Math.floor(value / 256) % 256;
  const b = value % 256;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
};

const highlights = () =>
  "highlights" in CSS && typeof Highlight === "function"
    ? CSS.highlights
    : null;

/** 切り抜く枠の最小の大きさ（ドキュメントの px） */
const MIN_CROP = 8;

/** 比率を保ったまま、ドキュメントに収まる一番大きな枠（中央） */
const fitCrop = (doc: model.Doc, ratio: number): snap.Box => {
  const width = Math.min(doc.width, doc.height * ratio);
  const height = width / ratio;
  return {
    x: (doc.width - width) / 2,
    y: (doc.height - height) / 2,
    width,
    height,
  };
};

/** ハンドルで枠の大きさを変える。ドキュメントの外には出さず、比率があれば保つ */
const resizeCrop = (
  doc: model.Doc,
  origin: snap.Box,
  handle: Handle,
  dx: number,
  dy: number,
  ratio: number | null,
): snap.Box => {
  // ドキュメントが最小の大きさより小さいときは、ドキュメントの大きさまで
  const minWidth = Math.min(MIN_CROP, doc.width);
  const minHeight = Math.min(MIN_CROP, doc.height);
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  if (handle.includes("w")) left = model.clamp(left + dx, 0, right - minWidth);
  if (handle.includes("e"))
    right = model.clamp(right + dx, left + minWidth, doc.width);
  if (handle.includes("n")) top = model.clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes("s"))
    bottom = model.clamp(bottom + dy, top + minHeight, doc.height);
  if (ratio) {
    // 小さい方に合わせて縮めるので、ドキュメントからはみ出さない
    let width = right - left;
    let height = bottom - top;
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
    if (handle.includes("w")) left = right - width;
    else right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** 画像レイヤーのうち、枠（とぼかしで広がる分）にかかる範囲。レイヤーの左上からの px */
const imageClip = (layer: model.ImageLayer, box: snap.Box): snap.Box => {
  const margin = 1 + filters.blurPadding(layer.filters.blur);
  const left = Math.max(0, Math.floor(box.x - layer.x - margin));
  const top = Math.max(0, Math.floor(box.y - layer.y - margin));
  const right = Math.min(
    layer.width,
    Math.ceil(box.x + box.width - layer.x + margin),
  );
  const bottom = Math.min(
    layer.height,
    Math.ceil(box.y + box.height - layer.y + margin),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** canvas に描ける大きさか（iOS Safari の上限に合わせる） */
const withinCanvasLimit = (width: number, height: number) =>
  width <= model.MAX_SIDE &&
  height <= model.MAX_SIDE &&
  width * height <= model.MAX_AREA;

/** レイヤーを scale 倍にする（切り抜いたあと、決まった大きさに合わせるとき） */
const scaleLayer = (layer: model.Layer, scale: number) => {
  const round = (value: number) => Math.round(value * scale * 10) / 10;
  if (layer.type === "text") {
    const outlineValid =
      layer.outline !== null && layer.outline.key === text.outlineKey(layer);
    layer.runs = text.scaleRuns(layer.runs, scale);
    layer.outline =
      outlineValid && layer.outline
        ? {
            key: text.outlineKey(layer),
            ...text.scaleOutline(layer.outline, scale),
          }
        : null;
  }
  if ("strokeWidth" in layer) layer.strokeWidth = round(layer.strokeWidth);
  if (layer.type === "rect") layer.radius = round(layer.radius);
  layer.filters.blur = round(layer.filters.blur);
  layer.x = Math.round(layer.x * scale);
  layer.y = Math.round(layer.y * scale);
  if (layer.type === "text") {
    const size = text.measure(layer);
    layer.width = size.width;
    layer.height = size.height;
  } else {
    layer.width = Math.max(1, Math.round(layer.width * scale));
    layer.height = Math.max(1, Math.round(layer.height * scale));
  }
};

const MEGABYTE = 1_000_000;

/** ファイルサイズを「0.98 MB」「320 KB」のように書く */
const formatBytes = (bytes: number) =>
  bytes >= MEGABYTE / 10
    ? `${(bytes / MEGABYTE).toFixed(2)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const writeProp = (layer: model.Layer, path: string, value: unknown) => {
  if (path.startsWith("filters.")) {
    (layer.filters as Record<string, unknown>)[path.slice(8)] = value;
  } else {
    (layer as Record<string, unknown>)[path] = value;
  }
};

const textChanged = (layer: model.Layer) => {
  if (layer.type !== "text") return;
  render.fitText(layer);
  // 新しく使う文字のフォントを読み込む（読み込めたら fonts.subscribe で測り直して描き直す）
  render.loadFonts(layer).catch(() => undefined);
};

const effectsOf = (layer: model.TextLayer) => ({
  strokeColor: layer.strokeColor,
  strokeWidth: layer.strokeWidth,
  shadow: layer.shadow,
});

const clearHighlight = () => highlights()?.delete(HIGHLIGHT);

/** 保存の前に、テキストの文字の形（パス）を作っておく。作れなかったテキストの数を返す */
const buildOutlines = async (target: model.Doc) => {
  let failed = 0;
  for (const layer of target.layers) {
    if (layer.type !== "text") continue;
    // 標準のフォントはどの端末でも使えるので、パスは要らない
    if (
      layer.runs.every((run) => run.style.font.source === "builtin") ||
      !text.plainText(layer.runs).trim()
    ) {
      layer.outline = null;
      continue;
    }
    if (layer.outline?.key === text.outlineKey(layer)) continue;
    await render.loadFonts(layer).catch(() => undefined);
    const built = await outline.build(layer).catch(() => null);
    layer.outline = built;
    if (!built) failed++;
  }
  return failed;
};

export const mount = (root: HTMLElement) => {
  const controller = new AbortController();
  const { signal } = controller;
  // ClientRouter で他のページへ移るときに、document や window に付けたリスナーを外す
  document.addEventListener("astro:before-swap", () => controller.abort(), {
    once: true,
  });

  const stage = $<HTMLElement>(root, "#stage");
  const view = $<HTMLCanvasElement>(root, "#view");
  const viewContext = view.getContext("2d")!;
  const empty = $<HTMLElement>(root, "#empty");
  const toast = $<HTMLElement>(root, "#toast");
  const zoomLabel = $<HTMLElement>(root, "#zoom-label");
  const layerList = $<HTMLUListElement>(root, "#layer-list");
  const layerEmpty = $<HTMLElement>(root, "#layer-empty");
  const layerActions = $<HTMLElement>(root, "#layer-actions");
  const props = $<HTMLFormElement>(root, "#props");
  const propsTitle = $<HTMLElement>(root, "#props-title");
  const docForm = $<HTMLFormElement>(root, "#doc-props");
  const openInput = $<HTMLInputElement>(root, "#open-input");
  const imageInput = $<HTMLInputElement>(root, "#image-input");
  const newDialog = $<HTMLDialogElement>(root, "#new-dialog");
  const newForm = $<HTMLFormElement>(root, "#new-form");
  const exportDialog = $<HTMLDialogElement>(root, "#export-dialog");
  const exportForm = $<HTMLFormElement>(root, "#export-form");
  const snapButton = $<HTMLButtonElement>(root, '[data-action="snap"]');
  const undoButton = $<HTMLButtonElement>(root, '[data-action="undo"]');
  const redoButton = $<HTMLButtonElement>(root, '[data-action="redo"]');
  const rich = $<HTMLElement>(root, "#rich");
  const stageText = $<HTMLElement>(root, "#stage-text");
  const fontName = $<HTMLElement>(root, "#font-name");
  const fontMissing = $<HTMLElement>(root, "#font-missing");
  const fontDialog = $<HTMLDialogElement>(root, "#font-dialog");
  const cropForm = $<HTMLFormElement>(root, "#crop-props");
  const cropBar = $<HTMLElement>(root, "#crop-bar");
  const cropButton = $<HTMLButtonElement>(root, '[data-action="crop"]');
  const picker = fontpicker.create(fontDialog, signal);

  // ---- 状態 ----
  let doc: model.Doc | null = null;
  const assets: model.Assets = new Map();
  const cache = new render.LayerCache();
  let selectedId: string | null = null;
  let fileHandle: project.FileHandle | null = null;
  let history: string[] = [];
  let historyIndex = -1;
  let savedIndex = -1;
  let snapEnabled = true;
  let guides: snap.Guides = { xs: [], ys: [] };
  const camera = { scale: 1, x: 0, y: 0, fit: true };
  let drag: Drag | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  /** キャンバス上で編集中のテキストレイヤー */
  let editingId: string | null = null;
  /** 書式を適用する文字の範囲（編集欄から離れてボタンなどを押しても覚えておく）。null は全体 */
  let charRange: { start: number; end: number } | null = null;
  let lastTap: { id: string; time: number } | null = null;
  /** トリミング中の枠（ドキュメントの座標）。トリミングしていないときは null */
  let crop: snap.Box | null = null;

  const selected = () =>
    doc?.layers.find((layer) => layer.id === selectedId) ?? null;
  const isDirty = () => doc !== null && historyIndex !== savedIndex;

  // ---- 通知 ----
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (message: string, error = false) => {
    toast.textContent = message;
    toast.classList.toggle("toast--error", error);
    toast.classList.add("toast--visible");
    motion.play(toast, "in");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => toast.classList.remove("toast--visible"),
      error ? 4000 : 2000,
    );
  };

  // ---- 履歴 ----
  const snapshot = () => JSON.stringify(doc);

  const updateHistoryButtons = () => {
    undoButton.disabled = historyIndex <= 0;
    redoButton.disabled = historyIndex >= history.length - 1;
  };

  /** 操作の区切りで状態を履歴に積む（直前と同じなら何もしない） */
  const commit = () => {
    if (!doc) return;
    const state = snapshot();
    if (history[historyIndex] === state) return;
    history = history.slice(0, historyIndex + 1);
    history.push(state);
    if (history.length > HISTORY_LIMIT) {
      history.shift();
      savedIndex--;
    }
    historyIndex = history.length - 1;
    updateHistoryButtons();
    renderLayerList();
  };

  const restore = (index: number) => {
    const state = history[index];
    if (state === undefined) return;
    closeStageText();
    charRange = null;
    crop = null;
    historyIndex = index;
    doc = JSON.parse(state) as model.Doc;
    if (!selected()) selectedId = null;
    cache.prune(doc);
    updateHistoryButtons();
    refreshAll();
  };

  const undo = () => {
    // 入力中の文字を履歴に積んでから戻す
    finishEditing();
    if (historyIndex > 0) restore(historyIndex - 1);
  };
  const redo = () => {
    finishEditing();
    if (historyIndex < history.length - 1) restore(historyIndex + 1);
  };

  // ---- 表示位置（カメラ） ----
  const stageSize = () => ({
    width: stage.clientWidth,
    height: stage.clientHeight,
  });

  const fitCamera = () => {
    if (!doc) return;
    const { width, height } = stageSize();
    const margin = width < 480 ? 12 : 32;
    // 下の端は拡大・縮小のボタンと重ならないよう空けておく
    const bottom = ZOOM_BAR_SPACE;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        (width - margin * 2) / doc.width,
        (height - margin - bottom) / doc.height,
        4,
      ),
    );
    camera.scale = scale;
    camera.x = (width - doc.width * scale) / 2;
    camera.y = margin + (height - margin - bottom - doc.height * scale) / 2;
    camera.fit = true;
  };

  const zoomAt = (scale: number, cx: number, cy: number) => {
    const next = model.clamp(scale, MIN_SCALE, MAX_SCALE);
    camera.x = cx - ((cx - camera.x) * next) / camera.scale;
    camera.y = cy - ((cy - camera.y) * next) / camera.scale;
    camera.scale = next;
    camera.fit = false;
    requestDraw();
  };

  const zoomBy = (factor: number) => {
    const { width, height } = stageSize();
    zoomAt(camera.scale * factor, width / 2, height / 2);
  };

  const toDoc = (clientX: number, clientY: number) => {
    const rect = stage.getBoundingClientRect();
    return {
      x: (clientX - rect.left - camera.x) / camera.scale,
      y: (clientY - rect.top - camera.y) / camera.scale,
    };
  };

  const toScreen = (x: number, y: number) => ({
    x: camera.x + x * camera.scale,
    y: camera.y + y * camera.scale,
  });

  // ---- 描画 ----
  let checker: CanvasPattern | null = null;
  const checkerPattern = () => {
    if (checker) return checker;
    const tile = document.createElement("canvas");
    tile.width = tile.height = 16;
    const context = tile.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 16, 16);
    context.fillStyle = "#d9dde2";
    context.fillRect(0, 0, 8, 8);
    context.fillRect(8, 8, 8, 8);
    checker = viewContext.createPattern(tile, "repeat");
    return checker;
  };

  let frame = 0;
  const requestDraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const draw = () => {
    const { width, height } = stageSize();
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (view.width !== pixelWidth || view.height !== pixelHeight) {
      view.width = pixelWidth;
      view.height = pixelHeight;
    }
    const context = viewContext;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    zoomLabel.textContent = `${Math.round(camera.scale * 100)}%`;
    if (!doc) return;

    const w = doc.width * camera.scale;
    const h = doc.height * camera.scale;
    context.save();
    context.shadowColor = "rgb(0 0 0 / 0.18)";
    context.shadowBlur = 12;
    context.shadowOffsetY = 2;
    context.fillStyle = doc.background ?? checkerPattern() ?? "#ffffff";
    context.fillRect(camera.x, camera.y, w, h);
    context.restore();

    context.save();
    context.beginPath();
    context.rect(camera.x, camera.y, w, h);
    context.clip();
    context.translate(camera.x, camera.y);
    context.scale(camera.scale, camera.scale);
    context.imageSmoothingQuality = "high";
    render.drawLayers(context, doc, assets, cache, editingId);
    context.restore();
    positionStageText();

    // スナップのガイド
    context.save();
    context.strokeStyle = "#ff2d95";
    context.lineWidth = 1;
    for (const x of guides.xs) {
      const sx = Math.round(toScreen(x, 0).x) + 0.5;
      context.beginPath();
      context.moveTo(sx, camera.y - 8);
      context.lineTo(sx, camera.y + h + 8);
      context.stroke();
    }
    for (const y of guides.ys) {
      const sy = Math.round(toScreen(0, y).y) + 0.5;
      context.beginPath();
      context.moveTo(camera.x - 8, sy);
      context.lineTo(camera.x + w + 8, sy);
      context.stroke();
    }
    context.restore();

    if (crop) {
      drawCrop(context, crop);
      return;
    }

    // 選択枠とハンドル
    const layer = selected();
    if (layer) {
      const topLeft = toScreen(layer.x, layer.y);
      const box = {
        x: topLeft.x,
        y: topLeft.y,
        width: layer.width * camera.scale,
        height: layer.height * camera.scale,
      };
      context.save();
      context.strokeStyle = "#1a73e8";
      context.lineWidth = 1.5;
      context.setLineDash(layer.visible ? [] : [4, 4]);
      context.strokeRect(box.x, box.y, box.width, box.height);
      context.setLineDash([]);
      for (const handle of handlesFor(layer)) {
        const p = handlePoint(box, handle);
        context.beginPath();
        context.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
        context.fillStyle = "#ffffff";
        context.fill();
        context.stroke();
      }
      context.restore();
    }
  };

  /** 切り抜く枠の外を暗くし、枠・三分割の線・ハンドルを描く */
  const drawCrop = (context: CanvasRenderingContext2D, box: snap.Box) => {
    if (!doc) return;
    const outer = toScreen(0, 0);
    const inner = cropScreenBox(box);
    context.save();
    context.beginPath();
    context.rect(
      outer.x,
      outer.y,
      doc.width * camera.scale,
      doc.height * camera.scale,
    );
    context.rect(inner.x, inner.y, inner.width, inner.height);
    context.fillStyle = "rgb(0 0 0 / 0.55)";
    context.fill("evenodd");
    context.strokeStyle = "rgb(255 255 255 / 0.45)";
    context.lineWidth = 1;
    context.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      context.moveTo(inner.x + inner.width * t, inner.y);
      context.lineTo(inner.x + inner.width * t, inner.y + inner.height);
      context.moveTo(inner.x, inner.y + inner.height * t);
      context.lineTo(inner.x + inner.width, inner.y + inner.height * t);
    }
    context.stroke();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1.5;
    context.strokeRect(inner.x, inner.y, inner.width, inner.height);
    context.strokeStyle = "#1a73e8";
    for (const handle of cropHandles()) {
      const p = handlePoint(inner, handle);
      context.beginPath();
      context.arc(p.x, p.y, 6, 0, Math.PI * 2);
      context.fillStyle = "#ffffff";
      context.fill();
      context.stroke();
    }
    context.restore();
  };

  // ---- 当たり判定 ----
  const hitLayer = (x: number, y: number) => {
    if (!doc) return null;
    const tolerance = 4 / camera.scale;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i]!;
      if (!layer.visible) continue;
      if (
        x >= layer.x - tolerance &&
        x <= layer.x + layer.width + tolerance &&
        y >= layer.y - tolerance &&
        y <= layer.y + layer.height + tolerance
      )
        return layer;
    }
    return null;
  };

  const hitHandle = (clientX: number, clientY: number, touch: boolean) => {
    const layer = selected();
    if (!layer && !crop) return null;
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let box: snap.Box;
    let handles: Handle[];
    if (crop) {
      box = cropScreenBox(crop);
      handles = cropHandles();
    } else {
      const topLeft = toScreen(layer!.x, layer!.y);
      box = {
        x: topLeft.x,
        y: topLeft.y,
        width: layer!.width * camera.scale,
        height: layer!.height * camera.scale,
      };
      handles = handlesFor(layer!);
    }
    const radius = touch ? 20 : 10;
    let best: { handle: Handle; distance: number } | null = null;
    for (const handle of handles) {
      const p = handlePoint(box, handle);
      const distance = Math.hypot(p.x - px, p.y - py);
      if (distance <= radius && (!best || distance < best.distance))
        best = { handle, distance };
    }
    return best?.handle ?? null;
  };

  const snapTargets = (except: string) => {
    if (!doc) return { xs: [], ys: [] };
    return snap.targets(
      doc,
      doc.layers.filter((layer) => layer.visible && layer.id !== except),
    );
  };

  // ---- ドラッグ操作 ----
  const applyMove = (
    current: Extract<Drag, { kind: "move" }>,
    point: { x: number; y: number },
    event: PointerEvent,
  ) => {
    const layer = selected();
    if (!layer || !doc) return;
    let dx = point.x - current.startX;
    let dy = point.y - current.startY;
    // Shift を押しながらだと、縦か横の一方向だけに動かす
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    let x = current.origin.x + dx;
    let y = current.origin.y + dy;
    guides = { xs: [], ys: [] };
    if (snapEnabled && !event.altKey) {
      const result = snap.snapMove(
        { x, y, width: layer.width, height: layer.height },
        snapTargets(layer.id),
        SNAP_DISTANCE / camera.scale,
      );
      if (!event.shiftKey || dy === 0) x = result.x;
      if (!event.shiftKey || dx === 0) y = result.y;
      guides = result.guides;
    }
    layer.x = Math.round(x);
    layer.y = Math.round(y);
  };

  const applyResize = (
    current: Extract<Drag, { kind: "resize" }>,
    point: { x: number; y: number },
    event: PointerEvent,
  ) => {
    const layer = selected();
    if (!layer || !doc) return;
    const origin = current.origin;
    const { handle } = current;
    const dx = point.x - current.startX;
    const dy = point.y - current.startY;
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (handle.includes("w")) left += dx;
    if (handle.includes("e")) right += dx;
    if (handle.includes("n")) top += dy;
    if (handle.includes("s")) bottom += dy;

    guides = { xs: [], ys: [] };
    if (snapEnabled && !event.altKey) {
      const targets = snapTargets(layer.id);
      const threshold = SNAP_DISTANCE / camera.scale;
      const edge = (value: number, lines: number[], axis: "xs" | "ys") => {
        const line = snap.snapEdge(value, lines, threshold);
        if (line === null) return value;
        guides[axis].push(line);
        return line;
      };
      if (handle.includes("w")) left = edge(left, targets.xs, "xs");
      if (handle.includes("e")) right = edge(right, targets.xs, "xs");
      if (handle.includes("n")) top = edge(top, targets.ys, "ys");
      if (handle.includes("s")) bottom = edge(bottom, targets.ys, "ys");
    }

    // 反対側の辺を越えないようにする
    if (handle.includes("w")) left = Math.min(left, right - 1);
    if (handle.includes("e")) right = Math.max(right, left + 1);
    if (handle.includes("n")) top = Math.min(top, bottom - 1);
    if (handle.includes("s")) bottom = Math.max(bottom, top + 1);

    const corner = handle.length === 2;
    // 画像とパスは角のハンドルで縦横比を保つ（Shift で切り替え）。テキストは常に、図形は Shift で保つ
    const keepRatio =
      corner &&
      (layer.type === "text" ||
        (layer.type === "image" || layer.type === "path"
          ? !event.shiftKey
          : event.shiftKey));
    if (keepRatio) {
      const scale = Math.max(
        (right - left) / origin.width,
        (bottom - top) / origin.height,
      );
      const width = Math.max(1, origin.width * scale);
      const height = Math.max(1, origin.height * scale);
      if (handle.includes("w")) left = right - width;
      else right = left + width;
      if (handle.includes("n")) top = bottom - height;
      else bottom = top + height;
      // 縦横比を合わせると、合わせ直した側のガイドはずれるので消す
      guides = { xs: [], ys: [] };
    }

    if (layer.type === "text" && origin.type === "text") {
      const scale = (right - left) / origin.width;
      layer.runs = text.scaleRuns(origin.runs, scale);
      layer.strokeWidth = Math.round(origin.strokeWidth * scale * 10) / 10;
      // フォントが無くパスで表示しているときは、パスも一緒に拡大・縮小する
      layer.outline =
        origin.outline && text.usesOutline(origin)
          ? {
              key: text.outlineKey(layer),
              ...text.scaleOutline(origin.outline, scale),
            }
          : null;
      const size = text.measure(layer);
      layer.width = size.width;
      layer.height = size.height;
      layer.x = Math.round(
        handle.includes("w") ? origin.x + origin.width - size.width : origin.x,
      );
      layer.y = Math.round(
        handle.includes("n")
          ? origin.y + origin.height - size.height
          : origin.y,
      );
      return;
    }
    layer.x = Math.round(left);
    layer.y = Math.round(top);
    layer.width = Math.max(1, Math.round(right - left));
    layer.height = Math.max(1, Math.round(bottom - top));
  };

  /** ドラッグを取り消して、動かす前の状態に戻す（2 本目の指が触れたとき） */
  const cancelLayerDrag = () => {
    if (!doc || !drag || (drag.kind !== "move" && drag.kind !== "resize"))
      return;
    const origin = drag.origin;
    doc.layers = doc.layers.map((layer) =>
      layer.id === origin.id ? origin : layer,
    );
    guides = { xs: [], ys: [] };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const rect = stage.getBoundingClientRect();
    drag = {
      kind: "pinch",
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      midX: (a.x + b.x) / 2 - rect.left,
      midY: (a.y + b.y) / 2 - rect.top,
      scale: camera.scale,
      viewX: camera.x,
      viewY: camera.y,
    };
  };

  stage.addEventListener("pointerdown", (event) => {
    if (!doc) return;
    // キャンバス上の編集欄の中では、文字の選択をブラウザに任せる
    if (event.target instanceof Node && stageText.contains(event.target))
      return;
    // キャンバスの上のボタン（拡大・縮小、トリミング）は、ポインターを奪わずにクリックさせる
    if (event.target instanceof Element && event.target.closest("button"))
      return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
    finishEditing();
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      cancelLayerDrag();
      startPinch();
      requestDraw();
      return;
    }
    if (pointers.size > 2) return;

    const point = toDoc(event.clientX, event.clientY);
    const handle = hitHandle(
      event.clientX,
      event.clientY,
      event.pointerType !== "mouse",
    );
    if (crop) {
      const inside =
        point.x >= crop.x &&
        point.x <= crop.x + crop.width &&
        point.y >= crop.y &&
        point.y <= crop.y + crop.height;
      if (handle || inside) {
        drag = {
          kind: handle ? "crop-resize" : "crop-move",
          handle,
          startX: point.x,
          startY: point.y,
          origin: { ...crop },
        };
        return;
      }
    }
    const current = selected();
    if (handle && current) {
      drag = {
        kind: "resize",
        id: current.id,
        handle,
        startX: point.x,
        startY: point.y,
        origin: structuredClone(current),
      };
      return;
    }
    const hit = crop ? null : hitLayer(point.x, point.y);
    if (hit) {
      if (hit.id !== selectedId) select(hit.id);
      drag = {
        kind: "move",
        id: hit.id,
        startX: point.x,
        startY: point.y,
        origin: structuredClone(hit),
        moved: false,
      };
      return;
    }
    drag = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      viewX: camera.x,
      viewY: camera.y,
      moved: false,
    };
  });

  stage.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!drag) {
      // ハンドルの上ではカーソルを変える
      if (event.pointerType === "mouse" && doc) {
        const handle = hitHandle(event.clientX, event.clientY, false);
        const point = toDoc(event.clientX, event.clientY);
        const inCrop =
          crop !== null &&
          point.x >= crop.x &&
          point.x <= crop.x + crop.width &&
          point.y >= crop.y &&
          point.y <= crop.y + crop.height;
        stage.style.cursor = handle
          ? cursors[handle]
          : inCrop || (!crop && hitLayer(point.x, point.y))
            ? "move"
            : "default";
      }
      return;
    }
    if (drag.kind === "pinch") {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const rect = stage.getBoundingClientRect();
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2 - rect.left;
      const midY = (a.y + b.y) / 2 - rect.top;
      const scale = model.clamp(
        (drag.scale * distance) / drag.distance,
        MIN_SCALE,
        MAX_SCALE,
      );
      camera.x = midX - ((drag.midX - drag.viewX) * scale) / drag.scale;
      camera.y = midY - ((drag.midY - drag.viewY) * scale) / drag.scale;
      camera.scale = scale;
      camera.fit = false;
      requestDraw();
      return;
    }
    if (drag.kind === "pan") {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      camera.x = drag.viewX + dx;
      camera.y = drag.viewY + dy;
      camera.fit = false;
      requestDraw();
      return;
    }
    const point = toDoc(event.clientX, event.clientY);
    if (drag.kind === "crop-move" || drag.kind === "crop-resize") {
      if (!doc || !crop) return;
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      crop =
        drag.kind === "crop-move"
          ? {
              ...drag.origin,
              x: model.clamp(
                drag.origin.x + dx,
                0,
                doc.width - drag.origin.width,
              ),
              y: model.clamp(
                drag.origin.y + dy,
                0,
                doc.height - drag.origin.height,
              ),
            }
          : resizeCrop(
              doc,
              drag.origin,
              drag.handle!,
              dx,
              dy,
              cropPreset().ratio,
            );
      syncCropPanel();
      requestDraw();
      return;
    }
    if (drag.kind === "move") {
      const distance =
        Math.hypot(point.x - drag.startX, point.y - drag.startY) * camera.scale;
      if (!drag.moved && distance < 3) return;
      drag.moved = true;
      applyMove(drag, point, event);
    } else if (drag.kind === "resize") {
      applyResize(drag, point, event);
    }
    syncGeometry();
    requestDraw();
  });

  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (!drag) return;
    if (drag.kind === "pinch") {
      // 指が 1 本残っても、離すまでは何もしない
      if (pointers.size === 0) drag = null;
      return;
    }
    if (drag.kind === "pan" && !drag.moved && !crop) select(null);
    // タッチでは、同じテキストを 2 回続けてタップしたらその場で編集する
    if (drag.kind === "move" && !drag.moved && event.pointerType !== "mouse") {
      const now = performance.now();
      const layer = selected();
      if (
        layer?.type === "text" &&
        lastTap?.id === layer.id &&
        now - lastTap.time < DOUBLE_TAP
      ) {
        drag = null;
        lastTap = null;
        startEditing(layer);
        return;
      }
      lastTap = { id: drag.id, time: now };
    }
    const finished = drag;
    drag = null;
    guides = { xs: [], ys: [] };
    if (finished.kind === "move" || finished.kind === "resize") {
      commit();
      syncPanel();
    }
    requestDraw();
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", (event) => {
    if (drag && (drag.kind === "move" || drag.kind === "resize"))
      cancelLayerDrag();
    drag = null;
    endPointer(event);
  });

  stage.addEventListener("dblclick", (event) => {
    if (event.target instanceof Node && stageText.contains(event.target))
      return;
    const point = toDoc(event.clientX, event.clientY);
    const hit = hitLayer(point.x, point.y);
    if (hit?.type === "text") startEditing(hit);
  });

  stage.addEventListener(
    "wheel",
    (event) => {
      if (!doc) return;
      const rect = stage.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // トラックパッドのピンチもここに来る
        event.preventDefault();
        zoomAt(
          camera.scale * Math.exp(-event.deltaY * 0.01),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      } else if (!camera.fit) {
        // 拡大中はホイールで表示位置を動かす（全体表示のときはページをスクロールさせる）
        event.preventDefault();
        camera.x -= event.deltaX;
        camera.y -= event.deltaY;
        requestDraw();
      }
    },
    { passive: false },
  );

  const resizeObserver = new ResizeObserver(() => {
    if (camera.fit) fitCamera();
    requestDraw();
  });
  resizeObserver.observe(stage);
  signal.addEventListener("abort", () => resizeObserver.disconnect());

  // ---- 選択とパネル ----
  const select = (id: string | null) => {
    if (crop && id !== null) cancelCrop();
    if (editingId && editingId !== id) finishEditing();
    if (id !== selectedId) charRange = null;
    selectedId = id;
    renderLayerList();
    syncPanel();
    requestDraw();
  };

  const thumbnail = (layer: model.Layer) => {
    const canvas = document.createElement("canvas");
    const size = 36;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.height = size * ratio;
    canvas.className = "layer__thumb";
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d")!;
    const rendered = cache.get(layer, assets);
    const scale = Math.min(
      (size * ratio) / rendered.canvas.width,
      (size * ratio) / rendered.canvas.height,
    );
    const w = rendered.canvas.width * scale;
    const h = rendered.canvas.height * scale;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      rendered.canvas,
      (size * ratio - w) / 2,
      (size * ratio - h) / 2,
      w,
      h,
    );
    return canvas;
  };

  function renderLayerList() {
    layerList.replaceChildren();
    const layers = doc?.layers ?? [];
    layerEmpty.hidden = layers.length > 0;
    layerActions.hidden = layers.length === 0;
    // 上にあるレイヤーほどリストの上に出す
    for (const layer of layers.toReversed()) {
      const item = document.createElement("li");
      item.className = "layer";
      item.dataset["id"] = layer.id;
      item.classList.toggle("layer--selected", layer.id === selectedId);
      item.classList.toggle("layer--hidden", !layer.visible);

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "layer__eye";
      eye.dataset["layerAction"] = "toggle";
      eye.setAttribute("aria-pressed", String(layer.visible));
      eye.setAttribute("aria-label", `${layer.name} を表示`);
      eye.title = layer.visible ? "非表示にする" : "表示する";
      eye.innerHTML = eyeIcon(layer.visible);

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "layer__pick";
      pick.dataset["layerAction"] = "select";
      pick.setAttribute("aria-current", String(layer.id === selectedId));
      const icon = document.createElement("span");
      icon.className = "layer__type";
      icon.innerHTML = typeIcons[layer.type];
      icon.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "layer__name";
      name.textContent = layer.name;
      pick.append(thumbnail(layer), name, icon);

      item.append(eye, pick);
      layerList.append(item);
    }
    const layer = selected();
    for (const button of layerActions.querySelectorAll<HTMLButtonElement>(
      "[data-action]",
    )) {
      const action = button.dataset["action"];
      const index = layer ? (doc?.layers.indexOf(layer) ?? -1) : -1;
      button.disabled =
        !layer ||
        (action === "layer-up" && index === layers.length - 1) ||
        (action === "layer-down" && index === 0);
    }
  }

  layerList.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-layer-action]")
        : null;
    const id = target?.closest<HTMLElement>(".layer")?.dataset["id"];
    if (!target || !id || !doc) return;
    if (target.dataset["layerAction"] === "toggle") {
      const layer = doc.layers.find((l) => l.id === id);
      if (!layer) return;
      layer.visible = !layer.visible;
      commit();
      requestDraw();
      layerList
        .querySelector<HTMLElement>(
          `.layer[data-id="${CSS.escape(id)}"] .layer__eye`,
        )
        ?.focus();
      return;
    }
    select(id);
  });

  const propInputs = () =>
    props.querySelectorAll<HTMLInputElement>("[data-prop]");

  const showOutput = (input: HTMLInputElement) => {
    const output = props.querySelector<HTMLOutputElement>(
      `output[for="${input.id}"]`,
    );
    if (output) output.value = `${input.value}${input.dataset["unit"] ?? ""}`;
  };

  /** 位置と大きさの欄だけ更新する（ドラッグ中） */
  function syncGeometry() {
    const layer = selected();
    if (!layer) return;
    for (const key of ["x", "y", "width", "height"] as const) {
      const input = props.querySelector<HTMLInputElement>(
        `[data-prop="${key}"]`,
      );
      if (input && document.activeElement !== input && key in layer)
        input.value = String(readProp(layer, key));
    }
    if (layer.type === "text") syncCharControls();
  }

  /** 選択中のレイヤーの値をパネルに反映する */
  function syncPanel() {
    cropForm.hidden = crop === null;
    cropBar.hidden = crop === null;
    cropButton.setAttribute("aria-pressed", String(crop !== null));
    if (crop) {
      props.hidden = true;
      docForm.hidden = true;
      propsTitle.textContent = "トリミング";
      syncCropPanel();
      return;
    }
    const layer = selected();
    props.hidden = !layer;
    docForm.hidden = !doc || layer !== null;
    propsTitle.textContent = layer
      ? `${model.layerTypeLabels[layer.type]}の設定`
      : doc
        ? "キャンバスの設定"
        : "設定";
    if (doc && !layer) syncDocPanel();
    if (!layer) return;
    for (const section of props.querySelectorAll<HTMLElement>("[data-for]")) {
      section.hidden = !section.dataset["for"]!.split(" ").includes(layer.type);
    }
    for (const input of propInputs()) {
      const value = readProp(layer, input.dataset["prop"]!);
      if (input.type === "checkbox") input.checked = value === true;
      else if (input.type === "radio") input.checked = input.value === value;
      else if (document.activeElement !== input || input.type === "range")
        input.value = String(value ?? "");
      if (input.type === "range") showOutput(input);
    }
    // テキストの枠の大きさは文字から決まる
    for (const key of ["width", "height"]) {
      const input = props.querySelector<HTMLInputElement>(
        `[data-prop="${key}"]`,
      );
      if (input) input.disabled = layer.type === "text";
    }
    if (layer.type === "text") {
      if (document.activeElement !== rich) renderPanelText(layer);
      syncCharControls();
      syncFontInfo(layer);
      showHighlight();
    }
    if (layer.type === "path")
      pathFill.value = layer.parts[0]?.color ?? "#ffffff";
  }

  const docInput = (name: string) =>
    docForm.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

  function syncDocPanel() {
    if (!doc) return;
    docInput("name").value = doc.name;
    docInput("width").value = String(doc.width);
    docInput("height").value = String(doc.height);
    docInput("transparent").checked = doc.background === null;
    docInput("background").value = doc.background ?? "#ffffff";
    docInput("background").disabled = doc.background === null;
  }

  // ---- テキストの編集（パネルの編集欄と、キャンバス上の編集欄） ----
  const pathFill = $<HTMLInputElement>(props, '[data-path="fill"]');

  const textLayer = () => {
    const layer = selected();
    return layer?.type === "text" ? layer : null;
  };

  /** 書式を適用する範囲がある編集欄（キャンバス上で編集中ならそちら） */
  const activeEditor = () => (editingId ? stageText : rich);

  /** パネルの編集欄は、一番大きな文字が 22px 程度になるように縮めて見せる */
  const renderPanelText = (layer: model.TextLayer) => {
    richedit.render(rich, layer.runs, {
      scale: Math.min(1, 22 / text.maxSize(layer.runs)),
      lineHeight: layer.lineHeight,
      effects: effectsOf(layer),
    });
    rich.style.textAlign = layer.align;
    rich.classList.toggle("rich--dark", isLight(layer.runs[0]!.style.color));
  };

  let stageTextScale = 0;
  const renderStageText = (layer: model.TextLayer) => {
    stageTextScale = camera.scale;
    richedit.render(stageText, layer.runs, {
      scale: camera.scale,
      lineHeight: layer.lineHeight,
      effects: effectsOf(layer),
    });
    stageText.style.textAlign = layer.align;
  };

  /** 書式を変えたあと、両方の編集欄を作り直す（入力中の編集欄の選択範囲は保つ） */
  const renderEditors = (layer: model.TextLayer) => {
    for (const editor of editingId ? [rich, stageText] : [rich]) {
      const focused = document.activeElement === editor;
      const range = focused ? richedit.getSelection(editor) : null;
      if (editor === rich) renderPanelText(layer);
      else renderStageText(layer);
      if (range) richedit.setSelection(editor, range.start, range.end);
    }
    showHighlight();
  };

  /** キャンバス上の編集欄を、レイヤーの位置と揃えに合わせて置く */
  function positionStageText() {
    if (!editingId || !doc) return;
    const layer = doc.layers.find((l) => l.id === editingId);
    if (layer?.type !== "text") {
      closeStageText();
      return;
    }
    if (stageTextScale !== camera.scale) renderEditors(layer);
    const anchor =
      layer.align === "left" ? 0 : layer.align === "center" ? 0.5 : 1;
    const p = toScreen(layer.x, layer.y);
    const x =
      p.x + (layer.width * camera.scale - stageText.offsetWidth) * anchor;
    stageText.style.translate = `${Math.round(x)}px ${Math.round(p.y)}px`;
  }

  /** 編集欄から離れている間も、書式を変える範囲に色を付けておく */
  function showHighlight() {
    const registry = highlights();
    if (!registry) return;
    const editor = activeEditor();
    if (
      !charRange ||
      charRange.start >= charRange.end ||
      document.activeElement === editor
    ) {
      registry.delete(HIGHLIGHT);
      return;
    }
    registry.set(
      HIGHLIGHT,
      new Highlight(richedit.rangeOf(editor, charRange.start, charRange.end)),
    );
  }

  /** 書式の欄（フォント・大きさ・色・太字）に、選んでいる文字の書式を出す */
  function syncCharControls() {
    const layer = textLayer();
    if (!layer) return;
    const start = charRange?.start ?? 0;
    const end = charRange?.end ?? 0;
    const styles = text.stylesIn(layer.runs, start, end);
    const style = styles[0]!;
    const sizeInput = $<HTMLInputElement>(props, '[data-char="size"]');
    if (document.activeElement !== sizeInput)
      sizeInput.value = String(style.size);
    $<HTMLInputElement>(props, '[data-char="color"]').value = style.color;
    $<HTMLInputElement>(props, '[data-char="bold"]').checked = styles.every(
      (s) => s.bold,
    );
    const mixed = styles.some((s) => !fonts.sameFont(s.font, style.font));
    fontName.textContent = `${style.font.family}${mixed ? " ほか" : ""}`;
    fontName.style.fontFamily = fonts.cssFamily(style.font);
  }

  /** この端末で使えないフォントがあれば知らせる */
  function syncFontInfo(layer: model.TextLayer) {
    const missing = [
      ...new Set(
        layer.runs
          .filter((run) => fonts.status(run.style.font) === "missing")
          .map((run) => run.style.font.family),
      ),
    ];
    fontMissing.hidden = missing.length === 0;
    if (missing.length === 0) return;
    const names = missing.map((name) => `「${name}」`).join("");
    fontMissing.textContent = text.usesOutline(layer)
      ? `${names}はこの端末で使えないため、保存されたパス（文字の形）で表示しています。文字を編集すると代わりのフォントで表示されるので、先にフォントを選び直すか、「ファイル」からフォントを読み込んでください。`
      : `${names}はこの端末で使えないため、代わりのフォントで表示しています。フォントを選び直すか、「ファイル」からフォントを読み込んでください。`;
  }

  /** 選んでいる文字（無ければテキスト全体）に書式を適用する */
  const applyChar = (patch: Partial<model.CharStyle>) => {
    const layer = textLayer();
    if (!layer) return;
    const editor = activeEditor();
    const range =
      (document.activeElement === editor
        ? richedit.getSelection(editor)
        : null) ?? charRange;
    layer.runs = text.applyStyle(
      layer.runs,
      range?.start ?? 0,
      range?.end ?? 0,
      patch,
    );
    textChanged(layer);
    renderEditors(layer);
    syncGeometry();
    syncFontInfo(layer);
    requestDraw();
  };

  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  /** 文字の入力は、少し間が空いたところで履歴に積む */
  const scheduleCommit = () => {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 600);
  };

  const onTextInput = (editor: HTMLElement, event: Event) => {
    const layer = textLayer();
    if (!layer) return;
    // 書式の無い文字（全部消してから入力した文字など）は、直前にカーソルがあった位置の書式にする
    const fallback = text.styleAt(
      layer.runs,
      Math.max(0, (charRange?.start ?? 1) - 1),
    );
    layer.runs = richedit.read(editor, fallback);
    // 変換中（IME）は DOM を作り直さない
    if (!(event as InputEvent).isComposing && !richedit.isClean(editor)) {
      const range = richedit.getSelection(editor);
      if (editor === rich) renderPanelText(layer);
      else renderStageText(layer);
      if (range) richedit.setSelection(editor, range.start, range.end);
    }
    textChanged(layer);
    if (editor === stageText) renderPanelText(layer);
    syncGeometry();
    requestDraw();
    scheduleCommit();
  };

  for (const editor of [rich, stageText]) {
    editor.addEventListener("input", (event) => onTextInput(editor, event));
    editor.addEventListener("compositionend", (event) =>
      onTextInput(editor, event),
    );
    editor.addEventListener("focusout", () => {
      clearTimeout(commitTimer);
      commit();
    });
    // 貼り付けは書式なしの文字だけにする
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const value = event.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, value.replace(/\r\n?/g, "\n"));
    });
    editor.addEventListener("drop", (event) => event.preventDefault());
    editor.addEventListener("keydown", (event) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // ブラウザの太字・斜体・下線（<b> などを入れる）の代わりに、書式の太字を切り替える
      if (mod && (key === "b" || key === "i" || key === "u")) {
        event.preventDefault();
        if (key === "b") {
          const layer = textLayer();
          const range = richedit.getSelection(editor);
          if (!layer) return;
          const styles = text.stylesIn(
            layer.runs,
            range?.start ?? 0,
            range?.end ?? 0,
          );
          applyChar({ bold: !styles.every((s) => s.bold) });
          commit();
          syncCharControls();
        }
        return;
      }
      if (key === "escape" && editor === stageText) {
        event.preventDefault();
        finishEditing();
        stage.focus({ preventScroll: true });
      }
    });
  }

  document.addEventListener(
    "selectionchange",
    () => {
      const editor = activeEditor();
      if (document.activeElement !== editor) return;
      const range = richedit.getSelection(editor);
      if (!range) return;
      charRange = range;
      syncCharControls();
    },
    { signal },
  );

  // 書式の欄やフォントのダイアログに移ったときは、選んでいた文字の範囲を保つ。それ以外に移ったら忘れる
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const editor = activeEditor();
      if (target === editor) {
        clearHighlight();
        return;
      }
      if (target.closest("[data-char], #font-button, #font-dialog")) {
        showHighlight();
        return;
      }
      if (editingId) finishEditing();
      if (target !== rich) {
        charRange = null;
        clearHighlight();
        syncCharControls();
      }
    },
    { signal },
  );

  /** キャンバス上の編集欄を閉じる（履歴には積まない） */
  function closeStageText() {
    if (!editingId) return;
    editingId = null;
    stageText.hidden = true;
    stageText.replaceChildren();
    clearHighlight();
    requestDraw();
  }

  /** キャンバス上の編集を終える */
  function finishEditing() {
    if (!editingId) return;
    clearTimeout(commitTimer);
    closeStageText();
    charRange = null;
    commit();
    syncPanel();
  }

  /** テキストをキャンバス上で、その場で編集する */
  function startEditing(layer: model.TextLayer) {
    if (editingId === layer.id) return;
    finishEditing();
    if (selectedId !== layer.id) select(layer.id);
    editingId = layer.id;
    stageText.hidden = false;
    renderStageText(layer);
    positionStageText();
    stageText.focus({ preventScroll: true });
    // 文字をすべて選んでおき、そのまま入力すると置き換わるようにする
    richedit.setSelection(stageText, 0, richedit.length(stageText));
    requestDraw();
  }

  const pickFont = async () => {
    const layer = textLayer();
    if (!layer) return;
    const range = charRange;
    const current = text.stylesIn(
      layer.runs,
      range?.start ?? 0,
      range?.end ?? 0,
    )[0]!;
    const font = await picker.open(current.font);
    if (!font || textLayer() !== layer) return;
    charRange = range;
    applyChar({ font });
    commit();
    syncCharControls();
  };

  // フォントを読み込めたら（または読み込めなかったら）、テキストを測り直して描き直す
  let fontTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeFonts = fonts.subscribe(() => {
    if (!doc) return;
    let moved = false;
    for (const layer of doc.layers)
      if (layer.type === "text" && render.fitText(layer)) moved = true;
    if (moved) syncGeometry();
    const layer = textLayer();
    if (layer) {
      syncFontInfo(layer);
      syncCharControls();
    }
    requestDraw();
    // レイヤーの一覧のサムネイルは、まとめて描き直す
    clearTimeout(fontTimer);
    fontTimer = setTimeout(renderLayerList, 150);
  });
  signal.addEventListener("abort", () => {
    unsubscribeFonts();
    clearTimeout(fontTimer);
    clearTimeout(commitTimer);
  });

  /** テキストを、文字の形のパスのレイヤーにする */
  const convertToPath = async () => {
    const layer = textLayer();
    if (!layer || !doc) return;
    finishEditing();
    notify("パスに変換しています…");
    let shape = text.usesOutline(layer) ? layer.outline : null;
    if (!shape) {
      await render.loadFonts(layer).catch(() => undefined);
      render.fitText(layer);
      shape = await outline.build(layer).catch(() => null);
    }
    const index = doc?.layers.indexOf(layer) ?? -1;
    if (!doc || index < 0) return;
    if (!shape || shape.parts.length === 0) {
      notify(
        shape
          ? "文字が無いので、パスに変換できませんでした。"
          : "フォントのデータを読めない文字があるため、パスに変換できませんでした。",
        true,
      );
      return;
    }
    const path: model.PathLayer = {
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
      x: layer.x,
      y: layer.y,
      width: shape.width,
      height: shape.height,
      filters: layer.filters,
      type: "path",
      baseWidth: shape.width,
      baseHeight: shape.height,
      parts: shape.parts,
      size: text.maxSize(layer.runs),
      strokeColor: layer.strokeColor,
      strokeWidth: layer.strokeWidth,
      shadow: layer.shadow,
    };
    doc.layers[index] = path;
    commit();
    syncPanel();
    requestDraw();
    notify("パスに変換しました。");
  };

  props.addEventListener("input", (event) => {
    const input = event.target;
    if (!(
      input instanceof HTMLInputElement ||
      input instanceof HTMLTextAreaElement ||
      input instanceof HTMLSelectElement
    ))
      return;
    const layer = selected();
    if (!layer) return;
    // 文字ごとの書式
    const char = input.dataset["char"];
    if (char && input instanceof HTMLInputElement) {
      if (char === "size") {
        const size = Number(input.value);
        if (
          input.value === "" ||
          !input.checkValidity() ||
          !Number.isFinite(size)
        )
          return;
        applyChar({ size });
      } else if (char === "color") applyChar({ color: input.value });
      else if (char === "bold") applyChar({ bold: input.checked });
      return;
    }
    // パスの塗りは、すべての文字の色をまとめて変える
    if (input === pathFill && layer.type === "path") {
      layer.parts = layer.parts.map((part) => ({
        ...part,
        color: input.value,
      }));
      requestDraw();
      return;
    }
    const path = input.dataset["prop"];
    if (!path) return;
    let value: unknown;
    if (input instanceof HTMLInputElement && input.type === "checkbox")
      value = input.checked;
    else if (
      input instanceof HTMLInputElement &&
      (input.type === "number" || input.type === "range")
    ) {
      if (input.value === "" || !input.checkValidity()) return;
      value = Number(input.value);
      if (!Number.isFinite(value)) return;
      if (input.type === "range") showOutput(input);
    } else value = input.value;
    if (path === "name" && typeof value === "string") {
      value = value.slice(0, 200);
    }
    writeProp(layer, path, value);
    if (path === "width" || path === "height")
      writeProp(layer, path, Math.max(1, Math.round(value as number)));
    if (layer.type === "text") {
      textChanged(layer);
      renderEditors(layer);
      syncGeometry();
    }
    if (path === "name") {
      const name = layerList.querySelector(
        `.layer[data-id="${CSS.escape(layer.id)}"] .layer__name`,
      );
      if (name) name.textContent = layer.name;
    }
    requestDraw();
  });

  // 値を決めたところ（スライダーを離した、欄から出た）で履歴に積む
  props.addEventListener("change", () => {
    commit();
    syncPanel();
  });

  props.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-action='reset-filters']")
        : null;
    const layer = selected();
    if (!target || !layer) return;
    layer.filters = { ...model.defaultFilters };
    commit();
    syncPanel();
    requestDraw();
  });

  docForm.addEventListener("submit", (event) => event.preventDefault());
  docForm.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !doc) return;
    if (input.name === "name") doc.name = input.value.slice(0, 200);
    if (input.name === "transparent") {
      doc.background = input.checked ? null : docInput("background").value;
      docInput("background").disabled = input.checked;
    }
    if (input.name === "background" && !docInput("transparent").checked)
      doc.background = input.value;
    requestDraw();
  });
  docForm.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !doc) return;
    if (input.name === "width" || input.name === "height") {
      const width = Number(docInput("width").value);
      const height = Number(docInput("height").value);
      if (
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width >= 1 &&
        height >= 1
      ) {
        const size = model.fitSize(Math.round(width), Math.round(height));
        doc.width = size.width;
        doc.height = size.height;
        if (size.scaled)
          notify("大きすぎるので、扱える大きさまで縮めました。", true);
        setStageRatio();
        fitCamera();
      }
      syncDocPanel();
    }
    commit();
    requestDraw();
  });

  // ---- ドキュメントの作成・読み込み ----
  /** 狭い画面では、キャンバスの高さをドキュメントの縦横比に合わせる（CSS で使う） */
  const setStageRatio = () => {
    if (doc)
      stage.style.setProperty("--doc-hw", String(doc.height / doc.width));
  };

  // ---- トリミング ----
  const cropPreset = () => {
    const id = new FormData(cropForm).get("crop-preset");
    return (
      model.cropPresets.find((preset) => preset.id === id) ??
      model.cropPresets[0]!
    );
  };

  /** 切り抜く枠を画面の座標にする */
  function cropScreenBox(box: snap.Box): snap.Box {
    const topLeft = toScreen(box.x, box.y);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: box.width * camera.scale,
      height: box.height * camera.scale,
    };
  }

  /** 比率が決まっているときは、角のハンドルだけにする */
  function cropHandles(): Handle[] {
    return cropPreset().ratio
      ? ["nw", "ne", "se", "sw"]
      : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  }

  /** 切り抜いたあとの大きさ（px）。決まった大きさに合わせるときはその大きさ */
  const cropResult = () => {
    if (!crop) return null;
    const preset = cropPreset();
    const fit = preset.size && cropFitInput().checked ? preset.size : null;
    return {
      width: Math.max(1, Math.round(crop.width)),
      height: Math.max(1, Math.round(crop.height)),
      fit,
    };
  };

  const cropFitInput = () =>
    cropForm.querySelector<HTMLInputElement>('[name="crop-fit"]')!;

  function syncCropPanel() {
    const result = cropResult();
    if (!result) return;
    const preset = cropPreset();
    const fitLabel = cropForm.querySelector<HTMLElement>("#crop-fit")!;
    fitLabel.hidden = !preset.size;
    if (preset.size)
      cropForm.querySelector<HTMLElement>("#crop-fit-label")!.textContent =
        `切り抜いたあと ${preset.size[0]} × ${preset.size[1]} px に拡大・縮小する`;
    cropForm.querySelector<HTMLElement>("#crop-size")!.textContent = result.fit
      ? `${result.width} × ${result.height} px を切り抜いて、${result.fit[0]} × ${result.fit[1]} px にします`
      : `${result.width} × ${result.height} px を切り抜きます`;
  }

  const startCrop = () => {
    if (!doc) return;
    if (crop) {
      cancelCrop();
      return;
    }
    finishEditing();
    selectedId = null;
    renderLayerList();
    const preset = cropPreset();
    crop = preset.ratio
      ? fitCrop(doc, preset.ratio)
      : { x: 0, y: 0, width: doc.width, height: doc.height };
    syncPanel();
    requestDraw();
  };

  function cancelCrop() {
    if (!crop) return;
    crop = null;
    drag = null;
    syncPanel();
    requestDraw();
  }

  /** 画像の clip の範囲だけを、元の解像度で新しい画像にする */
  const clipAsset = async (layer: model.ImageLayer, clip: snap.Box) => {
    const asset = assets.get(layer.asset);
    if (!asset) return null;
    const sx = asset.image.width / layer.width;
    const sy = asset.image.height / layer.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(clip.width * sx));
    canvas.height = Math.max(1, Math.round(clip.height * sy));
    canvas
      .getContext("2d")!
      .drawImage(
        asset.image,
        clip.x * sx,
        clip.y * sy,
        clip.width * sx,
        clip.height * sy,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    const type = ["image/jpeg", "image/webp"].includes(asset.blob.type)
      ? asset.blob.type
      : "image/png";
    const blob = await exporter.toBlob(canvas, type, 0.95);
    return addAsset(blob, await createImageBitmap(blob));
  };

  /**
   * 決まった大きさに合わせて切り抜く。拡大するとレイヤーの枠の外の部分も大きくなるので、
   * 画像は枠にかかる範囲だけを残す。それでも canvas の上限を超えるときは null
   */
  const cropToFit = async (
    target: model.Doc,
    box: snap.Box,
    fit: readonly [number, number],
  ) => {
    // 丸める前の枠で拡大・縮小する。丸めると比率がずれて、端が欠けたり枠の外が見えたりする
    const scale = fit[0] / box.width;
    const clips = new Map<string, snap.Box>();
    for (const layer of target.layers)
      if (layer.type === "image") clips.set(layer.id, imageClip(layer, box));
    const visible = (size: snap.Box) => size.width > 0 && size.height > 0;
    const fits = target.layers.every((layer) => {
      const size = clips.get(layer.id) ?? layer;
      return (
        !visible(size) ||
        withinCanvasLimit(size.width * scale, size.height * scale)
      );
    });
    if (!fits) return null;
    const replaced = new Map<string, string>();
    for (const layer of target.layers) {
      const clip = clips.get(layer.id);
      if (
        layer.type !== "image" ||
        !clip ||
        !visible(clip) ||
        (clip.width === layer.width && clip.height === layer.height)
      )
        continue;
      const asset = await clipAsset(layer, clip);
      if (asset) replaced.set(layer.id, asset);
    }
    return () => {
      // 枠にかからない画像レイヤーは消す
      target.layers = target.layers.filter((layer) => {
        const clip = clips.get(layer.id);
        return !clip || visible(clip);
      });
      for (const layer of target.layers) {
        const clip = clips.get(layer.id);
        const asset = replaced.get(layer.id);
        if (layer.type === "image" && clip && asset) {
          layer.asset = asset;
          layer.x += clip.x;
          layer.y += clip.y;
          layer.width = clip.width;
          layer.height = clip.height;
        }
        layer.x -= box.x;
        layer.y -= box.y;
        scaleLayer(layer, scale);
      }
      target.width = fit[0];
      target.height = fit[1];
    };
  };

  const applyCrop = async () => {
    const result = cropResult();
    if (!doc || !crop || !result) return;
    const target = doc;
    const box = crop;
    crop = null;
    drag = null;
    syncPanel();
    let apply: (() => void) | null = null;
    if (result.fit) {
      try {
        apply = await cropToFit(target, box, result.fit);
      } catch {
        apply = null;
      }
      // 画像を作っているあいだに別のファイルを開いたとき
      if (doc !== target) return;
      crop = null;
    }
    if (apply) apply();
    else {
      const x = Math.round(box.x);
      const y = Math.round(box.y);
      for (const layer of target.layers) {
        layer.x -= x;
        layer.y -= y;
      }
      target.width = Math.min(result.width, target.width - x);
      target.height = Math.min(result.height, target.height - y);
    }
    commit();
    setStageRatio();
    fitCamera();
    refreshAll();
    notify(
      result.fit && !apply
        ? `${result.fit[0]} × ${result.fit[1]} px に拡大できなかったため、${target.width} × ${target.height} px のまま切り抜きました。`
        : `${target.width} × ${target.height} px に切り抜きました。`,
    );
  };

  cropForm.addEventListener("submit", (event) => event.preventDefault());
  cropForm.addEventListener("change", (event) => {
    if (!doc || !crop) return;
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === "crop-preset") {
      const preset = cropPreset();
      if (preset.ratio) crop = fitCrop(doc, preset.ratio);
    }
    syncCropPanel();
    requestDraw();
  });

  const refreshAll = () => {
    empty.hidden = doc !== null;
    stage.classList.toggle("stage--ready", doc !== null);
    setStageRatio();
    root.dataset["state"] = doc ? "ready" : "empty";
    renderLayerList();
    syncPanel();
    requestDraw();
  };

  const confirmDiscard = () =>
    !isDirty() ||
    confirm("保存していない変更があります。破棄してよろしいですか？");

  const startDoc = (next: model.Doc, handle: project.FileHandle | null) => {
    closeStageText();
    charRange = null;
    crop = null;
    doc = next;
    fileHandle = handle;
    selectedId = null;
    cache.clear();
    history = [snapshot()];
    historyIndex = 0;
    savedIndex = 0;
    updateHistoryButtons();
    fitCamera();
    refreshAll();
    // テキストのフォントを読み込んでから描き直す
    for (const layer of next.layers)
      if (layer.type === "text") textChanged(layer);
  };

  const addAsset = (blob: Blob, image: ImageBitmap) => {
    const id = model.newId();
    assets.set(id, { blob, image });
    return id;
  };

  const addLayer = (layer: model.Layer) => {
    if (!doc) return;
    // 選択中のレイヤーのすぐ上に置く
    const current = selected();
    const index = current ? doc.layers.indexOf(current) + 1 : doc.layers.length;
    doc.layers.splice(index, 0, layer);
    selectedId = layer.id;
    commit();
    syncPanel();
    requestDraw();
  };

  const openImage = async (file: Blob, name: string, asNewDoc: boolean) => {
    try {
      const loaded = await loadImage(file);
      const asset = addAsset(loaded.blob, loaded.image);
      if (asNewDoc || !doc) {
        const next: model.Doc = {
          name,
          width: loaded.image.width,
          height: loaded.image.height,
          background: null,
          layers: [],
        };
        startDoc(next, null);
        addLayer({
          ...model.createImage(
            next,
            asset,
            loaded.image.width,
            loaded.image.height,
            name,
          ),
          x: 0,
          y: 0,
        });
        // 開いた画像を履歴の始まりにする（元に戻すで画像が消えないように）
        history = [snapshot()];
        historyIndex = 0;
        savedIndex = 0;
        updateHistoryButtons();
      } else {
        addLayer(
          model.createImage(
            doc,
            asset,
            loaded.image.width,
            loaded.image.height,
            name,
          ),
        );
      }
      if (loaded.scaled)
        notify("大きい画像なので、扱える大きさまで縮めました。");
    } catch {
      notify("この画像は読み込めませんでした。", true);
    }
  };

  const openProject = async (file: File, handle: project.FileHandle | null) => {
    try {
      const loaded = await project.deserialize(file);
      for (const [id, asset] of loaded.assets) assets.set(id, asset);
      startDoc(loaded.doc, handle);
      savedIndex = historyIndex;
      notify(`「${loaded.doc.name}」を開きました。`);
    } catch (error) {
      notify(
        error instanceof project.ProjectError
          ? error.message
          : "ファイルを開けませんでした。",
        true,
      );
    }
  };

  const openFile = async (file: File, handle: project.FileHandle | null) => {
    if (project.isProjectFile(file)) await openProject(file, handle);
    else if (project.isImageFile(file))
      await openImage(file, project.baseName(file.name), true);
    else
      notify("画像か IMAGE の作品ファイル（.tbimg）を選んでください。", true);
  };

  const open = async () => {
    if (!confirmDiscard()) return;
    const picked = await project.pickFile(openInput);
    if (picked) await openFile(picked.file, picked.handle);
  };

  const pickImage = () =>
    new Promise<File | null>((resolve) => {
      imageInput.value = "";
      imageInput.addEventListener(
        "change",
        () => resolve(imageInput.files?.[0] ?? null),
        { once: true, signal },
      );
      imageInput.click();
    });

  const addImage = async () => {
    const file = await pickImage();
    if (file) await openImage(file, project.baseName(file.name), !doc);
  };

  const addText = () => {
    if (!doc) return;
    // 前に選んでいたテキストの書式を引き継ぐ
    const previous = textLayer();
    const style = previous
      ? { ...previous.runs[0]!.style, size: text.maxSize(previous.runs) }
      : undefined;
    const layer = model.createText(doc, style);
    render.fitText(layer);
    layer.x = Math.round((doc.width - layer.width) / 2);
    layer.y = Math.round((doc.height - layer.height) / 2);
    addLayer(layer);
    textChanged(layer);
    startEditing(layer);
  };

  // ---- 保存と書き出し ----
  let saving = false;
  const save = async (saveAs = false) => {
    if (!doc || saving) return;
    saving = true;
    try {
      // 入力中の文字も履歴に積んでから保存する
      clearTimeout(commitTimer);
      commit();
      const index = historyIndex;
      const failed = await buildOutlines(doc);
      const blob = await project.serialize(doc, assets);
      const result = await project.save(
        blob,
        doc.name,
        saveAs ? null : fileHandle,
      );
      if (result === undefined) return;
      fileHandle = result;
      savedIndex = index;
      notify(
        `${
          result
            ? `${result.name} に保存しました。`
            : "作品ファイルをダウンロードしました。"
        }${
          failed > 0
            ? "フォントのデータを読めないテキストがあったため、そのテキストの文字の形（パス）は保存していません。"
            : ""
        }`,
        failed > 0,
      );
    } catch {
      notify("保存できませんでした。", true);
    } finally {
      saving = false;
    }
  };

  const exportQuality = () =>
    Number(
      exportForm.querySelector<HTMLInputElement>('[name="quality"]')!.value,
    ) / 100;
  const exportFormat = () =>
    (new FormData(exportForm).get("format") as exporter.Format | null) ?? "png";
  const exportInput = (name: string) =>
    exportForm.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  /** サイズを指定して圧縮するときの上限。画質を指定するときや PNG・PSD では null */
  const exportLimit = (): exporter.Limit | null => {
    const format = exportFormat();
    if (format !== "jpeg" && format !== "webp") return null;
    if (new FormData(exportForm).get("mode") !== "size") return null;
    const megabytes = Number(exportInput("limit").value);
    if (!Number.isFinite(megabytes) || megabytes <= 0) return null;
    return {
      bytes: Math.floor(megabytes * MEGABYTE),
      shrink: exportInput("shrink").checked,
    };
  };

  const syncExportForm = () => {
    const format = exportFormat();
    const lossy = format === "jpeg" || format === "webp";
    const bySize = new FormData(exportForm).get("mode") === "size";
    exportForm.querySelector<HTMLElement>("#export-mode")!.hidden = !lossy;
    exportForm.querySelector<HTMLElement>("#export-quality")!.hidden =
      !lossy || bySize;
    exportForm.querySelector<HTMLElement>("#export-limit")!.hidden =
      !lossy || !bySize;
    for (const chip of exportForm.querySelectorAll<HTMLElement>("[data-limit]"))
      chip.setAttribute(
        "aria-pressed",
        String(
          Number(chip.dataset["limit"]) === Number(exportInput("limit").value),
        ),
      );
    const note = exportForm.querySelector<HTMLElement>("#export-note")!;
    note.textContent =
      lossy && bySize
        ? `上限に収まる、一番きれいな画質を探して書き出します（1 MB = 1,000,000 バイト）。${format === "jpeg" ? "透明な部分は白で塗りつぶします。" : ""}`
        : format === "psd"
          ? "レイヤーを保ったまま書き出します。テキストと図形は、フィルターを適用した画像のレイヤーになります。"
          : format === "jpeg"
            ? "透明な部分は白で塗りつぶします。"
            : format === "png"
              ? "透明な部分は透明のまま書き出します。"
              : "透明な部分は透明のまま書き出します。対応していないブラウザでは PNG になります。";
    const output = exportForm.querySelector<HTMLOutputElement>(
      'output[for="export-quality-input"]',
    );
    if (output) output.value = `${Math.round(exportQuality() * 100)}`;
  };

  exportForm.addEventListener("input", syncExportForm);
  exportForm.addEventListener("click", (event) => {
    const chip =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-limit]")
        : null;
    if (!chip) return;
    exportInput("limit").value = chip.dataset["limit"]!;
    syncExportForm();
  });
  exportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!doc) return;
    const submitter = (event as SubmitEvent).submitter;
    const button = submitter instanceof HTMLButtonElement ? submitter : null;
    if (button?.value === "cancel") {
      exportDialog.close();
      return;
    }
    if (button) button.disabled = true;
    try {
      if (button?.value === "copy") {
        await exporter.copyImage(doc, assets, cache);
        notify("画像をクリップボードにコピーしました。");
      } else {
        const limit = exportLimit();
        const note = exportForm.querySelector<HTMLElement>("#export-note")!;
        if (limit) note.textContent = "圧縮しています…";
        const result = await exporter.exportFile(
          doc,
          assets,
          cache,
          exportFormat(),
          exportQuality(),
          limit,
        );
        const packed = result.compressed;
        if (result.actual !== result.requested)
          notify(
            "このブラウザは WebP に対応していないため、PNG で書き出しました。",
          );
        else if (packed) {
          const detail = `${formatBytes(result.size)}（画質 ${Math.round(packed.quality * 100)}%${
            packed.shrunk ? `、${packed.width} × ${packed.height} に縮小` : ""
          }）`;
          notify(
            packed.fitted
              ? `${detail}で書き出しました。`
              : `上限に収まりませんでした。一番小さくした ${detail}で書き出しました。`,
            !packed.fitted,
          );
        } else notify(`${formatBytes(result.size)}で書き出しました。`);
      }
      exportDialog.close();
    } catch {
      notify(
        button?.value === "copy"
          ? "クリップボードにコピーできませんでした。"
          : "書き出せませんでした。",
        true,
      );
    } finally {
      if (button) button.disabled = false;
      syncExportForm();
    }
  });

  const showExport = () => {
    if (!doc) return;
    exportForm.querySelector<HTMLElement>("#export-size")!.textContent =
      `${doc.width} × ${doc.height} px`;
    syncExportForm();
    exportDialog.showModal();
  };

  // ---- 新規作成 ----
  const syncNewForm = () => {
    const data = new FormData(newForm);
    const preset = String(data.get("preset") ?? "");
    const custom = newForm.querySelector<HTMLElement>("#new-custom")!;
    custom.hidden = preset !== "custom";
  };
  newForm.addEventListener("input", syncNewForm);
  newForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter;
    if (
      submitter instanceof HTMLButtonElement &&
      submitter.value === "cancel"
    ) {
      newDialog.close();
      return;
    }
    const data = new FormData(newForm);
    const preset = String(data.get("preset") ?? "1920x1080");
    const [w, h] =
      preset === "custom"
        ? [Number(data.get("width")), Number(data.get("height"))]
        : preset.split("x").map(Number);
    if (
      !w ||
      !h ||
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      w < 1 ||
      h < 1
    )
      return;
    const size = model.fitSize(Math.round(w), Math.round(h));
    const background = String(data.get("background") ?? "white");
    newDialog.close();
    startDoc(
      {
        name: "無題",
        width: size.width,
        height: size.height,
        background:
          background === "transparent"
            ? null
            : background === "black"
              ? "#000000"
              : "#ffffff",
        layers: [],
      },
      null,
    );
    if (size.scaled)
      notify("大きすぎるので、扱える大きさまで縮めました。", true);
  });

  const showNew = () => {
    if (!confirmDiscard()) return;
    syncNewForm();
    newDialog.showModal();
  };

  // ---- レイヤーの並べ替え・複製・削除 ----
  const moveLayer = (direction: 1 | -1) => {
    const layer = selected();
    if (!doc || !layer) return;
    const index = doc.layers.indexOf(layer);
    const next = index + direction;
    if (next < 0 || next >= doc.layers.length) return;
    doc.layers.splice(index, 1);
    doc.layers.splice(next, 0, layer);
    commit();
    requestDraw();
  };

  const duplicate = () => {
    const layer = selected();
    if (!layer) return;
    addLayer(model.duplicateLayer(layer));
  };

  const remove = () => {
    const layer = selected();
    if (!doc || !layer) return;
    const index = doc.layers.indexOf(layer);
    doc.layers.splice(index, 1);
    selectedId = doc.layers[Math.min(index, doc.layers.length - 1)]?.id ?? null;
    cache.prune(doc);
    commit();
    syncPanel();
    requestDraw();
  };

  const nudge = (dx: number, dy: number) => {
    const layer = selected();
    if (!layer) return;
    layer.x += dx;
    layer.y += dy;
    syncGeometry();
    requestDraw();
  };

  // ---- ボタン ----
  const actions: Record<string, () => void> = {
    new: showNew,
    open: () => void open(),
    save: () => void save(),
    export: showExport,
    "add-image": () => void addImage(),
    "add-text": addText,
    "add-rect": () => doc && addLayer(model.createShape(doc, "rect")),
    "add-ellipse": () => doc && addLayer(model.createShape(doc, "ellipse")),
    undo,
    redo,
    snap: () => {
      snapEnabled = !snapEnabled;
      snapButton.setAttribute("aria-pressed", String(snapEnabled));
    },
    "zoom-in": () => zoomBy(1.25),
    "zoom-out": () => zoomBy(0.8),
    "zoom-fit": () => {
      fitCamera();
      requestDraw();
    },
    "layer-up": () => moveLayer(1),
    "layer-down": () => moveLayer(-1),
    "layer-duplicate": duplicate,
    "layer-delete": remove,
    "pick-font": () => void pickFont(),
    crop: startCrop,
    "crop-apply": () => void applyCrop(),
    "crop-cancel": cancelCrop,
    "to-path": () => void convertToPath(),
  };

  root.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-action]")
        : null;
    if (!target || target.disabled) return;
    actions[target.dataset["action"]!]?.();
  });

  // ---- キーボード ----
  document.addEventListener(
    "keydown",
    (event) => {
      if (newDialog.open || exportDialog.open || fontDialog.open) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "s") {
        event.preventDefault();
        void save(event.shiftKey);
        return;
      }
      if (mod && key === "o") {
        event.preventDefault();
        void open();
        return;
      }
      if (mod && key === "e" && doc) {
        event.preventDefault();
        showExport();
        return;
      }
      // トリミング中は Enter で切り抜き、Esc でやめる（比率の選択肢にフォーカスがあっても効かせる）
      if (
        crop &&
        !mod &&
        (key === "enter" || key === "escape") &&
        !(
          event.target instanceof HTMLInputElement &&
          !["radio", "checkbox"].includes(event.target.type)
        )
      ) {
        event.preventDefault();
        if (key === "enter") void applyCrop();
        else cancelCrop();
        return;
      }
      if (isEditable(event.target)) return;
      // トリミング中は、ほかのキーでレイヤーを動かしたり消したりしない
      if (crop && !mod) return;
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && key === "d" && selected()) {
        event.preventDefault();
        duplicate();
        return;
      }
      const current = selected();
      if (!current) return;
      if (key === "enter" && current.type === "text") {
        event.preventDefault();
        startEditing(current);
        return;
      }
      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        remove();
      } else if (key === "escape") {
        select(null);
      } else if (key.startsWith("arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudge(
          key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
          key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
        );
      }
    },
    { signal },
  );
  // 矢印キーでの移動は、キーを離したところで履歴に積む
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key.startsWith("Arrow") && !isEditable(event.target)) commit();
    },
    { signal },
  );

  // ---- ドロップと貼り付け ----
  stage.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      stage.classList.add("stage--drop");
    }
  });
  stage.addEventListener("dragleave", () =>
    stage.classList.remove("stage--drop"),
  );
  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    stage.classList.remove("stage--drop");
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    if (project.isProjectFile(file)) {
      if (confirmDiscard()) void openProject(file, null);
    } else if (project.isImageFile(file)) {
      void openImage(file, project.baseName(file.name), !doc);
    }
  });
  document.addEventListener(
    "paste",
    (event) => {
      if (isEditable(event.target)) return;
      const file = [...(event.clipboardData?.files ?? [])].find((f) =>
        project.isImageFile(f),
      );
      if (!file) return;
      event.preventDefault();
      void openImage(file, "貼り付けた画像", !doc);
    },
    { signal },
  );

  // ---- 保存していない変更の確認 ----
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (!isDirty()) return;
      event.preventDefault();
    },
    { signal },
  );
  // ClientRouter での遷移はページ全体の読み込みに切り替えて、上の確認を出す
  document.addEventListener(
    "astro:before-preparation",
    (event) => {
      if (isDirty()) event.preventDefault();
    },
    { signal },
  );

  window.addEventListener(
    "resize",
    () => {
      if (camera.fit) fitCamera();
      requestDraw();
    },
    { signal },
  );

  refreshAll();
};
