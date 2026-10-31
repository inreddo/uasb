import type { CardEffect } from './types.ts';

/** A whole ability made solely of guards and one yes/no optional instruction. */
export function optionalEntryChoice(steps: readonly CardEffect[]): Extract<CardEffect, { type: 'chooseOption' }> | undefined {
  if (steps.length !== 1) return undefined;
  const step = steps[0]!;
  if (step.type === 'if' && !step.else?.length) return optionalEntryChoice(step.then ?? []);
  if (step.type === 'chooseOption' && step.count === 1 && (step.min === undefined || step.min === 1)
    && step.options.length === 2 && step.options.filter(option => option.length === 0).length === 1) return step;
  return undefined;
}
