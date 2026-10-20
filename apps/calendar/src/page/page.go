//go:build js

// Package page は calendar のページの動き（入力の解釈と結果の表示、複数行の整形、コピー）。
// gosfc の go: import で index.astro から読み込み、Start を呼ぶ。
package page

import (
	"strconv"
	"syscall/js"
	"time"

	"toolbox.richinosan.com/apps/calendar/src/lib/jpdate"
	"toolbox.richinosan.com/packages/ui/src/web"
)

// Start はページを表示するたびに初期化するよう登録する。
func Start() {
	web.OnPageLoad(initPage)
}

// 選んだモードと残り日数のオン・オフだけを localStorage に覚えておく（入力した日付は保存しない）。
const (
	modeKey      = "toolbox:calendar:mode"
	multiDaysKey = "toolbox:calendar:multi-days"
)

func initPage() {
	text := web.Query("#date-text")
	// ClientRouter で他のページから遷移したときも呼ばれる（カレンダー以外のページでは何もしない）
	if text.IsNull() {
		return
	}
	picker := web.Query("#date-picker")
	pickerButton := web.Query("#date-picker-button")
	pickerLabel := web.Query("#date-picker-label")
	note := web.Query("#date-note")
	weekday := web.Query("#weekday")
	holidayValue := web.Query("#holiday")
	unixTime := web.Query("#unix-time")
	copyButton := web.Query("#copy-unix-time")
	startText := web.Query("#start-text")
	startPicker := web.Query("#start-picker")
	startPickerButton := web.Query("#start-picker-button")
	startPickerLabel := web.Query("#start-picker-label")
	startNote := web.Query("#start-note")
	daysLeft := web.Query("#days-left")

	dates := newDateFormat()

	// ネイティブの date input とボタンの表示を、テキスト入力の解釈結果に合わせる
	syncPicker := func(target, label js.Value, info jpdate.Info, ok bool) {
		if ok {
			target.Set("value", info.ISODate())
			label.Set("textContent", dates.format(info.Time))
		} else {
			target.Set("value", "")
			label.Set("textContent", dates.placeholder)
		}
		label.Get("classList").Call("toggle", "picker__label--empty", !ok)
	}

	initialised := false
	// 結果が変わったときだけ軽く動かす（初期表示では動かさない）
	setResult := func(el js.Value, value string) {
		if initialised && el.Get("textContent").String() != value {
			web.Play(el, "pop")
		}
		el.Set("textContent", value)
	}
	hint := "日付のみの場合は " + jpdate.TimeZoneLabel + " の 00:00:00 として計算します。"

	render := func() {
		now := time.Now()
		input := text.Get("value").String()
		info, ok := jpdate.Parse(input, now)
		nextWeekday, nextHoliday, nextUnixTime := "—", "—", "—"
		if ok {
			nextWeekday = info.Weekday
			nextUnixTime = strconv.FormatInt(info.Time.Unix(), 10)
			switch {
			case !info.HolidayKnown:
				nextHoliday = "不明（" + strconv.Itoa(jpdate.LastHolidayYear) + " 年まで対応）"
			case info.Holiday == "":
				nextHoliday = "なし"
			default:
				nextHoliday = info.Holiday
			}
		}
		setResult(weekday, nextWeekday)
		setResult(holidayValue, nextHoliday)
		holidayValue.Get("classList").Call("toggle", "result__holiday--none", info.Holiday == "")
		setResult(unixTime, nextUnixTime)
		copyButton.Set("disabled", !ok)
		syncPicker(picker, pickerLabel, info, ok)
		blank := isBlank(input)
		note.Get("classList").Call("toggle", "note--error", !ok && !blank)
		switch {
		case ok:
			note.Set("textContent", info.DateTime()+"（"+jpdate.TimeZoneLabel+"）として計算しています。")
		case !blank:
			note.Set("textContent", "日付として解釈できません。")
		default:
			note.Set("textContent", hint)
		}

		// 起算日は空欄なら今日として数える
		startInput := startText.Get("value").String()
		startInfo, startOK := jpdate.Parse(startInput, now)
		startValid := startOK || isBlank(startInput)
		start := now.In(jpdate.JST)
		if startOK {
			start = startInfo.Time
		}
		nextDaysLeft := "—"
		if ok && startValid {
			nextDaysLeft = jpdate.FormatDaysLeft(jpdate.DaysUntil(info.Time, start))
		}
		setResult(daysLeft, nextDaysLeft)
		syncPicker(startPicker, startPickerLabel, startInfo, startOK)
		startNote.Get("classList").Call("toggle", "note--error", !startValid)
		switch {
		case !startValid:
			startNote.Set("textContent", "起算日を日付として解釈できません。")
		case startOK:
			startNote.Set("textContent", "上の日付を期限として、"+dates.format(start)+" から数えています。")
		default:
			startNote.Set("textContent", "上の日付を期限として、今日 "+dates.format(start)+" から数えています。")
		}
	}

	web.Listen(text, "input", func(js.Value) { render() })
	showTooltip := web.Tooltip(web.Query("#copy-tooltip"))
	web.Listen(copyButton, "click", func(js.Value) {
		web.CopyText(unixTime.Get("textContent").String(), func() {
			// クリップボードが使えない環境では値を選択状態にして手動コピーに任せる
			js.Global().Call("getSelection").Call("selectAllChildren", unixTime)
		}, func(copied bool) { showTooltip(copiedMessage(copied)) })
	})

	// カレンダーで選んだ日付をテキスト入力に反映する（日付と起算日で共通）
	bindPicker := func(button, target, input js.Value) {
		web.Listen(button, "click", func(js.Value) {
			if !web.Try(func() { target.Call("showPicker") }) {
				// showPicker() に未対応のブラウザではネイティブ input をクリックして開く
				target.Call("click")
			}
		})
		web.Listen(target, "input", func(js.Value) {
			input.Set("value", target.Get("value"))
			render()
		})
	}
	bindPicker(pickerButton, picker, text)
	bindPicker(startPickerButton, startPicker, startText)
	web.Listen(startText, "input", func(js.Value) { render() })

	// 複数行モード：入力と同じ行に「yyyy年mm月dd日(曜)」で出力する
	modes := []struct {
		name          string
		button, panel js.Value
	}{
		{"single", web.Query("#mode-single"), web.Query("#single-panel")},
		{"multi", web.Query("#mode-multi"), web.Query("#multi-panel")},
	}
	multiInput := web.Query("#multi-input")
	multiOutput := web.Query("#multi-output")
	multiNote := web.Query("#multi-note")
	copyMulti := web.Query("#copy-multi")
	showMultiTooltip := web.Tooltip(web.Query("#copy-multi-tooltip"))

	setMode := func(mode string) {
		for _, m := range modes {
			m.button.Call("setAttribute", "aria-pressed", strconv.FormatBool(m.name == mode))
			m.panel.Set("hidden", m.name != mode)
		}
	}
	for _, m := range modes {
		web.Listen(m.button, "click", func(event js.Value) {
			setMode(m.name)
			// チュートリアルが表示のために押した場合（isTrusted が false）は、選択として覚えない
			if !event.Get("isTrusted").Bool() {
				return
			}
			web.LocalSet(modeKey, m.name)
			if m.name == "multi" {
				multiInput.Call("focus")
			}
		})
	}
	// localStorage が使えない環境では毎回「1件」から始める
	if mode, _ := web.LocalGet(modeKey); mode == "multi" {
		setMode("multi")
	} else {
		setMode("single")
	}

	// 残り日数を付けるかどうかも localStorage に覚えておく
	multiDays := web.Query("#multi-days")
	if v, _ := web.LocalGet(multiDaysKey); v == "on" {
		multiDays.Set("checked", true)
	}

	renderMulti := func() {
		now := time.Now()
		var daysFrom time.Time
		if multiDays.Get("checked").Bool() {
			daysFrom = now
		}
		input := multiInput.Get("value").String()
		result := jpdate.FormatLines(input, now, daysFrom)
		multiOutput.Set("value", result.Output)
		copyMulti.Set("disabled", isBlank(input))
		passed := ""
		if len(result.PassedLines) > 0 {
			for i, n := range result.PassedLines {
				if i > 0 {
					passed += "、"
				}
				passed += strconv.Itoa(n)
			}
			passed += " 行目は日付が見つからないので、そのまま出力しています。"
		}
		multiNote.Get("classList").Call("toggle", "note--error", result.ParsedCount == 0 && passed != "")
		switch {
		case result.ParsedCount > 0:
			multiNote.Set("textContent", strconv.Itoa(result.ParsedCount)+" 件を変換しました。"+passed)
		case passed != "":
			multiNote.Set("textContent", passed)
		default:
			multiNote.Set("textContent", "1 行に 1 つずつ日付を入力してください。日付のみの入力は "+jpdate.TimeZoneLabel+" として扱います。")
		}
	}
	web.Listen(multiDays, "change", func(event js.Value) {
		renderMulti()
		// チュートリアルなどスクリプトから切り替えた場合は覚えない
		if !event.Get("isTrusted").Bool() {
			return
		}
		if multiDays.Get("checked").Bool() {
			web.LocalSet(multiDaysKey, "on")
		} else {
			web.LocalSet(multiDaysKey, "off")
		}
	})
	web.Listen(multiInput, "input", func(js.Value) { renderMulti() })
	web.Listen(copyMulti, "click", func(js.Value) {
		web.CopyText(multiOutput.Get("value").String(), func() {
			// クリップボードが使えない環境では出力を選択状態にして手動コピーに任せる
			multiOutput.Call("select")
		}, func(copied bool) { showMultiTooltip(copiedMessage(copied)) })
	})
	renderMulti()

	today := jpdate.Today(time.Now())
	if text.Get("value").String() == "" {
		text.Set("value", today)
	}
	if startText.Get("value").String() == "" {
		startText.Set("value", today)
	}
	render()
	initialised = true
}

func copiedMessage(copied bool) string {
	if copied {
		return "コピーしました"
	}
	return "選択しました"
}

// isBlank は JavaScript の trim() で空になるか。
func isBlank(s string) bool {
	return js.Global().Get("String").New(s).Call("trim").String() == ""
}

// dateFormat は日付の表記をブラウザではなくサービスの言語設定（<html lang>）に合わせる。ja なら yyyy/mm/dd。
type dateFormat struct {
	intl        js.Value
	placeholder string
}

func newDateFormat() dateFormat {
	options := js.Global().Get("Object").New()
	options.Set("year", "numeric")
	options.Set("month", "2-digit")
	options.Set("day", "2-digit")
	options.Set("timeZone", "UTC")
	intl := js.Global().Get("Intl").Get("DateTimeFormat").New(web.Document().Get("documentElement").Get("lang"), options)
	placeholder := ""
	parts := intl.Call("formatToParts", js.Global().Get("Date").New(0))
	for i := 0; i < parts.Length(); i++ {
		part := parts.Index(i)
		switch part.Get("type").String() {
		case "year":
			placeholder += "yyyy"
		case "month":
			placeholder += "mm"
		case "day":
			placeholder += "dd"
		default:
			placeholder += part.Get("value").String()
		}
	}
	return dateFormat{intl: intl, placeholder: placeholder}
}

// format は t の JST での日付を表記する。
func (f dateFormat) format(t time.Time) string {
	y, m, d := t.In(jpdate.JST).Date()
	utc := js.Global().Get("Date").New(0)
	// Date.UTC は 0〜99 年を 1900 年代にずらすので setUTCFullYear で組み立てる
	utc.Call("setUTCFullYear", y, int(m)-1, d)
	out := ""
	parts := f.intl.Call("formatToParts", utc)
	for i := 0; i < parts.Length(); i++ {
		part := parts.Index(i)
		value := part.Get("value").String()
		// 年は 4 桁に揃える（Intl は 50 年を "50" と出すため）
		if part.Get("type").String() == "year" {
			for len(value) < 4 {
				value = "0" + value
			}
		}
		out += value
	}
	return out
}
