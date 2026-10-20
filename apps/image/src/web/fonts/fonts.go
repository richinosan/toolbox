//go:build js

// Package fonts はテキストに使うフォントの管理。
//   - 標準: LINE Seed JP（サイトのフォント。Astro の Fonts API が配信する）
//   - Web フォント: Fontsource のフォントを、使うときだけ jsDelivr から読み込む（文字の範囲ごとに分かれたファイルの必要な分だけ）
//   - 端末のフォント: Local Font Access API（Chrome / Edge）で一覧を読み、local() で使う
//   - ファイル: 読み込んだ .ttf / .otf / .woff / .woff2 をそのまま使う（ページを閉じると消える）
//
// どのフォントも canvas では別名（tb-…）で登録し、同じ名前のフォントが端末にあっても取り違えないようにする。
// 「待つ」関数（Ensure など）は Promise の完了を待つので、goroutine の中で呼ぶ。
package fonts

import (
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"syscall/js"
	"unicode/utf16"

	"toolbox.richinosan.com/apps/image/src/lib/model"
	"toolbox.richinosan.com/packages/ui/src/web"
)

// 読み込みの状態。
const (
	Ready   = "ready"
	Loading = "loading"
	Missing = "missing"
)

var fontsourceID = web.NewRegExp(`^[a-z0-9][a-z0-9-]{0,80}$`, "")

const (
	cdn     = "https://cdn.jsdelivr.net/npm/@fontsource"
	catalog = "https://api.fontsource.org/v1/fonts"
)

// CatalogFont は Fontsource のフォント。
type CatalogFont struct {
	ID       string
	Family   string
	Weights  []float64
	Category string
	Japanese bool
}

func cf(id, family string, weights []float64, category string, japanese bool) CatalogFont {
	return CatalogFont{ID: id, Family: family, Weights: weights, Category: category, Japanese: japanese}
}

// Recommended はよく使うフォント（最初に一覧に出す）。太さは Fontsource の情報どおり。
var Recommended = []CatalogFont{
	cf("noto-sans-jp", "Noto Sans JP", []float64{100, 200, 300, 400, 500, 600, 700, 800, 900}, "sans-serif", true),
	cf("noto-serif-jp", "Noto Serif JP", []float64{200, 300, 400, 500, 600, 700, 800, 900}, "serif", true),
	cf("m-plus-rounded-1c", "M PLUS Rounded 1c", []float64{100, 300, 400, 500, 700, 800, 900}, "sans-serif", true),
	cf("zen-maru-gothic", "Zen Maru Gothic", []float64{300, 400, 500, 700, 900}, "sans-serif", true),
	cf("zen-kaku-gothic-new", "Zen Kaku Gothic New", []float64{300, 400, 500, 700, 900}, "sans-serif", true),
	cf("biz-udpgothic", "BIZ UDPGothic", []float64{400, 700}, "sans-serif", true),
	cf("kosugi-maru", "Kosugi Maru", []float64{400}, "sans-serif", true),
	cf("dela-gothic-one", "Dela Gothic One", []float64{400}, "display", true),
	cf("rocknroll-one", "RocknRoll One", []float64{400}, "sans-serif", true),
	cf("mochiy-pop-one", "Mochiy Pop One", []float64{400}, "sans-serif", true),
	cf("reggae-one", "Reggae One", []float64{400}, "display", true),
	cf("potta-one", "Potta One", []float64{400}, "display", true),
	cf("train-one", "Train One", []float64{400}, "display", true),
	cf("dotgothic16", "DotGothic16", []float64{400}, "sans-serif", true),
	cf("yusei-magic", "Yusei Magic", []float64{400}, "sans-serif", true),
	cf("hachi-maru-pop", "Hachi Maru Pop", []float64{400}, "handwriting", true),
	cf("klee-one", "Klee One", []float64{400, 600}, "handwriting", true),
	cf("yomogi", "Yomogi", []float64{400}, "handwriting", true),
	cf("shippori-mincho", "Shippori Mincho", []float64{400, 500, 600, 700, 800}, "serif", true),
	cf("zen-old-mincho", "Zen Old Mincho", []float64{400, 500, 600, 700, 900}, "serif", true),
	cf("kaisei-decol", "Kaisei Decol", []float64{400, 500, 700}, "serif", true),
	cf("bebas-neue", "Bebas Neue", []float64{400}, "sans-serif", false),
	cf("anton", "Anton", []float64{400}, "sans-serif", false),
	cf("oswald", "Oswald", []float64{200, 300, 400, 500, 600, 700}, "sans-serif", false),
	cf("montserrat", "Montserrat", []float64{100, 200, 300, 400, 500, 600, 700, 800, 900}, "sans-serif", false),
	cf("poppins", "Poppins", []float64{100, 200, 300, 400, 500, 600, 700, 800, 900}, "sans-serif", false),
	cf("inter", "Inter", []float64{100, 200, 300, 400, 500, 600, 700, 800, 900}, "sans-serif", false),
	cf("playfair-display", "Playfair Display", []float64{400, 500, 600, 700, 800, 900}, "serif", false),
	cf("lobster", "Lobster", []float64{400}, "display", false),
	cf("pacifico", "Pacifico", []float64{400}, "handwriting", false),
	cf("permanent-marker", "Permanent Marker", []float64{400}, "handwriting", false),
}

// CategoryLabels はフォントの分類の表示名。
var CategoryLabels = map[string]string{
	"sans-serif":  "ゴシック",
	"serif":       "明朝・セリフ",
	"display":     "デザイン",
	"handwriting": "手書き",
	"monospace":   "等幅",
}

// WebRef は Fontsource のフォントの指定。
func WebRef(font CatalogFont) model.FontRef {
	return model.FontRef{Source: "web", ID: font.ID, Family: font.Family, Weights: font.Weights}
}

// ---- 状態の通知 ----

type listener struct {
	id int
	f  func()
}

var (
	listeners    []listener
	nextListener int
	version      int
)

// Subscribe はフォントの読み込みや追加で状態が変わったら listener を呼ぶ（描画のキャッシュを捨てるため）。戻り値で登録を外す。
func Subscribe(f func()) (unsubscribe func()) {
	nextListener++
	id := nextListener
	listeners = append(listeners, listener{id, f})
	return func() {
		listeners = slices.DeleteFunc(listeners, func(l listener) bool { return l.id == id })
	}
}

// Version は状態が変わるたびに増える数（描画のキャッシュのキーに使う）。
func Version() int { return version }

func changed() {
	version++
	for _, l := range slices.Clone(listeners) {
		l.f()
	}
}

// ---- 太さ ----

// nearestWeight は指定した太さに一番近い、用意されている太さ。
func nearestWeight(weights []float64, target float64) float64 {
	if len(weights) == 0 {
		return 400
	}
	best := weights[0]
	for _, w := range weights {
		if math.Abs(w-target) < math.Abs(best-target) {
			best = w
		}
	}
	return best
}

func heavyWeights(weights []float64) []float64 {
	var heavy []float64
	for _, w := range weights {
		if w >= 600 {
			heavy = append(heavy, w)
		}
	}
	return heavy
}

// HasRealBold は太字にしたとき、実際のフォントに太字があるか（無ければブラウザが擬似的に太くする）。
func HasRealBold(ref model.FontRef) bool {
	switch ref.Source {
	case "web":
		weights := ref.Weights
		if weights == nil {
			weights = []float64{400}
		}
		return len(heavyWeights(weights)) > 0
	case "local":
		return ref.Faces != nil && ref.Faces.Bold != ""
	case "file":
		return slices.ContainsFunc(fileFaces[ref.ID], func(f fileFace) bool { return f.weight >= 600 })
	}
	return true
}

// webWeight は web フォントで読み込む太さのファイル（太字が無いフォントは標準の太さを読み、ブラウザに太らせる）。
func webWeight(ref model.FontRef, bold bool) float64 {
	weights := ref.Weights
	if len(weights) == 0 {
		weights = []float64{400}
	}
	if heavy := heavyWeights(weights); bold && len(heavy) > 0 {
		return nearestWeight(heavy, 700)
	}
	return nearestWeight(weights, 400)
}

// ---- canvas・CSS に渡す名前 ----

func quote(name string) string {
	return `"` + strings.NewReplacer(`"`, "", `\`, "").Replace(name) + `"`
}

// hash は別名に使えるよう、文字列を短い英数字にする（FNV-1a、UTF-16 のコード単位ごと）。
func hash(text string) string {
	h := uint32(2166136261)
	for _, c := range utf16.Encode([]rune(text)) {
		h ^= uint32(c)
		h *= 16777619
	}
	return strconv.FormatUint(uint64(h), 36)
}

func alias(ref model.FontRef) string { return "tb-" + ref.Source + "-" + hash(ref.ID) }

func builtinFamily() string {
	value := js.Global().Call("getComputedStyle", web.Document().Get("documentElement")).
		Call("getPropertyValue", "--font-line-seed-jp").String()
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return "system-ui, sans-serif"
}

// CSSFamily は canvas の font や CSS の font-family に使う値（代わりのフォントも付ける）。
func CSSFamily(ref model.FontRef) string {
	if ref.Source == "builtin" {
		return builtinFamily()
	}
	return quote(alias(ref)) + ", " + builtinFamily()
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// FontString は canvas の font 指定。web フォントは実際に用意されている太さを使う。
func FontString(ref model.FontRef, size float64, bold bool) string {
	// 太字が無いフォントでも 700 を指定すれば、ブラウザが擬似的に太らせる
	weight := 400.0
	if ref.Source == "web" && !(bold && !HasRealBold(ref)) {
		weight = webWeight(ref, bold)
	} else if bold {
		weight = 700
	}
	return num(weight) + " " + num(size) + "px " + CSSFamily(ref)
}

// loadString は document.fonts.load に渡す font 指定。代わりのフォントを含めると、端末に無い代わりのフォント
// （local("Arial") など）の読み込みに失敗して全体が失敗するので、そのフォントだけを指定する。
func loadString(ref model.FontRef, bold bool) string {
	family := quote(alias(ref))
	if ref.Source == "builtin" {
		family, _, _ = strings.Cut(builtinFamily(), ",")
	}
	return strings.Replace(FontString(ref, 16, bold), CSSFamily(ref), family, 1)
}

// ---- 待つ処理の共有（同じ読み込みを何度もしないため） ----

type task[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func start[T any](f func() (T, error)) *task[T] {
	t := &task[T]{done: make(chan struct{})}
	go func() {
		t.err = catch(func() (err error) {
			t.value, err = f()
			return err
		})
		close(t.done)
	}()
	return t
}

func (t *task[T]) wait() (T, error) {
	<-t.done
	return t.value, t.err
}

// catch は f の JavaScript の例外（syscall/js の panic）もエラーにする。
func catch(f func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			switch r := r.(type) {
			case error:
				err = r
			case string:
				err = errors.New(r)
			default:
				err = errors.New("panic")
			}
		}
	}()
	return f()
}

func await(promise js.Value) js.Value {
	v, err := web.Await(promise)
	if err != nil {
		panic(err)
	}
	return v
}

func fetchOK(url string) (js.Value, error) {
	response, err := web.Await(js.Global().Call("fetch", url))
	if err != nil {
		return js.Undefined(), err
	}
	if !response.Get("ok").Bool() {
		return js.Undefined(), errors.New("fetch " + strconv.Itoa(response.Get("status").Int()))
	}
	return response, nil
}

// ---- 読み込み ----

type webFace struct {
	url    string
	weight float64
	ranges [][2]float64
}

var (
	statuses = map[string]string{}
	webCSS   = map[string]*task[[]webFace]{}
)

// Status は読み込みの状態（Ready・Loading・Missing）。
func Status(ref model.FontRef) string {
	if ref.Source == "builtin" {
		return Ready
	}
	if s, ok := statuses[ref.Key()]; ok {
		return s
	}
	return Loading
}

func setStatus(ref model.FontRef, next string) {
	if statuses[ref.Key()] == next {
		return
	}
	statuses[ref.Key()] = next
	changed()
}

var hexPrefix = web.NewRegExp(`^[0-9a-fA-F]+`, "")

// parseHex は Number.parseInt(s, 16) と同じく先頭の 16 進数を読む（無ければ NaN）。
func parseHex(s string) float64 {
	digits := hexPrefix.FindString(strings.TrimSpace(s))
	if digits == "" {
		return math.NaN()
	}
	v, err := strconv.ParseUint(digits, 16, 64)
	if err != nil {
		return math.Inf(1)
	}
	return float64(v)
}

var unicodePrefix = web.NewRegExp(`^U\+`, "i")

func parseRanges(value string) [][2]float64 {
	var ranges [][2]float64
	for _, part := range strings.Split(value, ",") {
		part = unicodePrefix.ReplaceAllString(strings.TrimSpace(part), "")
		if part == "" {
			continue
		}
		if strings.Contains(part, "?") {
			ranges = append(ranges, [2]float64{
				parseHex(strings.ReplaceAll(part, "?", "0")),
				parseHex(strings.ReplaceAll(part, "?", "f")),
			})
			continue
		}
		start, end, _ := strings.Cut(part, "-")
		a := parseHex(start)
		b := a
		if end != "" {
			b = parseHex(end)
		}
		ranges = append(ranges, [2]float64{a, b})
	}
	return ranges
}

var (
	fontFaceBlock = web.NewRegExp(`@font-face\s*\{[^}]*\}`, "")
	italicStyle   = web.NewRegExp(`font-style:\s*italic`, "")
	woff2URL      = web.NewRegExp(`url\(([^)]+?\.woff2)\)`, "")
	unicodeRange  = web.NewRegExp(`unicode-range:\s*([^;]+);`, "")
	quotes        = strings.NewReplacer(`"`, "", `'`, "")
)

func newFontFace(family string, source any, descriptors map[string]any) js.Value {
	return js.Global().Get("FontFace").New(family, source, descriptors)
}

// loadWebWeight は Fontsource の CSS を読み、@font-face を別名で登録する。
func loadWebWeight(ref model.FontRef, weight float64) ([]webFace, error) {
	key := ref.ID + "@" + num(weight)
	pending, ok := webCSS[key]
	if !ok {
		pending = start(func() ([]webFace, error) {
			if !fontsourceID.Test(ref.ID) {
				return nil, errors.New("invalid font id")
			}
			cssURL := cdn + "/" + ref.ID + "@5/" + num(weight) + ".css"
			response, err := fetchOK(cssURL)
			if err != nil {
				return nil, err
			}
			css := await(response.Call("text")).String()
			var faces []webFace
			fontFaces := web.Document().Get("fonts")
			for _, block := range fontFaceBlock.FindAllString(css) {
				if italicStyle.Test(block) {
					continue
				}
				m := woff2URL.Find(block)
				if m == nil {
					continue
				}
				absolute := js.Global().Get("URL").New(quotes.Replace(m[1]), cssURL).Get("href").String()
				if !strings.HasPrefix(absolute, cdn+"/") {
					continue
				}
				descriptors := map[string]any{"weight": num(weight), "display": "swap"}
				ranges := [][2]float64{{0, 0x10ffff}}
				if r := unicodeRange.Find(block); r != nil {
					descriptors["unicodeRange"] = r[1]
					ranges = parseRanges(r[1])
				}
				fontFaces.Call("add", newFontFace(alias(ref), `url(`+absolute+`) format("woff2")`, descriptors))
				faces = append(faces, webFace{url: absolute, weight: weight, ranges: ranges})
			}
			return faces, nil
		})
		webCSS[key] = pending
	}
	faces, err := pending.wait()
	if err != nil && webCSS[key] == pending {
		delete(webCSS, key)
	}
	return faces, err
}

// Ensure は text に使う文字のフォントを読み込む。使えるようになったら true。待つので goroutine の中で呼ぶ。
func Ensure(ref model.FontRef, bold bool, text string) (ok bool) {
	sample := text
	if sample == "" {
		sample = "A"
	}
	err := catch(func() error {
		fontFaces := web.Document().Get("fonts")
		switch ref.Source {
		case "builtin":
			await(fontFaces.Call("load", loadString(ref, bold), sample))
			ok = true
		case "web":
			if _, err := loadWebWeight(ref, webWeight(ref, bold)); err != nil {
				return err
			}
			await(fontFaces.Call("load", loadString(ref, bold), sample))
			setStatus(ref, Ready)
			ok = true
		case "local":
			if err := registerLocal(ref); err != nil {
				return err
			}
			ok = Status(ref) == Ready
		case "file":
			if _, found := fileFaces[ref.ID]; !found {
				setStatus(ref, Missing)
				return nil
			}
			ok = true
		}
		return nil
	})
	if err != nil {
		setStatus(ref, Missing)
		return false
	}
	return ok
}

// ---- 端末のフォント ----

// localFaces はファミリーごとの、PostScript 名から FontData への表。
var localFaces = map[string]map[string]js.Value{}

// CanQueryLocal は端末のフォントの一覧を読めるブラウザか。
func CanQueryLocal() bool {
	return js.Global().Get("queryLocalFonts").Type() == js.TypeFunction
}

// LocalFamily は端末のフォントのファミリー。
type LocalFamily struct {
	Family string
	Ref    model.FontRef
}

var (
	boldStyle    = web.NewRegExp(`bold|heavy|black|w[6-9]`, "i")
	regularStyle = web.NewRegExp(`^(regular|normal|book|roman|w[34]|medium)$`, "i")
	italic       = web.NewRegExp(`italic|oblique`, "i")
)

// QueryLocal は端末のフォントの一覧（ファミリーごと、名前順）。待つので goroutine の中で呼ぶ。
func QueryLocal() (result []LocalFamily, err error) {
	if !CanQueryLocal() {
		return nil, errors.New("queryLocalFonts is not supported")
	}
	err = catch(func() error {
		list, err := web.Await(js.Global().Call("queryLocalFonts"))
		if err != nil {
			return err
		}
		var order []string
		families := map[string][]js.Value{}
		for i := range list.Length() {
			data := list.Index(i)
			family := data.Get("family").String()
			if _, ok := families[family]; !ok {
				order = append(order, family)
			}
			families[family] = append(families[family], data)
		}
		for _, family := range order {
			faces := families[family]
			byName := map[string]js.Value{}
			for _, face := range faces {
				byName[face.Get("postscriptName").String()] = face
			}
			localFaces[family] = byName
			style := func(face js.Value) string { return face.Get("style").String() }
			regular := faces[0]
			if i := slices.IndexFunc(faces, func(f js.Value) bool { return regularStyle.Test(strings.TrimSpace(style(f))) }); i >= 0 {
				regular = faces[i]
			} else if i := slices.IndexFunc(faces, func(f js.Value) bool { return !boldStyle.Test(style(f)) && !italic.Test(style(f)) }); i >= 0 {
				regular = faces[i]
			}
			names := &model.Faces{Regular: regular.Get("postscriptName").String()}
			if i := slices.IndexFunc(faces, func(f js.Value) bool { return boldStyle.Test(style(f)) && !italic.Test(style(f)) }); i >= 0 {
				names.Bold = faces[i].Get("postscriptName").String()
			}
			result = append(result, LocalFamily{Family: family, Ref: model.FontRef{Source: "local", ID: family, Family: family, Faces: names}})
		}
		collator := js.Global().Get("Intl").Get("Collator").New("ja")
		slices.SortStableFunc(result, func(a, b LocalFamily) int {
			return collator.Call("compare", a.Family, b.Family).Int()
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

var localRegistered = map[string]*task[struct{}]{}

// registerLocal は端末のフォントを local() で別名に登録する。見つからなければ missing にする。
func registerLocal(ref model.FontRef) error {
	key := ref.Key()
	pending, ok := localRegistered[key]
	if !ok {
		pending = start(func() (struct{}, error) {
			faces := model.Faces{Regular: ref.ID}
			if ref.Faces != nil {
				faces = *ref.Faces
			}
			type entry struct {
				name   string
				weight string
			}
			entries := []entry{{faces.Regular, "400"}}
			if faces.Bold != "" {
				entries = append(entries, entry{faces.Bold, "700"})
			}
			// 標準と太字を同時に読み込む
			loads := make([]js.Value, len(entries))
			faceValues := make([]js.Value, len(entries))
			for i, e := range entries {
				faceValues[i] = newFontFace(alias(ref), "local("+quote(e.name)+")", map[string]any{"weight": e.weight})
				loads[i] = faceValues[i].Call("load")
			}
			loaded := make([]bool, len(entries))
			for i := range entries {
				if _, err := web.Await(loads[i]); err == nil {
					web.Document().Get("fonts").Call("add", faceValues[i])
					loaded[i] = true
				}
			}
			if loaded[0] {
				setStatus(ref, Ready)
			} else {
				setStatus(ref, Missing)
			}
			return struct{}{}, nil
		})
		localRegistered[key] = pending
	}
	_, err := pending.wait()
	return err
}

// ---- ファイルから読み込んだフォント ----

type fileFace struct {
	weight         float64
	data           js.Value
	postscriptName string
}

var fileFaces = map[string][]fileFace{}

//goesm:import "./lazy.ts" loadFontkit await
func loadFontkit() (js.Value, error)

var (
	extension = web.NewRegExp(`\.[^.]+$`, "")
	boldName  = web.NewRegExp(`bold`, "i")
)

// sliceUTF16 は String.prototype.slice(0, n) と同じく、UTF-16 のコード単位で n 個までにする。
func sliceUTF16(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// AddFile はフォントファイル（File）を登録する。ファミリー名と太さはファイルから読む（fontkit を使うときだけ読み込む）。
// 待つので goroutine の中で呼ぶ。
func AddFile(file js.Value) (ref model.FontRef, err error) {
	err = catch(func() error {
		data, err := web.Await(file.Call("arrayBuffer"))
		if err != nil {
			return err
		}
		fontkit, err := loadFontkit()
		if err != nil {
			return err
		}
		parsed := fontkit.Call("create", js.Global().Get("Uint8Array").New(data))
		collection := js.Global().Get("Reflect").Call("has", parsed, "fonts").Bool()
		font := parsed
		if collection {
			font = parsed.Get("fonts").Index(0)
		}
		if font.IsUndefined() || font.IsNull() {
			return errors.New("empty font collection")
		}
		family := ""
		if name := font.Get("familyName"); name.Truthy() {
			family = name.String()
		} else {
			family = extension.ReplaceAllString(file.Get("name").String(), "")
		}
		family = sliceUTF16(family, 100)
		weight := 400.0
		if os2 := font.Get("OS/2"); os2.Truthy() && !os2.Get("usWeightClass").IsUndefined() && !os2.Get("usWeightClass").IsNull() {
			weight = os2.Get("usWeightClass").Float()
		} else if sub := font.Get("subfamilyName"); sub.Type() == js.TypeString && boldName.Test(sub.String()) {
			weight = 700
		}
		ref = model.FontRef{Source: "file", ID: family, Family: family}
		face := newFontFace(alias(ref), data, map[string]any{"weight": num(weight)})
		if _, err := web.Await(face.Call("load")); err != nil {
			return err
		}
		web.Document().Get("fonts").Call("add", face)
		added := fileFace{weight: weight, data: data}
		if collection {
			added.postscriptName = font.Get("postscriptName").String()
		}
		fileFaces[family] = append(fileFaces[family], added)
		statuses[ref.Key()] = Ready
		changed()
		return nil
	})
	if err != nil {
		return model.FontRef{}, err
	}
	return ref, nil
}

// ---- 文字の形（パス）を作るためのフォントのデータ ----

// Binary は文字の形（パス）を作るためのフォントのデータ。
type Binary struct {
	// Key はファイルを区別するキー（同じファイルを何度も解析しないため）。
	Key string
	// Data はフォントファイルの ArrayBuffer。
	Data js.Value
	// PostscriptName はフォントコレクションから選ぶ書体の名前（無ければ ""）。
	PostscriptName string
	// Synthetic は太字が無く、太らせて描く必要があるか。
	Synthetic bool
}

var binaryCache = map[string]*task[js.Value]{}

func fetchBinary(url string) (js.Value, error) {
	pending, ok := binaryCache[url]
	if !ok {
		pending = start(func() (js.Value, error) {
			response, err := fetchOK(url)
			if err != nil {
				return js.Undefined(), err
			}
			return web.Await(response.Call("arrayBuffer"))
		})
		binaryCache[url] = pending
	}
	data, err := pending.wait()
	if err != nil && binaryCache[url] == pending {
		delete(binaryCache, url)
	}
	return data, err
}

func inRanges(ranges [][2]float64, codePoint rune) bool {
	c := float64(codePoint)
	for _, r := range ranges {
		if c >= r[0] && c <= r[1] {
			return true
		}
	}
	return false
}

// cssWeight は CSSOM の font-weight（"bold" や "normal" になることもある）を数にする。
func cssWeight(value string) float64 {
	v := strings.TrimSpace(value)
	if v == "bold" {
		return 700
	}
	digits := leadingInt.FindString(v)
	if n, err := strconv.Atoi(digits); err == nil && n != 0 {
		return float64(n)
	}
	return 400
}

var (
	cssURL     = web.NewRegExp(`url\(["']?([^"')]+)["']?\)`, "")
	leadingInt = web.NewRegExp(`^[+-]?[0-9]+`, "")
)

// builtinFaces は LINE Seed JP の @font-face（ページの CSS から URL を読む）。
func builtinFaces() []webFace {
	first, _, _ := strings.Cut(builtinFamily(), ",")
	family := quotes.Replace(strings.TrimSpace(first))
	fontFaceRule := js.Global().Get("CSSFontFaceRule")
	var faces []webFace
	sheets := web.Document().Get("styleSheets")
	for i := range sheets.Length() {
		sheet := sheets.Index(i)
		var rules js.Value
		if !web.Try(func() { rules = sheet.Get("cssRules") }) || !rules.Truthy() {
			continue
		}
		for j := range rules.Length() {
			rule := rules.Index(j)
			if !rule.InstanceOf(fontFaceRule) {
				continue
			}
			style := rule.Get("style")
			get := func(name string) string { return style.Call("getPropertyValue", name).String() }
			if strings.TrimSpace(quotes.Replace(get("font-family"))) != family {
				continue
			}
			m := cssURL.Find(get("src"))
			if m == nil {
				continue
			}
			base := sheet.Get("href")
			if base.IsNull() || base.IsUndefined() {
				base = js.Global().Get("location").Get("href")
			}
			ranges := [][2]float64{{0, 0x10ffff}}
			if r := get("unicode-range"); r != "" {
				ranges = parseRanges(r)
			}
			faces = append(faces, webFace{
				url:    js.Global().Get("URL").New(m[1], base).Get("href").String(),
				weight: cssWeight(get("font-weight")),
				ranges: ranges,
			})
		}
	}
	return faces
}

// BinaryFor は 1 文字分のフォントのデータ。web フォントと LINE Seed JP は文字の範囲ごとにファイルが分かれているので、
// その文字を含むファイルを返す。手に入らなければ ok が false。待つので goroutine の中で呼ぶ。
func BinaryFor(ref model.FontRef, bold bool, codePoint rune) (binary Binary, ok bool) {
	err := catch(func() error {
		switch ref.Source {
		case "builtin", "web":
			var weight float64
			var faces []webFace
			if ref.Source == "web" {
				weight = webWeight(ref, bold)
				var err error
				if faces, err = loadWebWeight(ref, weight); err != nil {
					return err
				}
			} else {
				// ページの CSS にある太さの中から選ぶ（太字が無ければ標準の太さを太らせて描く）
				all := builtinFaces()
				var weights []float64
				for _, f := range all {
					if !slices.Contains(weights, f.weight) {
						weights = append(weights, f.weight)
					}
				}
				if heavy := heavyWeights(weights); bold && len(heavy) > 0 {
					weight = nearestWeight(heavy, 700)
				} else {
					weight = nearestWeight(weights, 400)
				}
				for _, f := range all {
					if f.weight == weight {
						faces = append(faces, f)
					}
				}
			}
			i := slices.IndexFunc(faces, func(f webFace) bool { return inRanges(f.ranges, codePoint) })
			if i < 0 {
				return nil
			}
			data, err := fetchBinary(faces[i].url)
			if err != nil {
				return err
			}
			binary, ok = Binary{Key: faces[i].url, Data: data, Synthetic: bold && weight < 600}, true
		case "file":
			faces := fileFaces[ref.ID]
			if len(faces) == 0 {
				return nil
			}
			face := faces[0]
			if i := slices.IndexFunc(faces, func(f fileFace) bool { return (f.weight >= 600) == bold }); i >= 0 {
				face = faces[i]
			}
			binary = Binary{
				Key:            "file:" + ref.ID + ":" + num(face.weight),
				Data:           face.data,
				PostscriptName: face.postscriptName,
				Synthetic:      bold && face.weight < 600,
			}
			ok = true
		case "local":
			faces := model.Faces{Regular: ref.ID}
			if ref.Faces != nil {
				faces = *ref.Faces
			}
			name := faces.Regular
			if bold && faces.Bold != "" {
				name = faces.Bold
			}
			data, found := localFaces[ref.ID][name]
			if !found {
				// ページを開き直したあとは、もう一度一覧を読む（許可済みなら確認は出ない）
				if _, err := QueryLocal(); err != nil {
					return nil
				}
				if data, found = localFaces[ref.ID][name]; !found {
					return nil
				}
			}
			blob, err := web.Await(data.Call("blob"))
			if err != nil {
				return err
			}
			buffer, err := web.Await(blob.Call("arrayBuffer"))
			if err != nil {
				return err
			}
			binary = Binary{Key: "local:" + name, Data: buffer, PostscriptName: name, Synthetic: bold && faces.Bold == ""}
			ok = true
		}
		return nil
	})
	if err != nil {
		return Binary{}, false
	}
	return binary, ok
}

// ---- Fontsource の一覧（検索用） ----

var catalogTask *task[[]CatalogFont]

func isArray(v js.Value) bool { return js.Global().Get("Array").Call("isArray", v).Bool() }

// LoadCatalog は Fontsource の一覧（検索用）。待つので goroutine の中で呼ぶ。
func LoadCatalog() ([]CatalogFont, error) {
	pending := catalogTask
	if pending == nil {
		pending = start(func() ([]CatalogFont, error) {
			response, err := fetchOK(catalog)
			if err != nil {
				return nil, err
			}
			data := await(response.Call("json"))
			var list []CatalogFont
			if !isArray(data) {
				return list, nil
			}
			for i := range data.Length() {
				item := data.Index(i)
				if item.Type() != js.TypeObject {
					continue
				}
				id, family, weights, category, subsets := item.Get("id"), item.Get("family"), item.Get("weights"), item.Get("category"), item.Get("subsets")
				if id.Type() != js.TypeString || !fontsourceID.Test(id.String()) || family.Type() != js.TypeString ||
					!isArray(weights) || !isArray(subsets) || (category.Type() == js.TypeString && category.String() == "icons") {
					continue
				}
				font := CatalogFont{ID: id.String(), Family: family.String(), Category: js.Global().Call("String", category).String()}
				for j := range weights.Length() {
					if w := weights.Index(j); w.Type() == js.TypeNumber {
						font.Weights = append(font.Weights, w.Float())
					}
				}
				font.Japanese = subsets.Call("includes", "japanese").Bool()
				list = append(list, font)
			}
			return list, nil
		})
		catalogTask = pending
	}
	list, err := pending.wait()
	if err != nil && catalogTask == pending {
		catalogTask = nil
	}
	return list, err
}

// ReadRef は作品ファイルから読んだフォント指定（JSON.parse した値）を確かめる。おかしければ model.Builtin。
func ReadRef(value js.Value) model.FontRef {
	if value.Type() != js.TypeObject {
		return model.Builtin
	}
	str := func(v js.Value, fallback string) string {
		if v.Type() == js.TypeString {
			return sliceUTF16(v.String(), 200)
		}
		return fallback
	}
	id := str(value.Get("id"), "")
	family := str(value.Get("family"), id)
	if id == "" {
		return model.Builtin
	}
	switch source := value.Get("source"); str(source, "") {
	case "web":
		if !fontsourceID.Test(id) {
			return model.Builtin
		}
		weights := []float64{}
		if list := value.Get("weights"); isArray(list) {
			for i := range list.Length() {
				w := list.Index(i)
				if w.Type() == js.TypeNumber && w.Float() >= 100 && w.Float() <= 1000 && len(weights) < 20 {
					weights = append(weights, w.Float())
				}
			}
		} else {
			weights = []float64{400}
		}
		if len(weights) == 0 {
			weights = []float64{400}
		}
		return model.FontRef{Source: "web", ID: id, Family: family, Weights: weights}
	case "local":
		faces := &model.Faces{Regular: id}
		if v := value.Get("faces"); v.Type() == js.TypeObject {
			faces.Regular = str(v.Get("regular"), id)
			faces.Bold = str(v.Get("bold"), "")
		}
		return model.FontRef{Source: "local", ID: id, Family: family, Faces: faces}
	case "file":
		return model.FontRef{Source: "file", ID: id, Family: family}
	}
	return model.Builtin
}
