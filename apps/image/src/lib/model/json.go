package model

import (
	"math"
	"strconv"
	"unicode/utf8"
)

// JSON の書き出し。作品ファイル（.tbimg）と、履歴・描画のキャッシュで状態を比べるキーに使う。
// encoding/json は配信サイズが大きいので使わず、JSON.stringify と同じ形を手で書く。

// AppendJSON はドキュメントを JSON にして b に足す。
func (d *Doc) AppendJSON(b []byte) []byte {
	b = append(b, `{"name":`...)
	b = appendString(b, d.Name)
	b = append(b, `,"width":`...)
	b = appendNumber(b, d.Width)
	b = append(b, `,"height":`...)
	b = appendNumber(b, d.Height)
	b = append(b, `,"background":`...)
	if d.Background == "" {
		b = append(b, "null"...)
	} else {
		b = appendString(b, d.Background)
	}
	b = append(b, `,"layers":[`...)
	for i, layer := range d.Layers {
		if i > 0 {
			b = append(b, ',')
		}
		b = layer.AppendJSON(b, true)
	}
	return append(b, "]}"...)
}

// JSON はドキュメントの JSON。
func (d *Doc) JSON() string { return string(d.AppendJSON(nil)) }

// AppendJSON はレイヤーを JSON にして b に足す。placement が false なら、描画結果に影響しない
// 値（id・名前・表示・不透明度・位置）を省く（描画のキャッシュのキー）。
func (l *Layer) AppendJSON(b []byte, placement bool) []byte {
	b = append(b, '{')
	if placement {
		b = append(b, `"id":`...)
		b = appendString(b, l.ID)
		b = append(b, `,"name":`...)
		b = appendString(b, l.Name)
		b = append(b, `,"visible":`...)
		b = strconv.AppendBool(b, l.Visible)
		b = append(b, `,"opacity":`...)
		b = appendNumber(b, l.Opacity)
		b = append(b, `,"x":`...)
		b = appendNumber(b, l.X)
		b = append(b, `,"y":`...)
		b = appendNumber(b, l.Y)
		b = append(b, ',')
	}
	b = append(b, `"width":`...)
	b = appendNumber(b, l.Width)
	b = append(b, `,"height":`...)
	b = appendNumber(b, l.Height)
	b = append(b, `,"filters":`...)
	b = l.Filters.appendJSON(b)
	b = append(b, `,"type":`...)
	b = appendString(b, l.Type)
	switch l.Type {
	case TypeImage:
		b = append(b, `,"asset":`...)
		b = appendString(b, l.Asset)
	case TypeRect, TypeEllipse:
		b = append(b, `,"fill":`...)
		b = appendString(b, l.Fill)
		b = append(b, `,"fillEnabled":`...)
		b = strconv.AppendBool(b, l.FillEnabled)
		b = append(b, `,"stroke":`...)
		b = appendString(b, l.Stroke)
		b = append(b, `,"strokeWidth":`...)
		b = appendNumber(b, l.StrokeWidth)
		b = append(b, `,"radius":`...)
		b = appendNumber(b, l.Radius)
	case TypeText:
		b = append(b, `,"runs":[`...)
		for i, run := range l.Runs {
			if i > 0 {
				b = append(b, ',')
			}
			b = append(b, `{"text":`...)
			b = appendString(b, run.Text)
			b = append(b, `,"style":`...)
			b = run.Style.appendJSON(b)
			b = append(b, '}')
		}
		b = append(b, `],"align":`...)
		b = appendString(b, l.Align)
		b = append(b, `,"lineHeight":`...)
		b = appendNumber(b, l.LineHeight)
		b = append(b, `,"strokeColor":`...)
		b = appendString(b, l.StrokeColor)
		b = append(b, `,"strokeWidth":`...)
		b = appendNumber(b, l.StrokeWidth)
		b = append(b, `,"shadow":`...)
		b = strconv.AppendBool(b, l.Shadow)
		b = append(b, `,"outline":`...)
		if l.Outline == nil {
			b = append(b, "null"...)
		} else {
			b = append(b, `{"key":`...)
			b = appendString(b, l.Outline.Key)
			b = append(b, `,"width":`...)
			b = appendNumber(b, l.Outline.Width)
			b = append(b, `,"height":`...)
			b = appendNumber(b, l.Outline.Height)
			b = append(b, `,"parts":`...)
			b = appendParts(b, l.Outline.Parts)
			b = append(b, '}')
		}
	case TypePath:
		b = append(b, `,"baseWidth":`...)
		b = appendNumber(b, l.BaseWidth)
		b = append(b, `,"baseHeight":`...)
		b = appendNumber(b, l.BaseHeight)
		b = append(b, `,"parts":`...)
		b = appendParts(b, l.Parts)
		b = append(b, `,"size":`...)
		b = appendNumber(b, l.Size)
		b = append(b, `,"strokeColor":`...)
		b = appendString(b, l.StrokeColor)
		b = append(b, `,"strokeWidth":`...)
		b = appendNumber(b, l.StrokeWidth)
		b = append(b, `,"shadow":`...)
		b = strconv.AppendBool(b, l.Shadow)
	}
	return append(b, '}')
}

func (f Filters) appendJSON(b []byte) []byte {
	b = append(b, `{"preset":`...)
	b = appendString(b, f.Preset)
	b = append(b, `,"brightness":`...)
	b = appendNumber(b, f.Brightness)
	b = append(b, `,"contrast":`...)
	b = appendNumber(b, f.Contrast)
	b = append(b, `,"saturation":`...)
	b = appendNumber(b, f.Saturation)
	b = append(b, `,"hue":`...)
	b = appendNumber(b, f.Hue)
	b = append(b, `,"tint":`...)
	b = appendString(b, f.Tint)
	b = append(b, `,"tintAmount":`...)
	b = appendNumber(b, f.TintAmount)
	b = append(b, `,"blur":`...)
	b = appendNumber(b, f.Blur)
	return append(b, '}')
}

func (s CharStyle) appendJSON(b []byte) []byte {
	b = append(b, `{"font":`...)
	b = s.Font.AppendJSON(b)
	b = append(b, `,"size":`...)
	b = appendNumber(b, s.Size)
	b = append(b, `,"color":`...)
	b = appendString(b, s.Color)
	b = append(b, `,"bold":`...)
	b = strconv.AppendBool(b, s.Bold)
	return append(b, '}')
}

// AppendJSON はフォントの指定を JSON にして b に足す。
func (f FontRef) AppendJSON(b []byte) []byte {
	b = append(b, `{"source":`...)
	b = appendString(b, f.Source)
	b = append(b, `,"id":`...)
	b = appendString(b, f.ID)
	b = append(b, `,"family":`...)
	b = appendString(b, f.Family)
	if f.Weights != nil {
		b = append(b, `,"weights":[`...)
		for i, w := range f.Weights {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendNumber(b, w)
		}
		b = append(b, ']')
	}
	if f.Faces != nil {
		b = append(b, `,"faces":{"regular":`...)
		b = appendString(b, f.Faces.Regular)
		if f.Faces.Bold != "" {
			b = append(b, `,"bold":`...)
			b = appendString(b, f.Faces.Bold)
		}
		b = append(b, '}')
	}
	return append(b, '}')
}

// JSON は書式の JSON（編集欄の span に書式を覚えさせるときに使う）。
func (s CharStyle) JSON() string { return string(s.appendJSON(nil)) }

func appendParts(b []byte, parts []Part) []byte {
	b = append(b, '[')
	for i, part := range parts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"d":`...)
		b = appendString(b, part.D)
		b = append(b, `,"color":`...)
		b = appendString(b, part.Color)
		b = append(b, `,"bold":`...)
		b = strconv.AppendBool(b, part.Bold)
		b = append(b, '}')
	}
	return append(b, ']')
}

// AppendNumber は JavaScript の数と同じ書き方で n を足す（NaN と ±Infinity は JSON.stringify と同じく null）。
func AppendNumber(b []byte, n float64) []byte { return appendNumber(b, n) }

func appendNumber(b []byte, n float64) []byte {
	switch {
	case math.IsNaN(n) || math.IsInf(n, 0):
		return append(b, "null"...)
	case n == 0:
		// -0 も JSON.stringify と同じく 0
		return append(b, '0')
	case n == math.Trunc(n) && math.Abs(n) < 1e21:
		return strconv.AppendFloat(b, n, 'f', 0, 64)
	}
	abs := math.Abs(n)
	if abs >= 1e21 || abs < 1e-6 {
		// JavaScript は指数の 0 埋めをしない（1e-7。Go は 1e-07）
		start := len(b)
		b = strconv.AppendFloat(b, n, 'e', -1, 64)
		for i := start; i < len(b); i++ {
			if b[i] == 'e' {
				j := i + 2
				k := j
				for k < len(b)-1 && b[k] == '0' {
					k++
				}
				return append(b[:j], b[k:]...)
			}
		}
		return b
	}
	return strconv.AppendFloat(b, n, 'f', -1, 64)
}

// AppendString は文字列を JSON の文字列にして b に足す。
func AppendString(b []byte, s string) []byte { return appendString(b, s) }

func appendString(b []byte, s string) []byte {
	const hex = "0123456789abcdef"
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"' || c == '\\':
				b = append(b, '\\', c)
			case c == '\n':
				b = append(b, '\\', 'n')
			case c == '\r':
				b = append(b, '\\', 'r')
			case c == '\t':
				b = append(b, '\\', 't')
			case c == '\b':
				b = append(b, '\\', 'b')
			case c == '\f':
				b = append(b, '\\', 'f')
			case c < 0x20:
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
			default:
				b = append(b, c)
			}
			i++
			continue
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		b = append(b, s[i:i+size]...)
		i += size
	}
	return append(b, '"')
}
