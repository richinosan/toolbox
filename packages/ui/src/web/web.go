//go:build js

// Package web は各ツールのページを Go（goesm）で書くための、DOM まわりの小さな共通処理。
// DOM は syscall/js で直接さわる（goesm がプロパティアクセスと関数呼び出しにそのまま変換する）。
package web

import (
	"errors"
	"syscall/js"
)

// Document は window.document。
func Document() js.Value { return js.Global().Get("document") }

// Query は document.querySelector(selector)。見つからなければ null（IsNull が true）。
func Query(selector string) js.Value {
	return Document().Call("querySelector", selector)
}

// Listen は target に type のイベントリスナーを付ける。
func Listen(target js.Value, typ string, handler func(event js.Value)) {
	target.Call("addEventListener", typ, js.FuncOf(func(this js.Value, args []js.Value) any {
		handler(args[0])
		return nil
	}))
}

// OnPageLoad はページを表示するたびに init を呼ぶ。ClientRouter での遷移ではスクリプトが再実行されないので、
// astro:page-load で初期化する（ほかのツールのページでも呼ばれるので、init の中で自分のページか確かめる）。
func OnPageLoad(init func()) {
	Listen(Document(), "astro:page-load", func(js.Value) { init() })
}

//goesm:import "../motion.ts" play
func play(element js.Value, kind string)

// Play は #ui/motion.ts の控えめなアニメーション（"in"、"press"、"pop"）を element に付ける。
func Play(element js.Value, kind string) { play(element, kind) }

// Await は Promise の完了を待つ。reject されたらその理由をエラーにする。goroutine の中で呼ぶ。
func Await(promise js.Value) (js.Value, error) {
	done := make(chan js.Value, 1)
	failed := make(chan js.Value, 1)
	promise.Call("then",
		js.FuncOf(func(this js.Value, args []js.Value) any {
			done <- arg(args)
			return nil
		}),
		js.FuncOf(func(this js.Value, args []js.Value) any {
			failed <- arg(args)
			return nil
		}),
	)
	select {
	case v := <-done:
		return v, nil
	case reason := <-failed:
		return js.Undefined(), errors.New(js.Global().Call("String", reason).String())
	}
}

func arg(args []js.Value) js.Value {
	if len(args) == 0 {
		return js.Undefined()
	}
	return args[0]
}

// Try は f を実行し、JavaScript の例外（syscall/js の panic）が起きたら false を返す。
func Try(f func()) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()
	f()
	return true
}

// LocalGet は localStorage の値を読む。使えない環境（プライベートモードなど）やキーがなければ ok が false。
func LocalGet(key string) (value string, ok bool) {
	Try(func() {
		v := js.Global().Get("localStorage").Call("getItem", key)
		if v.Type() == js.TypeString {
			value, ok = v.String(), true
		}
	})
	return value, ok
}

// LocalSet は localStorage に保存する。保存できない環境では何もしない。
func LocalSet(key, value string) {
	Try(func() { js.Global().Get("localStorage").Call("setItem", key, value) })
}

// Tooltip はコピー結果などをボタンの上に短く出す。レイアウトを動かさないよう、tooltip 要素の文字だけを変える。
func Tooltip(tooltip js.Value) func(message string) {
	timer := js.Null()
	hide := js.FuncOf(func(this js.Value, args []js.Value) any {
		tooltip.Get("classList").Call("remove", "copy__tooltip--visible")
		return nil
	})
	return func(message string) {
		tooltip.Set("textContent", message)
		tooltip.Get("classList").Call("add", "copy__tooltip--visible")
		Play(tooltip, "in")
		js.Global().Call("clearTimeout", timer)
		timer = js.Global().Call("setTimeout", hide, 1500)
	}
}

// CopyText は text をクリップボードにコピーする。使えない環境では fallback（選択状態にするなど）を呼ぶ。
// done にはコピーできたかどうかが渡る。
func CopyText(text string, fallback func(), done func(copied bool)) {
	go func() {
		clipboard := js.Global().Get("navigator").Get("clipboard")
		copied := false
		if clipboard.Truthy() {
			var promise js.Value
			if Try(func() { promise = clipboard.Call("writeText", text) }) {
				_, err := Await(promise)
				copied = err == nil
			}
		}
		if !copied {
			fallback()
		}
		done(copied)
	}()
}
