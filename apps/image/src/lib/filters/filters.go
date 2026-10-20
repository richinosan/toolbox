// Package filters はレイヤーに掛けるフィルター（色の調整とガウスぼかし）。
// ブラウザごとの canvas の filter の対応差を避けるため、ピクセルを直接計算する。
//
// 計算は TypeScript 版（Uint8ClampedArray への代入）と 1 バイトも違わないようにしている。
// 積は float64() で包み、積和が 1 回の丸め（FMA）にまとめられないようにする。
package filters

import (
	"math"

	"toolbox.richinosan.com/apps/image/src/lib/model"
)

// Matrix は RGB の 3×4 アフィン行列（値は 0〜1 で考える）。[r行(4), g行(4), b行(4)]
type Matrix [12]float64

var identity = Matrix{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0}

// then は a のあとに b を適用する行列。
func then(a, b Matrix) Matrix {
	var out Matrix
	for row := 0; row < 3; row++ {
		for col := 0; col < 4; col++ {
			value := 0.0
			if col == 3 {
				value = b[row*4+3]
			}
			for k := 0; k < 3; k++ {
				value += float64(b[row*4+k] * a[k*4+col])
			}
			out[row*4+col] = value
		}
	}
	return out
}

func scale(r, g, b, offset float64) Matrix {
	return Matrix{r, 0, 0, offset, 0, g, 0, offset, 0, 0, b, offset}
}

// 以下の係数は CSS の Filter Effects（grayscale / sepia / saturate / hue-rotate）と同じ
var luma = [3]float64{0.2126, 0.7152, 0.0722}

var grayscale = Matrix{luma[0], luma[1], luma[2], 0, luma[0], luma[1], luma[2], 0, luma[0], luma[1], luma[2], 0}

var sepia = Matrix{0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0}

func saturate(s float64) Matrix {
	return Matrix{
		0.213 + float64(0.787*s), 0.715 - float64(0.715*s), 0.072 - float64(0.072*s), 0,
		0.213 - float64(0.213*s), 0.715 + float64(0.285*s), 0.072 - float64(0.072*s), 0,
		0.213 - float64(0.213*s), 0.715 - float64(0.715*s), 0.072 + float64(0.928*s), 0,
	}
}

func hueRotate(degrees float64) Matrix {
	angle := float64(degrees*math.Pi) / 180
	cos := math.Cos(angle)
	sin := math.Sin(angle)
	return Matrix{
		0.213 + float64(cos*0.787) - float64(sin*0.213),
		0.715 - float64(cos*0.715) - float64(sin*0.715),
		0.072 - float64(cos*0.072) + float64(sin*0.928),
		0,
		0.213 - float64(cos*0.213) + float64(sin*0.143),
		0.715 + float64(cos*0.285) + float64(sin*0.14),
		0.072 - float64(cos*0.072) - float64(sin*0.283),
		0,
		0.213 - float64(cos*0.213) - float64(sin*0.787),
		0.715 - float64(cos*0.715) + float64(sin*0.715),
		0.072 + float64(cos*0.928) + float64(sin*0.072),
		0,
	}
}

func contrast(c float64) Matrix { return scale(c, c, c, 0.5-float64(0.5*c)) }

// hexToRgb は Number.parseInt(hex.slice(1), 16) と同じく、先頭から読める 16 進の数字だけを読む。
func hexToRgb(hex string) (r, g, b float64) {
	var value uint32
	for i := 1; i < len(hex); i++ {
		c := hex[i]
		var d byte
		switch {
		case '0' <= c && c <= '9':
			d = c - '0'
		case 'a' <= c && c <= 'f':
			d = c - 'a' + 10
		case 'A' <= c && c <= 'F':
			d = c - 'A' + 10
		default:
			i = len(hex)
			continue
		}
		value = value<<4 | uint32(d)
	}
	return float64(value>>16&255) / 255, float64(value>>8&255) / 255, float64(value&255) / 255
}

// tint は明るさを保ったまま、指定した色味に寄せる（amount は 0〜1）。
func tint(hex string, amount float64) Matrix {
	r, g, b := hexToRgb(hex)
	l := float64(luma[0]*r) + float64(luma[1]*g) + float64(luma[2]*b)
	// 色の明るさで割って、元の明るさが変わらないようにする（黒に近い色は割らずにそのまま暗くする）
	k := 1.0
	if l > 0.05 {
		k = math.Min(4, 1/l)
	}
	color := [3]float64{r * k, g * k, b * k}
	var out Matrix
	for row := 0; row < 3; row++ {
		for col := 0; col < 4; col++ {
			keep := 0.0
			if row == col {
				keep = 1 - amount
			}
			add := 0.0
			if col < 3 {
				add = float64(float64(amount*color[row]) * luma[col])
			}
			out[row*4+col] = keep + add
		}
	}
	return out
}

func presetMatrix(preset model.FilterPreset) Matrix {
	switch preset {
	case "mono":
		return grayscale
	case "sepia":
		return sepia
	case "invert":
		return scale(-1, -1, -1, 1)
	case "vivid":
		return then(saturate(1.5), contrast(1.1))
	case "warm":
		return then(scale(1.1, 1.02, 0.86, 0), saturate(1.1))
	case "cool":
		return then(scale(0.88, 1, 1.12, 0), saturate(0.95))
	case "fade":
		return then(then(saturate(0.7), contrast(0.8)), scale(1.05, 1.05, 1.05, 0))
	}
	return identity
}

// ColorMatrix はフィルターの色の調整をまとめた行列。
func ColorMatrix(f model.Filters) Matrix {
	m := presetMatrix(f.Preset)
	if f.Brightness != 0 {
		b := 1 + f.Brightness/100
		m = then(m, scale(b, b, b, 0))
	}
	if f.Contrast != 0 {
		m = then(m, contrast(1+f.Contrast/100))
	}
	if f.Saturation != 0 {
		m = then(m, saturate(1+f.Saturation/100))
	}
	if f.Hue != 0 {
		m = then(m, hueRotate(f.Hue))
	}
	if f.TintAmount != 0 {
		m = then(m, tint(f.Tint, f.TintAmount/100))
	}
	return m
}

// clamp は Uint8ClampedArray への代入と同じ変換（0〜255 に収めて偶数丸め、NaN は 0）。
func clamp(v float64) byte {
	switch {
	case !(v > 0):
		return 0
	case v >= 255:
		return 255
	}
	return byte(math.RoundToEven(v))
}

// ApplyColor は ImageData のデータ（RGBA、ストレートアルファ）に色の行列を掛ける。
// 値は Uint8ClampedArray と同じく 0〜255 に収めて偶数丸めする。
func ApplyColor(data []byte, m Matrix) {
	if m == identity {
		return
	}
	r0, r1, r2, r3 := m[0], m[1], m[2], float64(m[3]*255)
	g0, g1, g2, g3 := m[4], m[5], m[6], float64(m[7]*255)
	b0, b1, b2, b3 := m[8], m[9], m[10], float64(m[11]*255)
	for i := 0; i+3 < len(data); i += 4 {
		if data[i+3] == 0 {
			continue
		}
		r := float64(data[i])
		g := float64(data[i+1])
		b := float64(data[i+2])
		data[i] = clamp(float64(r0*r) + float64(r1*g) + float64(r2*b) + r3)
		data[i+1] = clamp(float64(g0*r) + float64(g1*g) + float64(g2*b) + g3)
		data[i+2] = clamp(float64(b0*r) + float64(b1*g) + float64(b2*b) + b3)
	}
}

// jsRound は JavaScript の Math.round（.5 は +∞ 側へ）。
func jsRound(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}

// boxRadii はガウスぼかしを 3 回の箱ぼかしで近似するときの、各回の半径。
func boxRadii(sigma float64) [3]int {
	const n = 3
	ideal := math.Sqrt(float64(12*sigma*sigma)/n + 1)
	lower := math.Floor(ideal)
	if math.Mod(lower, 2) == 0 {
		lower--
	}
	upper := lower + 2
	m := jsRound((float64(12*sigma*sigma) - float64(n*lower*lower) - float64(4*n*lower) - 3*n) / (-4*lower - 4))
	var radii [3]int
	for i := range radii {
		size := upper
		if float64(i) < m {
			size = lower
		}
		radii[i] = int(math.Max(0, (size-1)/2))
	}
	return radii
}

// boxPass は 1 方向の箱ぼかし。端は端のピクセルを延長して扱う。
func boxPass(src, dst []byte, length, lines, step, lineStep, radius int) {
	size := float64(radius*2 + 1)
	last := length - 1
	for line := 0; line < lines; line++ {
		start := line * lineStep
		var r, g, b, a int
		for i := -radius; i <= radius; i++ {
			p := start + min(last, max(0, i))*step
			r += int(src[p])
			g += int(src[p+1])
			b += int(src[p+2])
			a += int(src[p+3])
		}
		for i := 0; i < length; i++ {
			p := start + i*step
			dst[p] = clamp(float64(r) / size)
			dst[p+1] = clamp(float64(g) / size)
			dst[p+2] = clamp(float64(b) / size)
			dst[p+3] = clamp(float64(a) / size)
			add := start + min(last, i+radius+1)*step
			remove := start + max(0, i-radius)*step
			r += int(src[add]) - int(src[remove])
			g += int(src[add+1]) - int(src[remove+1])
			b += int(src[add+2]) - int(src[remove+2])
			a += int(src[add+3]) - int(src[remove+3])
		}
	}
}

// ApplyBlur はガウスぼかし（sigma は px）。透明な部分の色が混ざって黒ずまないよう、乗算済みアルファで計算する。
func ApplyBlur(data []byte, width, height int, sigma float64) {
	if !(sigma > 0) || width == 0 || height == 0 {
		return
	}
	for i := 0; i+3 < len(data); i += 4 {
		a := float64(data[i+3]) / 255
		data[i] = clamp(float64(data[i]) * a)
		data[i+1] = clamp(float64(data[i+1]) * a)
		data[i+2] = clamp(float64(data[i+2]) * a)
	}
	temp := make([]byte, len(data))
	for _, radius := range boxRadii(sigma) {
		if radius == 0 {
			continue
		}
		boxPass(data, temp, width, height, 4, width*4, radius)
		boxPass(temp, data, height, width, width*4, 4, radius)
	}
	for i := 0; i+3 < len(data); i += 4 {
		a := data[i+3]
		if a == 0 {
			continue
		}
		k := 255 / float64(a)
		data[i] = clamp(float64(data[i]) * k)
		data[i+1] = clamp(float64(data[i+1]) * k)
		data[i+2] = clamp(float64(data[i+2]) * k)
	}
}

// BlurPadding はぼかしで外側に広がる幅（px）。
func BlurPadding(sigma float64) float64 {
	if sigma > 0 {
		return math.Ceil(sigma * 3)
	}
	return 0
}
