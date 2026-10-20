//go:build js

// Package outline はテキストを文字の形（パス）にする。保存のときと「パスに変換」のときだけ使う。
// フォントのファイルを fontkit で読み、グリフの輪郭を SVG のパスにする（fontkit は使うときだけ読み込む）。
package outline

import (
	"math"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
	"toolbox.richinosan.com/apps/image/src/web/textlayout"
)

//goesm:import "./lazy.ts" loadFontkit await
func loadFontkit() (js.Value, error)

// parsed は解析したフォント（Binary.Key ごと。解析できなかったものは null）。
var parsed = map[string]js.Value{}

func parse(fontkit js.Value, binary fonts.Binary) js.Value {
	if font, ok := parsed[binary.Key]; ok {
		return font
	}
	font := js.Null()
	func() {
		defer func() {
			if recover() != nil {
				font = js.Null()
			}
		}()
		name := js.Undefined()
		if binary.PostscriptName != "" {
			name = js.ValueOf(binary.PostscriptName)
		}
		result := fontkit.Call("create", js.Global().Get("Uint8Array").New(binary.Data), name)
		if collection := result.Get("fonts"); collection.Type() == js.TypeObject {
			if collection.Length() > 0 {
				font = collection.Index(0)
			}
		} else {
			font = result
		}
	}()
	parsed[binary.Key] = font
	return font
}

// round は 0.01 単位に丸める（Math.round と同じく .5 は +∞ の側）。
func round(value float64) float64 { return math.Floor(value*100+0.5) / 100 }

// toPath はグリフの輪郭（フォントの単位・上が正）を、レイヤーの座標の SVG パスにして b に足す。
func toPath(b []byte, glyph js.Value, x, baseline, scale float64) []byte {
	point := func(b []byte, args js.Value, i int) []byte {
		b = model.AppendNumber(b, round(x+args.Index(i).Float()*scale))
		b = append(b, ' ')
		return model.AppendNumber(b, round(baseline-args.Index(i+1).Float()*scale))
	}
	commands := glyph.Get("path").Get("commands")
	for i := range commands.Length() {
		command := commands.Index(i)
		args := command.Get("args")
		switch command.Get("command").String() {
		case "moveTo":
			b = point(append(b, 'M'), args, 0)
		case "lineTo":
			b = point(append(b, 'L'), args, 0)
		case "quadraticCurveTo":
			b = point(append(b, 'Q'), args, 0)
			b = point(append(b, ' '), args, 2)
		case "bezierCurveTo":
			b = point(append(b, 'C'), args, 0)
			b = point(append(b, ' '), args, 2)
			b = point(append(b, ' '), args, 4)
		case "closePath":
			b = append(b, 'Z')
		}
	}
	return b
}

type group struct {
	binary fonts.Binary
	text   string
}

// groupByBinary は同じフォントのファイルで描ける文字のまとまりに分ける（文字の範囲ごとにファイルが分かれているため）。
func groupByBinary(segment textlayout.Segment) ([]group, bool) {
	var groups []group
	for _, char := range segment.Text {
		binary, ok := fonts.BinaryFor(segment.Style.Font, segment.Style.Bold, char)
		if !ok {
			return nil, false
		}
		if n := len(groups); n > 0 && groups[n-1].binary.Key == binary.Key {
			groups[n-1].text += string(char)
		} else {
			groups = append(groups, group{binary, string(char)})
		}
	}
	return groups, true
}

// Build はテキストレイヤーのパス。フォントのデータが手に入らない文字があれば ok が false。待つので goroutine の中で呼ぶ。
func Build(layer *model.Layer) (outline *model.TextOutline, ok bool) {
	fontkit, err := loadFontkit()
	if err != nil {
		return nil, false
	}
	result := textlayout.Of(layer)
	parts := []model.Part{}
	for _, line := range result.Lines {
		start := textlayout.LineOffset(layer, line, result.Width)
		for _, segment := range line.Segments {
			groups, ok := groupByBinary(segment)
			if !ok {
				return nil, false
			}
			x := start + segment.X
			var d []byte
			synthetic := false
			for _, group := range groups {
				font := parse(fontkit, group.binary)
				if font.IsNull() {
					return nil, false
				}
				synthetic = synthetic || group.binary.Synthetic
				scale := segment.Style.Size / font.Get("unitsPerEm").Float()
				run := font.Call("layout", group.text)
				glyphs, positions := run.Get("glyphs"), run.Get("positions")
				for i := range glyphs.Length() {
					position := positions.Index(i)
					d = toPath(d, glyphs.Index(i),
						x+position.Get("xOffset").Float()*scale,
						line.Baseline-position.Get("yOffset").Float()*scale,
						scale)
					x += position.Get("xAdvance").Float() * scale
				}
			}
			if len(d) > 0 {
				parts = append(parts, model.Part{D: string(d), Color: segment.Style.Color, Bold: synthetic})
			}
		}
	}
	return &model.TextOutline{
		Key:    richtext.OutlineKey(layer),
		Width:  result.Width,
		Height: result.Height,
		Parts:  parts,
	}, true
}
