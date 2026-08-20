/**
 * Flat polygon helpers. Polygons are stored as [x0, y0, x1, y1, ...] with an
 * implicit closing edge from the last vertex back to the first.
 */

export type Polygon = number[];

export function polygonArea(poly: Polygon): number {
  let sum = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
  }
  return sum / 2;
}

export function polygonBounds(poly: Polygon): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    if (poly[i] < x0) x0 = poly[i];
    if (poly[i] > x1) x1 = poly[i];
    if (poly[i + 1] < y0) y0 = poly[i + 1];
    if (poly[i + 1] > y1) y1 = poly[i + 1];
  }
  return { x0, y0, x1, y1 };
}

export function pointInPolygon(poly: Polygon, px: number, py: number): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    const straddles = yi > py !== yj > py;
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Unsigned distance from a point to the polygon's boundary. */
export function distanceToEdges(poly: Polygon, px: number, py: number): number {
  let best = Infinity;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2];
    const ay = poly[j * 2 + 1];
    const bx = poly[i * 2];
    const by = poly[i * 2 + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + dx * t - px;
    const cy = ay + dy * t - py;
    const d2 = cx * cx + cy * cy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Positive inside the polygon, negative outside. */
export function signedDistance(poly: Polygon, px: number, py: number): number {
  const d = distanceToEdges(poly, px, py);
  return pointInPolygon(poly, px, py) ? d : -d;
}

/**
 * Ear-clipping triangulation. Returns a flat vertex list of triangles,
 * [x0,y0, x1,y1, x2,y2, ...]. Adequate for the simple, rectilinear basin
 * shapes this game uses; it is not robust against self-intersection.
 */
export function triangulate(poly: Polygon): Float32Array {
  const n = poly.length / 2;
  if (n < 3) return new Float32Array(0);

  // Work on a CCW copy so the ear test has a consistent sign.
  const idx: number[] = [];
  if (polygonArea(poly) < 0) for (let i = n - 1; i >= 0; i--) idx.push(i);
  else for (let i = 0; i < n; i++) idx.push(i);

  const out: number[] = [];
  const px = (i: number) => poly[i * 2];
  const py = (i: number) => poly[i * 2 + 1];

  let guard = 0;
  while (idx.length > 3 && guard++ < n * n + 64) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];

      const cross = (px(b) - px(a)) * (py(c) - py(a)) - (py(b) - py(a)) * (px(c) - px(a));
      if (cross <= 0) continue; // reflex or degenerate

      let containsOther = false;
      for (let k = 0; k < idx.length; k++) {
        const p = idx[k];
        if (p === a || p === b || p === c) continue;
        if (pointInTriangle(px(p), py(p), px(a), py(a), px(b), py(b), px(c), py(c))) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      out.push(px(a), py(a), px(b), py(b), px(c), py(c));
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input; emit what we have
  }
  if (idx.length === 3) {
    out.push(px(idx[0]), py(idx[0]), px(idx[1]), py(idx[1]), px(idx[2]), py(idx[2]));
  }
  return new Float32Array(out);
}

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
