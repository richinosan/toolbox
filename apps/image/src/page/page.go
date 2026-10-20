//go:build js

// Package page は IMAGE のエディター本体。ページの要素に操作を結び付け、ドキュメントの状態・履歴・描画を管理する。
// gosfc の go: import で index.astro から読み込み、Start を呼ぶ。
package page

import (
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/snap"
	"toolbox.richinosan.com/apps/image/src/web/assets"
	"toolbox.richinosan.com/apps/image/src/web/fontpicker"
	"toolbox.richinosan.com/apps/image/src/web/render"
	"toolbox.richinosan.com/packages/ui/src/web"
)

const (
	historyLimit = 100
	// snapDistance はスナップが効く距離（画面上の px）。
	snapDistance = 8
	minScale     = 0.02
	maxScale     = 16
	// doubleTap は 2 回のタップをダブルタップとみなす間隔（ms）。
	doubleTap = 350
	// highlightName は編集欄から離れても書式を変える範囲を見せるハイライトの名前。
	highlightName = "tb-text-selection"
	// zoomBarSpace はキャンバスの下に置く拡大・縮小のボタンの分の余白（px）。
	zoomBarSpace = 52
	// minCrop は切り抜く枠の最小の大きさ（ドキュメントの px）。
	minCrop  = 8
	megabyte = 1_000_000
)

// Start はページを表示するたびに初期化するよう登録する。
func Start() {
	web.OnPageLoad(func() {
		root := web.Query("#image-editor")
		// このツール以外のページでは何もしない
		if root.IsNull() {
			return
		}
		mount(root)
	})
}

type camera struct {
	scale, x, y float64
	fit         bool
}

type point struct{ x, y float64 }

// drag はドラッグ中の操作。
type drag struct {
	// kind は "move"・"resize"・"crop-move"・"crop-resize"・"pan"・"pinch"。
	kind           string
	id             string
	handle         string
	startX, startY float64
	origin         *model.Layer
	cropOrigin     snap.Box
	viewX, viewY   float64
	moved          bool
	distance       float64
	midX, midY     float64
	scale          float64
}

type snapshot struct {
	json string
	doc  *model.Doc
}

type charRange struct{ start, end int }

type editor struct {
	root   js.Value
	signal js.Value

	stage, view, viewContext, empty, toast, zoomLabel  js.Value
	layerList, layerEmpty, layerActions                js.Value
	props, propsTitle, docForm, openInput, imageInput  js.Value
	newDialog, newForm, exportDialog, exportForm       js.Value
	snapButton, undoButton, redoButton                 js.Value
	rich, stageText, fontName, fontMissing, fontDialog js.Value
	cropForm, cropBar, cropButton, pathFill            js.Value
	picker                                             *fontpicker.Picker

	// ---- 状態 ----
	doc          *model.Doc
	assets       assets.Assets
	cache        *render.Cache
	selectedID   string
	fileHandle   js.Value
	history      []snapshot
	historyIndex int
	savedIndex   int
	snapEnabled  bool
	guides       snap.Lines
	camera       camera
	drag         *drag
	pointers     map[int]point
	pointerOrder []int
	// editingID はキャンバス上で編集中のテキストレイヤー。
	editingID string
	// charRange は書式を適用する文字の範囲（編集欄から離れてボタンなどを押しても覚えておく）。nil は全体。
	charRange *charRange
	lastTapID string
	lastTapAt float64
	// crop はトリミング中の枠（ドキュメントの座標）。トリミングしていないときは nil。
	crop *snap.Box

	toastTimer, commitTimer, fontTimer js.Value
	frame                              int
	checker                            js.Value
	stageTextScale                     float64
	applyingCrop, saving               bool
}

func (e *editor) selected() *model.Layer {
	if e.doc == nil || e.selectedID == "" {
		return nil
	}
	return e.doc.Find(e.selectedID)
}

func (e *editor) isDirty() bool { return e.doc != nil && e.historyIndex != e.savedIndex }

func (e *editor) textLayer() *model.Layer {
	if layer := e.selected(); layer != nil && layer.Type == model.TypeText {
		return layer
	}
	return nil
}

func mount(root js.Value) {
	controller := js.Global().Get("AbortController").New()
	e := &editor{
		root:        root,
		signal:      controller.Get("signal"),
		assets:      assets.Assets{},
		fileHandle:  js.Null(),
		snapEnabled: true,
		camera:      camera{scale: 1, fit: true},
		pointers:    map[int]point{},
		toastTimer:  js.Null(),
		commitTimer: js.Null(),
		fontTimer:   js.Null(),
		checker:     js.Null(),
	}
	e.cache = render.NewCache(e.assets)
	// ClientRouter で他のページへ移るときに、document や window に付けたリスナーを外す
	once := js.Global().Get("Object").New()
	once.Set("once", true)
	on(web.Document(), "astro:before-swap", func(js.Value) { controller.Call("abort") }, once)

	q := func(selector string) js.Value { return root.Call("querySelector", selector) }
	e.stage = q("#stage")
	e.view = q("#view")
	e.viewContext = e.view.Call("getContext", "2d")
	e.empty = q("#empty")
	e.toast = q("#toast")
	e.zoomLabel = q("#zoom-label")
	e.layerList = q("#layer-list")
	e.layerEmpty = q("#layer-empty")
	e.layerActions = q("#layer-actions")
	e.props = q("#props")
	e.propsTitle = q("#props-title")
	e.docForm = q("#doc-props")
	e.openInput = q("#open-input")
	e.imageInput = q("#image-input")
	e.newDialog = q("#new-dialog")
	e.newForm = q("#new-form")
	e.exportDialog = q("#export-dialog")
	e.exportForm = q("#export-form")
	e.snapButton = q(`[data-action="snap"]`)
	e.undoButton = q(`[data-action="undo"]`)
	e.redoButton = q(`[data-action="redo"]`)
	e.rich = q("#rich")
	e.stageText = q("#stage-text")
	e.fontName = q("#font-name")
	e.fontMissing = q("#font-missing")
	e.fontDialog = q("#font-dialog")
	e.cropForm = q("#crop-props")
	e.cropBar = q("#crop-bar")
	e.cropButton = q(`[data-action="crop"]`)
	e.pathFill = e.props.Call("querySelector", `[data-path="fill"]`)
	e.picker = fontpicker.New(e.fontDialog)
	e.signal.Call("addEventListener", "abort", js.FuncOf(func(js.Value, []js.Value) any {
		e.picker.Close()
		return nil
	}))

	e.bindPointer()
	e.bindPanel()
	e.bindText()
	e.bindCrop()
	e.bindFiles()
	e.bindKeys()
	e.refreshAll()
}

// ---- DOM の小さな処理 ----

// on は target にリスナーを付ける。options は addEventListener の第 3 引数（省略可）。
func on(target js.Value, typ string, handler func(event js.Value), options ...js.Value) {
	f := js.FuncOf(func(this js.Value, args []js.Value) any {
		handler(args[0])
		return nil
	})
	if len(options) > 0 {
		target.Call("addEventListener", typ, f, options[0])
	} else {
		target.Call("addEventListener", typ, f)
	}
}

// onDoc は document や window にリスナーを付ける（ページを離れると外れる）。
func (e *editor) onDoc(target js.Value, typ string, handler func(event js.Value)) {
	options := js.Global().Get("Object").New()
	options.Set("signal", e.signal)
	on(target, typ, handler, options)
}

// after は ms ミリ秒後に f を呼ぶ。戻り値は clearTimeout に渡す。
func after(ms float64, f func()) js.Value {
	var callback js.Func
	callback = js.FuncOf(func(js.Value, []js.Value) any {
		callback.Release()
		f()
		return nil
	})
	return js.Global().Call("setTimeout", callback, ms)
}

func clearTimer(timer js.Value) {
	if !timer.IsNull() {
		js.Global().Call("clearTimeout", timer)
	}
}

func query(root js.Value, selector string) js.Value { return root.Call("querySelector", selector) }

func queryAll(root js.Value, selector string) []js.Value {
	list := root.Call("querySelectorAll", selector)
	out := make([]js.Value, list.Length())
	for i := range out {
		out[i] = list.Index(i)
	}
	return out
}

func toggleClass(element js.Value, name string, force bool) {
	element.Get("classList").Call("toggle", name, force)
}

func setText(element js.Value, text string) { element.Set("textContent", text) }

// isElement は値が Element か。
func isElement(value js.Value) bool {
	return value.Type() == js.TypeObject && value.InstanceOf(js.Global().Get("Element"))
}

// closest は event.target から selector に合う要素を探す。無ければ null。
func closest(target js.Value, selector string) js.Value {
	if !isElement(target) {
		return js.Null()
	}
	return target.Call("closest", selector)
}

func dataset(element js.Value, key string) string {
	value := element.Get("dataset").Get(key)
	if value.Type() != js.TypeString {
		return ""
	}
	return value.String()
}

// isEditable は入力欄（スライダーや選択肢も含む）か。フォーカスがあるときは、矢印キーや Delete をそちらに任せる。
func isEditable(target js.Value) bool {
	if !isElement(target) || !target.InstanceOf(js.Global().Get("HTMLElement")) {
		return false
	}
	if target.Get("isContentEditable").Bool() {
		return true
	}
	switch target.Get("tagName").String() {
	case "TEXTAREA", "SELECT", "INPUT":
		return true
	}
	return false
}

// number は JavaScript の Number(value)。
func number(value js.Value) float64 { return js.Global().Call("Number", value).Float() }

// formatNumber は JavaScript の String(number)。
func formatNumber(value float64) string { return js.Global().Call("String", value).String() }

func isFinite(value float64) bool { return js.Global().Get("Number").Call("isFinite", value).Bool() }

// formValue は FormData(form).get(name)。無ければ ""。
func formValue(form js.Value, name string) (string, bool) {
	value := js.Global().Get("FormData").New(form).Call("get", name)
	if value.Type() != js.TypeString {
		return "", false
	}
	return value.String(), true
}

func now() float64 { return js.Global().Get("performance").Call("now").Float() }

func devicePixelRatio() float64 {
	ratio := js.Global().Get("devicePixelRatio")
	if ratio.Type() != js.TypeNumber || ratio.Float() == 0 {
		return 1
	}
	return ratio.Float()
}
