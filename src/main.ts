import { Game } from './core/game';
import { DebugPanel } from './ui/debugPanel';

const stage = document.getElementById('stage');
const boot = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');

function fail(message: string): void {
  if (bootMsg) bootMsg.textContent = message;
  if (boot) boot.classList.remove('gone');
  console.error(message);
}

function main(): void {
  if (!stage) {
    fail('missing #stage');
    return;
  }
  try {
    if (bootMsg) bootMsg.textContent = 'baking floor';
    const game = new Game(stage);
    const panel = new DebugPanel(game);
    game.onFrame = () => panel.update();
    game.start();
    // Expose for console poking during development.
    (window as unknown as { game: Game }).game = game;
    if (import.meta.env.DEV) installDevSnapshot(game);
    requestAnimationFrame(() => boot?.classList.add('gone'));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Dev helper: renders one frame at an explicit size and posts it to the dev
 * server, which writes it to .dev-shots/. Works even when the page has no
 * layout (hidden panes, headless checks).
 */
function installDevSnapshot(game: Game): void {
  const snap = async (
    name = 'latest',
    width = 1600,
    height = 1000,
    opts: { hour?: number; zoom?: number; x?: number; y?: number; time?: number } = {},
  ): Promise<string> => {
    if (opts.hour !== undefined) game.clock.hour = opts.hour;
    if (opts.zoom !== undefined) game.camera.zoom = game.camera.targetZoom = opts.zoom;
    if (opts.x !== undefined) game.camera.x = opts.x;
    if (opts.y !== undefined) game.camera.y = opts.y;

    game.renderer.resize(width, height, 1);
    const viewport = { width, height };
    game.camera.clampToWorld(viewport);
    game.renderOnce(viewport, opts.time ?? performance.now() / 1000);

    const url = game.renderer.canvas.toDataURL('image/png');
    const res = await fetch('/__shot', {
      method: 'POST',
      headers: { 'x-shot-name': name },
      body: url,
    });
    return res.text();
  };
  (window as unknown as { snap: typeof snap }).snap = snap;
}

main();
