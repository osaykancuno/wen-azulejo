// WEN AZULEJO: the rules (core.ts), the page's schemas (engine.ts) and the BUILT verifier, as Studio receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import {
  CELLS, COLS, MOTIFS, RULES, adjacent, checkState, createEngine, inputSchema, neighbours, parseInput, stateSchema,
  type AzState, type Tile,
} from '../src/games/wen-azulejo/engine.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('wen-azulejo');
const engine = createEngine(WALL_PANELS);
const OPEN = RULES.countdownTicks;
const PHASE2 = OPEN + 2 * RULES.phaseTicks;                // need 4 from here
const started = (seed: number): AzState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
/** A run at `tick` with exactly these fragments on the wall and no more arrivals. */
function scene(tiles: Partial<Tile>[], tick = OPEN, seed = 1): AzState {
  const s = engine.advance(started(seed), OPEN);          // the wall opens empty; the clock is then set to `tick`
  return { ...s, tick, play: { ...s.play, nextSpawn: 1_000_000, nextId: 100, tiles: tiles.map((t, i) => ({
    id: i + 1, cell: i, motif: 0, panel: 0, born: tick, dies: tick + 200, ...t })) } };
}
const join = (s: AzState, cells: number[], tick = s.tick): AzState => engine.applyInput(s, { action: 'join', cells }, tick);
const whats = (s: AzState): string[] => s.play.events.map((e) => e.what);
const at = (col: number, row: number): number => row * COLS + col;
const NAMED = WALL_PANELS.slice(0, 3).map((p) => p.p);

test('the scoring config: 3 s of countdown + 90 s of play, with room to start; the rule tables agree', () => {
  assert.deepEqual(CONFIG, { game: 'wen-azulejo', maxTicks: 2160, roundTicks: 1860 });
  assert.equal(CONFIG.roundTicks, RULES.countdownTicks + RULES.playTicks);
  const phases = RULES.motifs.length;
  assert.equal(RULES.playTicks, phases * RULES.phaseTicks);
  for (const table of [RULES.need, RULES.groupMin, RULES.groupMax]) assert.equal(table.length, phases);
  for (let p = 0; p < phases; p++) {
    assert.ok((RULES.motifs[p] as number) <= MOTIFS.length && (RULES.need[p] as number) <= RULES.maxChain);
    assert.ok((RULES.groupMin[p] as number) <= (RULES.groupMax[p] as number));
    if (p) assert.ok((RULES.motifs[p] as number) >= (RULES.motifs[p - 1] as number) && (RULES.need[p] as number) >= (RULES.need[p - 1] as number), 'never easier');
  }
  assert.ok(RULES.lifeEnd < RULES.lifeStart && RULES.intervalEnd < RULES.intervalStart);
});

test('geometry: neighbours are the up-to-8 touching slots, adjacency is symmetric and never a slot with itself', () => {
  assert.deepEqual(neighbours(0), [1, COLS, COLS + 1]);
  assert.equal(neighbours(at(2, 3)).length, 8);
  for (let a = 0; a < CELLS; a++) for (let b = 0; b < CELLS; b++) {
    assert.equal(adjacent(a, b), adjacent(b, a));
    assert.equal(adjacent(a, b), neighbours(a).includes(b));
  }
  assert.equal(adjacent(at(5, 0), at(0, 1)), false, 'no wrap from the end of a row to the next');
});

test('createRun validates its seed and config; same seed and inputs, same wall', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(2 ** 32, CONFIG)); assert.throws(() => engine.createRun('1', CONFIG));
  assert.throws(() => engine.createRun(1.5, CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'gate-rush' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  assert.throws(() => engine.createRun(1, { ...CONFIG, roundTicks: RULES.countdownTicks }));
  const a = engine.advance(started(42), 400), b = engine.advance(started(42), 400), c = engine.advance(started(43), 400);
  assert.deepEqual(a, b); assert.notDeepEqual(a.play.tiles, c.play.tiles);
  assert.ok(a.play.tiles.length > 0 || a.play.events.length > 0, 'fragments arrive');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the state round-trips through JSON');
  let stepped = started(42); for (let t = 1; t <= 400; t += 7) stepped = engine.advance(stepped, t);
  assert.deepEqual(engine.advance(stepped, 400), a, 'many small advances = one big advance');
  assert.throws(() => engine.advance(a, 399), /backwards/, 'time never moves backwards');
  assert.throws(() => engine.applyInput(a, { action: 'start' }, 12.5));
});

test('arrivals: nothing in the countdown; linked groups of one motif in play; free, cooled slots; each name once', () => {
  assert.equal(engine.advance(started(5), OPEN).play.tiles.length, 0, 'the countdown is empty');
  const motifsSeen = new Set<number>();
  let named = 0;
  for (let seed = 1; seed <= 25; seed++) {
    let run = started(seed), before = new Map<number, Tile>();
    for (let t = OPEN + 1; t < CONFIG.roundTicks - 10; t++) {
      run = engine.advance(run, t);
      if (run.gameOver) break;
      run = { ...run, play: { ...run.play, cracks: 0 } };            // keep the wall up to watch the whole run
      const fresh = run.play.tiles.filter((x) => !before.has(x.id));
      if (fresh.length) {
        const phase = engine.phaseAt(run, t);
        assert.ok(fresh.length >= (RULES.groupMin[phase] as number) - 2 && fresh.length <= (RULES.groupMax[phase] as number), `group of ${fresh.length}`);
        assert.equal(new Set(fresh.map((x) => x.motif)).size, 1, 'one motif per group');
        assert.ok(fresh.every((x) => x.motif < engine.motifsAt(run, t)), 'only the motifs of the phase');
        for (let i = 1; i < fresh.length; i++) assert.ok(adjacent((fresh[i - 1] as Tile).cell, (fresh[i] as Tile).cell), 'a group can be linked');
        assert.ok(fresh.filter((x) => x.panel).length <= 1);
        for (const x of fresh) { motifsSeen.add(x.motif); assert.equal(x.dies - x.born, engine.lifeAt(run, t)); }
      }
      assert.equal(new Set(run.play.tiles.map((x) => x.cell)).size, run.play.tiles.length, 'one fragment per slot');
      const panels = run.play.tiles.filter((x) => x.panel).map((x) => x.panel);
      assert.equal(new Set(panels).size, panels.length, 'a name is on the wall once at most');
      named += fresh.filter((x) => x.panel).length;
      before = new Map(run.play.tiles.map((x) => [x.id, x]));
    }
  }
  assert.equal(motifsSeen.size, MOTIFS.length, 'every motif shows up');
  assert.ok(named > 100, `names arrive (${named})`);
});

test('the pace ramps evenly from the first second to the last; the motifs grow every phase', () => {
  const s = started(1), open = engine.openTickOf(s);
  assert.equal(engine.lifeAt(s, open), RULES.lifeStart); assert.equal(engine.lifeAt(s, open + RULES.playTicks), RULES.lifeEnd);
  assert.equal(engine.intervalAt(s, open), RULES.intervalStart); assert.equal(engine.intervalAt(s, open + RULES.playTicks), RULES.intervalEnd);
  for (let t = open + 1; t <= open + RULES.playTicks; t++) {
    const dl = engine.lifeAt(s, t - 1) - engine.lifeAt(s, t), di = engine.intervalAt(s, t - 1) - engine.intervalAt(s, t);
    assert.ok(dl === 0 || dl === 1, 'life: one tick at most per tick'); assert.ok(di === 0 || di === 1);
  }
  assert.deepEqual([0, 1, 2, 3].map((p) => engine.needAt(s, open + p * RULES.phaseTicks)), RULES.need);
  assert.deepEqual([0, 1, 2, 3].map((p) => engine.motifsAt(s, open + p * RULES.phaseTicks + 5)), RULES.motifs);
});

test('a chain of one motif completes an azulejo: points × multiplier, slots cleared and cooled, the pattern grows', () => {
  let s = scene([{ cell: at(0, 0) }, { cell: at(1, 1) }, { cell: at(2, 1) }, { cell: at(4, 4), motif: 1 }]);
  s = join(s, [at(0, 0), at(1, 1), at(2, 1)], OPEN + 1);
  assert.deepEqual(whats(s), ['made']);
  assert.equal(s.play.score, engine.valueOf(3, 3)); assert.equal(s.play.score, 150);
  assert.equal(s.play.made, 1); assert.equal(s.play.combo, 1); assert.deepEqual(s.play.mosaic, [0]);
  assert.deepEqual(s.play.tiles.map((t) => t.cell), [at(4, 4)]);
  assert.equal(s.play.cool[at(1, 1)], OPEN + 1 + RULES.cooldown);
  // longer chains score more than their length: 4 of a kind when 3 make one
  const long = join(scene([0, 1, 2, 3].map((c) => ({ cell: c }))), [0, 1, 2, 3], OPEN + 1);
  assert.equal(long.play.score, RULES.perFragment * 4 + RULES.longBonus);
});

test('azulejos in a row multiply (×2 from the 4th), and the streak ends after 3 s without one', () => {
  const tiles: Partial<Tile>[] = [];
  for (let k = 0; k < 6; k++) for (let c = 0; c < 3; c++) tiles.push({ cell: at(c, k), motif: k % 3 });
  let s = scene(tiles), t = OPEN;
  const gains: number[] = [];
  for (let k = 0; k < 5; k++) { t += 10; const before = s.play.score; s = join(s, [at(0, k), at(1, k), at(2, k)], t); gains.push(s.play.score - before); }
  assert.deepEqual(gains, [150, 150, 150, 300, 300]);
  assert.equal(s.play.combo, 5); assert.equal(s.play.bestCombo, 5);
  s = engine.advance(s, t + RULES.comboWindow + 1);
  assert.equal(s.play.combo, 0, 'too slow: the streak is over');
  const before = s.play.score;
  s = join(s, [at(0, 5), at(1, 5), at(2, 5)], t + RULES.comboWindow + 2);
  assert.equal(s.play.score - before, 150); assert.equal(s.play.bestCombo, 5);
});

test('a golden fragment paints its name on the wall: a bonus, a crack repaired, each name once', () => {
  let s = scene([{ cell: 0, panel: NAMED[0] }, { cell: 1 }, { cell: 2, panel: NAMED[1] }]);
  s = { ...s, play: { ...s.play, cracks: 3 } };
  s = join(s, [0, 1, 2], OPEN + 1);
  assert.equal(s.play.score, 150 + 2 * RULES.painted);
  assert.deepEqual(s.play.painted, [NAMED[0], NAMED[1]]); assert.equal(s.play.cracks, 1);
  assert.deepEqual(s.play.events.at(-1)?.panels, [NAMED[0], NAMED[1]]);
  // a painted name never comes back
  let run = started(8);
  run = { ...run, play: { ...run.play, painted: engine.pool.slice(0, engine.pool.length - 2) } };
  for (let t = OPEN; t < OPEN + 900; t += 3) {
    run = engine.advance({ ...run, play: { ...run.play, cracks: 0 } }, t);
    for (const x of run.play.tiles) assert.ok(x.panel === 0 || !run.play.painted.includes(x.panel));
  }
});

test('errors: mixed motifs, a skipped slot or a chain too short cracks the wall, costs points and the streak, keeps the fragments', () => {
  const base = scene([{ cell: 0 }, { cell: 1 }, { cell: 2, motif: 1 }, { cell: 3 }, { cell: 4 }]);
  const rich = { ...base, play: { ...base.play, score: 500, combo: 2, bestCombo: 2, lastMade: OPEN } };
  for (const cells of [[0, 1, 2], [1, 0, 3], [3, 4]]) {
    const s = join(rich, cells, OPEN + 1);
    assert.deepEqual(whats(s), ['error'], JSON.stringify(cells));
    assert.equal(s.play.score, 500 - RULES.errorPenalty); assert.equal(s.play.cracks, 1); assert.equal(s.play.combo, 0);
    assert.equal(s.play.errors, 1); assert.equal(s.play.tiles.length, 5, 'nothing leaves the wall');
  }
  // too short once the azulejos need 4
  const late = scene([{ cell: 0 }, { cell: 1 }, { cell: 2 }, { cell: 3 }], PHASE2);
  assert.deepEqual(whats(join(late, [0, 1, 2])), ['error']);
  assert.deepEqual(whats(join(late, [0, 1, 2, 3])), ['made']);
  // the score never goes below zero
  const poor = join(scene([{ cell: 0 }, { cell: 1, motif: 2 }]), [0, 1]);
  assert.equal(poor.play.score, 0); assert.equal(poor.play.events.at(-1)?.gain, 0);
});

test('latency: a chain through a slot that emptied a moment ago does nothing (no points, no crack)', () => {
  let s = scene([{ cell: 0, dies: OPEN + 5 }, { cell: 1 }, { cell: 2 }]);
  s = engine.advance(s, OPEN + 5);
  assert.deepEqual(whats(s), ['fall']);
  const after = join(s, [0, 1, 2], OPEN + 8);
  assert.deepEqual(after.play, engine.advance(s, OPEN + 8).play);
  // and the emptied slot stays empty long enough for any chain in flight
  let run = started(3);
  for (let t = OPEN; t < OPEN + 600; t++) {
    const next = engine.advance(run, t);
    for (const x of next.play.tiles) if (!run.play.tiles.some((y) => y.id === x.id)) assert.ok((run.play.cool[x.cell] as number) <= t);
    run = { ...next, play: { ...next.play, cracks: 0 } };
  }
});

test('a fragment left too long falls: a crack and a penalty; twelve cracks end the run without a bonus', () => {
  let s = scene([{ cell: 7, dies: OPEN + 3 }]);
  s = { ...s, play: { ...s.play, score: 100 } };
  s = engine.advance(s, OPEN + 3);
  assert.deepEqual(whats(s), ['fall']); assert.equal(s.play.cracks, 1); assert.equal(s.play.score, 100 - RULES.fallPenalty);
  assert.equal(s.play.fallen, 1); assert.equal(s.play.tiles.length, 0); assert.equal(s.play.cool[7], OPEN + 3 + RULES.cooldown);
  const idle = engine.advance(started(9), CONFIG.roundTicks);
  assert.equal(idle.gameOver, true); assert.equal(idle.play.end, 'cracked'); assert.equal(idle.play.cracks, RULES.maxCracks);
  assert.equal(idle.play.bonus, 0); assert.ok(idle.tick < CONFIG.roundTicks, 'an idle wall crumbles long before the end');
  assert.equal(idle.play.tiles.length, 0);
});

test('holding the wall for 90 s pays the survival bonus; a finished run never changes', () => {
  const bot = playBot(77);
  assert.equal(bot.play.end, 'time', `the bot holds the wall (${bot.play.cracks} cracks)`);
  assert.equal(bot.play.bonus, RULES.survival + RULES.perCrackLeft * (RULES.maxCracks - bot.play.cracks));
  assert.ok(bot.play.made > 30 && bot.play.painted.length > 5, `made ${bot.play.made}, painted ${bot.play.painted.length}`);
  console.log(`  wen-azulejo bot (seed 77): score ${bot.play.score}, made ${bot.play.made}, painted ${bot.play.painted.length}, fallen ${bot.play.fallen}, cracks ${bot.play.cracks}, best combo ${bot.play.bestCombo}`);
  assert.ok(JSON.stringify(bot).length < 8192);
  assert.deepEqual(engine.applyInput(bot, { action: 'join', cells: [0, 1, 2] }, bot.tick + 1), bot);
  assert.deepEqual(engine.advance(bot, CONFIG.maxTicks), bot);
});

test('start: chains before the start or in the countdown are no-ops; a second start does not move the clock', () => {
  const fresh = engine.createRun(3, CONFIG);
  assert.deepEqual(join(fresh, [0, 1, 2], 2).play, fresh.play);
  const s = started(3);
  assert.deepEqual(join(s, [0, 1, 2], OPEN - 1).play, engine.advance(s, OPEN - 1).play);
  assert.equal(engine.applyInput(s, { action: 'start' }, 30).startTick, 0);
  // an input after the end changes nothing
  const over = engine.advance(s, CONFIG.maxTicks);
  assert.deepEqual(engine.applyInput(over, { action: 'start' }, CONFIG.maxTicks), over);
});

test('forged inputs never score, crack or change anything', () => {
  const s = scene([{ cell: 0 }, { cell: 1 }, { cell: 2 }]);
  const forged: unknown[] = [
    { action: 'join', cells: [0, 1, 2], score: 9999 }, { action: 'join', cells: [0, 1, 1] }, { action: 'join', cells: [0] }, { action: 'join', cells: [] },
    { action: 'join', cells: [0, 1, 2, 3, 4, 5, 6] }, { action: 'join', cells: [0, 1, CELLS] }, { action: 'join', cells: [0, 1, -1] },
    { action: 'join', cells: [0, 1, 2.5] }, { action: 'join', cells: ['0', '1', '2'] }, { action: 'join', cells: '0,1,2' }, { action: 'join' },
    { action: 'join', cells: { 0: 0, 1: 1, 2: 2 } }, { action: 'paint', cells: [0, 1, 2] }, { action: 'slam', lane: 0 }, { action: 'start', x: 1 },
    { cells: [0, 1, 2] }, null, 7, 'join', [], { score: 1e9 }, { action: 'join', cells: [0, 1, 2], tick: 0 },
  ];
  for (const input of forged) {
    const after = engine.applyInput(s, input, OPEN + 1);
    assert.deepEqual(after.play, engine.advance(s, OPEN + 1).play, JSON.stringify(input));
    assert.equal(parseInput(input), null);
    assert.equal(inputSchema.safeParse(input).success, false, 'the page refuses what the verifier refuses');
  }
  assert.ok(inputSchema.safeParse({ action: 'join', cells: [0, 1, 2] }).success);
});

test('checkState and the page schema refuse incoherent or tampered states (and agree)', () => {
  const s = engine.advance(started(4), 300);
  assert.ok(s.play.tiles.length > 1);
  assert.deepEqual(checkState(s), s); assert.equal(stateSchema.safeParse(s).success, true);
  const mutate = (f: (x: any) => void): unknown => { const c = structuredClone(s) as any; f(c); return c; };
  const bad = [
    mutate((x) => { x.extra = 1; }), mutate((x) => { x.play.extra = 1; }), mutate((x) => { x.play.score = -1; }), mutate((x) => { x.play.score = 1.5; }),
    mutate((x) => { x.play.cracks = RULES.maxCracks + 1; }), mutate((x) => { x.play.cracks = RULES.maxCracks; }), mutate((x) => { x.play.cool = [0, 0]; }),
    mutate((x) => { x.play.tiles[0].cell = CELLS; }), mutate((x) => { x.play.tiles[0].motif = MOTIFS.length; }), mutate((x) => { x.play.tiles[0].extra = 1; }),
    mutate((x) => { x.play.tiles[1].cell = x.play.tiles[0].cell; }), mutate((x) => { x.play.tiles.push({ ...x.play.tiles[0], cell: 41 }); }),
    mutate((x) => { x.play.tiles[0].id = x.play.nextId; }), mutate((x) => { x.play.tiles = Array(CELLS + 1).fill(x.play.tiles[0]); }),
    mutate((x) => { x.play.tiles[0].dies = x.tick; }), mutate((x) => { x.play.tiles[0].dies = x.play.tiles[0].born + RULES.lifeStart + 1; }),
    mutate((x) => { x.play.tiles[0].panel = 551; }), mutate((x) => { x.play.tiles[0].panel = 7; x.play.painted = [7]; }),
    mutate((x) => { x.play.tiles[0].panel = 7; x.play.tiles[1].panel = 7; }),
    mutate((x) => { x.play.end = 'time'; }), mutate((x) => { x.play.combo = x.play.bestCombo + 1; }), mutate((x) => { x.started = false; }),
    mutate((x) => { x.tick = x.rules.maxTicks + 1; }), mutate((x) => { x.rules.game = 'gate-rush'; }), mutate((x) => { x.seed = -1; }),
    mutate((x) => { x.play.painted = [3, 3]; }), mutate((x) => { x.play.mosaic = [MOTIFS.length]; }), mutate((x) => { x.play.lastMade = x.tick + 1; }),
    mutate((x) => { x.play.events = [{ seq: 1, tick: 0, what: 'made', motif: 0, cells: [0, 1, 2], panels: [], gain: 1, extra: 1 }]; }),
  ];
  bad.forEach((state, i) => {
    assert.throws(() => checkState(state), Error, `case ${i}`);
    assert.equal(stateSchema.safeParse(state).success, false, `case ${i}`);
  });
});

/* ------------------------------------- bot ------------------------------------- */
/** The best chain on the wall right now (longest up to `want`, names first, fragments closest to falling first). */
function bestChain(s: AzState, want = RULES.maxChain): number[] | null {
  const need = engine.needAt(s, s.tick);
  let best: Tile[] | null = null, bestKey = -Infinity;
  const tiles = s.play.tiles;
  const walk = (path: Tile[]): void => {
    if (path.length >= need) {
      const key = path.length * 10 + path.filter((t) => t.panel).length * 30 - Math.min(...path.map((t) => t.dies)) / 100;
      if (key > bestKey) { bestKey = key; best = path; }
    }
    if (path.length >= want) return;
    const last = path[path.length - 1] as Tile;
    for (const t of tiles) if (t.motif === last.motif && !path.includes(t) && adjacent(last.cell, t.cell)) walk([...path, t]);
  };
  for (const t of tiles) walk([t]);
  return best ? (best as Tile[]).map((t) => t.cell) : null;
}
/** A quick player: one chain every 15 ticks (0.75 s), sent 3 ticks after spotting it. */
function playBot(seed: number): AzState {
  let s = started(seed), next = 0;
  for (let t = 1; !s.gameOver && t <= CONFIG.maxTicks; t++) {
    s = engine.advance(s, t);
    if (t < next || s.gameOver) continue;
    const cells = bestChain(s);
    if (cells) { s = join(s, cells, t + 3); t = s.tick; next = t + 15; }
  }
  return s;
}

/* ------------------------------ the BUILT verifier ------------------------------ */
const ARCHIVE: Configuration = {
  appId: '00000000-0000-4000-8000-00000000a201', groupId: '60faaf46-ba4b-460c-a82a-adb852371a94', studioUrl: 'https://studio.superrare.com',
  apiUrl: 'https://api.superrare.com', connectUrl: 'https://connect.superrare.com', appOrigin: 'https://wen-azulejo-test.srstudio.dev',
  display: 'embed', game: 'wen-azulejo', hubUrl: 'https://6972mvu4.srstudio.dev/',
};
async function built() {
  const files = unzipSync(zipSync(await packageGame(ARCHIVE)));
  const verifier = await loadBuiltVerifier(files['server-verifier.js'] as Uint8Array);
  return { files, verifier, config: JSON.parse(strFromU8(files['scoring-config.json'] as Uint8Array)) as Record<string, unknown> };
}

test('wen-azulejo: the archive has Studio\'s root layout, the credit line, a zod-free verifier under 256 KB', async () => {
  const { files, config } = await built();
  for (const required of ['index.html', 'config.json', 'server-verifier.js', 'scoring-config.json']) assert.ok(files[required], `missing ${required}`);
  assert.ok(Object.keys(files).some((name) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name)), 'the page bundle under assets/');
  assert.deepEqual(config, CONFIG);
  const verifier = files['server-verifier.js'] as Uint8Array;
  assert.ok(verifier.byteLength < 256_000, `${verifier.byteLength} B`);
  assert.ok(!/ZodError|\$ZodType/.test(strFromU8(verifier)), 'zod-free verifier');
  assert.ok(!/gate-rush|GATE RUSH/.test(strFromU8(verifier)), 'nothing of GATE RUSH inside');
  const html = strFromU8(files['index.html'] as Uint8Array);
  assert.ok(html.includes('<title>WEN AZULEJO · THE WALL ARCADE</title>'));
  assert.ok(/remix the wall experiment/i.test(html) && html.includes('https://onthewall.nfcsummit.com'), 'the credit line, linked');
  const publicConfig = strFromU8(files['config.json'] as Uint8Array);
  assert.ok(!/secret|token|private|treasury|0x[0-9a-fA-F]{40}/i.test(publicConfig));
  assert.equal(JSON.parse(publicConfig).groupId, '60faaf46-ba4b-460c-a82a-adb852371a94');
  assert.equal(JSON.parse(publicConfig).game, 'wen-azulejo');
});

test('wen-azulejo: the BUILT verifier answers the conformance probe and rejects everything else', async () => {
  const { verifier, config } = await built();
  const probe = new Coordinator(verifier, config, 0);
  const state = await probe.create() as AzState;
  assert.equal(state.rules.game, 'wen-azulejo');
  assert.equal(await probe.score(), 0); assert.equal(await probe.isFinished(), false); assert.deepEqual(await probe.view(), state);
  const post = (payload: unknown) => verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
  assert.equal((await post({ version: 1, op: 'score', state: { ...state, bogus: 9 } })).status, 400);
  assert.equal((await post({ version: 1, op: 'submitScore', score: 999999 })).status, 400);
  assert.equal((await post({ version: 1, op: 'advance', state, serverTick: -1 })).status, 400);
  assert.equal((await post({ version: 1, op: 'applyInput', state, input: { action: 'start' }, serverTick: 1, score: 5 })).status, 400);
  assert.equal((await post({ version: 2, op: 'score', state })).status, 400);
  assert.equal((await post({ version: 1, op: 'createRun', seed: 1, config: { ...config, game: 'full-row' } })).status, 400);
  assert.equal((await verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'GET' }))).status, 404);
  // a forged input through the real envelope: a state unchanged but for the clock
  const forged = await post({ version: 1, op: 'applyInput', state, input: { action: 'join', cells: [0, 1, 2], score: 1e6 }, serverTick: 1 });
  assert.equal(forged.status, 200);
  assert.deepEqual(((await forged.json()) as { result: AzState }).result.play, state.play);
});

test('wen-azulejo: whole runs through the BUILT verifier, called every tick like the platform, equal the engine and replay exactly', async () => {
  const { verifier: raw, config } = await built();
  const times: number[] = [];
  const verifier = { fetch: async (request: Request): Promise<Response> => { const t0 = performance.now(); const r = await raw.fetch(request); times.push(performance.now() - t0); return r; } };
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<AzState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown, tick: number): Promise<void> => { await run.input(input, tick); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' }, 2);
    const rnd = mulberry32(seed ^ 0x99);
    let next = 0;
    while (!run.state.gameOver && run.tick < (config.maxTicks as number)) {
      await run.advanceTo(run.tick + 1); local = engine.advance(local, run.tick);
      if (run.tick < next) continue;
      const cells = bestChain(run.state);
      // a fallible player: sometimes slow, now and then a wrong link, a stale chain, or a forged input
      const r = rnd();
      if (cells && r < 0.85) { await send({ action: 'join', cells }, run.tick + 1 + Math.floor(rnd() * 3)); next = run.tick + 12 + Math.floor(rnd() * 10); }
      else if (r < 0.88 && run.state.play.tiles.length >= 2) { const [a, b] = run.state.play.tiles; await send({ action: 'join', cells: [(a as Tile).cell, (b as Tile).cell] }, run.tick + 1); }
      else if (r < 0.89) await send({ action: 'join', cells: [0, 1, 2], score: 99999 }, run.tick + 1);
    }
    await run.advanceTo(config.maxTicks as number); local = engine.advance(local, run.tick);
    assert.equal(run.state.gameOver, true);
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    const again = new Coordinator<AzState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state, 'same seed, same inputs at the same ticks: same run');
    console.log(`  wen-azulejo built verifier (seed ${seed}): ${run.calls} calls, end ${run.state.play.end}, score ${run.state.play.score}, made ${run.state.play.made}, errors ${run.state.play.errors}, painted ${run.state.play.painted.length}, largest state ${run.largestState} B`);
    assert.ok(run.largestState < 16_384);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] as number, p99 = times[Math.floor(times.length * 0.99)] as number;
  console.log(`  wen-azulejo built verifier: ${times.length} calls, median ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${(times.at(-1) as number).toFixed(2)} ms`);
  assert.ok(p99 < 3, `p99 ${p99} ms`);
});

test('wen-azulejo: the worst single call (an idle run advanced in one go) stays far under 10 ms', async () => {
  const { verifier, config } = await built();
  let worst = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const run = new Coordinator<AzState>(verifier, config, seed);
    await run.create(); await run.input({ action: 'start' }, 1);
    await run.advanceTo(config.maxTicks as number);
    worst = Math.max(worst, run.worstMs);
  }
  console.log(`  wen-azulejo built verifier: worst call ${worst.toFixed(2)} ms`);
  assert.ok(worst < 10);
});
