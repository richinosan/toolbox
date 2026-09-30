/** 入力日付は常にこのタイムゾーンの 00:00:00 として解釈する（JST は夏時間がないため固定オフセット）。 */
export const TIME_ZONE_LABEL = "Asia/Tokyo (UTC+09:00)";
const UTC_OFFSET_SECONDS = 9 * 60 * 60;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type DateInfo = {
  weekday: (typeof WEEKDAYS)[number];
  unixTime: number;
};

/** `<input type="date">` の値（YYYY-MM-DD）から曜日と Unix time（秒）を求める。不正な値なら null。 */
export function getDateInfo(value: string): DateInfo | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  // Date.UTC は 0〜99 年を 1900 年代として扱うため setUTCFullYear を使う
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // 2月30日のような繰り上がりや、Date が扱えない範囲を弾く
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const weekday = WEEKDAYS[date.getUTCDay()];
  if (!weekday) return null;
  return { weekday, unixTime: date.getTime() / 1000 - UTC_OFFSET_SECONDS };
}

/** 現在の Asia/Tokyo での日付を YYYY-MM-DD で返す。 */
export function todayInTimeZone(now = new Date()): string {
  return new Date(now.getTime() + UTC_OFFSET_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);
}
