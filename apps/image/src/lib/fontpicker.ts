// フォントを選ぶダイアログ（Web フォント・端末のフォント・ファイル）。
import * as fonts from "./fonts";

const $ = <T extends Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector)!;

const LIMIT = 120;

export const create = (dialog: HTMLDialogElement, signal: AbortSignal) => {
  const form = $<HTMLFormElement>(dialog, "form");
  const search = $<HTMLInputElement>(dialog, "#font-search");
  const japanese = $<HTMLInputElement>(dialog, "#font-japanese");
  const webList = $<HTMLUListElement>(dialog, "#font-list");
  const webNote = $<HTMLElement>(dialog, "#font-web-note");
  const localButton = $<HTMLButtonElement>(dialog, "#font-local-load");
  const localSearch = $<HTMLInputElement>(dialog, "#font-local-search");
  const localList = $<HTMLUListElement>(dialog, "#font-local-list");
  const localNote = $<HTMLElement>(dialog, "#font-local-note");
  const fileButton = $<HTMLButtonElement>(dialog, "#font-file-pick");
  const fileInput = $<HTMLInputElement>(dialog, "#font-file-input");
  const fileList = $<HTMLUListElement>(dialog, "#font-file-list");
  const fileNote = $<HTMLElement>(dialog, "#font-file-note");

  let current: fonts.FontRef = fonts.builtin;
  let resolve: ((ref: fonts.FontRef | null) => void) | null = null;
  let localFamilies: fonts.LocalFamily[] | null = null;
  const files: fonts.FontRef[] = [];

  const finish = (ref: fonts.FontRef | null) => {
    resolve?.(ref);
    resolve = null;
    if (dialog.open) dialog.close();
  };

  const item = (
    ref: fonts.FontRef,
    label: string,
    meta: string,
    preview: string | null,
  ) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "font-item";
    button.setAttribute("aria-pressed", String(fonts.sameFont(ref, current)));
    const name = document.createElement("span");
    name.className = "font-item__name";
    name.textContent = label;
    if (preview) name.style.fontFamily = preview;
    const info = document.createElement("span");
    info.className = "font-item__meta";
    info.textContent = meta;
    button.append(name, info);
    button.addEventListener("click", () => finish(ref));
    li.append(button);
    return li;
  };

  const tab = () =>
    (new FormData(form).get("font-tab") as string | null) ?? "web";

  const showTab = () => {
    for (const panel of dialog.querySelectorAll<HTMLElement>("[data-tab]"))
      panel.hidden = panel.dataset["tab"] !== tab();
  };

  const renderWeb = async () => {
    const query = search.value.trim().toLowerCase();
    let list: readonly fonts.CatalogFont[] = fonts.recommended;
    webNote.textContent =
      "選んだフォントだけを、使う文字の分だけ jsDelivr（Fontsource）から読み込みます。";
    if (query) {
      try {
        webNote.textContent = "フォントの一覧を読み込んでいます…";
        list = await fonts.loadCatalog();
        webNote.textContent = "";
      } catch {
        webNote.textContent =
          "フォントの一覧を読み込めませんでした。おすすめの中から探しています。";
      }
    }
    const filtered = list
      .filter((font) => !japanese.checked || font.japanese)
      .filter(
        (font) =>
          !query ||
          font.family.toLowerCase().includes(query) ||
          font.id.includes(query),
      );
    const items = filtered
      .slice(0, LIMIT)
      .map((font) =>
        item(
          fonts.webRef(font),
          font.family,
          [
            fonts.categoryLabels[font.category] ?? "",
            font.japanese ? "日本語" : "",
            font.weights.some((w) => w >= 600) ? "太字あり" : "",
          ]
            .filter(Boolean)
            .join("・"),
          null,
        ),
      );
    if (!query || "line seed jp".includes(query))
      items.unshift(
        item(fonts.builtin, "LINE Seed JP", "標準・日本語・太字あり", null),
      );
    webList.replaceChildren(...items);
    if (filtered.length > LIMIT)
      webNote.textContent = `${filtered.length} 件中 ${LIMIT} 件を表示しています。名前で絞り込んでください。`;
    else if (items.length === 0) webNote.textContent = "見つかりませんでした。";
  };

  const renderLocal = () => {
    if (!localFamilies) return;
    const query = localSearch.value.trim().toLowerCase();
    const filtered = localFamilies.filter(
      (family) => !query || family.family.toLowerCase().includes(query),
    );
    localList.replaceChildren(
      ...filtered.slice(0, 300).map((family) =>
        item(
          family.ref,
          family.family,
          family.ref.faces?.bold ? "太字あり" : "",
          // 端末のフォントは通信なしで見本を出せる
          `"${family.family.replace(/["\\]/g, "")}", sans-serif`,
        ),
      ),
    );
    localNote.textContent =
      filtered.length > 300
        ? `${filtered.length} 件中 300 件を表示しています。名前で絞り込んでください。`
        : filtered.length === 0
          ? "見つかりませんでした。"
          : "";
  };

  const renderFiles = () => {
    fileList.replaceChildren(
      ...files.map((ref) => item(ref, ref.family, "読み込んだファイル", null)),
    );
  };

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void renderWeb(), 200);
  });
  japanese.addEventListener("change", () => void renderWeb());
  localSearch.addEventListener("input", renderLocal);
  form.addEventListener("change", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.name === "font-tab"
    )
      showTab();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    finish(null);
  });
  dialog.addEventListener("close", () => finish(null));

  localButton.addEventListener("click", async () => {
    if (!fonts.canQueryLocal()) {
      localNote.textContent =
        "このブラウザは端末のフォントの一覧を読めません（Chrome・Edge のパソコン版で使えます）。「ファイル」からフォントファイルを読み込んでください。";
      return;
    }
    localNote.textContent = "読み込んでいます…";
    try {
      localFamilies = await fonts.queryLocal();
      localSearch.hidden = false;
      localButton.hidden = true;
      renderLocal();
    } catch {
      localNote.textContent =
        "端末のフォントを読めませんでした。ブラウザの確認で「許可」を選ぶと読めます。";
    }
  });

  fileButton.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const picked = [...(fileInput.files ?? [])];
    if (picked.length === 0) return;
    fileNote.textContent = "読み込んでいます…";
    let last: fonts.FontRef | null = null;
    let failed = 0;
    for (const file of picked) {
      try {
        const ref = await fonts.addFile(file);
        if (!files.some((f) => fonts.sameFont(f, ref))) files.push(ref);
        last = ref;
      } catch {
        failed++;
      }
    }
    renderFiles();
    fileNote.textContent =
      failed > 0
        ? `${failed} 個のファイルはフォントとして読めませんでした。`
        : "";
    // 1 つだけ読み込んだときは、そのまま選ぶ
    if (picked.length === 1 && last) finish(last);
  });

  signal.addEventListener("abort", () => finish(null));

  return {
    open: (font: fonts.FontRef) =>
      new Promise<fonts.FontRef | null>((done) => {
        current = font;
        resolve = done;
        search.value = "";
        void renderWeb();
        renderLocal();
        renderFiles();
        showTab();
        dialog.showModal();
      }),
  };
};
