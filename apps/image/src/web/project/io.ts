// Go（project.go）から使う、Promise を返す処理。

/** Promise の完了を待つ（Go の側で reject の理由を js.Error として受け取るため） */
export const settle = (promise: unknown) => Promise.resolve(promise);

/** Blob を data URL にする */
export const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });

/** data URL の画像を Blob と ImageBitmap にする */
export const loadImage = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  return { blob, image: await createImageBitmap(blob) };
};
