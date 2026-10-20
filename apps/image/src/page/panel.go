//go:build js

package page

import (
	"math"
	"slices"
	"strconv"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/packages/ui/src/web"
)

var typeIcons = map[string]string{
	model.TypeImage:   `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3 3 3-3 5 5"/></svg>`,
	model.TypeText:    `<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>`,
	model.TypeRect:    `<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>`,
	model.TypeEllipse: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`,
	model.TypePath:    `<svg viewBox="0 0 24 24"><path d="M12 3 5 14l7 7 7-7z"/><circle cx="12" cy="13" r="1.6"/></svg>`,
}

func eyeIcon(visible bool) string {
	if visible {
		return `<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`
	}
	return `<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.4-1"/></svg>`
}

// readProp はパネルの欄（data-prop）に対応するレイヤーの値。そのレイヤーに無い値は nil。
func readProp(layer *model.Layer, path string) any {
	shape := layer.IsShape()
	text := layer.Type == model.TypeText
	path2 := layer.Type == model.TypePath
	switch path {
	case "name":
		return layer.Name
	case "x":
		return layer.X
	case "y":
		return layer.Y
	case "width":
		return layer.Width
	case "height":
		return layer.Height
	case "opacity":
		return layer.Opacity
	case "filters.preset":
		return layer.Filters.Preset
	case "filters.brightness":
		return layer.Filters.Brightness
	case "filters.contrast":
		return layer.Filters.Contrast
	case "filters.saturation":
		return layer.Filters.Saturation
	case "filters.hue":
		return layer.Filters.Hue
	case "filters.tint":
		return layer.Filters.Tint
	case "filters.tintAmount":
		return layer.Filters.TintAmount
	case "filters.blur":
		return layer.Filters.Blur
	case "fill":
		if shape {
			return layer.Fill
		}
	case "fillEnabled":
		if shape {
			return layer.FillEnabled
		}
	case "stroke":
		if shape {
			return layer.Stroke
		}
	case "radius":
		if layer.Type == model.TypeRect {
			return layer.Radius
		}
	case "strokeWidth":
		if shape || text || path2 {
			return layer.StrokeWidth
		}
	case "strokeColor":
		if text || path2 {
			return layer.StrokeColor
		}
	case "shadow":
		if text || path2 {
			return layer.Shadow
		}
	case "align":
		if text {
			return layer.Align
		}
	case "lineHeight":
		if text {
			return layer.LineHeight
		}
	}
	return nil
}

// writeProp はパネルの欄の値をレイヤーに書く。
func writeProp(layer *model.Layer, path string, value any) {
	f, _ := value.(float64)
	s, _ := value.(string)
	b, _ := value.(bool)
	switch path {
	case "name":
		layer.Name = s
	case "x":
		layer.X = f
	case "y":
		layer.Y = f
	case "width":
		layer.Width = f
	case "height":
		layer.Height = f
	case "opacity":
		layer.Opacity = f
	case "filters.preset":
		layer.Filters.Preset = s
	case "filters.brightness":
		layer.Filters.Brightness = f
	case "filters.contrast":
		layer.Filters.Contrast = f
	case "filters.saturation":
		layer.Filters.Saturation = f
	case "filters.hue":
		layer.Filters.Hue = f
	case "filters.tint":
		layer.Filters.Tint = s
	case "filters.tintAmount":
		layer.Filters.TintAmount = f
	case "filters.blur":
		layer.Filters.Blur = f
	case "fill":
		layer.Fill = s
	case "fillEnabled":
		layer.FillEnabled = b
	case "stroke":
		layer.Stroke = s
	case "radius":
		layer.Radius = f
	case "strokeWidth":
		layer.StrokeWidth = f
	case "strokeColor":
		layer.StrokeColor = s
	case "shadow":
		layer.Shadow = b
	case "align":
		layer.Align = s
	case "lineHeight":
		layer.LineHeight = f
	}
}

// propString は JavaScript の String(value ?? "")。
func propString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		return formatNumber(v)
	case bool:
		return strconv.FormatBool(v)
	}
	return ""
}

// isLight は明るい色か（パネルの編集欄で、白っぽい文字を暗い背景で見せる）。
func isLight(color string) bool {
	if len(color) < 2 {
		return false
	}
	value, err := strconv.ParseInt(color[1:], 16, 64)
	if err != nil {
		return false
	}
	r := float64(value / 65536 % 256)
	g := float64(value / 256 % 256)
	b := float64(value % 256)
	return (0.299*r+0.587*g+0.114*b)/255 > 0.6
}

// ---- 選択とパネル ----

func (e *editor) selectLayer(id string) {
	if e.crop != nil && id != "" {
		e.cancelCrop()
	}
	if e.editingID != "" && e.editingID != id {
		e.finishEditing()
	}
	if id != e.selectedID {
		e.charRange = nil
	}
	e.selectedID = id
	e.renderLayerList()
	e.syncPanel()
	e.requestDraw()
}

func (e *editor) thumbnail(layer *model.Layer) js.Value {
	document := web.Document()
	canvas := document.Call("createElement", "canvas")
	const size = 36.0
	ratio := devicePixelRatio()
	canvas.Set("width", size*ratio)
	canvas.Set("height", size*ratio)
	canvas.Set("className", "layer__thumb")
	canvas.Call("setAttribute", "aria-hidden", "true")
	context := canvas.Call("getContext", "2d")
	rendered := e.cache.Get(layer)
	rw, rh := rendered.Canvas.Get("width").Float(), rendered.Canvas.Get("height").Float()
	scale := math.Min(size*ratio/rw, size*ratio/rh)
	w, h := rw*scale, rh*scale
	context.Set("imageSmoothingQuality", "high")
	context.Call("drawImage", rendered.Canvas, (size*ratio-w)/2, (size*ratio-h)/2, w, h)
	return canvas
}

func (e *editor) renderLayerList() {
	document := web.Document()
	e.layerList.Call("replaceChildren")
	var layers []*model.Layer
	if e.doc != nil {
		layers = e.doc.Layers
	}
	e.layerEmpty.Set("hidden", len(layers) > 0)
	e.layerActions.Set("hidden", len(layers) == 0)
	// 上にあるレイヤーほどリストの上に出す
	for i := len(layers) - 1; i >= 0; i-- {
		layer := layers[i]
		item := document.Call("createElement", "li")
		item.Set("className", "layer")
		item.Get("dataset").Set("id", layer.ID)
		toggleClass(item, "layer--selected", layer.ID == e.selectedID)
		toggleClass(item, "layer--hidden", !layer.Visible)

		eye := document.Call("createElement", "button")
		eye.Set("type", "button")
		eye.Set("className", "layer__eye")
		eye.Get("dataset").Set("layerAction", "toggle")
		eye.Call("setAttribute", "aria-pressed", strconv.FormatBool(layer.Visible))
		eye.Call("setAttribute", "aria-label", layer.Name+" を表示")
		if layer.Visible {
			eye.Set("title", "非表示にする")
		} else {
			eye.Set("title", "表示する")
		}
		eye.Set("innerHTML", eyeIcon(layer.Visible))

		pick := document.Call("createElement", "button")
		pick.Set("type", "button")
		pick.Set("className", "layer__pick")
		pick.Get("dataset").Set("layerAction", "select")
		pick.Call("setAttribute", "aria-current", strconv.FormatBool(layer.ID == e.selectedID))
		icon := document.Call("createElement", "span")
		icon.Set("className", "layer__type")
		icon.Set("innerHTML", typeIcons[layer.Type])
		icon.Call("setAttribute", "aria-hidden", "true")
		name := document.Call("createElement", "span")
		name.Set("className", "layer__name")
		setText(name, layer.Name)
		pick.Call("append", e.thumbnail(layer), name, icon)

		item.Call("append", eye, pick)
		e.layerList.Call("append", item)
	}
	layer := e.selected()
	index := -1
	if layer != nil {
		index = e.doc.Index(layer)
	}
	for _, button := range queryAll(e.layerActions, "[data-action]") {
		action := dataset(button, "action")
		button.Set("disabled", layer == nil ||
			(action == "layer-up" && index == len(layers)-1) ||
			(action == "layer-down" && index == 0))
	}
}

func (e *editor) propInputs() []js.Value { return queryAll(e.props, "[data-prop]") }

func (e *editor) showOutput(input js.Value) {
	output := query(e.props, `output[for="`+input.Get("id").String()+`"]`)
	if !output.IsNull() {
		output.Set("value", input.Get("value").String()+dataset(input, "unit"))
	}
}

func activeElement() js.Value { return web.Document().Get("activeElement") }

// syncGeometry は位置と大きさの欄だけ更新する（ドラッグ中）。
func (e *editor) syncGeometry() {
	layer := e.selected()
	if layer == nil {
		return
	}
	for _, key := range []string{"x", "y", "width", "height"} {
		input := query(e.props, `[data-prop="`+key+`"]`)
		if !input.IsNull() && !activeElement().Equal(input) {
			input.Set("value", propString(readProp(layer, key)))
		}
	}
	if layer.Type == model.TypeText {
		e.syncCharControls()
	}
}

// syncPanel は選択中のレイヤーの値をパネルに反映する。
func (e *editor) syncPanel() {
	cropping := e.crop != nil
	e.cropForm.Set("hidden", !cropping)
	e.cropBar.Set("hidden", !cropping)
	e.cropButton.Call("setAttribute", "aria-pressed", strconv.FormatBool(cropping))
	if cropping {
		e.props.Set("hidden", true)
		e.docForm.Set("hidden", true)
		setText(e.propsTitle, "トリミング")
		e.syncCropPanel()
		return
	}
	layer := e.selected()
	e.props.Set("hidden", layer == nil)
	e.docForm.Set("hidden", e.doc == nil || layer != nil)
	switch {
	case layer != nil:
		setText(e.propsTitle, model.LayerTypeLabels[layer.Type]+"の設定")
	case e.doc != nil:
		setText(e.propsTitle, "キャンバスの設定")
	default:
		setText(e.propsTitle, "設定")
	}
	if e.doc != nil && layer == nil {
		e.syncDocPanel()
	}
	if layer == nil {
		return
	}
	for _, section := range queryAll(e.props, "[data-for]") {
		section.Set("hidden", !slices.Contains(strings.Split(dataset(section, "for"), " "), layer.Type))
	}
	for _, input := range e.propInputs() {
		value := readProp(layer, dataset(input, "prop"))
		switch typ := input.Get("type").String(); {
		case typ == "checkbox":
			input.Set("checked", value == true)
		case typ == "radio":
			s, ok := value.(string)
			input.Set("checked", ok && input.Get("value").String() == s)
		case !activeElement().Equal(input) || typ == "range":
			input.Set("value", propString(value))
		}
		if input.Get("type").String() == "range" {
			e.showOutput(input)
		}
	}
	// テキストの枠の大きさは文字から決まる
	for _, key := range []string{"width", "height"} {
		if input := query(e.props, `[data-prop="`+key+`"]`); !input.IsNull() {
			input.Set("disabled", layer.Type == model.TypeText)
		}
	}
	if layer.Type == model.TypeText {
		if !activeElement().Equal(e.rich) {
			e.renderPanelText(layer)
		}
		e.syncCharControls()
		e.syncFontInfo(layer)
		e.showHighlight()
	}
	if layer.Type == model.TypePath {
		color := "#ffffff"
		if len(layer.Parts) > 0 {
			color = layer.Parts[0].Color
		}
		e.pathFill.Set("value", color)
	}
}

func (e *editor) docInput(name string) js.Value {
	return query(e.docForm, `[name="`+name+`"]`)
}

func (e *editor) syncDocPanel() {
	if e.doc == nil {
		return
	}
	e.docInput("name").Set("value", e.doc.Name)
	e.docInput("width").Set("value", formatNumber(e.doc.Width))
	e.docInput("height").Set("value", formatNumber(e.doc.Height))
	e.docInput("transparent").Set("checked", e.doc.Background == "")
	background := e.doc.Background
	if background == "" {
		background = "#ffffff"
	}
	e.docInput("background").Set("value", background)
	e.docInput("background").Set("disabled", e.doc.Background == "")
}

// truncate は文字列を UTF-16 で n 文字までにする（JavaScript の slice(0, n)）。
func truncate(value string, n int) string {
	count := 0
	for i, r := range value {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if count+size > n {
			return value[:i]
		}
		count += size
	}
	return value
}

func (e *editor) bindPanel() {
	on(e.layerList, "click", func(event js.Value) {
		target := closest(event.Get("target"), "[data-layer-action]")
		if target.IsNull() || e.doc == nil {
			return
		}
		item := target.Call("closest", ".layer")
		if item.IsNull() {
			return
		}
		id := dataset(item, "id")
		if id == "" {
			return
		}
		if dataset(target, "layerAction") == "toggle" {
			layer := e.doc.Find(id)
			if layer == nil {
				return
			}
			layer.Visible = !layer.Visible
			e.commit()
			e.requestDraw()
			escaped := js.Global().Get("CSS").Call("escape", id).String()
			if eye := query(e.layerList, `.layer[data-id="`+escaped+`"] .layer__eye`); !eye.IsNull() {
				eye.Call("focus")
			}
			return
		}
		e.selectLayer(id)
	})

	on(e.props, "input", func(event js.Value) {
		input := event.Get("target")
		tag := ""
		if isElement(input) {
			tag = input.Get("tagName").String()
		}
		if tag != "INPUT" && tag != "TEXTAREA" && tag != "SELECT" {
			return
		}
		layer := e.selected()
		if layer == nil {
			return
		}
		// 文字ごとの書式
		if char := dataset(input, "char"); char != "" && tag == "INPUT" {
			switch char {
			case "size":
				size := number(input.Get("value"))
				if input.Get("value").String() == "" || !input.Call("checkValidity").Bool() || !isFinite(size) {
					return
				}
				e.applyChar(func(s *model.CharStyle) { s.Size = size })
			case "color":
				color := input.Get("value").String()
				e.applyChar(func(s *model.CharStyle) { s.Color = color })
			case "bold":
				bold := input.Get("checked").Bool()
				e.applyChar(func(s *model.CharStyle) { s.Bold = bold })
			}
			return
		}
		// パスの塗りは、すべての文字の色をまとめて変える
		if input.Equal(e.pathFill) && layer.Type == model.TypePath {
			color := input.Get("value").String()
			parts := make([]model.Part, len(layer.Parts))
			for i, part := range layer.Parts {
				part.Color = color
				parts[i] = part
			}
			layer.Parts = parts
			e.requestDraw()
			return
		}
		path := dataset(input, "prop")
		if path == "" {
			return
		}
		var value any
		typ := input.Get("type").String()
		switch {
		case tag == "INPUT" && typ == "checkbox":
			value = input.Get("checked").Bool()
		case tag == "INPUT" && (typ == "number" || typ == "range"):
			if input.Get("value").String() == "" || !input.Call("checkValidity").Bool() {
				return
			}
			n := number(input.Get("value"))
			if !isFinite(n) {
				return
			}
			value = n
			if typ == "range" {
				e.showOutput(input)
			}
		default:
			value = input.Get("value").String()
		}
		if s, ok := value.(string); ok && path == "name" {
			value = truncate(s, 200)
		}
		writeProp(layer, path, value)
		if f, ok := value.(float64); ok && (path == "width" || path == "height") {
			writeProp(layer, path, math.Max(1, model.Round(f)))
		}
		if layer.Type == model.TypeText {
			e.textChanged(layer)
			e.renderEditors(layer)
			e.syncGeometry()
		}
		if path == "name" {
			escaped := js.Global().Get("CSS").Call("escape", layer.ID).String()
			if name := query(e.layerList, `.layer[data-id="`+escaped+`"] .layer__name`); !name.IsNull() {
				setText(name, layer.Name)
			}
		}
		e.requestDraw()
	})

	// 値を決めたところ（スライダーを離した、欄から出た）で履歴に積む
	on(e.props, "change", func(js.Value) {
		e.commit()
		e.syncPanel()
	})

	on(e.props, "click", func(event js.Value) {
		target := closest(event.Get("target"), "[data-action='reset-filters']")
		layer := e.selected()
		if target.IsNull() || layer == nil {
			return
		}
		layer.Filters = model.DefaultFilters
		e.commit()
		e.syncPanel()
		e.requestDraw()
	})

	on(e.docForm, "submit", func(event js.Value) { event.Call("preventDefault") })
	on(e.docForm, "input", func(event js.Value) {
		input := event.Get("target")
		if !isElement(input) || input.Get("tagName").String() != "INPUT" || e.doc == nil {
			return
		}
		switch input.Get("name").String() {
		case "name":
			e.doc.Name = truncate(input.Get("value").String(), 200)
		case "transparent":
			checked := input.Get("checked").Bool()
			if checked {
				e.doc.Background = ""
			} else {
				e.doc.Background = e.docInput("background").Get("value").String()
			}
			e.docInput("background").Set("disabled", checked)
		case "background":
			if !e.docInput("transparent").Get("checked").Bool() {
				e.doc.Background = input.Get("value").String()
			}
		}
		e.requestDraw()
	})
	on(e.docForm, "change", func(event js.Value) {
		input := event.Get("target")
		if !isElement(input) || input.Get("tagName").String() != "INPUT" || e.doc == nil {
			return
		}
		if name := input.Get("name").String(); name == "width" || name == "height" {
			width := number(e.docInput("width").Get("value"))
			height := number(e.docInput("height").Get("value"))
			if isFinite(width) && isFinite(height) && width >= 1 && height >= 1 {
				w, h, scaled := model.FitSize(model.Round(width), model.Round(height))
				e.doc.Width = w
				e.doc.Height = h
				if scaled {
					e.notify("大きすぎるので、扱える大きさまで縮めました。", true)
				}
				e.setStageRatio()
				e.fitCamera()
			}
			e.syncDocPanel()
		}
		e.commit()
		e.requestDraw()
	})
}

// setStageRatio は狭い画面で、キャンバスの高さをドキュメントの縦横比に合わせる（CSS で使う）。
func (e *editor) setStageRatio() {
	if e.doc != nil {
		e.stage.Get("style").Call("setProperty", "--doc-hw", formatNumber(e.doc.Height/e.doc.Width))
	}
}

func (e *editor) refreshAll() {
	e.empty.Set("hidden", e.doc != nil)
	toggleClass(e.stage, "stage--ready", e.doc != nil)
	e.setStageRatio()
	if e.doc != nil {
		e.root.Get("dataset").Set("state", "ready")
	} else {
		e.root.Get("dataset").Set("state", "empty")
	}
	e.renderLayerList()
	e.syncPanel()
	e.requestDraw()
}
