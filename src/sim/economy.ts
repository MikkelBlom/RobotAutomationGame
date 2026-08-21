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

/** How many crates a shift is expected to move. */
const DAILY_QUOTA = 24;

export class Ledger {
  shippedToday = 0;
  quota = DAILY_QUOTA;
  /** Money banked across the whole run, not just today. */
  revenue = 0;
  /** Mean seconds per crate today. Zero until the second one lands. */
  avgSeconds = 0;

  private shiftStart = 0;
  private day = 0;

  /** Records one crate loaded, at `now` seconds of simulated time. */
  record(material: CrateMaterialValue, shape: CrateShapeValue, now: number): void {
    this.shippedToday++;
    this.revenue += crateValue(material, shape);
    // Mean over the whole shift so far, not since the last crate: a single fast
    // turnaround should not make a slow shift look quick.
    const elapsed = Math.max(0, now - this.shiftStart);
    this.avgSeconds = this.shippedToday > 0 ? elapsed / this.shippedToday : 0;
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
    this.avgSeconds = 0;
    this.shiftStart = now;
  }
}
