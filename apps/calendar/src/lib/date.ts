import * as luxon from "luxon";

/** 日付のみの入力は常にこのタイムゾーンの 00:00:00 として解釈する。 */
export const TIME_ZONE = "Asia/Tokyo";
export const TIME_ZONE_LABEL = "Asia/Tokyo (UTC+09:00)";

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
 * - 8 桁: 20261001, 6 桁: 261001（2 桁の年は luxon の規則で 00〜59 → 20xx, 60〜99 → 19xx）
 * 全角数字・全角記号は半角として扱う。解釈できなければ null。
 */
export function parseDate(
  input: string,
  now = luxon.DateTime.now(),
): DateInfo | null {
  const text = input.normalize("NFKC").trim();
  if (!text) return null;

  const dateTime = parseText(text, now.setZone(TIME_ZONE));
  const weekday = dateTime?.setLocale("ja").weekdayLong;
  if (!dateTime?.isValid || !weekday) return null;

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
    if (year?.length === 2) {
      return luxon.DateTime.fromFormat(
        `${year}-${month}-${day}`,
        "yy-M-d",
        opts,
      );
    }
    return luxon.DateTime.fromObject(
      {
        year: year ? Number(year) : now.year,
        month: Number(month),
        day: Number(day),
      },
      opts,
    );
  }

  if (/^\d{8}$/.test(text))
    return luxon.DateTime.fromFormat(text, "yyyyMMdd", opts);
  if (/^\d{6}$/.test(text))
    return luxon.DateTime.fromFormat(text, "yyMMdd", opts);

  // 時刻やオフセットを含む ISO 8601 はその瞬間として扱い、表示は Asia/Tokyo に揃える
  const iso = luxon.DateTime.fromISO(text, opts);
  return iso.isValid ? iso.setZone(TIME_ZONE) : null;
}
