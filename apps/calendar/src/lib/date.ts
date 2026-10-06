// 日付の解釈と整形は Go（./jpdate）で書き、goesm で TypeScript に変換したものを読み込む。
// goesm は Go の string を JavaScript の文字列に、struct を json タグの名前のオブジェクトに変換して渡す。
// ここでは Go にない NFKC 正規化と、今の時刻だけを扱う。
import * as jpdate from "#go/apps/calendar/src/lib/jpdate.ts";

export const TIME_ZONE_LABEL = "JST (UTC+09:00)";

export type DateInfo = ReturnType<typeof jpdate.ParseDate>[0];

/** 今の UNIX 時間（秒） */
const nowUnix = () => Math.floor(Date.now() / 1000);

/**
 * 日付文字列を解釈する（対応形式は jpdate.go の ParseDate を参照）。
 * 全角数字・全角記号は半角として扱う。西暦 1 年より前と、解釈できない入力は null。
 */
export function parseDate(input: string, now = nowUnix()): DateInfo | null {
  // Go の標準ライブラリには NFKC 正規化がないので、ブラウザの normalize を使う
  const text = input.normalize("NFKC").trim();
  if (!text) return null;

  const [info, ok] = jpdate.ParseDate(text, now);
  return ok ? info : null;
}

/** 今日の日付（JST）を「2026-10-01」の形式で返す。 */
export function today(now = nowUnix()): string {
  return jpdate.Today(now);
}

export type MultiLineResult = {
  /** 入力と同じ行数の出力。空行はそのまま、解釈できない行は理由つきで残す。 */
  output: string;
  /** 解釈できなかった行番号（1 始まり） */
  invalidLines: number[];
  /** 解釈できた行の数 */
  parsedCount: number;
};

/** 1 行に 1 つ書かれた日付をまとめて「2026年10月01日(木)」の形式に整える。 */
export function formatLines(input: string, now = nowUnix()): MultiLineResult {
  const invalidLines: number[] = [];
  let parsedCount = 0;
  const lines = input.split(/\r\n|\r|\n/).map((line, i) => {
    if (!line.trim()) return "";
    const info = parseDate(line, now);
    if (!info) {
      invalidLines.push(i + 1);
      return `解釈できません: ${line.trim()}`;
    }
    parsedCount += 1;
    return info.japanese;
  });
  return { output: lines.join("\n"), invalidLines, parsedCount };
}
