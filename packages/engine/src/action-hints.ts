import { checkAction, getDefinition, raidBaseEligible } from './engine.ts';
import type { Action, CardId, GameState, PlayerId } from './types.ts';

/** Private, advisory facts for manual-action confirmations; never a command permission. */
export type ActionHints = { hasLegalAttack: boolean; raidableHandIds: CardId[] };

/** Candidate shapes only. All permissions, targets, costs and resulting effects stay in checkAction. */
export function* raidHintCandidates(state: GameState, player: PlayerId, cardId: CardId): Generator<Extract<Action, { type: 'raid' }>> {
  const own = state.players[player];
  for (const [line, bases] of [['front', own.front], ['energy', own.energy]] as const) {
    for (const base of bases) {
      // This shared rule is a cheap necessary prerequisite, including special re-RAID/base grants.
      if (!raidBaseEligible(state, player, cardId, base.cardId)) continue;
      const action = { type: 'raid' as const, cardId, baseId: base.cardId };
      yield action;
      if (line !== 'energy') continue;
      yield { ...action, moveToFront: true };
      // Do not hardcode line capacity: the command owns capacity changes and replacement rules.
      for (const replacement of own.front) yield { ...action, moveToFront: true, replace: replacement.cardId };
    }
  }
}

export function actionHints(state: GameState, viewer: PlayerId | null): ActionHints | undefined {
  if (viewer === null || viewer !== state.activePlayer || state.status !== 'playing'
    || state.pending != null || state.effect != null || state.battle != null
    || (state.phase !== 'main' && state.phase !== 'attack')) return undefined;
  const own = state.players[viewer];
  const hints: ActionHints = { hasLegalAttack: false, raidableHandIds: [] };
  if (state.phase === 'attack') {
    for (const card of [...own.front, ...own.energy]) {
      if (!card.active || getDefinition(state, card.cardId).kind !== 'character') continue;
      if (checkAction(state, viewer, { type: 'attack', cardId: card.cardId }).legal) {
        hints.hasLegalAttack = true; break;
      }
      for (const target of state.players[viewer === 0 ? 1 : 0].front) {
        if (checkAction(state, viewer, { type: 'attack', cardId: card.cardId, targetId: target.cardId }).legal) {
          hints.hasLegalAttack = true; break;
        }
      }
      if (hints.hasLegalAttack) break;
    }
    return hints;
  }
  for (const cardId of own.hand) {
    const definition = getDefinition(state, cardId);
    if (definition.kind !== 'character' || !definition.raid) continue;
    for (const candidate of raidHintCandidates(state, viewer, cardId)) {
      if (!checkAction(state, viewer, candidate).legal) continue;
      hints.raidableHandIds.push(cardId);
      break;
    }
  }
  return hints;
}
