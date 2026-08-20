/**
 * Raw pointer and keyboard state. Deliberately dumb: it records what happened
 * this frame, and the game layer decides what it means.
 */

export interface DragBox {
  active: boolean;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

export class Input {
  readonly keys = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  inside = false;

  /** Left-button drag, in screen pixels. */
  readonly drag: DragBox = { active: false, startX: 0, startY: 0, currentX: 0, currentY: 0 };

  /** Consumed by the game each frame. */
  dragCompleted: { x0: number; y0: number; x1: number; y1: number; moved: boolean } | null = null;
  rightClick: { x: number; y: number } | null = null;
  wheelDelta = 0;

  private readonly element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointerleave', () => {
      this.inside = false;
    });
    element.addEventListener('pointerenter', () => {
      this.inside = true;
    });
    element.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    this.mouseX = p.x;
    this.mouseY = p.y;
    this.inside = true;
    if (e.button === 0) {
      this.drag.active = true;
      this.drag.startX = p.x;
      this.drag.startY = p.y;
      this.drag.currentX = p.x;
      this.drag.currentY = p.y;
      this.element.setPointerCapture?.(e.pointerId);
    } else if (e.button === 2) {
      this.rightClick = { x: p.x, y: p.y };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    this.mouseX = p.x;
    this.mouseY = p.y;
    if (this.drag.active) {
      this.drag.currentX = p.x;
      this.drag.currentY = p.y;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.drag.active) return;
    const p = this.localPoint(e);
    const dx = p.x - this.drag.startX;
    const dy = p.y - this.drag.startY;
    this.dragCompleted = {
      x0: Math.min(this.drag.startX, p.x),
      y0: Math.min(this.drag.startY, p.y),
      x1: Math.max(this.drag.startX, p.x),
      y1: Math.max(this.drag.startY, p.y),
      moved: Math.hypot(dx, dy) > 5,
    };
    this.drag.active = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.localPoint(e);
    this.mouseX = p.x;
    this.mouseY = p.y;
    this.wheelDelta += e.deltaY;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  isDown(...keys: string[]): boolean {
    for (const k of keys) if (this.keys.has(k)) return true;
    return false;
  }

  /** Clears the one-shot events. Call at the end of each frame. */
  endFrame(): void {
    this.dragCompleted = null;
    this.rightClick = null;
    this.wheelDelta = 0;
  }
}
