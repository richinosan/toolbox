//go:build js

package page

import (
	"strconv"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/packages/ui/src/web"
)

func (e *editor) actions() map[string]func() {
	return map[string]func(){
		"new":         e.showNew,
		"open":        e.open,
		"save":        func() { e.save(false) },
		"export":      e.showExport,
		"add-image":   e.addImage,
		"add-text":    e.addText,
		"add-rect":    func() { e.addShape(model.TypeRect) },
		"add-ellipse": func() { e.addShape(model.TypeEllipse) },
		"undo":        e.undo,
		"redo":        e.redo,
		"snap": func() {
			e.snapEnabled = !e.snapEnabled
			e.snapButton.Call("setAttribute", "aria-pressed", strconv.FormatBool(e.snapEnabled))
		},
		"zoom-in":  func() { e.zoomBy(1.25) },
		"zoom-out": func() { e.zoomBy(0.8) },
		"zoom-fit": func() {
			e.fitCamera()
			e.requestDraw()
		},
		"layer-up":        func() { e.moveLayer(1) },
		"layer-down":      func() { e.moveLayer(-1) },
		"layer-duplicate": e.duplicate,
		"layer-delete":    e.remove,
		"pick-font":       e.pickFont,
		"crop":            e.startCrop,
		"crop-apply":      e.applyCrop,
		"crop-cancel":     e.cancelCrop,
		"to-path":         e.convertToPath,
	}
}

func (e *editor) addShape(typ string) {
	if e.doc != nil {
		e.addLayer(model.CreateShape(e.doc, typ))
	}
}

func (e *editor) bindKeys() {
	actions := e.actions()
	on(e.root, "click", func(event js.Value) {
		target := closest(event.Get("target"), "button[data-action]")
		if target.IsNull() || target.Get("disabled").Bool() {
			return
		}
		if action, ok := actions[dataset(target, "action")]; ok {
			action()
		}
	})

	document := web.Document()
	window := js.Global()
	e.onDoc(document, "keydown", func(event js.Value) {
		if e.newDialog.Get("open").Bool() || e.exportDialog.Get("open").Bool() || e.fontDialog.Get("open").Bool() {
			return
		}
		mod := event.Get("ctrlKey").Bool() || event.Get("metaKey").Bool()
		shift := event.Get("shiftKey").Bool()
		key := strings.ToLower(event.Get("key").String())
		target := event.Get("target")
		switch {
		case mod && key == "s":
			event.Call("preventDefault")
			e.save(shift)
			return
		case mod && key == "o":
			event.Call("preventDefault")
			e.open()
			return
		case mod && key == "e" && e.doc != nil:
			event.Call("preventDefault")
			e.showExport()
			return
		}
		// トリミング中は Enter で切り抜き、Esc でやめる（比率の選択肢にフォーカスがあっても効かせる）
		if e.crop != nil && !mod && (key == "enter" || key == "escape") {
			textInput := isElement(target) && target.Get("tagName").String() == "INPUT" &&
				target.Get("type").String() != "radio" && target.Get("type").String() != "checkbox"
			if !textInput {
				event.Call("preventDefault")
				if key == "enter" {
					e.applyCrop()
				} else {
					e.cancelCrop()
				}
				return
			}
		}
		if isEditable(target) {
			return
		}
		// トリミング中は、ほかのキーでレイヤーを動かしたり消したりしない
		if e.crop != nil && !mod {
			return
		}
		switch {
		case mod && key == "z":
			event.Call("preventDefault")
			if shift {
				e.redo()
			} else {
				e.undo()
			}
			return
		case mod && key == "y":
			event.Call("preventDefault")
			e.redo()
			return
		case mod && key == "d" && e.selected() != nil:
			event.Call("preventDefault")
			e.duplicate()
			return
		}
		current := e.selected()
		if current == nil {
			return
		}
		if key == "enter" && current.Type == model.TypeText {
			event.Call("preventDefault")
			e.startEditing(current)
			return
		}
		switch {
		case key == "delete" || key == "backspace":
			event.Call("preventDefault")
			e.remove()
		case key == "escape":
			e.selectLayer("")
		case strings.HasPrefix(key, "arrow"):
			event.Call("preventDefault")
			step := 1.0
			if shift {
				step = 10
			}
			var dx, dy float64
			switch key {
			case "arrowleft":
				dx = -step
			case "arrowright":
				dx = step
			case "arrowup":
				dy = -step
			case "arrowdown":
				dy = step
			}
			e.nudge(dx, dy)
		}
	})
	// 矢印キーでの移動は、キーを離したところで履歴に積む
	e.onDoc(document, "keyup", func(event js.Value) {
		if strings.HasPrefix(event.Get("key").String(), "Arrow") && !isEditable(event.Get("target")) {
			e.commit()
		}
	})

	// ---- 保存していない変更の確認 ----
	e.onDoc(window, "beforeunload", func(event js.Value) {
		if e.isDirty() {
			event.Call("preventDefault")
		}
	})
	// ClientRouter での遷移はページ全体の読み込みに切り替えて、上の確認を出す
	e.onDoc(document, "astro:before-preparation", func(event js.Value) {
		if e.isDirty() {
			event.Call("preventDefault")
		}
	})
	e.onDoc(window, "resize", func(js.Value) {
		if e.camera.fit {
			e.fitCamera()
		}
		e.requestDraw()
	})
}
