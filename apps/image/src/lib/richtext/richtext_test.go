package richtext

import (
	"testing"

	"toolbox.richinosan.com/apps/image/src/lib/model"
)

var (
	plain = model.CharStyle{Font: model.Builtin, Size: 24, Color: "#000000"}
	bold  = model.CharStyle{Font: model.Builtin, Size: 24, Color: "#000000", Bold: true}
)

func TestLenCountsUTF16(t *testing.T) {
	if n := Len("a😀\nあ"); n != 5 {
		t.Fatalf("Len = %d", n)
	}
}

func TestApplyStyle(t *testing.T) {
	runs := []model.TextRun{{Text: "ab😀cd", Style: plain}}
	// 😀 は 2 コード単位（2〜4）
	out := ApplyStyle(runs, 2, 4, func(s *model.CharStyle) { s.Bold = true })
	if len(out) != 3 || out[0].Text != "ab" || out[1].Text != "😀" || !out[1].Style.Bold || out[2].Text != "cd" {
		t.Fatalf("%+v", out)
	}
	// 戻すとまとまる
	back := ApplyStyle(out, 0, 6, func(s *model.CharStyle) { s.Bold = false })
	if len(back) != 1 || back[0].Text != "ab😀cd" {
		t.Fatalf("%+v", back)
	}
	if !StyleAt(out, 2).Bold || StyleAt(out, 4).Bold || !SameStyle(StyleAt(out, 99), out[2].Style) {
		t.Fatal("StyleAt")
	}
	if got := StylesIn(out, 1, 3); len(got) != 2 {
		t.Fatalf("StylesIn %v", got)
	}
}

func TestNormalize(t *testing.T) {
	out := Normalize([]model.TextRun{{Text: "", Style: bold}}, plain)
	if len(out) != 1 || out[0].Text != "" || !out[0].Style.Bold {
		t.Fatalf("%+v", out)
	}
	out = Normalize([]model.TextRun{{Text: "a", Style: plain}, {Text: "b", Style: plain}, {Text: "c", Style: bold}}, plain)
	if len(out) != 2 || out[0].Text != "ab" {
		t.Fatalf("%+v", out)
	}
}

func TestScaleAndUsage(t *testing.T) {
	runs := []model.TextRun{{Text: "a", Style: plain}, {Text: "b", Style: bold}, {Text: "c", Style: plain}}
	scaled := ScaleRuns(runs, 1.37)
	if scaled[0].Style.Size != 32.9 || runs[0].Style.Size != 24 {
		t.Fatalf("ScaleRuns %v", scaled[0].Style.Size)
	}
	if MaxSize(nil) != 1 || MaxSize(scaled) != 32.9 {
		t.Fatal("MaxSize")
	}
	usage := FontUsage(runs)
	if len(usage) != 2 || usage[0].Text != "ac" || usage[1].Text != "b" {
		t.Fatalf("%+v", usage)
	}
}

func TestOutlineKey(t *testing.T) {
	layer := &model.Layer{
		Runs:       []model.TextRun{{Text: "a\"\n\b😀", Style: plain}, {Text: "x", Style: bold}},
		Align:      "center",
		LineHeight: 120,
	}
	want := `[[["a\"\n\b😀","builtin:line-seed",24,"#000000",false],["x","builtin:line-seed",24,"#000000",true]],"center",120]`
	if got := OutlineKey(layer); got != want {
		t.Fatalf("\n%s\n%s", got, want)
	}
	layer.LineHeight = 1e-7
	layer.Runs = nil
	if got := OutlineKey(layer); got != `[[],"center",1e-7]` {
		t.Fatal(got)
	}
}

func TestScalePath(t *testing.T) {
	if got := ScalePath("M1.5 -2L.5,1e-3Z 1.2.3", 2); got != "M3 -4L1,0Z NaN" {
		t.Fatal(got)
	}
	if got := ScalePath("M-0.001 2.675", 1); got != "M0 2.68" {
		t.Fatal(got)
	}
	o := ScaleOutline(model.TextOutline{Key: "k", Width: 101, Height: 0.2, Parts: []model.Part{{D: "M1 1", Color: "red"}}}, 1.5)
	if o.Key != "" || o.Width != 152 || o.Height != 1 || o.Parts[0].D != "M1.5 1.5" || o.Parts[0].Color != "red" {
		t.Fatalf("%+v", o)
	}
}

func TestOverflow(t *testing.T) {
	if Overflow(2, true, 40) != 16 || Overflow(0, false, 24) != 3 {
		t.Fatal(Overflow(2, true, 40), Overflow(0, false, 24))
	}
}

func TestScalePathScanner(t *testing.T) {
	cases := map[string]string{
		"M1 2L-3.5 4e2Z":  "M2 4L-7 800Z",
		"M1-2":            "M2-4",
		"M.5e-1 x- 1e":    "M0.1 x- 2e",
		"M-.25,3.e1 -- 4": "M-0.5,60 -- 8",
	}
	for in, want := range cases {
		if got := ScalePath(in, 2); got != want {
			t.Errorf("ScalePath(%q) = %q, want %q", in, got, want)
		}
	}
}
