import { makeRng, type Rng } from '../core/mathUtils';
import { CRATE_UNIT, CrateMaterial, CrateShape, type CrateMaterialValue, type CrateShapeValue } from './cargo';
import { BERTH } from './level';

/**
 * The supply side of the port.
 *
 * A flatbed berths in the clear channel between the two jetties, drops ramps
 * onto both of them, and waits while machines take its cargo off. It leaves
 * when it is empty and nothing is still aboard, and another comes along later.
 *
 * This is what replaces the fixed stock the building starts with. The abandoned
 * crates on the floor are a one-off; the water is the job.
 */

export const BoatState = {
  Away: 0,
  Arriving: 1,
  Mooring: 2,
  Berthed: 3,
  Casting: 4,
  Leaving: 5,
} as const;
export type BoatStateValue = (typeof BoatState)[keyof typeof BoatState];

/** Hull, sized to sit in the channel with a working gap either side. */
export const BOAT_W = BERTH.x1 - BERTH.x0 - 220;
export const BOAT_H = BERTH.y1 - BERTH.y0 - 420;
export const BOAT_X = (BERTH.x0 + BERTH.x1) / 2;
export const BOAT_Y = (BERTH.y0 + BERTH.y1) / 2;

/** Deck grid. Crates sit on it the way they sit in a trailer. */
export const DECK_COLS = 8;
export const DECK_ROWS = 4;
export const DECK_SLOTS = DECK_COLS * DECK_ROWS;

/**
 * How far the ramps reach from the hull onto each jetty.
 *
 * Has to clear more than the 210 cm gap. Robots are kept back from the water's
 * edge by their own radius plus the clearance margin, so a ramp that merely
 * touched the jetty landed on ground the pathfinder already refuses — the deck
 * came out an island nothing could reach. This lands three metres inboard of
 * the edge, which is also what a ramp actually looks like.
 */
export const RAMP_REACH = 520;
export const RAMP_WIDTH = 520;
/** How far a ramp reaches back over the deck, so the two never leave a gap. */
const RAMP_OVERLAP = 300;

const ARRIVE_TIME = 5.0;
const MOOR_TIME = 1.8;
const CAST_TIME = 1.8;
const LEAVE_TIME = 5.0;

/** How far west the boat sits when it is away — out through the dock mouth. */
const AWAY_OFFSET = 9000;

export interface BoatCargo {
  material: CrateMaterialValue;
  shape: CrateShapeValue;
}

export interface Boat {
  state: BoatStateValue;
  elapsed: number;
  /** 0 away, 1 alongside. */
  moored: number;
  /** 0 ramps stowed, 1 down on the jetties. */
  ramps: number;
  /** In-game hours still to wait before the next one comes. */
  awayHours: number;
  cargo: Array<BoatCargo | null>;
}

export class BoatDock {
  readonly boat: Boat;
  private readonly rng: Rng;
  /** Nothing arrives until the port is open for business. */
  open = false;

  /** Something worth hearing: mooring lines, ramps, engines. */
  onSound: ((what: 'arrive' | 'ramps' | 'depart') => void) | null = null;

  constructor(seed: number) {
    this.rng = makeRng(seed ^ 0x51b0);
    this.boat = {
      state: BoatState.Away,
      elapsed: 0,
      moored: 0,
      ramps: 0,
      awayHours: 0,
      cargo: new Array(DECK_SLOTS).fill(null),
    };
  }

  /** True while machines may drive aboard. */
  static isBoarding(b: Boat): boolean {
    return b.state === BoatState.Berthed;
  }

  /** World position of a deck slot. */
  static slotPosition(slot: number): { x: number; y: number } {
    const col = slot % DECK_COLS;
    const row = Math.floor(slot / DECK_COLS);
    return {
      x: BOAT_X + (col - (DECK_COLS - 1) / 2) * CRATE_UNIT,
      y: BOAT_Y + (row - (DECK_ROWS - 1) / 2) * CRATE_UNIT,
    };
  }

  /** Where the hull is right now, given how far along the approach it is. */
  static hullX(b: Boat): number {
    return BOAT_X - (1 - b.moored) * AWAY_OFFSET;
  }

  static isEmpty(b: Boat): boolean {
    return b.cargo.every((c) => c === null);
  }

  /**
   * True if a point is on the deck or on one of the ramps.
   *
   * `pad` is normally negative: the pathfinder asks whether a machine's whole
   * body is on solid ground, not just its centre. That is why the ramps run
   * INTO the deck rather than starting at the hull edge — inset by a robot
   * radius, a deck region and a ramp region that merely touch leave a band
   * between them that belongs to neither, and the deck comes out unreachable.
   */
  static aboard(b: Boat, x: number, y: number, pad = 0): boolean {
    if (b.ramps < 0.98) return false;
    const hx = BoatDock.hullX(b);
    if (Math.abs(x - hx) < BOAT_W / 2 + pad && Math.abs(y - BOAT_Y) < BOAT_H / 2 + pad) {
      return true;
    }
    if (Math.abs(x - hx) > RAMP_WIDTH / 2 + pad) return false;
    const north = BOAT_Y - BOAT_H / 2;
    const south = BOAT_Y + BOAT_H / 2;
    return (
      (y < north + RAMP_OVERLAP && y > north - RAMP_REACH - pad) ||
      (y > south - RAMP_OVERLAP && y < south + RAMP_REACH + pad)
    );
  }

  /**
   * Loads a boat with work.
   *
   * Mostly what the current machines can actually lift, with a scattering of
   * what they cannot — a boat that is all steel is a boat that wasted a trip,
   * and one that is all timber never shows the player what they are missing.
   */
  private fill(count: number): void {
    this.boat.cargo.fill(null);
    for (let i = 0; i < Math.min(count, DECK_SLOTS); i++) {
      const roll = this.rng.next();
      const shape: CrateShapeValue =
        roll < 0.78 ? CrateShape.Unit : roll < 0.93 ? CrateShape.Long : CrateShape.Large;
      const material: CrateMaterialValue =
        this.rng.chance(0.78) ? CrateMaterial.Timber : CrateMaterial.Steel;
      this.boat.cargo[i] = { material, shape };
    }
  }

  /** Brings the next boat forward, whatever the cycle was going to do. */
  callEarly(): void {
    if (this.boat.state === BoatState.Away) this.boat.awayHours = 0;
  }

  /**
   * Advances the boat. Returns true when the set of drivable ground changed and
   * the nav grid needs the water strip re-rasterising.
   *
   * `occupied` reports whether anything of ours is still aboard — a boat that
   * cast off with a machine on the deck would carry it out to sea.
   */
  update(dt: number, hours: number, occupied: () => boolean, load: number): boolean {
    const b = this.boat;
    const wasBoarding = BoatDock.isBoarding(b);
    b.elapsed += dt;

    switch (b.state) {
      case BoatState.Away:
        b.moored = 0;
        b.ramps = 0;
        if (!this.open) break;
        b.awayHours = Math.max(0, b.awayHours - hours);
        if (b.awayHours <= 0) {
          this.fill(load);
          this.onSound?.('arrive');
          this.enter(BoatState.Arriving);
        }
        break;

      case BoatState.Arriving: {
        const p = Math.min(1, b.elapsed / ARRIVE_TIME);
        // Eased, so it slows as it comes alongside.
        b.moored = 1 - (1 - p) * (1 - p);
        if (p >= 1) {
          this.onSound?.('ramps');
          this.enter(BoatState.Mooring);
        }
        break;
      }

      case BoatState.Mooring:
        b.moored = 1;
        b.ramps = Math.min(1, b.elapsed / MOOR_TIME);
        if (b.elapsed >= MOOR_TIME) this.enter(BoatState.Berthed);
        break;

      case BoatState.Berthed:
        b.moored = 1;
        b.ramps = 1;
        // It waits as long as it takes. Working fast is what gets the next one
        // here sooner; working slowly just means this one sits there.
        if (BoatDock.isEmpty(b) && !occupied()) {
          this.onSound?.('ramps');
          this.enter(BoatState.Casting);
        }
        break;

      case BoatState.Casting:
        b.moored = 1;
        // Still checked: a machine can drive back aboard mid-lift.
        if (occupied()) {
          b.ramps = Math.min(1, b.ramps + dt / CAST_TIME);
          if (b.ramps >= 1) this.enter(BoatState.Berthed);
          break;
        }
        b.ramps = Math.max(0, 1 - b.elapsed / CAST_TIME);
        if (b.elapsed >= CAST_TIME) {
          this.onSound?.('depart');
          this.enter(BoatState.Leaving);
        }
        break;

      case BoatState.Leaving: {
        const p = Math.min(1, b.elapsed / LEAVE_TIME);
        b.ramps = 0;
        b.moored = 1 - p * p;
        if (p >= 1) {
          this.enter(BoatState.Away);
          b.awayHours = this.rng.range(1.2, 2.6);
        }
        break;
      }
    }

    return BoatDock.isBoarding(b) !== wasBoarding;
  }

  private enter(state: BoatStateValue): void {
    this.boat.state = state;
    this.boat.elapsed = 0;
  }
}
