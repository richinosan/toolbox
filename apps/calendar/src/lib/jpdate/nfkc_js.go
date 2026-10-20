//go:build js

package jpdate

import "syscall/js"

// nfkc は全角の英数字・記号を半角にする（NFKC 正規化）。Go の標準ライブラリには NFKC がないので、
// ブラウザの String.prototype.normalize を使う。
func nfkc(s string) string {
	return js.Global().Get("String").New(s).Call("normalize", "NFKC").String()
}
