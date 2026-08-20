/** Thin WebGL2 helpers. No engine — we own the pipeline. */

export type GL = WebGL2RenderingContext;

export function compileShader(gl: GL, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`could not create shader: ${label}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    throw new Error(`shader compile failed [${label}]\n${log}\n${numberSource(source)}`);
  }
  return shader;
}

function numberSource(src: string): string {
  return src
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(3, ' ')} | ${line}`)
    .join('\n');
}

export function createProgram(gl: GL, vsSource: string, fsSource: string, label: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, `${label}.frag`);
  const program = gl.createProgram();
  if (!program) throw new Error(`could not create program: ${label}`);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error';
    gl.deleteProgram(program);
    throw new Error(`program link failed [${label}]\n${log}`);
  }
  return program;
}

/** Caches uniform locations so hot paths do not hit getUniformLocation. */
export class Uniforms {
  private readonly cache = new Map<string, WebGLUniformLocation | null>();

  constructor(private readonly gl: GL, private readonly program: WebGLProgram) {}

  loc(name: string): WebGLUniformLocation | null {
    let found = this.cache.get(name);
    if (found === undefined) {
      found = this.gl.getUniformLocation(this.program, name);
      this.cache.set(name, found);
    }
    return found;
  }

  int(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v);
  }
  float(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v);
  }
  vec2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y);
  }
  vec3(name: string, x: number, y: number, z: number): void {
    this.gl.uniform3f(this.loc(name), x, y, z);
  }
  vec4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }
  mat3(name: string, m: Float32Array): void {
    this.gl.uniformMatrix3fv(this.loc(name), false, m);
  }
}

export interface TextureOptions {
  filter?: number;
  wrap?: number;
  flipY?: boolean;
  mipmap?: boolean;
}

export function createTextureFromSource(
  gl: GL,
  source: TexImageSource,
  opts: TextureOptions = {},
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('could not create texture');
  const filter = opts.filter ?? gl.LINEAR;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, opts.flipY ?? false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  if (opts.mipmap) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export function createTextureFromData(
  gl: GL,
  data: Uint8Array,
  width: number,
  height: number,
  opts: TextureOptions = {},
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('could not create texture');
  const filter = opts.filter ?? gl.LINEAR;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** A colour-only offscreen target. */
export class RenderTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width = 0;
  height = 0;

  constructor(private readonly gl: GL, width: number, height: number) {
    const fb = gl.createFramebuffer();
    const tex = gl.createTexture();
    if (!fb || !tex) throw new Error('could not create render target');
    this.framebuffer = fb;
    this.texture = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
  }
}

export const BlendMode = {
  /** Straight alpha over. */
  Normal: 0,
  /** Adds light. */
  Additive: 1,
  /** Multiplies the destination down by source alpha — used for contact shadows. */
  Shadow: 2,
} as const;
export type BlendModeValue = (typeof BlendMode)[keyof typeof BlendMode];

export function applyBlend(gl: GL, mode: BlendModeValue): void {
  gl.enable(gl.BLEND);
  switch (mode) {
    case BlendMode.Additive:
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      break;
    case BlendMode.Shadow:
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      break;
    default:
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      break;
  }
}
