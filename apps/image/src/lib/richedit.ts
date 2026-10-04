// 文字ごとに書式を持つテキストの編集欄（contenteditable）。
// DOM は「1 行 = 1 つの div、ラン = data-style を持つ span」の形で作り、入力のたびに DOM からランを読み直す。
// 書式の変更は DOM ではなくランに対して行い、作り直した DOM に選択範囲を戻す。
import * as fonts from "./fonts";
import type * as model from "./model";
import * as text from "./text";

export type View = {
  /** 文字の大きさの倍率（パネルでは見やすい大きさに縮め、キャンバス上では表示倍率に合わせる） */
  scale: number;
  lineHeight: number;
  /** キャンバス上で編集するときは、縁取りと影も見せる */
  effects?: { strokeColor: string; strokeWidth: number; shadow: boolean };
};

const styleOf = (element: Element | null): model.CharStyle | null => {
  const span = element?.closest<HTMLElement>("[data-style]");
  const raw = span?.dataset["style"];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as model.CharStyle;
  } catch {
    return null;
  }
};

const applySpanStyle = (
  span: HTMLElement,
  style: model.CharStyle,
  view: View,
) => {
  span.dataset["style"] = JSON.stringify(style);
  span.style.fontFamily = fonts.cssFamily(style.font);
  span.style.fontSize = `${style.size * view.scale}px`;
  span.style.fontWeight = style.bold ? "700" : "400";
  span.style.color = style.color;
  span.style.lineHeight = `${(style.size * view.scale * view.lineHeight) / 100}px`;
};

/** ランを DOM にする */
export const render = (
  element: HTMLElement,
  runs: readonly model.TextRun[],
  view: View,
) => {
  const lines: model.TextRun[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((piece, i) => {
      if (i > 0) lines.push([]);
      lines.at(-1)!.push({ text: piece, style: run.style });
    });
  }
  const effects = view.effects;
  element.style.setProperty(
    "--stroke",
    effects && effects.strokeWidth > 0
      ? `${effects.strokeWidth * 2 * view.scale}px ${effects.strokeColor}`
      : "0",
  );
  element.classList.toggle("rich--shadow", Boolean(effects?.shadow));
  element.replaceChildren(
    ...lines.map((line) => {
      const div = document.createElement("div");
      const parts = line.filter((part) => part.text);
      if (parts.length === 0) {
        // 空の行も、その位置の書式の高さにする
        const span = document.createElement("span");
        applySpanStyle(span, line[0]?.style ?? runs[0]!.style, view);
        span.append(document.createElement("br"));
        div.append(span);
      }
      for (const part of parts) {
        const span = document.createElement("span");
        applySpanStyle(span, part.style, view);
        span.textContent = part.text;
        div.append(span);
      }
      return div;
    }),
  );
};

const isBlock = (node: Node) =>
  node instanceof HTMLElement && /^(DIV|P)$/.test(node.tagName);

type Unit =
  | { kind: "text"; node: Text; text: string; style: model.CharStyle | null }
  /** 行の始まり（2 行目以降）。node は行の要素 */
  | { kind: "line"; node: Node; text: "\n"; style: null }
  /** 行の途中の <br> */
  | {
      kind: "br";
      node: HTMLBRElement;
      text: "\n";
      style: model.CharStyle | null;
    };

/**
 * DOM の中身を、文字の並びとして順にたどる。
 * 行（div）の区切りと <br> を改行にする。行の最後の <br> は空の行を保つためのものなので数えない。
 */
const units = (element: HTMLElement): Unit[] => {
  const out: Unit[] = [];
  const lines: Node[][] = [];
  let loose: Node[] = [];
  for (const child of element.childNodes) {
    if (isBlock(child)) {
      if (loose.length) lines.push(loose);
      loose = [];
      lines.push([child]);
    } else loose.push(child);
  }
  if (loose.length) lines.push(loose);
  lines.forEach((nodes, index) => {
    if (index > 0)
      out.push({ kind: "line", node: nodes[0]!, text: "\n", style: null });
    const brs: HTMLBRElement[] = [];
    const collect = (node: Node) => {
      if (node instanceof HTMLBRElement) brs.push(node);
      node.childNodes.forEach(collect);
    };
    nodes.forEach(collect);
    const trailing = brs.at(-1);
    const visit = (node: Node) => {
      if (node instanceof Text) {
        out.push({
          kind: "text",
          node,
          text: (node.textContent ?? "").replace(/\u200b/g, ""),
          style: styleOf(node.parentElement),
        });
      } else if (node instanceof HTMLBRElement) {
        if (node !== trailing)
          out.push({
            kind: "br",
            node,
            text: "\n",
            style: styleOf(node.parentElement),
          });
      } else if (isBlock(node) && !nodes.includes(node)) {
        // 行の中に入れ子の行があれば、改行として扱う
        out.push({ kind: "line", node, text: "\n", style: null });
        node.childNodes.forEach(visit);
      } else node.childNodes.forEach(visit);
    };
    nodes.forEach(visit);
  });
  return out;
};

/** DOM からランを読む。書式の無い文字（ブラウザが span の外に入れた文字）は直前の書式にする */
export const read = (
  element: HTMLElement,
  fallback: model.CharStyle,
): model.TextRun[] => {
  const runs: model.TextRun[] = [];
  let current = fallback;
  for (const unit of units(element)) {
    if (unit.style) current = unit.style;
    runs.push({ text: unit.text, style: current });
  }
  return text.normalize(runs, fallback);
};

const afterNode = (node: Node) => {
  const parent = node.parentNode!;
  return {
    node: parent,
    offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1,
  };
};

/** DOM の位置を、文字の位置に直す */
const offsetOf = (element: HTMLElement, container: Node, offset: number) => {
  const point = document.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  // (node, offset) が point と同じか前にあるとき true
  const reached = (node: Node, at: number) => point.comparePoint(node, at) <= 0;
  let count = 0;
  for (const unit of units(element)) {
    if (unit.kind === "text") {
      if (unit.node === container)
        return count + Math.min(offset, unit.text.length);
      if (!reached(unit.node, unit.node.length)) return count;
      count += unit.text.length;
    } else if (unit.kind === "line") {
      if (!reached(unit.node, 0)) return count;
      count += 1;
    } else {
      const after = afterNode(unit.node);
      if (!reached(after.node, after.offset)) return count;
      count += 1;
    }
  }
  return count;
};

/** 選択範囲を、文字の位置（改行も 1 文字）で返す。編集欄の外なら null */
export const getSelection = (element: HTMLElement) => {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (
    !element.contains(range.startContainer) ||
    !element.contains(range.endContainer)
  )
    return null;
  const start = offsetOf(element, range.startContainer, range.startOffset);
  const end = offsetOf(element, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

/** 文字の位置を DOM の位置に直す */
const pointOf = (element: HTMLElement, target: number) => {
  let count = 0;
  let pending: { node: Node; offset: number } | null = null;
  for (const unit of units(element)) {
    if (unit.kind === "text") {
      if (target <= count + unit.text.length)
        return { node: unit.node as Node, offset: target - count };
      count += unit.text.length;
      pending = null;
    } else {
      if (pending && target === count) return pending;
      count += 1;
      pending =
        unit.kind === "line"
          ? { node: unit.node, offset: 0 }
          : afterNode(unit.node);
    }
  }
  if (pending && target === count) return pending;
  return { node: element as Node, offset: element.childNodes.length };
};

/** 文字の位置の範囲を DOM の Range にする */
export const rangeOf = (element: HTMLElement, start: number, end: number) => {
  const a = pointOf(element, start);
  const b = pointOf(element, end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
};

/** 文字の位置で選択範囲を戻す */
export const setSelection = (
  element: HTMLElement,
  start: number,
  end: number,
) => {
  const selection = document.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(rangeOf(element, start, end));
};

/** 文字の数（改行も 1 文字） */
export const length = (element: HTMLElement) =>
  units(element).reduce((sum, unit) => sum + unit.text.length, 0);

/**
 * DOM が render() で作った形のままか。ブラウザが span の外に文字を入れたり、
 * 別の要素を入れたりしたときは false（作り直して見た目を書式に合わせる）
 */
export const isClean = (element: HTMLElement) => {
  for (const line of element.childNodes) {
    if (!(line instanceof HTMLDivElement)) return false;
    for (const span of line.childNodes) {
      if (!(span instanceof HTMLSpanElement) || !span.dataset["style"])
        return false;
      for (const child of span.childNodes)
        if (!(child instanceof Text || child instanceof HTMLBRElement))
          return false;
    }
  }
  return true;
};
