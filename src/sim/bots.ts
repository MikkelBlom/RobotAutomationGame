import { angleDelta, clamp, TAU } from '../core/mathUtils';
import type { NavGrid } from './navGrid';

/**
 * Ground robots.
 *
 * State lives in flat typed arrays rather than one object per robot. That is
 * the whole reason this can scale: at a hundred thousand units the cost is
 * memory traffic over a few contiguous buffers, not chasing a hundred thousand
 * pointers and feeding the garbage collector.
 */

export const BOT_LENGTH = 132;
export const BOT_WIDTH = 90;
/** Collision radius — a little tighter than the hull so they can pass closely. */
export const BOT_RADIUS = 46;

export const BotState = { Idle: 0, Moving: 1 } as const;

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
  private readonly hashCell = 72;
  private readonly buckets = new Map<number, number[]>();

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
  }

  spawn(x: number, y: number, angle = 0): number {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.angle[i] = angle;
    this.speed[i] = 118;
    this.turnRate[i] = 2.9;
    this.goalX[i] = x;
    this.goalY[i] = y;
    this.state[i] = BotState.Idle;
    this.selected[i] = 0;
    this.velocity[i] = 0;
    this.phase[i] = (i * 0.618) % 1 * TAU;
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
    this.capacity = next;
  }

  pathOf(index: number): ActivePath | undefined {
    return this.paths.get(index);
  }

  clearOrders(index: number): void {
    this.paths.delete(index);
    this.queues.delete(index);
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

    if (!append) this.queues.delete(index);
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

  update(dt: number, nav: NavGrid): void {
    for (let i = 0; i < this.count; i++) this.steer(i, dt, nav);
    this.resolveCollisions(nav);
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
    const arrive = isLast ? 6 : 30;
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

    if (path.cursor >= pts.length - 2 && dist < 6) {
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
    const approach = isLast ? Math.min(1, dist / 90) : 1;
    const target = this.speed[i] * alignment * approach;
    this.velocity[i] += (target - this.velocity[i]) * Math.min(1, dt * 5);

    const step = this.velocity[i] * dt;
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
      // Wedged. Re-plan from here; if that fails too, drop this leg and try
      // the next queued one rather than abandoning the whole route.
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
