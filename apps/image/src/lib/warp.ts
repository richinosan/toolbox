// 空間変形（曲げ・奥行きの傾き・4 隅の移動）。レイヤーを描いた絵を、細かい網目に分けて変形した先に貼り直す。
// WebGL が使えるときは GPU で貼り（継ぎ目が出ない）、使えないときは canvas 2D で三角形ごとに貼る。
import * as model from "./model";

type Point = { x: number; y: number };

/** 枠の大きさに対する、奥行きの傾きを掛けた 4 隅（左上・右上・右下・左下。0〜1 の割合） */
const tiltCorners = (warp: model.Warp, width: number, height: number) => {
  const ax = (warp.tiltX * Math.PI) / 180;
  const ay = (warp.tiltY * Math.PI) / 180;
  // 見る位置までの距離。大きいほど遠近の付き方がゆるやかになる
  const distance = Math.max(width, height) * 1.2;
  return (
    [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ] as const
  ).map(([u, v]) => {
    const x = u * width;
    const y = v * height;
    // 横の軸で回してから、縦の軸で回す
    const y1 = y * Math.cos(ax);
    const z1 = -y * Math.sin(ax);
    const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
    const z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
    const scale = distance / (distance - z2);
    return { x: (x2 * scale) / width + 0.5, y: (y1 * scale) / height + 0.5 };
  });
};

/**
 * 遠近の枠の 4 隅（レイヤーの左上を原点にした px）。曲げは、この枠の中で掛かる。
 * 4 隅を動かすハンドルはここに置く（曲げた形の角は曲げ方によって枠の外や内に来るので、ハンドルにはしない）
 */
export const corners = (layer: model.Layer): Point[] =>
  tiltCorners(layer.warp, layer.width, layer.height).map((point, i) => ({
    x: (point.x + layer.warp.corners[i]![0]) * layer.width,
    y: (point.y + layer.warp.corners[i]![1]) * layer.height,
  }));

/** 隅の移動量は枠の 2 倍まで（保存する桁も揃える） */
const clampOffset = (value: number) =>
  Math.round(model.clamp(value, -2, 2) * 10_000) / 10_000;

/** 4 隅の位置（レイヤーの左上を原点にした px）から、その隅の移動量を逆算する */
export const cornerOffset = (
  layer: model.Layer,
  corner: model.Corner,
  at: Point,
) => {
  const base = tiltCorners(layer.warp, layer.width, layer.height)[corner]!;
  return [
    clampOffset(at.x / layer.width - base.x),
    clampOffset(at.y / layer.height - base.y),
  ] as [number, number];
};

/** 単位正方形を 4 隅へ移す射影変換（3×3 行列の 8 個の係数） */
const homography = (quad: Point[]) => {
  const [p0, p1, p2, p3] = quad as [Point, Point, Point, Point];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = det === 0 ? 0 : (sx * dy2 - dx2 * sy) / det;
  const h = det === 0 ? 0 : (dx1 * sy - sx * dy1) / det;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
};

/** 4 隅が凸（ねじれていない）か。ねじれていると射影変換が裏返るので、線形の補間にする */
const isConvex = (quad: Point[]) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
};

/** 曲げ（枠の中の位置 u, v を 0〜1 の割合で受け取り、曲げた先の割合を返す） */
const bend = (style: model.WarpStyle, amount: number, aspect: number) => {
  const b = amount / 100;
  const sin = Math.sin;
  const pi = Math.PI;
  switch (style) {
    case "arc": {
      // 同心円の扇形に沿わせる（真ん中の縦の線はそのまま）
      const angle = b * pi;
      if (Math.abs(angle) < 1e-4) return null;
      // 幅を 1 としたときの、下の辺（上向きのとき）の半径
      const radius = 1 / Math.abs(angle);
      const height = 1 / aspect;
      return (u: number, v: number): Point => {
        const phi = (u - 0.5) * Math.abs(angle);
        const y = v * height;
        if (b > 0) {
          const r = radius + height - y;
          return {
            x: 0.5 + r * sin(phi),
            y: (height + radius - r * Math.cos(phi)) * aspect,
          };
        }
        const r = radius + y;
        return {
          x: 0.5 + r * sin(phi),
          y: (r * Math.cos(phi) - radius) * aspect,
        };
      };
    }
    case "arch":
      // 下の辺はそのままで、上ほど大きく曲げる
      return (u: number, v: number): Point => ({
        x: u,
        y: v - b * 0.5 * sin(pi * u) * (1 - v),
      });
    case "bulge":
      // 真ん中を太らせる（負の値で細める）
      return (u: number, v: number): Point => ({
        x: u,
        y: (v - 0.5) * (1 + b * 0.6 * sin(pi * u)) + 0.5,
      });
    case "flag":
      return (u: number, v: number): Point => ({
        x: u,
        y: v - b * 0.3 * sin(2 * pi * u),
      });
    case "wave":
      // 上と下で波をずらす
      return (u: number, v: number): Point => ({
        x: u,
        y: v - b * 0.25 * sin(2 * pi * (u + (v - 0.5) * 0.5)),
      });
    case "rise":
      // 右に向かって持ち上がる（真ん中で一番急）
      return (u: number, v: number): Point => ({
        x: u,
        y: v - b * 0.5 * sin(pi * (u - 0.5)),
      });
    default:
      return null;
  }
};

/** レイヤーの枠の中の位置（レイヤーの左上を原点にした px）を、変形した先へ移す関数 */
export const mapper = (layer: model.Layer) => {
  const { width, height, warp } = layer;
  const curve = bend(warp.style, warp.bend, width / height);
  const quad = corners(layer).map((p) => ({ x: p.x / width, y: p.y / height }));
  const [q0, q1, q2, q3] = quad as [Point, Point, Point, Point];
  const bilinear = (u: number, v: number): Point => ({
    x: (1 - v) * ((1 - u) * q0.x + u * q1.x) + v * ((1 - u) * q3.x + u * q2.x),
    y: (1 - v) * ((1 - u) * q0.y + u * q1.y) + v * ((1 - u) * q3.y + u * q2.y),
  });
  const m = isConvex(quad) ? homography(quad) : null;
  // 曲げた先（縁取りの分の外側も含めて）が奥の消える線を越えると裏返るので、そのときは線形の補間にする
  let safe = m !== null;
  if (m)
    for (let j = -2; j <= 6 && safe; j++)
      for (let i = -2; i <= 6 && safe; i++) {
        let u = i / 4;
        let v = j / 4;
        if (curve) ({ x: u, y: v } = curve(u, v));
        if (m.g * u + m.h * v + 1 < 0.15) safe = false;
      }
  const project =
    m && safe
      ? (u: number, v: number): Point => {
          const w = Math.max(m.g * u + m.h * v + 1, 1e-3);
          return {
            x: (m.a * u + m.b * v + m.c) / w,
            y: (m.d * u + m.e * v + m.f) / w,
          };
        }
      : bilinear;
  return (x: number, y: number): Point => {
    let u = x / width;
    let v = y / height;
    if (curve) ({ x: u, y: v } = curve(u, v));
    const p = project(u, v);
    return { x: p.x * width, y: p.y * height };
  };
};

/** 変形した枠の輪郭（ドキュメントの px。当たり判定と選択枠に使う） */
export const outline = (layer: model.Layer, steps = 24): Point[] => {
  const map = mapper(layer);
  const { width: w, height: h } = layer;
  const points: Point[] = [];
  const edges: [number, number, number, number][] = [
    [0, 0, w, 0],
    [w, 0, w, h],
    [w, h, 0, h],
    [0, h, 0, 0],
  ];
  for (const [x0, y0, x1, y1] of edges)
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const p = map(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      points.push({ x: layer.x + p.x, y: layer.y + p.y });
    }
  return points;
};

/**
 * ドキュメントの点 (x, y) が、変形したレイヤーの枠の中に入るか（当たり判定）。
 * 4 隅を内側に寄せると形が折り返して輪郭の外にも描かれるので、輪郭ではなく網目の三角形で調べる
 */
export const hits = (layer: model.Layer, x: number, y: number, steps = 16) => {
  const map = mapper(layer);
  const grid: Point[] = [];
  for (let j = 0; j <= steps; j++)
    for (let i = 0; i <= steps; i++) {
      const p = map((i / steps) * layer.width, (j / steps) * layer.height);
      grid.push({ x: layer.x + p.x, y: layer.y + p.y });
    }
  const at = (i: number, j: number) => grid[j * (steps + 1) + i]!;
  for (let j = 0; j < steps; j++)
    for (let i = 0; i < steps; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (contains([a, b, c], x, y) || contains([a, c, d], x, y)) return true;
    }
  return false;
};

/** 点が多角形の内側にあるか */
export const contains = (polygon: Point[], x: number, y: number) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
};

export type Warped = {
  canvas: HTMLCanvasElement;
  /** canvas の左上が、レイヤーの左上から左・上にどれだけ外側にあるか */
  left: number;
  top: number;
};

type Mesh = {
  columns: number;
  rows: number;
  /** 変形した先の位置（出力の canvas の px） */
  points: Float32Array;
  width: number;
  height: number;
  left: number;
  top: number;
};

/**
 * 網目を作る。source の左上はレイヤーの左上から (pad, pad) 外側にある。
 * 細かさは絵の大きさに合わせる（曲げがあると細かくする）
 */
const buildMesh = (
  layer: model.Layer,
  sourceWidth: number,
  sourceHeight: number,
  pad: number,
  /** 後で周りに足す余白（ぼかしの広がり）。その分も含めて上限に収める */
  reserve: number,
): Mesh => {
  const map = mapper(layer);
  const cell = layer.warp.style !== "none" && layer.warp.bend !== 0 ? 12 : 24;
  const columns = model.clamp(Math.ceil(sourceWidth / cell), 4, 64);
  const rows = model.clamp(Math.ceil(sourceHeight / cell), 4, 64);
  const raw = new Float32Array((columns + 1) * (rows + 1) * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const p = map(
        (i / columns) * sourceWidth - pad,
        (j / rows) * sourceHeight - pad,
      );
      const k = (j * (columns + 1) + i) * 2;
      raw[k] = p.x;
      raw[k + 1] = p.y;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  // 出力の canvas が上限を超えるときだけ、変形した範囲の中心のまわりに収める
  const half = model.MAX_SIDE / 2 - 2 - reserve;
  const fit = (min: number, max: number) => {
    if (max - min <= half * 2) return [min, max] as const;
    const center = (min + max) / 2;
    return [center - half, center + half] as const;
  };
  [minX, maxX] = fit(minX, maxX);
  [minY, maxY] = fit(minY, maxY);
  minX = Math.floor(minX) - 1;
  minY = Math.floor(minY) - 1;
  maxX = Math.ceil(maxX) + 1;
  maxY = Math.ceil(maxY) + 1;
  let width = Math.max(1, maxX - minX);
  let height = Math.max(1, maxY - minY);
  const padded = (w: number, h: number) =>
    (w + reserve * 2) * (h + reserve * 2);
  if (padded(width, height) > model.MAX_AREA) {
    // 余白を足しても面積の上限に収まるまで、真ん中に寄せて縮める
    let area = Math.sqrt(model.MAX_AREA / padded(width, height));
    while (
      padded(Math.floor(width * area), Math.floor(height * area)) >
      model.MAX_AREA
    )
      area *= 0.99;
    const shrinkX = (width - width * area) / 2;
    const shrinkY = (height - height * area) / 2;
    minX = Math.round(minX + shrinkX);
    minY = Math.round(minY + shrinkY);
    width = Math.max(1, Math.floor(width * area));
    height = Math.max(1, Math.floor(height * area));
  }
  for (let k = 0; k < raw.length; k += 2) {
    raw[k] = raw[k]! - minX;
    raw[k + 1] = raw[k + 1]! - minY;
  }
  return {
    columns,
    rows,
    points: raw,
    width,
    height,
    left: -minX,
    top: -minY,
  };
};

// ---- WebGL ----

type Gl = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  webgl2: boolean;
  program: WebGLProgram;
  position: number;
  coord: number;
  buffers: { position: WebGLBuffer; coord: WebGLBuffer; index: WebGLBuffer };
  texture: WebGLTexture;
};

let shared: Gl | null | undefined;

const VERTEX = `
attribute vec2 a_position;
attribute vec2 a_coord;
uniform vec2 u_size;
varying vec2 v_coord;
void main() {
  vec2 clip = a_position / u_size * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_coord = a_coord;
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_image;
varying vec2 v_coord;
void main() {
  gl_FragColor = texture2D(u_image, v_coord);
}`;

const setupGl = (): Gl | null => {
  const canvas = document.createElement("canvas");
  const options: WebGLContextAttributes = {
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    antialias: true,
  };
  const gl2 = canvas.getContext("webgl2", options);
  const gl = gl2 ?? canvas.getContext("webgl", options);
  if (!gl) return null;
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const texture = gl.createTexture();
  return {
    canvas,
    gl,
    webgl2: gl2 !== null,
    program,
    position: gl.getAttribLocation(program, "a_position"),
    coord: gl.getAttribLocation(program, "a_coord"),
    buffers: {
      position: gl.createBuffer(),
      coord: gl.createBuffer(),
      index: gl.createBuffer(),
    },
    texture,
  };
};

const getGl = () => {
  if (shared === undefined || (shared && shared.gl.isContextLost()))
    shared = setupGl();
  return shared;
};

const indices = (columns: number, rows: number) => {
  const out = new Uint16Array(columns * rows * 6);
  let k = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i;
      const b = a + 1;
      const c = a + columns + 1;
      const d = c + 1;
      out.set([a, b, d, a, d, c], k);
      k += 6;
    }
  return out;
};

const coords = (columns: number, rows: number) => {
  const out = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const k = (j * (columns + 1) + i) * 2;
      out[k] = i / columns;
      out[k + 1] = j / rows;
    }
  return out;
};

const drawGl = (source: HTMLCanvasElement, mesh: Mesh) => {
  const context = getGl();
  if (!context) return null;
  const { gl, canvas } = context;
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  if (
    source.width > maxTexture ||
    source.height > maxTexture ||
    mesh.width > maxView[0]! ||
    mesh.height > maxView[1]!
  )
    return null;
  canvas.width = mesh.width;
  canvas.height = mesh.height;
  gl.viewport(0, 0, mesh.width, mesh.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.disable(gl.BLEND);
  gl.useProgram(context.program);

  gl.bindTexture(gl.TEXTURE_2D, context.texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // 奥に遠ざかって小さくなる部分がちらつかないよう、WebGL2 では縮小用の画像（ミップマップ）も作る
  if (context.webgl2) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
  } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

  gl.uniform2f(
    gl.getUniformLocation(context.program, "u_size"),
    mesh.width,
    mesh.height,
  );
  gl.uniform1i(gl.getUniformLocation(context.program, "u_image"), 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, context.buffers.position);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.points, gl.STREAM_DRAW);
  gl.enableVertexAttribArray(context.position);
  gl.vertexAttribPointer(context.position, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, context.buffers.coord);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    coords(mesh.columns, mesh.rows),
    gl.STREAM_DRAW,
  );
  gl.enableVertexAttribArray(context.coord);
  gl.vertexAttribPointer(context.coord, 2, gl.FLOAT, false, 0, 0);
  const index = indices(mesh.columns, mesh.rows);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, context.buffers.index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STREAM_DRAW);
  gl.drawElements(gl.TRIANGLES, index.length, gl.UNSIGNED_SHORT, 0);

  const out = document.createElement("canvas");
  out.width = mesh.width;
  out.height = mesh.height;
  out.getContext("2d")!.drawImage(canvas, 0, 0);
  return out;
};

// ---- canvas 2D（WebGL が使えないとき） ----

/**
 * 三角形を 1 枚ずつ、画素ごとに元の絵から拾って書き込む。
 * 重ねて描くのではなく書き込む（上書きする）ので、三角形の境目で半透明の部分が濃くならず、継ぎ目も出ない
 */
const draw2d = (source: HTMLCanvasElement, mesh: Mesh) => {
  const out = document.createElement("canvas");
  out.width = mesh.width;
  out.height = mesh.height;
  const context = out.getContext("2d")!;
  const sw = source.width;
  const sh = source.height;
  const src = source
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, sw, sh).data;
  const image = context.createImageData(mesh.width, mesh.height);
  const dst = image.data;
  const { columns, rows, points } = mesh;
  const cw = sw / columns;
  const ch = sh / rows;
  /** 透明度を掛けた色で、まわり 4 画素から補間する */
  const sample = (x: number, y: number, at: number) => {
    const fx = model.clamp(x - 0.5, 0, sw - 1);
    const fy = model.clamp(y - 0.5, 0, sh - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const [px, py, weight] of [
      [x0, y0, (1 - tx) * (1 - ty)],
      [x1, y0, tx * (1 - ty)],
      [x0, y1, (1 - tx) * ty],
      [x1, y1, tx * ty],
    ] as const) {
      const k = (py * sw + px) * 4;
      const alpha = (src[k + 3]! / 255) * weight;
      r += src[k]! * alpha;
      g += src[k + 1]! * alpha;
      b += src[k + 2]! * alpha;
      a += alpha;
    }
    if (a <= 0) return;
    dst[at] = r / a;
    dst[at + 1] = g / a;
    dst[at + 2] = b / a;
    dst[at + 3] = a * 255;
  };
  const triangle = (s: [Point, Point, Point], d: [Point, Point, Point]) => {
    const [d0, d1, d2] = d;
    const det = (d1.y - d2.y) * (d0.x - d2.x) + (d2.x - d1.x) * (d0.y - d2.y);
    if (Math.abs(det) < 1e-9) return;
    const left = Math.max(0, Math.floor(Math.min(d0.x, d1.x, d2.x)));
    const right = Math.min(
      mesh.width - 1,
      Math.ceil(Math.max(d0.x, d1.x, d2.x)),
    );
    const top = Math.max(0, Math.floor(Math.min(d0.y, d1.y, d2.y)));
    const bottom = Math.min(
      mesh.height - 1,
      Math.ceil(Math.max(d0.y, d1.y, d2.y)),
    );
    const epsilon = -1e-6;
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        // 画素の中心が三角形の中にあるか（重心座標）
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 =
          ((d1.y - d2.y) * (px - d2.x) + (d2.x - d1.x) * (py - d2.y)) / det;
        const w1 =
          ((d2.y - d0.y) * (px - d2.x) + (d0.x - d2.x) * (py - d2.y)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < epsilon || w1 < epsilon || w2 < epsilon) continue;
        sample(
          w0 * s[0].x + w1 * s[1].x + w2 * s[2].x,
          w0 * s[0].y + w1 * s[1].y + w2 * s[2].y,
          (y * mesh.width + x) * 4,
        );
      }
  };
  const at = (i: number, j: number) => {
    const k = (j * (columns + 1) + i) * 2;
    return { x: points[k]!, y: points[k + 1]! };
  };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const s00 = { x: i * cw, y: j * ch };
      const s10 = { x: (i + 1) * cw, y: j * ch };
      const s01 = { x: i * cw, y: (j + 1) * ch };
      const s11 = { x: (i + 1) * cw, y: (j + 1) * ch };
      triangle([s00, s10, s11], [at(i, j), at(i + 1, j), at(i + 1, j + 1)]);
      triangle([s00, s11, s01], [at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
    }
  context.putImageData(image, 0, 0);
  return out;
};

/**
 * レイヤーを描いた絵（左上がレイヤーの左上から pad 外側）を変形する
 */
export const apply = (
  layer: model.Layer,
  source: HTMLCanvasElement,
  pad: number,
  /** 後で周りに足す余白（ぼかしの広がり） */
  reserve = 0,
): Warped => {
  const mesh = buildMesh(layer, source.width, source.height, pad, reserve);
  const canvas = drawGl(source, mesh) ?? draw2d(source, mesh);
  return { canvas, left: mesh.left, top: mesh.top };
};
