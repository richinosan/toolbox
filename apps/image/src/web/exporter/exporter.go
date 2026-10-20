//go:build js

// Package exporter は書き出し：PNG / JPEG / WebP の画像と、レイヤーを保った PSD。
// 「待つ」関数は Promise の完了を待つので、goroutine の中で呼ぶ。
package exporter

import (
	"math"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/web/project"
)

// Format は書き出す形式（"png"、"jpeg"、"webp"、"psd"）。
type Format = string

// Formats は書き出す形式と表示名（画面に出す順）。
var Formats = model.ExportFormats

var mimeTypes = map[Format]string{"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}

var extensions = map[Format]string{"png": ".png", "jpeg": ".jpg", "webp": ".webp", "psd": ".psd"}

// Renderer はレイヤーの描画（editor の描画のキャッシュ）。
type Renderer interface {
	// Flatten は背景込みで 1 枚の canvas にする。background が "" なら透明。
	Flatten(doc *model.Doc, background string) js.Value
	// Layer はレイヤー 1 枚をフィルター込みで描いた canvas と、その canvas の左上がレイヤーの左上からどれだけ外側にあるか。
	Layer(layer *model.Layer) (canvas js.Value, pad float64)
}

//goesm:import "./lazy.ts" settle await
func settle(promise js.Value) (js.Value, error)

//goesm:import "./lazy.ts" toBlob await
func toBlob(canvas js.Value, typ string, quality js.Value) (js.Value, error)

//goesm:import "./lazy.ts" toBlob
func toBlobPromise(canvas js.Value, typ string, quality js.Value) js.Value

//goesm:import "./lazy.ts" writePsd await
func writePsd(psd js.Value) (js.Value, error)

func qualityValue(quality float64) js.Value {
	if quality < 0 {
		return js.Undefined()
	}
	return js.ValueOf(quality)
}

// ToBlob は canvas.toBlob の結果を待つ。quality が負なら指定しない。
func ToBlob(canvas js.Value, typ string, quality float64) (js.Value, error) {
	return toBlob(canvas, typ, qualityValue(quality))
}

// flatCanvas は 1 枚の画像の canvas。JPEG は透明を扱えないので、透明な背景は白で埋める。
func flatCanvas(doc *model.Doc, r Renderer, format Format) js.Value {
	background := doc.Background
	if format == "jpeg" && background == "" {
		background = "#ffffff"
	}
	return r.Flatten(doc, background)
}

// Limit はファイルサイズの上限（JPEG・WebP）。
type Limit struct {
	Bytes float64
	// Shrink は画質を下げても収まらないとき、縦横の大きさも縮めるか。
	Shrink bool
}

// Compressed は上限を指定して圧縮した結果。
type Compressed struct {
	Quality float64
	Fitted  bool
	Width   float64
	Height  float64
	Shrunk  bool
}

// Result は書き出しの結果。
type Result struct {
	Requested Format
	// Actual は実際の形式（WebP に対応していないブラウザでは png）。
	Actual Format
	Size   float64
	// Compressed は上限を指定したときだけ。
	Compressed *Compressed
}

const (
	// shrinkQuality は縮めるときに下げる画質の下限（これより下げると見た目が崩れやすいので、先に縮める）。
	shrinkQuality = 0.5
	minQuality    = 0.05
	maxQuality    = 0.95
)

// jsRound は Math.round（.5 は +∞ の側に丸める）。
func jsRound(n float64) float64 { return math.Floor(n + 0.5) }

func resized(source js.Value, scale float64) js.Value {
	canvas := js.Global().Get("document").Call("createElement", "canvas")
	canvas.Set("width", math.Max(1, jsRound(source.Get("width").Float()*scale)))
	canvas.Set("height", math.Max(1, jsRound(source.Get("height").Float()*scale)))
	context := canvas.Call("getContext", "2d")
	context.Set("imageSmoothingQuality", "high")
	context.Call("drawImage", source, 0, 0, canvas.Get("width"), canvas.Get("height"))
	return canvas
}

type compressed struct {
	blob          js.Value
	quality       float64
	fitted        bool
	width, height float64
}

// compress は上限に収まる一番高い画質を二分探索で探す。
// 下限の画質でも収まらず、縮めてよいときは、縦横を縮めてからもう一度探す。
func compress(original js.Value, typ string, limit Limit) (compressed, error) {
	floor := minQuality
	if limit.Shrink {
		floor = shrinkQuality
	}
	canvas := original
	var smallest js.Value
	smallestQuality := 0.0
	done := func(blob js.Value, quality float64, fitted bool) compressed {
		return compressed{blob, quality, fitted, canvas.Get("width").Float(), canvas.Get("height").Float()}
	}
	for range 8 {
		best, err := toBlob(canvas, typ, js.ValueOf(maxQuality))
		if err != nil {
			return compressed{}, err
		}
		// 対応していない形式（PNG になった）は、画質では小さくできない
		if size := best.Get("size").Float(); best.Get("type").String() != typ || size <= limit.Bytes {
			return done(best, maxQuality, size <= limit.Bytes), nil
		}
		worst, err := toBlob(canvas, typ, js.ValueOf(floor))
		if err != nil {
			return compressed{}, err
		}
		smallest, smallestQuality = worst, floor
		if worst.Get("size").Float() <= limit.Bytes {
			low, high, found := floor, maxQuality, worst
			for range 7 {
				quality := (low + high) / 2
				blob, err := toBlob(canvas, typ, js.ValueOf(quality))
				if err != nil {
					return compressed{}, err
				}
				if blob.Get("size").Float() <= limit.Bytes {
					found, low = blob, quality
				} else {
					high = quality
				}
			}
			return done(found, low, true), nil
		}
		if !limit.Shrink || math.Min(canvas.Get("width").Float(), canvas.Get("height").Float()) <= 16 {
			break
		}
		// ファイルサイズはおおよそ面積に比例するので、その分だけ縮める
		scale := math.Min(0.9, math.Sqrt(limit.Bytes/worst.Get("size").Float())*0.95)
		canvas = resized(original, canvas.Get("width").Float()*math.Max(0.25, scale)/original.Get("width").Float())
	}
	return done(smallest, smallestQuality, false), nil
}

// psd はレイヤーを保った PSD。各レイヤーはフィルター込みの画像として書き出す（テキストも画像になる）。
func psd(doc *model.Doc, r Renderer) (js.Value, error) {
	children := []any{}
	if doc.Background != "" {
		canvas := js.Global().Get("document").Call("createElement", "canvas")
		canvas.Set("width", doc.Width)
		canvas.Set("height", doc.Height)
		context := canvas.Call("getContext", "2d")
		context.Set("fillStyle", doc.Background)
		context.Call("fillRect", 0, 0, doc.Width, doc.Height)
		children = append(children, map[string]any{"name": "背景", "left": 0, "top": 0, "canvas": canvas})
	}
	for _, layer := range doc.Layers {
		canvas, pad := r.Layer(layer)
		children = append(children, map[string]any{
			"name":    layer.Name,
			"left":    jsRound(layer.X - pad),
			"top":     jsRound(layer.Y - pad),
			"canvas":  canvas,
			"opacity": layer.Opacity / 100,
			"hidden":  !layer.Visible,
		})
	}
	return writePsd(js.ValueOf(map[string]any{
		"width":    doc.Width,
		"height":   doc.Height,
		"children": children,
		"canvas":   r.Flatten(doc, doc.Background),
	}))
}

// ExportFile は書き出してダウンロードさせる。limit が nil なら quality（0〜1）で書き出す。待つ。
func ExportFile(doc *model.Doc, r Renderer, format Format, quality float64, limit *Limit) (Result, error) {
	var blob js.Value
	var result *compressed
	var err error
	switch {
	case format == "psd":
		blob, err = psd(doc, r)
	case limit != nil && format != "png":
		var c compressed
		c, err = compress(flatCanvas(doc, r, format), mimeTypes[format], *limit)
		blob, result = c.blob, &c
	default:
		blob, err = ToBlob(flatCanvas(doc, r, format), mimeTypes[format], quality)
	}
	if err != nil {
		return Result{}, err
	}
	// WebP に対応していないブラウザは PNG で返すので、拡張子も実際の形式に合わせる
	actual := format
	if format != "psd" && blob.Get("type").String() == "image/png" {
		actual = "png"
	}
	project.Download(blob, project.SafeName(doc.Name)+extensions[actual])
	out := Result{Requested: format, Actual: actual, Size: blob.Get("size").Float()}
	if result != nil {
		out.Compressed = &Compressed{
			Quality: result.quality,
			Fitted:  result.fitted,
			Width:   result.width,
			Height:  result.height,
			Shrunk:  result.width != doc.Width || result.height != doc.Height,
		}
	}
	return out, nil
}

// CopyImage は PNG としてクリップボードにコピーする。待つ。
func CopyImage(doc *model.Doc, r Renderer) error {
	blob := toBlobPromise(flatCanvas(doc, r, "png"), "image/png", js.ValueOf(1))
	// Safari はユーザー操作の直後に write を呼ぶ必要があるので、Blob の Promise のまま渡す
	item := js.Global().Get("ClipboardItem").New(js.ValueOf(map[string]any{"image/png": blob}))
	var promise js.Value
	var thrown any
	func() {
		defer func() { thrown = recover() }()
		promise = js.Global().Get("navigator").Get("clipboard").Call("write", []any{item})
	}()
	if thrown != nil {
		if err, ok := thrown.(error); ok {
			return err
		}
		return js.Error{Value: js.Global().Get("Error").New("clipboard")}
	}
	_, err := settle(promise)
	return err
}
