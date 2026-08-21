import type { LightingState } from '../core/dayCycle';
import type { Settings } from '../core/settings';
import { BOT_LENGTH, BOT_RADIUS, BOT_WIDTH, BotState, BotTask, type BotPool } from '../sim/bots';
import { BOT_ART, REGIONS } from './atlas';
import { crateQuad, crateRegion, outlineQuad } from './crateArt';
import type { CrateMaterialValue, CrateShapeValue } from '../sim/cargo';
import { pushCastShadow, type Bounds } from './lighting';
import type { SpriteBatch } from './spriteBatch';

/**
 * Draws robots and their order feedback. Split across the renderer's passes:
 * bodies into albedo, contact shadows into the light buffer, headlights as
 * additive light, and trails/selection unlit on top.
 */

/** Track links are 22 cm apart in the art; four frames cover one pitch. */
const TRACK_PITCH = 22 * (165 / 200);

/** The atlas cell is larger than the hull, so convert once. */
const SPRITE_W = BOT_LENGTH * (BOT_ART.cell / (BOT_ART.halfLength * 2));
const SPRITE_H = BOT_WIDTH * (BOT_ART.cell / (BOT_ART.halfWidth * 2));

const TRAIL = { r: 0.36, g: 0.84, b: 1.0 };
const TRAIL_PALE = { r: 0.72, g: 0.95, b: 1.0 };
const SELECT = { r: 0.45, g: 0.89, b: 1.0 };

/**
 * Loader arm geometry, in centimetres.
 *
 * The boom occupies only about a tenth of its atlas cell, so ARM_WIDTH is the
 * height of the whole cell, not of the visible arm — the boom itself ends up
 * around 20 cm across.
 */
const ARM_STOWED = 45;
const ARM_TRAVEL = 88;
const ARM_WIDTH = 200;
/** How far out from the centreline the arms sit, stowed and fully spread. */
const ARM_SPREAD_IN = 0.30;
const ARM_SPREAD_OUT = 0.62;
/** How much a crate grows as it comes off the floor, selling the height. */
const LIFT_RISE = 0.16;



const BOT_FRAMES = [
  REGIONS.botBody0, REGIONS.botBody1, REGIONS.botBody2, REGIONS.botBody3,
];

/** Spacing between trail dots, in world units. */
const TRAIL_STEP = 46;
/** Hard cap so a huge selection cannot flood the batch. */
const MAX_TRAIL_DOTS = 4000;

function visible(b: Bounds, x: number, y: number, pad: number): boolean {
  return x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
}

export class EntityRenderer {
  constructor(private readonly bots: BotPool) {}

  /**
   * Robot bodies, into the albedo pass. The track frame is chosen from distance
   * driven, so the links visibly walk when the robot moves and stop when it
   * does — four baked frames cost nothing extra, they are just different UVs.
   */
  drawBodies(batch: SpriteBatch, bounds: Bounds): void {
    const b = this.bots;
    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH)) continue;
      const frame = ((Math.floor(b.odometer[i] / TRACK_PITCH * 4) % 4) + 4) % 4;
      batch.pushRegion(
        BOT_FRAMES[frame], b.x[i], b.y[i], b.angle[i], SPRITE_W, SPRITE_H, 1, 1, 1, 1,
      );
    }
  }

  /** Cast shadows, laid onto the floor before the robots stand on it. */
  drawShadows(batch: SpriteBatch, bounds: Bounds, lighting: LightingState, settings: Settings): void {
    if (!settings.shadows) return;
    const b = this.bots;
    const angle = Math.atan2(lighting.shadowOffsetY, lighting.shadowOffsetX);
    const length = Math.hypot(lighting.shadowOffsetX, lighting.shadowOffsetY);
    const directional = Math.min(1, lighting.sunIntensity * 0.7 + 0.3);

    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH * 2 + length)) continue;
      // A robot is low, so its shadow is short even when a column's is long.
      pushCastShadow(
        batch, b.x[i], b.y[i], BOT_WIDTH * 1.15, angle, length * 0.42, 0.44 * directional,
      );
      // The hull's own footprint, which the robot then covers.
      batch.pushRegion(
        REGIONS.hardShadow, b.x[i], b.y[i], b.angle[i],
        SPRITE_W * 0.86, SPRITE_H * 0.90, 0, 0, 0, 0.5,
      );

      // A crate being lifted leaves its shadow behind on the floor, shrinking
      // and fading as it rises.
      const t = b.liftT[i];
      if (b.carryMaterial[i] >= 0 && t < 1) {
        const e = t * t * (3 - 2 * t);
        const shrink = 1 - e * 0.45;
        const q = crateQuad(b.carryShape[i] as CrateShapeValue);
        batch.pushRegion(
          REGIONS.hardShadow,
          b.liftFromX[i], b.liftFromY[i], b.angle[i],
          q.w * 0.8 * shrink, q.h * 0.8 * shrink,
          0, 0, 0, 0.55 * (1 - e * 0.7),
        );
      }
    }
  }

  /** Headlights and beacons, added into the light buffer. */
  drawLights(batch: SpriteBatch, bounds: Bounds, lighting: LightingState, settings: Settings): void {
    if (!settings.lighting) return;
    const b = this.bots;
    // Robot lamps matter at night and wash out at noon; keep a trace of them so
    // the machine still reads as powered in daylight.
    const nightness = 1 - Math.min(1, lighting.sunIntensity * 0.9);
    const strength = 0.22 + nightness * 0.78;

    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], 900)) continue;
      const cos = Math.cos(b.angle[i]);
      const sin = Math.sin(b.angle[i]);

      // Headlight cone, thrown ahead of the nose.
      const reach = 620;
      const cx = b.x[i] + cos * reach * 0.42;
      const cy = b.y[i] + sin * reach * 0.42;
      batch.pushRegion(
        REGIONS.cone, cx, cy, b.angle[i], reach, reach * 0.8,
        1.0, 0.88, 0.68, 0.5 * strength,
      );

      // Warm pool directly under the chassis.
      batch.pushRegion(
        REGIONS.radial, b.x[i], b.y[i], 0, 520, 520,
        1.0, 0.72, 0.42, 0.24 * strength,
      );
    }
  }

  /**
   * Loader arms and whatever is riding on the deck.
   *
   * The arms live at the back of the machine and slide out behind it, which is
   * why a robot reverses up to a crate before collecting it. Both are drawn
   * into the albedo pass alongside the body.
   */
  drawLoad(batch: SpriteBatch, bounds: Bounds): void {
    const b = this.bots;
    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH * 2)) continue;
      const cos = Math.cos(b.angle[i]);
      const sin = Math.sin(b.angle[i]);

      const extend = b.armExtend[i];
      if (extend > 0.001) {
        // Arms run rearward, one down each flank.
        const reach = ARM_STOWED + extend * ARM_TRAVEL;
        // The sprite points +x, so face it backwards along the hull.
        const armAngle = b.angle[i] + Math.PI;
        // The arms also swing outboard as they go, so they close around the
        // sides of the crate rather than butting into its face.
        const spread = BOT_WIDTH * (ARM_SPREAD_IN + extend * (ARM_SPREAD_OUT - ARM_SPREAD_IN));
        for (const side of [-1, 1]) {
          const offset = spread * side;
          // Start at the tail, centred on the arm's own length.
          const baseX = b.x[i] - cos * (BOT_LENGTH * 0.48) - sin * offset;
          const baseY = b.y[i] - sin * (BOT_LENGTH * 0.48) + cos * offset;
          const cx = baseX - cos * (reach / 2);
          const cy = baseY - sin * (reach / 2);
          batch.pushRegion(
            REGIONS.botArm, cx, cy, armAngle, reach, ARM_WIDTH, 1, 1, 1, 1,
          );
        }
      }

      if (b.carryMaterial[i] >= 0) {
        const region = crateRegion(
          b.carryMaterial[i] as CrateMaterialValue,
          b.carryShape[i] as CrateShapeValue,
        );
        const q = crateQuad(b.carryShape[i] as CrateShapeValue);

        // Where it ends up: on the deck, towards the back of the machine.
        const deckX = b.x[i] - cos * (BOT_LENGTH * 0.17);
        const deckY = b.y[i] - sin * (BOT_LENGTH * 0.17);

        const t = b.liftT[i];
        if (t >= 1) {
          batch.pushRegion(region, deckX, deckY, b.angle[i], q.w, q.h, 1, 1, 1, 1);
        } else {
          // Travelling from the floor onto the deck. Ease it, and grow it a
          // little on the way: seen from above, rising towards the camera is
          // the only cue that something has left the ground.
          const e = t * t * (3 - 2 * t);
          const cx = b.liftFromX[i] + (deckX - b.liftFromX[i]) * e;
          const cy = b.liftFromY[i] + (deckY - b.liftFromY[i]) * e;
          const rise = 1 + LIFT_RISE * Math.sin(e * Math.PI * 0.5);
          batch.pushRegion(region, cx, cy, b.angle[i], q.w * rise, q.h * rise, 1, 1, 1, 1);
        }
      }
    }
  }

  /** Emissive detail, added after the light multiply so it survives darkness. */
  drawGlow(batch: SpriteBatch, bounds: Bounds, lighting: LightingState, time: number): void {
    const b = this.bots;
    const nightness = 1 - Math.min(1, lighting.sunIntensity * 0.9);
    const strength = 0.45 + nightness * 0.55;

    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH)) continue;
      const blink = 0.6 + 0.4 * Math.sin(time * 3.4 + b.phase[i]);
      batch.pushRegion(
        REGIONS.botGlow, b.x[i], b.y[i], b.angle[i], SPRITE_W, SPRITE_H,
        1, 1, 1, strength * blink,
      );
    }
  }

  /**
   * Order feedback: an animated trail running along the remaining path, and a
   * marker at the destination. Drawn additively so it reads as a projected
   * hologram rather than paint on the floor.
   */
  drawTrails(batch: SpriteBatch, bounds: Bounds, time: number, settings: Settings): void {
    if (!settings.showPaths) return;
    const b = this.bots;
    let dots = 0;

    for (let i = 0; i < b.count && dots < MAX_TRAIL_DOTS; i++) {
      if (b.state[i] !== BotState.Moving) continue;
      if (b.task[i] === BotTask.Fetch && !b.pathOf(i)) continue;
      const path = b.pathOf(i);
      if (!path) continue;
      const selected = b.selected[i] === 1;
      // Unselected robots still show a faint trail so the hall reads as busy.
      const baseAlpha = selected ? 0.85 : 0.28;

      const pts = path.points;
      let prevX = b.x[i];
      let prevY = b.y[i];
      let travelled = 0;
      let carry = 0;

      for (let p = path.cursor; p < pts.length; p += 2) {
        const nx = pts[p];
        const ny = pts[p + 1];
        const segLen = Math.hypot(nx - prevX, ny - prevY);
        if (segLen > 0.001) {
          const ux = (nx - prevX) / segLen;
          const uy = (ny - prevY) / segLen;
          let d = carry;
          while (d < segLen && dots < MAX_TRAIL_DOTS) {
            const px = prevX + ux * d;
            const py = prevY + uy * d;
            const along = travelled + d;
            if (visible(bounds, px, py, 40)) {
              // A pulse runs from the robot towards the destination.
              const wave = Math.sin(along * 0.020 - time * 4.2);
              const pulse = 0.42 + 0.58 * Math.max(0, wave);
              // Fade in just ahead of the robot, out at the far end.
              const lead = Math.min(1, along / 150);
              const alpha = baseAlpha * pulse * lead * 0.5;
              const size = 34 + pulse * 24;
              batch.pushRegion(
                REGIONS.dot, px, py, 0, size, size,
                TRAIL.r, TRAIL.g, TRAIL.b, alpha,
              );
              dots++;
            }
            d += TRAIL_STEP;
          }
          carry = d - segLen;
          travelled += segLen;
        }
        prevX = nx;
        prevY = ny;
      }

      // Destination marker: a slow pulse so it is findable without shouting.
      if (visible(bounds, b.goalX[i], b.goalY[i], 90)) {
        const beat = 0.5 + 0.5 * Math.sin(time * 2.6);
        const size = 150 + beat * 40;
        batch.pushRegion(
          REGIONS.marker, b.goalX[i], b.goalY[i], time * 0.35, size, size,
          TRAIL_PALE.r, TRAIL_PALE.g, TRAIL_PALE.b, baseAlpha * (0.4 + beat * 0.35),
        );
      }

      // Queued legs, straight and dimmer — they have not been pathed yet, so
      // showing a route here would be a lie. Numbered by size instead.
      const queue = b.queueOf(i);
      if (queue && queue.length > 0) {
        let fromX = b.goalX[i];
        let fromY = b.goalY[i];
        for (let q = 0; q < queue.length; q++) {
          const toX = queue[q].x;
          const toY = queue[q].y;
          const legLen = Math.hypot(toX - fromX, toY - fromY);
          const ux = (toX - fromX) / (legLen || 1);
          const uy = (toY - fromY) / (legLen || 1);
          for (let d = 0; d < legLen && dots < MAX_TRAIL_DOTS; d += TRAIL_STEP * 1.9) {
            const px = fromX + ux * d;
            const py = fromY + uy * d;
            if (!visible(bounds, px, py, 40)) continue;
            const wave = Math.sin(d * 0.016 - time * 3.0);
            batch.pushRegion(
              REGIONS.dot, px, py, 0, 26, 26,
              TRAIL.r, TRAIL.g, TRAIL.b,
              baseAlpha * 0.22 * (0.5 + 0.5 * Math.max(0, wave)),
            );
            dots++;
          }
          if (visible(bounds, toX, toY, 90)) {
            batch.pushRegion(
              REGIONS.marker, toX, toY, time * 0.2, 105, 105,
              TRAIL_PALE.r, TRAIL_PALE.g, TRAIL_PALE.b, baseAlpha * 0.4,
            );
          }
          fromX = toX;
          fromY = toY;
        }
      }
    }
  }

  /**
   * Marks the crate a robot has been sent to collect, so it is obvious which
   * one the order landed on before the robot has got anywhere near it.
   */
  drawOrderMarks(
    batch: SpriteBatch,
    bounds: Bounds,
    props: ReadonlyArray<{ x: number; y: number; angle: number; shape: CrateShapeValue }>,
    time: number,
  ): void {
    const b = this.bots;
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    for (let i = 0; i < b.count; i++) {
      // targetProp is cleared the instant the crate leaves the floor, so this
      // only ever marks a crate that is still standing there.
      if (b.task[i] !== BotTask.Fetch || b.targetProp[i] < 0) continue;
      const prop = props[b.targetProp[i]];
      if (!prop) continue;
      if (!visible(bounds, prop.x, prop.y, 400)) continue;
      const o = outlineQuad(prop.shape);
      batch.pushRegion(
        REGIONS.crateOutline, prop.x, prop.y, prop.angle, o.w, o.h,
        1.0, 0.72, 0.24, 0.6 + pulse * 0.4,
      );
    }
  }

  /** Selection reticles, drawn unlit so they stay legible at any time of day. */
  drawSelection(batch: SpriteBatch, bounds: Bounds, time: number): void {
    const b = this.bots;
    const spin = time * 0.55;
    for (let i = 0; i < b.count; i++) {
      if (!b.selected[i]) continue;
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH)) continue;
      const size = BOT_RADIUS * 3.3;
      batch.pushRegion(
        REGIONS.ring, b.x[i], b.y[i], spin, size, size,
        SELECT.r, SELECT.g, SELECT.b, 0.95,
      );
    }
  }
}
