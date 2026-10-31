import type { CardDefinition, CardOperation, Color, Duration, ErrorCode, GameState, MatchConfig, TurnEventKind, ZoneId } from './types.ts';
import { inspectDeck } from './deck-rules.ts';
import { handLimitOf } from './conditions.ts';

export class RuleError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}

export function requireRule(value: unknown, code: ErrorCode, message: string): asserts value {
  if (!value) throw new RuleError(code, message);
}

export const COLORS: readonly Color[] = ['red', 'blue', 'green', 'yellow', 'purple'];
/** Every kind of turn event the engine logs; a condition may only ask about one of these. */
export const TURN_EVENT_KINDS: readonly TurnEventKind[] = ['retired', 'moved', 'restedByEffect', 'rested', 'triggered', 'abilityActivated', 'apPaidByEffect', 'lifeToHand', 'extraDraw', 'attacked', 'used', 'discardedFromHand', 'sidelineToHand', 'milled', 'revealedFromDeck', 'entered', 'dealtPlayerDamage', 'returnedToHand', 'sidelineToDeck', 'revealedToHand', 'drew', 'revealedFromHand', 'activatedByEffect'];

const integer = (n: unknown, min = 0): n is number => Number.isSafeInteger(n) && (n as number) >= min;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(text);
const onlyKeys = (v: object, keys: readonly string[]): boolean => Object.keys(v).every(k => keys.includes(k));
const validEnergy = (v: unknown) => record(v) && onlyKeys(v, COLORS) && Object.values(v).every(n => integer(n));
function validFilter(v: unknown): boolean {
  return record(v) && onlyKeys(v, ['kind', 'color', 'trait', 'notTrait', 'notColor', 'name', 'names', 'nameContains', 'notNameContains', 'notNames', 'maxEnergy', 'minEnergy', 'energyBasis', 'maxGeneratedEnergy', 'minGeneratedEnergy', 'maxBP', 'minBP', 'maxApCost', 'minApCost', 'other', 'active', 'rested', 'skipsNextReady', 'self', 'hasEffect', 'hasActivated', 'hasTrigger', 'triggerType', 'notTriggerType', 'attackedThisTurn', 'raidAbility', 'attackAbility', 'blockAbility', 'hasKeyword', 'noTraits', 'energyEqualsDeclared', 'traitEqualsDeclared', 'nameContainsDeclared', 'raid', 'underCount', 'printedBP', 'printedApCost', 'energySatisfied', 'bound', 'bpCeiling', 'zone', 'side', 'raidBaseFor', 'anyOf', 'differentLine', 'sameLine', 'restedByEffectThisTurn', 'enteredThisTurn', 'bpBelowSource', 'bpBelowSourceRate', 'sameBpAsSource', 'sameBpAsBind', 'raidUnderName', 'raidUnderNames', 'notRaidedNameThisTurn', 'cardNumberDiffersFromRemoved', 'energyDiffersFromRemoved', 'asRemoved', 'chosenByEffectThisTurn', 'nameNotInOwnField', 'revealedBpCeiling', 'revealedEnergyBpCeiling', 'sameNameAsRevealed', 'bpBelowPrinted', 'bpAbovePrinted', 'restable', 'traitOtherThan', 'enteredFrom', 'removedBpCeiling', 'retiredBpCeiling'])

    && (v.raidUnderName === undefined || text(v.raidUnderName))
    && (v.raidUnderNames === undefined || strings(v.raidUnderNames))
    && (v.notRaidedNameThisTurn === undefined || typeof v.notRaidedNameThisTurn === 'boolean')
    && (v.nameNotInOwnField === undefined || typeof v.nameNotInOwnField === 'boolean')
    && (v.cardNumberDiffersFromRemoved === undefined || typeof v.cardNumberDiffersFromRemoved === 'boolean')
    && (v.energyDiffersFromRemoved === undefined || typeof v.energyDiffersFromRemoved === 'boolean')
    && (v.asRemoved === undefined || (record(v.asRemoved) && onlyKeys(v.asRemoved, ['energy', 'originalBp'])
      && Object.keys(v.asRemoved).length > 0
      && (v.asRemoved.energy === undefined || typeof v.asRemoved.energy === 'boolean')
      && (v.asRemoved.originalBp === undefined || typeof v.asRemoved.originalBp === 'boolean')))
    && (v.revealedBpCeiling === undefined || typeof v.revealedBpCeiling === 'boolean')
    && (v.revealedEnergyBpCeiling === undefined || typeof v.revealedEnergyBpCeiling === 'boolean')
    && (v.sameNameAsRevealed === undefined || typeof v.sameNameAsRevealed === 'boolean')
    && (v.bpBelowPrinted === undefined || typeof v.bpBelowPrinted === 'boolean')
    && (v.bpAbovePrinted === undefined || typeof v.bpAbovePrinted === 'boolean')
    && (v.restable === undefined || typeof v.restable === 'boolean')
    && (v.chosenByEffectThisTurn === undefined || (record(v.chosenByEffectThisTurn)
      && onlyKeys(v.chosenByEffectThisTurn, ['trait', 'name', 'names', 'own'])
      && (v.chosenByEffectThisTurn.trait === undefined || text(v.chosenByEffectThisTurn.trait))
      && (v.chosenByEffectThisTurn.name === undefined || text(v.chosenByEffectThisTurn.name))
      && (v.chosenByEffectThisTurn.names === undefined || strings(v.chosenByEffectThisTurn.names))
      && (v.chosenByEffectThisTurn.own === undefined || typeof v.chosenByEffectThisTurn.own === 'boolean')))

    && (v.zone === undefined || v.zone === 'front' || v.zone === 'energy')
    && (v.side === undefined || v.side === 'self' || v.side === 'opponent')
    && (v.bpCeiling === undefined || (record(v.bpCeiling) && onlyKeys(v.bpCeiling, ['count', 'per', 'base']) && validTierCount(v.bpCeiling.count) && integer(v.bpCeiling.per, 1) && (v.bpCeiling.base === undefined || integer(v.bpCeiling.base, 0))))
    && (v.anyOf === undefined || (Array.isArray(v.anyOf) && v.anyOf.length > 0 && v.anyOf.every(sub => validFilter(sub))))
    && (v.bound === undefined || (record(v.bound) && onlyKeys(v.bound, ['stat', 'extreme', 'who', 'zone', 'other', 'exclusive'])
      && ['bp', 'requiredEnergy', 'apCost'].includes(String(v.bound.stat))
      && (v.bound.extreme === 'max' || v.bound.extreme === 'min')
      && (v.bound.who === 'self' || v.bound.who === 'opponent')
      && (v.bound.zone === 'field' || v.bound.zone === 'sideline')
      && (v.bound.other === undefined || typeof v.bound.other === 'boolean')
      && (v.bound.exclusive === undefined || typeof v.bound.exclusive === 'boolean')))
    && (v.notNames === undefined || strings(v.notNames))
    && (v.energyEqualsDeclared === undefined || typeof v.energyEqualsDeclared === 'boolean')
    && (v.raid === undefined || typeof v.raid === 'boolean')
    && (v.restedByEffectThisTurn === undefined || typeof v.restedByEffectThisTurn === 'boolean')
    && (v.enteredThisTurn === undefined || typeof v.enteredThisTurn === 'boolean')
    && (v.bpBelowSource === undefined || integer(v.bpBelowSource, 0))
    && (v.bpBelowSourceRate === undefined || (typeof v.bpBelowSourceRate === 'number' && v.bpBelowSourceRate > 0 && v.bpBelowSourceRate <= 1))
    && (v.sameBpAsSource === undefined || typeof v.sameBpAsSource === 'boolean')
    && (v.sameBpAsBind === undefined || (text(v.sameBpAsBind) && (v.sameBpAsBind as string).length <= 12))
    && (v.sameCountAsBind === undefined || (text(v.sameCountAsBind) && (v.sameCountAsBind as string).length <= 12))
    && (v.underCount === undefined || (record(v.underCount) && onlyKeys(v.underCount, ['min', 'max']) && (v.underCount.min === undefined || integer(v.underCount.min)) && (v.underCount.max === undefined || integer(v.underCount.max))))
    && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
    && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
    && (v.color === undefined || COLORS.includes(v.color as Color)) && (v.trait === undefined || text(v.trait))
    && (v.notTrait === undefined || text(v.notTrait))
    && (v.traitOtherThan === undefined || text(v.traitOtherThan))
    && (v.notColor === undefined || COLORS.includes(v.notColor as Color))
    && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names)) && (v.nameContains === undefined || text(v.nameContains))
    && (v.maxEnergy === undefined || integer(v.maxEnergy)) && (v.minEnergy === undefined || integer(v.minEnergy))
    && (v.energyBasis === undefined || v.energyBasis === 'printed')
    && (v.maxGeneratedEnergy === undefined || integer(v.maxGeneratedEnergy)) && (v.minGeneratedEnergy === undefined || integer(v.minGeneratedEnergy))
    && (v.maxBP === undefined || integer(v.maxBP)) && (v.minBP === undefined || integer(v.minBP))
    && (v.maxApCost === undefined || integer(v.maxApCost)) && (v.minApCost === undefined || integer(v.minApCost))
    && (v.other === undefined || typeof v.other === 'boolean') && (v.self === undefined || typeof v.self === 'boolean')
    && (v.active === undefined || typeof v.active === 'boolean') && (v.rested === undefined || typeof v.rested === 'boolean')
    && (v.hasEffect === undefined || typeof v.hasEffect === 'boolean')
    && (v.hasTrigger === undefined || typeof v.hasTrigger === 'boolean')
    && (v.triggerType === undefined || v.triggerType === 'color' || v.triggerType === 'draw' || v.triggerType === 'raid' || v.triggerType === 'special')
    && (v.notTriggerType === undefined || (Array.isArray(v.notTriggerType) && v.notTriggerType.length > 0
      && v.notTriggerType.every(t => ['get', 'draw', 'final', 'raid', 'active', 'special', 'color'].includes(String(t)))))
    && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean')
    && (v.attackAbility === undefined || typeof v.attackAbility === 'boolean')
    && (v.blockAbility === undefined || typeof v.blockAbility === 'boolean')
    && (v.traitEqualsDeclared === undefined || typeof v.traitEqualsDeclared === 'boolean')
    && (v.noTraits === undefined || typeof v.noTraits === 'boolean')
    && (v.energySatisfied === undefined || typeof v.energySatisfied === 'boolean')
    && (v.differentLine === undefined || typeof v.differentLine === 'boolean')
    && (v.sameLine === undefined || typeof v.sameLine === 'boolean')
    && (v.raidBaseFor === undefined || text(v.raidBaseFor));
}
export const ZONES: readonly ZoneId[] = [
  'ownFront', 'ownEnergy', 'ownField', 'ownHand', 'ownSideline', 'ownRemoval', 'ownDeck', 'ownLife', 'ownAp', 'ownUnder', 'ownUnderAll', 'ownRaidUnder', 'ownRaidBottom', 'eventRaidUnder', 'blocker',
  'enemyFront', 'enemyEnergy', 'enemyField', 'enemyHand', 'enemySideline', 'enemyRemoval', 'enemyDeck', 'enemyLife', 'enemyAp',
];
export const CARD_OPERATIONS: readonly CardOperation[] = [
  'return', 'retire', 'remove', 'removalToSideline', 'rest', 'activate', 'bp', 'impact', 'damage',
  'evade', 'checkmate', 'readyAp', 'move', 'deploy', 'deployRested', 'raid', 'toDeckTop', 'toDeckBottom', 'toLife', 'loseEffects', 'loseSelfTurnEffects', 'reveal', 'toUnder', 'energy', 'grantKeywords', 'topToSideline', 'cannotActivate', 'bottomToField', 'underToSideline', 'placeSourceUnder', 'blockOnly',
  'raidTopToHand', 'toDeckTopOrBottom', 'retireEndPhase', 'topToDeckBottom', 'topToDeckTop', 'energyCostUp', 'mustBlockAttacker',
];
const KEYWORD_KEYS = ['step', 'damage', 'impact', 'impactNegate', 'doubleAttack', 'doubleBlock', 'snipe'] as const;
function validKeywords(v: unknown): boolean {
  return record(v) && onlyKeys(v, KEYWORD_KEYS)
    && Object.entries(v).every(([key, value]) => key === 'damage' || key === 'impact' ? integer(value, 1) : typeof value === 'boolean');
}
function validCondition(v: unknown, depth = 0): boolean {
  if (!record(v) || depth > 6) return false;
  switch (v.type) {
    case 'lineHasSpace': return onlyKeys(v, ['type','who','line']) && (v.who === 'self' || v.who === 'opponent') && (v.line === 'front' || v.line === 'energy');
    case 'turnOf': return onlyKeys(v, ['type', 'who']) && (v.who === 'self' || v.who === 'opponent');
    case 'line': return onlyKeys(v, ['type', 'line']) && (v.line === 'front' || v.line === 'energy');
    case 'atZone': return onlyKeys(v, ['type', 'zone']) && ['sideline', 'front', 'energy'].includes(String(v.zone));
    case 'isActive': case 'isRested': case 'selfActive': case 'selfRested': case 'raidState': return onlyKeys(v, ['type']);
    case 'hasName': return onlyKeys(v, ['type', 'who', 'name']) && (v.who === 'self' || v.who === 'opponent') && text(v.name);
    case 'hasNameContains': return onlyKeys(v, ['type', 'who', 'fragment']) && (v.who === 'self' || v.who === 'opponent') && text(v.fragment);
    case 'hasTrait': return onlyKeys(v, ['type', 'who', 'trait']) && (v.who === 'self' || v.who === 'opponent') && text(v.trait);
    case 'fieldCount':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'kind', 'line', 'trait', 'notTrait', 'color', 'notColor', 'name', 'nameContains', 'notNameContains', 'names', 'traits', 'notNames', 'other', 'self', 'minBP', 'maxBP', 'printedBP', 'raid', 'minEnergy', 'maxEnergy', 'minApCost', 'maxApCost', 'printedApCost', 'hasKeyword', 'hasKeywords', 'hasTrigger', 'raidAbility', 'attackAbility', 'blockAbility', 'hasActivated', 'sameLine', 'differentLine', 'bpBelowPrinted', 'bpAbovePrinted', 'restable', 'rested', 'active', 'underCount', 'anyOf', 'traitPresent', 'traitOtherThan', 'namedAmong', 'noSameCardNumber'])
        && (v.namedAmong === undefined || strings(v.namedAmong))
      && (v.names === undefined || strings(v.names)) && (v.traits === undefined || strings(v.traits))
      && (v.notNames === undefined || strings(v.notNames))
      && (v.anyOf === undefined || (Array.isArray(v.anyOf) && v.anyOf.length > 0 && v.anyOf.every(sub => validFilter(sub))))
      && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
      && (v.raid === undefined || typeof v.raid === 'boolean')
      && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
      && (v.minEnergy === undefined || integer(v.minEnergy)) && (v.maxEnergy === undefined || integer(v.maxEnergy))
      && (v.minApCost === undefined || integer(v.minApCost)) && (v.maxApCost === undefined || integer(v.maxApCost))
      && (v.traitOtherThan === undefined || text(v.traitOtherThan))
      && (v.hasKeyword === undefined || text(v.hasKeyword))
      && (v.hasKeywords === undefined || strings(v.hasKeywords))
      && (v.hasTrigger === undefined || typeof v.hasTrigger === 'boolean')
      && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean')
      && (v.attackAbility === undefined || typeof v.attackAbility === 'boolean')
      && (v.blockAbility === undefined || typeof v.blockAbility === 'boolean')
      && (v.hasActivated === undefined || typeof v.hasActivated === 'boolean')
      && (v.self === undefined || typeof v.self === 'boolean')
      && (v.sameLine === undefined || typeof v.sameLine === 'boolean')
      && (v.differentLine === undefined || typeof v.differentLine === 'boolean')
      && (v.bpBelowPrinted === undefined || typeof v.bpBelowPrinted === 'boolean')
      && (v.bpAbovePrinted === undefined || typeof v.bpAbovePrinted === 'boolean')
      && (v.restable === undefined || typeof v.restable === 'boolean')
      && (v.rested === undefined || typeof v.rested === 'boolean')
      && (v.active === undefined || typeof v.active === 'boolean')
      && (v.underCount === undefined || (record(v.underCount) && onlyKeys(v.underCount, ['min', 'max']) && (v.underCount.min === undefined || integer(v.underCount.min)) && (v.underCount.max === undefined || integer(v.underCount.max))))
        && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.line === undefined || v.line === 'front' || v.line === 'energy')
        && (v.trait === undefined || text(v.trait)) && (v.notTrait === undefined || text(v.notTrait)) && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.notColor === undefined || COLORS.includes(v.notColor as Color))
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.other === undefined || typeof v.other === 'boolean');
    case 'fieldCountCompare': {
      const side = (s: unknown): boolean => record(s) && onlyKeys(s, ['line', 'rested', 'active'])
        && (s.line === undefined || s.line === 'front' || s.line === 'energy')
        && (s.rested === undefined || typeof s.rested === 'boolean')
        && (s.active === undefined || typeof s.active === 'boolean');
      return onlyKeys(v, ['type', 'kind', 'left', 'right', 'op'])
        && (v.kind === undefined || v.kind === 'character' || v.kind === 'field')
        && ['atLeast', 'more', 'atMost', 'less'].includes(String(v.op))
        && side(v.left) && side(v.right);
    }
    case 'handCount': case 'lifeCount': case 'energyCount': case 'deckCount':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'other', 'filter']) && (v.who === 'self' || v.who === 'opponent')
        && (v.other === undefined || typeof v.other === 'boolean')
        && (v.filter === undefined || (record(v.filter) && validFilter(v.filter)))
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'lifeSum':
      return onlyKeys(v, ['type', 'min', 'max'])
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'revealedPlusField': return onlyKeys(v, ['type', 'trait', 'min']) && text(v.trait) && integer(v.min, 1);
    case 'sidelineEnergyVariety':
      return onlyKeys(v, ['type', 'who', 'min', 'max']) && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'revealedTraitNames':
      return onlyKeys(v, ['type', 'who', 'trait', 'min', 'max']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent')
        && text(v.trait) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'sidelineCount':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'kind', 'color', 'trait', 'notTrait', 'noTraits', 'name', 'nameContains', 'names', 'notNames', 'traits', 'minBP', 'maxBP', 'alsoRemoval', 'triggerType', 'raidAbility', 'other', 'apCost', 'hasTrait']) && (v.who === 'self' || v.who === 'opponent')
      && (v.apCost === undefined || integer(v.apCost))
      && (v.hasTrait === undefined || typeof v.hasTrait === 'boolean')
      && (v.triggerType === undefined || v.triggerType === 'draw' || v.triggerType === 'special')
      && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
      && (v.names === undefined || strings(v.names)) && (v.notNames === undefined || strings(v.notNames)) && (v.traits === undefined || strings(v.traits))
      && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
      && (v.other === undefined || typeof v.other === 'boolean')
      && (v.alsoRemoval === undefined || typeof v.alsoRemoval === 'boolean')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.color === undefined || COLORS.includes(v.color as Color)) && (v.trait === undefined || text(v.trait))
        && (v.notTrait === undefined || text(v.notTrait)) && (v.noTraits === undefined || typeof v.noTraits === 'boolean')
        && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean');
    case 'fieldEnergySum':
      return onlyKeys(v, ['type', 'who', 'min', 'max']) && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'countSum':
      return onlyKeys(v, ['type', 'counts', 'min', 'max']) && Array.isArray(v.counts) && (v.counts as unknown[]).every(validTierCount)
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'removalCount':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'kind', 'name', 'names']) && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)));
    case 'distinctNames':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'kind', 'kinds', 'color', 'trait', 'notTrait', 'zone', 'names', 'notNames', 'nameContains', 'other', 'by'])
        && (v.by === undefined || v.by === 'name' || v.by === 'energy')
        && (v.other === undefined || typeof v.other === 'boolean') && (v.who === 'self' || v.who === 'opponent')
        && (v.names === undefined || strings(v.names)) && (v.notNames === undefined || strings(v.notNames)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.color === undefined || COLORS.includes(v.color as Color)) && (v.trait === undefined || text(v.trait))
        && (v.notTrait === undefined || text(v.notTrait))
        && (v.kinds === undefined || (Array.isArray(v.kinds) && v.kinds.length > 0 && v.kinds.every(k => ['character', 'field', 'event'].includes(String(k)))))
        && (v.zone === undefined || ['front', 'energy', 'field', 'sideline', 'fieldOrSideline', 'removal'].includes(String(v.zone)));
    case 'distinctTraits':
      return onlyKeys(v, ['type', 'who', 'traitContains', 'color', 'min', 'max', 'other', 'kind'])
        && (v.who === 'self' || v.who === 'opponent')
        && (v.traitContains === undefined || text(v.traitContains))
        && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.other === undefined || typeof v.other === 'boolean');
    case 'producedEnergy':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'color']) && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.color === undefined || COLORS.includes(v.color as Color));
    case 'raidUnderEnergy':
      return onlyKeys(v, ['type', 'min', 'max']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'raidUnderTrait': return onlyKeys(v, ['type', 'trait']) && text(v.trait);
    case 'raidUnderBp': return onlyKeys(v, ['type', 'min', 'max']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'raidUnderName':
      return onlyKeys(v, ['type', 'name', 'names', 'nameContains', 'who'])
        && (v.who === undefined || v.who === 'self' || v.who === 'opponent')
        && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.name !== undefined || v.names !== undefined || v.nameContains !== undefined);
    case 'selfBp': case 'underCount':
      return onlyKeys(v, ['type', 'min', 'max', 'all', 'who', 'withStatics', 'printedBP', 'names']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
      && (v.all === undefined || typeof v.all === 'boolean') && (v.who === undefined || v.who === 'self' || v.who === 'opponent')
      && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
      && (v.names === undefined || (Array.isArray(v.names) && (v.names as unknown[]).length > 0 && (v.names as unknown[]).every(n => typeof n === 'string')))
      && (v.withStatics === undefined || typeof v.withStatics === 'boolean');
    // Only the two bounds: sharing the case above let `all` / `who` / `withStatics` through, none of
    // which this predicate has a field for.
    case 'selfApCost':
      return onlyKeys(v, ['type', 'min', 'max']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'selfRequirement':
      return onlyKeys(v, ['type', 'min', 'max']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'usedEventThisTurn':
      return onlyKeys(v, ['type', 'other']) && (v.other === undefined || typeof v.other === 'boolean');
    case 'eventsUsedThisTurn':
      return onlyKeys(v, ['type', 'who', 'min', 'max']) && (v.who === 'self' || v.who === 'opponent')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'isRaidState': case 'inBattle': return onlyKeys(v, ['type']);
    case 'battleDefender':
      return onlyKeys(v, ['type', 'minBP', 'maxBP', 'name', 'nameContains'])
        && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains));
    case 'selfHasKeyword': return onlyKeys(v, ['type', 'keyword']) && ['step', 'damage', 'impact', 'impactNegate', 'doubleAttack', 'doubleBlock', 'snipe'].includes(String(v.keyword));
    case 'energyCountCompare':
      return onlyKeys(v, ['type', 'op']) && ['eq', 'gt', 'lt'].includes(String(v.op));
    case 'handCountCompare':
      return onlyKeys(v, ['type', 'op']) && ['lt', 'gt', 'le', 'ge', 'eq'].includes(String(v.op));
    case 'thisEffectRevealedHand':
      return onlyKeys(v, ['type', 'min']) && (v.min === undefined || integer(v.min, 1));
    case 'thisEffectRetired':
      return onlyKeys(v, ['type', 'who', 'min', 'max', 'maxEnergy', 'minEnergy']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent' || v.who === 'both')
        && (v.min === undefined || integer(v.min, 0)) && (v.max === undefined || integer(v.max, 0))
        && (v.maxEnergy === undefined || integer(v.maxEnergy)) && (v.minEnergy === undefined || integer(v.minEnergy));
    case 'thisEffectDiscardedKind':
      return onlyKeys(v, ['type', 'kind']) && ['character', 'field', 'event'].includes(String(v.kind));
    case 'thisEffectDiscardedName':
      return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'thisEffectDeckBottomName':
      return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'thisEffectRested':
      return onlyKeys(v, ['type', 'min']) && (v.min === undefined || integer(v.min, 1));
    case 'thisEffectBpZero':
      return onlyKeys(v, ['type', 'who']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent');
    case 'thisEffectRemoved':
      return onlyKeys(v, ['type', 'minBP', 'maxBP', 'who'])
        && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
        && (v.who === undefined || v.who === 'self' || v.who === 'opponent');
    case 'thisEffectDiscardedEnergySum':
      return onlyKeys(v, ['type', 'min', 'max']) && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'thisEffectUnderFromHand':
      return onlyKeys(v, ['type', 'min']) && (v.min === undefined || integer(v.min, 1));
    case 'thisEffectUnderFromHandToSource':
      return onlyKeys(v, ['type', 'min']) && (v.min === undefined || integer(v.min, 1));
    case 'drewFaceDown': return onlyKeys(v, ['type']);
    case 'faceUpCount':
      return onlyKeys(v, ['type', 'who', 'zones', 'min', 'max'])
        && (v.who === undefined || v.who === 'self' || v.who === 'opponent' || v.who === 'both')
        && (v.zones === undefined || (Array.isArray(v.zones) && (v.zones as unknown[]).every(z => z === 'deck' || z === 'life')))
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'phase': return onlyKeys(v, ['type', 'phase']) && (v.phase === 'main' || v.phase === 'attack');
    case 'retireCause': return onlyKeys(v, ['type', 'cause', 'own', 'name', 'names'])
      && (v.cause === 'battle' || v.cause === 'effect' || v.cause === 'bpZero')
      && (v.own === undefined || typeof v.own === 'boolean')
      && (v.name === undefined || text(v.name))
      && (v.names === undefined || strings(v.names));
    case 'chosenByEffectThisTurn': return onlyKeys(v, ['type', 'who', 'self', 'trait', 'name', 'names'])
      && (v.who === 'self' || v.who === 'opponent')
      && (v.self === undefined || typeof v.self === 'boolean')
      && (v.trait === undefined || text(v.trait))
      && (v.name === undefined || text(v.name))
      && (v.names === undefined || strings(v.names));

    case 'clashCompare': return onlyKeys(v, ['type', 'compare']) && (v.compare === 'atLeast' || v.compare === 'less');
    case 'turnEvent':
      return onlyKeys(v, ['type', 'event', 'who', 'self', 'min', 'max', 'kind', 'color', 'notColor', 'trait', 'excludeSelf', 'name', 'nameContains', 'nameContainsAny', 'causeNameContains', 'causeKind', 'causeAnyOf', 'causeSelf', 'raidAbility', 'apCost', 'activatedApCost', 'phase', 'notPhase', 'free', 'via', 'from', 'printedBP', 'printedEnergy', 'raid', 'usedFrom', 'line', 'toLine', 'ownEffect', 'byEffect', 'cause', 'cardCount', 'triggerType', 'distinctNames'])
        && (v.cardCount === undefined || (record(v.cardCount) && onlyKeys(v.cardCount, ['min', 'max'])))
        && (v.distinctNames === undefined || (record(v.distinctNames) && onlyKeys(v.distinctNames, ['min', 'max'])))
        && (v.triggerType === undefined || v.triggerType === 'get' || v.triggerType === 'draw' || v.triggerType === 'special')

        && (v.from === undefined || v.from === 'hand' || v.from === 'sideline' || v.from === 'deck' || v.from === 'life' || v.from === 'removal' || v.from === 'under')
        && (v.notColor === undefined || COLORS.includes(v.notColor as Color))
        && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean')
        && (v.nameContainsAny === undefined || strings(v.nameContainsAny))
        && (v.causeNameContains === undefined || text(v.causeNameContains))
        && (v.causeKind === undefined || ['character', 'field', 'event'].includes(String(v.causeKind)))
        && (v.causeAnyOf === undefined || (Array.isArray(v.causeAnyOf) && (v.causeAnyOf as unknown[]).length > 0
          && (v.causeAnyOf as unknown[]).every(alt => record(alt) && onlyKeys(alt, ['kind', 'name', 'nameContains'])
            && (alt.kind === undefined || ['character', 'field', 'event'].includes(String(alt.kind)))
            && (alt.name === undefined || text(alt.name))
            && (alt.nameContains === undefined || text(alt.nameContains)))))
        && (v.causeSelf === undefined || typeof v.causeSelf === 'boolean')
        && (v.cause === undefined || v.cause === 'bpZero' || v.cause === 'battle' || v.cause === 'effect')
        && (v.raid === undefined || typeof v.raid === 'boolean')
        && (v.ownEffect === undefined || typeof v.ownEffect === 'boolean')
        && (v.byEffect === undefined || typeof v.byEffect === 'boolean')
        && (v.usedFrom === undefined || v.usedFrom === 'hand' || v.usedFrom === 'removal' || v.usedFrom === 'deck')
        && (v.line === undefined || v.line === 'front' || v.line === 'energy')
        && (v.toLine === undefined || v.toLine === 'front' || v.toLine === 'energy')
        && (v.apCost === undefined || integer(v.apCost, 0)
          || (record(v.apCost) && onlyKeys(v.apCost, ['min', 'max']) && (v.apCost.min === undefined || integer(v.apCost.min, 0)) && (v.apCost.max === undefined || integer(v.apCost.max, 0))))
        && (v.phase === undefined || ['start', 'movement', 'main', 'attack', 'end'].includes(String(v.phase)))
        && (v.notPhase === undefined || ['start', 'movement', 'main', 'attack', 'end'].includes(String(v.notPhase)))
        && (v.free === undefined || typeof v.free === 'boolean')
        && (v.via === undefined || v.via === 'play' || v.via === 'effect')
        && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
        && (v.printedEnergy === undefined || (record(v.printedEnergy) && onlyKeys(v.printedEnergy, ['min', 'max']) && (v.printedEnergy.min === undefined || integer(v.printedEnergy.min)) && (v.printedEnergy.max === undefined || integer(v.printedEnergy.max))))
        && (v.excludeSelf === undefined || typeof v.excludeSelf === 'boolean')
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
        && TURN_EVENT_KINDS.includes(v.event as TurnEventKind)
        && (v.who === undefined || v.who === 'self' || v.who === 'opponent' || v.who === 'both')
        && (v.self === undefined || typeof v.self === 'boolean')
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.trait === undefined || text(v.trait));
    case 'enteredVia':
      return onlyKeys(v, ['type', 'who', 'from', 'by', 'byKind', 'thisTurn', 'name', 'nameContains', 'kind', 'raid', 'causeName', 'ownEffect'])
        && (v.ownEffect === undefined || typeof v.ownEffect === 'boolean')
        && (v.byKind === undefined || (Array.isArray(v.byKind) && (v.byKind as unknown[]).length > 0 && (v.byKind as unknown[]).every(k => ['character', 'field', 'event'].includes(String(k)))))
        && (v.who === undefined || v.who === 'self' || v.who === 'opponent')
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.causeName === undefined || text(v.causeName))
        && (v.from === undefined || v.from === 'hand' || v.from === 'sideline' || v.from === 'removal' || v.from === 'deck')
        && (v.by === undefined || v.by === 'play' || v.by === 'effect')
        && (v.thisTurn === undefined || typeof v.thisTurn === 'boolean')
        && (v.kind === undefined || v.kind === 'character' || v.kind === 'field')
        && (v.raid === undefined || typeof v.raid === 'boolean')
        // A predicate that names neither an origin, a placement, a *subject* nor a period would be true
        // for every card that has a record at all, which is never what the printed wording means. A named
        // subject (「〈影山 飛雄〉が登場している」) narrows the predicate just as an origin does — and so
        // does 「レイドさせている」, which names the placement itself, and `thisTurn`, which asks about
        // the record's own turn (「このキャラが登場していないターンで」).
        && (v.from !== undefined || v.by !== undefined || v.name !== undefined || v.nameContains !== undefined || v.raid !== undefined || v.thisTurn !== undefined);
    case 'selectedHas':
      return onlyKeys(v, ['type', 'bind', 'kind', 'trait', 'color', 'name', 'names', 'nameContains', 'enteredFrom', 'zone', 'rested', 'active', 'notSelf', 'self', 'movedNotByMovePhaseThisTurn', 'restedByEffectThisTurn', 'raid', 'raidAbility', 'keyword', 'keywordAmount', 'hasKeyword', 'minBP', 'maxBP', 'minEnergy', 'maxEnergy', 'minApCost', 'maxApCost', 'printedApCost', 'energyEqualsDeclared', 'underCount', 'raidUnderName', 'raidUnderNames', 'nameNotInOwnField', 'energySatisfied', 'grantedByTrait', 'grantedModifiers'])
        && (v.notSelf === undefined || typeof v.notSelf === 'boolean')
        && (v.self === undefined || typeof v.self === 'boolean')
        && (v.enteredFrom === undefined || ['hand', 'sideline', 'deck', 'removal'].includes(String(v.enteredFrom)))
        && (v.minEnergy === undefined || integer(v.minEnergy)) && (v.maxEnergy === undefined || integer(v.maxEnergy))
        && (v.minApCost === undefined || integer(v.minApCost)) && (v.maxApCost === undefined || integer(v.maxApCost))
        && (v.bind === undefined || text(v.bind))
        && (v.raidUnderName === undefined || text(v.raidUnderName))
        && (v.raidUnderNames === undefined || strings(v.raidUnderNames))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.trait === undefined || text(v.trait)) && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.zone === undefined || v.zone === 'front' || v.zone === 'energy')
        && (v.rested === undefined || typeof v.rested === 'boolean') && (v.raid === undefined || typeof v.raid === 'boolean')
        && (v.active === undefined || typeof v.active === 'boolean')
        && (v.movedNotByMovePhaseThisTurn === undefined || typeof v.movedNotByMovePhaseThisTurn === 'boolean')
        && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean')
        && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
        && (v.underCount === undefined || (record(v.underCount) && onlyKeys(v.underCount, ['min', 'max']) && (v.underCount.min === undefined || integer(v.underCount.min)) && (v.underCount.max === undefined || integer(v.underCount.max))))
        && (v.keyword === undefined || KEYWORD_KEYS.includes(v.keyword as never)) && (v.keywordAmount === undefined || integer(v.keywordAmount, 1))
        && (v.hasKeyword === undefined || typeof v.hasKeyword === 'boolean');
    case 'revealedHas':
      return onlyKeys(v, ['type', 'kind', 'name', 'names', 'notNames', 'nameContains', 'trait', 'notTrait', 'color', 'minEnergy', 'maxEnergy', 'maxApCost', 'raidAbility', 'energyEqualsDeclared', 'energySatisfied', 'minBP', 'maxBP', 'self'])
        && (v.maxApCost === undefined || integer(v.maxApCost))
        && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
        && (v.self === undefined || typeof v.self === 'boolean')
        && (v.minEnergy === undefined || integer(v.minEnergy)) && (v.maxEnergy === undefined || integer(v.maxEnergy))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names))
        && (v.notNames === undefined || strings(v.notNames))
        && (v.nameContains === undefined || text(v.nameContains)) && (v.trait === undefined || text(v.trait))
        && (v.raidAbility === undefined || typeof v.raidAbility === 'boolean')
        && (v.color === undefined || COLORS.includes(v.color as Color));
    case 'battleAttacker':
      return onlyKeys(v, ['type', 'raid', 'trait', 'color', 'name', 'names', 'nameContains', 'kind', 'keyword', 'keywords', 'minBP', 'maxBP', 'printedBP'])
        && (v.keywords === undefined || (Array.isArray(v.keywords) && (v.keywords as unknown[]).length > 0 && (v.keywords as unknown[]).every(entry => typeof entry === 'string')))
        && (v.raid === undefined || typeof v.raid === 'boolean')
        && (v.minBP === undefined || integer(v.minBP)) && (v.maxBP === undefined || integer(v.maxBP))
        && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
        && (v.keyword === undefined || typeof v.keyword === 'string')
        && (v.trait === undefined || text(v.trait)) && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names))
        && (v.nameContains === undefined || text(v.nameContains))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)));
    case 'fieldAll':
      return onlyKeys(v, ['type', 'who', 'line', 'filter']) && (v.who === 'self' || v.who === 'opponent')
        && (v.line === undefined || v.line === 'front' || v.line === 'energy')
        && record(v.filter);
    case 'selectionCount':
      return onlyKeys(v, ['type', 'binds', 'min', 'max']) && strings(v.binds) && (v.binds as unknown[]).length > 0
        && (v.min === undefined || integer(v.min)) && (v.max === undefined || integer(v.max));
    case 'selectionEnergySum':
      return onlyKeys(v, ['type', 'binds', 'min', 'max']) && strings(v.binds) && (v.binds as unknown[]).length > 0
        && (v.min === undefined || integer(v.min, 0)) && (v.max === undefined || integer(v.max, 0));
    case 'selfEnergySatisfied':
      return onlyKeys(v, ['type', 'who']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent');
    case 'selfApAvailable':
      return onlyKeys(v, ['type', 'count']) && (v.count === undefined || integer(v.count, 0));
    case 'statementMatchesHand':
      return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'not': return onlyKeys(v, ['type', 'condition']) && validCondition(v.condition, depth + 1);
    case 'boundSameName': return onlyKeys(v, ['type', 'a', 'b']) && text(v.a) && text(v.b);
    case 'all': case 'any': return onlyKeys(v, ['type', 'conditions']) && Array.isArray(v.conditions) && v.conditions.length > 0 && v.conditions.length <= 12 && v.conditions.every(c => validCondition(c, depth + 1));
    default: return false;
  }
}
function validTierCount(v: unknown): boolean {
  if (!record(v) || typeof v.source !== 'string') return false;
  switch (v.source) {
    case 'triggerKinds': return onlyKeys(v, ['source','who','color','maxEnergy','other']) && (v.who === 'self' || v.who === 'opponent') && COLORS.includes(v.color as Color) && integer(v.maxEnergy) && (v.other === undefined || typeof v.other === 'boolean');
    // `underCount` carries `all` (「自分の場のキャラの下の裏向きのカード」 counts every stack, not the
    // source's own) — the reader has always read it; the whitelist was missing it, so a tier using that
    // source would have been rejected outright as UNSUPPORTED_CARD.
    case 'underCount': return onlyKeys(v, ['source', 'all', 'line']) && (v.all === undefined || typeof v.all === 'boolean')
      && (v.line === undefined || v.line === 'front' || v.line === 'energy');
    case 'eventsUsedThisTurn':
      return onlyKeys(v, ['source', 'other', 'trait', 'kind']) && (v.other === undefined || typeof v.other === 'boolean')
        && (v.trait === undefined || text(v.trait))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)));
    case 'turnEventRetired':
      return onlyKeys(v, ['source', 'who']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent');
    case 'selfMovedThisTurn': return onlyKeys(v, ['source']);
    case 'selfAttackedThisTurn': return onlyKeys(v, ['source']);
    case 'handDiscardedThisTurn': return onlyKeys(v, ['source', 'ownEffect']) && (v.ownEffect === undefined || typeof v.ownEffect === 'boolean');
    case 'raidCountThisTurn': return onlyKeys(v, ['source', 'who']) && (v.who === 'self' || v.who === 'opponent');
    case 'selectedCount': return onlyKeys(v, ['source', 'bind']) && (v.bind === undefined || text(v.bind));
    case 'selectedDamageBonus': return onlyKeys(v, ['source', 'bind']) && (v.bind === undefined || text(v.bind));
    case 'boundPrintedEnergy': return onlyKeys(v, ['source', 'bind']) && (v.bind === undefined || text(v.bind));
    case 'distinctEnergyValues': return onlyKeys(v, ['source', 'who', 'zone']) && v.zone !== undefined && (v.zone === 'sideline' || v.zone === 'field' || v.zone === 'fieldOrSideline');
    // 「…がある場合、…1枚につき…」 — a count gated by a printed condition.
    case 'gated': return onlyKeys(v, ['source', 'condition', 'count']) && record(v.condition) && validCondition(v.condition) && validTierCount(v.count);
    case 'restedEnergySum': return onlyKeys(v, ['source']);
    // 「自分のアクティブのAPカードの枚数分」 / 「この効果で場外に置いたカードの必要エナジーの数」.
    case 'apCount':
      return onlyKeys(v, ['source', 'who', 'state']) && (v.who === 'self' || v.who === 'opponent') && (v.state === 'active' || v.state === 'rested');
    case 'discardedEnergySum': return onlyKeys(v, ['source']);
    case 'retiredEnergySum': return onlyKeys(v, ['source']);
    case 'removedByThisEffect': return onlyKeys(v, ['source']);
    case 'retiredByThisEffect': return onlyKeys(v, ['source', 'who']) && (v.who === undefined || v.who === 'self' || v.who === 'opponent' || v.who === 'both');
    case 'restedByThisEffect': return onlyKeys(v, ['source']);
    case 'discardedByThisEffect': return onlyKeys(v, ['source', 'filter']) && (v.filter === undefined || validFilter(v.filter));
    case 'removal': return onlyKeys(v, ['source', 'who', 'kind', 'name', 'names']) && (v.who === 'self' || v.who === 'opponent') && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
      && (v.name === undefined || text(v.name)) && (v.names === undefined || strings(v.names));
    case 'distinctNames':
      return onlyKeys(v, ['source', 'who', 'names', 'notNames', 'kind', 'kinds', 'trait', 'notTrait', 'color', 'zone', 'other', 'by'])
        && (v.by === undefined || v.by === 'name' || v.by === 'energy')
        && (v.who === 'self' || v.who === 'opponent')
        && (v.other === undefined || typeof v.other === 'boolean')
        && (v.names === undefined || strings(v.names)) && (v.notNames === undefined || strings(v.notNames))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.trait === undefined || text(v.trait)) && (v.notTrait === undefined || text(v.notTrait)) && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.kinds === undefined || (Array.isArray(v.kinds) && v.kinds.length > 0 && v.kinds.every(k => ['character', 'field', 'event'].includes(String(k)))))
        && (v.zone === undefined || ['front', 'energy', 'field', 'sideline', 'fieldOrSideline', 'removal'].includes(String(v.zone)));
    case 'selfBp': return onlyKeys(v, ['source', 'who']) && (v.who === 'self' || v.who === 'opponent');
    case 'distinctTraits':
      return onlyKeys(v, ['source', 'who', 'color', 'traitContains', 'other'])
        && (v.who === 'self' || v.who === 'opponent')
        && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.traitContains === undefined || text(v.traitContains))
        && (v.other === undefined || typeof v.other === 'boolean');
    case 'sideline':
      return onlyKeys(v, ['source', 'who', 'kind', 'color', 'trait', 'notTrait', 'name', 'nameContains', 'names', 'other']) && (v.who === 'self' || v.who === 'opponent')
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.color === undefined || COLORS.includes(v.color as Color)) && (v.trait === undefined || text(v.trait))
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.names === undefined || strings(v.names))
        && (v.other === undefined || typeof v.other === 'boolean')
        && (v.notTrait === undefined || text(v.notTrait));
    case 'fieldCount':
      return onlyKeys(v, ['source', 'who', 'kind', 'trait', 'notTrait', 'color', 'notColor', 'name', 'nameContains', 'names', 'traits', 'sameLine', 'differentLine', 'minEnergy', 'maxEnergy', 'minApCost', 'maxApCost', 'printedApCost', 'minBP', 'maxBP', 'line', 'other', 'rested', 'active', 'raid', 'printedBP', 'hasTrigger', 'hasKeyword', 'hasKeywords', 'attackAbility', 'blockAbility', 'hasActivated']) && (v.who === 'self' || v.who === 'opponent')
        && (v.names === undefined || strings(v.names)) && (v.traits === undefined || strings(v.traits))
        && (v.rested === undefined || typeof v.rested === 'boolean') && (v.active === undefined || typeof v.active === 'boolean')
        && (v.raid === undefined || typeof v.raid === 'boolean')
        && (v.sameLine === undefined || typeof v.sameLine === 'boolean')
        && (v.differentLine === undefined || typeof v.differentLine === 'boolean')
        && (v.attackAbility === undefined || typeof v.attackAbility === 'boolean')
        && (v.blockAbility === undefined || typeof v.blockAbility === 'boolean')
        && (v.hasActivated === undefined || typeof v.hasActivated === 'boolean')
        && (v.minEnergy === undefined || integer(v.minEnergy)) && (v.maxEnergy === undefined || integer(v.maxEnergy))
        && (v.minApCost === undefined || integer(v.minApCost)) && (v.maxApCost === undefined || integer(v.maxApCost))
        && (v.printedBP === undefined || (record(v.printedBP) && onlyKeys(v.printedBP, ['min', 'max']) && (v.printedBP.min === undefined || integer(v.printedBP.min)) && (v.printedBP.max === undefined || integer(v.printedBP.max))))
    && (v.printedApCost === undefined || (record(v.printedApCost) && onlyKeys(v.printedApCost, ['min', 'max']) && (v.printedApCost.min === undefined || integer(v.printedApCost.min)) && (v.printedApCost.max === undefined || integer(v.printedApCost.max))))
        && (v.kind === undefined || ['character', 'field', 'event'].includes(String(v.kind)))
        && (v.trait === undefined || text(v.trait)) && (v.notTrait === undefined || text(v.notTrait)) && (v.color === undefined || COLORS.includes(v.color as Color))
        && (v.notColor === undefined || COLORS.includes(v.notColor as Color))
        && (v.name === undefined || text(v.name)) && (v.nameContains === undefined || text(v.nameContains))
        && (v.line === undefined || v.line === 'front' || v.line === 'energy') && (v.other === undefined || typeof v.other === 'boolean');
    case 'energyCount': case 'handCount': case 'lifeCount': case 'drewThisTurn': return onlyKeys(v, ['source', 'who']) && (v.who === 'self' || v.who === 'opponent');
    case 'producedEnergy': return onlyKeys(v, ['source', 'who', 'color']) && (v.who === 'self' || v.who === 'opponent') && (v.color === undefined || COLORS.includes(v.color as Color));
    case 'revealedTraitNames': return onlyKeys(v, ['source', 'who', 'trait', 'zone']) && (v.who === 'self' || v.who === 'opponent') && text(v.trait)
      && (v.zone === undefined || v.zone === 'front' || v.zone === 'energy');
    // 「公開した…カードの必要エナジーの数」 (MMM-2-016 / CGD-1-069) — the frame's reveal record.
    case 'revealedEnergy': return onlyKeys(v, ['source', 'color']) && (v.color === undefined || COLORS.includes(v.color as Color));
    case 'sum':
      return onlyKeys(v, ['source', 'counts']) && Array.isArray(v.counts) && v.counts.length > 0 && v.counts.length <= 6
        && v.counts.every(part => validTierCount(part));
    // 「…N枚につき」 — the unit division around an inner count.
    case 'perUnit':
      return onlyKeys(v, ['source', 'per', 'count']) && integer(v.per) && Number(v.per) > 0 && validTierCount(v.count);
    default: return false;
  }
}
/** Every event an effect may install a triggered ability for. */
export const ABILITY_EVENTS: readonly string[] = ['onPlay', 'onRaid', 'onAttack', 'onAttackDeclare', 'onBlock', 'onBlockWin', 'onBlocked', 'onRaided', 'onRetire', 'onMainEnd', 'onAttackPhaseStart', 'onAttackPhaseEnd', 'onRestedByEffect', 'onActivated', 'onMoved', 'onDiscardedFromHand', 'onMilled', 'onRemoved', 'onDamage', 'onOpponentAttack', 'onUnblockedAttack', 'onAttackEnd', 'onBattleWinAttackEnd', 'onBattleLossAttackEnd', 'onBlockedBattleEnd', 'onBattleWin', 'onBattleLose', 'onTurnStart', 'entered', 'onLifeToSideline', 'onRevealedFromDeck', 'onRevealedFromHand', 'onDeckToHand', 'onReturnedToHand', 'onLeftField', 'onBpIncreased', 'onBpDecreased', 'onUnderToSideline', 'onAbilityActivated', 'onDrew', 'onUnderToHand', 'onChosenByEffect', 'onEndPhaseStart', 'onMainPhaseStart', 'onSidelineToHand'];

export const DURATIONS: readonly Duration[] = ['turn', 'untilOwnTurnStart', 'untilOpponentAttackEnd', 'untilOpponentTurnEnd', 'attackEnd', 'whileSource'];

/** A `grantStatic` carries whole `StaticAbility` entries, so the ability shape is checked too. */
function validStaticAbility(v: unknown): boolean {
  if (!record(v) || !onlyKeys(v, ['condition', 'modifiers', 'oncePerTurn'])) return false;
  if (!Array.isArray(v.modifiers) || !(v.modifiers as unknown[]).length || !(v.modifiers as unknown[]).every(validStaticModifier)) return false;
  if (v.oncePerTurn !== undefined && v.oncePerTurn !== true) return false;
  return v.condition === undefined || validCondition(v.condition);
}

function validStaticModifier(v: unknown): boolean {
  if (!record(v)) return false;
  switch (v.type) {
    case 'bp': case 'impact': case 'damage': return onlyKeys(v, ['type', 'amount']) && Number.isSafeInteger(v.amount);
    case 'bpPer': return onlyKeys(v, ['type', 'count', 'amount']) && validTierCount(v.count) && Number.isSafeInteger(v.amount);
    case 'energy': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy);
    case 'energyPer': return onlyKeys(v, ['type', 'energy', 'count']) && validEnergy(v.energy) && validTierCount(v.count);
    case 'fieldGeneratesFromFront': case 'removalToSideline': return onlyKeys(v, ['type']);
    case 'opponentDrawRedirect': return onlyKeys(v, ['type']);
    case 'retireTriggerGate':
      return onlyKeys(v, ['type', 'cost'])
        && (v.cost === undefined || (record(v.cost) && onlyKeys(v.cost, ['hand']) && integer(v.cost.hand, 1)));
    case 'energyGenMultiplier': return onlyKeys(v, ['type', 'factor']) && integer(v.factor, 2);
    case 'attackLimit': return onlyKeys(v, ['type', 'max']) && integer(v.max, 1);
    case 'forbidDeploy': return onlyKeys(v, ['type', 'filter']) && validFilter(v.filter);
    case 'keywords': return onlyKeys(v, ['type', 'keywords']) && validKeywords(v.keywords);
    case 'stripKeywords':
      return onlyKeys(v, ['type', 'keywords', 'line']) && validKeywords(v.keywords)
        && (v.line === undefined || v.line === 'front' || v.line === 'energy');
    case 'selfTurnEffectsLost':
      return onlyKeys(v, ['type', 'names']) && (v.names === undefined || strings(v.names));
    case 'aliasName': return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'notAliasName': return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'countsAsMultiple': return onlyKeys(v, ['type', 'trait', 'count']) && text(v.trait) && integer(v.count, 2);
    case 'handBpReferenceBonus': return onlyKeys(v, ['type', 'amount']) && integer(v.amount);
    case 'sidelineEventCountBonus': return onlyKeys(v, ['type', 'amount']) && integer(v.amount);
    case 'sidelineAsEvent': return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'eventCardAlsoCharacter': return onlyKeys(v, ['type', 'names', 'color']) && strings(v.names) && (v.color === undefined || COLORS.includes(v.color as Color));
    case 'revealedAsCharacter': return onlyKeys(v, ['type', 'bp']) && (v.bp === undefined || integer(v.bp, 1));
    case 'mustAttack': return onlyKeys(v, ['type', 'self']) && (v.self === undefined || typeof v.self === 'boolean');
    case 'immuneToBpMinus':
      return onlyKeys(v, ['type', 'source']) && (v.source === undefined || v.source === 'characterEffect');
    case 'allColors': case 'enterActive': case 'enterRested': case 'canStep': case 'loseEffects': case 'generatesFromFront': case 'cannotEnterEnergy': case 'retireToRemoval': case 'sidelineToRemoval': case 'forbidBlockerAbilities': case 'forbidBattleLoserAbilities':
      return onlyKeys(v, ['type', 'source']) && (v.source === undefined || v.source === 'bpZero');
    // 「フロントLに登場できず、[自分の効果/このカードの効果/このカードの[起動メイン]]以外で移動できない」
    // — the movement carve-out of the reminder spelling rides as `except` on the movement half; placement
    // is never carved out.
    case 'cannotEnterFront':
      return onlyKeys(v, ['type', 'source', 'except']) && (v.source === undefined || v.source === 'bpZero')
        && (v.except === undefined || v.except === 'ownEffects' || v.except === 'selfEffect');
    case 'cannotMoveToFront':
      return onlyKeys(v, ['type', 'source', 'except']) && (v.source === undefined || v.source === 'bpZero')
        && (v.except === undefined || v.except === 'ownEffects' || v.except === 'selfEffect');
    case 'loserToDeckBottom': return onlyKeys(v, ['type', 'nameContains']) && text(v.nameContains);
    case 'battleOpponentLosesKeywords':
      return onlyKeys(v, ['type', 'keywords'])
        && Array.isArray(v.keywords) && (v.keywords as unknown[]).length > 0
        && (v.keywords as unknown[]).every(k => k === 'impactNegate');
    case 'forbidTriggers':
      return onlyKeys(v, ['type', 'events', 'keywords'])
        && (v.events === undefined || (Array.isArray(v.events) && (v.events as unknown[]).every(e => ABILITY_EVENTS.includes(e as string))))
        && (v.keywords === undefined || (Array.isArray(v.keywords) && (v.keywords as unknown[]).every(k => k === 'impactNegate')));
    // `doesNotRetire` is deliberately *not* in this group: the routed spelling carries a `source`, so it
    // has its own case below. Listing it here as well made the detailed case unreachable — a `switch`
    // takes the first matching label, and the argument-less group comes first.
    case 'mustBeBlocked':
      return onlyKeys(v, ['type', 'maxBP', 'overSelf', 'firstAttack']) && (v.maxBP === undefined || integer(v.maxBP, 1))
        && (v.overSelf === undefined || typeof v.overSelf === 'boolean')
        && (v.firstAttack === undefined || typeof v.firstAttack === 'boolean');
    // 「このキャラは、相手の〈X〉のアタックを可能ならブロックしなければならない。」 (CGD-1-069) — the
    // blocker-side named demand; the printed 〈X〉 rides as a literal name list. The list is absent on
    // the unnamed spelling 「このキャラは、相手のアタックを…」 (JJK-1-084), which covers any attacker.
    case 'mustBlockAttacker':
      return onlyKeys(v, ['type', 'names']) && (v.names === undefined || strings(v.names));
    // 「相手の効果で〔このキャラが場を離れるか、このキャラのBPがマイナスされる〕場合、代わりにこの
    // キャラをエナジーLに移動させてもよい。」 (KMY-P-002) — the relocation treatment.
    case 'energyMoveSubstitute':
      return onlyKeys(v, ['type']);
    case 'refuseGrantedAbilities':
      return onlyKeys(v, ['type', 'abilities'])
        && (v.abilities === undefined || (Array.isArray(v.abilities) && (v.abilities as unknown[]).every(entry => entry === 'cannotAttack' || entry === 'cannotBlock')));
    case 'cannotAttack': case 'cannotBlock': case 'cannotMovePhase': case 'canAttackFromEnergy':
    case 'cannotUseHandCards':
      return onlyKeys(v, ['type', 'filter']) && (v.filter === undefined || validFilter(v.filter));
    case 'cannotMove':
      // The owner-scoped 「相手の効果で…移動せず」 (YYH-1-027) rides `source: 'opponent'`; the
      // source-less spelling refuses every route and carries nothing else.
      return onlyKeys(v, ['type', 'source']) && (v.source === undefined || v.source === 'opponent');
    case 'attackOnlyNames':
      return onlyKeys(v, ['type', 'names']) && strings(v.names);
    case 'cannotActivate': case 'cannotSendLifeToSideline': case 'cannotBeRemovedByEffect': case 'cannotActivateExceptOwn':
    case 'activationApFree': case 'activationCostSubstitute': case 'getTriggerDeploySubstitute':
      return onlyKeys(v, ['type']);
    case 'retireSubstitute':
      return onlyKeys(v, ['type', 'filter', 'line', 'cause', 'leave', 'hand', 'minHand', 'substitute', 'under', 'top', 'base', 'life', 'minLife', 'follow', 'active', 'replenish', 'underMax', 'rest', 'toRemoval'])
        && (v.filter === undefined || validFilter(v.filter))
        && (v.substitute === undefined || validFilter(v.substitute))
        && (v.line === undefined || v.line === 'front' || v.line === 'energy')
        && (v.top === undefined || v.top === true)
        && (v.base === undefined || v.base === true)
        && (v.active === undefined || v.active === true)
          && (v.rest === undefined || v.rest === true)
          && (v.toRemoval === undefined || v.toRemoval === true)
          // 「場を離れる場合」 — the modifier covers every departure route rather than retirement only.
          // (F0's contract test accepts a bare flag; which prices a compiled node carries is the
          // compiler's business. The runtime answer this flag produces is validated on the state below.)
          && (v.leave === undefined || v.leave === true)
          && (v.cause === undefined || v.cause === 'opponentEffect' || v.cause === 'opponentTrigger' || v.cause === 'notBpZero' || v.cause === 'opponentEffectOrBattle' || v.cause === 'opponentEventEffect' || v.cause === 'anyEffect')
        && (v.follow === undefined || (Array.isArray(v.follow) && (v.follow as unknown[]).length > 0 && (v.follow as unknown[]).every(step => { try { validateEffects([step]); return true; } catch { return false; } })))
        && (v.hand === undefined || integer(v.hand, 1))
        && (v.under === undefined || integer(v.under, 1))
        && (v.life === undefined || integer(v.life, 1))
        && (v.minHand === undefined || integer(v.minHand, 1))
        && (v.minLife === undefined || integer(v.minLife, 1))
        && (v.replenish === undefined || integer(v.replenish, 1))
        && (v.underMax === undefined || integer(v.underMax, 0));
    case 'cannotBeBlockedBy':
      return onlyKeys(v, ['type', 'maxBP', 'filter'])
        && (v.maxBP === undefined || integer(v.maxBP)) && (v.filter === undefined || validFilter(v.filter))
        && (v.maxBP !== undefined || v.filter !== undefined);
    case 'canBeRaidedBy':
      return onlyKeys(v, ['type', 'filter', 'via'])
        && (v.filter === undefined || validFilter(v.filter))
        && (v.via === undefined || v.via === 'trigger');
    case 'cannotBeBlockedByAtLeast': return onlyKeys(v, ['type', 'minBP']) && integer(v.minBP);
    case 'apCostDelta': return onlyKeys(v, ['type', 'amount']) && Number.isSafeInteger(v.amount);
    case 'apCostDeltaOnRaid': return onlyKeys(v, ['type', 'amount']) && Number.isSafeInteger(v.amount);
    case 'energyCostDelta': return onlyKeys(v, ['type', 'color', 'amount', 'scope']) && COLORS.includes(v.color as Color) && Number.isSafeInteger(v.amount) && (v.scope === undefined || v.scope === 'hand' || v.scope === 'sideline' || v.scope === 'handOrSideline');
    case 'globalEnergyCostDelta': return onlyKeys(v, ['type', 'filter', 'color', 'amount']) && COLORS.includes(v.color as Color) && Number.isSafeInteger(v.amount) && validFilter(v.filter);
    case 'cannotReadyStep': return onlyKeys(v, ['type']);
    case 'maySkipReadyStep': return onlyKeys(v, ['type']);
    case 'damageSubstitute': return onlyKeys(v, ['type', 'min', 'to']) && integer(v.min, 1) && integer(v.to, 0);
    case 'forbidActiveTrigger': return onlyKeys(v, ['type', 'triggers'])
      && (v.triggers === undefined || (Array.isArray(v.triggers) && v.triggers.length > 0
        && (v.triggers as unknown[]).every(t => t === 'active' || t === 'draw' || t === 'special')));
    case 'specialTriggerRetireReplacement': return onlyKeys(v, ['type']);
    case 'returnSubstitute': return onlyKeys(v, ['type', 'hand', 'minHand']) && integer(v.hand, 1) && (v.minHand === undefined || integer(v.minHand, 1));
    case 'keywordPer': return onlyKeys(v, ['type', 'keyword', 'count', 'amount']) && (v.keyword === 'damage' || v.keyword === 'impact') && validTierCount(v.count) && Number.isSafeInteger(v.amount);
    case 'energyCostDeltaPer': return onlyKeys(v, ['type', 'color', 'amount', 'count', 'per', 'scope']) && COLORS.includes(v.color as Color) && Number.isSafeInteger(v.amount) && validTierCount(v.count) && integer(v.per, 1)
      && (v.scope === undefined || ['hand', 'notField', 'notFieldNotSideline', 'allPlaces'].includes(String(v.scope)));
    case 'raidEnergyCostDelta': return onlyKeys(v, ['type', 'color', 'amount', 'baseFilter', 'condition', 'asBase', 'raiderFilter', 'count', 'per']) && (v.count === undefined || validTierCount(v.count)) && (v.per === undefined || integer(v.per, 1)) && COLORS.includes(v.color as Color) && Number.isSafeInteger(v.amount) && (v.baseFilter === undefined || validFilter(v.baseFilter)) && (v.condition === undefined || validCondition(v.condition)) && (v.asBase === undefined || typeof v.asBase === 'boolean') && (v.raiderFilter === undefined || validFilter(v.raiderFilter));
    case 'selectBpRangeBonus':
      return onlyKeys(v, ['type', 'amount', 'colorTrigger']) && integer(v.amount, 1)
        && (v.colorTrigger === undefined || COLORS.includes(v.colorTrigger as Color));
    case 'selectableOnlyBy': return onlyKeys(v, ['type', 'source']) && validFilter(v.source);
    case 'paidChooseUpgrade': return onlyKeys(v, ['type', 'count']) && integer(v.count, 1);
    // The replacement carries a whole instruction list; its steps are validated like any other effects.
    case 'colorTriggerReplacement': {
      const shaped = onlyKeys(v, ['type', 'color', 'effects']) && COLORS.includes(v.color as Color)
        && Array.isArray(v.effects) && (v.effects as unknown[]).length > 0;
      if (!shaped) return false;
      validateEffects(v.effects as unknown[], 1);
      return true;
    }
    case 'apCostSet': return onlyKeys(v, ['type', 'amount']) && integer(v.amount) && (v.amount as number) >= 0;
    case 'energyCostSet': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy) && Object.keys(v.energy as object).length > 0;
    case 'energyCostSetOnField': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy) && Object.keys(v.energy as object).length > 0;
    case 'energyCostDeltaOnField': return onlyKeys(v, ['type', 'color', 'amount']) && COLORS.includes(v.color as Color) && Number.isSafeInteger(v.amount) && (v.amount as number) < 0;
    case 'energyCostDeltaForOthers': return onlyKeys(v, ['type', 'amount']) && Number.isSafeInteger(v.amount) && (v.amount as number) > 0;
    case 'deckEnergyCostDelta': return onlyKeys(v, ['type', 'filter', 'amount']) && validFilter(v.filter) && Number.isSafeInteger(v.amount) && (v.amount as number) < 0;
    case 'energyCostSetAll': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy) && Object.keys(v.energy as object).length > 0;
    case 'energyCostSetInSideline': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy) && Object.keys(v.energy as object).length > 0;
    case 'requiredEnergyAlternateWhileRevealed': return onlyKeys(v, ['type', 'energy']) && validEnergy(v.energy) && Object.keys(v.energy as object).length > 0;
    case 'cannotBeChosenBy': return onlyKeys(v, ['type', 'source', 'both', 'sourceNotTrait', 'sourceNotRaid'])
      && (v.source === undefined || ['characterEffect', 'eventEffect', 'trigger', 'any'].includes(String(v.source)))
      && (v.both === undefined || v.both === true)
      && (v.sourceNotTrait === undefined || text(v.sourceNotTrait))
      && (v.sourceNotRaid === undefined || v.sourceNotRaid === true);
    case 'cannotBeSniped': return onlyKeys(v, ['type', 'maxBP']) && (v.maxBP === undefined || integer(v.maxBP));
    case 'doesNotRetire': return onlyKeys(v, ['type', 'source'])
      && (v.source === undefined || ['characterEffect', 'eventEffect', 'trigger', 'battle'].includes(String(v.source)));
    case 'doesNotLeaveField': return onlyKeys(v, ['type', 'source', 'battle', 'anyOwner'])
      && (v.source === undefined || ['characterEffect', 'eventEffect', 'trigger'].includes(String(v.source)))
      && (v.battle === undefined || typeof v.battle === 'boolean')
      && (v.anyOwner === undefined || typeof v.anyOwner === 'boolean');
    case 'doesNotRest': return onlyKeys(v, ['type', 'own', 'both', 'sourceNotTrait'])
      && (v.own === undefined || v.own === true)
      && (v.both === undefined || v.both === true)
      && (v.sourceNotTrait === undefined || text(v.sourceNotTrait));
    case 'doesNotReturn': return onlyKeys(v, ['type', 'both', 'rules']) && (v.both === undefined || v.both === true)
      && (v.rules === undefined || v.rules === true);
    case 'cannotBeRaided': case 'overflowToSideline': case 'optionalLeaveToRemoval': return onlyKeys(v, ['type']);
    case 'leaveToHand': return onlyKeys(v, ['type', 'cause']) && (v.cause === undefined || v.cause === 'opponentEffect');
    case 'returnBaseToHand': return onlyKeys(v, ['type']);
    case 'handLimit': return onlyKeys(v, ['type', 'count']) && integer(v.count, 1);
    case 'cannotBlockFirstAttack': return onlyKeys(v, ['type']);
    case 'freeExtraDraw': return onlyKeys(v, ['type']);
    case 'moveDirectionSwap': return onlyKeys(v, ['type']);
    case 'getTriggerSubstitute': return onlyKeys(v, ['type']);
    case 'triggerToGetSubstitute': return onlyKeys(v, ['type']);
    case 'allCharsNoRetireByEffect': return onlyKeys(v, ['type']);
    case 'copyRaidBaseAbilities':
      return onlyKeys(v, ['type', 'events']) && Array.isArray(v.events) && (v.events as unknown[]).length > 0
        && (v.events as unknown[]).every(event => event === 'onPlay' || event === 'onAttack');
    case 'selectionTax':
      return onlyKeys(v, ['type', 'amount', 'kind', 'sources', 'restFilter', 'snipe']) && integer(v.amount, 1) && (v.kind === 'ap' || v.kind === 'hand' || v.kind === 'rest')
        && (v.snipe === undefined || typeof v.snipe === 'boolean')
        && (v.restFilter === undefined || (record(v.restFilter) && validFilter(v.restFilter)))
        && (v.sources === undefined || (Array.isArray(v.sources) && (v.sources as unknown[]).length > 0
          && (v.sources as unknown[]).every(s => ['characterEffect', 'eventEffect', 'trigger'].includes(String(s)))));
    case 'grantToField':
      return onlyKeys(v, ['type', 'filter', 'statics', 'triggers', 'nonStacking']) && validFilter(v.filter)
        && Array.isArray(v.statics) && (v.statics as unknown[]).every(validStaticAbility)
        && (v.triggers === undefined || (Array.isArray(v.triggers) && (v.triggers as unknown[]).length > 0
          && (v.triggers as unknown[]).every(trigger => record(trigger) && ABILITY_EVENTS.includes(String((trigger as Record<string, unknown>).event)) && Array.isArray((trigger as Record<string, unknown>).effects))))
        // A broadcast must carry *something*: statics alone, triggers alone (「…は「[アタック時]…」を得る」),
        // or both.
        && ((v.statics as unknown[]).length > 0 || ((v.triggers as unknown[] | undefined)?.length ?? 0) > 0)
        && (v.nonStacking === undefined || v.nonStacking === true);
    case 'grantToHand':
      return onlyKeys(v, ['type', 'filter', 'modifiers']) && validFilter(v.filter)
        && Array.isArray(v.modifiers) && (v.modifiers as unknown[]).length > 0
        && (v.modifiers as unknown[]).every(validStaticModifier);
    case 'useFromRemoval':
      return onlyKeys(v, ['type', 'filter']) && validFilter(v.filter);
    case 'colorTriggerSubstitute':
      return onlyKeys(v, ['type', 'color', 'from', 'to']) && COLORS.includes(v.color as Color)
        && ['character', 'field', 'event'].includes(String(v.from)) && ['character', 'field', 'event'].includes(String(v.to));
    case 'battleLoserTo': return onlyKeys(v, ['type', 'destination']) && ['energy', 'removal', 'hand', 'deckBottom', 'stay'].includes(String(v.destination));
    case 'nameOverride': return onlyKeys(v, ['type', 'name']) && text(v.name);
    case 'selfBattleLoserTo':
      return onlyKeys(v, ['type', 'destination', 'opponentMaxBP'])
        && ['energy', 'removal', 'hand', 'deckBottom'].includes(String(v.destination))
        && (v.opponentMaxBP === undefined || integer(v.opponentMaxBP, 1));

    case 'lineCapacity': return onlyKeys(v, ['type', 'line', 'amount']) && (v.line === 'front' || v.line === 'energy') && integer(v.amount, 1);
    case 'countsAsEventAsWell': return onlyKeys(v, ['type', 'filter']) && validFilter(v.filter);
    default: return false;
  }
}
export function validateEffects(value: unknown, depth = 0, allowRuntime = false): void {
  requireRule(Array.isArray(value) && value.length <= 200 && depth < 8, 'UNSUPPORTED_CARD', '效果列表无效或嵌套过深。');
  for (const e of value) {
    requireRule(record(e), 'UNSUPPORTED_CARD', '效果必须为指令对象。');
    let valid = false;
    switch (e.type) {
      case 'departureAnswer': valid = allowRuntime && onlyKeys(e,['type','cardId','destination']) && text(e.cardId) && (e.destination === 'original' || e.destination === 'removal' || e.destination === 'top' || (e.destination as string) === 'pay'); break;
      case 'departurePaySelect': valid = allowRuntime && onlyKeys(e,['type','cardId','count','prompt','candidates']) && text(e.cardId) && integer(e.count, 1) && text(e.prompt) && Array.isArray(e.candidates) && (e.candidates as unknown[]).length > 0 && (e.candidates as unknown[]).every(id => text(id)) && new Set(e.candidates as string[]).size === (e.candidates as unknown[]).length; break;
      case 'resumeCommand': valid = allowRuntime && onlyKeys(e,['type','command','pendingBefore','effectBefore']) && record(e.command) && record(e.command.action) && (e.command.player === 0 || e.command.player === 1) && (e.pendingBefore === null || record(e.pendingBefore)) && (e.effectBefore === undefined || record(e.effectBefore)); break;
      case 'triggerEntryChoice': valid = allowRuntime && onlyKeys(e,['type','phase','commands','pendingBefore']) && ['replacement','line','overflow'].includes(String(e.phase)) && record(e.pendingBefore) && e.pendingBefore.type === 'triggers' && record(e.commands) && Object.keys(e.commands).length > 0 && Object.values(e.commands).every(c => record(c) && integer(c.expectedRevision) && record(c.action) && c.action.type === 'resolveTrigger' && c.action.activate === true && text(c.action.cardId) && (c.player === 0 || c.player === 1)); break;
      case 'draw': valid = onlyKeys(e, ['type', 'count', 'countSource', 'upTo']) && integer(e.count, 1) && (e.upTo === undefined || typeof e.upTo === 'boolean')
        && (e.countSource === undefined || validTierCount(e.countSource)); break;
      case 'readyAp': valid = onlyKeys(e, ['type', 'count']) && integer(e.count, 1); break;
      case 'playerDamage': valid = onlyKeys(e, ['type', 'count']) && integer(e.count, 1); break;
      case 'drawDiscarded': valid = onlyKeys(e, ['type', 'to']) && (e.to === undefined || e.to === 'deckBottom'); break;
      case 'drawByRested': valid = onlyKeys(e, ['type', 'count']) && integer(e.count, 1); break;
      case 'lookTop': valid = onlyKeys(e, ['type']); break;
      case 'ifName':
        valid = onlyKeys(e, ['type', 'name', 'effects']) && text(e.name);
        validateEffects(e.effects, depth + 1, allowRuntime); break;
      case 'search': valid = onlyKeys(e, ['type', 'count', 'filter', 'max', 'discardAfterTake']) && integer(e.count, 1) && integer(e.max) && e.max <= e.count && validFilter(e.filter) && (e.discardAfterTake === undefined || typeof e.discardAfterTake === 'boolean'); break;
      case 'self': valid = onlyKeys(e, ['type', 'energyBonus', 'impact', 'retireMainEnd', 'keywords', 'bp', 'relative', 'lose']) && (e.energyBonus === undefined || validEnergy(e.energyBonus)) && (e.impact === undefined || integer(e.impact, 1)) && (e.retireMainEnd === undefined || typeof e.retireMainEnd === 'boolean') && (e.keywords === undefined || validKeywords(e.keywords)) && (e.bp === undefined || Number.isSafeInteger(e.bp)) && (e.relative === undefined || typeof e.relative === 'boolean') && (e.lose === undefined || typeof e.lose === 'boolean'); break;
      case 'boostTrait': valid = onlyKeys(e, ['type', 'trait', 'amount']) && text(e.trait) && Number.isSafeInteger(e.amount); break;
      case 'choose': {
        valid = onlyKeys(e, ['type', 'zone', 'filter', 'min', 'max', 'operation', 'amount', 'fallbackReturnSelf', 'apState'])
          && ['ownField', 'ownFront', 'enemyFront', 'ownSideline', 'ownAp'].includes(String(e.zone))
          && (e.apState === undefined || e.apState === 'rested' || e.apState === 'active')
          && (e.filter === undefined || validFilter(e.filter)) && integer(e.min) && integer(e.max, 1) && e.min <= e.max
          && ['return', 'retire', 'bp', 'evade', 'checkmate', 'readyAp'].includes(String(e.operation))
          && (['bp', 'evade', 'checkmate'].includes(String(e.operation)) ? Number.isSafeInteger(e.amount) : e.amount === undefined)
          && (e.fallbackReturnSelf === undefined || typeof e.fallbackReturnSelf === 'boolean');
        if (e.zone === 'ownAp') valid &&= e.operation === 'readyAp' && e.filter === undefined && !e.fallbackReturnSelf;
        else valid &&= e.operation !== 'readyAp' && e.apState === undefined;
        if (e.zone === 'ownSideline') valid &&= e.operation === 'return';
        if (e.fallbackReturnSelf) valid &&= e.zone === 'ownField' && e.operation === 'return' && e.min === 1 && e.max === 1;
        break;
      }
      case 'deployBatch':
        valid = onlyKeys(e, ['type', 'groups', 'rested', 'line']) && Array.isArray(e.groups) && e.groups.length > 0
          && e.groups.every(validFilter) && typeof e.rested === 'boolean' && (e.line === undefined || e.line === 'front' || e.line === 'energy');
        break;
      case 'select':
        valid = onlyKeys(e, ['type', 'bind', 'zone', 'zones', 'fromBinds', 'filter', 'min', 'max', 'choose', 'restOptional', 'printedMin', 'upTo', 'auto', 'all', 'distinctNames', 'distinctEnergy', 'maxPer', 'maxEnergyPer', 'declaredTarget', 'battleAttacker', 'excludeBattleAttacker', 'movedByThisEffect', 'underHosts', 'excludeBind', 'excludeChosenThisTurn', 'sameBpAsBind', 'sameNameAsBind', 'sameEnergyAsBind', 'differentNameFromBind', 'sameCountAsBind', 'differentLineFromBind', 'countDelta', 'excludeDeployedByThisEffect', 'deployedByThisEffect', 'energySumMin', 'bpSumMax', 'bpSumMin'])
          && (e.excludeChosenThisTurn === undefined || e.excludeChosenThisTurn === true
            || (record(e.excludeChosenThisTurn) && onlyKeys(e.excludeChosenThisTurn, ['trait', 'both'])
              && text(e.excludeChosenThisTurn.trait)
              && (e.excludeChosenThisTurn.both === undefined || typeof e.excludeChosenThisTurn.both === 'boolean')))

          && (e.countDelta === undefined || (record(e.countDelta) && onlyKeys(e.countDelta, ['count', 'amount']) && validTierCount(e.countDelta.count) && Number.isSafeInteger(e.countDelta.amount)))
          && (e.declaredTarget === undefined || e.declaredTarget === true)
          && (e.fromBinds === undefined || (Array.isArray(e.fromBinds) && (e.fromBinds as unknown[]).length > 0 && (e.fromBinds as unknown[]).every(bind => text(bind) && (bind as string).length <= 12)))
          && (e.battleAttacker === undefined || e.battleAttacker === true)
          && (e.excludeBattleAttacker === undefined || e.excludeBattleAttacker === true)
          && (e.movedByThisEffect === undefined || e.movedByThisEffect === true)
          && (e.excludeDeployedByThisEffect === undefined || e.excludeDeployedByThisEffect === true)
          && (e.deployedByThisEffect === undefined || e.deployedByThisEffect === true)
          && (e.energySumMin === undefined || integer(e.energySumMin, 1))
          && (e.bpSumMax === undefined || integer(e.bpSumMax, 1))
          && (e.bpSumMin === undefined || integer(e.bpSumMin, 1))
          && (e.excludeBind === undefined || (text(e.excludeBind) && (e.excludeBind as string).length <= 12))
          && (e.sameNameAsBind === undefined || (text(e.sameNameAsBind) && (e.sameNameAsBind as string).length <= 12))
          && (e.sameEnergyAsBind === undefined || (text(e.sameEnergyAsBind) && (e.sameEnergyAsBind as string).length <= 12))
          && (e.differentNameFromBind === undefined || (text(e.differentNameFromBind) && (e.differentNameFromBind as string).length <= 12))
          && text(e.bind) && e.bind.length <= 12 && ZONES.includes(e.zone as ZoneId)
          && (e.zones === undefined
            || (Array.isArray(e.zones) && (e.zones as unknown[]).length >= 2 && (e.zones as unknown[]).every(z => ZONES.includes(z as ZoneId))))
          && (e.filter === undefined || validFilter(e.filter)) && integer(e.min) && integer(e.max, 1) && e.min <= e.max
          && (e.underHosts === undefined || validFilter(e.underHosts))
          && (e.choose === undefined || e.choose === 'self' || e.choose === 'opponent')
          && (e.restOptional === undefined || typeof e.restOptional === 'boolean')
          && (e.printedMin === undefined || (integer(e.printedMin, 1) && e.printedMin <= e.max))
          && (e.upTo === undefined || e.upTo === true)
          && (e.auto === undefined || typeof e.auto === 'boolean')
          && (e.all === undefined || e.all === true)
          && (e.distinctNames === undefined || typeof e.distinctNames === 'boolean')
          && (e.distinctEnergy === undefined || typeof e.distinctEnergy === 'boolean')
          && (e.maxPer === undefined || (record(e.maxPer) && onlyKeys(e.maxPer, ['count', 'amount']) && validTierCount(e.maxPer.count) && Number.isSafeInteger(e.maxPer.amount)))
          && (e.maxEnergyPer === undefined || (record(e.maxEnergyPer) && onlyKeys(e.maxEnergyPer, ['count', 'amount']) && validTierCount(e.maxEnergyPer.count) && integer(e.maxEnergyPer.amount, 1) && (e.filter as { maxEnergy?: unknown } | undefined)?.maxEnergy !== undefined));
        break;
      case 'act':
        valid = onlyKeys(e, ['type', 'target', 'operation', 'amount', 'amountPer', 'line', 'keywords', 'relative', 'energy', 'duration', 'baseBind', 'underBind', 'chooser', 'amountFrom', 'faceUp', 'baseFromPeel', 'faceDownOnly', 'underOnly', 'suppressOnPlay'])
          && text(e.target) && e.target.length <= 12 && CARD_OPERATIONS.includes(e.operation as CardOperation)
          && (e.suppressOnPlay === undefined || e.suppressOnPlay === true)
          && (e.underBind === undefined || (text(e.underBind) && (e.underBind as string).length <= 12))
          && (e.baseFromPeel === undefined || (text(e.baseFromPeel) && (e.baseFromPeel as string).length <= 12))
          && (e.chooser === undefined || e.chooser === 'self' || e.chooser === 'opponent')
          && (e.amountFrom === undefined || (record(e.amountFrom) && onlyKeys(e.amountFrom, ['stat', 'extreme', 'who', 'zone', 'other'])
            && e.amountFrom.stat === 'bp' && (e.amountFrom.extreme === 'max' || e.amountFrom.extreme === 'min')
            && (e.amountFrom.who === 'self' || e.amountFrom.who === 'opponent')
            && (e.amountFrom.zone === 'field' || e.amountFrom.zone === 'sideline')
            && (e.amountFrom.other === undefined || typeof e.amountFrom.other === 'boolean')
            && e.operation === 'bp'))
          // 「…に表向きで置く」 — only the two destinations whose face the engine models read it.
          && (e.faceUp === undefined || (e.faceUp === true && (e.operation === 'toLife' || e.operation === 'toDeckTop')))
          && (e.amount === undefined || Number.isSafeInteger(e.amount))
          && (e.amountPer === undefined || (record(e.amountPer) && onlyKeys(e.amountPer, ['count', 'amount']) && validTierCount(e.amountPer.count) && Number.isSafeInteger(e.amountPer.amount)))
          && (e.baseBind === undefined || text(e.baseBind))
          && (e.line === undefined || e.line === 'front' || e.line === 'energy')
          && (e.keywords === undefined || validKeywords(e.keywords))
          && (e.energy === undefined || validEnergy(e.energy))
          // A relative flag is only meaningful where something raises an existing value: a keyword
          // grant on this step, or the IMPACT / DAMAGE operation.
          && (e.relative === undefined || (typeof e.relative === 'boolean' && (e.relative ? (e.keywords !== undefined || e.operation === 'impact' || e.operation === 'damage') : true)))
          // Each payload belongs to its own operation and nowhere else.
          && (e.energy === undefined || e.operation === 'energy')
          && (e.keywords !== undefined || e.operation !== 'grantKeywords');
        break;
      case 'actSource':
        valid = onlyKeys(e, ['type', 'operation', 'amount', 'line', 'relative', 'energy', 'keywords', 'duration', 'baseBind', 'underBind', 'amountPer', 'faceUp', 'faceDownOnly', 'underOnly', 'optional', 'suppressOnPlay', 'raidTopOnly']) && CARD_OPERATIONS.includes(e.operation as CardOperation)
          && (e.suppressOnPlay === undefined || e.suppressOnPlay === true)
          && (e.raidTopOnly === undefined || e.raidTopOnly === true)
          && (e.faceUp === undefined || (typeof e.faceUp === 'boolean' && e.faceUp === true))
          && (e.optional === undefined || typeof e.optional === 'boolean')
          && (e.amountPer === undefined || (record(e.amountPer) && onlyKeys(e.amountPer, ['count', 'amount']) && validTierCount(e.amountPer.count) && Number.isSafeInteger(e.amountPer.amount)))
          && (e.amount === undefined || Number.isSafeInteger(e.amount)) && (e.line === undefined || e.line === 'front' || e.line === 'energy')
          && (e.duration === undefined || DURATIONS.includes(e.duration as Duration))
          && (e.energy === undefined || (validEnergy(e.energy) && e.operation === 'energy'))
          && (e.keywords === undefined || validKeywords(e.keywords))
          && (e.baseBind === undefined || text(e.baseBind))
          && (e.underBind === undefined || (text(e.underBind) && (e.underBind as string).length <= 12 && e.operation === 'toUnder'))
          && (e.relative === undefined || (typeof e.relative === 'boolean' && (e.relative ? e.operation === 'impact' || e.operation === 'damage' || e.operation === 'grantKeywords' : true)));
        break;
      case 'drawTo': valid = onlyKeys(e, ['type', 'player', 'count', 'upTo']) && (e.upTo === undefined || typeof e.upTo === 'boolean') && (e.player === 'self' || e.player === 'opponent') && integer(e.count, 1); break;
      case 'drawToEqual': valid = onlyKeys(e, ['type', 'player']) && (e.player === 'self' || e.player === 'opponent'); break;
      case 'drawToSize': valid = onlyKeys(e, ['type', 'player', 'count']) && (e.player === 'self' || e.player === 'opponent') && integer(e.count, 1); break;
      case 'discard': valid = onlyKeys(e, ['type', 'player', 'count', 'max', 'optional', 'all', 'filter', 'strict', 'to', 'countSource']) && (e.all === undefined || (e.all === true && e.max === undefined && e.optional === undefined && e.countSource === undefined)) && (e.player === 'self' || e.player === 'opponent') && integer(e.count, 1) && (e.max === undefined || (integer(e.max, 1) && (e.max as number) >= (e.count as number))) && (e.optional === undefined || typeof e.optional === 'boolean') && (e.strict === undefined || typeof e.strict === 'boolean') && (e.filter === undefined || validFilter(e.filter)) && (e.to === undefined || e.to === 'sideline' || e.to === 'removal') && (e.countSource === undefined || validTierCount(e.countSource)); break;
      case 'millTop':
        valid = onlyKeys(e, ['type', 'player', 'count', 'to', 'underBind', 'optional', 'upTo', 'faceUp', 'from', 'bind']) && (e.player === 'self' || e.player === 'opponent') && integer(e.count, 1) && ['sideline', 'removal', 'under', 'life'].includes(String(e.to))
          && (e.underBind === undefined || (text(e.underBind) && (e.underBind as string).length <= 12 && e.to === 'under'))
          && (e.bind === undefined || (text(e.bind) && (e.bind as string).length <= 12))
          && (e.optional === undefined || typeof e.optional === 'boolean')
          && (e.upTo === undefined || (typeof e.upTo === 'boolean' && (e.upTo !== true || e.optional === undefined)))
          && (e.faceUp === undefined || (typeof e.faceUp === 'boolean' && e.to === 'life'))
          && (e.from === undefined || e.from === 'bottom');
        break;
      case 'allowRemovalUse': valid = onlyKeys(e, ['type']); break;
      case 'retrieveRetired': valid = onlyKeys(e, ['type']); break;
      case 'useFromSideline':
        valid = onlyKeys(e, ['type', 'bind', 'free', 'to'])
          && (e.bind === undefined || text(e.bind))
          && (e.free === undefined || e.free === true)
          && (e.to === undefined || e.to === 'sideline' || e.to === 'removal');
        break;
      case 'if':
        valid = onlyKeys(e, ['type', 'condition', 'then', 'else']) && validCondition(e.condition) && Array.isArray(e.then);
        if (valid) { validateEffects(e.then, depth + 1, allowRuntime); if (e.else !== undefined) { requireRule(Array.isArray(e.else), 'UNSUPPORTED_CARD', '条件分支无效。'); validateEffects(e.else, depth + 1, allowRuntime); } }
        break;
      case 'gained':
        valid = onlyKeys(e, ['type', 'then', 'else', 'on', 'min', 'filter', 'exclude'])
          && (e.on === undefined || e.on === 'gained' || e.on === 'discarded' || e.on === 'moved' || e.on === 'deployed' || e.on === 'rested' || e.on === 'activated' || e.on === 'apReadied')
          && (e.then === undefined || Array.isArray(e.then)) && (e.else === undefined || Array.isArray(e.else))
          && (e.min === undefined || integer(e.min, 1)) && (e.filter === undefined || validFilter(e.filter))
          && (e.exclude === undefined || typeof e.exclude === 'boolean')
          // 「以外」 is only meaningful against a filter to invert.
          && (e.exclude !== true || e.filter !== undefined);
        if (valid) { if (e.then) validateEffects(e.then, depth + 1, allowRuntime); if (e.else) validateEffects(e.else, depth + 1, allowRuntime); }
        break;
      case 'ifSelected':
        valid = onlyKeys(e, ['type', 'bind', 'then', 'else']) && text(e.bind) && e.bind.length <= 12
          && (e.then === undefined || Array.isArray(e.then)) && (e.else === undefined || Array.isArray(e.else));
        if (valid) { if (e.then) validateEffects(e.then, depth + 1, allowRuntime); if (e.else) validateEffects(e.else, depth + 1, allowRuntime); }
        break;
      case 'chooseOption': {
        const options = Array.isArray(e.options) ? (e.options as unknown[]) : [];
        valid = onlyKeys(e, ['type', 'count', 'options', 'labels', 'forbidRepeat', 'forbidRepeatOnly', 'min', 'chooser', 'countSource', 'optionGates', 'entrySharedLimitKey']) && integer(e.count, 1) && options.length > 0 && options.length <= 12 && (e.count as number) <= options.length && options.every(Array.isArray)
          && (e.labels === undefined || (Array.isArray(e.labels) && (e.labels as unknown[]).length === options.length && (e.labels as unknown[]).every(label => text(label))))
          && (e.entrySharedLimitKey === undefined || (text(e.entrySharedLimitKey) && e.entrySharedLimitKey.startsWith('entry:')))
          && (e.forbidRepeat === undefined || text(e.forbidRepeat))
          && (e.forbidRepeatOnly === undefined || (Array.isArray(e.forbidRepeatOnly) && e.forbidRepeatOnly.length > 0 && (e.forbidRepeatOnly as unknown[]).every(i => Number.isSafeInteger(i))))
          && (e.countSource === undefined || validTierCount(e.countSource))
          && (e.optionGates === undefined || (Array.isArray(e.optionGates) && (e.optionGates as unknown[]).length <= options.length && (e.optionGates as unknown[]).every(gate => gate == null || validCondition(gate))))
          // `min: 0` is the fully declinable chooser (「…レイドさせてもよい」 compiled as one optional
          // branch) — the answer may be empty, the same shape a `select` with min 0 accepts.
          && (e.min === undefined || (integer(e.min, 0) && (e.min as number) <= (e.count as number)))
          && (e.chooser === undefined || e.chooser === 'self' || e.chooser === 'opponent');
        if (valid) for (const option of options) validateEffects(option, depth + 1, allowRuntime);
        break;
      }
      case 'payAp':
        valid = onlyKeys(e, ['type', 'count', 'optional', 'then', 'asCost']) && integer(e.count, 1) && (e.optional === undefined || typeof e.optional === 'boolean') && (e.then === undefined || Array.isArray(e.then)) && (e.asCost === undefined || typeof e.asCost === 'boolean');
        if (valid && e.then) validateEffects(e.then, depth + 1, allowRuntime);
        break;
      case 'payDiscard':
        valid = onlyKeys(e, ['type', 'count', 'optional', 'then']) && integer(e.count, 1) && (e.optional === undefined || typeof e.optional === 'boolean') && (e.then === undefined || Array.isArray(e.then));
        if (valid && e.then) validateEffects(e.then, depth + 1, allowRuntime);
        break;
      case 'discardSameEnergy':
        valid = onlyKeys(e, ['type', 'count', 'optional']) && integer(e.count, 1) && (e.optional === undefined || typeof e.optional === 'boolean');
        break;
      case 'delayMainEnd':
      case 'delayOpponentTurnStart':
      case 'delayAttackPhaseStart':
      case 'delayAttackPhaseEnd':
        valid = onlyKeys(e, ['type', 'effects']) && Array.isArray(e.effects);
        if (valid) validateEffects(e.effects as unknown[], depth + 1, allowRuntime);
        break;
      case 'lookReveal':
        valid = onlyKeys(e, ['type', 'count', 'countSource', 'countPer', 'filter', 'max', 'rest', 'discardAfterTake', 'take', 'takeLine', 'reveal', 'from', 'distinctNames', 'distinctEnergy', 'bpSumMax', 'takeChooser', 'takeGateOnly', 'takeMin', 'takeRandomBy', 'secondTake', 'takeGroups', 'takeGroupsTo', 'player', 'optional', 'underHostFilter', 'takeGate', 'takeAllEnergyRun', 'maxEnergyPer', 'takeToSidelineIf']) && integer(e.count, 1) && (e.filter === undefined || validFilter(e.filter))
          && (e.takeLine === undefined || e.takeLine === 'front' || e.takeLine === 'energy')
          && (e.takeAllEnergyRun === undefined || integer(e.takeAllEnergyRun, 1))
          && (e.takeToSidelineIf === undefined || validFilter(e.takeToSidelineIf))
          && (e.countPer === undefined || (record(e.countPer) && onlyKeys(e.countPer, ['count', 'amount']) && validTierCount(e.countPer.count) && Number.isSafeInteger(e.countPer.amount)))
          && (e.takeGate === undefined || (record(e.takeGate) && onlyKeys(e.takeGate, ['maxApCost', 'energySatisfied', 'names', 'filter']) && (e.takeGate.maxApCost === undefined || integer(e.takeGate.maxApCost, 1)) && (e.takeGate.energySatisfied === undefined || typeof e.takeGate.energySatisfied === 'boolean') && (e.takeGate.names === undefined || strings(e.takeGate.names)) && (e.takeGate.filter === undefined || validFilter(e.takeGate.filter))))
          && (e.reveal === undefined || typeof e.reveal === 'boolean')
          && (e.distinctNames === undefined || typeof e.distinctNames === 'boolean')
          && (e.distinctEnergy === undefined || typeof e.distinctEnergy === 'boolean')
          && (e.bpSumMax === undefined || integer(e.bpSumMax, 1))
          && (e.takeChooser === undefined || e.takeChooser === 'self' || e.takeChooser === 'opponent')
          && (e.takeRandomBy === undefined || e.takeRandomBy === 'self' || e.takeRandomBy === 'opponent')
          && (e.takeMin === undefined || (integer(e.takeMin, 1) && (e.takeMin as number) <= (e.max as number)))
          && (e.optional === undefined || typeof e.optional === 'boolean')
          && (e.countSource === undefined || validTierCount(e.countSource))
          && (e.from === undefined || e.from === 'deck' || e.from === 'deckBottom' || e.from === 'under' || e.from === 'life')
          && (e.underHostFilter === undefined || validFilter(e.underHostFilter))
          && integer(e.max) && (e.countSource !== undefined || e.countPer !== undefined || e.max <= e.count) && ['bottom', 'top', 'sideline', 'order', 'orderTop', 'lifeOrder', 'splitTop', 'splitTopSideline', 'topOrUnder', 'removal', 'topOrRemoval', 'topOrSideline', 'topOrSidelineOpponent', 'topBottomFaceUp', 'topOrBottom'].includes(String(e.rest))
          && (e.discardAfterTake === undefined || integer(e.discardAfterTake))
          && (e.secondTake === undefined || (record(e.secondTake) && onlyKeys(e.secondTake, ['max', 'filter', 'to', 'min']) && integer(e.secondTake.max, 1)
            && (e.secondTake.filter === undefined || validFilter(e.secondTake.filter))
            && (e.secondTake.to === undefined || e.secondTake.to === 'hand' || e.secondTake.to === 'under')
            && (e.secondTake.min === undefined || integer(e.secondTake.min, 1))))
          && (e.takeGroups === undefined || (Array.isArray(e.takeGroups) && e.takeGroups.length >= 1
            && e.takeGroups.every((group: unknown) => record(group) && onlyKeys(group, ['max', 'filter', 'distinctNames']) && integer(group.max, 1)
              && (group.filter === undefined || validFilter(group.filter))
              && (group.distinctNames === undefined || typeof group.distinctNames === 'boolean'))))
          && (e.take === undefined || ['hand', 'sideline', 'deploy', 'deployRested', 'deployOrRaid', 'deployRestedOrRaid', 'under', 'use', 'top', 'removal', 'handOrSideline', 'topOrSideline'].includes(String(e.take)))
          // 「相手は自身の山札の上から1枚を公開する」 — an opponent-deck look reveals in place: the card is
          // shown and put back, never taken into a line. 「…公開し手札に加えてもよい」 is the one
          // exception the pool prints: the card joins the *opponent's own* hand, which the engine routes
          // to that player (the chooser and the destination both follow `player`). BLC-1-022 / KMR-1-113
          // print the destination choice on the *opponent's* side (top or the opponent's 場外), which the
          // engine models as `rest: 'topOrSidelineOpponent'` — still no line, so the same gate holds.
          && (e.player === undefined || ((e.player === 'self' || e.player === 'opponent')
            && (e.player === 'self' || (e.from !== 'under' && (e.take === undefined || e.take === 'top' || e.take === 'hand') && (e.rest === 'top' || e.rest === 'topOrSidelineOpponent')))));
        break;
      case 'clashReveal': valid = onlyKeys(e, ['type', 'count', 'to']) && integer(e.count, 1) && (e.to === 'bottom' || e.to === 'top'); break;
      case 'note': valid = onlyKeys(e, ['type', 'text']) && text(e.text); break;
      case 'winGame': valid = onlyKeys(e, ['type']); break;
      case 'revealLooked':
        valid = onlyKeys(e, ['type', 'filter', 'optional'])
          && (e.filter === undefined || validFilter(e.filter))
          && (e.optional === undefined || typeof e.optional === 'boolean');
        break;
      case 'takeRevealed':
        valid = onlyKeys(e, ['type'])
        break;
      case 'deckTopFaceUp':
        valid = onlyKeys(e, ['type']);
        break;
      case 'takeFaceUpTop':
        valid = onlyKeys(e, ['type', 'optional']) && (e.optional === undefined || typeof e.optional === 'boolean');
        break;
      case 'faceUpLife':
        valid = onlyKeys(e, ['type', 'who', 'max', 'optional', 'chooser', 'includeFaceUp'])
          && (e.who === undefined || e.who === 'self' || e.who === 'opponent')
          && (e.chooser === undefined || e.chooser === 'self' || e.chooser === 'opponent')
          && (e.max === undefined || (Number.isSafeInteger(e.max) && (e.max as number) >= 1))
          && (e.optional === undefined || typeof e.optional === 'boolean')
          && (e.includeFaceUp === undefined || e.includeFaceUp === true);
        break;
      case 'drawByCount':
        valid = onlyKeys(e, ['type', 'count']) && validTierCount(e.count);
        break;
      case 'useRevealed':
        valid = onlyKeys(e, ['type', 'filter']) && (e.filter === undefined || validFilter(e.filter));
        break;
      case 'useChosen':
        valid = onlyKeys(e, ['type', 'bind']) && (e.bind === undefined || text(e.bind));
        break;
      case 'useSelf':
        valid = onlyKeys(e, ['type']);
        break;
      case 'markStatement':
        valid = onlyKeys(e, ['type', 'has']) && typeof e.has === 'boolean';
        break;
      case 'revealHand':
        valid = onlyKeys(e, ['type', 'player', 'keepBind', 'upTo']) && (e.player === undefined || e.player === 'self' || e.player === 'opponent')
          && (e.keepBind === undefined || text(e.keepBind)) && (e.upTo === undefined || e.upTo === true);
        break;
      case 'revealHandToBottom':
        valid = onlyKeys(e, ['type', 'count', 'optional']) && integer(e.count, 1)
          && (e.optional === undefined || typeof e.optional === 'boolean');
        break;
      case 'swapLines':
        valid = onlyKeys(e, ['type', 'a', 'b'])
          && text(e.a) && (e.a as string).length <= 12 && text(e.b) && (e.b as string).length <= 12 && e.a !== e.b;
        break;
      case 'moveUnder':
        valid = onlyKeys(e, ['type', 'from', 'to', 'withFaceDown', 'faceUp'])
          && text(e.from) && (e.from as string).length <= 12 && text(e.to) && (e.to as string).length <= 12
          && e.from !== e.to
          && (e.withFaceDown === undefined || typeof e.withFaceDown === 'boolean')
          && (e.faceUp === undefined || typeof e.faceUp === 'boolean');
        break;
      case 'discardedUnder':
        valid = onlyKeys(e, ['type', 'optional', 'from', 'underBind', 'name']) && (e.optional === undefined || typeof e.optional === 'boolean')
          && (e.from === undefined || e.from === 'retired')
          && (e.underBind === undefined || (text(e.underBind) && (e.underBind as string).length <= 12))
          && (e.name === undefined || text(e.name));
        break;
      case 'remainderToHand':
        valid = onlyKeys(e, ['type', 'from', 'exclude'])
          && Array.isArray(e.from) && (e.from as unknown[]).length > 0 && (e.from as unknown[]).every(bind => text(bind) && (bind as string).length <= 12)
          && text(e.exclude) && (e.exclude as string).length <= 12;
        break;
      case 'watchBound':
        valid = onlyKeys(e, ['type', 'target', 'events', 'effects'])
          && text(e.target) && (e.target as string).length <= 12
          && Array.isArray(e.events) && (e.events as unknown[]).length > 0 && (e.events as unknown[]).every(k => k === 'retire' || k === 'blockedAttack')
          && Array.isArray(e.effects) && (e.effects as unknown[]).length > 0 && (e.effects as unknown[]).every(step => { try { validateEffects([step]); return true; } catch { return false; } });
        break;
      case 'takeUnder':
        valid = onlyKeys(e, ['type', 'target', 'count', 'all', 'fromCards', 'optional'])
          && text(e.target) && (e.target as string).length <= 12 && integer(e.count, 1)
            && (e.all === undefined || e.all === true)
            && (e.fromCards === undefined || e.fromCards === true)
            && (e.optional === undefined || typeof e.optional === 'boolean');
        break;
      case 'recoverDiscarded':
        valid = onlyKeys(e, ['type', 'max', 'from']) && integer(e.max, 1) && (e.from === undefined || e.from === 'deck');
        break;
      case 'eventCardToDeckTop':
        valid = onlyKeys(e, ['type']);
        break;
      case 'replayAbility':
        valid = (onlyKeys(e, ['type', 'target', 'event', 'asSelf']) && (e.target === 'source' || e.target === 'A' || e.target === 'discarded')
          && (e.event === 'onPlay' || e.event === 'onRetire' || e.event === 'onAttack' || e.event === 'trigger')
          && (e.asSelf === undefined || e.asSelf === true))
          || (onlyKeys(e, ['type', 'target', 'events']) && e.target === 'raidBase'
            && Array.isArray(e.events) && (e.events as unknown[]).length >= 1
            && (e.events as unknown[]).every(ev => ev === 'onPlay' || ev === 'onRetire'));
        break;
      case 'nextUseAp':
        valid = onlyKeys(e, ['type', 'filter', 'amount', 'zones', 'perEnergy']) && validFilter(e.filter) && Number.isSafeInteger(e.amount) && (e.amount as number) < 0
          && (e.zones === undefined || (Array.isArray(e.zones) && (e.zones as unknown[]).length >= 1
            && (e.zones as unknown[]).every(z => z === 'hand' || z === 'sideline' || z === 'removal')))
          && (e.perEnergy === undefined || e.perEnergy === true);
        break;
      case 'nextUseActive':
        valid = onlyKeys(e, ['type', 'filter', 'all']) && validFilter(e.filter) && (e.all === undefined || e.all === true);
        break;
      case 'nextEnergyDiscount':
        valid = onlyKeys(e, ['type', 'filter', 'color', 'amount', 'untilEnter']) && validFilter(e.filter)
          && COLORS.includes(e.color as Color) && Number.isSafeInteger(e.amount) && (e.amount as number) < 0
          && (e.untilEnter === undefined || validFilter(e.untilEnter));
        break;
      case 'nextUseEnergy':
        valid = onlyKeys(e, ['type', 'filter', 'color', 'amount']) && validFilter(e.filter) && COLORS.includes(e.color as Color)
          && Number.isSafeInteger(e.amount) && (e.amount as number) < 0;
        break;
      case 'nextRaidAp':
        valid = onlyKeys(e, ['type', 'filter', 'amount']) && validFilter(e.filter)
          && Number.isSafeInteger(e.amount) && (e.amount as number) < 0;
        break;
      case 'nextRaidEnergy':
        valid = onlyKeys(e, ['type', 'filter', 'color', 'amount']) && validFilter(e.filter) && COLORS.includes(e.color as Color)
          && Number.isSafeInteger(e.amount) && (e.amount as number) < 0;
        break;
      case 'nextActivationApFree':
        valid = onlyKeys(e, ['type', 'filter']) && validFilter(e.filter);
        break;
      case 'nextActivationSelectSwap':
        valid = onlyKeys(e, ['type', 'filter', 'from', 'zone']) && validFilter(e.filter)
          && ZONES.includes(e.from as ZoneId) && ZONES.includes(e.zone as ZoneId);
        break;
      case 'attackNoDamage': valid = onlyKeys(e, ['type']); break;
      case 'nextSelectBp': valid = onlyKeys(e, ['type', 'amount', 'all']) && Number.isSafeInteger(e.amount) && (e.amount as number) > 0 && (e.all === undefined || e.all === true); break;
      case 'purpleChooseAll':
        valid = onlyKeys(e, ['type', 'next', 'count']) && (e.next === undefined || e.next === true) && (e.count === undefined || integer(e.count, 1));
        break;
      case 'battleLoserTo': valid = onlyKeys(e, ['type', 'destination']) && ['energy', 'removal', 'hand', 'deckBottom', 'stay'].includes(String(e.destination)); break;

      case 'declare':
        valid = e.what === 'energyCount'
          ? onlyKeys(e, ['type', 'what', 'min', 'max']) && integer(e.min) && integer(e.max) && (e.min as number) <= (e.max as number)
          : e.what === 'name'
            ? onlyKeys(e, ['type', 'what', 'candidates']) && strings(e.candidates)
            : e.what === 'trait' && onlyKeys(e, ['type', 'what', 'contains']) && (e.contains === undefined || text(e.contains));
        break;
      case 'grantStatic':
        valid = onlyKeys(e, ['type', 'target', 'abilities', 'duration', 'sourceLine', 'raidBaseOf'])
          && (e.target === 'source' || e.target === 'A' || e.target === 'player' || e.target === 'opponentPlayer' || e.target === 'raidBase' || e.target === 'cause'
            || (Array.isArray(e.target) && e.target.length > 0 && e.target.every(bind => typeof bind === 'string')))
          && DURATIONS.includes(e.duration as Duration)
          && (e.sourceLine === undefined || e.sourceLine === 'front' || e.sourceLine === 'energy')
          && (e.raidBaseOf === undefined || (text(e.raidBaseOf) && (e.raidBaseOf as string).length <= 12 && e.target === 'raidBase'))
          && Array.isArray(e.abilities) && (e.abilities as unknown[]).length > 0 && (e.abilities as unknown[]).length <= 4
          && (e.abilities as unknown[]).every(validStaticAbility);
        break;
      case 'grantActivated': {
        const from = e.from as Record<string, unknown> | undefined;
        valid = onlyKeys(e, ['type', 'target', 'duration', 'from', 'apCostOnly', 'max']) && text(e.target) && (e.target as string).length <= 12
          && DURATIONS.includes(e.duration as Duration)
          && (e.apCostOnly === undefined || typeof e.apCostOnly === 'boolean')
          && (e.max === undefined || integer(e.max, 1))
          && record(from)
          && ('sameLine' in (from ?? {})
            ? onlyKeys(from, ['sameLine', 'filter']) && from!.sameLine === true && (from!.filter === undefined || validFilter(from!.filter))
            : 'bind' in (from ?? {})
              ? onlyKeys(from, ['bind']) && text(from!.bind)
              : 'removedByThisEffect' in (from ?? {})
                ? onlyKeys(from, ['removedByThisEffect']) && from!.removedByThisEffect === true
                : false);
        break;
      }
      case 'grantTurnAbilities': {
        const from = e.from as Record<string, unknown> | undefined;
        valid = onlyKeys(e, ['type', 'target', 'duration', 'from']) && (e.target === 'source' || e.target === 'A')
          && DURATIONS.includes(e.duration as Duration)
          && record(from)
          && ('bind' in (from ?? {})
            ? onlyKeys(from, ['bind']) && text(from!.bind)
            : 'removedByThisEffect' in (from ?? {})
              ? onlyKeys(from, ['removedByThisEffect']) && from!.removedByThisEffect === true
              : false);
        break;
      }
      case 'grantTrigger':
        valid = onlyKeys(e, ['type', 'target', 'event', 'effects', 'duration', 'oncePerTurn', 'sharedLimit', 'condition', 'eventCard', 'scope'])
          && (e.target === 'source' || e.target === 'A' || e.target === 'player') && DURATIONS.includes(e.duration as Duration)
          && ABILITY_EVENTS.includes(e.event as string) && Array.isArray(e.effects)
          && (e.oncePerTurn === undefined || typeof e.oncePerTurn === 'boolean')
          && (e.condition === undefined || validCondition(e.condition))
          && (e.eventCard === undefined || validFilter(e.eventCard))
          && (e.scope === undefined || e.scope === 'self' || e.scope === 'anyOfMine');
        if (valid) validateEffects(e.effects, depth + 1, allowRuntime);
        break;
      case 'tiered': {
        valid = onlyKeys(e, ['type', 'count', 'tiers', 'target']) && (e.target === undefined || typeof e.target === 'string') && validTierCount(e.count)
          && Array.isArray(e.tiers) && e.tiers.length > 0 && e.tiers.length <= 8
          && e.tiers.every((t: unknown) => record(t) && onlyKeys(t, ['min', 'max', 'effects', 'keywords', 'relative']) && integer(t.min) && Array.isArray(t.effects)
            && (t.max === undefined || (integer(t.max) && (t.max as number) >= (t.min as number)))
            && (t.keywords === undefined || validKeywords(t.keywords))
            && (t.relative === undefined || typeof t.relative === 'boolean')
            // A tier with neither is an empty bullet: it holds nothing for its threshold to switch on.
            && ((t.effects as unknown[]).length > 0 || t.keywords !== undefined));
        if (valid) for (const tier of e.tiers as { effects: unknown }[]) validateEffects(tier.effects, depth + 1, allowRuntime);
        break;
      }
    }
    requireRule(valid, 'UNSUPPORTED_CARD', '存在未支持的效果或无效参数。');
  }
}

export function validateCatalog(catalog: CardDefinition[]): void {
  requireRule(Array.isArray(catalog) && catalog.length > 0, 'INVALID_DECK', '卡牌目录不能为空。');
  const ids = new Set<string>();
  const functional = new Map<string, string>();
  for (const card of catalog) {
    requireRule(record(card), 'UNSUPPORTED_CARD', '卡牌定义必须是对象。');
    requireRule(card.implementation === 'core-v1', 'UNSUPPORTED_CARD', `卡牌 ${card.id} 尚未实现。`);
    requireRule(onlyKeys(card, ['id', 'functionalId', 'copyLimit', 'work', 'name', 'implementation', 'kind', 'apCost', 'requiredEnergy', 'generatedEnergy', 'bp', 'traits', 'keywords', 'raidScopedKeywords', 'raid', 'raidFromRaidTop', 'playCondition', 'raidOnly', 'raidOrEffectOnly', 'ignoresEnergyColor', 'noTriggerInHandDeck', 'raidCondition', 'raidOrderChoice', 'raidTriggerForced', 'useLimit', 'useTarget', 'useReveal', 'alsoKinds', 'onPlay', 'onRaid', 'onPlaySharedLimit', 'activeOnPlay', 'activeEnergyBonus', 'activated', 'trigger', 'static', 'triggered']), 'UNSUPPORTED_CARD', '卡牌包含尚未支持的字段。');
    requireRule(card.onPlaySharedLimit === undefined || card.onPlaySharedLimit === true, 'UNSUPPORTED_CARD', '登场共享额度参数无效。');
    requireRule(card.raidFromRaidTop === undefined || (card.kind === 'character' && record(card.raidFromRaidTop)
      && onlyKeys(card.raidFromRaidTop, ['names', 'nameContains', 'notRaidedThisTurn'])
      && (card.raidFromRaidTop.names === undefined || strings(card.raidFromRaidTop.names))
      && (card.raidFromRaidTop.nameContains === undefined || strings(card.raidFromRaidTop.nameContains))
      && (card.raidFromRaidTop.notRaidedThisTurn === undefined || card.raidFromRaidTop.notRaidedThisTurn === true)
      && ((card.raidFromRaidTop.names?.length ?? 0) + (card.raidFromRaidTop.nameContains?.length ?? 0) > 0)), 'UNSUPPORTED_CARD', '特殊 RAID 起点参数无效。');
    requireRule(card.useTarget === undefined || (record(card.useTarget) && onlyKeys(card.useTarget, ['filter', 'zone', 'apCostDelta']) && validFilter(card.useTarget.filter) && (card.useTarget.zone === 'ownFront' || card.useTarget.zone === 'ownField') && Number.isSafeInteger(card.useTarget.apCostDelta)), 'UNSUPPORTED_CARD', '使用目标宣告参数无效。');
    requireRule(card.useReveal === undefined || card.useReveal === true, 'UNSUPPORTED_CARD', '使用时公开手牌参数无效。');
    requireRule(card.alsoKinds === undefined || (Array.isArray(card.alsoKinds) && card.alsoKinds.length > 0 && card.alsoKinds.every(kind => ['character', 'field', 'event'].includes(kind))), 'UNSUPPORTED_CARD', '附加卡种无效。');
    requireRule(card.raidOnly === undefined || (card.raidOnly === true && card.kind === 'character'), 'UNSUPPORTED_CARD', 'RAID 限定登场参数无效。');
    requireRule(card.raidOrEffectOnly === undefined || (card.raidOrEffectOnly === true && card.kind === 'character'), 'UNSUPPORTED_CARD', '效果／RAID 限定登场参数无效。');
    requireRule(card.useLimit === undefined || (record(card.useLimit) && onlyKeys(card.useLimit, ['turns', 'count']) && integer(card.useLimit.turns, 1) && integer(card.useLimit.count, 1)), 'UNSUPPORTED_CARD', '使用次数限制参数无效。');
    requireRule(card.copyLimit === undefined || (integer(card.copyLimit, 1) && card.copyLimit <= 50), 'INVALID_DECK', '卡文规定的构筑上限必须为 1–50 的整数。');
    requireRule(card.playCondition === undefined || validCondition(card.playCondition), 'UNSUPPORTED_CARD', '使用条件无效。');
    requireRule(card.raidCondition === undefined || validCondition(card.raidCondition), 'UNSUPPORTED_CARD', 'RAID 条件无效。');
    requireRule(card.raidOrderChoice === undefined || card.raidOrderChoice === true, 'UNSUPPORTED_CARD', 'RAID 顺序标记无效。');
    requireRule(text(card.id) && text(card.functionalId) && text(card.work) && text(card.name), 'INVALID_DECK', '卡牌身份、作品及名称不能为空。');
    requireRule(!ids.has(card.id), 'INVALID_DECK', `重复卡牌定义：${card.id}`);
    ids.add(card.id);
    requireRule(['character', 'field', 'event'].includes(card.kind), 'UNSUPPORTED_CARD', '未知卡牌类型。');
    requireRule(integer(card.apCost), 'UNSUPPORTED_CARD', 'AP 费用必须是非负整数。');
    for (const energy of [card.requiredEnergy, card.generatedEnergy]) {
      requireRule(record(energy) && onlyKeys(energy, COLORS) && Object.values(energy).every(n => integer(n)), 'UNSUPPORTED_CARD', '能量必须使用已支持的颜色和非负整数。');
    }
    requireRule(card.kind === 'character' ? integer(card.bp) : card.bp === undefined, 'UNSUPPORTED_CARD', '只有角色必须定义基础 BP。');
    requireRule(card.traits === undefined || strings(card.traits), 'UNSUPPORTED_CARD', '特征必须是字符串数组。');
    if (card.keywords !== undefined) {
      requireRule(card.kind === 'character' && record(card.keywords), 'UNSUPPORTED_CARD', '只有角色支持战斗关键词。');
      requireRule(onlyKeys(card.keywords, ['step', 'damage', 'impact', 'impactNegate', 'doubleAttack', 'doubleBlock', 'snipe']), 'UNSUPPORTED_CARD', '存在尚未实现的关键词。');
      for (const [key, value] of Object.entries(card.keywords)) {
        requireRule(key === 'damage' || key === 'impact' ? integer(value, 1) : typeof value === 'boolean', 'UNSUPPORTED_CARD', `关键词参数无效：${key}`);
      }
    }
    if (card.raidScopedKeywords !== undefined) {
      requireRule(card.kind === 'character' && record(card.raidScopedKeywords), 'UNSUPPORTED_CARD', '只有角色支持战斗关键词。');
      requireRule(onlyKeys(card.raidScopedKeywords, ['step', 'damage', 'impact', 'impactNegate', 'doubleAttack', 'doubleBlock', 'snipe']), 'UNSUPPORTED_CARD', '存在尚未实现的关键词。');
      for (const [key, value] of Object.entries(card.raidScopedKeywords)) {
        requireRule(key === 'damage' || key === 'impact' ? integer(value, 1) : typeof value === 'boolean', 'UNSUPPORTED_CARD', `关键词参数无效：${key}`);
      }
    }
    if (card.raid !== undefined) {
      requireRule(card.kind === 'character' && record(card.raid) && onlyKeys(card.raid, ['names', 'traits', 'nameContains', 'nameContainsAll', 'filter'])
        && (card.raid.filter === undefined || validFilter(card.raid.filter)), 'UNSUPPORTED_CARD', '只支持基本名称/特征 RAID。');
      requireRule((card.raid.names === undefined || strings(card.raid.names)) && (card.raid.traits === undefined || strings(card.raid.traits)) && (card.raid.nameContains === undefined || strings(card.raid.nameContains)) && (card.raid.nameContainsAll === undefined || strings(card.raid.nameContainsAll)), 'UNSUPPORTED_CARD', 'RAID 条件无效。');
      // 「[レイド]必要エナジーが4以下の紫のキャラ…」 prints the base condition as a *filter* rather than a
      // name or trait list, so it counts as a condition too (SMD-1-071).
      requireRule((card.raid.names?.length ?? 0) + (card.raid.traits?.length ?? 0) + (card.raid.nameContains?.length ?? 0) + (card.raid.nameContainsAll?.length ?? 0) > 0
        || card.raid.filter !== undefined, 'UNSUPPORTED_CARD', 'RAID 必须有名称或特征条件。');
    }
    if (card.onPlay !== undefined) validateEffects(card.onPlay);
    if (card.onRaid !== undefined) { requireRule(card.raid, 'UNSUPPORTED_CARD', 'RAID 登场效果需要 RAID 条件。'); validateEffects(card.onRaid); }
    requireRule(card.activeOnPlay === undefined || (card.kind !== 'event' && typeof card.activeOnPlay === 'boolean'), 'UNSUPPORTED_CARD', '激活登场参数无效。');
    requireRule(card.activeEnergyBonus === undefined || (card.kind !== 'event' && validEnergy(card.activeEnergyBonus)), 'UNSUPPORTED_CARD', '持续能量参数无效。');
    if (card.activated !== undefined) {
      // An EVENT never sits on a field, so its activated abilities can only be 場外-scoped — the
      // 「[場外にある場合][起動メイン]…」 family (`MST-1-038`, whose whole reading activates from the discard
      // pile). The engine's own `activate` already accepts a sideline card exactly when its ability's
      // condition scopes it there; before this, such an event compiled but could not enter the catalog.
      const sidelineScoped = (value: unknown): boolean => {
        if (!record(value)) return false;
        if (value.type === 'atZone') return value.zone === 'sideline';
        if (value.type === 'all' && Array.isArray(value.conditions)) return (value.conditions as unknown[]).some(sidelineScoped);
        return false;
      };
      requireRule(Array.isArray(card.activated) && card.activated.length > 0 && card.activated.length <= 4
        && (card.kind !== 'event' || card.activated.every(a => record(a) && (sidelineScoped(a.condition) || a.zone === 'removal'))), 'UNSUPPORTED_CARD', '起动效果列表无效。');
      for (const a of card.activated) {
        requireRule(record(a) && onlyKeys(a, ['rest', 'oncePerTurn', 'sharedLimit', 'condition', 'effects', 'zone', 'handGate']) && typeof a.rest === 'boolean' && (a.oncePerTurn === undefined || typeof a.oncePerTurn === 'boolean') && (a.sharedLimit === undefined || a.sharedLimit === true) && (a.condition === undefined || validCondition(a.condition)) && (a.zone === undefined || a.zone === 'removal' || a.zone === 'hand') && (a.handGate === undefined || (a.handGate === 'energySatisfied' && (a.zone === 'hand' || sidelineScoped(a.condition)))), 'UNSUPPORTED_CARD', '起动效果参数无效。');
        validateEffects(a.effects);
      }
    }
    if (card.trigger !== undefined) {
      const trigger = card.trigger;
      requireRule(record(trigger) && ['get', 'draw', 'final', 'active', 'special', 'raid', 'color'].includes(trigger.type), 'UNSUPPORTED_CARD', '该生命触发尚未实现。');
      requireRule(trigger.type !== 'raid' || card.raid, 'UNSUPPORTED_CARD', 'RAID 触发需要 RAID 条件。');
      requireRule(onlyKeys(trigger, trigger.type === 'active' ? ['type', 'bpBonus'] : trigger.type === 'color' ? ['type', 'effects'] : ['type']), 'UNSUPPORTED_CARD', '触发包含尚未支持的条件。');
      if (trigger.type === 'active') requireRule(integer(trigger.bpBonus), 'UNSUPPORTED_CARD', 'ACTIVE 的 BP 加成必须为非负整数。');
      if (trigger.type === 'color') { requireRule(Array.isArray(trigger.effects) && trigger.effects.length > 0, 'UNSUPPORTED_CARD', 'COLOR 触发缺少效果。'); validateEffects(trigger.effects); }
    }
    if (card.static !== undefined) {
      requireRule(Array.isArray(card.static) && card.static.length > 0 && card.static.length <= 20, 'UNSUPPORTED_CARD', '持续效果列表无效。');
      for (const ability of card.static) {
        requireRule(record(ability) && onlyKeys(ability, ['condition', 'modifiers', 'oncePerTurn']) && (ability.condition === undefined || validCondition(ability.condition)) && (ability.oncePerTurn === undefined || ability.oncePerTurn === true), 'UNSUPPORTED_CARD', '持续效果条件无效。');
        requireRule(Array.isArray(ability.modifiers) && ability.modifiers.length > 0 && ability.modifiers.length <= 12 && ability.modifiers.every(validStaticModifier), 'UNSUPPORTED_CARD', '持续效果修正无效。');
      }
    }
    if (card.triggered !== undefined) {
      requireRule(Array.isArray(card.triggered) && card.triggered.length > 0 && card.triggered.length <= 8, 'UNSUPPORTED_CARD', '事件触发列表无效。');
      for (const ability of card.triggered) {
        requireRule(record(ability)
          && onlyKeys(ability, ['event', 'condition', 'eventCard', 'eventSource', 'underFaceDown', 'attackerOnly', 'oncePerTurn', 'sharedLimit', 'limitKey', 'limitTurns', 'limitCount', 'nameLimit', 'scope', 'zone', 'handGate', 'effects'])
          && (ability.underFaceDown === undefined || (ability.underFaceDown === true && ability.event === 'onUnderToSideline'))
        && (ability.scope === undefined || ability.scope === 'self' || ability.scope === 'anyOfMine' || ability.scope === 'anyOfTheirs')
          && ABILITY_EVENTS.includes(String(ability.event))
          && (ability.eventCard === undefined || validFilter(ability.eventCard))
          && (ability.eventSource === undefined || validFilter(ability.eventSource))
          && (ability.condition === undefined || validCondition(ability.condition))
          && (ability.oncePerTurn === undefined || typeof ability.oncePerTurn === 'boolean')
          && (ability.limitKey === undefined || (text(ability.limitKey) && (ability.limitKey as string).length <= 16))
          && (ability.limitTurns === undefined || integer(ability.limitTurns, 1))
          && (ability.limitCount === undefined || integer(ability.limitCount, 1))
          && (ability.nameLimit === undefined || text(ability.nameLimit))
          && (ability.sharedLimit === undefined || ability.sharedLimit === true)
          && (ability.zone === undefined || ability.zone === 'hand')
          && (ability.handGate === undefined || ability.handGate === 'energySatisfied'), 'UNSUPPORTED_CARD', '事件触发参数无效。');
        validateEffects(ability.effects);
      }
    }
    // Alternative prints must not bypass per-functional-card limits or alter game semantics.
    const signature = JSON.stringify(canonical({ ...card, id: '' }));
    requireRule(!functional.has(card.functionalId) || functional.get(card.functionalId) === signature, 'INVALID_DECK', `相同功能身份的卡牌定义不一致：${card.functionalId}`);
    functional.set(card.functionalId, signature);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function validateMatchConfig(config: MatchConfig): void {
  requireRule(record(config), 'INVALID_DECK', '对局配置无效。');
  validateCatalog(config.catalog);
  requireRule(config.firstPlayer === 0 || config.firstPlayer === 1, 'INVALID_DECK', '先攻玩家必须为 0 或 1。');
  requireRule(Number.isSafeInteger(config.seed), 'INVALID_DECK', '随机种子必须为安全整数。');
  requireRule(Array.isArray(config.decks) && config.decks.length === 2, 'INVALID_DECK', '必须提供两副卡组。');
  for (const deck of config.decks) {
    requireRule(Array.isArray(deck), 'INVALID_DECK', '主牌组必须是卡牌编号列表。');
    const result = inspectDeck(deck, config.catalog);
    requireRule(result.legal, 'INVALID_DECK', result.issues[0]?.message ?? '牌组构筑不合法。');
  }
}

/** Checks conservation and core invariants, including trigger and RAID holding zones. */
export function assertInvariants(state: GameState): void {
  const check = (condition: unknown, message: string): void => requireRule(condition, 'INVALID_STATE', message);
  check(state.schemaVersion === 2 && state.rulesVersion === 'ua-effects-2026-09-25', '状态版本不兼容。');
  check(integer(state.revision) && integer(state.turn) && integer(state.rng) && state.rng <= 0xffffffff, '回合、版本或随机状态无效。');
  check(state.activePlayer === 0 || state.activePlayer === 1, '行动玩家无效。');
  check(state.firstPlayer === 0 || state.firstPlayer === 1, '先攻玩家无效。');
  check(['setup', 'playing', 'finished'].includes(state.status) && ['setup', 'start', 'movement', 'main', 'attack', 'end'].includes(state.phase), '状态或阶段无效。');
  check(state.players.length === 2, '必须有两名玩家。');
  check(state.turnEvents === undefined || (Array.isArray(state.turnEvents)
    && state.turnEvents.every(e => record(e) && onlyKeys(e, ['event', 'player', 'cardId', 'phase', 'activePlayer', 'free', 'via', 'raid', 'usedFrom', 'line', 'causeOwner', 'causeId', 'cause', 'to', 'from', 'count', 'apCost'])
      && TURN_EVENT_KINDS.includes(e.event as TurnEventKind)
      && (e.player === 0 || e.player === 1)
      && (e.phase === undefined || ['setup', 'start', 'movement', 'main', 'attack', 'end'].includes(String(e.phase)))
      && (e.activePlayer === undefined || e.activePlayer === 0 || e.activePlayer === 1)
      && (e.free === undefined || typeof e.free === 'boolean')
      && (e.causeOwner === undefined || e.causeOwner === 0 || e.causeOwner === 1)
      && (e.cause === undefined || e.cause === 'bpZero' || e.cause === 'battle' || e.cause === 'effect')
      && (e.via === undefined || e.via === 'play' || e.via === 'effect')
      && (e.raid === undefined || e.raid === true)
      && (e.usedFrom === undefined || e.usedFrom === 'hand' || e.usedFrom === 'sideline' || e.usedFrom === 'deck' || e.usedFrom === 'removal' || e.usedFrom === 'under')
      && (e.line === undefined || e.line === 'front' || e.line === 'energy')
      && (e.to === undefined || e.to === 'front' || e.to === 'energy')
      && (e.cardId === undefined || Object.hasOwn(state.cards, e.cardId as string)))), '回合事件记录无效。');
  const resolvingLife = new Set<string>();
  const seen = new Set<string>();
  const count: [number, number] = [0, 0];
  const visit = (id: string, owner: 0 | 1): void => {
    const card = state.cards[id];
    check(Object.hasOwn(state.cards, id) && card?.id === id && card.owner === owner, `卡片身份/所有者错误：${id}`);
    check(card && Object.hasOwn(state.catalog, card.definitionId), '卡片引用了未知定义。');
    check(!seen.has(id), `卡片同时处于多个区域：${id}`);
    seen.add(id);
    count[owner]++;
  };
  for (const owner of [0, 1] as const) {
    const p = state.players[owner];
    check(p.ap.length === 3 && p.ap.every(ap => ['inactive', 'active', 'rested'].includes(ap)), 'AP 状态无效。');
    check(integer(p.turnsStarted), '个人回合数无效。');
    check(p.eventsUsedThisTurn === undefined || integer(p.eventsUsedThisTurn), '事件使用计数无效。');
    check(p.removalUseForTurn === undefined || (record(p.removalUseForTurn) && integer(p.removalUseForTurn.turn) && Array.isArray(p.removalUseForTurn.ids) && p.removalUseForTurn.ids.every((id: unknown) => typeof id === 'string')), '移除区使用记录无效。');
    for (const zone of [p.deck, p.hand, p.life, p.sideline, p.removal]) for (const id of zone) visit(id, owner);
    for (const line of ['front', 'energy'] as const) {
      check(p[line].length <= 4, '每条战线最多 4 张。');
      for (const field of p[line]) {
        visit(field.cardId, owner);
        const definition = state.catalog[state.cards[field.cardId]!.definitionId]!;
        check(definition.kind !== 'event' && (line !== 'front' || definition.kind === 'character'), '该类型不能存在于此战线。');
        check(typeof field.active === 'boolean' && integer(field.attacksThisTurn) && integer(field.blocksThisTurn), '场上卡片状态无效。');
        check(field.underneath.length <= 1 && (field.underneath.length === 0 || definition.raid), '非法 RAID 叠放。');
        for (const id of field.underneath) {
          visit(id, owner);
          check(state.catalog[state.cards[id]!.definitionId]!.kind === 'character', 'RAID 下层必须为角色。');
        }
        check(field.faceDown === undefined || (Array.isArray(field.faceDown) && field.faceDown.every(id => typeof id === 'string')), '卡下暗置卡无效。');
        for (const id of field.faceDown ?? []) visit(id, owner);
        check(field.bpModifiers.every(m => Number.isSafeInteger(m.amount) && integer(m.expiresTurn)), 'BP 修正无效。');
        check(field.instanceId === undefined || text(field.instanceId), '场上对象编号无效。');
        check(field.abilityUsed === undefined || (record(field.abilityUsed) && Object.values(field.abilityUsed).every(integer)), '起动回合无效。');
        check(field.retireAtMainEnd === undefined || integer(field.retireAtMainEnd), '延迟退场回合无效。');
        check(field.energyModifiers === undefined || (Array.isArray(field.energyModifiers) && field.energyModifiers.every(m => validEnergy(m.energy) && integer(m.expiresTurn))), '临时能量无效。');
        check(field.energyCostModifiers === undefined || (Array.isArray(field.energyCostModifiers) && field.energyCostModifiers.every(m => Number.isSafeInteger(m.amount) && integer(m.expiresTurn))), '临时必要能量无效。');
        check(field.mustBlockAttacker === undefined || (Array.isArray(field.mustBlockAttacker) && field.mustBlockAttacker.every(m => Array.isArray(m.names) && m.names.every(name => typeof name === 'string') && integer(m.expiresTurn))), '阻挡强要记录无效。');
        check(field.boundWatches === undefined || (Array.isArray(field.boundWatches) && field.boundWatches.every(m => typeof m.id === 'string' && (m.kind === 'retire' || m.kind === 'blockedAttack') && (m.attackerId === undefined || typeof m.attackerId === 'string') && Array.isArray(m.effects) && integer(m.expiresTurn))), '绑定观察记录无效。');
        check(field.impactModifiers === undefined || (Array.isArray(field.impactModifiers) && field.impactModifiers.every(m => integer(m.value, 1) && typeof m.additive === 'boolean' && integer(m.expiresTurn))), '临时 IMPACT 无效。');
        check(field.evadeModifiers === undefined || (Array.isArray(field.evadeModifiers) && field.evadeModifiers.every(m => integer(m.maxBP) && integer(m.expiresTurn))), '阻挡限制无效。');
        check(field.entered === undefined || (record(field.entered) && onlyKeys(field.entered, ['from', 'by', 'turn', 'raid', 'causeKind', 'causeName', 'causeOwner'])
          && (field.entered.causeOwner === undefined || field.entered.causeOwner === 0 || field.entered.causeOwner === 1)
          && ['hand', 'sideline', 'deck', 'life', 'removal', 'under'].includes(String((field.entered as Record<string, unknown>).from))
          && ((field.entered as Record<string, unknown>).by === 'play' || (field.entered as Record<string, unknown>).by === 'effect')
          && ((field.entered as Record<string, unknown>).raid === undefined || typeof (field.entered as Record<string, unknown>).raid === 'boolean')
          // 「自分の〔キャラ・フィールド〕の効果で登場していた」 — the placing effect's own kind, written by the
          // effect-placement sites; it was missing from this key list, so every effect placement from a
          // resolvable source failed validation the moment its result was checked.
          && ((field.entered as Record<string, unknown>).causeKind === undefined || ['character', 'field', 'event'].includes(String((field.entered as Record<string, unknown>).causeKind)))
          // 「〈メモリチェンジ〉の効果で登場していた」 — the placing effect source's name (KMR-2-048/054/057).
          && ((field.entered as Record<string, unknown>).causeName === undefined || typeof (field.entered as Record<string, unknown>).causeName === 'string')
          && integer((field.entered as Record<string, unknown>).turn)), '登场来源记录无效。');
        check(field.keywordModifiers === undefined || (Array.isArray(field.keywordModifiers) && field.keywordModifiers.every(m => validKeywords(m.keywords) && integer(m.expiresTurn) && (m.relative === undefined || typeof m.relative === 'boolean'))), '临时关键词无效。');
        check(field.effectsLostUntilTurn === undefined || integer(field.effectsLostUntilTurn), '效果无效化回合无效。');
        check(field.attackEndLapse === undefined || (Array.isArray(field.attackEndLapse) && field.attackEndLapse.every(kind => kind === 'cannotActivate' || kind === 'effectsLost')), '攻击阶段终了失效标记无效。');
        check(field.cannotActivateCharges === undefined || integer(field.cannotActivateCharges), '激活限制次数无效。');
        check(field.triggeredUsed === undefined || (record(field.triggeredUsed) && Object.values(field.triggeredUsed).every(n => integer(n))), '事件触发计数器无效。');
      }
    }
    check(p.sidelineTriggeredUsed === undefined || (record(p.sidelineTriggeredUsed) && Object.values(p.sidelineTriggeredUsed).every(integer)), '场外触发回合无效。');
    check(p.underTriggeredUsed === undefined || (record(p.underTriggeredUsed) && Object.values(p.underTriggeredUsed).every(integer)), '卡下触发回合无效。');
    check(p.revealTriggeredUsed === undefined || (record(p.revealTriggeredUsed) && Object.values(p.revealTriggeredUsed).every(integer)), '牌库公开触发回合无效。');
    check(p.handTriggeredUsed === undefined || (record(p.handTriggeredUsed) && Object.values(p.handTriggeredUsed).every(integer)), '手牌触发回合无效。');
    check(p.sharedLimitUsed === undefined || (record(p.sharedLimitUsed) && Object.values(p.sharedLimitUsed).every(integer)), '具名共享额度回合无效。');
    check(p.limitReserved === undefined || (record(p.limitReserved) && Object.values(p.limitReserved).every(entry =>
      record(entry) && integer((entry as { turn?: unknown }).turn)
      && ['shared', 'hand', 'sideline', 'under', 'card'].includes(String((entry as { to?: unknown }).to))
      && ((entry as { ref?: unknown }).ref === undefined || text((entry as { ref?: unknown }).ref))
      && ((entry as { ability?: unknown }).ability === undefined || text((entry as { ability?: unknown }).ability)))), '触发额度预留无效。');
    check(p.purpleChooseAll === undefined || (record(p.purpleChooseAll) && integer(p.purpleChooseAll.untilTurn)
      && (p.purpleChooseAll.remaining === undefined || integer(p.purpleChooseAll.remaining, 1))
      && (p.purpleChooseAll.count === undefined || integer(p.purpleChooseAll.count, 1))), '紫色全选待机无效。');
    check(p.nextEnergyDiscount === undefined || (Array.isArray(p.nextEnergyDiscount) && p.nextEnergyDiscount.every(entry => record(entry)
      && validFilter((entry as Record<string, unknown>).filter) && COLORS.includes((entry as Record<string, unknown>).color as Color)
      && Number.isSafeInteger((entry as Record<string, unknown>).amount) && integer((entry as Record<string, unknown>).expiresTurn)
      && ((entry as Record<string, unknown>).enterFilter === undefined || validFilter((entry as Record<string, unknown>).enterFilter)))), '待机能量减免无效。');
    check(p.delayedMainEnd === undefined || (Array.isArray(p.delayedMainEnd) && p.delayedMainEnd.every(entry => record(entry) && integer((entry as Record<string, unknown>).turn as number) && text(String((entry as Record<string, unknown>).sourceId)) && Array.isArray((entry as Record<string, unknown>).steps))), '主阶段延迟效果无效。');
    check(p.delayedTurnStart === undefined || (Array.isArray(p.delayedTurnStart) && p.delayedTurnStart.every(entry => record(entry) && integer((entry as Record<string, unknown>).turn as number) && text(String((entry as Record<string, unknown>).sourceId)) && Array.isArray((entry as Record<string, unknown>).steps) && ((entry as Record<string, unknown>).bindings === undefined || record((entry as Record<string, unknown>).bindings)))), '对手回合开始延迟效果无效。');
    // 「このターンのアタックフェイズ開始時/終了時」 — the same three-field parking shape (turn stamp, source,
    // steps), read by `takeDelayedAttack`.
    for (const field of ['delayedAttackStart', 'delayedAttackEnd'] as const) {
      const parked = p[field];
      check(parked === undefined || (Array.isArray(parked) && parked.every(entry => record(entry) && integer((entry as Record<string, unknown>).turn as number) && text(String((entry as Record<string, unknown>).sourceId)) && Array.isArray((entry as Record<string, unknown>).steps))), '攻击阶段延迟效果无效。');
    }
  }
  const validateTask = (task: import('./types.ts').EffectTask): void => {
    check(record(task) && text(task.id) && (task.player === 0 || task.player === 1) && Object.hasOwn(state.cards, task.sourceId) && state.cards[task.sourceId]!.owner === task.player && (task.sourceInstance === undefined || text(task.sourceInstance)), '效果任务来源无效。');
    check(task.abilityEvent === undefined || ABILITY_EVENTS.includes(task.abilityEvent), '效果任务时机无效。');
    check(task.battleSnapshot === undefined || (record(task.battleSnapshot)
      && onlyKeys(task.battleSnapshot, ['attacker', 'attackerId', 'defender', 'targetId', 'blockerId', 'onlyBlockerId', 'seq', 'won', 'compared', 'unblockedRaised', 'opponentAttackRaised', 'blockedRaised', 'doubleBlockReactivate', 'loserSent', 'noDamage', 'declare'])
      && (task.battleSnapshot.attacker === 0 || task.battleSnapshot.attacker === 1)
      && task.battleSnapshot.defender === (task.battleSnapshot.attacker === 0 ? 1 : 0)
      && text(task.battleSnapshot.attackerId) && state.cards[task.battleSnapshot.attackerId]?.owner === task.battleSnapshot.attacker
      && (['targetId', 'blockerId', 'onlyBlockerId', 'doubleBlockReactivate'] as const).every(key => task.battleSnapshot![key] === undefined || state.cards[task.battleSnapshot![key]!]?.owner === task.battleSnapshot!.defender)
      && (task.battleSnapshot.seq === undefined || integer(task.battleSnapshot.seq))
      && (task.battleSnapshot.won === undefined || typeof task.battleSnapshot.won === 'boolean')
      && (['compared', 'unblockedRaised', 'opponentAttackRaised', 'blockedRaised', 'loserSent'] as const).every(key => task.battleSnapshot![key] === undefined || task.battleSnapshot![key] === true)
      && (task.battleSnapshot.noDamage === undefined || typeof task.battleSnapshot.noDamage === 'boolean')
      // The declaration hand-over rides on the battle it belongs to; a snapshot taken while it is still
      // set (an attack-end raise on a battle the 「際」 batch ended) must validate as the same shape.
      && (task.battleSnapshot.declare === undefined || (record(task.battleSnapshot.declare)
        && onlyKeys(task.battleSnapshot.declare, ['targetId', 'ask'])
        && (task.battleSnapshot.declare.targetId === undefined || (text(task.battleSnapshot.declare.targetId) && Object.hasOwn(state.cards, task.battleSnapshot.declare.targetId)))
        && (task.battleSnapshot.declare.ask === undefined || task.battleSnapshot.declare.ask === true)))), '攻击结束战斗快照无效。');
    check(task.raidBase === undefined || (Array.isArray(task.raidBase) && task.raidBase.every(id => text(id) && Object.hasOwn(state.cards, id))), '退場時レイド元记录无效。');
    check(task.retireReason === undefined || text(task.retireReason), '退場原因记录无效。');
    check(task.departedLine === undefined || task.departedLine === 'front' || task.departedLine === 'energy', '离场战线记录无效。');
    check(task.retireCauseId === undefined || (text(task.retireCauseId) && Object.hasOwn(state.cards, task.retireCauseId)), '退場原因カード记录无效。');
    check(task.lifeArrival === undefined || (task.lifeArrival === task.sourceId && task.route === 'trigger'), '生命到达记录无效。');
    if (task.lifeArrival !== undefined) resolvingLife.add(task.lifeArrival);
    check(task.limitBudgetKeys === undefined || (Array.isArray(task.limitBudgetKeys) && task.limitBudgetKeys.length > 0 && task.limitBudgetKeys.every(text)), '触发额度结算记录无效。');
    validateEffects(task.steps,0,true);
  };
  const triggerBatch = state.pending?.type === 'triggers' ? state.pending : state.pending?.type === 'queue' ? state.pending.triggerResume
    : state.pending?.type === 'selectionTaxHand' ? state.pending.triggers
    : state.effect?.resume;
  if (triggerBatch) {
    check(triggerBatch.type === 'triggers' && (triggerBatch.player === 0 || triggerBatch.player === 1) && Array.isArray(triggerBatch.cards), '生命批次无效。');
    const waitingQueue = state.pending?.type === 'queue' && Array.isArray(state.pending.effects) && state.pending.effects.length > 0;
    check(state.effect || waitingQueue || triggerBatch.cards.length > 0 || triggerBatch.effects?.length, '触发决策不能为空。');
    for (const id of triggerBatch.cards) visit(id, triggerBatch.player);
    const get = triggerBatch.getResolution;
    check(get === undefined || (record(get) && onlyKeys(get,['cardId','effectiveTrigger','phase','sourceId','entryLine']) && text(get.cardId) && triggerBatch.cards.includes(get.cardId) && get.effectiveTrigger === 'get' && ['replacement','line','overflow'].includes(get.phase) && (get.sourceId === undefined || (text(get.sourceId) && state.cards[get.sourceId]?.owner === triggerBatch.player)) && (get.entryLine === undefined || ['front','energy'].includes(get.entryLine))), 'GET替代进度无效。');
    check(get === undefined || (get.phase === 'replacement' ? get.sourceId === undefined && get.entryLine === undefined : get.sourceId !== undefined && (get.phase === 'line' ? get.entryLine === undefined : get.entryLine !== undefined)), 'GET替代阶段字段不完整。');
    check(triggerBatch.effects === undefined || Array.isArray(triggerBatch.effects), '等待效果列表无效。');
    for (const task of triggerBatch.effects ?? []) { validateTask(task); check(task.player === triggerBatch.player, '生命效果归属错误。'); }
    // The batch itself says which scene it belongs to: an out-of-battle burn (「相手プレイヤーにNダメージ。」)
    // marks its batch, and the mark travels with it onto a frame when a colour trigger's own effect takes
    // the batch as its `resume` — so the frame's involvement cannot be the test.
    if (triggerBatch.outsideBattle) check(!state.battle, '战斗外伤害不能处于战斗中。');
    else check(state.phase === 'attack' && state.battle, '生命效果必须处于战斗中。');
  }
  const validateQueue = (queue: { effects: import('./types.ts').EffectTask[]; resume: string; defenderId?: string; damageCount?: number }, requireTasks: boolean): void => {
    // A *pending* queue with nothing left to resolve is a state the engine never means to be in. A
    // frame's queue is different: `resolveEffect` hands the remainder over when the last task starts,
    // and an empty remainder still carries `resume` — it is how `runEffects` knows to continue the
    // interrupted battle step once the ability finishes. Rejecting it made the command fail with
    // INVALID_STATE whenever a single queued ability paused for a question.
    check(Array.isArray(queue.effects) && (!requireTasks || queue.effects.length > 0), '能力队列不能为空。');
    check(['attackDeclare', 'block', 'compare', 'mainEnd', 'attackPhaseStart', 'attackPhaseStartOpponent', 'attackEnd', 'attackEndOpponent', 'unblockedDamage', 'battleWin', 'battleLose', 'none'].includes(queue.resume), '能力队列恢复点无效。');
    check(queue.defenderId === undefined || text(queue.defenderId), '能力队列指定对象无效。');
    check(queue.damageCount === undefined || integer(queue.damageCount), '能力队列伤害数无效。');
    for (const task of queue.effects) validateTask(task);
  };
  if (state.pending?.type === 'queue') validateQueue(state.pending, true);
  if (state.effect?.queue !== undefined) validateQueue(state.effect.queue, false);
  if (state.effect) {
    const f = state.effect;
    validateTask(f);
    check(f.sourceMovedTo === undefined || ['sideline', 'removal', 'hand'].includes(f.sourceMovedTo), '效果来源离场去向无效。');
    check(f.milledToSidelineIds === undefined || (Array.isArray(f.milledToSidelineIds) && new Set(f.milledToSidelineIds).size === f.milledToSidelineIds.length && f.milledToSidelineIds.every(id => text(id) && state.cards[id] !== undefined)), '效果堆牌记录无效。');
    check(integer(f.index) && f.index < f.steps.length && // Every stage `runEffects` can park on: `option` while a printed either/or is pending, `declare` while a printed number is being named, `take2` while a look's second pick is open, `mill`/`millCount` while an optional hidden-stack placement is being declined or confirmed or an up-to mill's count is being declared, `place` while a card is being put under a host.
      ['revealHandSubset', 'revealHandConfirm', 'deploymentBatch', 'recoverDiscarded', 'triggerEntryChoice', 'step', 'take', 'take2', 'takeGroup', 'takeMode', 'takeReplace', 'takeBase', 'raidLine', 'raidFullLine', 'takeRaidLine', 'takeRaidFullLine', 'takeDeployLine', 'takeDeployFullLine', 'takeUseLine', 'takeUseFullLine', 'lookOptional', 'actSourceOptional', 'revealOptional', 'revealHandPick', 'bottom', 'discard', 'topBottom', 'option', 'chooseAllMode', 'paidChooseUpgrade', 'declare', 'substitute', 'substituteCost', 'bpMinusSubstitute', 'mill', 'millCount', 'drawCount', 'moveFullLine', 'deployLine', 'deployFullLine', 'place', 'placeTopUnder', 'placeHost', 'deckChoice', 'placeTopRemoval', 'placeTopSideline', 'placeTopSidelineOpp', 'faceUpLife', 'faceUpTake', 'faceUpTopBottom', 'apCostSubstitute', 'grantPick', 'takeTopSideline'].includes(f.stage) && integer(f.taken) && Array.isArray(f.held), '效果进度无效。');
    if (f.stage === 'revealHandSubset' || f.stage === 'revealHandConfirm') {
      const step = f.steps[f.index];
      const shownPlayer = step?.type === 'revealHand' && step.player === 'opponent' ? (f.player === 0 ? 1 : 0) : f.player;
      check(step?.type === 'revealHand' && step.upTo === true && state.pending?.type === 'effect'
        && state.pending.player === (f.stage === 'revealHandSubset' ? shownPlayer : f.player)
        && state.pending.kind === (f.stage === 'revealHandSubset' ? 'cards' : 'option')
        && Array.isArray(f.selections?.__revealed)
        && (f.stage === 'revealHandSubset' ? f.selections.__revealed.length === 0
          : f.selections.__revealed.length > 0 && new Set(f.selections.__revealed).size === f.selections.__revealed.length
            && f.selections.__revealed.every(id => state.players[shownPlayer].hand.includes(id))), '选择性公开进度无效。');
    }
    if (f.deploymentBatch !== undefined) {
      const batch = f.deploymentBatch;
      check(record(batch) && onlyKeys(batch, ['phase', 'index', 'pools', 'plans', 'entered'])
        && f.stage === 'deploymentBatch' && f.steps[f.index]?.type === 'deployBatch'
        && ['pick', 'mode', 'base', 'line', 'space', 'move', 'moveSpace'].includes(batch.phase)
        && integer(batch.index) && Array.isArray(batch.pools) && batch.pools.every(pool => Array.isArray(pool) && pool.every(id => text(id) && state.cards[id]?.owner === f.player))
        && Array.isArray(batch.plans) && batch.plans.every(plan => record(plan) && onlyKeys(plan, ['id', 'mode', 'line', 'baseId'])
          && text(plan.id) && state.cards[plan.id]?.owner === f.player && ['deploy', 'raid'].includes(plan.mode)
          && (plan.line === undefined || plan.line === 'front' || plan.line === 'energy')
          && (plan.baseId === undefined || text(plan.baseId) && state.cards[plan.baseId]?.owner === f.player))
        && new Set(batch.plans.map(plan => plan.id)).size === batch.plans.length
        && new Set(batch.plans.filter(plan => plan.baseId !== undefined).map(plan => plan.baseId)).size === batch.plans.filter(plan => plan.baseId !== undefined).length
        && batch.index < (batch.phase === 'pick' ? batch.pools.length : batch.plans.length)
        && state.pending?.type === 'effect' && state.pending.kind === (['pick', 'base', 'space', 'moveSpace'].includes(batch.phase) ? 'cards' : 'option')
        && Array.isArray(batch.entered) && batch.entered.every(id => batch.plans.some(plan => plan.id === id)), '同时登场进度无效。');
    }
    check(f.stage !== 'deploymentBatch' || f.deploymentBatch !== undefined, '同时登场缺少进度。');
    check(f.playerDamage === undefined || integer(f.playerDamage, 1), '效果玩家伤害累计无效。');
    check(f.discardPrinted === undefined || integer(f.discardPrinted, 1), '效果弃牌下限记录无效。');
    check(f.acted === undefined || f.acted === true, '效果操作记录无效。');
    // A held card belongs to whoever owns it — an opponent-deck reveal (「相手は自身の山札の上から1枚を
    // 公開する」) holds the *opponent's* card while the placement is decided.
    for (const id of f.held) visit(id, state.cards[id]?.owner ?? f.player);
    if (f.selections?.__splitTopRest !== undefined) {
      const splitTopRest = f.selections.__splitTopRest;
      check(Array.isArray(splitTopRest) && splitTopRest.every(id => text(id) && f.held.includes(id))
        && new Set(splitTopRest).size === splitTopRest.length, '顶序寄存卡记录无效。');
    }
    if (f.eventCard) { visit(f.eventCard, f.player); check(state.catalog[state.cards[f.eventCard]!.definitionId]!.kind === 'event', '效果保留区必须为事件卡。'); }
    let parked = f.suspended;
    let nesting = 0;
    while (parked) {
      check(++nesting <= 50, '替代决策嵌套过深。');
      validateTask(parked);
      for (const id of parked.held) visit(id,state.cards[id]?.owner ?? parked.player);
      if (parked.eventCard) visit(parked.eventCard,parked.player);
      parked = parked.suspended;
    }
    // The decision normally belongs to the effect's controller, but 「自分の手札を1枚相手が選ぶ」 hands it
    // to the *opponent* on purpose — so the requirement is that it is one of the two players, and the
    // `choose` step that asked is what says which.
    check(state.pending?.type === 'effect' && (state.pending.player === 0 || state.pending.player === 1), '效果缺少对应决策。');
  }
  if (state.pending?.type === 'effect') {
    const p = state.pending;
    check(state.effect && text(p.choiceId) && text(p.prompt) && ['cards', 'ap', 'order', 'topBottom', 'option'].includes(p.kind) && integer(p.min) && integer(p.max) && p.min <= p.max && Array.isArray(p.options) && p.options.every(text) && p.max <= p.options.length && new Set(p.options).size === p.options.length, '效果选项无效。');
  }
  // A life trigger card whose effect is still resolving sits in no zone (Q73): its task owns it until the
  // frame closes and sends it to 場外. Once it is in a zone, the zone already holds it.
  for (const id of resolvingLife) if (!seen.has(id) && state.cards[id]) visit(id, state.cards[id]!.owner);
  check(Object.keys(state.cards).length === 100 && seen.size === 100 && count[0] === 50 && count[1] === 50, '实体卡不守恒：每名玩家必须正好 50 张。');
  if (state.departureChoices !== undefined) {
    for (const [cardId, destination] of Object.entries(state.departureChoices)) {
      check(Object.hasOwn(state.cards, cardId) && ['original', 'removal', 'top', 'pay'].includes(String(destination)), '离场替代回答记录无效。');
    }
  }
  if (state.departurePayChoices !== undefined) {
    for (const [cardId, picks] of Object.entries(state.departurePayChoices)) {
      check(Object.hasOwn(state.cards, cardId) && Array.isArray(picks) && picks.length > 0
        && picks.every(id => text(id) && Object.hasOwn(state.cards, id)) && new Set(picks).size === picks.length, '离场支付选卡记录无效。');
    }
  }
  check((state.status === 'finished') === (state.outcome !== null), '胜负与对局状态不一致。');
  if (state.status === 'finished') check(!state.pending && !state.battle, '结束后不能保留待处理决策。');
  if (state.status === 'setup') check(state.phase === 'setup' && state.pending?.type === 'mulligan' && state.turn === 0, '初始化状态无效。');
  if (state.status === 'playing') {
    check(state.phase !== 'setup' && state.turn > 0, '进行中状态无效。');
    // 「自分のライフエリアにあるカードを全て見てもよい。そうした場合、見たカードを望む順で自分のライフ
    // エリアに置く。」 — the look lifts the whole area into the frame while the ordering question is open, so
    // an empty area is legal exactly while the frame is holding those cards (`heldLifeFaceUp`).
    const lifeLifted = state.effect?.heldLifeFaceUp !== undefined;
    // 「はい、このカードの効果を処理した後に敗北します」(Q326/Q429) — while *any* resolution is still
    // open (an effect frame, however parked, or a decision/queue it raised), life=0 is a legitimate
    // intermediate; the defeat settles at the command's close (`settleLifeZero`), which finishes the
    // game as soon as nothing is pending. Without the pending/frame allowance an effect that zeroed a
    // life and then parked — for a choice, or for the attack-end watcher queue its battle raised —
    // left the state invalid, and every later command was refused at entry (round-104 FAM-A: seed
    // 1330's step-83 park on a queue pending).
    for (const p of state.players) check(p.life.length > 0 || state.pending !== null || state.effect !== undefined || triggerBatch || lifeLifted, '未结算生命归零。');
  }
  if (state.pending) check(state.pending.player === 0 || state.pending.player === 1, '决策玩家无效。');
  if (state.pending?.type === 'block') check(state.phase === 'attack' && state.battle, '战斗决策必须处于攻击阶段。');
  if (state.pending?.type === 'attackTarget') {
    const p = state.pending;
    check(state.phase === 'attack' && state.battle, '指定决策必须处于攻击阶段。');
    check(p.attackerId === state.battle!.attackerId && p.player === state.battle!.attacker, '指定决策的攻击者无效。');
    check(Array.isArray(p.candidates) && p.candidates.length > 0 && new Set(p.candidates).size === p.candidates.length, '指定候选无效。');
    for (const id of p.candidates) check(state.players[state.battle!.defender].front.some(slot => slot.cardId === id), '指定候选必须在对方前线。');
    check(p.declared === undefined || (text(p.declared) && Object.hasOwn(state.cards, p.declared)), '指定预先声明无效。');
  }
  if (state.pending?.type === 'damage' || state.pending?.type === 'triggers') {
    // 「相手プレイヤーにNダメージ。」 is the one damage that resolves with no battle open; everything
    // else in this family is a battle decision and has to be inside one.
    if (state.pending.outsideBattle) check(!state.battle, '战斗外伤害不能处于战斗中。');
    else check(state.phase === 'attack' && state.battle, '战斗决策必须处于攻击阶段。');
  }
  if (state.pending?.type === 'discard') {
    // The end-phase count is measured against the *current* ceiling (`handLimit` statics), not the
    // rulebook's 8: HTR-1-026 raises it to 15 and the pending count is `hand.length - limit`.
    const limit = handLimitOf(state, state.pending.player);
    check(state.phase === 'end' && state.pending.count === state.players[state.pending.player].hand.length - limit, '弃牌数量错误。');
  }
  if (state.pending?.type === 'energyOverflow') {
    const p = state.pending;
    check(state.phase === 'attack' && state.battle !== null, '腾位决策必须处于战斗中。');
    check(Array.isArray(p.cards) && p.cards.length > 0 && new Set(p.cards).size === p.cards.length, '腾位候选无效。');
    check(text(p.defenderId) && Object.hasOwn(state.cards, p.defenderId), '腾位败者记录无效。');
    for (const id of p.cards) check(state.players[p.defender].energy.some(slot => slot.cardId === id), '腾位候选必须在该エナジーL上。');
  }
  if (state.pending?.type === 'selectionTaxHand') {
    const p = state.pending;
    const hand = state.players[p.player].hand;
    check(integer(p.count, 1) && p.count <= hand.length, '选择税手牌数量无效。');
    check(Array.isArray(p.cards) && p.cards.length === hand.length && new Set(p.cards).size === p.cards.length
      && p.cards.every(id => text(id) && hand.includes(id)), '选择税手牌候选无效。');
    check(p.triggers.type === 'triggers' && p.triggers.player === p.player && Array.isArray(p.triggers.cards)
      && p.triggers.cards.length > 0, '选择税的生命批次无效。');
    check(p.resume.type === 'resolveTrigger' && p.resume.activate === true && text(p.resume.targetId)
      && p.triggers.cards.includes(p.resume.cardId), '选择税续接命令无效。');
  }
}
