// WEN AZULEJO · ROSÁCEA: the rules (core.ts), the page's schemas (engine.ts) and the BUILT verifier, as Studio receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import {
  CELLS, COLORS, COLS, RULES, VCOLS, VERTS, checkState, cornersOf, createEngine, inputSchema, parseInput, stateSchema, turned, verticesOf,
  type AzState, type Tile,
} from '../src/games/wen-azulejo/engine.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const CONFIG = scoringConfiguration('wen-azulejo');
const engine = createEngine(WALL_PANELS);
const OPEN = RULES.countdownTicks;
const NAMED = WALL_PANELS.slice(0, 4).map((p) => p.p);
const started = (seed: number): AzState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
/** A tile whose corners never close a junction with others like it: its four corners at a junction read 2, 0, 0, 1. */
const NEUTRAL = [0, 1, 2, 0];
/** A run at the opening of the wall with a neutral wall (ids 1-42) changed by `edit`, and no tile coming loose. */
function scene(edit: (tiles: Tile[]) => void = () => {}, seed = 1): AzState {
  const s = engine.advance(started(seed), OPEN);
  const tiles = Array.from({ length: CELLS }, (_, i): Tile => ({ id: i + 1, c: NEUTRAL.slice(), panel: 0, turns: 0, loose: 0, at: 0 }));
  edit(tiles);
  return { ...s, play: { ...s.play, tiles, nextId: 100, nextLoose: 1_000_000 } };
}
/** Sets junction `v` one turn away from a rosette of `color`: three corners in that colour, the fourth on `turner`'s
 *  previous corner (one clockwise turn brings it in). Returns the turner's slot. */
function almost(tiles: Tile[], v: number, color: number, which = 2): number {
  const corners = cornersOf(v);
  corners.forEach(([cell, k], i) => {
    const t = tiles[cell] as Tile;
    if (i === which) t.c[(k + 3) % 4] = color; else t.c[k] = color;
  });
  return (corners[which] as [number, number])[0];
}
const turn = (s: AzState, cell: number, tick = s.tick): AzState => engine.applyInput(s, { action: 'turn', cell, id: (s.play.tiles[cell] as Tile).id }, tick);
const whats = (s: AzState): string[] => s.play.events.map((e) => e.what);

test('the scoring config: 3 s of countdown + 90 s of play, with room to start; the rule tables agree', () => {
  assert.deepEqual(CONFIG, { game: 'wen-azulejo', maxTicks: 2160, roundTicks: 1860 });
  assert.equal(CONFIG.roundTicks, RULES.countdownTicks + RULES.playTicks);
  assert.equal(RULES.playTicks, RULES.colors.length * RULES.phaseTicks);
  RULES.colors.forEach((k, p) => { assert.ok(k >= 2 && k <= COLORS.length); if (p) assert.ok(k >= (RULES.colors[p - 1] as number), 'never easier'); });
  assert.ok(RULES.looseEnd < RULES.looseStart && RULES.graceEnd < RULES.graceStart);
});

test('geometry: a junction is the meeting of four corners; a quarter turn is clockwise and four make a full circle', () => {
  assert.equal(VERTS, 30);
  for (let v = 0; v < VERTS; v++) {
    const vx = (v % VCOLS) + 1, vy = Math.floor(v / VCOLS) + 1;          // the junction, in tile units
    for (const [cell, k] of cornersOf(v)) {
      const cx = (cell % COLS) + (k === 1 || k === 2 ? 1 : 0), cy = Math.floor(cell / COLS) + (k >= 2 ? 1 : 0);
      assert.deepEqual([cx, cy], [vx, vy], `junction ${v}, slot ${cell}, corner ${k}`);
      assert.ok(verticesOf(cell).includes(v));
    }
  }
  assert.deepEqual(verticesOf(0), [0]); assert.equal(verticesOf(COLS + 1).length, 4);
  assert.deepEqual(turned([1, 2, 3, 4]), [4, 1, 2, 3], 'the top-left corner takes the bottom-left glaze');
  assert.deepEqual(turned(turned(turned(turned([1, 2, 3, 4])))), [1, 2, 3, 4]);
});

test('createRun validates its seed and config; same seed and inputs, same wall', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(2 ** 32, CONFIG)); assert.throws(() => engine.createRun('1', CONFIG));
  assert.throws(() => engine.createRun(1.5, CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'gate-rush' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  assert.throws(() => engine.createRun(1, { ...CONFIG, roundTicks: RULES.countdownTicks }));
  const a = engine.advance(started(42), 400), b = engine.advance(started(42), 400), c = engine.advance(started(43), 400);
  assert.deepEqual(a, b); assert.notDeepEqual(a.play.tiles, c.play.tiles);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the state round-trips through JSON');
  let stepped = started(42); for (let t = 1; t <= 400; t += 7) stepped = engine.advance(stepped, t);
  assert.deepEqual(engine.advance(stepped, 400), a, 'many small advances = one big advance');
  assert.throws(() => engine.advance(a, 399), /backwards/, 'time never moves backwards');
  assert.throws(() => engine.applyInput(a, { action: 'start' }, 12.5));
});

test('the opening wall: 42 tiles laid, in the first glazes, with no rosette closed', () => {
  for (let seed = 0; seed < 200; seed++) {
    const s = engine.createRun(seed, CONFIG);
    assert.equal(s.play.tiles.length, CELLS);
    assert.ok(s.play.tiles.every((t) => t.at === 0 && t.turns === 0 && t.loose === 0 && t.c.every((x) => x < (RULES.colors[0] as number))));
    for (let v = 0; v < VERTS; v++) assert.equal(engine.closedAt(s.play, v, 0), -1, `seed ${seed}: junction ${v} closed at the start`);
  }
});

test('a tap turns the tile a quarter clockwise; the fourth turn that closes nothing cracks it', () => {
  let s = scene();
  s = { ...s, play: { ...s.play, score: 500, combo: 2, bestCombo: 2, lastMade: OPEN } };
  const cell = 14, id = (s.play.tiles[cell] as Tile).id;
  s = turn(s, cell, OPEN + 1);
  assert.deepEqual(s.play.tiles[cell]?.c, turned(NEUTRAL)); assert.equal(s.play.tiles[cell]?.turns, 1);
  s = turn(turn(s, cell, OPEN + 2), cell, OPEN + 3);
  assert.equal(s.play.tiles[cell]?.turns, RULES.maxTurns); assert.equal(s.play.events.length, 0);
  s = turn(s, cell, OPEN + 4);
  assert.deepEqual(whats(s), ['spin']);
  assert.equal(s.play.score, 500 - RULES.spinPenalty); assert.equal(s.play.cracks, 1); assert.equal(s.play.combo, 0); assert.equal(s.play.spun, 1);
  const fresh = s.play.tiles[cell] as Tile;
  assert.notEqual(fresh.id, id, 'a new tile'); assert.equal(fresh.at, OPEN + 4 + RULES.refillTicks); assert.equal(fresh.turns, 0);
  // the score never goes below zero
  let poor = scene();
  for (let k = 0; k <= RULES.maxTurns; k++) poor = turn(poor, 3, OPEN + 1 + k);
  assert.equal(poor.play.score, 0); assert.equal(poor.play.events.at(-1)?.gain, 0);
});

test('a turn that closes four corners of one colour makes a rosette: points, tiles relaid half a second later', () => {
  let cellT = -1;
  let s = scene((t) => { cellT = almost(t, 6, 3); });
  const before = s.play.tiles.map((t) => t.id);
  s = turn(s, cellT, OPEN + 1);
  assert.deepEqual(whats(s), ['rosette']);
  const e = s.play.events[0];
  assert.equal(e?.vertex, 6); assert.equal(e?.color, 3); assert.deepEqual([...(e?.cells ?? [])].sort((a, b) => a - b), cornersOf(6).map(([c]) => c).sort((a, b) => a - b));
  assert.equal(s.play.score, RULES.rosette); assert.equal(s.play.made, 1); assert.deepEqual(s.play.mosaic, [3]); assert.equal(s.play.combo, 1);
  for (const [cell] of cornersOf(6)) {
    const t = s.play.tiles[cell] as Tile;
    assert.ok(!before.includes(t.id), 'relaid'); assert.equal(t.at, OPEN + 1 + RULES.refillTicks);
    assert.ok(t.c.every((x) => x < engine.colorsAt(s, t.at)));
  }
  assert.equal(s.play.tiles.filter((t, i) => t.id === before[i]).length, CELLS - 4, 'the rest of the wall stays');
  // one turn can close two rosettes at once (the turning tile is in both)
  // junction 6 (slots 7, 8, 14, 13) and junction 7 (slots 8, 9, 15, 14) share slot 14: its bottom-left glaze turns into
  // its top-left corner (junction 6) and its top-left glaze into its top-right corner (junction 7)
  const two = scene((t) => {
    assert.equal(almost(t, 6, 3, 2), 14);
    t[14]!.c[0] = 4;
    for (const [cell, k] of cornersOf(7)) if (cell !== 14) t[cell]!.c[k] = 4;
  });
  const after = turn(two, 14, OPEN + 1);
  assert.deepEqual(whats(after), ['rosette', 'rosette']);
  assert.equal(after.play.score, RULES.rosette * 2); assert.deepEqual(after.play.mosaic, [3, 4]);
});

test('rosettes in a row multiply (×2 from the 4th), and the streak ends after 3 s without one', () => {
  const setups: number[] = [];
  const junctions = [0, 2, 4, 10, 12, 14];
  let s = scene((t) => { for (const v of junctions) setups.push(almost(t, v, 3)); });
  const gains: number[] = [];
  let tick = OPEN;
  for (let i = 0; i < 5; i++) { tick += 10; const before = s.play.score; s = turn(s, setups[i] as number, tick); gains.push(s.play.score - before); }
  assert.deepEqual(gains, [100, 100, 100, 200, 200]);
  assert.equal(s.play.bestCombo, 5);
  s = engine.advance(s, tick + RULES.comboWindow + 1);
  assert.equal(s.play.combo, 0, 'too slow: the streak is over');
  const before = s.play.score;
  s = turn(s, setups[5] as number, tick + RULES.comboWindow + 2);
  assert.equal(s.play.score - before, 100);
});

test('golden tiles paint their name (bonus, a crack repaired); a loose tile saved by a rosette pays, one not saved falls', () => {
  let cellT = -1;
  let s = scene((t) => {
    cellT = almost(t, 8, 4);
    const [a, b] = cornersOf(8);
    t[(a as [number, number])[0]]!.panel = NAMED[0] as number;
    t[(b as [number, number])[0]]!.loose = OPEN + 50;
  });
  s = { ...s, play: { ...s.play, cracks: 3 } };
  s = turn(s, cellT, OPEN + 1);
  assert.equal(s.play.score, RULES.rosette + RULES.painted + RULES.rescued);
  assert.deepEqual(s.play.painted, [NAMED[0]]); assert.equal(s.play.cracks, 2); assert.equal(s.play.rescued, 1);
  assert.deepEqual(s.play.events.at(-1)?.panels, [NAMED[0]]);
  assert.ok(s.play.tiles.every((t) => t.panel !== NAMED[0]), 'a painted name leaves the wall');
  // not saved: it falls at its tick, cracks the wall and is relaid
  let f = scene((t) => { t[20]!.loose = OPEN + 5; });
  f = { ...f, play: { ...f.play, score: 100 } };
  f = engine.advance(f, OPEN + 4);
  assert.equal(f.play.events.length, 0);
  f = engine.advance(f, OPEN + 5);
  assert.deepEqual(whats(f), ['fall']); assert.equal(f.play.cracks, 1); assert.equal(f.play.score, 100 - RULES.fallPenalty); assert.equal(f.play.fallen, 1);
  assert.equal(f.play.tiles[20]?.at, OPEN + 5 + RULES.refillTicks); assert.equal(f.play.tiles[20]?.loose, 0);
});

test('SOS: tiles come loose from the opening on, more and more often, with less and less time; a painted name never comes back', () => {
  const s = started(1), open = engine.openTickOf(s);
  assert.equal(engine.looseAt(s, open), RULES.looseStart); assert.equal(engine.looseAt(s, open + RULES.playTicks), RULES.looseEnd);
  assert.equal(engine.graceAt(s, open), RULES.graceStart); assert.equal(engine.graceAt(s, open + RULES.playTicks), RULES.graceEnd);
  for (let t = open + 1; t <= open + RULES.playTicks; t++) {
    assert.ok(engine.looseAt(s, t - 1) - engine.looseAt(s, t) <= 1); assert.ok(engine.graceAt(s, t - 1) - engine.graceAt(s, t) <= 1);
  }
  assert.ok(engine.advance(s, open).play.tiles.every((t) => t.loose === 0), 'nothing loose in the countdown');
  let run = { ...s, play: { ...s.play, painted: engine.pool.slice(0, engine.pool.length - 3) } };
  let loose = 0, maxNames = 0;
  for (let t = open; t < open + RULES.playTicks; t += 2) {
    run = engine.advance({ ...run, play: { ...run.play, cracks: 0 } }, t);
    loose = Math.max(loose, run.play.looseCount);
    const names = run.play.tiles.filter((x) => x.panel).map((x) => x.panel);
    maxNames = Math.max(maxNames, names.length);
    assert.ok(names.every((n) => !run.play.painted.includes(n)));
  }
  assert.ok(loose > 40, `${loose} tiles came loose`); assert.ok(maxNames <= RULES.namesMax);
});

test('a cascade: a new tile laid into place closes a rosette by itself, and counts', () => {
  let s = scene((t) => {
    for (const [cell, k] of cornersOf(20)) t[cell]!.c[k] = 4;
    const [cell] = cornersOf(20)[3] as [number, number];
    t[cell]!.at = OPEN + 3;                             // still being laid
  });
  assert.equal(engine.closedAt(s.play, 20, OPEN), -1, 'not yet: one slot is empty');
  s = engine.advance(s, OPEN + 3);
  assert.deepEqual(whats(s), ['cascade']); assert.equal(s.play.cascades, 1); assert.equal(s.play.score, RULES.rosette);
});

test('latency: a tap on a tile that left its slot (or is not laid yet) does nothing', () => {
  const s = scene((t) => { t[5]!.at = OPEN + 4; });
  assert.deepEqual(engine.applyInput(s, { action: 'turn', cell: 3, id: 999 }, OPEN + 1).play, engine.advance(s, OPEN + 1).play, 'another tile now');
  assert.deepEqual(engine.applyInput(s, { action: 'turn', cell: 5, id: 6 }, OPEN + 1).play, engine.advance(s, OPEN + 1).play, 'not laid yet');
  assert.notDeepEqual(engine.applyInput(s, { action: 'turn', cell: 5, id: 6 }, OPEN + 4).play.tiles[5]?.c, NEUTRAL, 'laid: it turns');
});

test('twelve cracks end the run without a bonus; holding the wall 90 s pays it; a finished run never changes', () => {
  const idle = engine.advance(started(9), CONFIG.roundTicks);
  assert.equal(idle.gameOver, true); assert.equal(idle.play.end, 'cracked'); assert.equal(idle.play.cracks, RULES.maxCracks);
  assert.equal(idle.play.bonus, 0); assert.ok(idle.tick < CONFIG.roundTicks, 'an idle wall crumbles before the end');
  const bot = playBot(77);
  assert.equal(bot.play.end, 'time', `the bot holds the wall (${bot.play.cracks} cracks)`);
  assert.equal(bot.play.bonus, RULES.survival + RULES.perCrackLeft * (RULES.maxCracks - bot.play.cracks));
  assert.ok(bot.play.made > 40 && bot.play.rescued > 10, `made ${bot.play.made}, rescued ${bot.play.rescued}`);
  console.log(`  wen-azulejo bot (seed 77): score ${bot.play.score}, rosettes ${bot.play.made} (cascades ${bot.play.cascades}), saved ${bot.play.rescued}, fallen ${bot.play.fallen}, painted ${bot.play.painted.length}, cracks ${bot.play.cracks}, best combo ${bot.play.bestCombo}`);
  assert.ok(JSON.stringify(bot).length < 12_000);
  assert.deepEqual(engine.applyInput(bot, { action: 'turn', cell: 0, id: (bot.play.tiles[0] as Tile).id }, bot.tick + 1), bot);
  assert.deepEqual(engine.advance(bot, CONFIG.maxTicks), bot);
});

test('start: taps before the start or in the countdown are no-ops; a second start does not move the clock', () => {
  const fresh = engine.createRun(3, CONFIG);
  assert.deepEqual(engine.applyInput(fresh, { action: 'turn', cell: 0, id: 1 }, 2).play, fresh.play);
  const s = started(3);
  assert.deepEqual(engine.applyInput(s, { action: 'turn', cell: 0, id: 1 }, OPEN - 1).play, engine.advance(s, OPEN - 1).play);
  assert.equal(engine.applyInput(s, { action: 'start' }, 30).startTick, 0);
  const over = engine.advance(s, CONFIG.maxTicks);
  assert.deepEqual(engine.applyInput(over, { action: 'start' }, CONFIG.maxTicks), over);
});

test('forged inputs never score, crack or turn anything', () => {
  let cellT = -1;
  const s = scene((t) => { cellT = almost(t, 6, 3); });
  const id = (s.play.tiles[cellT] as Tile).id;
  const forged: unknown[] = [
    { action: 'turn', cell: cellT, id, score: 9999 }, { action: 'turn', cell: cellT }, { action: 'turn', id }, { action: 'turn', cell: CELLS, id },
    { action: 'turn', cell: -1, id }, { action: 'turn', cell: 1.5, id }, { action: 'turn', cell: String(cellT), id }, { action: 'turn', cell: cellT, id: 0 },
    { action: 'turn', cell: cellT, id: 2_000_000 }, { action: 'turn', cell: cellT, id, times: 3 }, { action: 'rosette', vertex: 6 },
    { action: 'join', cells: [0, 1, 2] }, { action: 'slam', lane: 0 }, { action: 'start', x: 1 }, { cell: cellT, id }, null, 7, 'turn', [], { score: 1e9 },
  ];
  for (const input of forged) {
    const after = engine.applyInput(s, input, OPEN + 1);
    assert.deepEqual(after.play, engine.advance(s, OPEN + 1).play, JSON.stringify(input));
    assert.equal(parseInput(input), null);
    assert.equal(inputSchema.safeParse(input).success, false, 'the page refuses what the verifier refuses');
  }
  assert.ok(inputSchema.safeParse({ action: 'turn', cell: cellT, id }).success);
});

test('checkState and the page schema refuse incoherent or tampered states (and agree)', () => {
  const s = engine.advance(started(4), 300);
  assert.ok(s.play.tiles.some((t) => t.loose > 0));
  assert.deepEqual(checkState(s), s); assert.equal(stateSchema.safeParse(s).success, true);
  const mutate = (f: (x: any) => void): unknown => { const c = structuredClone(s) as any; f(c); return c; };
  const bad = [
    mutate((x) => { x.extra = 1; }), mutate((x) => { x.play.extra = 1; }), mutate((x) => { x.play.score = -1; }), mutate((x) => { x.play.score = 1.5; }),
    mutate((x) => { x.play.cracks = RULES.maxCracks + 1; }), mutate((x) => { x.play.cracks = RULES.maxCracks; }),
    mutate((x) => { x.play.tiles.pop(); }), mutate((x) => { x.play.tiles.push(x.play.tiles[0]); }),
    mutate((x) => { x.play.tiles[0].c = [0, 1, 2]; }), mutate((x) => { x.play.tiles[0].c = [0, 1, 2, COLORS.length]; }), mutate((x) => { x.play.tiles[0].extra = 1; }),
    mutate((x) => { x.play.tiles[1].id = x.play.tiles[0].id; }), mutate((x) => { x.play.tiles[0].id = x.play.nextId; }),
    mutate((x) => { x.play.tiles[0].turns = RULES.maxTurns + 1; }), mutate((x) => { x.play.tiles[0].at = x.tick + RULES.refillTicks + 1; }),
    mutate((x) => { x.play.tiles[0].loose = x.tick; }), mutate((x) => { x.play.tiles[0].panel = 551; }),
    mutate((x) => { x.play.tiles[0].panel = 7; x.play.painted = [7]; }), mutate((x) => { x.play.tiles[0].panel = 7; x.play.tiles[1].panel = 7; }),
    mutate((x) => { for (let i = 0; i <= RULES.namesMax; i++) x.play.tiles[i].panel = 100 + i; }),
    mutate((x) => { x.play.end = 'time'; }), mutate((x) => { x.play.combo = x.play.bestCombo + 1; }), mutate((x) => { x.started = false; }),
    mutate((x) => { x.tick = x.rules.maxTicks + 1; }), mutate((x) => { x.rules.game = 'gate-rush'; }), mutate((x) => { x.seed = -1; }),
    mutate((x) => { x.play.painted = [3, 3]; }), mutate((x) => { x.play.mosaic = [COLORS.length]; }), mutate((x) => { x.play.lastMade = x.tick + 1; }),
    mutate((x) => { x.play.events = [{ seq: 1, tick: 0, what: 'rosette', color: 0, vertex: 0, cells: [0, 1, 6, 7], panels: [], gain: 1, extra: 1 }]; x.play.eventSeq = 1; }),
    mutate((x) => { x.play.events = [{ seq: 1, tick: 0, what: 'rosette', color: 0, vertex: VERTS, cells: [0, 1, 6, 7], panels: [], gain: 1 }]; x.play.eventSeq = 1; }),
  ];
  bad.forEach((state, i) => {
    assert.throws(() => checkState(state), Error, `case ${i}`);
    assert.equal(stateSchema.safeParse(state).success, false, `case ${i}`);
  });
});

/* ------------------------------------- bot ------------------------------------- */
/** Turns to bring glaze `color` to corner k of tile t, or 99. */
const turnsTo = (t: Tile, k: number, color: number): number => { for (let r = 0; r < 4; r++) if (t.c[(k + 4 - r) % 4] === color) return r; return 99; };
/** The next tap of a player who sees the whole wall: the cheapest rosette in turns, loose and golden tiles first. */
function bestTap(s: AzState): { cell: number; id: number } | null {
  let best: { cost: number; cell: number; id: number } | null = null;
  for (let v = 0; v < VERTS; v++) {
    const corners = cornersOf(v), tiles = corners.map(([cell]) => s.play.tiles[cell] as Tile);
    if (tiles.some((t) => t.at > s.tick)) continue;
    const priority = tiles.reduce((a, t) => a + (t.loose ? (t.loose - s.tick < 60 ? 40 : 15) : 0) + (t.panel ? 8 : 0), 0);
    for (let color = 0; color < COLORS.length; color++) {
      const r = corners.map(([, k], i) => turnsTo(tiles[i] as Tile, k, color));
      if (r.some((x) => x === 99)) continue;
      const moving = r.map((x, i) => ({ x, i })).filter((m) => m.x > 0);
      if (!moving.length) continue;
      if (!moving.every((m, j) => m.x <= RULES.maxTurns - (tiles[m.i] as Tile).turns + (j === moving.length - 1 ? 1 : 0))) continue;
      const cost = r.reduce((a, b) => a + b, 0) - priority, m = moving[0] as { i: number };
      if (!best || cost < best.cost) best = { cost, cell: (corners[m.i] as [number, number])[0], id: (tiles[m.i] as Tile).id };
    }
  }
  return best ? { cell: best.cell, id: best.id } : null;
}
/** A quick player: a tap every 4 ticks (0.2 s), a short look after each rosette, taps landing 2 ticks late. */
function playBot(seed: number): AzState {
  let s = started(seed), next = 0, made = 0;
  for (let t = 1; !s.gameOver && t <= CONFIG.maxTicks; t++) {
    s = engine.advance(s, t);
    if (t < next || s.gameOver) continue;
    const tap = bestTap(s);
    if (!tap) continue;
    s = engine.applyInput(s, { action: 'turn', ...tap }, t + 2); t = s.tick;
    next = t + 4 + (s.play.made > made ? 8 : 0); made = s.play.made;
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
  assert.match(html, /<meta name="game-code" content="wen-azulejo@[0-9a-f]{12}">/, 'the page says which code it runs');
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
  const forged = await post({ version: 1, op: 'applyInput', state, input: { action: 'turn', cell: 0, id: 1, score: 1e6 }, serverTick: 1 });
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
      const r = rnd(), tap = bestTap(run.state);
      // a fallible player: slower, a random tap now and then (some over-spin), a stale tap, a forged input
      if (tap && r < 0.8) { await send({ action: 'turn', ...tap }, run.tick + 1 + Math.floor(rnd() * 3)); next = run.tick + 5 + Math.floor(rnd() * 8); }
      else if (r < 0.9) { const cell = Math.floor(rnd() * CELLS); await send({ action: 'turn', cell, id: (run.state.play.tiles[cell] as Tile).id }, run.tick + 1); }
      else if (r < 0.92) await send({ action: 'turn', cell: 0, id: 999_999 }, run.tick + 1);
      else if (r < 0.93) await send({ action: 'turn', cell: 0, id: 1, score: 99999 }, run.tick + 1);
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
    console.log(`  wen-azulejo built verifier (seed ${seed}): ${run.calls} calls, end ${run.state.play.end}, score ${run.state.play.score}, rosettes ${run.state.play.made}, spun ${run.state.play.spun}, saved ${run.state.play.rescued}, painted ${run.state.play.painted.length}, largest state ${run.largestState} B`);
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
