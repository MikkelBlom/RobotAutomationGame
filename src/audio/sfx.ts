/**
 * Procedural sound.
 *
 * Synthesised at runtime rather than loaded, for the same reason the art is
 * drawn into a canvas: nothing to keep in sync, nothing to download, and a
 * machine noise can be built from the same numbers that drive the machine.
 *
 * Three rules shape it:
 *
 * 1. Nothing is per-robot. With thousands of machines working, one voice each
 *    is thousands of voices and a wall of mush. The drive noise is a single bed
 *    whose level follows how much work is happening on screen.
 * 2. One-shots are throttled. Twenty crates landing in the same frame is one
 *    sound, not twenty.
 * 3. Noise is a last resort. The first pass built almost everything out of
 *    filtered noise and the result was television static — an electric motor is
 *    tonal, a wooden crate is a set of resonant modes, and neither is hiss.
 */

type Voice =
  | 'grab'
  | 'place'
  | 'refuse'
  | 'money'
  | 'doors'
  | 'arrive'
  | 'depart'
  | 'beep'
  | 'charge';

/** Shortest gap between two of the same one-shot, in seconds. */
const THROTTLE: Record<Voice, number> = {
  grab: 0.08,
  place: 0.08,
  refuse: 0.20,
  money: 0.30,
  doors: 0.70,
  arrive: 1.50,
  depart: 1.50,
  beep: 0.30,
  charge: 0.40,
};

/**
 * Resonant modes of a wooden packing case, as [hertz, level, seconds].
 *
 * A crate is a stiff hollow box: a handful of low partials that ring briefly
 * and die, with no harmonic relationship to each other. That inharmonicity is
 * what makes it read as wood rather than as a drum or a bell.
 */
const CRATE_MODES: Array<[number, number, number]> = [
  [116, 1.00, 0.34],
  [187, 0.62, 0.26],
  [289, 0.40, 0.19],
  [437, 0.24, 0.13],
  [683, 0.12, 0.08],
];

/** Shared noise buffer, for the few things that genuinely are noise. */
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

  /** The one drive bed: motor, inverter whine and track contact. */
  private bedGain: GainNode | null = null;
  private motorA: OscillatorNode | null = null;
  private motorB: OscillatorNode | null = null;
  private whine: OscillatorNode | null = null;
  private motorFilter: BiquadFilterNode | null = null;

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

    const bed = ctx.createGain();
    bed.gain.value = 0;
    bed.connect(master);
    this.bedGain = bed;

    // Motor: two sawtooths a few cents apart, rolled right off. Detuning them
    // gives the slow beat a real drive has; the lowpass takes out the buzz that
    // would otherwise read as a petrol engine.
    const motorFilter = ctx.createBiquadFilter();
    motorFilter.type = 'lowpass';
    motorFilter.frequency.value = 420;
    motorFilter.Q.value = 0.8;
    motorFilter.connect(bed);
    this.motorFilter = motorFilter;

    const motorLevel = ctx.createGain();
    motorLevel.gain.value = 0.5;
    motorLevel.connect(motorFilter);

    this.motorA = ctx.createOscillator();
    this.motorA.type = 'sawtooth';
    this.motorA.frequency.value = 96;
    this.motorA.connect(motorLevel);
    this.motorA.start();

    this.motorB = ctx.createOscillator();
    this.motorB.type = 'sawtooth';
    this.motorB.frequency.value = 96 * 1.011;
    this.motorB.connect(motorLevel);
    this.motorB.start();

    // Inverter whine. This is the single thing that says "electric" — take it
    // away and the bed could be any machine at all.
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0.055;
    whineGain.connect(bed);
    this.whine = ctx.createOscillator();
    this.whine.type = 'triangle';
    this.whine.frequency.value = 1500;
    this.whine.connect(whineGain);
    this.whine.start();

    // Track contact: noise, but rolled off so far down that it is felt rather
    // than heard. At full band this was the television static.
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 190;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.30;
    rumbleFilter.connect(rumbleGain).connect(bed);
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    rumble.connect(rumbleFilter);
    rumble.start();
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Sets the drive bed from how much of the fleet is working on screen.
   * `activity` is 0 to 1; `pace` is the fleet's average fraction of top speed.
   */
  drive(activity: number, pace: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.bedGain || !this.motorA || !this.motorB || !this.whine) return;
    const now = ctx.currentTime;
    const level = this.enabled ? Math.min(0.26, activity * 0.26) : 0;
    this.bedGain.gain.setTargetAtTime(level, now, 0.15);
    // Motor and whine both track pace, the whine much harder — that rising
    // note under load is most of what makes an electric drive recognisable.
    const rpm = 74 + pace * 96;
    this.motorA.frequency.setTargetAtTime(rpm, now, 0.25);
    this.motorB.frequency.setTargetAtTime(rpm * 1.011, now, 0.25);
    this.whine.frequency.setTargetAtTime(900 + pace * 2100, now, 0.2);
    this.motorFilter?.frequency.setTargetAtTime(320 + pace * 520, now, 0.25);
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

  /** A filtered noise burst. Transients and air only — never a whole sound. */
  private burst(
    duration: number,
    freq: number,
    sweep: number,
    gain: number,
    q = 1.4,
    type: BiquadFilterType = 'bandpass',
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const amp = ctx.createGain();
    const now = ctx.currentTime + delay;
    filter.frequency.setValueAtTime(freq, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), now + duration);
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    src.connect(filter).connect(amp).connect(this.master);
    // Each hit reads from a different point in the shared buffer, so repeats do
    // not phase into one flat tone.
    this.offset = (this.offset + 0.137) % 0.6;
    src.start(now, this.offset);
    src.stop(now + duration + 0.02);
  }

  /** One decaying partial. The building block for anything struck. */
  private mode(
    freq: number,
    gain: number,
    decay: number,
    type: OscillatorType = 'sine',
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    const now = ctx.currentTime + delay;
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.003);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + decay + 0.02);
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

  /** Strikes the crate's modes, scaled in level, pitch and ring. */
  private woodHit(gain: number, pitch: number, ring: number, delay = 0): void {
    for (const [freq, level, decay] of CRATE_MODES) {
      this.mode(freq * pitch, level * gain, decay * ring, 'sine', delay);
    }
    // The transient. Short and dry: this is the board being struck, not air.
    this.burst(0.035, 2400, 0.25, gain * 0.5, 0.9, 'bandpass', delay);
  }

  /** Arms closing on a crate and taking its weight: a servo, then the box. */
  grab(): void {
    if (!this.open('grab')) return;
    // Actuator: a short rising note, quiet, over in a fifth of a second.
    this.tone(210, 430, 0.16, 0.035, 'triangle');
    // Timber creaking as the load transfers.
    this.mode(174, 0.030, 0.20, 'sine', 0.07);
    this.woodHit(0.10, 1.06, 0.7, 0.10);
  }

  /** Crate down: the full box on concrete, with the settle after it. */
  place(): void {
    if (!this.open('place')) return;
    this.tone(430, 250, 0.14, 0.030, 'triangle');
    this.woodHit(0.20, 1.0, 1.0, 0.06);
    // The second, smaller knock as it beds down. A single hit sounds dropped;
    // two sound set down.
    this.woodHit(0.07, 1.04, 0.5, 0.135);
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
    this.burst(0.2, 3600, 0.5, 0.045, 2.6);
  }

  /** Trailer doors: a metallic slide ending in a latch. */
  doors(): void {
    if (!this.open('doors')) return;
    this.burst(0.7, 700, 0.32, 0.09, 0.8);
    this.mode(210, 0.07, 0.16, 'square', 0.60);
    this.mode(96, 0.06, 0.24, 'sine', 0.62);
  }

  /**
   * Diesel engine.
   *
   * A sawtooth well below hearing chopped by a pulse LFO at the firing rate.
   * The chop is the whole trick: an unmodulated low saw is a hum, and the same
   * saw gated twenty times a second is an engine.
   */
  private diesel(
    duration: number,
    fromRpm: number,
    toRpm: number,
    gain: number,
    delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime + delay;

    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(fromRpm, now);
    body.frequency.linearRampToValueAtTime(toRpm, now + duration);

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(260, now);
    tone.frequency.linearRampToValueAtTime(520, now + duration);
    tone.Q.value = 2.2;

    // Firing pulses. A square LFO into a gain gives a hard chop; the depth is
    // held under 1 so the engine never fully cuts between strokes.
    const chop = ctx.createGain();
    chop.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.setValueAtTime(fromRpm * 0.24, now);
    lfo.frequency.linearRampToValueAtTime(toRpm * 0.24, now + duration);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.42;
    lfo.connect(lfoDepth).connect(chop.gain);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(gain, now + 0.18);
    amp.gain.setValueAtTime(gain, now + duration * 0.72);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    body.connect(tone).connect(chop).connect(amp).connect(this.master);
    body.start(now);
    lfo.start(now);
    body.stop(now + duration + 0.05);
    lfo.stop(now + duration + 0.05);

    // Turbo, rising with the revs.
    this.tone(fromRpm * 8, toRpm * 13, duration * 0.9, gain * 0.16, 'triangle', delay);
  }

  /** Trailer backing onto the bay: engine under load, then air brakes. */
  arrive(): void {
    if (!this.open('arrive')) return;
    this.diesel(2.6, 46, 34, 0.075);
    // Air dump. Noise is right here — this genuinely is escaping air.
    this.burst(0.55, 5200, 0.16, 0.055, 0.8, 'bandpass', 2.35);
  }

  /** Trailer pulling out: brakes off, then the engine hauling it away. */
  depart(): void {
    if (!this.open('depart')) return;
    this.burst(0.45, 4600, 0.18, 0.05, 0.8);
    this.diesel(3.0, 38, 74, 0.085, 0.30);
  }

  /**
   * Reversing alarm.
   *
   * Around a kilohertz, square, hard-gated, and long enough to be a beep rather
   * than a tick. Real ones are almost pure square with a brutal envelope, which
   * is exactly why they carry across a yard.
   */
  beep(): void {
    if (!this.open('beep')) return;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const length = 0.26;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1020;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(0.055, now + 0.004);
    amp.gain.setValueAtTime(0.055, now + length - 0.012);
    amp.gain.linearRampToValueAtTime(0, now + length);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + length + 0.01);
    // A little grit an octave up, so it cuts rather than sounding like a test tone.
    this.mode(2040, 0.012, length, 'square');
  }

  /** Contact made with a charging point. */
  charge(): void {
    if (!this.open('charge')) return;
    this.mode(140, 0.05, 0.10, 'square');
    this.tone(300, 1150, 0.28, 0.035, 'triangle', 0.05);
  }
}
