import { describe, expect, it } from 'vitest';

import { BATTERY_DEAD } from './bots';
import { CrateMaterial, CrateShape, HAULER, crateRadius } from './cargo';
import { buildLevelGeometry } from './level';
import { SLOT_COUNT, TrailerFleet } from './trailers';
import {
  RATE_CONSTANTS,
  RateLimit,
  cycleCharge,
  cycleSeconds,
  projectProduction,
  trailerDeadSeconds,
  type RateModelBay,
  type RateModelCharger,
  type RateModelCrate,
  type RateModelRobot,
  type WorldSnapshot,
} from './rateModel';

/**
 * The model is a claim about the machine, so the tests are mostly claims about
 * the machine too: that the cycle it predicts matches what was measured, that
 * each constraint bites when and only when it should, and that nothing goes
 * strange over a horizon of weeks.
 */

const HOUR = 3600;
/** settings.dayLengthSeconds 240 / 24. */
const SECONDS_PER_HOUR = 10;

// ── Snapshot building ───────────────────────────────────────────────────────

function bay(overrides: Partial<RateModelBay> = {}): RateModelBay {
  return { loadX: 0, loadY: 0, filled: 0, cargoValue: 0, readyIn: 0, ...overrides };
}

function robot(overrides: Partial<RateModelRobot> = {}): RateModelRobot {
  return { hauler: HAULER.Standard, battery: 1, speed: 560, turnRate: 3.6, ...overrides };
}

/** `n` timber pallets, all the same distance out from the bay. */
function crateLine(n: number, distance: number): RateModelCrate[] {
  const out: RateModelCrate[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: distance,
      y: 0,
      material: CrateMaterial.Timber,
      shape: CrateShape.Unit,
    });
  }
  return out;
}

function world(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    robots: [robot()],
    crates: crateLine(200, 5000),
    bays: [bay()],
    chargers: [],
    secondsPerHour: SECONDS_PER_HOUR,
    batteryDrain: false,
    ...overrides,
  };
}

/**
 * A dock that swallows anything, so the fleet is the only limit.
 *
 * The trailer cycle always costs SOMETHING — a bay stands dead between loads
 * however quickly it turns round — so "unconstrained" has to be built by
 * zeroing the turnaround, not by hoping it is small.
 */
const NO_TURNAROUND = {
  trailerArriveSeconds: 0,
  trailerOpenSeconds: 0,
  trailerCloseSeconds: 0,
  trailerLeaveSeconds: 0,
  trailerAwayHours: 0,
};

const LEVEL_SEED = 20260820;
const LEVEL = buildLevelGeometry(LEVEL_SEED);

/** Every crate standing on the real starting floor. */
function realCrates(): RateModelCrate[] {
  return LEVEL.props.map((p) => ({ x: p.x, y: p.y, material: p.material, shape: p.shape }));
}

/**
 * The working bay, with its load point at the MIDDLE of the slot run.
 *
 * A robot fills every slot over one trailer, so the mean is what sets the haul.
 * Slot 0 is the far end of the box and is a fifth of a cycle further away.
 */
function realBay(): Partial<RateModelBay> {
  const fleet = new TrailerFleet(LEVEL.bays, LEVEL_SEED);
  const trailer = fleet.trailers.find((t) => TrailerFleet.isDockable(t));
  if (!trailer) throw new Error('no bay in service on the starting level');
  const slot = TrailerFleet.slotPosition(trailer, Math.floor(SLOT_COUNT / 2));
  return { loadX: slot.x, loadY: slot.y };
}

// ── Calibration ─────────────────────────────────────────────────────────────

describe('calibration against measured behaviour', () => {
  it('reproduces the measured 22 s haul and 0.0245 charge from one haul distance', () => {
    const k = RATE_CONSTANTS;
    const speed = 560;
    const turnRate = 3.6;

    // Solve for the routed leg length that produces the measured 22 s cycle.
    let lo = 0;
    let hi = 200000;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (cycleSeconds(mid, speed, turnRate, k) < 22) lo = mid;
      else hi = mid;
    }
    const leg = (lo + hi) / 2;

    // The two measurements were taken independently. Time and charge depend on
    // distance through different constants, so agreeing at the same distance is
    // the real test — a model fitted to one of them would miss the other.
    expect(cycleSeconds(leg, speed, turnRate, k)).toBeCloseTo(22, 3);
    const charge = cycleCharge(leg, speed, turnRate, k);
    expect(charge).toBeGreaterThan(0.0245 * 0.95);
    expect(charge).toBeLessThan(0.0245 * 1.05);
  });

  it('predicts the measured cycle on the real level geometry', () => {
    const snapshot = world({
      robots: [robot()],
      crates: realCrates(),
      bays: [bay(realBay())],
      batteryDrain: false,
      constants: NO_TURNAROUND,
    });

    const seconds = 1 / projectProduction(snapshot, 1).breakdown.segments[0].idealRate;
    // Measured on the running game at roughly 22 s per crate for one machine
    // working the near clusters. The nearest crates on this floor come out at
    // 14 s and the eighth at 23 s, so the first band's mean landing just under
    // the measurement is the model agreeing with it.
    expect(seconds).toBeGreaterThan(17);
    expect(seconds).toBeLessThan(26);
  });

  it('agrees with the trailer state machine on how long a bay is dead', () => {
    // 2.8 close + 3.2 leave + 3.75 h x 10 s + 3.4 arrive + 1.6 open.
    expect(trailerDeadSeconds(SECONDS_PER_HOUR, RATE_CONSTANTS)).toBeCloseTo(48.5, 6);
  });
});

// ── The unconstrained case ──────────────────────────────────────────────────

describe('unconstrained', () => {
  it('runs at exactly the fleet rate when nothing else binds', () => {
    const snapshot = world({
      robots: [robot(), robot(), robot()],
      crates: crateLine(6000, 4000),
      bays: [bay(), bay(), bay(), bay()],
      batteryDrain: false,
      constants: NO_TURNAROUND,
    });

    const result = projectProduction(snapshot, HOUR);
    const perRobot = cycleSeconds(
      (4000 - 206 - 206) * RATE_CONSTANTS.pathSlack,
      560,
      3.6,
      RATE_CONSTANTS,
    );
    const expected = (3 / perRobot) * HOUR;

    expect(result.cratesTaken).toBeGreaterThan(expected * 0.99);
    expect(result.cratesTaken).toBeLessThanOrEqual(expected);
    expect(result.breakdown.worst).toBe(RateLimit.Fleet);
    expect(result.breakdown.secondsBy[RateLimit.Fleet]).toBeCloseTo(HOUR, 3);
  });

  it('scales linearly with the number of robots', () => {
    const base = world({ crates: crateLine(6000, 4000), bays: [bay(), bay(), bay(), bay()], constants: NO_TURNAROUND });
    const one = projectProduction({ ...base, robots: [robot()] }, HOUR).cratesTaken;
    const ten = projectProduction(
      { ...base, robots: Array.from({ length: 10 }, () => robot()) },
      HOUR,
    ).cratesTaken;
    expect(ten / one).toBeGreaterThan(9.9);
    expect(ten / one).toBeLessThan(10.1);
  });

  it('is slower for a longer haul', () => {
    const near = projectProduction(
      world({ crates: crateLine(6000, 2000), constants: NO_TURNAROUND }),
      HOUR,
    ).cratesTaken;
    const far = projectProduction(
      world({ crates: crateLine(6000, 20000), constants: NO_TURNAROUND }),
      HOUR,
    ).cratesTaken;
    expect(far).toBeLessThan(near * 0.5);
  });
});

// ── Each constraint on its own ──────────────────────────────────────────────

describe('the dock', () => {
  it('caps throughput at the trailer turnaround when the fleet outruns it', () => {
    const robots = Array.from({ length: 40 }, () => robot());
    const snapshot = world({ robots, crates: crateLine(40000, 3000), batteryDrain: false });

    const result = projectProduction(snapshot, 10 * HOUR);
    const dead = trailerDeadSeconds(SECONDS_PER_HOUR, RATE_CONSTANTS);
    // Forty machines fill a trailer far faster than it can be swapped, so the
    // ceiling is one trailer per turnaround.
    const ceiling = SLOT_COUNT / dead;

    expect(result.rate).toBeLessThanOrEqual(ceiling);
    expect(result.rate).toBeGreaterThan(ceiling * 0.7);
    expect(result.breakdown.worst).toBe(RateLimit.Dock);
  });

  it('is honoured for a trailer of any size', () => {
    const robots = Array.from({ length: 40 }, () => robot());
    const snapshot = world({ robots, crates: crateLine(40000, 3000) });
    const twelve = projectProduction({ ...snapshot, slotCount: 12 }, 10 * HOUR).cratesTaken;
    const twentyFour = projectProduction({ ...snapshot, slotCount: 24 }, 10 * HOUR).cratesTaken;
    // Twice the slots per turnaround is close to twice the throughput while the
    // dock is the binding constraint.
    expect(twentyFour / twelve).toBeGreaterThan(1.7);
  });

  it('lets more bays through more crates', () => {
    const robots = Array.from({ length: 40 }, () => robot());
    const one = projectProduction(
      world({ robots, crates: crateLine(40000, 3000), bays: [bay()] }),
      2 * HOUR,
    ).cratesTaken;
    const four = projectProduction(
      world({ robots, crates: crateLine(40000, 3000), bays: [bay(), bay(), bay(), bay()] }),
      2 * HOUR,
    ).cratesTaken;
    expect(four).toBeGreaterThan(one * 3);
    // Unlocking bays 1-3 is the whole of the change; nothing in the model knows
    // it happened beyond being handed four bays instead of one.
    expect(four).toBeLessThan(40000);
  });

  it('produces nothing at all while every bay is away', () => {
    const snapshot = world({ bays: [bay({ readyIn: 400 })] });
    const shut = projectProduction(snapshot, 300);
    expect(shut.cratesTaken).toBe(0);
    expect(shut.breakdown.worst).toBe(RateLimit.DockClosed);
    expect(shut.breakdown.secondsBy[RateLimit.DockClosed]).toBeCloseTo(300, 3);

    // And starts the moment the trailer is back on the bumpers.
    const after = projectProduction(snapshot, 800);
    expect(after.cratesTaken).toBeGreaterThan(0);
    expect(after.breakdown.secondsBy[RateLimit.DockClosed]).toBeCloseTo(400, 3);
  });
});

describe('the warehouse floor', () => {
  it('stops when the last liftable crate has gone', () => {
    const snapshot = world({ crates: crateLine(7, 3000), constants: NO_TURNAROUND });
    const result = projectProduction(snapshot, 10 * HOUR);

    expect(result.cratesTaken).toBe(7);
    expect(result.cratesRemoved).toHaveLength(7);
    expect(new Set(result.cratesRemoved).size).toBe(7);
    expect(result.breakdown.worst).toBe(RateLimit.Warehouse);
  });

  it('produces nothing on an empty floor and says why', () => {
    const result = projectProduction(world({ crates: [] }), HOUR);
    expect(result.cratesTaken).toBe(0);
    expect(result.breakdown.worst).toBe(RateLimit.Warehouse);
    expect(result.breakdown.cratesLostBy[RateLimit.Warehouse]).toBeGreaterThan(0);
  });

  it('works the nearest crates first, so the haul lengthens as it goes', () => {
    const crates = [...crateLine(20, 1500), ...crateLine(20, 30000)];
    const result = projectProduction(world({ crates, constants: NO_TURNAROUND }), 10 * HOUR);
    const rates = result.breakdown.segments.filter((s) => s.rate > 0).map((s) => s.rate);
    expect(rates.length).toBeGreaterThan(1);
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]).toBeLessThanOrEqual(rates[i - 1] + 1e-9);
    }
  });

  it('blames the hauler roster when the crates are there but nothing is rated for them', () => {
    const crates: RateModelCrate[] = Array.from({ length: 20 }, () => ({
      x: 3000,
      y: 0,
      material: CrateMaterial.Steel,
      shape: CrateShape.Unit,
    }));
    const result = projectProduction(
      world({ crates, robots: [robot({ hauler: HAULER.Standard })] }),
      HOUR,
    );
    expect(result.cratesTaken).toBe(0);
    expect(result.breakdown.unliftableCrates).toBe(20);
    expect(result.breakdown.worst).toBe(RateLimit.Hauler);
  });

  it('puts a heavy hauler on pallets once its steel has gone', () => {
    // The Heavy is the only machine rated for steel, but it can lift a timber
    // 1x1 as well as anything can. A model that assigned each crate kind to one
    // class up front would leave it standing idle beside the pile.
    const crates: RateModelCrate[] = [
      ...Array.from({ length: 3 }, () => ({
        x: 3000,
        y: 0,
        material: CrateMaterial.Steel,
        shape: CrateShape.Unit,
      })),
      ...crateLine(400, 3000),
    ];
    const solo = projectProduction(
      world({ robots: [robot()], crates, constants: NO_TURNAROUND }),
      600,
    );
    const pair = projectProduction(
      world({
        robots: [robot(), robot({ hauler: HAULER.Heavy })],
        crates,
        constants: NO_TURNAROUND,
      }),
      600,
    );
    // Three steel crates are a couple of minutes' work; for the rest of the
    // window the Heavy is on pallets, so two machines do close to twice one.
    expect(pair.cratesTaken).toBeGreaterThan(solo.cratesTaken * 1.9);
    expect(pair.breakdown.unliftableCrates).toBe(0);
  });

  it('leaves a lane alone when nothing in the fleet can serve it', () => {
    const crates: RateModelCrate[] = [
      ...Array.from({ length: 3 }, () => ({
        x: 3000,
        y: 0,
        material: CrateMaterial.Steel,
        shape: CrateShape.Unit,
      })),
      ...crateLine(20, 3000),
    ];
    const result = projectProduction(
      world({ robots: [robot()], crates, constants: NO_TURNAROUND }),
      HOUR,
    );
    expect(result.cratesTaken).toBe(20);
    expect(result.breakdown.unliftableCrates).toBe(3);
    // The steel is reported as a roster problem, not as an empty warehouse.
    expect(result.breakdown.worst).toBe(RateLimit.Hauler);
  });

  it('gives a heavy hauler the steel a standard machine has to leave', () => {
    const crates: RateModelCrate[] = Array.from({ length: 20 }, () => ({
      x: 3000,
      y: 0,
      material: CrateMaterial.Steel,
      shape: CrateShape.Unit,
    }));
    const result = projectProduction(
      world({ crates, robots: [robot({ hauler: HAULER.Heavy })], constants: NO_TURNAROUND }),
      HOUR,
    );
    expect(result.breakdown.unliftableCrates).toBe(0);
    expect(result.cratesTaken).toBe(20);
  });
});

describe('batteries', () => {
  it('runs a fleet flat and leaves it there when nothing is commissioned', () => {
    const snapshot = world({
      robots: [robot({ battery: 1 })],
      crates: crateLine(6000, 4000),
      chargers: [],
      batteryDrain: true,
      constants: NO_TURNAROUND,
    });

    const result = projectProduction(snapshot, 24 * HOUR);
    const perCrate = cycleCharge(
      (4000 - 412) * RATE_CONSTANTS.pathSlack,
      560,
      3.6,
      RATE_CONSTANTS,
    );
    const affordable = 1 / perCrate;

    expect(result.cratesTaken).toBeGreaterThan(affordable * 0.9);
    expect(result.cratesTaken).toBeLessThanOrEqual(affordable);
    expect(result.battery[0]).toBeLessThanOrEqual(BATTERY_DEAD);
    expect(result.breakdown.worst).toBe(RateLimit.Flat);
    // Nothing recovers: twice the time is not one more crate.
    expect(projectProduction(snapshot, 48 * HOUR).cratesTaken).toBe(result.cratesTaken);
  });

  it('starts a nearly flat machine and stops it almost at once', () => {
    const result = projectProduction(
      world({
        robots: [robot({ battery: 0.05 })],
        crates: crateLine(1000, 4000),
        batteryDrain: true,
        constants: NO_TURNAROUND,
      }),
      24 * HOUR,
    );
    expect(result.cratesTaken).toBeGreaterThan(0);
    expect(result.cratesTaken).toBeLessThan(4);
  });

  it('kills an idle fleet that has no bay to work and no point to sit on', () => {
    const result = projectProduction(
      world({
        robots: [robot({ battery: 1 })],
        bays: [bay({ readyIn: 1e9 })],
        batteryDrain: true,
      }),
      6 * HOUR,
    );
    // DRAIN_IDLE is 1/14000, so a full battery is gone in under four hours of
    // standing about. This is a real way to lose a fleet overnight.
    expect(result.cratesTaken).toBe(0);
    expect(result.battery[0]).toBeLessThanOrEqual(BATTERY_DEAD);
  });

  it('keeps going indefinitely once a point is commissioned', () => {
    const withPoint = world({
      robots: [robot({ battery: 1 })],
      crates: crateLine(6000, 4000),
      chargers: [{ x: 4000, y: 4000 } as RateModelCharger],
      batteryDrain: true,
      constants: NO_TURNAROUND,
    });
    const without = { ...withPoint, chargers: [] };

    const fed = projectProduction(withPoint, 24 * HOUR);
    const starved = projectProduction(without, 24 * HOUR);

    expect(fed.cratesTaken).toBeGreaterThan(starved.cratesTaken * 20);
    // It settles at its charging threshold rather than dying.
    expect(fed.battery[0]).toBeGreaterThan(BATTERY_DEAD);
    expect(fed.breakdown.worst).not.toBe(RateLimit.Flat);
  });

  it('parks a machine with nothing to do on a point and fills it up', () => {
    // Not the same as being in a work/charge duty cycle. A machine that has run
    // the floor out is stood on the charger, not shuttling to it, so it comes
    // back full — and the caller writes this straight into BotPool.battery.
    const result = projectProduction(
      world({
        robots: [robot({ battery: 1 })],
        crates: crateLine(6, 3000),
        chargers: [{ x: 3000, y: 3000 }],
        batteryDrain: true,
        constants: NO_TURNAROUND,
      }),
      8 * HOUR,
    );
    expect(result.cratesTaken).toBe(6);
    expect(result.battery[0]).toBeCloseTo(1, 6);
  });

  it('shares the points out when more machines are idle than there are points', () => {
    const result = projectProduction(
      world({
        robots: Array.from({ length: 50 }, () => robot({ battery: 0.5 })),
        crates: [],
        chargers: [{ x: 3000, y: 3000 }],
        batteryDrain: true,
      }),
      300,
    );
    // One point between fifty machines fills nobody quickly, and the model must
    // not pretend all fifty are plugged in at once.
    expect(result.battery[0]).toBeLessThan(0.55);
  });

  it('charges nothing and reserves nothing when drain is switched off', () => {
    const on = projectProduction(
      world({ crates: crateLine(6000, 4000), batteryDrain: true, chargers: [{ x: 0, y: 0 }], constants: NO_TURNAROUND }),
      HOUR,
    );
    const off = projectProduction(
      world({ crates: crateLine(6000, 4000), batteryDrain: false, constants: NO_TURNAROUND }),
      HOUR,
    );
    expect(off.battery[0]).toBe(1);
    expect(off.cratesTaken).toBeGreaterThanOrEqual(on.cratesTaken);
  });

  it('makes the charging run the bottleneck once the fleet outgrows it', () => {
    const robots = Array.from({ length: 200 }, () => robot({ battery: 0.02 }));
    const result = projectProduction(
      world({
        robots,
        crates: crateLine(40000, 4000),
        bays: Array.from({ length: 40 }, () => bay()),
        chargers: [{ x: 4000, y: 4000 }],
        batteryDrain: true,
        constants: NO_TURNAROUND,
      }),
      HOUR,
    );
    expect(result.breakdown.worst).toBe(RateLimit.Charger);

    // Ten points carry a good deal more of the same fleet than one does, and
    // stop being the thing in the way.
    const many = projectProduction(
      world({
        robots,
        crates: crateLine(40000, 4000),
        bays: Array.from({ length: 40 }, () => bay()),
        chargers: Array.from({ length: 10 }, () => ({ x: 4000, y: 4000 })),
        batteryDrain: true,
        constants: NO_TURNAROUND,
      }),
      HOUR,
    );
    expect(many.cratesTaken).toBeGreaterThan(result.cratesTaken * 4);
    // Charging still costs something with ten points — a machine on a pad is
    // not hauling — but queueing for one has stopped being the problem.
    expect(many.breakdown.cratesLostBy[RateLimit.Charger]).toBeLessThan(
      result.breakdown.cratesLostBy[RateLimit.Charger] * 0.2,
    );
  });
});

// ── Shipping and money ──────────────────────────────────────────────────────

describe('shipping', () => {
  it('pays only for crates that actually left on a truck', () => {
    const result = projectProduction(
      world({ crates: crateLine(SLOT_COUNT - 1, 3000), constants: NO_TURNAROUND }),
      10 * HOUR,
    );
    expect(result.cratesTaken).toBe(SLOT_COUNT - 1);
    expect(result.cratesShipped).toBe(0);
    expect(result.revenue).toBe(0);
    expect(result.cratesAboard).toBe(SLOT_COUNT - 1);
    expect(result.bayFilled[0]).toBe(SLOT_COUNT - 1);
  });

  it('ships a trailer the moment its last slot is filled', () => {
    const result = projectProduction(
      world({ crates: crateLine(SLOT_COUNT, 3000), constants: NO_TURNAROUND }),
      10 * HOUR,
    );
    expect(result.cratesShipped).toBe(SLOT_COUNT);
    // A timber 1x1 is worth 45.
    expect(result.revenue).toBeCloseTo(45 * SLOT_COUNT, 6);
    expect(result.cratesAboard).toBe(0);
  });

  it('credits what was already aboard when that trailer goes', () => {
    const result = projectProduction(
      world({
        crates: crateLine(SLOT_COUNT, 3000),
        bays: [bay({ filled: 4, cargoValue: 4 * 130 })],
        constants: NO_TURNAROUND,
      }),
      10 * HOUR,
    );
    // Four aboard plus SLOT_COUNT - 4 loaded fills it; the rest start the next.
    expect(result.cratesShipped).toBe(SLOT_COUNT);
    expect(result.revenue).toBeCloseTo(4 * 130 + (SLOT_COUNT - 4) * 45, 6);
    expect(result.bayFilled[0]).toBe(4);
  });

  it('works two part-loaded bays in turn', () => {
    const result = projectProduction(
      world({
        crates: crateLine(SLOT_COUNT - 2, 3000),
        bays: [
          bay({ filled: SLOT_COUNT - 4, cargoValue: 100 }),
          bay({ filled: SLOT_COUNT - 6, cargoValue: 200 }),
        ],
        constants: NO_TURNAROUND,
      }),
      10 * HOUR,
    );
    // Four finish the first trailer, six the second, and the rest sit on the
    // second bay's replacement.
    expect(result.cratesTaken).toBe(SLOT_COUNT - 2);
    expect(result.cratesShipped).toBe(2 * SLOT_COUNT);
    expect(result.revenue).toBeCloseTo(300 + 10 * 45, 6);
    expect(result.bayFilled).toEqual([SLOT_COUNT - 12, 0]);
  });
});

// ── Long horizons ───────────────────────────────────────────────────────────

describe('long-horizon stability', () => {
  const pad = LEVEL.chargers[0];

  const realWorld = (): WorldSnapshot =>
    world({
      robots: [robot()],
      crates: realCrates(),
      bays: [bay(realBay())],
      chargers: [{ x: pad.x, y: pad.y }],
      batteryDrain: true,
    });

  it('stays finite and exact over a month away', () => {
    const result = projectProduction(realWorld(), 30 * 24 * HOUR);
    expect(Number.isFinite(result.cratesTaken)).toBe(true);
    expect(Number.isFinite(result.revenue)).toBe(true);
    expect(result.breakdown.truncated).toBe(false);

    const liftable = LEVEL.props.filter((p) => p.material === CrateMaterial.Timber
      && p.shape === CrateShape.Unit).length;
    expect(result.cratesTaken).toBe(liftable);
    expect(result.cratesRemoved).toHaveLength(liftable);

    const accounted = Object.values(result.breakdown.secondsBy).reduce((a, b) => a + b, 0);
    expect(accounted).toBeCloseTo(30 * 24 * HOUR, 0);
  });

  it('never goes backwards as the horizon grows', () => {
    let previous = -1;
    for (const seconds of [0, 30, 300, HOUR, 8 * HOUR, 24 * HOUR, 7 * 24 * HOUR]) {
      const result = projectProduction(realWorld(), seconds);
      expect(result.cratesTaken).toBeGreaterThanOrEqual(previous);
      expect(result.cratesShipped).toBeLessThanOrEqual(result.cratesTaken + SLOT_COUNT);
      expect(Number.isNaN(result.rate)).toBe(false);
      previous = result.cratesTaken;
    }
  });

  it('costs about the same to project a week as a minute', () => {
    const short = projectProduction(realWorld(), 60);
    const long = projectProduction(realWorld(), 7 * 24 * HOUR);
    // Segment count is bounded by events, not by elapsed time.
    expect(long.breakdown.segments.length).toBeLessThan(60);
    expect(short.breakdown.segments.length).toBeLessThan(60);
  });

  it('gives roughly the same answer split in two as taken whole', () => {
    const snapshot = world({
      robots: [robot()],
      crates: crateLine(6000, 4000),
      chargers: [{ x: 4000, y: 4000 }],
      batteryDrain: true,
    });

    const whole = projectProduction(snapshot, 4 * HOUR);

    const first = projectProduction(snapshot, 2 * HOUR);
    const carried: WorldSnapshot = {
      ...snapshot,
      robots: snapshot.robots.map((r, i) => ({ ...r, battery: first.battery[i] })),
      crates: snapshot.crates.filter((_, i) => !first.cratesRemoved.includes(i)),
      bays: [bay({ filled: first.bayFilled[0] })],
    };
    const second = projectProduction(carried, 2 * HOUR);

    const split = first.cratesTaken + second.cratesTaken;
    expect(split).toBeGreaterThan(whole.cratesTaken * 0.95);
    expect(split).toBeLessThan(whole.cratesTaken * 1.05);
  });

  it('returns a battery for every robot and only valid crate indices', () => {
    const snapshot = realWorld();
    const result = projectProduction(snapshot, 8 * HOUR);
    expect(result.battery).toHaveLength(snapshot.robots.length);
    for (const index of result.cratesRemoved) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(snapshot.crates.length);
    }
    expect(new Set(result.cratesRemoved).size).toBe(result.cratesRemoved.length);
  });

  it('does nothing at all over a zero-second horizon', () => {
    const result = projectProduction(realWorld(), 0);
    expect(result.cratesTaken).toBe(0);
    expect(result.revenue).toBe(0);
    expect(result.rate).toBe(0);
    expect(result.breakdown.segments).toHaveLength(0);
  });
});

// ── Guard against the level drifting under the model ────────────────────────

describe('assumptions about the level', () => {
  it('leaves crate sizes as the model measures them', () => {
    // The approach standoff uses the crate's own half-extent, so a change to
    // SHAPE_UNITS moves the haul distance. Fail loudly if it does.
    expect(crateRadius(CrateShape.Unit)).toBeCloseTo(Math.hypot(120, 120) / 2, 6);
  });

  it('has crates on the starting floor that no hauler class can ever lift', () => {
    // Steel in anything but a 1x1 needs a Heavy for the material and a Long or
    // Big for the shape, and no class is both. These crates are permanent
    // scenery, and the model reports them so the player can be told.
    const level = buildLevelGeometry(20260820);
    const result = projectProduction(
      world({
        robots: [
          robot({ hauler: HAULER.Standard }),
          robot({ hauler: HAULER.Long }),
          robot({ hauler: HAULER.Big }),
          robot({ hauler: HAULER.Heavy }),
        ],
        crates: level.props.map((p) => ({
          x: p.x,
          y: p.y,
          material: p.material,
          shape: p.shape,
        })),
      }),
      HOUR,
    );
    expect(result.breakdown.unliftableCrates).toBeGreaterThan(0);
  });
});
