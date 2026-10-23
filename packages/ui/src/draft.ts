// 入力中の内容を sessionStorage に一時保存する（誤って再読み込みしても消えないように）。
// sessionStorage はタブを閉じると消えるので、入力した内容が端末に残り続けることはない。
// 使えない環境（プライベートブラウズの一部など）では何もしない。

const prefix = "toolbox:draft:";

/** 保存した内容を読む。無い・読めないときは null */
export const read = (key: string): unknown => {
  try {
    const value = sessionStorage.getItem(prefix + key);
    return value === null ? null : (JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

export const write = (key: string, value: unknown) => {
  try {
    sessionStorage.setItem(prefix + key, JSON.stringify(value));
  } catch {
    // 保存できなくても、そのまま使える
  }
};

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
