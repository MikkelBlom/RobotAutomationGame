import { clamp } from './mathUtils';
import { WORLD } from '../sim/level';

export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Top-down camera. Clamped so the sealed warehouse shell always fills the
 * frame — the player never sees past the walls in this level.
 */
export class Camera {
  x = 1600;
  y = 1200;
  zoom = 1;
  targetZoom = 1;

  readonly minZoom = 0.05;
  readonly maxZoom = 2.4;

  private readonly view = new Float32Array(9);

  constructor(x = 1600, y = 1200, zoom = 1) {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.targetZoom = zoom;
  }

  /** Smooths towards the requested zoom and re-clamps the centre. */
  update(dt: number, viewport: ViewportSize): void {
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 14);
    if (Math.abs(this.targetZoom - this.zoom) < 0.0005) this.zoom = this.targetZoom;
    this.clampToWorld(viewport);
  }

  pan(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }

  zoomBy(factor: number): void {
    this.targetZoom = clamp(this.targetZoom * factor, this.minZoom, this.maxZoom);
  }

  /** Zooms while keeping the given screen point anchored to the same world point. */
  zoomAt(factor: number, screenX: number, screenY: number, viewport: ViewportSize): void {
    const before = this.screenToWorld(screenX, screenY, viewport);
    this.targetZoom = clamp(this.targetZoom * factor, this.minZoom, this.maxZoom);
    this.zoom = this.targetZoom;
    const after = this.screenToWorld(screenX, screenY, viewport);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clampToWorld(viewport);
  }

  /** Smallest zoom at which the sealed hall still covers the screen. */
  fitZoom(viewport: ViewportSize): number {
    return Math.max(
      viewport.width / (WORLD.x1 - WORLD.x0),
      viewport.height / (WORLD.y1 - WORLD.y0),
    );
  }

  clampToWorld(viewport: ViewportSize): void {
    // Never let the void outside the shell into frame — this level is sealed.
    const fit = this.fitZoom(viewport);
    if (this.targetZoom < fit) this.targetZoom = fit;
    if (this.zoom < fit) this.zoom = fit;

    const halfW = viewport.width / (2 * this.zoom);
    const halfH = viewport.height / (2 * this.zoom);
    const worldW = WORLD.x1 - WORLD.x0;
    const worldH = WORLD.y1 - WORLD.y0;
    this.x =
      halfW * 2 >= worldW
        ? (WORLD.x0 + WORLD.x1) / 2
        : clamp(this.x, WORLD.x0 + halfW, WORLD.x1 - halfW);
    this.y =
      halfH * 2 >= worldH
        ? (WORLD.y0 + WORLD.y1) / 2
        : clamp(this.y, WORLD.y0 + halfH, WORLD.y1 - halfH);
  }

  screenToWorld(sx: number, sy: number, viewport: ViewportSize): { x: number; y: number } {
    return {
      x: this.x + (sx - viewport.width / 2) / this.zoom,
      y: this.y + (sy - viewport.height / 2) / this.zoom,
    };
  }

  worldToScreen(wx: number, wy: number, viewport: ViewportSize): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + viewport.width / 2,
      y: (wy - this.y) * this.zoom + viewport.height / 2,
    };
  }

  /** Column-major 3x3 world -> clip matrix, with +y pointing down on screen. */
  viewMatrix(viewport: ViewportSize): Float32Array {
    const sx = (2 * this.zoom) / viewport.width;
    const sy = (-2 * this.zoom) / viewport.height;
    const m = this.view;
    m[0] = sx;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = sy;
    m[5] = 0;
    m[6] = -this.x * sx;
    m[7] = -this.y * sy;
    m[8] = 1;
    return m;
  }

  /** World-space rectangle currently visible, padded for culling. */
  visibleBounds(viewport: ViewportSize, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
    const halfW = viewport.width / (2 * this.zoom) + pad;
    const halfH = viewport.height / (2 * this.zoom) + pad;
    return { x0: this.x - halfW, y0: this.y - halfH, x1: this.x + halfW, y1: this.y + halfH };
  }
}
