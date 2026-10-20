package model

import "testing"

func TestAppendNumber(t *testing.T) {
	cases := map[float64]string{0: "0", -1.5: "-1.5", 1e-7: "1e-7", 1.5e-7: "1.5e-7", 1e21: "1e+21", 2.5e300: "2.5e+300", 123: "123", 0.1: "0.1"}
	for n, want := range cases {
		if got := string(AppendNumber(nil, n)); got != want {
			t.Errorf("AppendNumber(%v) = %s, want %s", n, got, want)
		}
	}
	negZero := 0.0
	negZero = -negZero
	if got := string(AppendNumber(nil, negZero)); got != "0" {
		t.Errorf("-0 = %s", got)
	}
	if got := string(AppendString(nil, "a\b\f\x01\"")); got != `"a\b\f\u0001\""` {
		t.Errorf("AppendString = %s", got)
	}
}
