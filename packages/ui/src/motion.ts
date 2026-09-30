// バウンスアニメーション。OS の「視差効果を減らす」設定が有効なときは何もしない

const keyframes = {
  /** 出現時：少し大きくなってから落ち着く */
  in: [
    { opacity: 0, scale: 0.85 },
    { opacity: 1, scale: 1.04, offset: 0.55 },
    { scale: 0.98, offset: 0.75 },
    { scale: 1 },
  ],
  /** 押したとき：へこんでから跳ね返る */
  press: [
    { scale: 1 },
    { scale: 0.9, offset: 0.35 },
    { scale: 1.06, offset: 0.7 },
    { scale: 1 },
  ],
  /** 値が変わったとき：小さく跳ねる */
  pop: [
    { scale: 1 },
    { scale: 1.12, offset: 0.4 },
    { scale: 0.97, offset: 0.7 },
    { scale: 1 },
  ],
} satisfies Record<string, Keyframe[]>;

export type Bounce = keyof typeof keyframes;

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export const bounce = (element: Element, kind: Bounce) => {
  if (reducedMotion()) return;
  element.animate(keyframes[kind], {
    duration: kind === "in" ? 380 : 340,
    easing: "ease-out",
  });
};
