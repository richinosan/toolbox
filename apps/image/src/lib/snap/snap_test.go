package snap

import (
	"reflect"
	"testing"
)

func TestMove(t *testing.T) {
	lines := Targets(100, 80, []Box{{X: 10, Y: 10, Width: 20, Height: 20}})
	// 左端 31 は他のレイヤーの右端 30 に、上端 41 はキャンバスの中心 40 に寄る
	x, y, guides := Move(Box{X: 31, Y: 41, Width: 10, Height: 10}, lines, 2)
	if x != 30 || y != 40 {
		t.Fatalf("位置: %v %v", x, y)
	}
	if !reflect.DeepEqual(guides.Xs, []float64{30}) || !reflect.DeepEqual(guides.Ys, []float64{40}) {
		t.Fatalf("ガイド: %+v", guides)
	}
	// 遠ければ動かさない
	x, y, guides = Move(Box{X: 60, Y: 60, Width: 7, Height: 7}, lines, 2)
	if x != 60 || y != 60 || guides.Xs != nil || guides.Ys != nil {
		t.Fatalf("動かない: %v %v %+v", x, y, guides)
	}
}

func TestEdge(t *testing.T) {
	if line, ok := Edge(49, []float64{0, 50, 100}, 2); !ok || line != 50 {
		t.Fatalf("%v %v", line, ok)
	}
	if _, ok := Edge(45, []float64{0, 50, 100}, 2); ok {
		t.Fatal("遠い線には合わせない")
	}
}
