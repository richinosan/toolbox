// レイヤーに掛けるフィルター（色の調整とガウスぼかし）。
// ブラウザごとの canvas の filter の対応差を避けるため、ピクセルを直接計算する。
import type * as model from "./model";

/** RGB の 3×4 アフィン行列（値は 0〜1 で考える）。[r行(4), g行(4), b行(4)] */
type Matrix = readonly number[];

const identity: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a のあとに b を適用する行列 */
const then = (a: Matrix, b: Matrix): Matrix => {
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      let value = col === 3 ? (b[row * 4 + 3] ?? 0) : 0;
      for (let k = 0; k < 3; k++)
        value += (b[row * 4 + k] ?? 0) * (a[k * 4 + col] ?? 0);
      out.push(value);
    }
  }
  return out;
};

const scale = (r: number, g: number, b: number, offset = 0): Matrix => [
  r,
  0,
  0,
  offset,
  0,
  g,
  0,
  offset,
  0,
  0,
  b,
  offset,
];

// 以下の係数は CSS の Filter Effects（grayscale / sepia / saturate / hue-rotate）と同じ
const LUMA = [0.2126, 0.7152, 0.0722] as const;

const grayscale: Matrix = [...LUMA, 0, ...LUMA, 0, ...LUMA, 0];

const sepia: Matrix = [
  0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0,
];

const saturate = (s: number): Matrix => [
  0.213 + 0.787 * s,
  0.715 - 0.715 * s,
  0.072 - 0.072 * s,
  0,
  0.213 - 0.213 * s,
  0.715 + 0.285 * s,
  0.072 - 0.072 * s,
  0,
  0.213 - 0.213 * s,
  0.715 - 0.715 * s,
  0.072 + 0.928 * s,
  0,
];

const hueRotate = (degrees: number): Matrix => {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    0.213 + cos * 0.787 - sin * 0.213,
    0.715 - cos * 0.715 - sin * 0.715,
    0.072 - cos * 0.072 + sin * 0.928,
    0,
    0.213 - cos * 0.213 + sin * 0.143,
    0.715 + cos * 0.285 + sin * 0.14,
    0.072 - cos * 0.072 - sin * 0.283,
    0,
    0.213 - cos * 0.213 - sin * 0.787,
    0.715 - cos * 0.715 + sin * 0.715,
    0.072 + cos * 0.928 + sin * 0.072,
    0,
  ];
};

const contrast = (c: number) => scale(c, c, c, 0.5 - 0.5 * c);

const hexToRgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ] as const;
};

/** 明るさを保ったまま、指定した色味に寄せる（amount は 0〜1） */
const tint = (hex: string, amount: number): Matrix => {
  const [r, g, b] = hexToRgb(hex);
  const luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  // 色の明るさで割って、元の明るさが変わらないようにする（黒に近い色は割らずにそのまま暗くする）
  const k = luma > 0.05 ? Math.min(4, 1 / luma) : 1;
  const color = [r * k, g * k, b * k];
  const out: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const keep = row === col ? 1 - amount : 0;
      const add = col < 3 ? amount * (color[row] ?? 0) * (LUMA[col] ?? 0) : 0;
      out.push(keep + add);
    }
  }
  return out;
};

const presetMatrix = (preset: model.FilterPreset): Matrix => {
  switch (preset) {
    case "mono":
      return grayscale;
    case "sepia":
      return sepia;
    case "invert":
      return scale(-1, -1, -1, 1);
    case "vivid":
      return then(saturate(1.5), contrast(1.1));
    case "warm":
      return then(scale(1.1, 1.02, 0.86), saturate(1.1));
    case "cool":
      return then(scale(0.88, 1, 1.12), saturate(0.95));
    case "fade":
      return then(then(saturate(0.7), contrast(0.8)), scale(1.05, 1.05, 1.05));
    case "none":
      return identity;
  }
};

export const colorMatrix = (filters: model.Filters): Matrix => {
  let m = presetMatrix(filters.preset);
  if (filters.brightness !== 0) {
    const b = 1 + filters.brightness / 100;
    m = then(m, scale(b, b, b));
  }
  if (filters.contrast !== 0) m = then(m, contrast(1 + filters.contrast / 100));
  if (filters.saturation !== 0)
    m = then(m, saturate(1 + filters.saturation / 100));
  if (filters.hue !== 0) m = then(m, hueRotate(filters.hue));
  if (filters.tintAmount !== 0)
    m = then(m, tint(filters.tint, filters.tintAmount / 100));
  return m;
};

const isIdentity = (m: Matrix) => m.every((value, i) => value === identity[i]);

/** ImageData（ストレートアルファ）に色の行列を掛ける */
export const applyColor = (data: Uint8ClampedArray, m: Matrix) => {
  if (isIdentity(m)) return;
  const [r0, r1, r2, r3, g0, g1, g2, g3, b0, b1, b2, b3] = m.map((value, i) =>
    i % 4 === 3 ? value * 255 : value,
  ) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    data[i] = r0 * r + r1 * g + r2 * b + r3;
    data[i + 1] = g0 * r + g1 * g + g2 * b + g3;
    data[i + 2] = b0 * r + b1 * g + b2 * b + b3;
  }
};

/** ガウスぼかしを 3 回の箱ぼかしで近似するときの、各回の半径 */
const boxRadii = (sigma: number) => {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - n * lower * lower - 4 * n * lower - 3 * n) /
      (-4 * lower - 4),
  );
  return Array.from({ length: n }, (_, i) =>
    Math.max(0, ((i < m ? lower : upper) - 1) / 2),
  );
};

/** 1 方向の箱ぼかし。端は端のピクセルを延長して扱う */
const boxPass = (
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  length: number,
  lines: number,
  step: number,
  lineStep: number,
  radius: number,
) => {
  const size = radius * 2 + 1;
  const last = length - 1;
  for (let line = 0; line < lines; line++) {
    const start = line * lineStep;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = -radius; i <= radius; i++) {
      const p = start + Math.min(last, Math.max(0, i)) * step;
      r += src[p]!;
      g += src[p + 1]!;
      b += src[p + 2]!;
      a += src[p + 3]!;
    }
    for (let i = 0; i < length; i++) {
      const p = start + i * step;
      dst[p] = r / size;
      dst[p + 1] = g / size;
      dst[p + 2] = b / size;
      dst[p + 3] = a / size;
      const add = start + Math.min(last, i + radius + 1) * step;
      const remove = start + Math.max(0, i - radius) * step;
      r += src[add]! - src[remove]!;
      g += src[add + 1]! - src[remove + 1]!;
      b += src[add + 2]! - src[remove + 2]!;
      a += src[add + 3]! - src[remove + 3]!;
    }
  }
};

/** ガウスぼかし（sigma は px）。透明な部分の色が混ざって黒ずまないよう、乗算済みアルファで計算する */
export const applyBlur = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
) => {
  if (sigma <= 0 || width === 0 || height === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    data[i] = data[i]! * a;
    data[i + 1] = data[i + 1]! * a;
    data[i + 2] = data[i + 2]! * a;
  }
  const temp = new Uint8ClampedArray(data.length);
  for (const radius of boxRadii(sigma)) {
    if (radius === 0) continue;
    boxPass(data, temp, width, height, 4, width * 4, radius);
    boxPass(temp, data, height, width, width * 4, 4, radius);
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    const k = 255 / a;
    data[i] = data[i]! * k;
    data[i + 1] = data[i + 1]! * k;
    data[i + 2] = data[i + 2]! * k;
  }
};

/** ぼかしで外側に広がる幅（px） */
export const blurPadding = (sigma: number) =>
  sigma > 0 ? Math.ceil(sigma * 3) : 0;
