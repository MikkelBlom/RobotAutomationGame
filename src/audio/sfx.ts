/**
 * Procedural sound.
 *
 * Everything here is synthesised at runtime rather than loaded, for the same
 * reason the art is drawn into a canvas rather than shipped as PNGs: there are
 * no assets to keep in sync, nothing to download, and a machine noise can be
 * built from the same numbers that drive the thing making it.
 *
 * Two rules shape the design:
 *
 * 1. Nothing is per-robot. With thousands of machines working, one voice each
 *    is thousands of voices and a wall of mush. The drive noise is a single bed
 *    whose level follows how much work is happening on screen.
 * 2. One-shots are throttled. Twenty crates landing in the same frame is one
 *    sound, not twenty.
 */

type Voice = 'grab' | 'place' | 'refuse' | 'money' | 'doors' | 'truck' | 'beep' | 'charge';

/** Shortest gap between two of the same one-shot, in seconds. */
const THROTTLE: Record<Voice, number> = {
  grab: 0.07,
  place: 0.07,
  refuse: 0.20,
  money: 0.30,
  doors: 0.60,
  truck: 0.60,
  beep: 0.30,
  charge: 0.40,
};

/** Shared noise buffer. Building one per hit was the bulk of the cost. */
function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < data.length; i++) {
    // Integer hash rather than Math.random: the same noise every run means a
    // sound tuned once stays tuned.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buffer;
}

export class Sfx {
  /** Master level, 0 to 1. */
  volume = 0.7;
  enabled = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastAt: Record<string, number> = {};
  private offset = 0;

  private driveGain: GainNode | null = null;
  private driveFilter: BiquadFilterNode | null = null;

  /**
   * Starts audio. Browsers only allow this from a real input event, so it is
   * called from the first click or keypress rather than at load.
   */
  resume(): void {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
  }

  private build(): void {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.noise = makeNoise(ctx, 1.4);

    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.master = master;

    // Drive bed: filtered noise plus a low hum, always running, gated by level.
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedGain.connect(master);
    this.driveGain = bedGain;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 220;
    filter.Q.value = 0.9;
    filter.connect(bedGain);
    this.driveFilter = filter;

    const bed = ctx.createBufferSource();
    bed.buffer = this.noise;
    bed.loop = true;
    bed.connect(filter);
    bed.start();

    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 54;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.16;
    hum.connect(humGain).connect(bedGain);
    hum.start();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Sets the drive bed from how much of the fleet is working on screen.
   * `activity` is 0 to 1; `pace` shifts the filter so a fast machine sounds
   * like one.
   */
  drive(activity: number, pace: number): void {
    if (!this.ctx || !this.driveGain || !this.driveFilter) return;
    const level = this.enabled ? Math.min(0.3, activity * 0.3) : 0;
    const now = this.ctx.currentTime;
    this.driveGain.gain.setTargetAtTime(level, now, 0.12);
    this.driveFilter.frequency.setTargetAtTime(150 + pace * 260, now, 0.2);
  }

  /** True if this voice is allowed to fire right now. */
  private open(voice: Voice): boolean {
    if (!this.enabled || !this.ctx) return false;
    const now = this.ctx.currentTime;
    const last = this.lastAt[voice] ?? -99;
    if (now - last < THROTTLE[voice]) return false;
    this.lastAt[voice] = now;
    return true;
  }

  /**
   * A short filtered noise burst: impacts, servos, clunks.
   *
   * Each hit reads from a different point in the shared buffer so repeated
   * bursts do not phase into one flat tone.
   */
  private burst(duration: number, freq: number, sweep: number, gain: number, q = 1.4): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    const amp = ctx.createGain();
    const now = ctx.currentTime;
    filter.frequency.setValueAtTime(freq, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), now + duration);
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(amp).connect(this.master);
    this.offset = (this.offset + 0.137) % 0.6;
    src.start(now, this.offset);
    src.stop(now + duration + 0.02);
  }

  /** A pitched blip. `to` below `from` falls, above it rises. */
  private tone(
    from: number,
    to: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'square',
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    const amp = ctx.createGain();
    const now = ctx.currentTime + delay;
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + duration);
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Arms closing and the crate coming up: a servo whine into a clunk. */
  grab(): void {
    if (!this.open('grab')) return;
    this.tone(340, 620, 0.18, 0.05, 'sawtooth');
    this.burst(0.13, 1500, 0.22, 0.16);
  }

  /** Crate down: a heavier, duller version of the same. */
  place(): void {
    if (!this.open('place')) return;
    this.tone(560, 300, 0.16, 0.045, 'sawtooth');
    this.burst(0.22, 900, 0.14, 0.22, 1.0);
  }

  /** Order refused. Flat and unmusical on purpose — this is a "no". */
  refuse(): void {
    if (!this.open('refuse')) return;
    this.tone(300, 190, 0.09, 0.07, 'square');
    this.tone(190, 130, 0.14, 0.06, 'square', 0.09);
  }

  /** Payment. A rising third, the only genuinely pleasant sound in the game. */
  money(): void {
    if (!this.open('money')) return;
    this.tone(784, 788, 0.14, 0.05, 'triangle');
    this.tone(1175, 1180, 0.26, 0.045, 'triangle', 0.07);
    this.burst(0.2, 3600, 0.5, 0.05, 2.6);
  }

  /** Trailer doors: a long metallic slide ending in a latch. */
  doors(): void {
    if (!this.open('doors')) return;
    this.burst(0.75, 620, 0.35, 0.13, 0.7);
    this.tone(150, 96, 0.2, 0.05, 'square', 0.62);
  }

  /** Trailer arriving or pulling away: air brakes and a diesel shove. */
  truck(): void {
    if (!this.open('truck')) return;
    this.tone(70, 44, 1.1, 0.09, 'sawtooth');
    this.burst(0.85, 260, 0.45, 0.1, 0.6);
    this.burst(0.45, 4200, 0.3, 0.07, 1.2);
  }

  /** Dock beacon. One chirp per flash. */
  beep(): void {
    if (!this.open('beep')) return;
    this.tone(1180, 1160, 0.1, 0.045, 'square');
  }

  /** Contact made with a charging point. */
  charge(): void {
    if (!this.open('charge')) return;
    this.tone(220, 880, 0.22, 0.04, 'triangle');
    this.burst(0.12, 2600, 1.6, 0.05, 3.0);
  }
}
