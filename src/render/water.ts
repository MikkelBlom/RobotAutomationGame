import { makeOctaveNoise } from '../art/noise';
import type { LightingState } from '../core/dayCycle';
import type { Settings } from '../core/settings';
import { createProgram, createTextureFromData, Uniforms, type GL } from './gl';
import { WATER_FRAG, WATER_VERT } from './shaders';
import { DOCK_MOUTH_X, WATER_BOUNDS, WATER_POLY } from '../sim/level';
import { distanceToEdges, pointInPolygon, triangulate } from '../sim/polygon';

/** World units per distance-field texel. Foam bands are ~15 units, so 4 is ample. */
const SDF_RESOLUTION = 12;
/** Texels of slack around the basin so bilinear taps never wrap. */
const SDF_PAD = 6;

const NEAR_RANGE = 340;
const BROAD_RANGE = 2400;

/** Neutral water albedo; time of day arrives via the lighting pass. */
const COLORS = {
  deep: [0.078, 0.128, 0.180] as const,
  shallow: [0.204, 0.310, 0.396] as const,
  foam: [0.780, 0.831, 0.851] as const,
  spec: [0.816, 0.882, 0.929] as const,
};

export class WaterLayer {
  private readonly gl: GL;
  private readonly program: WebGLProgram;
  private readonly uniforms: Uniforms;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vertexCount: number;
  private readonly sdfTexture: WebGLTexture;
  private readonly noiseTexture: WebGLTexture;

  private readonly originX: number;
  private readonly originY: number;
  private readonly spanX: number;
  private readonly spanY: number;

  constructor(gl: GL, seed: number) {
    this.gl = gl;
    this.program = createProgram(gl, WATER_VERT, WATER_FRAG, 'water');
    this.uniforms = new Uniforms(gl, this.program);

    const mesh = triangulate(WATER_POLY);
    this.vertexCount = mesh.length / 2;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('could not create water buffers');
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const pad = SDF_PAD * SDF_RESOLUTION;
    this.originX = WATER_BOUNDS.x0 - pad;
    this.originY = WATER_BOUNDS.y0 - pad;
    this.spanX = WATER_BOUNDS.x1 - WATER_BOUNDS.x0 + pad * 2;
    this.spanY = WATER_BOUNDS.y1 - WATER_BOUNDS.y0 + pad * 2;

    const { data, width, height } = this.buildDistanceField();
    this.sdfTexture = createTextureFromData(gl, data, width, height, { filter: gl.LINEAR });

    const noiseSize = 256;
    this.noiseTexture = createTextureFromData(
      gl,
      makeOctaveNoise(noiseSize, seed ^ 0x9e37),
      noiseSize,
      noiseSize,
      { filter: gl.LINEAR, wrap: gl.REPEAT },
    );
  }

  /**
   * Distance from every point of the basin to its shoreline, so the shader's
   * foam, edge shadow and depth follow the real notched outline instead of a
   * rectangle. Two ranges are packed because foam needs fine precision near the
   * wall while the depth gradient needs to reach the middle.
   */
  private buildDistanceField(): { data: Uint8Array; width: number; height: number } {
    const width = Math.ceil(this.spanX / SDF_RESOLUTION);
    const height = Math.ceil(this.spanY / SDF_RESOLUTION);
    const data = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
      const wy = this.originY + (y + 0.5) * SDF_RESOLUTION;
      for (let x = 0; x < width; x++) {
        const wx = this.originX + (x + 0.5) * SDF_RESOLUTION;
        const inside = pointInPolygon(WATER_POLY, wx, wy);
        const d = inside ? distanceToEdges(WATER_POLY, wx, wy) : 0;
        const i = (y * width + x) * 4;
        data[i] = Math.min(255, Math.round((d / NEAR_RANGE) * 255));
        data[i + 1] = Math.min(255, Math.round((d / BROAD_RANGE) * 255));
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  }

  draw(view: Float32Array, time: number, lighting: LightingState, settings: Settings): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    const u = this.uniforms;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
    u.int('uSdf', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTexture);
    u.int('uNoise', 1);

    u.mat3('uView', view);
    u.vec2('uSdfOrigin', this.originX, this.originY);
    u.vec2('uSdfSize', this.spanX, this.spanY);
    u.float('uTime', time);
    u.vec3('uDeepColor', COLORS.deep[0], COLORS.deep[1], COLORS.deep[2]);
    u.vec3('uShallowColor', COLORS.shallow[0], COLORS.shallow[1], COLORS.shallow[2]);
    u.vec3('uFoamColor', COLORS.foam[0], COLORS.foam[1], COLORS.foam[2]);
    u.vec3('uSpecColor', COLORS.spec[0], COLORS.spec[1], COLORS.spec[2]);
    // Glints need a source; at night the lamps carry them instead of the sun.
    u.float('uSpecStrength', 0.25 + lighting.sunIntensity * 0.55 + lighting.lampIntensity * 0.20);
    u.float('uWaveStrength', settings.waveStrength);
    u.float('uMouthX', DOCK_MOUTH_X);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    gl.bindVertexArray(null);
  }
}
