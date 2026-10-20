// Package richtext は文字ごとに書式を持つテキスト（ラン）の操作。
// 文字の位置（offset）は、ブラウザの選択範囲と同じく UTF-16 のコード単位で数える（改行も 1 文字）。
// サロゲートペアの途中を指す offset は、その文字の前として扱う（Go の文字列は片方だけのサロゲートを持てないため）。
package richtext

import (
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"toolbox.richinosan.com/apps/image/src/lib/model"
)

// SameStyle は同じ書式か。
func SameStyle(a, b model.CharStyle) bool {
	return a.Font.Same(b.Font) && a.Size == b.Size && a.Color == b.Color && a.Bold == b.Bold
}

// PlainText はランの文字をつなげたもの。
func PlainText(runs []model.TextRun) string {
	var b strings.Builder
	for _, run := range runs {
		b.WriteString(run.Text)
	}
	return b.String()
}

// Len は s の長さ（UTF-16 のコード単位）。
func Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// byteOffset は UTF-16 の位置 offset に当たる s のバイト位置（0〜len(s) に収める）。
func byteOffset(s string, offset int) int {
	if offset <= 0 {
		return 0
	}
	n := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if n+w > offset {
			return i
		}
		n += w
	}
	return len(s)
}

// slice は String.prototype.slice(start, end) と同じ（UTF-16 の位置）。
func slice(s string, start, end int) string {
	a := byteOffset(s, start)
	b := byteOffset(s, end)
	if b < a {
		return ""
	}
	return s[a:b]
}

// Normalize は空のランを除き、同じ書式で隣り合うランをまとめる。空になったら最初の書式（無ければ fallback）で空文字を 1 つ残す。
func Normalize(runs []model.TextRun, fallback model.CharStyle) []model.TextRun {
	var out []model.TextRun
	for _, run := range runs {
		if run.Text == "" {
			continue
		}
		if n := len(out); n > 0 && SameStyle(out[n-1].Style, run.Style) {
			out[n-1].Text += run.Text
		} else {
			out = append(out, model.TextRun{Text: run.Text, Style: run.Style})
		}
	}
	if len(out) > 0 {
		return out
	}
	style := fallback
	if len(runs) > 0 {
		style = runs[0].Style
	}
	return []model.TextRun{{Text: "", Style: style}}
}

// StyleAt は offset の位置の文字の書式（offset が末尾なら最後の文字）。
func StyleAt(runs []model.TextRun, offset int) model.CharStyle {
	position := 0
	for _, run := range runs {
		length := Len(run.Text)
		if offset < position+length {
			return run.Style
		}
		position += length
	}
	if len(runs) == 0 {
		return model.CharStyle{}
	}
	return runs[len(runs)-1].Style
}

// StylesIn は start〜end の文字の書式（start >= end なら全体）。
func StylesIn(runs []model.TextRun, start, end int) []model.CharStyle {
	var out []model.CharStyle
	if start >= end {
		for _, run := range runs {
			out = append(out, run.Style)
		}
		return out
	}
	position := 0
	for _, run := range runs {
		runStart := position
		position += Len(run.Text)
		if position > start && runStart < end {
			out = append(out, run.Style)
		}
	}
	if len(out) > 0 {
		return out
	}
	return []model.CharStyle{StyleAt(runs, start)}
}

// ApplyStyle は start〜end の文字（start >= end なら全体）の書式を patch で変える。結果は Normalize する。
func ApplyStyle(runs []model.TextRun, start, end int, patch func(*model.CharStyle)) []model.TextRun {
	patched := func(style model.CharStyle) model.CharStyle {
		patch(&style)
		return style
	}
	all := start >= end
	var out []model.TextRun
	position := 0
	for _, run := range runs {
		runStart := position
		runEnd := position + Len(run.Text)
		position = runEnd
		if all {
			out = append(out, model.TextRun{Text: run.Text, Style: patched(run.Style)})
			continue
		}
		a := max(start, runStart)
		b := min(end, runEnd)
		if a >= b {
			out = append(out, run)
			continue
		}
		if a > runStart {
			out = append(out, model.TextRun{Text: slice(run.Text, 0, a-runStart), Style: run.Style})
		}
		out = append(out, model.TextRun{Text: slice(run.Text, a-runStart, b-runStart), Style: patched(run.Style)})
		if b < runEnd {
			out = append(out, model.TextRun{Text: slice(run.Text, b-runStart, runEnd-runStart), Style: run.Style})
		}
	}
	var fallback model.CharStyle
	if len(runs) > 0 {
		fallback = runs[0].Style
	}
	return Normalize(out, fallback)
}

// jsRound は JavaScript の Math.round（.5 は +∞ 側へ）。
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// ScaleRuns はすべての文字の大きさを scale 倍にする（0.1 px 単位に丸め、1 px 以上）。
func ScaleRuns(runs []model.TextRun, scale float64) []model.TextRun {
	out := make([]model.TextRun, len(runs))
	for i, run := range runs {
		style := run.Style
		style.Size = math.Max(1, jsRound(run.Style.Size*scale*10)/10)
		out[i] = model.TextRun{Text: run.Text, Style: style}
	}
	return out
}

// MaxSize は一番大きな文字の大きさ（1 以上）。
func MaxSize(runs []model.TextRun) float64 {
	size := 1.0
	for _, run := range runs {
		size = math.Max(size, run.Style.Size)
	}
	return size
}

// Usage は使っているフォント（と太字）ごとの、そのフォントで使う文字。
type Usage struct {
	Font model.FontRef
	Bold bool
	Text string
}

// FontUsage は使っているフォント（重複なし、現れた順）と、そのフォントで使う文字。
func FontUsage(runs []model.TextRun) []Usage {
	var out []Usage
	index := map[string]int{}
	for _, run := range runs {
		key := run.Style.Font.Key() + "|" + strconv.FormatBool(run.Style.Bold)
		i, ok := index[key]
		if !ok {
			i = len(out)
			index[key] = i
			out = append(out, Usage{Font: run.Style.Font, Bold: run.Style.Bold})
		}
		out[i].Text += run.Text
	}
	return out
}

// OutlineKey はパスが今の文字と書式で作られたものか確かめるためのキー（TypeScript 版の JSON.stringify と同じ形）。
func OutlineKey(layer *model.Layer) string {
	b := []byte("[[")
	for i, run := range layer.Runs {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = appendJSONString(b, run.Text)
		b = append(b, ',')
		b = appendJSONString(b, run.Style.Font.Key())
		b = append(b, ',')
		b = appendJSONNumber(b, run.Style.Size)
		b = append(b, ',')
		b = appendJSONString(b, run.Style.Color)
		b = append(b, ',')
		b = strconv.AppendBool(b, run.Style.Bold)
		b = append(b, ']')
	}
	b = append(b, "],"...)
	b = appendJSONString(b, layer.Align)
	b = append(b, ',')
	b = appendJSONNumber(b, layer.LineHeight)
	b = append(b, ']')
	return string(b)
}

// appendJSONString は JSON.stringify と同じ書き方の文字列（\b \f も短い形で書く）。
func appendJSONString(b []byte, s string) []byte {
	const hex = "0123456789abcdef"
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				// 壊れた UTF-8 は U+FFFD にする
				b = append(b, "�"...)
			} else {
				b = append(b, s[i:i+size]...)
			}
			i += size
			continue
		}
		switch c {
		case '"', '\\':
			b = append(b, '\\', c)
		case '\b':
			b = append(b, '\\', 'b')
		case '\f':
			b = append(b, '\\', 'f')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			if c < 0x20 {
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			} else {
				b = append(b, c)
			}
		}
		i++
	}
	return append(b, '"')
}

// appendJSONNumber は JSON.stringify と同じ書き方の数（NaN と ±Infinity は null）。
func appendJSONNumber(b []byte, n float64) []byte {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return append(b, "null"...)
	}
	return appendJSNumber(b, n)
}

// appendJSNumber は String(n) と同じ書き方の数。
func appendJSNumber(b []byte, n float64) []byte {
	switch {
	case math.IsNaN(n):
		return append(b, "NaN"...)
	case math.IsInf(n, 1):
		return append(b, "Infinity"...)
	case math.IsInf(n, -1):
		return append(b, "-Infinity"...)
	case n == 0:
		return append(b, '0') // -0 も "0"
	}
	if abs := math.Abs(n); abs >= 1e-6 && abs < 1e21 {
		return strconv.AppendFloat(b, n, 'f', -1, 64)
	}
	// 指数表記。Go は 1e-07 のように 2 桁にするので、JavaScript と同じく 1e-7 にする
	s := strconv.FormatFloat(n, 'e', -1, 64)
	e := strings.IndexByte(s, 'e')
	mantissa, sign, digits := s[:e], s[e+1], strings.TrimLeft(s[e+2:], "0")
	b = append(b, mantissa...)
	return append(append(append(b, 'e'), sign), digits...)
}

// pathNumber は d[i:] の先頭が数（JavaScript の /-?[\d.]+(?:e-?\d+)?/）なら、その長さ。数でなければ 0。
// regexp は変換後のスクリプトを大きくするので、手で読む。
func pathNumber(d string, i int) int {
	isDigit := func(j int) bool { return j < len(d) && d[j] >= '0' && d[j] <= '9' }
	j := i
	if j < len(d) && d[j] == '-' {
		j++
	}
	start := j
	for j < len(d) && (isDigit(j) || d[j] == '.') {
		j++
	}
	if j == start {
		return 0
	}
	if j < len(d) && d[j] == 'e' {
		k := j + 1
		if k < len(d) && d[k] == '-' {
			k++
		}
		if isDigit(k) {
			for isDigit(k) {
				k++
			}
			j = k
		}
	}
	return j - i
}

// jsNumber は Number(s)（パスの数の部分に限る）。数として読めなければ NaN。
func jsNumber(s string) float64 {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(v, 0) {
		return math.NaN()
	}
	return v
}

// ScalePath は SVG のパスの座標をすべて scale 倍にする（0.01 単位に丸める）。
// 座標はすべて絶対座標なので、数を掛けるだけでよい。
func ScalePath(d string, scale float64) string {
	var b []byte
	for i := 0; i < len(d); {
		n := pathNumber(d, i)
		if n == 0 {
			b = append(b, d[i])
			i++
			continue
		}
		b = appendJSNumber(b, jsRound(jsNumber(d[i:i+n])*scale*100)/100)
		i += n
	}
	return string(b)
}

// ScaleOutline は拡大・縮小したテキストに合わせて、保存されたパスも拡大・縮小する（Key は呼び出し側で付け直す）。
func ScaleOutline(outline model.TextOutline, scale float64) model.TextOutline {
	parts := make([]model.Part, len(outline.Parts))
	for i, part := range outline.Parts {
		part.D = ScalePath(part.D, scale)
		parts[i] = part
	}
	return model.TextOutline{
		Width:  math.Max(1, jsRound(outline.Width*scale)),
		Height: math.Max(1, jsRound(outline.Height*scale)),
		Parts:  parts,
	}
}

// Overflow は縁取りと影が枠の外にはみ出す幅。
func Overflow(strokeWidth float64, shadow bool, size float64) float64 {
	extra := 0.0
	if shadow {
		extra = float64(size * 0.25)
	}
	return math.Ceil(strokeWidth + extra + float64(size*0.1))
}
