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
