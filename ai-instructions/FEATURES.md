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
| Crate pickup with loader arms | Implemented | Reverse up, arms out, load onto deck; right-click a crate | 2026-08-21 | — |
| Hull-accurate cargo collision | Implemented | Rect-vs-circle push-out, so turning cannot clip a crate | 2026-08-21 | — |
| Grime toggle | Implemented | Debug console; re-bakes the floor | 2026-08-21 | — |
| Flying robots | Planned | Must ignore terrain/congestion, cost energy | — | — |
| Water robots | Planned | Opens the dock as usable space | — | — |
| Props / machines on the floor | Planned | Deliberately deferred until the level is laid out | — | — |
| Save / offline progress | Planned | Rate model must be authoritative for this to be exact | — | — |
