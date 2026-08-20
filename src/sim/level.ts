import { makeRng } from '../core/mathUtils';
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

export const WALL_THICKNESS = 110;

/** Interior floor slab: 120 m x 84 m. */
export const FLOOR = { x: 0, y: 0, w: 12000, h: 8400 } as const;

/**
 * Depth of the dark strip north of the hall where trailers back onto the
 * loading bays. The camera may reach this far out so the inside of a docked
 * trailer is visible; everything else out here stays black.
 */
export const TRUCK_APRON = 700;

/** Outer extent the camera may reach. */
export const WORLD = {
  x0: FLOOR.x - WALL_THICKNESS,
  y0: FLOOR.y - WALL_THICKNESS - TRUCK_APRON,
  x1: FLOOR.x + FLOOR.w + WALL_THICKNESS,
  y1: FLOOR.y + FLOOR.h + WALL_THICKNESS,
} as const;

export const WORLD_W = WORLD.x1 - WORLD.x0;
export const WORLD_H = WORLD.y1 - WORLD.y0;

/**
 * The flooded dock. Engineered excavation: straight runs on the axes, every
 * corner taken off at exactly 45 degrees (each diagonal below has |dx| = |dy|).
 *
 * The two notches are concrete boarding jetties reaching OUT from the banks
 * into the pool, so crew can step across onto a hull lying alongside. They are
 * floor, not water — the polygon bends around them.
 */
export const WATER_POLY: Polygon = [
  -WALL_THICKNESS, 2340,
  1150, 2340,
  1670, 2860,   // 45 — north jetty, west side
  2820, 2860,   //      jetty nose
  3340, 2340,   // 45 — north jetty, east side
  5330, 2340,
  6000, 3010,   // 45 — NE corner
  6000, 5490,
  5330, 6160,   // 45 — SE corner
  4650, 6160,
  4130, 5640,   // 45 — south jetty, east side
  2980, 5640,   //      jetty nose
  2460, 6160,   // 45 — south jetty, west side
  -WALL_THICKNESS, 6160,
];

/** Vertical span of the opening where the dock passes through the west wall. */
export const DOCK_OPENING = { y0: 2340, y1: 6160 } as const;

/** Where the channel meets open water. Swell enters here. */
export const DOCK_MOUTH_X = WORLD.x0;

export const WATER_BOUNDS = polygonBounds(WATER_POLY);

/** Painted warning band around the dock. */
export const HAZARD_BAND = 90;
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
}

/** Interior width of a standard trailer. */
export const TRAILER_WIDTH = 245;
export const BAY_WIDTH = 330;
/** Floor strip kept clear in front of the loading bays. */
export const BAY_APPROACH_DEPTH = 900;

/** Bays sit along the north wall towards the east end. */
export function buildDockBays(): DockBay[] {
  const bays: DockBay[] = [];
  const first = 8200;
  const spacing = 950;
  for (let i = 0; i < 4; i++) {
    bays.push({ x: first + i * spacing, width: BAY_WIDTH, occupied: i === 1 || i === 2 });
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

/** Abandoned cargo left on the floor. Blocks robots and casts a shadow. */
export interface Prop {
  x: number;
  y: number;
  angle: number;
  size: number;
  /** 0 = timber crate, 1 = steel box, 2 = pallet stack. */
  variant: number;
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
  const bayRows = [950, 4250, 7480];
  for (let r = 0; r < bayRows.length; r++) {
    const spacing = r === 1 ? 1300 : 1100;
    for (let x = 1200; x < FLOOR.w - 700; x += spacing) {
      const cx = x + rng.range(-40, 40);
      const cy = bayRows[r] + rng.range(-35, 35);
      if (inWater(cx, cy, 420)) continue;
      // Keep the approach to the loading bays clear.
      if (cy < BAY_APPROACH_DEPTH && bays.some((b) => Math.abs(cx - b.x) < 700)) continue;
      columns.push({ x: cx, y: cy, size: rng.range(56, 66), rust: rng.next() });
    }
  }

  // Sodium work lamps on alternating columns, plus a few over the quay.
  for (let i = 0; i < columns.length; i++) {
    if (i % 2 !== 0) continue;
    const c = columns[i];
    lamps.push({
      x: c.x + rng.range(-90, 90),
      y: c.y + rng.range(-90, 90),
      radius: rng.range(1700, 2500),
      intensity: rng.range(0.75, 1),
      flickers: rng.chance(0.18),
      phase: rng.range(0, 6.283),
    });
  }
  lamps.push({ x: 3200, y: 2050, radius: 2200, intensity: 0.95, flickers: true, phase: 1.1 });
  lamps.push({ x: 2400, y: 6600, radius: 2200, intensity: 0.9, flickers: false, phase: 2.4 });
  lamps.push({ x: 6600, y: 4250, radius: 2000, intensity: 0.85, flickers: false, phase: 3.9 });
  for (const bay of bays) {
    lamps.push({ x: bay.x, y: 560, radius: 1400, intensity: 0.9, flickers: false, phase: bay.x });
    if (bay.occupied) {
      // Interior light in a docked trailer. Everything else beyond the shell
      // stays black, so this is the only thing that reads as "outside".
      lamps.push({
        x: bay.x, y: -430, radius: 760,
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
    const n = rng.int(3, 6);
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = cx + rng.range(-spread, spread);
        const y = cy + rng.range(-spread, spread);
        // Roughly a pallet footprint, with some larger crates.
        const size = rng.chance(0.7) ? rng.range(105, 135) : rng.range(150, 195);
        // Collision must exceed the drawn extent, or robots ride over corners.
        const radius = size * 0.62;
        if (!clearOf(x, y, radius)) continue;
        props.push({
          x, y,
          angle: rng.range(0, Math.PI * 2),
          size,
          variant: rng.chance(0.5) ? 0 : rng.chance(0.6) ? 1 : 2,
          radius,
        });
        break;
      }
    }
  }
  return props;
}

/** A sensible starting position for the first robot: dry floor, east of the dock. */
export const SPAWN = { x: 8200, y: 4200 };
