import { CrateMaterial, CrateShape, shapeSize, type CrateMaterialValue, type CrateShapeValue } from '../sim/cargo';
import { CRATE_FILL, REGIONS, type Region } from './atlas';

/**
 * Mapping from a crate's material and shape to its sprite and quad size.
 *
 * The quad is always derived from the shape's CANONICAL footprint, never from
 * the world-axis one — a 1x2 lying east-west is the same art turned a quarter,
 * and using the rotated footprint would stretch it flat.
 */

const REGION_BY_KIND: Record<number, Record<number, Region>> = {
  [CrateMaterial.Timber]: {
    [CrateShape.Unit]: REGIONS.crateTimber,
    [CrateShape.Long]: REGIONS.crateTimberLong,
    [CrateShape.Large]: REGIONS.crateTimberLarge,
  },
  [CrateMaterial.Steel]: {
    [CrateShape.Unit]: REGIONS.crateSteel,
    [CrateShape.Long]: REGIONS.crateSteelLong,
    [CrateShape.Large]: REGIONS.crateSteelLarge,
  },
};

export function crateRegion(
  material: CrateMaterialValue,
  shape: CrateShapeValue,
): Region {
  return REGION_BY_KIND[material][shape];
}

/** Quad size that renders this shape at its true footprint. */
export function crateQuad(shape: CrateShapeValue): { w: number; h: number } {
  const { w, h } = shapeSize(shape);
  const fill = CRATE_FILL[shape];
  return { w: w / fill.w, h: h / fill.h };
}

/** Quad size for the corner-bracket outline around a crate of this shape. */
export function outlineQuad(shape: CrateShapeValue, pad = 34): { w: number; h: number } {
  const { w, h } = shapeSize(shape);
  const fill = CRATE_FILL[CrateShape.Unit];
  return { w: (w + pad) / fill.w, h: (h + pad) / fill.h };
}
