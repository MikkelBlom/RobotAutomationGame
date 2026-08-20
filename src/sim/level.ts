import { makeRng } from '../core/mathUtils';
import { distanceToEdges, pointInPolygon, polygonBounds, type Polygon } from './polygon';

/**
 * The opening level: one warehouse hall with a flooded dock cut into it. The
 * dock runs west into the wall and out to open water, but the gate is shut, so
 * nothing beyond the shell is ever on screen. Early on the water is simply an
 * obstacle to route around; water robots and the gate come later.
 *
 * World units are roughly "centimetres of floor"; a ground bot is ~64 long.
 */

export const WALL_THICKNESS = 96;

/** Interior floor slab. */
export const FLOOR = { x: 0, y: 0, w: 3200, h: 2400 } as const;

/** Outer extent including the wall shell. The camera never leaves this. */
export const WORLD = {
  x0: FLOOR.x - WALL_THICKNESS,
  y0: FLOOR.y - WALL_THICKNESS,
  x1: FLOOR.x + FLOOR.w + WALL_THICKNESS,
  y1: FLOOR.y + FLOOR.h + WALL_THICKNESS,
} as const;

export const WORLD_W = WORLD.x1 - WORLD.x0;
export const WORLD_H = WORLD.y1 - WORLD.y0;

/**
 * The dock runs straight out through the west wall to open water. Nothing
 * beyond the shell is ever drawn — the channel just fades to black under the
 * wall — but it is genuinely open, and swell rolls in from it.
 */
export const DOCK_RECESS = WALL_THICKNESS;

/**
 * The flooded dock. It runs west out through the wall to open water, so a
 * submarine could put in here. On the floor side it is simply an obstacle
 * until water robots arrive.
 *
 * Engineered excavation: straight runs on the axes, every corner taken off at
 * exactly 45 degrees (each diagonal below has |dx| === |dy|).
 *
 * The two notches are concrete boarding jetties reaching OUT from the banks
 * into the pool, so crew can step across onto a hull lying alongside. They are
 * floor, not water — the polygon bends around them.
 */
export const WATER_POLY: Polygon = [
  -DOCK_RECESS, 620,
  300, 620,
  440, 760,    // 45  - north jetty, west side
  740, 760,    //      jetty nose
  880, 620,    // 45  - north jetty, east side
  1420, 620,
  1600, 800,   // 45  - NE corner
  1600, 1580,
  1420, 1760,  // 45  - SE corner
  1240, 1760,
  1100, 1620,  // 45  - south jetty, east side
  800, 1620,   //      jetty nose
  660, 1760,   // 45  - south jetty, west side
  -DOCK_RECESS, 1760,
];

/** Vertical span of the opening where the dock passes through the west wall. */
export const DOCK_OPENING = { y0: 620, y1: 1760 } as const;

/** Where the channel meets open water. Swell enters here. */
export const DOCK_MOUTH_X = WORLD.x0;

export const WATER_BOUNDS = polygonBounds(WATER_POLY);

/** Width of the painted hazard band that rings the basin. */
export const HAZARD_BAND = 46;
/** Bots are kept this far back from the water's edge. */
export const WATER_CLEARANCE = 34;

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
  /** Collision half-extent, a little tighter than the art. */
  radius: number;
}

export interface LevelGeometry {
  columns: Column[];
  lamps: Lamp[];
  skylights: Skylight[];
  props: Prop[];
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

  // Columns stand in rows along the structural bays — the two wall lines plus a
  // spine down the middle. A full lattice made the whole hall read as a grid.
  const bayRows = [268, 1204, 2136];
  for (let r = 0; r < bayRows.length; r++) {
    const spacing = r === 1 ? 700 : 560;
    for (let x = 360; x < FLOOR.w - 180; x += spacing) {
      const cx = x + rng.range(-22, 22);
      const cy = bayRows[r] + rng.range(-18, 18);
      if (inWater(cx, cy, 130)) continue;
      columns.push({ x: cx, y: cy, size: rng.range(62, 74), rust: rng.next() });
    }
  }

  // Sodium work lamps, mounted on alternating columns plus a pair over the quay.
  for (let i = 0; i < columns.length; i++) {
    if (i % 2 !== 0) continue;
    const c = columns[i];
    lamps.push({
      x: c.x + rng.range(-30, 30),
      y: c.y + rng.range(-30, 30),
      radius: rng.range(430, 620),
      intensity: rng.range(0.75, 1),
      flickers: rng.chance(0.18),
      phase: rng.range(0, 6.283),
    });
  }
  lamps.push({ x: 860, y: 620, radius: 560, intensity: 0.95, flickers: true, phase: 1.1 });
  lamps.push({ x: 640, y: 1980, radius: 560, intensity: 0.9, flickers: false, phase: 2.4 });
  lamps.push({ x: 1620, y: 1200, radius: 520, intensity: 0.85, flickers: false, phase: 3.9 });

  // Roof glazing: evenly spaced strips down the bays, set well back from the
  // walls. Regular spacing is right here — this is roof structure, and the
  // pools it casts should march across the floor in step as the sun moves.
  const STRIPS = 5;
  const PANELS = 3;
  const marginX = 420;
  const marginY = 340;
  const panelLength = 520;
  const panelGap =
    (FLOOR.h - marginY * 2 - panelLength * PANELS) / (PANELS - 1);

  for (let s = 0; s < STRIPS; s++) {
    const x = marginX + (s * (FLOOR.w - marginX * 2)) / (STRIPS - 1);
    for (let p = 0; p < PANELS; p++) {
      const top = marginY + p * (panelLength + panelGap);
      skylights.push({
        x,
        y: top + panelLength / 2,
        w: 158,
        h: panelLength,
        // Only the weathering varies; the geometry stays true.
        intensity: rng.range(0.86, 1),
      });
    }
  }

  // Abandoned cargo. Loosely clustered rather than evenly sprinkled, so the
  // hall reads as somewhere that was walked away from mid-shift.
  const props: Prop[] = [];
  const clusters: Array<[number, number, number]> = [
    [2260, 420, 300], [2880, 980, 240], [2500, 1980, 340],
    [1880, 2120, 260], [1930, 470, 220], [2980, 1720, 220],
    [640, 300, 240], [700, 2160, 260],
  ];
  const clearOf = (x: number, y: number, r: number): boolean => {
    if (x < FLOOR.x + 130 || x > FLOOR.x + FLOOR.w - 130) return false;
    if (y < FLOOR.y + 130 || y > FLOOR.y + FLOOR.h - 130) return false;
    if (inWater(x, y, 150)) return false;
    for (const c of columns) {
      if (Math.abs(x - c.x) < c.size + r + 40 && Math.abs(y - c.y) < c.size + r + 40) return false;
    }
    for (const p of props) {
      if (Math.hypot(x - p.x, y - p.y) < p.radius + r + 14) return false;
    }
    return true;
  };

  for (const [cx, cy, spread] of clusters) {
    const n = rng.int(3, 7);
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const x = cx + rng.range(-spread, spread);
        const y = cy + rng.range(-spread, spread);
        const size = rng.range(64, 108);
        const radius = size * 0.46;
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

  return { columns, lamps, skylights, props };
}

/** A sensible starting position for the first robot: dry floor, east of the basin. */
export const SPAWN = { x: 2100, y: 1200 };
