//go:build !js

package jpdate

import "golang.org/x/text/unicode/norm"

// nfkc は全角の英数字・記号を半角にする（NFKC 正規化）。ブラウザ以外（go test）では x/text を使う。
func nfkc(s string) string {
	return norm.NFKC.String(s)
}
