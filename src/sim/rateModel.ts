import { BATTERY_DEAD, BOT_HALF_LENGTH } from './bots';
import {
  CRATE_UNIT,
  canLift,
  shapeSize,
  type CrateMaterialValue,
  type CrateShapeValue,
  type HaulerClassValue,
} from './cargo';
import { crateValue } from './economy';
import { SLOT_COUNT } from './trailers';

/**
 * What the hall WOULD have produced, worked out rather than played out.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The background clock in `core/game.ts` replays the real simulation in 0.05 s
 * steps and gives up after 20 seconds of catch-up per tick, so a tab left shut
 * for an hour loses the hour. Replaying an hour is not an option: at 20 steps a
 * second that is 72,000 passes over the whole fleet, the nav grid and the
 * collision hash, on the main thread, while the player waits.
 *
 * So this file does the other thing. It takes a snapshot of the world and a
 * stretch of time, and answers in closed form: how many crates came off the
 * floor, how many left on a truck, what that was worth, and where every
 * battery ended up — plus, and this is the part that has to be believed, WHAT
 * HELD IT BACK.
 *
 * ── SHAPE OF THE MODEL ─────────────────────────────────────────────────────
 * Production is a pipeline. A SOURCE (the fleet) offers crates per second;
 * each STAGE downstream can only pass so many; the smallest cap wins and that
 * is the throughput. Alongside the pipeline sit RESERVOIRS — the crates on the
 * floor, the charge in the batteries — which are finite and drain, and whose
 * exhaustion changes the caps.
 *
 * Because the caps move as the reservoirs drain, the horizon is integrated in
 * SEGMENTS. Each segment runs at a constant rate up to the next event (a band
 * of crates worked out, a cohort of robots reaching its charging threshold, a
 * bay coming back into service, the horizon). Each segment is O(1) — there is
 * no stepping — and the segment count is bounded by the number of distinct
 * events, which is small. That is what makes a projection over a week cost the
 * same as one over a minute.
 *
 * ── WHAT IT DELIBERATELY DOES NOT KNOW ─────────────────────────────────────
 * It has no idea where any individual robot is standing, whether two of them
 * are shoving each other round a column, or which crate a player had half a
 * mind to fetch. It is a steady-state estimate of a fleet working sensibly.
 * Over the horizons it is meant for — minutes to days — that is the right
 * abstraction. Over five seconds it is not, and the live simulation should be
 * used instead.
 *
 * Every place it knowingly approximates is marked APPROXIMATION in a comment.
 */

// ── Constants mirrored from the live simulation ─────────────────────────────
//
// These are duplicated from `bots.ts` and `trailers.ts` because they are
// module-private there and this file may not modify either. THEY MUST BE KEPT
// IN STEP. Anything derived from them is derived here, never copied: the
// numbers below are only the ones the simulation itself states as literals.
//
// The honest fix is to export them from their own modules and import them; that
// is a change to files this model was asked not to touch, so it is flagged
// instead of made.

export interface RateConstants {
  /** bots.ts REACH_TIME — arms out. */
  reachSeconds: number;
  /** bots.ts CLOSE_TIME — arms close on the load. */
  closeSeconds: number;
  /** bots.ts LIFT_TIME — the crate travels between floor and deck. */
  liftSeconds: number;
  /** bots.ts BotPool.spawn turnRate, rad/s. Sets how long squaring up takes. */
  turnRate: number;
  /** bots.ts BotPool.spawn speed, cm/s. Only a default; robots carry their own. */
  speed: number;
  /** bots.ts DECEL, cm/s^2. */
  decel: number;
  /** bots.ts ACCEL_RESPONSE — how hard velocity chases its target, per second. */
  accelResponse: number;
  /** bots.ts GRAB_GAP — gap left between tail and load. */
  grabGap: number;

  /** bots.ts DRAIN_IDLE, charge per second. */
  drainIdle: number;
  /** bots.ts DRAIN_DRIVING, charge per second at rated speed. */
  drainDriving: number;
  /** bots.ts LADEN_MULTIPLIER. */
  ladenMultiplier: number;
  /** bots.ts DRAIN_PER_LIFT. */
  drainPerLift: number;
  /** bots.ts DRAIN_PER_PLACE. */
  drainPerPlace: number;
  /** bots.ts CHARGE_RATE, charge per second on a live point. */
  chargeRate: number;
  /** bots.ts DOCK_APPROACH — how far out a robot squares up, cm. */
  dockApproach: number;
  /** bots.ts DOCK_REVERSE_SPEED, cm/s. */
  dockReverseSpeed: number;
  /** bots.ts ARM_EXTEND_TIME — coupler travel before charge flows. */
  armExtendSeconds: number;

  /** trailers.ts ARRIVE_TIME. */
  trailerArriveSeconds: number;
  /** trailers.ts OPEN_TIME. */
  trailerOpenSeconds: number;
  /** trailers.ts CLOSE_TIME. */
  trailerCloseSeconds: number;
  /** trailers.ts LEAVE_TIME. */
  trailerLeaveSeconds: number;
  /**
   * Mean of the `rng.range(2.5, 5)` a departing trailer draws for its absence,
   * in IN-GAME hours. The mean is the right figure: over any horizon long
   * enough to matter, the draws average out, and a model that used the low end
   * would promise a throughput the hall cannot sustain.
   */
  trailerAwayHours: number;

  /**
   * Route length divided by straight-line distance.
   *
   * The only constant here that is not read off the simulation. A* on 60 cm
   * cells, string-pulled against line of sight, still has to go round columns
   * on an 11 m grid and round whatever cargo is lying about, and it has to
   * enter the bay square rather than cutting the corner. 1.12 is the detour
   * that makes the model agree with the measured cycle; see the CALIBRATION
   * note below.
   */
  pathSlack: number;

  /**
   * Charge a robot keeps in hand above what the run to the charger costs.
   *
   * The game has no charging controller yet — a person decides — so this is a
   * statement about a competent operator, not about code. Small enough that
   * almost the whole battery is usable, big enough that nobody dies on the
   * apron.
   */
  chargeMargin: number;

  /**
   * Smallest number of crates that share one haul distance.
   *
   * Crates are worked nearest-first, so the haul gets longer as the near stock
   * runs out. Banding is what makes that a handful of events instead of one per
   * crate. 8 is fine grained enough that the error inside a band is small and
   * coarse enough that a full warehouse is a dozen segments, not seventy.
   *
   * It is a FLOOR, not a fixed size: a lane never gets more than `MAX_BANDS`
   * bands however much stock it holds, or a warehouse of a hundred thousand
   * crates would need more segments than the budget allows. Bands widen with
   * the stock instead.
   */
  bandSize: number;
}

export const RATE_CONSTANTS: RateConstants = {
  reachSeconds: 0.75,
  closeSeconds: 0.3,
  liftSeconds: 0.85,
  turnRate: 3.6,
  speed: 560,
  decel: 1100,
  accelResponse: 9,
  grabGap: 26,

  drainIdle: 1 / 14000,
  drainDriving: 1 / 2000,
  ladenMultiplier: 1.65,
  drainPerLift: 0.0085,
  drainPerPlace: 0.0055,
  chargeRate: 1 / 20,
  dockApproach: 300,
  dockReverseSpeed: 105,
  armExtendSeconds: 0.55,

  trailerArriveSeconds: 3.4,
  trailerOpenSeconds: 1.6,
  trailerCloseSeconds: 2.8,
  trailerLeaveSeconds: 3.2,
  trailerAwayHours: 3.75,

  pathSlack: 1.12,
  chargeMargin: 0.02,
  bandSize: 8,
};

/**
 * ── CALIBRATION ────────────────────────────────────────────────────────────
 *
 * Two things were measured off the running game: a haul cycle of about 22 s per
 * crate for one robot, and 0.0245 of a charge spent per crate. They were
 * measured independently, and the model has to satisfy BOTH from the same haul
 * distance — which is a much stronger test than fitting either one alone,
 * because time and energy depend on distance through different constants.
 *
 *   handling  = 2 x (pi/3.6 + 0.75 + 0.30 + 0.85)          = 5.545 s
 *   drive     = 2 x (leg/560 + 1/9 + 560/2200)
 *   22 s      =>  leg (as routed) = 4403 cm, i.e. ~39 m of floor
 *   charge    = 0.0085 + 0.0055
 *               + (4403/560) x (1 + 1.65) x (1/2000)       = 0.01042
 *               + 5.545 x (1/14000)                        = 0.00040
 *             = 0.02481
 *
 * Predicted 0.0248 against a measured 0.0245: 1.3% out, from constants that
 * were never tuned against it. The two measurements agree with each other
 * through the model, so the model is describing the machine and not a curve
 * fitted to one number. `pathSlack` then places 4403 cm of route over roughly
 * 43 m of straight-line hall, which is the distance from the working bay to the
 * nearer crate clusters. That is the whole of the fitting done here.
 *
 * `rateModel.test.ts` asserts this agreement, so it breaks loudly if any of the
 * mirrored constants drifts.
 */

// ── What the model is told about the world ──────────────────────────────────

export interface RateModelRobot {
  /** What it is rated to move. Decides which crates it can even see. */
  hauler: HaulerClassValue;
  /** Charge, 0 to 1. */
  battery: number;
  /** Rated speed in cm/s (`BotPool.speed`). */
  speed?: number;
  /** rad/s (`BotPool.turnRate`). Sets the squaring-up time at both ends. */
  turnRate?: number;
}

export interface RateModelCrate {
  x: number;
  y: number;
  material: CrateMaterialValue;
  shape: CrateShapeValue;
}

/**
 * A loading bay that is actually in service. Shuttered bays are simply left out
 * of the list — that is how unlocking bays 1-3 later becomes a one-line change
 * at the call site rather than a change here.
 */
export interface RateModelBay {
  /** Where a load is set down: the trailer's next slot, in world units. */
  loadX: number;
  loadY: number;
  /** Slots already filled on the trailer standing here. */
  filled: number;
  /** What is already aboard is worth, so a departure pays for it. */
  cargoValue: number;
  /**
   * Seconds before this bay can be loaded again — a trailer away, arriving, or
   * with its doors still opening. Zero when it is workable right now.
   */
  readyIn: number;
}

/** A commissioned charging point. Sealed ones are left out of the list. */
export interface RateModelCharger {
  x: number;
  y: number;
}

export interface WorldSnapshot {
  robots: readonly RateModelRobot[];
  crates: readonly RateModelCrate[];
  bays: readonly RateModelBay[];
  chargers: readonly RateModelCharger[];
  /**
   * Real seconds per in-game hour — `settings.dayLengthSeconds / 24`. A trailer
   * measures its absence in game hours, so nothing about the dock's turnaround
   * can be worked out without this.
   */
  secondsPerHour: number;
  /** Slots a trailer holds. Defaults to the live `SLOT_COUNT`. */
  slotCount?: number;
  /** `settings.batteryDrain`. False pins every battery full. */
  batteryDrain: boolean;
  /** Overrides, for tests and for tuning. */
  constants?: Partial<RateConstants>;
}

// ── What comes back ─────────────────────────────────────────────────────────

/** Why the hall was not going faster. */
export const RateLimit = {
  /** Nothing else binds: the robots themselves are the ceiling. */
  Fleet: 'fleet',
  /** No liftable crates left on the floor. */
  Warehouse: 'warehouse',
  /** Crates are there, but nothing in the fleet is rated to lift them. */
  Hauler: 'hauler',
  /** Trailer turnaround: the dock cannot swallow crates as fast as they arrive. */
  Dock: 'dock',
  /** No bay workable at all — every trailer is away or still opening. */
  DockClosed: 'dockClosed',
  /** Not enough charging points to keep the fleet fed. */
  Charger: 'charger',
  /** Batteries flat with no commissioned point. Nothing recovers from this. */
  Flat: 'flat',
} as const;
export type RateLimitValue = (typeof RateLimit)[keyof typeof RateLimit];

const ALL_LIMITS: RateLimitValue[] = [
  RateLimit.Fleet,
  RateLimit.Warehouse,
  RateLimit.Hauler,
  RateLimit.Dock,
  RateLimit.DockClosed,
  RateLimit.Charger,
  RateLimit.Flat,
];

/** One stretch of the horizon over which nothing changed. */
export interface RateSegment {
  /** Seconds from the start of the projection. */
  start: number;
  seconds: number;
  /** Crates per second actually achieved. */
  rate: number;
  /** Crates per second the fleet would manage with every constraint lifted. */
  idealRate: number;
  binding: RateLimitValue;
}

export interface RateBreakdown {
  /** Seconds spent with each constraint binding. Sums to the horizon. */
  secondsBy: Record<RateLimitValue, number>;
  /**
   * Crates NOT moved because of each constraint.
   *
   * This is the number the player is owed an explanation for: it is the gap
   * between what the fleet could have done and what it did, charged to whatever
   * was in the way at the time.
   */
  cratesLostBy: Record<RateLimitValue, number>;
  /** The constraint that cost the most output over the whole horizon. */
  worst: RateLimitValue;
  /** Crates on the floor that NOTHING in the fleet is rated to lift. */
  unliftableCrates: number;
  segments: RateSegment[];
  /**
   * True when the segment budget ran out and the tail of the horizon was run at
   * a frozen rate. Should never happen; if it does, the result is still finite
   * and monotone, but the constraints stopped being tracked.
   */
  truncated: boolean;
}

export interface RateModelResult {
  /** The horizon this covers, in simulated seconds. */
  seconds: number;
  /** Crates lifted off the floor. */
  cratesTaken: number;
  /**
   * Indices into `snapshot.crates`, in the order they were taken. Splice these
   * out of the level and the floor matches the projection.
   */
  cratesRemoved: number[];
  /** Crates that left the building on a trailer. Only these are paid for. */
  cratesShipped: number;
  /** Crates standing loaded on a bay at the end, not yet shipped. */
  cratesAboard: number;
  /** Slots filled per bay at the end, index-aligned with `snapshot.bays`. */
  bayFilled: number[];
  /** Money banked over the horizon. */
  revenue: number;
  /** Charge per robot at the end, index-aligned with `snapshot.robots`. */
  battery: Float64Array;
  /** Mean crates per second across the whole horizon. */
  rate: number;
  breakdown: RateBreakdown;
}

// ── Derived quantities ──────────────────────────────────────────────────────

/**
 * Seconds to square up on a load, at either end of the haul.
 *
 * Both a fetch and a delivery end with the robot pointing back the way it came
 * — the deck and the arms are at the BACK, so it reverses onto the crate and
 * onto the trailer slot alike. That makes the align phase a half turn, and the
 * half turn dominates: the position ease runs at 4.5/s and has under a metre to
 * take out, which it does in a fraction of the time the turn needs.
 */
export function alignSeconds(turnRate: number): number {
  return Math.PI / turnRate;
}

/** Everything between arriving and driving off again, for one crate. */
export function handlingSeconds(turnRate: number, k: RateConstants): number {
  const perEnd = alignSeconds(turnRate) + k.reachSeconds + k.closeSeconds + k.liftSeconds;
  // Two ends: pick the crate up off the floor, set it down in the slot.
  return 2 * perEnd;
}

/**
 * Seconds to drive `distance` cm of ROUTE (already inflated by `pathSlack`).
 *
 * Cruise time plus the two losses the drive code actually imposes. Velocity
 * chases its target exponentially at `accelResponse`, which costs exactly one
 * time constant of distance however far the leg is; the arrival brake runs at
 * `decel` from rated speed, which costs half the braking time. Neither depends
 * on the length of the leg, which is why they are added rather than folded into
 * an average speed.
 *
 * APPROXIMATION: corner losses are not modelled. `steer` scales speed by
 * alignment through a turn, and a route with more corners is slower. That is
 * folded into `pathSlack` along with the detour itself, because the two are not
 * separable from the outside.
 */
export function driveSeconds(distance: number, speed: number, k: RateConstants): number {
  return distance / speed + 1 / k.accelResponse + speed / (2 * k.decel);
}

/**
 * Charge spent driving `distance` cm of route, laden or not.
 *
 * Distance, not time. `updatePower` drains `DRAIN_DRIVING * (v / rated)` per
 * second, so the integral over a leg is `DRAIN_DRIVING * distance / rated`
 * exactly — no matter how the speed varied along it. Slowing for a corner
 * costs time, but it costs no extra charge, and the model gets that right for
 * free by working in distance.
 */
function driveCharge(distance: number, speed: number, laden: boolean, k: RateConstants): number {
  const multiplier = laden ? k.ladenMultiplier : 1;
  return (distance / speed) * k.drainDriving * multiplier;
}

/** Seconds for one bay → crate → bay round trip, over `leg` cm of route. */
export function cycleSeconds(leg: number, speed: number, turnRate: number, k: RateConstants): number {
  return 2 * driveSeconds(leg, speed, k) + handlingSeconds(turnRate, k);
}

/** Charge spent on one such round trip. */
export function cycleCharge(leg: number, speed: number, turnRate: number, k: RateConstants): number {
  return (
    k.drainPerLift +
    k.drainPerPlace +
    driveCharge(leg, speed, false, k) +
    driveCharge(leg, speed, true, k) +
    // Sitting still through the grab and the set-down still costs something.
    handlingSeconds(turnRate, k) * k.drainIdle
  );
}

/**
 * Seconds a bay is out of action between one load leaving and the next being
 * loadable: doors shut, truck away, next truck on the bumpers, doors open.
 */
export function trailerDeadSeconds(secondsPerHour: number, k: RateConstants): number {
  return (
    k.trailerCloseSeconds +
    k.trailerLeaveSeconds +
    k.trailerAwayHours * secondsPerHour +
    k.trailerArriveSeconds +
    k.trailerOpenSeconds
  );
}

/** Seconds a charging point is occupied but not yet delivering: align, reverse, couple. */
function chargeDockSeconds(turnRate: number, k: RateConstants): number {
  return alignSeconds(turnRate) + k.dockApproach / k.dockReverseSpeed + k.armExtendSeconds;
}

// ── Stages ──────────────────────────────────────────────────────────────────
//
// A stage answers one question: given `upstream` crates per second arriving,
// how many can get past me? Adding a constraint to the model — a packing
// station, a conveyor, a shift roster — means writing one of these and pushing
// it into `STAGES`. Nothing else has to change: the resolver takes the running
// minimum and the breakdown picks up the new limit name on its own.

interface StageContext {
  /** Bays workable at this instant. */
  activeBays: number;
  slotCount: number;
  /** Seconds a bay is dead between loads. */
  deadSeconds: number;
}

interface RateStage {
  readonly limit: RateLimitValue;
  capacity(upstream: number, ctx: StageContext): number;
}

/**
 * The loading dock.
 *
 * A bay takes `slotCount` crates and then stands dead for `deadSeconds`. Worked
 * round-robin — which is what both a player and `resolveDrop` do, since it
 * takes the FIRST dockable trailer and fills it — a full rotation of B bays
 * takes either the time to load them all or the time one bay needs to come
 * back, whichever is longer:
 *
 *   rotation   = max(B x slots / upstream,  slots / upstream + dead)
 *   throughput = B x slots / rotation
 *              = min(upstream,  B x slots / (slots / upstream + dead))
 *
 * Exact for one bay. APPROXIMATION: for more than one it assumes the bays stay
 * out of phase, which is what round-robin loading produces once it settles but
 * not what you get for the first rotation after a snapshot.
 *
 * APPROXIMATION: it also assumes a robot never stands holding a crate waiting
 * for doors. In truth the fleet can buffer one crate per robot across a
 * closure, which the model gives up. On the horizons this is for, one crate per
 * robot is noise; on a ten-second horizon it is not.
 */
const dockStage: RateStage = {
  limit: RateLimit.Dock,
  capacity(upstream, ctx) {
    if (ctx.activeBays <= 0) return 0;
    if (upstream <= 0) return 0;
    const rotation = ctx.slotCount / upstream + ctx.deadSeconds;
    return (ctx.activeBays * ctx.slotCount) / rotation;
  },
};

/** Ordered downstream of the fleet. Add new constraints here. */
const STAGES: readonly RateStage[] = [dockStage];

// ── Internal working state ──────────────────────────────────────────────────

/**
 * Robots that are interchangeable, held as one row.
 *
 * Every robot in a cohort has the same class, the same rated speed and the same
 * charge, so they hit their charging threshold together and the model needs one
 * event for the lot. Ten thousand identical machines are one cohort and one
 * event — which is the difference between this being O(1) in fleet size and
 * O(n) in it.
 */
interface Cohort {
  hauler: HaulerClassValue;
  count: number;
  speed: number;
  turnRate: number;
  /** Shared charge, 0 to 1. */
  battery: number;
  members: number[];
  /**
   * `working` — running the battery down at full tilt.
   * `charging` — settled into a work/charge duty cycle, charge held steady.
   * `flat`     — nothing left and no way back. `startFetch` refuses outright,
   *              so a flat machine produces nothing at all; the fact that it
   *              can still crawl at DEAD_SPEED never enters production.
   */
  state: 'working' | 'charging' | 'flat';
}

/**
 * One KIND of crate — a material and a shape — and its queue.
 *
 * Keyed by the crate rather than by the machine, because the two do not line up
 * one to one and never will: a Big hauler takes a timber 2x2 that a Heavy
 * cannot, while the Heavy takes steel that the Big cannot. A lane per class
 * would have to decide up front which class owns which crate, and would then
 * leave a Heavy hauler standing idle beside a pallet it is perfectly capable of
 * lifting. Keyed by kind, each lane simply lists the classes that can serve it
 * and the assignment is made fresh every segment.
 *
 * Adding a crate kind, or changing `liftRefusal` so a class can take something
 * new, needs no change here at all.
 */
interface Lane {
  material: CrateMaterialValue;
  shape: CrateShapeValue;
  /** Hauler classes present in the fleet that can lift this kind. */
  servers: Set<HaulerClassValue>;
  /** Cohorts working this lane in the current segment. */
  crew: Cohort[];
  /** Crate indices, nearest bay-to-crate route first. */
  order: number[];
  /** Route length of one leg, per position in `order`. */
  leg: Float64Array;
  /** Cumulative crate value, `valuePrefix[n]` = value of the first n crates. */
  valuePrefix: Float64Array;
  /** Crates taken so far. Fractional between events. */
  taken: number;
  /** How many crates share one haul distance in this lane. */
  bandStep: number;
  /** Half-open span of `order` sharing the current haul distance. */
  bandEnd: number;
  bandLeg: number;
}

/**
 * Everything about a cohort that only changes when its band or state does.
 *
 * The three rates are deliberately layered, because the gaps BETWEEN them are
 * what the breakdown is made of: `capability` is what the machines are worth,
 * `alive` is what is left after the flat ones, `offered` is what actually goes
 * out of the door once charging trips and an empty floor have taken their cut.
 */
interface CohortRates {
  state: Cohort['state'];
  /** Crates per second these machines are worth, flat or not. */
  capability: number;
  /** Same, but zero once they are flat. */
  alive: number;
  /** After charging trips and queueing for a point, but ignoring the floor. */
  offeredIfStocked: number;
  /** After the floor too: zero when there is nothing this cohort may lift. */
  offered: number;
  /** Charge per crate. */
  perCrate: number;
  /** Charge below which it makes for a point (or gives up, with no point). */
  reserve: number;
  /** Points occupied per second of wall clock by the whole cohort. */
  padDemand: number;
  /** Fraction of wall clock spent hauling rather than charging. */
  availability: number;
}

const EPS = 1e-9;
/**
 * Ceiling on segments.
 *
 * Events come from cohorts, crate bands and bays, all of which are small. The
 * budget is a guard against a pathological snapshot, not a working limit — if
 * it is ever reached the result stays finite and the breakdown says so.
 */
const MAX_SEGMENTS = 2048;
/**
 * Most haul distances one lane is ever split into.
 *
 * The cost of a projection is the number of events in it, so this is the knob
 * that keeps a warehouse of a hundred thousand crates costing the same as one
 * of seventy. Twenty-four steps across the whole spread of haul distances is
 * far finer than the model's own accuracy.
 */
const MAX_BANDS = 24;

// ── The model ───────────────────────────────────────────────────────────────

/**
 * Projects `seconds` of SIMULATED time onto `world`.
 *
 * Simulated, not real: if `settings.simSpeed` is not 1, multiply before calling.
 * Nothing in the snapshot is modified.
 */
export function projectProduction(world: WorldSnapshot, seconds: number): RateModelResult {
  const k: RateConstants = { ...RATE_CONSTANTS, ...(world.constants ?? {}) };
  const slotCount = world.slotCount ?? SLOT_COUNT;
  const horizon = Math.max(0, seconds);
  const deadSeconds = trailerDeadSeconds(world.secondsPerHour, k);

  const battery = new Float64Array(world.robots.length);
  for (let i = 0; i < world.robots.length; i++) battery[i] = clamp01(world.robots[i].battery);

  const { lanes, cohorts, unliftable, referenceLeg } = prepare(world, k);
  const chargerLeg = nearestChargerLeg(world, k);
  const chargePoints = world.chargers.length;

  const secondsBy = emptyTally();
  const cratesLostBy = emptyTally();
  const segments: RateSegment[] = [];

  // Bays come back into service at known moments; each one is an event.
  const bayReady = world.bays.map((b) => Math.max(0, b.readyIn));

  let t = 0;
  let truncated = false;

  while (t < horizon - EPS) {
    if (segments.length >= MAX_SEGMENTS) {
      // Say so rather than quietly inventing a tail: the caller is told
      // `truncated`, and the time nobody worked out is left unattributed rather
      // than charged to a constraint that was never checked.
      truncated = true;
      break;
    }

    // Crates are worked nearest first, so once a band is gone the haul — and
    // with it the cycle time and the charge per crate — has to be re-measured.
    for (const lane of lanes) {
      if (lane.taken >= lane.bandEnd - EPS) retuneBand(lane);
    }

    const activeBays = countReady(bayReady, t);
    const ctx: StageContext = { activeBays, slotCount, deadSeconds };

    // 1. Put every cohort on the nearest crate kind it is rated for, and see
    //    what it offers there.
    for (const lane of lanes) lane.crew.length = 0;
    const rates = new Map<Cohort, CohortRates>();
    let capability = 0;
    let alive = 0;
    let padDemand = 0;
    for (const cohort of cohorts) {
      const lane = pickLane(cohort, lanes);
      if (lane) lane.crew.push(cohort);
      const r = cohortRates(cohort, lane, referenceLeg, world, k, chargerLeg, chargePoints);
      rates.set(cohort, r);
      capability += r.capability;
      alive += r.alive;
      padDemand += r.padDemand;
    }

    // 2. Queueing for a charging point stretches the whole duty cycle by the
    //    same factor it stretches demand, so availability scales exactly: the
    //    pad-seconds one charge needs are fixed, so if demand is D and there are
    //    P points, the cycle period grows by D/P and availability falls by P/D.
    const chargeThrottle = chargePoints > 0 && padDemand > chargePoints
      ? chargePoints / padDemand
      : 1;

    let fleetRate = 0;
    let offeredIfStocked = 0;
    for (const cohort of cohorts) {
      const r = rates.get(cohort) as CohortRates;
      if (r.state === 'charging') {
        r.offered *= chargeThrottle;
        r.offeredIfStocked *= chargeThrottle;
      }
      fleetRate += r.offered;
      offeredIfStocked += r.offeredIfStocked;
    }

    // 3. Downstream stages take the running minimum.
    let rate = fleetRate;
    let stageLimit: RateLimitValue | null = null;
    for (const stage of STAGES) {
      const cap = stage.capacity(rate, ctx);
      if (cap < rate) {
        rate = cap;
        stageLimit = stage.limit;
      }
    }

    // 4. The losses, layered. Each is the bite one thing took out of the rate,
    //    which is what "why was my factory slow" actually means.
    const losses = emptyTally();
    losses[RateLimit.Flat] = Math.max(0, capability - alive);
    losses[RateLimit.Charger] = Math.max(0, alive - offeredIfStocked);
    // Nothing to lift. Blame the roster rather than the floor when there is
    // cargo standing there that no machine on the strength is rated for —
    // "the warehouse is empty" would be a lie the player can see out of the
    // window.
    const emptyKind = unliftable > 0 ? RateLimit.Hauler : RateLimit.Warehouse;
    losses[emptyKind] += Math.max(0, offeredIfStocked - fleetRate);
    losses[activeBays <= 0 ? RateLimit.DockClosed : (stageLimit ?? RateLimit.Dock)] +=
      Math.max(0, fleetRate - rate);

    const binding = pickBinding(losses, capability);

    // 5. How long may this rate stand? Until the next thing changes.
    const dt = Math.min(
      horizon - t,
      nextEvent(t, rate, fleetRate, lanes, cohorts, rates, bayReady, horizon, k),
    );

    // 6. Advance.
    const scale = fleetRate > EPS ? rate / fleetRate : 0;
    for (const lane of lanes) {
      let laneRate = 0;
      for (const cohort of lane.crew) laneRate += (rates.get(cohort) as CohortRates).offered;
      const stock = lane.order.length - lane.taken;
      lane.taken += Math.min(stock, laneRate * scale * dt);
    }

    if (world.batteryDrain) {
      // Machines with nothing to haul go and stand on a point. Only so many can
      // at once, so the fill is shared out between them.
      let idleRobots = 0;
      for (const cohort of cohorts) {
        if ((rates.get(cohort) as CohortRates).offered <= EPS) idleRobots += cohort.count;
      }
      const idleShare = idleRobots > 0 ? Math.min(1, chargePoints / idleRobots) : 1;
      for (const cohort of cohorts) {
        const r = rates.get(cohort) as CohortRates;
        advanceCohort(cohort, r, scale, dt, k, chargePoints, idleShare);
      }
    }

    secondsBy[binding] += dt;
    for (const limit of ALL_LIMITS) cratesLostBy[limit] += losses[limit] * dt;
    segments.push({ start: t, seconds: dt, rate, idealRate: capability, binding });
    t += dt;
  }

  return assemble(world, lanes, cohorts, battery, horizon, slotCount, {
    secondsBy,
    cratesLostBy,
    segments,
    unliftable,
    truncated,
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

/**
 * Turns a snapshot into the two things the integrator works on: a lane per
 * crate kind, and a cohort per interchangeable group of robots.
 */
function prepare(
  world: WorldSnapshot,
  k: RateConstants,
): { lanes: Lane[]; cohorts: Cohort[]; unliftable: number; referenceLeg: number } {
  const classes = [...new Set(world.robots.map((r) => r.hauler))].sort((a, b) => a - b);
  const slotStandoff = BOT_HALF_LENGTH + CRATE_UNIT / 2 + k.grabGap;

  // Route length is measured between where the robot actually STOPS at each
  // end, not between the crate and the slot: it reverses up to both, so the two
  // standoffs are floor it never drives over.
  const legs = new Float64Array(world.crates.length);
  let legSum = 0;
  for (let i = 0; i < world.crates.length; i++) {
    const crate = world.crates[i];
    const size = shapeSize(crate.shape);
    // The approach snaps to the nearest face, so the reach is the mean of the
    // two half-extents over a population of freely-rotated crates.
    const crateStandoff = BOT_HALF_LENGTH + (size.w + size.h) / 4 + k.grabGap;
    let straight = Infinity;
    for (const bay of world.bays) {
      straight = Math.min(straight, Math.hypot(crate.x - bay.loadX, crate.y - bay.loadY));
    }
    const clear = Number.isFinite(straight)
      ? Math.max(0, straight - crateStandoff - slotStandoff)
      : 0;
    legs[i] = clear * k.pathSlack;
    legSum += legs[i];
  }

  const buckets = new Map<string, number[]>();
  let unliftable = 0;
  for (let i = 0; i < world.crates.length; i++) {
    const crate = world.crates[i];
    if (!classes.some((c) => canLift(c, crate.material, crate.shape))) {
      unliftable++;
      continue;
    }
    const key = `${crate.material}|${crate.shape}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  const lanes: Lane[] = [];
  for (const indices of buckets.values()) {
    // Nearest first: that is how the hall is actually worked, and it is what
    // makes the haul get longer — and the cycle slower — as the near stock goes.
    const order = indices.sort((a, b) => legs[a] - legs[b]);
    const leg = new Float64Array(order.length);
    const valuePrefix = new Float64Array(order.length + 1);
    for (let n = 0; n < order.length; n++) {
      const crate = world.crates[order[n]];
      leg[n] = legs[order[n]];
      valuePrefix[n + 1] = valuePrefix[n] + crateValue(crate.material, crate.shape);
    }

    const sample = world.crates[order[0]];
    const lane: Lane = {
      material: sample.material,
      shape: sample.shape,
      servers: new Set(classes.filter((c) => canLift(c, sample.material, sample.shape))),
      crew: [],
      order,
      leg,
      valuePrefix,
      taken: 0,
      bandStep: Math.max(
        Math.max(1, Math.floor(k.bandSize)),
        Math.ceil(order.length / MAX_BANDS),
      ),
      bandEnd: 0,
      bandLeg: 0,
    };
    retuneBand(lane);
    lanes.push(lane);
  }

  return {
    lanes,
    cohorts: buildCohorts(world),
    unliftable,
    // What a machine with nothing it may lift WOULD be doing, so the cost of a
    // missing hauler class is a real number rather than a shrug.
    referenceLeg: world.crates.length > 0 ? legSum / world.crates.length : 0,
  };
}

function buildCohorts(world: WorldSnapshot): Cohort[] {
  const byKey = new Map<string, Cohort>();
  for (let i = 0; i < world.robots.length; i++) {
    const robot = world.robots[i];
    const speed = robot.speed ?? RATE_CONSTANTS.speed;
    const turnRate = robot.turnRate ?? RATE_CONSTANTS.turnRate;
    const charge = clamp01(robot.battery);
    // Rounded so machines that are for practical purposes identical share a
    // row. A ten-thousandth of a charge is a fortieth of one crate.
    const key = `${robot.hauler}|${speed}|${turnRate}|${Math.round(charge * 1e4)}`;
    const found = byKey.get(key);
    if (found) {
      found.count++;
      found.members.push(i);
      continue;
    }
    byKey.set(key, {
      hauler: robot.hauler,
      count: 1,
      speed,
      turnRate,
      battery: charge,
      members: [i],
      state: charge <= BATTERY_DEAD ? 'flat' : 'working',
    });
  }
  return [...byKey.values()];
}

/**
 * The lane a cohort would work right now: the nearest stocked crate kind it is
 * rated for.
 *
 * Nearest wins because that is what a person does with a right click and what
 * any future dispatcher would do. It also keeps the choice stable — a band's
 * haul only ever grows, so cohorts do not flip between lanes segment to segment.
 */
function pickLane(cohort: Cohort, lanes: Lane[]): Lane | null {
  let best: Lane | null = null;
  for (const lane of lanes) {
    if (!lane.servers.has(cohort.hauler)) continue;
    if (lane.order.length - lane.taken <= EPS) continue;
    if (!best || lane.bandLeg < best.bandLeg) best = lane;
  }
  return best;
}

/**
 * Re-measures the haul for the band of crates now at the head of the queue.
 *
 * APPROXIMATION: every crate in a band is treated as being at the band's mean
 * distance. The mean rather than the nearest, so a band is not systematically
 * optimistic; the error inside a band is second order and vanishes as the band
 * narrows.
 */
function retuneBand(lane: Lane): void {
  const start = Math.min(lane.order.length, Math.floor(lane.taken + EPS));
  if (start >= lane.order.length) {
    lane.bandEnd = lane.order.length;
    // Keep the last known haul so a lane that runs dry does not divide by zero.
    lane.bandLeg = lane.order.length > 0 ? lane.leg[lane.order.length - 1] : 0;
    return;
  }
  const end = Math.min(lane.order.length, start + lane.bandStep);
  let sum = 0;
  for (let n = start; n < end; n++) sum += lane.leg[n];
  lane.bandEnd = end;
  lane.bandLeg = sum / (end - start);
}

/**
 * Route from the working bay to the nearest commissioned point.
 *
 * APPROXIMATION: measured from the DOCK, not from wherever a robot happens to
 * be standing. A machine on shift passes through the bay every cycle, so that
 * is roughly where its charging trip starts and ends — but one that runs low
 * out on the floor would go straight to the point from there. Infinity when
 * nothing is commissioned.
 */
function nearestChargerLeg(world: WorldSnapshot, k: RateConstants): number {
  if (world.chargers.length === 0 || world.bays.length === 0) return Infinity;
  let best = Infinity;
  for (const bay of world.bays) {
    for (const pad of world.chargers) {
      best = Math.min(best, Math.hypot(pad.x - bay.loadX, pad.y - bay.loadY));
    }
  }
  // The drive ends short of the pad; the last three metres are the reverse-in,
  // which is timed separately in `chargeDockSeconds`.
  return Math.max(0, best - k.dockApproach) * k.pathSlack;
}

// ── Per-segment evaluation ──────────────────────────────────────────────────

function cohortRates(
  cohort: Cohort,
  lane: Lane | null,
  referenceLeg: number,
  world: WorldSnapshot,
  k: RateConstants,
  chargerLeg: number,
  chargePoints: number,
): CohortRates {
  // With no lane to work, the cohort is still worth something — it is just not
  // being given anything to lift. Costing it at the average haul is what turns
  // "your Heavy hauler had nothing to do" into a number of crates.
  const bandLeg = lane ? lane.bandLeg : referenceLeg;
  const seconds = cycleSeconds(bandLeg, cohort.speed, cohort.turnRate, k);
  const capability = cohort.count / seconds;
  const alive = cohort.state === 'flat' ? 0 : capability;
  const hasStock = lane !== null;
  const perCrate = world.batteryDrain
    ? cycleCharge(bandLeg, cohort.speed, cohort.turnRate, k)
    : 0;

  // With drain switched off, or with nothing commissioned to plug into, there
  // is nothing to reserve and nothing to queue for: a machine runs flat out
  // until it stops for good.
  if (!world.batteryDrain || chargePoints === 0 || !Number.isFinite(chargerLeg)) {
    return {
      state: cohort.state,
      capability,
      alive,
      offeredIfStocked: alive,
      offered: hasStock ? alive : 0,
      perCrate,
      reserve: BATTERY_DEAD,
      padDemand: 0,
      availability: 1,
    };
  }

  // APPROXIMATION: the charging policy is invented, because the game has none —
  // a person decides when to send a machine to a point. Modelled as: run down
  // to just enough to reach a point, then fill right up. The return leg runs on
  // a full battery, so only the outbound trip has to be reserved for.
  const reserve = Math.min(
    0.95,
    driveCharge(chargerLeg, cohort.speed, false, k) + k.chargeMargin,
  );
  const usable = Math.max(EPS, 1 - reserve);
  const cratesPerCharge = perCrate > EPS ? usable / perCrate : Infinity;
  const workSeconds = cratesPerCharge * seconds;
  const padSeconds = chargeDockSeconds(cohort.turnRate, k) + usable / k.chargeRate;
  const tripSeconds = 2 * driveSeconds(chargerLeg, cohort.speed, k) + padSeconds;
  const period = workSeconds + tripSeconds;
  const availability = Number.isFinite(period) && period > EPS ? workSeconds / period : 1;

  // A cohort still running its first battery down has not started making
  // charging trips yet, so it is at full rate until it reaches the reserve.
  const cycling = cohort.state === 'charging';
  const offeredIfStocked = cycling ? alive * availability : alive;
  return {
    state: cohort.state,
    capability,
    alive,
    offeredIfStocked,
    offered: hasStock ? offeredIfStocked : 0,
    perCrate,
    reserve,
    padDemand: cycling ? (cohort.count * padSeconds) / period : 0,
    availability,
  };
}

/** Seconds until something changes that would move the rate. */
function nextEvent(
  t: number,
  rate: number,
  fleetRate: number,
  lanes: Lane[],
  cohorts: Cohort[],
  rates: Map<Cohort, CohortRates>,
  bayReady: number[],
  horizon: number,
  k: RateConstants,
): number {
  let dt = horizon - t;
  const scale = fleetRate > EPS ? rate / fleetRate : 0;

  // A bay coming back into service.
  for (const ready of bayReady) {
    if (ready > t + EPS) dt = Math.min(dt, ready - t);
  }

  // A band running out — the haul gets longer, so the rate steps down. So does
  // a lane emptying, which frees its crew for whatever else they can lift.
  for (const lane of lanes) {
    let laneRate = 0;
    for (const cohort of lane.crew) laneRate += (rates.get(cohort) as CohortRates).offered;
    const effective = laneRate * scale;
    if (effective <= EPS) continue;
    const toGo = Math.max(0, lane.bandEnd - lane.taken);
    dt = Math.min(dt, toGo / effective + EPS);
  }

  // A cohort reaching its charging threshold, or dying.
  for (const cohort of cohorts) {
    if (cohort.state !== 'working') continue;
    const r = rates.get(cohort) as CohortRates;
    const drain = cohortDrain(cohort, r, scale, k);
    if (drain <= EPS) continue;
    const headroom = cohort.battery - r.reserve;
    if (headroom > EPS) dt = Math.min(dt, headroom / drain + EPS);
  }

  return Math.max(dt, EPS);
}

/** Charge per second drawn by one robot of the cohort. */
function cohortDrain(cohort: Cohort, r: CohortRates, scale: number, k: RateConstants): number {
  if (cohort.state !== 'working' || r.perCrate <= 0) return 0;
  const perRobot = (r.offered * scale) / Math.max(1, cohort.count);
  const hauling = perRobot * r.perCrate;
  // Whatever share of the clock it is not hauling, it is standing about, and
  // standing about is not free. A full battery idles away in about four hours,
  // which is why a fleet left with no bay open and no charging point can be
  // found dead on return without having moved a single crate.
  const dutyFraction = Math.min(1, r.capability > EPS ? (r.offered * scale) / r.capability : 0);
  return hauling + (1 - dutyFraction) * k.drainIdle;
}

function advanceCohort(
  cohort: Cohort,
  r: CohortRates,
  scale: number,
  dt: number,
  k: RateConstants,
  chargePoints: number,
  /** Share of a point each idle robot can get, 0 to 1. */
  idleChargeShare: number,
): void {
  if (cohort.state === 'charging') {
    // A machine in the duty cycle sits around its threshold — that is what the
    // duty cycle means. But one with NOTHING to haul is not in a duty cycle at
    // all: it is parked on a point, and it fills up. Coming back to a fleet
    // sitting at 3% because the hall ran dry hours ago would be wrong, and the
    // caller writes these numbers straight back into `BotPool.battery`.
    if (r.offered <= EPS && chargePoints > 0) {
      cohort.battery = Math.min(1, cohort.battery + k.chargeRate * idleChargeShare * dt);
    }
    return;
  }
  if (cohort.state !== 'working') return;

  const drain = cohortDrain(cohort, r, scale, k);
  if (drain <= 0) return;
  cohort.battery = Math.max(0, cohort.battery - drain * dt);
  if (cohort.battery > r.reserve + EPS) return;

  if (chargePoints > 0 && r.availability > 0) {
    // From here on it works a duty cycle: haul until low, go and fill up.
    cohort.battery = r.reserve;
    cohort.state = 'charging';
    return;
  }
  // Nothing commissioned. It coasts to a stop and stays stopped — `startFetch`
  // refuses outright below BATTERY_DEAD, so it will never lift anything again
  // without a point being bought.
  cohort.battery = Math.min(cohort.battery, BATTERY_DEAD);
  cohort.state = 'flat';
}

/**
 * Which constraint gets the blame for this segment: whichever took the biggest
 * bite. A bite under one percent of what the fleet is worth is not an
 * explanation, it is rounding — in that case the fleet itself is the answer,
 * which is the honest thing to tell a player whose factory is simply small.
 */
function pickBinding(losses: Record<RateLimitValue, number>, capability: number): RateLimitValue {
  let worst: RateLimitValue = RateLimit.Fleet;
  let worstLoss = Math.max(EPS, capability * 0.01);
  for (const limit of ALL_LIMITS) {
    if (limit === RateLimit.Fleet) continue;
    if (losses[limit] > worstLoss) {
      worstLoss = losses[limit];
      worst = limit;
    }
  }
  return worst;
}

// ── Results ─────────────────────────────────────────────────────────────────

function assemble(
  world: WorldSnapshot,
  lanes: Lane[],
  cohorts: Cohort[],
  battery: Float64Array,
  horizon: number,
  slotCount: number,
  parts: {
    secondsBy: Record<RateLimitValue, number>;
    cratesLostBy: Record<RateLimitValue, number>;
    segments: RateSegment[];
    unliftable: number;
    truncated: boolean;
  },
): RateModelResult {
  // Crates come off the floor in whole units; the fractional tail is a crate
  // half-carried at the moment the horizon fell, and it has not been paid for.
  const cratesRemoved: number[] = [];
  let takenValue = 0;
  let cratesTaken = 0;
  for (const lane of lanes) {
    const whole = Math.min(lane.order.length, Math.floor(lane.taken + EPS));
    for (let n = 0; n < whole; n++) cratesRemoved.push(lane.order[n]);
    takenValue += lane.valuePrefix[whole];
    cratesTaken += whole;
  }

  const { shippedFromFloor, shippedAboard, aboardValue, bayFilled } = dispatch(
    world.bays,
    cratesTaken,
    slotCount,
  );

  // APPROXIMATION: crates still standing on a bay at the end are excluded from
  // revenue pro rata rather than by identity. Which particular crates are
  // aboard depends on an ordering the model does not track, and their values
  // differ by at most a factor of three within a lane.
  const shippedShare = cratesTaken > 0 ? shippedFromFloor / cratesTaken : 0;
  const revenue = takenValue * shippedShare + aboardValue;

  for (const cohort of cohorts) {
    for (const member of cohort.members) battery[member] = cohort.battery;
  }

  const cratesShipped = shippedFromFloor + shippedAboard;
  const worst = ALL_LIMITS.reduce((a, b) =>
    parts.cratesLostBy[b] > parts.cratesLostBy[a] ? b : a,
  );

  return {
    seconds: horizon,
    cratesTaken,
    cratesRemoved,
    cratesShipped,
    cratesAboard: bayFilled.reduce((a, b) => a + b, 0),
    bayFilled,
    revenue,
    battery,
    rate: horizon > 0 ? cratesTaken / horizon : 0,
    breakdown: {
      secondsBy: parts.secondsBy,
      cratesLostBy: parts.cratesLostBy,
      worst,
      unliftableCrates: parts.unliftable,
      segments: parts.segments,
      truncated: parts.truncated,
    },
  };
}

/**
 * Walks `loaded` crates into the bays and works out what left the building.
 *
 * `resolveDrop` takes the FIRST dockable trailer, so bays fill one at a time in
 * order. A trailer departs the instant its last slot is filled — and only then
 * does anything aboard count as shipped, which is the rule the ledger already
 * enforces.
 *
 * The rate cap has already accounted for the time a bay spends away, so this
 * only has to divide up crates, not schedule them.
 */
function dispatch(
  bays: readonly RateModelBay[],
  loaded: number,
  slotCount: number,
): {
  shippedFromFloor: number;
  shippedAboard: number;
  aboardValue: number;
  bayFilled: number[];
} {
  const bayFilled = bays.map((b) => Math.min(slotCount, Math.max(0, Math.floor(b.filled))));
  let remaining = Math.max(0, Math.floor(loaded));
  let shippedFromFloor = 0;
  let shippedAboard = 0;
  let aboardValue = 0;
  if (bayFilled.length === 0) {
    return { shippedFromFloor, shippedAboard, aboardValue, bayFilled };
  }

  // First, top up the trailers that were already standing there, in order.
  let at = 0;
  for (; at < bayFilled.length; at++) {
    const need = slotCount - bayFilled[at];
    if (remaining < need) break;
    remaining -= need;
    shippedFromFloor += need;
    shippedAboard += bayFilled[at];
    aboardValue += bays[at].cargoValue;
    bayFilled[at] = 0;
  }

  if (at < bayFilled.length) {
    // Not enough to fill this one, so it is still standing there part loaded.
    bayFilled[at] += remaining;
    return { shippedFromFloor, shippedAboard, aboardValue, bayFilled };
  }

  // Every bay went. From here every full trailer's worth is another departure,
  // and the tail is a fresh trailer part loaded.
  const departures = Math.floor(remaining / slotCount);
  shippedFromFloor += departures * slotCount;
  remaining -= departures * slotCount;
  bayFilled[0] = remaining;

  return { shippedFromFloor, shippedAboard, aboardValue, bayFilled };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function emptyTally(): Record<RateLimitValue, number> {
  const out = {} as Record<RateLimitValue, number>;
  for (const limit of ALL_LIMITS) out[limit] = 0;
  return out;
}

function countReady(bayReady: readonly number[], t: number): number {
  let n = 0;
  for (const ready of bayReady) if (ready <= t + EPS) n++;
  return n;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/*
 * ── HOW THIS IS MEANT TO BE CALLED ─────────────────────────────────────────
 *
 * `game.ts` currently owns a worker clock (`startBackgroundClock`) that replays
 * the simulation in 0.05 s steps and throws away anything past `MAX_CATCH_UP`.
 * The intended split is: the live simulation keeps the short end, this model
 * takes the long end, and MAX_CATCH_UP becomes the boundary between them
 * rather than a cliff.
 *
 *   private backgroundTick = (): void => {
 *     const now = performance.now();
 *     const elapsed = (now - this.lastFrame) / 1000;
 *     this.lastFrame = now;
 *     if (elapsed <= MAX_CATCH_UP) { ...step the real simulation as today... }
 *     else this.applyProjection(elapsed * this.settings.simSpeed);
 *   };
 *
 * WHAT IT EXPECTS TO BE TOLD
 *
 *   robots      One entry per live robot: `hauler`, `battery`, and its `speed`
 *               and `turnRate` out of `BotPool`. Position is NOT wanted — over
 *               these horizons where a machine happens to be standing is noise,
 *               and asking for it would invite the belief that the first cycle
 *               is modelled. It is not.
 *
 *   crates      Every `Prop` on the floor, with its world position, material
 *               and shape. The model decides for itself which are liftable, in
 *               which order they would be worked, and what each is worth.
 *
 *   bays        ONLY the bays in service. For each: where a load is set down,
 *               how many slots are already filled, what is aboard is worth (sum
 *               `crateValue` over `t.cargo`), and how many seconds until it can
 *               be loaded again.
 *
 *               The load point is the MIDDLE of the slot run —
 *               `TrailerFleet.slotPosition(t, Math.floor(SLOT_COUNT / 2))` —
 *               not the next free slot. Over a whole trailer's fill the robot
 *               visits every slot, and the mean is what sets the haul. Slot 0
 *               is the far end of the trailer, a good six metres deeper into
 *               the bay than the last one; using it makes every projected cycle
 *               about a fifth too slow.
 *
 *               `readyIn`, by trailer state:
 *
 *                 Docked        readyIn = 0
 *                 Opening       readyIn = OPEN_TIME - elapsed
 *                 Arriving      readyIn = (ARRIVE_TIME - elapsed) + OPEN_TIME
 *                 Closing/      readyIn = remaining state time
 *                 Leaving         + awayHours x secondsPerHour
 *                                 + ARRIVE_TIME + OPEN_TIME
 *                 Away          readyIn = awayHours x secondsPerHour
 *                                 + ARRIVE_TIME + OPEN_TIME
 *
 *   chargers    ONLY commissioned points (`pad.unlocked`), by position. An empty
 *               list is the death spiral and the model will say so.
 *
 *   secondsPerHour   `settings.dayLengthSeconds / 24`.
 *   slotCount        `SLOT_COUNT`. Passed rather than imported at the call site
 *                    so a test can ask what a bigger trailer would do.
 *   batteryDrain     `settings.batteryDrain`.
 *
 * WHAT TO DO WITH WHAT COMES BACK
 *
 *   1. `cratesRemoved` are indices into the crates array you passed, in the
 *      order they were taken. Splice them out of `level.props` HIGHEST INDEX
 *      FIRST, then `bots.setProps` and `nav.rebuild` — this is the one place a
 *      full nav rebuild is right, because the whole floor has changed at once.
 *   2. `battery[i]` is the new charge for robot i. Write it straight into
 *      `bots.battery`. Robots that went flat come back at zero and will refuse
 *      to lift, exactly as they would have if you had watched it happen.
 *   3. `cratesShipped` and `revenue` go to the ledger. Do NOT also call
 *      `ledger.load` — `avgSeconds` is a measurement of machines working and
 *      would be a lie about a stretch nobody watched. Better to leave the
 *      average alone across a projection than to invent one.
 *   4. `bayFilled[j]` is where each trailer ended up. Set `t.cargo` to match
 *      and rebuild the bay corridors.
 *   5. `breakdown` is the return-to-desk report: `worst` names the one thing to
 *      tell the player about, `cratesLostBy` says what it cost, and `segments`
 *      is the timeline if you ever want to draw it.
 *
 * WHAT IT WILL NOT DO FOR YOU
 *
 *   - It does not advance the day clock, the trailer state machines, or the
 *     charging couplers. Those are cheap and closed-form; step them separately.
 *   - It does not know about orders a player left queued. It assumes a fleet
 *     being worked sensibly, which is the only assumption available about time
 *     nobody was present for.
 *   - It is not the same as the simulation and should not be checked against it
 *     crate for crate. It is checked against it in aggregate, which is the
 *     claim it actually makes.
 *
 * ── WHERE TO ADD THINGS ────────────────────────────────────────────────────
 *
 *   A new hauler class     Nothing. Lanes are per crate KIND and each lists the
 *                          classes that can serve it, straight out of `canLift`.
 *                          Spawn a Big hauler and it starts working 2x2 timber
 *                          on the next projection — and falls back to pallets
 *                          when the 2x2s run out, because `pickLane` chooses
 *                          fresh every segment.
 *   A new crate kind       Nothing. Lanes are built from whatever kinds appear
 *                          in the snapshot.
 *   Changing `liftRefusal` Nothing. `servers` is derived from it.
 *   More bays              Pass them. `dockStage` is written for B bays.
 *   More charging points   Pass them. Contention is already modelled.
 *   A new constraint       Write a `RateStage` and push it into `STAGES`, and
 *                          add its name to `RateLimit` and `ALL_LIMITS`. The
 *                          resolver takes the running minimum and the breakdown
 *                          picks it up with no further work.
 *   Crates being PRODUCED  Today the floor is a fixed stock. A production stage
 *                          would be a source rather than a stage: give `Lane` an
 *                          inflow and let `nextEvent` stop at the moment stock
 *                          crosses zero in either direction.
 *   Flying / water robots  These need a per-lane, or rather per-COHORT,
 *                          `pathSlack`: a flyer routes straight and a ground
 *                          machine does not, over the same floor. `driveSeconds`
 *                          already takes the routed distance, so the change is
 *                          to move `pathSlack` onto the robot and multiply in
 *                          `cohortRates` rather than in `buildLanes`.
 *
 * ── WHAT IS DELIBERATELY LEFT ROUGH ────────────────────────────────────────
 *
 *   - `pickLane` is greedy, not optimal. Every cohort takes the nearest kind it
 *     is rated for, which can leave a specialist queueing behind a generalist on
 *     the same pile. A real assignment would be a small transportation problem;
 *     it is not worth solving until there is more than one hauler class to
 *     assign, and the greedy answer is what a player does anyway.
 *   - Robot positions are not modelled, so the FIRST cycle after a projection
 *     starts is charged at the steady-state haul rather than from where each
 *     machine is standing. Over the horizons this is for, that is one cycle in
 *     hundreds.
 *   - Congestion is not modelled at all. Ten thousand robots in one hall would
 *     shove each other about; the model would have them each at full rate. If
 *     fleet sizes ever get there, a congestion stage keyed on floor area is the
 *     place to put it.
 */
