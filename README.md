# WEN AZULEJO

A game of [THE WALL ARCADE](https://6972mvu4.srstudio.dev/), the arcade played on the names of a real wall in Lisbon
(ON THE WALL by NFC Summit). By osaykancuno (K4NCUN0 on the wall).

Lisbon, NFC Summit. A wall of 6 × 7 azulejos, each with four coloured corners: a quarter of a circle each, as in the
real 2 × 2 azulejo patterns. **Tap a tile to turn it a quarter turn.** Where four tiles meet and their four corners share
a colour, the circle closes: a **rosette**.

| What | Rule |
| --- | --- |
| Rosette | +100, × the multiplier. Its four tiles are relaid with new ones half a second later; new tiles that close a rosette by themselves make a cascade (it counts) |
| Streak | rosettes within 3 s of each other: ×2 from the 4th, ×3 from the 7th, ×4 from the 10th |
| Turns | each tile takes 3 turns; a 4th turn that closes nothing cracks it: −30 and a crack |
| SOS Azulejo | now and then a tile comes loose and shakes: put it in a rosette before it falls (+50), or it falls: −30 and a crack |
| Golden tile | carries a name of the wall: a rosette with it PAINTS the name on the wall (+200, one crack repaired). Each name once per run, 3 on the wall at most |
| Cracks | 12 and the wall crumbles: the run ends, no bonus |
| Survival | hold the wall 90 s: +2000 and +150 per crack left |

- 3 s countdown, then 90 s. The pressure ramps evenly from the first second to the last: a tile comes loose every
  2.4–3.6 s at the start and every 0.7–1 s at the end, and holds 7.5 s at the start and 3.3 s at the end (SOS in the
  HUD). Every 22.5 s the wall gets more complex: new tiles come in 3 glazes, then 4 (MANGANÊS), then 4, then 5
  (TERRACOTA). The opening wall has no rosette closed.
- The score never goes below zero. Each glaze has its own mark (dot, diamond, leaf, ring, triangle): colour is never the
  only cue. A dotted circle marks a junction one corner away from a rosette.
- Painted names become Lisbon street signs (RUA …) and their people walk down the calçada under the wall: their
  walking sprite from people.json, a pixel stand-in otherwise. Display only.
- The end card shows the pattern you made (every rosette, in order), the score, your rank this week, your best, the
  tiles you saved and the names you painted; POST ON X tags the painted names (@handle when known).

Players sign in with SuperRare Connect and spend 1 credit per run; the score is computed by SuperRare's server from the
game's own rules (`src/games/wen-azulejo/core.ts`, the very module the verifier runs). Practice is free, local and
unrecorded. The weekly leaderboard (Friday 15:00 to Friday 15:00, Lisbon) and the best score on this device are the
arcade's own page (`src/shell/`).

> A Remix The Wall experiment · NFC Summit 2027 · Lisbon — https://onthewall.nfcsummit.com

## Publish (Windows)

The game is online at https://34s8u757.srstudio.dev (App ID `a592b9f0-9096-4c3f-a9f4-325aa7c349ef`, in
`deploy/wen-azulejo.config.json`, public: no key or secret). Double-click `PUBBLICA.cmd`: it installs what is missing, logs in to SuperRare Studio if needed, builds and updates the
app named in `deploy/wen-azulejo.config.json`. In a fresh copy without it, the script lists the WEN AZULEJO apps of
your account (address and App ID) and asks which one to update; it creates an app only when there is none, or when you
type NUOVA, and never touches an app with another title.
Each build stamps `index.html` with `<meta name="game-code" content="wen-azulejo@…">`, the fingerprint of the game's
code, and the script shows the one online next to the one it is about to publish. Details in [docs/wen-azulejo.md](docs/wen-azulejo.md) (Italian).

Elsewhere (Node.js 22+, `npm install --global @rareprotocol/rare-profile@0.1.0`, `rare-profile login`):

```sh
npm ci
npm run typecheck
npm test
npm run build -- --config deploy/wen-azulejo.config.json --output dist/wen-azulejo.zip --force
rare-profile app update <app-id> --zip dist/wen-azulejo.zip --max-attempts 10000 --json
```

Try it locally without a wallet (fake Connect, no real payment): `node --import tsx scripts/dev-flow.ts
dist/dev-wen-azulejo`, then serve `dist/dev-wen-azulejo` on localhost (`?credits=3&signed=1`).

## Where things are

| Part | Files |
| --- | --- |
| Rules (deterministic engine, shared by the page and the verifier) | `src/games/wen-azulejo/core.ts` |
| Page schemas (the verifier's own checks) | `src/games/wen-azulejo/engine.ts` |
| Client: the wall, turning, rosettes, street signs, calçada, end card | `src/games/wen-azulejo/client.ts` |
| Server verifier (`POST /v1`, no schema library) | `src/verifiers/wen-azulejo.ts` |
| Page entry | `src/entries/wen-azulejo.ts` |
| Tests: rules, latency, forged inputs, tampered states, replay, the built verifier | `tests/wen-azulejo.test.ts` |
| Publishing | `PUBBLICA.cmd`, `PUBBLICA.ps1`, `scripts/wen-azulejo-config.ts` |
| Names of the wall (build-time snapshot, refreshed by PUBBLICA) | `src/generated/wall.json`, `scripts/snapshot-wall.ts` |
| Local test page without a wallet; cold start of the built verifier | `scripts/dev-flow.ts`, `scripts/dev-serve.ts`, `scripts/measure-cold-verifier.ts` |

The only game input is `{ "action": "turn", "cell": 0–41, "id": <the tile in it> }`, plus `{ "action": "start" }`:
never a score, a time or a state. A tap on a tile that left its slot in the meantime does nothing.

The rest (sign-in, credits, paid start, weekly leaderboard, Practice, the people of the wall's sprites) is
[THE WALL ARCADE's code](https://github.com/hs7j4yk4sz-boop/wall-arcade-connect), itself built on SuperRare's
[studio-games-example](https://github.com/superrare/studio-games-example): see `LICENSE` and `NOTICE` (MIT). This
repository holds WEN AZULEJO only.

Perfectly legal automated inputs are accepted by these rules: the game is not bot-proof.
