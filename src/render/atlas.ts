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

export const ATLAS_SIZE = 2048;

/**
 * How the robot is laid out inside its atlas cell. The art is drawn larger
 * than the hull so it stays sharp at close zoom; renderers convert hull size
 * to sprite size with these.
 */
export const BOT_ART = { cell: 256, halfLength: 110, halfWidth: 76 } as const;

/**
 * Crate art occupies this fraction of its cell, so a quad drawn at
 * footprint / CRATE_ART_FILL shows a crate of exactly that footprint.
 */
export const CRATE_ART_FILL = 0.80;

const CELLS = {
  /** Soft radial falloff — light pools. */
  radial: [0, 0, 256, 256],
  /** Soft-edged rectangle — daylight shafts from the roof glazing. */
  shaft: [256, 0, 256, 256],
  /** Structural column, viewed from above. */
  column: [512, 0, 256, 256],
  /** Soft blob — the long shadow an object throws. */
  blockShadow: [768, 0, 256, 256],
  /** Tight, hard-edged darkening right under an object, so it sits on the floor. */
  hardShadow: [1024, 0, 256, 256],
  /** Forward-facing headlight cone. */
  cone: [1280, 0, 256, 256],
  /** Selection ring. */
  ring: [1536, 0, 256, 256],
  /** Destination marker. */
  marker: [1792, 0, 256, 256],

  /** Soft dot for order trails. */
  dot: [0, 256, 256, 256],
  /** Ground robot, emissive parts only. */
  botGlow: [256, 256, 256, 256],
  /** Abandoned timber crate. */
  crateTimber: [512, 256, 256, 256],
  /** Abandoned steel box. */
  crateSteel: [768, 256, 256, 256],
  /** Stack of pallets. */
  palletStack: [1024, 256, 256, 256],

  /** Loader arm, stowed at the cell's left edge, extending towards +x. */
  botArm: [1280, 256, 256, 256],

  /** Trailer interior, roof off. Stretched to the trailer's real proportions. */
  trailerDeck: [1024, 512, 256, 256],
  /** One rear door leaf, hinged at the left edge of its cell. */
  trailerDoor: [1280, 512, 256, 256],

  /** Ground robot body. Four frames, tracks advanced a quarter pitch each. */
  botBody0: [0, 512, 256, 256],
  botBody1: [256, 512, 256, 256],
  botBody2: [512, 512, 256, 256],
  botBody3: [768, 512, 256, 256],
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
  drawHardShadow(ctx);
  for (let frame = 0; frame < 4; frame++) drawBotBody(ctx, makeRng(seed ^ 0x4a71), frame);
  drawBotGlow(ctx);
  drawBotArm(ctx);
  drawTrailerDeck(ctx, rng);
  drawTrailerDoor(ctx);
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

/**
 * Structural column seen from above.
 *
 * Drawn as one solid box section on a grouted base plate, rather than the
 * separate flanges-and-web of an H: from directly overhead that read as seven
 * loose squares stuck together. The heavy dark line right around the base plate
 * is what makes it sit ON the slab instead of hovering over it.
 */
function drawColumn(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'column');
  const plate = size * 0.78;
  const ph = plate / 2;
  const col = size * 0.44;
  const ch = col / 2;

  // A thin grout skirt, squared to the plate. It used to be a wobbly circle,
  // which read as a mysterious disc under every column.
  ctx.fillStyle = '#6a6b66';
  ctx.beginPath();
  ctx.roundRect(-ph - 7, -ph - 7, plate + 14, plate + 14, 5);
  ctx.fill();

  // Base plate.
  ctx.fillStyle = '#798085';
  ctx.beginPath();
  ctx.roundRect(-ph, -ph, plate, plate, 4);
  ctx.fill();
  // Hard edge all the way round: the grounding cue.
  ctx.strokeStyle = 'rgba(10,12,14,0.85)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(-ph, -ph, plate, plate, 4);
  ctx.stroke();
  // Light catches the top-left lip of the plate.
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-ph + 2, ph - 3);
  ctx.lineTo(-ph + 2, -ph + 2);
  ctx.lineTo(ph - 3, -ph + 2);
  ctx.stroke();

  // Holding-down bolts, one at each corner of the plate.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bx = sx * (ph - 15);
      const by = sy * (ph - 15);
      ctx.fillStyle = 'rgba(8,10,12,0.55)';
      ctx.beginPath();
      ctx.arc(bx + 2, by + 2, 8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#575e63';
      ctx.beginPath();
      ctx.arc(bx, by, 8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.arc(bx - 2, by - 2, 4, 0, TAU);
      ctx.fill();
    }
  }

  // Occlusion in the corner where the section meets the plate.
  const ao = ctx.createRadialGradient(0, 0, ch * 0.8, 0, 0, ch * 1.75);
  ao.addColorStop(0, 'rgba(6,8,10,0.6)');
  ao.addColorStop(1, 'rgba(6,8,10,0)');
  ctx.fillStyle = ao;
  ctx.fillRect(-ph, -ph, plate, plate);

  // The section itself: one solid piece, lit from the top-left.
  const face = ctx.createLinearGradient(-ch, -ch, ch, ch);
  face.addColorStop(0, '#aab2b8');
  face.addColorStop(0.5, '#848c92');
  face.addColorStop(1, '#5a6167');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.roundRect(-ch, -ch, col, col, 7);
  ctx.fill();

  // Top face highlight and the dark side, which give it height.
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(-ch + 4, ch - 5);
  ctx.lineTo(-ch + 4, -ch + 4);
  ctx.lineTo(ch - 5, -ch + 4);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(8,10,12,0.55)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(ch - 4, -ch + 5);
  ctx.lineTo(ch - 4, ch - 4);
  ctx.lineTo(-ch + 5, ch - 4);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(12,14,16,0.8)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(-ch, -ch, col, col, 7);
  ctx.stroke();

  // Weld seam down the visible corner, and wear.
  ctx.strokeStyle = 'rgba(160,168,174,0.3)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-ch + 10, -ch + 10);
  ctx.lineTo(-ch + 10, ch - 10);
  ctx.stroke();

  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = rng.range(0.07, 0.28);
    ctx.fillStyle = rng.chance(0.5) ? '#7a4520' : '#5c3116';
    const inCol = rng.chance(0.45);
    const reach = inCol ? ch : ph;
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-reach, reach), rng.range(-reach, reach),
      rng.range(4, 15), rng.range(3, 12), rng.range(0, TAU), 0, TAU,
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
 * Ground robot, seen from above and pointing +x.
 *
 * Built around the load it carries: the deck has to take a 120 x 80 Euro pallet
 * with handling clearance, which is what sets the machine at 240 x 150 cm. The
 * loader arms live in recesses down each flank and reach out behind.
 */
function drawBotBody(
  ctx: CanvasRenderingContext2D,
  rng: ReturnType<typeof makeRng>,
  frame: number,
): void {
  cell(ctx, ('botBody' + frame) as SpriteName);
  const L = BOT_ART.halfLength;
  const W = BOT_ART.halfWidth;

  // Tracks down both flanks.
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#1c2025';
    ctx.beginPath();
    ctx.roundRect(-L + 4, side * W - 30, L * 2 - 20, 60, 15);
    ctx.fill();
    ctx.fillStyle = '#4e565e';
    ctx.beginPath();
    ctx.roundRect(-L + 11, side * W - 22, L * 2 - 34, 44, 11);
    ctx.fill();

    // Track links advance a quarter pitch per frame; that is what makes the
    // machine look like it is driving rather than sliding.
    const pitch = 24;
    const offset = (frame / 4) * pitch;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-L + 11, side * W - 22, L * 2 - 34, 44, 11);
    ctx.clip();
    ctx.strokeStyle = 'rgba(10,12,15,0.62)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    for (let x = -L - pitch + offset; x < L + pitch; x += pitch) {
      ctx.moveTo(x, side * W - 22);
      ctx.lineTo(x, side * W + 22);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = -L - pitch + offset + 6; x < L + pitch; x += pitch) {
      ctx.moveTo(x, side * W - 22);
      ctx.lineTo(x, side * W + 22);
    }
    ctx.stroke();
    ctx.restore();

    // Drive sprocket at the front, idler at the back.
    for (const px of [-L + 20, L - 32]) {
      ctx.fillStyle = '#333b42';
      ctx.beginPath();
      ctx.arc(px, side * W, 15, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.arc(px - 3, side * W - 3, 7, 0, TAU);
      ctx.fill();
    }
  }

  // Chassis, chamfered at the nose so heading is obvious from above.
  ctx.beginPath();
  ctx.moveTo(-L + 8, -W + 16);
  ctx.lineTo(L - 40, -W + 16);
  ctx.lineTo(L, -W + 52);
  ctx.lineTo(L, W - 52);
  ctx.lineTo(L - 40, W - 16);
  ctx.lineTo(-L + 8, W - 16);
  ctx.closePath();
  ctx.fillStyle = '#a8b0b7';
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.75)';
  ctx.lineWidth = 6;
  ctx.stroke();

  // The deck. Sized for a Euro pallet with room to set it down.
  const deckX0 = -L + 16;
  const deckLen = 132;
  const deckHalf = W - 30;
  ctx.fillStyle = '#6a727a';
  ctx.beginPath();
  ctx.roundRect(deckX0, -deckHalf, deckLen, deckHalf * 2, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(16,18,20,0.6)';
  ctx.lineWidth = 5;
  ctx.stroke();
  // Roller bed running the length of the deck.
  ctx.strokeStyle = 'rgba(20,23,26,0.45)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let x = deckX0 + 14; x < deckX0 + deckLen - 6; x += 17) {
    ctx.moveTo(x, -deckHalf + 7);
    ctx.lineTo(x, deckHalf - 7);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(deckX0, -deckHalf, deckLen, 8);

  // Arm recesses down each flank, so the stowed arms have somewhere to live.
  ctx.fillStyle = 'rgba(24,28,32,0.75)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.roundRect(-L + 12, side * (W - 26) - 8, 96, 16, 5);
    ctx.fill();
  }

  // Hazard flashes on the shoulders.
  ctx.fillStyle = '#d8a92f';
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(-L + 26 + i * 26, -W + 18, 15, 12);
    ctx.fillRect(-L + 26 + i * 26, W - 30, 15, 12);
  }

  // Sensor head at the nose.
  ctx.fillStyle = '#3a4148';
  ctx.beginPath();
  ctx.roundRect(L - 72, -34, 62, 68, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.7)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Wear.
  for (let i = 0; i < 18; i++) {
    ctx.globalAlpha = rng.range(0.05, 0.18);
    ctx.fillStyle = rng.chance(0.55) ? '#7a4520' : '#23262a';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-L, L), rng.range(-W, W),
      rng.range(4, 14), rng.range(3, 11), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * One loader arm: a boom with a gripper pad on the end, drawn along +x from the
 * left edge of its cell so the renderer can stretch it to whatever extension
 * the grab animation has reached.
 */
function drawBotArm(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'botArm');
  const half = size / 2;

  ctx.fillStyle = '#5c646b';
  ctx.beginPath();
  ctx.roundRect(-half + 6, -13, size - 40, 26, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(-half + 6, -13, size - 40, 7);
  ctx.strokeStyle = 'rgba(14,16,18,0.75)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(-half + 6, -13, size - 40, 26, 7);
  ctx.stroke();

  // Slide rail down the middle of the boom.
  ctx.strokeStyle = 'rgba(20,23,26,0.5)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-half + 14, 0);
  ctx.lineTo(half - 40, 0);
  ctx.stroke();

  // Shoulder pivot.
  ctx.fillStyle = '#3d444b';
  ctx.beginPath();
  ctx.arc(-half + 14, 0, 17, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(-half + 10, -4, 7, 0, TAU);
  ctx.fill();

  // Gripper pad at the far end.
  ctx.fillStyle = '#2b3137';
  ctx.beginPath();
  ctx.roundRect(half - 44, -30, 26, 60, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(12,14,16,0.8)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#15181b';
  ctx.fillRect(half - 24, -26, 10, 52);
  ctx.fillStyle = '#d8a92f';
  ctx.fillRect(half - 44, -30, 26, 5);
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
  const h = size * 0.40;

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

/**
 * A tight, comparatively hard-edged shadow. Objects were reading as floating
 * because their only shadow was a wide soft blob; real contact needs a dark
 * core with a short penumbra directly beneath.
 */
function drawHardShadow(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'hardShadow');
  const half = size / 2;
  // A rounded rectangle with only a short penumbra. Crates and columns are
  // boxes, so a soft circular blob under one reads as a smudge rather than as
  // that object's shadow.
  const steps = 7;
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const r = half * (0.80 + t * 0.20);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(-r, -r, r * 2, r * 2, r * 0.20);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Trailer interior seen from above with the roof off, matching how the hall
 * itself is drawn. Authored to be stretched along its length: the decking and
 * the side walls both run that way, so distortion does not show.
 */
function drawTrailerDeck(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'trailerDeck');
  const h = size / 2;

  // Body shell, just proud of the interior.
  ctx.fillStyle = '#2c3238';
  ctx.fillRect(-h, -h, size, size);

  // Worn hardwood decking, planks running the length.
  ctx.fillStyle = '#5e5138';
  ctx.fillRect(-h + 16, -h, size - 32, size);
  ctx.strokeStyle = 'rgba(30,24,16,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = -h + 30; x < h - 16; x += 15) {
    ctx.moveTo(x, -h);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  // Ribbed side walls.
  ctx.fillStyle = '#3d444a';
  ctx.fillRect(-h, -h, 16, size);
  ctx.fillRect(h - 16, -h, 16, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let y = -h; y < h; y += 13) {
    ctx.moveTo(-h, y);
    ctx.lineTo(-h + 16, y);
    ctx.moveTo(h - 16, y);
    ctx.lineTo(h, y);
  }
  ctx.stroke();

  // Load restraint rails down each side.
  ctx.fillStyle = 'rgba(190,196,200,0.22)';
  ctx.fillRect(-h + 20, -h, 5, size);
  ctx.fillRect(h - 25, -h, 5, size);

  // Grime and scuffing from years of pallets.
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = rng.range(0.05, 0.2);
    ctx.fillStyle = rng.chance(0.5) ? '#241d13' : '#7a4520';
    ctx.beginPath();
    ctx.ellipse(
      rng.range(-h, h), rng.range(-h, h),
      rng.range(6, 26), rng.range(4, 18), rng.range(0, TAU), 0, TAU,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * One rear door leaf. Hinged at the LEFT edge of the cell and extending to +x,
 * so the renderer can pivot it about that edge to swing it open.
 */
function drawTrailerDoor(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'trailerDoor');
  const h = size / 2;
  const thick = size * 0.17;

  ctx.fillStyle = '#454c53';
  ctx.beginPath();
  ctx.roundRect(-h, -thick / 2, size, thick, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.fillRect(-h, -thick / 2, size, 7);
  ctx.strokeStyle = 'rgba(12,14,17,0.8)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(-h, -thick / 2, size, thick, 5);
  ctx.stroke();

  // Locking bars running the height of the leaf.
  ctx.strokeStyle = 'rgba(20,23,26,0.55)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  for (const x of [-h + size * 0.3, -h + size * 0.62]) {
    ctx.moveTo(x, -thick / 2 + 5);
    ctx.lineTo(x, thick / 2 - 5);
  }
  ctx.stroke();

  // Hinge knuckle at the pivot end.
  ctx.fillStyle = '#2b3137';
  ctx.beginPath();
  ctx.roundRect(-h, -thick * 0.62, 16, thick * 1.24, 4);
  ctx.fill();

  // Handle at the free end.
  ctx.fillStyle = '#8d9299';
  ctx.fillRect(h - 26, -thick * 0.2, 12, thick * 0.4);
  ctx.restore();
}
