# Future ideas

Parked while working on something else. Not commitments.

## Rendering
- Move the water surface height into a small offscreen texture so robots,
  debris and hulls can react to the same wave field the shader draws.
- Wet-edge darkening on concrete that responds to the live surge, instead of
  the static damp ring currently in the bake.
- Bloom on lamp cores at night; currently only the tone-map shoulder holds them.
- Robot variants (chassis colour, wear, cargo) driven from a per-robot seed byte
  so a crowd does not look cloned.

## Simulation
- Flow fields instead of per-robot A* once squads get large — one field per
  destination, shared by every robot heading there.
- Move the sim into a Web Worker on a fixed 20Hz tick with render interpolation.
- Simulation level-of-detail: only the sector under the camera runs individual
  robots; everything else collapses to throughput. This is the thing that makes
  offline progress exact.

## Design
- Congestion as a solved property of the route network rather than something
  discovered by watching robots jam.
- The dock gate as a mid-game unlock: opening it changes the hall's lighting and
  lets weather in.
