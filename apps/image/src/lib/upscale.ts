// 拡大保存：書き出す画像の画素（RGBA）を、選んだ方法で拡大する。
// ブラウザの Canvas の補間はブラウザごとに結果が違うので使わず、ここで計算する（どの端末でも同じ結果になる）。

export type Method = "nearest" | "bilinear" | "bicubic";

export const methods: readonly (readonly [Method, string, string])[] = [
  ["nearest", "ニアレストネイバー", "ドットをくっきり保つ（ドット絵向け）"],
  ["bilinear", "バイリニア", "なめらかにつなぐ"],
  ["bicubic", "バイキュービック", "なめらかで輪郭もはっきり（写真向け）"],
];

/** 倍率として使える数か（0 より大きい数。上限は設けない） */
export const isFactor = (value: number) => Number.isFinite(value) && value > 0;

export const isMethod = (value: unknown): value is Method =>
  methods.some(([method]) => method === value);

/** 拡大後の大きさ（px）。整数倍なら、ちょうど倍率どおりになる */
export const size = (width: number, height: number, factor: number) => ({
  width: Math.max(1, Math.round(width * factor)),
  height: Math.max(1, Math.round(height * factor)),
});

/**
 * ニアレストネイバー：拡大後の各画素に、中心が一番近い元の画素をそのまま写す。
 * 色を混ぜないので、元に無い色は出ない。整数倍なら、元の 1 画素が倍率 × 倍率の正方形になる
 */
const nearest = (
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
) => {
  // RGBA の 4 バイトを 1 つの数として写す
  const from = new Uint32Array(
    source.buffer,
    source.byteOffset,
    sourceWidth * sourceHeight,
  );
  const result = new Uint8ClampedArray(width * height * 4);
  const to = new Uint32Array(result.buffer);
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x++)
    columns[x] = Math.min(
      sourceWidth - 1,
      Math.floor(((x + 0.5) * sourceWidth) / width),
    );
  let previous = -1;
  for (let y = 0; y < height; y++) {
    const row = Math.min(
      sourceHeight - 1,
      Math.floor(((y + 0.5) * sourceHeight) / height),
    );
    const start = y * width;
    // 同じ元の行を写す行は、1 つ上の行をそのままコピーする
    if (row === previous) to.copyWithin(start, start - width, start);
    else {
      const offset = row * sourceWidth;
      for (let x = 0; x < width; x++)
        to[start + x] = from[offset + columns[x]!]!;
      previous = row;
    }
  }
  return result;
};

/** 拡大後の各位置が、元のどの画素をどの重みで混ぜるか */
type Taps = { count: number; index: Int32Array; weight: Float32Array };

/** Catmull-Rom（a = -0.5）の重み */
const cubic = (distance: number) => {
  const d = Math.abs(distance);
  if (d <= 1) return (1.5 * d - 2.5) * d * d + 1;
  if (d < 2) return ((-0.5 * d + 2.5) * d - 4) * d + 2;
  return 0;
};

const taps = (from: number, to: number, method: Method): Taps => {
  const count = method === "bicubic" ? 4 : 2;
  const index = new Int32Array(to * count);
  const weight = new Float32Array(to * count);
  for (let i = 0; i < to; i++) {
    // 画素の中心どうしを合わせる
    const center = ((i + 0.5) * from) / to - 0.5;
    const base = Math.floor(center);
    const t = center - base;
    for (let k = 0; k < count; k++) {
      const position = count === 4 ? base - 1 + k : base + k;
      // 端の外は、端の画素を繰り返す
      index[i * count + k] = Math.min(from - 1, Math.max(0, position));
      weight[i * count + k] =
        count === 4 ? cubic(center - position) : k === 0 ? 1 - t : t;
    }
  }
  return { count, index, weight };
};

/**
 * バイリニア・バイキュービック：横、縦の順に周りの画素を重み付きで混ぜる。
 * 透明な画素の色がにじまないよう、色に不透明度を掛けてから混ぜる
 */
const smooth = (
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  method: Method,
) => {
  const horizontal = taps(sourceWidth, width, method);
  const vertical = taps(sourceHeight, height, method);
  const { count } = horizontal;
  // 横に拡大した元の行。縦に混ぜるのに要る数行だけ持つ
  const rows = new Map<number, Float32Array>();
  const rowAt = (y: number) => {
    const cached = rows.get(y);
    if (cached) return cached;
    const row = new Float32Array(width * 4);
    const offset = y * sourceWidth * 4;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < count; k++) {
        const p = offset + horizontal.index[x * count + k]! * 4;
        const w = horizontal.weight[x * count + k]!;
        const alpha = (source[p + 3]! / 255) * w;
        r += source[p]! * alpha;
        g += source[p + 1]! * alpha;
        b += source[p + 2]! * alpha;
        a += alpha;
      }
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = a;
    }
    rows.set(y, row);
    return row;
  };
  const result = new Uint8ClampedArray(width * height * 4);
  const used: Float32Array[] = [];
  for (let y = 0; y < height; y++) {
    const first = vertical.index[y * count]!;
    for (const key of rows.keys()) if (key < first) rows.delete(key);
    for (let k = 0; k < count; k++)
      used[k] = rowAt(vertical.index[y * count + k]!);
    for (let x = 0; x < width * 4; x += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < count; k++) {
        const row = used[k]!;
        const w = vertical.weight[y * count + k]!;
        r += row[x]! * w;
        g += row[x + 1]! * w;
        b += row[x + 2]! * w;
        a += row[x + 3]! * w;
      }
      if (a <= 0) continue;
      const p = y * width * 4 + x;
      // バイキュービックは元の範囲を少しはみ出すことがある。Uint8ClampedArray が 0〜255 に収める
      result[p] = r / a;
      result[p + 1] = g / a;
      result[p + 2] = b / a;
      result[p + 3] = a * 255;
    }
  }
  return result;
};

/** RGBA の画素（1 画素 4 バイト、色に不透明度を掛けていないもの）を width × height に拡大する */
export const pixels = (
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  method: Method,
): Uint8ClampedArray => {
  if (source.length !== sourceWidth * sourceHeight * 4)
    throw new Error("画素の数が大きさと合いません。");
  if (width === sourceWidth && height === sourceHeight)
    return new Uint8ClampedArray(source);
  return method === "nearest"
    ? nearest(source, sourceWidth, sourceHeight, width, height)
    : smooth(source, sourceWidth, sourceHeight, width, height, method);
};
