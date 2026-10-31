import type { Action, PlayerView } from '../packages/engine/src/index.ts';

/** A deliberately simple demo policy. Reads ONLY the acting player's redacted view. */
export function chooseExampleAction(view: PlayerView): Action {
  const player = view.decision?.player ?? view.activePlayer;
  const own = view.players[player]!;
  const enemy = view.players[player === 0 ? 1 : 0]!;
  const pending = view.decision;
  switch (pending?.type) {
    case 'mulligan': return { type: 'mulligan', redraw: false };
    case 'block': return { type: 'block', cardId: null };
    case 'damage': return { type: 'chooseDamage', slots: enemy.life.slots.slice(0, pending.count) };
    case 'discard': return { type: 'discard', cards: own.hand.cards!.slice(0, pending.count).map(c => c.id) };
    case 'effect': {
      const choice = pending.choice!;
      const options = choice.kind === 'ap' ? choice.options.filter(o => own.ap[Number(o.id.slice(3))] === 'rested') : choice.options;
      return { type: 'chooseEffect', choiceId: choice.id, selected: options.slice(0, choice.max).map(o => o.id) };
    }
    case 'lineOverflow': {
      // 「上限を超えた分をリムーブ」 — the first resident is as good as any for a demo policy.
      const first = pending.cards![0];
      return first ? { type: 'resolveLineOverflow', cardId: first.id } : { type: 'advance' };
    }
    case 'energyOverflow': {
      // 「満线腾位」(Q1614) — same spirit: take the first candidate.
      const first = pending.cards![0];
      return first ? { type: 'resolveEnergyOverflow', cardId: first.id } : { type: 'advance' };
    }
    case 'triggers': {
      const cards = pending.revealed!;
      if (!cards.length) return { type: 'resolveEffect', taskId: pending.effects![0]!.id };
      const card = (own.life.count === 0 ? cards.find(c => c.definition.trigger?.type === 'final') : undefined) ?? cards[0]!;
      const trigger = card.definition.trigger;
      const target = trigger?.type === 'active' ? [...own.front, ...own.energy].find(c => c.definition.kind === 'character')
        : trigger?.type === 'special' ? enemy.front[0] : undefined;
      return { type: 'resolveTrigger', cardId: card.id, activate: true, ...(target ? { targetId: target.id } : {}) };
    }
  }
  if (view.phase === 'movement') {
    const moves = own.energy.filter(c => c.definition.kind === 'character').slice(0, 4 - own.front.length).map(c => ({ cardId: c.id, to: 'front' as const }));
    return { type: 'move', moves };
  }
  if (view.phase === 'main') {
    const ap = own.ap.filter(a => a === 'active').length;
    for (const card of own.hand.cards!) {
      const d = card.definition;
      if (d.apCost > ap || Object.entries(d.requiredEnergy).some(([color, n]) => (own.producedEnergy[color as keyof typeof own.producedEnergy] ?? 0) < n)) continue;
      if (d.kind === 'event') return { type: 'play', cardId: card.id };
      const to = d.kind === 'field' || own.energy.length === 0 ? 'energy' : own.front.length < 4 ? 'front' : 'energy';
      if (own[to].length < 4) return { type: 'play', cardId: card.id, to };
    }
  }
  if (view.phase === 'attack') {
    const attacker = own.front.find(c => c.active);
    if (attacker) return { type: 'attack', cardId: attacker.id };
  }
  return { type: 'advance' };
}
