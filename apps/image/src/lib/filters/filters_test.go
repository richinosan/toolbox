package filters

import (
	"testing"

	"toolbox.richinosan.com/apps/image/src/lib/model"
)

func TestColorMatrixIdentity(t *testing.T) {
	if m := ColorMatrix(model.DefaultFilters); m != identity {
		t.Fatalf("フィルターなしは単位行列: %v", m)
	}
	data := []byte{10, 20, 30, 255}
	ApplyColor(data, identity)
	if data[0] != 10 || data[1] != 20 || data[2] != 30 {
		t.Fatalf("単位行列では変わらない: %v", data)
	}
}

func TestApplyColor(t *testing.T) {
	invert := ColorMatrix(model.Filters{Preset: "invert"})
	data := []byte{0, 100, 255, 255, 50, 50, 50, 0}
	ApplyColor(data, invert)
	want := []byte{255, 155, 0, 255, 50, 50, 50, 0} // 透明なピクセルはそのまま
	for i := range want {
		if data[i] != want[i] {
			t.Fatalf("反転: %v != %v", data, want)
		}
	}
	// 結果は 0〜255 に収まる
	bright := ColorMatrix(model.Filters{Preset: "none", Brightness: 100})
	data = []byte{200, 10, 0, 255}
	ApplyColor(data, bright)
	if data[0] != 255 || data[1] != 20 || data[2] != 0 {
		t.Fatalf("明るさ: %v", data)
	}
}

func TestClampRoundsHalfToEven(t *testing.T) {
	for _, c := range []struct {
		in   float64
		want byte
	}{{0.5, 0}, {1.5, 2}, {2.5, 2}, {254.5, 254}, {-3, 0}, {300, 255}} {
		if got := clamp(c.in); got != c.want {
			t.Errorf("clamp(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestBlur(t *testing.T) {
	// 真ん中だけ不透明な白。ぼかすと周りに広がり、透明だった部分の色は白のまま（黒ずまない）
	const w, h = 7, 7
	data := make([]byte, w*h*4)
	center := (3*w + 3) * 4
	copy(data[center:], []byte{255, 255, 255, 255})
	ApplyBlur(data, w, h, 1)
	if data[center+3] == 255 || data[center+3] == 0 {
		t.Fatalf("中心のアルファが広がっていない: %v", data[center+3])
	}
	edge := (3*w + 2) * 4
	if data[edge+3] == 0 || data[edge] != 255 {
		t.Fatalf("隣のピクセル: %v", data[edge:edge+4])
	}
	if BlurPadding(0) != 0 || BlurPadding(1.2) != 4 {
		t.Fatal("BlurPadding")
	}
}

func TestBoxRadii(t *testing.T) {
	// TypeScript 版と同じ値
	for sigma, want := range map[float64][3]int{1: {0, 0, 1}, 2.25: {1, 2, 2}, 10: {9, 9, 10}} {
		if r := boxRadii(sigma); r != want {
			t.Errorf("sigma %v: %v, want %v", sigma, r, want)
		}
	}
}
