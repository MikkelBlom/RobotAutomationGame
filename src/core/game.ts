import { Camera } from './camera';
import { DayClock } from './dayCycle';
import { Input } from './input';
import { defaultSettings, type Settings } from './settings';
import { EntityRenderer } from '../render/entities';
import { Renderer } from '../render/renderer';
import { BOT_RADIUS, BotPool } from '../sim/bots';
import { buildLevelGeometry, SPAWN, type LevelGeometry } from '../sim/level';
import { NavGrid } from '../sim/navGrid';

const EDGE_PAN_MARGIN = 58;
const PAN_SPEED = 2600;
/** Slack around a click when picking a single robot. */
const CLICK_PICK_RADIUS = 110;

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
  readonly stats: Stats = {
    fps: 60, frameMs: 0, simMs: 0, drawMs: 0, sprites: 0, bots: 0, selected: 0,
  };

  /** Called at the end of each frame — used by the debug console. */
  onFrame: (() => void) | null = null;

  private readonly container: HTMLElement;
  private readonly selectionBox: HTMLDivElement;
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
    this.renderer = new Renderer(container, seed, this.level.bays);
    this.camera = new Camera(SPAWN.x, SPAWN.y, 0.30);
    this.input = new Input(this.renderer.canvas);
    this.renderer.setLevel(this.level);
    this.nav = new NavGrid(this.level.columns, this.level.props, BOT_RADIUS);
    this.entities = new EntityRenderer(this.bots);

    // Start with a single machine, as asked.
    this.bots.spawn(SPAWN.x, SPAWN.y, Math.PI);

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
      time,
      drawEntities: (batch, bounds) => this.entities.drawBodies(batch, bounds),
      drawEntityShadows: (batch, bounds) =>
        this.entities.drawShadows(batch, bounds, lighting, this.settings),
      drawEntityLights: (batch, bounds) =>
        this.entities.drawLights(batch, bounds, lighting, this.settings),
      drawGlow: (batch, bounds) => {
        this.entities.drawGlow(batch, bounds, lighting, time);
        this.entities.drawTrails(batch, bounds, time, this.settings);
      },
      drawOverlay: (batch, bounds) => this.entities.drawSelection(batch, bounds, time),
    });
  }

  private update(dt: number): void {
    this.clock.paused = this.settings.timePaused;
    this.clock.dayLengthSeconds = this.settings.dayLengthSeconds;
    this.clock.advance(dt * this.settings.simSpeed);

    this.updateCamera(dt);
    this.updateSelection();
    this.updateOrders();
    this.bots.update(dt * this.settings.simSpeed, this.nav);
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

    // Live rubber band.
    const drag = input.drag;
    if (drag.active && Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY) > 5) {
      const x = Math.min(drag.startX, drag.currentX);
      const y = Math.min(drag.startY, drag.currentY);
      this.selectionBox.style.display = 'block';
      this.selectionBox.style.left = `${x}px`;
      this.selectionBox.style.top = `${y}px`;
      this.selectionBox.style.width = `${Math.abs(drag.currentX - drag.startX)}px`;
      this.selectionBox.style.height = `${Math.abs(drag.currentY - drag.startY)}px`;
    } else if (!drag.active) {
      this.selectionBox.style.display = 'none';
    }

    const done = input.dragCompleted;
    if (!done) return;
    this.selectionBox.style.display = 'none';
    const additive = input.isDown('shift');

    if (done.moved) {
      const a = this.camera.screenToWorld(done.x0, done.y0, vp);
      const b = this.camera.screenToWorld(done.x1, done.y1, vp);
      this.bots.selectInRect(a.x, a.y, b.x, b.y, additive);
    } else {
      const w = this.camera.screenToWorld(done.x0, done.y0, vp);
      const hit = this.bots.pick(w.x, w.y, CLICK_PICK_RADIUS / this.camera.zoom + CLICK_PICK_RADIUS);
      if (!additive) this.bots.clearSelection();
      if (hit >= 0) this.bots.selected[hit] = 1;
    }
  }

  private updateOrders(): void {
    const click = this.input.rightClick;
    if (!click) return;
    const target = this.camera.screenToWorld(click.x, click.y, this.viewport);
    const selected = this.bots.selectedIndices();
    if (selected.length === 0) return;

    // Shift queues the destination behind the current order instead of
    // replacing it, so a route can be built up click by click.
    const append = this.input.isDown('shift');

    // Spread destinations so a squad does not all aim at one point and shove
    // each other around it.
    const spacing = BOT_RADIUS * 2.6;
    const perRow = Math.max(1, Math.ceil(Math.sqrt(selected.length)));
    for (let k = 0; k < selected.length; k++) {
      const col = k % perRow;
      const row = Math.floor(k / perRow);
      const offsetX = (col - (perRow - 1) / 2) * spacing;
      const offsetY = (row - (Math.ceil(selected.length / perRow) - 1) / 2) * spacing;
      this.bots.orderMove(
        selected[k], target.x + offsetX, target.y + offsetY, this.nav, append,
      );
    }
  }
}
