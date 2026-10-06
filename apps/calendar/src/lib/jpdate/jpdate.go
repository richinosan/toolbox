// Package jpdate は calendar に入力された日付を解釈し、JST (UTC+09:00) で表示用に整える。
//
// goesm で JavaScript に変換してブラウザで動かす。fmt は配信サイズが大きく増える（gzip 約 +37 KB、
// goesm v0.0.1-beta.4 で計測）ため使わない。全角文字の正規化（NFKC）と前後の空白除去は、
// ブラウザの String.prototype.normalize / trim に任せる（Go の標準ライブラリには NFKC がない）。
package jpdate

import (
	"regexp"
	"strconv"
	"time"
)

// jst は日付のみの入力を解釈するタイムゾーン。
// Asia/Tokyo は 1888 年以前が地方平均時（UTC+09:18:59）になるため、固定オフセットの UTC+9 を使う。
var jst = time.FixedZone("UTC+9", 9*60*60)

// JavaScript の Date が扱える範囲（±8.64e15 ミリ秒）。これを超える日時は解釈できないものとする。
const maxSeconds = 8_640_000_000_000

var (
	// 2026年10月1日, 10月1日, 1日
	kanjiDate = regexp.MustCompile(`^(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日$`)
	// 2026/10/1, 26/10/1, 10/1, 10-1
	separatedDate = regexp.MustCompile(`^(?:(\d{2}|\d{4})([/-]))?(\d{1,2})([/-])(\d{1,2})$`)
	// 20261001
	eightDigits = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})$`)
	// 261001
	sixDigits = regexp.MustCompile(`^(\d{2})(\d{2})(\d{2})$`)
)

// ISO 8601。luxon の DateTime.fromISO と同じ正規表現（[Asia/Tokyo] のような IANA タイムゾーン名は除く）。
const (
	isoTime          = `(\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d{1,30}))?)?)?(?:([Zz])|([+-]\d\d)(?::?(\d\d))?)?`
	isoTimeExtension = `(?:([Tt])` + isoTime + `)?`
)

var (
	isoCalendar = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-?(\d\d)(?:-?(\d\d))?)?` + isoTimeExtension + `$`)
	isoWeek     = regexp.MustCompile(`^(\d{4})-?W(\d\d)(?:-?(\d))?` + isoTimeExtension + `$`)
	isoOrdinal  = regexp.MustCompile(`^(\d{4})-?(\d{3})` + isoTimeExtension + `$`)
	isoTimeOnly = regexp.MustCompile(`^` + isoTime + `$`)
)

// DateInfo は JavaScript に渡す解釈結果。goesm はフィールドを json タグの名前のプレーンなオブジェクトにする。
type DateInfo struct {
	// JST での年月日
	Year  int `json:"year"`
	Month int `json:"month"`
	Day   int `json:"day"`
	// Weekday は「木曜日」の形式の曜日。
	Weekday string `json:"weekday"`
	// UnixTime は UNIX 時間（秒、小数点以下は切り捨て）。
	UnixTime int `json:"unixTime"`
	// ISODate は「2026-10-01」の形式（<input type="date"> の value）。
	ISODate string `json:"isoDate"`
	// DateTime は「2026-10-01 00:00:00」の形式（JST）。
	DateTime string `json:"dateTime"`
	// Japanese は「2026年10月01日(木)」の形式。
	Japanese string `json:"japanese"`
}

// ParseDate は日付の文字列を解釈する。text は NFKC 正規化と前後の空白除去を済ませたもの、now は今の UNIX 時間（秒）。
// 対応形式:
//   - 年月日（例: 2026年10月1日, 10月1日, 1日。年・月を省略すると今の年・月）
//   - 区切り（/ -）: 2026/10/1, 26/10/1, 10/1（年を省略すると今の年。区切り文字は揃える）
//   - 8 桁: 20261001, 6 桁: 261001（2 桁の年は 00〜59 → 20xx, 60〜99 → 19xx）
//   - ISO 8601（例: 2026-10-01, 2026-10-01T12:00:00Z, 2026-W40-4, 2026-274, 12:00）
//
// 日付のみの入力は JST の 00:00:00、オフセットのない日時は JST の時刻として扱う。
// 西暦 1 年より前と、解釈できない入力は ok が false。
func ParseDate(text string, now int) (info DateInfo, ok bool) {
	t, ok := parse(text, time.Unix(int64(now), 0).In(jst))
	if !ok {
		return DateInfo{}, false
	}
	t = t.In(jst)
	if t.Year() < 1 {
		return DateInfo{}, false
	}
	weekday := weekdayNames[t.Weekday()]
	return DateInfo{
		Year:     t.Year(),
		Month:    int(t.Month()),
		Day:      t.Day(),
		Weekday:  weekday + "曜日",
		UnixTime: int(t.Unix()),
		ISODate:  isoDate(t),
		DateTime: dateString(t, "-") + " " + pad(t.Hour(), 2) + ":" + pad(t.Minute(), 2) + ":" + pad(t.Second(), 2),
		Japanese: pad(t.Year(), 4) + "年" + pad(int(t.Month()), 2) + "月" + pad(t.Day(), 2) + "日(" + weekday + ")",
	}, true
}

// Today は now（UNIX 時間、秒）の JST での日付を「2026-10-01」の形式で返す。
func Today(now int) string {
	return isoDate(time.Unix(int64(now), 0).In(jst))
}

var weekdayNames = [7]string{"日", "月", "火", "水", "木", "金", "土"}

func parse(text string, now time.Time) (time.Time, bool) {
	if m := kanjiDate.FindStringSubmatch(text); m != nil {
		year, month := now.Year(), int(now.Month())
		if m[1] != "" {
			year = atoi(m[1])
		}
		if m[2] != "" {
			month = atoi(m[2])
		}
		return date(year, month, atoi(m[3]))
	}

	// 区切り文字は揃っている必要がある（2026/10-01 は後の形式にも当てはまらないので解釈できない）
	if m := separatedDate.FindStringSubmatch(text); m != nil && (m[2] == "" || m[2] == m[4]) {
		year := now.Year()
		if m[1] != "" {
			year = fullYear(m[1])
		}
		return date(year, atoi(m[3]), atoi(m[5]))
	}

	if m := eightDigits.FindStringSubmatch(text); m != nil {
		return date(atoi(m[1]), atoi(m[2]), atoi(m[3]))
	}
	if m := sixDigits.FindStringSubmatch(text); m != nil {
		return date(fullYear(m[1]), atoi(m[2]), atoi(m[3]))
	}

	// 時刻やオフセットを含む ISO 8601 はその瞬間として扱う（表示は呼び出し側で JST に揃える）
	return parseISO(text, now)
}

// date は JST の year 年 month 月 day 日 00:00:00 を返す。存在しない日付は ok が false。
func date(year, month, day int) (time.Time, bool) {
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, jst)
	if t.Year() != year || int(t.Month()) != month || t.Day() != day {
		return time.Time{}, false
	}
	return inRange(t)
}

// fullYear は 2 桁の年を 00〜59 → 2000 年代、60〜99 → 1900 年代とする（4 桁ならそのまま）。
func fullYear(s string) int {
	year := atoi(s)
	switch {
	case len(s) != 2:
		return year
	case year < 60:
		return 2000 + year
	default:
		return 1900 + year
	}
}

// parseISO は luxon の DateTime.fromISO と同じ順で形式を試す。形式に当てはまっても値が範囲外なら、
// ほかの形式は試さずに解釈できないものとする（luxon と同じ）。
func parseISO(text string, now time.Time) (time.Time, bool) {
	if m := isoCalendar.FindStringSubmatch(text); m != nil {
		year, month, day := atoi(m[1]), atoiOr(m[2], 1), atoiOr(m[3], 1)
		loc := zone(m[9:])
		if _, ok := date(year, month, day); !ok {
			return time.Time{}, false
		}
		return withTime(time.Date(year, time.Month(month), day, 0, 0, 0, 0, loc), m[4:9])
	}

	if m := isoWeek.FindStringSubmatch(text); m != nil {
		year, week, weekday := atoi(m[1]), atoi(m[2]), atoiOr(m[3], 1)
		if week < 1 || week > weeksInYear(year) || weekday < 1 || weekday > 7 {
			return time.Time{}, false
		}
		// 1 月 4 日を含む週がその年の第 1 週。その週の月曜日から数える
		jan4 := time.Date(year, time.January, 4, 0, 0, 0, 0, zone(m[9:]))
		monday := jan4.AddDate(0, 0, -(int(jan4.Weekday())+6)%7)
		return withTime(monday.AddDate(0, 0, (week-1)*7+weekday-1), m[4:9])
	}

	if m := isoOrdinal.FindStringSubmatch(text); m != nil {
		year, ordinal := atoi(m[1]), atoi(m[2])
		t := time.Date(year, time.January, ordinal, 0, 0, 0, 0, zone(m[8:]))
		if ordinal < 1 || t.Year() != year {
			return time.Time{}, false
		}
		return withTime(t, m[3:8])
	}

	if m := isoTimeOnly.FindStringSubmatch(text); m != nil {
		// 日付は、入力の時刻を解釈するタイムゾーンでの今日
		loc := zone(m[5:])
		year, month, day := now.In(loc).Date()
		return withTime(time.Date(year, month, day, 0, 0, 0, 0, loc), append([]string{"T"}, m[1:5]...))
	}

	return time.Time{}, false
}

// withTime は day（その日の 00:00）に時・分・秒を足す。clock は T、時、分、秒、小数秒の部分一致（T が空なら時刻なし）。
func withTime(day time.Time, clock []string) (time.Time, bool) {
	if clock[0] == "" {
		return inRange(day)
	}
	hour, minute, second := atoi(clock[1]), atoiOr(clock[2], 0), atoiOr(clock[3], 0)
	// ミリ秒は小数第 3 位までを切り捨てで使う。24:00 は 24:00:00.000 のときだけ翌日の 00:00 として受け付ける
	millis := atoi((clock[4] + "000")[:3])
	endOfDay := hour == 24 && minute == 0 && second == 0 && millis == 0
	if hour > 23 && !endOfDay || minute > 59 || second > 59 {
		return time.Time{}, false
	}
	return inRange(day.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute + time.Duration(second)*time.Second))
}

// zone はオフセットの部分一致（Z、±hh、mm）からタイムゾーンを返す。オフセットがなければ JST。
func zone(offset []string) *time.Location {
	switch {
	case offset[0] != "":
		return time.UTC
	case offset[1] != "":
		hours, minutes := atoi(offset[1][1:]), atoiOr(offset[2], 0)
		seconds := (hours*60 + minutes) * 60
		if offset[1][0] == '-' {
			seconds = -seconds
		}
		return time.FixedZone("", seconds)
	}
	return jst
}

// inRange は t が JavaScript の Date で扱える範囲（壁時計の時刻も含む）にあるかを確かめる。
func inRange(t time.Time) (time.Time, bool) {
	_, offset := t.Zone()
	unix := t.Unix()
	if abs(unix) > maxSeconds || abs(unix+int64(offset)) > maxSeconds {
		return time.Time{}, false
	}
	return t, true
}

// weeksInYear は ISO 8601 の週年 year の週数（52 か 53）を返す。12 月 28 日は必ず最終週に入る。
func weeksInYear(year int) int {
	_, week := time.Date(year, time.December, 28, 0, 0, 0, 0, time.UTC).ISOWeek()
	return week
}

// isoDate は「2026-10-01」の形式に整える。10000 年以降は ISO 8601 の拡張形式（+010000-01-01）にする。
func isoDate(t time.Time) string {
	if t.Year() > 9999 {
		return "+" + pad(t.Year(), 6) + dateString(t, "-")[len(strconv.Itoa(t.Year())):]
	}
	return dateString(t, "-")
}

// dateString は年（4 桁以上）・月・日（2 桁）を sep でつなぐ。
func dateString(t time.Time, sep string) string {
	return pad(t.Year(), 4) + sep + pad(int(t.Month()), 2) + sep + pad(t.Day(), 2)
}

// pad は 0 以上の n を、width 桁に満たなければ先頭を 0 で埋めて文字列にする。
func pad(n, width int) string {
	s := strconv.Itoa(n)
	for len(s) < width {
		s = "0" + s
	}
	return s
}

// atoi は正規表現で数字だけと確かめた文字列を整数にする（先頭の + / - も受け付ける）。
func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// atoiOr は s が空なら fallback を返す。
func atoiOr(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	return atoi(s)
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
