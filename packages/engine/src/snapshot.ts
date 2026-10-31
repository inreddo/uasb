import type { GameState } from './types.ts';
import { assertInvariants, requireRule, RuleError, validateCatalog } from './validation.ts';

/** Private local/server save only. It contains BOTH hands and the complete shuffle state. */
export function serializeGame(state: GameState): string {
  assertInvariants(state);
  return JSON.stringify(state);
}

/** Restore a trusted save from this engine version, not an untrusted player submission. */
export function restoreGame(json: string): GameState {
  try {
    const state: GameState = JSON.parse(json);
    requireRule(state !== null && typeof state === 'object' && !Array.isArray(state), 'INVALID_STATE', '存档格式无效。');
    // Previous snapshots contain only the original basic primitives. New optional fields default empty.
    const old = state as unknown as { schemaVersion: number; rulesVersion: string };
    if (old.schemaVersion === 1 && old.rulesVersion === 'ua-basic-2026-09-24') {
      old.schemaVersion = 2; old.rulesVersion = 'ua-effects-2026-09-25';
    }
    validateCatalog(Object.values(state.catalog));
    assertInvariants(state);
    return state;
  } catch (error) {
    if (error instanceof RuleError && error.code === 'INVALID_STATE') throw error;
    throw new RuleError('INVALID_STATE', '无法恢复存档：数据损坏、规则未支持或版本不兼容。');
  }
}
