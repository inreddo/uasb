import type { CardDefinition, CardEffect } from '../../engine/src/index.ts';
import data from '../data/ua01st.json' with { type: 'json' };

const lelouch = 'ルルーシュ・ランペルージ';
const knights = '黒の騎士団';
const ap = (max: number): CardEffect => ({ type: 'choose', zone: 'ownAp', min: 0, max, operation: 'readyAp' });
const effects: Record<string, Partial<CardDefinition>> = {
  '001': { activeEnergyBonus: { purple: 1 } },
  '002': {},
  '005': { activated: [{ rest: true, oncePerTurn: true, effects: [{ type: 'self', energyBonus: { purple: 1 }, retireMainEnd: true }] }] },
  '008': { onPlay: [{ type: 'choose', zone: 'ownField', filter: { kind: 'character', maxEnergy: 1, other: true }, min: 1, max: 1, operation: 'return', fallbackReturnSelf: true }] },
  '011': { onPlay: [{ type: 'lookTop' }] },
  '015': { onPlay: [{ type: 'choose', zone: 'ownField', filter: { kind: 'character' }, min: 0, max: 1, operation: 'evade', amount: 2000 }] },
  '029': { onPlay: [ap(2)] },
  '030': { onPlay: [{ type: 'choose', zone: 'enemyFront', filter: { kind: 'character', maxBP: 5000 }, min: 1, max: 1, operation: 'retire' }, { type: 'ifName', name: lelouch, effects: [ap(1)] }] },
  '033': { onPlay: [{ type: 'choose', zone: 'ownFront', filter: { kind: 'character' }, min: 1, max: 1, operation: 'checkmate', amount: 2000 }] },
  '101': {},
  '102': { onPlay: [{ type: 'choose', zone: 'ownSideline', filter: { kind: 'character', color: 'purple' }, min: 0, max: 1, operation: 'return' }] },
  '103': { onPlay: [{ type: 'choose', zone: 'enemyFront', filter: { kind: 'character' }, min: 0, max: 1, operation: 'bp', amount: -3000 }] },
  '104': {},
  '105': { onPlay: [{ type: 'search', count: 4, filter: { trait: 'KMF' }, max: 1, discardAfterTake: true }] },
  '106': { raid: { traits: [knights] }, onRaid: [{ type: 'draw', count: 1 }] },
  '107': { raid: { names: ['紅月 カレン'] }, onRaid: [{ type: 'choose', zone: 'enemyFront', filter: { kind: 'character', maxBP: 3000 }, min: 0, max: 1, operation: 'retire' }, { type: 'self', impact: 1 }] },
  '108': { activeOnPlay: true, activated: [{ rest: true, effects: [{ type: 'boostTrait', trait: knights, amount: 500 }] }] },
  '109': { onPlay: [{ type: 'search', count: 3, filter: { trait: knights }, max: 2 }] },
};

/** JP originals and source hashes live beside this file in data/ua01st.json. */
export const ua01stCatalog: CardDefinition[] = data.map(c => {
  const behavior = effects[c.id.slice(-3)];
  if (!behavior) throw new Error(`Missing verified implementation: ${c.id}`);
  return {
    id: c.id, functionalId: c.functionalId, copyLimit: c.copyLimit, work: c.work, name: c.name, implementation: 'core-v1',
    kind: c.kind as CardDefinition['kind'], apCost: c.apCost,
    requiredEnergy: c.requiredEnergy, generatedEnergy: c.generatedEnergy,
    ...(c.bp !== undefined ? { bp: c.bp } : {}),
    traits: c.traits.split(/[／/]/).map(t => t.trim()).filter(t => t && t !== '-'),
    ...(c.triggerType === 'none' ? {} : { trigger: c.triggerType === 'active' ? { type: 'active' as const, bpBonus: 3000 } : { type: c.triggerType as 'get' | 'draw' | 'final' | 'special' | 'raid' } }),
    ...behavior,
  };
});
