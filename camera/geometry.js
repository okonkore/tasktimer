export function detectChekiCorners(imageData) {
  const { data, width, height } = imageData;
  if (!data || width < 12 || height < 12) return fallbackResult();

  const histogram = new Uint32Array(256);
  const luminance = new Uint8Array(width * height);
  const saturation = new Uint8Array(width * height);

  for (
    let index = 0, pixel = 0;
    pixel < luminance.length;
    pixel++, index += 4
  ) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const light = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    luminance[pixel] = light;
    saturation[pixel] = Math.max(red, green, blue) - Math.min(red, green, blue);
    histogram[light] += 1;
  }

  const brightPercentile = percentile(histogram, luminance.length, 0.82);
  const threshold = clamp(brightPercentile - 18, 150, 232);
  const initialMask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < initialMask.length; pixel++) {
    initialMask[pixel] =
      luminance[pixel] >= threshold && saturation[pixel] <= 72 ? 1 : 0;
  }

  const mask = dilate(initialMask, width, height);
  const visited = new Uint8Array(mask.length);
  const candidates = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const component = collectComponent(mask, visited, start, width);
    if (component.length < width * height * 0.008) continue;
    const candidate = componentToCandidate(component, width, height);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return fallbackResult();
  return {
    corners: best.corners.map(([x, y]) => ({
      x: clamp(x / Math.max(1, width - 1), 0, 1),
      y: clamp(y / Math.max(1, height - 1), 0, 1),
    })),
    confidence: best.confidence,
    method: "white-frame",
  };
}

export function defaultCorners(inset = 0.06) {
  const safeInset = clamp(inset, 0, 0.4);
  return [
    { x: safeInset, y: safeInset },
    { x: 1 - safeInset, y: safeInset },
    { x: 1 - safeInset, y: 1 - safeInset },
    { x: safeInset, y: 1 - safeInset },
  ];
}

export function orderCorners(points) {
  if (!Array.isArray(points) || points.length !== 4) return defaultCorners();
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const ordered = points.map((point) => ({
    x: clamp(Number(point.x) || 0, 0, 1),
    y: clamp(Number(point.y) || 0, 0, 1),
  })).sort((a, b) =>
    Math.atan2(a.y - center.y, a.x - center.x) -
    Math.atan2(b.y - center.y, b.x - center.x)
  );
  const start = ordered.reduce(
    (best, point, index) =>
      point.x + point.y < ordered[best].x + ordered[best].y ? index : best,
    0,
  );
  return ordered.slice(start).concat(ordered.slice(0, start));
}

export function rotateCornersClockwise(points) {
  return orderCorners(
    orderCorners(points).map((point) => ({
      x: 1 - point.y,
      y: point.x,
    })),
  );
}

export function isUsableQuadrilateral(points) {
  const ordered = orderCorners(points);
  const area = Math.abs(
    polygonArea(ordered.map((point) => [point.x, point.y])),
  );
  if (area < 0.015) return false;
  let direction = 0;
  for (let index = 0; index < 4; index++) {
    const a = ordered[index];
    const b = ordered[(index + 1) % 4];
    const c = ordered[(index + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 0.0001) return false;
    const sign = Math.sign(cross);
    if (direction && sign !== direction) return false;
    direction = sign;
  }
  return true;
}

export function getChekiMiniOutputSize(
  estimatedWidth,
  estimatedHeight,
  maximum = 1600,
) {
  const width = Math.max(1, Number(estimatedWidth) || 1);
  const height = Math.max(1, Number(estimatedHeight) || 1);
  const landscape = width > height;
  const maximumLongEdge = Math.max(86, Math.floor(Number(maximum) || 1600));
  const sourceLongEdge = Math.max(86, width, height);
  const units = Math.max(
    1,
    Math.floor(Math.min(maximumLongEdge, sourceLongEdge) / 86),
  );
  const shortEdge = 54 * units;
  const longEdge = 86 * units;
  return landscape
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
}

export function createProjectiveMap(points, width, height) {
  const corners = orderCorners(points).map((point) => ({
    x: point.x * width,
    y: point.y * height,
  }));
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const deltaX1 = topRight.x - bottomRight.x;
  const deltaX2 = bottomLeft.x - bottomRight.x;
  const deltaX3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const deltaY1 = topRight.y - bottomRight.y;
  const deltaY2 = bottomLeft.y - bottomRight.y;
  const deltaY3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = deltaX1 * deltaY2 - deltaX2 * deltaY1;
  let projectiveX = 0;
  let projectiveY = 0;
  if (Math.abs(denominator) > 0.000001) {
    projectiveX = (deltaX3 * deltaY2 - deltaX2 * deltaY3) / denominator;
    projectiveY = (deltaX1 * deltaY3 - deltaX3 * deltaY1) / denominator;
  }
  return {
    a: topRight.x - topLeft.x + projectiveX * topRight.x,
    b: bottomLeft.x - topLeft.x + projectiveY * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + projectiveX * topRight.y,
    e: bottomLeft.y - topLeft.y + projectiveY * bottomLeft.y,
    f: topLeft.y,
    g: projectiveX,
    h: projectiveY,
    corners,
  };
}

function fallbackResult() {
  return { corners: defaultCorners(), confidence: 0, method: "fallback" };
}

function percentile(histogram, total, ratio) {
  const target = total * ratio;
  let count = 0;
  for (let value = 0; value < histogram.length; value++) {
    count += histogram[value];
    if (count >= target) return value;
  }
  return 255;
}

function dilate(mask, width, height) {
  const result = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (
        mask[index] || mask[index - 1] || mask[index + 1] ||
        mask[index - width] || mask[index + width]
      ) result[index] = 1;
    }
  }
  return result;
}

function collectComponent(mask, visited, start, width) {
  const component = [];
  const queue = [start];
  visited[start] = 1;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor];
    component.push(index);
    const x = index % width;
    const neighbors = [index - width, index + width];
    if (x > 0) neighbors.push(index - 1);
    if (x < width - 1) neighbors.push(index + 1);
    for (const neighbor of neighbors) {
      if (
        neighbor < 0 || neighbor >= mask.length || visited[neighbor] ||
        !mask[neighbor]
      ) continue;
      visited[neighbor] = 1;
      queue.push(neighbor);
    }
  }
  return component;
}

function componentToCandidate(component, width, height) {
  let minSum = Infinity;
  let maxSum = -Infinity;
  let minDifference = Infinity;
  let maxDifference = -Infinity;
  for (const index of component) {
    const x = index % width;
    const y = Math.floor(index / width);
    minSum = Math.min(minSum, x + y);
    maxSum = Math.max(maxSum, x + y);
    minDifference = Math.min(minDifference, x - y);
    maxDifference = Math.max(maxDifference, x - y);
  }

  const margin = Math.max(width, height) * 0.022;
  const buckets = [[], [], [], []];
  for (const index of component) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x + y <= minSum + margin) buckets[0].push([x, y]);
    if (x - y >= maxDifference - margin) buckets[1].push([x, y]);
    if (x + y >= maxSum - margin) buckets[2].push([x, y]);
    if (x - y <= minDifference + margin) buckets[3].push([x, y]);
  }
  if (buckets.some((bucket) => !bucket.length)) return null;
  const corners = buckets.map(averagePoint);
  const area = Math.abs(polygonArea(corners));
  const totalArea = width * height;
  const areaRatio = area / totalArea;
  if (areaRatio < 0.035 || areaRatio > 0.96) return null;

  const sideLengths = corners.map((corner, index) =>
    distance(corner, corners[(index + 1) % 4])
  );
  if (Math.min(...sideLengths) < Math.min(width, height) * 0.08) return null;
  const fillRatio = Math.min(1, component.length / Math.max(1, area));
  const oppositeBalance = Math.min(
    sideLengths[0] / sideLengths[2],
    sideLengths[2] / sideLengths[0],
    sideLengths[1] / sideLengths[3],
    sideLengths[3] / sideLengths[1],
  );
  const confidence = clamp(
    0.25 + areaRatio * 0.55 + fillRatio * 0.18 + oppositeBalance * 0.17,
    0.25,
    0.97,
  );
  return {
    corners,
    confidence,
    score: area * (0.55 + fillRatio * 0.25 + oppositeBalance * 0.2),
  };
}

function averagePoint(points) {
  const total = points.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0],
  );
  return [total[0] / points.length, total[1] / points.length];
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
