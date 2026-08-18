import {
  createProjectiveMap,
  detectChekiCorners,
  getChekiMiniOutputSize,
  isUsableQuadrilateral,
  orderCorners,
  rotateCornersClockwise,
} from "./geometry.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("cheki detector finds a bright quadrilateral frame", () => {
  const width = 120;
  const height = 160;
  const outer = [[20, 15], [101, 24], [95, 146], [24, 138]];
  const inner = [[31, 34], [89, 40], [85, 119], [35, 114]];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isFrame = insidePolygon(x, y, outer) && !insidePolygon(x, y, inner);
      const value = isFrame ? 244 : 48;
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }

  const result = detectChekiCorners({ data, width, height });
  assert(result.method === "white-frame", "the white frame should be detected");
  assert(
    result.confidence > 0.45,
    "the synthetic frame should have useful confidence",
  );
  const expected = outer.map(([x, y]) => ({ x: x / width, y: y / height }));
  result.corners.forEach((corner, index) => {
    const error = Math.hypot(
      corner.x - expected[index].x,
      corner.y - expected[index].y,
    );
    assert(error < 0.09, `corner ${index} should be near the frame`);
  });
});

Deno.test("corner ordering and validation reject crossed selections", () => {
  const ordered = orderCorners([
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.1 },
    { x: 0.1, y: 0.9 },
    { x: 0.9, y: 0.1 },
  ]);
  assert(ordered[0].x < 0.2 && ordered[0].y < 0.2, "top-left should be first");
  assert(
    isUsableQuadrilateral(ordered),
    "the ordered rectangle should be usable",
  );
  assert(
    !isUsableQuadrilateral([
      { x: 0.1, y: 0.1 },
      { x: 0.11, y: 0.1 },
      { x: 0.11, y: 0.11 },
      { x: 0.1, y: 0.11 },
    ]),
    "a tiny selection should be rejected",
  );
});

Deno.test("projective map preserves all four selected corners", () => {
  const corners = [
    { x: 0.1, y: 0.15 },
    { x: 0.88, y: 0.08 },
    { x: 0.92, y: 0.9 },
    { x: 0.06, y: 0.84 },
  ];
  const map = createProjectiveMap(corners, 1000, 800);
  const samples = [[0, 0], [1, 0], [1, 1], [0, 1]];
  samples.forEach(([u, v], index) => {
    const denominator = map.g * u + map.h * v + 1;
    const x = (map.a * u + map.b * v + map.c) / denominator;
    const y = (map.d * u + map.e * v + map.f) / denominator;
    assert(
      Math.hypot(x - map.corners[index].x, y - map.corners[index].y) < 0.001,
      "mapped corner should match",
    );
  });
});

Deno.test("cheki mini output keeps the physical 54 by 86 aspect ratio", () => {
  const portrait = getChekiMiniOutputSize(723, 1189);
  assert(
    portrait.width / portrait.height === 54 / 86,
    "portrait ratio should be 54:86",
  );
  assert(
    portrait.height <= 1600,
    "portrait output should respect the size limit",
  );

  const landscape = getChekiMiniOutputSize(1189, 723);
  assert(
    landscape.width / landscape.height === 86 / 54,
    "landscape ratio should be 86:54",
  );
  assert(
    landscape.width <= 1600,
    "landscape output should respect the size limit",
  );

  const limited = getChekiMiniOutputSize(3000, 5000, 800);
  assert(
    limited.width / limited.height === 54 / 86,
    "limited output should keep its ratio",
  );
  assert(limited.height <= 800, "custom size limit should be respected");
});

Deno.test("clockwise rotation keeps corners aligned with the rotated image", () => {
  const original = [
    { x: 0.1, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ];
  const rotated = rotateCornersClockwise(original);
  const expected = [
    { x: 0.1, y: 0.1 },
    { x: 0.8, y: 0.1 },
    { x: 0.8, y: 0.8 },
    { x: 0.1, y: 0.8 },
  ];
  rotated.forEach((corner, index) => {
    assert(
      Math.hypot(corner.x - expected[index].x, corner.y - expected[index].y) <
        0.0001,
      `rotated corner ${index} should follow the image`,
    );
  });
});

function insidePolygon(x: number, y: number, polygon: number[][]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[previous];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) {
      inside = !inside;
    }
  }
  return inside;
}
