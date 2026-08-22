import { BoatDock, BOAT_H, BOAT_W, BOAT_X, BOAT_Y, RAMP_REACH, RAMP_WIDTH, type Boat } from '../sim/boats';
import { crateQuad, crateRegion } from './crateArt';
import { FLOOR, SHOP_DOOR, SHOP_ROOM, TRICKLE_SOCKET, type ShopPlate } from '../sim/level';
import type { Progress } from '../sim/progress';
import { UPGRADE_BY_ID } from '../sim/progress';
import { BOARD_FIELDS, BOARD_ART_WIDTH, REGIONS, glyphRegion } from './atlas';
import type { Bounds } from './lighting';
import type { SpriteBatch } from './spriteBatch';

/**
 * The upgrade room and the boat, drawn.
 *
 * Both are plain on purpose. They have to work and read correctly before they
 * are worth any time — the shapes will change once there is something to react
 * to.
 */

const TILE = 300;
/** How the price and level text is sized, in world centimetres per glyph. */
const SIGN_SIZE = 46;
const SIGN_ADVANCE = SIGN_SIZE * 0.6;

const SIGN_OK = { r: 0.52, g: 1.0, b: 0.66 };
const SIGN_POOR = { r: 1.0, g: 0.48, b: 0.34 };
const SIGN_DONE = { r: 0.55, g: 0.72, b: 0.85 };

function overlaps(b: Bounds, x0: number, y0: number, x1: number, y1: number): boolean {
  return !(b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1);
}

/** Money with thousands separators, the way the board writes it. */
function money(value: number): string {
  const digits = Math.round(Math.abs(value)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return '$' + out;
}

export class ShopRenderer {
  /** Floor, walls and the purchase points, into the albedo pass. */
  collect(batch: SpriteBatch, bounds: Bounds, plates: ReadonlyArray<ShopPlate>): void {
    if (!overlaps(bounds, SHOP_ROOM.x0, SHOP_ROOM.y0, SHOP_ROOM.x1, FLOOR.y)) return;

    // Floor, tiled. The room reaches down through the wall band at the doorway
    // so the corridor does not read as a hole in the building.
    for (let y = SHOP_ROOM.y0; y < SHOP_ROOM.y1; y += TILE) {
      for (let x = SHOP_ROOM.x0; x < SHOP_ROOM.x1; x += TILE) {
        batch.pushRegion(REGIONS.shopFloor, x + TILE / 2, y + TILE / 2, 0, TILE, TILE, 1, 1, 1, 1);
      }
    }
    const doorDepth = FLOOR.y - SHOP_ROOM.y1;
    batch.pushRegion(
      REGIONS.shopFloor, SHOP_DOOR.x, SHOP_ROOM.y1 + doorDepth / 2, 0,
      SHOP_DOOR.width, doorDepth, 1, 1, 1, 1,
    );

    // Walls: a dark band around the three outside edges.
    const t = 90;
    const w = SHOP_ROOM.x1 - SHOP_ROOM.x0;
    const h = SHOP_ROOM.y1 - SHOP_ROOM.y0;
    const mid = (SHOP_ROOM.y0 + SHOP_ROOM.y1) / 2;
    batch.pushRegion(REGIONS.hardShadow, (SHOP_ROOM.x0 + SHOP_ROOM.x1) / 2, SHOP_ROOM.y0 + t / 2, 0,
      w, t, 0.16, 0.18, 0.20, 1);
    batch.pushRegion(REGIONS.hardShadow, SHOP_ROOM.x0 + t / 2, mid, 0, t, h, 0.16, 0.18, 0.20, 1);
    batch.pushRegion(REGIONS.hardShadow, SHOP_ROOM.x1 - t / 2, mid, 0, t, h, 0.16, 0.18, 0.20, 1);

    for (const plate of plates) {
      batch.pushRegion(
        REGIONS.shopPlate, plate.x, plate.y, 0, plate.size, plate.size, 1, 1, 1, 1,
      );
    }

    // The trickle socket, out on the slab by the door.
    batch.pushRegion(
      REGIONS.dockPlate, TRICKLE_SOCKET.x, TRICKLE_SOCKET.y, 0,
      TRICKLE_SOCKET.size, TRICKLE_SOCKET.size, 0.62, 0.66, 0.70, 1,
    );
  }

  /**
   * The signs over each purchase point, into the emissive pass.
   *
   * Price in green when it can be paid, red when it cannot, blue when the line
   * is finished. That is the entire interface — no menu, no tooltip, and the
   * colour carries it at a glance from across the room.
   */
  collectSigns(
    batch: SpriteBatch,
    bounds: Bounds,
    plates: ReadonlyArray<ShopPlate>,
    progress: Progress,
    bot: number,
  ): void {
    if (!overlaps(bounds, SHOP_ROOM.x0, SHOP_ROOM.y0, SHOP_ROOM.x1, FLOOR.y)) return;
    for (const plate of plates) {
      const def = UPGRADE_BY_ID.get(plate.upgrade);
      if (!def || !progress.visible(def)) continue;
      const next = progress.nextLevel(def, bot);
      const text = next === 0 ? '-' : money(def.price(next));
      const tint = next === 0 ? SIGN_DONE : progress.canAfford(def, bot) ? SIGN_OK : SIGN_POOR;
      this.write(batch, text, plate.x, plate.y - plate.size * 0.78, tint);

      // Level pips under the plate: how far along this line already is.
      const owned = def.scope === 1 ? progress.levelOf(def.id) : progress.botLevelOf(bot, def.id);
      const shown = Math.min(def.levels, 10);
      const step = 26;
      const left = plate.x - ((shown - 1) * step) / 2;
      for (let i = 0; i < shown; i++) {
        const lit = i < Math.min(owned, shown);
        batch.pushRegion(
          REGIONS.dot, left + i * step, plate.y + plate.size * 0.66, 0, 20, 20,
          lit ? SIGN_OK.r : 0.4, lit ? SIGN_OK.g : 0.44, lit ? SIGN_OK.b : 0.5,
          lit ? 0.95 : 0.30,
        );
      }
    }
  }

  private write(
    batch: SpriteBatch, text: string, cx: number, cy: number,
    tint: { r: number; g: number; b: number },
  ): void {
    const originX = cx - ((text.length - 1) * SIGN_ADVANCE) / 2;
    for (let i = 0; i < text.length; i++) {
      const region = glyphRegion(text[i]);
      if (!region) continue;
      batch.pushRegion(
        region, originX + i * SIGN_ADVANCE, cy, 0, SIGN_SIZE, SIGN_SIZE,
        tint.r, tint.g, tint.b, 0.95,
      );
    }
    void BOARD_FIELDS;
    void BOARD_ART_WIDTH;
  }

  /** The boat: hull, ramps and whatever is still on the deck. */
  collectBoat(batch: SpriteBatch, boat: Boat, bounds: Bounds): void {
    if (boat.moored <= 0.001) return;
    const hx = BoatDock.hullX(boat);
    if (!overlaps(bounds, hx - BOAT_W, BOAT_Y - BOAT_H, hx + BOAT_W, BOAT_Y + BOAT_H)) return;

    // Hull.
    batch.pushRegion(REGIONS.trailerDeck, hx, BOAT_Y, 0, BOAT_W, BOAT_H, 0.86, 0.88, 0.92, 1);
    // Gunwales, so the deck reads as something you drive onto rather than a raft.
    const rail = 46;
    batch.pushRegion(REGIONS.hardShadow, hx - BOAT_W / 2 + rail / 2, BOAT_Y, 0,
      rail, BOAT_H, 0.22, 0.25, 0.29, 1);
    batch.pushRegion(REGIONS.hardShadow, hx + BOAT_W / 2 - rail / 2, BOAT_Y, 0,
      rail, BOAT_H, 0.22, 0.25, 0.29, 1);

    // Ramps, north and south, dropping onto the jetties.
    if (boat.ramps > 0.001) {
      const reach = RAMP_REACH * boat.ramps;
      for (const side of [-1, 1]) {
        const edge = BOAT_Y + side * (BOAT_H / 2);
        batch.pushRegion(
          REGIONS.trailerDeck, hx, edge + side * (reach / 2), 0,
          RAMP_WIDTH, reach, 0.70, 0.72, 0.76, 1,
        );
      }
    }
  }

  /** Deck cargo still aboard, for a boat that is not berthed. */
  collectBoatCargo(batch: SpriteBatch, boat: Boat, bounds: Bounds): void {
    if (boat.moored <= 0.001 || BoatDock.isBoarding(boat)) return;
    const shift = BoatDock.hullX(boat) - BOAT_X;
    for (let slot = 0; slot < boat.cargo.length; slot++) {
      const load = boat.cargo[slot];
      if (!load) continue;
      const pos = BoatDock.slotPosition(slot);
      if (!overlaps(bounds, pos.x + shift - 200, pos.y - 200, pos.x + shift + 200, pos.y + 200)) {
        continue;
      }
      const q = crateQuad(load.shape);
      batch.pushRegion(
        crateRegion(load.material, load.shape), pos.x + shift, pos.y, 0, q.w, q.h, 1, 1, 1, 1,
      );
    }
  }
}
