// テキストを文字の形（パス）にする。保存のときと「パスに変換」のときだけ使う。
// フォントのファイルを fontkit で読み、グリフの輪郭を SVG のパスにする。
import type * as fontkitTypes from "fontkit";
import * as fonts from "./fonts";
import type * as model from "./model";
import * as text from "./text";

type FontkitModule = typeof fontkitTypes;

let fontkitModule: Promise<FontkitModule> | null = null;
// fontkit は大きいので、パスを作るときだけ読み込む
const loadFontkit = () => (fontkitModule ??= import("fontkit"));

const parsed = new Map<string, fontkitTypes.Font | null>();

const parse = (
  fontkit: FontkitModule,
  binary: fonts.FontBinary & { key: string },
) => {
  if (parsed.has(binary.key)) return parsed.get(binary.key) ?? null;
  let font: fontkitTypes.Font | null = null;
  try {
    const result = fontkit.create(
      new Uint8Array(binary.data) as never,
      binary.postscriptName,
    );
    font = "fonts" in result ? (result.fonts[0] ?? null) : result;
  } catch {
    font = null;
  }
  parsed.set(binary.key, font);
  return font;
};

const round = (value: number) => Math.round(value * 100) / 100;

/** グリフの輪郭（フォントの単位・上が正）を、レイヤーの座標の SVG パスにする */
const toPath = (
  glyph: fontkitTypes.Glyph,
  x: number,
  baseline: number,
  scale: number,
) => {
  const px = (value: number) => round(x + value * scale);
  const py = (value: number) => round(baseline - value * scale);
  let d = "";
  for (const { command, args } of glyph.path.commands) {
    const a = args as number[];
    switch (command) {
      case "moveTo":
        d += `M${px(a[0]!)} ${py(a[1]!)}`;
        break;
      case "lineTo":
        d += `L${px(a[0]!)} ${py(a[1]!)}`;
        break;
      case "quadraticCurveTo":
        d += `Q${px(a[0]!)} ${py(a[1]!)} ${px(a[2]!)} ${py(a[3]!)}`;
        break;
      case "bezierCurveTo":
        d += `C${px(a[0]!)} ${py(a[1]!)} ${px(a[2]!)} ${py(a[3]!)} ${px(a[4]!)} ${py(a[5]!)}`;
        break;
      case "closePath":
        d += "Z";
        break;
    }
  }
  return d;
};

/** 同じフォントのファイルで描ける文字のまとまりに分ける（文字の範囲ごとにファイルが分かれているため） */
const groupByBinary = async (segment: text.Segment) => {
  const groups: { binary: fonts.FontBinary & { key: string }; text: string }[] =
    [];
  for (const char of segment.text) {
    const binary = await fonts.binaryFor(
      segment.style.font,
      segment.style.bold,
      char.codePointAt(0)!,
    );
    if (!binary) return null;
    const last = groups.at(-1);
    if (last && last.binary.key === binary.key) last.text += char;
    else groups.push({ binary, text: char });
  }
  return groups;
};

/** テキストレイヤーのパス。フォントのデータが手に入らない文字があれば null */
export const build = async (
  layer: model.TextLayer,
): Promise<model.TextOutline | null> => {
  const fontkit = await loadFontkit();
  const result = text.layout(layer);
  const parts: model.TextOutline["parts"] = [];
  for (const line of result.lines) {
    const start = text.lineOffset(layer, line, result.width);
    for (const segment of line.segments) {
      const groups = await groupByBinary(segment);
      if (!groups) return null;
      let x = start + segment.x;
      let d = "";
      let synthetic = false;
      for (const group of groups) {
        const font = parse(fontkit, group.binary);
        if (!font) return null;
        synthetic ||= group.binary.synthetic;
        const scale = segment.style.size / font.unitsPerEm;
        const run = font.layout(group.text);
        run.glyphs.forEach((glyph, i) => {
          const position = run.positions[i]!;
          d += toPath(
            glyph,
            x + position.xOffset * scale,
            line.baseline - position.yOffset * scale,
            scale,
          );
          x += position.xAdvance * scale;
        });
      }
      if (d) parts.push({ d, color: segment.style.color, bold: synthetic });
    }
  }
  return {
    key: text.outlineKey(layer),
    width: result.width,
    height: result.height,
    parts,
  };
};
