import {
  BAY_WIDTH,
  FLOOR,
  inWater,
  TRAILER_DEPTH,
  TRAILER_WIDTH,
  WALL_THICKNESS,
  WATER_CLEARANCE,
  type Column,
  type DockBay,
  type Prop,
} from './level';

/**
 * Walkability and pathfinding for ground robots.
 *
 * The grid is an internal acceleration structure only — robots are never
 * snapped to it. Paths come out of A* as cell centres, then get string-pulled
 * back to straight lines through open space, so the movement you see is
 * free-form and diagonal, not stepped.
 */

/** 60 cm cells: fine enough for an 84 cm-radius robot without bloating A*. */
const CELL = 60;

/**
 * The grid covers the floor PLUS the strip north of the wall where trailers
 * back on, because robots have to be able to drive into a docked trailer. When
 * it covered only the slab, the trailer interiors were literally outside the
 * pathfinder and no route into a bay could ever be found.
 */
const NAV = {
  x0: FLOOR.x,
  y0: FLOOR.y - WALL_THICKNESS - TRAILER_DEPTH,
  w: FLOOR.w,
  h: FLOOR.h + WALL_THICKNESS + TRAILER_DEPTH,
} as const;

export class NavGrid {
  readonly cell = CELL;
  readonly cols: number;
  readonly rows: number;
  readonly blocked: Uint8Array;

  // Reusable A* scratch, sized once. Avoids per-request allocation.
  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly stamp: Int32Array;
  private readonly openHeap: Int32Array;
  private readonly inOpen: Uint8Array;
  private readonly botRadius: number;
  private bays: DockBay[] = [];
  private searchId = 0;
  private heapSize = 0;

  constructor(columns: Column[], props: Prop[], bays: DockBay[], botRadius: number) {
    this.cols = Math.ceil(NAV.w / CELL);
    this.rows = Math.ceil(NAV.h / CELL);
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.openHeap = new Int32Array(n + 1);
    this.inOpen = new Uint8Array(n);

    this.botRadius = botRadius;
    this.bays = bays;
    this.rasterise(columns, props, botRadius);
  }

  /** Re-rasterises after the world's obstacles change, e.g. a crate lifted. */
  rebuild(columns: Column[], props: Prop[], bays?: DockBay[]): void {
    if (bays) this.bays = bays;
    this.rasterise(columns, props, this.botRadius);
  }

  /**
   * How far into a bay a robot may drive, measured from the centreline. Taken
   * from whichever is tighter, the wall opening or the trailer body.
   */
  private bayHalfWidth(botRadius: number): number {
    return Math.min(BAY_WIDTH, TRAILER_WIDTH) / 2 - botRadius - 8;
  }

  /** True inside the drivable corridor of a bay: its mouth and its trailer. */
  private inBayCorridor(x: number, y: number, botRadius: number): boolean {
    if (y >= FLOOR.y) return false;
    const half = this.bayHalfWidth(botRadius);
    if (half <= 0) return false;
    for (const bay of this.bays) {
      if (Math.abs(x - bay.x) > half) continue;
      // Empty bays are sealed; only a docked trailer is drivable.
      const back = bay.occupied ? NAV.y0 + botRadius + 40 : FLOOR.y - WALL_THICKNESS;
      if (y >= back) return true;
    }
    return false;
  }

  private rasterise(columns: Column[], props: Prop[], botRadius: number): void {
    const edge = botRadius + 30;
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const wx = NAV.x0 + (cx + 0.5) * CELL;
        const wy = NAV.y0 + (cy + 0.5) * CELL;
        let blocked = false;

        const inBay = this.inBayCorridor(wx, wy, botRadius);

        if (wy < FLOOR.y) {
          // North of the slab: only a bay corridor is drivable, everything
          // else out here is wall or the dark apron.
          blocked = !inBay;
        } else if (
          wx < FLOOR.x + edge ||
          wx > FLOOR.x + FLOOR.w - edge ||
          wy > FLOOR.y + FLOOR.h - edge ||
          // The north edge margin must not seal the bay mouths.
          (wy < FLOOR.y + edge && !this.inBayCorridor(wx, FLOOR.y - 1, botRadius))
        ) {
          blocked = true;
        } else if (inWater(wx, wy, WATER_CLEARANCE + botRadius)) {
          blocked = true;
        } else {
          for (const col of columns) {
            const half = col.size * 0.95 + botRadius;
            if (Math.abs(wx - col.x) < half && Math.abs(wy - col.y) < half) {
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            for (const prop of props) {
              const reach = prop.radius + botRadius;
              const dx = wx - prop.x;
              const dy = wy - prop.y;
              if (dx * dx + dy * dy < reach * reach) {
                blocked = true;
                break;
              }
            }
          }
        }
        this.blocked[cy * this.cols + cx] = blocked ? 1 : 0;
      }
    }
  }

  cellOf(x: number, y: number): { cx: number; cy: number } {
    return {
      cx: Math.floor((x - NAV.x0) / CELL),
      cy: Math.floor((y - NAV.y0) / CELL),
    };
  }

  centreOf(cx: number, cy: number): { x: number; y: number } {
    return { x: NAV.x0 + (cx + 0.5) * CELL, y: NAV.y0 + (cy + 0.5) * CELL };
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  isBlockedCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return true;
    return this.blocked[cy * this.cols + cx] === 1;
  }

  isBlockedWorld(x: number, y: number): boolean {
    const { cx, cy } = this.cellOf(x, y);
    return this.isBlockedCell(cx, cy);
  }

  /** Nearest walkable point to an arbitrary click, searched in rings. */
  nearestFree(x: number, y: number): { x: number; y: number } | null {
    const { cx, cy } = this.cellOf(x, y);
    if (!this.isBlockedCell(cx, cy)) return { x, y };
    for (let r = 1; r < 90; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.isBlockedCell(nx, ny)) return this.centreOf(nx, ny);
        }
      }
    }
    return null;
  }

  /** Sampled line-of-sight between two world points, used to straighten paths. */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / (CELL * 0.5));
    if (steps === 0) return true;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isBlockedWorld(x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- A* ----

  private heapPush(index: number): void {
    let i = ++this.heapSize;
    this.openHeap[i] = index;
    while (i > 1) {
      const parent = i >> 1;
      if (this.fScore[this.openHeap[parent]] <= this.fScore[this.openHeap[i]]) break;
      const tmp = this.openHeap[parent];
      this.openHeap[parent] = this.openHeap[i];
      this.openHeap[i] = tmp;
      i = parent;
    }
  }

  private heapPop(): number {
    const top = this.openHeap[1];
    this.openHeap[1] = this.openHeap[this.heapSize--];
    let i = 1;
    for (;;) {
      const l = i << 1;
      const r = l + 1;
      let best = i;
      if (l <= this.heapSize && this.fScore[this.openHeap[l]] < this.fScore[this.openHeap[best]]) best = l;
      if (r <= this.heapSize && this.fScore[this.openHeap[r]] < this.fScore[this.openHeap[best]]) best = r;
      if (best === i) break;
      const tmp = this.openHeap[best];
      this.openHeap[best] = this.openHeap[i];
      this.openHeap[i] = tmp;
      i = best;
    }
    return top;
  }

  /**
   * Returns a smoothed path as a flat [x, y, ...] list, or null if the goal is
   * unreachable. The first point is the start; the last is the goal.
   */
  findPath(sx: number, sy: number, tx: number, ty: number): Float32Array | null {
    const start = this.cellOf(sx, sy);
    const goal = this.cellOf(tx, ty);

    if (!this.inBounds(start.cx, start.cy) || !this.inBounds(goal.cx, goal.cy)) return null;
    if (this.isBlockedCell(goal.cx, goal.cy)) return null;

    // A robot nudged into a blocked cell by collision should still be able to
    // path out, so the start is allowed to be blocked.
    const startIndex = start.cy * this.cols + start.cx;
    const goalIndex = goal.cy * this.cols + goal.cx;

    if (startIndex === goalIndex) return new Float32Array([sx, sy, tx, ty]);

    // Straight shot? Skip the search entirely — most orders are like this.
    if (this.hasLineOfSight(sx, sy, tx, ty)) return new Float32Array([sx, sy, tx, ty]);

    const id = ++this.searchId;
    this.heapSize = 0;

    const h = (index: number): number => {
      const cx = index % this.cols;
      const cy = (index / this.cols) | 0;
      const dx = Math.abs(cx - goal.cx);
      const dy = Math.abs(cy - goal.cy);
      // Octile distance.
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
    };

    this.stamp[startIndex] = id;
    this.gScore[startIndex] = 0;
    this.fScore[startIndex] = h(startIndex);
    this.cameFrom[startIndex] = -1;
    this.inOpen[startIndex] = 1;
    this.heapPush(startIndex);

    let found = false;
    let guard = 0;
    const maxExpansions = this.cols * this.rows;

    while (this.heapSize > 0 && guard++ < maxExpansions) {
      const current = this.heapPop();
      this.inOpen[current] = 0;
      if (current === goalIndex) {
        found = true;
        break;
      }
      const cx = current % this.cols;
      const cy = (current / this.cols) | 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.inBounds(nx, ny)) continue;
          if (this.blocked[ny * this.cols + nx] === 1) continue;
          // No squeezing diagonally between two blocked cells.
          if (dx !== 0 && dy !== 0) {
            if (this.isBlockedCell(cx + dx, cy) || this.isBlockedCell(cx, cy + dy)) continue;
          }
          const neighbour = ny * this.cols + nx;
          const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
          const tentative = this.gScore[current] + step;

          if (this.stamp[neighbour] !== id) {
            this.stamp[neighbour] = id;
            this.gScore[neighbour] = Infinity;
            this.inOpen[neighbour] = 0;
          }
          if (tentative < this.gScore[neighbour]) {
            this.cameFrom[neighbour] = current;
            this.gScore[neighbour] = tentative;
            this.fScore[neighbour] = tentative + h(neighbour);
            if (this.inOpen[neighbour] === 0) {
              this.inOpen[neighbour] = 1;
              this.heapPush(neighbour);
            }
          }
        }
      }
    }

    if (!found) return null;

    // Walk the parents back, in cell centres.
    const raw: number[] = [];
    let node = goalIndex;
    while (node !== -1) {
      const cx = node % this.cols;
      const cy = (node / this.cols) | 0;
      const c = this.centreOf(cx, cy);
      raw.push(c.x, c.y);
      if (node === startIndex) break;
      node = this.cameFrom[node];
    }
    // raw runs goal -> start. Walk it backwards in pairs; reversing the flat
    // array directly would swap every x with its y.
    const ordered: number[] = [];
    for (let i = raw.length - 2; i >= 0; i -= 2) ordered.push(raw[i], raw[i + 1]);

    // Replace the endpoints with the true start and goal.
    ordered[0] = sx;
    ordered[1] = sy;
    ordered[ordered.length - 2] = tx;
    ordered[ordered.length - 1] = ty;

    return new Float32Array(this.smooth(ordered));
  }

  /** String-pulling: drop any waypoint we can see past. */
  private smooth(points: number[]): number[] {
    if (points.length <= 4) return points;
    const out: number[] = [points[0], points[1]];
    let anchorX = points[0];
    let anchorY = points[1];
    let i = 2;

    while (i < points.length - 2) {
      const nextX = points[i + 2];
      const nextY = points[i + 3];
      if (this.hasLineOfSight(anchorX, anchorY, nextX, nextY)) {
        i += 2; // the point at i is redundant
        continue;
      }
      anchorX = points[i];
      anchorY = points[i + 1];
      out.push(anchorX, anchorY);
      i += 2;
    }
    out.push(points[points.length - 2], points[points.length - 1]);
    return out;
  }
}
