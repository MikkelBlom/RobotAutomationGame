/**
 * Crates, and which machines can move them.
 *
 * Everything is built on one module: a 1x1 crate is a Euro-pallet footprint.
 * Bigger crates are whole multiples of it, so they tile in a trailer without
 * gaps and a robot's capacity can be stated as "how many units of deck".
 */

/** Side of a 1x1 crate, in centimetres. */
export const CRATE_UNIT = 120;

export const CrateMaterial = { Timber: 0, Steel: 1 } as const;
export type CrateMaterialValue = (typeof CrateMaterial)[keyof typeof CrateMaterial];

export const CrateShape = { Unit: 0, Long: 1, Large: 2 } as const;
export type CrateShapeValue = (typeof CrateShape)[keyof typeof CrateShape];

/** Footprint of each shape, in units. */
export const SHAPE_UNITS: Record<CrateShapeValue, { w: number; h: number }> = {
  [CrateShape.Unit]: { w: 1, h: 1 },
  [CrateShape.Long]: { w: 1, h: 2 },
  [CrateShape.Large]: { w: 2, h: 2 },
};

export function shapeSize(shape: CrateShapeValue): { w: number; h: number } {
  const u = SHAPE_UNITS[shape];
  return { w: u.w * CRATE_UNIT, h: u.h * CRATE_UNIT };
}

/**
 * Collision radius for a crate. Deliberately the bounding circle: conservative,
 * and the shapes a robot cannot lift yet are pure obstacles anyway.
 */
export function crateRadius(shape: CrateShapeValue): number {
  const { w, h } = shapeSize(shape);
  return Math.hypot(w, h) * 0.5;
}

/**
 * What a machine is rated to move, as TWO independent axes.
 *
 * · deck   — capacity in crate units. 1 takes a 1x1, 2 takes a 1x2 (or two
 *            1x1), 4 takes a 2x2 (or two 1x2, or four 1x1).
 * · weight — a rating compared against the crate's own class. Timber is 1,
 *            steel is 2, and whatever comes later is 3, 4, ...
 *
 * They stack and neither is a ladder through the other, so a 1x1 heavy hauler
 * is a perfectly legal build. This replaced a single enum of four classes,
 * which could not express that combination at all: it demanded Heavy for steel
 * AND Long-or-Big for a long shape, so a steel 1x2 was liftable by nothing that
 * could ever exist.
 *
 * The pair is PACKED into one integer. That is not decoration — it lets a
 * capability live in a typed array beside the rest of the robot state, and be a
 * Set key when something needs to ask which capabilities can serve a crate.
 */
const DECK_SHIFT = 100;

export type CapabilityValue = number;

export function capability(deck: number, weight: number): CapabilityValue {
  return deck * DECK_SHIFT + weight;
}
/** Deck capacity, in crate units. */
export function capDeck(cap: CapabilityValue): number {
  return Math.floor(cap / DECK_SHIFT);
}
/** Weight rating. */
export function capWeight(cap: CapabilityValue): number {
  return cap % DECK_SHIFT;
}

/** Deck units a crate takes up. */
export const SHAPE_CAPACITY: Record<CrateShapeValue, number> = {
  [CrateShape.Unit]: 1,
  [CrateShape.Long]: 2,
  [CrateShape.Large]: 4,
};

/** How heavy a crate is to lift, on the same scale as a machine's rating. */
export const MATERIAL_WEIGHT: Record<CrateMaterialValue, number> = {
  [CrateMaterial.Timber]: 1,
  [CrateMaterial.Steel]: 2,
};

/**
 * Named starting points on the two axes.
 *
 * Convenience only — nothing in the simulation branches on these. A machine
 * carries its deck and weight numbers, and upgrades move them independently.
 */
export const HAULER = {
  /** The starting machine: one pallet of timber. */
  Standard: capability(1, 1),
  /** Deck for a 1x2. */
  Long: capability(2, 1),
  /** Deck for a 2x2. */
  Big: capability(4, 1),
  /** Rated for steel, but still only a single pallet of deck. */
  Heavy: capability(1, 2),
  /** Everything, eventually. */
  Full: capability(4, 2),
} as const;

/** Why a crate cannot be lifted, or null if it can. */
export function liftRefusal(
  cap: CapabilityValue,
  material: CrateMaterialValue,
  shape: CrateShapeValue,
): string | null {
  if (MATERIAL_WEIGHT[material] > capWeight(cap)) return 'too heavy';
  if (SHAPE_CAPACITY[shape] > capDeck(cap)) return 'deck too small';
  return null;
}

export function canLift(
  cap: CapabilityValue,
  material: CrateMaterialValue,
  shape: CrateShapeValue,
): boolean {
  return liftRefusal(cap, material, shape) === null;
}
