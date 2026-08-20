# Working notes

## Architecture decisions (settled — do not re-litigate without reason)

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

## Things tried and rejected

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
