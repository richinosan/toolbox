//go:build js

package model

import "syscall/js"

var idCounter int

// NewID は重ならない id を作る（crypto.randomUUID が使えなければ時刻と連番から作る）。
func NewID() string {
	crypto := js.Global().Get("crypto")
	if crypto.Truthy() && crypto.Get("randomUUID").Type() == js.TypeFunction {
		return crypto.Call("randomUUID").String()
	}
	idCounter++
	now := js.Global().Get("Number").New(js.Global().Get("Date").Call("now"))
	return now.Call("toString", 36).String() + "-" + itoa(idCounter)
}
