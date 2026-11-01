// WEN AZULEJO: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// Lisbon, NFC Summit. Fragments of azulejos land, in small linked groups of one motif, on a 6 × 7 wall of empty
// slots. Link fragments of the same motif, each next to the one before (sideways or diagonally), into one chain: a chain
// long enough completes an azulejo and clears it. Some fragments carry a name of the wall: completing them PAINTS that
// name on the virtual wall (bonus, and it repairs a crack). A fragment left too long falls and cracks the wall; a chain
// that mixes motifs, skips a slot or is too short is an error and cracks it too. Twelve cracks and the wall crumbles.
// 90 s; groups come faster and live shorter all along, and every 22.5 s the motifs get more numerous (3, 4, 4, 5) and
// bigger (3, then 4 fragments). Holding the wall the whole 90 s pays a big bonus.
//
// Integer arithmetic only, a seeded generator (src/common/det.ts), a state that round-trips through JSON exactly, no
// clock, no network. Group number n of a run is a pure function of (seed, n, tick, the wall at that tick).
import { fnv1a, mulberry32 } from '../../common/det.js';

/* ================================ RULES ==================================== */
export const COLS = 6;
export const ROWS = 7;
export const CELLS = COLS * ROWS;
/** The motifs, in the order they join the game: flor (flower), estrela (star), onda (wave), laço (knot), sol (sun). */
export const MOTIFS = ['flor', 'estrela', 'onda', 'laco', 'sol'] as const;
export type Motif = (typeof MOTIFS)[number];
export const RULES = {
  countdownTicks: 60,                         // 3 s between the start and the first fragment
  playTicks: 1800,                            // 90 s
  phaseTicks: 450,                            // four phases of 22.5 s
  /** Per phase: how many motifs are in play, and how many fragments make an azulejo. */
  motifs: [3, 4, 4, 5] as readonly number[],
  need: [3, 3, 4, 4] as readonly number[],
  maxChain: 6,
  /** Per phase: fragments come in small linked groups of one motif, from groupMin to groupMax. */
  groupMin: [3, 3, 3, 3] as readonly number[],
  groupMax: [4, 4, 5, 5] as readonly number[],
  /** The ramp, even from the first fragment to the end: a fragment's life (ticks) shrinks from lifeStart to lifeEnd, the
   *  ticks between groups (plus up to half again at random) from intervalStart to intervalEnd. */
  lifeStart: 240, lifeEnd: 140,
  intervalStart: 32, intervalEnd: 16,
  /** A freed slot stays empty this long (1 s), so a chain sent a moment ago never meets a newcomer in its slots. */
  cooldown: 20,
  /** Chance (out of 100) that a group lands next to a fragment of its motif, when there is room. */
  cluster: 60,
  /** Chance (out of 100) that one fragment of a group carries a name of the wall. */
  nameChance: 30,
  lastSpawnBeforeEnd: 40,                     // no new fragment in the last 2 s
  maxCracks: 12,
  perFragment: 50, longBonus: 50,             // an azulejo of L fragments: 50 × L + 50 × (L − need)², × the multiplier
  painted: 200,                               // each name painted (and one crack repaired)
  fallPenalty: 20, errorPenalty: 50,
  comboEvery: 3, multCap: 4, comboWindow: 60, // ×2 from the 4th azulejo in a row (each within 3 s of the last), ×4 at most
  survival: 2000, perCrackLeft: 150,
  mosaicMax: 64, paintedMax: 64, eventsMax: 10,
};
export const PHASES = RULES.motifs.length;
/** made: an azulejo completed · error: a chain that mixes motifs, skips a slot or is too short · fall: a fragment that
 *  waited too long and cracked the wall. */
export const WHATS = ['made', 'error', 'fall'] as const;
export type What = (typeof WHATS)[number];

/* ============================ TYPES & VALIDATION ============================= */
export type NamedPanel = { p: number; n: string };
export type AzConfig = { game: 'wen-azulejo'; maxTicks: number; roundTicks: number };
export type Tile = {
  id: number; cell: number; motif: number;
  /** A name of the wall (its panel, 1-550) or 0 for a plain fragment. */
  panel: number;
  born: number; dies: number;
};
export type AzEvent = { seq: number; tick: number; what: What; motif: number; cells: number[]; panels: number[]; gain: number };
export type End = 'none' | 'time' | 'cracked' | 'horizon';
export type Play = {
  score: number; combo: number; bestCombo: number; lastMade: number;
  cracks: number; made: number; errors: number; fallen: number; bonus: number; end: End;
  tiles: Tile[];
  /** Per slot, the tick before which nothing lands there. */
  cool: number[];
  nextSpawn: number; spawned: number; nextId: number; eventSeq: number;
  events: AzEvent[];
  /** The motif of every azulejo completed, in order (the last mosaicMax): the pattern shown at the end. */
  mosaic: number[];
  /** The names painted on the wall, in order, each once (panels). */
  painted: number[];
};
export type AzState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: AzConfig; play: Play };
export type AzInput = { action: 'start' } | { action: 'join'; cells: number[] };

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
/** An input, or null when it is not one (unknown action, extra field, a slot out of range, a slot twice, a chain of one). */
export function parseInput(value: unknown): AzInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action !== 'join' || !exactKeys(value, ['action', 'cells'])) return null;
  const cells = value.cells;
  if (!Array.isArray(cells) || cells.length < 2 || cells.length > RULES.maxChain || !cells.every((c) => isInt(c, 0, CELLS - 1))
    || new Set(cells).size !== cells.length) return null;
  return { action: 'join', cells: cells.slice() as number[] };
}
const TILE_KEYS = ['id', 'cell', 'motif', 'panel', 'born', 'dies'] as const;
const EVENT_KEYS = ['seq', 'tick', 'what', 'motif', 'cells', 'panels', 'gain'] as const;
const PLAY_KEYS = ['score', 'combo', 'bestCombo', 'lastMade', 'cracks', 'made', 'errors', 'fallen', 'bonus', 'end', 'tiles', 'cool',
  'nextSpawn', 'spawned', 'nextId', 'eventSeq', 'events', 'mosaic', 'painted'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
function checkTile(t: unknown): Tile {
  if (!isObject(t) || !exactKeys(t, TILE_KEYS)) return fail('tile');
  if (!isInt(t.id, 1, MAX_ID) || !isInt(t.cell, 0, CELLS - 1) || !isInt(t.motif, 0, MOTIFS.length - 1) || !isInt(t.panel, 0, 550)
    || !isInt(t.born, 0, MAX_INT) || !isInt(t.dies, 0, MAX_INT) || t.dies <= t.born || t.dies - t.born > RULES.lifeStart) return fail('tile');
  return { id: t.id, cell: t.cell, motif: t.motif, panel: t.panel, born: t.born, dies: t.dies };
}
function checkEvent(e: unknown): AzEvent {
  if (!isObject(e) || !exactKeys(e, EVENT_KEYS)) return fail('event');
  if (!isInt(e.seq, 1, MAX_INT) || !isInt(e.tick, 0, MAX_INT) || !oneOf(e.what, WHATS) || !isInt(e.motif, 0, MOTIFS.length - 1)
    || !intList(e.cells, RULES.maxChain, 0, CELLS - 1) || !intList(e.panels, RULES.maxChain, 1, 550) || !isInt(e.gain, -1_000_000, 1_000_000)) return fail('event');
  return { seq: e.seq, tick: e.tick, what: e.what, motif: e.motif, cells: e.cells.slice(), panels: e.panels.slice(), gain: e.gain };
}
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): AzState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  for (const k of ['score', 'combo', 'bestCombo', 'made', 'errors', 'fallen', 'bonus', 'nextSpawn', 'eventSeq'] as const) {
    if (!isInt(p[k], 0, MAX_INT)) return fail('state');
  }
  if (!isInt(p.lastMade, -1, MAX_INT) || !isInt(p.cracks, 0, RULES.maxCracks) || !oneOf(p.end, ['none', 'time', 'cracked', 'horizon'] as const)
    || !isInt(p.spawned, 0, MAX_ID) || !isInt(p.nextId, 1, MAX_ID + 1)) return fail('state');
  const { tiles, cool, events, mosaic, painted } = p;
  if (!Array.isArray(tiles) || tiles.length > CELLS) return fail('state');
  if (!intList(cool, CELLS, 0, MAX_INT) || cool.length !== CELLS) return fail('state');
  if (!Array.isArray(events) || events.length > RULES.eventsMax) return fail('state');
  if (!intList(mosaic, RULES.mosaicMax, 0, MOTIFS.length - 1)) return fail('state');
  if (!intList(painted, RULES.paintedMax, 1, 550) || new Set(painted).size !== painted.length) return fail('state');
  const wall = tiles.map(checkTile), log = events.map(checkEvent);
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.end !== 'none') !== gameOver || (p.cracks >= RULES.maxCracks && !gameOver) || (p.combo as number) > (p.bestCombo as number)
    || (!started && wall.length > 0) || (p.lastMade as number) > tick
    || new Set(wall.map((t) => t.id)).size !== wall.length || new Set(wall.map((t) => t.cell)).size !== wall.length
    || wall.some((t) => t.id >= (p.nextId as number) || t.born > tick || (!gameOver && t.dies <= tick))
    || wall.some((t) => t.panel > 0 && (painted.includes(t.panel) || wall.some((u) => u !== t && u.panel === t.panel)))
    || log.some((e) => e.seq > (p.eventSeq as number) || e.tick > tick)) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      score: p.score as number, combo: p.combo as number, bestCombo: p.bestCombo as number, lastMade: p.lastMade,
      cracks: p.cracks, made: p.made as number, errors: p.errors as number, fallen: p.fallen as number, bonus: p.bonus as number, end: p.end,
      tiles: wall, cool: cool.slice(), nextSpawn: p.nextSpawn as number, spawned: p.spawned, nextId: p.nextId,
      eventSeq: p.eventSeq as number, events: log, mosaic: mosaic.slice(), painted: painted.slice(),
    },
  };
}

/* ================================ GEOMETRY ================================= */
export const colOf = (cell: number): number => cell % COLS;
export const rowOf = (cell: number): number => Math.floor(cell / COLS);
/** Two different slots touching sideways or diagonally. */
export const adjacent = (a: number, b: number): boolean =>
  a !== b && Math.abs(colOf(a) - colOf(b)) <= 1 && Math.abs(rowOf(a) - rowOf(b)) <= 1;
/** The slots around one (up to 8), ascending. */
export function neighbours(cell: number): number[] {
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const r = rowOf(cell) + dr, c = colOf(cell) + dc;
    if ((dr || dc) && r >= 0 && r < ROWS && c >= 0 && c < COLS) out.push(r * COLS + c);
  }
  return out.sort((x, y) => x - y);
}

/* ================================ ENGINE ==================================== */
export const display = (name: string): string => name.trim().toUpperCase();

export function createEngine(panels: readonly NamedPanel[]) {
  const pool = panels.filter((panel) => panel.p >= 1 && panel.p <= 550 && /^[\x20-\x7E]{1,32}$/.test(display(panel.n))).map((panel) => panel.p);
  if (pool.length < 8) throw new Error('WEN AZULEJO needs at least 8 named panels');

  const openTickOf = (state: AzState): number => (state.startTick ?? 0) + RULES.countdownTicks;
  function endTickOf(state: AzState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  /** How far into the 90 s a tick is, from 0 to playTicks. */
  const elapsed = (state: AzState, tick: number): number => Math.max(0, Math.min(RULES.playTicks, tick - openTickOf(state)));
  const phaseAt = (state: AzState, tick: number): number => Math.min(PHASES - 1, Math.floor(elapsed(state, tick) / RULES.phaseTicks));
  const needAt = (state: AzState, tick: number): number => RULES.need[phaseAt(state, tick)] as number;
  const motifsAt = (state: AzState, tick: number): number => RULES.motifs[phaseAt(state, tick)] as number;
  const lifeAt = (state: AzState, tick: number): number =>
    RULES.lifeStart - Math.floor((RULES.lifeStart - RULES.lifeEnd) * elapsed(state, tick) / RULES.playTicks);
  const intervalAt = (state: AzState, tick: number): number =>
    RULES.intervalStart - Math.floor((RULES.intervalStart - RULES.intervalEnd) * elapsed(state, tick) / RULES.playTicks);
  const multOf = (combo: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(combo / RULES.comboEvery));
  /** Points of an azulejo of `length` fragments when `need` make one, before the multiplier. */
  const valueOf = (length: number, need: number): number => RULES.perFragment * length + RULES.longBonus * (length - need) * (length - need);
  const tileAt = (play: Play, cell: number): Tile | undefined => play.tiles.find((t) => t.cell === cell);

  function event(state: AzState, what: What, motif: number, cells: number[], panels: number[], gain: number): void {
    const play = state.play;
    play.eventSeq++;
    play.events.push({ seq: play.eventSeq, tick: state.tick, what, motif, cells, panels, gain });
    if (play.events.length > RULES.eventsMax) play.events.shift();
  }
  /** A penalty: never below zero; the wall cracks. */
  function crack(state: AzState, penalty: number): number {
    const play = state.play;
    const loss = Math.min(play.score, penalty);
    play.score -= loss; play.cracks = Math.min(RULES.maxCracks, play.cracks + 1); play.combo = 0;
    return loss > 0 ? -loss : 0;                // never -0: the state must round-trip through JSON exactly
  }
  /** The streak ends when no azulejo was completed for comboWindow ticks. */
  function settleCombo(state: AzState): void {
    const play = state.play;
    if (play.combo > 0 && state.tick - play.lastMade > RULES.comboWindow) play.combo = 0;
  }

  /** Arrival number n, from the wall as it is now: a small group of fragments of one motif, each next to the one before
   *  (so it can be linked), often landing beside fragments of its motif. One of them may carry a name of the wall. Empty
   *  when no slot is free (retried next tick). */
  function arrival(state: AzState, n: number): Tile[] {
    const play = state.play, tick = state.tick, phase = phaseAt(state, tick);
    const rnd = mulberry32(fnv1a(`azulejo:${state.seed}:${n}`));
    const rMotif = rnd(), rSize = rnd(), rCluster = rnd(), rSlot = rnd(), rName = rnd(), rWho = rnd(), rWhich = rnd();
    const taken = new Set(play.tiles.map((t) => t.cell));
    const isFree = (c: number): boolean => !taken.has(c) && (play.cool[c] as number) <= tick;
    const free: number[] = [];
    for (let c = 0; c < CELLS; c++) if (isFree(c)) free.push(c);
    if (free.length === 0) return [];
    const motif = Math.floor(rMotif * motifsAt(state, tick));
    const min = RULES.groupMin[phase] as number, max = RULES.groupMax[phase] as number;
    const size = min + Math.floor(rSize * (max - min + 1));
    let slots = free;
    if (Math.floor(rCluster * 100) < RULES.cluster) {
      const near = free.filter((c) => play.tiles.some((t) => t.motif === motif && adjacent(t.cell, c)));
      if (near.length) slots = near;
    }
    const cells = [slots[Math.floor(rSlot * slots.length)] as number];
    taken.add(cells[0] as number);
    while (cells.length < size) {
      const next = neighbours(cells[cells.length - 1] as number).filter(isFree);
      if (!next.length) break;
      const cell = next[Math.floor(rnd() * next.length)] as number;
      cells.push(cell); taken.add(cell);
    }
    let panel = 0;
    if (Math.floor(rName * 100) < RULES.nameChance && play.painted.length < RULES.paintedMax) {
      // a name not painted yet and not already on the wall (the next one in the pool otherwise); none left: a plain group
      const busy = new Set([...play.painted, ...play.tiles.map((t) => t.panel)]);
      let at = Math.floor(rWho * pool.length);
      for (let k = 0; k < pool.length && busy.has(pool[at] as number); k++) at = (at + 1) % pool.length;
      if (!busy.has(pool[at] as number)) panel = pool[at] as number;
    }
    const named = Math.floor(rWhich * cells.length), dies = tick + lifeAt(state, tick);
    return cells.map((cell, i) => ({ id: play.nextId + i, cell, motif, panel: i === named ? panel : 0, born: tick, dies }));
  }
  function spawn(state: AzState): void {
    const play = state.play, tick = state.tick;
    if (tick < play.nextSpawn || tick >= endTickOf(state) - RULES.lastSpawnBeforeEnd) return;
    const group = arrival(state, play.spawned);
    if (!group.length) return;
    const rnd = mulberry32(fnv1a(`gap:${state.seed}:${play.spawned}`));
    const interval = intervalAt(state, tick);
    play.tiles.push(...group);
    play.spawned++; play.nextId += group.length;
    play.nextSpawn = tick + interval + Math.floor(rnd() * (Math.floor(interval / 2) + 1));
  }

  /** One server tick: fragments that waited too long fall (a crack each), then the next one lands. */
  function step(state: AzState): void {
    const play = state.play, tick = state.tick;
    settleCombo(state);
    const falling = play.tiles.filter((t) => t.dies <= tick);
    if (falling.length) {
      play.tiles = play.tiles.filter((t) => t.dies > tick);
      for (const t of falling) {
        play.fallen++; play.cool[t.cell] = tick + RULES.cooldown;
        event(state, 'fall', t.motif, [t.cell], t.panel ? [t.panel] : [], crack(state, RULES.fallPenalty));
        if (play.cracks >= RULES.maxCracks) return;
      }
    }
    spawn(state);
  }

  function finish(state: AzState, end: End): void {
    const play = state.play;
    state.gameOver = true; play.end = end; play.tiles = [];
    if (end === 'time') { play.bonus = RULES.survival + RULES.perCrackLeft * (RULES.maxCracks - play.cracks); play.score += play.bonus; }
  }
  /** Mutating advance, one server tick at a time from the first fragment. */
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

  /** A chain of slots, as the server receives it at this tick. */
  function join(state: AzState, cells: number[]): void {
    const play = state.play, tick = state.tick;
    const tiles = cells.map((c) => tileAt(play, c));
    // a slot that emptied in the meantime (the fragment fell a moment before the chain arrived): nothing happens
    if (tiles.some((t) => t === undefined)) return;
    const chain = tiles as Tile[];
    settleCombo(state);
    const motif = (chain[0] as Tile).motif, need = needAt(state, tick);
    const linked = cells.every((c, i) => i === 0 || adjacent(cells[i - 1] as number, c));
    const same = chain.every((t) => t.motif === motif);
    if (!linked || !same || cells.length < need) {
      play.errors++;
      event(state, 'error', motif, cells.slice(), [], crack(state, RULES.errorPenalty));
      if (play.cracks >= RULES.maxCracks) finish(state, 'cracked');
      return;
    }
    // an azulejo: it leaves the wall, its names are painted, each repairs a crack
    const names = chain.filter((t) => t.panel > 0).map((t) => t.panel);
    const gain = valueOf(cells.length, need) * multOf(play.combo) + RULES.painted * names.length;
    play.tiles = play.tiles.filter((t) => !cells.includes(t.cell));
    for (const c of cells) play.cool[c] = tick + RULES.cooldown;
    play.score += gain; play.made++; play.combo++; play.lastMade = tick;
    if (play.combo > play.bestCombo) play.bestCombo = play.combo;
    play.cracks = Math.max(0, play.cracks - names.length);
    play.mosaic.push(motif);
    if (play.mosaic.length > RULES.mosaicMax) play.mosaic.shift();
    for (const p of names) if (play.painted.length < RULES.paintedMax) play.painted.push(p);
    event(state, 'made', motif, cells.slice(), names, gain);
  }

  const clone = (state: AzState): AzState => structuredClone(state);
  function createRun(seed: unknown, config: unknown): AzState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return {
      tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules,
      play: {
        score: 0, combo: 0, bestCombo: 0, lastMade: -1, cracks: 0, made: 0, errors: 0, fallen: 0, bonus: 0, end: 'none',
        tiles: [], cool: new Array<number>(CELLS).fill(0), nextSpawn: 0, spawned: 0, nextId: 1, eventSeq: 0, events: [], mosaic: [], painted: [],
      },
    };
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
      if (!state.started) { state.started = true; state.startTick = state.tick; state.play.nextSpawn = openTickOf(state); }
      return state;
    }
    if (!state.started || state.tick < openTickOf(state)) return state;
    join(state, action.cells);
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
    advanceInPlace, applyInputInPlace, clone, endTickOf, openTickOf, phaseAt, needAt, motifsAt, lifeAt, intervalAt, multOf, valueOf, tileAt, pool,
  };
}
export type AzulejoEngine = ReturnType<typeof createEngine>;
