import snapshot from './wall.json' with { type: 'json' };

/** The named panels of the wall at build time (the verifier has no network): position, name, X handle when known. */
export type WallPanel = { p: number; n: string; h?: string };
export const WALL_PANELS: readonly WallPanel[] = snapshot.positions;
