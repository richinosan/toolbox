//go:build js

package page

import (
	"errors"
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/assets"
	"toolbox.richinosan.com/apps/image/src/web/exporter"
	"toolbox.richinosan.com/apps/image/src/web/outline"
	"toolbox.richinosan.com/apps/image/src/web/project"
	"toolbox.richinosan.com/apps/image/src/web/render"
	"toolbox.richinosan.com/packages/ui/src/web"
)

type loaded struct {
	blob, image js.Value
	scaled      bool
}

// loadImage は画像を読み込む。大きすぎる画像はキャンバスの上限まで縮めてから使う。待つ。
func loadImage(file js.Value) (loaded, error) {
	original, err := web.Await(js.Global().Call("createImageBitmap", file))
	if err != nil {
		return loaded{}, err
	}
	width, height, scaled := model.FitSize(original.Get("width").Float(), original.Get("height").Float())
	if !scaled {
		return loaded{file, original, false}, nil
	}
	canvas := web.Document().Call("createElement", "canvas")
	canvas.Set("width", width)
	canvas.Set("height", height)
	context := canvas.Call("getContext", "2d")
	context.Set("imageSmoothingQuality", "high")
	context.Call("drawImage", original, 0, 0, width, height)
	original.Call("close")
	typ := "image/png"
	if file.Get("type").String() == "image/jpeg" {
		typ = "image/jpeg"
	}
	blob, err := exporter.ToBlob(canvas, typ, 0.92)
	if err != nil {
		return loaded{}, err
	}
	image, err := web.Await(js.Global().Call("createImageBitmap", blob))
	if err != nil {
		return loaded{}, err
	}
	return loaded{blob, image, true}, nil
}

// formatBytes はファイルサイズを「0.98 MB」「320 KB」のように書く。
func formatBytes(bytes float64) string {
	if bytes >= megabyte/10 {
		return js.Global().Get("Number").New(bytes/megabyte).Call("toFixed", 2).String() + " MB"
	}
	return formatNumber(math.Max(1, model.Round(bytes/1000))) + " KB"
}

// buildOutlines は保存の前に、テキストの文字の形（パス）を作っておく。作れなかったテキストの数を返す。待つ。
func buildOutlines(target *model.Doc) int {
	failed := 0
	for _, layer := range target.Layers {
		if layer.Type != model.TypeText {
			continue
		}
		// 標準のフォントはどの端末でも使えるので、パスは要らない
		builtin := true
		for _, run := range layer.Runs {
			builtin = builtin && run.Style.Font.Source == "builtin"
		}
		if builtin || strings.TrimSpace(richtext.PlainText(layer.Runs)) == "" {
			layer.Outline = nil
			continue
		}
		if layer.Outline != nil && layer.Outline.Key == richtext.OutlineKey(layer) {
			continue
		}
		render.LoadFonts(layer)
		built, ok := outline.Build(layer)
		if !ok {
			built = nil
			failed++
		}
		layer.Outline = built
	}
	return failed
}

func (e *editor) confirmDiscard() bool {
	return !e.isDirty() || js.Global().Call("confirm", "保存していない変更があります。破棄してよろしいですか？").Bool()
}

func (e *editor) resetHistory() {
	e.history = []snapshot{e.snapshot()}
	e.historyIndex = 0
	e.savedIndex = 0
	e.updateHistoryButtons()
}

func (e *editor) startDoc(next *model.Doc, handle js.Value) {
	e.closeStageText()
	e.charRange = nil
	e.crop = nil
	e.doc = next
	e.fileHandle = handle
	e.selectedID = ""
	e.cache.Clear()
	e.resetHistory()
	e.fitCamera()
	e.refreshAll()
	// テキストのフォントを読み込んでから描き直す
	for _, layer := range next.Layers {
		if layer.Type == model.TypeText {
			e.textChanged(layer)
		}
	}
}

func (e *editor) addAsset(blob, image js.Value) string {
	id := model.NewID()
	e.assets[id] = assets.Asset{Blob: blob, Image: image}
	return id
}

func (e *editor) addLayer(layer *model.Layer) {
	if e.doc == nil {
		return
	}
	// 選択中のレイヤーのすぐ上に置く
	index := len(e.doc.Layers)
	if current := e.selected(); current != nil {
		index = e.doc.Index(current) + 1
	}
	e.doc.Layers = append(e.doc.Layers[:index:index], append([]*model.Layer{layer}, e.doc.Layers[index:]...)...)
	e.selectedID = layer.ID
	e.commit()
	e.syncPanel()
	e.requestDraw()
}

// openImage は画像を開く（asNewDoc なら新しいドキュメントにする）。待つ。
func (e *editor) openImage(file js.Value, name string, asNewDoc bool) {
	image, err := loadImage(file)
	if err != nil {
		e.notify("この画像は読み込めませんでした。", true)
		return
	}
	asset := e.addAsset(image.blob, image.image)
	width, height := image.image.Get("width").Float(), image.image.Get("height").Float()
	if asNewDoc || e.doc == nil {
		next := &model.Doc{Name: name, Width: width, Height: height}
		e.startDoc(next, js.Null())
		layer := model.CreateImage(next, asset, width, height, name)
		layer.X, layer.Y = 0, 0
		e.addLayer(layer)
		// 開いた画像を履歴の始まりにする（元に戻すで画像が消えないように）
		e.resetHistory()
	} else {
		e.addLayer(model.CreateImage(e.doc, asset, width, height, name))
	}
	if image.scaled {
		e.notify("大きい画像なので、扱える大きさまで縮めました。", false)
	}
}

// openProject は作品ファイルを開く。待つ。
func (e *editor) openProject(file, handle js.Value) {
	doc, loaded, err := project.Deserialize(file)
	if err != nil {
		var projectError *project.Error
		if errors.As(err, &projectError) {
			e.notify(projectError.Message, true)
		} else {
			e.notify("ファイルを開けませんでした。", true)
		}
		return
	}
	for id, asset := range loaded {
		e.assets[id] = asset
	}
	e.startDoc(doc, handle)
	e.savedIndex = e.historyIndex
	e.notify("「"+doc.Name+"」を開きました。", false)
}

// openFile は作品ファイルか画像を開く。待つ。
func (e *editor) openFile(file, handle js.Value) {
	switch {
	case project.IsProjectFile(file):
		e.openProject(file, handle)
	case project.IsImageFile(file):
		e.openImage(file, project.BaseName(file.Get("name").String()), true)
	default:
		e.notify("画像か IMAGE の作品ファイル（.tbimg）を選んでください。", true)
	}
}

func (e *editor) open() {
	if !e.confirmDiscard() {
		return
	}
	go func() {
		file, handle, ok := project.PickFile(e.openInput)
		if ok {
			e.openFile(file, handle)
		}
	}()
}

func (e *editor) addImage() {
	input := e.imageInput
	input.Set("value", "")
	options := js.Global().Get("Object").New()
	options.Set("once", true)
	options.Set("signal", e.signal)
	on(input, "change", func(js.Value) {
		files := input.Get("files")
		if !files.Truthy() || files.Length() == 0 {
			return
		}
		file := files.Index(0)
		go e.openImage(file, project.BaseName(file.Get("name").String()), e.doc == nil)
	}, options)
	input.Call("click")
}

func (e *editor) addText() {
	if e.doc == nil {
		return
	}
	// 前に選んでいたテキストの書式を引き継ぐ
	var style *model.CharStyle
	if previous := e.textLayer(); previous != nil {
		s := previous.Runs[0].Style.Clone()
		s.Size = richtext.MaxSize(previous.Runs)
		style = &s
	}
	layer := model.CreateText(e.doc, style)
	render.FitText(layer)
	layer.X = model.Round((e.doc.Width - layer.Width) / 2)
	layer.Y = model.Round((e.doc.Height - layer.Height) / 2)
	e.addLayer(layer)
	e.textChanged(layer)
	e.startEditing(layer)
}

// ---- 保存と書き出し ----

func (e *editor) save(saveAs bool) {
	if e.doc == nil || e.saving {
		return
	}
	e.saving = true
	// 入力中の文字も履歴に積んでから保存する
	clearTimer(e.commitTimer)
	e.commit()
	index := e.historyIndex
	doc := e.doc
	handle := e.fileHandle
	if saveAs {
		handle = js.Null()
	}
	go func() {
		defer func() { e.saving = false }()
		failed := 0
		var saved js.Value
		var cancelled bool
		var err error
		ok := web.Try(func() {
			failed = buildOutlines(doc)
			var blob js.Value
			blob, err = project.Serialize(doc, e.assets)
			if err != nil {
				return
			}
			saved, cancelled, err = project.Save(blob, doc.Name, handle)
		})
		if !ok || err != nil {
			e.notify("保存できませんでした。", true)
			return
		}
		if cancelled {
			return
		}
		e.fileHandle = saved
		e.savedIndex = index
		message := "作品ファイルをダウンロードしました。"
		if saved.Truthy() {
			message = saved.Get("name").String() + " に保存しました。"
		}
		if failed > 0 {
			message += "フォントのデータを読めないテキストがあったため、そのテキストの文字の形（パス）は保存していません。"
		}
		e.notify(message, failed > 0)
	}()
}

func (e *editor) exportInput(name string) js.Value {
	return query(e.exportForm, `[name="`+name+`"]`)
}

func (e *editor) exportQuality() float64 { return number(e.exportInput("quality").Get("value")) / 100 }

func (e *editor) exportFormat() string {
	if format, ok := formValue(e.exportForm, "format"); ok {
		return format
	}
	return "png"
}

// exportLimit はサイズを指定して圧縮するときの上限。画質を指定するときや PNG・PSD では nil。
func (e *editor) exportLimit() *exporter.Limit {
	format := e.exportFormat()
	if format != "jpeg" && format != "webp" {
		return nil
	}
	if mode, _ := formValue(e.exportForm, "mode"); mode != "size" {
		return nil
	}
	megabytes := number(e.exportInput("limit").Get("value"))
	if !isFinite(megabytes) || megabytes <= 0 {
		return nil
	}
	return &exporter.Limit{Bytes: math.Floor(megabytes * megabyte), Shrink: e.exportInput("shrink").Get("checked").Bool()}
}

func (e *editor) syncExportForm() {
	format := e.exportFormat()
	lossy := format == "jpeg" || format == "webp"
	mode, _ := formValue(e.exportForm, "mode")
	bySize := mode == "size"
	query(e.exportForm, "#export-mode").Set("hidden", !lossy)
	query(e.exportForm, "#export-quality").Set("hidden", !lossy || bySize)
	query(e.exportForm, "#export-limit").Set("hidden", !lossy || !bySize)
	limit := number(e.exportInput("limit").Get("value"))
	for _, chip := range queryAll(e.exportForm, "[data-limit]") {
		pressed := "false"
		if number(js.ValueOf(dataset(chip, "limit"))) == limit {
			pressed = "true"
		}
		chip.Call("setAttribute", "aria-pressed", pressed)
	}
	var note string
	switch {
	case lossy && bySize:
		note = "上限に収まる、一番きれいな画質を探して書き出します（1 MB = 1,000,000 バイト）。"
		if format == "jpeg" {
			note += "透明な部分は白で塗りつぶします。"
		}
	case format == "psd":
		note = "レイヤーを保ったまま書き出します。テキストと図形は、フィルターを適用した画像のレイヤーになります。"
	case format == "jpeg":
		note = "透明な部分は白で塗りつぶします。"
	case format == "png":
		note = "透明な部分は透明のまま書き出します。"
	default:
		note = "透明な部分は透明のまま書き出します。対応していないブラウザでは PNG になります。"
	}
	setText(query(e.exportForm, "#export-note"), note)
	if output := query(e.exportForm, `output[for="export-quality-input"]`); !output.IsNull() {
		output.Set("value", formatNumber(model.Round(e.exportQuality()*100)))
	}
}

func (e *editor) submitExport(event js.Value) {
	event.Call("preventDefault")
	if e.doc == nil {
		return
	}
	submitter := event.Get("submitter")
	button := js.Null()
	if isElement(submitter) && submitter.Get("tagName").String() == "BUTTON" {
		button = submitter
	}
	value := ""
	if !button.IsNull() {
		value = button.Get("value").String()
	}
	if value == "cancel" {
		e.exportDialog.Call("close")
		return
	}
	if !button.IsNull() {
		button.Set("disabled", true)
	}
	doc := e.doc
	format, quality, limit := e.exportFormat(), e.exportQuality(), e.exportLimit()
	if value != "copy" && limit != nil {
		setText(query(e.exportForm, "#export-note"), "圧縮しています…")
	}
	finish := func() {
		if !button.IsNull() {
			button.Set("disabled", false)
		}
		e.syncExportForm()
	}
	if value == "copy" {
		// Safari はクリックのすぐあとに clipboard.write を呼ぶ必要があるので、待つ前に呼ぶ
		go func() {
			defer finish()
			if err := exporter.CopyImage(doc, e.cache); err != nil {
				e.notify("クリップボードにコピーできませんでした。", true)
				return
			}
			e.notify("画像をクリップボードにコピーしました。", false)
			e.exportDialog.Call("close")
		}()
		return
	}
	go func() {
		defer finish()
		var result exporter.Result
		var err error
		if !web.Try(func() { result, err = exporter.ExportFile(doc, e.cache, format, quality, limit) }) || err != nil {
			e.notify("書き出せませんでした。", true)
			return
		}
		packed := result.Compressed
		switch {
		case result.Actual != result.Requested:
			e.notify("このブラウザは WebP に対応していないため、PNG で書き出しました。", false)
		case packed != nil:
			detail := formatBytes(result.Size) + "（画質 " + formatNumber(model.Round(packed.Quality*100)) + "%"
			if packed.Shrunk {
				detail += "、" + size(packed.Width, packed.Height) + " に縮小"
			}
			detail += "）"
			if packed.Fitted {
				e.notify(detail+"で書き出しました。", false)
			} else {
				e.notify("上限に収まりませんでした。一番小さくした "+detail+"で書き出しました。", true)
			}
		default:
			e.notify(formatBytes(result.Size)+"で書き出しました。", false)
		}
		e.exportDialog.Call("close")
	}()
}

func (e *editor) showExport() {
	if e.doc == nil {
		return
	}
	setText(query(e.exportForm, "#export-size"), size(e.doc.Width, e.doc.Height)+" px")
	e.syncExportForm()
	e.exportDialog.Call("showModal")
}

// ---- 新規作成 ----

func (e *editor) syncNewForm() {
	preset, _ := formValue(e.newForm, "preset")
	query(e.newForm, "#new-custom").Set("hidden", preset != "custom")
}

func (e *editor) submitNew(event js.Value) {
	event.Call("preventDefault")
	submitter := event.Get("submitter")
	if isElement(submitter) && submitter.Get("tagName").String() == "BUTTON" && submitter.Get("value").String() == "cancel" {
		e.newDialog.Call("close")
		return
	}
	preset, ok := formValue(e.newForm, "preset")
	if !ok {
		preset = "1920x1080"
	}
	var w, h float64
	if preset == "custom" {
		width, _ := formValue(e.newForm, "width")
		height, _ := formValue(e.newForm, "height")
		w, h = number(js.ValueOf(width)), number(js.ValueOf(height))
	} else {
		parts := strings.Split(preset, "x")
		w = number(js.ValueOf(parts[0]))
		if len(parts) > 1 {
			h = number(js.ValueOf(parts[1]))
		}
	}
	if w == 0 || h == 0 || !isFinite(w) || !isFinite(h) || w < 1 || h < 1 {
		return
	}
	width, height, scaled := model.FitSize(model.Round(w), model.Round(h))
	background, ok := formValue(e.newForm, "background")
	if !ok {
		background = "white"
	}
	e.newDialog.Call("close")
	color := "#ffffff"
	switch background {
	case "transparent":
		color = ""
	case "black":
		color = "#000000"
	}
	e.startDoc(&model.Doc{Name: "無題", Width: width, Height: height, Background: color}, js.Null())
	if scaled {
		e.notify("大きすぎるので、扱える大きさまで縮めました。", true)
	}
}

func (e *editor) showNew() {
	if !e.confirmDiscard() {
		return
	}
	e.syncNewForm()
	e.newDialog.Call("showModal")
}

// ---- レイヤーの並べ替え・複製・削除 ----

func (e *editor) moveLayer(direction int) {
	layer := e.selected()
	if e.doc == nil || layer == nil {
		return
	}
	index := e.doc.Index(layer)
	next := index + direction
	if next < 0 || next >= len(e.doc.Layers) {
		return
	}
	e.doc.Layers[index], e.doc.Layers[next] = e.doc.Layers[next], e.doc.Layers[index]
	e.commit()
	e.requestDraw()
}

func (e *editor) duplicate() {
	if layer := e.selected(); layer != nil {
		e.addLayer(model.Duplicate(layer))
	}
}

func (e *editor) remove() {
	layer := e.selected()
	if e.doc == nil || layer == nil {
		return
	}
	index := e.doc.Index(layer)
	e.doc.Layers = append(e.doc.Layers[:index:index], e.doc.Layers[index+1:]...)
	e.selectedID = ""
	if len(e.doc.Layers) > 0 {
		e.selectedID = e.doc.Layers[min(index, len(e.doc.Layers)-1)].ID
	}
	e.cache.Prune(e.doc)
	e.commit()
	e.syncPanel()
	e.requestDraw()
}

func (e *editor) nudge(dx, dy float64) {
	layer := e.selected()
	if layer == nil {
		return
	}
	layer.X += dx
	layer.Y += dy
	e.syncGeometry()
	e.requestDraw()
}

func (e *editor) bindFiles() {
	on(e.exportForm, "input", func(js.Value) { e.syncExportForm() })
	on(e.exportForm, "click", func(event js.Value) {
		chip := closest(event.Get("target"), "[data-limit]")
		if chip.IsNull() {
			return
		}
		e.exportInput("limit").Set("value", dataset(chip, "limit"))
		e.syncExportForm()
	})
	on(e.exportForm, "submit", e.submitExport)
	on(e.newForm, "input", func(js.Value) { e.syncNewForm() })
	on(e.newForm, "submit", e.submitNew)

	// ---- ドロップと貼り付け ----
	on(e.stage, "dragover", func(event js.Value) {
		transfer := event.Get("dataTransfer")
		if transfer.Truthy() && transfer.Get("types").Call("includes", "Files").Bool() {
			event.Call("preventDefault")
			e.stage.Get("classList").Call("add", "stage--drop")
		}
	})
	on(e.stage, "dragleave", func(js.Value) { e.stage.Get("classList").Call("remove", "stage--drop") })
	on(e.stage, "drop", func(event js.Value) {
		event.Call("preventDefault")
		e.stage.Get("classList").Call("remove", "stage--drop")
		transfer := event.Get("dataTransfer")
		if !transfer.Truthy() || transfer.Get("files").Length() == 0 {
			return
		}
		file := transfer.Get("files").Index(0)
		if project.IsProjectFile(file) {
			if e.confirmDiscard() {
				go e.openProject(file, js.Null())
			}
		} else if project.IsImageFile(file) {
			go e.openImage(file, project.BaseName(file.Get("name").String()), e.doc == nil)
		}
	})
	e.onDoc(web.Document(), "paste", func(event js.Value) {
		if isEditable(event.Get("target")) {
			return
		}
		data := event.Get("clipboardData")
		if !data.Truthy() {
			return
		}
		files := data.Get("files")
		for i := 0; i < files.Length(); i++ {
			if file := files.Index(i); project.IsImageFile(file) {
				event.Call("preventDefault")
				go e.openImage(file, "貼り付けた画像", e.doc == nil)
				return
			}
		}
	})
}
