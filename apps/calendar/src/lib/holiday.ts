/**
 * 日本の祝日・休日を「国民の祝日に関する法律」（1948 年 7 月 20 日施行）に沿って計算する。
 * 外部の API やデータは使わず、ブラウザ内だけで求める。
 * - 春分の日・秋分の日は天文計算の近似式で求める（1900〜2150 年）。正式な日付は前年 2 月の官報で決まるので、
 *   先の年は推計になる。
 * - 振替休日（1973 年 4 月 12 日〜）と国民の休日（1985 年 12 月 27 日〜）も含める。
 * - 即位の礼・大喪の礼などの一度だけの休日も含める。
 */

/** 法律の施行日。これより前の日付は祝日として扱わない。 */
const LAW_START = "1948-07-20";

/** 一度だけ休日になった日（皇室の慶弔など）。 */
const SPECIAL_HOLIDAYS: Record<string, string> = {
  "1959-04-10": "皇太子明仁親王の結婚の儀",
  "1989-02-24": "昭和天皇の大喪の礼",
  "1990-11-12": "即位礼正殿の儀",
  "1993-06-09": "皇太子徳仁親王の結婚の儀",
  "2019-05-01": "天皇の即位の日",
  "2019-10-22": "即位礼正殿の儀",
};

const cache = new Map<number, Map<string, string>>();

/** 祝日を計算できる最後の年（春分・秋分の近似式が使える範囲）。 */
export const LAST_YEAR = 2150;

/**
 * 指定した日の祝日・休日名を返す。祝日でなければ null。
 * LAST_YEAR より後は春分の日・秋分の日（とそれに伴う休日）が求められないので undefined（不明）を返す。
 */
export function holidayName(
  year: number,
  month: number,
  day: number,
): string | null | undefined {
  if (year > LAST_YEAR) return undefined;
  return holidaysOf(year).get(toKey(year, month, day)) ?? null;
}

/** その年の祝日・休日を「yyyy-mm-dd → 名前」で返す（日付順）。 */
export function holidaysOf(year: number): Map<string, string> {
  let holidays = cache.get(year);
  if (!holidays) {
    holidays = computeHolidays(year);
    cache.set(year, holidays);
  }
  return holidays;
}

function computeHolidays(year: number): Map<string, string> {
  const result = new Map<string, string>();
  if (year < 1948) return result;

  // 1. 国民の祝日
  const national = new Map<string, string>();
  const add = (month: number, day: number | null, name: string) => {
    if (day === null) return;
    const key = toKey(year, month, day);
    if (key >= LAW_START) national.set(key, name);
  };

  if (year >= 1949) add(1, 1, "元日");
  if (year >= 1949)
    add(1, year >= 2000 ? nthMonday(year, 1, 2) : 15, "成人の日");
  if (year >= 1967) add(2, 11, "建国記念の日");
  if (year >= 2020) add(2, 23, "天皇誕生日");
  if (year >= 1949) add(3, vernalEquinox(year), "春分の日");
  if (year >= 2007) add(4, 29, "昭和の日");
  else if (year >= 1989) add(4, 29, "みどりの日");
  else if (year >= 1949) add(4, 29, "天皇誕生日");
  if (year >= 1949) add(5, 3, "憲法記念日");
  if (year >= 2007) add(5, 4, "みどりの日");
  if (year >= 1949) add(5, 5, "こどもの日");
  // 2020・2021 年は東京オリンピック・パラリンピックのため海の日・スポーツの日・山の日が移動した
  if (year === 2020) add(7, 23, "海の日");
  else if (year === 2021) add(7, 22, "海の日");
  else if (year >= 2003) add(7, nthMonday(year, 7, 3), "海の日");
  else if (year >= 1996) add(7, 20, "海の日");
  if (year === 2020) add(7, 24, "スポーツの日");
  else if (year === 2021) add(7, 23, "スポーツの日");
  if (year === 2020) add(8, 10, "山の日");
  else if (year === 2021) add(8, 8, "山の日");
  else if (year >= 2016) add(8, 11, "山の日");
  if (year >= 2003) add(9, nthMonday(year, 9, 3), "敬老の日");
  else if (year >= 1966) add(9, 15, "敬老の日");
  add(9, autumnalEquinox(year), "秋分の日");
  if (year >= 2022) add(10, nthMonday(year, 10, 2), "スポーツの日");
  else if (year >= 2000 && year <= 2019)
    add(10, nthMonday(year, 10, 2), "体育の日");
  else if (year >= 1966 && year <= 1999) add(10, 10, "体育の日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  if (year >= 1989 && year <= 2018) add(12, 23, "天皇誕生日");
  for (const [key, name] of Object.entries(SPECIAL_HOLIDAYS)) {
    if (key.startsWith(`${year}-`)) national.set(key, name);
  }

  // 2. 国民の休日：前日と翌日がどちらも国民の祝日である、祝日でない日
  // （2006 年までは日曜日と振替休日を除く。振替休日の日曜日の翌日にはならないので、ここでは日曜日だけ除く）
  const rest = new Map<string, string>();
  if (year >= 1985) {
    for (const key of national.keys()) {
      const next = addDays(key, 1);
      if (national.has(next) || !national.has(addDays(key, 2))) continue;
      if (next < "1985-12-27" || !next.startsWith(`${year}-`)) continue;
      if (year <= 2006 && weekdayOf(next) === 0) continue;
      rest.set(next, "国民の休日");
    }
  }

  // 3. 振替休日：国民の祝日が日曜日に当たるとき
  // 2006 年までは翌日（月曜日）だけ、2007 年からはその後の最も近い祝日でない日
  const substitute = new Map<string, string>();
  for (const key of national.keys()) {
    if (weekdayOf(key) !== 0 || key < "1973-04-12") continue;
    let next = addDays(key, 1);
    if (year >= 2007) {
      while (national.has(next)) next = addDays(next, 1);
    } else if (national.has(next)) {
      continue;
    }
    substitute.set(next, "振替休日");
  }

  const all = new Map([...national, ...rest, ...substitute]);
  for (const key of [...all.keys()].toSorted()) {
    if (key.startsWith(`${year}-`)) result.set(key, all.get(key)!);
  }
  return result;
}

/** 春分日（3 月の日）。近似式が使えない年は null。 */
function vernalEquinox(year: number): number | null {
  if (year < 1900 || year > 2150) return null;
  const base = year <= 1979 ? 20.8357 : year <= 2099 ? 20.8431 : 21.851;
  return equinoxDay(year, base);
}

/** 秋分日（9 月の日）。近似式が使えない年は null。 */
function autumnalEquinox(year: number): number | null {
  if (year < 1900 || year > 2150) return null;
  const base = year <= 1979 ? 23.2588 : year <= 2099 ? 23.2488 : 24.2488;
  return equinoxDay(year, base);
}

function equinoxDay(year: number, base: number): number {
  // うるう年の補正は 0 方向への切り捨て（1979 年までは負の値になるので floor ではずれる）
  const leap = Math.trunc((year - (year <= 1979 ? 1983 : 1980)) / 4);
  return Math.floor(base + 0.242194 * (year - 1980) - leap);
}

/** month 月の第 n 月曜日の日。 */
function nthMonday(year: number, month: number, n: number): number {
  const first = weekdayOf(toKey(year, month, 1));
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

function toKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toUtc(key: string): Date {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  return utc;
}

/** 曜日（0 = 日曜日）。 */
function weekdayOf(key: string): number {
  return toUtc(key).getUTCDay();
}

function addDays(key: string, days: number): string {
  const utc = toUtc(key);
  utc.setUTCDate(utc.getUTCDate() + days);
  return toKey(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}
