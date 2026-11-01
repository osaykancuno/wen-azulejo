# WEN AZULEJO

A game of [THE WALL ARCADE](https://6972mvu4.srstudio.dev/), the arcade played on the names of a real wall in Lisbon
(ON THE WALL by NFC Summit). By osaykancuno (K4NCUN0 on the wall).

Lisbon, NFC Summit. Fragments of azulejos land on a wall of 6 × 7 empty slots, in small linked groups of one motif.
**Drag across fragments of the same motif** (each touching the one before, sideways or diagonally), **or tap them one
after the other**, to complete an azulejo.

| What | Rule |
| --- | --- |
| Azulejo | 3 of a kind for the first 45 s, 4 of a kind after; up to 6 in one chain. 50 per fragment + 50 × (extra fragments)², × the multiplier |
| Streak | azulejos within 3 s of each other: ×2 from the 4th, ×3 from the 7th, ×4 from the 10th |
| Golden fragment | carries a name of the wall: completing it PAINTS the name on the wall (+200, one crack repaired). Each name once per run |
| Fall | a fragment left too long falls: −20 and a crack |
| Error | a chain that runs onto another motif, skips a slot or is too short: −50, a crack, the streak is over |
| Cracks | 12 and the wall crumbles: the run ends, no bonus |
| Survival | hold the wall 90 s: +2000 and +150 per crack left |

- 3 s countdown, then 90 s. The pace ramps evenly from the first second to the last: a group every 1.6–2.4 s at the
  start, every 0.8–1.2 s at the end, and fragments live 12 s at the start, 7 s at the end (SPEED in the HUD). Every
  22.5 s the motifs get more complex: 3 motifs, then 4 (LAÇO), then azulejos of 4 fragments, then 5 motifs (SOL).
- The score never goes below zero.
- Painted names become Lisbon street signs (RUA …) and their people walk down the calçada under the wall: their
  walking sprite from people.json, a pixel stand-in otherwise. Display only.
- The end card shows the pattern you made (every azulejo, in order), the score, your rank this week, your best, and the
  names you painted; POST ON X tags the painted names (@handle when known).

Players sign in with SuperRare Connect and spend 1 credit per run; the score is computed by SuperRare's server from the
game's own rules (`src/games/wen-azulejo/core.ts`, the very module the verifier runs). Practice is free, local and
unrecorded. The weekly leaderboard (Friday 15:00 to Friday 15:00, Lisbon) and the best score on this device are the
arcade's own page (`src/shell/`).

> A Remix The Wall experiment · NFC Summit 2027 · Lisbon — https://onthewall.nfcsummit.com

## Publish (Windows)

Double-click `PUBBLICA.cmd`. The first time it installs what is missing, logs in to SuperRare Studio, creates the app
once (`deploy/wen-azulejo.config.json`, a new app of its own), then builds and publishes; every later run updates the
same app. Details in [docs/wen-azulejo.md](docs/wen-azulejo.md) (Italian).

Elsewhere (Node.js 22+, `npm install --global @rareprotocol/rare-profile@0.1.0`, `rare-profile login`):

```sh
npm ci
npm run typecheck
npm test
npm run build -- --config deploy/wen-azulejo.config.json --output dist/wen-azulejo.zip --force
rare-profile app update <app-id> --zip dist/wen-azulejo.zip --max-attempts 10000 --json
```

Try it locally without a wallet (fake Connect, no real payment): `node --import tsx scripts/dev-flow.ts
dist/dev-wen-azulejo wen-azulejo`, then serve `dist/dev-wen-azulejo` on localhost (`?credits=3&signed=1`).

## Where things are

| Part | Files |
| --- | --- |
| Rules (deterministic engine, shared by the page and the verifier) | `src/games/wen-azulejo/core.ts` |
| Page schemas (the verifier's own checks) | `src/games/wen-azulejo/engine.ts` |
| Client: the wall, linking, street signs, calçada, end card | `src/games/wen-azulejo/client.ts` |
| Server verifier (`POST /v1`, no schema library) | `src/verifiers/wen-azulejo.ts` |
| Page entry | `src/entries/wen-azulejo.ts` |
| Tests: rules, latency, forged inputs, tampered states, replay, the built verifier | `tests/wen-azulejo.test.ts` |
| Publishing | `PUBBLICA.cmd`, `PUBBLICA.ps1`, `scripts/wen-azulejo-config.ts` |
| Names of the wall (build-time snapshot, refreshed by PUBBLICA) | `src/generated/wall.json`, `scripts/snapshot-wall.ts` |

The only game input is `{ "action": "join", "cells": [slot, …] }` (2 to 6 different slots 0–41), plus
`{ "action": "start" }`: never a score, a time or a state.

The rest (sign-in, credits, paid start, weekly leaderboard, Practice, the people of the wall's sprites) is
[THE WALL ARCADE's code](https://github.com/hs7j4yk4sz-boop/wall-arcade-connect), itself built on SuperRare's
[studio-games-example](https://github.com/superrare/studio-games-example): see `LICENSE` and `NOTICE` (MIT). The
arcade's other games (UNBREAKABLE, FULL ROW, TAP THE NAME) stay in `src/` because the shared page and its tests use
them; this repository builds and publishes WEN AZULEJO only.

Perfectly legal automated inputs are accepted by these rules: the game is not bot-proof.
