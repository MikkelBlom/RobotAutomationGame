import type { LightingState } from '../core/dayCycle';
import type { Settings } from '../core/settings';
import type { LevelGeometry } from '../sim/level';
import { CRATE_ART_FILL, REGIONS } from './atlas';
import type { SpriteBatch } from './spriteBatch';

/** Sodium vapour work lamps. */
const LAMP_COLOR = { r: 1.0, g: 0.58, b: 0.26 };

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function visible(b: Bounds, x: number, y: number, pad: number): boolean {
  return x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
}

/**
 * Draws a cast shadow.
 *
 * A shadow is the object's footprint SWEPT along the light direction: it starts
 * underneath the object and stretches away from it, growing longer as the sun
 * drops. Simply offsetting a scaled-up blob — which is what this used to do —
 * gives a shape that ignores the light angle entirely and, at large offsets,
 * detaches and floats with nothing casting it.
 *
 * The quad is rotated to the light, made (footprint + length) long, and centred
 * half a length away so its near end stays anchored on the object.
 */
export function pushCastShadow(
  batch: SpriteBatch,
  x: number,
  y: number,
  footprint: number,
  lightAngle: number,
  length: number,
  alpha: number,
): void {
  const half = length * 0.5;
  batch.pushRegion(
    REGIONS.blockShadow,
    x + Math.cos(lightAngle) * half,
    y + Math.sin(lightAngle) * half,
    lightAngle,
    footprint + length,
    footprint,
    0, 0, 0, alpha,
  );
}

/**
 * Fills the light-accumulation batches for one frame.
 *
 * Order matters at draw time: ambient clear, then additive sources, then
 * shadows multiplied over the result. That way a column standing in a pool of
 * daylight cuts a dark streak through the pool, rather than the pool simply
 * winning.
 */
export class LightingPass {
  constructor(private readonly level: LevelGeometry) {}

  collectDaylight(
    batch: SpriteBatch,
    lighting: LightingState,
    bounds: Bounds,
    settings: Settings,
  ): void {
    if (!settings.lighting || lighting.sunIntensity <= 0.02) return;

    const [r, g, b] = lighting.sunColor;
    const strength = lighting.sunIntensity;

    for (const sky of this.level.skylights) {
      // The pool keeps the strip's own orientation and slides with the sun.
      // Rotating it to face the sun turned the whole floor into a diamond grid.
      const x = sky.x + lighting.sunOffsetX;
      const y = sky.y + lighting.sunOffsetY;
      // A low sun smears the strip sideways rather than lengthening it.
      const w = sky.w * lighting.sunStretch;
      const h = sky.h;
      if (!visible(bounds, x, y, Math.max(w, h))) continue;
      const a = strength * sky.intensity;
      batch.pushRegion(REGIONS.shaft, x, y, 0, w, h, r, g, b, a * 0.52);
      // A tighter, brighter core inside the shaft.
      batch.pushRegion(REGIONS.shaft, x, y, 0, w * 0.46, h * 0.9, r, g, b, a * 0.30);
    }
  }

  collectLamps(
    batch: SpriteBatch,
    lighting: LightingState,
    bounds: Bounds,
    time: number,
    settings: Settings,
  ): void {
    if (!settings.lighting || lighting.lampIntensity <= 0.01) return;

    for (const lamp of this.level.lamps) {
      if (!visible(bounds, lamp.x, lamp.y, lamp.radius)) continue;
      let level = lighting.lampIntensity * lamp.intensity;
      if (lamp.flickers) {
        const f = Math.sin(time * 7.3 + lamp.phase) * Math.sin(time * 2.1 + lamp.phase * 1.7);
        level *= 0.76 + 0.24 * Math.abs(f);
      }
      const d = lamp.radius * 2;
      batch.pushRegion(
        REGIONS.radial, lamp.x, lamp.y, 0, d, d,
        LAMP_COLOR.r, LAMP_COLOR.g, LAMP_COLOR.b, level * 0.60,
      );
      // Hot core right under the fitting.
      batch.pushRegion(
        REGIONS.radial, lamp.x, lamp.y, 0, d * 0.30, d * 0.30,
        1.0, 0.80, 0.54, level * 0.55,
      );
    }
  }

  /**
   * Column shadows. Direction and length follow the same vector that slides the
   * daylight pools, so pools and shadows always agree about where the sun is.
   */
  collectShadows(
    batch: SpriteBatch,
    lighting: LightingState,
    bounds: Bounds,
    settings: Settings,
  ): void {
    if (!settings.shadows || !settings.columns) return;

    const angle = Math.atan2(lighting.shadowOffsetY, lighting.shadowOffsetX);
    const length = Math.hypot(lighting.shadowOffsetX, lighting.shadowOffsetY);
    // Daylight throws a hard shadow; at night the lamps surround a column from
    // several sides and only a soft pool of occlusion survives.
    const directional = Math.min(1, lighting.sunIntensity * 0.85 + 0.15);

    for (const col of this.level.columns) {
      if (!visible(bounds, col.x, col.y, col.size * 3 + length)) continue;
      // Columns are tall, so they throw the longest shadows in the hall.
      pushCastShadow(
        batch, col.x, col.y, col.size * 1.35, angle, length * 2.2, 0.5 * directional,
      );
      // Occlusion tucked under the base plate, always present.
      batch.pushRegion(
        REGIONS.hardShadow, col.x, col.y, 0,
        col.size * 1.5, col.size * 1.5, 0, 0, 0, 0.45,
      );
    }
  }

  /** Columns themselves, into the albedo pass. */
  collectColumns(batch: SpriteBatch, bounds: Bounds, settings: Settings): void {
    if (!settings.columns) return;
    for (const col of this.level.columns) {
      if (!visible(bounds, col.x, col.y, col.size * 2)) continue;
      const s = col.size * 1.9;
      batch.pushRegion(REGIONS.column, col.x, col.y, 0, s, s, 1, 1, 1, 1);
    }
  }

  /** Abandoned cargo, into the albedo pass. */
  collectProps(batch: SpriteBatch, bounds: Bounds, settings: Settings): void {
    if (!settings.props) return;
    for (const prop of this.level.props) {
      if (!visible(bounds, prop.x, prop.y, prop.size * 2)) continue;
      const region =
        prop.variant === 0 ? REGIONS.crateTimber
        : prop.variant === 1 ? REGIONS.crateSteel
        : REGIONS.palletStack;
      // prop.size is the crate's real footprint; the quad has to be larger
      // because the art does not fill its cell.
      const s = prop.size / CRATE_ART_FILL;
      batch.pushRegion(region, prop.x, prop.y, prop.angle, s, s, 1, 1, 1, 1);
    }
  }

  /** Shadows the cargo throws, laid onto the floor. */
  collectPropShadows(
    batch: SpriteBatch,
    lighting: LightingState,
    bounds: Bounds,
    settings: Settings,
  ): void {
    if (!settings.shadows || !settings.props) return;
    const angle = Math.atan2(lighting.shadowOffsetY, lighting.shadowOffsetX);
    const length = Math.hypot(lighting.shadowOffsetX, lighting.shadowOffsetY);
    const directional = Math.min(1, lighting.sunIntensity * 0.85 + 0.15);

    for (const prop of this.level.props) {
      if (!visible(bounds, prop.x, prop.y, prop.size * 3 + length)) continue;
      // A crate is about knee height, so its shadow is much shorter than a
      // column's for the same sun.
      pushCastShadow(
        batch, prop.x, prop.y, prop.size * 0.95, angle, length * 0.55, 0.48 * directional,
      );
      batch.pushRegion(
        REGIONS.hardShadow, prop.x, prop.y, prop.angle,
        prop.size * 1.0, prop.size * 1.0, 0, 0, 0, 0.5,
      );
    }
  }
}
