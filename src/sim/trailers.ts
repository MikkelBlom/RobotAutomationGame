import { makeRng, type Rng } from '../core/mathUtils';
import { CRATE_UNIT, type CrateMaterialValue, type CrateShapeValue } from './cargo';
import { SHELL, TRAILER_DEPTH, TRAILER_WIDTH, type DockBay } from './level';

/**
 * Road trailers working the loading bays.
 *
 * Each bay runs its own cycle: a trailer reverses on, its doors swing open, it
 * sits while it is worked, the doors close and it pulls away. Only a trailer
 * with its doors open counts as dockable — the nav grid is rebuilt whenever
 * that changes, so robots cannot path into one that is about to leave.
 */

export const TrailerState = {
  Away: 0,
  Arriving: 1,
  Opening: 2,
  Docked: 3,
  Closing: 4,
  Leaving: 5,
} as const;
export type TrailerStateValue = (typeof TrailerState)[keyof typeof TrailerState];

/** Slots a trailer holds, as columns across by rows deep. */
export const SLOT_COLS = 3;
export const SLOT_ROWS = 4;
export const SLOT_COUNT = SLOT_COLS * SLOT_ROWS;

/** Clear length left at the rear for a robot to work in. */
const WORKING_LENGTH = 520;

const ARRIVE_TIME = 3.4;
const OPEN_TIME = 1.6;
const CLOSE_TIME = 2.8;
const LEAVE_TIME = 3.2;

/**
 * How long a robot has to hold the dispatch plate before the doors commit.
 *
 * Without the dwell, merely driving across the plate on the way somewhere else
 * would send a half-loaded trailer away. The beacon flashes throughout, so the
 * hold is visible while it is happening rather than a hidden timer.
 */
const PLATE_DWELL = 1.3;

/** How far north a trailer sits when it is away — well past the camera limit. */
export const TRAILER_AWAY_OFFSET = TRAILER_DEPTH + 560;

export interface Trailer {
  bay: DockBay;
  state: TrailerStateValue;
  /** Seconds spent in the current state. */
  elapsed: number;
  /** How long this trailer will stay once docked, or stay away. */
  hold: number;
  /** 0 fully away, 1 backed onto the bay. */
  dock: number;
  /** 0 doors shut, 1 doors swung back. */
  doors: number;
  /** Per-trailer variation so a row of them does not look cloned. */
  tint: number;
  /** What is loaded, indexed by slot. Null slots are empty. */
  cargo: Array<{ material: CrateMaterialValue; shape: CrateShapeValue } | null>;
  /** In-game hours still to wait before coming back. */
  awayHours: number;
  /** Seconds the dispatch plate has been held, while docked. */
  dispatch: number;
  /** Beacon brightness, 0 to 1. Rises while the doors are being sent shut. */
  alarm: number;
}

export class TrailerFleet {
  readonly trailers: Trailer[] = [];
  /**
   * Called once as a trailer pulls out, with what it is taking with it. This is
   * the moment a load actually counts as shipped.
   */
  onDeparted: ((load: Trailer['cargo']) => void) | null = null;
  /** Something happened worth hearing: doors moving, or a trailer on the road. */
  onSound: ((what: 'doors' | 'truck') => void) | null = null;
  private readonly rng: Rng;

  constructor(bays: DockBay[], seed: number) {
    this.rng = makeRng(seed ^ 0x71ac);
    for (let i = 0; i < bays.length; i++) {
      const bay = bays[i];
      // Shuttered bays never take a trailer. Only one is in service so far.
      const docked = bay.active;
      this.trailers.push({
        bay,
        state: docked ? TrailerState.Docked : TrailerState.Away,
        elapsed: this.rng.range(0, 8),
        hold: docked ? this.rng.range(26, 50) : this.rng.range(10, 30),
        dock: docked ? 1 : 0,
        doors: docked ? 1 : 0,
        tint: this.rng.range(0.82, 1.06),
        cargo: new Array(SLOT_COUNT).fill(null),
        awayHours: 0,
        dispatch: 0,
        alarm: 0,
      });
      bay.occupied = docked;
    }
  }

  /** True while a robot may drive into this bay. */
  static isDockable(t: Trailer): boolean {
    return t.state === TrailerState.Docked;
  }

  /**
   * Advances every trailer. Returns true when the set of dockable bays has
   * changed and the bay strip of the nav grid needs re-rasterising.
   *
   * `hours` is elapsed in-game hours, which is what a departed trailer's return
   * is measured in — it should come back next shift, not in twenty seconds.
   * `occupiedByRobot` reports whether anything is inside the trailer or in its
   * mouth; a trailer will not shut its doors or pull out while that is true,
   * because leaving with a robot aboard strands it outside the building.
   */
  update(
    dt: number,
    hours: number,
    occupiedByRobot: (bayX: number) => boolean,
    plateHeld: (bayX: number) => boolean,
  ): boolean {
    let dockingChanged = false;

    for (const t of this.trailers) {
      if (!t.bay.active) continue;
      const wasDockable = TrailerFleet.isDockable(t);
      t.elapsed += dt;

      // The beacon is on whenever the doors are being sent shut — while the
      // plate is being held, and all the way out of the bay.
      const held = t.state === TrailerState.Docked && plateHeld(t.bay.x);
      const warning =
        held || t.state === TrailerState.Closing || t.state === TrailerState.Leaving;
      t.alarm += ((warning ? 1 : 0) - t.alarm) * Math.min(1, dt * 6);

      switch (t.state) {
        case TrailerState.Away:
          t.dock = 0;
          t.doors = 0;
          t.awayHours = Math.max(0, t.awayHours - hours);
          if (t.awayHours <= 0) {
            // A fresh trailer, empty.
            t.cargo.fill(null);
            this.onSound?.('truck');
            this.enter(t, TrailerState.Arriving);
          }
          break;

        case TrailerState.Arriving: {
          // Eased so it slows as it comes onto the bumpers.
          const p = Math.min(1, t.elapsed / ARRIVE_TIME);
          t.dock = 1 - (1 - p) * (1 - p);
          if (p >= 1) {
            this.onSound?.('doors');
            this.enter(t, TrailerState.Opening);
          }
          break;
        }

        case TrailerState.Opening:
          t.dock = 1;
          t.doors = Math.min(1, t.elapsed / OPEN_TIME);
          if (t.elapsed >= OPEN_TIME) this.enter(t, TrailerState.Docked);
          break;

        case TrailerState.Docked: {
          t.dock = 1;
          t.doors = 1;
          // Held on the plate long enough counts as a dispatch, however little
          // is aboard. Letting go before the dwell is up cancels it.
          t.dispatch = held ? t.dispatch + dt : 0;
          const sent = t.dispatch >= PLATE_DWELL;
          // Otherwise it waits as long as it takes: a trailer leaves when it is
          // loaded, not on a timer — and never while a robot is still aboard.
          if ((sent || TrailerFleet.isFull(t)) && !occupiedByRobot(t.bay.x)) {
            t.dispatch = 0;
            this.onSound?.('doors');
            this.enter(t, TrailerState.Closing);
          }
          break;
        }

        case TrailerState.Closing:
          t.dock = 1;
          // Still checked here: a robot can drive back in mid-close.
          if (occupiedByRobot(t.bay.x)) {
            t.doors = Math.min(1, t.doors + dt / CLOSE_TIME);
            if (t.doors >= 1) this.enter(t, TrailerState.Docked);
            break;
          }
          t.doors = Math.max(0, 1 - t.elapsed / CLOSE_TIME);
          if (t.elapsed >= CLOSE_TIME) {
            // Doors shut and rolling: the load has left the building.
            this.onDeparted?.(t.cargo);
            this.onSound?.('truck');
            this.enter(t, TrailerState.Leaving);
          }
          break;

        case TrailerState.Leaving: {
          const p = Math.min(1, t.elapsed / LEAVE_TIME);
          t.doors = 0;
          t.dock = 1 - p * p;
          if (p >= 1) {
            this.enter(t, TrailerState.Away);
            t.awayHours = this.rng.range(2.5, 5);
          }
          break;
        }
      }

      const dockable = TrailerFleet.isDockable(t);
      if (dockable !== wasDockable) {
        t.bay.occupied = dockable;
        dockingChanged = true;
      }
    }

    return dockingChanged;
  }

  /** Every slot loaded. */
  static isFull(t: Trailer): boolean {
    return t.cargo.every((c) => c !== null);
  }

  /**
   * The slot that should be loaded next.
   *
   * Fills from the far end back, so the robot never has to get past something
   * it has already set down to reach the next slot.
   */
  static nextFreeSlot(t: Trailer): number {
    return t.cargo.findIndex((c) => c === null);
  }

  /** World position of a slot's centre. */
  static slotPosition(t: Trailer, slot: number): { x: number; y: number } {
    const col = slot % SLOT_COLS;
    const row = Math.floor(slot / SLOT_COLS);
    const rear = TrailerFleet.rearY(t);
    // Row 0 is the far end of the trailer.
    const far = rear - TRAILER_DEPTH + CRATE_UNIT * 0.5 + 60;
    return {
      x: t.bay.x + (col - (SLOT_COLS - 1) / 2) * CRATE_UNIT,
      y: far + row * CRATE_UNIT,
    };
  }

  /** Where the working area starts, measured back from the rear sill. */
  static workingEdge(t: Trailer): number {
    return TrailerFleet.rearY(t) - WORKING_LENGTH;
  }

  /** True if a point is inside this trailer's body or its mouth. */
  static contains(t: Trailer, x: number, y: number, pad = 0): boolean {
    const rear = TrailerFleet.rearY(t);
    return (
      Math.abs(x - t.bay.x) < TRAILER_WIDTH / 2 + pad &&
      y < rear + pad &&
      y > rear - TRAILER_DEPTH - pad
    );
  }

  private enter(t: Trailer, state: TrailerStateValue): void {
    t.state = state;
    t.elapsed = 0;
  }

  /** Rear sill of a trailer, in world y. Docked, this sits at the wall face. */
  static rearY(t: Trailer): number {
    return SHELL.y0 - (1 - t.dock) * TRAILER_AWAY_OFFSET;
  }
}
