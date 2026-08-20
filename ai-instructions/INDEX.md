# ai-instructions — what each file is for

Read this first if you are new to the project.

| File | Purpose | Update when |
|---|---|---|
| `CLAUDE.md` | Project identity and the invariants that must not be broken. | Fundamentals change (rarely). |
| `INDEX.md` | This file. | A new notes file is added. |
| `FEATURES.md` | What is actually built vs. planned. | Every session. |
| `WORKING_NOTES.md` | Architecture decisions, live concerns, things tried and rejected. | Every session. |
| `SESSIONS.md` | Chronological log of work sessions. | End of every session. |
| `FUTURE_IDEAS.md` | Ideas parked while working on something else. | Whenever one occurs. |
| `LAUNCHPAD.md` | Read-only mirror of Launchpad project #31. Editing it does nothing. | `launchpad pull`. |

## Running it

```
npm install
npm run dev      # http://localhost:7443 (port claimed in Launchpad)
npm run typecheck
```

`.dev-shots/` holds frames captured by the dev-only `/__shot` endpoint
(see `vite.config.ts`). Call `window.snap(name, w, h, {hour, zoom, x, y})`
from the browser console. Gitignored.
