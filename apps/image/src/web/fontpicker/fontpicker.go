//go:build js

// Package fontpicker はフォントを選ぶダイアログ（Web フォント・端末のフォント・ファイル）。
package fontpicker

import (
	"slices"
	"strconv"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
	"toolbox.richinosan.com/packages/ui/src/web"
)

const limit = 120

type choice struct {
	font model.FontRef
	ok   bool
}

// Picker はフォントを選ぶダイアログ。
type Picker struct {
	dialog, form, search, japanese, webList, webNote js.Value
	localButton, localSearch, localList, localNote   js.Value
	fileButton, fileInput, fileList, fileNote        js.Value
	current                                          model.FontRef
	resolve                                          chan choice
	localFamilies                                    []fonts.LocalFamily
	localLoaded                                      bool
	files                                            []model.FontRef
	searchTimer                                      js.Value
	renderWebLater                                   js.Func
}

// New は dialog 要素（#font-dialog）に操作を結び付ける。
func New(dialog js.Value) *Picker {
	q := func(selector string) js.Value { return dialog.Call("querySelector", selector) }
	p := &Picker{
		dialog:      dialog,
		form:        q("form"),
		search:      q("#font-search"),
		japanese:    q("#font-japanese"),
		webList:     q("#font-list"),
		webNote:     q("#font-web-note"),
		localButton: q("#font-local-load"),
		localSearch: q("#font-local-search"),
		localList:   q("#font-local-list"),
		localNote:   q("#font-local-note"),
		fileButton:  q("#font-file-pick"),
		fileInput:   q("#font-file-input"),
		fileList:    q("#font-file-list"),
		fileNote:    q("#font-file-note"),
		current:     model.Builtin,
		searchTimer: js.Undefined(),
	}
	p.renderWebLater = js.FuncOf(func(js.Value, []js.Value) any {
		go p.renderWeb()
		return nil
	})

	web.Listen(p.search, "input", func(js.Value) {
		js.Global().Call("clearTimeout", p.searchTimer)
		p.searchTimer = js.Global().Call("setTimeout", p.renderWebLater, 200)
	})
	web.Listen(p.japanese, "change", func(js.Value) { go p.renderWeb() })
	web.Listen(p.localSearch, "input", func(js.Value) { p.renderLocal() })
	web.Listen(p.form, "change", func(event js.Value) {
		target := event.Get("target")
		if target.InstanceOf(js.Global().Get("HTMLInputElement")) && target.Get("name").String() == "font-tab" {
			p.showTab()
		}
	})
	web.Listen(p.form, "submit", func(event js.Value) {
		event.Call("preventDefault")
		p.finish(nil)
	})
	web.Listen(dialog, "close", func(js.Value) { p.finish(nil) })
	web.Listen(p.localButton, "click", func(js.Value) { go p.loadLocal() })
	web.Listen(p.fileButton, "click", func(js.Value) {
		p.fileInput.Set("value", "")
		p.fileInput.Call("click")
	})
	web.Listen(p.fileInput, "change", func(js.Value) { go p.addFiles() })
	return p
}

// Open はダイアログを開き、選ばれたフォントを返す。キャンセルされたら ok が false。待つので goroutine の中で呼ぶ。
func (p *Picker) Open(current model.FontRef) (font model.FontRef, ok bool) {
	// 前に開いたままのものはキャンセルにする
	p.settle(nil)
	done := make(chan choice, 1)
	p.current = current
	p.resolve = done
	p.search.Set("value", "")
	go p.renderWeb()
	p.renderLocal()
	p.renderFiles()
	p.showTab()
	p.dialog.Call("showModal")
	c := <-done
	return c.font, c.ok
}

// Close は開いていれば閉じる（ページを離れるとき）。待っている Open はキャンセルになる。
func (p *Picker) Close() { p.finish(nil) }

func (p *Picker) settle(ref *model.FontRef) {
	if p.resolve == nil {
		return
	}
	if ref != nil {
		p.resolve <- choice{*ref, true}
	} else {
		p.resolve <- choice{}
	}
	p.resolve = nil
}

func (p *Picker) finish(ref *model.FontRef) {
	p.settle(ref)
	if p.dialog.Get("open").Bool() {
		p.dialog.Call("close")
	}
}

func (p *Picker) item(ref model.FontRef, label, meta, preview string) js.Value {
	document := web.Document()
	li := document.Call("createElement", "li")
	button := document.Call("createElement", "button")
	button.Set("type", "button")
	button.Set("className", "font-item")
	button.Call("setAttribute", "aria-pressed", strconv.FormatBool(ref.Same(p.current)))
	name := document.Call("createElement", "span")
	name.Set("className", "font-item__name")
	name.Set("textContent", label)
	if preview != "" {
		name.Get("style").Set("fontFamily", preview)
	}
	info := document.Call("createElement", "span")
	info.Set("className", "font-item__meta")
	info.Set("textContent", meta)
	button.Call("append", name, info)
	web.Listen(button, "click", func(js.Value) { p.finish(&ref) })
	li.Call("append", button)
	return li
}

func replaceChildren(list js.Value, items []js.Value) {
	args := make([]any, len(items))
	for i, item := range items {
		args[i] = item
	}
	list.Call("replaceChildren", args...)
}

func (p *Picker) tab() string {
	if v := js.Global().Get("FormData").New(p.form).Call("get", "font-tab"); v.Type() == js.TypeString {
		return v.String()
	}
	return "web"
}

func (p *Picker) showTab() {
	tab := p.tab()
	panels := p.dialog.Call("querySelectorAll", "[data-tab]")
	for i := range panels.Length() {
		panel := panels.Index(i)
		panel.Set("hidden", panel.Get("dataset").Get("tab").String() != tab)
	}
}

func (p *Picker) renderWeb() {
	query := strings.ToLower(strings.TrimSpace(p.search.Get("value").String()))
	list := fonts.Recommended
	p.webNote.Set("textContent", "選んだフォントだけを、使う文字の分だけ jsDelivr（Fontsource）から読み込みます。")
	if query != "" {
		p.webNote.Set("textContent", "フォントの一覧を読み込んでいます…")
		if catalog, err := fonts.LoadCatalog(); err == nil {
			list = catalog
			p.webNote.Set("textContent", "")
		} else {
			p.webNote.Set("textContent", "フォントの一覧を読み込めませんでした。おすすめの中から探しています。")
		}
	}
	japaneseOnly := p.japanese.Get("checked").Bool()
	var filtered []fonts.CatalogFont
	for _, font := range list {
		if japaneseOnly && !font.Japanese {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(font.Family), query) && !strings.Contains(font.ID, query) {
			continue
		}
		filtered = append(filtered, font)
	}
	var items []js.Value
	if query == "" || strings.Contains("line seed jp", query) {
		items = append(items, p.item(model.Builtin, "LINE Seed JP", "標準・日本語・太字あり", ""))
	}
	for _, font := range filtered[:min(len(filtered), limit)] {
		var meta []string
		if label := fonts.CategoryLabels[font.Category]; label != "" {
			meta = append(meta, label)
		}
		if font.Japanese {
			meta = append(meta, "日本語")
		}
		if slices.ContainsFunc(font.Weights, func(w float64) bool { return w >= 600 }) {
			meta = append(meta, "太字あり")
		}
		items = append(items, p.item(fonts.WebRef(font), font.Family, strings.Join(meta, "・"), ""))
	}
	replaceChildren(p.webList, items)
	if len(filtered) > limit {
		p.webNote.Set("textContent", strconv.Itoa(len(filtered))+" 件中 "+strconv.Itoa(limit)+" 件を表示しています。名前で絞り込んでください。")
	} else if len(items) == 0 {
		p.webNote.Set("textContent", "見つかりませんでした。")
	}
}

func (p *Picker) renderLocal() {
	if !p.localLoaded {
		return
	}
	query := strings.ToLower(strings.TrimSpace(p.localSearch.Get("value").String()))
	var filtered []fonts.LocalFamily
	for _, family := range p.localFamilies {
		if query == "" || strings.Contains(strings.ToLower(family.Family), query) {
			filtered = append(filtered, family)
		}
	}
	var items []js.Value
	for _, family := range filtered[:min(len(filtered), 300)] {
		meta := ""
		if family.Ref.Faces != nil && family.Ref.Faces.Bold != "" {
			meta = "太字あり"
		}
		// 端末のフォントは通信なしで見本を出せる
		preview := `"` + strings.NewReplacer(`"`, "", `\`, "").Replace(family.Family) + `", sans-serif`
		items = append(items, p.item(family.Ref, family.Family, meta, preview))
	}
	replaceChildren(p.localList, items)
	switch {
	case len(filtered) > 300:
		p.localNote.Set("textContent", strconv.Itoa(len(filtered))+" 件中 300 件を表示しています。名前で絞り込んでください。")
	case len(filtered) == 0:
		p.localNote.Set("textContent", "見つかりませんでした。")
	default:
		p.localNote.Set("textContent", "")
	}
}

func (p *Picker) renderFiles() {
	items := make([]js.Value, len(p.files))
	for i, ref := range p.files {
		items[i] = p.item(ref, ref.Family, "読み込んだファイル", "")
	}
	replaceChildren(p.fileList, items)
}

func (p *Picker) loadLocal() {
	if !fonts.CanQueryLocal() {
		p.localNote.Set("textContent", "このブラウザは端末のフォントの一覧を読めません（Chrome・Edge のパソコン版で使えます）。「ファイル」からフォントファイルを読み込んでください。")
		return
	}
	p.localNote.Set("textContent", "読み込んでいます…")
	families, err := fonts.QueryLocal()
	if err != nil {
		p.localNote.Set("textContent", "端末のフォントを読めませんでした。ブラウザの確認で「許可」を選ぶと読めます。")
		return
	}
	p.localFamilies, p.localLoaded = families, true
	p.localSearch.Set("hidden", false)
	p.localButton.Set("hidden", true)
	p.renderLocal()
}

func (p *Picker) addFiles() {
	list := p.fileInput.Get("files")
	if !list.Truthy() || list.Length() == 0 {
		return
	}
	picked := make([]js.Value, list.Length())
	for i := range picked {
		picked[i] = list.Index(i)
	}
	p.fileNote.Set("textContent", "読み込んでいます…")
	var last *model.FontRef
	failed := 0
	for _, file := range picked {
		ref, err := fonts.AddFile(file)
		if err != nil {
			failed++
			continue
		}
		if !slices.ContainsFunc(p.files, ref.Same) {
			p.files = append(p.files, ref)
		}
		last = &ref
	}
	p.renderFiles()
	if failed > 0 {
		p.fileNote.Set("textContent", strconv.Itoa(failed)+" 個のファイルはフォントとして読めませんでした。")
	} else {
		p.fileNote.Set("textContent", "")
	}
	// 1 つだけ読み込んだときは、そのまま選ぶ
	if len(picked) == 1 && last != nil {
		p.finish(last)
	}
}
