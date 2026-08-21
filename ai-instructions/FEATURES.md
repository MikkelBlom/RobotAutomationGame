# Features

| Feature | Status | Notes | Date | Depends on |
|---|---|---|---|---|
| WebGL2 renderer, 4-pass pipeline | Implemented | albedo → light → composite → glow → overlay | 2026-08-21 | — |
| Instanced sprite batching | Implemented | ~26k robots @ 30fps measured | 2026-08-21 | — |
| Procedural floor bake | Implemented | Concrete, grime, cracks, puddles, wall ring | 2026-08-21 | — |
| Warehouse shell / walls | Implemented | Clad runs, sheet joints, posts, concrete kerb | 2026-08-21 | — |
| Flooded dock (45° cut) | Implemented | Boarding jetties are floor reaching into the pool | 2026-08-21 | — |
| Dock mouth open to sea | Implemented | Fades to black under the wall; no gate | 2026-08-21 | — |
| Hazard band | Implemented | Mitred offset ring, stripe angle fans round corners | 2026-08-21 | — |
| Water shader | Implemented | SDF-driven foam/depth, directional swell, edge surge | 2026-08-21 | — |
| Day/night cycle | Implemented | Keyframed 24h; one neutral bake, lighting does the rest | 2026-08-21 | — |
| Daylight pools from roof glazing | Implemented | Even strips, slide with the sun | 2026-08-21 | — |
| Sodium work lamps | Implemented | Ramp at dusk, some flicker | 2026-08-21 | — |
| Column + robot shadows | Implemented | Multiply into the light buffer, track the sun | 2026-08-21 | — |
| Ground robot | Implemented | Typed-array pool, tracked chassis sprite | 2026-08-21 | — |
| Nav grid + A* + string pulling | Implemented | Invisible grid; paths smoothed to free-form lines | 2026-08-21 | — |
| Robot collision | Implemented | Spatial-hash separation + slide along obstacles | 2026-08-21 | — |
| Drag-select / click-select | Implemented | Shift adds to selection | 2026-08-21 | — |
| Right-click move orders | Implemented | Squad destinations spread into a formation | 2026-08-21 | — |
| Shift+right-click waypoint queue | Implemented | Queued legs drawn dimmer and straight | 2026-08-21 | — |
| Animated order trail | Implemented | Cyan pulse along the remaining path | 2026-08-21 | — |
| Debug/settings console | Implemented | Bottom-left, F1 toggles. Time, render, spawn, stats | 2026-08-21 | — |
| Dev screenshot endpoint | Implemented | `window.snap()` → `.dev-shots/`, dev server only | 2026-08-21 | — |
| Real-world scale (1 unit = 1 cm) | Implemented | Sized from a Euro pallet up; hall is 120 x 84 m | 2026-08-21 | — |
| Loading dock, 4 bays | Implemented | Black seal when empty; lit trailer interior when occupied | 2026-08-21 | — |
| Dark outside the shell | Implemented | Everything beyond the walls is black except a docked trailer | 2026-08-21 | — |
| Track animation | Implemented | Four baked frames picked from distance driven | 2026-08-21 | — |
| Crate pickup with loader arms | Implemented | Reverse up, arms out, crate lifts onto the deck; right-click a crate | 2026-08-21 | — |
| Trailer arrive / depart cycle | Implemented | Reverses on, doors swing, dwells, closes, pulls away | 2026-08-21 | loading dock |
| Hull-accurate cargo collision | Implemented | Rect-vs-circle push-out, so turning cannot clip a crate | 2026-08-21 | — |
| Grime toggle | Implemented | Debug console; re-bakes the floor | 2026-08-21 | — |
| Crate taxonomy (3 sizes x 2 materials) | Implemented | 1x1 / 1x2 / 2x2, timber and steel; `src/sim/cargo.ts` | 2026-08-21 | — |
| Hauler class gating | Implemented | Standard lifts 1x1 timber only; Long / Big / Heavy refuse | 2026-08-21 | crate taxonomy |
| Set crates down in a trailer | Implemented | Reverses onto the mark, arms out, crate lowers into the slot | 2026-08-21 | crate pickup |
| Order marker on a targeted crate | Implemented | Amber corner brackets, pulsing, world-space | 2026-08-21 | — |
| Drop mark in the trailer | Implemented | Cyan ghost of the load at the next free slot; right-click to place | 2026-08-21 | trailer cycle |
| Trailer fill / depart / return cycle | Implemented | Leaves at 12/12 once clear, returns empty 2.5-5 in-game hours later | 2026-08-21 | trailer cycle |
| Robot-in-trailer safety interlock | Implemented | Doors re-open rather than shut a robot in and drive off | 2026-08-21 | trailer cycle |
| One bay unlocked | Implemented | Outermost bay only; the other three are shuttered | 2026-08-21 | loading dock |
| Queued fetch / deliver orders | Implemented | Shift-right-click stacks haulage jobs, not just waypoints | 2026-08-21 | waypoint queue |
| Grab is uninterruptible | Implemented | Orders during the animation queue instead of cancelling it | 2026-08-21 | — |
| Queue plan marks | Implemented | Every future pickup and drop marked, ranked by queue depth | 2026-08-21 | queued orders |
| Free-angle crates | Implemented | Dropped where they fell; approach snaps to the nearest face | 2026-08-21 | — |
| Dispatch pressure plates | Implemented | One per bay, cabled to a flashing beacon; sends a trailer early | 2026-08-21 | trailer cycle |
| Rolling waypoint handover | Implemented | Queued moves no longer brake to a halt at each point | 2026-08-21 | waypoint queue |
| Productivity board | Implemented | North wall: shipped/quota, revenue, average per crate | 2026-08-21 | ledger |
| Shift ledger / economy | Implemented | Crate values by material and size; resets at midnight | 2026-08-21 | — |
| Ship on departure | Implemented | Crates and money count when the truck pulls out, not when loaded | 2026-08-21 | ledger |
| Charging run, east wall | Implemented | Ten points, numbered from the south, all sealed; unlocking is a flag | 2026-08-21 | — |
| Robot battery / charging behaviour | Planned | The run exists as furniture; nothing drains or docks yet | — | charging run |
| Robot battery + on-hull readout | Implemented | Lit bar on the nose; colour and length follow charge, no UI element | 2026-08-21 | — |
| Flat-battery behaviour | Implemented | 16% speed, refuses to lift, still drivable | 2026-08-21 | battery |
| Charging at a live point | Implemented | Park on it; settles square, fills in 20s, feed pulses from the cabinet | 2026-08-21 | charging run |
| Procedural sound | Implemented | Synthesised; one fleet-wide drive bed plus throttled one-shots | 2026-08-21 | — |
| Buying a charging point | Planned | Nothing spends revenue yet, so flat is currently unrecoverable | — | charging run |
| Charging dock order | Implemented | Right-click a live point: green route mark, aligns on the way in | 2026-08-21 | charging run |
| Dispatch plate latch | Implemented | Lamp off once the truck goes; step off and on to re-arm | 2026-08-21 | dispatch plates |
| Runs while the tab is hidden | Implemented | Worker clock + real-elapsed catch-up, capped at 20s per tick | 2026-08-21 | — |
| Offline progress | Planned | Needs a rate model; long absences are currently just lost | — | runs while hidden |
| Long hauler / big hauler / heavy hauler | Planned | Needed for 1x2, 2x2 and steel crates respectively | — | hauler class gating |
| Bays 1-3 unlock | Planned | Presumably a progression cost | — | one bay unlocked |
| Flying robots | Planned | Must ignore terrain/congestion, cost energy | — | — |
| Water robots | Planned | Opens the dock as usable space | — | — |
| Props / machines on the floor | Planned | Deliberately deferred until the level is laid out | — | — |
| Save / offline progress | Planned | Rate model must be authoritative for this to be exact | — | — |
