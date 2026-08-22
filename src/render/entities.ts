import type { LightingState } from '../core/dayCycle';
import type { Settings } from '../core/settings';
import { BOT_LENGTH, BOT_RADIUS, BOT_WIDTH, type BotPool } from '../sim/bots';
import { BOT_ART, REGIONS } from './atlas';
import { crateQuad, crateRegion, outlineQuad, outlineRect } from './crateArt';
import type { CrateMaterialValue, CrateShapeValue } from '../sim/cargo';
import { FLOOR } from '../sim/level';
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
/**
 * Two colours, and the difference between them is the whole point.
 *
 * Cyan is a SUGGESTION — the slot a delivery would go to if you ordered one.
 * Green is a COMMITMENT — a crate a machine is on its way to collect, a slot it
 * is on its way to fill, a point it is on its way to dock at. Colour by kind
 * instead and the player learns three signals for one idea while still not
 * knowing which of them they have actually asked for.
 */
const MARK_COMMITTED = { r: 0.42, g: 1.0, b: 0.62 };
const MARK_PREVIEW = { r: 0.45, g: 0.89, b: 1.0 };

/**
 * One step of a robot's plan, ready to draw. Built by the game, which is the
 * only place that can see both a robot's order queue and the trailer's slots.
 */
/** What a mark is about. Each gets its own colour and its own outline size. */
export const MarkKind = { Pick: 0, Drop: 1, Dock: 2 } as const;
export type MarkKindValue = (typeof MarkKind)[keyof typeof MarkKind];

export interface PlanMark {
  x: number;
  y: number;
  angle: number;
  kind: MarkKindValue;
  /** Crate marks only; a dock mark uses `w`/`h` instead. */
  material: CrateMaterialValue;
  shape: CrateShapeValue;
  /** Dock marks only: the footprint to bracket. */
  w?: number;
  h?: number;
  /** 0 for the step in progress, rising down the queue. */
  depth: number;
  /** True once a machine has actually been ordered here. */
  committed: boolean;
}

/** How far inside the slab a queued leg turns before heading into a bay. */
const DOORWAY_INSET = 260;

/** Charge readout geometry, in centimetres on the hull. */
/**
 * Charge gauge, derived from the recess baked into the body art so the light
 * always sits inside its slot however the sprite is scaled.
 */
const ART_X = BOT_LENGTH / (BOT_ART.halfLength * 2);
const ART_Y = BOT_WIDTH / (BOT_ART.halfWidth * 2);
const STRIP_FORWARD = BOT_ART.gauge.x * ART_X;
/** A hair inside the well, so its edge frames the light on every side. */
const STRIP_LENGTH = BOT_ART.gauge.halfLen * 2 * ART_Y - 5;
const STRIP_WIDTH = BOT_ART.gauge.halfWide * 2 * ART_X - 4;

const CHARGE_FULL = { r: 0.42, g: 1.0, b: 0.56 };
const CHARGE_MID = { r: 1.0, g: 0.80, b: 0.24 };
const CHARGE_LOW = { r: 1.0, g: 0.28, b: 0.20 };
const FLAT_TINT = { r: 0.72, g: 0.14, b: 0.12 };
/**
 * How hard the gauge is driven into the additive pass. Below one on purpose:
 * at full strength it blew out its own housing and read as an overlay again.
 */
const GAUGE_GAIN = 0.78;

function mixTint(
  a: { r: number; g: number; b: number },
  c: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return { r: a.r + (c.r - a.r) * t, g: a.g + (c.g - a.g) * t, b: a.b + (c.b - a.b) * t };
}

const EMPTY_PATH = new Float32Array(0);

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

  /**
   * The charge readout on every robot, into the emissive pass.
   *
   * Green down to amber down to red as it empties, and a flat machine pulses a
   * dull red so a stopped fleet is obvious at a glance. Charging runs a bright
   * band along the strip. Nothing about this is a UI element — with thousands of
   * machines working there is nowhere to put one.
   */
  drawCharge(batch: SpriteBatch, bounds: Bounds, time: number): void {
    const b = this.bots;
    for (let i = 0; i < b.count; i++) {
      if (!visible(bounds, b.x[i], b.y[i], BOT_LENGTH)) continue;
      const cos = Math.cos(b.angle[i]);
      const sin = Math.sin(b.angle[i]);
      // Across the hull, forward of centre, where nothing else sits.
      const cx = b.x[i] + cos * STRIP_FORWARD;
      const cy = b.y[i] + sin * STRIP_FORWARD;
      const across = b.angle[i] + Math.PI / 2;

      const level = b.battery[i];
      const flat = level <= 0.001;
      const tint = flat
        ? FLAT_TINT
        : level > 0.5
          ? mixTint(CHARGE_MID, CHARGE_FULL, (level - 0.5) * 2)
          : mixTint(CHARGE_LOW, CHARGE_MID, level * 2);
      // A flat robot breathes; a low one blinks; a healthy one is steady.
      const pulse = flat
        ? 0.30 + 0.30 * Math.sin(time * 2.0 + b.phase[i])
        : level < 0.22
          ? 0.62 + 0.38 * Math.max(0, Math.sin(time * 5.5 + b.phase[i]))
          : 1;

      // Filled by taking a SLICE of the strip texture rather than scaling the
      // whole sprite down. Scaling squashed the rounded end cap along with the
      // bar, so a half-empty gauge still finished in a half circle and read as
      // a shrunken bar rather than a drained one.
      const fraction = Math.max(0.05, level);
      const filled = fraction * STRIP_LENGTH;
      const full = REGIONS.chargeStrip;
      const slice = {
        u0: full.u0,
        v0: full.v0,
        u1: full.u0 + (full.u1 - full.u0) * fraction,
        v1: full.v1,
      };
      const shift = (filled - STRIP_LENGTH) * 0.5;
      batch.pushRegion(
        slice,
        cx + Math.cos(across) * shift, cy + Math.sin(across) * shift, across,
        filled, STRIP_WIDTH, tint.r, tint.g, tint.b, pulse * GAUGE_GAIN,
      );

      if (b.charging[i]) {
        // A band running the length of the strip while it fills.
        const sweep = (time * 1.5) % 1;
        const at = (sweep - 0.5) * STRIP_LENGTH;
        batch.pushRegion(
          REGIONS.chargeStrip,
          cx + Math.cos(across) * at, cy + Math.sin(across) * at, across,
          STRIP_LENGTH * 0.24, STRIP_WIDTH,
          CHARGE_FULL.r, CHARGE_FULL.g, CHARGE_FULL.b, 0.7,
        );
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
      const path = b.pathOf(i);
      const queue = b.queueOf(i);
      // A robot with its arms out has no path — it has arrived. Requiring one
      // blanked the whole route for the several seconds a grab takes, which is
      // exactly when you are looking to see what it does next.
      if (!path && !(queue && queue.length > 0)) continue;
      const selected = b.selected[i] === 1;
      // Unselected robots still show a faint trail so the hall reads as busy.
      const baseAlpha = selected ? 0.85 : 0.28;

      const pts = path ? path.points : EMPTY_PATH;
      let prevX = b.x[i];
      let prevY = b.y[i];
      let travelled = 0;
      let carry = 0;

      for (let p = path ? path.cursor : 0; p < pts.length; p += 2) {
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
      // showing a route here would be a lie.
      //
      // The one liberty taken is a dog-leg at the slab edge for anything inside
      // a trailer: a straight line to a loading slot cuts across the wall and
      // out through the dark, which reads as a bug rather than a shortcut.
      if (queue && queue.length > 0) {
        let fromX = b.goalX[i];
        let fromY = b.goalY[i];
        const mouth = FLOOR.y + DOORWAY_INSET;
        const legs: Array<{ x: number; y: number; target: boolean }> = [];
        let curX = fromX;
        let curY = fromY;
        for (const order of queue) {
          const goingIn = order.y < mouth;
          const comingOut = curY < mouth;
          // Turn at the slab edge on the way out as well as on the way in —
          // handling only one direction still left every trailer-to-floor leg
          // slicing across the wall.
          if (comingOut && !goingIn) legs.push({ x: curX, y: mouth, target: false });
          if (!comingOut && goingIn) legs.push({ x: order.x, y: mouth, target: false });
          legs.push({ x: order.x, y: order.y, target: true });
          curX = order.x;
          curY = order.y;
        }
        for (let q = 0; q < legs.length; q++) {
          const toX = legs[q].x;
          const toY = legs[q].y;
          const legLen = Math.hypot(toX - fromX, toY - fromY);
          const ux = (toX - fromX) / (legLen || 1);
          const uy = (toY - fromY) / (legLen || 1);
          // Heavier than they were: at any zoom where you can see the whole
          // job, a queued leg drawn as faint specks is not a line at all, and
          // following the chain from one crate to the next was guesswork.
          for (let d = 0; d < legLen && dots < MAX_TRAIL_DOTS; d += TRAIL_STEP * 1.4) {
            const px = fromX + ux * d;
            const py = fromY + uy * d;
            if (!visible(bounds, px, py, 60)) continue;
            const wave = Math.max(0, Math.sin(d * 0.014 - time * 3.0));
            batch.pushRegion(
              REGIONS.dot, px, py, 0, 40 + wave * 16, 40 + wave * 16,
              TRAIL.r, TRAIL.g, TRAIL.b,
              baseAlpha * 0.40 * (0.45 + 0.55 * wave),
            );
            dots++;
          }
          if (legs[q].target && visible(bounds, toX, toY, 90)) {
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
   * Every crate a selected robot is going to touch, and where each one ends up.
   *
   * The step it is working on right now is drawn at full strength; each step
   * further down the queue is dimmer than the one in front of it. That ordering
   * IS the readout — it says which crate is next and which slot it lands in
   * without a word of text, and it is why the marks are ranked rather than all
   * drawn the same.
   */
  drawPlanMarks(batch: SpriteBatch, bounds: Bounds, plan: PlanMark[], time: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 3.2);
    for (const mark of plan) {
      if (!visible(bounds, mark.x, mark.y, 400)) continue;
      // The live step breathes; queued ones sit still, so movement alone picks
      // out what is happening now.
      const beat = mark.depth === 0 ? pulse : 0.55;
      const rank = mark.depth === 0 ? 1 : Math.max(0.28, 0.62 - mark.depth * 0.09);
      const tint = mark.committed ? MARK_COMMITTED : MARK_PREVIEW;

      if (mark.kind === MarkKind.Dock) {
        // A charging point has no contents to preview — just the bay it is.
        const pad = outlineRect(mark.w ?? 0, mark.h ?? 0);
        batch.pushRegion(
          REGIONS.crateOutline, mark.x, mark.y, 0, pad.w, pad.h,
          tint.r, tint.g, tint.b, (0.6 + beat * 0.4) * rank,
        );
        continue;
      }

      if (mark.kind === MarkKind.Drop) {
        // A translucent crate in the slot. This is what tells a drop apart from
        // a collection, so it has to be plainly visible rather than a hint.
        const q = crateQuad(mark.shape);
        batch.pushRegion(
          crateRegion(mark.material, mark.shape), mark.x, mark.y, mark.angle, q.w, q.h,
          tint.r, tint.g, tint.b, (0.30 + beat * 0.16) * rank,
        );
      }
      const o = outlineQuad(mark.shape);
      batch.pushRegion(
        REGIONS.crateOutline, mark.x, mark.y, mark.angle, o.w, o.h,
        tint.r, tint.g, tint.b, (0.6 + beat * 0.4) * rank,
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
