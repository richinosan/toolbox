import * as luxon from "luxon";

/**
 * 日付のみの入力は常にこのタイムゾーンの 00:00:00 として解釈する。
 * Asia/Tokyo は 1888 年以前が地方平均時（UTC+09:18:59）になるため、固定オフセットの UTC+9 を使う。
 */
export const TIME_ZONE = "UTC+9";
export const TIME_ZONE_LABEL = "JST (UTC+09:00)";

export type DateInfo = {
  dateTime: luxon.DateTime;
  weekday: string;
  unixTime: number;
};

/**
 * 日付文字列を解釈する。対応形式:
 * - ISO 8601（例: 2026-10-01, 2026-10-01T12:00:00Z）
 * - 年月日（例: 2026年10月1日, 10月1日, 1日。年・月を省略すると今の年・月）
 * - 区切り（/ ／ -）: 2026/10/1, 26/10/1, 10/1（年を省略すると今の年）
 * - 8 桁: 20261001, 6 桁: 261001（2 桁の年は 00〜59 → 20xx, 60〜99 → 19xx）
 * 全角数字・全角記号は半角として扱う。西暦 1 年より前と、解釈できない入力は null。
 */
export function parseDate(
  input: string,
  now = luxon.DateTime.now(),
): DateInfo | null {
  const text = input.normalize("NFKC").trim();
  if (!text) return null;

  const dateTime = parseText(text, now.setZone(TIME_ZONE));
  const weekday = dateTime?.setLocale("ja").weekdayLong;
  // 西暦 1 年より前（ISO の 0000 年や負の年）は、ピッカーの表示や年の桁数と食い違うので扱わない
  if (!dateTime?.isValid || !weekday || dateTime.year < 1) return null;

  return {
    dateTime,
    weekday,
    unixTime: dateTime.toUnixInteger(),
  };
}

function parseText(text: string, now: luxon.DateTime): luxon.DateTime | null {
  const opts = { zone: TIME_ZONE };

  let match = /^(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日$/.exec(text);
  if (match) {
    return luxon.DateTime.fromObject(
      {
        year: match[1] ? Number(match[1]) : now.year,
        month: match[2] ? Number(match[2]) : now.month,
        day: Number(match[3]),
      },
      opts,
    );
  }

  match = /^(?:(\d{2}|\d{4})([/-]))?(\d{1,2})([/-])(\d{1,2})$/.exec(text);
  // 区切り文字は揃っている必要がある（2026/10-01 は不可）
  if (match && (!match[2] || match[2] === match[4])) {
    const [, year, , month, , day] = match;
    return luxon.DateTime.fromObject(
      {
        year: year ? toFullYear(year) : now.year,
        month: Number(month),
        day: Number(day),
      },
      opts,
    );
  }

  if (/^\d{8}$/.test(text))
    return luxon.DateTime.fromFormat(text, "yyyyMMdd", opts);
  match = /^(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (match) {
    const [, year = "", month, day] = match;
    return luxon.DateTime.fromObject(
      { year: toFullYear(year), month: Number(month), day: Number(day) },
      opts,
    );
  }

  // 時刻やオフセットを含む ISO 8601 はその瞬間として扱い、表示は JST (UTC+9) に揃える
  const iso = luxon.DateTime.fromISO(text, opts);
  return iso.isValid ? iso.setZone(TIME_ZONE) : null;
}

/** 2 桁の年は 00〜59 → 2000 年代、60〜99 → 1900 年代とする（4 桁ならそのまま）。 */
function toFullYear(year: string): number {
  const value = Number(year);
  if (year.length !== 2) return value;
  return value < 60 ? 2000 + value : 1900 + value;
}

/** 「2026年10月01日(木)」の形式（年は 4 桁、月日は 2 桁、曜日は 1 文字）に整える。 */
export function formatJapanese(info: DateInfo): string {
  return info.dateTime.setLocale("ja").toFormat("yyyy年MM月dd日(EEE)");
}

export type MultiLineResult = {
  /** 入力と同じ行数の出力。空行はそのまま、解釈できない行は理由つきで残す。 */
  output: string;
  /** 解釈できなかった行番号（1 始まり） */
  invalidLines: number[];
  /** 解釈できた行の数 */
  parsedCount: number;
};

/** 1 行に 1 つ書かれた日付をまとめて整形する。 */
export function formatLines(
  input: string,
  now = luxon.DateTime.now(),
): MultiLineResult {
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
    return formatJapanese(info);
  });
  return { output: lines.join("\n"), invalidLines, parsedCount };
}
