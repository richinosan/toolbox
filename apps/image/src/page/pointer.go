//go:build js

package page

import (
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/lib/snap"
	"toolbox.richinosan.com/apps/image/src/web/textlayout"
)

// ---- ドラッグ操作 ----

func (e *editor) applyMove(current *drag, p point, event js.Value) {
	layer := e.selected()
	if layer == nil || e.doc == nil {
		return
	}
	dx := p.x - current.startX
	dy := p.y - current.startY
	shift := event.Get("shiftKey").Bool()
	// Shift を押しながらだと、縦か横の一方向だけに動かす
	if shift {
		if math.Abs(dx) > math.Abs(dy) {
			dy = 0
		} else {
			dx = 0
		}
	}
	x := current.origin.X + dx
	y := current.origin.Y + dy
	e.guides = snap.Lines{}
	if e.snapEnabled && !event.Get("altKey").Bool() {
		sx, sy, guides := snap.Move(snap.Box{X: x, Y: y, Width: layer.Width, Height: layer.Height},
			e.snapTargets(layer.ID), snapDistance/e.camera.scale)
		if !shift || dy == 0 {
			x = sx
		}
		if !shift || dx == 0 {
			y = sy
		}
		e.guides = guides
	}
	layer.X = model.Round(x)
	layer.Y = model.Round(y)
}

func (e *editor) applyResize(current *drag, p point, event js.Value) {
	layer := e.selected()
	if layer == nil || e.doc == nil {
		return
	}
	origin := current.origin
	handle := current.handle
	has := func(s string) bool { return strings.Contains(handle, s) }
	dx := p.x - current.startX
	dy := p.y - current.startY
	left, top := origin.X, origin.Y
	right, bottom := origin.X+origin.Width, origin.Y+origin.Height
	if has("w") {
		left += dx
	}
	if has("e") {
		right += dx
	}
	if has("n") {
		top += dy
	}
	if has("s") {
		bottom += dy
	}

	e.guides = snap.Lines{}
	if e.snapEnabled && !event.Get("altKey").Bool() {
		targets := e.snapTargets(layer.ID)
		threshold := snapDistance / e.camera.scale
		edgeX := func(value float64) float64 {
			line, ok := snap.Edge(value, targets.Xs, threshold)
			if !ok {
				return value
			}
			e.guides.Xs = append(e.guides.Xs, line)
			return line
		}
		edgeY := func(value float64) float64 {
			line, ok := snap.Edge(value, targets.Ys, threshold)
			if !ok {
				return value
			}
			e.guides.Ys = append(e.guides.Ys, line)
			return line
		}
		if has("w") {
			left = edgeX(left)
		}
		if has("e") {
			right = edgeX(right)
		}
		if has("n") {
			top = edgeY(top)
		}
		if has("s") {
			bottom = edgeY(bottom)
		}
	}

	// 反対側の辺を越えないようにする
	if has("w") {
		left = math.Min(left, right-1)
	}
	if has("e") {
		right = math.Max(right, left+1)
	}
	if has("n") {
		top = math.Min(top, bottom-1)
	}
	if has("s") {
		bottom = math.Max(bottom, top+1)
	}

	corner := len(handle) == 2
	shift := event.Get("shiftKey").Bool()
	// 画像とパスは角のハンドルで縦横比を保つ（Shift で切り替え）。テキストは常に、図形は Shift で保つ
	keepRatio := corner && (layer.Type == model.TypeText ||
		((layer.Type == model.TypeImage || layer.Type == model.TypePath) && !shift) ||
		(layer.IsShape() && shift))
	if keepRatio {
		scale := math.Max((right-left)/origin.Width, (bottom-top)/origin.Height)
		width := math.Max(1, origin.Width*scale)
		height := math.Max(1, origin.Height*scale)
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
		// 縦横比を合わせると、合わせ直した側のガイドはずれるので消す
		e.guides = snap.Lines{}
	}

	if layer.Type == model.TypeText && origin.Type == model.TypeText {
		scale := (right - left) / origin.Width
		layer.Runs = richtext.ScaleRuns(origin.Runs, scale)
		layer.StrokeWidth = model.Round(origin.StrokeWidth*scale*10) / 10
		// フォントが無くパスで表示しているときは、パスも一緒に拡大・縮小する
		layer.Outline = nil
		if origin.Outline != nil && textlayout.UsesOutline(origin) {
			scaled := richtext.ScaleOutline(*origin.Outline, scale)
			scaled.Key = richtext.OutlineKey(layer)
			layer.Outline = &scaled
		}
		width, height := textlayout.Measure(layer)
		layer.Width = width
		layer.Height = height
		if has("w") {
			layer.X = model.Round(origin.X + origin.Width - width)
		} else {
			layer.X = model.Round(origin.X)
		}
		if has("n") {
			layer.Y = model.Round(origin.Y + origin.Height - height)
		} else {
			layer.Y = model.Round(origin.Y)
		}
		return
	}
	layer.X = model.Round(left)
	layer.Y = model.Round(top)
	layer.Width = math.Max(1, model.Round(right-left))
	layer.Height = math.Max(1, model.Round(bottom-top))
}

// cancelLayerDrag はドラッグを取り消して、動かす前の状態に戻す（2 本目の指が触れたとき）。
func (e *editor) cancelLayerDrag() {
	if e.doc == nil || e.drag == nil || (e.drag.kind != "move" && e.drag.kind != "resize") {
		return
	}
	origin := e.drag.origin
	for i, layer := range e.doc.Layers {
		if layer.ID == origin.ID {
			e.doc.Layers[i] = origin
		}
	}
	e.guides = snap.Lines{}
}

// firstPointers は押している指（触れた順の最初の 2 本）。
func (e *editor) firstPointers() (a, b point, ok bool) {
	if len(e.pointerOrder) < 2 {
		return point{}, point{}, false
	}
	return e.pointers[e.pointerOrder[0]], e.pointers[e.pointerOrder[1]], true
}

func (e *editor) startPinch() {
	a, b, ok := e.firstPointers()
	if !ok {
		return
	}
	left, top := e.stageRect()
	e.drag = &drag{
		kind:     "pinch",
		distance: math.Max(1, math.Hypot(a.x-b.x, a.y-b.y)),
		midX:     (a.x+b.x)/2 - left,
		midY:     (a.y+b.y)/2 - top,
		scale:    e.camera.scale,
		viewX:    e.camera.x,
		viewY:    e.camera.y,
	}
}

func (e *editor) removePointer(id int) {
	delete(e.pointers, id)
	for i, v := range e.pointerOrder {
		if v == id {
			e.pointerOrder = append(e.pointerOrder[:i:i], e.pointerOrder[i+1:]...)
			break
		}
	}
}

func (e *editor) inCrop(p point) bool {
	c := e.crop
	return c != nil && p.x >= c.X && p.x <= c.X+c.Width && p.y >= c.Y && p.y <= c.Y+c.Height
}

func (e *editor) bindPointer() {
	stage := e.stage
	on(stage, "pointerdown", func(event js.Value) {
		if e.doc == nil {
			return
		}
		target := event.Get("target")
		// キャンバス上の編集欄の中では、文字の選択をブラウザに任せる
		if target.InstanceOf(js.Global().Get("Node")) && e.stageText.Call("contains", target).Bool() {
			return
		}
		// キャンバスの上のボタン（拡大・縮小、トリミング）は、ポインターを奪わずにクリックさせる
		if !closest(target, "button").IsNull() && isElement(target) {
			return
		}
		pointerType := event.Get("pointerType").String()
		if event.Get("button").Int() != 0 && pointerType == "mouse" {
			return
		}
		e.finishEditing()
		id := event.Get("pointerId").Int()
		stage.Call("setPointerCapture", id)
		clientX, clientY := event.Get("clientX").Float(), event.Get("clientY").Float()
		if _, ok := e.pointers[id]; !ok {
			e.pointerOrder = append(e.pointerOrder, id)
		}
		e.pointers[id] = point{clientX, clientY}
		if len(e.pointers) == 2 {
			e.cancelLayerDrag()
			e.startPinch()
			e.requestDraw()
			return
		}
		if len(e.pointers) > 2 {
			return
		}

		p := e.toDoc(clientX, clientY)
		handle := e.hitHandle(clientX, clientY, pointerType != "mouse")
		if e.crop != nil {
			if handle != "" || e.inCrop(p) {
				kind := "crop-move"
				if handle != "" {
					kind = "crop-resize"
				}
				e.drag = &drag{kind: kind, handle: handle, startX: p.x, startY: p.y, cropOrigin: *e.crop}
				return
			}
		}
		if current := e.selected(); handle != "" && current != nil {
			e.drag = &drag{kind: "resize", id: current.ID, handle: handle, startX: p.x, startY: p.y, origin: current.Clone()}
			return
		}
		var hit *model.Layer
		if e.crop == nil {
			hit = e.hitLayer(p.x, p.y)
		}
		if hit != nil {
			if hit.ID != e.selectedID {
				e.selectLayer(hit.ID)
			}
			e.drag = &drag{kind: "move", id: hit.ID, startX: p.x, startY: p.y, origin: hit.Clone()}
			return
		}
		e.drag = &drag{kind: "pan", startX: clientX, startY: clientY, viewX: e.camera.x, viewY: e.camera.y}
	})

	on(stage, "pointermove", func(event js.Value) {
		id := event.Get("pointerId").Int()
		clientX, clientY := event.Get("clientX").Float(), event.Get("clientY").Float()
		if _, ok := e.pointers[id]; ok {
			e.pointers[id] = point{clientX, clientY}
		}
		d := e.drag
		if d == nil {
			// ハンドルの上ではカーソルを変える
			if event.Get("pointerType").String() == "mouse" && e.doc != nil {
				handle := e.hitHandle(clientX, clientY, false)
				p := e.toDoc(clientX, clientY)
				cursor := "default"
				if handle != "" {
					cursor = cursors[handle]
				} else if e.inCrop(p) || (e.crop == nil && e.hitLayer(p.x, p.y) != nil) {
					cursor = "move"
				}
				stage.Get("style").Set("cursor", cursor)
			}
			return
		}
		switch d.kind {
		case "pinch":
			a, b, ok := e.firstPointers()
			if !ok {
				return
			}
			left, top := e.stageRect()
			distance := math.Hypot(a.x-b.x, a.y-b.y)
			midX := (a.x+b.x)/2 - left
			midY := (a.y+b.y)/2 - top
			scale := model.Clamp(d.scale*distance/d.distance, minScale, maxScale)
			e.camera.x = midX - (d.midX-d.viewX)*scale/d.scale
			e.camera.y = midY - (d.midY-d.viewY)*scale/d.scale
			e.camera.scale = scale
			e.camera.fit = false
			e.requestDraw()
			return
		case "pan":
			dx := clientX - d.startX
			dy := clientY - d.startY
			if !d.moved && math.Hypot(dx, dy) < 4 {
				return
			}
			d.moved = true
			e.camera.x = d.viewX + dx
			e.camera.y = d.viewY + dy
			e.camera.fit = false
			e.requestDraw()
			return
		}
		p := e.toDoc(clientX, clientY)
		switch d.kind {
		case "crop-move", "crop-resize":
			if e.doc == nil || e.crop == nil {
				return
			}
			dx := p.x - d.startX
			dy := p.y - d.startY
			var next snap.Box
			if d.kind == "crop-move" {
				next = d.cropOrigin
				next.X = model.Clamp(d.cropOrigin.X+dx, 0, e.doc.Width-d.cropOrigin.Width)
				next.Y = model.Clamp(d.cropOrigin.Y+dy, 0, e.doc.Height-d.cropOrigin.Height)
			} else {
				next = resizeCrop(e.doc, d.cropOrigin, d.handle, dx, dy, e.cropPreset().Ratio)
			}
			e.crop = &next
			e.syncCropPanel()
			e.requestDraw()
			return
		case "move":
			distance := math.Hypot(p.x-d.startX, p.y-d.startY) * e.camera.scale
			if !d.moved && distance < 3 {
				return
			}
			d.moved = true
			e.applyMove(d, p, event)
		case "resize":
			e.applyResize(d, p, event)
		}
		e.syncGeometry()
		e.requestDraw()
	})

	endPointer := func(event js.Value) {
		e.removePointer(event.Get("pointerId").Int())
		d := e.drag
		if d == nil {
			return
		}
		if d.kind == "pinch" {
			// 指が 1 本残っても、離すまでは何もしない
			if len(e.pointers) == 0 {
				e.drag = nil
			}
			return
		}
		if d.kind == "pan" && !d.moved && e.crop == nil {
			e.selectLayer("")
		}
		// タッチでは、同じテキストを 2 回続けてタップしたらその場で編集する
		if d.kind == "move" && !d.moved && event.Get("pointerType").String() != "mouse" {
			t := now()
			layer := e.selected()
			if layer != nil && layer.Type == model.TypeText && e.lastTapID == layer.ID && t-e.lastTapAt < doubleTap {
				e.drag = nil
				e.lastTapID = ""
				e.startEditing(layer)
				return
			}
			e.lastTapID, e.lastTapAt = d.id, t
		}
		e.drag = nil
		e.guides = snap.Lines{}
		if d.kind == "move" || d.kind == "resize" {
			e.commit()
			e.syncPanel()
		}
		e.requestDraw()
	}
	on(stage, "pointerup", endPointer)
	on(stage, "pointercancel", func(event js.Value) {
		if e.drag != nil && (e.drag.kind == "move" || e.drag.kind == "resize") {
			e.cancelLayerDrag()
		}
		e.drag = nil
		endPointer(event)
	})

	on(stage, "dblclick", func(event js.Value) {
		target := event.Get("target")
		if target.InstanceOf(js.Global().Get("Node")) && e.stageText.Call("contains", target).Bool() {
			return
		}
		p := e.toDoc(event.Get("clientX").Float(), event.Get("clientY").Float())
		if hit := e.hitLayer(p.x, p.y); hit != nil && hit.Type == model.TypeText {
			e.startEditing(hit)
		}
	})

	passive := js.Global().Get("Object").New()
	passive.Set("passive", false)
	on(stage, "wheel", func(event js.Value) {
		if e.doc == nil {
			return
		}
		left, top := e.stageRect()
		if event.Get("ctrlKey").Bool() || event.Get("metaKey").Bool() {
			// トラックパッドのピンチもここに来る
			event.Call("preventDefault")
			e.zoomAt(e.camera.scale*math.Exp(-event.Get("deltaY").Float()*0.01),
				event.Get("clientX").Float()-left, event.Get("clientY").Float()-top)
		} else if !e.camera.fit {
			// 拡大中はホイールで表示位置を動かす（全体表示のときはページをスクロールさせる）
			event.Call("preventDefault")
			e.camera.x -= event.Get("deltaX").Float()
			e.camera.y -= event.Get("deltaY").Float()
			e.requestDraw()
		}
	}, passive)

	observer := js.Global().Get("ResizeObserver").New(js.FuncOf(func(js.Value, []js.Value) any {
		if e.camera.fit {
			e.fitCamera()
		}
		e.requestDraw()
		return nil
	}))
	observer.Call("observe", stage)
	e.signal.Call("addEventListener", "abort", js.FuncOf(func(js.Value, []js.Value) any {
		observer.Call("disconnect")
		return nil
	}))
}
