// Go（exporter.go）から使う、Promise を返す処理。

/** Promise の完了を待つ（Go の側で reject の理由を js.Error として受け取るため） */
export const settle = (promise: unknown) => Promise.resolve(promise);

export const toBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("画像を作れませんでした。")),
      type,
      quality,
    ),
  );

/** PSD を書き出す。PSD の書き出しライブラリは大きいので、使うときだけ読み込む */
export const writePsd = async (psd: import("ag-psd").Psd) => {
  const agPsd = await import("ag-psd");
  const buffer = agPsd.writePsd(psd, {
    generateThumbnail: true,
    noBackground: true,
  });
  return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
};
