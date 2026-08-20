import type { Camera, ViewportSize } from '../core/camera';
import type { LightingState } from '../core/dayCycle';
import type { Settings } from '../core/settings';
import { buildAtlas } from './atlas';
import {
  applyBlend,
  BlendMode,
  createProgram,
  createTextureFromSource,
  RenderTarget,
  Uniforms,
  type GL,
} from './gl';
import { bakeFloor } from './floorBake';
import { LightingPass, type Bounds } from './lighting';
import { COMPOSITE_FRAG, FULLSCREEN_VERT } from './shaders';
import { SpriteBatch } from './spriteBatch';
import { WaterLayer } from './water';
import { WORLD, WORLD_H, WORLD_W, type DockBay, type LevelGeometry } from '../sim/level';

export interface FrameContext {
  camera: Camera;
  viewport: ViewportSize;
  lighting: LightingState;
  settings: Settings;
  level: LevelGeometry;
  /** Seconds since start, used for animation. */
  time: number;
  /** Filled by the game layer: robots, order trails, selection. */
  drawEntities?: (batch: SpriteBatch, bounds: Bounds) => void;
  drawEntityShadows?: (batch: SpriteBatch, bounds: Bounds) => void;
  drawEntityLights?: (batch: SpriteBatch, bounds: Bounds) => void;
  drawGlow?: (batch: SpriteBatch, bounds: Bounds) => void;
  drawOverlay?: (batch: SpriteBatch, bounds: Bounds) => void;
}

/**
 * Owns the GL device and the pass structure:
 *
 *   1. albedo    — unlit scene colour (floor, water, columns, robots)
 *   2. light     — ambient fill, daylight pools, lamps, robot lamps, then
 *                  shadows multiplied over the accumulated result
 *   3. composite — albedo * light, tone-mapped and graded, to the screen
 *   4. glow      — emissive bits added after the multiply, so robots still read
 *                  as lit at 03:00
 *   5. overlay   — selection, order trails, debug: deliberately unlit
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: GL;

  pixelRatio = 1;
  viewportWidth = 1;
  viewportHeight = 1;
  lastSpriteCount = 0;

  private readonly albedo: RenderTarget;
  private readonly light: RenderTarget;

  private readonly compositeProgram: WebGLProgram;
  private readonly compositeUniforms: Uniforms;
  private readonly emptyVao: WebGLVertexArrayObject;

  private readonly seed: number;
  private readonly bays: DockBay[];
  private floorTexture: WebGLTexture;
  private bakedGrime = true;
  private readonly atlasTexture: WebGLTexture;

  private readonly floorBatch: SpriteBatch;
  private readonly entityBatch: SpriteBatch;
  private readonly lightBatch: SpriteBatch;
  private readonly shadowBatch: SpriteBatch;
  private readonly glowBatch: SpriteBatch;
  private readonly overlayBatch: SpriteBatch;

  readonly waterLayer: WaterLayer;
  private lightingPass: LightingPass | null = null;

  constructor(container: HTMLElement, seed: number, bays: DockBay[]) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    this.seed = seed;
    this.bays = bays;
    const floorCanvas = bakeFloor(seed, bays, { grime: true });
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (floorCanvas.width > maxTex || floorCanvas.height > maxTex) {
      throw new Error(
        `floor bake ${floorCanvas.width}x${floorCanvas.height} exceeds GPU limit ${maxTex}`,
      );
    }
    this.floorTexture = createTextureFromSource(gl, floorCanvas, { filter: gl.LINEAR });
    this.atlasTexture = createTextureFromSource(gl, buildAtlas(seed), { filter: gl.LINEAR });

    this.floorBatch = new SpriteBatch(gl, 4);
    this.entityBatch = new SpriteBatch(gl, 2048);
    this.lightBatch = new SpriteBatch(gl, 1024);
    this.shadowBatch = new SpriteBatch(gl, 2048);
    this.glowBatch = new SpriteBatch(gl, 2048);
    this.overlayBatch = new SpriteBatch(gl, 2048);

    this.waterLayer = new WaterLayer(gl, seed);
    this.albedo = new RenderTarget(gl, 1, 1);
    this.light = new RenderTarget(gl, 1, 1);

    this.compositeProgram = createProgram(gl, FULLSCREEN_VERT, COMPOSITE_FRAG, 'composite');
    this.compositeUniforms = new Uniforms(gl, this.compositeProgram);

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('could not create vao');
    this.emptyVao = vao;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  setLevel(level: LevelGeometry): void {
    this.lightingPass = new LightingPass(level);
  }

  /**
   * Re-bakes the floor. Only used by the grime toggle: the wear is part of the
   * baked albedo, so switching it costs a full re-bake. Fine for a debug
   * control, not something to do per frame.
   */
  private syncFloorBake(grime: boolean): void {
    if (grime === this.bakedGrime) return;
    this.bakedGrime = grime;
    const gl = this.gl;
    gl.deleteTexture(this.floorTexture);
    this.floorTexture = createTextureFromSource(
      gl, bakeFloor(this.seed, this.bays, { grime }), { filter: gl.LINEAR },
    );
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    this.viewportWidth = cssWidth;
    this.viewportHeight = cssHeight;
    const w = Math.max(1, Math.round(cssWidth * pixelRatio));
    const h = Math.max(1, Math.round(cssHeight * pixelRatio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.albedo.resize(w, h);
    this.light.resize(w, h);
  }

  /** Ambient colour normalised to a hue, then scaled by its intensity. */
  private ambientLight(lighting: LightingState): [number, number, number] {
    const [r, g, b] = lighting.ambient;
    const peak = Math.max(r, g, b, 0.0001);
    const k = lighting.ambientIntensity / peak;
    return [r * k, g * k, b * k];
  }

  render(ctx: FrameContext): void {
    const gl = this.gl;
    const view = ctx.camera.viewMatrix(ctx.viewport);
    const bounds = ctx.camera.visibleBounds(ctx.viewport, 220);
    const pass = this.lightingPass;
    let sprites = 0;
    this.syncFloorBake(ctx.settings.floorGrime);

    // ------------------------------------------------------------- 1. albedo
    this.albedo.bind();
    gl.clearColor(0.015, 0.017, 0.02, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    applyBlend(gl, BlendMode.Normal);
    this.floorBatch.begin();
    this.floorBatch.push(
      WORLD.x0 + WORLD_W / 2, WORLD.y0 + WORLD_H / 2, 0,
      WORLD_W, WORLD_H,
      0, 0, 1, 1,
      1, 1, 1, 1,
    );
    this.floorBatch.flush(view, this.floorTexture);

    if (ctx.settings.water) {
      gl.disable(gl.BLEND);
      this.waterLayer.draw(view, ctx.time, ctx.lighting, ctx.settings);
      applyBlend(gl, BlendMode.Normal);
    }

    this.entityBatch.begin();
    pass?.collectColumns(this.entityBatch, bounds, ctx.settings);
    pass?.collectProps(this.entityBatch, bounds, ctx.settings);
    ctx.drawEntities?.(this.entityBatch, bounds);
    sprites += this.entityBatch.length;
    this.entityBatch.flush(view, this.atlasTexture);

    // -------------------------------------------------------------- 2. light
    this.light.bind();
    if (ctx.settings.lighting) {
      const [r, g, b] = this.ambientLight(ctx.lighting);
      gl.clearColor(r, g, b, 1);
    } else {
      gl.clearColor(1, 1, 1, 1);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Additive sources.
    applyBlend(gl, BlendMode.Additive);
    this.lightBatch.begin();
    pass?.collectDaylight(this.lightBatch, ctx.lighting, bounds, ctx.settings);
    pass?.collectLamps(this.lightBatch, ctx.lighting, bounds, ctx.time, ctx.settings);
    ctx.drawEntityLights?.(this.lightBatch, bounds);
    sprites += this.lightBatch.length;
    this.lightBatch.flush(view, this.atlasTexture);

    // Occluders multiply down whatever light landed, so a column standing in a
    // pool of daylight cuts a streak through it.
    applyBlend(gl, BlendMode.Shadow);
    this.shadowBatch.begin();
    pass?.collectShadows(this.shadowBatch, ctx.lighting, bounds, ctx.settings);
    pass?.collectPropShadows(this.shadowBatch, ctx.lighting, bounds, ctx.settings);
    ctx.drawEntityShadows?.(this.shadowBatch, bounds);
    sprites += this.shadowBatch.length;
    this.shadowBatch.flush(view, this.atlasTexture);

    // ---------------------------------------------------------- 3. composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);

    gl.useProgram(this.compositeProgram);
    const u = this.compositeUniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedo.texture);
    u.int('uAlbedo', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.light.texture);
    u.int('uLight', 1);

    const l = ctx.lighting;
    u.vec3('uGradeTint', l.gradeTint[0], l.gradeTint[1], l.gradeTint[2]);
    u.float('uGradeStrength', ctx.settings.lighting ? l.gradeStrength : 0);
    u.float('uSaturation', ctx.settings.lighting ? l.saturation : 1);
    u.float('uGrain', ctx.settings.grain ? l.grain : 0);
    u.float('uVignette', ctx.settings.vignette ? l.vignette : 0);
    u.float('uTime', ctx.time);
    u.float('uExposure', ctx.settings.exposure);
    u.vec2('uResolution', this.canvas.width, this.canvas.height);

    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // --------------------------------------------------------------- 4. glow
    applyBlend(gl, BlendMode.Additive);
    this.glowBatch.begin();
    ctx.drawGlow?.(this.glowBatch, bounds);
    sprites += this.glowBatch.length;
    this.glowBatch.flush(view, this.atlasTexture);

    // ------------------------------------------------------------ 5. overlay
    applyBlend(gl, BlendMode.Normal);
    this.overlayBatch.begin();
    ctx.drawOverlay?.(this.overlayBatch, bounds);
    sprites += this.overlayBatch.length;
    this.overlayBatch.flush(view, this.atlasTexture);

    this.lastSpriteCount = sprites;
  }
}
