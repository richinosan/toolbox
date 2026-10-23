// フレームのレイアウト（CSS の flex・grid に近い並べ方）。
// フレームの中身の位置と、「中身に合わせる」フレームの大きさを計算して、レイヤーに書き込む。
import * as model from "./model";

type Item = { layer: model.Layer; index: number };

/** 大きさを変えられるか（テキストの大きさは文字で決まる） */
const resizable = (layer: model.Layer) => layer.type !== "text";

/** レイヤーと中身をまとめて動かす */
const moveTo = (layers: model.Layer[], item: Item, x: number, y: number) => {
  const dx = Math.round(x) - item.layer.x;
  const dy = Math.round(y) - item.layer.y;
  if (dx === 0 && dy === 0) return;
  for (const layer of layers.slice(
    item.index,
    model.subtreeEnd(layers, item.index),
  )) {
    layer.x += dx;
    layer.y += dy;
  }
};

const offset = (align: model.AlignValue, free: number) =>
  align === "start" ? 0 : align === "center" ? free / 2 : free;

/** レイアウトで並べる中身（隠したレイヤーは並べない。CSS の display: none と同じ） */
const items = (layers: readonly model.Layer[], frame: model.FrameLayer) =>
  layers.flatMap((layer, index) =>
    layer.parent === frame.id && layer.visible ? [{ layer, index }] : [],
  );

/** 伸ばす中身を除いた、並ぶ向きと直角の向きの一番大きな大きさ（伸ばした大きさで広がり続けないように） */
const crossNatural = (
  list: Item[],
  key: "width" | "height",
  stretch: boolean,
) => {
  const natural = stretch
    ? list.filter((item) => !resizable(item.layer))
    : list;
  const source = natural.length > 0 ? natural : list;
  return Math.max(0, ...source.map((item) => item.layer[key]));
};

/** グリッドのセルの幅（中身に合わせるときは一番幅の広い中身） */
const gridCell = (frame: model.FrameLayer, list: Item[]) => {
  const inset = model.insets(frame);
  const columns = Math.max(1, Math.round(frame.layout.columns));
  const gaps = frame.layout.gap * (columns - 1);
  const width = frame.layout.hug
    ? crossNatural(list, "width", frame.layout.stretch)
    : Math.max(1, (frame.width - inset.left - inset.right - gaps) / columns);
  const rows: number[] = [];
  list.forEach((item, i) => {
    const row = Math.floor(i / columns);
    const natural =
      frame.layout.stretch && resizable(item.layer) ? 0 : item.layer.height;
    rows[row] = Math.max(rows[row] ?? 0, natural);
  });
  // 伸ばす中身だけの行は、今の高さを使う
  list.forEach((item, i) => {
    const row = Math.floor(i / columns);
    if (!rows[row]) rows[row] = Math.max(1, item.layer.height);
  });
  return { columns, width, rows };
};

/** 「中身に合わせる」フレームの大きさ */
const hugSize = (frame: model.FrameLayer, list: Item[]) => {
  const inset = model.insets(frame);
  const { mode, gap, stretch } = frame.layout;
  const gaps = gap * Math.max(0, list.length - 1);
  let width = 0;
  let height = 0;
  if (mode === "row") {
    width = list.reduce((sum, item) => sum + item.layer.width, 0) + gaps;
    height = crossNatural(list, "height", stretch);
  } else if (mode === "column") {
    width = crossNatural(list, "width", stretch);
    height = list.reduce((sum, item) => sum + item.layer.height, 0) + gaps;
  } else {
    const cell = gridCell(frame, list);
    const columns = Math.min(cell.columns, list.length);
    width = cell.width * columns + gap * Math.max(0, columns - 1);
    height =
      cell.rows.reduce((sum, row) => sum + row, 0) +
      gap * Math.max(0, cell.rows.length - 1);
  }
  return {
    width: Math.max(1, Math.round(width + inset.left + inset.right)),
    height: Math.max(1, Math.round(height + inset.top + inset.bottom)),
  };
};

/** フレームの中身を並べる（フレームの位置と大きさは決まっているものとする） */
const arrange = (
  layers: model.Layer[],
  frame: model.FrameLayer,
  list: Item[],
) => {
  const inset = model.insets(frame);
  const left = frame.x + inset.left;
  const top = frame.y + inset.top;
  const innerWidth = Math.max(0, frame.width - inset.left - inset.right);
  const innerHeight = Math.max(0, frame.height - inset.top - inset.bottom);
  const { mode, gap, alignX, alignY, distribute, stretch } = frame.layout;

  if (mode === "grid") {
    const cell = gridCell(frame, list);
    let rowTop = top;
    list.forEach((item, i) => {
      const column = i % cell.columns;
      const row = Math.floor(i / cell.columns);
      if (column === 0 && row > 0) rowTop += cell.rows[row - 1]! + gap;
      const rowHeight = cell.rows[row]!;
      const cellLeft = left + column * (cell.width + gap);
      if (stretch && resizable(item.layer)) {
        item.layer.width = Math.max(1, Math.round(cell.width));
        item.layer.height = Math.max(1, Math.round(rowHeight));
      }
      moveTo(
        layers,
        item,
        cellLeft + offset(alignX, cell.width - item.layer.width),
        rowTop + offset(alignY, rowHeight - item.layer.height),
      );
    });
    return;
  }

  const row = mode === "row";
  const mainSize = (layer: model.Layer) => (row ? layer.width : layer.height);
  const inner = row ? innerWidth : innerHeight;
  const cross = row ? innerHeight : innerWidth;
  if (stretch)
    for (const item of list)
      if (resizable(item.layer)) {
        if (row) item.layer.height = Math.max(1, Math.round(cross));
        else item.layer.width = Math.max(1, Math.round(cross));
      }
  const total =
    list.reduce((sum, item) => sum + mainSize(item.layer), 0) +
    gap * Math.max(0, list.length - 1);
  const free = inner - total;
  let space = gap;
  let position: number;
  if (distribute && list.length > 1) {
    space = gap + Math.max(0, free) / (list.length - 1);
    position = 0;
  } else position = offset(row ? alignX : alignY, free);
  for (const item of list) {
    const crossFree = cross - (row ? item.layer.height : item.layer.width);
    const crossOffset = offset(row ? alignY : alignX, crossFree);
    if (row) moveTo(layers, item, left + position, top + crossOffset);
    else moveTo(layers, item, left + crossOffset, top + position);
    position += mainSize(item.layer) + space;
  }
};

/**
 * すべてのフレームのレイアウトを計算する。
 * 1. 内側のフレームから順に「中身に合わせる」大きさを決め、2. 外側のフレームから順に中身を並べる
 */
export const apply = (doc: model.Doc) => {
  const layers = doc.layers;
  if (!layers.some((layer) => layer.type === "frame")) return;
  for (let i = layers.length - 1; i >= 0; i--) {
    const frame = layers[i]!;
    if (
      frame.type !== "frame" ||
      frame.layout.mode === "free" ||
      !frame.layout.hug
    )
      continue;
    const size = hugSize(frame, items(layers, frame));
    frame.width = size.width;
    frame.height = size.height;
  }
  for (const frame of layers) {
    if (frame.type !== "frame" || frame.layout.mode === "free") continue;
    arrange(layers, frame, items(layers, frame));
  }
};

const center = (layer: model.Layer) => ({
  x: layer.x + layer.width / 2,
  y: layer.y + layer.height / 2,
});

const px = (value: number) => (value === 0 ? "0" : `${value}px`);

/**
 * レイアウトで並ぶ中身をドラッグしたとき、指の位置に合う並び順（兄弟の中での番号）。
 * 横並びは横の位置、縦並びは縦の位置、グリッドは一番近いセル
 */
export const dropIndex = (
  layers: readonly model.Layer[],
  frame: model.FrameLayer,
  dragged: model.Layer,
  point: { x: number; y: number },
) => {
  const siblings = items(layers, frame)
    .map((item) => item.layer)
    .filter((layer) => layer !== dragged);
  if (frame.layout.mode === "row")
    return siblings.filter((layer) => center(layer).x < point.x).length;
  if (frame.layout.mode === "column")
    return siblings.filter((layer) => center(layer).y < point.y).length;
  const all = items(layers, frame).map((item) => item.layer);
  let best = all.indexOf(dragged);
  let distance = Infinity;
  all.forEach((layer, i) => {
    const c = center(layer);
    const d = Math.hypot(c.x - point.x, c.y - point.y);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
};

/** CSS で書くとどうなるか（パネルに見せる） */
export const css = (layer: model.Layer) => {
  const lines: string[] = [];
  if (layer.type === "frame") {
    const { mode, gap, alignX, alignY, distribute, stretch, columns, hug } =
      layer.layout;
    if (mode === "free") lines.push("position: relative;");
    else if (mode === "grid") {
      lines.push(
        "display: grid;",
        `grid-template-columns: repeat(${columns}, ${hug ? "max-content" : "1fr"});`,
        `gap: ${px(gap)};`,
        `justify-items: ${stretch ? "stretch" : alignX};`,
        `align-items: ${stretch ? "stretch" : alignY};`,
      );
    } else {
      const row = mode === "row";
      const main = row ? alignX : alignY;
      const cross = row ? alignY : alignX;
      lines.push(
        "display: flex;",
        `flex-direction: ${row ? "row" : "column"};`,
        `gap: ${px(gap)};`,
        `justify-content: ${distribute ? "space-between" : main === "start" ? "flex-start" : main === "end" ? "flex-end" : "center"};`,
        `align-items: ${stretch ? "stretch" : cross === "start" ? "flex-start" : cross === "end" ? "flex-end" : "center"};`,
      );
    }
    if (hug && mode !== "free") lines.push("width: fit-content;");
    else
      lines.push(`width: ${px(layer.width)};`, `height: ${px(layer.height)};`);
  }
  if (model.hasBox(layer)) {
    const { padding, fill, fillEnabled, borderWidth, borderColor, radius } =
      layer.box;
    const { top, right, bottom, left } = padding;
    const sides =
      top === bottom && right === left
        ? top === right
          ? px(top)
          : `${px(top)} ${px(right)}`
        : `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
    if (top || right || bottom || left) lines.push(`padding: ${sides};`);
    if (fillEnabled) lines.push(`background: ${fill};`);
    if (borderWidth > 0)
      lines.push(`border: ${px(borderWidth)} solid ${borderColor};`);
    if (radius > 0) lines.push(`border-radius: ${px(radius)};`);
    if (lines.length > 0) lines.unshift("box-sizing: border-box;");
  }
  return lines.join("\n");
};
