// 文字の大きさの入力：−/+ で進む段階と、スライダーの目盛り。

export const MIN = 1;
export const MAX = 2000;

/** −/+ で進む大きさ。小さいうちは細かく、大きくなるほど約 1 割ずつ進む */
const STEPS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40,
  44, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 192, 216, 240,
  264, 288, 320, 360, 400, 440, 480, 540, 600, 660, 720, 800, 880, 960, 1080,
  1200, 1320, 1440, 1600, 1760, 1920, 2000,
];

/** いまの大きさから、ひとつ上（direction = 1）または下（-1）の段階 */
export const step = (size: number, direction: 1 | -1): number => {
  if (direction > 0) return STEPS.find((s) => s > size) ?? MAX;
  return STEPS.findLast((s) => s < size) ?? MIN;
};

/** スライダーは 4〜1000px を対数で並べる（小さい文字も大きい文字も同じ手ざわりで動かせる） */
const SLIDER_MIN = 4;
const SLIDER_MAX = 1000;
export const SLIDER_STEPS = 1000;

export const toSlider = (size: number): number => {
  const clamped = Math.min(Math.max(size, SLIDER_MIN), SLIDER_MAX);
  return Math.round(
    (Math.log(clamped / SLIDER_MIN) / Math.log(SLIDER_MAX / SLIDER_MIN)) *
      SLIDER_STEPS,
  );
};

export const fromSlider = (value: number): number =>
  Math.round(SLIDER_MIN * (SLIDER_MAX / SLIDER_MIN) ** (value / SLIDER_STEPS));

export const clamp = (size: number): number =>
  Math.min(Math.max(Math.round(size), MIN), MAX);
