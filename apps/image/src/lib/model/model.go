// Package model は IMAGE のドキュメント（キャンバスとレイヤー）のデータ構造。
// 座標・大きさはすべてドキュメントのピクセル単位で持つ（JavaScript の number と同じく float64）。
package model

import "math"

// MaxArea は一度に扱えるキャンバスの最大面積（iOS Safari の canvas の上限 16,777,216px に合わせる）。
const MaxArea = 4096 * 4096

// MaxSide はキャンバスの 1 辺の最大長。
const MaxSide = 8192

// FilterPreset はカラーフィルターのプリセット。
type FilterPreset = string

// Preset は選択肢の値と表示名。
type Preset struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// FilterPresets はカラーフィルターのプリセット（画面に出す順）。
var FilterPresets = []Preset{
	{"none", "なし"},
	{"mono", "モノクロ"},
	{"sepia", "セピア"},
	{"vivid", "ビビッド"},
	{"warm", "暖色"},
	{"cool", "寒色"},
	{"fade", "フェード"},
	{"invert", "反転"},
}

// Filters はレイヤーに掛けるフィルター。
type Filters struct {
	Preset FilterPreset
	// Brightness は -100〜100（0 で変化なし）。
	Brightness float64
	// Contrast は -100〜100。
	Contrast float64
	// Saturation は -100〜100。
	Saturation float64
	// Hue は -180〜180（度）。
	Hue float64
	// Tint は色かぶせの色（明るさを保ったまま、この色味に寄せる）。
	Tint string
	// TintAmount は色かぶせの強さ 0〜100。
	TintAmount float64
	// Blur はガウスぼかしの半径（標準偏差・px）0〜100。
	Blur float64
}

// DefaultFilters はフィルターなしの値。
var DefaultFilters = Filters{Preset: "none", Tint: "#ff8a00"}

// HasFilters はフィルターが掛かっているか。
func (f Filters) HasFilters() bool {
	return f.Preset != "none" || f.Brightness != 0 || f.Contrast != 0 || f.Saturation != 0 ||
		f.Hue != 0 || f.TintAmount != 0 || f.Blur != 0
}

// FontRef はテキストに使うフォントの指定。
type FontRef struct {
	// Source は "builtin"、"web"、"local"、"file" のどれか。
	Source string
	// ID は builtin: キー / web: Fontsource の id / local・file: ファミリー名。
	ID string
	// Family は画面に出す名前。
	Family string
	// Weights は web フォントで用意されている太さ（ほかは nil）。
	Weights []float64
	// Faces は端末のフォントの標準と太字の PostScript 名（local() に使う。ほかは nil）。
	Faces *Faces
}

// Faces は端末のフォントの書体の名前。
type Faces struct {
	Regular string
	// Bold は太字の PostScript 名。無ければ ""。
	Bold string
}

// Builtin は標準のフォント（LINE Seed JP）。
var Builtin = FontRef{Source: "builtin", ID: "line-seed", Family: "LINE Seed JP"}

// Key はフォントを区別するキー。
func (f FontRef) Key() string { return f.Source + ":" + f.ID }

// Same は同じフォントか。
func (f FontRef) Same(other FontRef) bool { return f.Key() == other.Key() }

// CharStyle は文字ごとの書式。
type CharStyle struct {
	Font FontRef
	// Size は文字の大きさ（px）。
	Size  float64
	Color string
	Bold  bool
}

// TextRun は同じ書式が続く文字のまとまり。改行（\n）も文字として含む。
type TextRun struct {
	Text  string
	Style CharStyle
}

// Part は文字の形のパス（SVG のパス）の 1 つ。
type Part struct {
	D     string
	Color string
	Bold  bool
}

// TextOutline は保存時に作る、文字の形のパス（フォントが無い端末でも同じ見た目で表示するため）。
type TextOutline struct {
	// Key はパスを作ったときの文字と書式（変わっていたら使わない）。
	Key    string
	Width  float64
	Height float64
	// Parts はレイヤーの左上を原点にした SVG のパス。
	Parts []Part
}

// レイヤーの種類。
const (
	TypeImage   = "image"
	TypeRect    = "rect"
	TypeEllipse = "ellipse"
	TypeText    = "text"
	TypePath    = "path"
)

// Layer はレイヤー。Type によって使うフィールドが変わる。
type Layer struct {
	ID      string
	Name    string
	Visible bool
	// Opacity は 0〜100。
	Opacity float64
	X       float64
	Y       float64
	Width   float64
	Height  float64
	Filters Filters
	Type    string

	// image: Assets のキー
	Asset string

	// rect・ellipse
	Fill        string
	FillEnabled bool
	Stroke      string
	// StrokeWidth は rect・ellipse・text・path の線（縁取り）の太さ（px）。
	StrokeWidth float64
	// Radius は角の丸さ（rect のみ）。
	Radius float64

	// text
	Runs  []TextRun
	Align string
	// LineHeight は行の高さ（各行の一番大きな文字に対する倍率 ×100）。
	LineHeight float64
	// StrokeColor は text・path の縁取りの色。
	StrokeColor string
	// Shadow は text・path の影。
	Shadow  bool
	Outline *TextOutline

	// path: パスの座標の基準の大きさ（Width / Height との比で拡大・縮小する）
	BaseWidth  float64
	BaseHeight float64
	Parts      []Part
	// Size は変換したときの一番大きな文字の大きさ（影の大きさに使う）。
	Size float64
}

// IsShape は四角か丸か。
func (l *Layer) IsShape() bool { return l.Type == TypeRect || l.Type == TypeEllipse }

// Doc はドキュメント。
type Doc struct {
	Name   string
	Width  float64
	Height float64
	// Background は背景色。"" は透明。
	Background string
	// Layers は下から上の順。
	Layers []*Layer
}

// Find は id のレイヤーを返す。無ければ nil。
func (d *Doc) Find(id string) *Layer {
	for _, layer := range d.Layers {
		if layer.ID == id {
			return layer
		}
	}
	return nil
}

// Index は layer の位置を返す。無ければ -1。
func (d *Doc) Index(layer *Layer) int {
	for i, l := range d.Layers {
		if l == layer {
			return i
		}
	}
	return -1
}

// CropPreset はトリミングの比率のプリセット。Size があるものは、その大きさ（px）に合わせることもできる。
type CropPreset struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Ratio は幅 ÷ 高さ。0 は自由。
	Ratio float64 `json:"ratio"`
	// Size は合わせる大きさ。無ければ nil。
	Size []float64 `json:"size"`
	// Note は名前の横に小さく出す説明。
	Note string `json:"note"`
}

// CropPresets はトリミングのプリセット（画面に出す順）。
var CropPresets = []CropPreset{
	{ID: "free", Label: "自由"},
	{ID: "square", Label: "1:1", Ratio: 1, Note: "正方形"},
	{ID: "4-5", Label: "4:5", Ratio: 4.0 / 5},
	{ID: "16-9", Label: "16:9", Ratio: 16.0 / 9},
	{ID: "ogp", Label: "OGP", Ratio: 1200.0 / 630, Size: []float64{1200, 630}},
	{ID: "x", Label: "X（Twitter）", Ratio: 16.0 / 9, Size: []float64{1600, 900}},
	{ID: "a4-portrait", Label: "A4 縦", Ratio: 1 / math.Sqrt2},
	{ID: "a4-landscape", Label: "A4 横", Ratio: math.Sqrt2},
}

// LayerTypeLabels はレイヤーの種類の表示名。
var LayerTypeLabels = map[string]string{
	TypeImage:   "画像",
	TypeRect:    "四角",
	TypeEllipse: "丸",
	TypeText:    "テキスト",
	TypePath:    "パス",
}

func base(doc *Doc, name string, width, height float64) *Layer {
	return &Layer{
		ID:      NewID(),
		Name:    name,
		Visible: true,
		Opacity: 100,
		X:       math.Round((doc.Width - width) / 2),
		Y:       math.Round((doc.Height - height) / 2),
		Width:   width,
		Height:  height,
		Filters: DefaultFilters,
	}
}

// nextName は同じ種類のレイヤーの数から「テキスト 2」のような名前を付ける。
func nextName(doc *Doc, typ string) string {
	label := LayerTypeLabels[typ]
	count := 0
	for _, layer := range doc.Layers {
		if layer.Type == typ {
			count++
		}
	}
	if count == 0 {
		return label
	}
	return label + " " + itoa(count+1)
}

// CreateShape は四角（rect）か丸（ellipse）のレイヤーを作る。
func CreateShape(doc *Doc, typ string) *Layer {
	size := math.Max(16, math.Round(math.Min(doc.Width, doc.Height)*0.3))
	layer := base(doc, nextName(doc, typ), size, size)
	layer.Type = typ
	layer.Fill = "#1a73e8"
	if typ == TypeRect {
		layer.Fill = "#06c755"
	}
	layer.FillEnabled = true
	layer.Stroke = "#ffffff"
	return layer
}

// CreateText はテキストのレイヤーを作る。style が nil なら標準の書式。
// 大きさは文字から決まるので、描画するときに測った値で上書きする。
func CreateText(doc *Doc, style *CharStyle) *Layer {
	size := math.Max(12, math.Round(math.Min(doc.Width, doc.Height)/10))
	layer := base(doc, nextName(doc, TypeText), size*4, size)
	layer.Type = TypeText
	s := CharStyle{Font: Builtin, Size: size, Color: "#ffffff", Bold: true}
	if style != nil {
		s = *style
	}
	layer.Runs = []TextRun{{Text: "テキスト", Style: s}}
	layer.Align = "center"
	layer.LineHeight = 130
	layer.StrokeColor = "#1b1f24"
	layer.StrokeWidth = math.Max(1, math.Round(size/12))
	return layer
}

// CreateImage は画像のレイヤーを作る。キャンバスに収まる大きさまで縮める（拡大はしない）。
func CreateImage(doc *Doc, asset string, imageWidth, imageHeight float64, name string) *Layer {
	scale := math.Min(1, math.Min(doc.Width/imageWidth, doc.Height/imageHeight))
	width := math.Max(1, math.Round(imageWidth*scale))
	height := math.Max(1, math.Round(imageHeight*scale))
	if name == "" {
		name = nextName(doc, TypeImage)
	}
	layer := base(doc, name, width, height)
	layer.Type = TypeImage
	layer.Asset = asset
	return layer
}

// Duplicate はレイヤーを複製する（少しずらして「〜 のコピー」という名前にする）。
func Duplicate(layer *Layer) *Layer {
	copied := layer.Clone()
	copied.ID = NewID()
	copied.Name = layer.Name + " のコピー"
	copied.X += 16
	copied.Y += 16
	return copied
}

// Clone はレイヤーを深くコピーする。
func (l *Layer) Clone() *Layer {
	c := *l
	c.Filters = l.Filters
	if l.Runs != nil {
		c.Runs = make([]TextRun, len(l.Runs))
		for i, run := range l.Runs {
			c.Runs[i] = TextRun{Text: run.Text, Style: run.Style.Clone()}
		}
	}
	if l.Outline != nil {
		outline := *l.Outline
		outline.Parts = append([]Part(nil), l.Outline.Parts...)
		c.Outline = &outline
	}
	if l.Parts != nil {
		c.Parts = append([]Part(nil), l.Parts...)
	}
	return &c
}

// Clone は書式をコピーする（フォントの太さの一覧なども別のものにする）。
func (s CharStyle) Clone() CharStyle {
	s.Font = s.Font.Clone()
	return s
}

// Clone はフォントの指定をコピーする。
func (f FontRef) Clone() FontRef {
	if f.Weights != nil {
		f.Weights = append([]float64(nil), f.Weights...)
	}
	if f.Faces != nil {
		faces := *f.Faces
		f.Faces = &faces
	}
	return f
}

// Clone はドキュメントを深くコピーする。
func (d *Doc) Clone() *Doc {
	c := *d
	c.Layers = make([]*Layer, len(d.Layers))
	for i, layer := range d.Layers {
		c.Layers[i] = layer.Clone()
	}
	return &c
}

// FitSize はキャンバスの大きさを上限内に収める（縦横比は保つ）。scaled は縮めたかどうか。
func FitSize(width, height float64) (w, h float64, scaled bool) {
	scale := math.Min(math.Min(1, MaxSide/width), math.Min(MaxSide/height, math.Sqrt(MaxArea/(width*height))))
	return math.Max(1, math.Floor(width*scale)), math.Max(1, math.Floor(height*scale)), scale < 1
}

// Clamp は value を min〜max に収める。
func Clamp(value, min, max float64) float64 {
	return math.Min(max, math.Max(min, value))
}

// IsHex は「#rrggbb」の形の色か。
func IsHex(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for i := 1; i < 7; i++ {
		c := value[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
