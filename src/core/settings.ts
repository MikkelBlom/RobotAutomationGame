/** Everything the debug panel can toggle. Kept in one place so the panel and
 *  the renderer never drift apart. */
export interface Settings {
  // Time
  dayLengthSeconds: number;
  timePaused: boolean;

  // Render toggles
  lighting: boolean;
  water: boolean;
  columns: boolean;
  props: boolean;
  /** Slab stains, puddles and wear. Off gives a clean slab for level layout. */
  floorGrime: boolean;
  shadows: boolean;
  grain: boolean;
  vignette: boolean;
  exposure: number;
  waveStrength: number;

  // Debug overlays
  showNavGrid: boolean;
  showCollision: boolean;
  showPaths: boolean;
  showStats: boolean;

  // Simulation
  simSpeed: number;
  /** Charging points commissioned, counted from the south end. */
  chargePoints: number;
  /** Off keeps every battery full, for looking at something else. */
  batteryDrain: boolean;

  // Sound
  sound: boolean;
  volume: number;
}

export function defaultSettings(): Settings {
  return {
    // One real second is one in-game minute. The shift runs 07:00 to midnight,
    // which is seventeen real minutes of play.
    dayLengthSeconds: 1440,
    timePaused: false,

    lighting: true,
    water: true,
    columns: true,
    props: true,
    floorGrime: true,
    shadows: true,
    grain: true,
    vignette: true,
    exposure: 1,
    waveStrength: 1,

    showNavGrid: false,
    showCollision: false,
    showPaths: true,
    showStats: true,

    simSpeed: 1,
    // One point commissioned from the start. With none there is no way back
    // from a flat battery, which is a dead end rather than a difficulty.
    // Every point sealed. The first one is the first thing money buys, and
    // needing it is what teaches the battery.
    chargePoints: 0,
    batteryDrain: true,

    sound: true,
    volume: 0.65,
  };
}
