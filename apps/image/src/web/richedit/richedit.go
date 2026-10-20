//go:build js

// Package richedit は文字ごとに書式を持つテキストの編集欄（contenteditable）。
// DOM は「1 行 = 1 つの div、ラン = data-style を持つ span」の形で作り、入力のたびに DOM からランを読み直す。
// 書式の変更は DOM ではなくランに対して行い、作り直した DOM に選択範囲を戻す。
// 文字の位置は、ブラウザの選択範囲と同じく UTF-16 のコード単位で数える（改行も 1 文字）。
package richedit

import (
	"strconv"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
)

// Effects はキャンバス上で編集するときに見せる縁取りと影。
type Effects struct {
	StrokeColor string
	StrokeWidth float64
	Shadow      bool
}

// View は編集欄の見せ方。
type View struct {
	// Scale は文字の大きさの倍率（パネルでは見やすい大きさに縮め、キャンバス上では表示倍率に合わせる）。
	Scale      float64
	LineHeight float64
	// Effects はキャンバス上で編集するときだけ。
	Effects *Effects
}

var document = js.Global().Get("document")

// styles は data-style に書いた JSON から書式を引く（同じページで作ったもの）。
var styles = map[string]model.CharStyle{}

func styleOf(element js.Value) (model.CharStyle, bool) {
	if element.IsNull() || element.IsUndefined() {
		return model.CharStyle{}, false
	}
	span := element.Call("closest", "[data-style]")
	if span.IsNull() {
		return model.CharStyle{}, false
	}
	raw := span.Get("dataset").Get("style")
	if raw.Type() != js.TypeString || raw.String() == "" {
		return model.CharStyle{}, false
	}
	key := raw.String()
	if style, ok := styles[key]; ok {
		return style, true
	}
	// ほかのページから貼り付けた span など
	var style model.CharStyle
	ok := true
	func() {
		defer func() {
			if recover() != nil {
				ok = false
			}
		}()
		value := js.Global().Get("JSON").Call("parse", raw)
		style = model.CharStyle{
			Font:  fonts.ReadRef(value.Get("font")),
			Size:  value.Get("size").Float(),
			Color: value.Get("color").String(),
			Bold:  value.Get("bold").Truthy(),
		}
	}()
	return style, ok
}

func px(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) + "px" }

func applySpanStyle(span js.Value, style model.CharStyle, view View) {
	key := style.JSON()
	styles[key] = style
	span.Get("dataset").Set("style", key)
	s := span.Get("style")
	s.Set("fontFamily", fonts.CSSFamily(style.Font))
	s.Set("fontSize", px(style.Size*view.Scale))
	if style.Bold {
		s.Set("fontWeight", "700")
	} else {
		s.Set("fontWeight", "400")
	}
	s.Set("color", style.Color)
	s.Set("lineHeight", px(style.Size*view.Scale*view.LineHeight/100))
}

// Render はランを DOM にする。
func Render(element js.Value, runs []model.TextRun, view View) {
	lines := [][]model.TextRun{nil}
	for _, run := range runs {
		for i, piece := range strings.Split(run.Text, "\n") {
			if i > 0 {
				lines = append(lines, nil)
			}
			lines[len(lines)-1] = append(lines[len(lines)-1], model.TextRun{Text: piece, Style: run.Style})
		}
	}
	stroke := "0"
	if e := view.Effects; e != nil && e.StrokeWidth > 0 {
		stroke = px(e.StrokeWidth*2*view.Scale) + " " + e.StrokeColor
	}
	element.Get("style").Call("setProperty", "--stroke", stroke)
	element.Get("classList").Call("toggle", "rich--shadow", view.Effects != nil && view.Effects.Shadow)
	children := make([]any, 0, len(lines))
	for _, line := range lines {
		div := document.Call("createElement", "div")
		var parts []model.TextRun
		for _, p := range line {
			if p.Text != "" {
				parts = append(parts, p)
			}
		}
		if len(parts) == 0 {
			// 空の行も、その位置の書式の高さにする
			span := document.Call("createElement", "span")
			style := runs[0].Style
			if len(line) > 0 {
				style = line[0].Style
			}
			applySpanStyle(span, style, view)
			span.Call("append", document.Call("createElement", "br"))
			div.Call("append", span)
		}
		for _, p := range parts {
			span := document.Call("createElement", "span")
			applySpanStyle(span, p.Style, view)
			span.Set("textContent", p.Text)
			div.Call("append", span)
		}
		children = append(children, div)
	}
	element.Call("replaceChildren", children...)
}

const (
	textNode    = 3
	elementNode = 1
)

func tagName(node js.Value) string {
	if node.Get("nodeType").Int() != elementNode {
		return ""
	}
	return node.Get("tagName").String()
}

func isBlock(node js.Value) bool {
	tag := tagName(node)
	return tag == "DIV" || tag == "P"
}

func isText(node js.Value) bool { return node.Get("nodeType").Int() == textNode }

func childNodes(node js.Value) []js.Value {
	list := node.Get("childNodes")
	out := make([]js.Value, list.Length())
	for i := range out {
		out[i] = list.Index(i)
	}
	return out
}

const (
	kindText = iota
	// kindLine は行の始まり（2 行目以降）。node は行の要素。
	kindLine
	// kindBR は行の途中の <br>。
	kindBR
)

type unit struct {
	kind     int
	node     js.Value
	text     string
	style    model.CharStyle
	hasStyle bool
}

func (u unit) length() int { return richtext.Len(u.text) }

func contains(nodes []js.Value, node js.Value) bool {
	for _, n := range nodes {
		if n.Equal(node) {
			return true
		}
	}
	return false
}

// units は DOM の中身を、文字の並びとして順にたどる。
// 行（div）の区切りと <br> を改行にする。行の最後の <br> は空の行を保つためのものなので数えない。
func units(element js.Value) []unit {
	var out []unit
	var lines [][]js.Value
	var loose []js.Value
	for _, child := range childNodes(element) {
		if isBlock(child) {
			if len(loose) > 0 {
				lines = append(lines, loose)
			}
			loose = nil
			lines = append(lines, []js.Value{child})
		} else {
			loose = append(loose, child)
		}
	}
	if len(loose) > 0 {
		lines = append(lines, loose)
	}
	for index, nodes := range lines {
		if index > 0 {
			out = append(out, unit{kind: kindLine, node: nodes[0], text: "\n"})
		}
		var brs []js.Value
		var collect func(node js.Value)
		collect = func(node js.Value) {
			if tagName(node) == "BR" {
				brs = append(brs, node)
			}
			for _, child := range childNodes(node) {
				collect(child)
			}
		}
		for _, node := range nodes {
			collect(node)
		}
		trailing := js.Null()
		if len(brs) > 0 {
			trailing = brs[len(brs)-1]
		}
		var visit func(node js.Value)
		visit = func(node js.Value) {
			switch {
			case isText(node):
				style, ok := styleOf(node.Get("parentElement"))
				out = append(out, unit{
					kind:     kindText,
					node:     node,
					text:     strings.ReplaceAll(node.Get("textContent").String(), "​", ""),
					style:    style,
					hasStyle: ok,
				})
			case tagName(node) == "BR":
				if !node.Equal(trailing) {
					style, ok := styleOf(node.Get("parentElement"))
					out = append(out, unit{kind: kindBR, node: node, text: "\n", style: style, hasStyle: ok})
				}
			case isBlock(node) && !contains(nodes, node):
				// 行の中に入れ子の行があれば、改行として扱う
				out = append(out, unit{kind: kindLine, node: node, text: "\n"})
				for _, child := range childNodes(node) {
					visit(child)
				}
			default:
				for _, child := range childNodes(node) {
					visit(child)
				}
			}
		}
		for _, node := range nodes {
			visit(node)
		}
	}
	return out
}

// Read は DOM からランを読む。書式の無い文字（ブラウザが span の外に入れた文字）は直前の書式にする。
func Read(element js.Value, fallback model.CharStyle) []model.TextRun {
	var runs []model.TextRun
	current := fallback
	for _, u := range units(element) {
		if u.hasStyle {
			current = u.style
		}
		runs = append(runs, model.TextRun{Text: u.text, Style: current})
	}
	return richtext.Normalize(runs, fallback)
}

type point struct {
	node   js.Value
	offset int
}

func afterNode(node js.Value) point {
	parent := node.Get("parentNode")
	index := js.Global().Get("Array").Get("prototype").Get("indexOf").Call("call", parent.Get("childNodes"), node).Int()
	return point{parent, index + 1}
}

// offsetOf は DOM の位置を、文字の位置に直す。
func offsetOf(element, container js.Value, offset int) int {
	p := document.Call("createRange")
	p.Call("setStart", container, offset)
	p.Call("collapse", true)
	// (node, offset) が p と同じか前にあるとき true
	reached := func(node js.Value, at int) bool { return p.Call("comparePoint", node, at).Int() <= 0 }
	count := 0
	for _, u := range units(element) {
		switch u.kind {
		case kindText:
			if u.node.Equal(container) {
				return count + min(offset, u.length())
			}
			if !reached(u.node, u.node.Get("length").Int()) {
				return count
			}
			count += u.length()
		case kindLine:
			if !reached(u.node, 0) {
				return count
			}
			count++
		default:
			after := afterNode(u.node)
			if !reached(after.node, after.offset) {
				return count
			}
			count++
		}
	}
	return count
}

// GetSelection は選択範囲を、文字の位置（改行も 1 文字）で返す。編集欄の外なら ok が false。
func GetSelection(element js.Value) (start, end int, ok bool) {
	selection := document.Call("getSelection")
	if selection.IsNull() || selection.Get("rangeCount").Int() == 0 {
		return 0, 0, false
	}
	r := selection.Call("getRangeAt", 0)
	if !element.Call("contains", r.Get("startContainer")).Bool() || !element.Call("contains", r.Get("endContainer")).Bool() {
		return 0, 0, false
	}
	a := offsetOf(element, r.Get("startContainer"), r.Get("startOffset").Int())
	b := offsetOf(element, r.Get("endContainer"), r.Get("endOffset").Int())
	return min(a, b), max(a, b), true
}

// pointOf は文字の位置を DOM の位置に直す。
func pointOf(element js.Value, target int) point {
	count := 0
	var pending *point
	for _, u := range units(element) {
		if u.kind == kindText {
			if target <= count+u.length() {
				return point{u.node, target - count}
			}
			count += u.length()
			pending = nil
			continue
		}
		if pending != nil && target == count {
			return *pending
		}
		count++
		if u.kind == kindLine {
			pending = &point{u.node, 0}
		} else {
			after := afterNode(u.node)
			pending = &after
		}
	}
	if pending != nil && target == count {
		return *pending
	}
	return point{element, element.Get("childNodes").Length()}
}

// RangeOf は文字の位置の範囲を DOM の Range にする。
func RangeOf(element js.Value, start, end int) js.Value {
	a := pointOf(element, start)
	b := pointOf(element, end)
	r := document.Call("createRange")
	r.Call("setStart", a.node, a.offset)
	r.Call("setEnd", b.node, b.offset)
	return r
}

// SetSelection は文字の位置で選択範囲を戻す。
func SetSelection(element js.Value, start, end int) {
	selection := document.Call("getSelection")
	if selection.IsNull() {
		return
	}
	selection.Call("removeAllRanges")
	selection.Call("addRange", RangeOf(element, start, end))
}

// Length は文字の数（改行も 1 文字）。
func Length(element js.Value) int {
	sum := 0
	for _, u := range units(element) {
		sum += u.length()
	}
	return sum
}

// IsClean は DOM が Render で作った形のままか。ブラウザが span の外に文字を入れたり、
// 別の要素を入れたりしたときは false（作り直して見た目を書式に合わせる）。
func IsClean(element js.Value) bool {
	for _, line := range childNodes(element) {
		if tagName(line) != "DIV" {
			return false
		}
		for _, span := range childNodes(line) {
			if tagName(span) != "SPAN" {
				return false
			}
			if style := span.Get("dataset").Get("style"); style.Type() != js.TypeString || style.String() == "" {
				return false
			}
			for _, child := range childNodes(span) {
				if !isText(child) && tagName(child) != "BR" {
					return false
				}
			}
		}
	}
	return true
}
