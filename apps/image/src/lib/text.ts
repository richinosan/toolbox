// 文字ごとに書式を持つテキスト（ラン）の操作と、行のレイアウト・描画。
import * as fonts from "./fonts";
import type * as model from "./model";

// ---- ランの操作 ----

export const sameStyle = (a: model.CharStyle, b: model.CharStyle) =>
  fonts.sameFont(a.font, b.font) &&
  a.size === b.size &&
  a.color === b.color &&
  a.bold === b.bold;

export const plainText = (runs: readonly model.TextRun[]) =>
  runs.map((run) => run.text).join("");

/** 空のランを除き、同じ書式で隣り合うランをまとめる。空になったら最初の書式で空文字を 1 つ残す */
export const normalize = (
  runs: readonly model.TextRun[],
  fallback: model.CharStyle,
): model.TextRun[] => {
  const out: model.TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && sameStyle(last.style, run.style)) last.text += run.text;
    else out.push({ text: run.text, style: { ...run.style } });
  }
  return out.length > 0
    ? out
    : [{ text: "", style: { ...(runs[0]?.style ?? fallback) } }];
};

/** offset の位置の文字の書式（offset が末尾なら最後の文字） */
export const styleAt = (runs: readonly model.TextRun[], offset: number) => {
  let position = 0;
  for (const run of runs) {
    if (offset < position + run.text.length) return run.style;
    position += run.text.length;
  }
  return runs.at(-1)!.style;
};

/** start〜end の文字の書式（start === end なら全体） */
export const stylesIn = (
  runs: readonly model.TextRun[],
  start: number,
  end: number,
) => {
  if (start >= end) return runs.map((run) => run.style);
  const out: model.CharStyle[] = [];
  let position = 0;
  for (const run of runs) {
    const runStart = position;
    position += run.text.length;
    if (position > start && runStart < end) out.push(run.style);
  }
  return out.length > 0 ? out : [styleAt(runs, start)];
};

/** start〜end の文字に書式を適用する（start === end なら全体） */
export const applyStyle = (
  runs: readonly model.TextRun[],
  start: number,
  end: number,
  patch: Partial<model.CharStyle>,
): model.TextRun[] => {
  const all = start >= end;
  const out: model.TextRun[] = [];
  let position = 0;
  for (const run of runs) {
    const runStart = position;
    const runEnd = position + run.text.length;
    position = runEnd;
    if (all) {
      out.push({ text: run.text, style: { ...run.style, ...patch } });
      continue;
    }
    const a = Math.max(start, runStart);
    const b = Math.min(end, runEnd);
    if (a >= b) {
      out.push(run);
      continue;
    }
    if (a > runStart)
      out.push({ text: run.text.slice(0, a - runStart), style: run.style });
    out.push({
      text: run.text.slice(a - runStart, b - runStart),
      style: { ...run.style, ...patch },
    });
    if (b < runEnd)
      out.push({ text: run.text.slice(b - runStart), style: run.style });
  }
  return normalize(out, runs[0]!.style);
};

/** すべての文字の大きさを scale 倍にする（ハンドルでの拡大・縮小） */
export const scaleRuns = (runs: readonly model.TextRun[], scale: number) =>
  runs.map((run) => ({
    text: run.text,
    style: {
      ...run.style,
      size: Math.max(1, Math.round(run.style.size * scale * 10) / 10),
    },
  }));

export const maxSize = (runs: readonly model.TextRun[]) =>
  Math.max(1, ...runs.map((run) => run.style.size));

/** 使っているフォント（重複なし）と、そのフォントで使う文字 */
export const fontUsage = (runs: readonly model.TextRun[]) => {
  const usage = new Map<
    string,
    { font: fonts.FontRef; bold: boolean; text: string }
  >();
  for (const run of runs) {
    const key = `${fonts.keyOf(run.style.font)}|${run.style.bold}`;
    const entry = usage.get(key) ?? {
      font: run.style.font,
      bold: run.style.bold,
      text: "",
    };
    entry.text += run.text;
    usage.set(key, entry);
  }
  return [...usage.values()];
};

// ---- レイアウト ----

export type Segment = {
  text: string;
  style: model.CharStyle;
  /** 行の左端からの位置 */
  x: number;
  width: number;
};

export type Line = {
  segments: Segment[];
  width: number;
  /** 行の上端（テキストの枠の上端から） */
  top: number;
  height: number;
  /** ベースライン（テキストの枠の上端から） */
  baseline: number;
};

export type Layout = { lines: Line[]; width: number; height: number };

let measureContext: CanvasRenderingContext2D | null = null;
const measurer = () => {
  measureContext ??= document.createElement("canvas").getContext("2d")!;
  return measureContext;
};

const metrics = (style: model.CharStyle, text: string) => {
  const context = measurer();
  context.font = fonts.fontString(style.font, style.size, style.bold);
  const m = context.measureText(text || "あ");
  return {
    width: text ? m.width : 0,
    ascent: m.fontBoundingBoxAscent || style.size * 0.88,
    descent: m.fontBoundingBoxDescent || style.size * 0.12,
  };
};

/** ランを行に分ける。空の行も、その位置の書式で高さを持たせる */
const splitLines = (runs: readonly model.TextRun[]) => {
  const lines: {
    parts: { text: string; style: model.CharStyle }[];
    style: model.CharStyle;
  }[] = [{ parts: [], style: runs[0]!.style }];
  for (const run of runs) {
    const pieces = run.text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) lines.push({ parts: [], style: run.style });
      const line = lines.at(-1)!;
      if (piece) line.parts.push({ text: piece, style: run.style });
      if (line.parts.length === 0) line.style = run.style;
    });
  }
  return lines;
};

export const layout = (layer: model.TextLayer): Layout => {
  const lines: Line[] = [];
  let top = 0;
  let width = 0;
  for (const line of splitLines(layer.runs)) {
    let x = 0;
    let ascent = 0;
    let descent = 0;
    let size = 0;
    const segments: Segment[] = [];
    const parts =
      line.parts.length > 0 ? line.parts : [{ text: "", style: line.style }];
    for (const part of parts) {
      const m = metrics(part.style, part.text);
      ascent = Math.max(ascent, m.ascent);
      descent = Math.max(descent, m.descent);
      size = Math.max(size, part.style.size);
      if (part.text) {
        segments.push({
          text: part.text,
          style: part.style,
          x,
          width: m.width,
        });
        x += m.width;
      }
    }
    const height = Math.max((size * layer.lineHeight) / 100, 1);
    lines.push({
      segments,
      width: x,
      top,
      height,
      baseline: top + (height - (ascent + descent)) / 2 + ascent,
    });
    top += height;
    width = Math.max(width, x);
  }
  return {
    lines,
    width: Math.max(1, Math.ceil(Math.max(width, maxSize(layer.runs) * 0.5))),
    height: Math.max(1, Math.ceil(top)),
  };
};

/** 行の左端の位置（揃えに合わせる） */
export const lineOffset = (
  layer: model.TextLayer,
  line: Line,
  width: number,
) =>
  layer.align === "left"
    ? 0
    : layer.align === "center"
      ? (width - line.width) / 2
      : width - line.width;

/** パスが今の文字と書式で作られたものか確かめるためのキー */
export const outlineKey = (layer: model.TextLayer) =>
  JSON.stringify([
    layer.runs.map((run) => [
      run.text,
      fonts.keyOf(run.style.font),
      run.style.size,
      run.style.color,
      run.style.bold,
    ]),
    layer.align,
    layer.lineHeight,
  ]);

/** パスの座標をすべて scale 倍にする（座標はすべて絶対座標なので、数を掛けるだけでよい） */
export const scalePath = (d: string, scale: number) =>
  d.replace(/-?[\d.]+(?:e-?\d+)?/g, (value) =>
    String(Math.round(Number(value) * scale * 100) / 100),
  );

/** 拡大・縮小したテキストに合わせて、保存されたパスも拡大・縮小する */
export const scaleOutline = (
  outline: model.TextOutline,
  scale: number,
): Omit<model.TextOutline, "key"> => ({
  width: Math.max(1, Math.round(outline.width * scale)),
  height: Math.max(1, Math.round(outline.height * scale)),
  parts: outline.parts.map((part) => ({
    ...part,
    d: scalePath(part.d, scale),
  })),
});

/** 使っているフォントがこの端末で使えず、保存されたパスで表示するとき true */
export const usesOutline = (layer: model.TextLayer) =>
  layer.outline !== null &&
  layer.outline.key === outlineKey(layer) &&
  layer.runs.some((run) => fonts.status(run.style.font) === "missing");

/** 枠の大きさ（縁取りと影は含まない） */
export const measure = (layer: model.TextLayer) => {
  if (usesOutline(layer) && layer.outline)
    return { width: layer.outline.width, height: layer.outline.height };
  const result = layout(layer);
  return { width: result.width, height: result.height };
};

// ---- 描画 ----

const shadow = (context: CanvasRenderingContext2D, size: number) => {
  context.shadowColor = "rgb(0 0 0 / 0.55)";
  context.shadowBlur = size * 0.12;
  context.shadowOffsetX = size * 0.04;
  context.shadowOffsetY = size * 0.06;
};

const noShadow = (context: CanvasRenderingContext2D) => {
  context.shadowColor = "transparent";
};

/** 縁取りと影が枠の外にはみ出す幅 */
export const overflow = (
  strokeWidth: number,
  hasShadow: boolean,
  size: number,
) => Math.ceil(strokeWidth + (hasShadow ? size * 0.25 : 0) + size * 0.1);

/** フォントで描く */
export const draw = (
  context: CanvasRenderingContext2D,
  layer: model.TextLayer,
  ox: number,
  oy: number,
) => {
  const result = layout(layer);
  const size = maxSize(layer.runs);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.lineJoin = "round";
  context.miterLimit = 2;
  const each = (paint: (segment: Segment, x: number, y: number) => void) => {
    for (const line of result.lines) {
      const start = ox + lineOffset(layer, line, result.width);
      for (const segment of line.segments) {
        context.font = fonts.fontString(
          segment.style.font,
          segment.style.size,
          segment.style.bold,
        );
        paint(segment, start + segment.x, oy + line.baseline);
      }
    }
  };
  if (layer.strokeWidth > 0) {
    // 縁取りは文字の外側だけに見えるよう、太さの 2 倍で描いた上に塗りを重ねる
    if (layer.shadow) shadow(context, size);
    context.strokeStyle = layer.strokeColor;
    context.lineWidth = layer.strokeWidth * 2;
    each((segment, x, y) => context.strokeText(segment.text, x, y));
    noShadow(context);
  } else if (layer.shadow) shadow(context, size);
  each((segment, x, y) => {
    context.fillStyle = segment.style.color;
    context.fillText(segment.text, x, y);
  });
  noShadow(context);
};

/** パス（保存されたパス・パスに変換したレイヤー）で描く */
export const drawParts = (
  context: CanvasRenderingContext2D,
  parts: readonly { d: string; color: string; bold: boolean }[],
  options: {
    strokeColor: string;
    strokeWidth: number;
    shadow: boolean;
    size: number;
    ox: number;
    oy: number;
    scaleX?: number;
    scaleY?: number;
  },
) => {
  const paths = parts.map((part) => ({ ...part, path: new Path2D(part.d) }));
  context.save();
  context.translate(options.ox, options.oy);
  context.scale(options.scaleX ?? 1, options.scaleY ?? 1);
  // 拡大・縮小しても線の太さは変えない
  const lineScale =
    1 / Math.max(0.01, Math.min(options.scaleX ?? 1, options.scaleY ?? 1));
  context.lineJoin = "round";
  context.miterLimit = 2;
  if (options.strokeWidth > 0) {
    if (options.shadow) shadow(context, options.size);
    context.strokeStyle = options.strokeColor;
    context.lineWidth = options.strokeWidth * 2 * lineScale;
    for (const part of paths) context.stroke(part.path);
    noShadow(context);
  } else if (options.shadow) shadow(context, options.size);
  for (const part of paths) {
    context.fillStyle = part.color;
    context.fill(part.path);
    // 太字が無いフォントは、塗りと同じ色の線で太らせる（ブラウザの擬似太字に近づける）
    if (part.bold) {
      context.strokeStyle = part.color;
      context.lineWidth = options.size * 0.035 * lineScale;
      context.stroke(part.path);
    }
  }
  noShadow(context);
  context.restore();
};
