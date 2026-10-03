// スナップ：動かしているレイヤーの端と中心を、キャンバスや他のレイヤーの端・中心にそろえる。

export type Box = { x: number; y: number; width: number; height: number };

export type Targets = { xs: number[]; ys: number[] };

export type Guides = { xs: number[]; ys: number[] };

/** キャンバスの端・中心と、他のレイヤーの端・中心 */
export const targets = (
  canvas: { width: number; height: number },
  boxes: readonly Box[],
): Targets => {
  const xs = [0, canvas.width / 2, canvas.width];
  const ys = [0, canvas.height / 2, canvas.height];
  for (const box of boxes) {
    xs.push(box.x, box.x + box.width / 2, box.x + box.width);
    ys.push(box.y, box.y + box.height / 2, box.y + box.height);
  }
  return { xs, ys };
};

/** candidates のどれかを lines のどれかに合わせるときの、最小の移動量（threshold 以内のみ） */
const nearest = (
  candidates: readonly number[],
  lines: readonly number[],
  threshold: number,
) => {
  let best: { delta: number; line: number } | null = null;
  for (const candidate of candidates) {
    for (const line of lines) {
      const delta = line - candidate;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta))
        best = { delta, line };
    }
  }
  return best;
};

/** 合わせたあとの位置で、ぴったり重なっている線をすべてガイドとして返す */
const matched = (
  candidates: readonly number[],
  lines: readonly number[],
): number[] => [
  ...new Set(
    lines.filter((line) =>
      candidates.some((candidate) => Math.abs(candidate - line) < 0.5),
    ),
  ),
];

/** 移動：左端・中心・右端（上端・中心・下端）のどれかを合わせる */
export const snapMove = (
  box: Box,
  lines: Targets,
  threshold: number,
): { x: number; y: number; guides: Guides } => {
  const xs = [box.x, box.x + box.width / 2, box.x + box.width];
  const ys = [box.y, box.y + box.height / 2, box.y + box.height];
  const sx = nearest(xs, lines.xs, threshold);
  const sy = nearest(ys, lines.ys, threshold);
  const x = box.x + (sx?.delta ?? 0);
  const y = box.y + (sy?.delta ?? 0);
  return {
    x,
    y,
    guides: {
      xs: sx ? matched([x, x + box.width / 2, x + box.width], lines.xs) : [],
      ys: sy ? matched([y, y + box.height / 2, y + box.height], lines.ys) : [],
    },
  };
};

/** 1 本の辺（リサイズで動かしている辺）を合わせる */
export const snapEdge = (
  value: number,
  lines: readonly number[],
  threshold: number,
) => nearest([value], lines, threshold)?.line ?? null;
