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
export const BOT_ART = {
  cell: 256,
  halfLength: 110,
  halfWidth: 76,
  /**
   * The charge gauge recess, in art units from the hull centre.
   *
   * Baked into the body sprite rather than drawn over it. A lit bar laid on top
   * of a robot is a health bar; a lit bar sitting in a machined slot that is
   * shaded and worn along with the rest of the hull is an instrument.
   */
  gauge: { x: 36, halfLen: 33, halfWide: 11 },
} as const;

/**
 * Crate art occupies this fraction of its cell, so a quad drawn at
 * footprint / CRATE_ART_FILL shows a crate of exactly that footprint.
 */
export const CRATE_ART_FILL = 0.80;

/**
 * How much of its square cell each crate shape's art occupies.
 *
 * A 1x2 is drawn at its true 1:2 aspect inside the square cell, so the renderer
 * can use a square quad and the art is never stretched — the alternative was
 * squashing a 1x1's planks to fake a longer box.
 */
export const CRATE_FILL: Record<number, { w: number; h: number }> = {
  0: { w: 0.80, h: 0.80 },
  1: { w: 0.40, h: 0.80 },
  2: { w: 0.80, h: 0.80 },
};

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

  /** 1x2 and 2x2 crates. Authored at their own aspect inside a square cell. */
  crateTimberLong: [0, 768, 256, 256],
  crateTimberLarge: [256, 768, 256, 256],
  crateSteelLong: [512, 768, 256, 256],
  crateSteelLarge: [768, 768, 256, 256],
  /** Square bracket outline: marks a targeted crate or a ghosted drop slot. */
  crateOutline: [1024, 768, 256, 256],

  /** Trailer interior, roof off. Stretched to the trailer's real proportions. */
  trailerDeck: [1024, 512, 256, 256],
  /** One rear door leaf, hinged at the left edge of its cell. */
  trailerDoor: [1280, 512, 256, 256],

  /** Dispatch plate beside a loading bay. */
  dockPlate: [1280, 768, 256, 256],
  /** Armoured cable, running the full cell width so runs can be butted. */
  plateWire: [1536, 768, 256, 256],
  /** Warning beacon housing, unlit. */
  warnLamp: [1792, 768, 256, 256],
  /** The beacon's lens, for the emissive pass. */
  warnGlow: [0, 1024, 256, 256],

  /** Charge readout on a robot's deck. Tinted and scaled at draw time. */
  chargeStrip: [1280, 1024, 256, 256],

  /** Charging coupler, stowed at the cell's right edge and reaching towards -x. */
  chargeArm: [1536, 1024, 256, 256],
  /** A single arc, struck from the coupler head towards -x. */
  spark: [1792, 1024, 256, 256],

  /** Charging cabinet, live. Connector faces +x. */
  chargeDock: [256, 1024, 256, 256],
  /** The same cabinet still sealed from the factory. */
  chargeDockSealed: [512, 1024, 256, 256],
  /** Painted floor pad a robot backs onto. */
  chargePad: [768, 1024, 256, 256],
  /** Contact glow for a live point. */
  chargeGlow: [1024, 1024, 256, 256],

  /**
   * Shop floor tile, and a purchase point.
   *
   * Row 1792, not 1024: 1024 is full and these two silently landed on top of
   * chargeDockSealed and chargePad, so the upgrade room came out tiled with
   * sealed charging cabinets. Anything added here wants checking against the
   * map above first.
   */
  shopFloor: [0, 1792, 256, 256],
  shopPlate: [256, 1792, 256, 256],

  /** Digits and the few marks the quota board needs, 16 across. */
  glyphs: [0, 1280, 2048, 128],
  /** Quota board housing: bezel, dividers, mounting. Unlit. */
  quotaBoard: [0, 1408, 2048, 192],
  /** The board's lit face: screen wash and etched labels. Emissive. */
  quotaScreen: [0, 1600, 2048, 192],

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

function cell(
  ctx: CanvasRenderingContext2D, name: SpriteName,
): { size: number; w: number; h: number } {
  const [x, y, w, h] = CELLS[name];
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  return { size: w, w, h };
}

/**
 * Characters the board can display, in strip order.
 *
 * Deliberately just enough: counts, money, and a duration. Anything the board
 * cannot spell is something it has no business showing.
 */
export const GLYPHS = '0123456789.,$s/-';
const GLYPH_CELL = 128;

/** Sub-region of the glyph strip for one character, or null if unsupported. */
export function glyphRegion(ch: string): Region | null {
  const i = GLYPHS.indexOf(ch);
  if (i < 0) return null;
  const [sx, sy] = CELLS.glyphs;
  const inset = 0.5;
  return {
    u0: (sx + i * GLYPH_CELL + inset) / ATLAS_SIZE,
    v0: (sy + inset) / ATLAS_SIZE,
    u1: (sx + (i + 1) * GLYPH_CELL - inset) / ATLAS_SIZE,
    v1: (sy + GLYPH_CELL - inset) / ATLAS_SIZE,
  };
}

/**
 * Where each readout sits on the board, in atlas pixels from its centre.
 *
 * Shared with the renderer so the numbers land inside the panels the art has
 * already drawn for them — the two would drift apart if each guessed.
 */
export const BOARD_FIELDS = {
  shipped: { x: -690, y: 34, size: 104 },
  revenue: { x: 40, y: 34, size: 84 },
  average: { x: 730, y: 34, size: 84 },
} as const;
/** Atlas-pixel width of the board, so the renderer can work out its scale. */
export const BOARD_ART_WIDTH = 2048;
export const BOARD_ART_HEIGHT = 192;

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
  drawCrateVariants(ctx, seed);
  drawCrateOutline(ctx);
  drawChargeStrip(ctx);
  drawShopSurfaces(ctx, makeRng(seed ^ 0x3c19));
  drawChargeArm(ctx);
  drawSpark(ctx);
  drawChargeDock(ctx, false);
  drawChargeDock(ctx, true);
  drawChargePad(ctx, makeRng(seed ^ 0x2f19));
  drawChargeGlow(ctx);
  drawGlyphs(ctx);
  drawQuotaBoard(ctx);
  drawDockPlate(ctx, makeRng(seed ^ 0x71c3));
  drawPlateWire(ctx);
  drawWarnLamp(ctx);
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
  // Trimmed to open a strip of chassis between the deck and the sensor head for
  // the gauge. Still a Euro pallet's length with clearance.
  const deckLen = 118;
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
  ctx.roundRect(L - 58, -34, 50, 68, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(18,20,22,0.7)';
  ctx.lineWidth = 5;
  ctx.stroke();

  // Charge gauge recess. Cut into the chassis before the wear passes, so it
  // scuffs with everything else instead of sitting on top looking new.
  {
    const g = BOT_ART.gauge;
    ctx.fillStyle = '#2b3238';
    ctx.beginPath();
    ctx.roundRect(g.x - g.halfWide - 4, -g.halfLen - 4, (g.halfWide + 4) * 2, (g.halfLen + 4) * 2, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(210,220,228,0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // The slot itself, dark and slightly graded so it reads as a recess.
    const well = ctx.createLinearGradient(g.x - g.halfWide, 0, g.x + g.halfWide, 0);
    well.addColorStop(0, '#0b0d0f');
    well.addColorStop(0.55, '#15181c');
    well.addColorStop(1, '#0d1013');
    ctx.fillStyle = well;
    ctx.beginPath();
    ctx.roundRect(g.x - g.halfWide, -g.halfLen, g.halfWide * 2, g.halfLen * 2, 3);
    ctx.fill();
    // Segment ticks across the well, so an empty gauge still looks like one.
    ctx.strokeStyle = 'rgba(120,132,144,0.20)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 1; i < 5; i++) {
      const y = -g.halfLen + (i * g.halfLen * 2) / 5;
      ctx.moveTo(g.x - g.halfWide + 2, y);
      ctx.lineTo(g.x + g.halfWide - 2, y);
    }
    ctx.stroke();
  }

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

/** Timber and steel crates at 1x2 and 2x2, drawn at their real aspect. */
function drawCrateVariants(ctx: CanvasRenderingContext2D, seed: number): void {
  const variants: Array<[SpriteName, boolean, number, number]> = [
    ['crateTimberLong', false, 0.40, 0.80],
    ['crateTimberLarge', false, 0.80, 0.80],
    ['crateSteelLong', true, 0.40, 0.80],
    ['crateSteelLarge', true, 0.80, 0.80],
  ];
  for (let i = 0; i < variants.length; i++) {
    const [name, steel, fw, fh] = variants[i];
    const rng = makeRng(seed ^ (0x51a0 + i * 977));
    const { size } = cell(ctx, name);
    const w = size * fw;
    const h = size * fh;
    if (steel) paintSteelBox(ctx, rng, w, h);
    else paintTimberBox(ctx, rng, w, h);
    ctx.restore();
  }
}

function paintTimberBox(
  ctx: CanvasRenderingContext2D,
  rng: ReturnType<typeof makeRng>,
  w: number,
  h: number,
): void {
  const hw = w / 2;
  const hh = h / 2;
  ctx.fillStyle = '#6f5936';
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, w, h, 5);
  ctx.fill();

  // Lid boards run the long way, which is what makes the shape readable.
  const along = w >= h;
  const count = Math.max(4, Math.round((along ? h : w) / 22));
  for (let i = 0; i < count; i++) {
    const shade = 0.86 + rng.next() * 0.28;
    ctx.fillStyle = `rgb(${Math.round(133 * shade)},${Math.round(106 * shade)},${Math.round(63 * shade)})`;
    if (along) {
      const bh = (h - 10) / count;
      ctx.fillRect(-hw + 5, -hh + 5 + i * bh, w - 10, bh - 3);
    } else {
      const bw = (w - 10) / count;
      ctx.fillRect(-hw + 5 + i * bw, -hh + 5, bw - 3, h - 10);
    }
  }

  ctx.strokeStyle = 'rgba(58,45,26,0.85)';
  ctx.lineWidth = 7;
  ctx.strokeRect(-hw + 4, -hh + 4, w - 8, h - 8);
  ctx.strokeStyle = 'rgba(120,110,96,0.5)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-hw + 14, -hh + 4);
  ctx.lineTo(-hw + 14, hh - 4);
  ctx.moveTo(hw - 14, -hh + 4);
  ctx.lineTo(hw - 14, hh - 4);
  ctx.stroke();

  for (let i = 0; i < 24; i++) {
    ctx.globalAlpha = rng.range(0.06, 0.24);
    ctx.fillStyle = rng.chance(0.5) ? '#2c2418' : '#7a4520';
    ctx.beginPath();
    ctx.ellipse(rng.range(-hw, hw), rng.range(-hh, hh),
      rng.range(4, 18), rng.range(3, 13), rng.range(0, TAU), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function paintSteelBox(
  ctx: CanvasRenderingContext2D,
  rng: ReturnType<typeof makeRng>,
  w: number,
  h: number,
): void {
  const hw = w / 2;
  const hh = h / 2;
  ctx.fillStyle = '#4d565c';
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, w, h, 8);
  ctx.fill();
  ctx.fillStyle = '#5d676e';
  ctx.beginPath();
  ctx.roundRect(-hw + 7, -hh + 7, w - 14, h - 14, 5);
  ctx.fill();

  ctx.strokeStyle = 'rgba(22,26,29,0.55)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let y = -hh + 22; y < hh - 12; y += 22) {
    ctx.moveTo(-hw + 12, y);
    ctx.lineTo(hw - 12, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let y = -hh + 25; y < hh - 12; y += 22) {
    ctx.moveTo(-hw + 12, y);
    ctx.lineTo(hw - 12, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#2b3135';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(sx * (hw - 20) - 8, sy * (hh - 20) - 8, 16, 16, 3);
      ctx.fill();
    }
  }
  ctx.strokeStyle = 'rgba(16,19,21,0.7)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-hw, -hh, w, h);

  for (let i = 0; i < 28; i++) {
    ctx.globalAlpha = rng.range(0.08, 0.3);
    ctx.fillStyle = rng.chance(0.65) ? '#7a4520' : '#5c3116';
    ctx.beginPath();
    ctx.ellipse(rng.range(-hw, hw), rng.range(-hh, hh),
      rng.range(4, 16), rng.range(3, 12), rng.range(0, TAU), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Corner brackets. Tinted at draw time: an order marker or a drop ghost. */
function drawCrateOutline(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'crateOutline');
  const h = size * 0.40;
  const arm = h * 0.42;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 11;
  ctx.lineCap = 'square';
  ctx.beginPath();
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.moveTo(sx * h, sy * h - sy * arm);
      ctx.lineTo(sx * h, sy * h);
      ctx.lineTo(sx * h - sx * arm, sy * h);
    }
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Dispatch plate: a sprung steel pad, hazard-striped so it reads as a control
 * rather than a patch of floor. Worn through in the middle where it gets stood
 * on, which is the only hint anyone needs about what to do with it.
 */
function drawDockPlate(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'dockPlate');
  const half = size * 0.46;
  const w = half * 2;

  // Recessed housing under the pad.
  ctx.fillStyle = '#1a1d20';
  ctx.beginPath();
  ctx.roundRect(-half - 7, -half - 7, w + 14, w + 14, 8);
  ctx.fill();

  // Hazard border: diagonal stripes clipped to a ring around the pad.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-half, -half, w, w, 6);
  ctx.clip();
  ctx.fillStyle = '#c8a12a';
  ctx.fillRect(-half, -half, w, w);
  ctx.fillStyle = '#20232a';
  ctx.lineWidth = 0;
  const pitch = size * 0.115;
  for (let d = -w; d < w * 2; d += pitch * 2) {
    ctx.beginPath();
    ctx.moveTo(-half + d, -half);
    ctx.lineTo(-half + d + pitch, -half);
    ctx.lineTo(-half + d + pitch - w, half);
    ctx.lineTo(-half + d - w, half);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // The tread plate itself, inset so the stripes read as a surround.
  const inner = half * 0.72;
  ctx.fillStyle = '#4a5158';
  ctx.beginPath();
  ctx.roundRect(-inner, -inner, inner * 2, inner * 2, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let i = -6; i <= 6; i++) {
    const o = i * (inner / 3.6);
    ctx.moveTo(-inner, o);
    ctx.lineTo(inner, o + inner * 0.5);
  }
  ctx.stroke();

  // Polished centre — the part boots and tracks actually land on.
  const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, inner);
  shine.addColorStop(0, 'rgba(190,200,210,0.30)');
  shine.addColorStop(0.6, 'rgba(150,160,170,0.10)');
  shine.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(-inner, -inner, inner * 2, inner * 2);

  ctx.fillStyle = '#23262b';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * (half - 9), sy * (half - 9), 6, 0, TAU);
      ctx.fill();
    }
  }

  for (let i = 0; i < 26; i++) {
    ctx.globalAlpha = rng.range(0.05, 0.20);
    ctx.fillStyle = rng.chance(0.6) ? '#191b1e' : '#6d4a24';
    ctx.beginPath();
    ctx.ellipse(rng.range(-half, half), rng.range(-half, half),
      rng.range(3, 12), rng.range(2, 9), rng.range(0, TAU), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Cable, spanning the cell edge to edge so segments of a run butt together.
 *
 * Deliberately plain. It had saddle clips and banding, which at the size this
 * is actually drawn read as a chain lying on the floor rather than as the thing
 * you barely notice until you follow it to see where it goes.
 */
function drawPlateWire(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'plateWire');
  const half = size / 2;
  const t = size * 0.30;
  ctx.fillStyle = '#1c1f23';
  ctx.fillRect(-half, -t / 2, size, t);
  ctx.fillStyle = 'rgba(150,162,174,0.16)';
  ctx.fillRect(-half, -t / 2, size, t * 0.3);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-half, t / 2 - t * 0.26, size, t * 0.26);
  ctx.restore();
}

/**
 * Warning beacon: a compact unit bolted flat to the wall.
 *
 * Was a bare circle with a spoked cage across it, which read as a hazard symbol
 * rather than a light fitting. A base plate under a small domed lens does the
 * job at a fraction of the size.
 */
function drawWarnLamp(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'warnLamp');
  const bw = size * 0.34;
  const bh = size * 0.23;

  // Base plate.
  ctx.fillStyle = '#2b3036';
  ctx.beginPath();
  ctx.roundRect(-bw, -bh, bw * 2, bh * 2, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,12,14,0.7)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.fillRect(-bw + 4, -bh + 4, bw * 2 - 8, 5);
  ctx.fillStyle = '#1a1d21';
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(sx * (bw - 7), 0, 4, 0, TAU);
    ctx.fill();
  }

  // Lens: a small dome, dark until the emissive pass lights it.
  const r = size * 0.115;
  ctx.fillStyle = '#15171a';
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.35, 0, TAU);
  ctx.fill();
  const lens = ctx.createRadialGradient(-r * 0.3, -r * 0.35, 0, 0, 0, r);
  lens.addColorStop(0, '#7a2a28');
  lens.addColorStop(0.65, '#4a1618');
  lens.addColorStop(1, '#2a0d10');
  ctx.fillStyle = lens;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,220,215,0.16)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.3, -r * 0.36, r * 0.42, r * 0.26, -0.5, 0, TAU);
  ctx.fill();
  ctx.restore();

  // The lit lens. The gradient has to reach zero INSIDE the cell — running it
  // past the edge clips a bright ring square, which is why the beacon used to
  // throw a hard-edged red box across the bay.
  const g = cell(ctx, 'warnGlow');
  const gr = g.size * 0.5;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
  grad.addColorStop(0, 'rgba(255,244,240,1)');
  grad.addColorStop(0.10, 'rgba(255,150,132,0.92)');
  grad.addColorStop(0.26, 'rgba(255,58,44,0.42)');
  grad.addColorStop(0.55, 'rgba(228,24,20,0.12)');
  grad.addColorStop(1, 'rgba(190,14,12,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, gr, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** The board's character set, baked once at cell resolution. */
function drawGlyphs(ctx: CanvasRenderingContext2D): void {
  const c = cell(ctx, 'glyphs');
  ctx.translate(-c.w / 2, -c.h / 2);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Tabular figures: the numbers change every few seconds and a proportional
  // face would make the whole readout jitter sideways as they do.
  ctx.font = '700 96px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  for (let i = 0; i < GLYPHS.length; i++) {
    ctx.fillText(GLYPHS[i], i * GLYPH_CELL + GLYPH_CELL / 2, GLYPH_CELL / 2 + 4);
  }
  ctx.restore();
}

/** Panel boundaries in atlas pixels from the board's centre. */
const BOARD_SPLITS = [-330, 390];

/**
 * Productivity board. Housing in one cell, lit face in another, so the numbers
 * and their labels stay readable after dark while the bezel goes properly black
 * like everything else in the hall.
 */
function drawQuotaBoard(ctx: CanvasRenderingContext2D): void {
  const chrome = cell(ctx, 'quotaBoard');
  const hw = chrome.w / 2;
  const hh = chrome.h / 2;

  ctx.fillStyle = '#191c20';
  ctx.beginPath();
  ctx.roundRect(-hw + 2, -hh + 2, chrome.w - 4, chrome.h - 4, 10);
  ctx.fill();
  ctx.strokeStyle = '#0d0f11';
  ctx.lineWidth = 6;
  ctx.stroke();
  // Top and bottom rails catch the light; the face is recessed between them.
  ctx.fillStyle = '#2b3037';
  ctx.fillRect(-hw + 6, -hh + 6, chrome.w - 12, 13);
  ctx.fillStyle = '#101316';
  ctx.fillRect(-hw + 6, hh - 17, chrome.w - 12, 11);
  ctx.fillStyle = '#0a0c0e';
  ctx.beginPath();
  ctx.roundRect(-hw + 20, -hh + 24, chrome.w - 40, chrome.h - 46, 5);
  ctx.fill();

  ctx.fillStyle = '#33383f';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * (hw - 11), sy * (hh - 11), 5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();

  const face = cell(ctx, 'quotaScreen');
  const fw = face.w / 2;
  const fh = face.h / 2;
  // Screen wash: barely there, but it is what stops the panel reading as a
  // painted sign rather than something switched on.
  const wash = ctx.createLinearGradient(0, -fh, 0, fh);
  wash.addColorStop(0, 'rgba(70,150,130,0.20)');
  wash.addColorStop(0.5, 'rgba(50,120,110,0.11)');
  wash.addColorStop(1, 'rgba(24,60,58,0.16)');
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.roundRect(-fw + 20, -fh + 24, face.w - 40, face.h - 46, 5);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  for (let y = -fh + 26; y < fh - 24; y += 5) {
    ctx.fillRect(-fw + 20, y, face.w - 40, 2);
  }

  ctx.strokeStyle = 'rgba(120,220,200,0.30)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const x of BOARD_SPLITS) {
    ctx.moveTo(x, -fh + 40);
    ctx.lineTo(x, fh - 40);
  }
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = '600 40px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(150,240,215,0.72)';
  const label = (text: string, x: number): void => {
    // Letter-spaced by hand; the canvas API has no tracking control and a
    // run-on label at this size reads as a smudge.
    const spacing = 25;
    const total = (text.length - 1) * spacing;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x - total / 2 + i * spacing, -fh + 52);
    }
  };
  label('SHIPPED / QUOTA', BOARD_FIELDS.shipped.x);
  label('REVENUE', BOARD_FIELDS.revenue.x);
  label('AVG PER CRATE', BOARD_FIELDS.average.x);
  ctx.restore();
}

/**
 * Charging cabinet, seen from above with its connector towards +x.
 *
 * The sealed variant is the same box with a bolted transit cover over the head
 * and a lockout tag on it — the difference has to be visible at a glance,
 * because a whole wall of them is the game saying "not yet" ten times over.
 */
function drawChargeDock(ctx: CanvasRenderingContext2D, sealed: boolean): void {
  const { size } = cell(ctx, sealed ? 'chargeDockSealed' : 'chargeDock');
  const hw = size * 0.30;
  const hh = size * 0.34;

  ctx.fillStyle = '#171a1d';
  ctx.beginPath();
  ctx.roundRect(-hw - 6, -hh - 6, hw * 2 + 12, hh * 2 + 12, 7);
  ctx.fill();
  ctx.fillStyle = sealed ? '#3b4046' : '#4c545c';
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, hw * 2, hh * 2, 5);
  ctx.fill();

  // Cooling fins down the back half.
  ctx.strokeStyle = 'rgba(15,17,19,0.7)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let y = -hh + 12; y < hh - 8; y += 13) {
    ctx.moveTo(-hw + 7, y);
    ctx.lineTo(-hw * 0.1, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let y = -hh + 15; y < hh - 8; y += 13) {
    ctx.moveTo(-hw + 7, y);
    ctx.lineTo(-hw * 0.1, y);
  }
  ctx.stroke();

  // Connector head, on the hall side.
  ctx.fillStyle = '#23272c';
  ctx.beginPath();
  ctx.roundRect(hw * 0.16, -hh * 0.46, hw * 1.05, hh * 0.92, 4);
  ctx.fill();
  ctx.fillStyle = sealed ? '#2c3035' : '#8d6a2a';
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.roundRect(hw * 0.62, sy * hh * 0.30 - 6, hw * 0.5, 12, 3);
    ctx.fill();
  }

  if (sealed) {
    // Transit cover: a plate bolted straight over the head.
    ctx.fillStyle = '#5a6068';
    ctx.beginPath();
    ctx.roundRect(hw * 0.10, -hh * 0.56, hw * 1.2, hh * 1.12, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(16,18,20,0.75)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#2a2e33';
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(hw * 1.10, sy * hh * 0.38, 5, 0, TAU);
      ctx.fill();
    }
    // Lockout tag, hanging off the cover.
    ctx.fillStyle = '#b8352c';
    ctx.beginPath();
    ctx.roundRect(hw * 0.34, hh * 0.42, hw * 0.62, hh * 0.44, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(hw * 0.42, hh * 0.56, hw * 0.46, 4);
    ctx.fillRect(hw * 0.42, hh * 0.68, hw * 0.30, 4);
  } else {
    // Status lens, dark here — the emissive pass lights it.
    ctx.fillStyle = '#1d3a2c';
    ctx.beginPath();
    ctx.arc(-hw * 0.55, -hh * 0.66, 9, 0, TAU);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(10,12,14,0.65)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, hw * 2, hh * 2, 5);
  ctx.stroke();
  ctx.restore();
}

/** Painted parking pad. Worn where a robot's tracks would sit. */
function drawChargePad(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const { size } = cell(ctx, 'chargePad');
  const hw = size * 0.46;
  const hh = size * 0.38;

  ctx.strokeStyle = '#c8b04a';
  ctx.lineWidth = 9;
  ctx.setLineDash([]);
  ctx.beginPath();
  // Closed against the wall at +x, open to the hall at -x: it is a bay to
  // reverse into, not a box to sit in.
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(hw, -hh);
  ctx.lineTo(hw, hh);
  ctx.lineTo(-hw, hh);
  ctx.stroke();

  // Entry ticks, so the open side still reads as an edge.
  ctx.lineWidth = 8;
  ctx.beginPath();
  for (const sy of [-1, 1]) {
    ctx.moveTo(-hw, sy * hh);
    ctx.lineTo(-hw + size * 0.13, sy * hh);
  }
  ctx.stroke();

  // Track wear, running the way a robot backs in.
  ctx.fillStyle = 'rgba(28,30,33,0.30)';
  for (const sy of [-1, 1]) {
    ctx.fillRect(-hw, sy * hh * 0.48 - 13, hw * 1.75, 26);
  }

  for (let i = 0; i < 22; i++) {
    ctx.globalAlpha = rng.range(0.05, 0.20);
    ctx.fillStyle = rng.chance(0.6) ? '#1a1c1f' : '#6d4a24';
    ctx.beginPath();
    ctx.ellipse(rng.range(-hw, hw), rng.range(-hh, hh),
      rng.range(4, 15), rng.range(3, 11), rng.range(0, TAU), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Soft green contact glow for a commissioned point. */
function drawChargeGlow(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'chargeGlow');
  const r = size * 0.46;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  grad.addColorStop(0, 'rgba(220,255,240,0.95)');
  grad.addColorStop(0.25, 'rgba(120,255,190,0.55)');
  grad.addColorStop(0.6, 'rgba(40,220,150,0.18)');
  grad.addColorStop(1, 'rgba(20,180,120,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();
}

/**
 * The charge readout carried by every robot.
 *
 * It has to work as a fleet-wide readout, not a gauge you inspect: at the zoom
 * where a hundred machines are on screen each one is a few pixels, so the
 * COLOUR has to carry the meaning and the length is the detail you get when you
 * lean in. Hence a plain lit bar rather than pips or a ring.
 *
 * Only the light lives here. The slot it sits in is part of the body sprite.
 */
function drawChargeStrip(ctx: CanvasRenderingContext2D): void {
  const strip = cell(ctx, 'chargeStrip');
  const w = strip.size * 0.46;
  const h = strip.size * 0.40;
  const grad = ctx.createLinearGradient(0, -h, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.42, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0.55)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(-w, -h, w * 2, h * 2, h);
  ctx.fill();
  // Cell divisions: enough to read as a gauge close up, invisible far away.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (let i = 1; i < 5; i++) {
    ctx.fillRect(-w + (i * w * 2) / 5 - h * 0.11, -h, h * 0.22, h * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

}

/**
 * The coupler a charging point reaches out with.
 *
 * A boom running the length of the cell with a contact head on the leading end,
 * so the renderer can stretch it to whatever the gap happens to be and the head
 * still lands on the machine.
 */
function drawChargeArm(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'chargeArm');
  const half = size / 2;
  const t = size * 0.115;

  // Boom.
  ctx.fillStyle = '#2b3138';
  ctx.fillRect(-half, -t / 2, size, t);
  ctx.fillStyle = 'rgba(190,205,218,0.20)';
  ctx.fillRect(-half, -t / 2, size, t * 0.28);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(-half, t / 2 - t * 0.3, size, t * 0.3);
  // Ribs, so extension is visible as travel rather than as a growing bar.
  ctx.fillStyle = 'rgba(12,14,16,0.55)';
  for (let x = -half + size * 0.10; x < half - size * 0.12; x += size * 0.11) {
    ctx.fillRect(x, -t / 2, size * 0.016, t);
  }

  // Contact head, on the leading end.
  const hw = size * 0.085;
  const hh = size * 0.115;
  ctx.fillStyle = '#3c444c';
  ctx.beginPath();
  ctx.roundRect(-half, -hh, hw * 2, hh * 2, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,12,14,0.7)';
  ctx.lineWidth = 3;
  ctx.stroke();
  // Copper contacts.
  ctx.fillStyle = '#b4762c';
  for (const sy of [-1, 1]) {
    ctx.fillRect(-half + 3, sy * hh * 0.46 - hh * 0.16, hw * 1.5, hh * 0.32);
  }
  ctx.restore();
}

/**
 * One arc, struck from the coupler head towards -x.
 *
 * Drawn as a jagged path rather than a glow blob: an arc is a line that cannot
 * decide where it is going, and a soft dot reads as a light, not electricity.
 */
function drawSpark(ctx: CanvasRenderingContext2D): void {
  const { size } = cell(ctx, 'spark');
  const half = size / 2;
  const rng = makeRng(0x5eed);
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let pass = 0; pass < 2; pass++) {
    // Two passes: a wide soft one under a tight bright one, which is what gives
    // a drawn line the bloom a real arc has.
    ctx.lineWidth = pass === 0 ? size * 0.11 : size * 0.035;
    ctx.globalAlpha = pass === 0 ? 0.22 : 1;
    ctx.beginPath();
    ctx.moveTo(half * 0.92, 0);
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = half * 0.92 - t * size * 0.86;
      // Wander grows away from the head, then pinches back to a point.
      const spread = Math.sin(t * Math.PI) * size * 0.17;
      ctx.lineTo(x, rng.range(-spread, spread));
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * The upgrade room's floor, and its purchase points.
 *
 * Deliberately plainer than the warehouse: painted concrete rather than a slab
 * that has been worked on for years. The room is new; the building is not.
 */
function drawShopSurfaces(ctx: CanvasRenderingContext2D, rng: ReturnType<typeof makeRng>): void {
  const floor = cell(ctx, 'shopFloor');
  const half = floor.size / 2;
  ctx.fillStyle = '#3a3f45';
  ctx.fillRect(-half, -half, floor.size, floor.size);
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 3;
  for (let i = 1; i < 4; i++) {
    const at = -half + (i * floor.size) / 4;
    ctx.beginPath();
    ctx.moveTo(-half, at);
    ctx.lineTo(half, at);
    ctx.moveTo(at, -half);
    ctx.lineTo(at, half);
    ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.globalAlpha = rng.range(0.03, 0.10);
    ctx.fillStyle = rng.chance(0.5) ? '#20242a' : '#585f68';
    ctx.beginPath();
    ctx.ellipse(rng.range(-half, half), rng.range(-half, half),
      rng.range(8, 40), rng.range(6, 30), rng.range(0, TAU), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  const plate = cell(ctx, 'shopPlate');
  const ph = plate.size * 0.42;
  ctx.fillStyle = '#171a1e';
  ctx.beginPath();
  ctx.roundRect(-ph - 6, -ph - 6, ph * 2 + 12, ph * 2 + 12, 8);
  ctx.fill();
  ctx.fillStyle = '#495159';
  ctx.beginPath();
  ctx.roundRect(-ph, -ph, ph * 2, ph * 2, 6);
  ctx.fill();
  // A ring on the tread, so it reads as somewhere to stand rather than a hatch.
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(0, 0, ph * 0.58, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let i = -3; i <= 3; i++) {
    ctx.moveTo(-ph + 8, i * (ph / 3.4));
    ctx.lineTo(ph - 8, i * (ph / 3.4));
  }
  ctx.stroke();
  ctx.fillStyle = '#23272c';
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * (ph - 9), sy * (ph - 9), 5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}
