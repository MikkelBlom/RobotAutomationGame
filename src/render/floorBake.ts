import { makeRng, TAU, type Rng } from '../core/mathUtils';
import { pointInPolygon } from '../sim/polygon';
import {
  DOCK_OPENING,
  FLOOR,
  HAZARD_BAND,
  WALL_THICKNESS,
  WATER_POLY,
  WORLD,
  WORLD_H,
  WORLD_W,
} from '../sim/level';

/**
 * Procedural albedo for the static shell: concrete slab, grime, the hazard band
 * around the basin, and the wall ring. Baked once into a texture.
 *
 * Deliberately NEUTRAL — no baked sun or lamp light. All time-of-day comes from
 * the lighting pass, which is what lets one bake serve the whole day cycle.
 *
 * The floor is intentionally clear of shelving, crates and machinery: the level
 * gets laid out first, props come after.
 */

/**
 * Neutral mid-tone albedo. Kept deliberately dark: the composite multiplies
 * this by the light buffer, so a light bake reads as washed-out chalk once
 * daylight is applied.
 */
const PALETTE = {
  concrete: '#5e615f',
  concreteLight: '#6e716e',
  concreteDark: '#4a4d4c',
  joint: '#3a3d3d',
  grime: '#35383a',
  oil: '#202224',
  damp: '#454a4d',
  puddle: '#2f3a45',
  puddleRim: '#7d8285',
  crack: '#2b2d2e',
  wall: '#2f3336',
  wallLight: '#3f4448',
  wallDark: '#191b1d',
  curbLight: '#6a706f',
  rust: '#7a4520',
  rustDeep: '#5c3116',
  hazardYellow: '#b8932e',
  hazardDark: '#2e2f2c',
  gate: '#3a3f43',
  gateDark: '#23272a',
  pit: '#0f141a',
} as const;

function tracePolygon(ctx: CanvasRenderingContext2D, poly: number[]): void {
  ctx.beginPath();
  ctx.moveTo(poly[0], poly[1]);
  for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
  ctx.closePath();
}

function makeConcreteNoise(rng: Rng, size: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  const img = ctx.createImageData(size, size);
  const px = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = rng.next();
    const tone = 96 + v * 116;
    px[i * 4] = tone;
    px[i * 4 + 1] = tone * 0.985;
    px[i * 4 + 2] = tone * 0.94;
    px[i * 4 + 3] = 34 + v * 84;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export function bakeFloor(seed: number): HTMLCanvasElement {
  const rng = makeRng(seed);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(WORLD_W);
  cv.height = Math.ceil(WORLD_H);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for floor bake');

  ctx.save();
  ctx.translate(-WORLD.x0, -WORLD.y0);

  paintWallShell(ctx, rng);
  paintSlab(ctx, rng);
  paintPourJoints(ctx, rng);
  paintGrime(ctx, rng);
  paintTrafficWear(ctx, rng);
  paintPuddlesAndOil(ctx, rng);
  paintCracks(ctx, rng);
  paintBasinPit(ctx);
  paintDampRing(ctx);
  paintHazardBand(ctx, rng, cv.width, cv.height);
  paintWallContactShadow(ctx);
  paintDockMouth(ctx, rng);

  ctx.restore();
  return cv;
}

/**
 * The wall ring, drawn as four runs of clad steel rather than one flat band.
 * Each run gets sheet joints, corrugation across its thickness, structural
 * posts on the bay spacing, and a concrete kerb where it meets the slab —
 * which is what actually sells the thickness from directly above.
 */
function paintWallShell(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.fillStyle = PALETTE.wallDark;
  ctx.fillRect(WORLD.x0, WORLD.y0, WORLD_W, WORLD_H);

  const t = WALL_THICKNESS;
  // x, y, length, thickness, runsHorizontally, kerb side (+1 = kerb at larger coord)
  const runs: Array<[number, number, number, number, boolean, number]> = [
    [WORLD.x0, WORLD.y0, WORLD_W, t, true, 1],                       // north
    [WORLD.x0, FLOOR.y + FLOOR.h, WORLD_W, t, true, -1],             // south
    // West is split either side of the dock opening.
    [WORLD.x0, FLOOR.y, t, DOCK_OPENING.y0 - FLOOR.y, false, 1],
    [WORLD.x0, DOCK_OPENING.y1, t, FLOOR.y + FLOOR.h - DOCK_OPENING.y1, false, 1],
    [FLOOR.x + FLOOR.w, FLOOR.y, t, FLOOR.h, false, -1],             // east
  ];

  for (const [x, y, w, h, horizontal, kerbSide] of runs) {
    paintWallRun(ctx, rng, x, y, w, h, horizontal, kerbSide);
  }
}

function paintWallRun(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  horizontal: boolean,
  kerbSide: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const runLength = horizontal ? w : h;
  const thickness = horizontal ? h : w;
  const alongStart = horizontal ? x : y;

  ctx.fillStyle = PALETTE.wall;
  ctx.fillRect(x, y, w, h);

  // Cladding sheets: each weathered slightly differently.
  const sheet = 330;
  for (let a = alongStart; a < alongStart + runLength; a += sheet) {
    ctx.globalAlpha = rng.range(0.05, 0.14);
    ctx.fillStyle = rng.chance(0.5) ? PALETTE.wallLight : PALETTE.wallDark;
    if (horizontal) ctx.fillRect(a, y, sheet, h);
    else ctx.fillRect(x, a, w, sheet);
  }
  ctx.globalAlpha = 1;

  // Corrugation runs across the wall's thickness.
  ctx.strokeStyle = 'rgba(0,0,0,0.24)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let a = alongStart; a < alongStart + runLength; a += 15) {
    if (horizontal) {
      ctx.moveTo(a, y);
      ctx.lineTo(a, y + h);
    } else {
      ctx.moveTo(x, a);
      ctx.lineTo(x + w, a);
    }
  }
  ctx.stroke();
  // Catch-light on the opposite side of each rib.
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.beginPath();
  for (let a = alongStart + 3; a < alongStart + runLength; a += 15) {
    if (horizontal) {
      ctx.moveTo(a, y);
      ctx.lineTo(a, y + h);
    } else {
      ctx.moveTo(x, a);
      ctx.lineTo(x + w, a);
    }
  }
  ctx.stroke();

  // Sheet joints, heavier than the corrugation.
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let a = alongStart; a < alongStart + runLength; a += sheet) {
    if (horizontal) {
      ctx.moveTo(a, y);
      ctx.lineTo(a, y + h);
    } else {
      ctx.moveTo(x, a);
      ctx.lineTo(x + w, a);
    }
  }
  ctx.stroke();

  // Structural posts on the bay spacing, standing proud of the cladding.
  const bay = 560;
  for (let a = alongStart + bay / 2; a < alongStart + runLength; a += bay) {
    const postW = 46;
    ctx.fillStyle = PALETTE.wallLight;
    if (horizontal) ctx.fillRect(a - postW / 2, y + 6, postW, h - 12);
    else ctx.fillRect(x + 6, a - postW / 2, w - 12, postW);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 3;
    if (horizontal) ctx.strokeRect(a - postW / 2, y + 6, postW, h - 12);
    else ctx.strokeRect(x + 6, a - postW / 2, w - 12, postW);
    // Top-face catch light.
    ctx.fillStyle = 'rgba(255,255,255,0.11)';
    if (horizontal) ctx.fillRect(a - postW / 2, y + 6, postW, 6);
    else ctx.fillRect(x + 6, a - postW / 2, 6, postW);
  }

  // Rust bleeding from the fixings.
  for (let i = 0; i < 46; i++) {
    ctx.globalAlpha = rng.range(0.07, 0.26);
    ctx.fillStyle = rng.chance(0.5) ? PALETTE.rust : PALETTE.rustDeep;
    const a = rng.range(alongStart, alongStart + runLength);
    const across = rng.range(0, thickness);
    const px = horizontal ? a : x + across;
    const py = horizontal ? y + across : a;
    ctx.beginPath();
    ctx.ellipse(
      px, py,
      horizontal ? rng.range(5, 16) : rng.range(9, 30),
      horizontal ? rng.range(9, 30) : rng.range(5, 16),
      0, 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Concrete kerb along the inner face — the thing that actually reads as
  // "this wall has depth" when you are looking straight down at it.
  const kerb = 16;
  const kx = horizontal ? x : kerbSide > 0 ? x + w - kerb : x;
  const ky = horizontal ? (kerbSide > 0 ? y + h - kerb : y) : y;
  const kw = horizontal ? w : kerb;
  const kh = horizontal ? kerb : h;
  ctx.fillStyle = PALETTE.curbLight;
  ctx.fillRect(kx, ky, kw, kh);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  if (horizontal) ctx.fillRect(kx, kerbSide > 0 ? ky + kerb - 4 : ky, kw, 4);
  else ctx.fillRect(kerbSide > 0 ? kx + kerb - 4 : kx, ky, 4, kh);

  ctx.restore();
}

function paintSlab(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();

  ctx.fillStyle = PALETTE.concrete;
  ctx.fillRect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);

  // Broad tonal zones so the slab is not flat. Low contrast on purpose —
  // anything stronger reads as cloud cover rather than worn concrete.
  for (let i = 0; i < 170; i++) {
    ctx.globalAlpha = rng.range(0.014, 0.042);
    ctx.fillStyle = rng.chance(0.5) ? PALETTE.concreteLight : PALETTE.concreteDark;
    ctx.beginPath();
    ctx.ellipse(
      rng.range(FLOOR.x, FLOOR.x + FLOOR.w),
      rng.range(FLOOR.y, FLOOR.y + FLOOR.h),
      rng.range(70, 250),
      rng.range(50, 170),
      rng.range(0, TAU),
      0,
      TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Aggregate grain.
  const noise = makeConcreteNoise(rng, 256);
  const pattern = ctx.createPattern(noise, 'repeat');
  if (pattern) {
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = pattern;
    ctx.fillRect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/**
 * Slab control joints. Deliberately faint and unevenly spaced — a crisp,
 * regular lattice made the whole floor read as a tile grid.
 */
function paintPourJoints(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();
  ctx.strokeStyle = PALETTE.joint;
  ctx.lineCap = 'round';

  // Long pours run the length of the hall; cross joints are shorter and rarer.
  for (let x = FLOOR.x + rng.range(300, 520); x < FLOOR.x + FLOOR.w; x += rng.range(430, 720)) {
    ctx.globalAlpha = rng.range(0.10, 0.20);
    ctx.lineWidth = rng.range(2, 3.4);
    ctx.beginPath();
    ctx.moveTo(x, FLOOR.y);
    ctx.lineTo(x + rng.range(-14, 14), FLOOR.y + FLOOR.h);
    ctx.stroke();
  }
  for (let y = FLOOR.y + rng.range(360, 620); y < FLOOR.y + FLOOR.h; y += rng.range(520, 860)) {
    const x0 = FLOOR.x + (rng.chance(0.5) ? 0 : rng.range(200, 900));
    const x1 = FLOOR.x + FLOOR.w - (rng.chance(0.5) ? 0 : rng.range(200, 900));
    ctx.globalAlpha = rng.range(0.08, 0.16);
    ctx.lineWidth = rng.range(1.8, 3);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y + rng.range(-12, 12));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintGrime(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();

  // Dirt builds up along the walls where nothing sweeps.
  const edges: Array<[number, number, number, number]> = [
    [FLOOR.x, FLOOR.y, FLOOR.w, 150],
    [FLOOR.x, FLOOR.y + FLOOR.h - 150, FLOOR.w, 150],
    [FLOOR.x, FLOOR.y, 150, FLOOR.h],
    [FLOOR.x + FLOOR.w - 150, FLOOR.y, 150, FLOOR.h],
  ];
  const gradients = [
    ctx.createLinearGradient(0, FLOOR.y, 0, FLOOR.y + 150),
    ctx.createLinearGradient(0, FLOOR.y + FLOOR.h, 0, FLOOR.y + FLOOR.h - 150),
    ctx.createLinearGradient(FLOOR.x, 0, FLOOR.x + 150, 0),
    ctx.createLinearGradient(FLOOR.x + FLOOR.w, 0, FLOOR.x + FLOOR.w - 150, 0),
  ];
  for (let i = 0; i < 4; i++) {
    gradients[i].addColorStop(0, 'rgba(60,56,46,0.42)');
    gradients[i].addColorStop(1, 'rgba(60,56,46,0)');
    ctx.fillStyle = gradients[i];
    ctx.fillRect(edges[i][0], edges[i][1], edges[i][2], edges[i][3]);
  }

  // General blotchy filth.
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = rng.range(0.02, 0.07);
    ctx.fillStyle = PALETTE.grime;
    ctx.beginPath();
    ctx.ellipse(
      rng.range(FLOOR.x, FLOOR.x + FLOOR.w),
      rng.range(FLOOR.y, FLOOR.y + FLOOR.h),
      rng.range(40, 200),
      rng.range(28, 130),
      rng.range(0, TAU),
      0,
      TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintTrafficWear(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();
  ctx.lineCap = 'round';
  for (let i = 0; i < 130; i++) {
    const x = rng.range(FLOOR.x, FLOOR.x + FLOOR.w);
    const y = rng.range(FLOOR.y, FLOOR.y + FLOOR.h);
    const angle = rng.chance(0.6) ? rng.range(-0.12, 0.12) : Math.PI / 2 + rng.range(-0.12, 0.12);
    const len = rng.range(60, 260);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = rng.range(0.04, 0.13);
    ctx.strokeStyle = PALETTE.oil;
    ctx.lineWidth = rng.range(4, 13);
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.lineTo(len / 2, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintPuddlesAndOil(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();

  for (let i = 0; i < 52; i++) {
    const x = rng.range(FLOOR.x + 60, FLOOR.x + FLOOR.w - 60);
    const y = rng.range(FLOOR.y + 60, FLOOR.y + FLOOR.h - 60);
    const rx = rng.range(20, 62);
    const ry = rx * rng.range(0.4, 0.75);
    const rot = rng.range(0, TAU);

    // Damp halo first, tight and faint — a wide soft one reads as fog.
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = PALETTE.damp;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 1.22, ry * 1.22, rot, 0, TAU);
    ctx.fill();

    // The standing water itself: small, dark, defined.
    ctx.globalAlpha = rng.range(0.34, 0.58);
    ctx.fillStyle = PALETTE.puddle;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    ctx.fill();

    // A thin lit rim on one side only, so it reads as a depression.
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = PALETTE.puddleRim;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, Math.PI * 0.85, Math.PI * 1.95);
    ctx.stroke();
  }

  for (let i = 0; i < 40; i++) {
    const x = rng.range(FLOOR.x + 40, FLOOR.x + FLOOR.w - 40);
    const y = rng.range(FLOOR.y + 40, FLOOR.y + FLOOR.h - 40);
    const r = rng.range(18, 70);
    for (let k = 0; k < rng.int(3, 6); k++) {
      ctx.globalAlpha = rng.range(0.1, 0.3);
      ctx.fillStyle = PALETTE.oil;
      ctx.beginPath();
      ctx.ellipse(
        x + rng.range(-r * 0.5, r * 0.5),
        y + rng.range(-r * 0.4, r * 0.4),
        r * rng.range(0.35, 1),
        r * rng.range(0.25, 0.7),
        rng.range(0, TAU),
        0,
        TAU,
      );
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintCracks(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();
  ctx.lineCap = 'round';
  for (let i = 0; i < 80; i++) {
    let x = rng.range(FLOOR.x, FLOOR.x + FLOOR.w);
    let y = rng.range(FLOOR.y, FLOOR.y + FLOOR.h);
    let angle = rng.range(0, TAU);
    ctx.globalAlpha = rng.range(0.12, 0.34);
    ctx.strokeStyle = PALETTE.crack;
    ctx.lineWidth = rng.range(0.8, 2.4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0, n = rng.int(3, 8); k < n; k++) {
      angle += rng.range(-0.9, 0.9);
      x += Math.cos(angle) * rng.range(30, 100);
      y += Math.sin(angle) * rng.range(30, 100);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** The basin reads as a dark pit; the animated water mesh renders on top. */
function paintBasinPit(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  tracePolygon(ctx, WATER_POLY);
  ctx.fillStyle = PALETTE.pit;
  ctx.fill();
  ctx.restore();
}

/** Concrete around the basin never fully dries. */
function paintDampRing(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  tracePolygon(ctx, WATER_POLY);
  ctx.clip();
  ctx.restore();

  ctx.save();
  ctx.lineJoin = 'round';
  for (let i = 0; i < 5; i++) {
    const width = 200 - i * 36;
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = PALETTE.damp;
    ctx.lineWidth = width;
    tracePolygon(ctx, WATER_POLY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * The yellow warning band around the dock.
 *
 * Each stripe is ONE continuous polygon that follows the band all the way
 * round, rather than being rebuilt per edge or per sub-segment. The band is
 * parameterised by arc length along the basin outline; a 45-degree stripe is
 * simply one whose outer edge is offset along that arc by the band width. So a
 * stripe crossing a corner bends with the corner instead of being clipped,
 * re-angled, or stitched — which is what produced the seams and the sawtooth in
 * the three previous attempts.
 */
function paintHazardBand(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  _width: number,
  _height: number,
): void {
  const BAND = HAZARD_BAND;
  const stripe = 34;
  const pitch = stripe * 2;
  const count = WATER_POLY.length / 2;

  const px = (i: number) => WATER_POLY[(i % count) * 2];
  const py = (i: number) => WATER_POLY[(i % count) * 2 + 1];

  // Outward unit normal of each edge i (vertex i -> i+1), and its length.
  const nx = new Float64Array(count);
  const ny = new Float64Array(count);
  const edgeLen = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const dx = px(i + 1) - px(i);
    const dy = py(i + 1) - py(i);
    const len = Math.hypot(dx, dy) || 1;
    edgeLen[i] = len;
    let cx = -dy / len;
    let cy = dx / len;
    const midX = (px(i) + px(i + 1)) / 2;
    const midY = (py(i) + py(i + 1)) / 2;
    if (pointInPolygon(WATER_POLY, midX + cx * 6, midY + cy * 6)) {
      cx = -cx;
      cy = -cy;
    }
    nx[i] = cx;
    ny[i] = cy;
  }

  // Mitred offset of each vertex j, between edges j-1 and j.
  const ox = new Float64Array(count);
  const oy = new Float64Array(count);
  for (let j = 0; j < count; j++) {
    const prev = (j - 1 + count) % count;
    let bx = nx[prev] + nx[j];
    let by = ny[prev] + ny[j];
    const blen = Math.hypot(bx, by) || 1;
    bx /= blen;
    by /= blen;
    const cosHalf = Math.max(0.35, bx * nx[j] + by * ny[j]);
    const d = BAND / cosHalf;
    ox[j] = px(j) + bx * d;
    oy[j] = py(j) + by * d;
  }

  // Cumulative arc length so the outline can be addressed by distance.
  const cum = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) cum[i + 1] = cum[i] + edgeLen[i];
  const perimeter = cum[count];

  /** Point on the inner outline (or its mitred offset) at arc length s. */
  const at = (s: number, outer: boolean): [number, number] => {
    let u = ((s % perimeter) + perimeter) % perimeter;
    let i = 0;
    while (i < count - 1 && cum[i + 1] <= u) i++;
    const t = (u - cum[i]) / edgeLen[i];
    const j = (i + 1) % count;
    return outer
      ? [ox[i] + (ox[j] - ox[i]) * t, oy[i] + (oy[j] - oy[i]) * t]
      : [px(i) + (px(j) - px(i)) * t, py(i) + (py(j) - py(i)) * t];
  };

  /** Arc lengths of any outline vertices strictly inside (a, b). */
  const verticesBetween = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k <= count * 2; k++) {
      const v = cum[k % count] + Math.floor(k / count) * perimeter;
      if (v > a && v < b) out.push(v);
    }
    return out.sort((m, n) => m - n);
  };

  ctx.save();
  // Never paint over the wall recess or the dock mouth.
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();

  // Yellow ground: the mitred ring, with the basin punched out of it.
  ctx.beginPath();
  ctx.moveTo(ox[0], oy[0]);
  for (let i = 1; i < count; i++) ctx.lineTo(ox[i], oy[i]);
  ctx.closePath();
  ctx.moveTo(px(0), py(0));
  for (let i = count - 1; i >= 1; i--) ctx.lineTo(px(i), py(i));
  ctx.closePath();
  ctx.fillStyle = PALETTE.hazardYellow;
  ctx.fill('evenodd');

  // Dark bars. Offsetting the outer edge by BAND along the arc is what makes
  // the bar sit at 45 degrees to the band.
  ctx.fillStyle = PALETTE.hazardDark;
  const bars = Math.ceil(perimeter / pitch);
  for (let k = 0; k < bars; k++) {
    const s0 = k * pitch;
    const s1 = s0 + stripe;

    ctx.beginPath();
    let p = at(s0, false);
    ctx.moveTo(p[0], p[1]);
    for (const v of verticesBetween(s0, s1)) {
      p = at(v, false);
      ctx.lineTo(p[0], p[1]);
    }
    p = at(s1, false);
    ctx.lineTo(p[0], p[1]);

    p = at(s1 + BAND, true);
    ctx.lineTo(p[0], p[1]);
    const backs = verticesBetween(s0 + BAND, s1 + BAND).reverse();
    for (const v of backs) {
      p = at(v, true);
      ctx.lineTo(p[0], p[1]);
    }
    p = at(s0 + BAND, true);
    ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill();
  }

  // Worn paint, applied over the finished band so scuffs cross the stripes.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ox[0], oy[0]);
  for (let i = 1; i < count; i++) ctx.lineTo(ox[i], oy[i]);
  ctx.closePath();
  ctx.clip();
  for (let k = 0; k < 200; k++) {
    const i = rng.int(0, count - 1);
    const t = rng.next();
    const j = (i + 1) % count;
    const bx = px(i) + (px(j) - px(i)) * t;
    const by = py(i) + (py(j) - py(i)) * t;
    ctx.globalAlpha = rng.range(0.07, 0.28);
    ctx.fillStyle = rng.chance(0.6) ? PALETTE.concrete : PALETTE.grime;
    ctx.beginPath();
    ctx.ellipse(
      bx + nx[i] * rng.range(0, BAND), by + ny[i] * rng.range(0, BAND),
      rng.range(6, 26), rng.range(4, 14), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // A dark lip between the paint and the water, so the band has an edge.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10,12,14,0.55)';
  ctx.lineWidth = 5;
  tracePolygon(ctx, WATER_POLY);
  ctx.stroke();

  ctx.restore();
}

/**
 * The mouth of the dock, where the channel passes under the west wall. There is
 * no gate: the water simply runs out to sea. Nothing beyond the shell is drawn
 * — the water shader fades the channel to black — so all that is needed here is
 * the cut ends of the wall and the shadow they throw across the water.
 */
function paintDockMouth(ctx: CanvasRenderingContext2D, rng: Rng): void {
  const x0 = WORLD.x0;
  const x1 = FLOOR.x;
  const { y0, y1 } = DOCK_OPENING;

  // Cut ends of the wall on either side of the opening, with a steel edge.
  for (const [jy, dir] of [[y0, -1], [y1, 1]] as Array<[number, number]>) {
    ctx.fillStyle = PALETTE.wallLight;
    ctx.fillRect(x0, jy + (dir < 0 ? -18 : 0), x1 - x0, 18);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x0, jy + (dir < 0 ? -4 : 14), x1 - x0, 4);
    // Fender posts protecting the corner from hulls.
    for (let x = x0 + 22; x < x1; x += 46) {
      ctx.fillStyle = PALETTE.gateDark;
      ctx.beginPath();
      ctx.arc(x, jy + dir * -13, 9, 0, TAU);
      ctx.fill();
    }
    for (let i = 0; i < 26; i++) {
      ctx.globalAlpha = rng.range(0.1, 0.32);
      ctx.fillStyle = rng.chance(0.5) ? PALETTE.rust : PALETTE.rustDeep;
      ctx.beginPath();
      ctx.ellipse(
        rng.range(x0, x1), jy + dir * -rng.range(0, 20),
        rng.range(4, 15), rng.range(3, 10), 0, 0, TAU,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/** Soft contact darkening where the walls meet the slab. */
function paintWallContactShadow(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();
  const depth = WALL_THICKNESS * 1.15;
  const shade = (grad: CanvasGradient, x: number, y: number, w: number, h: number) => {
    grad.addColorStop(0, 'rgba(12,11,10,0.5)');
    grad.addColorStop(1, 'rgba(12,11,10,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  };
  shade(
    ctx.createLinearGradient(0, FLOOR.y, 0, FLOOR.y + depth),
    FLOOR.x, FLOOR.y, FLOOR.w, depth,
  );
  shade(
    ctx.createLinearGradient(0, FLOOR.y + FLOOR.h, 0, FLOOR.y + FLOOR.h - depth),
    FLOOR.x, FLOOR.y + FLOOR.h - depth, FLOOR.w, depth,
  );
  shade(
    ctx.createLinearGradient(FLOOR.x, 0, FLOOR.x + depth, 0),
    FLOOR.x, FLOOR.y, depth, FLOOR.h,
  );
  shade(
    ctx.createLinearGradient(FLOOR.x + FLOOR.w, 0, FLOOR.x + FLOOR.w - depth, 0),
    FLOOR.x + FLOOR.w - depth, FLOOR.y, depth, FLOOR.h,
  );
  ctx.restore();
}
