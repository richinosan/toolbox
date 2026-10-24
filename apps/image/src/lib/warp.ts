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

/** 変形した先の 4 隅（レイヤーの左上を原点にした px） */
const corners = (layer: model.Layer): Point[] =>
  tiltCorners(layer.warp, layer.width, layer.height).map((point, i) => ({
    x: (point.x + layer.warp.corners[i]![0]) * layer.width,
    y: (point.y + layer.warp.corners[i]![1]) * layer.height,
  }));

/** 隅の移動量は枠の 2 倍まで（保存する桁も揃える） */
const clampOffset = (value: number) =>
  Math.round(model.clamp(value, -2, 2) * 10_000) / 10_000;

/** 枠の 4 隅が、変形した先で来る位置（レイヤーの左上を原点にした px。ハンドルを置く位置） */
export const handles = (layer: model.Layer): Point[] => {
  const map = mapper(layer);
  return [
    map(0, 0),
    map(layer.width, 0),
    map(layer.width, layer.height),
    map(0, layer.height),
  ];
};

/**
 * 枠の隅が at（レイヤーの左上を原点にした px）に来るような、その隅の移動量。
 * 曲げを掛けていると隅の位置は移動量にぴったり比例しないので、少しずつ近づける
 */
export const cornerOffset = (
  layer: model.Layer,
  corner: model.Corner,
  at: Point,
) => {
  const trial: model.Layer = structuredClone(layer);
  const errorOf = (offset: [number, number]) => {
    trial.warp.corners[corner] = offset;
    const p = handles(trial)[corner]!;
    return { dx: at.x - p.x, dy: at.y - p.y };
  };
  let best = layer.warp.corners[corner]!;
  let error = errorOf(best);
  // 行き過ぎて離れたら、動かす量を半分にする
  let step = 1;
  for (let i = 0; i < 24 && Math.hypot(error.dx, error.dy) >= 0.05; i++) {
    const next: [number, number] = [
      best[0] + (error.dx / layer.width) * step,
      best[1] + (error.dy / layer.height) * step,
    ];
    const nextError = errorOf(next);
    if (
      Math.hypot(nextError.dx, nextError.dy) < Math.hypot(error.dx, error.dy)
    ) {
      best = next;
      error = nextError;
    } else step /= 2;
  }
  trial.warp.corners[corner] = best;
  const [x, y] = trial.warp.corners[corner]!;
  return [clampOffset(x), clampOffset(y)] as [number, number];
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
  // 出力の canvas が上限を超えないよう、レイヤーの中心のまわりに収める
  const cx = layer.width / 2;
  const cy = layer.height / 2;
  const half = model.MAX_SIDE / 2;
  minX = Math.floor(Math.max(minX, cx - half)) - 1;
  minY = Math.floor(Math.max(minY, cy - half)) - 1;
  maxX = Math.ceil(Math.min(maxX, cx + half)) + 1;
  maxY = Math.ceil(Math.min(maxY, cy + half)) + 1;
  let width = Math.max(1, maxX - minX);
  let height = Math.max(1, maxY - minY);
  const area = Math.sqrt(model.MAX_AREA / (width * height));
  if (area < 1) {
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

/** 三角形を 1 枚ずつ、アフィン変換で貼る。継ぎ目が見えないよう、切り抜きを少し外へ広げる */
const draw2d = (source: HTMLCanvasElement, mesh: Mesh) => {
  const out = document.createElement("canvas");
  out.width = mesh.width;
  out.height = mesh.height;
  const context = out.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  const { columns, rows, points } = mesh;
  const sw = source.width / columns;
  const sh = source.height / rows;
  const at = (i: number, j: number) => {
    const k = (j * (columns + 1) + i) * 2;
    return { x: points[k]!, y: points[k + 1]! };
  };
  const triangle = (s: [Point, Point, Point], d: [Point, Point, Point]) => {
    const [s0, s1, s2] = s;
    const [d0, d1, d2] = d;
    const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (det === 0) return;
    const a =
      ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
    const b =
      ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
    const c =
      ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
    const dd =
      ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - dd * s0.y;
    const cx = (d0.x + d1.x + d2.x) / 3;
    const cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p: Point) => {
      const length = Math.hypot(p.x - cx, p.y - cy) || 1;
      return {
        x: p.x + ((p.x - cx) / length) * 0.6,
        y: p.y + ((p.y - cy) / length) * 0.6,
      };
    };
    const [g0, g1, g2] = [grow(d0), grow(d1), grow(d2)];
    context.save();
    context.beginPath();
    context.moveTo(g0.x, g0.y);
    context.lineTo(g1.x, g1.y);
    context.lineTo(g2.x, g2.y);
    context.closePath();
    context.clip();
    context.setTransform(a, b, c, dd, e, f);
    context.drawImage(source, 0, 0);
    context.restore();
  };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const s00 = { x: i * sw, y: j * sh };
      const s10 = { x: (i + 1) * sw, y: j * sh };
      const s01 = { x: i * sw, y: (j + 1) * sh };
      const s11 = { x: (i + 1) * sw, y: (j + 1) * sh };
      const d00 = at(i, j);
      const d10 = at(i + 1, j);
      const d01 = at(i, j + 1);
      const d11 = at(i + 1, j + 1);
      triangle([s00, s10, s11], [d00, d10, d11]);
      triangle([s00, s11, s01], [d00, d11, d01]);
    }
  return out;
};

/**
 * レイヤーを描いた絵（左上がレイヤーの左上から pad 外側）を変形する
 */
export const apply = (
  layer: model.Layer,
  source: HTMLCanvasElement,
  pad: number,
): Warped => {
  const mesh = buildMesh(layer, source.width, source.height, pad);
  const canvas = drawGl(source, mesh) ?? draw2d(source, mesh);
  return { canvas, left: mesh.left, top: mesh.top };
};
