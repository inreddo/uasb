import type { GameState } from './types.ts';

/** Reproducible test/local PRNG, NOT suitable for adversarial online games. */
function next(state: Pick<GameState, 'rng'>): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let n = state.rng;
  n = Math.imul(n ^ (n >>> 15), n | 1);
  n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
  return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
}

export function shuffle<T>(state: Pick<GameState, 'rng'>, values: T[]): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(next(state) * (i + 1));
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
}

/**
 * One uniform draw, for 「相手がランダムに1枚選ぶ」. The caller passes a non-empty list; the same
 * reproducible generator the shuffle uses answers, so a seeded game replays identically.
 */
export function randomPick<T>(state: Pick<GameState, 'rng'>, values: T[]): T {
  return values[Math.floor(next(state) * values.length)]!;
}
