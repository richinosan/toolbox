//go:build js

package page

import (
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/snap"
	"toolbox.richinosan.com/packages/ui/src/web"
)

// ---- 通知 ----

func (e *editor) notify(message string, isError bool) {
	setText(e.toast, message)
	toggleClass(e.toast, "toast--error", isError)
	e.toast.Get("classList").Call("add", "toast--visible")
	web.Play(e.toast, "in")
	clearTimer(e.toastTimer)
	ms := 2000.0
	if isError {
		ms = 4000
	}
	e.toastTimer = after(ms, func() { e.toast.Get("classList").Call("remove", "toast--visible") })
}

// ---- 履歴 ----

func (e *editor) snapshot() snapshot { return snapshot{json: e.doc.JSON(), doc: e.doc.Clone()} }

func (e *editor) updateHistoryButtons() {
	e.undoButton.Set("disabled", e.historyIndex <= 0)
	e.redoButton.Set("disabled", e.historyIndex >= len(e.history)-1)
}

// commit は操作の区切りで状態を履歴に積む（直前と同じなら何もしない）。
func (e *editor) commit() {
	if e.doc == nil {
		return
	}
	state := e.snapshot()
	if e.historyIndex >= 0 && e.historyIndex < len(e.history) && e.history[e.historyIndex].json == state.json {
		return
	}
	e.history = append(e.history[:e.historyIndex+1:e.historyIndex+1], state)
	if len(e.history) > historyLimit {
		e.history = e.history[1:]
		e.savedIndex--
	}
	e.historyIndex = len(e.history) - 1
	e.updateHistoryButtons()
	e.renderLayerList()
}

func (e *editor) restore(index int) {
	if index < 0 || index >= len(e.history) {
		return
	}
	e.closeStageText()
	e.charRange = nil
	e.crop = nil
	e.historyIndex = index
	e.doc = e.history[index].doc.Clone()
	if e.selected() == nil {
		e.selectedID = ""
	}
	e.cache.Prune(e.doc)
	e.updateHistoryButtons()
	e.refreshAll()
}

func (e *editor) undo() {
	// 入力中の文字を履歴に積んでから戻す
	e.finishEditing()
	if e.historyIndex > 0 {
		e.restore(e.historyIndex - 1)
	}
}

func (e *editor) redo() {
	e.finishEditing()
	if e.historyIndex < len(e.history)-1 {
		e.restore(e.historyIndex + 1)
	}
}

// ---- 表示位置（カメラ） ----

func (e *editor) stageSize() (width, height float64) {
	return e.stage.Get("clientWidth").Float(), e.stage.Get("clientHeight").Float()
}

func (e *editor) fitCamera() {
	if e.doc == nil {
		return
	}
	width, height := e.stageSize()
	margin := 32.0
	if width < 480 {
		margin = 12
	}
	// 下の端は拡大・縮小のボタンと重ならないよう空けておく
	bottom := float64(zoomBarSpace)
	scale := math.Max(minScale, math.Min(math.Min((width-margin*2)/e.doc.Width, (height-margin-bottom)/e.doc.Height), 4))
	e.camera = camera{
		scale: scale,
		x:     (width - e.doc.Width*scale) / 2,
		y:     margin + (height-margin-bottom-e.doc.Height*scale)/2,
		fit:   true,
	}
}

func (e *editor) zoomAt(scale, cx, cy float64) {
	next := model.Clamp(scale, minScale, maxScale)
	e.camera.x = cx - (cx-e.camera.x)*next/e.camera.scale
	e.camera.y = cy - (cy-e.camera.y)*next/e.camera.scale
	e.camera.scale = next
	e.camera.fit = false
	e.requestDraw()
}

func (e *editor) zoomBy(factor float64) {
	width, height := e.stageSize()
	e.zoomAt(e.camera.scale*factor, width/2, height/2)
}

func (e *editor) stageRect() (left, top float64) {
	rect := e.stage.Call("getBoundingClientRect")
	return rect.Get("left").Float(), rect.Get("top").Float()
}

func (e *editor) toDoc(clientX, clientY float64) point {
	left, top := e.stageRect()
	return point{(clientX - left - e.camera.x) / e.camera.scale, (clientY - top - e.camera.y) / e.camera.scale}
}

func (e *editor) toScreen(x, y float64) point {
	return point{e.camera.x + x*e.camera.scale, e.camera.y + y*e.camera.scale}
}

// ---- 描画 ----

func (e *editor) checkerPattern() js.Value {
	if !e.checker.IsNull() {
		return e.checker
	}
	tile := web.Document().Call("createElement", "canvas")
	tile.Set("width", 16)
	tile.Set("height", 16)
	context := tile.Call("getContext", "2d")
	context.Set("fillStyle", "#ffffff")
	context.Call("fillRect", 0, 0, 16, 16)
	context.Set("fillStyle", "#d9dde2")
	context.Call("fillRect", 0, 0, 8, 8)
	context.Call("fillRect", 8, 8, 8, 8)
	e.checker = e.viewContext.Call("createPattern", tile, "repeat")
	return e.checker
}

func (e *editor) requestDraw() {
	if e.frame != 0 {
		return
	}
	var callback js.Func
	callback = js.FuncOf(func(js.Value, []js.Value) any {
		callback.Release()
		e.frame = 0
		e.draw()
		return nil
	})
	e.frame = js.Global().Call("requestAnimationFrame", callback).Int()
}

// screenBox はドキュメントの枠を画面の座標にする。
func (e *editor) screenBox(x, y, width, height float64) snap.Box {
	p := e.toScreen(x, y)
	return snap.Box{X: p.x, Y: p.y, Width: width * e.camera.scale, Height: height * e.camera.scale}
}

func (e *editor) draw() {
	width, height := e.stageSize()
	ratio := devicePixelRatio()
	pixelWidth := math.Max(1, model.Round(width*ratio))
	pixelHeight := math.Max(1, model.Round(height*ratio))
	if e.view.Get("width").Float() != pixelWidth || e.view.Get("height").Float() != pixelHeight {
		e.view.Set("width", pixelWidth)
		e.view.Set("height", pixelHeight)
	}
	context := e.viewContext
	context.Call("setTransform", ratio, 0, 0, ratio, 0, 0)
	context.Call("clearRect", 0, 0, width, height)
	setText(e.zoomLabel, formatNumber(model.Round(e.camera.scale*100))+"%")
	if e.doc == nil {
		return
	}
	doc := e.doc

	w := doc.Width * e.camera.scale
	h := doc.Height * e.camera.scale
	context.Call("save")
	context.Set("shadowColor", "rgb(0 0 0 / 0.18)")
	context.Set("shadowBlur", 12)
	context.Set("shadowOffsetY", 2)
	if doc.Background != "" {
		context.Set("fillStyle", doc.Background)
	} else if pattern := e.checkerPattern(); !pattern.IsNull() {
		context.Set("fillStyle", pattern)
	} else {
		context.Set("fillStyle", "#ffffff")
	}
	context.Call("fillRect", e.camera.x, e.camera.y, w, h)
	context.Call("restore")

	context.Call("save")
	context.Call("beginPath")
	context.Call("rect", e.camera.x, e.camera.y, w, h)
	context.Call("clip")
	context.Call("translate", e.camera.x, e.camera.y)
	context.Call("scale", e.camera.scale, e.camera.scale)
	context.Set("imageSmoothingQuality", "high")
	e.cache.DrawLayers(context, doc, e.editingID)
	context.Call("restore")
	e.positionStageText()

	// スナップのガイド
	context.Call("save")
	context.Set("strokeStyle", "#ff2d95")
	context.Set("lineWidth", 1)
	for _, x := range e.guides.Xs {
		sx := model.Round(e.toScreen(x, 0).x) + 0.5
		context.Call("beginPath")
		context.Call("moveTo", sx, e.camera.y-8)
		context.Call("lineTo", sx, e.camera.y+h+8)
		context.Call("stroke")
	}
	for _, y := range e.guides.Ys {
		sy := model.Round(e.toScreen(0, y).y) + 0.5
		context.Call("beginPath")
		context.Call("moveTo", e.camera.x-8, sy)
		context.Call("lineTo", e.camera.x+w+8, sy)
		context.Call("stroke")
	}
	context.Call("restore")

	if e.crop != nil {
		e.drawCrop(context, *e.crop)
		return
	}

	// 選択枠とハンドル
	if layer := e.selected(); layer != nil {
		box := e.screenBox(layer.X, layer.Y, layer.Width, layer.Height)
		context.Call("save")
		context.Set("strokeStyle", "#1a73e8")
		context.Set("lineWidth", 1.5)
		if layer.Visible {
			context.Call("setLineDash", []any{})
		} else {
			context.Call("setLineDash", []any{4, 4})
		}
		context.Call("strokeRect", box.X, box.Y, box.Width, box.Height)
		context.Call("setLineDash", []any{})
		for _, handle := range handlesFor(layer) {
			p := handlePoint(box, handle)
			context.Call("beginPath")
			context.Call("arc", p.x, p.y, 5.5, 0, math.Pi*2)
			context.Set("fillStyle", "#ffffff")
			context.Call("fill")
			context.Call("stroke")
		}
		context.Call("restore")
	}
}

// drawCrop は切り抜く枠の外を暗くし、枠・三分割の線・ハンドルを描く。
func (e *editor) drawCrop(context js.Value, box snap.Box) {
	if e.doc == nil {
		return
	}
	outer := e.toScreen(0, 0)
	inner := e.cropScreenBox(box)
	context.Call("save")
	context.Call("beginPath")
	context.Call("rect", outer.x, outer.y, e.doc.Width*e.camera.scale, e.doc.Height*e.camera.scale)
	context.Call("rect", inner.X, inner.Y, inner.Width, inner.Height)
	context.Set("fillStyle", "rgb(0 0 0 / 0.55)")
	context.Call("fill", "evenodd")
	context.Set("strokeStyle", "rgb(255 255 255 / 0.45)")
	context.Set("lineWidth", 1)
	context.Call("beginPath")
	for _, t := range []float64{1.0 / 3, 2.0 / 3} {
		context.Call("moveTo", inner.X+inner.Width*t, inner.Y)
		context.Call("lineTo", inner.X+inner.Width*t, inner.Y+inner.Height)
		context.Call("moveTo", inner.X, inner.Y+inner.Height*t)
		context.Call("lineTo", inner.X+inner.Width, inner.Y+inner.Height*t)
	}
	context.Call("stroke")
	context.Set("strokeStyle", "#ffffff")
	context.Set("lineWidth", 1.5)
	context.Call("strokeRect", inner.X, inner.Y, inner.Width, inner.Height)
	context.Set("strokeStyle", "#1a73e8")
	for _, handle := range e.cropHandles() {
		p := handlePoint(inner, handle)
		context.Call("beginPath")
		context.Call("arc", p.x, p.y, 6, 0, math.Pi*2)
		context.Set("fillStyle", "#ffffff")
		context.Call("fill")
		context.Call("stroke")
	}
	context.Call("restore")
}

// ---- 当たり判定 ----

var (
	cornerHandles = []string{"nw", "ne", "se", "sw"}
	allHandles    = []string{"nw", "n", "ne", "e", "se", "s", "sw", "w"}
)

func handlesFor(layer *model.Layer) []string {
	if layer.Type == model.TypeText {
		return cornerHandles
	}
	return allHandles
}

func handlePoint(box snap.Box, handle string) point {
	p := point{box.X + box.Width/2, box.Y + box.Height/2}
	if strings.Contains(handle, "w") {
		p.x = box.X
	} else if strings.Contains(handle, "e") {
		p.x = box.X + box.Width
	}
	if strings.Contains(handle, "n") {
		p.y = box.Y
	} else if strings.Contains(handle, "s") {
		p.y = box.Y + box.Height
	}
	return p
}

var cursors = map[string]string{
	"nw": "nwse-resize",
	"se": "nwse-resize",
	"ne": "nesw-resize",
	"sw": "nesw-resize",
	"n":  "ns-resize",
	"s":  "ns-resize",
	"e":  "ew-resize",
	"w":  "ew-resize",
}

func (e *editor) hitLayer(x, y float64) *model.Layer {
	if e.doc == nil {
		return nil
	}
	tolerance := 4 / e.camera.scale
	for i := len(e.doc.Layers) - 1; i >= 0; i-- {
		layer := e.doc.Layers[i]
		if !layer.Visible {
			continue
		}
		if x >= layer.X-tolerance && x <= layer.X+layer.Width+tolerance &&
			y >= layer.Y-tolerance && y <= layer.Y+layer.Height+tolerance {
			return layer
		}
	}
	return nil
}

func (e *editor) hitHandle(clientX, clientY float64, touch bool) string {
	layer := e.selected()
	if layer == nil && e.crop == nil {
		return ""
	}
	left, top := e.stageRect()
	px := clientX - left
	py := clientY - top
	var box snap.Box
	var handles []string
	if e.crop != nil {
		box = e.cropScreenBox(*e.crop)
		handles = e.cropHandles()
	} else {
		box = e.screenBox(layer.X, layer.Y, layer.Width, layer.Height)
		handles = handlesFor(layer)
	}
	radius := 10.0
	if touch {
		radius = 20
	}
	best, bestDistance := "", math.Inf(1)
	for _, handle := range handles {
		p := handlePoint(box, handle)
		distance := math.Hypot(p.x-px, p.y-py)
		if distance <= radius && distance < bestDistance {
			best, bestDistance = handle, distance
		}
	}
	return best
}

func (e *editor) snapTargets(except string) snap.Lines {
	if e.doc == nil {
		return snap.Lines{}
	}
	var boxes []snap.Box
	for _, layer := range e.doc.Layers {
		if layer.Visible && layer.ID != except {
			boxes = append(boxes, snap.Box{X: layer.X, Y: layer.Y, Width: layer.Width, Height: layer.Height})
		}
	}
	return snap.Targets(e.doc.Width, e.doc.Height, boxes)
}
