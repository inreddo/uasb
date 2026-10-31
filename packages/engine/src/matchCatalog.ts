import type { CardDefinition } from './types.ts';

const energyTotal = (card: CardDefinition): number =>
  Object.values(card.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);

const byIdCache = new WeakMap<readonly CardDefinition[], Map<string, CardDefinition>>();
function byId(pool: readonly CardDefinition[]): Map<string, CardDefinition> {
  let map = byIdCache.get(pool);
  if (!map) { map = new Map(pool.map(card => [card.id, card])); byIdCache.set(pool, map); }
  return map;
}

const representativeCache = new WeakMap<readonly CardDefinition[], CardDefinition[]>();

/**
 * One card per distinct required-energy total across the given pool.
 *
 * The `declare` effect (effects.ts, `what: 'energyCount'`) enumerates the totals it offers
 * by walking the match catalog. A per-match subset must therefore keep every total the full
 * pool can offer, or the offered options would silently shrink — verified by the M0
 * full-vs-subset differential probes (tmp/m0-subset-probe.ts, tmp/m0-subset-multi.ts).
 */
export function energyRepresentatives(pool: readonly CardDefinition[]): CardDefinition[] {
  let reps = representativeCache.get(pool);
  if (!reps) {
    const byTotal = new Map<number, CardDefinition>();
    for (const card of pool) if (!byTotal.has(energyTotal(card))) byTotal.set(energyTotal(card), card);
    reps = [...byTotal.values()];
    representativeCache.set(pool, reps);
  }
  return reps;
}

export type MatchCatalog = { catalog: CardDefinition[]; missing: string[]; size: number };

export function buildMatchCatalog(decks: readonly string[][], pool: readonly CardDefinition[]): MatchCatalog {
  const source = byId(pool);
  const picked = new Map<string, CardDefinition>();
  const missing: string[] = [];
  for (const deck of decks) {
    for (const id of deck) {
      const definition = source.get(id);
      if (!definition) { if (!missing.includes(id)) missing.push(id); continue; }
      picked.set(definition.id, definition);
    }
  }
  for (const rep of energyRepresentatives(pool)) picked.set(rep.id, rep);
  return { catalog: [...picked.values()], missing, size: picked.size };
}
