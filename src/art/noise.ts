import { mulberry32 } from '../core/mathUtils';

/**
 * Tileable value noise packed as four octaves into RGBA. The water shader
 * samples the same texture at several scales, so one upload covers swell,
 * chop, fine ripple and glint.
 */
export function makeOctaveNoise(size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  // Fine lattices: coarse ones produced obvious blobs once tiled in world space.
  const lattices = [11, 23, 47, 89];
  for (let channel = 0; channel < 4; channel++) {
    writeOctave(out, size, channel, lattices[channel], seed + channel * 7919);
  }
  return out;
}

function writeOctave(
  out: Uint8Array,
  size: number,
  channel: number,
  lattice: number,
  seed: number,
): void {
  const rand = mulberry32(seed);
  const grid = new Float32Array(lattice * lattice);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  const at = (gx: number, gy: number): number =>
    grid[((gy % lattice) + lattice) % lattice * lattice + (((gx % lattice) + lattice) % lattice)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * lattice;
      const fy = (y / size) * lattice;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      let tx = fx - x0;
      let ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);

      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      const value = top * (1 - ty) + bottom * ty;

      out[(y * size + x) * 4 + channel] = Math.round(value * 255);
    }
  }
}
