import type { CardDefinition } from '../packages/engine/src/index.ts';

/** Fictional fixtures, deliberately NOT implementations of official cards or a starter deck. */
export const exampleCatalog: CardDefinition[] = Array.from({ length: 13 }, (_, i) => ({
  id: `TEST/${String(i + 1).padStart(3, '0')}`,
  functionalId: `TEST${String(i + 1).padStart(3, '0')}`,
  work: 'TEST', name: `测试角色 ${i + 1}`, implementation: 'core-v1', kind: 'character',
  apCost: 1, requiredEnergy: {}, generatedEnergy: { purple: 1 }, bp: 2000 + (i % 3) * 1000,
}));

export const exampleDeck: string[] = exampleCatalog.flatMap((card, index) => Array<string>(index === 12 ? 2 : 4).fill(card.id));
