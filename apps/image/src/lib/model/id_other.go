//go:build !js

package model

var idCounter int

// NewID は重ならない id を作る（ブラウザ以外の go test では連番）。
func NewID() string {
	idCounter++
	return "id-" + itoa(idCounter)
}
