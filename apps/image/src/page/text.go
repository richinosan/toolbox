//go:build js

package page

import (
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
	"toolbox.richinosan.com/apps/image/src/web/outline"
	"toolbox.richinosan.com/apps/image/src/web/render"
	"toolbox.richinosan.com/apps/image/src/web/richedit"
	"toolbox.richinosan.com/apps/image/src/web/textlayout"
	"toolbox.richinosan.com/packages/ui/src/web"
)

// ---- テキストの編集（パネルの編集欄と、キャンバス上の編集欄） ----

func effectsOf(layer *model.Layer) *richedit.Effects {
	return &richedit.Effects{StrokeColor: layer.StrokeColor, StrokeWidth: layer.StrokeWidth, Shadow: layer.Shadow}
}

func highlights() js.Value {
	css := js.Global().Get("CSS")
	if css.IsUndefined() || !css.Get("highlights").Truthy() || js.Global().Get("Highlight").Type() != js.TypeFunction {
		return js.Null()
	}
	return css.Get("highlights")
}

func clearHighlight() {
	if registry := highlights(); !registry.IsNull() {
		registry.Call("delete", highlightName)
	}
}

// textChanged はテキストの内容や大きさが変わったとき、枠の大きさを測り直し、新しく使う文字のフォントを読み込む
// （読み込めたら fonts.Subscribe で測り直して描き直す）。
func (e *editor) textChanged(layer *model.Layer) {
	if layer.Type != model.TypeText {
		return
	}
	render.FitText(layer)
	go render.LoadFonts(layer)
}

// activeEditor は書式を適用する範囲がある編集欄（キャンバス上で編集中ならそちら）。
func (e *editor) activeEditor() js.Value {
	if e.editingID != "" {
		return e.stageText
	}
	return e.rich
}

// renderPanelText はパネルの編集欄に、一番大きな文字が 22px 程度になるように縮めて見せる。
func (e *editor) renderPanelText(layer *model.Layer) {
	richedit.Render(e.rich, layer.Runs, richedit.View{
		Scale:      math.Min(1, 22/richtext.MaxSize(layer.Runs)),
		LineHeight: layer.LineHeight,
		Effects:    effectsOf(layer),
	})
	e.rich.Get("style").Set("textAlign", layer.Align)
	toggleClass(e.rich, "rich--dark", isLight(layer.Runs[0].Style.Color))
}

func (e *editor) renderStageText(layer *model.Layer) {
	e.stageTextScale = e.camera.scale
	richedit.Render(e.stageText, layer.Runs, richedit.View{
		Scale:      e.camera.scale,
		LineHeight: layer.LineHeight,
		Effects:    effectsOf(layer),
	})
	e.stageText.Get("style").Set("textAlign", layer.Align)
}

// renderEditors は書式を変えたあと、両方の編集欄を作り直す（入力中の編集欄の選択範囲は保つ）。
func (e *editor) renderEditors(layer *model.Layer) {
	editors := []js.Value{e.rich}
	if e.editingID != "" {
		editors = append(editors, e.stageText)
	}
	for _, editor := range editors {
		focused := activeElement().Equal(editor)
		start, end, ok := 0, 0, false
		if focused {
			start, end, ok = richedit.GetSelection(editor)
		}
		if editor.Equal(e.rich) {
			e.renderPanelText(layer)
		} else {
			e.renderStageText(layer)
		}
		if ok {
			richedit.SetSelection(editor, start, end)
		}
	}
	e.showHighlight()
}

// positionStageText はキャンバス上の編集欄を、レイヤーの位置と揃えに合わせて置く。
func (e *editor) positionStageText() {
	if e.editingID == "" || e.doc == nil {
		return
	}
	layer := e.doc.Find(e.editingID)
	if layer == nil || layer.Type != model.TypeText {
		e.closeStageText()
		return
	}
	if e.stageTextScale != e.camera.scale {
		e.renderEditors(layer)
	}
	anchor := 1.0
	switch layer.Align {
	case "left":
		anchor = 0
	case "center":
		anchor = 0.5
	}
	p := e.toScreen(layer.X, layer.Y)
	x := p.x + (layer.Width*e.camera.scale-e.stageText.Get("offsetWidth").Float())*anchor
	e.stageText.Get("style").Set("translate", formatNumber(model.Round(x))+"px "+formatNumber(model.Round(p.y))+"px")
}

// showHighlight は編集欄から離れている間も、書式を変える範囲に色を付けておく。
func (e *editor) showHighlight() {
	registry := highlights()
	if registry.IsNull() {
		return
	}
	editor := e.activeEditor()
	if e.charRange == nil || e.charRange.start >= e.charRange.end || activeElement().Equal(editor) {
		registry.Call("delete", highlightName)
		return
	}
	registry.Call("set", highlightName,
		js.Global().Get("Highlight").New(richedit.RangeOf(editor, e.charRange.start, e.charRange.end)))
}

func (e *editor) rangeOrAll() (start, end int) {
	if e.charRange == nil {
		return 0, 0
	}
	return e.charRange.start, e.charRange.end
}

// syncCharControls は書式の欄（フォント・大きさ・色・太字）に、選んでいる文字の書式を出す。
func (e *editor) syncCharControls() {
	layer := e.textLayer()
	if layer == nil {
		return
	}
	start, end := e.rangeOrAll()
	styles := richtext.StylesIn(layer.Runs, start, end)
	style := styles[0]
	sizeInput := query(e.props, `[data-char="size"]`)
	if !activeElement().Equal(sizeInput) {
		sizeInput.Set("value", formatNumber(style.Size))
	}
	query(e.props, `[data-char="color"]`).Set("value", style.Color)
	bold, mixed := true, false
	for _, s := range styles {
		bold = bold && s.Bold
		mixed = mixed || !s.Font.Same(style.Font)
	}
	query(e.props, `[data-char="bold"]`).Set("checked", bold)
	name := style.Font.Family
	if mixed {
		name += " ほか"
	}
	setText(e.fontName, name)
	e.fontName.Get("style").Set("fontFamily", fonts.CSSFamily(style.Font))
}

// syncFontInfo はこの端末で使えないフォントがあれば知らせる。
func (e *editor) syncFontInfo(layer *model.Layer) {
	var missing []string
	for _, run := range layer.Runs {
		if fonts.Status(run.Style.Font) == fonts.Missing && !contains(missing, run.Style.Font.Family) {
			missing = append(missing, run.Style.Font.Family)
		}
	}
	e.fontMissing.Set("hidden", len(missing) == 0)
	if len(missing) == 0 {
		return
	}
	names := "「" + strings.Join(missing, "」「") + "」"
	if textlayout.UsesOutline(layer) {
		setText(e.fontMissing, names+"はこの端末で使えないため、保存されたパス（文字の形）で表示しています。文字を編集すると代わりのフォントで表示されるので、先にフォントを選び直すか、「ファイル」からフォントを読み込んでください。")
	} else {
		setText(e.fontMissing, names+"はこの端末で使えないため、代わりのフォントで表示しています。フォントを選び直すか、「ファイル」からフォントを読み込んでください。")
	}
}

func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

// applyChar は選んでいる文字（無ければテキスト全体）に書式を適用する。
func (e *editor) applyChar(patch func(*model.CharStyle)) {
	layer := e.textLayer()
	if layer == nil {
		return
	}
	editor := e.activeEditor()
	start, end := e.rangeOrAll()
	if activeElement().Equal(editor) {
		if s, t, ok := richedit.GetSelection(editor); ok {
			start, end = s, t
		}
	}
	layer.Runs = richtext.ApplyStyle(layer.Runs, start, end, patch)
	e.textChanged(layer)
	e.renderEditors(layer)
	e.syncGeometry()
	e.syncFontInfo(layer)
	e.requestDraw()
}

// scheduleCommit は文字の入力を、少し間が空いたところで履歴に積む。
func (e *editor) scheduleCommit() {
	clearTimer(e.commitTimer)
	e.commitTimer = after(600, e.commit)
}

func (e *editor) onTextInput(editor, event js.Value) {
	layer := e.textLayer()
	if layer == nil {
		return
	}
	// 書式の無い文字（全部消してから入力した文字など）は、直前にカーソルがあった位置の書式にする
	at := 1
	if e.charRange != nil {
		at = e.charRange.start
	}
	fallback := richtext.StyleAt(layer.Runs, max(0, at-1))
	layer.Runs = richedit.Read(editor, fallback)
	// 変換中（IME）は DOM を作り直さない
	if !event.Get("isComposing").Truthy() && !richedit.IsClean(editor) {
		start, end, ok := richedit.GetSelection(editor)
		if editor.Equal(e.rich) {
			e.renderPanelText(layer)
		} else {
			e.renderStageText(layer)
		}
		if ok {
			richedit.SetSelection(editor, start, end)
		}
	}
	e.textChanged(layer)
	if editor.Equal(e.stageText) {
		e.renderPanelText(layer)
	}
	e.syncGeometry()
	e.requestDraw()
	e.scheduleCommit()
}

// closeStageText はキャンバス上の編集欄を閉じる（履歴には積まない）。
func (e *editor) closeStageText() {
	if e.editingID == "" {
		return
	}
	e.editingID = ""
	e.stageText.Set("hidden", true)
	e.stageText.Call("replaceChildren")
	clearHighlight()
	e.requestDraw()
}

// finishEditing はキャンバス上の編集を終える。
func (e *editor) finishEditing() {
	if e.editingID == "" {
		return
	}
	clearTimer(e.commitTimer)
	e.closeStageText()
	e.charRange = nil
	e.commit()
	e.syncPanel()
}

func preventScroll() js.Value {
	options := js.Global().Get("Object").New()
	options.Set("preventScroll", true)
	return options
}

// startEditing はテキストをキャンバス上で、その場で編集する。
func (e *editor) startEditing(layer *model.Layer) {
	if e.editingID == layer.ID {
		return
	}
	e.finishEditing()
	if e.selectedID != layer.ID {
		e.selectLayer(layer.ID)
	}
	e.editingID = layer.ID
	e.stageText.Set("hidden", false)
	e.renderStageText(layer)
	e.positionStageText()
	e.stageText.Call("focus", preventScroll())
	// 文字をすべて選んでおき、そのまま入力すると置き換わるようにする
	richedit.SetSelection(e.stageText, 0, richedit.Length(e.stageText))
	e.requestDraw()
}

func (e *editor) pickFont() {
	layer := e.textLayer()
	if layer == nil {
		return
	}
	saved := e.charRange
	start, end := e.rangeOrAll()
	current := richtext.StylesIn(layer.Runs, start, end)[0]
	go func() {
		font, ok := e.picker.Open(current.Font)
		if !ok || e.textLayer() != layer {
			return
		}
		e.charRange = saved
		e.applyChar(func(s *model.CharStyle) { s.Font = font.Clone() })
		e.commit()
		e.syncCharControls()
	}()
}

// convertToPath はテキストを、文字の形のパスのレイヤーにする。
func (e *editor) convertToPath() {
	layer := e.textLayer()
	if layer == nil || e.doc == nil {
		return
	}
	e.finishEditing()
	e.notify("パスに変換しています…", false)
	go func() {
		var shape *model.TextOutline
		built := true
		if textlayout.UsesOutline(layer) {
			shape = layer.Outline
		} else {
			render.LoadFonts(layer)
			render.FitText(layer)
			shape, built = outline.Build(layer)
		}
		if e.doc == nil {
			return
		}
		index := e.doc.Index(layer)
		if index < 0 {
			return
		}
		if !built || shape == nil || len(shape.Parts) == 0 {
			if built && shape != nil {
				e.notify("文字が無いので、パスに変換できませんでした。", true)
			} else {
				e.notify("フォントのデータを読めない文字があるため、パスに変換できませんでした。", true)
			}
			return
		}
		e.doc.Layers[index] = &model.Layer{
			ID:          layer.ID,
			Name:        layer.Name,
			Visible:     layer.Visible,
			Opacity:     layer.Opacity,
			X:           layer.X,
			Y:           layer.Y,
			Width:       shape.Width,
			Height:      shape.Height,
			Filters:     layer.Filters,
			Type:        model.TypePath,
			BaseWidth:   shape.Width,
			BaseHeight:  shape.Height,
			Parts:       append([]model.Part(nil), shape.Parts...),
			Size:        richtext.MaxSize(layer.Runs),
			StrokeColor: layer.StrokeColor,
			StrokeWidth: layer.StrokeWidth,
			Shadow:      layer.Shadow,
		}
		e.commit()
		e.syncPanel()
		e.requestDraw()
		e.notify("パスに変換しました。", false)
	}()
}

func (e *editor) bindText() {
	for _, editor := range []js.Value{e.rich, e.stageText} {
		on(editor, "input", func(event js.Value) { e.onTextInput(editor, event) })
		on(editor, "compositionend", func(event js.Value) { e.onTextInput(editor, event) })
		on(editor, "focusout", func(js.Value) {
			clearTimer(e.commitTimer)
			e.commit()
		})
		// 貼り付けは書式なしの文字だけにする
		on(editor, "paste", func(event js.Value) {
			event.Call("preventDefault")
			value := ""
			if data := event.Get("clipboardData"); data.Truthy() {
				value = data.Call("getData", "text/plain").String()
			}
			value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
			web.Document().Call("execCommand", "insertText", false, value)
		})
		on(editor, "drop", func(event js.Value) { event.Call("preventDefault") })
		on(editor, "keydown", func(event js.Value) {
			mod := event.Get("ctrlKey").Bool() || event.Get("metaKey").Bool()
			key := strings.ToLower(event.Get("key").String())
			// ブラウザの太字・斜体・下線（<b> などを入れる）の代わりに、書式の太字を切り替える
			if mod && (key == "b" || key == "i" || key == "u") {
				event.Call("preventDefault")
				if key == "b" {
					layer := e.textLayer()
					start, end, _ := richedit.GetSelection(editor)
					if layer == nil {
						return
					}
					bold := true
					for _, s := range richtext.StylesIn(layer.Runs, start, end) {
						bold = bold && s.Bold
					}
					e.applyChar(func(s *model.CharStyle) { s.Bold = !bold })
					e.commit()
					e.syncCharControls()
				}
				return
			}
			if key == "escape" && editor.Equal(e.stageText) {
				event.Call("preventDefault")
				e.finishEditing()
				e.stage.Call("focus", preventScroll())
			}
		})
	}

	document := web.Document()
	e.onDoc(document, "selectionchange", func(js.Value) {
		editor := e.activeEditor()
		if !activeElement().Equal(editor) {
			return
		}
		start, end, ok := richedit.GetSelection(editor)
		if !ok {
			return
		}
		e.charRange = &charRange{start, end}
		e.syncCharControls()
	})

	// 書式の欄やフォントのダイアログに移ったときは、選んでいた文字の範囲を保つ。それ以外に移ったら忘れる
	e.onDoc(document, "focusin", func(event js.Value) {
		target := event.Get("target")
		if !isElement(target) {
			return
		}
		if target.Equal(e.activeEditor()) {
			clearHighlight()
			return
		}
		if !target.Call("closest", "[data-char], #font-button, #font-dialog").IsNull() {
			e.showHighlight()
			return
		}
		if e.editingID != "" {
			e.finishEditing()
		}
		if !target.Equal(e.rich) {
			e.charRange = nil
			clearHighlight()
			e.syncCharControls()
		}
	})

	// フォントを読み込めたら（または読み込めなかったら）、テキストを測り直して描き直す
	unsubscribe := fonts.Subscribe(func() {
		if e.doc == nil {
			return
		}
		moved := false
		for _, layer := range e.doc.Layers {
			if layer.Type == model.TypeText && render.FitText(layer) {
				moved = true
			}
		}
		if moved {
			e.syncGeometry()
		}
		if layer := e.textLayer(); layer != nil {
			e.syncFontInfo(layer)
			e.syncCharControls()
		}
		e.requestDraw()
		// レイヤーの一覧のサムネイルは、まとめて描き直す
		clearTimer(e.fontTimer)
		e.fontTimer = after(150, e.renderLayerList)
	})
	e.signal.Call("addEventListener", "abort", js.FuncOf(func(js.Value, []js.Value) any {
		unsubscribe()
		clearTimer(e.fontTimer)
		clearTimer(e.commitTimer)
		return nil
	}))
}
