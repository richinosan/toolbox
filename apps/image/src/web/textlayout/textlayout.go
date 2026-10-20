//go:build js

// Package textlayout はテキストレイヤーの行のレイアウト（canvas の measureText で測る）と描画。
package textlayout

import (
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
)

// Segment は行の中の、同じ書式の文字のまとまり。
type Segment struct {
	Text  string
	Style model.CharStyle
	// X は行の左端からの位置。
	X     float64
	Width float64
}

// Line は 1 行。
type Line struct {
	Segments []Segment
	Width    float64
	// Top は行の上端（テキストの枠の上端から）。
	Top    float64
	Height float64
	// Baseline はベースライン（テキストの枠の上端から）。
	Baseline float64
}

// Layout はテキストのレイアウト。
type Layout struct {
	Lines  []Line
	Width  float64
	Height float64
}

var measureContext js.Value

func measurer() js.Value {
	if measureContext.IsUndefined() {
		measureContext = js.Global().Get("document").Call("createElement", "canvas").Call("getContext", "2d")
	}
	return measureContext
}

type metric struct{ width, ascent, descent float64 }

// orDefault は JS の `value || fallback`（0 と NaN なら fallback）。
func orDefault(value js.Value, fallback float64) float64 {
	if value.Type() != js.TypeNumber {
		return fallback
	}
	v := value.Float()
	if v == 0 || math.IsNaN(v) {
		return fallback
	}
	return v
}

func metrics(style model.CharStyle, text string) metric {
	context := measurer()
	context.Set("font", fonts.FontString(style.Font, style.Size, style.Bold))
	sample := text
	if sample == "" {
		sample = "あ"
	}
	m := context.Call("measureText", sample)
	out := metric{
		ascent:  orDefault(m.Get("fontBoundingBoxAscent"), style.Size*0.88),
		descent: orDefault(m.Get("fontBoundingBoxDescent"), style.Size*0.12),
	}
	if text != "" {
		out.width = m.Get("width").Float()
	}
	return out
}

type part struct {
	text  string
	style model.CharStyle
}

type rawLine struct {
	parts []part
	style model.CharStyle
}

// splitLines はランを行に分ける。空の行も、その位置の書式で高さを持たせる。
func splitLines(runs []model.TextRun) []*rawLine {
	lines := []*rawLine{{style: runs[0].Style}}
	for _, run := range runs {
		for i, piece := range strings.Split(run.Text, "\n") {
			if i > 0 {
				lines = append(lines, &rawLine{style: run.Style})
			}
			line := lines[len(lines)-1]
			if piece != "" {
				line.parts = append(line.parts, part{piece, run.Style})
			}
			if len(line.parts) == 0 {
				line.style = run.Style
			}
		}
	}
	return lines
}

// Of はテキストレイヤーのレイアウト。
func Of(layer *model.Layer) Layout {
	var lines []Line
	top, width := 0.0, 0.0
	for _, line := range splitLines(layer.Runs) {
		x, ascent, descent, size := 0.0, 0.0, 0.0, 0.0
		var segments []Segment
		parts := line.parts
		if len(parts) == 0 {
			parts = []part{{"", line.style}}
		}
		for _, p := range parts {
			m := metrics(p.style, p.text)
			ascent = math.Max(ascent, m.ascent)
			descent = math.Max(descent, m.descent)
			size = math.Max(size, p.style.Size)
			if p.text != "" {
				segments = append(segments, Segment{Text: p.text, Style: p.style, X: x, Width: m.width})
				x += m.width
			}
		}
		height := math.Max(size*layer.LineHeight/100, 1)
		lines = append(lines, Line{
			Segments: segments,
			Width:    x,
			Top:      top,
			Height:   height,
			Baseline: top + (height-(ascent+descent))/2 + ascent,
		})
		top += height
		width = math.Max(width, x)
	}
	return Layout{
		Lines:  lines,
		Width:  math.Max(1, math.Ceil(math.Max(width, richtext.MaxSize(layer.Runs)*0.5))),
		Height: math.Max(1, math.Ceil(top)),
	}
}

// LineOffset は行の左端の位置（揃えに合わせる）。
func LineOffset(layer *model.Layer, line Line, width float64) float64 {
	switch layer.Align {
	case "left":
		return 0
	case "center":
		return (width - line.Width) / 2
	}
	return width - line.Width
}

// UsesOutline は使っているフォントがこの端末で使えず、保存されたパスで表示するとき true。
func UsesOutline(layer *model.Layer) bool {
	if layer.Outline == nil || layer.Outline.Key != richtext.OutlineKey(layer) {
		return false
	}
	for _, run := range layer.Runs {
		if fonts.Status(run.Style.Font) == fonts.Missing {
			return true
		}
	}
	return false
}

// Measure は枠の大きさ（縁取りと影は含まない）。
func Measure(layer *model.Layer) (width, height float64) {
	if UsesOutline(layer) {
		return layer.Outline.Width, layer.Outline.Height
	}
	result := Of(layer)
	return result.Width, result.Height
}

func shadow(context js.Value, size float64) {
	context.Set("shadowColor", "rgb(0 0 0 / 0.55)")
	context.Set("shadowBlur", size*0.12)
	context.Set("shadowOffsetX", size*0.04)
	context.Set("shadowOffsetY", size*0.06)
}

func noShadow(context js.Value) { context.Set("shadowColor", "transparent") }

// Draw はフォントで描く。
func Draw(context js.Value, layer *model.Layer, ox, oy float64) {
	result := Of(layer)
	size := richtext.MaxSize(layer.Runs)
	context.Set("textAlign", "left")
	context.Set("textBaseline", "alphabetic")
	context.Set("lineJoin", "round")
	context.Set("miterLimit", 2)
	each := func(paint func(segment Segment, x, y float64)) {
		for _, line := range result.Lines {
			start := ox + LineOffset(layer, line, result.Width)
			for _, segment := range line.Segments {
				context.Set("font", fonts.FontString(segment.Style.Font, segment.Style.Size, segment.Style.Bold))
				paint(segment, start+segment.X, oy+line.Baseline)
			}
		}
	}
	if layer.StrokeWidth > 0 {
		// 縁取りは文字の外側だけに見えるよう、太さの 2 倍で描いた上に塗りを重ねる
		if layer.Shadow {
			shadow(context, size)
		}
		context.Set("strokeStyle", layer.StrokeColor)
		context.Set("lineWidth", layer.StrokeWidth*2)
		each(func(segment Segment, x, y float64) { context.Call("strokeText", segment.Text, x, y) })
		noShadow(context)
	} else if layer.Shadow {
		shadow(context, size)
	}
	each(func(segment Segment, x, y float64) {
		context.Set("fillStyle", segment.Style.Color)
		context.Call("fillText", segment.Text, x, y)
	})
	noShadow(context)
}

// PartsOptions は DrawParts の指定。ScaleX・ScaleY が 0 なら 1。
type PartsOptions struct {
	StrokeColor    string
	StrokeWidth    float64
	Shadow         bool
	Size           float64
	OX, OY         float64
	ScaleX, ScaleY float64
}

// DrawParts はパス（保存されたパス・パスに変換したレイヤー）で描く。
func DrawParts(context js.Value, parts []model.Part, options PartsOptions) {
	path2D := js.Global().Get("Path2D")
	paths := make([]js.Value, len(parts))
	for i, p := range parts {
		paths[i] = path2D.New(p.D)
	}
	sx, sy := options.ScaleX, options.ScaleY
	if sx == 0 {
		sx = 1
	}
	if sy == 0 {
		sy = 1
	}
	context.Call("save")
	context.Call("translate", options.OX, options.OY)
	context.Call("scale", sx, sy)
	// 拡大・縮小しても線の太さは変えない
	lineScale := 1 / math.Max(0.01, math.Min(sx, sy))
	context.Set("lineJoin", "round")
	context.Set("miterLimit", 2)
	if options.StrokeWidth > 0 {
		if options.Shadow {
			shadow(context, options.Size)
		}
		context.Set("strokeStyle", options.StrokeColor)
		context.Set("lineWidth", options.StrokeWidth*2*lineScale)
		for _, path := range paths {
			context.Call("stroke", path)
		}
		noShadow(context)
	} else if options.Shadow {
		shadow(context, options.Size)
	}
	for i, p := range parts {
		context.Set("fillStyle", p.Color)
		context.Call("fill", paths[i])
		// 太字が無いフォントは、塗りと同じ色の線で太らせる（ブラウザの擬似太字に近づける）
		if p.Bold {
			context.Set("strokeStyle", p.Color)
			context.Set("lineWidth", options.Size*0.035*lineScale)
			context.Call("stroke", paths[i])
		}
	}
	noShadow(context)
	context.Call("restore")
}
