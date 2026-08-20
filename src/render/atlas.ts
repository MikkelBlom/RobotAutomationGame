import { makeRng, TAU } from '../core/mathUtils';

/**
 * One procedurally drawn texture atlas for every sprite in the game. Sprites
 * are authored large (256px for a ~64-unit robot) so they stay crisp when the
 * camera is zoomed in.
 */

export interface Region {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export const ATLAS_SIZE = 1024;

/**
 * How the robot is laid out inside its atlas cell. The art is drawn larger
 * than the hull so it stays sharp at close zoom; renderers convert hull size
 * to sprite size with these.
 */
export const BOT_ART = { cell: 256, halfLength: 100, halfWidth: 72 } as const;

const CELLS = {
  /** Soft radial falloff — light pools and contact shadows. */
  radial: [0, 0, 256, 256],
  /** Soft-edged rectangle — daylight shafts from the roof glazing. */
  shaft: [256, 0, 256, 256],
  /** Structural column, viewed from above. */
  column: [512, 0, 256, 256],
  /** Squarish soft blob — shadow cast by a column. */
  blockShadow: [768, 0, 256, 256],
  /** Ground robot, unlit colour. */
  botBody: [0, 256, 256, 256],
  /** Ground robot, emissive parts only. */
  botGlow: [256, 256, 256, 256],
  /** Forward-facing headlight cone. */
  cone: [512, 256, 256, 256],
  /** Selection ring. */
  ring: [768, 256, 256, 256],
  /** Soft dot for order trails. */
  dot: [0, 512, 128, 128],
  /** Destination marker. */
  marker: [128, 512, 128, 128],
  /** Abandoned timber crate. */
  crateTimber: [256, 512, 256, 256],
  /** Abandoned steel box. */
  crateSteel: [512, 512, 256, 256],
  /** Stack of pallets. */
  palletStack: [768, 512, 256, 256],
} as const;

export type SpriteName = keyof typeof CELLS;

export const REGIONS = {} as Record<SpriteName, Region>;
for (const [name, [x, y, w, h]] of Object.entries(CELLS)) {
  // Half-texel inset stops neighbouring cells bleeding in under linear filtering.
  const inset = 0.5;
  REGIONS[name as SpriteName] = {
    u0: (x + inset) / ATLAS_SIZE,
    v0: (y + inset) / ATLAS_SIZE,
    u1: (x + w - inset) / ATLAS_SIZE,
    v1: (y + h - inset) / ATLAS_SIZE,
  };
}

function cell(ctx: CanvasRenderingContext2D, name: SpriteName): { size: number } {
  const [x, y, w, h] = CELLS[name];
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  return { size: w };
}

export function buildAtlas(seed: number): HTMLCanvasElement {
  const rng = makeRng(seed ^ 0x4a71);
  const cv = document.createElement('canvas');
  cv.width = ATLAS_SIZE;
  cv.height = ATLAS_SIZE;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for atlas');
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  drawRadial(ctx);
  drawShaft(ctx);
  drawColumn(ctx, rng);
  drawBlockShadow(ctx);
  drawBotBody(ctx, rng);
  drawBotGlow(ctx);
  drawCone(ctx);
  drawRing(ctx);
  drawDot(ctx);
  drawMarker(ctx);
  drawCrateTimber(ctx, rng);
  drawCrateSteel(ctx, rng);
  drawPalletStack(ctx, rng);

  return cv;
}

function drawRadial(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'radial');
  const r = size / 2;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.62)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.20)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** A shaft of daylight: bright core, soft shoulders, with glazing bars across it. */
function drawShaft(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'shaft');
  const half = size / 2;

  const across = ctx.createLinearGradient(-half, 0, half, 0);
  across.addColorStop(0.0, 'rgba(255,255,255,0)');
  across.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  across.addColorStop(0.5, 'rgba(255,255,255,1)');
  across.addColorStop(0.78, 'rgba(255,255,255,0.85)');
  across.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = across;
  ctx.fillRect(-half, -half, size, size);

  // Fade the ends so a pool does not stop with a straight edge.
  ctx.globalCompositeOperation = 'destination-in';
  const along = ctx.createLinearGradient(0, -half, 0, half);
  along.addColorStop(0.0, 'rgba(0,0,0,0)');
  along.addColorStop(0.18, 'rgba(0,0,0,0.9)');
  along.addColorStop(0.82, 'rgba(0,0,0,0.9)');
  along.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = along;
  ctx.fillRect(-half, -half, size, size);

  // Glazing bars read as dark ribs crossing the pool.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  for (let y = -half + 26; y < half; y += 42) {
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawColumn(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'column');
  const s = size * 0.60;
  const h = s / 2;

  // Grouted base plate, wider than the section and slightly irregular.
  ctx.fillStyle = '#585e63';
  ctx.beginPath();
  ctx.roundRect(-h - 22, -h - 22, s + 44, s + 44, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(16,18,20,0.6)';
  ctx.lineWidth = 4;
  ctx.stroke();
  // Holding-down bolts.
  ctx.fillStyle = '#33383c';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * (h + 11), sy * (h + 11), 6, 0, TAU);
      ctx.fill();
    }
  }

  // An H-section seen end-on: two flanges and a web, which reads far more like
  // structural steel from above than a plain filled square.
  const flange = s * 0.26;
  const grad = ctx.createLinearGradient(-h, -h, h, h);
  grad.addColorStop(0, '#a3acb3');
  grad.addColorStop(0.45, '#7d868d');
  grad.addColorStop(1, '#5b6369');
  ctx.fillStyle = grad;
  ctx.fillRect(-h, -h, s, flange);
  ctx.fillRect(-h, h - flange, s, flange);
  ctx.fillRect(-s * 0.16, -h, s * 0.32, s);

  // Top-face highlight on the light side, contact dark on the other.
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(-h, -h, s, 7);
  ctx.fillRect(-s * 0.16, -h, 7, s);
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  ctx.fillRect(-h, h - 7, s, 7);
  ctx.fillRect(s * 0.16 - 7, -h, 7, s);

  ctx.strokeStyle = 'rgba(14,16,18,0.75)';
  ctx.lineWidth = 4;
  ctx.strokeRect(-h, -h, s, flange);
  ctx.strokeRect(-h, h - flange, s, flange);
  ctx.strokeRect(-s * 0.16, -h, s * 0.32, s);

  // Rust and dirt.
  for (let i = 0; i < 22; i++) {
    ctx.globalAlpha = rng.range(0.08, 0.3);
    ctx.fillStyle = rng.chance(0.5) ? '#7a4520' : '#5c3116';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-h, h), rng.range(-h, h),
      rng.range(4, 16), rng.range(4, 14), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawBlockShadow(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'blockShadow');
  const half = size / 2;
  // A rounded square with a soft edge — closer to a real column's penumbra
  // than a circle, but still soft enough not to read as a hard cut-out.
  for (let i = 12; i >= 0; i--) {
    const t = i / 12;
    const r = half * (0.42 + t * 0.58);
    ctx.globalAlpha = 0.11 * (1 - t) + 0.02;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(-r, -r, r * 2, r * 2, r * 0.42);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Ground robot, seen from above and pointing +x. Tracked chassis, cargo deck,
 * sensor head. Drawn at high resolution so it survives close zoom.
 */
function drawBotBody(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  cell(ctx, 'botBody');
  // Authored in a 256-wide cell for a robot 64 long x 46 wide -> scale to fit.
  const L = 100; // half-length in cell units
  const W = 72; // half-width

  // Tracks along both flanks.
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#20242a';
    ctx.beginPath();
    ctx.roundRect(-L + 4, side * W - 26, L * 2 - 8, 52, 14);
    ctx.fill();
    ctx.fillStyle = '#454c54';
    ctx.beginPath();
    ctx.roundRect(-L + 10, side * W - 19, L * 2 - 20, 38, 10);
    ctx.fill();
    // Track links.
    ctx.strokeStyle = 'rgba(12,14,16,0.55)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let x = -L + 20; x < L - 16; x += 20) {
      ctx.moveTo(x, side * W - 18);
      ctx.lineTo(x, side * W + 18);
    }
    ctx.stroke();
  }

  // Chassis: chamfered nose so heading is obvious from above.
  ctx.beginPath();
  ctx.moveTo(-L + 6, -W + 12);
  ctx.lineTo(L - 34, -W + 12);
  ctx.lineTo(L, -W + 44);
  ctx.lineTo(L, W - 44);
  ctx.lineTo(L - 34, W - 12);
  ctx.lineTo(-L + 6, W - 12);
  ctx.closePath();
  ctx.fillStyle = '#949aa1';
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.75)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Recessed cargo deck.
  ctx.fillStyle = '#6d747b';
  ctx.beginPath();
  ctx.roundRect(-L + 22, -W + 28, 108, (W - 28) * 2, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.5)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.fillRect(-L + 22, -W + 28, 108, 9);

  // Hazard flashes on the shoulders.
  ctx.fillStyle = '#c79a2c';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(-L + 28 + i * 22, -W + 14, 13, 11);
    ctx.fillRect(-L + 28 + i * 22, W - 25, 13, 11);
  }

  // Sensor head at the nose.
  ctx.fillStyle = '#3a4148';
  ctx.beginPath();
  ctx.roundRect(L - 62, -30, 54, 60, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.7)';
  ctx.lineWidth = 4;
  ctx.stroke();

  // Wear.
  for (let i = 0; i < 16; i++) {
    ctx.globalAlpha = rng.range(0.06, 0.2);
    ctx.fillStyle = rng.chance(0.55) ? '#7a4520' : '#23262a';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-L, L), rng.range(-W, W),
      rng.range(3, 12), rng.range(3, 10), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Only the parts that emit: lens, beacon, deck strip. Added after lighting. */
function drawBotGlow(ctx: CanvasRenderingContext2D): void {
  cell(ctx, 'botGlow');
  const L = 100;

  // Forward lens.
  const lens = ctx.createRadialGradient(L - 34, 0, 0, L - 34, 0, 26);
  lens.addColorStop(0, 'rgba(255,214,150,1)');
  lens.addColorStop(0.4, 'rgba(255,150,60,0.75)');
  lens.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = lens;
  ctx.beginPath();
  ctx.arc(L - 34, 0, 26, 0, TAU);
  ctx.fill();

  // Roof beacon.
  const beacon = ctx.createRadialGradient(-56, 0, 0, -56, 0, 24);
  beacon.addColorStop(0, 'rgba(255,206,120,1)');
  beacon.addColorStop(0.45, 'rgba(255,170,60,0.6)');
  beacon.addColorStop(1, 'rgba(255,150,40,0)');
  ctx.fillStyle = beacon;
  ctx.beginPath();
  ctx.arc(-56, 0, 24, 0, TAU);
  ctx.fill();

  // Status strip down the deck.
  ctx.fillStyle = 'rgba(120,230,255,0.55)';
  ctx.fillRect(-30, -5, 74, 10);
  ctx.restore();
}

/** Headlight cone, apex at the cell centre, opening towards +x. */
function drawCone(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'cone');
  const half = size / 2;
  const grad = ctx.createLinearGradient(-half, 0, half, 0);
  grad.addColorStop(0.0, 'rgba(255,232,190,0.95)');
  grad.addColorStop(0.45, 'rgba(255,214,150,0.42)');
  grad.addColorStop(1.0, 'rgba(255,200,130,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(-half + 8, 0);
  ctx.lineTo(half, -half * 0.82);
  ctx.lineTo(half, half * 0.82);
  ctx.closePath();
  ctx.fill();

  // Soften the hard edges of the wedge.
  ctx.globalCompositeOperation = 'destination-in';
  const soft = ctx.createLinearGradient(0, -half, 0, half);
  soft.addColorStop(0.0, 'rgba(0,0,0,0)');
  soft.addColorStop(0.3, 'rgba(0,0,0,1)');
  soft.addColorStop(0.7, 'rgba(0,0,0,1)');
  soft.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = soft;
  ctx.fillRect(-half, -half, size, size);
  ctx.restore();
}

function drawRing(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'ring');
  const r = size / 2 - 14;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 9;
  // Bracket corners rather than a full circle — reads as a selection reticle.
  for (let i = 0; i < 4; i++) {
    const a0 = i * (TAU / 4) + 0.36;
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a0 + TAU / 4 - 0.72);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDot(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'dot');
  const r = size / 2;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawMarker(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'marker');
  const r = size / 2 - 10;
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, TAU);
  ctx.stroke();
  ctx.lineWidth = 5;
  for (let i = 0; i < 4; i++) {
    const a = i * (TAU / 4);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 0.78, Math.sin(a) * r * 0.78);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Weathered timber crate, lid boards facing up. */
function drawCrateTimber(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'crateTimber');
  const h = size * 0.40;

  ctx.fillStyle = '#6f5936';
  ctx.beginPath();
  ctx.roundRect(-h, -h, h * 2, h * 2, 5);
  ctx.fill();

  // Lid boards with gaps between them.
  const boards = 5;
  const bw = (h * 2 - 10) / boards;
  for (let i = 0; i < boards; i++) {
    const shade = 0.86 + rng.next() * 0.28;
    ctx.fillStyle = `rgb(${Math.round(133 * shade)},${Math.round(106 * shade)},${Math.round(63 * shade)})`;
    ctx.fillRect(-h + 5 + i * bw, -h + 5, bw - 3, h * 2 - 10);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(-h + 5 + i * bw, -h + 5, bw - 3, 4);
  }

  // Corner banding.
  ctx.strokeStyle = 'rgba(58,45,26,0.85)';
  ctx.lineWidth = 7;
  ctx.strokeRect(-h + 4, -h + 4, h * 2 - 8, h * 2 - 8);
  ctx.strokeStyle = 'rgba(120,110,96,0.5)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-h + 14, -h + 4);
  ctx.lineTo(-h + 14, h - 4);
  ctx.moveTo(h - 14, -h + 4);
  ctx.lineTo(h - 14, h - 4);
  ctx.stroke();

  // Grime and damage.
  for (let i = 0; i < 22; i++) {
    ctx.globalAlpha = rng.range(0.06, 0.24);
    ctx.fillStyle = rng.chance(0.5) ? '#2c2418' : '#7a4520';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-h, h), rng.range(-h, h),
      rng.range(4, 18), rng.range(3, 13), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Steel transit box, ribbed lid. */
function drawCrateSteel(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'crateSteel');
  const h = size * 0.38;

  ctx.fillStyle = '#4d565c';
  ctx.beginPath();
  ctx.roundRect(-h, -h, h * 2, h * 2, 8);
  ctx.fill();
  ctx.fillStyle = '#5d676e';
  ctx.beginPath();
  ctx.roundRect(-h + 7, -h + 7, h * 2 - 14, h * 2 - 14, 5);
  ctx.fill();

  // Ribs.
  ctx.strokeStyle = 'rgba(22,26,29,0.55)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let y = -h + 22; y < h - 12; y += 22) {
    ctx.moveTo(-h + 12, y);
    ctx.lineTo(h - 12, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let y = -h + 25; y < h - 12; y += 22) {
    ctx.moveTo(-h + 12, y);
    ctx.lineTo(h - 12, y);
  }
  ctx.stroke();

  // Latches at the corners.
  ctx.fillStyle = '#2b3135';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(sx * (h - 20) - 8, sy * (h - 20) - 8, 16, 16, 3);
      ctx.fill();
    }
  }

  ctx.strokeStyle = 'rgba(16,19,21,0.7)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-h, -h, h * 2, h * 2);

  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = rng.range(0.08, 0.3);
    ctx.fillStyle = rng.chance(0.65) ? '#7a4520' : '#5c3116';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-h, h), rng.range(-h, h),
      rng.range(4, 16), rng.range(3, 12), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** A short stack of empty pallets. */
function drawPalletStack(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'palletStack');
  const h = size * 0.40;

  // Two slightly misaligned layers, so it reads as stacked.
  for (let layer = 0; layer < 2; layer++) {
    ctx.save();
    ctx.translate(rng.range(-7, 7), rng.range(-7, 7));
    ctx.rotate(rng.range(-0.06, 0.06));
    ctx.fillStyle = layer === 0 ? '#4f4028' : '#5d4c31';
    ctx.fillRect(-h, -h, h * 2, h * 2);
    ctx.fillStyle = layer === 0 ? '#6b5836' : '#7b6740';
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(-h + 4, -h + 6 + i * ((h * 2 - 12) / 5), h * 2 - 8, (h * 2 - 12) / 5 - 6);
    }
    ctx.strokeStyle = 'rgba(30,24,14,0.6)';
    ctx.lineWidth = 4;
    ctx.strokeRect(-h, -h, h * 2, h * 2);
    ctx.restore();
  }

  for (let i = 0; i < 18; i++) {
    ctx.globalAlpha = rng.range(0.06, 0.22);
    ctx.fillStyle = '#2c2418';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-h, h), rng.range(-h, h),
      rng.range(4, 16), rng.range(3, 12), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
