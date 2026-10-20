// fontkit は大きいので、フォントファイルを読み込むときだけ読み込む（Go からは //goesm:import で呼ぶ）。
let fontkitModule: Promise<unknown> | null = null;

export const loadFontkit = () => (fontkitModule ??= import("fontkit"));
