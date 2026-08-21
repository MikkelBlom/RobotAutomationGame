import { CrateMaterial, CrateShape, type CrateMaterialValue, type CrateShapeValue } from './cargo';

/**
 * What the shift has been worth so far.
 *
 * Kept deliberately thin: a counter, a target, a running total and a mean. It
 * exists so the board on the west wall has something true to display — the
 * numbers ARE the feedback, so nothing here may be estimated or smoothed into
 * something prettier than what actually happened.
 */

/** What a crate fetches, by material and size. */
export function crateValue(material: CrateMaterialValue, shape: CrateShapeValue): number {
  const bySize = { [CrateShape.Unit]: 1, [CrateShape.Long]: 2.2, [CrateShape.Large]: 4.6 };
  const byMaterial = { [CrateMaterial.Timber]: 45, [CrateMaterial.Steel]: 130 };
  return Math.round(byMaterial[material] * bySize[shape]);
}

/**
 * How many crates a shift is expected to move.
 *
 * One trailer's worth. It has to be a figure the hall can actually supply —
 * with a quota above the number of liftable crates in the building, the board
 * is just permanently red.
 */
const DAILY_QUOTA = 12;

export class Ledger {
  shippedToday = 0;
  quota = DAILY_QUOTA;
  /** Money banked across the whole run, not just today. */
  revenue = 0;
  /**
   * Mean seconds per crate handled today.
   *
   * Measured on crates going ONTO a trailer, not off in one. Shipping happens
   * in batches of up to twelve, so tying the pace to it would leave the figure
   * frozen for a whole load and then lurch — and it would degrade while a
   * trailer is away, which says nothing about how the machines are working.
   */
  avgSeconds = 0;

  /** Crates put aboard today, shipped or not. Drives the average only. */
  private loadedToday = 0;
  private shiftStart = 0;
  private day = 0;

  /**
   * Records a trailer leaving with a load aboard, at `now` simulated seconds.
   *
   * Nothing counts until the truck pulls out. A crate sitting in a trailer that
   * is still on the bay has not been shipped and has not been paid for — it can
   * still be the thing that gets left behind when the doors shut.
   */
  ship(
    load: ReadonlyArray<{ material: CrateMaterialValue; shape: CrateShapeValue } | null>,
  ): void {
    for (const crate of load) {
      if (!crate) continue;
      this.shippedToday++;
      this.revenue += crateValue(crate.material, crate.shape);
    }
  }

  /**
   * Records one crate set down in a trailer, at `now` simulated seconds.
   *
   * Mean over the whole shift so far, not since the last crate: one fast
   * turnaround should not make a slow shift look quick.
   */
  load(now: number): void {
    this.loadedToday++;
    const elapsed = Math.max(0, now - this.shiftStart);
    this.avgSeconds = elapsed / this.loadedToday;
  }

  /**
   * Rolls the counters over when the clock passes midnight.
   *
   * Takes the day number rather than watching the hour itself, because the hour
   * can be dragged backwards from the debug console and that must not be
   * mistaken for a new shift.
   */
  syncDay(day: number, now: number): void {
    if (day === this.day) return;
    this.day = day;
    this.shippedToday = 0;
    this.loadedToday = 0;
    this.avgSeconds = 0;
    this.shiftStart = now;
  }
}
