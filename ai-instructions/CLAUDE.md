# RobotAutomationGame

A top-down 2D factory-automation incremental game about robots. Web-based
(TypeScript + Vite + raw WebGL2, no engine). The first level is a single grimy
warehouse hall with a flooded dock cut into it.

## What this is

Ground robots first, then flying, then water, then space — each new domain
should bring a **new verb**, not a bigger number. The player selects robots and
issues orders directly (RTS-style); automation is layered on top of that later.

The long-term target is very large robot counts. As of 2026-08-21 the WebGL
renderer holds ~26,000 robots at 30fps in one warehouse.

## Invariants — do not break these

1. **The bake is neutral.** `floorBake.ts` and `atlas.ts` produce albedo with no
   sun, no lamps, no time of day. Every lighting effect comes from the light
   pass. This is what lets one bake serve a full 24-hour cycle.
2. **Render pass order is fixed**: albedo → light (ambient, then additive
   sources, then shadows multiplied over the result) → composite (albedo × light)
   → glow (additive emissive) → overlay (unlit UI-in-world).
3. **Robot state lives in typed arrays** (`BotPool`), not per-robot objects.
   Anything added per robot goes in a parallel `Float32Array`/`Uint8Array`.
4. **Everything goes through `SpriteBatch`.** One buffer upload and one
   instanced draw call per batch. Never add a per-entity draw call.
5. **Nothing outside the warehouse shell is ever drawn.** The camera clamps to
   the shell (`Camera.fitZoom`), and the dock channel fades to black under the
   wall rather than revealing open sea.
6. **No visible grids.** The nav grid is an invisible acceleration structure and
   paths are string-pulled so movement is free-form. Floor joints, water edges
   and clutter must not read as a lattice.
7. **The level is procedural from one seed.** `buildLevelGeometry(seed)` and the
   bakes must stay deterministic.

<!-- launchpad:begin -->
## Launchpad

This project is tracked in **Launchpad**, a local service on http://localhost:7420 that owns
Mikkel's notes, ideas, and tasks for every project. **It is Launchpad project #31 ("RobotAutomationGame").**
Launchpad's database is the source of truth — not the markdown in this repo.

```bash
launchpad pull --json      # read this project's tasks/ideas/notes (nothing written to disk)
launchpad guide            # the full command set, with the push-plan schema
```

Every `launchpad` command run inside this folder targets project #31 automatically.
Write back with `launchpad task add "…"`, `launchpad idea add "…"`, `launchpad note add "…"`,
`launchpad set description "…"`, `launchpad tag add <name>`, or a batch `launchpad push plan.json`.

**Dev server ports.** This project has no port claimed yet. Before configuring a dev server, run `launchpad ports free` to get ports that are actually available, pick one, and claim it with `launchpad ports add <n>` so it shows up in Launchpad and nothing else takes it. One claim per process the project runs. A port another project already claims is refused, naming the project that holds it — ask for a free one rather than forcing it. Never assume a port is free because nothing is listening on it: `launchpad ports free` is the only list that accounts for what other projects have claimed.

`ai-instructions/LAUNCHPAD.md` is a **read-only mirror** — editing it changes nothing.
Agents archive rather than delete; nothing you do here is unrecoverable.
<!-- launchpad:end -->
