import { Camera } from './camera';
import { DayClock } from './dayCycle';
import { Input } from './input';
import { defaultSettings, type Settings } from './settings';
import { EntityRenderer, type PlanMark } from '../render/entities';
import { Renderer } from '../render/renderer';
import { BOT_LENGTH, BOT_RADIUS, BotPool, BotTask, OrderKind } from '../sim/bots';
import {
  buildLevelGeometry, PLATE_TRIGGER, SPAWN, type LevelGeometry, type Prop,
} from '../sim/level';
import { Sfx } from '../audio/sfx';
import { Ledger } from '../sim/economy';
import { NavGrid } from '../sim/navGrid';
import { SLOT_COUNT, TrailerFleet, type Trailer } from '../sim/trailers';
import { canLift, type CrateMaterialValue, type CrateShapeValue, type HaulerClassValue } from '../sim/cargo';

const EDGE_PAN_MARGIN = 58;
const PAN_SPEED = 1750;
/** Slack around a click when picking a single robot. */
const CLICK_PICK_RADIUS = 110;
/**
 * Ceiling on how many plan marks are built in a frame.
 *
 * Select a thousand machines and the marks stop being a readout and start being
 * confetti, so there is no point paying to build them all.
 */
const MAX_PLAN_MARKS = 40;

export interface Stats {
  fps: number;
  frameMs: number;
  simMs: number;
  drawMs: number;
  sprites: number;
  bots: number;
  selected: number;
}

export class Game {
  readonly renderer: Renderer;
  readonly camera: Camera;
  readonly input: Input;
  readonly clock = new DayClock();
  readonly settings: Settings = defaultSettings();
  readonly level: LevelGeometry;
  readonly nav: NavGrid;
  readonly bots = new BotPool(4096);
  readonly entities: EntityRenderer;
  readonly trailers: TrailerFleet;
  readonly stats: Stats = {
    fps: 60, frameMs: 0, simMs: 0, drawMs: 0, sprites: 0, bots: 0, selected: 0,
  };

  /** Procedural sound. Silent until the first click or keypress wakes it. */
  readonly sfx = new Sfx();

  /** Shift figures, shown on the board on the north wall. */
  readonly ledger = new Ledger();

  /** Where the drop ghost currently sits, so a right click can find it. */
  dropGhost: { x: number; y: number } | null = null;

  /** Called at the end of each frame — used by the debug console. */
  onFrame: (() => void) | null = null;

  private readonly container: HTMLElement;
  private readonly selectionBox: HTMLDivElement;
  /**
   * Where the drag began, in WORLD space. Anchoring in screen space meant the
   * box slid across the floor when the camera panned; anchored here it stays
   * put and simply grows.
   */
  private dragAnchor: { x: number; y: number } | null = null;
  private lastFrame = performance.now();
  private elapsed = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsTimer = 0;
  private running = false;

  constructor(container: HTMLElement, seed = 20260820) {
    this.container = container;
    // The bake needs the bays before anything else, so the level is built first.
    this.level = buildLevelGeometry(seed);
    this.trailers = new TrailerFleet(this.level.bays, seed);
    this.renderer = new Renderer(container, seed, this.level.bays);
    this.camera = new Camera(SPAWN.x, SPAWN.y, 0.30);
    this.input = new Input(this.renderer.canvas);
    this.renderer.setLevel(this.level);
    this.nav = new NavGrid(this.level.columns, this.level.props, this.level.bays, BOT_RADIUS);
    this.bots.onDelivered = this.onDelivered;
    this.bots.onSound = (what) => {
      if (what === 'grab') this.sfx.grab();
      else if (what === 'place') this.sfx.place();
      else this.sfx.charge();
    };
    this.trailers.onSound = (what) => {
      if (what === 'doors') this.sfx.doors();
      else this.sfx.truck();
    };
    // Browsers will not start audio without a real gesture, so it waits for one.
    const wake = (): void => {
      if (this.settings.sound) this.sfx.resume();
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    this.trailers.onDeparted = (load) => {
      this.ledger.ship(load);
      this.sfx.money();
    };
    this.bots.onResolveDrop = this.resolveDrop;
    this.bots.setProps(this.level.props);
    this.bots.setChargers(this.level.chargers);
    this.entities = new EntityRenderer(this.bots);

    // Start with a single machine, as asked. Snap it to walkable ground: a
    // hand-picked constant silently ends up inside an obstacle's clearance the
    // moment anything is resized, and a robot spawned there can never move.
    const start = this.nav.nearestFree(SPAWN.x, SPAWN.y) ?? SPAWN;
    this.bots.spawn(start.x, start.y, Math.PI);

    this.selectionBox = document.createElement('div');
    this.selectionBox.style.cssText = [
      'position:absolute',
      'border:1px solid rgba(120,225,255,0.9)',
      'background:rgba(90,200,255,0.12)',
      'box-shadow:0 0 12px rgba(90,200,255,0.25) inset',
      'pointer-events:none',
      'display:none',
      'z-index:5',
    ].join(';');
    container.appendChild(this.selectionBox);

    this.handleResize();
    window.addEventListener('resize', this.handleResize);
    // The container can be laid out after construction (hidden panes, late
    // fonts, devtools docking). Observing it keeps the viewport truthful.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(this.handleResize).observe(container);
    }
  }

  private handleResize = (): void => {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth || 1280);
    const height = Math.max(1, rect.height || window.innerHeight || 800);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.resize(width, height, dpr);
    this.camera.clampToWorld(this.viewport);
  };

  get viewport(): { width: number; height: number } {
    return { width: this.renderer.viewportWidth, height: this.renderer.viewportHeight };
  }

  /** Adds robots at free positions near a point — used by the debug panel. */
  spawnBots(n: number, aroundX = SPAWN.x, aroundY = SPAWN.y): number {
    let added = 0;
    const spread = Math.max(600, Math.sqrt(n) * 230);
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (let attempt = 0; attempt < 40 && !placed; attempt++) {
        const x = aroundX + (Math.random() * 2 - 1) * spread;
        const y = aroundY + (Math.random() * 2 - 1) * spread;
        if (!this.nav.isBlockedWorld(x, y)) {
          this.bots.spawn(x, y, Math.random() * Math.PI * 2);
          placed = true;
          added++;
        }
      }
    }
    return added;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    // Clamp so a background tab or a breakpoint does not teleport the sim.
    const dt = Math.min(0.05, Math.max(0, rawDt));
    this.elapsed += dt;

    const simStart = performance.now();
    this.update(dt);
    const simEnd = performance.now();

    this.renderOnce();
    const drawEnd = performance.now();

    this.stats.simMs = simEnd - simStart;
    this.stats.drawMs = drawEnd - simEnd;
    this.stats.frameMs = rawDt * 1000;
    this.stats.sprites = this.renderer.lastSpriteCount;
    this.stats.bots = this.bots.count;
    this.fpsAccum += 1 / Math.max(rawDt, 0.0001);
    this.fpsFrames++;
    this.fpsTimer += dt;
    if (this.fpsTimer > 0.3) {
      this.stats.fps = Math.round(this.fpsAccum / this.fpsFrames);
      this.stats.selected = this.bots.selectedCount();
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.fpsTimer = 0;
    }

    this.onFrame?.();
    this.input.endFrame();
    requestAnimationFrame(this.frame);
  };

  /**
   * Renders one frame with the current camera and settings. Shared by the main
   * loop and by dev tooling, so an offscreen capture is guaranteed to contain
   * exactly what the player sees — robots, trails and all.
   */
  renderOnce(viewport = this.viewport, time = this.elapsed): void {
    const lighting = this.clock.state();
    this.renderer.render({
      camera: this.camera,
      viewport,
      lighting,
      settings: this.settings,
      level: this.level,
      trailers: this.trailers,
      time,
      drawEntities: (batch, bounds) => {
        this.entities.drawBodies(batch, bounds);
        this.entities.drawChargeSockets(batch, bounds);
        this.entities.drawLoad(batch, bounds);
      },
      drawEntityShadows: (batch, bounds) =>
        this.entities.drawShadows(batch, bounds, lighting, this.settings),
      drawEntityLights: (batch, bounds) =>
        this.entities.drawLights(batch, bounds, lighting, this.settings),
      drawGlow: (batch, bounds) => {
        this.entities.drawGlow(batch, bounds, lighting, time);
        this.entities.drawTrails(batch, bounds, time, this.settings);
        this.entities.drawCharge(batch, bounds, time, this.level.chargers);
      },
      ledger: this.ledger,
      drawMarks: (batch, bounds) => {
        this.entities.drawPlanMarks(batch, bounds, this.buildPlan(), time);
      },
      drawOverlay: (batch, bounds) => this.entities.drawSelection(batch, bounds, time),
    });
  }

  private update(dt: number): void {
    this.clock.paused = this.settings.timePaused;
    this.clock.dayLengthSeconds = this.settings.dayLengthSeconds;
    this.clock.advance(dt * this.settings.simSpeed);
    this.ledger.syncDay(this.clock.day, this.elapsed);

    // Trailers coming and going change which bays can be driven into. Only the
    // bay strip is re-rasterised: a full rebuild here cost a four-frame hitch
    // every few seconds.
    const hours = this.settings.timePaused
      ? 0
      : ((dt * this.settings.simSpeed) / this.clock.dayLengthSeconds) * 24;
    if (this.trailers.update(
      dt * this.settings.simSpeed, hours, this.robotAtBay, this.plateHeld,
    )) {
      this.nav.rebuildBayCorridors(this.level.bays, this.trailerCargoBlocks());
    }

    this.updateCamera(dt);
    this.updateSelection();
    this.updateOrders();
    this.applyChargeUnlocks();
    this.updateSound(dt);
    this.bots.update(
      dt * this.settings.simSpeed, this.nav, this.settings.batteryDrain, this.takeProp,
    );
  }

  private updateCamera(dt: number): void {
    const input = this.input;
    const vp = this.viewport;

    if (input.wheelDelta !== 0) {
      const factor = input.wheelDelta < 0 ? 1.18 : 1 / 1.18;
      this.camera.zoomAt(factor, input.mouseX, input.mouseY, vp);
    }

    let px = 0;
    let py = 0;
    if (input.isDown('a', 'arrowleft')) px -= 1;
    if (input.isDown('d', 'arrowright')) px += 1;
    if (input.isDown('w', 'arrowup')) py -= 1;
    if (input.isDown('s', 'arrowdown')) py += 1;

    // Edge panning, but not while a selection box is being dragged.
    if (input.inside && !input.drag.active) {
      const m = EDGE_PAN_MARGIN;
      if (input.mouseX < m) px -= 1 - input.mouseX / m;
      if (input.mouseX > vp.width - m) px += 1 - (vp.width - input.mouseX) / m;
      if (input.mouseY < m) py -= 1 - input.mouseY / m;
      if (input.mouseY > vp.height - m) py += 1 - (vp.height - input.mouseY) / m;
    }

    if (px !== 0 || py !== 0) {
      const len = Math.hypot(px, py) || 1;
      const boost = input.isDown('shift') ? 2.1 : 1;
      const speed = (PAN_SPEED * boost) / this.camera.zoom;
      this.camera.pan((px / len) * speed * dt, (py / len) * speed * dt);
    }

    this.camera.update(dt, vp);
  }

  private updateSelection(): void {
    const input = this.input;
    const vp = this.viewport;

    // Live rubber band, anchored to the world point first clicked.
    const drag = input.drag;
    if (drag.active && !this.dragAnchor) {
      this.dragAnchor = this.camera.screenToWorld(drag.startX, drag.startY, vp);
    }
    if (drag.active && this.dragAnchor) {
      const anchor = this.camera.worldToScreen(this.dragAnchor.x, this.dragAnchor.y, vp);
      if (Math.hypot(drag.currentX - anchor.x, drag.currentY - anchor.y) > 5) {
        this.selectionBox.style.display = 'block';
        this.selectionBox.style.left = `${Math.min(anchor.x, drag.currentX)}px`;
        this.selectionBox.style.top = `${Math.min(anchor.y, drag.currentY)}px`;
        this.selectionBox.style.width = `${Math.abs(drag.currentX - anchor.x)}px`;
        this.selectionBox.style.height = `${Math.abs(drag.currentY - anchor.y)}px`;
      }
    } else if (!drag.active) {
      this.selectionBox.style.display = 'none';
    }

    const done = input.dragCompleted;
    if (!done) {
      return;
    }
    this.selectionBox.style.display = 'none';
    const anchor = this.dragAnchor;
    this.dragAnchor = null;
    const additive = input.isDown('shift');

    if (done.moved && anchor) {
      const end = this.camera.screenToWorld(input.mouseX, input.mouseY, vp);
      this.bots.selectInRect(
        Math.min(anchor.x, end.x), Math.min(anchor.y, end.y),
        Math.max(anchor.x, end.x), Math.max(anchor.y, end.y),
        additive,
      );
    } else {
      const w = this.camera.screenToWorld(done.x0, done.y0, vp);
      const hit = this.bots.pick(w.x, w.y, CLICK_PICK_RADIUS / this.camera.zoom + CLICK_PICK_RADIUS);
      if (!additive) this.bots.clearSelection();
      if (hit >= 0) this.bots.selected[hit] = 1;
    }
  }

  /**
   * Removes a crate from the world once a robot has it on the deck, and
   * re-rasterises the nav grid so everything can now drive through where it was.
   */
  private takeProp = (propIndex: number): void => {
    const prop = this.level.props[propIndex];
    if (!prop) return;
    const { x, y, radius } = prop;
    this.level.props.splice(propIndex, 1);
    // Indices shift, so anything still targeting a later crate must follow.
    for (let i = 0; i < this.bots.count; i++) {
      if (this.bots.targetProp[i] > propIndex) this.bots.targetProp[i]--;
    }
    this.bots.setProps(this.level.props);
    // Only the ground the crate was standing on has changed.
    this.nav.clearAround(x, y, radius, this.level.props);
  };

  /**
   * Whether anything is inside a trailer or sitting in its mouth. A trailer
   * pulling out with a robot aboard would carry it off out of the building, so
   * it waits.
   */
  private robotAtBay = (bayX: number): boolean => {
    const t = this.trailers.trailers.find((x) => x.bay.x === bayX);
    if (!t) return false;
    for (let i = 0; i < this.bots.count; i++) {
      if (TrailerFleet.contains(t, this.bots.x[i], this.bots.y[i], BOT_LENGTH)) return true;
      // A robot on its way in counts too, or it arrives to a closed door.
      if (this.bots.task[i] === BotTask.Deliver && Math.abs(this.bots.goalX[i] - bayX) < 400) {
        return true;
      }
    }
    return false;
  };

  /**
   * Feeds the drive bed and chirps the dock beacons.
   *
   * The bed is one voice for the whole fleet, weighted by what is on screen —
   * with thousands of machines a sample each would be a wall of mush, and you
   * would not hear the one crate landing that you actually care about.
   */
  private updateSound(dt: number): void {
    this.sfx.enabled = this.settings.sound;
    if (!this.settings.sound) {
      this.sfx.drive(0, 0);
      return;
    }
    const bounds = this.camera.visibleBounds(this.viewport);
    let moving = 0;
    let paceSum = 0;
    for (let i = 0; i < this.bots.count; i++) {
      if (this.bots.velocity[i] < 12) continue;
      const x = this.bots.x[i];
      const y = this.bots.y[i];
      if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) continue;
      moving++;
      paceSum += this.bots.velocity[i] / this.bots.speed[i];
    }
    // Saturates quickly: eight machines working already sounds like a shift.
    const activity = moving === 0 ? 0 : Math.min(1, 0.35 + moving / 8);
    this.sfx.drive(activity, moving === 0 ? 0 : paceSum / moving);

    // One chirp per beacon flash, while any dock is warning.
    let warning = false;
    for (const t of this.trailers.trailers) if (t.alarm > 0.4) warning = true;
    this.beaconChirp = warning ? this.beaconChirp + dt : 0;
    if (warning && this.beaconChirp > 0.74) {
      this.beaconChirp = 0;
      this.sfx.beep();
    }
  }

  private beaconChirp = 0;

  /** Commissions charging points from the south end, per the debug setting. */
  private applyChargeUnlocks(): void {
    const n = this.settings.chargePoints;
    for (const pad of this.level.chargers) pad.unlocked = pad.index < n;
  }

  /** Whether a robot is standing on the dispatch plate for a bay. */
  private plateHeld = (bayX: number): boolean => {
    const plate = this.level.plates.find((p) => p.bayX === bayX);
    if (!plate) return false;
    for (let i = 0; i < this.bots.count; i++) {
      const dx = this.bots.x[i] - plate.x;
      const dy = this.bots.y[i] - plate.y;
      if (dx * dx + dy * dy < PLATE_TRIGGER * PLATE_TRIGGER) return true;
    }
    return false;
  };

  /** Loaded crates, as circles the nav grid can treat as obstacles. */
  private trailerCargoBlocks(): Array<{ x: number; y: number; r: number }> {
    const out: Array<{ x: number; y: number; r: number }> = [];
    for (const t of this.trailers.trailers) {
      if (!TrailerFleet.isDockable(t)) continue;
      for (let slot = 0; slot < t.cargo.length; slot++) {
        if (!t.cargo[slot]) continue;
        const p = TrailerFleet.slotPosition(t, slot);
        out.push({ x: p.x, y: p.y, r: 74 });
      }
    }
    return out;
  }

  /** A robot has set its load down in a trailer slot. */
  private onDelivered = (_bot: number, slot: number, material: number, shape: number): void => {
    const t = this.trailers.trailers.find((x) => TrailerFleet.isDockable(x));
    if (!t || slot < 0) return;
    t.cargo[slot] = {
      material: material as CrateMaterialValue,
      shape: shape as CrateShapeValue,
    };
    this.ledger.load(this.elapsed);
    // The crate is an obstacle from now on.
    this.nav.rebuildBayCorridors(this.level.bays, this.trailerCargoBlocks());
  };

  /**
   * Everything the selected robots are lined up to do, as marks to draw.
   *
   * This walks each robot's active task and then its queue, tracking what will
   * be on its deck at every step and which trailer slot each delivery will land
   * in. Without the walk you can see the crate being collected now but nothing
   * about the three behind it, which is exactly the part that was invisible.
   *
   * It also drags each queued order's displayed target up to date, so the
   * dotted queue line ends where the crate will actually go rather than at
   * whichever slot happened to be free when the order was given.
   */
  private buildPlan(): PlanMark[] {
    const marks: PlanMark[] = [];
    const trailer = this.trailers.trailers.find((t) => TrailerFleet.isDockable(t));
    let slot = trailer ? TrailerFleet.nextFreeSlot(trailer) : -1;

    // What a robot is still holding once its whole plan has run. That is the
    // only thing a NEW delivery order could be about.
    let unassigned: { material: CrateMaterialValue; shape: CrateShapeValue } | null = null;

    for (let i = 0; i < this.bots.count && marks.length < MAX_PLAN_MARKS; i++) {
      if (!this.bots.selected[i]) continue;
      let depth = 0;
      let load: { material: CrateMaterialValue; shape: CrateShapeValue } | null =
        this.bots.carryMaterial[i] >= 0
          ? {
              material: this.bots.carryMaterial[i] as CrateMaterialValue,
              shape: this.bots.carryShape[i] as CrateShapeValue,
            }
          : null;

      const pick = (prop: Prop): void => {
        marks.push({
          x: prop.x, y: prop.y, angle: prop.angle,
          material: prop.material, shape: prop.shape, drop: false, depth,
        });
        load = { material: prop.material, shape: prop.shape };
        depth++;
      };
      /** Books the next free slot and marks it. Returns where it landed. */
      const place = (): { x: number; y: number } | null => {
        if (!trailer || !load || slot < 0 || slot >= SLOT_COUNT) return null;
        const pos = TrailerFleet.slotPosition(trailer, slot);
        marks.push({
          x: pos.x, y: pos.y, angle: 0,
          material: load.material, shape: load.shape, drop: true, depth,
        });
        slot++;
        load = null;
        depth++;
        return pos;
      };

      // The step in progress comes first — it is what depth 0 means.
      if (this.bots.task[i] === BotTask.Fetch && this.bots.targetProp[i] >= 0) {
        const prop = this.level.props[this.bots.targetProp[i]];
        if (prop) pick(prop);
      } else if (this.bots.task[i] === BotTask.Deliver) {
        place();
      }

      for (const order of this.bots.queueOf(i) ?? []) {
        if (order.kind === OrderKind.Fetch && order.prop) {
          pick(order.prop);
          order.x = order.prop.x;
          order.y = order.prop.y;
        } else if (order.kind === OrderKind.Deliver) {
          const pos = place();
          if (pos) {
            order.x = pos.x;
            order.y = pos.y;
          }
        } else {
          depth++;
        }
      }
      if (load) unassigned = load;
    }

    // Where a NEW delivery order would land. Only offered when something will
    // actually be left on a deck — with every load already spoken for, an extra
    // mark just reads as a fifth delivery nobody asked for.
    this.dropGhost = this.pendingDrop(trailer, slot, marks, unassigned);
    return marks;
  }

  /** The mark a fresh delivery order would use, if one makes sense right now. */
  private pendingDrop(
    trailer: Trailer | undefined,
    slot: number,
    marks: PlanMark[],
    load: { material: CrateMaterialValue; shape: CrateShapeValue } | null,
  ): { x: number; y: number } | null {
    if (!trailer || !load || slot < 0 || slot >= SLOT_COUNT) return null;
    const pos = TrailerFleet.slotPosition(trailer, slot);
    marks.push({
      x: pos.x, y: pos.y, angle: 0,
      material: load.material, shape: load.shape, drop: true,
      depth: marks.length,
    });
    return pos;
  }

  /** A selected robot with something on its deck, if there is one. */
  private carryingSelection(): number | null {
    for (let i = 0; i < this.bots.count; i++) {
      if (this.bots.selected[i] && this.bots.carryMaterial[i] >= 0) return i;
    }
    return null;
  }

  /** Nearest crate to a world point, within a generous grab radius. */
  private pickProp(x: number, y: number): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.level.props.length; i++) {
      const p = this.level.props[i];
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < p.radius + 90 && d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  /** Where a queued delivery should go by the time it actually starts. */
  private resolveDrop = (bot: number): { slot: number; x: number; y: number } | null => {
    if (this.bots.carryMaterial[bot] < 0) return null;
    const trailer = this.trailers.trailers.find((t) => TrailerFleet.isDockable(t));
    if (!trailer) return null;
    const slot = TrailerFleet.nextFreeSlot(trailer);
    if (slot < 0) return null;
    const pos = TrailerFleet.slotPosition(trailer, slot);
    return { slot, x: pos.x, y: pos.y };
  };

  private updateOrders(): void {
    const click = this.input.rightClick;
    if (!click) return;
    const target = this.camera.screenToWorld(click.x, click.y, this.viewport);
    const selected = this.bots.selectedIndices();
    if (selected.length === 0) return;

    // Shift queues an order behind the current one instead of replacing it.
    const shift = this.input.isDown('shift');

    /** Closest selected robot, optionally restricted to ones fit for the job. */
    const nearest = (fit?: (i: number) => boolean): number => {
      let best = -1;
      let bestDist = Infinity;
      for (const i of selected) {
        if (fit && !fit(i)) continue;
        const d = Math.hypot(this.bots.x[i] - target.x, this.bots.y[i] - target.y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    };

    // The drop mark is checked first: it sits over the trailer floor, where a
    // stray crate pick would otherwise win the click.
    const ghost = this.dropGhost;
    if (ghost && Math.hypot(ghost.x - target.x, ghost.y - target.y) < 260) {
      // The robot that will do it may not be loaded YET — a queued delivery
      // runs after the fetch in front of it.
      const carrier = this.carryingSelection() ?? nearest();
      if (carrier >= 0) {
        if (!shift && this.bots.isBusy(carrier)) this.bots.clearQueue(carrier);
        const drop = this.resolveDrop(carrier);
        if (drop) {
          this.bots.orderDeliver(
            carrier, drop.slot, drop.x, drop.y, this.nav, shift || this.bots.isBusy(carrier),
          );
        } else {
          // Nothing on the deck to set down yet, so it can only be queued.
          this.bots.orderDeliver(carrier, -1, ghost.x, ghost.y, this.nav, true);
        }
      }
      return;
    }

    // Right-clicking a crate sends the nearest selected robot to collect it.
    const propIndex = this.pickProp(target.x, target.y);
    if (propIndex >= 0) {
      const prop = this.level.props[propIndex];
      // Prefer a machine rated for it and with a free deck, so selecting a
      // squad does not hand the job to a loaded robot standing slightly nearer.
      const rated = (i: number): boolean =>
        canLift(this.bots.hauler[i] as HaulerClassValue, prop.material, prop.shape);
      const free = nearest((i) => rated(i) && this.bots.carryMaterial[i] < 0);
      const able = free >= 0 ? free : nearest(rated);
      if (able < 0 || this.bots.isFlat(able)) {
        // Nothing on the roster can take it. No words for that — just the noise
        // a machine makes when it will not do the thing.
        this.sfx.refuse();
        return;
      }
      if (!shift && this.bots.isBusy(able)) this.bots.clearQueue(able);
      this.bots.orderFetch(able, propIndex, prop, this.nav, shift || this.bots.isBusy(able));
      return;
    }

    // Ordinary movement. A robot mid-grab takes the order onto its queue rather
    // than abandoning the animation, so the crate never hangs in mid-air.
    const append = shift;

    // Spread destinations so a squad does not all aim at one point and shove
    // each other around it.
    const spacing = BOT_RADIUS * 2.6;
    const perRow = Math.max(1, Math.ceil(Math.sqrt(selected.length)));
    for (let k = 0; k < selected.length; k++) {
      const col = k % perRow;
      const row = Math.floor(k / perRow);
      const offsetX = (col - (perRow - 1) / 2) * spacing;
      const offsetY = (row - (Math.ceil(selected.length / perRow) - 1) / 2) * spacing;
      const i = selected[k];
      // A plain click at a robot mid-grab still means "then go there, and only
      // there", so anything already stacked up is dropped first.
      if (!append && this.bots.isBusy(i)) this.bots.clearQueue(i);
      this.bots.orderMove(
        i, target.x + offsetX, target.y + offsetY, this.nav, append || this.bots.isBusy(i),
      );
    }
  }
}
