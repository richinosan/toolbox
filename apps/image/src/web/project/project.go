//go:build js

// Package project は作品ファイル（.tbimg）の保存と読み込み。
// 作品はブラウザ内には保存せず、端末のファイルとして書き出す。
// File System Access API が使えるブラウザでは同じファイルに上書き保存し、使えないブラウザではダウンロードする。
// 「待つ」関数は Promise の完了を待つので、goroutine の中で呼ぶ。
package project

import (
	"errors"
	"math"
	"strings"
	"syscall/js"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/apps/image/src/lib/richtext"
	"toolbox.richinosan.com/apps/image/src/web/assets"
	"toolbox.richinosan.com/apps/image/src/web/fonts"
)

// Extension は作品ファイルの拡張子。
const Extension = model.ProjectExtension

// Accept はファイルを選ぶ input の accept。
const Accept = model.ProjectAccept

const (
	format  = "toolbox-image"
	version = 1
	mime    = "application/x-toolbox-image"
)

var imageTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"}

//goesm:import "./io.ts" settle await
func settle(promise js.Value) (js.Value, error)

//goesm:import "./io.ts" dataUrl await
func dataURL(blob js.Value) (js.Value, error)

//goesm:import "./io.ts" loadImage await
func loadImage(url js.Value) (js.Value, error)

// Error は作品ファイルとして読めなかったときのエラー。Error() は画面に出すメッセージ。
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

// CanPickFiles は File System Access API で保存先を選べるブラウザか。
func CanPickFiles() bool {
	return js.Global().Get("showSaveFilePicker").Type() == js.TypeFunction
}

// isAbort はユーザーがキャンセルしたときのエラー（DOMException の AbortError）か。
func isAbort(err error) bool {
	var jerr js.Error
	if !errors.As(err, &jerr) {
		return false
	}
	v := jerr.Value
	return v.Type() == js.TypeObject && v.InstanceOf(js.Global().Get("DOMException")) &&
		v.Get("name").String() == "AbortError"
}

func object(entries map[string]any) js.Value { return js.ValueOf(entries) }

// Serialize は作品を 1 つの JSON の Blob にまとめる（画像は data URL で埋め込む）。待つ。
func Serialize(doc *model.Doc, all assets.Assets) (blob js.Value, err error) {
	// data URL は大きいので Go の文字列にせず、JSON の断片と並べて Blob にする（data URL はエスケープが要らない）
	b := []byte(`{"format":"` + format + `","version":1,"doc":`)
	b = doc.AppendJSON(b)
	b = append(b, `,"assets":{`...)
	parts := []any{}
	seen := map[string]bool{}
	for _, layer := range doc.Layers {
		if layer.Type != model.TypeImage || seen[layer.Asset] {
			continue
		}
		seen[layer.Asset] = true
		asset, ok := all[layer.Asset]
		if !ok {
			continue
		}
		url, err := dataURL(asset.Blob)
		if err != nil {
			return js.Undefined(), err
		}
		if len(parts) > 0 {
			b = append(b, ',')
		}
		b = model.AppendString(b, layer.Asset)
		b = append(b, `:"`...)
		parts = append(parts, string(b), url)
		b = []byte{'"'}
	}
	b = append(b, "}}"...)
	parts = append(parts, string(b))
	return js.Global().Get("Blob").New(js.ValueOf(parts), object(map[string]any{"type": mime})), nil
}

// ---- 読み込み（ファイルの中身は信用せず、型と範囲を確かめながら組み立てる） ----

func isObject(v js.Value) bool {
	return v.Type() == js.TypeObject && !js.Global().Get("Array").Call("isArray", v).Bool()
}

func isArray(v js.Value) bool {
	return v.Type() == js.TypeObject && js.Global().Get("Array").Call("isArray", v).Bool()
}

// field は obj[key]（obj がオブジェクトでなければ undefined）。
func field(obj js.Value, key string) js.Value {
	if !isObject(obj) {
		return js.Undefined()
	}
	return obj.Get(key)
}

func num(v js.Value, fallback, min, max float64) float64 {
	if v.Type() != js.TypeNumber {
		return fallback
	}
	n := v.Float()
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return fallback
	}
	return model.Clamp(n, min, max)
}

// jsRound は Math.round（.5 は +∞ の側に丸める）。
func jsRound(n float64) float64 { return math.Floor(n + 0.5) }

func integer(v js.Value, fallback, min, max float64) float64 {
	return jsRound(num(v, fallback, min, max))
}

// sliceUTF16 は s の先頭 n 文字（UTF-16 のコード単位）。String.prototype.slice(0, n) と同じ。
func sliceUTF16(s string, n int) string {
	if len(s) <= n {
		return s
	}
	units := 0
	for i, r := range s {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if units+size > n {
			return s[:i]
		}
		units += size
	}
	return s
}

func str(v js.Value, fallback string, maxLength int) string {
	if v.Type() != js.TypeString {
		return fallback
	}
	return sliceUTF16(v.String(), maxLength)
}

func boolean(v js.Value, fallback bool) bool {
	if v.Type() != js.TypeBoolean {
		return fallback
	}
	return v.Bool()
}

func hex(v js.Value, fallback string) string {
	if v.Type() != js.TypeString || !model.IsHex(v.String()) {
		return fallback
	}
	return strings.ToLower(v.String())
}

func oneOf(v js.Value, options []string, fallback string) string {
	if v.Type() != js.TypeString {
		return fallback
	}
	s := v.String()
	for _, option := range options {
		if s == option {
			return s
		}
	}
	return fallback
}

const position = 100_000

func readFilters(v js.Value) model.Filters {
	d := model.DefaultFilters
	presets := make([]string, len(model.FilterPresets))
	for i, p := range model.FilterPresets {
		presets[i] = p.Value
	}
	return model.Filters{
		Preset:     oneOf(field(v, "preset"), presets, d.Preset),
		Brightness: num(field(v, "brightness"), d.Brightness, -100, 100),
		Contrast:   num(field(v, "contrast"), d.Contrast, -100, 100),
		Saturation: num(field(v, "saturation"), d.Saturation, -100, 100),
		Hue:        num(field(v, "hue"), d.Hue, -180, 180),
		Tint:       hex(field(v, "tint"), d.Tint),
		TintAmount: num(field(v, "tintAmount"), d.TintAmount, 0, 100),
		Blur:       num(field(v, "blur"), d.Blur, 0, 100),
	}
}

func readStyle(v js.Value) model.CharStyle {
	return model.CharStyle{
		Font:  fonts.ReadRef(field(v, "font")),
		Size:  num(field(v, "size"), 48, 1, 2000),
		Color: hex(field(v, "color"), "#ffffff"),
		Bold:  boolean(field(v, "bold"), false),
	}
}

// isJSSpace は正規表現の \s に当たる文字か。
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// validPath は SVG のパス（数字と M・L・Q・C・Z だけ）か。
func validPath(d string) bool {
	for _, r := range d {
		switch {
		case strings.ContainsRune("MLQCZ0123456789.-,e", r), isJSSpace(r):
		default:
			return false
		}
	}
	return true
}

// readParts は SVG のパスを確かめる。おかしければ ok が false。
func readParts(v js.Value) (parts []model.Part, ok bool) {
	if !isArray(v) {
		return nil, false
	}
	n := min(v.Length(), 5000)
	parts = []model.Part{}
	for i := range n {
		part := v.Index(i)
		d := field(part, "d")
		if d.Type() != js.TypeString {
			return nil, false
		}
		s := d.String()
		if utf16Len(s) > 2_000_000 || !validPath(s) {
			return nil, false
		}
		parts = append(parts, model.Part{
			D:     s,
			Color: hex(part.Get("color"), "#ffffff"),
			Bold:  boolean(part.Get("bold"), false),
		})
	}
	return parts, true
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func readLayer(v js.Value, assetIDs map[string]bool) *model.Layer {
	if !isObject(v) {
		return nil
	}
	l := &model.Layer{
		ID:      model.NewID(),
		Name:    str(v.Get("name"), "レイヤー", 200),
		Visible: boolean(v.Get("visible"), true),
		Opacity: num(v.Get("opacity"), 100, 0, 100),
		X:       integer(v.Get("x"), 0, -position, position),
		Y:       integer(v.Get("y"), 0, -position, position),
		Width:   integer(v.Get("width"), 100, 1, model.MaxSide*4),
		Height:  integer(v.Get("height"), 100, 1, model.MaxSide*4),
		Filters: readFilters(v.Get("filters")),
	}
	typ := v.Get("type")
	if typ.Type() != js.TypeString {
		return nil
	}
	switch l.Type = typ.String(); l.Type {
	case model.TypeImage:
		l.Asset = str(v.Get("asset"), "", 10_000)
		if !assetIDs[l.Asset] {
			return nil
		}
	case model.TypeRect, model.TypeEllipse:
		l.Fill = hex(v.Get("fill"), "#06c755")
		l.FillEnabled = boolean(v.Get("fillEnabled"), true)
		l.Stroke = hex(v.Get("stroke"), "#ffffff")
		l.StrokeWidth = num(v.Get("strokeWidth"), 0, 0, 500)
		l.Radius = num(v.Get("radius"), 0, 0, 5000)
	case model.TypeText:
		runs := []model.TextRun{}
		if source := v.Get("runs"); isArray(source) {
			for i := range min(source.Length(), 2000) {
				run := source.Index(i)
				if text := field(run, "text"); text.Type() == js.TypeString {
					runs = append(runs, model.TextRun{
						Text:  sliceUTF16(text.String(), 10_000),
						Style: readStyle(run.Get("style")),
					})
				}
			}
		}
		l.Runs = richtext.Normalize(runs, readStyle(js.Null()))
		l.Align = oneOf(v.Get("align"), []string{"left", "center", "right"}, "center")
		l.LineHeight = num(v.Get("lineHeight"), 130, 50, 300)
		l.StrokeColor = hex(v.Get("strokeColor"), "#1b1f24")
		l.StrokeWidth = num(v.Get("strokeWidth"), 0, 0, 200)
		l.Shadow = boolean(v.Get("shadow"), false)
		if outline := v.Get("outline"); isObject(outline) {
			if parts, ok := readParts(outline.Get("parts")); ok {
				l.Outline = &model.TextOutline{
					Key:    str(outline.Get("key"), "", 1_000_000),
					Width:  integer(outline.Get("width"), l.Width, 1, model.MaxSide*4),
					Height: integer(outline.Get("height"), l.Height, 1, model.MaxSide*4),
					Parts:  parts,
				}
			}
		}
	case model.TypePath:
		parts, ok := readParts(v.Get("parts"))
		if !ok {
			return nil
		}
		l.BaseWidth = num(v.Get("baseWidth"), l.Width, 1, model.MaxSide*4)
		l.BaseHeight = num(v.Get("baseHeight"), l.Height, 1, model.MaxSide*4)
		l.Parts = parts
		l.Size = num(v.Get("size"), 48, 1, 2000)
		l.StrokeColor = hex(v.Get("strokeColor"), "#1b1f24")
		l.StrokeWidth = num(v.Get("strokeWidth"), 0, 0, 200)
		l.Shadow = boolean(v.Get("shadow"), false)
	default:
		return nil
	}
	return l
}

// Deserialize は .tbimg（Blob）を読み込む。中身は信用せず、型と範囲を確かめながら組み立てる。
// 読めなければ *Error を返す。待つ。
func Deserialize(file js.Value) (*model.Doc, assets.Assets, error) {
	var data js.Value
	text, err := settle(file.Call("text"))
	if err == nil {
		if !webTry(func() { data = js.Global().Get("JSON").Call("parse", text) }) {
			err = errors.New("parse")
		}
	}
	if err != nil {
		return nil, nil, &Error{"IMAGE の作品ファイルとして読み込めませんでした。"}
	}
	if !isObject(data) || data.Get("format").Type() != js.TypeString || data.Get("format").String() != format ||
		!isObject(data.Get("doc")) {
		return nil, nil, &Error{"IMAGE の作品ファイルではありません。"}
	}
	if v := data.Get("version"); v.Type() != js.TypeNumber || v.Float() > version {
		return nil, nil, &Error{"新しい形式の作品ファイルです。ページを再読み込みしてから開いてください。"}
	}

	all := assets.Assets{}
	if embedded := data.Get("assets"); isObject(embedded) {
		entries := js.Global().Get("Object").Call("entries", embedded)
		for i := range entries.Length() {
			entry := entries.Index(i)
			id, url := entry.Index(0).String(), entry.Index(1)
			if url.Type() != js.TypeString || !strings.HasPrefix(url.String(), "data:image/") {
				continue
			}
			loaded, err := loadImage(url)
			if err != nil {
				continue // 壊れた画像はレイヤーごと読み飛ばす
			}
			all[id] = assets.Asset{Blob: loaded.Get("blob"), Image: loaded.Get("image")}
		}
	}

	source := data.Get("doc")
	width, height, _ := model.FitSize(
		integer(source.Get("width"), 1920, 1, model.MaxSide),
		integer(source.Get("height"), 1080, 1, model.MaxSide),
	)
	ids := map[string]bool{}
	for id := range all {
		ids[id] = true
	}
	layers := []*model.Layer{}
	if source := source.Get("layers"); isArray(source) {
		for i := range min(source.Length(), 500) {
			if layer := readLayer(source.Index(i), ids); layer != nil {
				layers = append(layers, layer)
			}
		}
	}
	name := str(source.Get("name"), "無題", 200)
	if name == "" {
		name = "無題"
	}
	background := ""
	if bg := source.Get("background"); !bg.IsNull() {
		background = hex(bg, "#ffffff")
	}
	return &model.Doc{Name: name, Width: width, Height: height, Background: background, Layers: layers}, all, nil
}

// webTry は f を実行し、JavaScript の例外が起きたら false を返す。
func webTry(f func()) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	f()
	return true
}

// ---- ファイルの保存と選択 ----

// SafeName はファイル名に使えない文字（記号と制御文字）を置き換える。
func SafeName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || strings.ContainsRune(`\/:*?"<>|`, r) {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	s := strings.TrimFunc(b.String(), isJSSpace)
	if s == "" {
		return "無題"
	}
	return s
}

// Download は blob を filename でダウンロードさせる。
func Download(blob js.Value, filename string) {
	url := js.Global().Get("URL")
	href := url.Call("createObjectURL", blob)
	document := js.Global().Get("document")
	anchor := document.Call("createElement", "a")
	anchor.Set("href", href)
	anchor.Set("download", filename)
	document.Get("body").Call("append", anchor)
	anchor.Call("click")
	anchor.Call("remove")
	var revoke js.Func
	revoke = js.FuncOf(func(this js.Value, args []js.Value) any {
		url.Call("revokeObjectURL", href)
		revoke.Release()
		return nil
	})
	js.Global().Call("setTimeout", revoke, 10_000)
}

func projectType() map[string]any {
	return map[string]any{
		"description": "IMAGE の作品",
		"accept":      map[string]any{mime: []any{Extension}},
	}
}

// Save は作品を保存する。handle（FileSystemFileHandle、無ければ null/undefined）があればそのファイルに上書きし、
// 無ければ保存先を選ぶ（選べないブラウザではダウンロード）。保存したファイルの handle を返す（ダウンロードしたときは null）。
// キャンセルされたら cancelled が true。待つ。
func Save(blob js.Value, name string, handle js.Value) (saved js.Value, cancelled bool, err error) {
	filename := SafeName(name) + Extension
	target := handle
	if !target.Truthy() && CanPickFiles() {
		var promise js.Value
		if webTry(func() {
			promise = js.Global().Call("showSaveFilePicker", object(map[string]any{
				"suggestedName": filename,
				"types":         []any{projectType()},
			}))
		}) {
			target, err = settle(promise)
		} else {
			err = errors.New("showSaveFilePicker")
		}
		if err != nil {
			if isAbort(err) {
				return js.Undefined(), true, nil
			}
			target, err = js.Null(), nil
		}
	}
	if target.Truthy() {
		writable, err := settle(target.Call("createWritable"))
		if err != nil {
			return js.Undefined(), false, err
		}
		if _, err := settle(writable.Call("write", blob)); err != nil {
			return js.Undefined(), false, err
		}
		if _, err := settle(writable.Call("close")); err != nil {
			return js.Undefined(), false, err
		}
		return target, false, nil
	}
	Download(blob, filename)
	return js.Null(), false, nil
}

// PickFile はファイルを選ぶ（作品ファイルと画像）。File System Access API が使えれば handle も返す（作品ファイルのときだけ）。
// 選ばれなければ ok が false。fallback は使えないときに使う <input type="file">。待つ。
func PickFile(fallback js.Value) (file, handle js.Value, ok bool) {
	if js.Global().Get("showOpenFilePicker").Type() == js.TypeFunction {
		var promise js.Value
		var err error
		if webTry(func() {
			promise = js.Global().Call("showOpenFilePicker", object(map[string]any{
				"types": []any{map[string]any{
					"description": "IMAGE の作品・画像",
					"accept": map[string]any{
						mime:      []any{Extension},
						"image/*": []any{".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bmp"},
					},
				}},
				"multiple": false,
			}))
		}) {
			var handles js.Value
			if handles, err = settle(promise); err == nil {
				h := handles.Index(0)
				if !h.Truthy() {
					return js.Null(), js.Null(), false
				}
				var f js.Value
				if f, err = settle(h.Call("getFile")); err == nil {
					if !IsProjectFile(f) {
						h = js.Null()
					}
					return f, h, true
				}
			}
			if isAbort(err) {
				return js.Null(), js.Null(), false
			}
		}
		// 使えなかったときは通常のファイル選択に切り替える
	}
	picked := make(chan js.Value, 1)
	fallback.Set("value", "")
	var onChange, onCancel js.Func
	finish := func(v js.Value) {
		select {
		case picked <- v:
		default:
		}
	}
	onChange = js.FuncOf(func(this js.Value, args []js.Value) any {
		files := fallback.Get("files")
		if files.Truthy() && files.Length() > 0 {
			finish(files.Index(0))
		} else {
			finish(js.Null())
		}
		return nil
	})
	onCancel = js.FuncOf(func(this js.Value, args []js.Value) any {
		finish(js.Null())
		return nil
	})
	once := object(map[string]any{"once": true})
	fallback.Call("addEventListener", "change", onChange, once)
	fallback.Call("addEventListener", "cancel", onCancel, once)
	fallback.Call("click")
	f := <-picked
	if f.IsNull() {
		return js.Null(), js.Null(), false
	}
	return f, js.Null(), true
}

// IsProjectFile は作品ファイルか。
func IsProjectFile(file js.Value) bool {
	return strings.HasSuffix(strings.ToLower(file.Get("name").String()), Extension) ||
		file.Get("type").String() == mime
}

// IsImageFile は画像のファイルか。
func IsImageFile(file js.Value) bool {
	typ := file.Get("type").String()
	if strings.HasPrefix(typ, "image/") {
		return true
	}
	for _, t := range imageTypes {
		if typ == t {
			return true
		}
	}
	return false
}

// BaseName はファイル名から拡張子を除いたもの（空なら「無題」）。
func BaseName(filename string) string {
	if i := strings.LastIndexByte(filename, '.'); i >= 0 && i < len(filename)-1 {
		filename = filename[:i]
	}
	if filename == "" {
		return "無題"
	}
	return filename
}
