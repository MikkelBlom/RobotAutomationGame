import { makeRng } from '../core/mathUtils';
import {
  CrateMaterial,
  CrateShape,
  crateRadius,
  shapeSize,
  type CrateMaterialValue,
  type CrateShapeValue,
} from './cargo';
import { distanceToEdges, pointInPolygon, polygonBounds, type Polygon } from './polygon';

/**
 * The opening level: one warehouse hall with a flooded dock cut into it.
 *
 * ── SCALE ──────────────────────────────────────────────────────────────────
 * One world unit is ONE CENTIMETRE. Everything is dimensioned from something
 * real, because an arbitrary scale made the proportions feel off and the hall
 * feel like a room rather than a building:
 *
 *   Euro pallet          120 x  80 cm   (the unit the robot is built around)
 *   Ground robot         165 x 105 cm   (its bed takes a pallet)
 *   Steel column          60 cm square, on an ~11 m structural bay
 *   Wall build-up        110 cm
 *   Hall               12000 x 8400 cm  = 120 m x 84 m
 *   Flooded dock        6110 x 3820 cm  =  61 m x 38 m (a boat fits)
 *   Trailer interior     245 cm wide
 *
 * If you add anything, size it from something real.
 *
 * The dock runs west out through the wall to open water. Nothing beyond the
 * shell is drawn — outside is simply dark — but it is genuinely open, and swell
 * rolls in from it.
 */

/** Clad steel wall with its structural frame inside it. */
export const WALL_THICKNESS = 260;

/** Interior floor slab: 120 m x 84 m. */
export const FLOOR = { x: 0, y: 0, w: 12000, h: 8400 } as const;

/** How far a trailer's interior reaches back from the wall. */
export const TRAILER_DEPTH = 1000;

/**
 * Dark margin outside the shell, on every side. The camera may reach into it,
 * and it is where the view fades out — you never see past the building.
 *
 * The north margin is much deeper because trailers back onto the loading bays
 * there and their interiors have to fit.
 */
export const APRON = { north: TRAILER_DEPTH + 460, south: 520, west: 520, east: 520 } as const;

/** Outer extent the camera may reach. */
export const WORLD = {
  x0: FLOOR.x - WALL_THICKNESS - APRON.west,
  y0: FLOOR.y - WALL_THICKNESS - APRON.north,
  x1: FLOOR.x + FLOOR.w + WALL_THICKNESS + APRON.east,
  y1: FLOOR.y + FLOOR.h + WALL_THICKNESS + APRON.south,
} as const;

export const WORLD_W = WORLD.x1 - WORLD.x0;
export const WORLD_H = WORLD.y1 - WORLD.y0;

/**
 * The building itself: floor plus its wall ring, with no apron.
 *
 * Walls must be positioned from THIS, never from WORLD. WORLD used to be the
 * shell, then aprons were added on every side and it silently became something
 * bigger — which put the west wall out in the dark apron where it was invisible,
 * and ran the north and south walls past both corners.
 */
export const SHELL = {
  x0: FLOOR.x - WALL_THICKNESS,
  y0: FLOOR.y - WALL_THICKNESS,
  x1: FLOOR.x + FLOOR.w + WALL_THICKNESS,
  y1: FLOOR.y + FLOOR.h + WALL_THICKNESS,
} as const;

/**
 * The flooded dock. Engineered excavation: straight runs on the axes, every
 * corner taken off at exactly 45 degrees (each diagonal below has |dx| = |dy|).
 *
 * 64 m long, 31 m wide, centred on the hall: under two ninths of the floor. The dock is
 * a corner of this building, not its subject — most of the hall has to stay
 * clear for the automation that goes in it.
 *
 * It reads as a RECTANGLE. The two concrete boarding jetties are modest bites
 * out of opposite banks, 5 m deep and 12 m along the nose, leaving a 22 m
 * channel for a boat to berth in with crew able to step across from either
 * side. Cut deeper or longer, they pinch the pool into an hourglass, which is
 * not what a dock looks like.
 *
 * The jetties are floor, not water; the polygon bends around them.
 */
export const WATER_POLY: Polygon = [
  -WALL_THICKNESS, 2650,
  1800, 2650,
  2300, 3150,   // 45 — north jetty, west face
  4300, 3150,   //      north jetty nose, 20 m
  4800, 2650,   // 45 — north jetty, east face
  5700, 2650,
  6200, 3150,   // 45 — NE corner
  6200, 5250,
  5700, 5750,   // 45 — SE corner
  4800, 5750,
  4300, 5250,   // 45 — south jetty, east face
  2300, 5250,   //      south jetty nose
  1800, 5750,   // 45 — south jetty, west face
  -WALL_THICKNESS, 5750,
];

/** Clear channel between the jetty noses — this is the berth. */
export const BERTH = { y0: 3150, y1: 5250, x0: 2300, x1: 4300 } as const;

/** Vertical span of the opening where the dock passes through the west wall. */
export const DOCK_OPENING = { y0: 2650, y1: 5750 } as const;

/**
 * Where the channel meets open water, and where it fades to black.
 *
 * This is the water's own west extent — the outer face of the wall — not
 * WORLD.x0. Once aprons were added on every side, WORLD.x0 moved 5 m further
 * out and the fade ended up entirely off the end of the water, so the channel
 * simply stopped dead against the wall with no darkening at all.
 */
export const DOCK_MOUTH_X = SHELL.x0;

export const WATER_BOUNDS = polygonBounds(WATER_POLY);

/** Painted warning band around the dock. */
export const HAZARD_BAND = 62;
/** Robots are kept this far back from the water's edge. */
export const WATER_CLEARANCE = 90;

// ── Loading bays ───────────────────────────────────────────────────────────

/** A trailer dock in the north wall. */
export interface DockBay {
  /** Centre of the bay opening, in x. */
  x: number;
  /** Clear width of the opening. */
  width: number;
  /** Whether a trailer is currently backed onto it. */
  occupied: boolean;
  /** Shuttered bays take no trailers at all yet. */
  active: boolean;
}

/**
 * Trailer interior. A real road trailer is 245 cm inside — two Euro pallets
 * side by side and nothing else. These are wider so a robot can drive in, turn,
 * and set two crates down abreast.
 */
export const TRAILER_WIDTH = 480;
export const BAY_WIDTH = 580;
/** Floor strip kept clear in front of the loading bays. */
export const BAY_APPROACH_DEPTH = 900;

/** Bays sit along the north wall towards the east end. */
export function buildDockBays(): DockBay[] {
  const bays: DockBay[] = [];
  // Spread across the eastern third, with the outermost bay's full width kept
  // clear of the east wall. Running one off the end of the building was a bug.
  const count = 4;
  const spacing = 1250;
  const span = spacing * (count - 1);
  const first = FLOOR.x + FLOOR.w - 900 - span;
  for (let i = 0; i < count; i++) {
    // Only one bay is in service so far; the rest are shuttered. It is the
    // outermost one, so the working dock sits at the far end of the run.
    bays.push({
      x: first + i * spacing,
      width: BAY_WIDTH,
      occupied: false,
      active: i === count - 1,
    });
  }
  return bays;
}

export interface Column {
  x: number;
  y: number;
  size: number;
  rust: number;
}

export interface Lamp {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  flickers: boolean;
  phase: number;
}

export interface Skylight {
  x: number;
  y: number;
  w: number;
  h: number;
  intensity: number;
}

/** A crate on the floor. Blocks robots and casts a shadow. */
export interface Prop {
  x: number;
  y: number;
  /**
   * Crates sit square to the building. They used to be scattered at random
   * angles, which made a robot's approach look crooked no matter how carefully
   * it lined up — there was no straight-on face to line up with.
   */
  angle: number;
  material: CrateMaterialValue;
  shape: CrateShapeValue;
  /** Footprint in centimetres. */
  w: number;
  h: number;
  /** Collision half-extent. Deliberately a little LARGER than the art. */
  radius: number;
}

export interface LevelGeometry {
  columns: Column[];
  lamps: Lamp[];
  skylights: Skylight[];
  props: Prop[];
  bays: DockBay[];
}

/**
 * True if the point is inside the basin, or within `margin` of its edge.
 * Uses real edge distance rather than axis samples so angled faces behave.
 */
export function inWater(x: number, y: number, margin = 0): boolean {
  if (pointInPolygon(WATER_POLY, x, y)) return true;
  if (margin <= 0) return false;
  return distanceToEdges(WATER_POLY, x, y) < margin;
}

export function buildLevelGeometry(seed: number): LevelGeometry {
  const rng = makeRng(seed);
  const columns: Column[] = [];
  const lamps: Lamp[] = [];
  const skylights: Skylight[] = [];
  const bays = buildDockBays();

  // Columns stand in rows along the structural bays — the two wall lines plus a
  // spine down the middle. A full lattice made the whole hall read as a grid.
  const bayRows = [1100, 4200, 7300];
  for (let r = 0; r < bayRows.length; r++) {
    const spacing = 1900;
    for (let x = 1400; x < FLOOR.w - 900; x += spacing) {
      const cx = x + rng.range(-40, 40);
      const cy = bayRows[r] + rng.range(-35, 35);
      if (inWater(cx, cy, 520)) continue;
      // Keep the approach to the loading bays clear.
      if (cy < BAY_APPROACH_DEPTH && bays.some((b) => Math.abs(cx - b.x) < 700)) continue;
      columns.push({ x: cx, y: cy, size: rng.range(185, 210), rust: rng.next() });
    }
  }

  // Sodium work lamps on alternating columns, plus a few over the quay.
  // Every third bay, not every other one: a lamp on half the columns turned
  // the floor into overlapping pools with no dark between them.
  for (let i = 0; i < columns.length; i++) {
    if (i % 3 !== 0) continue;
    const c = columns[i];
    lamps.push({
      x: c.x + rng.range(-90, 90),
      y: c.y + rng.range(-90, 90),
      radius: rng.range(1150, 1600),
      intensity: rng.range(0.75, 1),
      flickers: rng.chance(0.18),
      phase: rng.range(0, 6.283),
    });
  }
  lamps.push({ x: 3200, y: 2050, radius: 1500, intensity: 0.95, flickers: true, phase: 1.1 });
  lamps.push({ x: 2400, y: 7400, radius: 1500, intensity: 0.9, flickers: false, phase: 2.4 });
  lamps.push({ x: 7400, y: 4250, radius: 1400, intensity: 0.85, flickers: false, phase: 3.9 });
  for (const bay of bays) {
    lamps.push({ x: bay.x, y: 560, radius: 1000, intensity: 0.9, flickers: false, phase: bay.x });
    if (bay.occupied) {
      // Interior light in a docked trailer. Everything else beyond the shell
      // stays black, so this is the only thing that reads as "outside".
      lamps.push({
        x: bay.x, y: -680, radius: 720,
        intensity: 0.8, flickers: false, phase: bay.x * 0.5,
      });
    }
  }

  // Roof glazing: evenly spaced strips down the bays, set well back from the
  // walls. Regular spacing is right here — this is roof structure, and the
  // pools it casts should march across the floor in step as the sun moves.
  const STRIPS = 6;
  const PANELS = 4;
  const marginX = 1500;
  const marginY = 1200;
  const panelLength = 1250;
  const panelGap = (FLOOR.h - marginY * 2 - panelLength * PANELS) / (PANELS - 1);

  for (let s = 0; s < STRIPS; s++) {
    const x = marginX + (s * (FLOOR.w - marginX * 2)) / (STRIPS - 1);
    for (let p = 0; p < PANELS; p++) {
      const top = marginY + p * (panelLength + panelGap);
      skylights.push({
        x,
        y: top + panelLength / 2,
        w: 300,
        h: panelLength,
        // Only the weathering varies; the geometry stays true.
        intensity: rng.range(0.86, 1),
      });
    }
  }

  const props = buildProps(rng, columns, bays);
  return { columns, lamps, skylights, props, bays };
}

/**
 * Abandoned cargo. Loosely clustered rather than evenly sprinkled, so the hall
 * reads as somewhere that was walked away from mid-shift. Every item is kept
 * clearly apart from its neighbours — they are meant to be individually
 * meaningful objects, not scenery rubble.
 */
function buildProps(
  rng: ReturnType<typeof makeRng>,
  columns: Column[],
  bays: DockBay[],
): Prop[] {
  const props: Prop[] = [];
  const clusters: Array<[number, number, number]> = [
    [8600, 1900, 1100], [10600, 3600, 900], [9300, 6900, 1200],
    [7000, 7500, 1000], [7300, 1400, 800], [11100, 6200, 800],
    [2200, 1100, 900], [2600, 7500, 1000], [10800, 1300, 700],
  ];

  const clearOf = (x: number, y: number, r: number): boolean => {
    if (x < FLOOR.x + 500 || x > FLOOR.x + FLOOR.w - 500) return false;
    if (y < FLOOR.y + 500 || y > FLOOR.y + FLOOR.h - 500) return false;
    if (inWater(x, y, 500)) return false;
    if (y < BAY_APPROACH_DEPTH + 300 && bays.some((b) => Math.abs(x - b.x) < 800)) return false;
    for (const c of columns) {
      if (Math.abs(x - c.x) < c.size * 2 + r + 160 && Math.abs(y - c.y) < c.size * 2 + r + 160) {
        return false;
      }
    }
    // A clear 2.5 m gap between items, so each reads as its own object.
    for (const p of props) {
      if (Math.hypot(x - p.x, y - p.y) < p.radius + r + 250) return false;
    }
    return true;
  };

  for (const [cx, cy, spread] of clusters) {
    // A trailer takes twelve. The hall has to hold at least a couple of loads
    // of the one thing the starting machine can lift, or the truck never fills
    // and never leaves.
    const n = rng.int(5, 8);
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = cx + rng.range(-spread, spread);
        const y = cy + rng.range(-spread, spread);

        // Mostly single pallets of timber — the only thing the starting machine
        // is rated for. The rest are there to be visibly out of reach.
        const roll = rng.next();
        const shape: CrateShapeValue =
          roll < 0.72 ? CrateShape.Unit : roll < 0.88 ? CrateShape.Long : CrateShape.Large;
        const material: CrateMaterialValue =
          rng.chance(0.70) ? CrateMaterial.Timber : CrateMaterial.Steel;

        const { w, h } = shapeSize(shape);
        // Square to the building, quarter-turned at random so long crates lie
        // both ways. A crate at an arbitrary angle has no face to line up on.
        const quarter = rng.int(0, 3);
        const angle = (quarter * Math.PI) / 2;
        const radius = crateRadius(shape);
        if (!clearOf(x, y, radius)) continue;

        props.push({
          x, y, angle, material, shape,
          w: quarter % 2 === 0 ? w : h,
          h: quarter % 2 === 0 ? h : w,
          radius,
        });
        break;
      }
    }
  }
  return props;
}

/** A sensible starting position for the first robot: dry floor, east of the dock. */
export const SPAWN = { x: 10100, y: 4200 };
