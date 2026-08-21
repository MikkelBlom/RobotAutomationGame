import type { Game } from '../core/game';

/**
 * Bottom-left settings and debug console. Deliberately plain DOM — it wants to
 * be crisp, scrollable and easy to extend, none of which the canvas gives us.
 */

const CSS = `
.dbg {
  position: fixed; left: 14px; bottom: 14px; z-index: 20;
  width: 268px; max-height: calc(100vh - 28px);
  display: flex; flex-direction: column;
  font: 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: 0.3px; color: #c9c4b8;
  background: rgba(12,14,16,0.86); backdrop-filter: blur(6px);
  border: 1px solid rgba(180,175,160,0.16);
  border-radius: 3px;
  box-shadow: 0 10px 34px rgba(0,0,0,0.5);
  user-select: none;
}
.dbg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 11px; cursor: pointer;
  border-bottom: 1px solid rgba(180,175,160,0.14);
  color: #e8b551; letter-spacing: 2px; font-size: 10px;
}
.dbg-head span.hint { color: #5d646b; letter-spacing: 1px; }
.dbg-body { overflow-y: auto; padding: 4px 0 8px; }
.dbg.collapsed .dbg-body { display: none; }
.dbg-sec {
  padding: 7px 11px 3px; color: #6f7780;
  letter-spacing: 1.6px; font-size: 9px; text-transform: uppercase;
}
.dbg-row {
  display: flex; align-items: center; gap: 8px;
  padding: 3px 11px; min-height: 20px;
}
.dbg-row label { flex: 1; cursor: pointer; }
.dbg-row input[type=range] { flex: 1.35; height: 3px; accent-color: #e8b551; cursor: pointer; }
.dbg-row input[type=checkbox] { accent-color: #e8b551; cursor: pointer; margin: 0; }
.dbg-val { width: 52px; text-align: right; color: #8fd6ef; font-variant-numeric: tabular-nums; }
.dbg-btns { display: flex; gap: 5px; padding: 4px 11px 6px; flex-wrap: wrap; }
.dbg-btns button {
  flex: 1; min-width: 46px;
  font: inherit; color: #c9c4b8; cursor: pointer;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(180,175,160,0.2); border-radius: 2px;
  padding: 4px 2px;
}
.dbg-btns button:hover { background: rgba(232,181,81,0.16); border-color: rgba(232,181,81,0.5); }
.dbg-stats {
  padding: 5px 11px 2px; display: grid;
  grid-template-columns: 1fr auto 1fr auto; gap: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.dbg-stats i { font-style: normal; color: #6f7780; }
.dbg-stats b { font-weight: 500; color: #8fd6ef; text-align: right; }
.dbg-clock {
  padding: 2px 11px 6px; font-size: 19px; letter-spacing: 3px; color: #e8b551;
  font-variant-numeric: tabular-nums;
}
.dbg-clock em { font-style: normal; font-size: 10px; color: #6f7780; letter-spacing: 1.4px; }
`;

export class DebugPanel {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly clockEl: HTMLDivElement;
  private readonly statEls = new Map<string, HTMLElement>();
  private readonly timeSlider: HTMLInputElement;
  private suppressTimeSync = false;

  constructor(private readonly game: Game) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'dbg';

    const head = document.createElement('div');
    head.className = 'dbg-head';
    head.innerHTML = '<span>CONSOLE</span><span class="hint">F1</span>';
    head.addEventListener('click', () => this.root.classList.toggle('collapsed'));
    this.root.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'dbg-body';
    this.root.appendChild(this.body);

    this.clockEl = document.createElement('div');
    this.clockEl.className = 'dbg-clock';
    this.body.appendChild(this.clockEl);

    const s = game.settings;

    this.section('Time of day');
    this.timeSlider = this.slider('hour', 0, 24, 0.05, game.clock.hour, (v) => {
      this.suppressTimeSync = true;
      game.clock.hour = v;
    }, (v) => formatHour(v));
    this.slider('day length', 20, 900, 5, s.dayLengthSeconds, (v) => {
      s.dayLengthSeconds = v;
    }, (v) => `${Math.round(v)}s`);
    this.checkbox('freeze time', s.timePaused, (v) => {
      s.timePaused = v;
    });
    this.slider('sim speed', 0, 4, 0.05, s.simSpeed, (v) => {
      s.simSpeed = v;
    }, (v) => `${v.toFixed(2)}x`);
    this.buttons([
      ['dawn', () => this.setHour(6.4)],
      ['noon', () => this.setHour(12)],
      ['dusk', () => this.setHour(18.7)],
      ['night', () => this.setHour(23)],
    ]);

    this.section('Render');
    this.checkbox('lighting', s.lighting, (v) => { s.lighting = v; });
    this.checkbox('water', s.water, (v) => { s.water = v; });
    this.checkbox('columns', s.columns, (v) => { s.columns = v; });
    this.checkbox('cargo', s.props, (v) => { s.props = v; });
    this.checkbox('floor grime', s.floorGrime, (v) => { s.floorGrime = v; });
    this.checkbox('shadows', s.shadows, (v) => { s.shadows = v; });
    this.checkbox('film grain', s.grain, (v) => { s.grain = v; });
    this.checkbox('vignette', s.vignette, (v) => { s.vignette = v; });
    this.slider('exposure', 0.3, 2.2, 0.02, s.exposure, (v) => { s.exposure = v; },
      (v) => v.toFixed(2));
    this.slider('wave force', 0, 2.5, 0.05, s.waveStrength, (v) => { s.waveStrength = v; },
      (v) => v.toFixed(2));

    this.section('Robots');
    this.checkbox('order trails', s.showPaths, (v) => { s.showPaths = v; });
    this.checkbox('battery drain', s.batteryDrain, (v) => { s.batteryDrain = v; });
    this.slider('charge pts', 0, 10, 1, s.chargePoints, (v) => {
      s.chargePoints = v;
    }, (v) => `${Math.round(v)}/10`);
    this.buttons([
      ['+1', () => game.spawnBots(1)],
      ['+10', () => game.spawnBots(10)],
      ['+100', () => game.spawnBots(100)],
      ['+1000', () => game.spawnBots(1000)],
    ]);

    this.section('Sound');
    this.checkbox('sound', s.sound, (v) => {
      s.sound = v;
      if (v) game.sfx.resume();
    });
    this.slider('volume', 0, 1, 0.02, s.volume, (v) => {
      s.volume = v;
      game.sfx.setVolume(v);
    }, (v) => `${Math.round(v * 100)}%`);
    this.buttons([
      ['grab', () => { game.sfx.resume(); game.sfx.grab(); }],
      ['place', () => { game.sfx.resume(); game.sfx.place(); }],
      ['no', () => { game.sfx.resume(); game.sfx.refuse(); }],
      ['paid', () => { game.sfx.resume(); game.sfx.money(); }],
    ]);
    this.buttons([
      ['doors', () => { game.sfx.resume(); game.sfx.doors(); }],
      ['truck', () => { game.sfx.resume(); game.sfx.truck(); }],
      ['beep', () => { game.sfx.resume(); game.sfx.beep(); }],
      ['charge', () => { game.sfx.resume(); game.sfx.charge(); }],
    ]);

    this.section('Diagnostics');
    const stats = document.createElement('div');
    stats.className = 'dbg-stats';
    for (const key of ['fps', 'frame', 'sim', 'draw', 'sprites', 'robots', 'selected', 'zoom']) {
      const label = document.createElement('i');
      label.textContent = key;
      const value = document.createElement('b');
      value.textContent = '—';
      stats.append(label, value);
      this.statEls.set(key, value);
    }
    this.body.appendChild(stats);

    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        this.root.classList.toggle('collapsed');
      }
    });
  }

  private setHour(h: number): void {
    this.game.clock.hour = h;
    this.timeSlider.value = String(h);
    this.suppressTimeSync = false;
  }

  private section(title: string): void {
    const el = document.createElement('div');
    el.className = 'dbg-sec';
    el.textContent = title;
    this.body.appendChild(el);
  }

  private row(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'dbg-row';
    this.body.appendChild(el);
    return el;
  }

  private checkbox(label: string, initial: boolean, onChange: (v: boolean) => void): void {
    const row = this.row();
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    const text = document.createElement('label');
    text.textContent = label;
    text.addEventListener('click', () => {
      input.checked = !input.checked;
      onChange(input.checked);
    });
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, text);
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    onChange: (v: number) => void,
    format: (v: number) => string,
  ): HTMLInputElement {
    const row = this.row();
    const text = document.createElement('label');
    text.textContent = label;
    text.style.flex = '0 0 66px';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    const value = document.createElement('span');
    value.className = 'dbg-val';
    value.textContent = format(initial);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = format(v);
      onChange(v);
    });
    row.append(text, input, value);
    return input;
  }

  private buttons(items: Array<[string, () => void]>): void {
    const row = document.createElement('div');
    row.className = 'dbg-btns';
    for (const [label, action] of items) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', action);
      row.appendChild(button);
    }
    this.body.appendChild(row);
  }

  /** Called once per frame from the game loop. */
  update(): void {
    const g = this.game;
    this.clockEl.innerHTML = `${g.clock.label()} <em>${phaseName(g.clock.hour)}</em>`;

    // While time is running, keep the slider following it — unless the user is
    // the one moving it.
    if (!this.suppressTimeSync && !g.settings.timePaused) {
      this.timeSlider.value = String(g.clock.hour);
    }
    this.suppressTimeSync = false;

    const set = (key: string, text: string): void => {
      const el = this.statEls.get(key);
      if (el && el.textContent !== text) el.textContent = text;
    };
    set('fps', String(g.stats.fps));
    set('frame', `${g.stats.frameMs.toFixed(1)}ms`);
    set('sim', `${g.stats.simMs.toFixed(2)}ms`);
    set('draw', `${g.stats.drawMs.toFixed(2)}ms`);
    set('sprites', String(g.stats.sprites));
    set('robots', String(g.stats.bots));
    set('selected', String(g.stats.selected));
    set('zoom', `${Math.round(g.camera.zoom * 100)}%`);
  }
}

function formatHour(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function phaseName(hour: number): string {
  if (hour < 5.2) return 'night';
  if (hour < 7.4) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17.4) return 'afternoon';
  if (hour < 19.6) return 'dusk';
  if (hour < 21.5) return 'evening';
  return 'night';
}
