# Sessions

## 2026-08-20 — Concept exploration (Claude Code)

Discussed the game concept. Established: web-first, robots, factory automation,
very large unit counts. Built a single-file HTML concept demo (`demo/warehouse-concept.html`)
with four art-style variants (grime / night shift / ink wash / riso) on one
top-down warehouse scene, Canvas2D.

Outcome: Mikkel liked the grime and night-shift looks and asked to merge them
into a day/night cycle. Rejected the proposed "reclamation/terraforming" theme —
no theme is settled yet. Canvas2D measured 30fps at ~1,750 robots, confirming
the need for a real GPU pipeline.

## 2026-08-21 — Real project: renderer, level, robots (Claude Code)

Replaced the HTML concept with a proper Vite + TypeScript + WebGL2 project.
Dev server on port 7443 (claimed in Launchpad).

Built: the 4-pass renderer, instanced sprite batching, procedural floor and
atlas bakes, the warehouse shell, the flooded dock, the water shader, the 24-hour
lighting cycle, the ground robot with nav/A*/collision, selection and order
handling with a waypoint queue, the animated order trail, and the bottom-left
debug console.

Iterated heavily on visuals against direct feedback. See WORKING_NOTES.md
"Things tried and rejected" — the hazard band took four attempts, the water
three, and the root cause of the general speckled look turned out to be noise
sample scales roughly 30x too high.

Corrections taken during the session:
- The dock must stay connected to open water (a sub pen), not be sealed off.
- Its shape wants clean 45° chamfers, not blobby irregular angles.
- The notches in the reference sketch are FLOOR reaching into the pool
  (boarding jetties), not water bulging out.
- Roof glazing should be evenly spaced and set back from the walls.
- Nothing should read as a grid.

Measured: ~26,000 robots at 30fps (Mikkel's machine), against 1,750 in the
Canvas2D concept.

Issues encountered: `requestAnimationFrame` does not fire in an uncomposited
browser pane, which masqueraded as broken robot movement for a while.

Not done: the loading dock in the top-right and fog of war (both specified this
session, not started). Water at extreme close zoom still leans abstract.

Next: loading dock + fog of war; then robot animation.
