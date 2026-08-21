import { makeRng, type Rng } from '../core/mathUtils';
import { SHELL, TRAILER_DEPTH, type DockBay } from './level';

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

const ARRIVE_TIME = 3.4;
const OPEN_TIME = 1.6;
const CLOSE_TIME = 1.6;
const LEAVE_TIME = 3.2;

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
}

export class TrailerFleet {
  readonly trailers: Trailer[] = [];
  private readonly rng: Rng;

  constructor(bays: DockBay[], seed: number) {
    this.rng = makeRng(seed ^ 0x71ac);
    for (let i = 0; i < bays.length; i++) {
      const bay = bays[i];
      // Start the row out of step, so they are not all doing the same thing.
      const docked = i % 2 === 1;
      this.trailers.push({
        bay,
        state: docked ? TrailerState.Docked : TrailerState.Away,
        elapsed: this.rng.range(0, 8),
        hold: docked ? this.rng.range(26, 50) : this.rng.range(10, 30),
        dock: docked ? 1 : 0,
        doors: docked ? 1 : 0,
        tint: this.rng.range(0.82, 1.06),
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
   * changed and the nav grid needs re-rasterising.
   */
  update(dt: number): boolean {
    let dockingChanged = false;

    for (const t of this.trailers) {
      const wasDockable = TrailerFleet.isDockable(t);
      t.elapsed += dt;

      switch (t.state) {
        case TrailerState.Away:
          t.dock = 0;
          t.doors = 0;
          if (t.elapsed >= t.hold) this.enter(t, TrailerState.Arriving);
          break;

        case TrailerState.Arriving: {
          // Eased so it slows as it comes onto the bumpers.
          const p = Math.min(1, t.elapsed / ARRIVE_TIME);
          t.dock = 1 - (1 - p) * (1 - p);
          if (p >= 1) this.enter(t, TrailerState.Opening);
          break;
        }

        case TrailerState.Opening:
          t.dock = 1;
          t.doors = Math.min(1, t.elapsed / OPEN_TIME);
          if (t.elapsed >= OPEN_TIME) {
            this.enter(t, TrailerState.Docked);
            t.hold = this.rng.range(26, 50);
          }
          break;

        case TrailerState.Docked:
          t.dock = 1;
          t.doors = 1;
          if (t.elapsed >= t.hold) this.enter(t, TrailerState.Closing);
          break;

        case TrailerState.Closing:
          t.dock = 1;
          t.doors = Math.max(0, 1 - t.elapsed / CLOSE_TIME);
          if (t.elapsed >= CLOSE_TIME) this.enter(t, TrailerState.Leaving);
          break;

        case TrailerState.Leaving: {
          const p = Math.min(1, t.elapsed / LEAVE_TIME);
          t.doors = 0;
          t.dock = 1 - p * p;
          if (p >= 1) {
            this.enter(t, TrailerState.Away);
            t.hold = this.rng.range(10, 30);
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

  private enter(t: Trailer, state: TrailerStateValue): void {
    t.state = state;
    t.elapsed = 0;
  }

  /** Rear sill of a trailer, in world y. Docked, this sits at the wall face. */
  static rearY(t: Trailer): number {
    return SHELL.y0 - (1 - t.dock) * TRAILER_AWAY_OFFSET;
  }
}
