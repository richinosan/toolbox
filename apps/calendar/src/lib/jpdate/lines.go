package jpdate

import (
	"regexp"
	"time"
	"unicode/utf8"
)

// LinesResult は FormatLines の結果。
type LinesResult struct {
	// Output は入力と同じ行数の出力。日付の部分だけを整形し、それ以外の文字はそのまま残す。
	Output string
	// PassedLines は日付が見つからず、そのまま出力した行の番号（1 始まり。空行は含まない）。
	PassedLines []int
	// ParsedCount は整形した日付の数。
	ParsedCount int
}

// 文中から日付を探すときの形式。全角の数字・記号も受け付ける（解釈は Parse に任せる）。
// 「1日」や 8 桁の数字だけのような、文中では日付と決めにくい形式は行全体のときだけ扱う。
// Go の regexp には後読み・先読み・後方参照がないので、日付の前後の文字は scanDate で確かめる。
const d = `[0-9０-９]`

var (
	// 2026年10月1日, 10月1日
	inTextKanji = regexp.MustCompile(`^(?:` + d + `{4}年)?` + d + `{1,2}月` + d + `{1,2}日`)
	// 2026-10-01T12:00:00+09:00 などの ISO 8601（時刻つき）。オフセットは 1 番目のグループ
	inTextISO = regexp.MustCompile(`^` + d + `{4}[\-－]` + d + `{2}[\-－]` + d + `{2}[TＴ]` + d + `{2}[:：]` + d + `{2}(?:[:：]` + d + `{2}(?:[.．]` + d + `+)?)?([ZＺ]|[+＋\-－]` + d + `{2}[:：]?` + d + `{2})?`)
	// 2026/10/1, 26/10/1, 2026-10-01（区切り文字は同じ文字で揃える）
	inTextSeparated = regexp.MustCompile(`^(?:` + d + `{2}|` + d + `{4})(?:/` + d + `{1,2}/|／` + d + `{1,2}／|-` + d + `{1,2}-|－` + d + `{1,2}－)` + d + `{1,2}`)
	// 10/1
	inTextMonthDay = regexp.MustCompile(`^` + d + `{1,2}[/／]` + d + `{1,2}`)

	// 日付の後ろに書かれた曜日「(土)」「（日）」「(火・祝)」は付け直すので取り除く
	inTextWeekday = regexp.MustCompile(`^[ 　]*[(（][ 　]*[日月火水木金土](?:曜日?)?(?:[・･][ 　]*祝(?:日)?)?[ 　]*[)）]`)
	// 前に出力した残り日数「（あと 1 日）」「（本日中）」「（3 日超過）」も、貼り直したときに重ならないよう取り除く
	inTextDaysLeft = regexp.MustCompile(`^[ 　]*[(（][ 　]*(?:あと[ 　]*` + d + `+[ 　]*日|本日中|` + d + `+[ 　]*日超過)[ 　]*[)）]`)
)

// FormatLines は行ごとに日付を整形する。行全体が日付ならその行を、文の中に日付があればその部分だけを
// 「2026年10月01日(木)」の形式に置き換え、残りの文字はそのまま出力する。日付が見つからない行は何も変えずに出力する。
// daysFrom がゼロ値でなければ、その日を起算日とした残り日数を日付の後ろに「（あと 1 日）」のように付ける。
func FormatLines(input string, now, daysFrom time.Time) LinesResult {
	var result LinesResult
	format := func(info Info) string {
		if daysFrom.IsZero() {
			return info.Japanese()
		}
		return info.Japanese() + "（" + FormatDaysLeftShort(DaysUntil(info.Time, daysFrom)) + "）"
	}
	lines := splitLines(input)
	out := make([]byte, 0, len(input))
	for i, line := range lines {
		if i > 0 {
			out = append(out, '\n')
		}
		if trim(line) == "" {
			out = append(out, line...)
			continue
		}
		if info, ok := Parse(line, now); ok {
			result.ParsedCount++
			out = append(out, format(info)...)
			continue
		}
		found := false
		for pos := 0; pos < len(line); {
			start, coreEnd, end := scanDate(line, pos)
			if start < 0 {
				out = append(out, line[pos:]...)
				break
			}
			out = append(out, line[pos:start]...)
			if info, ok := Parse(line[start:coreEnd], now); ok {
				found = true
				result.ParsedCount++
				out = append(out, format(info)...)
			} else {
				out = append(out, line[start:end]...)
			}
			pos = end
		}
		if !found {
			result.PassedLines = append(result.PassedLines, i+1)
		}
	}
	result.Output = string(out)
	return result
}

// splitLines は \r\n、\r、\n のどれでも行を分ける。
func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\r':
			lines = append(lines, s[start:i])
			if i+1 < len(s) && s[i+1] == '\n' {
				i++
			}
			start = i + 1
		case '\n':
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	return append(lines, s[start:])
}

// scanDate は line の from 以降で最初に見つかる日付を探す。start〜coreEnd が日付、coreEnd〜end が
// 取り除く曜日・残り日数の括弧書き。見つからなければ start が -1。
// JavaScript の正規表現（後読み・先読みつき）と同じく、前後が数字や区切りに続く位置は日付としない。
// 後ろが続いてしまう場合は、括弧書きやオフセットを外した短い一致も順に試す。
func scanDate(line string, from int) (start, coreEnd, end int) {
	for start = from; start < len(line); {
		if r, _ := utf8.DecodeLastRuneInString(line[:start]); start == 0 || !isDateBefore(r) {
			rest := line[start:]
			for _, core := range coreEnds(rest) {
				for _, e := range suffixEnds(rest, core) {
					if !continuesDate(rest[e:]) {
						return start, start + core, start + e
					}
				}
			}
		}
		_, size := utf8.DecodeRuneInString(line[start:])
		start += size
	}
	return -1, -1, -1
}

// coreEnds は s の先頭にある日付の終わりの候補を、試す順に返す。
func coreEnds(s string) []int {
	var ends []int
	if m := inTextKanji.FindStringIndex(s); m != nil {
		ends = append(ends, m[1])
	}
	if m := inTextISO.FindStringSubmatchIndex(s); m != nil {
		ends = append(ends, m[1])
		if m[2] >= 0 {
			ends = append(ends, m[2])
		}
	}
	if m := inTextSeparated.FindStringIndex(s); m != nil {
		ends = append(ends, m[1])
	}
	if m := inTextMonthDay.FindStringIndex(s); m != nil {
		ends = append(ends, m[1])
	}
	return ends
}

// suffixEnds は日付 s[:core] の後ろの曜日・残り日数の括弧書きを含めた終わりの候補を、試す順
// （両方、曜日だけ、残り日数だけ、なし）に返す。
func suffixEnds(s string, core int) []int {
	var ends []int
	if w := inTextWeekday.FindStringIndex(s[core:]); w != nil {
		if l := inTextDaysLeft.FindStringIndex(s[core+w[1]:]); l != nil {
			ends = append(ends, core+w[1]+l[1])
		}
		ends = append(ends, core+w[1])
	}
	if l := inTextDaysLeft.FindStringIndex(s[core:]); l != nil {
		ends = append(ends, core+l[1])
	}
	return append(ends, core)
}

// isDateBefore は日付の直前にあると日付の一部とみなす文字か（数字・/・.・:）。
func isDateBefore(r rune) bool {
	return isDigit(r) || r == '/' || r == '／' || r == '.' || r == '．' || r == ':' || r == '：'
}

// continuesDate は s の先頭が日付の続き（数字・/・:、または . と数字）か。
func continuesDate(s string) bool {
	r, size := utf8.DecodeRuneInString(s)
	switch {
	case s == "":
		return false
	case isDigit(r) || r == '/' || r == '／' || r == ':' || r == '：':
		return true
	case r == '.' || r == '．':
		next, _ := utf8.DecodeRuneInString(s[size:])
		return isDigit(next)
	}
	return false
}

func isDigit(r rune) bool {
	return r >= '0' && r <= '9' || r >= '０' && r <= '９'
}
