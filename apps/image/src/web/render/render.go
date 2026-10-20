//go:build js

// Package render はレイヤーの描画。レイヤーごとにフィルター込みの画像を作ってキャッシュし、それを重ねて 1 枚にする。
package render

import (
	"math"
	"strconv"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/filters"
	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/assets"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
	"toolbox.richinosan.com/apps/image/src/web/textlayout"
)

// FitText はテキストの内容や大きさが変わったとき、枠の大きさを測り直す。
// 左揃えは左端、中央揃えは中心、右揃えは右端の位置を保つ。変わったら true。
func FitText(layer *model.Layer) bool {
	width, height := textlayout.Measure(layer)
	if width == layer.Width && height == layer.Height {
		return false
	}
	anchor := 1.0
	switch layer.Align {
	case "left":
		anchor = 0
	case "center":
		anchor = 0.5
	}
	layer.X = jsRound(layer.X + (layer.Width-width)*anchor)
	layer.Width = width
	layer.Height = height
	return true
}

// jsRound は JS の Math.round（.5 は大きい方へ）。
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

// LoadFonts はテキストで使うフォントを読み込む（文字の範囲ごとに分かれたファイルの、必要な分だけ）。
// 並行して読み込み、すべて終わるまで待つ。goroutine の中で呼ぶ。
func LoadFonts(layer *model.Layer) {
	usage := richtext.FontUsage(layer.Runs)
	done := make(chan struct{}, len(usage))
	for _, u := range usage {
		go func() {
			fonts.Ensure(u.Font, u.Bold, u.Text)
			done <- struct{}{}
		}()
	}
	for range usage {
		<-done
	}
}

func textPad(layer *model.Layer, size float64) float64 {
	return richtext.Overflow(layer.StrokeWidth, layer.Shadow, size)
}

// PathSize は拡大・縮小したパスの、一番大きな文字の大きさ。
func PathSize(layer *model.Layer) float64 {
	return layer.Size * math.Min(layer.Width/layer.BaseWidth, layer.Height/layer.BaseHeight)
}

func drawShape(context js.Value, layer *model.Layer, ox, oy float64) {
	// 線は図形の内側に収める
	inset := layer.StrokeWidth / 2
	w := math.Max(0, layer.Width-layer.StrokeWidth)
	h := math.Max(0, layer.Height-layer.StrokeWidth)
	context.Call("beginPath")
	if layer.Type == model.TypeEllipse {
		context.Call("ellipse", ox+layer.Width/2, oy+layer.Height/2, w/2, h/2, 0, 0, math.Pi*2)
	} else {
		radius := math.Min(layer.Radius, math.Min(w/2, h/2))
		context.Call("roundRect", ox+inset, oy+inset, w, h, math.Max(0, radius))
	}
	if layer.FillEnabled {
		context.Set("fillStyle", layer.Fill)
		context.Call("fill")
	}
	if layer.StrokeWidth > 0 {
		context.Set("strokeStyle", layer.Stroke)
		context.Set("lineWidth", layer.StrokeWidth)
		context.Call("stroke")
	}
}

// Rendered はレイヤー 1 枚を描いた結果。
type Rendered struct {
	Canvas js.Value
	// Pad は canvas の左上がレイヤーの左上からどれだけ外側にあるか。
	Pad float64
}

// Padding はレイヤーを描く canvas が、レイヤーの枠からどれだけ外に広がるか（ぼかし・縁取りなど）。
func Padding(layer *model.Layer) float64 {
	blurPad := 0.0
	if layer.Type != model.TypeImage {
		blurPad = filters.BlurPadding(layer.Filters.Blur)
	}
	switch layer.Type {
	case model.TypeText:
		return textPad(layer, richtext.MaxSize(layer.Runs)) + blurPad
	case model.TypePath:
		return textPad(layer, PathSize(layer)) + blurPad
	}
	return blurPad
}

// Layer はレイヤー 1 枚をフィルター込みで描く（位置・不透明度・表示は含まない）。
// 画像はぼかしても枠の外に広げず端を延長し、図形とテキストは外側に広げる。
func Layer(layer *model.Layer, all assets.Assets) Rendered {
	pad := Padding(layer)
	canvas := js.Global().Get("document").Call("createElement", "canvas")
	width := math.Max(1, jsRound(layer.Width)+pad*2)
	height := math.Max(1, jsRound(layer.Height)+pad*2)
	canvas.Set("width", width)
	canvas.Set("height", height)
	options := js.Global().Get("Object").New()
	options.Set("willReadFrequently", false)
	context := canvas.Call("getContext", "2d", options)
	context.Set("imageSmoothingQuality", "high")
	switch layer.Type {
	case model.TypeImage:
		if asset, ok := all[layer.Asset]; ok {
			context.Call("drawImage", asset.Image, 0, 0, layer.Width, layer.Height)
		}
	case model.TypeText:
		if textlayout.UsesOutline(layer) {
			textlayout.DrawParts(context, layer.Outline.Parts, textlayout.PartsOptions{
				StrokeColor: layer.StrokeColor,
				StrokeWidth: layer.StrokeWidth,
				Shadow:      layer.Shadow,
				Size:        richtext.MaxSize(layer.Runs),
				OX:          pad,
				OY:          pad,
			})
		} else {
			textlayout.Draw(context, layer, pad, pad)
		}
	case model.TypePath:
		textlayout.DrawParts(context, layer.Parts, textlayout.PartsOptions{
			StrokeColor: layer.StrokeColor,
			StrokeWidth: layer.StrokeWidth,
			Shadow:      layer.Shadow,
			Size:        PathSize(layer),
			OX:          pad,
			OY:          pad,
			ScaleX:      layer.Width / layer.BaseWidth,
			ScaleY:      layer.Height / layer.BaseHeight,
		})
	default:
		drawShape(context, layer, pad, pad)
	}
	if layer.Filters.HasFilters() {
		// canvas の width・height は整数に丸められるので、実際の値を使う
		w, h := canvas.Get("width").Int(), canvas.Get("height").Int()
		image := context.Call("getImageData", 0, 0, w, h)
		data := image.Get("data")
		pixels := make([]byte, data.Length())
		js.CopyBytesToGo(pixels, data)
		filters.ApplyColor(pixels, filters.ColorMatrix(layer.Filters))
		filters.ApplyBlur(pixels, w, h, layer.Filters.Blur)
		js.CopyBytesToJS(data, pixels)
		context.Call("putImageData", image, 0, 0)
	}
	return Rendered{Canvas: canvas, Pad: pad}
}

// cacheKey は描画結果に影響する値だけを並べたキー（位置・不透明度・名前は含まない）。
func cacheKey(layer *model.Layer, fontVersion int) string {
	b := layer.AppendJSON(nil, false)
	if layer.Type == model.TypeText {
		b = append(b, '#')
		b = strconv.AppendInt(b, int64(fontVersion), 10)
		b = append(b, '#')
		b = strconv.AppendInt(b, int64(fonts.Version()), 10)
	}
	return string(b)
}

type entry struct {
	key      string
	rendered Rendered
}

// Cache はレイヤーごとの描画結果のキャッシュ。
type Cache struct {
	entries map[string]entry
	// FontVersion はフォントの読み込みが終わったら増やして、テキストを描き直す。
	FontVersion int
	// Assets は画像レイヤーが使う画像。
	Assets assets.Assets
}

// NewCache は空のキャッシュ。
func NewCache(all assets.Assets) *Cache {
	return &Cache{entries: map[string]entry{}, Assets: all}
}

// Get はレイヤーの描画結果（変わっていなければキャッシュ）。
func (c *Cache) Get(layer *model.Layer) Rendered {
	key := cacheKey(layer, c.FontVersion)
	if e, ok := c.entries[layer.ID]; ok && e.key == key {
		return e.rendered
	}
	rendered := Layer(layer, c.Assets)
	c.entries[layer.ID] = entry{key, rendered}
	return rendered
}

// Prune はドキュメントに無くなったレイヤーのキャッシュを捨てる。
func (c *Cache) Prune(doc *model.Doc) {
	ids := map[string]bool{}
	for _, layer := range doc.Layers {
		ids[layer.ID] = true
	}
	for id := range c.entries {
		if !ids[id] {
			delete(c.entries, id)
		}
	}
}

// Clear はキャッシュをすべて捨てる。
func (c *Cache) Clear() { c.entries = map[string]entry{} }

// DrawLayers はドキュメントを context に重ねて描く。context の変換はドキュメント座標に合わせておく。
// hidden はキャンバス上で編集中のテキスト（編集欄の文字を見せるので描かない）。
func (c *Cache) DrawLayers(context js.Value, doc *model.Doc, hidden string) {
	for _, layer := range doc.Layers {
		if !layer.Visible || layer.Opacity <= 0 || (hidden != "" && layer.ID == hidden) {
			continue
		}
		r := c.Get(layer)
		context.Set("globalAlpha", layer.Opacity/100)
		context.Call("drawImage", r.Canvas, layer.X-r.Pad, layer.Y-r.Pad)
	}
	context.Set("globalAlpha", 1)
}

// Flatten は背景込みで 1 枚の画像にする（書き出し用）。background が "" なら透明。
func (c *Cache) Flatten(doc *model.Doc, background string) js.Value {
	canvas := js.Global().Get("document").Call("createElement", "canvas")
	canvas.Set("width", doc.Width)
	canvas.Set("height", doc.Height)
	context := canvas.Call("getContext", "2d")
	context.Set("imageSmoothingQuality", "high")
	if background != "" {
		context.Set("fillStyle", background)
		context.Call("fillRect", 0, 0, doc.Width, doc.Height)
	}
	c.DrawLayers(context, doc, "")
	return canvas
}

// Layer は exporter.Renderer の実装（レイヤー 1 枚をフィルター込みで）。
func (c *Cache) Layer(layer *model.Layer) (js.Value, float64) {
	r := c.Get(layer)
	return r.Canvas, r.Pad
}
