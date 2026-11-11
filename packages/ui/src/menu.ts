// ヘッダーのツール一覧を、dashboard が配信する HTML 断片（/menu）で最新にする。
// ページに埋め込まれた一覧はそのツールをビルドした時点のものなので、あとから足したツールが載らない。
// 読み込めないとき（オフライン・回線が遅い・dashboard が未デプロイ）は、埋め込まれた一覧のまま使う。
import * as singleton from "./singleton";

const MENU_URL = "/menu";
/** 開きっぱなしのタブでも、ページを移ったときにこれより古ければ読み込み直す */
const MAX_AGE = 5 * 60 * 1000;
const TIMEOUT = 8000;

let latest: { html: string; at: number } | undefined;
let loading = false;

/** 断片の中身を確かめて、ツールのタイルが入った一覧だけを取り出す */
const parse = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  const list = template.content.querySelector("ul.tools-menu");
  if (!list || !list.querySelector("a.tool-tile[href^='/']")) return undefined;
  // スクリプトなど、一覧に要らないものが混ざっていたら使わない
  if (list.querySelector("script, style, link, iframe, form")) return undefined;
  for (const element of list.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (attribute.name.startsWith("on")) return undefined;
    }
  }
  // アイコンの SVG はグラデーションなどを id で参照する。id はビルドごとの連番なので、
  // ページにある別のアイコンとぶつからないよう付け替える
  const ids = new Map<string, string>();
  for (const element of list.querySelectorAll("[id]")) {
    const renamed = `menu-${element.id}`;
    ids.set(element.id, renamed);
    element.id = renamed;
  }
  for (const element of list.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      const value = attribute.value.replace(
        /(url\(#|^#)([^)\s]+)/g,
        (match, prefix: string, id: string) =>
          ids.has(id) ? `${prefix}${ids.get(id)}` : match,
      );
      if (value !== attribute.value) attribute.value = value;
    }
  }
  return list;
};

const apply = () => {
  if (!latest) return;
  const current = document.querySelector("#tools-popover .tools-menu");
  const list = parse(latest.html);
  if (!current || !list) return;
  current.replaceChildren(...list.children);
};

const load = async () => {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch(MENU_URL, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.includes("html")) return;
    const html = await response.text();
    if (!parse(html)) return;
    latest = { html, at: Date.now() };
    apply();
  } catch {
    // 読み込めなければ埋め込まれた一覧のまま
  } finally {
    loading = false;
  }
};

export const start = () => {
  singleton.once("tools-menu", () => {
    // ポップオーバーは ClientRouter の遷移ごとに入れ替わるので、そのたびに当て直す
    document.addEventListener("astro:page-load", () => {
      apply();
      if (!latest || Date.now() - latest.at > MAX_AGE) void load();
    });
  });
};
