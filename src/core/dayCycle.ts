import { clamp, hexToRgb, lerp, lerpRgb, smoothstep, type Rgb } from './mathUtils';

/**
 * One continuous 24-hour lighting cycle, replacing what used to be two separate
 * art styles. The scene is baked once in neutral albedo; everything that made
 * "grime" look like daytime and "night shift" look like night is produced here
 * and applied by the lighting pass.
 */

export interface LightingState {
  /** Hours, 0..24. */
  hour: number;
  /** Flat fill light applied to the whole hall. */
  ambient: Rgb;
  ambientIntensity: number;
  /** Colour and strength of daylight through the roof glazing. */
  sunColor: Rgb;
  sunIntensity: number;
  /**
   * How far a roof opening's light pool slides across the floor, and the
   * direction contact shadows are thrown. One vector drives both, so pools and
   * shadows always agree.
   */
  sunOffsetX: number;
  sunOffsetY: number;
  /** Pools stretch as the sun gets low. */
  sunStretch: number;
  /**
   * Where contact shadows fall. Same direction as the sun offset, but with a
   * floor length: a physically correct midday shadow is nearly zero, which
   * reads as objects floating rather than standing.
   */
  shadowOffsetX: number;
  shadowOffsetY: number;
  /** Sodium work lamps, off during the day. */
  lampIntensity: number;
  /** Colour grade applied at composite. */
  gradeTint: Rgb;
  gradeStrength: number;
  /** Slight desaturation at night, when the eye loses colour. */
  saturation: number;
  /** Film grain gets heavier in the dark. */
  grain: number;
  vignette: number;
}

interface Keyframe {
  hour: number;
  ambient: string;
  ambientIntensity: number;
  sunColor: string;
  sunIntensity: number;
  lampIntensity: number;
  gradeTint: string;
  gradeStrength: number;
  saturation: number;
  grain: number;
  vignette: number;
}

/** Anchors around the day. Everything between these is interpolated. */
const KEYS: Keyframe[] = [
  {
    hour: 0,
    ambient: '#1b2740', ambientIntensity: 0.27,
    sunColor: '#22304d', sunIntensity: 0.05,
    lampIntensity: 1.0,
    gradeTint: '#2b3a5c', gradeStrength: 0.30, saturation: 0.80, grain: 0.075, vignette: 0.72,
  },
  {
    hour: 4.5,
    ambient: '#22304c', ambientIntensity: 0.30,
    sunColor: '#3a4a6e', sunIntensity: 0.10,
    lampIntensity: 1.0,
    gradeTint: '#2c3d60', gradeStrength: 0.28, saturation: 0.82, grain: 0.070, vignette: 0.70,
  },
  {
    hour: 6.2,
    ambient: '#4c5260', ambientIntensity: 0.42,
    sunColor: '#ff9d52', sunIntensity: 0.55,
    lampIntensity: 0.55,
    gradeTint: '#6b4a3a', gradeStrength: 0.22, saturation: 0.92, grain: 0.060, vignette: 0.60,
  },
  {
    hour: 8.5,
    ambient: '#767d80', ambientIntensity: 0.68,
    sunColor: '#ffd9a0', sunIntensity: 0.95,
    lampIntensity: 0.0,
    gradeTint: '#576066', gradeStrength: 0.15, saturation: 1.0, grain: 0.050, vignette: 0.50,
  },
  {
    hour: 12,
    ambient: '#858d91', ambientIntensity: 0.86,
    sunColor: '#fff0cf', sunIntensity: 1.12,
    lampIntensity: 0.0,
    gradeTint: '#556065', gradeStrength: 0.11, saturation: 1.0, grain: 0.045, vignette: 0.46,
  },
  {
    hour: 16,
    ambient: '#7d8286', ambientIntensity: 0.76,
    sunColor: '#ffdda6', sunIntensity: 1.0,
    lampIntensity: 0.0,
    gradeTint: '#5c6064', gradeStrength: 0.16, saturation: 1.0, grain: 0.050, vignette: 0.50,
  },
  {
    hour: 18.6,
    ambient: '#6d5c53', ambientIntensity: 0.50,
    sunColor: '#ff8438', sunIntensity: 0.72,
    lampIntensity: 0.35,
    gradeTint: '#7a4426', gradeStrength: 0.26, saturation: 0.96, grain: 0.058, vignette: 0.58,
  },
  {
    hour: 20.2,
    ambient: '#3b4260', ambientIntensity: 0.36,
    sunColor: '#57608f', sunIntensity: 0.22,
    lampIntensity: 0.85,
    gradeTint: '#3a4570', gradeStrength: 0.30, saturation: 0.86, grain: 0.068, vignette: 0.66,
  },
  {
    hour: 21.8,
    ambient: '#1e2942', ambientIntensity: 0.28,
    sunColor: '#243050', sunIntensity: 0.06,
    lampIntensity: 1.0,
    gradeTint: '#2b3a5c', gradeStrength: 0.30, saturation: 0.80, grain: 0.075, vignette: 0.72,
  },
  {
    hour: 24,
    ambient: '#1b2740', ambientIntensity: 0.27,
    sunColor: '#22304d', sunIntensity: 0.05,
    lampIntensity: 1.0,
    gradeTint: '#2b3a5c', gradeStrength: 0.30, saturation: 0.80, grain: 0.075, vignette: 0.72,
  },
];

/** Maximum distance a light pool slides from its roof opening, at the lowest sun. */
const MAX_SUN_SLIDE = 2600;

export function sampleDay(hour: number): LightingState {
  const h = ((hour % 24) + 24) % 24;

  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (h >= KEYS[i].hour && h <= KEYS[i + 1].hour) {
      a = KEYS[i];
      b = KEYS[i + 1];
      break;
    }
  }
  const span = b.hour - a.hour;
  const raw = span > 0 ? (h - a.hour) / span : 0;
  const t = raw * raw * (3 - 2 * raw); // ease so keyframes do not read as hard corners

  // Sun elevation: 0 at 06:00 and 18:00, peaking at midday.
  const dayT = clamp((h - 6) / 12, 0, 1);
  const elevation = Math.sin(dayT * Math.PI);
  const isDaylight = h > 5.4 && h < 19.4;
  const slide = (1 - elevation) * MAX_SUN_SLIDE * (isDaylight ? 1 : 0.35);

  // Azimuth sweeps roughly east-to-west across the hall over the day; before
  // dawn and after dusk it parks so the transition does not visibly snap.
  const azimuth = lerp(-0.62, Math.PI + 0.62, dayT);

  return {
    hour: h,
    ambient: lerpRgb(hexToRgb(a.ambient), hexToRgb(b.ambient), t),
    ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, t),
    sunColor: lerpRgb(hexToRgb(a.sunColor), hexToRgb(b.sunColor), t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    sunOffsetX: Math.cos(azimuth) * slide,
    sunOffsetY: Math.sin(azimuth) * slide * 0.55,
    sunStretch: lerp(1, 2.15, 1 - elevation),
    shadowOffsetX: Math.cos(azimuth) * (95 + slide * 0.55),
    shadowOffsetY: Math.sin(azimuth) * (95 + slide * 0.55) * 0.55,
    lampIntensity: lerp(a.lampIntensity, b.lampIntensity, t),
    gradeTint: lerpRgb(hexToRgb(a.gradeTint), hexToRgb(b.gradeTint), t),
    gradeStrength: lerp(a.gradeStrength, b.gradeStrength, t),
    saturation: lerp(a.saturation, b.saturation, t),
    grain: lerp(a.grain, b.grain, t),
    vignette: lerp(a.vignette, b.vignette, t),
  };
}

/** 0 at deep night, 1 at full day — handy for anything that just needs "is it light". */
export function daylightAmount(hour: number): number {
  return smoothstep(5.2, 8.0, hour) * (1 - smoothstep(17.8, 20.6, hour));
}

export class DayClock {
  /** Current time of day in hours. */
  hour = 9.5;
  /** Real seconds for one full in-game day. */
  dayLengthSeconds = 240;
  paused = false;
  /** Days elapsed. Counted rather than inferred, so scrubbing time is safe. */
  day = 0;

  advance(dt: number): void {
    if (this.paused || this.dayLengthSeconds <= 0) return;
    const next = this.hour + (dt / this.dayLengthSeconds) * 24;
    if (next >= 24) this.day += Math.floor(next / 24);
    this.hour = next % 24;
  }

  state(): LightingState {
    return sampleDay(this.hour);
  }

  label(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
