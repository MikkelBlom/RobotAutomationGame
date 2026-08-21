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

---

## 2026-08-21 — Claude Code (Opus 5) — shipping on departure, charging run

**Shipping moved to departure.** `Ledger.record` is gone, replaced by `ship(cargo)`
fired from `TrailerFleet.onDeparted` at the Closing→Leaving transition, and
`load(now)` fired from `Game.onDelivered`. Shipped and revenue are batched;
average-per-crate stays live off loading. See WORKING_NOTES for why they are
split.

**Quota dropped 24 → 12** because the hall only held 23 liftable crates, and the
crate clusters were thickened (`rng.int(6, 9)` per cluster) to make up for the
east service lane. 52 crates now, 29 of them liftable — a little over two loads.

**Ten charging points on the east wall**, `buildChargePads()`, numbered from the
south corner running north at 620 pitch. All locked. New atlas art: `chargeDock`,
`chargeDockSealed`, `chargePad`, `chargeGlow`. `LightingPass.collectChargers` /
`collectChargerGlow` / `collectChargerLights`. `buildProps` keeps a 950 cm
service lane along the east wall clear of cargo.

Verified: three crates loaded leave the board at 0/$0 until the plate dispatch
sends the trailer, then 3/$135 at the moment it starts rolling; a full twelve
does the same on its automatic departure. The average ticked 17.0 → 16.0 → 16.6
while loading, untouched by the departure.

Not done: nothing was cut. There is still no charging BEHAVIOUR — no battery, no
docking, no drain. The run is furniture with a working unlocked/locked flag and
the lit state already wired, waiting for whatever powers it.

---

## 2026-08-21 — Claude Code (Opus 5) — batteries, sound, and a nav deadlock

**Nav deadlock found and fixed.** Reproduced by sweeping every liftable crate
from six start points: one crate at 40 degrees hung reliably. Root cause and the
three-part fix are in WORKING_NOTES ("Nav and the overlap resolver disagreed").
Swept clean afterwards: 174 fetches, 208 move orders aimed into the bad band.

**Battery.** `bots.battery` 0..1, drained by driving (scaled by speed), idling
and each lift. Measured 0.0181 per crate end to end, so a full charge is about
55 crates or four and a half truckloads. Flat robots run at 16% speed (measured
5.6x slower over 30 m) and `startFetch` refuses them. Readout is two sprites on
the nose: a dark socket in the albedo pass and a lit bar in the glow pass, length
and colour both following charge.

**Charging.** Positional, no docking sequence: park on a commissioned point and
it fills at 1/20 per second, settling square with its nose to the cabinet. Feed
pulses run from the cabinet into the machine while it charges. Debug panel got
`charge pts` (0-10) and `battery drain`.

**Sound.** `src/audio/sfx.ts`, fully procedural. grab / place / refuse / money /
doors / truck / beep / charge one-shots plus a single fleet-wide drive bed.
Debug panel has sound on/off, volume, and a button per voice.

**Beacon and cable redrawn.** The square red light was a gradient overflowing its
atlas cell. The beacon is now a small base-plate-and-lens unit instead of a caged
circle, and the cable is thicker with saddle clips and a proper corner join.

Not done: nothing was cut. The open question is in the handoff — with zero
charging points commissioned by default there is no way back from a flat battery.
Drain was slowed to roughly three in-game days to keep that a long way off, but
it is a real dead end until a point can be bought.

---

## 2026-08-21 — Claude Code (Opus 5) — integration pass

Three notes from playing, all landed. Reasoning in WORKING_NOTES ("Making things
belong").

- **Charge gauge is now part of the hull.** Recess baked into all four body
  frames; only the light drawn over it, inset and held below full additive
  strength. `drawChargeSockets` deleted. Deck shortened 132 -> 118 art units and
  the sensor head moved forward to open the strip of chassis it sits in.
- **Plate cable redrawn** as a thin wandering run along a polyline baked by
  `layWire()`, and the beacon moved off the trailer's door post onto the pier
  outside the bay opening where a docked trailer cannot cover it.
- **First charging point commissioned by default** (`chargePoints: 1`).

Verified end to end after: three crates hauled, plate-dispatched, shipped at
3/$135 as the trailer rolled, then the robot driven to the point and charging
square at angle 0. 901 robots at sim 0.97 ms / draw 0.56 ms.

Not done: nothing cut.

---

## 2026-08-21 — Claude Code (Opus 5) — docking, sound rebuild, background running

- **Charging points are a real order.** `BotTask.Charge` + `orderCharge`, with a
  green corner-bracket route mark (`MarkKind.Dock`) and a two-stage drive-then-
  align exactly like a grab. `PlanMark.drop` became `PlanMark.kind` with three
  values. Right-clicking a commissioned pad issues it; it queues behind shift.
- **Beacon latch.** `Trailer.plateLatched` — see WORKING_NOTES. Verified: return
  while standing on the plate leaves the lamp off and does not dispatch; 12 s of
  standing does nothing; step off, step on, and it fires.
- **Sound rebuilt from scratch.** Motor and whine instead of noise, inharmonic
  modal synthesis for crates, a proper square reversing alarm, and a chopped
  sawtooth diesel with separate arrive and depart voices. Reasoning per sound is
  in WORKING_NOTES.
- **Runs in the background.** Worker-driven clock plus real-elapsed catch-up;
  `frame()` skips rendering while hidden so the two cannot both advance the sim.

Verified after: haul loop, plate dispatch, ledger, and a dock order landing the
robot exactly on the pad at angle 0 and charging. Background clock confirmed
advancing the sim 3.5 s of simulation with the page hidden and rAF stopped.

Not done: nothing cut. Offline progress beyond `MAX_CATCH_UP` (20 s) is lost —
see the handoff.

---

## 2026-08-22 — Claude Code (Opus 5) — reverse docking, marks, drain model

- **Marks recoloured by commitment**, not by kind. `PlanMark.committed`: cyan for
  the offered slot, green once a machine is actually on its way. The drop ghost
  crate is much more visible (alpha 0.30+ rather than 0.16).
- **Reverse-in docking.** New `Phase.Backing`; `DOCK_FACING` is now π so the
  machine ends nose-out with its gauge facing the hall. Odometer runs negative
  while reversing so the tracks turn the right way.
- **Coupler and arcs** replace the travelling green dots. `ChargePad.arm` and
  `.drawing` are runtime state on the pad; nothing charges until `arm > 0.94`,
  and the coupler stows once the battery is full. New atlas cells `chargeArm`
  and `spark`.
- **Drive bed quietened** substantially; see WORKING_NOTES for the numbers.
- **Drain model** rebuilt around what each action costs, laden driving included.
  Measured 29.4% of a charge for a full trailer.

Verified: reverse dock lands at exactly (11800, 7880) at 180°, coupler extends,
charges, retracts at full; committed marks green and the preview cyan; plate
dispatch still fires; 901 robots at sim 1.49 ms / draw 1.57 ms.

Not done: nothing cut.
