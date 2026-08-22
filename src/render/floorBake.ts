import { makeRng, TAU, type Rng } from '../core/mathUtils';
import { pointInPolygon } from '../sim/polygon';
import {
  BAY_APPROACH_DEPTH,
  SHELL,
  DOCK_OPENING,
  FLOOR,
  type DockBay,
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
  concrete: '#55584f',
  concreteLight: '#666a60',
  concreteDark: '#42453e',
  joint: '#3a3d3d',
  grime: '#35383a',
  oil: '#202224',
  damp: '#454a4d',
  puddle: '#2f3a45',
  puddleRim: '#7d8285',
  crack: '#2b2d2e',
  wall: '#4a5158',
  wallLight: '#5b636b',
  wallDark: '#262b30',
  curbLight: '#7d8482',
  rust: '#7a4520',
  rustDeep: '#5c3116',
  hazardYellow: '#8d7530',
  hazardDark: '#2a2b28',
  gate: '#3a3f43',
  leveller: '#363c42',
  trailerFloor: '#5e5138',
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

/**
 * Texels per centimetre. The hall is 120 m across; baking that at one texel per
 * centimetre would need a 12000 px texture. At this ratio one texel is a little
 * over 3 cm, which is finer than anything visible at play zoom. The consequence
 * is that detail authored below life size cannot land, so the floor wear below
 * is deliberately drawn coarser than reality.
 */
export const BAKE_SCALE = 0.30;

export interface BakeOptions {
  /** Stains, puddles, oil and wear on the slab. Toggleable for level layout. */
  grime: boolean;
}

export function bakeFloor(
  seed: number,
  bays: DockBay[],
  options: BakeOptions = { grime: true },
): HTMLCanvasElement {
  const rng = makeRng(seed);
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(WORLD_W * BAKE_SCALE);
  cv.height = Math.ceil(WORLD_H * BAKE_SCALE);
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for floor bake');

  ctx.save();
  ctx.scale(BAKE_SCALE, BAKE_SCALE);
  ctx.translate(-WORLD.x0, -WORLD.y0);

  // Everything outside the shell, including the trailer apron to the north,
  // starts black. This is the whole of the "fog of war": you cannot see out.
  ctx.fillStyle = '#05070a';
  ctx.fillRect(WORLD.x0, WORLD.y0, WORLD_W, WORLD_H);

  paintWallShell(ctx, rng, bays);
  paintSlab(ctx, rng);
  paintPourJoints(ctx, rng);
  if (options.grime) {
    paintGrime(ctx, rng);
    paintTrafficWear(ctx, rng);
    paintPuddlesAndOil(ctx, rng);
    paintCracks(ctx, rng);
  }
  paintBasinPit(ctx);
  paintDampRing(ctx);
  paintHazardBand(ctx, rng, cv.width, cv.height);
  paintWallContactShadow(ctx);
  paintDockMouth(ctx, rng);
  // Fog goes on before the trailers, so a docked trailer stays the one lit
  // thing beyond the shell.
  paintOutsideFog(ctx);
  paintLoadingBays(ctx, rng, bays);

  ctx.restore();
  return cv;
}

/**
 * The wall ring, drawn as four runs of clad steel rather than one flat band.
 * Each run gets sheet joints, corrugation across its thickness, structural
 * posts on the bay spacing, and a concrete kerb where it meets the slab —
 * which is what actually sells the thickness from directly above.
 */
function paintWallShell(ctx: CanvasRenderingContext2D, rng: Rng, bays: DockBay[]): void {
  const t = WALL_THICKNESS;
  const northY = SHELL.y0;
  const shellW = SHELL.x1 - SHELL.x0;

  // Every run is positioned from SHELL, the building itself. Using WORLD here
  // put the west wall out in the apron and overhung the north and south walls
  // past both corners.
  // x, y, length, thickness, runsHorizontally, kerb side (+1 = kerb at larger coord)
  const runs: Array<[number, number, number, number, boolean, number]> = [
    [SHELL.x0, FLOOR.y + FLOOR.h, shellW, t, true, -1],              // south
    // West is split either side of the dock opening.
    [SHELL.x0, FLOOR.y, t, DOCK_OPENING.y0 - FLOOR.y, false, 1],
    [SHELL.x0, DOCK_OPENING.y1, t, FLOOR.y + FLOOR.h - DOCK_OPENING.y1, false, 1],
    [FLOOR.x + FLOOR.w, FLOOR.y, t, FLOOR.h, false, -1],             // east
  ];

  // The north wall is broken by the loading bays, so it is built as the pieces
  // between them.
  const gaps = bays
    .map((b) => [b.x - b.width / 2, b.x + b.width / 2] as const)
    .sort((a, b) => a[0] - b[0]);
  let cursor = SHELL.x0;
  for (const [gapStart, gapEnd] of gaps) {
    if (gapStart > cursor) runs.push([cursor, northY, gapStart - cursor, t, true, 1]);
    cursor = gapEnd;
  }
  if (cursor < SHELL.x1) runs.push([cursor, northY, SHELL.x1 - cursor, t, true, 1]);

  for (const [x, y, w, h, horizontal, kerbSide] of runs) {
    paintWallRun(ctx, rng, x, y, w, h, horizontal, kerbSide);
  }
}

/**
 * Trailer bays in the north wall.
 *
 * A bay reads as a black rubber seal in the wall when it is empty — you cannot
 * see out through it. When a trailer is backed on, its interior is drawn out in
 * the apron and lit from inside, so the truck is the one thing visible beyond
 * the shell.
 */
function paintLoadingBays(ctx: CanvasRenderingContext2D, rng: Rng, bays: DockBay[]): void {
  const t = WALL_THICKNESS;
  const northY = FLOOR.y - t;

  for (const bay of bays) {
    const half = bay.width / 2;
    const x0 = bay.x - half;
    const x1 = bay.x + half;

    // Rubber dock seal lining the opening. Trailers are drawn live on top of
    // this now, since they arrive and leave.
    ctx.fillStyle = '#05070b';
    ctx.fillRect(x0, northY, bay.width, t);
    ctx.fillStyle = '#0a0d11';
    ctx.fillRect(x0, northY, 26, t);
    ctx.fillRect(x1 - 26, northY, 26, t);
    ctx.fillRect(x0, northY, bay.width, 22);

    // A bay not in service is shut, not merely empty. An open black hole with
    // no trailer ever arriving reads as a bay whose truck is late; a closed
    // shutter reads as a bay that is not yours yet.
    if (!bay.active) {
      paintShutter(ctx, rng, x0, northY, bay.width, t);
      continue;
    }

    // Dock bumpers either side of the opening, at the face.
    ctx.fillStyle = '#15181b';
    ctx.fillRect(x0 - 46, FLOOR.y - 34, 46, 82);
    ctx.fillRect(x1, FLOOR.y - 34, 46, 82);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x0 - 46, FLOOR.y - 34, 46, 9);
    ctx.fillRect(x1, FLOOR.y - 34, 46, 9);

    // Dock leveller plate, set into the slab just inside.
    const plateDepth = 210;
    ctx.fillStyle = PALETTE.leveller;
    ctx.fillRect(x0, FLOOR.y, bay.width, plateDepth);
    // Recessed into the slab: dark on the far lip, light where it rises.
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x0, FLOOR.y + plateDepth - 12, bay.width, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(x0, FLOOR.y, bay.width, 7);
    ctx.strokeStyle = 'rgba(12,14,16,0.6)';
    ctx.lineWidth = 5;
    ctx.strokeRect(x0, FLOOR.y, bay.width, plateDepth);
    // Chequer plate.
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let d = -bay.width; d < bay.width * 2; d += 44) {
      ctx.moveTo(x0 + d, FLOOR.y);
      ctx.lineTo(x0 + d + plateDepth, FLOOR.y + plateDepth);
      ctx.moveTo(x0 + d + plateDepth, FLOOR.y);
      ctx.lineTo(x0 + d, FLOOR.y + plateDepth);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, FLOOR.y, bay.width, plateDepth);
    ctx.clip();
    ctx.stroke();
    ctx.restore();

    // Painted approach lane: two edge lines and a bay number block.
    ctx.strokeStyle = 'rgba(184,147,46,0.42)';
    ctx.lineWidth = 16;
    ctx.setLineDash([170, 110]);
    ctx.beginPath();
    ctx.moveTo(x0 - 30, FLOOR.y + plateDepth);
    ctx.lineTo(x0 - 30, FLOOR.y + BAY_APPROACH_DEPTH);
    ctx.moveTo(x1 + 30, FLOOR.y + plateDepth);
    ctx.lineTo(x1 + 30, FLOOR.y + BAY_APPROACH_DEPTH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Scuffed rubber where trailers have hit the bumpers.
    for (let i = 0; i < 26; i++) {
      ctx.globalAlpha = rng.range(0.06, 0.2);
      ctx.fillStyle = PALETTE.oil;
      ctx.beginPath();
      ctx.ellipse(
        rng.range(x0 - 90, x1 + 90), FLOOR.y + rng.range(0, 360),
        rng.range(20, 80), rng.range(12, 48), rng.range(0, TAU), 0, TAU,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
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
  const sheet = 1200;
  for (let a = alongStart; a < alongStart + runLength; a += sheet) {
    ctx.globalAlpha = rng.range(0.04, 0.10);
    ctx.fillStyle = rng.chance(0.5) ? PALETTE.wallLight : PALETTE.wallDark;
    if (horizontal) ctx.fillRect(a, y, sheet, h);
    else ctx.fillRect(x, a, w, sheet);
  }
  ctx.globalAlpha = 1;

  // Corrugation runs across the wall's thickness.
  ctx.strokeStyle = 'rgba(0,0,0,0.24)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let a = alongStart; a < alongStart + runLength; a += 55) {
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
  for (let a = alongStart + 12; a < alongStart + runLength; a += 55) {
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
  const bay = 1100;
  for (let a = alongStart + bay / 2; a < alongStart + runLength; a += bay) {
    const postW = 150;
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
  for (let i = 0; i < 34; i++) {
    ctx.globalAlpha = rng.range(0.04, 0.11);
    ctx.fillStyle = rng.chance(0.22) ? PALETTE.rust : PALETTE.wallDark;
    const a = rng.range(alongStart, alongStart + runLength);
    const across = rng.range(0, thickness);
    const px = horizontal ? a : x + across;
    const py = horizontal ? y + across : a;
    ctx.beginPath();
    ctx.ellipse(
      px, py,
      horizontal ? rng.range(18, 60) : rng.range(34, 112),
      horizontal ? rng.range(34, 112) : rng.range(18, 60),
      0, 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Concrete kerb along the inner face — the thing that actually reads as
  // "this wall has depth" when you are looking straight down at it.
  const kerb = 55;
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

  // Broad tonal variation from a smooth noise field.
  //
  // This used to be several hundred stacked soft ellipses. Overlapping, they
  // read as leopard print — big grey clouds drifting over the slab — which is
  // nothing like concrete. A low-frequency field gives the same "not flat"
  // result without ever resolving into blobs.
  paintTonalField(ctx, rng, FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h, 0.16, 26);

  // Aggregate grain.
  const noise = makeConcreteNoise(rng, 512);
  const pattern = ctx.createPattern(noise, 'repeat');
  if (pattern) {
    ctx.globalAlpha = 0.5;
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
  for (let x = FLOOR.x + rng.range(1100, 1900); x < FLOOR.x + FLOOR.w; x += rng.range(1600, 2700)) {
    ctx.globalAlpha = rng.range(0.10, 0.20);
    ctx.lineWidth = rng.range(7, 13);
    ctx.beginPath();
    ctx.moveTo(x, FLOOR.y);
    ctx.lineTo(x + rng.range(-52, 52), FLOOR.y + FLOOR.h);
    ctx.stroke();
  }
  for (let y = FLOOR.y + rng.range(1350, 2300); y < FLOOR.y + FLOOR.h; y += rng.range(1950, 3200)) {
    const x0 = FLOOR.x + (rng.chance(0.5) ? 0 : rng.range(750, 3400));
    const x1 = FLOOR.x + FLOOR.w - (rng.chance(0.5) ? 0 : rng.range(750, 3400));
    ctx.globalAlpha = rng.range(0.08, 0.16);
    ctx.lineWidth = rng.range(6, 11);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y + rng.range(-45, 45));
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
    [FLOOR.x, FLOOR.y, FLOOR.w, 560],
    [FLOOR.x, FLOOR.y + FLOOR.h - 560, FLOOR.w, 560],
    [FLOOR.x, FLOOR.y, 560, FLOOR.h],
    [FLOOR.x + FLOOR.w - 560, FLOOR.y, 560, FLOOR.h],
  ];
  const gradients = [
    ctx.createLinearGradient(0, FLOOR.y, 0, FLOOR.y + 560),
    ctx.createLinearGradient(0, FLOOR.y + FLOOR.h, 0, FLOOR.y + FLOOR.h - 560),
    ctx.createLinearGradient(FLOOR.x, 0, FLOOR.x + 560, 0),
    ctx.createLinearGradient(FLOOR.x + FLOOR.w, 0, FLOOR.x + FLOOR.w - 560, 0),
  ];
  for (let i = 0; i < 4; i++) {
    gradients[i].addColorStop(0, 'rgba(60,56,46,0.22)');
    gradients[i].addColorStop(1, 'rgba(60,56,46,0)');
    ctx.fillStyle = gradients[i];
    ctx.fillRect(edges[i][0], edges[i][1], edges[i][2], edges[i][3]);
  }

  // Traffic soiling: darker where robots run, not random blobs. Same field
  // generator as the slab tone, just tighter and dirtier.
  paintTonalField(ctx, rng, FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h, 0.13, 11);

  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintTrafficWear(ctx: CanvasRenderingContext2D, rng: Rng): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(FLOOR.x, FLOOR.y, FLOOR.w, FLOOR.h);
  ctx.clip();
  ctx.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const x = rng.range(FLOOR.x, FLOOR.x + FLOOR.w);
    const y = rng.range(FLOOR.y, FLOOR.y + FLOOR.h);
    const angle = rng.chance(0.6) ? rng.range(-0.12, 0.12) : Math.PI / 2 + rng.range(-0.12, 0.12);
    const len = rng.range(400, 1600);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = rng.range(0.04, 0.13);
    ctx.strokeStyle = PALETTE.oil;
    ctx.lineWidth = rng.range(14, 46);
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

  for (let i = 0; i < 62; i++) {
    const x = rng.range(FLOOR.x + 60, FLOOR.x + FLOOR.w - 60);
    const y = rng.range(FLOOR.y + 60, FLOOR.y + FLOOR.h - 60);
    const rx = rng.range(38, 105);
    const ry = rx * rng.range(0.4, 0.75);
    const rot = rng.range(0, TAU);

    // The standing water itself: small, dark, defined.
    ctx.globalAlpha = rng.range(0.26, 0.44);
    ctx.fillStyle = PALETTE.puddle;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    ctx.fill();

    // A thin lit rim on one side only, so it reads as a depression.
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = PALETTE.puddleRim;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, Math.PI * 0.85, Math.PI * 1.95);
    ctx.stroke();
  }

  for (let i = 0; i < 110; i++) {
    const x = rng.range(FLOOR.x + 40, FLOOR.x + FLOOR.w - 40);
    const y = rng.range(FLOOR.y + 40, FLOOR.y + FLOOR.h - 40);
    const r = rng.range(28, 78);
    for (let k = 0; k < rng.int(2, 4); k++) {
      ctx.globalAlpha = rng.range(0.14, 0.34);
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
  for (let i = 0; i < 190; i++) {
    let x = rng.range(FLOOR.x, FLOOR.x + FLOOR.w);
    let y = rng.range(FLOOR.y, FLOOR.y + FLOOR.h);
    let angle = rng.range(0, TAU);
    ctx.globalAlpha = rng.range(0.07, 0.18);
    ctx.strokeStyle = PALETTE.crack;
    ctx.lineWidth = rng.range(2.5, 6);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0, n = rng.int(3, 8); k < n; k++) {
      angle += rng.range(-0.9, 0.9);
      x += Math.cos(angle) * rng.range(120, 420);
      y += Math.sin(angle) * rng.range(120, 420);
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
    const width = 760 - i * 135;
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
  const stripe = 40;
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
  for (let k = 0; k < 620; k++) {
    const i = rng.int(0, count - 1);
    const t = rng.next();
    const j = (i + 1) % count;
    const bx = px(i) + (px(j) - px(i)) * t;
    const by = py(i) + (py(j) - py(i)) * t;
    ctx.globalAlpha = rng.range(0.10, 0.40);
    ctx.fillStyle = rng.chance(0.6) ? PALETTE.concrete : PALETTE.grime;
    ctx.beginPath();
    ctx.ellipse(
      bx + nx[i] * rng.range(0, BAND), by + ny[i] * rng.range(0, BAND),
      rng.range(14, 62), rng.range(9, 34), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // A dark lip between the paint and the water, so the band has an edge.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(10,12,14,0.55)';
  ctx.lineWidth = 16;
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
  const x0 = SHELL.x0;
  const x1 = FLOOR.x;
  const { y0, y1 } = DOCK_OPENING;

  // Cut ends of the wall on either side of the opening, with a steel edge.
  for (const [jy, dir] of [[y0, -1], [y1, 1]] as Array<[number, number]>) {
    ctx.fillStyle = PALETTE.wallLight;
    ctx.fillRect(x0, jy + (dir < 0 ? -62 : 0), x1 - x0, 62);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x0, jy + (dir < 0 ? -14 : 48), x1 - x0, 14);
    // Fender posts protecting the corner from hulls.
    for (let x = x0 + 80; x < x1; x += 165) {
      ctx.fillStyle = PALETTE.gateDark;
      ctx.beginPath();
      ctx.arc(x, jy + dir * -46, 32, 0, TAU);
      ctx.fill();
    }
    for (let i = 0; i < 60; i++) {
      ctx.globalAlpha = rng.range(0.1, 0.32);
      ctx.fillStyle = rng.chance(0.5) ? PALETTE.rust : PALETTE.rustDeep;
      ctx.beginPath();
      ctx.ellipse(
        rng.range(x0, x1), jy + dir * -rng.range(0, 72),
        rng.range(14, 54), rng.range(11, 36), 0, 0, TAU,
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

/**
 * Darkens everything outside the slab, on all four sides.
 *
 * The fade starts at the floor edge, is already well down by the outer face of
 * the wall, and is solid a little way into the apron. The wall still reads as
 * part of the building rather than being cut off flat, but nothing beyond it is
 * ever legible.
 */
function paintOutsideFog(ctx: CanvasRenderingContext2D): void {
  const ink = '5,7,10';

  const band = (
    grad: CanvasGradient,
    wallFraction: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void => {
    grad.addColorStop(0, `rgba(${ink},0)`);
    grad.addColorStop(wallFraction, `rgba(${ink},0.28)`);
    grad.addColorStop(Math.min(0.92, wallFraction + 0.34), `rgba(${ink},1)`);
    grad.addColorStop(1, `rgba(${ink},1)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  };

  const northDepth = FLOOR.y - WORLD.y0;
  const southDepth = WORLD.y1 - (FLOOR.y + FLOOR.h);
  const westDepth = FLOOR.x - WORLD.x0;
  const eastDepth = WORLD.x1 - (FLOOR.x + FLOOR.w);

  band(
    ctx.createLinearGradient(0, FLOOR.y, 0, WORLD.y0),
    WALL_THICKNESS / northDepth,
    WORLD.x0, WORLD.y0, WORLD_W, northDepth,
  );
  band(
    ctx.createLinearGradient(0, FLOOR.y + FLOOR.h, 0, WORLD.y1),
    WALL_THICKNESS / southDepth,
    WORLD.x0, FLOOR.y + FLOOR.h, WORLD_W, southDepth,
  );
  band(
    ctx.createLinearGradient(FLOOR.x, 0, WORLD.x0, 0),
    WALL_THICKNESS / westDepth,
    WORLD.x0, WORLD.y0, westDepth, WORLD_H,
  );
  band(
    ctx.createLinearGradient(FLOOR.x + FLOOR.w, 0, WORLD.x1, 0),
    WALL_THICKNESS / eastDepth,
    FLOOR.x + FLOOR.w, WORLD.y0, eastDepth, WORLD_H,
  );
}

/**
 * Smooth large-scale tonal variation, from a value-noise field stretched over
 * the target area.
 *
 * `cells` sets the feature size: low numbers give broad drifts, higher numbers
 * a tighter mottle. This exists because stacking soft ellipses to fake the same
 * thing produced overlapping grey clouds that looked nothing like a floor.
 */
function paintTonalField(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x: number,
  y: number,
  w: number,
  h: number,
  strength: number,
  cells: number,
): void {
  const aspect = w / h;
  const gw = Math.max(4, Math.round(cells * Math.sqrt(aspect)));
  const gh = Math.max(4, Math.round(cells / Math.sqrt(aspect)));

  const src = document.createElement('canvas');
  src.width = gw;
  src.height = gh;
  const sctx = src.getContext('2d');
  if (!sctx) return;

  const img = sctx.createImageData(gw, gh);
  const px = img.data;
  for (let i = 0; i < gw * gh; i++) {
    const v = rng.next();
    // Signed around mid grey: the field both lifts and drops the base tone.
    const tone = v < 0.5 ? 0 : 255;
    px[i * 4] = tone;
    px[i * 4 + 1] = tone;
    px[i * 4 + 2] = tone;
    px[i * 4 + 3] = Math.round(Math.abs(v - 0.5) * 2 * 255);
  }
  sctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // Bilinear upscale is what turns the lattice into a smooth field.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = strength;
  ctx.drawImage(src, x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * A roller shutter across a bay that is not in service.
 *
 * Slats across the opening with the guide rails either side, dropped to the
 * floor and padlocked. Painted into the bake because it never moves — a bay
 * being commissioned is a level change, not something that happens mid-frame.
 */
function paintShutter(
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  x0: number,
  y0: number,
  width: number,
  depth: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, width, depth);
  ctx.clip();

  ctx.fillStyle = '#3c4147';
  ctx.fillRect(x0, y0, width, depth);

  // Slats run across the opening, seen end-on from above.
  const pitch = 30;
  for (let y = y0; y < y0 + depth; y += pitch) {
    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    ctx.fillRect(x0, y, width, pitch * 0.42);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(x0, y + pitch * 0.72, width, pitch * 0.28);
  }

  // Guide rails.
  ctx.fillStyle = '#23272c';
  ctx.fillRect(x0, y0, 24, depth);
  ctx.fillRect(x0 + width - 24, y0, 24, depth);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 + 6, y0, 5, depth);
  ctx.fillRect(x0 + width - 18, y0, 5, depth);

  // Bottom rail, resting on the slab, with a hasp and padlock at the centre.
  ctx.fillStyle = '#1b1f23';
  ctx.fillRect(x0, y0 + depth - 30, width, 30);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(x0, y0 + depth - 30, width, 5);
  ctx.fillStyle = '#2e3339';
  ctx.fillRect(x0 + width / 2 - 26, y0 + depth - 42, 52, 30);
  ctx.strokeStyle = '#9aa3ad';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x0 + width / 2, y0 + depth - 34, 9, Math.PI, TAU);
  ctx.stroke();
  ctx.fillStyle = '#6e7681';
  ctx.fillRect(x0 + width / 2 - 11, y0 + depth - 34, 22, 17);

  // Grime and rust streaks — nothing has opened this in a while.
  for (let i = 0; i < 22; i++) {
    ctx.globalAlpha = rng.range(0.05, 0.20);
    ctx.fillStyle = rng.chance(0.55) ? '#14171a' : '#6b4622';
    const w = rng.range(6, 26);
    ctx.fillRect(rng.range(x0, x0 + width), y0, w, rng.range(depth * 0.3, depth));
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
