// WEN AZULEJO · ROSÁCEA: the browser side. The page draws the wall of azulejos with the platform's authoritative state
// (the player's own queued taps applied by the very module the verifier runs, then brought to "now" by that same module)
// and turns a tap into ONE ordered input: { action: 'turn', cell, id }. It never sends a score, a time or a state: which
// rosette closed, which tile fell, which name was painted and what it is worth is decided by the rules on SuperRare's
// server.
//
// The painted names become Lisbon street signs and their people (people.json sprites, a pixel stand-in otherwise) walk
// down the calçada under the wall. Glazes, the turning animation, hints, sounds, street signs, sprites and the end card
// are display only.
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
  CELLS, COLS, ROWS, RULES, VCOLS, VERTS, cornersOf, engine, inputSchema, snapshotSchema, stateSchema,
  type AzEvent, type AzState, type Tile, type What,
} from './engine.js';

const W = 420, H = 800, TICK_MS = 50;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', BLUE = '#2E7FD6', LABEL = '#6B685F';
const GLAZE = '#F7F4EC', GROUT = '#CFC8B8', GOLD = '#D9A62E', RED = '#D64532', COBALT = '#1F4FA3';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const HUD_H = 96;
const CELL = 64, GX = (W - COLS * CELL) / 2, GY = 106;            // the wall of azulejos
const SIGNS_Y = GY + ROWS * CELL + 10;                              // the street signs of the painted names
const STREET_Y = SIGNS_Y + 92;                                      // the calçada, where the painted people walk
/** The glazes: cobalt, ochre, green, manganese, terracotta. Each also has its own mark (colour is never the only cue). */
const INKS = ['#1F4FA3', '#D08A12', '#2F7A4A', '#6B3FA0', '#C2522D'];
const SNAPSHOT_NAME = new Map(WALL_PANELS.map((p) => [p.p, p]));
const nameOfPanel = (panel: number): string => infoOf(panel).name.toUpperCase() || SNAPSHOT_NAME.get(panel)?.n.toUpperCase() || '';
const handleOf = (panel: number): string => infoOf(panel).handle || SNAPSHOT_NAME.get(panel)?.h || '';
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const cellX = (cell: number): number => GX + (cell % COLS) * CELL + CELL / 2;
const cellY = (cell: number): number => GY + Math.floor(cell / COLS) * CELL + CELL / 2;
const vertX = (v: number): number => GX + ((v % VCOLS) + 1) * CELL;
const vertY = (v: number): number => GY + (Math.floor(v / VCOLS) + 1) * CELL;
const pick = <T,>(list: readonly T[], key: string): T => list[fnv1a(key) % list.length] as T;

/** What the wall says (display only, picked from the event number). */
const SAYS: Record<What, readonly string[]> = {
  rosette: ['LINDO!', 'MUITO BEM!', 'GM LISBOA', 'WAGMI', 'SO BASED', 'OBRIGADO!', 'PERFEITO'],
  cascade: ['CASCATA!', 'FREE ROSETTE', 'LUCKY TILE'],
  spin: ['RODOU DEMAIS!', 'TOO MUCH SPIN', 'NGMI', 'AI AI AI'],
  fall: ['SOS!', 'CRACK!', 'RIP AZULEJO'],
};
const PHASE_BANNERS = ['BOM DIA, LISBOA!', 'NEW GLAZE: MANGANÊS', 'SOS AZULEJO!', 'LAST CALL · 5 GLAZES'];
const COMBO_BANNERS = ['', '×2 LINDO', '×3 BELÍSSIMO', '×4 OBRA-PRIMA'];
/** Best practice score on this device (the best real score is the page's own: the leaderboard, then this device). */
const PRACTICE_BEST_KEY = 'wen-azulejo:best-practice';
const TURN_MS = 140;

type Mode = 'idle' | 'play' | 'end';
type Pop = { seq: number; e: AzEvent; t0: number };
type Bit = { x: number; y: number; vx: number; vy: number; life: number; c: string; s: number; spin: number; a: number };
type Ghost = { cell: number; c: number[]; t0: number; kind: 'made' | 'fall' | 'spin'; delay: number };
type Bloom = { v: number; color: number; t0: number };
type Walker = { panel: number; x: number; dir: 1 | -1; speed: number; lane: number; t0: number };

/** The end card's title: what kind of tile setter this run made you (display only). */
export function setterTitle(play: AzState['play']): { title: string; line: string; good: boolean } {
  if (play.end === 'time') {
    if (play.cracks === 0) return { title: 'MESTRE AZULEJEIRO', line: 'Ninety seconds, not a single crack in the wall.', good: true };
    if (play.painted.length >= 12) return { title: 'PAINTER OF THE WALL', line: `${play.painted.length} names painted on the wall.`, good: true };
    if (play.rescued >= 25) return { title: 'SOS HERO', line: `${play.rescued} loose tiles saved before they fell.`, good: true };
    if (play.bestCombo >= 15) return { title: 'ROSETTE MACHINE', line: `${play.bestCombo} rosettes in a row.`, good: true };
    return { title: 'LISBON STILL STANDS', line: 'The wall held for 90 seconds.', good: true };
  }
  if (play.made < 5) return { title: 'WEN AZULEJO? NOT TODAY', line: 'The tiles won this time.', good: false };
  if (play.spun >= 4) return { title: 'DIZZY TILE SETTER', line: `${play.spun} tiles turned until they cracked.`, good: false };
  return { title: 'CRACKED UNDER PRESSURE', line: `${play.made} rosettes before the wall gave way.`, good: false };
}

/* ------------------------------ drawing a tile ------------------------------ */
/** The glaze's own mark, at (x, y): a dot, a diamond, a leaf, a ring, a triangle. */
function mark(g: CanvasRenderingContext2D, color: number, x: number, y: number, r: number): void {
  g.fillStyle = GLAZE; g.strokeStyle = GLAZE; g.lineWidth = Math.max(1.5, r * 0.5);
  g.beginPath();
  if (color === 0) { g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  else if (color === 1) { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.2, y); g.lineTo(x, y + r * 1.2); g.lineTo(x - r * 1.2, y); g.closePath(); g.fill(); }
  else if (color === 2) { g.ellipse(x, y, r * 1.4, r * 0.6, Math.PI / 4, 0, Math.PI * 2); g.fill(); }
  else if (color === 3) { g.arc(x, y, r * 0.95, 0, Math.PI * 2); g.stroke(); }
  else { g.moveTo(x, y - r * 1.2); g.lineTo(x + r * 1.1, y + r * 0.8); g.lineTo(x - r * 1.1, y + r * 0.8); g.closePath(); g.fill(); }
}
/** One azulejo, its top-left at (x, y), `s` px: glazed square, a quarter of a circle in each corner (the corners of four
 *  tiles close into a rosette), a small star in the middle. */
function drawTile(g: CanvasRenderingContext2D, c: readonly number[], x: number, y: number, s: number): void {
  g.fillStyle = GLAZE; g.fillRect(x, y, s, s);
  const R = s * 0.44;
  const corners: [number, number, number][] = [[x, y, 0], [x + s, y, Math.PI / 2], [x + s, y + s, Math.PI], [x, y + s, Math.PI * 1.5]];
  corners.forEach(([cx, cy, a], k) => {
    const color = c[k] as number;
    g.fillStyle = INKS[color] as string;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a, a + Math.PI / 2); g.closePath(); g.fill();
    g.strokeStyle = GLAZE; g.lineWidth = Math.max(1, s / 40);
    g.beginPath(); g.arc(cx, cy, R * 0.72, a, a + Math.PI / 2); g.stroke();
    const mid = a + Math.PI / 4;
    mark(g, color, cx + Math.cos(mid) * R * 0.42, cy + Math.sin(mid) * R * 0.42, s * 0.045);
  });
  // the middle: a small four-point star
  const mx = x + s / 2, my = y + s / 2, r = s * 0.11;
  g.fillStyle = '#9C9483';
  g.beginPath(); g.moveTo(mx, my - r); g.lineTo(mx + r * 0.3, my - r * 0.3); g.lineTo(mx + r, my); g.lineTo(mx + r * 0.3, my + r * 0.3);
  g.lineTo(mx, my + r); g.lineTo(mx - r * 0.3, my + r * 0.3); g.lineTo(mx - r, my); g.lineTo(mx - r * 0.3, my - r * 0.3); g.closePath(); g.fill();
  g.strokeStyle = GROUT; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
}
/** A closed rosette: a full disc of one glaze with its four marks (the end card's pattern, the bloom when it closes). */
function drawRosette(g: CanvasRenderingContext2D, color: number, x: number, y: number, R: number): void {
  g.fillStyle = INKS[color] as string; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = GLAZE; g.lineWidth = Math.max(1, R / 18); g.beginPath(); g.arc(x, y, R * 0.72, 0, Math.PI * 2); g.stroke();
  for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2; mark(g, color, x + Math.cos(a) * R * 0.42, y + Math.sin(a) * R * 0.42, R * 0.1); }
  g.fillStyle = GLAZE; g.beginPath(); g.arc(x, y, R * 0.12, 0, Math.PI * 2); g.fill();
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
const SOUNDS: Record<What, (e: AzEvent) => void> = {
  rosette: (e) => beep(e.panels.length ? [523, 659, 784, 1047] : [523, 659, 784], 0.07, 'triangle', 0.05),
  cascade: () => beep([784, 988, 1175], 0.06, 'triangle', 0.04),
  spin: () => beep([200, 140], 0.14, 'sawtooth', 0.06),
  fall: () => beep([300, 180, 120], 0.08, 'square', 0.04),
};

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('az-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas az-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'WEN AZULEJO. A wall of 6 by 7 azulejos, each with four coloured corners. Tap a tile to turn it a quarter turn. Where four corners of one colour meet, a rosette closes. Save the loose tiles (SOS) by putting them in a rosette; golden tiles paint a name of the wall.');
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
  let blooms: Bloom[] = [];
  let walkers: Walker[] = [];
  let signs: number[] = [];                 // the painted names, newest last
  /** The turning animation: tile id -> its corners as last drawn, and when it last turned. */
  let faces = new Map<number, { key: string; t0: number }>();
  let pressed: { cell: number; t0: number } | null = null;
  let banner: { text: string; t0: number; gold: boolean } | null = null;
  let lastPhase = -2, shake = 0, flash = 0, lastCount = -1;
  let endStats: EndStats | null = null;
  let dirty = true, DPR = 1;
  let hits = new HitFeed('wen-azulejo', false);

  function reset(isPractice: boolean): void {
    view = null; shown = null; nowTick = 0; seen = new Map(); pops = []; bits = []; ghosts = []; blooms = []; walkers = []; signs = [];
    faces = new Map(); pressed = null; banner = null; lastPhase = -2; shake = 0; flash = 0; lastCount = -1;
    finalScore = null; endStats = null; practice = isPractice;
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
  // A tap names the slot AND the tile in it: a tile that left the slot in the meantime (a rosette, a fall) is never
  // turned by mistake on the server. Nothing is decided here: the page only proposes the turn.
  function tap(e: PointerEvent): void {
    if (mode !== 'play') return;
    e.preventDefault();
    if (!shown || shown.gameOver || !io.canInput() || nowTick < engine.openTickOf(shown)) return;
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * H / r.height;
    const col = Math.floor((x - GX) / CELL), row = Math.floor((y - GY) / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
    const cell = row * COLS + col, tile = shown.play.tiles[cell];
    if (!tile || tile.at > nowTick) return;
    pressed = { cell, t0: performance.now() };
    beep([330 + tile.turns * 70], 0.04, 'triangle', 0.035);
    io.sendInput({ action: 'turn', cell, id: tile.id });
  }
  canvas.addEventListener('pointerdown', tap);

  /* ------------------------------ state follow ------------------------------ */
  function burst(x: number, y: number, count: number, colors: readonly string[], power = 1): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = (100 + Math.random() * 220) * power;
      bits.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.6 + Math.random() * 0.6, c: colors[i % colors.length] as string, s: 4 + Math.random() * 5, spin: (Math.random() - 0.5) * 12, a: Math.random() * 6 });
    }
  }
  function follow(s: AzState, prev: AzState | null): void {
    for (const e of s.play.events) {
      const before = seen.get(e.seq);
      if (before === e.what) continue;
      seen.set(e.seq, e.what);
      if (before === undefined) onEvent(e, s, prev);
      pops = pops.filter((p) => p.seq !== e.seq);
      pops.push({ seq: e.seq, e, t0: performance.now() });
      if (pops.length > 6) pops.shift();
    }
    if (s.gameOver) hits.flush();
  }
  function onEvent(e: AzEvent, s: AzState, prev: AzState | null): void {
    SOUNDS[e.what](e);
    const now = performance.now();
    // the tiles that left: as they were just before (the previous state shown), else in the event's colour
    const oldFace = (cell: number): number[] => {
      const t = prev?.play.tiles[cell];
      return t && t.at <= nowTick ? t.c.slice() : [Math.max(0, e.color), Math.max(0, e.color), Math.max(0, e.color), Math.max(0, e.color)];
    };
    if (e.what === 'rosette' || e.what === 'cascade') {
      blooms.push({ v: e.vertex, color: e.color, t0: now });
      e.cells.forEach((cell, i) => ghosts.push({ cell, c: oldFace(cell), t0: now, kind: 'made', delay: 120 + i * 40 }));
      burst(vertX(e.vertex), vertY(e.vertex), 18, [INKS[e.color] as string, GLAZE, BLUE]);
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
    } else {
      for (const cell of e.cells) {
        ghosts.push({ cell, c: oldFace(cell), t0: now, kind: e.what === 'fall' ? 'fall' : 'spin', delay: 0 });
        burst(cellX(cell), cellY(cell) + 20, 14, [RED, GLAZE, '#8C8A84'], 0.8);
      }
      shake = e.what === 'spin' ? 1 : 0.6; flash = e.what === 'spin' ? 1 : 0.5;
    }
  }
  /** The state shown: the latest one, brought to the estimated server tick by the rules themselves. */
  function catchUp(): void {
    if (!view || mode !== 'play') return;
    const tick = Math.max(view.tick, io.estimatedTick());
    if (shown && tick === nowTick) return;
    const prev = shown;
    nowTick = tick;
    shown = tick > view.tick ? engine.advance(view, tick) : view;
    follow(shown, prev);
  }

  /* --------------------------------- drawing -------------------------------- */
  let backdrop: HTMLCanvasElement | null = null;
  /** The wall's frame and empty slots, the street-sign band and the calçada, drawn once. */
  function wallBackdrop(): HTMLCanvasElement {
    if (backdrop) return backdrop;
    const c = document.createElement('canvas'); c.width = W * DPR; c.height = H * DPR;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.scale(DPR, DPR);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    g.fillStyle = '#E9E4D8'; g.fillRect(GX - 8, GY - 8, COLS * CELL + 16, ROWS * CELL + 16);
    g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(GX - 8, GY - 8, COLS * CELL + 16, ROWS * CELL + 16);
    g.fillStyle = '#D8D1C2'; g.fillRect(GX, GY, COLS * CELL, ROWS * CELL);
    g.strokeStyle = 'rgba(11,11,11,.08)'; g.lineWidth = 1;
    for (let cell = 0; cell < CELLS; cell++) g.strokeRect(GX + (cell % COLS) * CELL + 0.5, GY + Math.floor(cell / COLS) * CELL + 0.5, CELL - 1, CELL - 1);
    // the calçada portuguesa: black and white waves
    g.fillStyle = '#EDEAE2'; g.fillRect(0, STREET_Y, W, H - STREET_Y);
    g.fillStyle = '#2A2927';
    for (let x = -40; x < W + 40; x += 4) {
      for (let band = 0; band < 3; band++) g.fillRect(x, STREET_Y + 18 + band * 40 + Math.sin((x + band * 30) / 34) * 9, 3, 6);
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
    if (!s) { text('WEN AZULEJO', W / 2, 40, `40px ${F_ANTON}`, CHALK); text('ROSÁCEA · NFC SUMMIT · LISBOA', W / 2, 74, `500 11px ${F_MONO}`, '#B0ACA2'); return; }
    const end = engine.endTickOf(s), open = engine.openTickOf(s);
    const secs = Math.ceil(Math.max(0, end - Math.max(nowTick, open)) * TICK_MS / 1000);
    const urgent = nowTick >= open && secs <= 10 && !s.gameOver;
    text(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, W / 2, 28, `34px ${F_ANTON}`, urgent ? GOLD : CHALK);
    const left = Math.max(0, Math.min(1, (end - Math.max(nowTick, open)) / RULES.playTicks));
    ctx.fillStyle = '#2A2927'; ctx.fillRect(W / 2 - 60, 50, 120, 4); ctx.fillStyle = urgent ? GOLD : BLUE; ctx.fillRect(W / 2 - 60, 50, 120 * left, 4);
    const t = Math.max(nowTick, open), speed = RULES.looseStart / engine.looseAt(s, t);
    text(`${engine.colorsAt(s, t)} GLAZES · SOS ×${speed.toFixed(1)}`, W / 2, 70, `500 11px ${F_MONO}`, speed >= 2 ? GOLD : '#B0ACA2');
    // the score sits low on the left: the page's own ← and PRACTICE tag take the top-left corner
    text(fmtScore(s.play.score), 14, 64, `30px ${F_ANTON}`, CHALK, 'left');
    const mult = engine.multOf(s.play.combo);
    if (s.play.combo >= 2) text(`${mult > 1 ? `×${mult} · ` : ''}${s.play.combo} IN A ROW`, 14, 88, `500 10px ${F_MONO}`, mult > 1 ? GOLD : '#B0ACA2', 'left');
    for (let i = 0; i < RULES.maxCracks; i++) crackIcon(W - 26 - (i % 6) * 16, 10 + Math.floor(i / 6) * 16, i < s.play.cracks);
    text(`CRACKS ${s.play.cracks}/${RULES.maxCracks}`, W - 14, 54, `500 10px ${F_MONO}`, s.play.cracks >= RULES.maxCracks - 3 ? RED : '#8C8A84', 'right');
    text(`PAINTED ${s.play.painted.length}`, W - 14, 72, `500 10px ${F_MONO}`, s.play.painted.length ? GOLD : '#8C8A84', 'right');
    if (nowTick >= open && !s.gameOver) {
      const phase = engine.phaseAt(s, nowTick);
      if (phase !== lastPhase) { banner = { text: PHASE_BANNERS[phase] as string, t0: performance.now(), gold: phase === RULES.colors.length - 1 }; lastPhase = phase; }
    }
  }

  /** One tile in its slot: turning (a quarter turn eased in), shaking when loose, golden with a name, three notches for
   *  the turns it still takes. */
  function tileAt(t: Tile, cell: number, now: number): void {
    const x = GX + (cell % COLS) * CELL, y = GY + Math.floor(cell / COLS) * CELL;
    const key = t.c.join('');
    let face = faces.get(t.id);
    if (!face) { face = { key, t0: -1e9 }; faces.set(t.id, face); }
    else if (face.key !== key) { face.key = key; face.t0 = now; }
    const turnT = Math.min(1, (now - face.t0) / TURN_MS), ease = 1 - (1 - turnT) * (1 - turnT);
    const land = Math.min(1, Math.max(0, (nowTick - t.at) / 6));
    const loose = t.loose > 0, left = loose ? Math.max(0, t.loose - nowTick) : 0;
    const wobble = loose ? Math.sin(now / (left < 40 ? 30 : 60) + cell) * (left < 40 ? 3 : 1.5) : 0;
    const press = pressed && pressed.cell === cell ? Math.max(0, 1 - (now - pressed.t0) / 150) : 0;
    ctx.save();
    ctx.translate(x + CELL / 2 + wobble, y + CELL / 2 - (1 - land) * 18);
    ctx.globalAlpha = 0.3 + 0.7 * land;
    ctx.rotate(-(1 - ease) * Math.PI / 2 + (loose ? wobble * 0.02 : 0));
    const s = CELL * (1 - press * 0.06);
    drawTile(ctx, t.c, -s / 2, -s / 2, s);
    ctx.restore();
    ctx.save();
    ctx.translate(x, y);
    if (t.panel) {
      ctx.strokeStyle = GOLD; ctx.lineWidth = 4; ctx.strokeRect(2, 2, CELL - 4, CELL - 4);
      const name = nameOfPanel(t.panel);
      ctx.fillStyle = INK; ctx.fillRect(6, CELL / 2 - 7, CELL - 12, 14);
      text(name, CELL / 2, CELL / 2, fitFont(name, CELL - 16, 10, F_MONO), GOLD);
    }
    // once it has turned: the turns it still takes, three dots under the star (red when spent; all red = the next cracks it)
    if (t.turns > 0) {
      for (let k = 0; k < RULES.maxTurns; k++) {
        ctx.fillStyle = k < RULES.maxTurns - t.turns ? INK : RED;
        ctx.beginPath(); ctx.arc(CELL / 2 - 8 + k * 8, CELL / 2 + 13, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (loose) {
      const frac = Math.max(0, Math.min(1, left / RULES.graceStart));
      ctx.strokeStyle = RED; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.strokeRect(1.5, 1.5, CELL - 3, CELL - 3); ctx.setLineDash([]);
      ctx.fillStyle = RED; ctx.fillRect(0, -6, CELL * frac, 4);
      ctx.fillStyle = RED; ctx.fillRect(CELL / 2 - 15, 4, 30, 13);
      text('SOS', CELL / 2, 11, `500 10px ${F_MONO}`, CHALK);
    }
    ctx.restore();
  }
  /** Junctions three corners of one colour away from a rosette: a faint dotted circle (a hint, display only). */
  function hints(s: AzState): void {
    ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = 2;
    for (let v = 0; v < VERTS; v++) {
      const counts = new Map<number, number>();
      let ok = true;
      for (const [cell, k] of cornersOf(v)) {
        const t = s.play.tiles[cell] as Tile;
        if (t.at > nowTick) { ok = false; break; }
        counts.set(t.c[k] as number, (counts.get(t.c[k] as number) ?? 0) + 1);
      }
      if (!ok) continue;
      for (const [color, n] of counts) if (n === 3) {
        ctx.strokeStyle = INKS[color] as string; ctx.globalAlpha = 0.55;
        ctx.beginPath(); ctx.arc(vertX(v), vertY(v), CELL * 0.48, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function wall(s: AzState, now: number): void {
    s.play.tiles.forEach((t, cell) => { if (t.at <= nowTick) tileAt(t, cell, now); });
    hints(s);
    // ghosts: the tiles of a rosette flip away, a fallen tile drops, a cracked one shatters
    ghosts = ghosts.filter((gh) => now - gh.t0 - gh.delay < 650);
    for (const gh of ghosts) {
      const t = (now - gh.t0 - gh.delay) / 650;
      const x = cellX(gh.cell), y = cellY(gh.cell);
      ctx.save();
      if (t < 0) { ctx.translate(x - CELL / 2, y - CELL / 2); drawTile(ctx, gh.c, 0, 0, CELL); ctx.restore(); continue; }
      ctx.globalAlpha = 1 - t;
      if (gh.kind === 'made') { ctx.translate(x, y); ctx.scale(Math.max(0.01, Math.cos(t * Math.PI / 2)), 1 - t * 0.2); }
      else if (gh.kind === 'fall') { ctx.translate(x, y + 260 * t * t); ctx.rotate(t * 1.4); }
      else { ctx.translate(x, y); ctx.rotate(Math.sin(t * 30) * 0.15); }
      drawTile(ctx, gh.c, -CELL / 2, -CELL / 2, CELL);
      if (gh.kind === 'spin') { ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-20, -28); ctx.lineTo(4, -2); ctx.lineTo(-6, 8); ctx.lineTo(18, 30); ctx.stroke(); }
      ctx.restore();
    }
    // blooms: the rosette that just closed, swelling out of the junction
    blooms = blooms.filter((b) => now - b.t0 < 700);
    for (const b of blooms) {
      const t = (now - b.t0) / 700;
      ctx.save(); ctx.globalAlpha = 1 - t * t;
      drawRosette(ctx, b.color, vertX(b.v), vertY(b.v), CELL * (0.44 + t * 0.5));
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
    const shownSigns = signs.slice(-3);
    if (!shownSigns.length) text(idle ? 'ROSETTES WITH GOLDEN TILES PAINT THE WALL' : 'NAMES PAINTED ON THE WALL SHOW UP HERE', W / 2, SIGNS_Y + 38, `500 11px ${F_MONO}`, LABEL);
    shownSigns.forEach((panel, i) => {
      const x = 10 + i * 135, age = (now - (pops.find((p) => p.e.panels.includes(panel))?.t0 ?? 0)) / 400;
      const drop = age < 1 && i === shownSigns.length - 1 ? (1 - age) * -30 : 0;
      streetSign(ctx, nameOfPanel(panel), x, SIGNS_Y + 4 + drop, 129, 72);
    });
    if (signs.length > 3) text(`+${signs.length - 3}`, W - 6, SIGNS_Y + 84, `500 10px ${F_MONO}`, LABEL, 'right');
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
      const e = p.e, made = e.what === 'rosette' || e.what === 'cascade';
      const x0 = made ? vertX(e.vertex) : cellX(e.cells[0] ?? 0), y0 = made ? vertY(e.vertex) : cellY(e.cells[0] ?? 0);
      const x = Math.max(44, Math.min(W - 44, x0)), y = y0 - 34 - t * 26;
      ctx.globalAlpha = 1 - Math.max(0, t - 0.7) / 0.3;
      const tagText = e.gain > 0 ? `+${e.gain}` : e.gain < 0 ? `${e.gain}` : 'CRACK';
      text(tagText, x, y, `24px ${F_ANTON}`, e.gain > 0 ? (e.panels.length ? GOLD : INK) : RED);
      if (!made || fnv1a(`s:${p.seq}`) % 2 === 0 || e.what === 'cascade') text(pick(SAYS[e.what], `${e.what}:${p.seq}`), x, y - 22, `500 12px ${F_MONO}`, made ? COBALT : RED);
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
  function countdown(s: AzState, now: number): void {
    const left = engine.openTickOf(s) - nowTick;
    if (left <= 0 || s.gameOver) return;
    ctx.fillStyle = 'rgba(222,219,211,.95)'; ctx.fillRect(0, HUD_H, W, H - HUD_H);
    text(String(Math.ceil(left * TICK_MS / 1000)), W / 2, 160, `90px ${F_ANTON}`, BLUE);
    text('TAP A TILE TO TURN IT', W / 2, 232, `30px ${F_ANTON}`, INK);
    // the example: four tiles closing a cobalt rosette, the last one turning into place
    const ex = W / 2 - 60, ey = 262, sz = 60, spin = Math.min(1, ((now / 1400) % 1) * 2);
    drawTile(ctx, [1, 2, 0, 1], ex, ey, sz); drawTile(ctx, [2, 1, 2, 0], ex + sz, ey, sz); drawTile(ctx, [1, 0, 2, 2], ex, ey + sz, sz);
    ctx.save(); ctx.translate(ex + sz * 1.5, ey + sz * 1.5); ctx.rotate(-(1 - spin) * Math.PI / 2); drawTile(ctx, [0, 2, 1, 2], -sz / 2, -sz / 2, sz); ctx.restore();
    if (spin >= 1) { ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(ex + sz, ey + sz, sz * 0.46, 0, Math.PI * 2); ctx.stroke(); }
    text('4 corners of one colour = a ROSETTE', W / 2, 400, `500 13px ${F_MONO}`, INK);
    text('each tile takes 3 turns · the 4th cracks it', W / 2, 424, `500 13px ${F_MONO}`, INK);
    text('SOS: a loose tile falls unless it joins a rosette', W / 2, 460, `500 13px ${F_MONO}`, RED);
    text('golden tile = a name of the wall: paint it!', W / 2, 484, `500 13px ${F_MONO}`, '#9A7414');
    text('12 cracks and the wall crumbles · 90 s', W / 2, 520, `500 12px ${F_MONO}`, LABEL);
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
      wall(s, now);
      street(now, false);
      popups(now);
      hud(s);
      banners(now);
      countdown(s, now);
      if (s.gameOver) {
        ctx.fillStyle = 'rgba(222,219,211,.9)'; ctx.fillRect(0, 300, W, 170);
        const head = s.play.end === 'cracked' ? 'THE WALL CRUMBLED' : 'THE WALL STANDS!';
        text(head, W / 2, 360, fitFont(head, W - 40, 52, F_ANTON), s.play.end === 'cracked' ? RED : BLUE);
        if (s.play.bonus) text(`SURVIVAL BONUS +${fmtScore(s.play.bonus)}`, W / 2, 420, `500 14px ${F_MONO}`, INK);
      }
    } else {
      // the entry: a quiet wall of azulejos turning by themselves behind the page's own overlay
      for (let cell = 0; cell < CELLS; cell++) {
        const k = fnv1a(`idle:${cell}`), r = Math.floor((now + (k % 9000)) / 2400) % 4;
        let c = [k % 3, (k >>> 3) % 3, (k >>> 6) % 3, (k >>> 9) % 3];
        for (let i = 0; i < r; i++) c = [c[3] as number, c[0] as number, c[1] as number, c[2] as number];
        drawTile(ctx, c, GX + (cell % COLS) * CELL, GY + Math.floor(cell / COLS) * CELL, CELL);
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
  /** The end card, 1080 × 1080: the rosettes you closed, the names you painted, the score. */
  function endCard(s: AzState | null, score: number, best: string): HTMLCanvasElement {
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    g.fillStyle = CONCRETE; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = INK; g.fillRect(0, 0, 1080, 140);
    text('WEN AZULEJO', 60, 72, `80px ${F_ANTON}`, CHALK, 'left', g);
    text(practice ? 'PRACTICE' : 'ROSÁCEA · LISBOA', 1020, 72, `500 26px ${F_MONO}`, practice ? BLUE : '#B0ACA2', 'right', g);
    const p = s?.play;
    if (p) {
      const t = setterTitle(p);
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
      // the pattern you made: every rosette closed, in order (the last 40), 8 a row
      const made = p.mosaic.slice(-40);
      text(`YOUR PATTERN · ${p.made} ROSETTE${p.made === 1 ? '' : 'S'} · ${p.rescued} SAVED`, 60, 452, `500 22px ${F_MONO}`, INK, 'left', g);
      const size = 66;
      g.fillStyle = '#E9E4D8'; g.fillRect(56, 476, 8 * size + 8, 5 * size + 8);
      made.forEach((color, i) => drawRosette(g, color, 60 + (i % 8) * size + size / 2, 480 + Math.floor(i / 8) * size + size / 2, size * 0.46));
      if (!made.length) text('no rosette this time', 60 + 4 * size, 480 + 2.5 * size, `500 22px ${F_MONO}`, LABEL, 'center', g);
      const painted = p.painted;
      text(`PAINTED ON THE WALL · ${painted.length}`, 620, 452, `500 22px ${F_MONO}`, INK, 'left', g);
      painted.slice(0, 5).forEach((panel, i) => streetSign(g, nameOfPanel(panel), 620, 480 + i * 68, 400, 62));
      if (painted.length > 5) text(`+${painted.length - 5} more`, 1020, 830, `500 22px ${F_MONO}`, LABEL, 'right', g);
      if (!painted.length) text('golden tiles carry names: paint them!', 820, 560, `500 20px ${F_MONO}`, LABEL, 'center', g);
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
    card.setAttribute('aria-label', `Your card: ${score} points, ${s?.play.made ?? 0} rosettes, ${s?.play.painted.length ?? 0} names painted.`);
    const nodes: HTMLElement[] = [card];
    if (!practice && s) {
      const gameUrl = `${location.origin}/`;
      const tags = s.play.painted.map((panel) => tag(SNAPSHOT_NAME.get(panel)?.n ?? nameOfPanel(panel), handleOf(panel))).filter(Boolean);
      const title = setterTitle(s.play).title, made = s.play.made;
      const tweet = fitTweet(tags, (names, more) => `${title}: ${score} points on WEN AZULEJO, ${made} rosette${made === 1 ? '' : 's'} for the wall of NFC Summit, Lisbon.${names ? ` I painted ${names}${more ? ' …' : ''} on the wall.` : ''} ${gameUrl}`, gameUrl);
      const post = document.createElement('a');
      post.className = 'end-post'; post.target = '_blank'; post.rel = 'noopener';
      post.href = intentHref(tweet); post.textContent = 'Post on X';
      nodes.push(post);
    }
    const wallLink = document.createElement('a');
    wallLink.className = 'end-wall'; wallLink.href = 'https://onthewall.nfcsummit.com'; wallLink.target = '_blank'; wallLink.rel = 'noopener';
    wallLink.textContent = 'get on the wall';
    nodes.push(wallLink);
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
      if (next !== view) { view = next; nowTick = -1; }
      catchUp();
    },
  };
}

export const wenAzulejoAdapter: GameAdapter = {
  id: 'wen-azulejo',
  title: 'WEN AZULEJO',
  heading: 'Close the rosettes',
  tagline: 'Lisbon, NFC Summit. Turn the azulejos, close the rosettes, save the loose tiles, paint the names of the wall. 90 seconds.',
  lede: `A wall of azulejos, each with four coloured corners. Tap a tile to turn it a quarter turn. Where four tiles meet with corners of one colour, the circle closes: a rosette. It scores, and its tiles are relaid with new ones (which may close rosettes by themselves). Each tile takes ${RULES.maxTurns} turns; a fourth that closes nothing cracks it. SOS: now and then a tile comes loose; put it in a rosette before it falls, or the wall cracks. Golden tiles carry a name of the wall: a rosette with one paints the name, for a bonus, and repairs a crack. Twelve cracks and the wall crumbles. New glazes arrive and tiles come loose faster as the clock runs down; rosettes in a row multiply your points. Hold the wall for 90 seconds for a big bonus. One credit per run, scored by the server.`,
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
  diagSummary: (s: AzState) => ({ tick: s.tick, started: s.started, startTick: s.startTick, gameOver: s.gameOver, score: s.play.score, cracks: s.play.cracks, made: s.play.made, loose: s.play.tiles.filter((t) => t.loose).length, last: s.play.events.at(-1) ?? null }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('wen-azulejo')),
    advance: (state: AzState, tick: number) => engine.advance(state, tick),
  },
};
