import type { Ledger } from '../sim/economy';
import {
  BOARD_ART_HEIGHT, BOARD_ART_WIDTH, BOARD_FIELDS, REGIONS, glyphRegion,
} from './atlas';
import type { Bounds } from './lighting';
import type { SpriteBatch } from './spriteBatch';

/**
 * The productivity board on the north wall.
 *
 * The whole point of it is that the game never explains itself in words: the
 * quota, the money and the pace are on a screen bolted to the wall, the way
 * they would be in a real hall, and the player reads them or does not.
 *
 * Its numbers are composed from a baked glyph strip rather than a live canvas
 * texture, so the board costs one texture and no re-uploads.
 */

/**
 * Where the board hangs.
 *
 * Above the wall rather than across it: sitting in the wall band it read as
 * painted onto the cladding, and it hid the run of wall behind it. Overlapping
 * the outer face by a little is what keeps it attached to the building.
 */
export const BOARD_RECT = { x: 2600, y: -390, w: 3200, h: 300 } as const;

/** Atlas pixels to world centimetres. Uniform — the art is cut to this ratio. */
const ART_SCALE = BOARD_RECT.w / BOARD_ART_WIDTH;
/** Monospaced advance, as a fraction of glyph size. */
const ADVANCE = 0.60;

const SCREEN = { r: 0.62, g: 1.0, b: 0.88 };
/** Behind quota: the shipped figure goes amber instead of green. */
const BEHIND = { r: 1.0, g: 0.74, b: 0.34 };

function boardVisible(bounds: Bounds): boolean {
  return !(
    bounds.x1 < BOARD_RECT.x - BOARD_RECT.w ||
    bounds.x0 > BOARD_RECT.x + BOARD_RECT.w ||
    bounds.y1 < BOARD_RECT.y - BOARD_RECT.h ||
    bounds.y0 > BOARD_RECT.y + BOARD_RECT.h
  );
}

/** Money with thousands separators. Plain `toLocaleString` can emit spaces. */
function money(value: number): string {
  const digits = Math.round(value).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return '$' + out;
}

function duration(seconds: number): string {
  if (seconds <= 0) return '-';
  return (seconds < 100 ? seconds.toFixed(1) : Math.round(seconds).toString()) + 's';
}

export class QuotaBoard {
  /** Housing, into the albedo pass so it darkens with the rest of the hall. */
  collect(batch: SpriteBatch, bounds: Bounds): void {
    if (!boardVisible(bounds)) return;
    // Stands proud of the wall, so it throws a band down onto it. Without one
    // the board reads as painted on rather than bolted up.
    batch.pushRegion(
      REGIONS.blockShadow, BOARD_RECT.x, BOARD_RECT.y + BOARD_RECT.h * 0.55, 0,
      BOARD_RECT.w * 1.02, BOARD_RECT.h * 1.1, 0, 0, 0, 0.5,
    );
    batch.pushRegion(
      REGIONS.quotaBoard, BOARD_RECT.x, BOARD_RECT.y, 0,
      BOARD_RECT.w, BOARD_RECT.h, 1, 1, 1, 1,
    );
  }

  /** Lit face and readouts, into the emissive pass so they survive the night. */
  collectGlow(batch: SpriteBatch, bounds: Bounds, ledger: Ledger, time: number): void {
    if (!boardVisible(bounds)) return;
    batch.pushRegion(
      REGIONS.quotaScreen, BOARD_RECT.x, BOARD_RECT.y, 0,
      BOARD_RECT.w, BOARD_RECT.h, 1, 1, 1, 0.85,
    );

    // Shipped runs amber until the quota is met, then settles green. A number
    // changing colour is the only "you are behind" the game ever says.
    const met = ledger.shippedToday >= ledger.quota;
    const tint = met ? SCREEN : BEHIND;
    // A slow flicker, as if the tubes are old. Never enough to hinder reading.
    const flicker = 0.94 + 0.06 * Math.sin(time * 2.1 + Math.sin(time * 7.3) * 0.6);

    this.field(
      batch, BOARD_FIELDS.shipped,
      `${ledger.shippedToday}/${ledger.quota}`, tint, flicker,
    );
    this.field(batch, BOARD_FIELDS.revenue, money(ledger.revenue), SCREEN, flicker);
    this.field(batch, BOARD_FIELDS.average, duration(ledger.avgSeconds), SCREEN, flicker);
  }

  /** Lays one readout out centred on its panel. */
  private field(
    batch: SpriteBatch,
    field: { x: number; y: number; size: number },
    text: string,
    tint: { r: number; g: number; b: number },
    alpha: number,
  ): void {
    const size = field.size * ART_SCALE;
    const advance = size * ADVANCE;
    const originX = BOARD_RECT.x + field.x * ART_SCALE - ((text.length - 1) * advance) / 2;
    const y = BOARD_RECT.y + field.y * (BOARD_RECT.h / BOARD_ART_HEIGHT);
    for (let i = 0; i < text.length; i++) {
      const region = glyphRegion(text[i]);
      if (!region) continue;
      batch.pushRegion(
        region, originX + i * advance, y, 0, size, size,
        tint.r, tint.g, tint.b, alpha,
      );
    }
  }
}
