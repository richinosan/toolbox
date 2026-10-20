package jpdate

import "time"

// 日本の祝日・休日を「国民の祝日に関する法律」（1948 年 7 月 20 日施行）に沿って計算する。
// 外部の API やデータは使わず、ブラウザ内だけで求める。
//   - 春分の日・秋分の日は天文計算の近似式で求める（1900〜2150 年）。正式な日付は前年 2 月の官報で決まるので、
//     先の年は推計になる。
//   - 振替休日（1973 年 4 月 12 日〜）と国民の休日（1985 年 12 月 27 日〜）も含める。
//   - 即位の礼・大喪の礼などの一度だけの休日も含める。

// LastHolidayYear は祝日を計算できる最後の年（春分・秋分の近似式が使える範囲）。
const LastHolidayYear = 2150

// day は年月日を yyyymmdd の整数で表す（比較がそのまま日付の前後になる）。
type day int

func dayOf(year, month, d int) day { return day(year*10000 + month*100 + d) }

func (d day) year() int { return int(d) / 10000 }

func (d day) time() time.Time {
	return time.Date(int(d)/10000, time.Month(int(d)/100%100), int(d)%100, 0, 0, 0, 0, time.UTC)
}

func (d day) weekday() time.Weekday { return d.time().Weekday() }

func (d day) add(days int) day {
	y, m, dd := d.time().AddDate(0, 0, days).Date()
	return dayOf(y, int(m), dd)
}

// lawStart は法律の施行日。これより前の日付は祝日として扱わない。
const lawStart = day(19480720)

// specialHolidays は一度だけ休日になった日（皇室の慶弔など）。
var specialHolidays = []struct {
	day  day
	name string
}{
	{19590410, "皇太子明仁親王の結婚の儀"},
	{19890224, "昭和天皇の大喪の礼"},
	{19901112, "即位礼正殿の儀"},
	{19930609, "皇太子徳仁親王の結婚の儀"},
	{20190501, "天皇の即位の日"},
	{20191022, "即位礼正殿の儀"},
}

var holidayCache = map[int]map[day]string{}

// HolidayName は year 年 month 月 d 日の祝日・休日の名前を返す。祝日でなければ ""。
// LastHolidayYear より後は春分の日・秋分の日（とそれに伴う休日）が求められないので known が false（不明）。
func HolidayName(year, month, d int) (name string, known bool) {
	if year > LastHolidayYear {
		return "", false
	}
	holidays, ok := holidayCache[year]
	if !ok {
		holidays = computeHolidays(year)
		holidayCache[year] = holidays
	}
	return holidays[dayOf(year, month, d)], true
}

func computeHolidays(year int) map[day]string {
	result := map[day]string{}
	if year < 1948 {
		return result
	}

	// 1. 国民の祝日
	national := map[day]string{}
	add := func(month, d int, name string) {
		if d == 0 {
			return
		}
		if key := dayOf(year, month, d); key >= lawStart {
			national[key] = name
		}
	}

	if year >= 1949 {
		add(1, 1, "元日")
		if year >= 2000 {
			add(1, nthMonday(year, 1, 2), "成人の日")
		} else {
			add(1, 15, "成人の日")
		}
	}
	if year >= 1967 {
		add(2, 11, "建国記念の日")
	}
	if year >= 2020 {
		add(2, 23, "天皇誕生日")
	}
	if year >= 1949 {
		add(3, vernalEquinox(year), "春分の日")
	}
	switch {
	case year >= 2007:
		add(4, 29, "昭和の日")
	case year >= 1989:
		add(4, 29, "みどりの日")
	case year >= 1949:
		add(4, 29, "天皇誕生日")
	}
	if year >= 1949 {
		add(5, 3, "憲法記念日")
	}
	if year >= 2007 {
		add(5, 4, "みどりの日")
	}
	if year >= 1949 {
		add(5, 5, "こどもの日")
	}
	// 2020・2021 年は東京オリンピック・パラリンピックのため海の日・スポーツの日・山の日が移動した
	switch {
	case year == 2020:
		add(7, 23, "海の日")
		add(7, 24, "スポーツの日")
		add(8, 10, "山の日")
	case year == 2021:
		add(7, 22, "海の日")
		add(7, 23, "スポーツの日")
		add(8, 8, "山の日")
	case year >= 2003:
		add(7, nthMonday(year, 7, 3), "海の日")
	case year >= 1996:
		add(7, 20, "海の日")
	}
	if year >= 2016 && year != 2020 && year != 2021 {
		add(8, 11, "山の日")
	}
	switch {
	case year >= 2003:
		add(9, nthMonday(year, 9, 3), "敬老の日")
	case year >= 1966:
		add(9, 15, "敬老の日")
	}
	add(9, autumnalEquinox(year), "秋分の日")
	switch {
	case year >= 2022:
		add(10, nthMonday(year, 10, 2), "スポーツの日")
	case year >= 2000 && year <= 2019:
		add(10, nthMonday(year, 10, 2), "体育の日")
	case year >= 1966 && year <= 1999:
		add(10, 10, "体育の日")
	}
	add(11, 3, "文化の日")
	add(11, 23, "勤労感謝の日")
	if year >= 1989 && year <= 2018 {
		add(12, 23, "天皇誕生日")
	}
	for _, s := range specialHolidays {
		if s.day.year() == year {
			national[s.day] = s.name
		}
	}

	for key, name := range national {
		result[key] = name
	}

	// 2. 国民の休日：前日と翌日がどちらも国民の祝日である、祝日でない日
	// （2006 年までは日曜日と振替休日を除く。振替休日の日曜日の翌日にはならないので、ここでは日曜日だけ除く）
	if year >= 1985 {
		for key := range national {
			next := key.add(1)
			if _, ok := national[next]; ok {
				continue
			}
			if _, ok := national[key.add(2)]; !ok {
				continue
			}
			if next < 19851227 || next.year() != year {
				continue
			}
			if year <= 2006 && next.weekday() == time.Sunday {
				continue
			}
			result[next] = "国民の休日"
		}
	}

	// 3. 振替休日：国民の祝日が日曜日に当たるとき
	// 2006 年までは翌日（月曜日）だけ、2007 年からはその後の最も近い祝日でない日
	for key := range national {
		if key.weekday() != time.Sunday || key < 19730412 {
			continue
		}
		next := key.add(1)
		if year >= 2007 {
			for {
				if _, ok := national[next]; !ok {
					break
				}
				next = next.add(1)
			}
		} else if _, ok := national[next]; ok {
			continue
		}
		if next.year() == year {
			result[next] = "振替休日"
		}
	}
	return result
}

// vernalEquinox は春分日（3 月の日）。近似式が使えない年は 0。
func vernalEquinox(year int) int {
	switch {
	case year < 1900 || year > 2150:
		return 0
	case year <= 1979:
		return equinoxDay(year, 20.8357)
	case year <= 2099:
		return equinoxDay(year, 20.8431)
	}
	return equinoxDay(year, 21.851)
}

// autumnalEquinox は秋分日（9 月の日）。近似式が使えない年は 0。
func autumnalEquinox(year int) int {
	switch {
	case year < 1900 || year > 2150:
		return 0
	case year <= 1979:
		return equinoxDay(year, 23.2588)
	case year <= 2099:
		return equinoxDay(year, 23.2488)
	}
	return equinoxDay(year, 24.2488)
}

func equinoxDay(year int, base float64) int {
	// うるう年の補正は 0 方向への切り捨て（Go の整数の割り算と同じ）
	from := 1980
	if year <= 1979 {
		from = 1983
	}
	leap := (year - from) / 4
	v := base + 0.242194*float64(year-1980) - float64(leap)
	// floor（v は正なので切り捨てと同じだが、念のため負にも対応する）
	n := int(v)
	if float64(n) > v {
		n--
	}
	return n
}

// nthMonday は month 月の第 n 月曜日の日。
func nthMonday(year, month, n int) int {
	first := int(dayOf(year, month, 1).weekday())
	return 1 + (8-first)%7 + (n-1)*7
}
