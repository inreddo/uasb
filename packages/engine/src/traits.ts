
import type { CardDefinition } from './types.ts';

/** The trait's name with any parenthesised note removed — the *base* spelling, not used for matching. */
export function traitName(trait: string): string {
  return trait.replace(/[（(][^）)]*[）)]/g, '').trim();
}

/** Whether a card carries the named trait, compared exactly as printed. */
export function hasTrait(definition: CardDefinition | undefined, name: string): boolean {
  if (!definition) return false;
  const wanted = name.trim();
  return (definition.traits ?? []).some(trait => trait.trim() === wanted);
}

/** Whether any of the named traits is carried, exactly as printed. */
export function hasAnyTrait(definition: CardDefinition | undefined, names: readonly string[]): boolean {
  return names.some(name => hasTrait(definition, name));
}
