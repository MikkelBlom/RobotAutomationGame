import { createProgram, Uniforms, type GL } from './gl';

/**
 * Instanced quad renderer. Every sprite in the game — robots, shadows, light
 * pools, trail dots — goes through this. One buffer upload and one
 * drawArraysInstanced per flush, so the cost of 100k sprites is 100k * 13
 * floats of memory traffic rather than 100k draw calls.
 */

const FLOATS_PER_INSTANCE = 13; // x, y, rot, w, h, u0, v0, u1, v1, r, g, b, a
const STRIDE = FLOATS_PER_INSTANCE * 4;

const VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;   // unit quad, -0.5 .. 0.5
layout(location = 1) in vec3 aXYR;      // world position + rotation
layout(location = 2) in vec2 aSize;     // world-space size
layout(location = 3) in vec4 aUV;       // u0, v0, u1, v1
layout(location = 4) in vec4 aColor;

uniform mat3 uView;

out vec2 vUV;
out vec4 vColor;

void main() {
  float c = cos(aXYR.z);
  float s = sin(aXYR.z);
  vec2 local = aCorner * aSize;
  vec2 world = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + aXYR.xy;
  vec3 clip = uView * vec3(world, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vUV = mix(aUV.xy, aUV.zw, aCorner + 0.5);
  vColor = aColor;
}
`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;

void main() {
  outColor = texture(uTex, vUV) * vColor;
}
`;

export class SpriteBatch {
  readonly program: WebGLProgram;
  readonly uniforms: Uniforms;

  private readonly gl: GL;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private data: Float32Array;
  private count = 0;
  private capacity: number;
  private uploadedCapacity = 0;

  constructor(gl: GL, capacity = 4096) {
    this.gl = gl;
    this.capacity = capacity;
    this.data = new Float32Array(capacity * FLOATS_PER_INSTANCE);
    this.program = createProgram(gl, VERT, FRAG, 'sprite');
    this.uniforms = new Uniforms(gl, this.program);

    const vao = gl.createVertexArray();
    const quad = gl.createBuffer();
    const inst = gl.createBuffer();
    if (!vao || !quad || !inst) throw new Error('could not create sprite batch buffers');
    this.vao = vao;
    this.instanceBuffer = inst;

    gl.bindVertexArray(vao);

    // Unit quad as a triangle strip.
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.uploadedCapacity = capacity;

    const attrib = (index: number, size: number, offsetFloats: number) => {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, STRIDE, offsetFloats * 4);
      gl.vertexAttribDivisor(index, 1);
    };
    attrib(1, 3, 0); // xyr
    attrib(2, 2, 3); // size
    attrib(3, 4, 5); // uv
    attrib(4, 4, 9); // colour

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  begin(): void {
    this.count = 0;
  }

  get length(): number {
    return this.count;
  }

  private grow(): void {
    this.capacity = Math.ceil(this.capacity * 1.75);
    const next = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
    next.set(this.data);
    this.data = next;
  }

  push(
    x: number,
    y: number,
    rotation: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (this.count >= this.capacity) this.grow();
    const o = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = rotation;
    d[o + 3] = w;
    d[o + 4] = h;
    d[o + 5] = u0;
    d[o + 6] = v0;
    d[o + 7] = u1;
    d[o + 8] = v1;
    d[o + 9] = r;
    d[o + 10] = g;
    d[o + 11] = b;
    d[o + 12] = a;
    this.count++;
  }

  /** Convenience overload for an atlas region object. */
  pushRegion(
    region: { u0: number; v0: number; u1: number; v1: number },
    x: number,
    y: number,
    rotation: number,
    w: number,
    h: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    this.push(x, y, rotation, w, h, region.u0, region.v0, region.u1, region.v1, r, g, b, a);
  }

  /**
   * Uploads and draws. The caller owns program selection so several batches can
   * share one shader, but the common case is `flush(view, texture)`.
   */
  flush(view: Float32Array, texture: WebGLTexture): void {
    if (this.count === 0) return;
    const gl = this.gl;

    gl.useProgram(this.program);
    this.uniforms.mat3('uView', view);
    this.uniforms.int('uTex', 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (this.capacity > this.uploadedCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      this.uploadedCapacity = this.capacity;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * FLOATS_PER_INSTANCE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}
