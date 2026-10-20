//go:build js

// Package assets は、ドキュメントの画像レイヤーが使う画像（元のファイルと ImageBitmap）を持つ。
package assets

import "syscall/js"

// Asset は画像 1 枚。
type Asset struct {
	// Blob は元のファイル（保存するときに埋め込む）。
	Blob js.Value
	// Image は描画に使う ImageBitmap。
	Image js.Value
}

// Assets は id ごとの画像。
type Assets map[string]Asset
