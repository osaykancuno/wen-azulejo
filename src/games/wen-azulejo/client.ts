// WEN AZULEJO: the browser side. The page draws the wall of empty slots with the platform's authoritative state (the
// player's own queued chains applied by the very module the verifier runs, then brought to "now" by that same module)
// and turns a drag or a few taps into ONE ordered input: { action: 'join', cells: [slot, slot, ...] }. It never sends a
// score, a time or a state: which azulejo was completed, which name was painted and what it is worth is decided by the
// rules on SuperRare's server.
//
// The painted names become Lisbon street signs and their people (people.json sprites, a pixel stand-in otherwise) walk
// down the calçada under the wall. Motifs, glaze, sounds, street signs, sprites and the end card are display only.
import type { EndStats, GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { scoringConfiguration } from '../../shell/config.js';
import { HitFeed } from '../../shell/hits.js';
import { infoOf } from '../../shell/wall-data.js';
import { loadPeople, onPeople, sheetOfName } from '../../shell/people.js';
import { DIR, drawSprite, stepAt, type SpriteSheet } from '../../share/sprite.js';
import { fitTweet, intentHref, tag } from '../../share/post.js';
import { rankOf } from '../../share/end-screen.js';
import { WALL_PANELS } from '../../generated/wall.js';
import { fnv1a } from '../../common/det.js';
import {
  CELLS, COLS, MOTIFS, ROWS, RULES, adjacent, engine, inputSchema, snapshotSchema, stateSchema,
  type AzEvent, type AzState, type Tile, type What,
} from './engine.js';

const W = 420, H = 800, TICK_MS = 50;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', BLUE = '#2E7FD6', LABEL = '#6B685F';
const GLAZE = '#F7F4EC', GOLD = '#D9A62E', RED = '#D64532', COBALT = '#1F4FA3';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const HUD_H = 96;
const CELL = 64, GX = (W - COLS * CELL) / 2, GY = 106;            // the wall of slots
const SIGNS_Y = GY + ROWS * CELL + 10;                              // the street signs of the painted names
const STREET_Y = SIGNS_Y + 92;                                      // the calçada, where the painted people walk
/** Traditional azulejo colours, one per motif: cobalt, ochre, green, manganese, terracotta. */
const INKS = [COBALT, '#C98A1B', '#2F7A4A', '#6B3FA0', '#C2522D'];
const MOTIF_LABEL = ['FLOR', 'ESTRELA', 'ONDA', 'LAÇO', 'SOL'];
const SNAPSHOT_NAME = new Map(WALL_PANELS.map((p) => [p.p, p]));
const nameOfPanel = (panel: number): string => infoOf(panel).name.toUpperCase() || SNAPSHOT_NAME.get(panel)?.n.toUpperCase() || '';
const handleOf = (panel: number): string => infoOf(panel).handle || SNAPSHOT_NAME.get(panel)?.h || '';
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const cellX = (cell: number): number => GX + (cell % COLS) * CELL + CELL / 2;
const cellY = (cell: number): number => GY + Math.floor(cell / COLS) * CELL + CELL / 2;
const pick = <T,>(list: readonly T[], key: string): T => list[fnv1a(key) % list.length] as T;

/** What the wall says (display only, picked from the event number). */
const SAYS: Record<What, readonly string[]> = {
  made: ['LINDO!', 'MUITO BEM!', 'GM LISBOA', 'WAGMI', 'SO BASED', 'OBRIGADO!', 'PERFEITO'],
  error: ['NGMI', 'AI AI AI', 'OOPS', 'WRONG TILE, ANON'],
  fall: ['CRACK!', 'SMASH!', 'RIP'],
};
const PHASE_BANNERS = ['BOM DIA, LISBOA!', 'NEW MOTIF: LAÇO', 'LINK 4 NOW!', 'LAST CALL · 5 MOTIFS'];
const COMBO_BANNERS = ['', '×2 LINDO', '×3 BELÍSSIMO', '×4 OBRA-PRIMA'];
/** Best practice score on this device (the best real score is the page's own: the leaderboard, then this device). */
const PRACTICE_BEST_KEY = 'wen-azulejo:best-practice';

type Mode = 'idle' | 'play' | 'end';
type Pop = { seq: number; e: AzEvent; t0: number };
type Bit = { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number; spin: number; a: number };
type Ghost = { cell: number; motif: number; t0: number; kind: 'made' | 'fall'; delay: number };
type Walker = { panel: number; x: number; dir: 1 | -1; speed: number; lane: number; t0: number };

/** The end card's title: what kind of tile painter this run made you (display only). */
export function painterTitle(play: AzState['play']): { title: string; line: string; good: boolean } {
  if (play.end === 'time') {
    if (play.cracks === 0) return { title: 'MESTRE AZULEJEIRO', line: 'Ninety seconds, not a single crack in the wall.', good: true };
    if (play.painted.length >= 15) return { title: 'PAINTER OF THE WALL', line: `${play.painted.length} names painted on the wall.`, good: true };
    if (play.bestCombo >= 12) return { title: 'AZULEJO MACHINE', line: `${play.bestCombo} azulejos in a row.`, good: true };
    return { title: 'LISBON STILL STANDS', line: 'The wall held for 90 seconds.', good: true };
  }
  if (play.made < 5) return { title: 'WEN AZULEJO? NOT TODAY', line: 'The fragments won this time.', good: false };
  if (play.errors >= 4) return { title: 'BULL IN A TILE SHOP', line: `${play.errors} wrong links. The tiles remember.`, good: false };
  return { title: 'CRACKED UNDER PRESSURE', line: `${play.made} azulejos before the wall gave way.`, good: false };
}

/* ------------------------------ drawing a tile ------------------------------ */
/** One azulejo fragment: glazed square, corner quarter-circles (they make circles with the neighbours), its motif. */
function drawTile(g: CanvasRenderingContext2D, motif: number, x: number, y: number, s: number, glow = 0): void {
  const c = INKS[motif] as string, cx = x + s / 2, cy = y + s / 2, r = s / 2;
  g.fillStyle = GLAZE; g.fillRect(x, y, s, s);
  g.strokeStyle = c; g.fillStyle = c; g.lineWidth = Math.max(1.5, s / 26);
  // the corner quarters
  for (const [qx, qy, a] of [[x, y, 0], [x + s, y, Math.PI / 2], [x + s, y + s, Math.PI], [x, y + s, Math.PI * 1.5]] as const) {
    g.beginPath(); g.arc(qx, qy, s * 0.2, a, a + Math.PI / 2); g.stroke();
  }
  g.beginPath(); g.rect(x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.88); g.globalAlpha = 0.35; g.stroke(); g.globalAlpha = 1;
  g.beginPath();
  if (motif === 0) {                                   // FLOR: four petals around a heart
    for (let k = 0; k < 4; k++) {
      g.save(); g.translate(cx, cy); g.rotate(k * Math.PI / 2);
      g.beginPath(); g.ellipse(0, -r * 0.34, r * 0.17, r * 0.3, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
    g.fillStyle = GLAZE; g.beginPath(); g.arc(cx, cy, r * 0.14, 0, Math.PI * 2); g.fill();
    g.fillStyle = c; g.beginPath(); g.arc(cx, cy, r * 0.08, 0, Math.PI * 2); g.fill();
  } else if (motif === 1) {                            // ESTRELA: an eight-point star
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8 - Math.PI / 2, rr = k % 2 ? r * 0.27 : r * 0.62;
      if (k) g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); else g.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
    g.fillStyle = GLAZE; g.beginPath(); g.arc(cx, cy, r * 0.12, 0, Math.PI * 2); g.fill();
  } else if (motif === 2) {                            // ONDA: three waves
    g.lineWidth = Math.max(2, s / 14);
    for (let k = -1; k <= 1; k++) {
      const yy = cy + k * r * 0.36;
      g.beginPath(); g.moveTo(cx - r * 0.62, yy);
      g.bezierCurveTo(cx - r * 0.3, yy - r * 0.3, cx - r * 0.1, yy + r * 0.3, cx + r * 0.1, yy);
      g.bezierCurveTo(cx + r * 0.3, yy - r * 0.3, cx + r * 0.45, yy + r * 0.2, cx + r * 0.62, yy);
      g.stroke();
    }
  } else if (motif === 3) {                            // LAÇO: a knot of four rings
    g.lineWidth = Math.max(2, s / 15);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      g.beginPath(); g.arc(cx + Math.cos(a) * r * 0.24, cy + Math.sin(a) * r * 0.24, r * 0.27, 0, Math.PI * 2); g.stroke();
    }
    g.fillRect(cx - r * 0.07, cy - r * 0.07, r * 0.14, r * 0.14);
  } else {                                             // SOL: a sun with twelve rays
    g.lineWidth = Math.max(2, s / 18);
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.36, cy + Math.sin(a) * r * 0.36); g.lineTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62); g.stroke();
    }
    g.beginPath(); g.arc(cx, cy, r * 0.27, 0, Math.PI * 2); g.fill();
  }
  if (glow > 0) { g.fillStyle = `rgba(255,255,255,${(0.6 * glow).toFixed(3)})`; g.fillRect(x, y, s, s); }
}

/* ------------------------------ a pixel stand-in ------------------------------ */
// A person of the wall without a character yet: a 16 × 16 pixel figure, colours from their name, four walking steps.
const SKIN = ['#F1C9A5', '#D9A47E', '#A8714F', '#6B4430', '#E8B98F'];
const TOP = ['#2E7FD6', '#3E7D4F', '#7A4FA3', '#D9A62E', '#5C6B78', '#B5462F', '#C7B9A6'];
const HAIR = ['#0B0B0B', '#5A3A22', '#C9A16B', '#8E2F1E', '#DEDBD3'];
function drawStandIn(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number, dir: number): void {
  const h = fnv1a(name), px = size / 16;
  const skin = SKIN[h % SKIN.length] as string, top = TOP[(h >>> 3) % TOP.length] as string, hair = HAIR[(h >>> 6) % HAIR.length] as string;
  const r = (cx: number, cy: number, w: number, hh: number, c: string): void => { g.fillStyle = c; g.fillRect(Math.round(x + cx * px), Math.round(y + cy * px), Math.ceil(w * px), Math.ceil(hh * px)); };
  const bob = step % 2 ? 0.5 : 0;
  r(5, 1 + bob, 6, 2, hair); r(5, 3 + bob, 6, 4, skin);
  if (dir === DIR.DOWN) { r(6, 4 + bob, 1, 1, INK); r(9, 4 + bob, 1, 1, INK); }
  else if (dir === DIR.LEFT) r(5, 4 + bob, 1, 1, INK);
  else if (dir === DIR.RIGHT) r(10, 4 + bob, 1, 1, INK);
  r(4, 7 + bob, 8, 5, top); r(3, 8 + bob, 1, 3, skin); r(12, 8 + bob, 1, 3, skin);
  const a = step % 4 === 1 ? 1 : step % 4 === 3 ? -1 : 0;
  r(5, 12, 2, 3 + (a > 0 ? 0 : 1), INK); r(9, 12, 2, 3 + (a < 0 ? 0 : 1), INK);
}
function drawPerson(g: CanvasRenderingContext2D, name: string, x: number, y: number, size: number, step: number, dir: number): void {
  const sheet: SpriteSheet | null = sheetOfName(name);
  if (sheet) drawSprite(g, sheet, x, y, size, step, dir);
  else drawStandIn(g, name, x, y, size, step, dir);
}

/* --------------------------------- sound --------------------------------- */
const SOUND_KEY = 'wen-azulejo:sound';
let audio: AudioContext | null = null;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
function beep(freqs: number[], len = 0.08, type: OscillatorType = 'square', gain = 0.05): void {
  if (!soundOn) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    let t = audio.currentTime;
    for (const f of freqs) {
      const o = audio.createOscillator(), v = audio.createGain();
      o.type = type; o.frequency.value = f; v.gain.setValueAtTime(gain, t); v.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(v).connect(audio.destination); o.start(t); o.stop(t + len); t += len * 0.9;
    }
  } catch { /* no sound on this device */ }
}
/** A plucked note per link (the chain climbs a Portuguese-guitar-ish scale), a chord per azulejo. */
const SCALE = [392, 440, 494, 523, 587, 659];
const SOUNDS: Record<What, (e: AzEvent) => void> = {
  made: (e) => beep(e.panels.length ? [523, 659, 784, 1047] : [523, 659, 784], 0.07, 'triangle', 0.05),
  error: () => beep([200, 140], 0.14, 'sawtooth', 0.06),
  fall: () => beep([300, 180], 0.07, 'square', 0.03),
};

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('az-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas az-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'WEN AZULEJO. Fragments of azulejos land on a wall of 6 by 7 slots. Drag across fragments of the same motif, each touching the one before (sideways or diagonally), or tap them one after the other, to complete an azulejo. Fragments with a name paint that name on the wall.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  const label = (): void => { soundButton.textContent = soundOn ? 'Sound on' : 'Sound off'; };
  label();
  soundButton.addEventListener('click', () => { soundOn = !soundOn; label(); try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* storage unavailable */ } });
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your run');
  host.append(canvas, endPanel, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  void loadPeople();
  onPeople(() => { dirty = true; });

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let finalScore: number | null = null;
  let view: AzState | null = null;          // the latest authoritative (or predicted) state
  let shown: AzState | null = null;         // that state brought to "now" by the rules: what is drawn
  let nowTick = 0;
  let seen = new Map<number, What>();       // event seq -> what, so each event plays once (and a correction replays)
  let pops: Pop[] = [];
  let bits: Bit[] = [];
  let ghosts: Ghost[] = [];
  let walkers: Walker[] = [];
  let signs: number[] = [];                 // the painted names, newest last
  let redCells: { cells: number[]; t0: number } | null = null;
  let banner: { text: string; t0: number; gold: boolean } | null = null;
  let lastPhase = -2, shake = 0, flash = 0, lastCount = -1;
  let endStats: EndStats | null = null;
  let dirty = true, DPR = 1;
  let hits = new HitFeed('wen-azulejo', false);
  /** The chain being linked: slots, and the id of the fragment in each (a fragment that falls breaks the chain). */
  let chain: { cell: number; id: number }[] = [];
  let dragging = false, pointer: number | null = null, pointerAt: { x: number; y: number } | null = null;

  function reset(isPractice: boolean): void {
    view = null; shown = null; nowTick = 0; seen = new Map(); pops = []; bits = []; ghosts = []; walkers = []; signs = [];
    redCells = null; banner = null; lastPhase = -2; shake = 0; flash = 0; lastCount = -1;
    finalScore = null; endStats = null; practice = isPractice; chain = []; dragging = false; pointer = null; pointerAt = null;
    hits = new HitFeed('wen-azulejo', isPractice ? false : undefined);
  }

  /* ------------------------------ text helpers ----------------------------- */
  function text(s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center', g: CanvasRenderingContext2D = ctx): void {
    g.font = font; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y);
  }
  function fitFont(s: string, maxW: number, size: number, family: string, g: CanvasRenderingContext2D = ctx): string {
    let sz = size;
    g.font = `${sz}px ${family}`;
    while (sz > 7 && g.measureText(s).width > maxW) { sz -= 1; g.font = `${sz}px ${family}`; }
    return `${sz}px ${family}`;
  }

  /* -------------------------------- input ----------------------------------- */
  // A drag (or taps, one fragment after the other) builds the chain on the page; releasing it with enough fragments
  // sends it, ONE input. Running onto a fragment of another motif mid-chain sends the chain as it is: the server rules
  // count it as an error. Nothing is decided here: the page only proposes slots.
  const playing = (): boolean => mode === 'play' && Boolean(shown) && !shown?.gameOver && io.canInput() && nowTick >= engine.openTickOf(shown as AzState);
  const tileIn = (cell: number): Tile | undefined => shown?.play.tiles.find((t) => t.cell === cell);
  const needNow = (): number => (shown ? engine.needAt(shown, nowTick) : 3);
  function cellAt(e: PointerEvent, strict: boolean): number | null {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    pointerAt = { x, y };
    const col = Math.floor((x - GX) / CELL), row = Math.floor((y - GY) / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    const cell = row * COLS + col;
    // while dragging, only the heart of a slot counts: a finger crossing a corner does not pick the diagonal neighbour
    if (strict && Math.hypot(x - cellX(cell), y - cellY(cell)) > CELL * 0.4) return null;
    return cell;
  }
  function send(cells: number[]): void {
    io.sendInput({ action: 'join', cells });
    chain = []; dragging = false;
  }
  /** Tries to add a slot to the chain: true when the pointer is now on the chain's last fragment. */
  function reach(cell: number): void {
    const tile = tileIn(cell);
    const last = chain[chain.length - 1];
    if (!tile || !last) return;
    if (chain.length >= 2 && chain[chain.length - 2]?.cell === cell) { chain.pop(); beep([330], 0.03, 'triangle', 0.02); return; }   // back one
    if (chain.some((c) => c.cell === cell) || !adjacent(last.cell, cell)) return;
    const first = tileIn((chain[0] as { cell: number }).cell);
    if (first && tile.motif !== first.motif) {
      // the wrong motif: with two or more linked, the chain goes out as it is (an error); with one, start again here
      if (chain.length >= 2) { send([...chain.map((c) => c.cell), cell]); return; }
      chain = [{ cell, id: tile.id }];
      return;
    }
    if (chain.length >= RULES.maxChain) return;
    chain.push({ cell, id: tile.id });
    beep([SCALE[Math.min(SCALE.length - 1, chain.length - 1)] as number], 0.05, 'triangle', 0.04);
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'play') return;
    e.preventDefault();
    if (!playing()) return;
    const cell = cellAt(e, false);
    if (cell === null) { chain = []; return; }
    const tile = tileIn(cell);
    if (!tile) { chain = []; return; }
    const last = chain[chain.length - 1];
    if (last && last.cell !== cell && adjacent(last.cell, cell) && !chain.some((c) => c.cell === cell)) reach(cell);   // a tap that extends
    else if (!last || last.cell !== cell) { chain = [{ cell, id: tile.id }]; beep([SCALE[0] as number], 0.05, 'triangle', 0.04); }
    dragging = chain.length > 0; pointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointer || !playing()) return;
    e.preventDefault();
    const cell = cellAt(e, true);
    if (cell !== null && cell !== chain[chain.length - 1]?.cell) reach(cell);
  });
  const release = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    pointer = null; pointerAt = null;
    if (!dragging) return;
    dragging = false;
    if (playing() && chain.length >= needNow()) send(chain.map((c) => c.cell));
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', (e) => { if (e.pointerId === pointer) { pointer = null; dragging = false; pointerAt = null; } });

  /* ------------------------------ state follow ------------------------------ */
  function burst(x: number, y: number, count: number, colors: readonly string[], power = 1): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = (100 + Math.random() * 220) * power;
      bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.6 + Math.random() * 0.6, c: colors[i % colors.length] as string, s: 4 + Math.random() * 5, spin: (Math.random() - 0.5) * 12, a: Math.random() * 6 });
    }
  }
  function follow(s: AzState): void {
    for (const e of s.play.events) {
      const before = seen.get(e.seq);
      if (before === e.what) continue;
      seen.set(e.seq, e.what);
      if (before === undefined) onEvent(e, s);
      pops = pops.filter((p) => p.seq !== e.seq);
      pops.push({ seq: e.seq, e, t0: performance.now() });
      if (pops.length > 6) pops.shift();
    }
    // a fragment of the chain gone (fallen, or taken by a correction): the chain breaks
    if (chain.some((c) => tileIn(c.cell)?.id !== c.id)) { chain = []; dragging = false; }
    if (s.gameOver) hits.flush();
  }
  function onEvent(e: AzEvent, s: AzState): void {
    SOUNDS[e.what](e);
    const now = performance.now();
    if (e.what === 'made') {
      e.cells.forEach((cell, i) => {
        ghosts.push({ cell, motif: e.motif, t0: now, kind: 'made', delay: i * 45 });
        burst(cellX(cell), cellY(cell), 8, [INKS[e.motif] as string, GLAZE, BLUE]);
      });
      for (const panel of e.panels) {
        signs.push(panel);
        const right = fnv1a(`w:${panel}`) % 2 === 1, behind = 60 * (walkers.length % 3);
        walkers.push({ panel, x: right ? -50 - behind : W + 10 + behind, dir: right ? 1 : -1, speed: 36 + (fnv1a(`v:${panel}`) % 30), lane: walkers.length % 2, t0: now });
        if (walkers.length > 8) walkers.shift();
        if (!practice) hits.add(panel);
        banner = { text: `${nameOfPanel(panel) || 'A NAME'} IS ON THE WALL!`, t0: now, gold: true };
        burst(W / 2, SIGNS_Y + 30, 30, [GOLD, BLUE, CHALK], 1.2);
      }
      const step = Math.floor(s.play.combo / RULES.comboEvery);
      if (!e.panels.length && s.play.combo > 0 && s.play.combo % RULES.comboEvery === 0 && step < COMBO_BANNERS.length) {
        banner = { text: COMBO_BANNERS[step] as string, t0: now, gold: true };
      }
    } else if (e.what === 'error') {
      redCells = { cells: e.cells, t0: now }; shake = 1; flash = 1;
    } else {
      for (const cell of e.cells) {
        ghosts.push({ cell, motif: e.motif, t0: now, kind: 'fall', delay: 0 });
        burst(cellX(cell), cellY(cell) + 20, 10, [INKS[e.motif] as string, GLAZE, '#8C8A84'], 0.7);
      }
      shake = Math.max(shake, 0.4);
    }
  }
  /** The state shown: the latest one, brought to the estimated server tick by the rules themselves. */
  function catchUp(): void {
    if (!view || mode !== 'play') return;
    const tick = Math.max(view.tick, io.estimatedTick());
    if (shown && tick === nowTick) return;
    nowTick = tick;
    shown = tick > view.tick ? engine.advance(view, tick) : view;
    follow(shown);
  }

  /* --------------------------------- drawing -------------------------------- */
  let backdrop: HTMLCanvasElement | null = null;
  /** The wall of empty slots (mortar and faint outlines), the street-sign band and the calçada, drawn once. */
  function wallBackdrop(): HTMLCanvasElement {
    if (backdrop) return backdrop;
    const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(DPR, DPR);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    // the wall: lime plaster with empty slots
    g.fillStyle = '#E9E4D8'; g.fillRect(GX - 8, GY - 8, COLS * CELL + 16, ROWS * CELL + 16);
    g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(GX - 8, GY - 8, COLS * CELL + 16, ROWS * CELL + 16);
    for (let cell = 0; cell < CELLS; cell++) {
      const x = GX + (cell % COLS) * CELL + 3, y = GY + Math.floor(cell / COLS) * CELL + 3;
      g.fillStyle = '#DDD7C9'; g.fillRect(x, y, CELL - 6, CELL - 6);
      g.strokeStyle = 'rgba(11,11,11,.08)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, CELL - 7, CELL - 7);
    }
    // the calçada portuguesa: black and white waves
    g.fillStyle = '#EDEAE2'; g.fillRect(0, STREET_Y, W, H - STREET_Y);
    g.fillStyle = '#2A2927';
    for (let x = -40; x < W + 40; x += 4) {
      for (let band = 0; band < 3; band++) {
        const y = STREET_Y + 18 + band * 40 + Math.sin((x + band * 30) / 34) * 9;
        g.fillRect(x, y, 3, 6);
      }
    }
    g.fillStyle = INK; g.fillRect(0, STREET_Y - 2, W, 2);
    backdrop = c;
    return c;
  }

  function crackIcon(x: number, y: number, broken: boolean): void {
    ctx.fillStyle = broken ? RED : CHALK; ctx.fillRect(x, y, 12, 12);
    if (broken) { ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 2, y + 1); ctx.lineTo(x + 6, y + 6); ctx.lineTo(x + 4, y + 8); ctx.lineTo(x + 9, y + 11); ctx.stroke(); }
  }
  function hud(s: AzState | null): void {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, HUD_H);
    if (!s) { text('WEN AZULEJO', W / 2, 40, `40px ${F_ANTON}`, CHALK); text('NFC SUMMIT · LISBOA', W / 2, 74, `500 11px ${F_MONO}`, '#B0ACA2'); return; }
    const end = engine.endTickOf(s), open = engine.openTickOf(s);
    const secs = Math.ceil(Math.max(0, end - Math.max(nowTick, open)) * TICK_MS / 1000);
    const urgent = nowTick >= open && secs <= 10 && !s.gameOver;
    text(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 28, `34px ${F_ANTON}`, urgent ? GOLD : CHALK);
    // the timer bar: 90 s draining
    const left = Math.max(0, Math.min(1, (end - Math.max(nowTick, open)) / RULES.playTicks));
    ctx.fillStyle = '#2A2927'; ctx.fillRect(W / 2 - 60, 50, 120, 4); ctx.fillStyle = urgent ? GOLD : BLUE; ctx.fillRect(W / 2 - 60, 50, 120 * left, 4);
    const t = Math.max(nowTick, open), need = engine.needAt(s, t);
    const speed = RULES.intervalStart / engine.intervalAt(s, t);
    text(`LINK ${need} · SPEED ×${speed.toFixed(1)}`, W / 2, 70, `500 11px ${F_MONO}`, speed >= 1.8 ? GOLD : '#B0ACA2');
    // the score sits low on the left: the page's own ← and PRACTICE tag take the top-left corner
    text(fmtScore(s.play.score), 14, 64, `30px ${F_ANTON}`, CHALK, 'left');
    const mult = engine.multOf(s.play.combo);
    if (s.play.combo >= 2) text(`${mult > 1 ? `×${mult} · ` : ''}${s.play.combo} IN A ROW`, 14, 88, `500 10px ${F_MONO}`, mult > 1 ? GOLD : '#B0ACA2', 'left');
    // the cracks: twelve tiles, two rows, right
    for (let i = 0; i < RULES.maxCracks; i++) crackIcon(W - 26 - (i % 6) * 16, 10 + Math.floor(i / 6) * 16, i < s.play.cracks);
    text(`CRACKS ${s.play.cracks}/${RULES.maxCracks}`, W - 14, 54, `500 10px ${F_MONO}`, s.play.cracks >= RULES.maxCracks - 3 ? RED : '#8C8A84', 'right');
    text(`PAINTED ${s.play.painted.length}`, W - 14, 72, `500 10px ${F_MONO}`, s.play.painted.length ? GOLD : '#8C8A84', 'right');
    if (nowTick >= open && !s.gameOver) {
      const phase = engine.phaseAt(s, nowTick);
      if (phase !== lastPhase) { banner = { text: PHASE_BANNERS[phase] as string, t0: performance.now(), gold: phase === RULES.motifs.length - 1 }; lastPhase = phase; }
    }
  }

  function tiles(s: AzState, now: number): void {
    const chainCells = new Set(chain.map((c) => c.cell));
    for (const t of s.play.tiles) {
      const x = GX + (t.cell % COLS) * CELL, y = GY + Math.floor(t.cell / COLS) * CELL;
      const life = Math.max(0, Math.min(1, (t.dies - nowTick) / (t.dies - t.born)));
      const fresh = Math.min(1, (nowTick - t.born) / 6);                 // lands with a little drop
      const wobble = life < 0.3 ? Math.sin(now / 45 + t.id) * (1 - life / 0.3) * 2.2 : 0;
      const sel = chainCells.has(t.cell);
      const pad = sel ? 1 : 4, size = CELL - pad * 2;
      ctx.save();
      ctx.translate(x + CELL / 2 + wobble, y + CELL / 2 - (1 - fresh) * 14);
      ctx.globalAlpha = 0.4 + 0.6 * fresh;
      if (t.panel) { ctx.fillStyle = GOLD; ctx.fillRect(-size / 2 - 3, -size / 2 - 3, size + 6, size + 6); }
      drawTile(ctx, t.motif, -size / 2, -size / 2, size, sel ? 0.15 : 0);
      if (sel) { ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(-size / 2, -size / 2, size, size); }
      // the cracks of a fragment about to fall
      if (life < 0.45) {
        ctx.strokeStyle = 'rgba(11,11,11,.7)'; ctx.lineWidth = 1.4; ctx.beginPath();
        const h = fnv1a(`c:${t.id}`), k = (0.45 - life) / 0.45;
        ctx.moveTo(-size / 2 + (h % 20), -size / 2); ctx.lineTo(-4 + (h % 9), -6 * k); ctx.lineTo(6, 4 * k); ctx.lineTo(size / 2 - ((h >>> 5) % 18), size / 2 * k);
        ctx.stroke();
      }
      // the life bar
      ctx.fillStyle = life < 0.3 ? RED : 'rgba(11,11,11,.25)'; ctx.fillRect(-size / 2 + 4, size / 2 - 5, (size - 8) * life, 3);
      if (t.panel) {
        const name = nameOfPanel(t.panel);
        ctx.fillStyle = INK; ctx.fillRect(-size / 2, -size / 2 - 2, size, 13);
        text(name, 0, -size / 2 + 5, fitFont(name, size - 4, 10, F_MONO), GOLD);
      }
      ctx.restore();
    }
    // the chain: a cord through the linked fragments, to the finger
    if (chain.length) {
      ctx.strokeStyle = INK; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const path = (): void => {
        ctx.beginPath();
        chain.forEach((c, i) => { if (i) ctx.lineTo(cellX(c.cell), cellY(c.cell)); else ctx.moveTo(cellX(c.cell), cellY(c.cell)); });
        if (dragging && pointerAt) ctx.lineTo(pointerAt.x, pointerAt.y);
        ctx.stroke();
      };
      path(); ctx.strokeStyle = chain.length >= needNow() ? GOLD : CHALK; ctx.lineWidth = 3; path();
      for (const c of chain) { ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(cellX(c.cell), cellY(c.cell), 6, 0, Math.PI * 2); ctx.fill(); }
      const need = needNow(), last = chain[chain.length - 1] as { cell: number };
      text(`${chain.length}/${need}`, cellX(last.cell), cellY(last.cell) - CELL / 2 - 2, `14px ${F_ANTON}`, chain.length >= need ? GOLD : INK);
    }
    if (redCells) {
      const t = (now - redCells.t0) / 600;
      if (t >= 1) redCells = null;
      else for (const cell of redCells.cells) { ctx.fillStyle = `rgba(214,69,50,${(0.55 * (1 - t)).toFixed(3)})`; ctx.fillRect(cellX(cell) - CELL / 2, cellY(cell) - CELL / 2, CELL, CELL); }
    }
  }
  /** Completed fragments flash and fly to the street signs; fallen ones drop and turn. */
  function ghostTiles(now: number): void {
    ghosts = ghosts.filter((gh) => now - gh.t0 - gh.delay < 700);
    for (const gh of ghosts) {
      const t = (now - gh.t0 - gh.delay) / 700;
      if (t < 0) { drawTile(ctx, gh.motif, cellX(gh.cell) - CELL / 2 + 4, cellY(gh.cell) - CELL / 2 + 4, CELL - 8, 1); continue; }
      ctx.save();
      if (gh.kind === 'made') {
        const s = 1 + Math.sin(Math.min(1, t * 2) * Math.PI) * 0.25;
        ctx.globalAlpha = 1 - t;
        ctx.translate(cellX(gh.cell), cellY(gh.cell) + (SIGNS_Y - cellY(gh.cell)) * t * t); ctx.scale(s * (1 - t * 0.6), s * (1 - t * 0.6));
        drawTile(ctx, gh.motif, -(CELL - 8) / 2, -(CELL - 8) / 2, CELL - 8, Math.max(0, 1 - t * 3));
      } else {
        ctx.globalAlpha = 1 - t;
        ctx.translate(cellX(gh.cell), cellY(gh.cell) + 220 * t * t); ctx.rotate(t * 1.6);
        drawTile(ctx, gh.motif, -(CELL - 8) / 2, -(CELL - 8) / 2, CELL - 8);
      }
      ctx.restore();
    }
  }

  /** A Lisbon street sign, azulejo style: white tiles, cobalt border and letters, "RUA" over the name. */
  function streetSign(g: CanvasRenderingContext2D, name: string, x: number, y: number, w: number, h: number): void {
    g.fillStyle = GLAZE; g.fillRect(x, y, w, h);
    g.strokeStyle = COBALT; g.lineWidth = 3; g.strokeRect(x + 3, y + 3, w - 6, h - 6);
    g.lineWidth = 1; g.strokeRect(x + 7, y + 7, w - 14, h - 14);
    g.strokeStyle = 'rgba(31,79,163,.25)';
    for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x + (w * k) / 4, y); g.lineTo(x + (w * k) / 4, y + h); g.stroke(); }
    text('RUA', x + w / 2, y + h * 0.3, `500 ${Math.round(h * 0.15)}px ${F_MONO}`, COBALT, 'center', g);
    text(name, x + w / 2, y + h * 0.63, fitFont(name, w - 20, Math.round(h * 0.34), F_ANTON, g), COBALT, 'center', g);
  }
  function street(now: number, idle: boolean): void {
    // the signs: the last three names painted
    const shownSigns = signs.slice(-3);
    if (!shownSigns.length) text(idle ? 'COMPLETE NAMED TILES TO PAINT THE WALL' : 'NAMES PAINTED ON THE WALL SHOW UP HERE', W / 2, SIGNS_Y + 38, `500 11px ${F_MONO}`, LABEL);
    shownSigns.forEach((panel, i) => {
      const x = 10 + i * 135, age = (now - (pops.find((p) => p.e.panels.includes(panel))?.t0 ?? 0)) / 400;
      const drop = age < 1 && i === shownSigns.length - 1 ? (1 - age) * -30 : 0;
      streetSign(ctx, nameOfPanel(panel), x, SIGNS_Y + 4 + drop, 129, 72);
    });
    if (signs.length > 3) text(`+${signs.length - 3}`, W - 6, SIGNS_Y + 84, `500 10px ${F_MONO}`, LABEL, 'right');
    // the people of the painted names walk down the street
    const dt = 1 / 60;
    walkers.forEach((wk) => {
      wk.x += wk.dir * wk.speed * dt;
      if (wk.x > W + 20) wk.dir = -1;
      if (wk.x < -60) wk.dir = 1;
      const y = STREET_Y + 26 + wk.lane * 50, name = nameOfPanel(wk.panel);
      drawPerson(ctx, name, wk.x, y, 44, stepAt(now + wk.panel * 37), wk.dir > 0 ? DIR.RIGHT : DIR.LEFT);
      ctx.font = fitFont(name, 90, 10, F_MONO);
      text(name, wk.x + 22, y - 6, ctx.font, INK);
    });
  }

  function popups(now: number): void {
    for (const p of pops) {
      const t = (now - p.t0) / 1100;
      if (t >= 1) continue;
      const e = p.e, cell = e.cells[e.cells.length - 1] ?? 0, x = Math.max(40, Math.min(W - 40, cellX(cell))), y = cellY(cell) - 30 - t * 26;
      ctx.globalAlpha = 1 - Math.max(0, t - 0.7) / 0.3;
      const tagText = e.gain > 0 ? `+${e.gain}` : e.gain < 0 ? `${e.gain}` : e.what === 'fall' ? 'CRACK' : '';
      if (tagText) text(tagText, x, y, `24px ${F_ANTON}`, e.gain > 0 ? (e.panels.length ? GOLD : INK) : RED);
      if (e.what !== 'fall' || fnv1a(`s:${p.seq}`) % 3 === 0) text(pick(SAYS[e.what], `${e.what}:${p.seq}`), x, y - 22, `500 12px ${F_MONO}`, e.what === 'made' ? COBALT : RED);
      ctx.globalAlpha = 1;
    }
  }
  function banners(now: number): void {
    if (!banner) return;
    const t = (now - banner.t0) / 1500;
    if (t >= 1) { banner = null; return; }
    const pop = Math.min(1, t * 8);
    ctx.save();
    ctx.globalAlpha = 1 - Math.max(0, t - 0.75) / 0.25;
    ctx.translate(W / 2, GY + ROWS * CELL / 2); ctx.rotate(-0.05); ctx.scale(pop, pop);
    ctx.font = fitFont(banner.text, W - 60, 38, F_ANTON);
    const w = ctx.measureText(banner.text).width + 36;
    ctx.fillStyle = banner.gold ? GOLD : INK; ctx.fillRect(-w / 2, -30, w, 60);
    text(banner.text, 0, 1, ctx.font, banner.gold ? INK : CHALK);
    ctx.restore();
  }
  function countdown(s: AzState): void {
    const left = engine.openTickOf(s) - nowTick;
    if (left <= 0 || s.gameOver) return;
    ctx.fillStyle = 'rgba(222,219,211,.94)'; ctx.fillRect(0, HUD_H, W, H - HUD_H);
    text(String(Math.ceil(left * TICK_MS / 1000)), W / 2, 170, `100px ${F_ANTON}`, BLUE);
    text('LINK 3 OF A KIND', W / 2, 250, `32px ${F_ANTON}`, INK);
    // the example: three flowers linked
    for (let i = 0; i < 3; i++) drawTile(ctx, 0, W / 2 - 96 + i * 66, 290, 60);
    ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(W / 2 - 66, 320); ctx.lineTo(W / 2 + 66, 320); ctx.stroke();
    text('drag across them, or tap one after the other', W / 2, 372, `500 13px ${F_MONO}`, INK);
    text('sideways or diagonally · one motif per chain', W / 2, 394, `500 13px ${F_MONO}`, INK);
    ctx.fillStyle = GOLD; ctx.fillRect(W / 2 - 33, 422, 66, 66); drawTile(ctx, 2, W / 2 - 30, 425, 60);
    text('golden = a name of the wall: paint it!', W / 2, 512, `500 13px ${F_MONO}`, INK);
    text('fragments that wait too long fall and crack the wall', W / 2, 544, `500 12px ${F_MONO}`, RED);
    text('12 cracks and it crumbles · faster and faster · 90 s', W / 2, 566, `500 12px ${F_MONO}`, LABEL);
    const n = Math.ceil(left * TICK_MS / 1000);
    if (n !== lastCount) { lastCount = n; beep([440], 0.05, 'sine'); }
  }

  function draw(now: number): void {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = CONCRETE; ctx.fillRect(0, 0, W, H);
    if (mode === 'end') return;                          // the end panel and the page's bar cover the stage
    const s = mode === 'idle' ? null : shown;
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 6 * shake);
    ctx.drawImage(wallBackdrop(), 0, 0, W * DPR, H * DPR, 0, 0, W, H);
    if (s && mode === 'play') {
      tiles(s, now);
      ghostTiles(now);
      street(now, false);
      popups(now);
      hud(s);
      banners(now);
      countdown(s);
      if (s.gameOver) {
        ctx.fillStyle = 'rgba(222,219,211,.9)'; ctx.fillRect(0, 300, W, 170);
        const head = s.play.end === 'cracked' ? 'THE WALL CRUMBLED' : 'THE WALL STANDS!';
        text(head, W / 2, 360, fitFont(head, W - 40, 52, F_ANTON), s.play.end === 'cracked' ? RED : BLUE);
        if (s.play.bonus) text(`SURVIVAL BONUS +${fmtScore(s.play.bonus)}`, W / 2, 420, `500 14px ${F_MONO}`, INK);
      }
    } else {
      // the entry: a quiet wall of azulejos behind the page's own overlay
      for (let cell = 0; cell < CELLS; cell++) {
        const k = fnv1a(`idle:${cell}:${Math.floor((now + cell * 397) / 2600)}`);
        if (k % 3 === 0) continue;
        drawTile(ctx, k % MOTIFS.length, GX + (cell % COLS) * CELL + 4, GY + Math.floor(cell / COLS) * CELL + 4, CELL - 8);
      }
      if (!walkers.length && WALL_PANELS.length) {
        for (let i = 0; i < 4; i++) {
          const panel = (WALL_PANELS[(fnv1a(`idlew:${i}`) % WALL_PANELS.length)] as { p: number }).p;
          walkers.push({ panel, x: i * 110, dir: i % 2 ? -1 : 1, speed: 30 + i * 6, lane: i % 2, t0: now });
        }
      }
      street(now, true);
      hud(null);
    }
    for (const b of bits) {
      ctx.save(); ctx.globalAlpha = Math.min(1, b.life); ctx.fillStyle = b.c; ctx.translate(b.x, b.y); ctx.rotate(b.a);
      ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.7); ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (flash > 0) { ctx.fillStyle = `rgba(214,69,50,${(flash * 0.22).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  }

  /* ------------------------------- end screen ------------------------------- */
  function practiceBest(score: number | null): number | null {
    try {
      const before = Number(localStorage.getItem(PRACTICE_BEST_KEY));
      const best = Math.max(Number.isFinite(before) ? before : 0, score ?? 0);
      if (score !== null && score > (Number.isFinite(before) ? before : 0)) localStorage.setItem(PRACTICE_BEST_KEY, String(score));
      return best > 0 ? best : null;
    } catch { return score; }
  }
  /** The end card, 1080 × 1080: the pattern you made, the names you painted, the score. */
  function endCard(s: AzState | null, score: number, best: string): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = CONCRETE; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = INK; g.fillRect(0, 0, 1080, 140);
    text('WEN AZULEJO', 60, 72, `80px ${F_ANTON}`, CHALK, 'left', g);
    text(practice ? 'PRACTICE' : 'NFC SUMMIT · LISBOA', 1020, 72, `500 26px ${F_MONO}`, practice ? BLUE : '#B0ACA2', 'right', g);
    const p = s?.play;
    if (p) {
      const t = painterTitle(p);
      text(t.title, 58, 210, fitFont(t.title, 960, 88, F_ANTON, g), t.good ? COBALT : RED, 'left', g);
      text(t.line, 62, 276, `500 26px ${F_MONO}`, INK, 'left', g);
    }
    text(fmtScore(score), 58, 360, `90px ${F_ANTON}`, INK, 'left', g);
    g.font = `90px ${F_ANTON}`;
    const sw = g.measureText(fmtScore(score)).width;
    const rank = practice ? undefined : rankOf(endStats?.rank);
    text(`POINTS${rank ? ` · #${rank} THIS WEEK` : ''}`, 58 + sw + 24, 382, `500 24px ${F_MONO}`, LABEL, 'left', g);
    if (best) text(best, 1020, 382, `500 22px ${F_MONO}`, LABEL, 'right', g);
    g.fillStyle = 'rgba(11,11,11,.12)'; g.fillRect(60, 420, 960, 2);
    if (p) {
      // the pattern you made: every azulejo completed, in order, 8 a row (the last 40)
      const tilesMade = p.mosaic.slice(-40);
      text(`YOUR PATTERN · ${p.made} AZULEJO${p.made === 1 ? '' : 'S'}`, 60, 452, `500 22px ${F_MONO}`, INK, 'left', g);
      const size = 66;
      g.fillStyle = '#E9E4D8'; g.fillRect(56, 476, 8 * size + 8, 5 * size + 8);
      tilesMade.forEach((m, i) => drawTile(g, m, 60 + (i % 8) * size, 480 + Math.floor(i / 8) * size, size - 2));
      if (!tilesMade.length) text('no azulejo this time', 60 + 4 * size, 480 + 2.5 * size, `500 22px ${F_MONO}`, LABEL, 'center', g);
      // the names you painted
      const painted = p.painted;
      text(`PAINTED ON THE WALL · ${painted.length}`, 620, 452, `500 22px ${F_MONO}`, INK, 'left', g);
      painted.slice(0, 5).forEach((panel, i) => streetSign(g, nameOfPanel(panel), 620, 480 + i * 68, 400, 62));
      if (painted.length > 5) text(`+${painted.length - 5} more`, 1020, 830, `500 22px ${F_MONO}`, LABEL, 'right', g);
      if (!painted.length) text('golden tiles carry names: paint them!', 820, 560, `500 20px ${F_MONO}`, LABEL, 'center', g);
      // their people
      painted.slice(0, 8).forEach((panel, i) => drawPerson(g, nameOfPanel(panel), 60 + i * 120, 846, 104, 0, DIR.DOWN));
    }
    const player = endStats?.player;                    // an ENS name only: an address says nothing on a card
    if (player && !/^0x[0-9a-f]{40}$/i.test(player)) text(player, 1020, 960, `500 26px ${F_MONO}`, INK, 'right', g);
    g.fillStyle = INK; g.fillRect(0, 980, 1080, 100);
    text('A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON', 540, 1030, `500 24px ${F_MONO}`, CHALK, 'center', g);
    return c;
  }
  function renderEnd(): void {
    const s = shown ?? view;
    const score = finalScore ?? s?.play.score ?? 0;
    let best = '';
    if (practice) { const b = practiceBest(score); best = b ? `PRACTICE BEST ${fmtScore(b)}` : ''; }
    else if (Number(endStats?.best) > 0) best = `${(endStats as EndStats).bestLabel.toUpperCase()} ${fmtScore(Number((endStats as EndStats).best))}`;
    const card = endCard(s, score, best);
    card.className = 'end-card';
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', `Your card: ${score} points, ${s?.play.made ?? 0} azulejos, ${s?.play.painted.length ?? 0} names painted.`);
    const nodes: HTMLElement[] = [card];
    if (!practice && s) {
      const gameUrl = `${location.origin}/`;
      const tags = s.play.painted.map((panel) => tag(SNAPSHOT_NAME.get(panel)?.n ?? nameOfPanel(panel), handleOf(panel))).filter(Boolean);
      const title = painterTitle(s.play).title, made = s.play.made;
      const tweet = fitTweet(tags, (names, more) => `${title}: ${score} points on WEN AZULEJO, ${made} azulejo${made === 1 ? '' : 's'} for the wall of NFC Summit, Lisbon.${names ? ` I painted ${names}${more ? ' …' : ''} on the wall.` : ''} ${gameUrl}`, gameUrl);
      const post = document.createElement('a');
      post.className = 'end-post'; post.target = '_blank'; post.rel = 'noopener';
      post.href = intentHref(tweet); post.textContent = 'Post on X';
      nodes.push(post);
    }
    const wall = document.createElement('a');
    wall.className = 'end-wall'; wall.href = 'https://onthewall.nfcsummit.com'; wall.target = '_blank'; wall.rel = 'noopener';
    wall.textContent = 'get on the wall';
    nodes.push(wall);
    endPanel.replaceChildren(...nodes);
  }

  /* ---------------------------- layout and main loop ------------------------ */
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || W, availH = frameEl.clientHeight || H;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    DPR = canvas.width / W;
    backdrop = null; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { backdrop = null; dirty = true; }).catch(() => undefined);

  let lastFrame = performance.now(), idleT = 0;
  function frame(t: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t;
    if (shake > 0.05) shake *= Math.pow(0.004, dt); else shake = 0;
    if (flash > 0) flash = Math.max(0, flash - dt * 3);
    for (const b of bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.vy += 520 * dt; b.life -= dt; b.a += b.spin * dt; }
    if (bits.length) bits = bits.filter((b) => b.life > 0);
    if (mode === 'play') { catchUp(); draw(t); }
    else if (mode === 'idle' && t - idleT > 60) { idleT = t; draw(t); }
    else if (dirty) { draw(t); dirty = false; }
  }
  requestAnimationFrame(frame);

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      chain = []; dragging = false;
      if (extra?.idle) { mode = 'idle'; endPanel.hidden = true; walkers = []; return; }
      if (extra && typeof extra.final === 'number') {
        finalScore = extra.final;
        practice = Boolean(extra.practice);
        if (extra.view && typeof extra.view === 'object' && !view) { view = extra.view as AzState; shown = view; }
        mode = 'end';
        hits.flush();
        renderEnd(); endPanel.hidden = false;
      } else if (mode !== 'end') { mode = 'idle'; endPanel.hidden = true; }
    },
    hideRun(): void {
      if (mode !== 'play') return;
      mode = view?.gameOver ? 'end' : 'idle';
      chain = []; dragging = false;
      if (mode === 'end') { renderEnd(); endPanel.hidden = false; }
      dirty = true;
    },
    endStats(stats: EndStats): void {
      endStats = stats;
      if (mode === 'end') renderEnd();
    },
    showRun(next: AzState, info): void {
      const nextPractice = Boolean(info.practice);
      if (mode !== 'play' || nextPractice !== practice || (view && view.seed !== next.seed)) {
        reset(nextPractice); mode = 'play'; endPanel.hidden = true;
      }
      if (next !== view) { view = next; shown = null; nowTick = -1; }
      catchUp();
    },
  };
}

export const wenAzulejoAdapter: GameAdapter = {
  id: 'wen-azulejo',
  title: 'WEN AZULEJO',
  heading: 'Paint the wall',
  tagline: 'Lisbon, NFC Summit. Link fragments of azulejos, paint the names of the wall, keep the wall from cracking. 90 seconds.',
  lede: 'Fragments of azulejos land on a wall of empty slots. Drag across fragments of the same motif, each touching the one before (sideways or diagonally), or tap them one after the other: 3 of a kind complete an azulejo (4 from the second half), longer chains score more. Golden fragments carry a name of the wall: complete them to paint that name on the wall, for a bonus, and each one repairs a crack. A fragment left too long falls and cracks the wall; a chain that runs onto another motif is an error and cracks it too. Twelve cracks and the wall crumbles. Fragments come faster and new motifs arrive as the clock runs down; azulejos in a row multiply your points. Hold the wall for 90 seconds for a big bonus. One credit per run, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: AzState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: AzState) => state.play.score,
  statusLine(state: AzState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    const open = engine.openTickOf(state);
    if (tick < open) return `The wall opens in ${Math.ceil((open - tick) * TICK_MS / 1000)}`;
    const left = Math.max(0, engine.endTickOf(state) - tick) * TICK_MS / 1000;
    return `Score ${state.play.score} · cracks ${state.play.cracks}/${RULES.maxCracks} · ${Math.ceil(left)} s left`;
  },
  createStage,
  diagSummary: (s: AzState) => ({ tick: s.tick, started: s.started, startTick: s.startTick, gameOver: s.gameOver, score: s.play.score, cracks: s.play.cracks, tiles: s.play.tiles.length, made: s.play.made, last: s.play.events.at(-1) ?? null }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('wen-azulejo')),
    advance: (state: AzState, tick: number) => engine.advance(state, tick),
  },
};
