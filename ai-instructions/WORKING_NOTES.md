# Working notes

## Architecture decisions (settled — do not re-litigate without reason)

**One world unit is one centimetre, and everything is sized from something
real.** The Euro pallet (120 x 80) is the module: the robot is 165 x 105 so its
bed takes one, columns are 60 cm on an 11 m bay, the hall is 120 x 84 m. Before
this the scale was arbitrary and the proportions felt wrong — the hall read as a
room. If you add anything, size it from a real object.

**The floor bake renders at 0.30 texels per centimetre** (`BAKE_SCALE`). A 120 m
hall at 1 texel/cm would be a 12000 px texture. One texel is ~3.3 cm, so detail
authored below life size cannot land; floor wear is deliberately drawn coarser
than reality.

**Raw WebGL2, no engine.** Canvas2D measured 30fps at ~1,750 robots because it
issues one draw call per sprite. Instanced WebGL2 measured ~26,000 robots at
30fps in the same hall. Pixi/Phaser were considered and rejected: the art is
flat shapes plus custom shader passes, so their sprite/texture pipeline buys
little, and the lighting and water passes would have to fight it.

**One neutral bake, lighting does time of day.** The original HTML concept had
two separate art styles ("grime" = day, "night shift" = night). Merging them
into a lit scene means the bake carries no light at all and a single 24-hour
curve produces both. Consequence: the bake palette must stay mid-tone and
neutral — a light bake reads as washed-out chalk once daylight multiplies it.

**Shadows multiply the light buffer AFTER the additive sources.** Not physically
correct (a column does not know which lamp it occludes) but it means a column
standing in a pool of daylight cuts a dark streak through that pool, which is
the read we want, for one extra sprite per occluder.

**Typed-array robot pool.** Flat `Float32Array`/`Uint8Array` columns, no
per-robot objects. Paths and waypoint queues are the exception: they live in
sparse `Map`s, because only commanded robots have them and you command squads,
not a whole fleet.

**Nav grid is invisible.** 24-unit cells, A* with octile heuristic, then
string-pulled against line-of-sight. Robots are never snapped to it. This
matters — Mikkel pushed back hard on anything that reads as a grid.

## Never re-rasterise the whole nav grid during play

A full `NavGrid.rebuild` is ~70 ms over the 32,000 cells — a four-frame hitch.
It was being called on every crate pickup and every trailer docking, the latter
firing about every eight seconds. Use the targeted paths instead:

- `rebuildBayCorridors(bays)` — only the trailer apron and the first rows of
  slab inside the north wall. 0.18 ms.
- `clearAround(x, y, radius, props)` — only the cells a lifted crate covered.
  0.013 ms.

`rebuild` itself is for load time and wholesale level changes only.

## WORLD is not the building

`WORLD` is the camera's limit and includes the dark apron on every side.
`SHELL` is the building: floor plus its wall ring. Position walls, the dock
mouth and anything else structural from **SHELL**.

This caused two separate bugs. Walls were placed from `WORLD`, so once aprons
were added all round, the west wall was drawn 5 m out in the dark apron — the
building simply had no west wall — and the north and south walls overhung both
corners. The dock mouth's fade to black was anchored the same way and ended up
entirely off the end of the water, so the channel stopped dead against the wall
with no darkening.

## A cast shadow is a sweep, not an offset copy

A shadow is the object's footprint swept ALONG the light: it starts underneath
the object and stretches away, growing as the sun drops. `pushCastShadow` builds
that — quad rotated to the light, `(footprint + length)` long, centred half a
length away so its near end stays anchored.

Offsetting a scaled-up blob instead (the earlier approach) ignores the light
angle completely, and at large offsets the shadow detaches and floats with
nothing casting it. Shadow length also has to scale with object height: a
column's is several times a crate's for the same sun.

## Validate geometry, not just colour

A "visual pass" that only tunes palettes and shader constants will sail straight
past structural bugs. The following all shipped looking merely ugly, when in
fact they were broken:

- A loading bay placed **outside the east wall**, because the bay positions were
  a hardcoded first + spacing that nobody checked against `FLOOR.w`.
- **Trailers unreachable**: the nav grid covered only the slab, so trailer
  interiors were literally outside the pathfinder, and the north edge margin
  sealed the bay mouths for good measure. No route in could ever exist.
- **Crates drawn up to 206 cm** — nearly robot-sized — because `prop.size` fed a
  chain of magic multipliers rather than being the footprint in centimetres.
- **The starting robot spawned inside a column's clearance** once columns were
  enlarged, so it sat at full throttle re-planning forever without moving. Both
  the spawn and stuck robots now snap to the nearest walkable point.

Cheapest way to catch these: dump the numbers and compare them against the
building before looking at a single screenshot.

## Rendering gotchas found the hard way

- **Contact shadows belong in the ALBEDO pass, drawn before the objects.** Put
  in the light buffer, any part of a shadow overlapping its own object darkened
  that object — and seen from directly above, an object's shadow always starts
  underneath it, so there is no offset that avoids this. Drawn onto the floor
  first, each object simply covers its own shadow and the problem disappears.
- **Lamp pools stack.** A lamp on every other column, at the radii the art pass
  used, left no dark floor between them and the additive overlaps grade into
  odd greens and pinks. Every third bay, tighter radius.

- **The floor bake needs mipmaps.** It is ~3700 px across and gets minified
  hard at anything but close zoom. Without them it aliases into a shimmering
  diagonal moire that reads as dirt across the whole hall. `createTextureFromSource`
  takes `{ mipmap: true }`.
- **Never use `fract(sin(dot(p, k)) * large)` as a hash.** It loses precision
  and lays a visible diagonal weave over the frame — worst at night where the
  film grain is heaviest. The composite now uses an integer-style hash.
- **Soft ellipses do not make a floor.** Several hundred stacked at low alpha
  read as leopard print, not concrete. Broad tonal variation comes from a
  low-frequency value-noise field (`paintTonalField`); ellipses are only for
  small, definite things like oil and standing water.
- **Watch for amplitude dying through a chain of multiplies.** The water chop
  was passing through four separate dampings and arriving at a few percent of
  brightness, which is why the pool read as a flat gradient.
- **Domain-warp the long wavelengths only.** Warping the short chop as well
  curls the ripple lines into marbled smoke; ripple has to stay directional to
  read as a water surface.
- **Weight a wave spectrum towards SHORT wavelengths.** Loaded towards long
  ones there is no detail at working zoom. `waveAt` fades each wave out as its
  wavelength approaches pixel size, so short ripples can be used freely without
  aliasing when the camera pulls back.

## Things tried and rejected

- **Staggered boarding jetties.** The two quay fingers were at different x
  spans, which read as a mistake. They face each other now, leaving a 14 m
  channel with 40 m of quay down each side — a hull lies along it and crew can
  step across from either bank. The berth is what sets the basin's dimensions.
- **A robot sized without reference to its load.** The deck could not actually
  take a Euro pallet. It is now 240 x 150 cm, derived from the pallet plus
  handling clearance plus somewhere to stow the arms.
- **Circle-only collision against cargo.** The nav grid reasons about the
  robot's centre, so a machine turning on the spot beside a crate swept its nose
  straight through it. There is now a hull-rectangle-versus-circle push-out per
  frame, on top of the grid.
- **Anchoring the selection box in screen space.** Panning with WASD mid-drag
  dragged the box across the floor with the camera. The anchor is stored in
  world space, so the first click grounds it and panning extends the box.

- **Contact shadows centred on the object.** In a top-down view a shadow
  directly beneath something is hidden BY that thing, so a centred shadow drawn
  into the light buffer just darkens the object itself — crates got a dark blob
  painted on their lids and the robot turned into a smudge. Contact shadows are
  now pushed along the light direction by a fraction of the object's size, so
  only a crescent emerges.
- **Column drawn as an H-section.** From directly overhead the two flanges and
  the web read as seven loose squares stuck together. It is now one solid box
  section on a grouted base plate, and the heavy dark line around that plate is
  what actually stops it looking like it hovers.
- **Scaling detail counts and sizes together** when the hall grew 3.7x. Both
  went up, so the slab turned into leopard print. Counts should rise roughly
  with area, sizes only with what is actually visible at play zoom.

- **Water from a scrolling noise texture.** Tiled visibly at any usable scale.
  Replaced with crossed directional sines through a domain warp, which has no
  repeat period.
- **Noise sample scales around 0.02–0.14.** These sample far below feature size
  (`repeat = 1/scale`, `feature = repeat / lattice`, lattices are 11/23/47/89),
  so every "texture" was sub-pixel static. Correct range for ~20-unit features
  is roughly 0.0005–0.002. This was the cause of the speckled look throughout.
- **Chop travelling outward.** `sin(dot(p,d)*k + t*w)` moves in the **-d**
  direction. Every wave direction had a positive x component with `+ t*w`, so
  the whole pool appeared to drain out of the dock mouth. All chop terms now use
  `- t*w` with positive-x directions, so it drifts into the hall.
- **Swell `fract()` wrapping mid-pool.** The front's travel distance was shorter
  than the dock, so the cycle restarted while the wave was still on screen —
  visibly a reset. The front now starts three widths before the mouth and
  travels well past the far wall, so it has decayed to nothing at both ends.
- **Constant chop across the whole pool.** Enclosed water reads wrong when it
  is uniformly rippled. Chop is now scaled by the passing swell
  (`chop *= 0.26 + 0.9 * max(0, surge)`), so calm water is nearly flat and the
  swell raises its own crest.
- **Swell as a positive gaussian bump.** Painted a white band across the water.
  Now a *signed* ridge (gaussian derivative): trough ahead, crest behind, fed
  into the surface height so it reads as a moving ridge of light and shade.
  Foam only caps the very top of the ridge, and breaks properly at the shore.
- **Hazard band, four failed approaches before the current one**:
  (1) screen-space stripe pattern — stripes had no relationship to band
  direction and read as random black-and-yellow noise;
  (2) per-edge quads extended past their ends — visible seams and doubled
  wedges at every corner;
  (3) mitred wedges, one stripe angle per edge — clean, but a hard cut at each
  corner;
  (4) mitred wedges subdivided into ~14-unit steps with the angle blended
  towards the neighbour — no hard cut, but every sub-quad boundary stepped, so
  the stripe edges came out sawtoothed.
  **Current, and the right answer:** parameterise the outline by arc length.
  Each stripe is ONE polygon whose inner edge runs from arc length s to
  s + stripeWidth and whose outer edge runs from s + BAND to s1 + BAND (the
  arc-length offset is what makes it 45 degrees). Vertices falling inside a
  stripe's span are inserted into its path, so a stripe crossing a corner simply
  bends with it. No clipping, no per-segment angle, no seams.
- **Skylights as a grid of panels rotated to face the sun.** Turned the floor
  into a diamond lattice. Now even strips keeping their own orientation, sliding
  with the sun.
- **Full column lattice.** Read as a grid. Now three structural bay rows.

## Live concerns

- **Water at very close zoom** still leans slightly abstract. The wave field is
  believable in motion and at mid zoom; if it needs to hold up zoomed right in,
  it likely wants a real normal/height texture rather than analytic sines.
- **Robot sprite is one static image.** No track animation, no suspension
  movement. `velocity[]` is already tracked for this.
- **`grow()` in `BotPool`** reallocates every column and casts away
  `readonly`. Works, but it is the ugliest code in the sim. Pre-sizing the pool
  is the cheap alternative.
- **The simulation is now the bottleneck, not rendering.** At 3,000 robots:
  sim 2.05 ms/tick, draw 1.61 ms/frame, ~6.5k sprites after culling. That
  extrapolates to roughly 18 ms/tick at 26,000, which matches the 30fps Mikkel
  measured. Rendering has plenty of headroom; the next perf work belongs in
  `BotPool.update` (separation is the expensive half), or in moving the sim to a
  worker on a fixed tick.
- **Trail dots are capped at 4,000.** With a very large selection the trail
  silently truncates. Fine for now, but it is a silent cap.
- **`requestAnimationFrame` does not fire in a hidden/uncomposited tab**, so any
  automated check must step `bots.update()` by hand. Cost an hour of false
  "robots are not moving" debugging.

## Open questions

- Fog of war: per-pixel mask texture, or coarse tile visibility? The truck
  interior needs to be visible while everything else outside stays hidden, which
  argues for a mask texture the composite pass samples.
- Does the loading dock belong in the level polygon (a notch in the north-east
  wall) or as a prop layer on top of the shell?

## Gameplay-loop lessons (2026-08-21)

**A sprite's quad comes from the canonical footprint, never the rotated one.**
`Prop.w/h` are the WORLD-axis footprint — already turned by `prop.angle`. Passing
them to `pushRegion` *together with* `prop.angle` rotates the thing twice. Long
crates cast their shadow across themselves. Rule: pass `shapeSize(shape)` with
`prop.angle`, or `prop.w/h` with angle 0. Never mix.

**An index into a mutable array is not a handle.** Crates are spliced out of
`level.props` as they are collected, so every index above the removed one shifts.
Two bugs came out of this: the amber "about to be picked up" bracket jumped to a
different crate during the lift, and taking the LAST crate in the list aborted
its own lift (`props[index]` became undefined). Fixes: clear `targetProp` the
instant the crate leaves the floor, and hold queued fetches by object identity.

**A brake curve, not a linear ramp.** Arrival used `speed * (dist / 260)`, which
means a short hop never leaves first gear — a two metre nudge crawled the whole
way. `sqrt(2 * DECEL * dist)` runs flat out until it genuinely has to slow.
Same for cornering: `1 - |delta| / 1.4` came to a dead stop at 90°; 1.9 lets it
carry some speed through the turn.

**The queue must not jump the gun.** `advanceQueue` used to fire the moment a
path completed. A fetch's path completes when the robot reaches the standoff —
i.e. before the grab has played at all — so the next queued order immediately
abandoned the crate. The queue now advances when the TASK finishes, not when the
path does.

**Timber on timber is invisible.** Crates loaded into the trailer vanished into
the deck boards. A contact shadow under each one is what separates them. Same
principle as the floor props: the shadow goes into the albedo pass, before the
object.

**No text UI.** Refused orders fail silently — a toast was tried and rejected.
The feedback has to be in the world (the amber bracket, the cyan drop mark) or
not at all.

## Readability pass (2026-08-21, later)

**No explanatory UI, ever.** Mikkel's rule, stated plainly: *"I dont really like
games and UI that explain the purpose. I want to show not tell."* The toast that
narrated refusals is gone and nothing replaced it. Everything the player needs to
know is an object in the world — the amber bracket on a crate, the cyan mark in a
slot, the cable from a plate to a door, the board on the wall. If a future
feature seems to need a caption, the feature is wrong, not the rule.

**A queue nobody can read is not a queue.** Marking only the crate being fetched
right now told the player nothing about the three behind it. `Game.buildPlan()`
walks each selected robot's active task and then its order queue, tracking what
will be on the deck at every step and booking trailer slots forward, so the whole
job is on screen at once. Rank by brightness: depth 0 breathes, everything behind
it sits still and dimmer. That ordering IS the readout.

**Straight queue lines still need a doorway.** A straight leg from a crate to a
loading slot cuts through the north wall and out into the black, which reads as a
bug rather than a shortcut. Legs crossing `FLOOR.y` now turn at the slab edge,
both on the way in and on the way out — handling only one direction left every
trailer-to-floor leg slicing across the wall.

**Faint is not subtle.** The queued trail at `alpha 0.22` on 26 cm dots vanished
at any zoom wide enough to see the whole job. Doubled the dot and the alpha.

**Crates are not on a grid.** They used to be quarter-turned, which made the hall
read as a lattice. They are free-angle now and nothing broke, because the
approach code snaps to the nearest of the crate's OWN four faces — that works at
any base angle. `Prop.w/h` is the footprint in the crate's own frame, never the
world's; a world-axis box is meaningless at a free angle anyway.

**Brake curves, not arrival ramps, part two.** Queued waypoints each braked to a
halt before the next leg started. A leg with another plain MOVE behind it is now
"rolling": no brake, wider arrival radius, momentum carried across. Anything
ending in a grab still stops dead and squares up — that one has to be exact.

**The board is one texture.** Numbers are composed from a baked 16-glyph strip in
the main atlas rather than a live canvas texture, so the display costs no extra
texture bind and no re-uploads. `BOARD_FIELDS` in `atlas.ts` is shared by the art
and the renderer so the numbers land inside the panels drawn for them.

**Dispatch needs a dwell.** Standing on the plate sends the trailer away however
little is aboard, so merely driving across it on the way somewhere else would
dispatch a half-loaded truck. `PLATE_DWELL` is 1.3s with the beacon flashing
throughout: the hold is visible while it happens rather than a hidden timer.

## Shipping and the east wall (2026-08-21, later still)

**Loaded is not shipped.** Mikkel's rule: a crate counts, and its money arrives,
only when the truck pulls out — `TrailerFleet.onDeparted` fires once at the
Closing→Leaving transition and hands the whole cargo array to `Ledger.ship()`.
The board therefore sits at zero while a trailer fills, which is correct: the
trailer visibly filling IS the feedback, and a load still on the bay can still be
the one that gets left behind.

**The pace metric is not the shipping metric.** "Average per crate" is measured
on crates going ONTO a trailer (`Ledger.load`), not off in one. Tying it to
shipping would freeze it for a whole load, lurch when the truck goes, and then
degrade for hours while the trailer is away — none of which says anything about
how the machines are working. Shipped and revenue are the batched figures; the
average is the live one.

**A quota has to be reachable from what is in the building.** The daily quota was
24 against 23 liftable crates in the whole hall, so the board could only ever be
red. It is 12 now — one trailer — and the crate clusters carry a little more to
make up for the floor the east service lane took.

**The charging run is built locked.** Ten points on the east wall, numbered from
the south corner north, all `unlocked: false`. Sealed points draw a different
cabinet (transit cover, lockout tag) and their bay paint at 42% — the difference
has to be visible at a glance, because a whole wall of them is the game saying
"not yet" ten times over without a word of text. Unlocking is a flag; the live
cabinet, its contact glow and its light pool are already wired.

**Sprites that face a wall need a fixed authoring direction.** The charge cabinet
is authored with its connector towards +x and drawn rotated by π on the east
wall. Authoring it already-facing-west would have worked today and been wrong the
first time a point goes on another wall. Same reason the floor pad is drawn
closed at +x, open at -x: the bay is something to reverse into.

## Power, sound, and a nav deadlock (2026-08-21, evening)

**Nav and the overlap resolver disagreed by 36 cm, and that was a deadlock.**
The nav grid clears cargo using the robot's CIRCULAR radius (84) while
`resolvePropOverlap` pushes using the full hull rectangle (half-length 120).
Anything parked between those two numbers is somewhere nav calls walkable and
the resolver shoves out of, so the robot oscillates there forever. A fetch
standoff lands squarely in that band — which is exactly why it hung on one
particular crate and not its neighbours, and why the rotation seemed to matter:
it only bites when the hull's long axis points at the crate.

Three fixes, each needed:
- The crate a robot is working on never pushes it, at ANY phase (it used to be
  exempt only once the arms were out).
- `orderMove` runs its destination through `parkable()`, which shoves it clear
  of that band. Passing THROUGH the band is fine — a shove across the line of
  travel is what the separation pass is for. Stopping in it is what deadlocks.
- `STALL_LIMIT`: any drive that stops closing on its waypoint for 2.5 s gives
  the order up. A backstop, not the fix.

Swept afterwards: 174 fetches from six start points and 208 move orders aimed
deliberately inside the band, all clean.

**A gradient must reach zero inside its atlas cell.** The beacon glow ran its
gradient to 1.44x the cell, so it was clipped square at a still-bright alpha —
that is the "big square light". Same trap for anything drawn with
`createRadialGradient` into a cell.

**Sprite art must fill the quad it is drawn at.** The charge strip was authored
at 28% of its cell height and drawn on a 26 cm quad, so it rendered as a 7 cm
hairline. The cable had the same fault at 10%. If a sprite looks thin, check
what fraction of the cell the art occupies before touching the draw size.

**An unlit fitting cannot go in the glow pass.** The charge readout's socket is a
dark recess; pushed into an additive pass it contributes nothing and simply is
not there. Albedo for the recess, glow for the light inside it.

**`&&` where `||` was meant.** `drawFeed` looked up its charging point with
`if (|dx| > W && |dy| > H) continue;` — since every point shares an x, the guard
never fired and all three robots drew their feed at point zero. Two-axis box
tests reject on EITHER axis.

**The battery readout is a fleet instrument, not a gauge.** At the zoom where a
hundred machines are on screen each is a few pixels, so COLOUR carries the
meaning and the bar length is the detail you get when you lean in. Green to
amber to red, flat machines breathing a dull red. Two sprites per robot; 2000
robots measured at sim 3.23 ms, draw 2.19 ms.

**Sound is procedural and never per-robot.** `src/audio/sfx.ts` synthesises
everything from oscillators and one shared noise buffer — no assets to keep in
sync, same reasoning as the canvas-drawn art. The drive noise is ONE bed whose
level follows how much of the fleet is working on screen; a voice per machine
would be thousands of voices and a wall of mush. One-shots are throttled per
voice so twenty crates landing in a frame is one sound. Audio cannot start
without a real input event, so it waits for the first pointerdown or keydown.

**Refusals have a sound now, not words.** That is the only feedback a refused
order gets, and it is consistent with the no-text-UI rule.

## Making things belong (2026-08-21, late)

**A lit bar drawn over a robot is a health bar. A lit bar sitting in a machined
slot is an instrument.** The charge readout used to be a pill sprite plus a
separate socket sprite, both floating over the body, and it read as UI. The slot
is now baked into all four `botBody` frames — cut in before the wear pass, so it
scuffs along with the rest of the hull — and only the light is drawn over it.
`BOT_ART.gauge` carries the recess geometry in art units so the light is derived
from the same numbers the art used and can never drift out of its own housing.
Two more things mattered: the light is drawn a few centimetres INSIDE the well
so the bezel frames it on every side, and `GAUGE_GAIN` holds it below full
additive strength — at 1.0 it blew out its own housing and looked pasted on
again. Cost also dropped: one sprite per robot instead of two.

**Subtle means thin AND wandering.** The plate cable went from a hairline, to a
clipped conduit that read as a chain, to what it should have been: a plain
17 cm cable following a baked polyline that eases across the gap with a sine
wander on the normal. A right angle across a factory floor looks like a diagram;
something somebody actually laid wanders. `layWire()` in `level.ts` bakes it
once — it never changes, so it has no business being recomputed per frame.

**Mount things where they can be seen, not where they are wired.** The beacon was
on the trailer's door post, which is correct engineering and completely useless:
a docked trailer covers it. It sits on the pier outside the bay opening now. If a
fixture's whole job is to be seen, that beats where the cable would really run.

**One charging point starts commissioned.** With none there is no way back from a
flat battery, which is a dead end rather than a difficulty. When points become
purchasable this can go back to zero — but only then.

## Sound, background running, and docking (2026-08-21, night)

**Noise is a last resort.** The first sound pass built almost everything from
filtered noise and it was television static. What each thing actually is:
- An electric drive is TONAL. Two detuned sawtooths well lowpassed for the
  motor, plus an inverter whine that tracks speed hard — that rising note under
  load is most of what makes a drive read as electric. Noise stays, but rolled
  off below 190 Hz so it is felt rather than heard.
- A wooden crate is a set of INHARMONIC resonant modes. `CRATE_MODES` is five
  partials with no harmonic relationship, each with its own short decay. The
  inharmonicity is what stops it sounding like a drum. A set-down is two hits,
  the second smaller: one hit sounds dropped, two sound set down.
- A reversing alarm is a near-pure SQUARE around a kilohertz with a brutal
  envelope, and long enough to be a beep rather than a tick.
- A diesel is a low sawtooth CHOPPED by a square LFO at the firing rate. The
  chop is the whole trick: unmodulated it is a hum, gated twenty times a second
  it is an engine. Arrive and depart are now separate voices with their own
  rev direction, because a truck pulling away was silent before.

**The preview pane reports `document.hidden === true`.** That is why
`requestAnimationFrame` never fired in it, and it now also means `frame()`
correctly refuses to render there. Any scripted test that drives `g.frame()` by
hand must first override `document.hidden` to false, or the calls silently do
nothing and the robot appears wedged at spawn. Cost me a while.

**Background running is a worker timer plus real-elapsed catch-up.** rAF stops
dead for a hidden page. A worker's `setInterval` keeps firing where a page timer
would be clamped to once a second, and each tick advances the sim by the real
time that has passed rather than a fixed step, so the result is the same however
hard the browser throttles. The catch-up is STEPPED at 0.05 s — the movement and
separation code assumes a frame-sized dt and handing it thirty seconds at once
walks robots through walls — and capped at `MAX_CATCH_UP`, because simulating
minutes of backlog would lock the page up on return. Proper offline progress
needs a rate model, not a fast replay.

**Standing on a button is not pressing it.** `Trailer.plateLatched` latches as
soon as the plate has been acted on and clears only when the robot actually
steps off. It also latches while there is no trailer to dispatch, so parking
there through a departure and a return does not fire the instant the next one
backs on.

**Docking is the same two-stage shape as a grab.** Right-clicking a charging
point is now a real `BotTask.Charge` with its own green route mark, driving to a
standoff and then running an align phase, rather than drifting to the middle of
whatever pad it happened to stop on. `DOCK_STANDOFF` is the single number the
approach point and `grabReach` are both derived from, so they cannot disagree.

## Marks, couplers and drain (2026-08-22)

**Colour marks by COMMITMENT, not by kind.** Amber for a pickup, cyan for a drop
and green for a dock made the player learn three signals for one idea, and still
left them unable to tell an order they had given from a slot the game was merely
offering. Now: cyan is a suggestion (the slot a delivery WOULD use), green is a
commitment (something a machine is actually on its way to). `PlanMark.committed`
carries it. What differs between kinds is drawn INSIDE the brackets — a ghost
crate for a drop, nothing for a dock — not the bracket colour.

**A machine reverses onto its charger.** Driving to the edge and rotating into
place read as floating. `Phase.Backing` is a fifth phase after Aligning: square
up in FRONT of the bay nose-out, then reverse straight back along the hull with
the odometer running negative so the tracks turn the right way. Nose-out also
puts the charge gauge where it can be read from the hall. `DOCK_APPROACH` is the
one number both the approach point and the align standoff come from.

**Full extension has to land ON the thing.** The coupler's first numbers put its
head 85 cm inside the robot's hull, which hid the head and every arc it struck.
Cabinet face to hull rear is 99 cm; the reach is 24 + 78 = 102. Anything drawn at
a contact point needs its geometry derived from both bodies, not guessed.

**Arcs are lines, not glows.** A soft dot at a contact reads as a lamp. The
`spark` cell is a jagged path drawn twice, a wide dim pass under a tight bright
one, which is where the bloom comes from. They are struck from `hash2(beat,
index)` rather than `Math.random`, so a paused frame does not reshuffle them and
each point in the run flickers on its own schedule.

**The ambient bed is the sound you hear for the whole session.** It was mixed
like an effect. Level down from 0.26 to 0.085, the inverter whine from 0.055 to
0.018 and its sweep pulled down out of the piercing range, and the activity
curve changed from `0.35 + n/8` to `0.22 + sqrt(n)/9` so a busy hall no longer
sits permanently at the ceiling.

**Drain by what the work costs.** Idle is nearly free, driving scales with
speed, driving with a crate aboard costs 1.65x driving empty, lifting costs more
than setting down. Measured: a full trailer of twelve crates uses 29.4% of a
charge, so the first load leaves 70% in the tank and a charge is worth about
three and a half trailers.

## Cost layers, and things that must not reset (2026-08-22, later)

**Passable-but-penalised needs a cost layer, not a block.** Dispatch plates
could not be blocked (a robot sent to one has to reach it) and could not be
ignored (crossing one in transit sends a trailer away by accident). `NavGrid`
now carries an `avoid` layer beside `blocked`: A* multiplies the step cost by
`AVOID_COST`, and the trip waives the penalty entirely when the GOAL is on
penalised ground. Three places all had to agree or the dodge leaked:
- the A* step cost,
- the straight-shot shortcut in `findPath`,
- `smooth()` — string-pulling would otherwise straighten a carefully routed
  path right back through the ground the search paid to avoid.

**And `nearestFree` has to know about it too.** With it unaware, a destination
NEXT to a plate got snapped ONTO the plate, which then made the pathfinder think
the plate was the goal and waive the penalty for the whole journey. It now
prefers unpenalised ground unless the requested point is itself penalised —
which is exactly the rule that keeps clicking the plate working.

**Scaling a sprite scales its end caps.** The battery gauge shrank horizontally,
so a half-empty bar still finished in a half circle and read as a shrunken bar
rather than a drained one. Fixed by drawing a horizontal SLICE of the texture
(interpolating `u1`) at the matching width, so the geometry is cut, not squashed.

**A trail keyed off `state === Moving` disappears exactly when it matters.** A
robot mid-grab has no path — it has arrived — so the whole route including the
queued legs blanked for the several seconds the animation takes, which is
precisely when you are looking to see what it does next. The loop now runs for
anything with a path OR a queue.

**Pace is a property of the factory, not the calendar.** `avgSeconds` reset at
midnight, so the board read a wild number for the first crate of each day and
settled down by evening, throwing away every measurement as it became
meaningful. It is a lifetime mean now. `shippedToday` still rolls over, because
that one genuinely is a daily figure.

**A closed bay is not an empty bay.** The three shuttered docks were black
openings, which read as bays whose truck was late. They have roller shutters
baked into the floor now — slats, guide rails, a padlock — and no dispatch
plate, because a dead plate wired to a shut door is furniture that looks like a
control.

## The rate model (2026-08-22, agent)

`src/sim/rateModel.ts` projects what the factory WOULD have produced over a
stretch of time, in closed form, instead of replaying the simulation. It is not
wired into `game.ts` yet — `MAX_CATCH_UP` is the boundary where it would take
over from live replay.

**Shape.** Lanes (one per crate kind, not per hauler class — the class lattice
is not a total order, so a fixed class-to-crate assignment strands a Heavy
beside a pallet it could lift). Cohorts (identical robots collapse to one row,
which is why cost is flat in fleet size). Segmented integration to the next
event, each segment O(1): 30 days costs 0.08 ms with one robot, 1.1 ms with
5,000.

**Losses are layered and each gap is charged to a named limit** —
capability → alive → offeredIfStocked → fleetRate → rate — so `breakdown`
answers "why was I slow", which is the number the game will eventually want to
show.

**Only one fitted coefficient** (`pathSlack = 1.12`). Everything else is derived
from the simulation's own constants. The validation worth knowing: the two
measurements it was checked against (22 s per crate, 0.0245 charge per crate)
depend on distance through DIFFERENT constants, so solving one for route length
and predicting the other is a real test — it lands 1.3% out with nothing tuned.

**Two traps when integrating**, both from the model's own notes:
- Pass the load point as the MIDDLE of the slot run, not the next free slot.
  Slot 0 is ~6 m deeper into the bay and makes every projected cycle a fifth too
  slow.
- Never call `ledger.load()` on a projection. `avgSeconds` is a measurement of
  machines working; inventing one for a stretch nobody watched is a lie on the
  board.

**Known gaps**: congestion is not modelled at all (fine until fleets are large
enough to shove each other); `pickLane` is greedy rather than an optimal
assignment (exact with one hauler class); the floor is a fixed stock with no
inflow.

**Fragility to fix at some point**: every timing constant the model needs is
module-private in `bots.ts`/`trailers.ts` and is mirrored in `RATE_CONSTANTS`.
Exporting them would remove the whole class of drift.

## Building the intro, the shop and the water (2026-08-22)

**Capability is a packed integer.** `deck * 100 + weight`. Packed rather than a
pair of fields so it can live in a typed array beside the rest of the robot
state AND be a Set key where something asks which capabilities can serve a
crate. `Uint16Array`, not `Uint8` — a full-deck heavy hauler is 402.

**The boat's cargo is injected into `level.props`.** Tagged `onBoat`. That makes
collecting from a deck go through exactly the same code as collecting from the
floor: order marks, approach, nav, animation, all of it. Deck cargo is skipped
by the nav grid and by the overlap resolver, because a deck loaded on a 120 cm
pitch would be solid to the pathfinder and nothing could reach a single crate.

**Three geometry traps in the boarding ramps**, all of which made the deck an
unreachable island:
1. The ramp must clear the WATER CLEARANCE margin, not just the gap to the
   jetty. Robots are held back from the edge by their radius plus the margin, so
   a ramp that merely touched the jetty landed on ground the pathfinder already
   refuses. 210 cm of gap needed a 520 cm ramp.
2. The deck and ramp regions must OVERLAP. Both are inset by a robot radius when
   the pathfinder asks, and two regions that merely touch leave a band between
   them belonging to neither.
3. `inBayCorridor` measured the back of a trailer from `NAV.y0`. Extending the
   grid north for the upgrade room silently extended every trailer with it.

**Drain off must not mean refill.** The upgrade room stops battery drain by
passing `drainEnabled: false`, which the debug toggle had implemented as
`battery = 1`. The room was quietly topping every machine up, which would have
made the whole battery pointless. They are separate concerns now.

**Atlas rows fill up silently.** `shopFloor` and `shopPlate` were dropped at
[512,1024] and [768,1024], both already taken, so the upgrade room came out
tiled with sealed charging cabinets. There is a row map in `atlas.ts`; check it
before adding a cell.

**Draw order: `drawUnder` before props.** A boat hull and a shop floor are
things other objects stand ON. Drawn in the same pass as the machines, the hull
covered its own cargo.

**Purchases have to apply while you are still standing there.** The shop's early
return skipped `applyChargeUnlocks`, so a commissioned point stayed sealed until
the machine drove back out.
