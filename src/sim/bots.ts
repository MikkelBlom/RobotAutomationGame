import { angleDelta, clamp, TAU } from '../core/mathUtils';
import type { Prop } from './level';
import type { NavGrid } from './navGrid';

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
export const BotTask = { None: 0, Move: 1, Fetch: 2 } as const;

/** Stages of a fetch, after the drive is done. */
const Phase = { Driving: 0, Aligning: 1, Reaching: 2, Closing: 3, Lifting: 4 } as const;

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
  /** Prop variant riding on the deck, or -1 when empty. */
  readonly carrying: Int8Array;
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
  private readonly paths = new Map<number, ActivePath>();

  /**
   * Destinations queued behind the one currently being driven to, as a flat
   * [x, y, ...] list per robot. Shift + right click appends here instead of
   * replacing the order.
   */
  private readonly queues = new Map<number, number[]>();

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
    this.velocity = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.odometer = new Float32Array(capacity);
    this.task = new Uint8Array(capacity);
    this.targetProp = new Int32Array(capacity);
    this.taskPhase = new Uint8Array(capacity);
    this.phaseTime = new Float32Array(capacity);
    this.armExtend = new Float32Array(capacity);
    this.carrying = new Int8Array(capacity);
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
    this.speed[i] = 175;   // 1.65 m/s, typical for a warehouse AMR
    this.turnRate[i] = 1.8;
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
    this.carrying[i] = -1;
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
    (this as { velocity: Float32Array }).velocity = copy(this.velocity, (n) => new Float32Array(n));
    (this as { phase: Float32Array }).phase = copy(this.phase, (n) => new Float32Array(n));
    (this as { odometer: Float32Array }).odometer = copy(this.odometer, (n) => new Float32Array(n));
    (this as { task: Uint8Array }).task = copy(this.task, (n) => new Uint8Array(n));
    (this as { taskPhase: Uint8Array }).taskPhase = copy(this.taskPhase, (n) => new Uint8Array(n));
    (this as { phaseTime: Float32Array }).phaseTime = copy(this.phaseTime, (n) => new Float32Array(n));
    (this as { armExtend: Float32Array }).armExtend = copy(this.armExtend, (n) => new Float32Array(n));
    (this as { approachX: Float32Array }).approachX = copy(this.approachX, (n) => new Float32Array(n));
    (this as { approachY: Float32Array }).approachY = copy(this.approachY, (n) => new Float32Array(n));
    (this as { liftT: Float32Array }).liftT = copy(this.liftT, (n) => new Float32Array(n));
    (this as { liftFromX: Float32Array }).liftFromX = copy(this.liftFromX, (n) => new Float32Array(n));
    (this as { liftFromY: Float32Array }).liftFromY = copy(this.liftFromY, (n) => new Float32Array(n));
    const nextCarrying = new Int8Array(next);
    nextCarrying.set(this.carrying);
    (this as { carrying: Int8Array }).carrying = nextCarrying;
    const nextTarget = new Int32Array(next);
    nextTarget.set(this.targetProp);
    (this as { targetProp: Int32Array }).targetProp = nextTarget;
    this.capacity = next;
  }

  pathOf(index: number): ActivePath | undefined {
    return this.paths.get(index);
  }

  clearOrders(index: number): void {
    this.paths.delete(index);
    this.queues.delete(index);
    this.task[index] = BotTask.None;
    this.targetProp[index] = -1;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    this.state[index] = BotState.Idle;
    this.goalX[index] = this.x[index];
    this.goalY[index] = this.y[index];
  }

  /** Queued destinations behind the active one, as a flat [x, y, ...] list. */
  queueOf(index: number): readonly number[] | undefined {
    return this.queues.get(index);
  }

  /**
   * Issues a move order.
   *
   * `append` queues the destination behind whatever the robot is already doing
   * rather than replacing it, which is how shift + right click builds a route.
   * Returns false if nothing walkable was reachable.
   */
  orderMove(index: number, tx: number, ty: number, nav: NavGrid, append = false): boolean {
    const target = nav.nearestFree(tx, ty);
    if (!target) return false;

    if (append && this.state[index] === BotState.Moving) {
      let queue = this.queues.get(index);
      if (!queue) {
        queue = [];
        this.queues.set(index, queue);
      }
      queue.push(target.x, target.y);
      return true;
    }

    if (!append) {
      this.queues.delete(index);
      this.task[index] = BotTask.Move;
      this.targetProp[index] = -1;
    }
    return this.driveTo(index, target.x, target.y, nav);
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

  /** Starts the next queued destination, if there is one. */
  private advanceQueue(index: number, nav: NavGrid): boolean {
    const queue = this.queues.get(index);
    if (!queue || queue.length < 2) {
      this.queues.delete(index);
      return false;
    }
    const nx = queue.shift() as number;
    const ny = queue.shift() as number;
    if (queue.length === 0) this.queues.delete(index);
    return this.driveTo(index, nx, ny, nav);
  }

  /**
   * Sends a robot to collect a crate.
   *
   * It drives to a standoff point on the side the crate is already nearest to,
   * then turns so its TAIL faces the load — the deck and the arms are both at
   * the back, so it has to reverse up to the crate the way a real loader would.
   */
  orderFetch(index: number, propIndex: number, prop: Prop, nav: NavGrid): boolean {
    // Approach from whichever side the robot is already on, so it does not
    // drive a lap around the crate for no reason.
    let ax = this.x[index] - prop.x;
    let ay = this.y[index] - prop.y;
    const len = Math.hypot(ax, ay);
    if (len < 1) {
      ax = 1;
      ay = 0;
    } else {
      ax /= len;
      ay /= len;
    }

    const standoff = BOT_HALF_LENGTH + prop.radius + GRAB_GAP;
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

    this.queues.delete(index);
    if (!this.driveTo(index, target.x, target.y, nav)) return false;
    // Fix the bearing now. Recomputing it from the robot's live position each
    // frame lets it drift as the robot shuffles, and the crate ends up off to
    // one side of the deck.
    const bearingX = target.x - prop.x;
    const bearingY = target.y - prop.y;
    const bearing = Math.hypot(bearingX, bearingY) || 1;
    this.approachX[index] = bearingX / bearing;
    this.approachY[index] = bearingY / bearing;
    this.task[index] = BotTask.Fetch;
    this.targetProp[index] = propIndex;
    this.taskPhase[index] = Phase.Driving;
    this.phaseTime[index] = 0;
    return true;
  }

  /** Puts whatever is on the deck back on the floor, returning its variant. */
  dropCarried(index: number): number {
    const variant = this.carrying[index];
    this.carrying[index] = -1;
    return variant;
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

  update(dt: number, nav: NavGrid, onPropTaken?: (propIndex: number) => void): void {
    for (let i = 0; i < this.count; i++) this.steer(i, dt, nav);
    for (let i = 0; i < this.count; i++) this.advanceTask(i, dt, nav, onPropTaken);
    this.resolveCollisions(nav);
    this.resolvePropOverlap(nav);
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
    if (this.task[i] !== BotTask.Fetch) {
      // Arms drift back to stowed whenever nothing is being collected.
      if (this.armExtend[i] > 0) {
        this.armExtend[i] = Math.max(0, this.armExtend[i] - dt / STOW_TIME);
      }
      return;
    }

    const propIndex = this.targetProp[i];
    const prop = this.props[propIndex];
    if (!prop) {
      this.clearOrders(i);
      return;
    }

    // Still driving: wait for the path to finish.
    if (this.taskPhase[i] === Phase.Driving) {
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
      const standoff = BOT_HALF_LENGTH + prop.radius + GRAB_GAP;
      const parkX = prop.x + ax * standoff;
      const parkY = prop.y + ay * standoff;

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
        // The crate leaves the world here, but it does not appear on the deck
        // yet: the renderer carries it up from where it was standing over the
        // lift, so it rises rather than teleporting.
        this.carrying[i] = prop.variant;
        this.liftFromX[i] = prop.x;
        this.liftFromY[i] = prop.y;
        this.liftT[i] = 0;
        onPropTaken?.(propIndex);
        this.taskPhase[i] = Phase.Lifting;
        this.phaseTime[i] = 0;
      }
      return;
    }

    // Lifting: the crate comes off the floor and onto the deck while the arms
    // draw back in with it.
    this.liftT[i] = Math.min(1, this.phaseTime[i] / LIFT_TIME);
    this.armExtend[i] = Math.max(0, 1 - this.phaseTime[i] / LIFT_TIME);
    if (this.phaseTime[i] >= LIFT_TIME) {
      this.liftT[i] = 1;
      this.armExtend[i] = 0;
      this.task[i] = BotTask.None;
      this.targetProp[i] = -1;
      this.taskPhase[i] = Phase.Driving;
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
      // A robot mid-grab is deliberately tucked up against its target.
      const grabbing = this.task[i] === BotTask.Fetch && this.taskPhase[i] !== Phase.Driving;
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

    // Advance through waypoints we have effectively reached. Intermediate ones
    // get a generous radius so corners are rounded rather than pivoted on.
    const arrive = isLast ? 14 : 90;
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

    if (path.cursor >= pts.length - 2 && dist < 14) {
      this.paths.delete(i);
      this.velocity[i] = 0;
      // Roll straight on to the next queued waypoint, if the player stacked one.
      if (!this.advanceQueue(i, nav)) this.state[i] = BotState.Idle;
      return;
    }

    const desired = Math.atan2(dy, dx);
    const delta = angleDelta(this.angle[i], desired);
    const turn = clamp(delta, -this.turnRate[i] * dt, this.turnRate[i] * dt);
    this.angle[i] += turn;

    // Slow into turns, and ease to a stop at the final waypoint.
    const alignment = Math.max(0, 1 - Math.abs(delta) / 1.4);
    const approach = isLast ? Math.min(1, dist / 260) : 1;
    const target = this.speed[i] * alignment * approach;
    this.velocity[i] += (target - this.velocity[i]) * Math.min(1, dt * 5);

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
