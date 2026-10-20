//go:build js

package web

import "syscall/js"

// RegExp は JavaScript の RegExp。Go の regexp は変換後のスクリプトを大きくする（regexp/syntax と unicode の表が入る）ので、
// ブラウザで動く処理ではこちらを使う。
type RegExp struct {
	re js.Value
	// all は同じパターンに g を付けたもの（すべての一致を探す・置き換える）。
	all js.Value
}

var stringPrototype = js.Global().Get("String").Get("prototype")

// NewRegExp は pattern（JavaScript の書き方）と flags（"i" など。g は付けない）から RegExp を作る。
func NewRegExp(pattern, flags string) RegExp {
	ctor := js.Global().Get("RegExp")
	return RegExp{re: ctor.New(pattern, flags), all: ctor.New(pattern, flags+"g")}
}

// Test は s に一致する部分があるか。
func (r RegExp) Test(s string) bool { return r.re.Call("test", s).Bool() }

// Find は最初の一致と、括弧で囲んだ部分（一致しなかった括弧は ""）。一致しなければ nil。
func (r RegExp) Find(s string) []string {
	m := r.re.Call("exec", s)
	if m.IsNull() {
		return nil
	}
	out := make([]string, m.Length())
	for i := range out {
		if v := m.Index(i); v.Type() == js.TypeString {
			out[i] = v.String()
		}
	}
	return out
}

// FindString は最初の一致。一致しなければ ""。
func (r RegExp) FindString(s string) string {
	if m := r.Find(s); m != nil {
		return m[0]
	}
	return ""
}

// FindAllString はすべての一致。
func (r RegExp) FindAllString(s string) []string {
	m := stringPrototype.Get("match").Call("call", s, r.all)
	if m.IsNull() {
		return nil
	}
	out := make([]string, m.Length())
	for i := range out {
		out[i] = m.Index(i).String()
	}
	return out
}

// ReplaceAllFunc はすべての一致を f の結果に置き換える。
func (r RegExp) ReplaceAllFunc(s string, f func(match string) string) string {
	replace := js.FuncOf(func(this js.Value, args []js.Value) any { return f(args[0].String()) })
	defer replace.Release()
	return stringPrototype.Get("replace").Call("call", s, r.all, replace).String()
}

// ReplaceAllString はすべての一致を repl（$ などの特別な書き方は使わず、そのままの文字）に置き換える。
func (r RegExp) ReplaceAllString(s, repl string) string {
	return r.ReplaceAllFunc(s, func(string) string { return repl })
}
