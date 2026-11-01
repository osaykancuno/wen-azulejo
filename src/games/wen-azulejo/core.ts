// WEN AZULEJO · ROSÁCEA: the deterministic rules, shared by the browser (prediction, practice) and the server verifier
// (zod-free).
//
// Lisbon, NFC Summit. A wall of 6 × 7 azulejos. Every tile has four coloured corners, a quarter of a circle each, as in
// the real 2 × 2 azulejo patterns. A tap turns a tile 90° clockwise. Where four tiles meet and their four corners share a
// colour, the circle closes: a ROSETTE. It scores, and its four tiles are relaid with new ones half a second later (which
// may close new rosettes by themselves: a cascade). Every tile takes three turns; a fourth turn that closes nothing cracks
// it. Now and then a tile comes LOOSE (SOS Azulejo): put it in a rosette before it falls, or the wall cracks. Golden
// tiles carry a name of the wall: a rosette with one PAINTS that name on the wall (bonus, and a crack repaired). Twelve
// cracks and the wall crumbles. 90 s; every 22.5 s the colours grow (3, 4, 4, 5), and tiles come loose more and more often
// with less and less time to save them. Holding the wall the whole 90 s pays a big bonus.
//
// Integer arithmetic only, a seeded generator (src/common/det.ts), a state that round-trips through JSON exactly, no
// clock, no network. Tile number n of a run is a pure function of (seed, n, the tick it is laid at).
import { fnv1a, mulberry32 } from '../../common/det.js';

/* ================================ RULES ==================================== */
export const COLS = 6;
export const ROWS = 7;
export const CELLS = COLS * ROWS;
/** The junctions where four tiles meet (5 × 6). */
export const VCOLS = COLS - 1;
export const VROWS = ROWS - 1;
export const VERTS = VCOLS * VROWS;
/** The glazes, in the order they join the game. */
export const COLORS = ['cobalto', 'ocre', 'verde', 'manganes', 'terracota'] as const;
export const RULES = {
  countdownTicks: 60,                         // 3 s between the start and the wall opening
  playTicks: 1800,                            // 90 s
  phaseTicks: 450,                            // four phases of 22.5 s
  /** Per phase: how many glazes the new tiles are made of. */
  colors: [3, 4, 4, 5] as readonly number[],
  /** Turns a tile takes; the next one, if it closes no rosette, cracks it. */
  maxTurns: 3,
  /** A tile of a rosette (or a fallen or cracked one) is relaid this many ticks later. */
  refillTicks: 10,
  /** The ramp, even from the opening to the end: the ticks between two tiles coming loose (plus up to half again at
   *  random) shrink from looseStart to looseEnd, the ticks a loose tile holds from graceStart to graceEnd. */
  looseStart: 48, looseEnd: 14,
  graceStart: 150, graceEnd: 66,
  /** Chance (out of 100) that a new tile is golden (carries a name of the wall); at most namesMax on the wall at once. */
  nameChance: 5, namesMax: 3,
  maxCracks: 12,
  rosette: 100,                               // × the multiplier
  rescued: 50,                                // each loose tile saved by a rosette
  painted: 200,                               // each name painted (and one crack repaired)
  fallPenalty: 30, spinPenalty: 30,
  comboEvery: 3, multCap: 4, comboWindow: 60, // ×2 from the 4th rosette in a row (each within 3 s of the last), ×4 at most
  survival: 2000, perCrackLeft: 150,
  mosaicMax: 64, paintedMax: 64, eventsMax: 12,
};
export const PHASES = RULES.colors.length;
/** rosette: four corners of one colour closed by a turn · cascade: closed by new tiles laid by themselves · spin: a tile
 *  turned once too often, cracked · fall: a loose tile not saved in time. */
export const WHATS = ['rosette', 'cascade', 'spin', 'fall'] as const;
export type What = (typeof WHATS)[number];

/* ============================ TYPES & VALIDATION ============================= */
export type NamedPanel = { p: number; n: string };
export type AzConfig = { game: 'wen-azulejo'; maxTicks: number; roundTicks: number };
/** One tile; its slot is its index in `tiles`. */
export type Tile = {
  id: number;
  /** The glaze of each corner: top-left, top-right, bottom-right, bottom-left. */
  c: number[];
  /** A name of the wall (its panel, 1-550) or 0. */
  panel: number;
  /** Turns taken so far. */
  turns: number;
  /** 0, or the tick this loose tile falls at. */
  loose: number;
  /** The tick it is laid at: before that its slot is empty (being relaid). */
  at: number;
};
export type AzEvent = { seq: number; tick: number; what: What; color: number; vertex: number; cells: number[]; panels: number[]; gain: number };
export type End = 'none' | 'time' | 'cracked' | 'horizon';
export type Play = {
  score: number; combo: number; bestCombo: number; lastMade: number;
  cracks: number; made: number; cascades: number; spun: number; fallen: number; rescued: number; bonus: number; end: End;
  tiles: Tile[];
  nextId: number; nextLoose: number; looseCount: number; eventSeq: number;
  events: AzEvent[];
  /** The colour of every rosette, in order (the last mosaicMax): the pattern shown at the end. */
  mosaic: number[];
  /** The names painted on the wall, in order, each once (panels). */
  painted: number[];
};
export type AzState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: AzConfig; play: Play };
export type AzInput = { action: 'start' } | { action: 'turn'; cell: number; id: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const MAX_ID = 1_000_000;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const fail = (what: string): never => { throw new Error(`Invalid WEN AZULEJO ${what}`); };
const intList = (v: unknown, maxLen: number, min: number, max: number): v is number[] =>
  Array.isArray(v) && v.length <= maxLen && v.every((x) => isInt(x, min, max));

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): AzConfig {
  if (!isObject(value) || value.game !== 'wen-azulejo' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, RULES.countdownTicks + 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'wen-azulejo', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, a slot or an id out of range). */
export function parseInput(value: unknown): AzInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'turn' && exactKeys(value, ['action', 'cell', 'id']) && isInt(value.cell, 0, CELLS - 1) && isInt(value.id, 1, MAX_ID)) {
    return { action: 'turn', cell: value.cell, id: value.id };
  }
  return null;
}
const TILE_KEYS = ['id', 'c', 'panel', 'turns', 'loose', 'at'] as const;
const EVENT_KEYS = ['seq', 'tick', 'what', 'color', 'vertex', 'cells', 'panels', 'gain'] as const;
const PLAY_KEYS = ['score', 'combo', 'bestCombo', 'lastMade', 'cracks', 'made', 'cascades', 'spun', 'fallen', 'rescued', 'bonus', 'end', 'tiles',
  'nextId', 'nextLoose', 'looseCount', 'eventSeq', 'events', 'mosaic', 'painted'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
function checkTile(t: unknown): Tile {
  if (!isObject(t) || !exactKeys(t, TILE_KEYS)) return fail('tile');
  if (!isInt(t.id, 1, MAX_ID) || !intList(t.c, 4, 0, COLORS.length - 1) || t.c.length !== 4 || !isInt(t.panel, 0, 550)
    || !isInt(t.turns, 0, RULES.maxTurns) || !isInt(t.loose, 0, MAX_INT) || !isInt(t.at, 0, MAX_INT)) return fail('tile');
  return { id: t.id, c: t.c.slice(), panel: t.panel, turns: t.turns, loose: t.loose, at: t.at };
}
function checkEvent(e: unknown): AzEvent {
  if (!isObject(e) || !exactKeys(e, EVENT_KEYS)) return fail('event');
  if (!isInt(e.seq, 1, MAX_INT) || !isInt(e.tick, 0, MAX_INT) || !oneOf(e.what, WHATS) || !isInt(e.color, -1, COLORS.length - 1)
    || !isInt(e.vertex, -1, VERTS - 1) || !intList(e.cells, 4, 0, CELLS - 1) || !intList(e.panels, 4, 1, 550) || !isInt(e.gain, -1_000_000, 1_000_000)) return fail('event');
  return { seq: e.seq, tick: e.tick, what: e.what, color: e.color, vertex: e.vertex, cells: e.cells.slice(), panels: e.panels.slice(), gain: e.gain };
}
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): AzState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  for (const k of ['score', 'combo', 'bestCombo', 'made', 'cascades', 'spun', 'fallen', 'rescued', 'bonus', 'nextLoose', 'looseCount', 'eventSeq'] as const) {
    if (!isInt(p[k], 0, MAX_INT)) return fail('state');
  }
  if (!isInt(p.lastMade, -1, MAX_INT) || !isInt(p.cracks, 0, RULES.maxCracks) || !oneOf(p.end, ['none', 'time', 'cracked', 'horizon'] as const)
    || !isInt(p.nextId, 1, MAX_ID + 1)) return fail('state');
  const { tiles, events, mosaic, painted } = p;
  if (!Array.isArray(tiles) || tiles.length !== CELLS) return fail('state');
  if (!Array.isArray(events) || events.length > RULES.eventsMax) return fail('state');
  if (!intList(mosaic, RULES.mosaicMax, 0, COLORS.length - 1)) return fail('state');
  if (!intList(painted, RULES.paintedMax, 1, 550) || new Set(painted).size !== painted.length) return fail('state');
  const wall = tiles.map(checkTile), log = events.map(checkEvent);
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  const named = wall.filter((t) => t.panel > 0).map((t) => t.panel);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.end !== 'none') !== gameOver || (p.cracks >= RULES.maxCracks && !gameOver) || (p.combo as number) > (p.bestCombo as number)
    || (p.lastMade as number) > tick || new Set(wall.map((t) => t.id)).size !== CELLS || wall.some((t) => t.id >= (p.nextId as number))
    || wall.some((t) => t.at > tick + RULES.refillTicks || (t.loose > 0 && (!started || (!gameOver && t.loose <= tick))))
    || new Set(named).size !== named.length || named.some((x) => painted.includes(x)) || named.length > RULES.namesMax
    || log.some((e) => e.seq > (p.eventSeq as number) || e.tick > tick)) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      score: p.score as number, combo: p.combo as number, bestCombo: p.bestCombo as number, lastMade: p.lastMade, cracks: p.cracks,
      made: p.made as number, cascades: p.cascades as number, spun: p.spun as number, fallen: p.fallen as number, rescued: p.rescued as number,
      bonus: p.bonus as number, end: p.end, tiles: wall, nextId: p.nextId, nextLoose: p.nextLoose as number, looseCount: p.looseCount as number,
      eventSeq: p.eventSeq as number, events: log, mosaic: mosaic.slice(), painted: painted.slice(),
    },
  };
}

/* ================================ GEOMETRY ================================= */
export const colOf = (cell: number): number => cell % COLS;
export const rowOf = (cell: number): number => Math.floor(cell / COLS);
/** The four slots around a junction with the corner of each that touches it: top-left tile's bottom-right corner (2),
 *  top-right tile's bottom-left (3), bottom-right tile's top-left (0), bottom-left tile's top-right (1). */
export function cornersOf(vertex: number): [number, number][] {
  const vc = vertex % VCOLS, vr = Math.floor(vertex / VCOLS), tl = vr * COLS + vc;
  return [[tl, 2], [tl + 1, 3], [tl + COLS + 1, 0], [tl + COLS, 1]];
}
/** The junctions around a slot (1 to 4), ascending. */
export function verticesOf(cell: number): number[] {
  const c = colOf(cell), r = rowOf(cell), out: number[] = [];
  for (const [vc, vr] of [[c - 1, r - 1], [c, r - 1], [c - 1, r], [c, r]] as const) {
    if (vc >= 0 && vc < VCOLS && vr >= 0 && vr < VROWS) out.push(vr * VCOLS + vc);
  }
  return out;
}
/** A tile turned 90° clockwise: the top-left corner takes the bottom-left's glaze, and so on. */
export const turned = (c: readonly number[]): number[] => [c[3] as number, c[0] as number, c[1] as number, c[2] as number];

/* ================================ ENGINE ==================================== */
export const display = (name: string): string => name.trim().toUpperCase();

export function createEngine(panels: readonly NamedPanel[]) {
  const pool = panels.filter((panel) => panel.p >= 1 && panel.p <= 550 && /^[\x20-\x7E]{1,32}$/.test(display(panel.n))).map((panel) => panel.p);
  if (pool.length < 8) throw new Error('WEN AZULEJO needs at least 8 named panels');

  const openTickOf = (state: AzState): number => (state.startTick ?? 0) + RULES.countdownTicks;
  function endTickOf(state: AzState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  const elapsed = (state: AzState, tick: number): number => Math.max(0, Math.min(RULES.playTicks, tick - openTickOf(state)));
  const phaseAt = (state: AzState, tick: number): number => Math.min(PHASES - 1, Math.floor(elapsed(state, tick) / RULES.phaseTicks));
  const colorsAt = (state: AzState, tick: number): number => RULES.colors[phaseAt(state, tick)] as number;
  const looseAt = (state: AzState, tick: number): number =>
    RULES.looseStart - Math.floor((RULES.looseStart - RULES.looseEnd) * elapsed(state, tick) / RULES.playTicks);
  const graceAt = (state: AzState, tick: number): number =>
    RULES.graceStart - Math.floor((RULES.graceStart - RULES.graceEnd) * elapsed(state, tick) / RULES.playTicks);
  const multOf = (combo: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(combo / RULES.comboEvery));
  /** A tile is on the wall (laid) at this tick. */
  const laid = (t: Tile, tick: number): boolean => t.at <= tick;
  /** The colour closed at a junction, or -1. */
  function closedAt(play: Play, vertex: number, tick: number): number {
    const corners = cornersOf(vertex);
    const first = play.tiles[(corners[0] as [number, number])[0]] as Tile;
    if (!laid(first, tick)) return -1;
    const color = first.c[2] as number;
    for (const [cell, k] of corners) { const t = play.tiles[cell] as Tile; if (!laid(t, tick) || t.c[k] !== color) return -1; }
    return color;
  }

  /** Tile number `id`, laid at `at`, in the glazes of the phase of `colorTick`. `avoid` re-rolls it (deterministically)
   *  while it would close a rosette with the laid tiles above and to its left (the opening wall starts with none). */
  function makeTile(state: AzState, id: number, at: number, colorTick: number, cell: number, avoid: boolean): Tile {
    const play = state.play, k = colorsAt(state, colorTick);
    let c: number[] = [0, 0, 0, 0], rName = 0, rWho = 0;
    for (let salt = 0; salt < 16; salt++) {
      const rnd = mulberry32(fnv1a(`tile:${state.seed}:${id}:${salt}`));
      c = [0, 1, 2, 3].map(() => Math.floor(rnd() * k));
      rName = rnd(); rWho = rnd();
      if (!avoid) break;
      const col = colOf(cell), row = rowOf(cell);
      if (col === 0 || row === 0) break;
      const v = (row - 1) * VCOLS + (col - 1), corners = cornersOf(v);
      // this tile is the junction's bottom-right one (its top-left corner); the other three are laid already
      const same = corners.filter(([x]) => x !== cell).every(([x, q]) => (play.tiles[x] as Tile).c[q] === c[0]);
      if (!same) break;
    }
    let panel = 0;
    const onWall = play.tiles.filter((t) => t && t.panel > 0).map((t) => t.panel);
    if (Math.floor(rName * 100) < RULES.nameChance && onWall.length < RULES.namesMax && play.painted.length < RULES.paintedMax) {
      // a name not painted yet and not already on the wall (the next one in the pool otherwise); none left: a plain tile
      const busy = new Set([...play.painted, ...onWall]);
      let i = Math.floor(rWho * pool.length);
      for (let n = 0; n < pool.length && busy.has(pool[i] as number); n++) i = (i + 1) % pool.length;
      if (!busy.has(pool[i] as number)) panel = pool[i] as number;
    }
    return { id, c, panel, turns: 0, loose: 0, at };
  }
  /** Relays the tile of a slot: a new one, laid refillTicks from now. */
  function relay(state: AzState, cell: number): void {
    const play = state.play, at = state.tick + RULES.refillTicks;
    play.tiles[cell] = makeTile(state, play.nextId, at, at, cell, false);
    play.nextId++;
  }

  function event(state: AzState, what: What, color: number, vertex: number, cells: number[], panels: number[], gain: number): void {
    const play = state.play;
    play.eventSeq++;
    play.events.push({ seq: play.eventSeq, tick: state.tick, what, color, vertex, cells, panels, gain });
    if (play.events.length > RULES.eventsMax) play.events.shift();
  }
  /** A penalty: never below zero; the wall cracks and the streak ends. */
  function crack(state: AzState, penalty: number): number {
    const play = state.play;
    const loss = Math.min(play.score, penalty);
    play.score -= loss; play.cracks = Math.min(RULES.maxCracks, play.cracks + 1); play.combo = 0;
    return loss > 0 ? -loss : 0;                // never -0: the state must round-trip through JSON exactly
  }
  function settleCombo(state: AzState): void {
    const play = state.play;
    if (play.combo > 0 && state.tick - play.lastMade > RULES.comboWindow) play.combo = 0;
  }
  /** Closes every rosette at these junctions (each once), then relays their tiles. */
  function close(state: AzState, vertices: number[], what: 'rosette' | 'cascade'): void {
    const play = state.play, tick = state.tick, gone = new Set<number>();
    for (const v of [...new Set(vertices)].sort((a, b) => a - b)) {
      const color = closedAt(play, v, tick);
      if (color < 0) continue;
      const cells = cornersOf(v).map(([cell]) => cell);
      const fresh = cells.filter((cell) => !gone.has(cell));
      const tiles = fresh.map((cell) => play.tiles[cell] as Tile);
      const names = tiles.filter((t) => t.panel > 0).map((t) => t.panel);
      const saved = tiles.filter((t) => t.loose > 0).length;
      const gain = RULES.rosette * multOf(play.combo) + RULES.rescued * saved + RULES.painted * names.length;
      play.score += gain; play.made++; play.combo++; play.lastMade = tick; play.rescued += saved;
      if (what === 'cascade') play.cascades++;
      if (play.combo > play.bestCombo) play.bestCombo = play.combo;
      play.cracks = Math.max(0, play.cracks - names.length);
      play.mosaic.push(color);
      if (play.mosaic.length > RULES.mosaicMax) play.mosaic.shift();
      for (const n of names) if (play.painted.length < RULES.paintedMax) play.painted.push(n);
      for (const t of tiles) { t.loose = 0; t.panel = 0; }
      for (const cell of cells) gone.add(cell);
      event(state, what, color, v, cells, names, gain);
    }
    for (const cell of [...gone].sort((a, b) => a - b)) relay(state, cell);
  }

  /** One server tick: new tiles laid (cascades), loose tiles that fall, the next tile to come loose. */
  function step(state: AzState): void {
    const play = state.play, tick = state.tick;
    settleCombo(state);
    const landed: number[] = [];
    play.tiles.forEach((t, cell) => { if (t.at === tick) landed.push(...verticesOf(cell)); });
    if (landed.length) close(state, landed, 'cascade');
    for (let cell = 0; cell < CELLS; cell++) {
      const t = play.tiles[cell] as Tile;
      if (t.loose === 0 || t.loose > tick) continue;
      play.fallen++;
      event(state, 'fall', -1, -1, [cell], t.panel ? [t.panel] : [], crack(state, RULES.fallPenalty));
      relay(state, cell);
      if (play.cracks >= RULES.maxCracks) return;
    }
    if (tick >= play.nextLoose && tick < endTickOf(state)) {
      const rnd = mulberry32(fnv1a(`loose:${state.seed}:${play.looseCount}`));
      const candidates: number[] = [];
      play.tiles.forEach((t, cell) => { if (laid(t, tick) && t.loose === 0) candidates.push(cell); });
      if (candidates.length) {
        (play.tiles[candidates[Math.floor(rnd() * candidates.length)] as number] as Tile).loose = tick + graceAt(state, tick);
        const interval = looseAt(state, tick);
        play.looseCount++;
        play.nextLoose = tick + interval + Math.floor(rnd() * (Math.floor(interval / 2) + 1));
      }
    }
  }

  function finish(state: AzState, end: End): void {
    const play = state.play;
    state.gameOver = true; play.end = end;
    for (const t of play.tiles) t.loose = 0;
    if (end === 'time') { play.bonus = RULES.survival + RULES.perCrackLeft * (RULES.maxCracks - play.cracks); play.score += play.bonus; }
  }
  /** Mutating advance, one server tick at a time from the opening of the wall. */
  function advanceInPlace(state: AzState, serverTick: number): AzState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const end = endTickOf(state);
    const target = Math.min(serverTick, end);
    if (state.started) {
      const open = openTickOf(state);
      if (state.tick < open) state.tick = Math.min(open, target);
      while (state.tick < target) {
        state.tick++;
        step(state);
        if (state.play.cracks >= RULES.maxCracks) { finish(state, 'cracked'); return state; }
      }
    }
    state.tick = Math.max(state.tick, target);
    if (state.tick >= end) finish(state, state.started ? 'time' : 'horizon');
    return state;
  }

  /** A tap: the tile `id` in slot `cell` turns 90° clockwise, as the server receives it at this tick. */
  function turn(state: AzState, cell: number, id: number): void {
    const play = state.play, tick = state.tick;
    const tile = play.tiles[cell] as Tile;
    // a tile that left this slot a moment ago (a rosette, a fall) or is not laid yet: nothing happens
    if (tile.id !== id || !laid(tile, tick)) return;
    settleCombo(state);
    tile.c = turned(tile.c);
    const closing = verticesOf(cell).filter((v) => closedAt(play, v, tick) >= 0);
    if (closing.length) { close(state, closing, 'rosette'); return; }
    if (tile.turns < RULES.maxTurns) { tile.turns++; return; }
    // one turn too many: the tile cracks
    play.spun++;
    event(state, 'spin', -1, -1, [cell], [], crack(state, RULES.spinPenalty));
    relay(state, cell);
    if (play.cracks >= RULES.maxCracks) finish(state, 'cracked');
  }

  const clone = (state: AzState): AzState => structuredClone(state);
  function createRun(seed: unknown, config: unknown): AzState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    const state: AzState = {
      tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules,
      play: {
        score: 0, combo: 0, bestCombo: 0, lastMade: -1, cracks: 0, made: 0, cascades: 0, spun: 0, fallen: 0, rescued: 0, bonus: 0, end: 'none',
        tiles: [], nextId: 1, nextLoose: 0, looseCount: 0, eventSeq: 0, events: [], mosaic: [], painted: [],
      },
    };
    // the opening wall: every slot laid, in the first phase's glazes, with no rosette closed yet
    for (let cell = 0; cell < CELLS; cell++) { state.play.tiles.push(makeTile(state, state.play.nextId, 0, 0, cell, true)); state.play.nextId++; }
    return state;
  }
  function advance(state: AzState, serverTick: number): AzState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: AzState, input: unknown, serverTick: number): AzState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; state.play.nextLoose = openTickOf(state) + RULES.looseStart; }
      return state;
    }
    if (!state.started || state.tick < openTickOf(state)) return state;
    turn(state, action.cell, action.id);
    return state;
  }
  function applyInput(state: AzState, input: unknown, serverTick: number): AzState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: AzState): AzState => state;
  const isFinished = (state: AzState): boolean => state.gameOver;
  const score = (state: AzState): number => state.play.score;

  return {
    createRun, advance, applyInput, view, isFinished, score,
    advanceInPlace, applyInputInPlace, clone, endTickOf, openTickOf, phaseAt, colorsAt, looseAt, graceAt, multOf, closedAt, laid, pool,
  };
}
export type AzulejoEngine = ReturnType<typeof createEngine>;
