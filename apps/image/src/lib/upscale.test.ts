// 拡大保存の計算の検査（mise run unit）。
// PNG は画素をそのまま保存するので、ここで確かめた画素がそのままファイルになる。
import * as assert from "node:assert/strict";
import * as test from "node:test";
import * as upscale from "./upscale.ts";

/** 画素ごとに違う色（半透明・透明も混ぜる）の画像 */
const sample = (width: number, height: number) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 37 + 11) % 256;
    data[i * 4 + 1] = (i * 91 + 5) % 256;
    data[i * 4 + 2] = (i * 53 + 199) % 256;
    data[i * 4 + 3] = i % 5 === 0 ? 0 : i % 3 === 0 ? 128 : 255;
  }
  return data;
};

const pixel = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)].join(",");

test.describe("ニアレストネイバー", () => {
  for (const factor of [2, 3, 4, 8, 16])
    test.test(
      `${factor} 倍：元の 1 画素が ${factor} × ${factor} の正方形になる`,
      () => {
        const [width, height] = [7, 5];
        const source = sample(width, height);
        const size = upscale.size(width, height, factor);
        assert.deepEqual(size, {
          width: width * factor,
          height: height * factor,
        });
        const result = upscale.pixels(
          source,
          width,
          height,
          size.width,
          size.height,
          "nearest",
        );
        assert.equal(result.length, size.width * size.height * 4);
        for (let y = 0; y < size.height; y++)
          for (let x = 0; x < size.width; x++)
            assert.equal(
              pixel(result, size.width, x, y),
              pixel(
                source,
                width,
                Math.floor(x / factor),
                Math.floor(y / factor),
              ),
              `(${x}, ${y})`,
            );
      },
    );

  for (const factor of [1.5, 2.5, 3.3])
    test.test(`${factor} 倍：元にある色だけを使い、すべての画素が残る`, () => {
      const [width, height] = [9, 6];
      const source = sample(width, height);
      const size = upscale.size(width, height, factor);
      const result = upscale.pixels(
        source,
        width,
        height,
        size.width,
        size.height,
        "nearest",
      );
      const colors = new Set<string>();
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) colors.add(pixel(source, width, x, y));
      const used = new Set<string>();
      for (let y = 0; y < size.height; y++)
        for (let x = 0; x < size.width; x++) {
          const color = pixel(result, size.width, x, y);
          assert.ok(colors.has(color), `(${x}, ${y}) に元に無い色 ${color}`);
          used.add(color);
        }
      assert.equal(used.size, colors.size);
    });

  test.test("市松模様の境目がぼけない", () => {
    const source = new Uint8ClampedArray(2 * 2 * 4);
    for (const [i, value] of [0, 255, 255, 0].entries())
      source.set([value, value, value, 255], i * 4);
    const result = upscale.pixels(source, 2, 2, 16, 16, "nearest");
    for (let i = 0; i < 16 * 16; i++)
      assert.ok(result[i * 4] === 0 || result[i * 4] === 255);
  });
});

for (const method of ["bilinear", "bicubic"] as const)
  test.describe(method, () => {
    test.test("単色の画像は同じ色のまま", () => {
      const source = new Uint8ClampedArray(4 * 3 * 4);
      for (let i = 0; i < 12; i++) source.set([200, 100, 50, 255], i * 4);
      const result = upscale.pixels(source, 4, 3, 12, 9, method);
      for (let i = 0; i < 12 * 9; i++)
        assert.equal(
          pixel(result, 12, i % 12, Math.floor(i / 12)),
          "200,100,50,255",
        );
    });

    test.test("透明な画素の色がにじまない", () => {
      // 左が不透明の赤、右が透明の緑。境目に緑が混ざってはいけない
      const source = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 0]);
      const result = upscale.pixels(source, 2, 1, 8, 1, method);
      for (let x = 0; x < 8; x++) {
        const [r, g, , a] = result.subarray(x * 4, x * 4 + 4);
        if (a) assert.deepEqual([r, g], [255, 0], `x = ${x}`);
      }
      assert.equal(result[3], 255);
      assert.equal(result[7 * 4 + 3], 0);
    });

    test.test("白黒の境目は中間の色でつながる", () => {
      const source = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
      const result = upscale.pixels(source, 2, 1, 8, 1, method);
      const values = [...Array(8).keys()].map((x) => result[x * 4]!);
      assert.equal(values[0], 0);
      assert.equal(values[7], 255);
      assert.ok(values.some((value) => value > 0 && value < 255));
      for (let x = 1; x < 8; x++) assert.ok(values[x]! >= values[x - 1]!);
    });
  });

test.test("等倍は元の画素と同じ", () => {
  const source = sample(4, 4);
  for (const [method] of upscale.methods)
    assert.deepEqual(upscale.pixels(source, 4, 4, 4, 4, method), source);
});

test.test("画素の数が大きさと合わないときはエラーにする", () => {
  assert.throws(() =>
    upscale.pixels(new Uint8ClampedArray(8), 4, 4, 8, 8, "nearest"),
  );
});
