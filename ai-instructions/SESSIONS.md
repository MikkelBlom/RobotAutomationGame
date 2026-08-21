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

---

## 2026-08-20/21 — Claude Code (Opus 5) — the haulage loop

Built the first real gameplay loop: pick a crate off the warehouse floor, carry
it to the docked trailer, set it down on a marked slot, repeat until the trailer
is full, watch it leave and come back.

**Crate taxonomy** — `src/sim/cargo.ts` is the single source of truth. Three
shapes (1x1, 1x2, 2x2) x two materials (timber, steel), sized off `CRATE_UNIT =
120`. `liftRefusal(hauler, material, shape)` returns a reason string or null;
`canLift` is the boolean wrapper. Hauler classes: Standard / Long / Big / Heavy.
The starting machine is Standard, so only timber 1x1 can be moved — everything
else is deliberately visible and out of reach until the other haulers exist.

**Crate art** — `src/render/crateArt.ts` maps (material, shape) to an atlas
region and a quad. The quad is ALWAYS derived from the shape's canonical
footprint; rotation handles quarter-turns. Using the world-axis footprint
together with `prop.angle` rotates twice — that was the bug behind "shadows are
rotated 90 degrees wrong on the long crates".

**Trailers** — 12 slots (3 across x 4 deep), filled from the far end back so the
robot never has to get past its own work. A trailer leaves only when it is full
AND `robotAtBay()` says nothing of ours is inside or heading in; if a robot
enters while the doors are closing they re-open. Away for 2.5-5 in-game hours,
then returns empty. Only the OUTERMOST bay is active (bay index `count - 1`).

**Order queue** — `queues` used to hold a flat `[x, y, ...]` list. It now holds
`QueuedOrder` records so fetch and deliver can be queued too. A queued fetch
holds the crate BY IDENTITY (indices shift as crates are spliced out of the
level); a queued delivery holds no slot at all and asks `onResolveDrop` where to
go at the moment it starts, because what is free depends on what got loaded in
between. Stale orders are skipped rather than stalling the queue.

**Interrupt safety** — `isBusy()` is true from the moment the arms start moving
until the lift finishes. Orders given during that window are queued instead of
replacing, so a robot can no longer drive off mid-lift. `settleGrab()` closes out
a grab that an API-level order cut short; without it `liftT` was left part-way
and the renderer drew the crate back at the spot it came from.

Measured after the speed pass: 200cm forward hop 0.48s, 600cm sideways 1.43s,
3000cm haul 5.78s. Full trailer (12 crates) loads, departs once the robot is
clear, and returns empty.

Not done: nothing was cut from this session's scope. Open items are in
FUTURE_IDEAS.md — the other three hauler classes, the other three bays, and
anything to do with what the trailer does with the cargo once it drives off.

---

## 2026-08-21 — Claude Code (Opus 5) — readability and the dock floor

Six pieces of feedback, all landed.

**Queue visualisation.** `Game.buildPlan()` projects each selected robot's whole
plan — active task plus queue — into a list of `PlanMark`s, booking trailer slots
forward so every future drop is marked in the slot it will actually use. Drawn
brightness-ranked by queue depth. `EntityRenderer.drawPlanMarks()` replaced both
`drawOrderMarks` and `LightingPass.collectDropGhost`; all marks now live in one
place, in the overlay pass. Queued legs also dog-leg at the slab edge so they
stop cutting through the north wall, and their dots are roughly twice as heavy.

**Free crate angles.** `buildProps` no longer quarter-turns. `Prop.w/h` is the
crate's own-frame footprint. The three call sites that used it were checked; two
needed nothing, one (the contact shadow) was double-rotating and is fixed.

**Dispatch plates.** One per bay — including shuttered ones, which read as
stations waiting to open. Hazard-striped sprung pad, armoured cable running to
the bay's right door post, caged beacon there that flashes red. Holding a robot
on it for `PLATE_DWELL` sends the trailer away however little is aboard. The
robot-inside interlock still applies, and the plate sits well clear of the mouth
so using it is never the thing that traps you.

**Rolling waypoints.** A queued plain-move leg no longer brakes to a halt at each
point. Grabs still stop dead.

**Quota board.** `src/render/board.ts` plus `src/sim/economy.ts`. On the north
wall at x 2600: shipped/quota, revenue, average seconds per crate. Housing in the
albedo pass, lit face and numbers in the emissive pass, so it reads at midnight
and at noon. Shipped goes amber until quota is met, then green — the only "you
are behind" the game says. Numbers come from a baked glyph strip, one texture.

**No text UI.** The refusal toast is deleted, `src/ui/toast.ts` with it.

Measured after: 3000 robots all selected with plan marks building every frame,
sim 3.12 ms, draw 1.59 ms. Plan marks capped at 40 so a thousand-robot selection
does not turn the readout into confetti.

Not done: nothing was cut. Refused orders are now silent by design — see
WORKING_NOTES "No explanatory UI, ever" before adding any feedback for them.
