package model

import "math"

// Round は JavaScript の Math.round（.5 は大きい方へ。負の数でも同じ）。
func Round(v float64) float64 { return math.Floor(v + 0.5) }

// ExportFormats は書き出す形式と表示名（画面に出す順）。
var ExportFormats = []Preset{{"png", "PNG"}, {"jpeg", "JPEG"}, {"webp", "WebP"}, {"psd", "PSD"}}

// ProjectExtension は作品ファイルの拡張子。
const ProjectExtension = ".tbimg"

// ProjectAccept はファイルを選ぶ input の accept。
const ProjectAccept = ProjectExtension + ",image/*"

// PageData は index.astro（ビルド時）で選択肢などを作るための値。
type PageData struct {
	MaxSide       int
	CropPresets   []CropPreset
	FilterPresets []Preset
	ExportFormats []Preset
	Accept        string
}

// Page は index.astro で使う値。
func Page() PageData {
	return PageData{
		MaxSide:       MaxSide,
		CropPresets:   CropPresets,
		FilterPresets: FilterPresets,
		ExportFormats: ExportFormats,
		Accept:        ProjectAccept,
	}
}
