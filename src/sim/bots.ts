import { angleDelta, clamp, TAU } from '../core/mathUtils';
import { CRATE_UNIT, canLift, HAULER } from './cargo';
import { TRICKLE_RATE } from './progress';
import type { Prop } from './level';
import type { NavGrid } from './navGrid';
import { CHARGE_PAD_H, CHARGE_PAD_W, type ChargePad } from './level';

/**
 * Ground robots.
 *
 * State lives in flat typed arrays rather than one object per robot. That is
 * the whole reason this can scale: at a hundred thousand units the cost is
 * memory traffic over a few contiguous buffers, not chasing a hundred thousand
 * pointers and feeding the garbage collector.
 */

/**
 * 240 x 150 cm. Sized from its load: the deck has to take a 120 x 80 Euro
 * pallet with handling clearance, and the loader arms need somewhere to stow.
 */
export const BOT_LENGTH = 240;
export const BOT_WIDTH = 150;
/** Collision radius — a little tighter than the hull so they can pass closely. */
/** Navigation radius, between half-width and half-length. */
export const BOT_RADIUS = 84;
/**
 * Half the hull's longest dimension. Used when pushing out of cargo: the nav
 * grid only knows about the robot's centre, so a machine turning on the spot
 * could otherwise sweep its nose through a crate.
 */
export const BOT_HALF_LENGTH = BOT_LENGTH / 2;

export const BotState = { Idle: 0, Moving: 1 } as const;

/**
 * What a robot has been told to do. Fetching runs through its own little
 * sequence once the robot has arrived, which is what produces the reverse-up,
 * arms-out, load-on-deck behaviour.
 */
export const BotTask = { None: 0, Move: 1, Fetch: 2, Deliver: 3, Charge: 4 } as const;

/** Stages of a fetch, after the drive is done. */
const Phase = {
  Driving: 0,
  Aligning: 1,
  Reaching: 2,
  Closing: 3,
  Lifting: 4,
  /** Charging only: reversing into the bay once squared up in front of it. */
  Backing: 5,
} as const;

/** How long each stage of the grab takes, in seconds. */
const REACH_TIME = 0.75;
const CLOSE_TIME = 0.30;
/** Raising the crate off the floor and setting it on the deck. */
const LIFT_TIME = 0.85;
/** Arms returning to their recesses once nothing is being collected. */
const STOW_TIME = 0.65;
/** How precisely the robot has to be squared up before it reaches. */
const ALIGN_ANGLE = 0.035;
const ALIGN_DISTANCE = 6;

/** Gap left between the robot's tail and the crate it is collecting. */
const GRAB_GAP = 26;

/**
 * Braking, in cm/s^2.
 *
 * The old arrival ramp scaled speed by `distance / 260`, which meant a short
 * hop never got out of first gear — a two metre nudge crawled the whole way.
 * A real brake curve runs flat out until it genuinely has to slow down.
 */
const DECEL = 1100;
/** How long a robot may make no headway before its order is abandoned. */
const STALL_LIMIT = 2.5;

/**
 * Battery, as a fraction per second unless stated.
 *
 * Sized so a full charge comfortably covers the first trailer and then some:
 * about a quarter of a charge for twelve crates, so running out is something
 * you plan around rather than something that interrupts the first shift.
 *
 * Everything costs what it ought to. Sitting still costs almost nothing.
 * Driving costs by how fast you are going. Driving with a crate aboard costs
 * more than driving empty, because the machine is carrying it. Working the arms
 * costs a lump, and lifting costs more than setting down.
 */
const DRAIN_IDLE = 1 / 14000;
const DRAIN_DRIVING = 1 / 2000;
/** Extra cost of driving with a load on the deck. */
const LADEN_MULTIPLIER = 1.65;
/** Taking a crate up off the floor. */
const DRAIN_PER_LIFT = 0.0085;
/** Lowering one, which is the same actuators doing less work. */
const DRAIN_PER_PLACE = 0.0055;
/** A point fills a robot in about twenty seconds. */
const CHARGE_RATE = 1 / 20;
/** Below this a robot is dead: it crawls, and it will not lift anything. */
export const BATTERY_DEAD = 0.001;
/** What a flat robot can still manage, as a fraction of its rated speed. */
const DEAD_SPEED = 0.16;
/** Nose east, into the cabinet: the charge strip is on the front of the hull. */
/**
 * Nose OUT of the bay: a machine reverses onto its charger the way it reverses
 * onto a crate, and it leaves the gauge facing the hall where it can be read.
 */
const DOCK_FACING = Math.PI;
/**
 * Where a robot squares up before reversing in, measured from the pad centre.
 *
 * Far enough out to give the reverse a visible run, and the one number both the
 * approach point and the align standoff are derived from so they cannot drift.
 */
const DOCK_APPROACH = 300;
/** How fast it backs in. Slow, because that is what makes it read as careful. */
const DOCK_REVERSE_SPEED = 105;
/** Coupler travel times, in seconds. Out briskly, back in unhurriedly. */
const ARM_EXTEND_TIME = 0.55;
const ARM_STOW_TIME = 0.9;
/** How hard acceleration chases the target speed. */
const ACCEL_RESPONSE = 9;

/** What a queued order does when it comes up. */
export const OrderKind = { Move: 0, Fetch: 1, Deliver: 2, Charge: 3 } as const;
export type OrderKindValue = (typeof OrderKind)[keyof typeof OrderKind];

/**
 * One entry in a robot's order queue.
 *
 * A queued fetch holds the crate BY IDENTITY rather than by index: crates are
 * spliced out of the level as they are collected, so an index stored now points
 * at a different crate by the time the order comes up.
 *
 * A queued delivery holds no slot at all. Which slot is free depends on what
 * else has been loaded in the meantime, so it is resolved at the moment the
 * order starts, through `onResolveDrop`.
 */
export interface QueuedOrder {
  kind: OrderKindValue;
  /** Where the order points, for drawing the queued route. */
  x: number;
  y: number;
  prop?: Prop;
  pad?: ChargePad;
}

/** Waypoints for a robot currently under orders. */
interface ActivePath {
  points: Float32Array;
  /** Index of the waypoint being steered towards, in points. */
  cursor: number;
}

export class BotPool {
  count = 0;
  capacity: number;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly angle: Float32Array;
  readonly speed: Float32Array;
  readonly turnRate: Float32Array;
  readonly goalX: Float32Array;
  readonly goalY: Float32Array;
  readonly state: Uint8Array;
  readonly selected: Uint8Array;
  /**
   * How many orders this machine may stack behind the one it is running.
   *
   * Zero to begin with: one order at a time is the whole of the controls on the
   * first day, and everything else is introduced one purchase at a time.
   */
  readonly queueMax: Uint16Array;
  /** Charge remaining, 0 to 1. */
  readonly battery: Float32Array;
  /** 1 while sitting on a live charging point. */
  readonly charging: Uint8Array;
  /**
   * 1 when the charge is coming from the free trickle socket rather than a
   * commissioned point. Slow, but it can never bankrupt anyone, which is what
   * makes it impossible to be stranded flat and broke.
   */
  readonly onTrickle: Uint8Array;
  /** Charge taken on this tick, as a fraction. What the meter bills. */
  readonly chargedThisFrame: Float32Array;
  /** Seconds spent not getting any closer to the current waypoint. */
  readonly stallTime: Float32Array;
  /** Distance to the waypoint last frame, for detecting a stall. */
  readonly lastGap: Float32Array;
  /** Smoothed travel speed, for track animation and light dimming. */
  readonly velocity: Float32Array;
  readonly phase: Float32Array;
  /** Distance driven, in cm. Drives the track animation frame. */
  readonly odometer: Float32Array;
  /** Current order type, one of BotTask. */
  readonly task: Uint8Array;
  /** Index into the level's prop list while fetching, else -1. */
  readonly targetProp: Int32Array;
  /** Stage within a fetch. */
  readonly taskPhase: Uint8Array;
  /** Seconds elapsed in the current fetch stage. */
  readonly phaseTime: Float32Array;
  /** Loader arm extension, 0 stowed to 1 fully out. */
  readonly armExtend: Float32Array;
  /** What is riding on the deck. Material is -1 when the deck is empty. */
  readonly carryMaterial: Int8Array;
  readonly carryShape: Int8Array;
  /**
   * What this machine is rated to move, as a packed capability.
   *
   * Sixteen bits, not eight: the pack is deck * 100 + weight, so a full-deck
   * heavy hauler is 402 and would silently wrap in a byte.
   */
  readonly hauler: Uint16Array;
  /** Where a delivery is being set down. */
  readonly placeX: Float32Array;
  readonly placeY: Float32Array;
  /** Which trailer slot a delivery belongs to, or -1. */
  readonly placeSlot: Int32Array;
  /** Which charging point a robot has been sent to, or -1. */
  readonly targetPad: Int32Array;
  /** How far the load reaches along the approach axis, so the standoff suits
   *  the crate actually being collected. */
  readonly grabReach: Float32Array;
  /**
   * Unit vector from the crate out to where the robot parks, fixed when the
   * order is issued. Everything about the grab is measured along this, which is
   * what keeps the crate square to the robot instead of off to one side.
   */
  readonly approachX: Float32Array;
  readonly approachY: Float32Array;
  /** Lift animation, 0 on the floor to 1 settled on the deck. */
  readonly liftT: Float32Array;
  /** Where the crate was picked up from, so the lift can start there. */
  readonly liftFromX: Float32Array;
  readonly liftFromY: Float32Array;

  /**
   * Only robots actually under orders carry a path, and you command squads, not
   * the whole fleet — so a sparse map costs far less than a per-robot buffer.
   */
  private chargers: ChargePad[] = [];
  private trickle: ((x: number, y: number) => boolean) | null = null;
  private readonly paths = new Map<number, ActivePath>();

  /**
   * Destinations queued behind the one currently being driven to, as a flat
   * [x, y, ...] list per robot. Shift + right click appends here instead of
   * replacing the order.
   */
  private readonly queues = new Map<number, QueuedOrder[]>();

  /** Called when a robot finishes setting a load down. */
  onDelivered: ((bot: number, slot: number, material: number, shape: number) => void) | null = null;
  /**
   * Asked where a QUEUED delivery should go, at the moment it starts. Returns
   * null when there is nowhere to put it — no trailer docked, or it is full.
   */
  onResolveDrop: ((bot: number) => { slot: number; x: number; y: number } | null) | null = null;
  /** Something happened worth hearing. Called at most once per event, per robot. */
  onSound: ((what: 'grab' | 'place' | 'charge') => void) | null = null;

  // Spatial hash for neighbour lookups during separation.
  private readonly hashCell = 300;
  private readonly buckets = new Map<number, number[]>();

  // Cargo, hashed the same way so the push-out below stays cheap.
  private props: readonly Prop[] = [];
  private readonly propBuckets = new Map<number, number[]>();

  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.angle = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.turnRate = new Float32Array(capacity);
    this.goalX = new Float32Array(capacity);
    this.goalY = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.selected = new Uint8Array(capacity);
    this.queueMax = new Uint16Array(capacity);
    this.battery = new Float32Array(capacity);
    this.charging = new Uint8Array(capacity);
    this.onTrickle = new Uint8Array(capacity);
    this.chargedThisFrame = new Float32Array(capacity);
    this.stallTime = new Float32Array(capacity);
    this.lastGap = new Float32Array(capacity);
    this.velocity = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.odometer = new Float32Array(capacity);
    this.task = new Uint8Array(capacity);
    this.targetProp = new Int32Array(capacity);
    this.taskPhase = new Uint8Array(capacity);
    this.phaseTime = new Float32Array(capacity);
    this.armExtend = new Float32Array(capacity);
    this.carryMaterial = new Int8Array(capacity);
    this.carryShape = new Int8Array(capacity);
    this.hauler = new Uint16Array(capacity);
    this.placeX = new Float32Array(capacity);
    this.placeY = new Float32Array(capacity);
    this.placeSlot = new Int32Array(capacity);
    this.targetPad = new Int32Array(capacity);
    this.grabReach = new Float32Array(capacity);
    this.approachX = new Float32Array(capacity);
    this.approachY = new Float32Array(capacity);
    this.liftT = new Float32Array(capacity);
    this.liftFromX = new Float32Array(capacity);
    this.liftFromY = new Float32Array(capacity);
  }

  spawn(x: number, y: number, angle = 0): number {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.angle[i] = angle;
    this.speed[i] = 560;   // 5.6 m/s — game pace, not warehouse pace
    this.turnRate[i] = 3.6;
    this.goalX[i] = x;
    this.goalY[i] = y;
    this.state[i] = BotState.Idle;
    this.selected[i] = 0;
    this.velocity[i] = 0;
    this.phase[i] = (i * 0.618) % 1 * TAU;
    this.odometer[i] = 0;
    this.task[i] = BotTask.None;
    this.targetProp[i] = -1;
    this.taskPhase[i] = Phase.Driving;
    this.phaseTime[i] = 0;
    this.armExtend[i] = 0;
    this.carryMaterial[i] = -1;
    this.carryShape[i] = 0;
    this.hauler[i] = HAULER.Standard;
    this.queueMax[i] = 0;
    this.battery[i] = 1;
    this.charging[i] = 0;
    this.placeSlot[i] = -1;
    this.targetPad[i] = -1;
    this.approachX[i] = 1;
    this.approachY[i] = 0;
    this.liftT[i] = 1;
    this.liftFromX[i] = x;
    this.liftFromY[i] = y;
    return i;
  }

  private grow(): void {
    const next = Math.ceil(this.capacity * 1.8);
    const copy = <T extends Float32Array | Uint8Array>(src: T, make: (n: number) => T): T => {
      const dst = make(next);
      dst.set(src);
      return dst;
    };
    // Typed arrays are fixed-size, so growth means reallocating each column.
    (this as { x: Float32Array }).x = copy(this.x, (n) => new Float32Array(n));
    (this as { y: Float32Array }).y = copy(this.y, (n) => new Float32Array(n));
    (this as { angle: Float32Array }).angle = copy(this.angle, (n) => new Float32Array(n));
    (this as { speed: Float32Array }).speed = copy(this.speed, (n) => new Float32Array(n));
    (this as { turnRate: Float32Array }).turnRate = copy(this.turnRate, (n) => new Float32Array(n));
    (this as { goalX: Float32Array }).goalX = copy(this.goalX, (n) => new Float32Array(n));
    (this as { goalY: Float32Array }).goalY = copy(this.goalY, (n) => new Float32Array(n));
    (this as { state: Uint8Array }).state = copy(this.state, (n) => new Uint8Array(n));
    (this as { selected: Uint8Array }).selected = copy(this.selected, (n) => new Uint8Array(n));
    const nextQueueMax = new Uint16Array(next);
    nextQueueMax.set(this.queueMax);
    (this as { queueMax: Uint16Array }).queueMax = nextQueueMax;
    (this as { battery: Float32Array }).battery = copy(this.battery, (n) => new Float32Array(n));
    const nextCharging = new Uint8Array(next);
    nextCharging.set(this.charging);
    (this as { charging: Uint8Array }).charging = nextCharging;
    const nextTrickle = new Uint8Array(next);
    nextTrickle.set(this.onTrickle);
    (this as { onTrickle: Uint8Array }).onTrickle = nextTrickle;
    (this as { chargedThisFrame: Float32Array }).chargedThisFrame =
      copy(this.chargedThisFrame, (n) => new Float32Array(n));
    (this as { stallTime: Float32Array }).stallTime = copy(this.stallTime, (n) => new Float32Array(n));
    (this as { lastGap: Float32Array }).lastGap = copy(this.lastGap, (n) => new Float32Array(n));
    (this as { velocity: Float32Array }).velocity = copy(this.velocity, (n) => new Float32Array(n));
    (this as { phase: Float32Array }).phase = copy(this.phase, (n) => new Float32Array(n));
    (this as { odometer: Float32Array }).odometer = copy(this.odometer, (n) => new Float32Array(n));
    (this as { task: Uint8Array }).task = copy(this.task, (n) => new Uint8Array(n));
    (this as { taskPhase: Uint8Array }).taskPhase = copy(this.taskPhase, (n) => new Uint8Array(n));
    (this as { phaseTime: Float32Array }).phaseTime = copy(this.phaseTime, (n) => new Float32Array(n));
    (this as { armExtend: Float32Array }).armExtend = copy(this.armExtend, (n) => new Float32Array(n));
    (this as { grabReach: Float32Array }).grabReach = copy(this.grabReach, (n) => new Float32Array(n));
    (this as { approachX: Float32Array }).approachX = copy(this.approachX, (n) => new Float32Array(n));
    (this as { approachY: Float32Array }).approachY = copy(this.approachY, (n) => new Float32Array(n));
    (this as { liftT: Float32Array }).liftT = copy(this.liftT, (n) => new Float32Array(n));
    (this as { liftFromX: Float32Array }).liftFromX = copy(this.liftFromX, (n) => new Float32Array(n));
    (this as { liftFromY: Float32Array }).liftFromY = copy(this.liftFromY, (n) => new Float32Array(n));
    const growInt8 = (src: Int8Array): Int8Array => {
      const dst = new Int8Array(next);
      dst.set(src);
      return dst;
    };
    (this as { carryMaterial: Int8Array }).carryMaterial = growInt8(this.carryMaterial);
    (this as { carryShape: Int8Array }).carryShape = growInt8(this.carryShape);
    const nextHauler = new Uint16Array(next);
    nextHauler.set(this.hauler);
    (this as { hauler: Uint16Array }).hauler = nextHauler;
    (this as { placeX: Float32Array }).placeX = copy(this.placeX, (n) => new Float32Array(n));
    (this as { placeY: Float32Array }).placeY = copy(this.placeY, (n) => new Float32Array(n));
    const nextSlot = new Int32Array(next);
    nextSlot.set(this.placeSlot);
    (this as { placeSlot: Int32Array }).placeSlot = nextSlot;
    const nextPad = new Int32Array(next);
    nextPad.set(this.targetPad);
    (this as { targetPad: Int32Array }).targetPad = nextPad;
    const nextTarget = new Int32Array(next);
    nextTarget.set(this.targetProp);
    (this as { targetProp: Int32Array }).targetProp = nextTarget;
    this.capacity = next;
  }

  /** Charging points the fleet can draw from. Only live ones do anything. */
  setChargers(pads: ChargePad[]): void {
    this.chargers = pads;
  }

  /** Where the free trickle socket is, as a test on a machine's position. */
  setTrickle(test: ((x: number, y: number) => boolean) | null): void {
    this.trickle = test;
  }

  /** True when a robot is too flat to work. It can still crawl home. */
  isFlat(index: number): boolean {
    return this.battery[index] <= BATTERY_DEAD;
  }

  pathOf(index: number): ActivePath | undefined {
    return this.paths.get(index);
  }

  clearOrders(index: number): void {
    this.paths.delete(index);
    this.queues.delete(index);
    this.task[index] = BotTask.None;
    this.targetProp[index] = -1;
    this.placeSlot[index] = -1;
    this.targetPad[index] = -1;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    this.state[index] = BotState.Idle;
    this.goalX[index] = this.x[index];
    this.goalY[index] = this.y[index];
  }

  /** Orders waiting behind the active one. */
  queueOf(index: number): readonly QueuedOrder[] | undefined {
    return this.queues.get(index);
  }

  /**
   * True while a robot is physically committed to a grab.
   *
   * Once the arms are out the animation has to play through — driving off
   * mid-lift left the crate hanging in the air. Orders given now are queued
   * instead of replacing what it is doing.
   */
  isBusy(index: number): boolean {
    const t = this.task[index];
    if (t !== BotTask.Fetch && t !== BotTask.Deliver && t !== BotTask.Charge) return false;
    return this.taskPhase[index] !== Phase.Driving;
  }

  /**
   * Closes out a grab that a new order has cut short.
   *
   * Without this, an order given between the arms closing and the lift
   * finishing left `liftT` part-way: the crate is on the robot's books but the
   * renderer still draws it back at the spot it was picked up from.
   */
  private settleGrab(index: number): void {
    if (this.taskPhase[index] === Phase.Driving) return;
    this.liftT[index] = 1;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
  }

  /** Throws away pending orders without disturbing the active one. */
  clearQueue(index: number): void {
    this.queues.delete(index);
  }

  /** What the queue will do next, or -1 when there is nothing behind this. */
  private nextQueuedKind(index: number): OrderKindValue | -1 {
    const queue = this.queues.get(index);
    return queue && queue.length > 0 ? queue[0].kind : -1;
  }

  /** True when there is room to stack another order on this machine. */
  canQueue(index: number): boolean {
    return (this.queues.get(index)?.length ?? 0) < this.queueMax[index];
  }

  private pushOrder(index: number, order: QueuedOrder): boolean {
    let queue = this.queues.get(index);
    if (!queue) {
      queue = [];
      this.queues.set(index, queue);
    }
    if (queue.length >= this.queueMax[index]) return false;
    queue.push(order);
    return true;
  }

  /**
   * Issues a move order.
   *
   * `append` queues the destination behind whatever the robot is already doing
   * rather than replacing it, which is how shift + right click builds a route.
   * Returns false if nothing walkable was reachable.
   */
  orderMove(index: number, tx: number, ty: number, nav: NavGrid, append = false): boolean {
    const target = this.parkable(nav.nearestFree(tx, ty), nav);
    if (!target) return false;

    if (append && (this.state[index] === BotState.Moving || this.isBusy(index))) {
      return this.pushOrder(index, { kind: OrderKind.Move, x: target.x, y: target.y });
    }

    if (!append) {
      this.queues.delete(index);
      this.settleGrab(index);
      this.task[index] = BotTask.Move;
      this.targetProp[index] = -1;
    }
    return this.driveTo(index, target.x, target.y, nav);
  }

  /**
   * Moves a destination out of the band around cargo where a robot can stand by
   * the nav grid's reckoning but gets pushed out by its own hull.
   *
   * Only destinations matter: passing through the band is fine, because a shove
   * across the line of travel is what the separation pass is for. Stopping in
   * it is what deadlocks.
   */
  private parkable(
    target: { x: number; y: number } | null, nav: NavGrid,
  ): { x: number; y: number } | null {
    if (!target) return null;
    let { x, y } = target;
    for (const prop of this.props) {
      const need = prop.radius + BOT_HALF_LENGTH + 12;
      let dx = x - prop.x;
      let dy = y - prop.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= need) continue;
      if (dist < 1) {
        dx = 1;
        dy = 0;
      } else {
        dx /= dist;
        dy /= dist;
      }
      x = prop.x + dx * need;
      y = prop.y + dy * need;
    }
    if (x === target.x && y === target.y) return target;
    return nav.nearestFree(x, y) ?? target;
  }

  /** Plans and starts a path. Does not touch the queue. */
  private driveTo(index: number, tx: number, ty: number, nav: NavGrid): boolean {
    const path = nav.findPath(this.x[index], this.y[index], tx, ty);
    if (!path || path.length < 4) {
      this.paths.delete(index);
      this.state[index] = BotState.Idle;
      this.goalX[index] = this.x[index];
      this.goalY[index] = this.y[index];
      return false;
    }
    this.paths.set(index, { points: path, cursor: 2 });
    this.goalX[index] = tx;
    this.goalY[index] = ty;
    this.state[index] = BotState.Moving;
    return true;
  }

  /**
   * Starts the next queued order, if there is one.
   *
   * Orders that can no longer be carried out — a crate someone else took, a
   * delivery with nowhere to go — are dropped and the next one is tried, so one
   * stale entry does not stall the whole queue.
   */
  private advanceQueue(index: number, nav: NavGrid): boolean {
    const queue = this.queues.get(index);
    if (!queue) return false;

    while (queue.length > 0) {
      const order = queue.shift() as QueuedOrder;
      if (queue.length === 0) this.queues.delete(index);

      if (order.kind === OrderKind.Fetch && order.prop) {
        const idx = this.props.indexOf(order.prop);
        if (idx >= 0 && this.startFetch(index, idx, order.prop, nav)) return true;
        continue;
      }
      if (order.kind === OrderKind.Charge && order.pad) {
        const idx = this.chargers.indexOf(order.pad);
        if (idx >= 0 && this.startCharge(index, order.pad, idx, nav)) return true;
        continue;
      }
      if (order.kind === OrderKind.Deliver) {
        const drop = this.onResolveDrop?.(index);
        if (drop && this.startDeliver(index, drop.slot, drop.x, drop.y, nav)) return true;
        continue;
      }
      this.task[index] = BotTask.Move;
      this.targetProp[index] = -1;
      if (this.driveTo(index, order.x, order.y, nav)) return true;
    }
    this.queues.delete(index);
    return false;
  }

  /**
   * Sends a robot to collect a crate.
   *
   * It drives to a standoff point on the side the crate is already nearest to,
   * then turns so its TAIL faces the load — the deck and the arms are both at
   * the back, so it has to reverse up to the crate the way a real loader would.
   */
  orderFetch(
    index: number, propIndex: number, prop: Prop, nav: NavGrid, append = false,
  ): boolean {
    // The rating is fixed, so it can be judged now. Whether the deck is free
    // cannot be — a queued fetch runs after whatever unloads it.
    if (!canLift(this.hauler[index], prop.material, prop.shape)) return false;
    if (append && (this.state[index] === BotState.Moving || this.isBusy(index))) {
      return this.pushOrder(index, { kind: OrderKind.Fetch, x: prop.x, y: prop.y, prop });
    }
    this.queues.delete(index);
    this.settleGrab(index);
    return this.startFetch(index, propIndex, prop, nav);
  }

  /** Begins a fetch immediately. Does not touch the queue. */
  private startFetch(index: number, propIndex: number, prop: Prop, nav: NavGrid): boolean {
    if (!canLift(this.hauler[index], prop.material, prop.shape)) return false;
    // Flat machines can crawl about but have nothing left to work the arms.
    if (this.isFlat(index)) return false;
    if (this.carryMaterial[index] >= 0) return false;
    // Approach from whichever side the robot is already on — but SNAPPED to
    // the nearest of the crate's four faces. Coming in on an arbitrary bearing
    // leaves the crate sitting skewed on the deck however carefully the robot
    // lines up, because there is no square face to line up against.
    const raw = Math.atan2(this.y[index] - prop.y, this.x[index] - prop.x);
    const quarter = Math.PI / 2;
    const facing = prop.angle + Math.round((raw - prop.angle) / quarter) * quarter;
    const ax = Math.cos(facing);
    const ay = Math.sin(facing);

    // How far the crate reaches along that face's normal.
    const alongCrateX = Math.abs(Math.cos(facing - prop.angle)) > 0.5;
    const reach = (alongCrateX ? prop.w : prop.h) * 0.5;
    const standoff = BOT_HALF_LENGTH + reach + GRAB_GAP;
    let target = nav.nearestFree(prop.x + ax * standoff, prop.y + ay * standoff);
    if (!target) {
      // Try a few other bearings before giving up on it.
      for (let k = 1; k < 8 && !target; k++) {
        const a = (k * Math.PI) / 4;
        const bx = ax * Math.cos(a) - ay * Math.sin(a);
        const by = ax * Math.sin(a) + ay * Math.cos(a);
        target = nav.nearestFree(prop.x + bx * standoff, prop.y + by * standoff);
      }
    }
    if (!target) return false;

    if (!this.driveTo(index, target.x, target.y, nav)) return false;
    // Fixed at order time. Recomputing from the robot's live position each
    // frame lets it drift as the robot shuffles.
    this.approachX[index] = ax;
    this.approachY[index] = ay;
    this.grabReach[index] = reach;
    this.task[index] = BotTask.Fetch;
    this.targetProp[index] = propIndex;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    return true;
  }

  /**
   * Sends a robot to set its load down at a point, squared up to it.
   *
   * Delivery always approaches from the south with the nose pointing out, since
   * a trailer is loaded from its open end and the deck is at the robot's back.
   */
  orderDeliver(
    index: number, slot: number, x: number, y: number, nav: NavGrid, append = false,
  ): boolean {
    if (append && (this.state[index] === BotState.Moving || this.isBusy(index))) {
      // No slot is recorded: which one is free depends on what gets loaded
      // between now and then, so it is resolved when the order comes up.
      return this.pushOrder(index, { kind: OrderKind.Deliver, x, y });
    }
    this.queues.delete(index);
    this.settleGrab(index);
    return this.startDeliver(index, slot, x, y, nav);
  }

  /**
   * Sends a robot to a charging point, squared up on the way in.
   *
   * It drives to a standoff west of the pad and then runs the same align phase
   * a grab uses, so it enters the bay straight instead of drifting to the
   * middle from wherever it happened to stop.
   */
  orderCharge(index: number, pad: ChargePad, padIndex: number, nav: NavGrid, append = false): boolean {
    if (append && (this.state[index] === BotState.Moving || this.isBusy(index))) {
      return this.pushOrder(index, { kind: OrderKind.Charge, x: pad.x, y: pad.y, pad });
    }
    this.queues.delete(index);
    this.settleGrab(index);
    return this.startCharge(index, pad, padIndex, nav);
  }

  /** Begins a docking run immediately. Does not touch the queue. */
  private startCharge(
    index: number, pad: ChargePad, padIndex: number, nav: NavGrid,
  ): boolean {
    if (!pad.unlocked) return false;
    // Approach from the hall side and stop short of the bay.
    const target = nav.nearestFree(pad.x - DOCK_APPROACH, pad.y);
    if (!target) return false;
    if (!this.driveTo(index, target.x, target.y, nav)) return false;
    this.approachX[index] = -1;
    this.approachY[index] = 0;
    this.placeX[index] = pad.x;
    this.placeY[index] = pad.y;
    this.targetPad[index] = padIndex;
    this.task[index] = BotTask.Charge;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    return true;
  }

  /** Begins a delivery immediately. Does not touch the queue. */
  private startDeliver(
    index: number, slot: number, x: number, y: number, nav: NavGrid,
  ): boolean {
    if (this.carryMaterial[index] < 0) return false;
    const standoff = BOT_HALF_LENGTH + CRATE_UNIT * 0.5 + GRAB_GAP;
    const target = nav.nearestFree(x, y + standoff);
    if (!target) return false;
    if (!this.driveTo(index, target.x, target.y, nav)) return false;
    this.approachX[index] = 0;
    this.approachY[index] = 1;
    this.grabReach[index] = CRATE_UNIT * 0.5;
    this.placeX[index] = x;
    this.placeY[index] = y;
    this.placeSlot[index] = slot;
    this.task[index] = BotTask.Deliver;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    return true;
  }

  selectedIndices(out: number[] = []): number[] {
    out.length = 0;
    for (let i = 0; i < this.count; i++) if (this.selected[i]) out.push(i);
    return out;
  }

  clearSelection(): void {
    this.selected.fill(0, 0, this.count);
  }

  selectedCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.selected[i]) n++;
    return n;
  }

  /** Nearest robot to a point within a radius, for click-select. */
  pick(x: number, y: number, radius: number): number {
    let best = -1;
    let bestDist = radius * radius;
    for (let i = 0; i < this.count; i++) {
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  selectInRect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    if (!additive) this.clearSelection();
    for (let i = 0; i < this.count; i++) {
      if (this.x[i] >= x0 && this.x[i] <= x1 && this.y[i] >= y0 && this.y[i] <= y1) {
        this.selected[i] = 1;
      }
    }
  }

  // ------------------------------------------------------------ simulation

  /**
   * Cargo the robots have to avoid. Rebuilt only when the world's crates
   * change, since a per-frame scan over every crate for every robot would not
   * survive a large fleet.
   */
  setProps(props: readonly Prop[]): void {
    this.props = props;
    this.propBuckets.clear();
    for (let i = 0; i < props.length; i++) {
      const key = this.propKey(props[i].x, props[i].y);
      let bucket = this.propBuckets.get(key);
      if (!bucket) {
        bucket = [];
        this.propBuckets.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private propKey(x: number, y: number): number {
    return (Math.floor(x / this.hashCell) << 16) ^ (Math.floor(y / this.hashCell) & 0xffff);
  }

  update(
    dt: number, nav: NavGrid, drainEnabled: boolean,
    onPropTaken?: (propIndex: number) => void,
  ): void {
    for (let i = 0; i < this.count; i++) this.steer(i, dt, nav);
    for (let i = 0; i < this.count; i++) this.advanceTask(i, dt, nav, onPropTaken);
    this.resolveCollisions(nav);
    this.resolvePropOverlap(nav);
    this.updatePower(dt, drainEnabled);
  }

  /**
   * Drains and refills batteries.
   *
   * Charging is positional: park on a commissioned point and it fills. There is
   * no docking sequence and nothing to click, because a machine that plugs
   * itself in when it is stood in the right place needs no explaining.
   */
  private updatePower(dt: number, drainEnabled: boolean): void {
    for (const pad of this.chargers) pad.drawing = false;
    this.chargedThisFrame.fill(0, 0, this.count);
    this.onTrickle.fill(0, 0, this.count);

    for (let i = 0; i < this.count; i++) {
      let point: ChargePad | undefined;
      for (const pad of this.chargers) {
        if (!pad.unlocked) continue;
        if (Math.abs(this.x[i] - pad.x) > CHARGE_PAD_W * 0.5) continue;
        if (Math.abs(this.y[i] - pad.y) > CHARGE_PAD_H * 0.5) continue;
        point = pad;
        break;
      }
      if (point && !this.charging[i]) this.onSound?.('charge');
      this.charging[i] = point ? 1 : 0;

      if (point) {
        // Nothing flows until the coupler has actually reached the machine.
        point.drawing = this.battery[i] < 1;
        this.onTrickle[i] = 0;
        if (point.arm > 0.94) {
          const before = this.battery[i];
          this.battery[i] = Math.min(1, this.battery[i] + CHARGE_RATE * dt);
          this.chargedThisFrame[i] = this.battery[i] - before;
        }
        // A machine that wandered onto a pad without being sent tidies itself
        // square anyway, so a bay never holds something sitting crooked.
        const working =
          this.task[i] === BotTask.Fetch ||
          this.task[i] === BotTask.Deliver ||
          this.task[i] === BotTask.Charge;
        if (this.state[i] !== BotState.Moving && !working) {
          const ease = Math.min(1, dt * 2.6);
          this.x[i] += (point.x - this.x[i]) * ease;
          this.y[i] += (point.y - this.y[i]) * ease;
          this.angle[i] += angleDelta(this.angle[i], DOCK_FACING) * ease;
        }
        continue;
      }
      // The trickle socket: a fixture, not a purchase, and never billed. It is
      // slow enough that living off it costs most of a shift, which is what
      // makes the first commissioned point worth buying without anyone having
      // to say so — and it is why a flat battery is never a dead end.
      if (this.trickle && this.trickle(this.x[i], this.y[i])) {
        this.onTrickle[i] = 1;
        this.charging[i] = 1;
        this.battery[i] = Math.min(1, this.battery[i] + CHARGE_RATE * TRICKLE_RATE * dt);
        continue;
      }
      // Drain off means DRAIN OFF, not a free top-up. The upgrade room uses
      // this to stop the clock on a machine standing in it, and a room that
      // quietly refilled everything would make the whole battery pointless.
      if (!drainEnabled) continue;
      const moving = this.velocity[i] > 8;
      let drain = DRAIN_IDLE;
      if (moving) {
        const laden = this.carryMaterial[i] >= 0 ? LADEN_MULTIPLIER : 1;
        drain = DRAIN_DRIVING * (this.velocity[i] / this.speed[i]) * laden;
      }
      this.battery[i] = Math.max(0, this.battery[i] - drain * dt);
    }

    // Couplers reach out to whatever is drawing and stow again when it is done.
    for (const pad of this.chargers) {
      const rate = dt / (pad.drawing ? ARM_EXTEND_TIME : ARM_STOW_TIME);
      pad.arm = pad.drawing
        ? Math.min(1, pad.arm + rate)
        : Math.max(0, pad.arm - rate);
    }
  }

  /**
   * Runs the fetch sequence once the drive is finished: turn tail-on, reach the
   * arms out, close on the crate, then stow it on the deck.
   */
  private advanceTask(
    i: number,
    dt: number,
    nav: NavGrid,
    onPropTaken?: (propIndex: number) => void,
  ): void {
    const isFetch = this.task[i] === BotTask.Fetch;
    const isDeliver = this.task[i] === BotTask.Deliver;
    const isDock = this.task[i] === BotTask.Charge;
    if (isDock) {
      this.advanceDock(i, dt, nav);
      return;
    }
    if (!isFetch && !isDeliver) {
      // Arms drift back to stowed whenever nothing is being collected.
      if (this.armExtend[i] > 0) {
        this.armExtend[i] = Math.max(0, this.armExtend[i] - dt / STOW_TIME);
      }
      return;
    }

    // Fetching works towards a crate on the floor; delivering works towards a
    // point the robot was told to set its load down on.
    //
    // Once the crate has been taken it is no longer IN the level, and its old
    // index now belongs to whichever crate shifted down into the gap. Looking
    // it up past that point marked the wrong crate on screen and, if it was the
    // last one in the list, aborted the lift outright.
    const taken = isFetch && this.carryMaterial[i] >= 0;
    const prop = isFetch && !taken ? this.props[this.targetProp[i]] : undefined;
    if (isFetch && !taken && !prop) {
      this.clearOrders(i);
      return;
    }
    const anchorX = isFetch ? (taken ? this.liftFromX[i] : (prop as Prop).x) : this.placeX[i];
    const anchorY = isFetch ? (taken ? this.liftFromY[i] : (prop as Prop).y) : this.placeY[i];

    // Still driving: wait for the path to finish, arms tucked in.
    if (this.taskPhase[i] === Phase.Driving) {
      if (this.armExtend[i] > 0) {
        this.armExtend[i] = Math.max(0, this.armExtend[i] - dt / STOW_TIME);
      }
      if (this.state[i] === BotState.Moving) return;
      this.taskPhase[i] = Phase.Aligning;
      this.phaseTime[i] = 0;
      return;
    }

    this.phaseTime[i] += dt;

    if (this.taskPhase[i] === Phase.Aligning) {
      // Square up ON the crate: slide onto the approach line at the right
      // standoff and point the NOSE away from the load, since the deck and the
      // arms are both at the back. Turning on the spot without correcting
      // position leaves the crate off-centre and the grab looks wrong.
      const ax = this.approachX[i];
      const ay = this.approachY[i];
      const standoff = BOT_HALF_LENGTH + this.grabReach[i] + GRAB_GAP;
      const parkX = anchorX + ax * standoff;
      const parkY = anchorY + ay * standoff;

      const ease = Math.min(1, dt * 4.5);
      this.x[i] += (parkX - this.x[i]) * ease;
      this.y[i] += (parkY - this.y[i]) * ease;

      const want = Math.atan2(ay, ax);
      const delta = angleDelta(this.angle[i], want);
      this.angle[i] += clamp(delta, -this.turnRate[i] * dt, this.turnRate[i] * dt);

      const offset = Math.hypot(parkX - this.x[i], parkY - this.y[i]);
      const squared = Math.abs(delta) < ALIGN_ANGLE && offset < ALIGN_DISTANCE;
      if (squared || this.phaseTime[i] > 5) {
        this.x[i] = parkX;
        this.y[i] = parkY;
        this.angle[i] = want;
        this.taskPhase[i] = Phase.Reaching;
        this.phaseTime[i] = 0;
      }
      return;
    }

    if (this.taskPhase[i] === Phase.Reaching) {
      this.armExtend[i] = Math.min(1, this.phaseTime[i] / REACH_TIME);
      if (this.phaseTime[i] >= REACH_TIME) {
        this.taskPhase[i] = Phase.Closing;
        this.phaseTime[i] = 0;
      }
      return;
    }

    if (this.taskPhase[i] === Phase.Closing) {
      this.armExtend[i] = 1;
      if (this.phaseTime[i] >= CLOSE_TIME) {
        if (isFetch) {
          // The crate leaves the world here, but it does not appear on the deck
          // yet: the renderer carries it up from where it was standing over the
          // lift, so it rises rather than teleporting.
          const p = prop as Prop;
          this.carryMaterial[i] = p.material;
          this.carryShape[i] = p.shape;
          this.liftFromX[i] = p.x;
          this.liftFromY[i] = p.y;
          this.liftT[i] = 0;
          this.battery[i] = Math.max(0, this.battery[i] - DRAIN_PER_LIFT);
          const removed = this.targetProp[i];
          this.targetProp[i] = -1;
          onPropTaken?.(removed);
        } else {
          this.battery[i] = Math.max(0, this.battery[i] - DRAIN_PER_PLACE);
          // Setting down runs the same travel in reverse: the crate leaves the
          // deck and descends to the mark.
          this.liftFromX[i] = anchorX;
          this.liftFromY[i] = anchorY;
          this.liftT[i] = 1;
        }
        this.onSound?.(isFetch ? 'grab' : 'place');
        this.taskPhase[i] = Phase.Lifting;
        this.phaseTime[i] = 0;
      }
      return;
    }

    // The crate travels between the floor and the deck while the arms draw
    // back in with it. Fetching runs 0 -> 1, delivering 1 -> 0.
    const travel = Math.min(1, this.phaseTime[i] / LIFT_TIME);
    this.liftT[i] = isFetch ? travel : 1 - travel;
    this.armExtend[i] = Math.max(0, 1 - travel);
    if (travel >= 1) {
      this.armExtend[i] = 0;
      if (isDeliver) {
        this.onDelivered?.(i, this.placeSlot[i], this.carryMaterial[i], this.carryShape[i]);
        this.carryMaterial[i] = -1;
        this.placeSlot[i] = -1;
        this.liftT[i] = 1;
      }
      this.task[i] = BotTask.None;
      this.targetProp[i] = -1;
      this.taskPhase[i] = Phase.Driving;
      this.advanceQueue(i, nav);
    }
  }

  /**
   * Drives onto a charging point and squares up on it.
   *
   * Deliberately the same two-stage shape as a grab — arrive, then align — so a
   * machine entering a bay behaves the way a machine collecting a crate does.
   */
  private advanceDock(i: number, dt: number, nav: NavGrid): void {
    if (this.armExtend[i] > 0) {
      this.armExtend[i] = Math.max(0, this.armExtend[i] - dt / STOW_TIME);
    }
    if (this.taskPhase[i] === Phase.Driving) {
      if (this.state[i] === BotState.Moving) return;
      this.taskPhase[i] = Phase.Aligning;
      this.phaseTime[i] = 0;
      return;
    }

    this.phaseTime[i] += dt;

    if (this.taskPhase[i] === Phase.Aligning) {
      // Square up in FRONT of the bay, nose pointing back out of it.
      const parkX = this.placeX[i] - DOCK_APPROACH;
      const parkY = this.placeY[i];
      const ease = Math.min(1, dt * 3.4);
      this.x[i] += (parkX - this.x[i]) * ease;
      this.y[i] += (parkY - this.y[i]) * ease;
      const delta = angleDelta(this.angle[i], DOCK_FACING);
      this.angle[i] += clamp(delta, -this.turnRate[i] * dt, this.turnRate[i] * dt);

      const offset = Math.hypot(parkX - this.x[i], parkY - this.y[i]);
      if ((Math.abs(delta) < ALIGN_ANGLE && offset < ALIGN_DISTANCE) || this.phaseTime[i] > 5) {
        this.x[i] = parkX;
        this.y[i] = parkY;
        this.angle[i] = DOCK_FACING;
        this.taskPhase[i] = Phase.Backing;
        this.phaseTime[i] = 0;
      }
      return;
    }

    // Reversing in. Straight back along the hull, tracks running the other way,
    // with any lateral error eased out on the way.
    const backX = -Math.cos(this.angle[i]);
    const backY = -Math.sin(this.angle[i]);
    const remaining =
      (this.placeX[i] - this.x[i]) * backX + (this.placeY[i] - this.y[i]) * backY;
    const step = Math.min(DOCK_REVERSE_SPEED * dt, Math.max(0, remaining));
    this.x[i] += backX * step;
    this.y[i] += backY * step;
    // Negative, so the track frames run backwards while it reverses.
    this.odometer[i] -= step;
    const lateral = Math.min(1, dt * 3);
    this.x[i] += (this.placeX[i] - this.x[i]) * lateral * Math.abs(backY);
    this.y[i] += (this.placeY[i] - this.y[i]) * lateral * Math.abs(backX);
    this.velocity[i] = DOCK_REVERSE_SPEED * 0.35;

    if (remaining <= 1 || this.phaseTime[i] > 8) {
      this.x[i] = this.placeX[i];
      this.y[i] = this.placeY[i];
      this.angle[i] = DOCK_FACING;
      this.velocity[i] = 0;
      this.task[i] = BotTask.None;
      this.targetPad[i] = -1;
      this.taskPhase[i] = Phase.Driving;
      this.advanceQueue(i, nav);
    }
  }

  /**
   * Pushes robots out of cargo using the real hull rectangle rather than a
   * circle. The nav grid only reasons about the robot's centre, so a machine
   * turning on the spot beside a crate could otherwise sweep its nose straight
   * through it.
   */
  private resolvePropOverlap(nav: NavGrid): void {
    if (this.props.length === 0) return;
    const hx = BOT_LENGTH / 2;
    const hy = BOT_WIDTH / 2;

    for (let i = 0; i < this.count; i++) {
      // The crate a robot is working on never pushes it around — not just once
      // the arms are out, but for the whole task.
      //
      // The nav grid clears cargo using the robot's circular radius (84) while
      // this resolver pushes using the full hull (half-length 120). Anything
      // parked in that 36 cm band is somewhere nav calls walkable and this call
      // shoves it out of, and the robot oscillates there forever. An approach
      // standoff lands squarely in that band, which is exactly how a fetch
      // could hang on one particular crate and not its neighbours.
      const grabbing =
        this.task[i] === BotTask.Fetch || this.task[i] === BotTask.Deliver;
      const cx = Math.floor(this.x[i] / this.hashCell);
      const cy = Math.floor(this.y[i] / this.hashCell);
      const cos = Math.cos(-this.angle[i]);
      const sin = Math.sin(-this.angle[i]);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = this.propBuckets.get(
            ((cx + ox) << 16) ^ ((cy + oy) & 0xffff),
          );
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const prop = this.props[bucket[k]];
            if (grabbing && bucket[k] === this.targetProp[i]) continue;
            // Cargo on a deck is not something to be shoved away from.
            if (prop.onBoat) continue;

            // Closest point on the hull rectangle, in the robot's own frame.
            const dx = prop.x - this.x[i];
            const dy = prop.y - this.y[i];
            const lx = dx * cos - dy * sin;
            const ly = dx * sin + dy * cos;
            const nx = clamp(lx, -hx, hx);
            const ny = clamp(ly, -hy, hy);
            let sx = lx - nx;
            let sy = ly - ny;
            let dist = Math.hypot(sx, sy);

            if (dist >= prop.radius) continue;
            if (dist < 0.001) {
              // Centre is inside the hull: leave along the shallowest face.
              const toX = hx - Math.abs(lx);
              const toY = hy - Math.abs(ly);
              if (toX < toY) {
                sx = lx >= 0 ? 1 : -1;
                sy = 0;
              } else {
                sx = 0;
                sy = ly >= 0 ? 1 : -1;
              }
              dist = 0.001;
            }
            const push = (prop.radius - dist) / dist;
            // Back into world space and move the robot away from the crate.
            const wx = (sx * cos + sy * sin) * push;
            const wy = (-sx * sin + sy * cos) * push;
            const tx = this.x[i] - wx;
            const ty = this.y[i] - wy;
            if (!nav.isBlockedWorld(tx, ty)) {
              this.x[i] = tx;
              this.y[i] = ty;
            }
          }
        }
      }
    }
  }

  private steer(i: number, dt: number, nav: NavGrid): void {
    const path = this.paths.get(i);
    if (!path) {
      this.velocity[i] += (0 - this.velocity[i]) * Math.min(1, dt * 6);
      return;
    }

    const pts = path.points;
    let wx = pts[path.cursor];
    let wy = pts[path.cursor + 1];
    const isLast = path.cursor >= pts.length - 2;
    // A leg with another plain move stacked behind it is not really an arrival:
    // braking to a halt at every queued waypoint made a long route feel jerky.
    // Anything that ends in a grab still has to stop dead and square up.
    const rolling = isLast && this.nextQueuedKind(i) === OrderKind.Move;

    // Advance through waypoints we have effectively reached. Intermediate ones
    // get a generous radius so corners are rounded rather than pivoted on.
    const arrive = isLast ? (rolling ? 70 : 14) : 90;
    let dx = wx - this.x[i];
    let dy = wy - this.y[i];
    let dist = Math.hypot(dx, dy);

    while (dist < arrive && !isLast) {
      path.cursor += 2;
      if (path.cursor >= pts.length) break;
      wx = pts[path.cursor];
      wy = pts[path.cursor + 1];
      dx = wx - this.x[i];
      dy = wy - this.y[i];
      dist = Math.hypot(dx, dy);
      if (path.cursor >= pts.length - 2) break;
    }

    if (path.cursor >= pts.length - 2 && dist < arrive) {
      this.paths.delete(i);
      // Rolling handovers keep their momentum; everything else stops.
      if (!rolling) this.velocity[i] = 0;
      // A fetch or a delivery still has its grab to play out. The queue waits
      // for that; taking the next order here abandoned the crate on arrival.
      this.state[i] = BotState.Idle;
      if (
        this.task[i] === BotTask.Fetch ||
        this.task[i] === BotTask.Deliver ||
        this.task[i] === BotTask.Charge
      ) {
        return;
      }
      // Otherwise roll straight on to whatever was stacked behind this. A move
      // that finishes with nothing behind it is over — leaving the task set to
      // Move made a parked robot look permanently mid-order.
      if (!this.advanceQueue(i, nav)) this.task[i] = BotTask.None;
      return;
    }

    // Nothing should sit grinding against an obstacle indefinitely. If the gap
    // to the waypoint stops shrinking, give the order up rather than burn a
    // robot on it forever.
    if (dist < this.lastGap[i] - 0.5) {
      this.stallTime[i] = 0;
    } else {
      this.stallTime[i] += dt;
      if (this.stallTime[i] > STALL_LIMIT) {
        this.stallTime[i] = 0;
        this.paths.delete(i);
        this.velocity[i] = 0;
        this.state[i] = BotState.Idle;
        if (this.task[i] === BotTask.Fetch || this.task[i] === BotTask.Deliver) {
          // Close enough to work with: let the align phase finish the job.
          this.taskPhase[i] = Phase.Aligning;
          this.phaseTime[i] = 0;
        } else if (!this.advanceQueue(i, nav)) {
          this.clearOrders(i);
        }
        return;
      }
    }
    this.lastGap[i] = dist;

    const desired = Math.atan2(dy, dx);
    const delta = angleDelta(this.angle[i], desired);
    const turn = clamp(delta, -this.turnRate[i] * dt, this.turnRate[i] * dt);
    this.angle[i] += turn;

    // Slow into turns, and brake into the final waypoint on a real curve so a
    // short move is still driven briskly rather than crept.
    const alignment = Math.max(0, 1 - Math.abs(delta) / 1.9);
    const brake = isLast && !rolling
      ? Math.sqrt(2 * DECEL * Math.max(0, dist - 6))
      : Infinity;
    const rated = this.isFlat(i) ? this.speed[i] * DEAD_SPEED : this.speed[i];
    const target = Math.min(rated * alignment, brake);
    this.velocity[i] += (target - this.velocity[i]) * Math.min(1, dt * ACCEL_RESPONSE);

    const step = this.velocity[i] * dt;
    this.odometer[i] += step;
    const nx = this.x[i] + Math.cos(this.angle[i]) * step;
    const ny = this.y[i] + Math.sin(this.angle[i]) * step;

    // Slide along obstacles rather than sticking to them.
    if (!nav.isBlockedWorld(nx, ny)) {
      this.x[i] = nx;
      this.y[i] = ny;
    } else if (!nav.isBlockedWorld(nx, this.y[i])) {
      this.x[i] = nx;
    } else if (!nav.isBlockedWorld(this.x[i], ny)) {
      this.y[i] = ny;
    } else {
      // Wedged against something. Nudge out to the nearest walkable point
      // first: re-planning alone just produces the same blocked first step
      // again next frame, and the robot sits there at full throttle going
      // nowhere.
      const free = nav.nearestFree(this.x[i], this.y[i]);
      if (free) {
        this.x[i] = free.x;
        this.y[i] = free.y;
      }
      if (!this.driveTo(i, this.goalX[i], this.goalY[i], nav)) {
        if (!this.advanceQueue(i, nav)) this.clearOrders(i);
      }
    }
  }

  /**
   * Positional separation through a spatial hash. Robots push each other apart
   * instead of overlapping; it is not a rigid-body solver, but at these speeds
   * and densities it reads correctly and costs almost nothing.
   */
  private resolveCollisions(nav: NavGrid): void {
    if (this.count < 2) return;
    const cell = this.hashCell;
    this.buckets.clear();

    for (let i = 0; i < this.count; i++) {
      const key = (Math.floor(this.x[i] / cell) << 16) ^ (Math.floor(this.y[i] / cell) & 0xffff);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(i);
    }

    const minDist = BOT_RADIUS * 2;
    const minDistSq = minDist * minDist;

    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(this.x[i] / cell);
      const cy = Math.floor(this.y[i] / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = this.buckets.get(((cx + ox) << 16) ^ ((cy + oy) & 0xffff));
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k];
            if (j <= i) continue;
            let dx = this.x[j] - this.x[i];
            let dy = this.y[j] - this.y[i];
            let dsq = dx * dx + dy * dy;
            if (dsq >= minDistSq) continue;
            if (dsq < 0.0001) {
              // Exactly coincident: nudge apart deterministically.
              dx = ((i % 7) - 3) * 0.1 + 0.01;
              dy = ((j % 5) - 2) * 0.1 + 0.01;
              dsq = dx * dx + dy * dy;
            }
            const d = Math.sqrt(dsq);
            const push = (minDist - d) * 0.5;
            const ux = (dx / d) * push;
            const uy = (dy / d) * push;

            const ix = this.x[i] - ux;
            const iy = this.y[i] - uy;
            if (!nav.isBlockedWorld(ix, iy)) {
              this.x[i] = ix;
              this.y[i] = iy;
            }
            const jx = this.x[j] + ux;
            const jy = this.y[j] + uy;
            if (!nav.isBlockedWorld(jx, jy)) {
              this.x[j] = jx;
              this.y[j] = jy;
            }
          }
        }
      }
    }
  }
}
