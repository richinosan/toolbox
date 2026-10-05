// Package jpdate は calendar に入力された日付を解釈し、JST (UTC+09:00) で表示用に整える。
//
// goesm で JavaScript に変換してブラウザで動かす。標準ライブラリは読み込むだけで配信サイズが増える
// （time だけで gzip 約 +24 KiB）ため使わず、暦の計算も文字列の組み立てもこのパッケージ内で行う。
// 全角文字の正規化（NFKC）と前後の空白除去は、ブラウザの String.prototype.normalize / trim に任せる。
package jpdate

// Offset は日付のみの入力を解釈するタイムゾーン（固定オフセットの UTC+9）の秒数。
// Asia/Tokyo は 1888 年以前が地方平均時（UTC+09:18:59）になるため、固定オフセットを使う。
const Offset = 9 * 60 * 60

// JavaScript の Date が扱える範囲（±8.64e15 ミリ秒）。これを超える日時は解釈できないものとする。
const maxSeconds = 8_640_000_000_000

// Info は解釈した日時を JST で表したもの。
type Info struct {
	Year, Month, Day     int
	Hour, Minute, Second int
	// Weekday は曜日（0 が日曜）。
	Weekday int
	// Unix は UNIX 時間（秒、小数点以下は切り捨て）。
	Unix int
}

// Parse は日付の文字列を解釈する。text は NFKC 正規化と前後の空白除去を済ませたもの、now は今の UNIX 時間（秒）。
// 対応形式:
//   - 年月日（例: 2026年10月1日, 10月1日, 1日。年・月を省略すると今の年・月）
//   - 区切り（/ -）: 2026/10/1, 26/10/1, 10/1（年を省略すると今の年。区切り文字は揃える）
//   - 8 桁: 20261001, 6 桁: 261001（2 桁の年は 00〜59 → 20xx, 60〜99 → 19xx）
//   - ISO 8601（例: 2026-10-01, 2026-10-01T12:00:00Z, 2026-W40-4, 2026-274, 12:00）
//
// 日付のみの入力は JST の 00:00:00、オフセットのない日時は JST の時刻として扱う。
// 西暦 1 年より前と、解釈できない入力は ok が false。
func Parse(text string, now int) (info Info, ok bool) {
	unix, ok := parseText(text, now)
	if !ok {
		return Info{}, false
	}
	info = fromUnix(unix)
	if info.Year < 1 {
		return Info{}, false
	}
	return info, true
}

func parseText(text string, now int) (unix int, ok bool) {
	today := fromUnix(now)

	if y, m, d, matched := matchKanji(text); matched {
		if y < 0 {
			y = today.Year
		}
		if m < 0 {
			m = today.Month
		}
		return localDate(y, m, d)
	}

	// 区切りが揃っていないもの（2026/10-01）は、後の形式にも当てはまらないので解釈できない
	if y, m, d, matched := matchSeparated(text); matched {
		if y < 0 {
			y = today.Year
		}
		return localDate(y, m, d)
	}

	if len(text) == 8 && allDigits(text) {
		return localDate(atoi(text[:4]), atoi(text[4:6]), atoi(text[6:]))
	}
	if len(text) == 6 && allDigits(text) {
		return localDate(fullYear(text[:2]), atoi(text[2:4]), atoi(text[4:]))
	}

	// 時刻やオフセットを含む ISO 8601 はその瞬間として扱い、表示は JST に揃える
	return parseISO(text, now)
}

// matchKanji は「(yyyy年)(m月)d日」に当てはめる。省略した年・月は -1。
func matchKanji(s string) (y, m, d int, ok bool) {
	y, m = -1, -1
	i := 0
	if n := digitRun(s, i, 4); n == 4 && hasPrefixAt(s, i+n, "年") {
		y = atoi(s[i : i+n])
		i += n + len("年")
	}
	if n := digitRun(s, i, 2); n > 0 && hasPrefixAt(s, i+n, "月") {
		m = atoi(s[i : i+n])
		i += n + len("月")
	}
	n := digitRun(s, i, 2)
	if n == 0 || s[i+n:] != "日" {
		return 0, 0, 0, false
	}
	return y, m, atoi(s[i : i+n]), true
}

// matchSeparated は「(yy|yyyy 区切り) m 区切り d」に当てはめる。省略した年は -1。
func matchSeparated(s string) (y, m, d int, ok bool) {
	var parts [3]string
	var seps [2]byte
	count := 0
	start := 0
	for i := 0; i <= len(s); i++ {
		if i < len(s) && isDigit(s[i]) {
			continue
		}
		if count == len(parts) {
			return 0, 0, 0, false
		}
		parts[count] = s[start:i]
		if parts[count] == "" {
			return 0, 0, 0, false
		}
		count++
		if i == len(s) {
			break
		}
		if s[i] != '/' && s[i] != '-' || count > len(seps) {
			return 0, 0, 0, false
		}
		seps[count-1] = s[i]
		start = i + 1
	}
	short := func(p string) bool { return len(p) == 1 || len(p) == 2 }
	switch count {
	case 2:
		if short(parts[0]) && short(parts[1]) {
			return -1, atoi(parts[0]), atoi(parts[1]), true
		}
	case 3:
		if (len(parts[0]) == 2 || len(parts[0]) == 4) && short(parts[1]) && short(parts[2]) && seps[0] == seps[1] {
			return fullYear(parts[0]), atoi(parts[1]), atoi(parts[2]), true
		}
	}
	return 0, 0, 0, false
}

// fullYear は 2 桁の年を 00〜59 → 2000 年代、60〜99 → 1900 年代とする（4 桁ならそのまま）。
func fullYear(s string) int {
	y := atoi(s)
	if len(s) != 2 {
		return y
	}
	if y < 60 {
		return 2000 + y
	}
	return 1900 + y
}

// localDate は JST の y 年 m 月 d 日 00:00:00 の UNIX 時間を返す。
func localDate(y, m, d int) (int, bool) {
	if !validDate(y, m, d) {
		return 0, false
	}
	return instant(daysFromCivil(y, m, d)*86400, Offset)
}

// instant は壁時計の秒数（1970-01-01 00:00:00 からの経過）とオフセットから UNIX 時間を求める。
func instant(wall, offset int) (int, bool) {
	unix := wall - offset
	if abs(wall) > maxSeconds || abs(unix) > maxSeconds {
		return 0, false
	}
	return unix, true
}

// isoKind は ISO 8601 の日付の書き方。
type isoKind int

const (
	isoCalendar isoKind = iota // 2026-10-01
	isoWeek                    // 2026-W40-4
	isoOrdinal                 // 2026-274
	isoTimeOnly                // 12:00（日付は今日）
)

// isoParts は ISO 8601 の各部分。月・日・曜日の既定値は 1、時刻の既定値は 0。
type isoParts struct {
	kind             isoKind
	year, month, day int
	// ordinal は年内の通算日（1 始まり）。
	ordinal int
	// week は週番号、weekday は曜日（1 が月曜）。
	week, weekday        int
	hour, minute, second int
	// millisZero は小数秒をミリ秒に切り捨てると 0 になるか（24:00 を受け付けるかの判定に使う）。
	millisZero bool
	hasOffset  bool
	offset     int
}

// parseISO は luxon の DateTime.fromISO と同じ形式を受け付ける（[Asia/Tokyo] のような IANA タイムゾーン名は除く）。
func parseISO(s string, now int) (int, bool) {
	var p isoParts
	if !matchYMD(s, &p) && !matchWeek(s, &p) && !matchOrdinal(s, &p) && !matchTimeOnly(s, &p) {
		return 0, false
	}

	offset := Offset
	if p.hasOffset {
		offset = p.offset
	}

	// 形式に当てはまっても値が範囲外なら、ほかの形式は試さずに解釈できないものとする（luxon と同じ）
	var days int
	switch p.kind {
	case isoTimeOnly:
		// 日付は、入力の時刻を解釈するタイムゾーンでの今日
		days = floorDiv(now+offset, 86400)
	case isoWeek:
		if p.week < 1 || p.week > weeksInYear(p.year) || p.weekday < 1 || p.weekday > 7 {
			return 0, false
		}
		// 1 月 4 日を含む週がその年の第 1 週
		jan4 := daysFromCivil(p.year, 1, 4)
		days = jan4 - (isoWeekday(jan4) - 1) + (p.week-1)*7 + p.weekday - 1
	case isoOrdinal:
		if p.ordinal < 1 || p.ordinal > daysInYear(p.year) {
			return 0, false
		}
		days = daysFromCivil(p.year, 1, 1) + p.ordinal - 1
	default:
		if !validDate(p.year, p.month, p.day) {
			return 0, false
		}
		days = daysFromCivil(p.year, p.month, p.day)
	}

	// 24:00 は 24:00:00.000 のときだけ、翌日の 00:00 として受け付ける
	endOfDay := p.hour == 24 && p.minute == 0 && p.second == 0 && p.millisZero
	if p.hour > 23 && !endOfDay || p.minute > 59 || p.second > 59 {
		return 0, false
	}
	return instant(days*86400+p.hour*3600+p.minute*60+p.second, offset)
}

// matchYMD: ([+-]\d{6}|\d{4})(?:-?(\d\d)(?:-?(\d\d))?)? に任意の T 時刻が続く
func matchYMD(s string, p *isoParts) bool {
	p.kind = isoCalendar
	i := 0
	if len(s) > 0 && (s[0] == '+' || s[0] == '-') {
		if digitRun(s, 1, 6) != 6 {
			return false
		}
		p.year = atoi(s[1:7])
		if s[0] == '-' {
			p.year = -p.year
		}
		i = 7
	} else {
		if digitRun(s, 0, 4) != 4 {
			return false
		}
		p.year = atoi(s[:4])
		i = 4
	}

	if j := skipByte(s, i, '-'); digitRun(s, j, 2) == 2 {
		p.month = atoi(s[j : j+2])
		if k := skipByte(s, j+2, '-'); digitRun(s, k, 2) == 2 {
			p.day = atoi(s[k : k+2])
			if matchTimeExtension(s, k+2, p) {
				return true
			}
		}
		p.day = 1
		if matchTimeExtension(s, j+2, p) {
			return true
		}
	}
	p.month, p.day = 1, 1
	return matchTimeExtension(s, i, p)
}

// matchWeek: (\d{4})-?W(\d\d)(?:-?(\d))? に任意の T 時刻が続く
func matchWeek(s string, p *isoParts) bool {
	p.kind = isoWeek
	if digitRun(s, 0, 4) != 4 {
		return false
	}
	p.year = atoi(s[:4])
	i := skipByte(s, 4, '-')
	if i >= len(s) || s[i] != 'W' || digitRun(s, i+1, 2) != 2 {
		return false
	}
	p.week = atoi(s[i+1 : i+3])
	i += 3
	if j := skipByte(s, i, '-'); digitRun(s, j, 1) == 1 {
		p.weekday = atoi(s[j : j+1])
		if matchTimeExtension(s, j+1, p) {
			return true
		}
	}
	p.weekday = 1
	return matchTimeExtension(s, i, p)
}

// matchOrdinal: (\d{4})-?(\d{3}) に任意の T 時刻が続く
func matchOrdinal(s string, p *isoParts) bool {
	p.kind = isoOrdinal
	if digitRun(s, 0, 4) != 4 {
		return false
	}
	p.year = atoi(s[:4])
	i := skipByte(s, 4, '-')
	if digitRun(s, i, 3) != 3 {
		return false
	}
	p.ordinal = atoi(s[i : i+3])
	return matchTimeExtension(s, i+3, p)
}

// matchTimeOnly: 日付のない時刻（オフセットつきも可）
func matchTimeOnly(s string, p *isoParts) bool {
	p.kind = isoTimeOnly
	return matchTime(s, 0, p)
}

// matchTimeExtension: (?:[Tt]時刻)? で文字列が終わる
func matchTimeExtension(s string, i int, p *isoParts) bool {
	if i < len(s) && (s[i] == 'T' || s[i] == 't') && matchTime(s, i+1, p) {
		return true
	}
	p.hour, p.minute, p.second, p.millisZero, p.hasOffset = 0, 0, 0, true, false
	return i == len(s)
}

// matchTime: (\d\d)(?::?(\d\d)(?::?(\d\d)(?:[.,](\d{1,30}))?)?)? にオフセットが続いて文字列が終わる
func matchTime(s string, i int, p *isoParts) bool {
	if digitRun(s, i, 2) != 2 {
		return false
	}
	p.hour = atoi(s[i : i+2])
	p.minute, p.second, p.millisZero = 0, 0, true
	i += 2

	if j := skipByte(s, i, ':'); digitRun(s, j, 2) == 2 {
		p.minute = atoi(s[j : j+2])
		j += 2
		if k := skipByte(s, j, ':'); digitRun(s, k, 2) == 2 {
			p.second = atoi(s[k : k+2])
			k += 2
			if k < len(s) && (s[k] == '.' || s[k] == ',') {
				if n := digitRun(s, k+1, 30); n > 0 {
					// ミリ秒は小数第 3 位までを切り捨てで使う
					p.millisZero = s[k+1:k+1+min(n, 3)] == "000"[:min(n, 3)]
					if matchOffset(s, k+1+n, p) {
						return true
					}
					p.millisZero = true
				}
			}
			if matchOffset(s, k, p) {
				return true
			}
			p.second = 0
		}
		if matchOffset(s, j, p) {
			return true
		}
		p.minute = 0
	}
	return matchOffset(s, i, p)
}

// matchOffset: (?:[Zz]|[+-]\d\d(?::?\d\d)?)? で文字列が終わる
func matchOffset(s string, i int, p *isoParts) bool {
	p.hasOffset = false
	if i == len(s) {
		return true
	}
	switch s[i] {
	case 'Z', 'z':
		p.hasOffset, p.offset = true, 0
		return i+1 == len(s)
	case '+', '-':
		if digitRun(s, i+1, 2) != 2 {
			return false
		}
		hours := atoi(s[i+1 : i+3])
		minutes := 0
		if j := skipByte(s, i+3, ':'); digitRun(s, j, 2) == 2 && j+2 == len(s) {
			minutes = atoi(s[j : j+2])
		} else if i+3 != len(s) {
			return false
		}
		p.hasOffset, p.offset = true, (hours*60+minutes)*60
		if s[i] == '-' {
			p.offset = -p.offset
		}
		return true
	}
	return false
}

// WeekdayName は「木曜日」の形式の曜日を返す。
func (info Info) WeekdayName() string {
	return weekdayNames[info.Weekday] + "曜日"
}

// Japanese は「2026年10月01日(木)」の形式（年は 4 桁以上、月日は 2 桁、曜日は 1 文字）に整える。
func (info Info) Japanese() string {
	return pad(info.Year, 4) + "年" + pad(info.Month, 2) + "月" + pad(info.Day, 2) + "日(" + weekdayNames[info.Weekday] + ")"
}

// ISODate は「2026-10-01」の形式に整える（<input type="date"> の value に使う）。
// 10000 年以降は ISO 8601 の拡張形式（+010000-01-01）にする。
func (info Info) ISODate() string {
	year := pad(info.Year, 4)
	if info.Year > 9999 {
		year = "+" + pad(info.Year, 6)
	}
	return year + "-" + pad(info.Month, 2) + "-" + pad(info.Day, 2)
}

// DateTime は「2026-10-01 00:00:00」の形式に整える。
func (info Info) DateTime() string {
	return pad(info.Year, 4) + "-" + pad(info.Month, 2) + "-" + pad(info.Day, 2) + " " +
		pad(info.Hour, 2) + ":" + pad(info.Minute, 2) + ":" + pad(info.Second, 2)
}

// Today は now（UNIX 時間、秒）の JST での日付を「2026-10-01」の形式で返す。
func Today(now int) string {
	return fromUnix(now).ISODate()
}

var weekdayNames = [7]string{"日", "月", "火", "水", "木", "金", "土"}

// fromUnix は UNIX 時間を JST の日時に分解する。
func fromUnix(unix int) Info {
	wall := unix + Offset
	days := floorDiv(wall, 86400)
	secs := wall - days*86400
	y, m, d := civilFromDays(days)
	return Info{
		Year: y, Month: m, Day: d,
		Hour: secs / 3600, Minute: secs / 60 % 60, Second: secs % 60,
		Weekday: (isoWeekday(days)) % 7,
		Unix:    unix,
	}
}

// daysFromCivil は先発グレゴリオ暦の y 年 m 月 d 日の、1970-01-01 からの日数を返す。
// http://howardhinnant.github.io/date_algorithms.html#days_from_civil
func daysFromCivil(y, m, d int) int {
	if m <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	mp := (m + 9) % 12
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// civilFromDays は daysFromCivil の逆。
func civilFromDays(z int) (y, m, d int) {
	z += 719468
	era := floorDiv(z, 146097)
	doe := z - era*146097
	yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	d = doy - (153*mp+2)/5 + 1
	m = mp + 3
	if m > 12 {
		m -= 12
	}
	y = yoe + era*400
	if m <= 2 {
		y++
	}
	return y, m, d
}

// isoWeekday は 1970-01-01 からの日数の曜日を返す（1 が月曜、7 が日曜）。
func isoWeekday(days int) int {
	// 1970-01-01 は木曜日
	return floorMod(days+3, 7) + 1
}

// weeksInYear は ISO 8601 の週年 y の週数（52 か 53）を返す。12 月 28 日は必ず最終週に入る。
func weeksInYear(y int) int {
	dec28 := daysFromCivil(y, 12, 28)
	jan4 := daysFromCivil(y, 1, 4)
	return (dec28-(isoWeekday(dec28)-1)-(jan4-(isoWeekday(jan4)-1)))/7 + 1
}

func validDate(y, m, d int) bool {
	return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

func isLeap(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

func daysInYear(y int) int {
	if isLeap(y) {
		return 366
	}
	return 365
}

func daysInMonth(y, m int) int {
	switch m {
	case 2:
		if isLeap(y) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func floorMod(a, b int) int {
	return a - floorDiv(a, b)*b
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func isDigit(c byte) bool {
	return '0' <= c && c <= '9'
}

func allDigits(s string) bool {
	return digitRun(s, 0, len(s)) == len(s)
}

// digitRun は s[i:] の先頭から続く数字の数を、最大 limit 個まで数える。
func digitRun(s string, i, limit int) int {
	n := 0
	for i+n < len(s) && n < limit && isDigit(s[i+n]) {
		n++
	}
	return n
}

// skipByte は s[i] が c なら i+1、そうでなければ i を返す。
func skipByte(s string, i int, c byte) int {
	if i < len(s) && s[i] == c {
		return i + 1
	}
	return i
}

func hasPrefixAt(s string, i int, prefix string) bool {
	return len(s)-i >= len(prefix) && s[i:i+len(prefix)] == prefix
}

// atoi は数字だけの文字列を整数にする（呼び出し側で数字であることを確かめている）。
func atoi(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		n = n*10 + int(s[i]-'0')
	}
	return n
}

// pad は 0 以上の n を、width 桁に満たなければ先頭を 0 で埋めて文字列にする。
func pad(n, width int) string {
	var buf [24]byte
	i := len(buf)
	for n > 0 || len(buf)-i < width {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
