// Package snap は、動かしているレイヤーの端と中心を、キャンバスや他のレイヤーの端・中心にそろえる。
package snap

import "math"

// Box は枠。
type Box struct{ X, Y, Width, Height float64 }

// Lines は縦の線（Xs）と横の線（Ys）の位置。スナップの対象とガイドに使う。
type Lines struct{ Xs, Ys []float64 }

// Targets はキャンバスの端・中心と、boxes の端・中心。
func Targets(width, height float64, boxes []Box) Lines {
	xs := []float64{0, width / 2, width}
	ys := []float64{0, height / 2, height}
	for _, box := range boxes {
		xs = append(xs, box.X, box.X+box.Width/2, box.X+box.Width)
		ys = append(ys, box.Y, box.Y+box.Height/2, box.Y+box.Height)
	}
	return Lines{xs, ys}
}

// nearest は candidates のどれかを lines のどれかに合わせるときの、最小の移動量（threshold 以内のみ）。
func nearest(candidates, lines []float64, threshold float64) (delta, line float64, ok bool) {
	for _, candidate := range candidates {
		for _, l := range lines {
			d := l - candidate
			if math.Abs(d) > threshold {
				continue
			}
			if !ok || math.Abs(d) < math.Abs(delta) {
				delta, line, ok = d, l, true
			}
		}
	}
	return
}

// matched は合わせたあとの位置で、ぴったり重なっている線をすべて返す（重複なし）。
func matched(candidates, lines []float64) []float64 {
	var out []float64
	seen := map[float64]bool{}
	for _, l := range lines {
		if seen[l] {
			continue
		}
		for _, candidate := range candidates {
			if math.Abs(candidate-l) < 0.5 {
				seen[l] = true
				out = append(out, l)
				break
			}
		}
	}
	return out
}

// Move は移動：左端・中心・右端（上端・中心・下端）のどれかを threshold 以内の線に合わせる。
// 合わせたあとの位置と、ぴったり重なっている線（ガイド）を返す。
func Move(box Box, lines Lines, threshold float64) (x, y float64, guides Lines) {
	dx, _, okX := nearest([]float64{box.X, box.X + box.Width/2, box.X + box.Width}, lines.Xs, threshold)
	dy, _, okY := nearest([]float64{box.Y, box.Y + box.Height/2, box.Y + box.Height}, lines.Ys, threshold)
	x = box.X + dx
	y = box.Y + dy
	if okX {
		guides.Xs = matched([]float64{x, x + box.Width/2, x + box.Width}, lines.Xs)
	}
	if okY {
		guides.Ys = matched([]float64{y, y + box.Height/2, y + box.Height}, lines.Ys)
	}
	return
}

// Edge は 1 本の辺（リサイズで動かしている辺）を threshold 以内の線に合わせる。無ければ ok が false。
func Edge(value float64, lines []float64, threshold float64) (line float64, ok bool) {
	_, line, ok = nearest([]float64{value}, lines, threshold)
	return
}
