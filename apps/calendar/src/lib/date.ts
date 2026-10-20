import * as luxon from "luxon";
import * as holiday from "./holiday";

/**
 * 日付のみの入力は常にこのタイムゾーンの 00:00:00 として解釈する。
 * Asia/Tokyo は 1888 年以前が地方平均時（UTC+09:18:59）になるため、固定オフセットの UTC+9 を使う。
 */
export const TIME_ZONE = "UTC+9";
export const TIME_ZONE_LABEL = "JST (UTC+09:00)";

export type DateInfo = {
  dateTime: luxon.DateTime;
  weekday: string;
  /** 祝日・休日の名前（JST での日付で判定）。祝日でなければ null、計算できない年は undefined */
  holiday: string | null | undefined;
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
    holiday: holiday.holidayName(dateTime.year, dateTime.month, dateTime.day),
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

/**
 * 「2026年10月01日(木)」の形式（年は 4 桁、月日は 2 桁、曜日は 1 文字）に整える。
 * 祝日・休日（振替休日・国民の休日を含む）は「2026年11月03日(火・祝)」のように曜日の後ろに「祝」を付ける。
 */
export function formatJapanese(info: DateInfo): string {
  const day = info.dateTime.setLocale("ja").toFormat("yyyy年MM月dd日");
  const weekday = info.dateTime.setLocale("ja").toFormat("EEE");
  return `${day}(${info.holiday ? `${weekday}・祝` : weekday})`;
}

export type MultiLineResult = {
  /** 入力と同じ行数の出力。日付の部分だけを整形し、それ以外の文字はそのまま残す。 */
  output: string;
  /** 日付が見つからず、そのまま出力した行の番号（1 始まり。空行は含まない） */
  passedLines: number[];
  /** 整形した日付の数 */
  parsedCount: number;
};

// 文中から日付を探すときの形式。全角の数字・記号も受け付ける（解釈は parseDate に任せる）。
// 「1日」や 8 桁の数字だけのような、文中では日付と決めにくい形式は行全体のときだけ扱う。
const D = "[0-9０-９]";
const DATE_IN_TEXT = new RegExp(
  "(?<![0-9０-９/／.．:：])(" +
    [
      // 2026年10月1日, 10月1日
      `(?:${D}{4}年)?${D}{1,2}月${D}{1,2}日`,
      // 2026-10-01T12:00:00+09:00 などの ISO 8601（時刻つき）
      `${D}{4}[\\-－]${D}{2}[\\-－]${D}{2}[TＴ]${D}{2}[:：]${D}{2}(?:[:：]${D}{2}(?:[.．]${D}+)?)?(?:[ZＺ]|[+＋\\-－]${D}{2}[:：]?${D}{2})?`,
      // 2026/10/1, 26/10/1, 2026-10-01
      `(?:${D}{2}|${D}{4})([/／]|[\\-－])${D}{1,2}\\2${D}{1,2}`,
      // 10/1
      `${D}{1,2}[/／]${D}{1,2}`,
    ].join("|") +
    ")" +
    // 日付の後ろに書かれた曜日「(土)」「（日）」「(火・祝)」は付け直すので取り除く
    `(?:[ 　]*[(（][ 　]*[日月火水木金土](?:曜日?)?(?:[・･][ 　]*祝(?:日)?)?[ 　]*[)）])?` +
    "(?![0-9０-９/／:：]|[.．][0-9０-９])",
  "g",
);

/**
 * 行ごとに日付を整形する。行全体が日付ならその行を、文の中に日付があればその部分だけを
 * 「2026年10月01日(木)」の形式に置き換え、残りの文字はそのまま出力する。
 * 日付が見つからない行は何も変えずに出力する。
 */
export function formatLines(
  input: string,
  now = luxon.DateTime.now(),
): MultiLineResult {
  const passedLines: number[] = [];
  let parsedCount = 0;
  const lines = input.split(/\r\n|\r|\n/).map((line, i) => {
    if (!line.trim()) return line;
    const whole = parseDate(line, now);
    if (whole) {
      parsedCount += 1;
      return formatJapanese(whole);
    }
    let found = false;
    const replaced = line.replace(
      DATE_IN_TEXT,
      (match: string, text: string) => {
        const info = parseDate(text, now);
        if (!info) return match;
        found = true;
        parsedCount += 1;
        return formatJapanese(info);
      },
    );
    if (!found) passedLines.push(i + 1);
    return replaced;
  });
  return { output: lines.join("\n"), passedLines, parsedCount };
}

/**
 * 起算日から期限日までの日数（JST の暦日で数える）。期限日が起算日の翌日なら 1、同じ日なら 0、
 * 過ぎていれば負になる。時刻つきの入力も、その瞬間の JST での日付で数える。
 */
export function daysUntil(deadline: luxon.DateTime, start: luxon.DateTime) {
  // UTC+9 は固定オフセットで夏時間がないので、差はちょうど日数の倍数になる
  return Math.round(startOfDay(deadline).diff(startOfDay(start), "days").days);
}

function startOfDay(value: luxon.DateTime) {
  return value.setZone(TIME_ZONE).startOf("day");
}

/** 残り日数の表示。明日が期限なら「あと 1 日」、今日なら「本日中」、過ぎていれば「期限切れ（N 日超過）」。 */
export function formatDaysLeft(days: number): string {
  if (days > 0) return `あと ${days} 日`;
  if (days === 0) return "本日中";
  return `期限切れ（${-days} 日超過）`;
}
