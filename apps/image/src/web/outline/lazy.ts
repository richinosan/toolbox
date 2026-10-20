// Go（outline.go）から使う、fontkit の読み込み。fontkit は大きいので、パスを作るときだけ読み込む。
let fontkitModule: Promise<typeof import("fontkit")> | null = null;

export const loadFontkit = () => (fontkitModule ??= import("fontkit"));
