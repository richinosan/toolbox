//go:build js

package page

import (
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/filters"
	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/lib/snap"
	"toolbox.richinosan.com/apps/image/src/web/exporter"
	"toolbox.richinosan.com/apps/image/src/web/render"
	"toolbox.richinosan.com/apps/image/src/web/textlayout"
	"toolbox.richinosan.com/packages/ui/src/web"
)

// fitCrop は比率を保ったまま、ドキュメントに収まる一番大きな枠（中央）。
func fitCrop(doc *model.Doc, ratio float64) snap.Box {
	width := math.Min(doc.Width, doc.Height*ratio)
	height := width / ratio
	return snap.Box{X: (doc.Width - width) / 2, Y: (doc.Height - height) / 2, Width: width, Height: height}
}

// resizeCrop はハンドルで枠の大きさを変える。ドキュメントの外には出さず、比率（0 は自由）があれば保つ。
func resizeCrop(doc *model.Doc, origin snap.Box, handle string, dx, dy, ratio float64) snap.Box {
	has := func(s string) bool { return strings.Contains(handle, s) }
	// ドキュメントが最小の大きさより小さいときは、ドキュメントの大きさまで
	minWidth := math.Min(minCrop, doc.Width)
	minHeight := math.Min(minCrop, doc.Height)
	left, top := origin.X, origin.Y
	right, bottom := origin.X+origin.Width, origin.Y+origin.Height
	if has("w") {
		left = model.Clamp(left+dx, 0, right-minWidth)
	}
	if has("e") {
		right = model.Clamp(right+dx, left+minWidth, doc.Width)
	}
	if has("n") {
		top = model.Clamp(top+dy, 0, bottom-minHeight)
	}
	if has("s") {
		bottom = model.Clamp(bottom+dy, top+minHeight, doc.Height)
	}
	if ratio != 0 {
		// 小さい方に合わせて縮めるので、ドキュメントからはみ出さない
		width := right - left
		height := bottom - top
		if width/height > ratio {
			width = height * ratio
		} else {
			height = width / ratio
		}
		if has("w") {
			left = right - width
		} else {
			right = left + width
		}
		if has("n") {
			top = bottom - height
		} else {
			bottom = top + height
		}
	}
	return snap.Box{X: left, Y: top, Width: right - left, Height: bottom - top}
}

// imageClip は画像レイヤーのうち、枠（とぼかしで広がる分）にかかる範囲。レイヤーの左上からの px。
func imageClip(layer *model.Layer, box snap.Box) snap.Box {
	margin := 1 + filters.BlurPadding(layer.Filters.Blur)
	left := math.Max(0, math.Floor(box.X-layer.X-margin))
	top := math.Max(0, math.Floor(box.Y-layer.Y-margin))
	right := math.Min(layer.Width, math.Ceil(box.X+box.Width-layer.X+margin))
	bottom := math.Min(layer.Height, math.Ceil(box.Y+box.Height-layer.Y+margin))
	return snap.Box{X: left, Y: top, Width: right - left, Height: bottom - top}
}

// withinCanvasLimit は canvas に描ける大きさか（iOS Safari の上限に合わせる）。
func withinCanvasLimit(width, height float64) bool {
	return width <= model.MaxSide && height <= model.MaxSide && width*height <= model.MaxArea
}

// scaleLayer はレイヤーを scale 倍にする（切り抜いたあと、決まった大きさに合わせるとき）。
func scaleLayer(layer *model.Layer, scale float64) {
	round := func(value float64) float64 { return model.Round(value*scale*10) / 10 }
	if layer.Type == model.TypeText {
		outlineValid := layer.Outline != nil && layer.Outline.Key == richtext.OutlineKey(layer)
		layer.Runs = richtext.ScaleRuns(layer.Runs, scale)
		if outlineValid {
			scaled := richtext.ScaleOutline(*layer.Outline, scale)
			scaled.Key = richtext.OutlineKey(layer)
			layer.Outline = &scaled
		} else {
			layer.Outline = nil
		}
	}
	if layer.Type != model.TypeImage {
		layer.StrokeWidth = round(layer.StrokeWidth)
	}
	if layer.Type == model.TypeRect {
		layer.Radius = round(layer.Radius)
	}
	layer.Filters.Blur = round(layer.Filters.Blur)
	layer.X = model.Round(layer.X * scale)
	layer.Y = model.Round(layer.Y * scale)
	if layer.Type == model.TypeText {
		layer.Width, layer.Height = textlayout.Measure(layer)
	} else {
		layer.Width = math.Max(1, model.Round(layer.Width*scale))
		layer.Height = math.Max(1, model.Round(layer.Height*scale))
	}
}

// ---- トリミング ----

func (e *editor) cropPreset() model.CropPreset {
	id, _ := formValue(e.cropForm, "crop-preset")
	for _, preset := range model.CropPresets {
		if preset.ID == id {
			return preset
		}
	}
	return model.CropPresets[0]
}

// cropScreenBox は切り抜く枠を画面の座標にする。
func (e *editor) cropScreenBox(box snap.Box) snap.Box {
	return e.screenBox(box.X, box.Y, box.Width, box.Height)
}

// cropHandles は比率が決まっているときは、角のハンドルだけにする。
func (e *editor) cropHandles() []string {
	if e.cropPreset().Ratio != 0 {
		return cornerHandles
	}
	return allHandles
}

type cropResult struct {
	width, height float64
	// fit は決まった大きさに合わせるときのその大きさ。無ければ nil。
	fit []float64
}

func (r cropResult) key() string {
	key := formatNumber(r.width) + "x" + formatNumber(r.height)
	if r.fit != nil {
		key += ":" + formatNumber(r.fit[0]) + "x" + formatNumber(r.fit[1])
	}
	return key
}

func (e *editor) cropFitInput() js.Value { return query(e.cropForm, `[name="crop-fit"]`) }

// cropResult は切り抜いたあとの大きさ（px）。決まった大きさに合わせるときはその大きさ。
func (e *editor) cropResult() (cropResult, bool) {
	if e.crop == nil {
		return cropResult{}, false
	}
	preset := e.cropPreset()
	var fit []float64
	if preset.Size != nil && e.cropFitInput().Get("checked").Bool() {
		fit = preset.Size
	}
	return cropResult{
		width:  math.Max(1, model.Round(e.crop.Width)),
		height: math.Max(1, model.Round(e.crop.Height)),
		fit:    fit,
	}, true
}

func size(width, height float64) string { return formatNumber(width) + " × " + formatNumber(height) }

func (e *editor) syncCropPanel() {
	result, ok := e.cropResult()
	if !ok {
		return
	}
	preset := e.cropPreset()
	query(e.cropForm, "#crop-fit").Set("hidden", preset.Size == nil)
	if preset.Size != nil {
		setText(query(e.cropForm, "#crop-fit-label"), "切り抜いたあと "+size(preset.Size[0], preset.Size[1])+" px に拡大・縮小する")
	}
	label := size(result.width, result.height) + " px を切り抜きます"
	if result.fit != nil {
		label = size(result.width, result.height) + " px を切り抜いて、" + size(result.fit[0], result.fit[1]) + " px にします"
	}
	setText(query(e.cropForm, "#crop-size"), label)
}

func (e *editor) startCrop() {
	if e.doc == nil {
		return
	}
	if e.crop != nil {
		e.cancelCrop()
		return
	}
	e.finishEditing()
	e.selectedID = ""
	e.renderLayerList()
	box := snap.Box{Width: e.doc.Width, Height: e.doc.Height}
	if preset := e.cropPreset(); preset.Ratio != 0 {
		box = fitCrop(e.doc, preset.Ratio)
	}
	e.crop = &box
	e.syncPanel()
	e.requestDraw()
}

func (e *editor) cancelCrop() {
	if e.crop == nil {
		return
	}
	e.crop = nil
	e.drag = nil
	e.syncPanel()
	e.requestDraw()
}

// clipAsset は画像の clip の範囲だけを、元の解像度で新しい画像にする。待つ。
func (e *editor) clipAsset(layer *model.Layer, clip snap.Box) (string, bool) {
	asset, ok := e.assets[layer.Asset]
	if !ok {
		return "", false
	}
	sx := asset.Image.Get("width").Float() / layer.Width
	sy := asset.Image.Get("height").Float() / layer.Height
	canvas := web.Document().Call("createElement", "canvas")
	canvas.Set("width", math.Max(1, model.Round(clip.Width*sx)))
	canvas.Set("height", math.Max(1, model.Round(clip.Height*sy)))
	canvas.Call("getContext", "2d").Call("drawImage", asset.Image,
		clip.X*sx, clip.Y*sy, clip.Width*sx, clip.Height*sy,
		0, 0, canvas.Get("width"), canvas.Get("height"))
	// 編集中のデータなので、劣化しない PNG にする
	blob, err := exporter.ToBlob(canvas, "image/png", -1)
	if err != nil {
		return "", false
	}
	image, err := web.Await(js.Global().Call("createImageBitmap", blob))
	if err != nil {
		return "", false
	}
	return e.addAsset(blob, image), true
}

// cropToFit は決まった大きさに合わせて切り抜く。拡大するとレイヤーの枠の外の部分も大きくなるので、
// 画像は枠にかかる範囲だけを残す。それでも canvas の上限を超えるときは nil。待つ。
func (e *editor) cropToFit(target *model.Doc, box snap.Box, fit []float64) func() {
	// 丸める前の枠で拡大・縮小する。丸めると比率がずれて、端が欠けたり枠の外が見えたりする
	scale := fit[0] / box.Width
	clips := map[string]snap.Box{}
	for _, layer := range target.Layers {
		if layer.Type == model.TypeImage {
			clips[layer.ID] = imageClip(layer, box)
		}
	}
	visible := func(b snap.Box) bool { return b.Width > 0 && b.Height > 0 }
	// 描くときの canvas は、ぼかしや縁取りの分だけ外に広がる。それも一緒に拡大される
	for _, layer := range target.Layers {
		b, ok := clips[layer.ID]
		if !ok {
			b = snap.Box{Width: layer.Width, Height: layer.Height}
		}
		pad := render.Padding(layer) * 2
		if visible(b) && !withinCanvasLimit((b.Width+pad)*scale+2, (b.Height+pad)*scale+2) {
			return nil
		}
	}
	replaced := map[string]string{}
	for _, layer := range target.Layers {
		clip, ok := clips[layer.ID]
		if layer.Type != model.TypeImage || !ok || !visible(clip) ||
			(clip.Width == layer.Width && clip.Height == layer.Height) {
			continue
		}
		if asset, ok := e.clipAsset(layer, clip); ok {
			replaced[layer.ID] = asset
		}
	}
	return func() {
		// 枠にかからない画像レイヤーは消す
		var layers []*model.Layer
		for _, layer := range target.Layers {
			if clip, ok := clips[layer.ID]; !ok || visible(clip) {
				layers = append(layers, layer)
			}
		}
		target.Layers = layers
		for _, layer := range target.Layers {
			clip, hasClip := clips[layer.ID]
			asset, hasAsset := replaced[layer.ID]
			if layer.Type == model.TypeImage && hasClip && hasAsset {
				layer.Asset = asset
				layer.X += clip.X
				layer.Y += clip.Y
				layer.Width = clip.Width
				layer.Height = clip.Height
			}
			layer.X -= box.X
			layer.Y -= box.Y
			scaleLayer(layer, scale)
		}
		target.Width = fit[0]
		target.Height = fit[1]
	}
}

func (e *editor) applyCrop() {
	result, ok := e.cropResult()
	if e.doc == nil || e.crop == nil || !ok || e.applyingCrop {
		return
	}
	target := e.doc
	box := e.crop
	if result.fit == nil {
		e.finishCrop(target, *box, result, nil)
		return
	}
	before := target.JSON()
	request := result.key()
	e.applyingCrop = true
	go func() {
		var apply func()
		web.Try(func() { apply = e.cropToFit(target, *box, result.fit) })
		e.applyingCrop = false
		// 画像を作っているあいだに編集したり、枠や比率・拡大の設定を変えたり、トリミングをやめたりしたときは何もしない
		current, ok := e.cropResult()
		if e.doc != target || e.crop != box || !ok || current.key() != request || target.JSON() != before {
			return
		}
		e.finishCrop(target, *box, result, apply)
	}()
}

func (e *editor) finishCrop(target *model.Doc, box snap.Box, result cropResult, apply func()) {
	e.crop = nil
	e.drag = nil
	if apply != nil {
		apply()
	} else {
		x := model.Round(box.X)
		y := model.Round(box.Y)
		for _, layer := range target.Layers {
			layer.X -= x
			layer.Y -= y
		}
		target.Width = math.Min(result.width, target.Width-x)
		target.Height = math.Min(result.height, target.Height-y)
	}
	// 消した画像レイヤーの描画結果を捨てる
	e.cache.Prune(target)
	e.commit()
	e.setStageRatio()
	e.fitCamera()
	e.refreshAll()
	if result.fit != nil && apply == nil {
		e.notify(size(result.fit[0], result.fit[1])+" px に拡大できなかったため、"+size(target.Width, target.Height)+" px のまま切り抜きました。", false)
	} else {
		e.notify(size(target.Width, target.Height)+" px に切り抜きました。", false)
	}
}

func (e *editor) bindCrop() {
	on(e.cropForm, "submit", func(event js.Value) { event.Call("preventDefault") })
	on(e.cropForm, "change", func(event js.Value) {
		if e.doc == nil || e.crop == nil {
			return
		}
		target := event.Get("target")
		if isElement(target) && target.Get("tagName").String() == "INPUT" && target.Get("name").String() == "crop-preset" {
			if preset := e.cropPreset(); preset.Ratio != 0 {
				box := fitCrop(e.doc, preset.Ratio)
				e.crop = &box
			}
		}
		e.syncCropPanel()
		e.requestDraw()
	})
}
