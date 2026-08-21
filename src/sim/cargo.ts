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
 * What a machine is rated to move.
 *
 * Only Standard exists so far, which is why a timber 1x1 is the only thing that
 * can be picked up. The rest describe the machines that come later, and are
 * here so the refusal has a reason attached rather than being a silent no-op.
 */
export const HaulerClass = {
  /** The starting machine: one pallet of timber. */
  Standard: 0,
  /** Takes a 1x2. */
  Long: 1,
  /** Takes a 2x2. */
  Big: 2,
  /** Rated for steel, at any size. */
  Heavy: 3,
} as const;
export type HaulerClassValue = (typeof HaulerClass)[keyof typeof HaulerClass];

export const HAULER_NAMES: Record<HaulerClassValue, string> = {
  [HaulerClass.Standard]: 'hauler',
  [HaulerClass.Long]: 'long hauler',
  [HaulerClass.Big]: 'big hauler',
  [HaulerClass.Heavy]: 'heavy hauler',
};

/** Why a crate cannot be lifted, or null if it can. */
export function liftRefusal(
  hauler: HaulerClassValue,
  material: CrateMaterialValue,
  shape: CrateShapeValue,
): string | null {
  if (material === CrateMaterial.Steel && hauler !== HaulerClass.Heavy) {
    return 'needs a heavy hauler';
  }
  if (shape === CrateShape.Long && hauler !== HaulerClass.Long && hauler !== HaulerClass.Big) {
    return 'needs a long hauler';
  }
  if (shape === CrateShape.Large && hauler !== HaulerClass.Big) {
    return 'needs a big hauler';
  }
  return null;
}

export function canLift(
  hauler: HaulerClassValue,
  material: CrateMaterialValue,
  shape: CrateShapeValue,
): boolean {
  return liftRefusal(hauler, material, shape) === null;
}
