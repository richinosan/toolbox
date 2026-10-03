// 控えめなアニメーション。跳ね返り（オーバーシュート）はせず、短い ease-out で落ち着かせる
// OS の「視差効果を減らす」設定が有効なときは何もしない

const keyframes = {
  /** 出現時：わずかに下から浮かび上がるようにフェードイン */
  in: [
    { opacity: 0, translate: "0 4px", scale: 0.98 },
    { opacity: 1, translate: "0 0", scale: 1 },
  ],
  /** 押したとき：ほんの少し縮んで戻る */
  press: [{ scale: 1 }, { scale: 0.97, offset: 0.4 }, { scale: 1 }],
  /** 値が変わったとき：薄い状態から戻して変化を伝える */
  pop: [
    { opacity: 0.4, translate: "0 2px" },
    { opacity: 1, translate: "0 0" },
  ],
} satisfies Record<string, Keyframe[]>;

export type Motion = keyof typeof keyframes;

const duration = { in: 180, press: 160, pop: 200 } satisfies Record<
  Motion,
  number
>;

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export const play = (element: Element, kind: Motion) => {
  if (reducedMotion()) return;
  element.animate(keyframes[kind], {
    duration: duration[kind],
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  });
};
