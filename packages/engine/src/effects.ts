import type {
  CardDefinition, CardEffect, CardFilter, CardId, CardOperation, Condition, Duration, EffectDecision, EffectFrame, EffectTask,
  Energy, FieldCard, GameState, Keywords, PlayerId, PlayerScope, QueueResume, StaticModifier, TierCount, TriggerDecision, TriggeredAbility, ZoneId,
} from './types.ts';
import { addToLife, applyQueueResume, clearTemporaryFieldState, executeResumedCommand, checkBP, clearEnteredDiscounts, collectHiddenWatchers, collectTriggered, prepareEntryEffects, settleLimitBudgets, currentApCostOf, damagePlayer, draw, endBattle, energySatisfied, expireWhileSourceGrants, faceUpTop, findField, finish, getBP, getDamage, getDefinition, getEnergy, getKeywords, hasApCostTag, leaveField, lifeIsFaceUp, logTurnEvent, noteDeckToSideline, noteDeckTop, queueRaided, raidBaseEligible, removeFromLife, requiredEnergyOf, sidelineUseDiscount, spendSidelineUseDiscount } from './engine.ts';
import type { Context } from './engine.ts';
import { activeStatics, allCharsNoRetireByEffect, answersKind, choseCardThisTurn, currentBP, deployForbidden, effectiveNames, effectiveRequiredEnergy, effectiveRequiredEnergyVariants, effectsSuppressed, energyRunHolds, enteredThisTurn, evalCondition, eventCardRewritesToCharacter, fieldStatics, frontMoveForbidden, handStaticsOf, lineCapacity, locate, matchesEventCard, otherOf, ownStaticsOf, peekDefinition, persistentEnergyCostModifiers, playerStatics, printedEnergyTotal, printsAbility, refusesBpMinusFrom, refusesHandReturn, refusesOpponentRemoval, refusesRest, refusesRetire, removalRedirectsToSideline, restedByEffectThisTurn, retiredRequiredEnergyTotal, revealedBpOf, selectBpRangeBonus, selectableOnlyByFilters, sidelineAsEventTreated, sidelineRedirectsToRemoval, spendReplacementUse, staticEnterActive, staticForbids, staticImmunity, staticProtection, staticSelectionTax, tierCountOf, treatedAsAllColors, type SelectionTax } from './conditions.ts';
import { hasTrait } from './traits.ts';
import { ANY_COUNT } from './types.ts';
import { randomPick } from './random.ts';
import { logEvent, syncLedger, visibility } from './log-ledger.ts';
import { COLORS, requireRule } from './validation.ts';

const fields = (s: GameState, p: PlayerId) => [...s.players[p].front, ...s.players[p].energy];
/** A card's current BP wherever it is (the field slot's modifiers, else its printed value). */
function bpOfCard(s: GameState, id: CardId): number | undefined {
  const owner = s.cards[id]?.owner;
  if (owner === undefined) return undefined;
  const here = findField(s, owner, id)?.card;
  return here ? getBP(s, here) : peekDefinition(s, id)?.bp;
}
/** The operations that take a card off the field — what 「場を離れない」 has anything to say about. */
const LEAVES_FIELD: ReadonlySet<CardOperation> = new Set<CardOperation>(['return', 'retire', 'remove', 'toDeckTop', 'toDeckBottom', 'toLife', 'raidTopToHand', 'topToSideline', 'toDeckTopOrBottom', 'topToDeckBottom', 'topToDeckTop']);
/**
 * The `TierCount` sources the *resolving frame* answers (the cases `tierCount` handles before its
 * `tierCountOf` fallback): this effect's own resting/retirement/removal/discard records and the cards a
 * binding holds. `matchesFilter`'s state-only `bpCeiling` reader answers 0 for these, so the `select`
 * step folds their ceiling into a plain `maxBP` itself (BLC-4-008 / RNK-1-044).
 */
const FRAME_TIER_SOURCES: ReadonlySet<TierCount['source']> = new Set<TierCount['source']>([
  'restedEnergySum', 'removedByThisEffect', 'retiredByThisEffect', 'discardedEnergySum', 'retiredEnergySum',
  'restedByThisEffect', 'discardedByThisEffect', 'selectedCount', 'selectedDamageBonus', 'boundPrintedEnergy', 'revealedTraitNames', 'perUnit', 'gated',
  // `gated` joins the set as a *conditional* frame source: the gate's inner count may itself be one of
  // the frame-scoped readings above (「自分の場に〈珊瑚〉がある場合、この効果で…置いたカード1枚につき」
  // — IYS-1-071), which the state-only reader behind `matchesFilter` answers 0 for.
]);
export const fieldIdentity = (f: FieldCard) => f.instanceId ?? f.cardId;
const source = (s: GameState, f: EffectTask) => {
  const c = findField(s, f.player, f.sourceId)?.card;
  return c && fieldIdentity(c) === f.sourceInstance ? c : undefined;
};
export const scopePlayer = (viewer: PlayerId, who: PlayerScope): PlayerId => (who === 'self' ? viewer : otherOf(viewer));

/**
 * The quantity `CardFilter.bound` measures on one card.
 *
 * `bp` is the *current* BP where the card has a slot and its printed BP where it does not — the same
 * value `maxBP` reads — so a bound and a fixed BP bound never disagree about the same character.
 * `requiredEnergy` is the printed total and `apCost` the printed cost, neither of which the board edits.
 */
function boundStatOf(s: GameState, id: CardId, slot: FieldCard | undefined, stat: 'bp' | 'requiredEnergy' | 'apCost'): number {
  const definition = peekDefinition(s, id);
  if (!definition) return 0;
  if (stat === 'apCost') return definition.apCost;
  if (stat === 'requiredEnergy') return Object.values(definition.requiredEnergy).reduce((total, n) => total + (n ?? 0), 0);
  return slot ? getBP(s, slot) : definition.bp ?? 0;
}

/**
 * Records an effect's picks for the turn (「このターン中に…の効果で選ばれている」) and raises the
 * 「…の効果で選ばれた時」 watcher.
 *
 * Every selection is recorded, not only the ones a `excludeChosenThisTurn` reads back: the qualified
 * spellings ask about *any* of the chooser's effects (「[特徴：日輪刀]の効果で選ばれているキャラ」), and a
 * watcher on the chosen card answers whenever it happens.
 */
function recordChosen(ctx: Context, f: EffectFrame, ids: CardId[]): void {
  if (!ids.length) return;
  const s = ctx.state;
  const p = s.players[f.player];
  p.chosenByEffectThisTurn = { ...(p.chosenByEffectThisTurn ?? {}), [f.sourceId]: [...(p.chosenByEffectThisTurn?.[f.sourceId] ?? []), ...ids] };
  // 「このキャラが自分の[特徴：X]の効果で選ばれた時」 — one moment per chosen card; the choosing effect
  // finishes resolving first, the way every effect-raised moment does.
  for (const id of new Set(ids)) {
    ctx.queue.push(...collectTriggered(ctx, s.cards[id]?.owner ?? f.player, 'onChosenByEffect', id, id, { causeId: f.sourceId }));
  }
}

/**
 * Whether the operation being applied comes from the *opponent's character effect* — the route the
 * routed BP-minus immunity (AOT-2-028) names. Read off the resolving frame's own source card: it must
 * belong to the other player and be a character (an event card's or a trigger's effect is a different
 * route the print excludes).
 */
function enemyCharacterEffect(s: GameState, f: EffectFrame, targetOwner: PlayerId): boolean {
  if (f.sourceId === undefined) return false;
  const causeOwner = s.cards[f.sourceId]?.owner;
  if (causeOwner === undefined || causeOwner === targetOwner) return false;
  return peekDefinition(s, f.sourceId)?.kind === 'character';
}

/**
 * Raises the declared `maxEnergy` of a filter — and of its `anyOf` branches, which `matchesFilter`
 * reads beside the enclosing fields — by `raise`. 「…1種類につき、この効果で登場させるキャラの必要
 * エナジーの範囲+1。」 (BLC-4-056, 0095): only nodes that declare a ceiling move, so colour / AP /
 * identity gates and branch nodes without a declared ceiling stay exactly as printed (a shallow copy
 * left the branch ceilings at 0 and refused the very cards the raise opened — 抽检002-SR-R
 * B-BLC-4-056-RANGE).
 */
function raiseMaxEnergy(filter: CardFilter, raise: number): CardFilter {
  return {
    ...filter,
    ...(filter.maxEnergy !== undefined ? { maxEnergy: filter.maxEnergy + raise } : {}),
    ...(filter.anyOf ? { anyOf: filter.anyOf.map(branch => raiseMaxEnergy(branch, raise)) } : {}),
  };
}

export function matchesFilter(s: GameState, id: CardId, filter: CardFilter = {}, sourceId?: CardId, declared?: EffectFrame['declared'], heldFromDeck = false): boolean {
  const d = peekDefinition(s, id);
  if (!d) return false;
  // 「〈A〉かカード名に「B」を含むキャラ」 — any one alternative is enough; the remaining fields of the
  // enclosing filter still apply on top of it.
  if (filter.anyOf?.length && !filter.anyOf.some(sub => matchesFilter(s, id, sub, sourceId, declared, heldFromDeck))) return false;
  const owner = s.cards[id]!.owner;
  const here = locate(s, owner, id);
  const field = here ? s.players[owner][here.line].find(c => c.cardId === id)! : undefined;
  // The required-energy signature *as read* for the colour gates and the 「指定した数」 equality below;
  // the min/max bounds read the dual variants instead (「…としても扱う」 keeps the printed reading
  // beside the alternate one — Q805–Q809 / Q1126, see `effectiveRequiredEnergyVariants`).
  const requiredEnergy = effectiveRequiredEnergy(s, id);
  const energyTotal = Object.values(requiredEnergy).reduce((a, b) => a + (b ?? 0), 0);
  // Q486: unqualified aliases also apply in hand/sideline; scoped name modifiers keep their own
  // conditions. Use the shared narrowed reader for aliases, exclusions and full name replacement.
  const names = effectiveNames(s, id, owner);
  // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — while the candidate sits in
  // 場外 under a carrier that prints the treatment, it answers event-card filters. 「…の効果に記載されて
  // いる「イベントカード」を「イベントカードかキャラカード」に代えてもよい。」 (OPM-P-001) is the
  // mirror: an event-card subject *in the named cards' own effects* also admits character cards.
  // 「このカードは全ての場所でイベントカードとしても扱う」 (Q1295/Q1298) — a printed `alsoKinds`
  // answers the kind gate everywhere the card is read, so a filter for either kind admits it.
  if (filter.kind && !answersKind(d, filter.kind)
    && !(filter.kind === 'event' && (sidelineAsEventTreated(s, id) || (d.kind === 'character' && eventCardRewritesToCharacter(s, sourceId))))) return false;
  if (filter.color && !Object.hasOwn(requiredEnergy, filter.color) && !treatedAsAllColors(s, id)) return false;
  if (filter.trait && !hasTrait(d, filter.trait)) return false;
  // 「［特徴：X］以外の」 — an exclusion, so a card carrying X fails even if it carries the included trait
  // as well.
  if (filter.notTrait && hasTrait(d, filter.notTrait)) return false;
  if (filter.notColor && (Object.hasOwn(requiredEnergy, filter.notColor) || treatedAsAllColors(s, id))) return false;
  if (filter.name && !names.includes(filter.name)) return false;
  if (filter.names && !filter.names.some(n => names.includes(n))) return false;
  if (filter.notNames?.length && names.some(n => filter.notNames!.includes(n))) return false;
  if (filter.nameNotInOwnField) {
    const controller = sourceId !== undefined ? s.cards[sourceId]?.owner ?? s.activePlayer : s.activePlayer;
    const fieldNames = new Set<string>();
    for (const slot of [...s.players[controller].front, ...s.players[controller].energy]) {
      for (const name of effectiveNames(s, slot.cardId, controller)) fieldNames.add(name);
    }
    if (names.some(name => fieldNames.has(name))) return false;
  }
  if (filter.nameContains) { const fragment = filter.nameContains; if (!names.some(n => n.includes(fragment))) return false; }
  // 「カード名にこの効果で指定したものを含む」 (NGR-P-003) — the name announced earlier in the effect.
  if (filter.nameContainsDeclared !== undefined) {
    const wanted = declared?.name;
    const holds = wanted !== undefined && names.some(n => n.includes(wanted));
    if (holds !== filter.nameContainsDeclared) return false;
  }
  if (filter.notNameContains) { const fragment = filter.notNameContains; if (names.some(n => n.includes(fragment))) return false; }
  // 「必要エナジーが N 以下 / N 以上」 — 「…としても扱う」 is a dual reading (Q805–Q809 / Q1126:
  // 「元々の必要エナジーの数と…のどちらとしても扱う」), so a card passes when **one** of its readings
  // satisfies both ends at once (a bound pair asks one reading's question, not one end per reading). Every
  // other filter field above and below stays an AND on top. Counts and the 「指定した数」 equality keep the
  // single `effectiveRequiredEnergy` value (the round's G-scope).
  if (filter.maxEnergy !== undefined || filter.minEnergy !== undefined) {
    const inRange = filter.energyBasis === 'printed'
      ? (() => {
        const total = printedEnergyTotal(d);
        return (filter.maxEnergy === undefined || total <= filter.maxEnergy)
          && (filter.minEnergy === undefined || total >= filter.minEnergy);
      })()
      : effectiveRequiredEnergyVariants(s, id, owner).some(energy => {
        const total = Object.values(energy).reduce((a, b) => a + (b ?? 0), 0);
        if (filter.maxEnergy !== undefined && total > filter.maxEnergy) return false;
        if (filter.minEnergy !== undefined && total < filter.minEnergy) return false;
        return true;
      });
    if (!inRange) return false;
  }
  // 「発生エナジーが1以下」 — what the card *produces*, read from the printed generation (the same value
  // the energy line shows for an unmodified, active card). The requirement bounds above are a different
  // number, so a subject printing both must not be read through one of them. 「元々の発生エナジーが2以上」
  // (MST-1-062) is the lower bound of the same axis, read from the same sum.
  if (filter.maxGeneratedEnergy !== undefined || filter.minGeneratedEnergy !== undefined) {
    const produced = Object.values(d.generatedEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
    if (filter.maxGeneratedEnergy !== undefined && produced > filter.maxGeneratedEnergy) return false;
    if (filter.minGeneratedEnergy !== undefined && produced < filter.minGeneratedEnergy) return false;
  }
  if (filter.maxBP !== undefined && (field ? getBP(s, field) : d.bp ?? Infinity) > filter.maxBP) return false;
  if (filter.minBP !== undefined && (field ? getBP(s, field) : d.bp ?? -Infinity) < filter.minBP) return false;
  // 「元々のBPよりBPが低い/高い…キャラ」 (KGR-1-011) — the candidate's *current* BP against its own
  // printed one, the same relation `Condition.fieldCount.bpBelowPrinted` reads (equal BP satisfies
  // neither, the two comparing strictly on opposite sides).
  if (filter.bpBelowPrinted === true && currentBP(s, id, owner) >= (d.bp ?? 0)) return false;
  if (filter.bpAbovePrinted === true && currentBP(s, id, owner) <= (d.bp ?? 0)) return false;
  // 「…レストにしないとこのカードは使用できない」 (JJK-1-063, Q1244) — the payer must be restable by
  // this effect, the same gate the `act rest` payment applies at execution (ownEffect=true, cause =
  // the effect source). Without it the selection offers a locked card and the payment is silently
  // refused while the use itself still resolves.
  if (filter.restable === true && refusesRest(s, id, owner, true, sourceId)) return false;
  // 「消費APがN…」 (Q1122) — the price the card would *currently* cost: a hand card's own-scope reductions
  // (花海咲季's static taking 月村手毬 to 1) are the number the print filters on. The use-route terms
  // (「次に使用する」 discounts, a useTarget declaration) stay out — they belong to a use, not to the card.
  if (filter.maxApCost !== undefined && currentApCostOf(s, id) > filter.maxApCost) return false;
  if (filter.minApCost !== undefined && currentApCostOf(s, id) < filter.minApCost) return false;
  // 「元々の消費AP」 reads the printed price, the AP sibling of the `printedBP` block above.
  if (filter.printedApCost) {
    if (filter.printedApCost.min !== undefined && d.apCost < filter.printedApCost.min) return false;
    if (filter.printedApCost.max !== undefined && d.apCost > filter.printedApCost.max) return false;
  }
  if (filter.raid !== undefined && ((field?.underneath.length ?? 0) > 0) !== filter.raid) return false;
  // 「レイド元が〈X〉のキャラ」 — the card the stack sits on (`underneath[0]`), read through the same
  // `effectiveNames` every other 〈X〉 test uses so aliases count here too. A card not in raid state has
  // no base and matches nothing.
  if (filter.raidUnderName !== undefined || filter.raidUnderNames !== undefined) {
    const baseId = field?.underneath.at(-1);
    const baseNames = baseId === undefined ? [] : effectiveNames(s, baseId, owner);
    if (filter.raidUnderName !== undefined && !baseNames.includes(filter.raidUnderName)) return false;
    if (filter.raidUnderNames !== undefined && !filter.raidUnderNames.some(n => baseNames.includes(n))) return false;
  }
  // 「このターン中にレイドしたキャラと同じカード名のカード」 — the exclusion reads the turn log's raid
  // entries: a raider may since have left the field, so the names have to come off the log.
  if (filter.notRaidedNameThisTurn) {
    const raided = new Set<string>();
    for (const entry of s.turnEvents ?? []) {
      if (entry.event !== 'entered' || !entry.raid || entry.cardId === undefined) continue;
      const raiderOwner = s.cards[entry.cardId]?.owner;
      if (raiderOwner === undefined) continue;
      for (const n of effectiveNames(s, entry.cardId, raiderOwner)) raided.add(n);
    }
    if (names.some(n => raided.has(n))) return false;
  }
  // 「このターン中に自分の効果でアクティブからレストになったことがある」 — a log fact, not a slot state.
  if (filter.restedByEffectThisTurn && !restedByEffectThisTurn(s, id, sourceId !== undefined ? s.cards[sourceId]?.owner : undefined)) return false;
  // 「このターン中に登場した」 — the same log-fact reading off the entry records (NIK-1-077, CGH-1-094).
  if (filter.enteredThisTurn && !enteredThisTurn(s, id)) return false;
  // 「このターン中に(自分の)[特徴：X]の効果で選ばれている…」 — the candidate against the choosing
  // players' selection records. `own` reads only the effect controller's (the printed 「自分の」); its
  // absence reads either side, the way the unowned print does.
  if (filter.chosenByEffectThisTurn) {
    const q = filter.chosenByEffectThisTurn;
    const controllers: PlayerId[] = q.own || sourceId === undefined
      ? [sourceId === undefined ? s.activePlayer : s.cards[sourceId]?.owner ?? s.activePlayer]
      : [s.cards[sourceId]?.owner ?? s.activePlayer, otherOf(s.cards[sourceId]?.owner ?? s.activePlayer)];
    if (!controllers.some(owner => choseCardThisTurn(s, owner, {
      cardId: id,
      ...(q.trait !== undefined ? { trait: q.trait } : {}),
      ...(q.name !== undefined ? { name: q.name } : {}),
      ...(q.names !== undefined ? { names: q.names } : {}),
    }))) return false;
  }
  // 「このキャラのBPよりBPがN以上低い」 — the candidate against the effect *source*'s current BP. The
  // source may already have left the field (a 「退場時」 ability), where its printed BP is the honest read.
  if (filter.bpBelowSource !== undefined || filter.bpBelowSourceRate !== undefined || filter.sameBpAsSource === true) {
    const sourceOwner = sourceId === undefined ? undefined : s.cards[sourceId]?.owner;
    const sourceField = sourceId !== undefined && sourceOwner !== undefined ? findField(s, sourceOwner, sourceId)?.card : undefined;
    const sourceBp = sourceField ? getBP(s, sourceField) : (sourceId !== undefined ? peekDefinition(s, sourceId)?.bp ?? 0 : 0);
    const candidateBp = field ? getBP(s, field) : d.bp ?? 0;
    // 「このキャラと同じBPの…」 — equality against the *effect source's* current BP, the sibling of the
    // 「…よりBPがN以上低い」 relation above; both sides are board values read where both cards exist.
    if (filter.sameBpAsSource === true && candidateBp !== sourceBp) return false;
    if (filter.bpBelowSource !== undefined && candidateBp > sourceBp - filter.bpBelowSource) return false;
    // 「BPがこのキャラのBPの半分以下」 — the fractional sibling: the same source BP, scaled (Q810 reads
    // the source's current value, buffs included). BP is printed in multiples of 500, but 半分 is floored
    // so a 2500 source still admits its 1000s rather than a fractional candidate.
    if (filter.bpBelowSourceRate !== undefined && candidateBp > Math.floor(sourceBp * filter.bpBelowSourceRate)) return false;
  }
  if (filter.underCount) {
    // The hidden stack, not the raid base: `raid` above reads `underneath`, this reads `faceDown`.
    const hidden = field?.faceDown?.length ?? 0;
    if (filter.underCount.min !== undefined && hidden < filter.underCount.min) return false;
    if (filter.underCount.max !== undefined && hidden > filter.underCount.max) return false;
  }
  // 「元々のBP」 reads the printed value, so modifiers on the field card are deliberately ignored.
  if (filter.printedBP) {
    const printed = d.bp;
    if (printed === undefined) return false;
    if (filter.printedBP.min !== undefined && printed < filter.printedBP.min) return false;
    if (filter.printedBP.max !== undefined && printed > filter.printedBP.max) return false;
  }
  // 「必要エナジーを満たし」 — the *owner's* produced energy covers the card's requirement (after its own
  // hand-scope reductions). A board fact, not a bound on the printed symbols.
  if (filter.energySatisfied) {
    const produced = getEnergy(s, owner);
    const required = requiredEnergyOf(s, id);
    if (!COLORS.every(color => (produced[color] ?? 0) >= (required[color] ?? 0))) return false;
  }
  if (filter.other && id === sourceId) return false;
  if (filter.self && id !== sourceId) return false;
  // A union branch's own line and side (「相手のフロントLのキャラか自分の場の…」): the enclosing `select`
  // names both zones, and each branch settles which of them it may match.
  if (filter.zone !== undefined && here?.line !== filter.zone) return false;
  if (filter.side !== undefined) {
    const sourceOwner = sourceId === undefined ? undefined : s.cards[sourceId]?.owner;
    if (sourceOwner === undefined) return false;
    if ((owner === sourceOwner) !== (filter.side === 'self')) return false;
  }
  // 「このキャラと別のラインにある…」 — a relation to the *source's* slot, so both cards must have one:
  // a source that has left the field, or a candidate held outside a line, cannot be compared.
  if (filter.differentLine) {
    const sourceLine = sourceId === undefined ? undefined : locate(s, s.cards[sourceId]?.owner ?? owner, sourceId)?.line;
    if (!sourceLine || !here || here.line === sourceLine) return false;
  }
  // 「同じラインの…」 — the mirror relation. A source with no line (it left the field) matches nothing,
  // which is the honest reading: the line it was on is gone.
  if (filter.sameLine) {
    const sourceLine = sourceId === undefined ? undefined : locate(s, s.cards[sourceId]?.owner ?? owner, sourceId)?.line;
    if (!sourceLine || !here || here.line !== sourceLine) return false;
  }
  if (filter.active !== undefined && field?.active !== filter.active) return false;
  if (filter.rested !== undefined && field?.active === filter.rested) return false;
  // 「「次の1回アクティブにならない」キャラ」 (SLG-1-058/060) — a character holding an activation charge,
  // the state the rest and battle-loser instructions write (`FieldCard.cannotActivateCharges`).
  if (filter.skipsNextReady !== undefined && ((field?.cannotActivateCharges ?? 0) > 0) !== filter.skipsNextReady) return false;
  // 「自分の場のキャラの最大BP以下の…」 — a bound measured over *other* cards, so neither side is
  // knowable at compile time. The pool belongs to the effect *controller*, which only `sourceId`
  // identifies: the candidate's own owner says nothing about whose field the maximum came off, so
  // without a source there is no pool and nothing can satisfy the bound.
  if (filter.bound) {
    const bound = filter.bound;
    const sourceOwner = sourceId === undefined ? undefined : s.cards[sourceId]?.owner;
    if (sourceOwner === undefined) return false;
    const poolOwner = scopePlayer(sourceOwner, bound.who);
    // The printed pool is always 「…のキャラ」 (the compiler refuses any other subject), so a non-character
    // on a line — a フィールド card in the energy line — takes no part in the measurement: it has no BP,
    // and reading one as 0 would drag a `min` bound down (round-40 audit B4).
    const isCharacter = (id: CardId): boolean => peekDefinition(s, id)?.kind === 'character';
    const pool = bound.zone === 'sideline'
      ? s.players[poolOwner].sideline.filter(isCharacter).map(member => ({ id: member, slot: undefined }))
      : [...s.players[poolOwner].front, ...s.players[poolOwner].energy].filter(slot => isCharacter(slot.cardId)).map(slot => ({ id: slot.cardId, slot }));
    const values = pool.filter(member => !(bound.other && member.id === sourceId))
      .map(member => boundStatOf(s, member.id, member.slot, bound.stat));
    // An empty pool has no maximum (「自分の場の他のキャラ」 with no other character), and a bound with
    // no value to compare against admits nothing — the printed instruction then does nothing.
    if (!values.length) return false;
    const limit = bound.extreme === 'max' ? Math.max(...values) : Math.min(...values);
    const mine = boundStatOf(s, id, field, bound.stat);
    const above = bound.exclusive ? mine >= limit : mine > limit;
    const below = bound.exclusive ? mine <= limit : mine < limit;
    if (bound.extreme === 'max' ? above : below) return false;
  }
  // 「自分の場の〈X〉の枚数×1000以下のBPの…」 — the ceiling is a *board count* times its printed factor.
  // The count belongs to the effect controller, which only `sourceId` identifies (`bound`'s rule above).
  // A printed `base` is the floor the count scales from (「『BP1000』以下の…。…1枚につき、『BP+1000』される」).
  if (filter.bpCeiling) {
    const sourceOwner = sourceId === undefined ? undefined : s.cards[sourceId]?.owner;
    if (sourceId === undefined || sourceOwner === undefined) return false;
    const ceiling = (filter.bpCeiling.base ?? 0) + tierCountOf(s, sourceOwner, sourceId, filter.bpCeiling.count) * filter.bpCeiling.per;
    const bp = field ? getBP(s, field) : d.bp ?? 0;
    if (bp > ceiling) return false;
  }
  // 「この効果で指定した数と同じ必要エナジー」 — the bound lives on the frame, not in the filter, because
  // the player picks the number while the effect resolves.
  if (filter.energyEqualsDeclared && declared?.energyCount !== energyTotal) return false;
  if (filter.hasEffect !== undefined) {
    const has = d.onPlay !== undefined || d.onRaid !== undefined || d.activated !== undefined || d.static !== undefined || d.triggered !== undefined;
    if (has !== filter.hasEffect) return false;
  }
  // 「[起動メイン]を持つ」 — the printed activated ability alone (the same read `raidAbility` makes of the
  // printed RAID).
  if (filter.hasActivated !== undefined && (d.activated !== undefined) !== filter.hasActivated) return false;
  const triggerlessInZone = d.noTriggerInHandDeck === true
    && (heldFromDeck || s.players[owner].hand.includes(id) || s.players[owner].deck.includes(id));
  if (filter.hasTrigger !== undefined && (d.trigger !== undefined && !triggerlessInZone) !== filter.hasTrigger) return false;
  // 「[ドロートリガー]を持つ」 — the kind of printed trigger, beside the existence check above.
  if (filter.triggerType !== undefined && (!triggerlessInZone && d.trigger?.type !== filter.triggerType)) return false;
  // 「…をどちらも持たない」 (CSM-1-024) — the exclusion counterpart; a triggerless card satisfies it.
  if (filter.notTriggerType?.length && !triggerlessInZone && d.trigger !== undefined && filter.notTriggerType.includes(d.trigger.type)) return false;
  // 「[レイド]を持つ」 — the printed RAID ability, not the slot's stack state (`filter.raid`).
  if (filter.raidAbility !== undefined && (d.raid !== undefined) !== filter.raidAbility) return false;
  // 「このターン中にアタックした…」 (SYN-P-002) — the candidate attacked earlier this turn.
  if (filter.attackedThisTurn !== undefined
    && (s.turnEvents ?? []).some(entry => entry.event === 'attacked' && entry.cardId === id) !== filter.attackedThisTurn) return false;
  // 「[アタック時]/[ブロック時]を持つ」 — the printed triggered ability, read exactly as the condition
  // readers read it (`triggered` entries carrying the event; a fence-internal one only while raided).
  if (filter.attackAbility !== undefined && (printsAbility(d, 'onAttack', s, id) !== filter.attackAbility)) return false;
  if (filter.blockAbility !== undefined && (printsAbility(d, 'onBlock', s, id) !== filter.blockAbility)) return false;
  // 「[K]を持つキャラ」 — a game keyword the candidate must currently have. Read from the merged keyword
  // set (printed, granted by statics, and this-turn keyword modifiers), the same read every keyword test
  // uses, so a filter can never disagree with what the board says the card has.
  if (filter.hasKeyword !== undefined && !getKeywords(s, id)[filter.hasKeyword]) return false;
  // 「指定した特徴を持つ…」 — the trait the resolving effect declared earlier (「…特徴を1つ指定する」),
  // read back from the frame like `energyEqualsDeclared` reads its number.
  if (filter.traitEqualsDeclared && (declared?.trait === undefined || !hasTrait(d, declared.trait))) return false;
  // 「特徴を持たない」 — no printed traits at all. Distinct from `notTrait`, which excludes one trait and
  // admits every other card, traits or none.
  if (filter.noTraits && (d.traits?.length ?? 0) > 0) return false;
  // 「「X」以外の特徴」 — a trait other than the named one. A card with no traits does not match.
  if (filter.traitOtherThan !== undefined && !(d.traits ?? []).some(trait => trait !== filter.traitOtherThan)) return false;
  return true;
}

function zoneIds(s: GameState, player: PlayerId, zone: ZoneId, sourceId: CardId, raidBase?: CardId[], battleBlocker?: CardId): CardId[] {
  switch (zone) {
    case 'ownFront': case 'enemyFront': return s.players[player].front.map(c => c.cardId);
    case 'ownEnergy': case 'enemyEnergy': return s.players[player].energy.map(c => c.cardId);
    case 'ownField': case 'enemyField': return fields(s, player).map(c => c.cardId);
    case 'ownHand': case 'enemyHand': return [...s.players[player].hand];
    case 'ownSideline': case 'enemySideline': return [...s.players[player].sideline];
    case 'ownRemoval': case 'enemyRemoval': return [...s.players[player].removal];
    case 'ownDeck': case 'enemyDeck': return [...s.players[player].deck];
    case 'ownLife': case 'enemyLife': return [...s.players[player].life];
    case 'ownAp': case 'enemyAp': return s.players[player].ap.flatMap((a, i) => (a === 'inactive' ? [] : [`ap:${i}`]));
    case 'ownUnder': {
      const here = findField(s, player, sourceId);
      return [...(here?.card.faceDown ?? [])];
    }
    case 'ownUnderAll': {
      // Every face-down card under the controller's characters, in line order — 「自分の場のキャラの下の
      // 裏向きのカード」 does not single out one host.
      const out: CardId[] = [];
      for (const line of ['front', 'energy'] as const) {
        for (const card of s.players[player][line]) out.push(...(card.faceDown ?? []));
      }
      return out;
    }
    case 'ownRaidUnder': {
      const here = findField(s, player, sourceId);
      if (here) return [...here.card.underneath];
      // A 「[退場時]」 ability resolves from 場外 with its base already beside it; the snapshot the
      // retirement took is what 「このキャラのレイド元のカード」 names there. Only ids still *in* the
      // sideline are offered — a base an earlier instruction already returned is gone from this pile.
      return (raidBase ?? []).filter(id => s.players[player].sideline.includes(id));
    }
    case 'ownRaidBottom': {
      // 「レイド状態のこのキャラの一番下のカード」 — the *deepest* card alone, read exactly where
      // `ownRaidUnder` reads its whole stack (the live stack, or the retirement snapshot from 場外).
      const here = findField(s, player, sourceId);
      const stack = here
        ? [...here.card.underneath]
        : (raidBase ?? []).filter(id => s.players[player].sideline.includes(id));
      return stack.length ? [stack[stack.length - 1]!] : [];
    }
    case 'eventRaidUnder': {
      // 「そのキャラのレイド元のカード」 (MCR-2-017/073) — the *event card's* raid base, read from the
      // snapshot the retirement handed to the watcher (`EffectTask.raidBase`). The source's own stack is
      // a different pile and must not answer here: the printed subject is the card that retired.
      return (raidBase ?? []).filter(id => s.players[player].sideline.includes(id));
    }
    case 'blocker': {
      // 「このキャラをブロックしたキャラ」 (KMR-2-083) — a determinate card rather than a pool. The id
      // rides on the task (`battleBlocker`), snapshotted by the raising site because `endBattle` clears
      // the open battle before the queue it raised runs. Only ids still on the field are offered.
      const blockerId = battleBlocker ?? s.battle?.blockerId;
      if (blockerId === undefined) return [];
      const owner = s.cards[blockerId]?.owner;
      return owner !== undefined && findField(s, owner, blockerId) ? [blockerId] : [];
    }
  }
}

/**
 * The memory key a `chooseOption`'s printed per-turn budget writes and reads.
 *
 * Three spellings share the one memory (`PlayerState.chosenOptionsThisTurn`): a printed card name
 * (「〈X〉が既に選んだ効果は選べない」), the resolving card itself (「既に選んだ**このキャラ**の効果は
 * 選べない」 → `'@source'`), and the resolving card's *number* (「同じカードナンバーの〈X〉が既に選んだ
 * 効果は選べない」 → `'@number:…'`, so every copy of the print shares the budget). The `@number` form is
 * emitted only where the printed name is the ability's own card — the corpus has exactly one such
 * spelling (MSS-1-069) — so the source's number is the card number the print names.
 */
function repeatKeyOf(e: Extract<CardEffect, { type: 'chooseOption' }>, f: EffectFrame, s: GameState): string {
  const key = e.forbidRepeat!;
  if (key === '@source') return f.sourceId;
  if (key.startsWith('@number:')) return `@number:${peekDefinition(s, f.sourceId)?.functionalId ?? f.sourceId}`;
  return key;
}

/**
 * Whether 「選ばれない」 keeps the controller's effect from binding `id`.
 *
 * Only the *opponent's* effects are refused — a card that protects itself from the opponent does not
 * stop its own controller from choosing it — and only along the route the protection names.
 */
export function protectedFrom(s: GameState, id: CardId, controller: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger', causeId?: CardId): boolean {
  const owner = s.cards[id]?.owner;
  if (owner === undefined) return false;
  return staticProtection(s, id, owner).some(protection => {
    // The plain spelling protects from the *other* player's effects; 「自分と相手の」 (`both`, ARK-1-023)
    // covers the owner's own as well.
    if (owner === controller && protection.both !== true) return false;
    const source = protection.source;
    if (source !== undefined && source !== 'any' && source !== route) return false;
    // 「特徴に「X」を持たない…キャラの効果で」 — the refusal reads the resolving cause's printed trait; a
    // cause that cannot be read (absent, not a character, or carrying the trait) is not refused.
    if (protection.sourceNotTrait !== undefined) {
      if (route !== 'characterEffect' || causeId === undefined) return false;
      const cause = peekDefinition(s, causeId);
      if (!cause || cause.kind !== 'character' || hasTrait(cause, protection.sourceNotTrait)) return false;
    }
    // 「レイド状態でない相手のキャラの効果で選ばれない。」 (YYH-1-008) — a cause character *stacked over a
    // base* still chooses this card (it is レイド状態). The state is the same field read `isRaidState`
    // makes; a cause whose slot cannot be found stays unrefused, the `sourceNotTrait` convention.
    if (protection.sourceNotRaid !== undefined) {
      if (route !== 'characterEffect' || causeId === undefined) return false;
      const cause = peekDefinition(s, causeId);
      if (!cause || cause.kind !== 'character') return false;
      const causeOwner = s.cards[causeId]?.owner;
      const here = causeOwner !== undefined ? locate(s, causeOwner, causeId) : undefined;
      const slot = here ? s.players[causeOwner!][here.line].find(c => c.cardId === causeId) : undefined;
      if (!slot || slot.underneath.length > 0) return false;
    }
    return true;
  });
}

export function eligibleFor(s: GameState, f: EffectFrame, zone: ZoneId | ZoneId[], filter?: CardFilter, ignoreProtection = false): string[] {
  // A multi-zone choice offers every named pile as one selection (「自分の手札か自分の場外から」), and each
  // zone settles its own side: a pair printed on one player reads 自分の/自分の, while a cross-board union
  // (「相手のフロントLのキャラか自分の場の…」) reads 相手の/自分の. Resolving them all against the first
  // zone's side sent the second half of such a union to the wrong board.
  const primary = Array.isArray(zone) ? zone[0]! : zone;
  const sideOf = (one: ZoneId): PlayerId => (one.startsWith('enemy') ? otherOf(f.player) : f.player);
  // A multi-zone union must satisfy validation.ts's option-uniqueness invariant: `enemyField`
  // already contains `enemyFront` (SMD-1-056 prints `zones: ['enemyFront', 'enemyField']`), so a
  // bare `flatMap` offered every front card twice and the play was rolled back. Dedupe the union
  // only; the single-zone path keeps `zoneIds`'s order unchanged.
  const base = Array.isArray(zone)
    ? [...new Set(zone.flatMap(one => zoneIds(s, sideOf(one), one, f.sourceId, f.raidBase, f.battleBlocker)))]
    : zoneIds(s, sideOf(zone), zone, f.sourceId, f.raidBase, f.battleBlocker);
  if (primary === 'ownAp' || primary === 'enemyAp') return base;
  const route = f.route ?? 'characterEffect';
  // 「相手のフロントLのキャラ全ては、このターン中、BP-1000」 — an instruction that never prints 「選び」
  // is not 「選び」と書かれた該当の効果, so a 「効果で選ばれない」 card still takes it (Q906; round-103
  // YYH-1-025 question). The auto/all pool bypasses the protection filter; asking selections keep it.
  return base.filter(id => matchesFilter(s, id, filter, f.sourceId, f.declared) && (ignoreProtection || !protectedFrom(s, id, f.player, route, f.sourceId)))
    // 「相手は…元々のBPが4000のキャラの効果でのみ選ぶことができる。」 — the card's own controller allows
    // the other side to select it only through the named effects. Like `protectedFrom`, the restriction
    // binds only when the chooser is *not* the card's controller; the cause is the resolving effect's
    // source, which must exist for a named filter to hold.
    .filter(id => {
      const owner = s.cards[id]?.owner;
      if (owner === undefined || owner === f.player) return true;
      // Q699: this source whitelist qualifies character effects only. A trigger whose source card
      // happens to be a character, and field/event effects, are outside the printed restriction.
      if (route !== 'characterEffect' || peekDefinition(s, f.sourceId)?.kind !== 'character') return true;
      const allowed = selectableOnlyByFilters(s, id, owner);
      if (!allowed.length) return true;
      if (f.sourceId === undefined) return false;
      return allowed.some(one => matchesFilter(s, f.sourceId!, one));
    })
    // 「…を1枚場外に置かないと選べない」 — a taxed card cannot be chosen at all while the chooser has
    // nothing to pay with, which is what 「…ないと選べない」 says. Read here, where the choice is offered,
    // and along the effect's own route.
    .filter(id => canPaySelectionTax(s, id, f.player, route))
    // 「…をレイドさせる」 — only the bases the bound raider may actually raid onto are offered. The raider
    // is normally a binding; `'source'` names the card whose ability is resolving (「このカードを…レイド
    // させる」 inside a granted ability), which has no selection of its own.
    .filter(id => !filter?.raidBaseFor || raidBaseEligible(s, sideOf(primary),
      filter.raidBaseFor === 'source' ? f.sourceId : (f.selections?.[filter.raidBaseFor] ?? [])[0] ?? '', id));
}

/**
 * Q2272 (総則) — 「対象を選ぶ必要がある【起動メイン】は、その対象全てを選ぶことができない場合、発動する
 * ことができません。※「1枚まで選び」のように、「まで」と記載がある場合は、0枚を選ぶことができるため、
 * 発動できます。」: an activation whose steps carry a *forced* selection (min ≥ 1, no 「まで」, not
 * declinable) cannot start when the pool cannot supply it — checked before any cost is paid.
 *
 * The gate is deliberately thin: it answers only selections whose pool the *pre-activation board* alone
 * decides. A pool fed by earlier steps of the same effect (named bindings, this-effect records) or widened
 * by a waiting BP-range bonus is left to resolution, and a preceding step whose zone writes cannot be named
 * ends the walk. Both directions of a miss are intentional — a missed refusal is a smaller wrong than
 * refusing a legal activation — which is why removal-only writes are the only ones the walk names: a pool
 * read before them can only over-count, so a refusal based on it is still sound. Cards whose dedicated FAQ
 * blessed the empty activation before this 総則 (HTR-2-030, Q613) are gated like the rest: the newer
 * general ruling supersedes — the round record carries the precedence note.
 */
export function activationSelectBlocked(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[]): boolean {
  return selectGateWalk(s, player, sourceId, steps, []);
}

/** Check the printed, leading AP/hand costs before any cost choice can park the activation.
 * Keep both AP and hand-substitution routes: using AP greedily can strand a later larger AP cost.
 * An effect-body payment or an unmodelled step ends this narrow cost-prefix check.
 */
export function activationCostFailure(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[]): 'ap' | 'hand' | undefined {
  const p = s.players[player], modifiers = ownStaticsOf(s, sourceId, player);
  const free = modifiers.some(m => m.type === 'activationApFree');
  const substitute = modifiers.some(m => m.type === 'activationCostSubstitute');
  let waivers = (p.nextActivationApFree ?? []).filter(w => w.expiresTurn >= s.turn && matchesFilter(s, sourceId, w.filter)).length;
  let routes = [{ ap: p.ap.filter(a => a === 'active').length, hand: p.hand.length }];
  for (const step of steps) {
    if (step.type === 'discard' && step.strict && !step.optional && step.player === 'self' && !step.filter && !step.countSource && step.max === undefined) {
      routes = routes.filter(r => r.hand >= step.count).map(r => ({ ...r, hand: r.hand - step.count }));
      if (!routes.length) return 'hand';
    } else if (step.type === 'payAp' && step.asCost && !step.optional) {
      if (free) continue;
      if (waivers) { waivers--; continue; }
      const next = routes.flatMap(r => [
        ...(r.ap >= step.count ? [{ ...r, ap: r.ap - step.count }] : []),
        ...(substitute && step.count === 1 && r.hand > 0 ? [{ ...r, hand: r.hand - 1 }] : []),
      ]);
      if (!next.length) return 'ap';
      routes = [...new Map(next.map(r => [`${r.ap}:${r.hand}`, r])).values()];
      if (step.then?.length) break;
    } else break;
  }
  return undefined;
}

/**
 * The same walk for a card's *use* (Q1119 総則 / Q510): 「対象を選ぶ必要があるイベントカードは、その対象
 * 全てを選ぶことができない場合、使用することができません」 — the walk reads the card's own effect steps and
 * the shared safety rules apply (only pools the pre-use board alone decides are judged).
 */
export function useSelectBlocked(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[]): boolean {
  return selectGateWalk(s, player, sourceId, steps, []);
}

function selectGateWalk(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[], outer: CardEffect[]): boolean {
  const preceding = [...outer];
  for (const step of steps) {
    if (step.type === 'select') {
      if (selectGateBlocks(s, player, sourceId, step, preceding)) return true;
      continue;
    }
    if (step.type === 'if') {
      // 「自分の場に〈リンウェル〉がある場合、…」 (TOA-1-030) — a *name* gate the pre-use board alone
      // decides, read before anything has executed (`preceding` empty), picks the one branch that will
      // run: the other branch's open pool must not mask the taken branch's empty forced pick (Q1119/Q2272).
      // Every other condition — and any branch point after an executed step, whose reading the effect
      // itself could have moved — keeps the conservative rule below.
      if (step.condition.type === 'hasName' && preceding.length === 0) {
        const branch = evalCondition(s, sourceId, player, step.condition) ? step.then : step.else;
        return branch?.length ? selectGateWalk(s, player, sourceId, branch, preceding) : false;
      }
      // Only when *every* branch certainly needs an unsatisfiable selection is the activation impossible;
      // one open branch — or a branch this gate cannot judge — leaves the activation standing. What either
      // branch then writes is unnameable, so nothing after the branch point is judged either.
      const thenBlocked = step.then?.length ? selectGateWalk(s, player, sourceId, step.then, preceding) : false;
      const elseBlocked = step.else?.length ? selectGateWalk(s, player, sourceId, step.else, preceding) : false;
      if (thenBlocked && elseBlocked) return true;
      return false;
    }
    if (step.type === 'gained') {
      // 「…そうした場合、AとBを選び…」 — exactly one of the branches runs (the gate holds or it does
      // not), so the same every-branch rule as `if`: a both-branches-blocked consequent makes the
      // activation impossible (HIQ-1-028's forced attack×block pair). Same stop: what a branch leaves
      // behind is unnameable.
      const thenBlocked = step.then?.length ? selectGateWalk(s, player, sourceId, step.then, preceding) : false;
      const elseBlocked = step.else?.length ? selectGateWalk(s, player, sourceId, step.else, preceding) : false;
      if (thenBlocked && elseBlocked) return true;
      return false;
    }
    if (selectGateWrites(step) === undefined) return false;
    preceding.push(step);
  }
  return false;
}

function selectGateBlocks(s: GameState, player: PlayerId, sourceId: CardId, e: Extract<CardEffect, { type: 'select' }>, preceding: CardEffect[]): boolean {
  // 「まで」 and every other declinable/open form may take zero: not a forced selection (Q2272's own note).
  if (e.min < 1 || e.auto || e.all || e.battleAttacker || e.restOptional === true || e.declaredTarget) return false;
  // Widths and pools this gate cannot read off the pre-activation board: a width the frame supplies, or a
  // pool that is a binding/record rather than a zone.
  if (e.countDelta || e.sameCountAsBind !== undefined || e.maxPer || e.maxEnergyPer) return false;
  if (e.fromBinds?.length || e.movedByThisEffect || e.underHosts) return false;
  const filter = e.filter;
  if (filter?.raidBaseFor) return false;
  // A ceiling counted from this effect's own records answers 0 to `matchesFilter`, which would read as an
  // empty pool; the resolution-time `select` folds it into a plain cap itself — leave those to resolution.
  if (filter?.bpCeiling && FRAME_TIER_SOURCES.has(filter.bpCeiling.count.source)) return false;
  const zones = e.zones ?? [e.zone];
  for (const step of preceding) {
    const writes = selectGateWrites(step);
    if (writes === undefined || zones.some(zone => writes.has(zone))) return false;
  }
  // 「このターン中、次に…選ぶ際、指定できるBPの範囲+N」 — a waiting widening only adds candidates, so a
  // probe that ignored it could read a pool empty while resolution finds one; with one parked, skip.
  if (filter && (filter.minBP !== undefined || filter.maxBP !== undefined)) {
    const definition = peekDefinition(s, sourceId);
    const sourceColor = definition?.trigger?.type === 'color' && findField(s, player, sourceId) === undefined
      ? COLORS.find(colour => (definition.requiredEnergy[colour] ?? 0) > 0)
      : undefined;
    const widenings = (s.players[player].pendingSelectBp ?? []).filter(entry => entry.expiresTurn >= s.turn);
    if (selectBpRangeBonus(s, player, sourceColor) + widenings.reduce((total, entry) => total + entry.amount, 0) > 0) return false;
  }
  const probe = makeTask(s, player, sourceId, []) as EffectFrame;
  probe.selections = {};
  return eligibleFor(s, probe, zones, filter).length < Math.min(e.min, e.max);
}

/**
 * The zones a step may *add* cards to, or `undefined` when its shape is not one this gate models. Removal-
 * only shapes (a retire, a discard) still name their destinations: a pool read before them over-counts.
 */
function selectGateWrites(step: CardEffect): Set<ZoneId> | undefined {
  switch (step.type) {
    case 'actSource': return selectGateOperationWrites(step.operation);
    case 'act': return selectGateOperationWrites(step.operation);
    case 'choose': return selectGateChooseWrites(step.operation);
    case 'discard': return new Set<ZoneId>(['ownSideline', 'ownRemoval', 'ownHand', 'enemySideline', 'enemyRemoval']);
    case 'payAp': {
      if (!step.then?.length) return new Set<ZoneId>(['ownAp']);
      // 「…を退場させる」 as the price's own consequence (HIQ-1-028): the pool a later select reads is
      // shaped by what the paid branch wrote, so the union is computed from the sub-steps — an
      // unmodelable sub-step keeps the whole thing unknown.
      const writes = new Set<ZoneId>(['ownAp']);
      for (const sub of step.then) {
        const subWrites = selectGateWrites(sub);
        if (subWrites === undefined) return undefined;
        for (const zone of subWrites) writes.add(zone);
      }
      return writes;
    }
    case 'self': case 'grantStatic': return new Set<ZoneId>();
    default: return undefined;
  }
}

function selectGateOperationWrites(operation: CardOperation): Set<ZoneId> | undefined {
  switch (operation) {
    // A retire may be substituted into the hand, a discard may be redirected to リムーブ — both named.
    case 'retire': return new Set<ZoneId>(['ownSideline', 'ownRemoval', 'ownHand', 'enemySideline', 'enemyRemoval', 'enemyHand']);
    case 'removalToSideline': return new Set<ZoneId>(['ownSideline', 'enemySideline']);
    case 'remove': return new Set<ZoneId>(['ownRemoval', 'enemyRemoval']);
    case 'return': return new Set<ZoneId>(['ownHand', 'enemyHand']);
    case 'bp': case 'rest': case 'activate': return new Set<ZoneId>();
    default: return undefined;
  }
}

function selectGateChooseWrites(operation: 'return' | 'retire' | 'bp' | 'evade' | 'checkmate' | 'readyAp'): Set<ZoneId> | undefined {
  switch (operation) {
    case 'retire': return new Set<ZoneId>(['ownSideline', 'ownRemoval', 'ownHand', 'enemySideline', 'enemyRemoval', 'enemyHand']);
    case 'return': return new Set<ZoneId>(['ownHand', 'enemyHand']);
    // 「レストのAPカードを…選び」 — readying slots widens a later slot choice's pool.
    case 'readyAp': return new Set<ZoneId>(['ownAp']);
    case 'bp': case 'evade': case 'checkmate': return new Set<ZoneId>();
    default: return undefined;
  }
}

export function selectionTaxFor(s: GameState, id: CardId, chooser: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger'): SelectionTax | undefined {
  const owner = s.cards[id]?.owner;
  if (owner === undefined || owner === chooser) return undefined;
  return staticSelectionTax(s, id, owner, route);
}

/** The chooser's own characters a 「…を1枚レストにしなければ選べない」 tax may rest. */
function taxRestCandidates(s: GameState, chooser: PlayerId, filter: CardFilter | undefined, causeId: CardId): { line: 'front' | 'energy'; card: FieldCard }[] {
  const lines: ('front' | 'energy')[] = filter?.zone === 'front' ? ['front'] : filter?.zone === 'energy' ? ['energy'] : ['front', 'energy'];
  const out: { line: 'front' | 'energy'; card: FieldCard }[] = [];
  for (const line of lines) {
    for (const card of s.players[chooser][line]) {
      if (filter?.active !== false && !card.active) continue;
      if (filter?.minBP !== undefined && getBP(s, card) < filter.minBP) continue;
      // Q1244 — a card under a 「レストにならない」 lock cannot be spent as the tax's rest payment
      // either; the paying chooser's own doing counts as an own-effect rest, and the taxed card is
      // the rest's cause for the trait-scoped forms.
      if (refusesRest(s, card.cardId, chooser, true, causeId)) continue;
      out.push({ line, card });
    }
  }
  return out;
}

/**
 * Assign distinct rest candidates to every rest slot of a per-kind tax. `tax.rest` keeps one entry per
 * printed/granted tax (each with its own filter), so the slots are expanded and matched as a small
 * bipartite assignment: a character may pay at most one slot, and overlapping filters must not reuse it.
 */
function restTaxAssignment(s: GameState, chooser: PlayerId, causeId: CardId, tax: SelectionTax): { line: 'front' | 'energy'; card: FieldCard }[] | undefined {
  const slots = tax.rest.flatMap(entry => Array.from({ length: entry.amount }, () => entry.restFilter));
  if (!slots.length) return [];
  const candidates = slots.map(filter => taxRestCandidates(s, chooser, filter, causeId));
  const assigned: ({ line: 'front' | 'energy'; card: FieldCard } | undefined)[] = new Array(slots.length);
  const slotOf = new Map<CardId, number>();
  const assign = (slot: number, seen: Set<CardId>): boolean => {
    for (const candidate of candidates[slot]!) {
      const id = candidate.card.cardId;
      if (seen.has(id)) continue;
      seen.add(id);
      const previous = slotOf.get(id);
      if (previous === undefined || assign(previous, seen)) {
        slotOf.set(id, slot);
        assigned[slot] = candidate;
        return true;
      }
    }
    return false;
  };
  for (let slot = 0; slot < slots.length; slot++) {
    if (!assign(slot, new Set())) return undefined;
  }
  return assigned as { line: 'front' | 'energy'; card: FieldCard }[];
}

export function canPayTax(s: GameState, id: CardId, chooser: PlayerId, tax: SelectionTax | undefined): boolean {
  if (!tax) return true;
  const p = s.players[chooser];
  if (tax.ap > p.ap.filter(slot => slot === 'active').length) return false;
  if (tax.hand > p.hand.length) return false;
  return tax.rest.length === 0 || restTaxAssignment(s, chooser, id, tax) !== undefined;
}

export function canPaySelectionTax(s: GameState, id: CardId, chooser: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger'): boolean {
  return canPayTax(s, id, chooser, selectionTaxFor(s, id, chooser, route));
}

/**
 * The hand half of the selection taxes on a whole answer. One selection may bind several taxed cards
 * (or one card may carry several hand taxes), and the printed cost is paid per taxed selection; the
 * choice frame must therefore ask for the sum, not once per card.
 */
function selectionTaxHandTotal(s: GameState, f: EffectFrame, ids: string[]): number {
  return ids.reduce((sum, id) => sum + (selectionTaxFor(s, id, f.player, f.route ?? 'characterEffect')?.hand ?? 0), 0);
}

export function payTax(ctx: Context, id: CardId, chooser: PlayerId, tax: SelectionTax | undefined, opts: { skipHand?: boolean; hand?: CardId[]; emitAp?: boolean } = {}): void {
  const s = ctx.state;
  if (!tax) return;
  const p = s.players[chooser];
  if (tax.ap > 0) {
    let remaining = tax.ap;
    for (let i = 0; i < p.ap.length && remaining > 0; i++) {
      if (p.ap[i] !== 'active') continue;
      p.ap[i] = 'rested';
      remaining--;
    }
    if (opts.emitAp !== false) ctx.events.push({ type: 'apSpent', data: { player: chooser, amount: tax.ap } });
  }
  // The hand half is already paid by the `selectionTax` cards frame (the chooser picked which cards);
  // it is skipped only while replaying that same answer, never for a fresh selection.
  if (!opts.skipHand && tax.hand > 0) {
    const pay = opts.hand ?? p.hand.slice(0, tax.hand);
    for (const card of pay) {
      const at = p.hand.indexOf(card);
      if (at < 0) continue;
      p.hand.splice(at, 1);
      p.sideline.push(card);
    }
  }
  if (tax.rest.length) {
    // 「…を1枚レストにしなければ選べない」 is an ordinary cost: it rests the card for this
    // resolution only. `cannotActivateCharges` is the 「次のN回アクティブにならない」 charge and
    // must not be written here — otherwise the paid character skips its next ready step (WBK-1-061).
    for (const { card } of restTaxAssignment(s, chooser, id, tax) ?? []) card.active = false;
  }
}

function chargeSelectionTax(ctx: Context, f: EffectFrame, ids: string[]): void {
  for (const id of ids) {
    payTax(ctx, id, f.player, selectionTaxFor(ctx.state, id, f.player, f.route ?? 'characterEffect'), { skipHand: f.selectionTaxPaid === true });
  }
}

export function makeTask(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[], route?: EffectTask['route'], raidBase?: CardId[], underIds?: CardId[]): EffectTask {
  const c = findField(s, player, sourceId)?.card;
  const kind = peekDefinition(s, sourceId)?.kind;
  return {
    id: `${s.revision}:${sourceId}`, player, sourceId, steps: structuredClone(steps),
    route: route ?? (kind === 'event' ? 'eventEffect' : 'characterEffect'),
    ...(c ? { sourceInstance: fieldIdentity(c) } : {}),
    ...(raidBase?.length ? { raidBase } : {}),
    ...(underIds?.length ? { underIds } : {}),
  };
}
/** Placement routes read the entry budget through the same reserve-and-settle channel `play` uses: a
 * named-tail 【登場時】 belongs to the printed card, so an effect placement of a second copy is covered by
 * Q2123's 「どちらか片方しか発動できません」 exactly like a played one. */
function placedEntrySteps(s: GameState, player: PlayerId, definition: CardDefinition): CardEffect[] {
  return definition.onPlaySharedLimit === true ? prepareEntryEffects(s, player, definition) : definition.onPlay ?? [];
}
function makeEntryTask(s: GameState, player: PlayerId, sourceId: CardId, steps: CardEffect[]): EffectTask {
  const definition = peekDefinition(s, sourceId);
  const key = definition?.onPlaySharedLimit === true ? `entry:${definition.functionalId}` : undefined;
  return { ...makeTask(s, player, sourceId, steps), abilityEvent: 'onPlay', ...(key !== undefined ? { limitBudgetKeys: [key] } : {}) };
}
/**
 * Replaces the frame's pending queue, carrying the resume fields over from whatever it already held.
 *
 * `damageCount` is the printed amount an unblocked attack deals. Hand-built merges dropped it while
 * keeping `resume` and `defenderId`, so a 「ブロックされなかった時」 ability that queued anything at
 * all (a retirement's own 退場時 trigger is enough) resumed with 1 damage instead of the printed
 * number. Every rebuild site goes through here so no field can go missing one site at a time.
 */
function setQueue(f: EffectFrame, effects: EffectTask[]): void {
  f.queue = {
    effects,
    resume: f.queue?.resume ?? 'none',
    ...(f.queue?.defenderId !== undefined ? { defenderId: f.queue.defenderId } : {}),
    ...(f.queue?.damageCount !== undefined ? { damageCount: f.queue.damageCount } : {}),
  };
}

function entryBudgetKeyOf(definition: CardDefinition | undefined): string | undefined {
  return definition?.onPlaySharedLimit === true ? `entry:${definition.functionalId}` : undefined;
}
function trackEntryBudget(f: EffectFrame, definition: CardDefinition | undefined): void {
  const key = entryBudgetKeyOf(definition);
  if (key === undefined || f.limitBudgetKeys?.includes(key)) return;
  f.limitBudgetKeys = [...(f.limitBudgetKeys ?? []), key];
}
export function settleTriggers(ctx: Context, pending: TriggerDecision): void {
  if (pending.cards.length || pending.effects?.length) ctx.state.pending = pending;
  else endBattle(ctx);
}
export function startEffect(ctx: Context, task: EffectTask, resume?: TriggerDecision, eventCard?: CardId, queue?: { effects: EffectTask[]; resume: QueueResume; defenderId?: CardId; damageCount?: number }): void {
  // 「元々の効果を失う」 installed *after* the watcher was queued — the same frame's move followed by a
  // loseEffects step (KMR-2-049/Q1807) — silences the printed watcher: the collection ran before the
  // suppression landed, so the answer is re-read here, where it is final. Granted abilities are 「得た
  // 効果」 and keep firing (Q1313/Q1314).
  if (task.printedWatcher === true && effectsSuppressed(ctx.state, task.sourceId)) {
    settleLimitBudgets(ctx.state, task.player, task.limitBudgetKeys, false);
    return;
  }
  requireRule(!ctx.state.effect, 'INVALID_STATE', '另一个效果仍在结算。');
  ctx.state.effect = {
    ...task, index: 0, stage: 'step', held: [], taken: 0, selections: { ...(task.bindings ?? {}) },
    ...(resume ? { resume } : {}),
    ...(eventCard ? { eventCard } : {}),
    ...(queue ? { queue: { effects: queue.effects, resume: queue.resume, ...(queue.defenderId !== undefined ? { defenderId: queue.defenderId } : {}), ...(queue.damageCount !== undefined ? { damageCount: queue.damageCount } : {}) } } : {}),
  };
  ctx.state.pending = null;
  if (task.abilityEvent !== undefined && peekDefinition(ctx.state, task.sourceId)?.kind !== 'event') {
    syncLedger(ctx, 'rule');
    logEvent(ctx, 'effectBegan', { player: task.player, cardId: task.sourceId, pub: visibility(ctx, [task.sourceId]).pub.length, ev: task.abilityEvent });
  }
  runEffects(ctx);
}
/**
 * Where a looked-card pick sends what it takes — the destination half of the take prompt.
 *
 * Generated from the step's own `take` rather than written per call site: the round-124 sweep found the
 * hard-coded 「公开并加入手牌」 sitting on a `take: 'sideline'` step (BLC-4-048), and a per-branch string
 * would let the same drift return one branch at a time.
 */
export function takeDestinationText(take: Extract<CardEffect, { type: 'lookReveal' }>['take']): string {
  switch (take ?? 'hand') {
    case 'sideline': return '置于场外';
    case 'under': return '面朝下置于该角色下方';
    case 'top': return '放回牌库顶';
    case 'removal': return '置于移除区';
    case 'use': return '不支付AP使用';
    case 'deploy': return '登场';
    case 'deployRested': return '以休息状态登场';
    case 'deployOrRaid': return '登场或RAID';
    case 'deployRestedOrRaid': return '以休息状态登场或RAID';
    case 'handOrSideline': return '加入手牌或置于场外';
    case 'topOrSideline': return '放回牌库顶或置于场外';
    default: return '加入手牌';
  }
}
export function lookTakePrompt(args: { lead: string; from: string; floor: number; max: number; dest: string; reveal: boolean; empty: boolean }): string {
  if (args.empty) return `${args.lead}：无可选卡，点击确认继续`;
  if (args.floor > 0) return `从${args.from}中选择 ${args.floor === args.max ? args.floor : `${args.floor}~${args.max}`} 张${args.dest}`;
  return `${args.lead}，${args.reveal ? '公开并' : ''}选择至多 ${args.max} 张${args.dest}（可不选）`;
}
/**
 * The 「望む順で」 ordering question over the cards a look leaves behind. The remainder's destination
 * decides the wording: `orderTop` stacks them on the deck's *top* (first pick = topmost), while
 * `bottom`/`order` put the block at the *bottom* (first pick = highest card of the block).
 */
export function lookOrderPrompt(rest: string): string {
  return rest === 'orderTop' || rest === 'splitTopSideline'
    ? '按顺序点击：先选的放在牌库最上（依次向下叠放）'
    : '按顺序点击剩余卡牌：先选的在上，最后选的在牌库最底';
}
function request(ctx: Context, f: EffectFrame, kind: EffectDecision['kind'], prompt: string, min: number, max: number, options: string[], chooser: PlayerId = f.player): void {
  // A moment ability raised earlier in this frame (「…レストになった時」) must not be dropped when the
  // frame parks for a decision: the command's own queue does not survive into the next command, so the
  // tasks join the *frame's* queue here and resolve after the frame closes.
  if (ctx.queue.length) {
    const queued = ctx.queue.splice(0, ctx.queue.length);
    setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
  }
  ctx.state.pending = { type: 'effect', player: chooser, choiceId: `${f.id}:${f.index}:${f.stage}:${ctx.state.revision}`, kind, prompt, min: Math.min(min, options.length), max: Math.min(max, options.length), options };
}
const prompts: Record<CardOperation, string> = {
  return: '选择要返回手牌的卡', retire: '选择要退场的角色', remove: '选择要置于移除区的卡', removalToSideline: '选择要置回场外的卡', rest: '选择要休息的卡',
  activate: '选择要激活的卡', bp: '选择要变更 BP 的角色', impact: '选择要获得 IMPACT 的角色', damage: '选择要获得 DAMAGE 的角色',
  evade: '选择本回合不被低 BP 角色阻挡的角色', checkmate: '选择本回合 BP +2000 的己方前线角色', readyAp: '选择要激活的 AP（未开放的 AP 不能选择）',
  blockOnly: '选择本次攻击唯一可以阻挡的角色',
  move: '选择要移动到另一条战线的角色', deploy: '选择要特殊登场的角色', raid: '选择要 RAID 的基底',
  deployRested: '选择要以休息状态特殊登场的角色',
  toDeckTop: '选择要放到牌库顶的卡', toDeckBottom: '选择要放到牌库底的卡', toLife: '选择要置入生命区的卡',
  loseEffects: '选择要失去所有原有效果的对方角色', loseSelfTurnEffects: '选择要失去[自己的回合中]效果的角色', reveal: '选择要公开的卡', toUnder: '选择要置于此角色下方的卡',
  energy: '选择要变更发生能量的角色', grantKeywords: '选择要获得关键词的角色',
  topToSideline: '选择要取走 RAID 顶牌的角色',
  topToDeckBottom: '选择要取走 RAID 顶牌放回牌库底的角色',
  topToDeckTop: '选择要取走 RAID 顶牌放回牌库顶的角色',
  cannotActivate: '选择要禁止激活的角色',
  bottomToField: '选择要登场其堆栈底牌的角色', underToSideline: '选择要移走其卡下堆的角色', placeSourceUnder: '选择要置于其下的角色',
  raidTopToHand: '选择要剥离其 RAID 顶牌的角色',
  toDeckTopOrBottom: '选择要放回牌库的卡',
  retireEndPhase: '选择要预定在结束阶段退场的角色',
  energyCostUp: '选择要提升必要能量的角色',
  mustBlockAttacker: '选择必须阻挡该攻击的角色',
};
function removeFromZone(s: GameState, player: PlayerId, id: CardId): void {
  const p = s.players[player];
  for (const zone of [p.hand, p.sideline, p.removal, p.deck] as CardId[][]) {
    const at = zone.indexOf(id);
    if (at !== -1) { zone.splice(at, 1); return; }
  }
  // The life area keeps a flag per slot, so its removal goes through the slot-aware helper rather than
  // splicing the card list alone (which would leave every flag one slot behind).
  if (removeFromLife(s, player, id)) {
    // 「（山札の一番上ではなくなった場合は裏向きに戻る）」 is about the deck; a life card that leaves keeps
    // no public state, so nothing else to do here.
    return;
  }
  // A face-down card under a character is a place a card can be, so "remove it from wherever it is" has
  // to reach those stacks too — otherwise a card taken out of them (「…の下に置かれたカードを手札に
  // 加える」) would sit in the hand *and* under the character at the same time.
  for (const card of [...p.front, ...p.energy]) {
    const at = card.faceDown?.indexOf(id) ?? -1;
    if (at !== -1) { card.faceDown!.splice(at, 1); return; }
  }
  for (const card of [...p.front, ...p.energy]) {
    const at = card.underneath.indexOf(id);
    if (at !== -1) { card.underneath.splice(at, 1); return; }
  }
}
/** Which zone a card currently occupies, for the entry record the effects write. */
function zoneOfCard(s: GameState, owner: PlayerId, id: CardId): 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under' {
  const p = s.players[owner];
  if (p.hand.includes(id)) return 'hand';
  if (p.sideline.includes(id)) return 'sideline';
  if (p.deck.includes(id)) return 'deck';
  if (p.life.includes(id)) return 'life';
  if (p.removal.includes(id)) return 'removal';
  return 'under';
}

function printedSelectBind(f: EffectFrame): string | undefined {
  if (f.selectPrinted === undefined) return undefined;
  for (let i = f.index - 1; i >= 0; i--) {
    const step = f.steps[i];
    if (step?.type === 'select') return step.bind;
  }
  return undefined;
}

function recordSelectAct(f: EffectFrame, target: string | undefined, count: number): void {
  if (target === undefined || printedSelectBind(f) !== target) return;
  (f.selections ??= {}).__selectAct = [target, String(count)];
}

/**
 * The count the gate above reads: the act that executed the printed selection, when it is still the last
 * instruction of the gate's sentence.
 *
 * A printed sentence may continue after the selection's own act with further `act` steps (SLG-1-048's
 * 「…合计3张与此角色最上方的卡牌置于场外」 is one sentence, two acts), so those do not change what
 * 「そうした場合」 asks. Any other kind of step between is a new instruction — AOT-2-053's optional AP
 * payment, BLC-4-058's draw, SMD-1-018's face-up card take — and the gate then keeps reading that
 * instruction's own result (`didCount`), exactly as it did before.
 */
function selectActCount(f: EffectFrame, printedBind: string | undefined): number | undefined {
  const record = f.selections?.__selectAct;
  if (record === undefined || printedBind === undefined || record[0] !== printedBind) return undefined;
  for (let i = f.index - 1; i >= 0; i--) {
    const step = f.steps[i];
    if (step === undefined || step.type !== 'act') return undefined;
    if (step.target === printedBind) return Number(record[1]);
  }
  return undefined;
}

/**
 * Whether a 「…した場合」 clause holds.
 *
 * Without a discriminator this is the old, deliberately loose reading: *anything* counted by the last
 * action opens the branch (`gainedCount` for a take, `discardedCount` for a discard, `didCount` for a
 * selection). With one, the branch follows the *cards*: `filter` picks the gained ones, `exclude`
 * inverts the set (「〈X〉以外を手札に加えた場合」 means "the card that arrived is not 〈X〉"), and
 * `min` is how many must qualify.
 */
function gainedHolds(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'gained' }>): boolean {
  // The selection's printed count is spent by any `gained` that follows it; only the loose reading below
  // uses it, so a discriminated gate is unaffected.
  const selectPrinted = f.selectPrinted;
  const printedBind = printedSelectBind(f);
  delete f.selectPrinted;
  const selectActed = selectActCount(f, printedBind);
  delete f.selections?.__selectAct;
  const discardPrinted = f.discardPrinted;
  delete f.discardPrinted;
  // 「2枚以上移動させた場合」 — `on: 'moved'` reads the frame's bare "how many the last step handled"
  // marker (`didCount`), which is what a move records. It is its own reading so the ordinary `min` gate
  // keeps comparing the gained/discarded counts alone.
  if (e.on === 'moved') return (f.didCount ?? 0) >= Math.max(1, e.min ?? 1);
  // 「自分のAPカードを1枚…アクティブにしてもよい。そうした場合、…」 (IMC-1-061) — the AP half of the
  // activation gate (Q509): only slots this effect actually readied count (an already-active slot is not
  // a ready). AP slots have no card identity, so the frame holds their count.
  if (e.on === 'apReadied') return (f.readiedAp ?? 0) >= Math.max(1, e.min ?? 1);
  // 「2枚レストにしなかった場合」 — the cards *this effect* rested (`restedIds`), the same frame record the
  // 「この効果でレストにしたカード1枚につき」 counts read. Read with its own `min` so the negative branch
  // can ask for "fewer than two".
  if (e.on === 'rested' || e.on === 'activated') {
    const ids = (e.on === 'activated' ? f.activatedIds : f.restedIds) ?? [];
    if (e.filter === undefined) return ids.length >= Math.max(1, e.min ?? 1);
    const matched = ids.filter((id: string) => matchesFilter(ctx.state, id, e.filter!, f.sourceId));
    return (e.exclude ? ids.length - matched.length : matched.length) >= Math.max(1, e.min ?? 1);
  }
  // 「この効果で〈X〉を登場させた場合」 — the placements this effect made (`deployedIds`, written by the
  // deploy and effect-raid operations), read with the same filter/`exclude` vocabulary as the others.
  if (e.on === 'deployed') {
    const ids = f.deployedIds ?? [];
    if (!ids.length) return false;
    if (e.filter === undefined) return ids.length >= Math.max(1, e.min ?? 1);
    const matched = ids.filter((id: string) => matchesFilter(ctx.state, id, e.filter, f.sourceId));
    const qualifying = e.exclude ? ids.length - matched.length : matched.length;
    return qualifying >= Math.max(1, e.min ?? 1);
  }
  const ids = e.on === 'discarded' ? f.discardedIds : f.gainedIds;
  const count = (e.on === 'discarded' ? f.discardedCount : f.gainedCount) ?? 0;
  if (e.filter === undefined && e.exclude === undefined) {
    if (e.min === undefined) {
      // 「…をN枚置く。そうした場合、…」 — when the preceding instruction was a *selection*, the gate asks
      // whether the printed count was reached (Q561/Q562/Q574/Q575: moving the fewer-than-N available
      // cards still leaves 「条件は満たされていない」). The record rides from the `select` step; the act
      // that followed wrote its taken count to `didCount` — and, when it is the act the selection feeds,
      // to `__selectAct` as well. A printed sentence may carry further acts after that one (SLG-1-048's
      // `topToSideline`), so the gate reads that act's own record when it has one.
      if (selectPrinted !== undefined) {
        return selectActed !== undefined ? selectActed >= selectPrinted : (f.didCount ?? 0) >= selectPrinted;
      }
      // The discard spelling of the same question (FMA-1-079: 「手札の紫のカードを3枚場外に置く。そうした
      // 場合、…」 — two cards placed is not the printed condition).
      if (discardPrinted !== undefined) return (f.didCount ?? 0) >= discardPrinted;
      const previous = f.steps[f.index - 1];
      if (e.on !== 'discarded' && previous?.type === 'lookReveal' && previous.max > 0) return count > 0;
      // The undiscriminated reading stays deliberately loose: the branch opens when *any* of the last
      // action's outcomes is non-empty.
      return e.on === 'discarded' ? count > 0 : count > 0 || (f.discardedCount ?? 0) > 0 || (f.didCount ?? 0) > 0;
    }
    return count >= Math.max(1, e.min);
  }
  if (!ids) return false;
  const matched = ids.filter((id: string) => matchesFilter(ctx.state, id, e.filter, f.sourceId));
  const qualifying = e.exclude ? ids.length - matched.length : matched.length;
  return qualifying >= Math.max(1, e.min ?? 1);
}

/**
 * 「このカードが山札から公開された時、…」 — queues the watchers the revealed cards carry themselves.
 *
 * The subject is the revealed card, which is in no zone while the effect holds it (or is already back in
 * the deck), so the usual field walk cannot reach it: the ability is read off the card's own definition
 * and its per-turn budget lives on the *player*, keyed by the same `${functionalId}:${index}` convention
 * the sideline channel uses. Only the card's own channel exists — no other card watches another's reveal.
 */
function queueRevealedFromDeck(ctx: Context, ids: CardId[]): void {
  const s = ctx.state;
  // 「このターン中に自分の山札から必要エナジーが5以上のカードが公開されている場合」 — the turn's own
  // record of the *public* reveal, beside the watcher collection below. Logged here because this
  // function is the single funnel every public-reveal site already goes through, and the reveal is a
  // fact about the card wherever it ends up afterwards.
  for (const id of ids) {
    const owner = s.cards[id]?.owner;
    if (owner !== undefined) logTurnEvent(s, 'revealedFromDeck', owner, id);
  }
  for (const id of ids) {
    const owner = s.cards[id]?.owner;
    if (owner === undefined) continue;
    const definition = peekDefinition(s, id);
    if (!definition?.triggered) continue;
    for (const [index, ability] of definition.triggered.entries()) {
      if (ability.event !== 'onRevealedFromDeck') continue;
      if (ability.condition && !evalCondition(s, id, owner, ability.condition)) continue;
      const key = `${definition.functionalId}:${index}`;
      const used = s.players[owner].revealTriggeredUsed?.[key] ?? 0;
      if (ability.oncePerTurn && used >= s.turn) continue;
      if (ability.oncePerTurn) s.players[owner].revealTriggeredUsed = { ...(s.players[owner].revealTriggeredUsed ?? {}), [key]: s.turn };
      ctx.queue.push(makeTask(s, owner, id, ability.effects));
    }
  }
}

/**
 * 「自分の効果で自分の手札からこのカードが公開された時」 (DST-1-045/046/047) — the *hand* sibling of
 * `queueRevealedFromDeck`. The revealed card does not move for the reveal, so the watcher resolves with
 * the hand card as its own source; 「自分の効果で」 rides as the printed `eventSource` — the causing
 * effect's source must belong to the revealed card's owner — and the per-turn budget shares the hand
 * channel's `handTriggeredUsed` bag.
 */
function queueRevealedFromHand(ctx: Context, cards: CardId[], causeId: CardId | undefined): void {
  const s = ctx.state;
  for (const id of cards) {
    const owner = s.cards[id]?.owner;
    if (owner === undefined) continue;
    const definition = peekDefinition(s, id);
    if (!definition?.triggered) continue;
    for (const [index, ability] of definition.triggered.entries()) {
      if (ability.event !== 'onRevealedFromHand' || ability.zone !== 'hand') continue;
      if (ability.eventCard?.self === true && ability.eventCard.other) continue;
      if (ability.eventSource && (causeId === undefined || s.cards[causeId]?.owner !== owner || !matchesEventCard(s, causeId, ability.eventSource))) continue;
      if (ability.condition && !evalCondition(s, id, owner, ability.condition)) continue;
      // 「…時、このカードが必要エナジーを満たしている場合」 — the hand card's own requirement gate, the
      // same read the hand channel applies at its own collection (engine.ts).
      if (ability.handGate === 'energySatisfied' && !energySatisfied(s, owner, id)) continue;
      const key = `${definition.functionalId}:${index}`;
      const used = s.players[owner].handTriggeredUsed?.[key] ?? 0;
      if (ability.oncePerTurn && used >= s.turn) continue;
      if (ability.oncePerTurn) s.players[owner].handTriggeredUsed = { ...(s.players[owner].handTriggeredUsed ?? {}), [key]: s.turn };
      ctx.queue.push(makeTask(s, owner, id, ability.effects));
    }
  }
}

/**
 * 「自分の場の〈X〉の効果によってこのカードが公開され、手札に加わった時」 (KGR-1-041) — the deck→hand
 * arrival whose cause is the printed 「…の効果によって」. Raised where a revealed deck card joins the
 * hand; the arriving cards sit in the hand, so the scan reads their own definitions like the hand and
 * 場外 funnels do, narrowing the cause by owner and filter exactly like the field scan.
 */
function queueDeckToHand(ctx: Context, cards: CardId[], causeId: CardId | undefined): void {
  const s = ctx.state;
  for (const id of cards) {
    const owner = s.cards[id]?.owner;
    if (owner === undefined) continue;
    const definition = peekDefinition(s, id);
    if (!definition?.triggered) continue;
    for (const [index, ability] of definition.triggered.entries()) {
      if (ability.event !== 'onDeckToHand' || ability.zone !== 'hand') continue;
      if (ability.eventSource && (causeId === undefined || s.cards[causeId]?.owner !== owner || !matchesEventCard(s, causeId, ability.eventSource))) continue;
      if (ability.condition && !evalCondition(s, id, owner, ability.condition)) continue;
      const key = `${definition.functionalId}:${index}`;
      const used = s.players[owner].handTriggeredUsed?.[key] ?? 0;
      if (ability.oncePerTurn && used >= s.turn) continue;
      if (ability.oncePerTurn) s.players[owner].handTriggeredUsed = { ...(s.players[owner].handTriggeredUsed ?? {}), [key]: s.turn };
      ctx.queue.push(makeTask(s, owner, id, ability.effects));
    }
  }
}

/**
 * 「…を公開し(てもよい)」 — the public half of a look, in place.
 *
 * The cards stay exactly where the look left them; what becomes new is that the table has seen them
 * (`cardsRevealed`) and that the deck-reveal watchers fire (`queueRevealedFromDeck`). The frame's
 * `didCount` records that the reveal happened, so the printed 「そうした場合、…」 can read it.
 */
function revealLooked(ctx: Context, f: EffectFrame, ids: CardId[]): void {
  f.didCount = ids.length;
  ctx.events.push({ type: 'cardsRevealed', data: { player: f.player, cards: [...ids] } });
  queueRevealedFromDeck(ctx, ids);
}

/**
 * What is placing a card — 「このキャラが自分の〔キャラ・フィールド〕の効果で登場していた場合」 and
 * 「〈X〉の効果で登場していた」 (KMR-2-048/054/057).
 *
 * Recorded on the placement (`FieldCard.entered.causeKind` / `.causeName`), because only the site that
 * places the card knows what is resolving; the printed 〔A・B〕 label asks for the kind and the 〈X〉
 * spelling for the identity. A resolving source that has no definition (never a real card) records
 * nothing, which reads as "no cause".
 */
function causeOf(f: EffectFrame, s: GameState): { causeOwner: PlayerId; causeKind?: 'character' | 'field' | 'event'; causeName?: string } {
  const definition = peekDefinition(s, f.sourceId);
  return definition
    ? { causeOwner: f.player, causeKind: definition.kind, ...(definition.name ? { causeName: definition.name } : {}) }
    : { causeOwner: f.player };
}

/** The field character whose hidden stack holds `id` (a face-down card), if any. */
function hostOfUnder(s: GameState, owner: PlayerId, id: CardId): CardId | undefined {
  for (const line of ['front', 'energy'] as const) {
    for (const slot of s.players[owner][line]) {
      if (slot.faceDown?.includes(id)) return slot.cardId;
    }
  }
  return undefined;
}

function applyOperation(ctx: Context, f: EffectFrame, id: string, operation: CardOperation, amount?: number, line?: 'front' | 'energy', keywords?: Keywords, relative = false, energy?: Energy, duration?: Duration, baseBind?: string, underBind?: string, chooser?: 'self' | 'opponent', faceUp = false, baseFromPeel?: string, faceDownOnly = false, underOnly = false, suppressOnPlay = false, trackSourceDeparture = false, offerLeavePrice = false): boolean {
  const s = ctx.state;
  const player = f.player;
  if (operation === 'readyAp') {
    const index = Number(id.slice(3));
    if (Number.isSafeInteger(index) && s.players[player].ap[index] !== undefined) f.acted = true;
    if (Number.isSafeInteger(index) && s.players[player].ap[index] === 'rested') {
      s.players[player].ap[index] = 'active';
      // 「自分のAPカードを…アクティブにしてもよい。そうした場合、…」 (IMC-1-061) — only a slot that
      // actually transitioned is a ready; the count is the Q509 gate's AP-side record.
      f.readiedAp = (f.readiedAp ?? 0) + 1;
      ctx.events.push({ type: 'apReadied', data: { player, amount: 1 } });
      return true;
    }
    return false;
  }
  const instance = s.cards[id];
  if (!instance) return false;
  f.acted = true;
  const owner = instance.owner;
  const here = findField(s, owner, id);
  const card = here?.card;
  const rememberSourceDeparture = (went: ReturnType<typeof leaveField>): void => {
    if (trackSourceDeparture && card && id === f.sourceId && owner === player
      && (went === 'sideline' || went === 'removal' || went === 'hand')) f.sourceMovedTo = went;
  };
  const definition = getDefinition(s, id);
  // 「このキャラは相手の効果で場を離れない。」 — the effect is refused before it takes the card anywhere.
  // Only a card that is *on the field* can be kept there, only the opponent's effects are refused, and
  // only the operations that actually leave the field are covered: `move` and `rest` stay inside it.
  if (card && LEAVES_FIELD.has(operation)
    && refusesOpponentRemoval(s, id, owner, f.route ?? 'characterEffect', owner !== player)) return false;
  // 「このキャラは相手のキャラの効果やイベントカードの効果で退場しない。」 — the routed *retirement*
  // refusal, which covers 場外 only: the other destinations still work, which is what tells it apart from
  // the 「場を離れない」 check above.
  if (card && owner !== player && operation === 'retire'
    && refusesRetire(s, id, owner, f.route ?? 'characterEffect')) return false;
  // 「自分と相手の場のキャラ全ては、効果で退場しない。」 — the table-wide retirement refusal a
  // player-scope grant installs for the turn (both sides' characters, effect-driven retirements only).
  if (card && operation === 'retire' && allCharsNoRetireByEffect(s)) return false;
  // 「このキャラは[自分と]相手の効果で手札に戻らない。」 — the hand destination alone is refused here
  // (場外 / リムーブエリア / 山札 still work, which is what tells it apart from a refusal to leave the
  // field). The owner axis follows the print: only the 「自分と相手の効果で」 spelling refuses the
  // controller's own effects.
  if (card && operation === 'return'
    && refusesHandReturn(s, id, owner, owner === player)) return false;
  // 「このキャラは相手の効果でレストにならない。」 — only the opponent's effects are refused; the
  // movement phase and the rules are the caller's own business, and the controller's own effects may
  // still rest the card. The 「それは次の1回アクティブにならない」 rider is a *separate* printed half:
  // a refused rest still parks its charge (Q1019/Q1114/Q1052), which the next activation moment spends
  // even though the card never went down.
  if (card && owner !== player && operation === 'rest' && refusesRest(s, id, owner, false, f.sourceId)) {
    if (amount !== undefined) card.cannotActivateCharges = (card.cannotActivateCharges ?? 0) + Math.max(1, amount);
    return false;
  }
  // 「…自身のカードの効果でレストにできない。」 (ARK-1-079) — the owner's *own* effects are the ones
  // refused, the mirror spelling of the line above (`doesNotRest.own`).
  if (card && owner === player && operation === 'rest' && refusesRest(s, id, owner, true, f.sourceId)) {
    if (amount !== undefined) card.cannotActivateCharges = (card.cannotActivateCharges ?? 0) + Math.max(1, amount);
    return false;
  }
  // 「このキャラが場を離れる場合、代わりにこのカードを手札に戻す。」 — a leave redirect. Every operation
  // that would take the card off the field sends it to its owner's hand instead; `return` itself is
  // skipped because the redirect would repeat what it already does. Handled here (before the switch)
  // because several destinations — 山札 / ライフ — stage through `leaveField` and then move the card
  // again, which would undo a redirect applied further down.
  if (card && operation !== 'return' && LEAVES_FIELD.has(operation)
    && activeStatics(s, id, owner).some(m => m.type === 'leaveToHand' && (m.cause === undefined || owner !== player))) {
    const went = leaveField(ctx, owner, id, 'hand', 'leave-redirect');
    rememberSourceDeparture(went);
    return went !== 'stayed';
  }
  switch (operation) {
    case 'retireEndPhase': {
      // 「エンドフェイズ開始時、そのキャラを退場させる」 — scheduled, not immediate: the card stays on
      // the field until this turn's end phase opens (`endAttackPhase` reads the marker).
      if (card) card.retireAtEnd = s.turn;
      break;
    }
    case 'return': {
      if (card) {
        const located = findField(s, owner, id);
        if (located && (located.card.underneath.length || (located.card.faceDown?.length ?? 0) > 0)) {
          (f.returnedStacks ??= {})[id] = { underneath: [...located.card.underneath], faceDown: [...(located.card.faceDown ?? [])] };
        }
        rememberSourceDeparture(leaveField(ctx, owner, id, 'hand', 'effect-return'));
      }
      else {
        // 「ライフを手札に加えた」 happens by two routes — an effect that picks a life card (this one)
        // and a life trigger that resolves to the hand (engine.ts#resolveTrigger). Both must log it:
        // logging only the trigger would make the gate narrower than printed for the effect route.
        const from = zoneOfCard(s, owner, id);
        removeFromZone(s, owner, id);
        s.players[owner].hand.push(id);
        if (from === 'life') logTurnEvent(s, 'lifeToHand', owner, id);
        // 「このカードが自分の効果で自分の場外から手札に加わった時」 (SLG-1-003 族) — the arrival from
        // 場外, raised here because this is the only route that lifts a card out of the discard pile into
        // a hand. The raising effect's own source rides as the cause, so a listener may name it
        // (「〈水篠 旬〉の効果で…加わった場合」 reads the `cause` binding).
        if (from === 'sideline') {
          logTurnEvent(s, 'sidelineToHand', owner, id, { via: 'effect', causeId: f.sourceId });
          ctx.queue.push(...collectTriggered(ctx, owner, 'onSidelineToHand', id, id, { causeId: f.sourceId }));
        }
        ctx.events.push({ type: 'cardReturned', data: { player: owner, cardId: id } });
      }
      break;
    }
    case 'retire': {
      // 「自分はこのターン中、自分の効果でライフエリアにあるカードを場外に置くことができない」 — a
      // player-scope restriction on the *effecting* player's own effects. A life card of that player
      // cannot reach the discard pile by this route while it holds.
      if (!card && f.player === owner && playerStatics(s, f.player).some(m => m.type === 'cannotSendLifeToSideline') && zoneOfCard(s, owner, id) === 'life') return false;
      if (card) {
        const leftBp = currentBP(s, id, owner);
        const stack = id === f.sourceId && (here?.card.faceDown?.length ?? 0) > 0 ? [...here!.card.faceDown!] : undefined;
        // 「[このカードを退場させる]このキャラの下の裏向きのカードを1枚まで手札に加える。」 (BLC-4-034) —
        // the self-retire cost runs first (the pool's cost-tag order), taking the hidden stack to 場外
        // with it; the following sentence still speaks about 「このキャラの下の」 cards, so the stack's
        // identity rides the frame and `takeUnder` reads it back.
        const went = leaveField(ctx, owner, id, 'sideline', 'card-effect', undefined, offerLeavePrice);
        rememberSourceDeparture(went);
        if (went === 'stayed') return false;
        if (stack !== undefined) f.sourceStack = stack;
        if (owner === f.player) {
          f.retiredOwn = (f.retiredOwn ?? 0) + 1;
          (f.retiredIdsOwn ??= []).push(id);
        } else {
          f.retiredOpponent = (f.retiredOpponent ?? 0) + 1;
          (f.retiredIdsOpponent ??= []).push(id);
        }
        (f.retiredBps ??= []).push(leftBp);
        return true;
      }
      else {
        // 「自分のライフエリアから…カードが場外に置かれた時」 — the effect-driven route to the discard pile
        // raises the same watcher the trigger batch raises; the origin has to be read before the move.
        const fromLife = zoneOfCard(s, owner, id) === 'life';
        // 「…の下から裏向きのカードが1枚場外に置かれた時」 — the same reading for a *hidden* card: the
        // host that held it is the event's subject, and both must be read before the removal unmakes
        // the relation.
        const host = zoneOfCard(s, owner, id) === 'under' ? hostOfUnder(s, owner, id) : undefined;
        const fromHand = zoneOfCard(s, owner, id) === 'hand';
        removeFromZone(s, owner, id);
        s.players[owner].sideline.push(id);
        // 「この効果で場外に置いたカード1枚につき」 — a card that is not on a line (a face-down card under
        // a host) still reached 場外 by this effect, which is the fact the count asks about.
        (f.discardedIds ??= []).push(id);
        // The count rides with the identities, the same pair the discard steps write (:3096/3101): without
        // it 「この効果で場外に置いたカードと同じ枚数のカードを引く」 read a hand card's arrival as zero
        // (UA52BT/KJN-1-055, whose 「手札を2枚まで場外に置いてもよい」 compiles to this retire route).
        f.discardedCount = (f.discardedCount ?? 0) + 1;
        // 「手札を…場外に置いてもよい」 (DST-1-008) compiles to this retire route, and a hand card reaching
        // the discard pile is the same departure the discard operation records: without the log entry the
        // card's own 「自分の効果で…置いた」 counts (Q710/Q711) and the onDiscardedFromHand batch never see it.
        if (fromHand) {
          const causeOwner = s.cards[f.sourceId]?.owner;
          logTurnEvent(s, 'discardedFromHand', owner, id, causeOwner === undefined ? {} : { causeOwner, causeId: f.sourceId });
          ctx.queue.push(...collectTriggered(ctx, owner, 'onDiscardedFromHand', id, id, { causeId: f.sourceId }));
        }
        if (fromLife) ctx.queue.push(...collectTriggered(ctx, owner, 'onLifeToSideline', id, id));
        if (host !== undefined) {
          ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToSideline', host, id));
          // 「裏向きのこのカードが…下から場外に置かれた時」 — the departed card's *own* watcher, which no
          // field walk can reach.
          ctx.queue.push(...collectHiddenWatchers(ctx, owner, id));
        }
      }
      break;
    }
    case 'remove': {
      // 「…は自分と相手の効果でリムーブエリアに置くことができない。」 — a broadcast protection that even
      // the controller's own effects must respect (the print names 「自分と相手の効果で」).
      if (card && activeStatics(s, id, owner).some(m => m.type === 'cannotBeRemovedByEffect')) return false;
      // 「このカードが使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く。」 — the card's
      // own resolution is exempt (that placement *is* the use); every other effect's redirects.
      if (removalRedirectsToSideline(s, id, f.sourceId)) {
        if (card) { const went = leaveField(ctx, owner, id, 'sideline', 'card-effect'); rememberSourceDeparture(went); if (went === 'stayed') break; }
        else { removeFromZone(s, owner, id); s.players[owner].sideline.push(id); }
        (f.discardedIds ??= []).push(id);
        break;
      }
      if (card) { const went = leaveField(ctx, owner, id, 'removal', 'card-effect'); rememberSourceDeparture(went); if (went === 'stayed') break; }
      else {
        // A card taken out of a raid stack lives in no zone (`zoneOfCard` answers 'under'); the detach
        // is `removeFromZone`'s own job now (KMR-2-030 removes a stack's base by name, FAM-B reached it
        // through `retire` — see the helper).
        removeFromZone(s, owner, id);
        s.players[owner].removal.push(id);
      }
      // The frame's own record, for 「この効果で(場外から)リムーブエリアに置いたカード1枚につき」 —
      // written here because this is the one route every effect-driven removal passes through.
      (f.removedIds ??= []).push(id);
      // 「このカードが自分の[紫の][特徴：CoMETIK]の効果でリムーブエリアに置かれた時、…」 — the moved
      // card's own watcher. The card is not on the field any more, so the collection reads its
      // definition directly (the same own-card scan the sideline arrivals use); the resolving effect's
      // source rides along as the cause, which the printed 「…の効果で」 narrows.
      ctx.queue.push(...collectTriggered(ctx, owner, 'onRemoved', id, undefined, { causeId: f.sourceId }));
      break;
    }
    case 'removalToSideline': {
      // 「自分のリムーブエリアの〈X〉を4枚以上場外に置く」 (BLC-4-004) — the selected cards come back
      // from the removal area to the discard pile. The card sits in no field slot, so the pile move is
      // the whole of it; the arrival joins the frame's own discard record, the channel the printed
      // follow-ups (「そうした場合、…」) and the energy sums read.
      removeFromZone(s, owner, id);
      s.players[owner].sideline.push(id);
      (f.discardedIds ??= []).push(id);
      break;
    }
    case 'toDeckTop': {
      // 「このターン中に自分の場外のカードが自分の山札に置かれている場合」 — the origin zone before the
      // move: only a card that left 場外 raises the entry (a hand card returned to the deck is a
      // different printed fact).
      const fromZone = zoneOfCard(s, owner, id);
      // `leaveField` takes the card off the line — together with its stack and its 退場時 abilities — and
      // parks it in 場外, because every other caller's destination *is* a pile. The deck is not: the pile
      // copy is removed again before the card is placed, or the same card would sit in two zones at once.
      if (card) { const went = leaveField(ctx, owner, id, 'sideline', 'effect-deck'); if (went !== 'sideline') break; removeFromZone(s, owner, id); }
      else removeFromZone(s, owner, id);
      if (fromZone === 'sideline') logTurnEvent(s, 'sidelineToDeck', owner, id);
      s.players[owner].deck.unshift(id); noteDeckTop(s.players[owner]);
      // 「…を相手の山札の上に表向きで置く」 — the placed card is the deck's public top. Placing a card
      // face-down on top (the ordinary reading) drops any earlier mark instead, which the reader sees by
      // comparing the id with `deck[0]`.
      if (faceUp) s.players[owner].deckTopFaceUp = id;
      break;
    }
    case 'toDeckBottom': {
      // The same origin reading as the deck-top sibling above.
      const fromZone = zoneOfCard(s, owner, id);
      if (card) { const went = leaveField(ctx, owner, id, 'sideline', 'effect-deck'); if (went !== 'sideline') break; removeFromZone(s, owner, id); }
      else removeFromZone(s, owner, id);
      if (fromZone === 'sideline') logTurnEvent(s, 'sidelineToDeck', owner, id);
      s.players[owner].deck.push(id);
      // 「この効果で山札の下に置いたカードと同じ枚数のカードを引く」 — the frame remembers what this
      // effect moved, because the deck's bottom records nothing.
      f.deckBottomIds = [...(f.deckBottomIds ?? []), id];
      break;
    }
    // 「相手の山札の上か下の相手が選んだ方に置く」 — the card stays where it is until its owner answers;
    // the placement itself happens on the answer (see `chooseEffect`).
    case 'toDeckTopOrBottom': {
      // The card may sit anywhere — a hand card (「自分の手札を1枚自分の山札の上か下に置く」, DST-1-061)
      // as well as a line card: the answer handler routes both through `findField` / `removeFromZone`.
      if (card || s.cards[id] !== undefined) {
        f.stage = 'deckChoice';
        f.selections ??= {};
        f.selections.__deckChoice = [id];
        // The card's owner is the one the print names (「相手が選んだ方」 from the effect's view); the
        // printed 「自分が選んだ方」 override hands the question to the effect's controller instead.
        request(ctx, f, 'topBottom', '选择放到其牌库顶或牌库底', 1, 1, ['top', 'bottom'], chooser === 'self' ? f.player : owner);
        return true;
      }
      return false;
    }
    case 'toLife': {
      // The same as the two deck destinations: the life area is not the pile `leaveField` parked it in.
      if (card) { const went = leaveField(ctx, owner, id, 'sideline', 'effect-life'); if (went !== 'sideline') break; removeFromZone(s, owner, id); }
      else removeFromZone(s, owner, id);
      // 「…を相手のライフエリアに表向きで置く」 — the placed life card is public; an ordinary placement
      // (a damage flip, an effect that moves a card there) is face down like every other life card.
      addToLife(s, owner, [id], faceUp);
      break;
    }
    case 'rest': if (card) {
      // 「アクティブからレストになった」 names the transition, so an already-rested card logs nothing:
      // resting it again is not the fact the printed wording asks about.
      if (card.active) {
        // 「この効果でレストにしたカードの必要エナジーの合計」 — the identity of what *this effect*
        // rested is only knowable here; once rested, the card is indistinguishable from one that was
        // already resting.
        (f.restedIds ??= []).push(id);
        // The cause's owner rides along: 「自分の効果で…レストになった」 vs an opponent's effect rest is
        // exactly the `ownEffect` qualifier's question, and the record is the only place it is knowable.
        logTurnEvent(s, 'restedByEffect', owner, id, { causeOwner: f.player, ...(here ? { line: here.line } : {}) });
        // The cause-agnostic record, for 「このターン中に…レストになっている」.
        logTurnEvent(s, 'rested', owner, id);
        // 「自分か相手の効果でアクティブのこのキャラがレストになった時、…」 — the moment is queued the same
        // way a retirement is: the effect that rested the card finishes resolving first. The line the
        // card was on rides along, so a watcher narrowed to 「自分のフロントLの…」 can match it (the
        // card may move before the queue drains).
        ctx.queue.push(...collectTriggered(ctx, owner, 'onRestedByEffect', id, undefined, { ...(here ? { line: here.line } : {}), causeId: f.sourceId }));
      }
      card.active = false;
      // 「それは次の1回アクティブにならない」 is a *printed rider* on the rest — the compiler writes it as
      // the step's `amount`. A plain 「レストにする」 (no amount) grants no charge (round-103 class H:
      // BLC-1-031/TRK-1-027's else-branch handed the foe a free skip).
      if (amount !== undefined) card.cannotActivateCharges = (card.cannotActivateCharges ?? 0) + Math.max(1, amount);
    } break;
    // 「レイド状態の上のカードを1枚手札に戻す」 — the STACK peels: the top card (the bound one) leaves for
    // the hand while the base card takes the slot over. `leaveField` cannot be used here — it sends
    // `underneath` along, which is the whole character leaving, not a peel.
    case 'raidTopToHand': {
      if (!card || !card.underneath.length || !here) break;
      // 「このキャラが(自分の)場から手札に戻った時」 — the peel's destination is the hand and the top is
      // the card the slot was, so the move owns the return moment. Its own ability's guards read the
      // board the card is still on (the same pre-move read `returnEffects` makes in `leaveField`), and
      // the field watchers are collected after the slot settles, below.
      const peelDefinition = peekDefinition(s, id);
      const peelReturn = peelDefinition !== undefined && !effectsSuppressed(s, id) ? peelDefinition.triggered ?? [] : [];
      const ownReturn = [
        ...peelReturn,
        ...(card.grantedAbilities ?? []).filter(grant => grant.expiresTurn >= s.turn).map(grant => grant.ability),
      ].filter(a => a.event === 'onReturnedToHand' && a.scope !== 'anyOfTheirs' && !a.eventCard?.other)
        .flatMap(a => (a.condition && !evalCondition(s, id, owner, a.condition) ? [] : a.effects));
      const baseId = card.underneath.pop()!;
      const stack = s.players[owner];
      stack.hand.push(id);
      // A peel is neither a 退場 nor a 登場 (Q544/Q1098/Q1762): the departing top's printed and granted
      // 【退場時】 stay silent even though the card leaves the field — it returns to the *hand*, and the
      // peel never retires it. (An earlier reading resolved them here anyway, against that FAQ.)
      // Q1100: the base comes back in its printed state — the effects the raider received while in raid
      // state are voided. The slot entry is rebuilt the way `topToSideline` rebuilds it, keeping only the
      // active/rested state (Q1099) and the line's own counters; the remainder of the stack and the
      // face-down pile stay with the slot.
      const idx = s.players[owner][here.line].indexOf(card);
      if (idx >= 0) s.players[owner][here.line][idx] = {
        cardId: baseId, instanceId: `${baseId}@peel#${s.revision}`,
        underneath: card.underneath, active: card.active, attacksThisTurn: card.attacksThisTurn, blocksThisTurn: card.blocksThisTurn, bpModifiers: [],
        ...(card.faceDown?.length ? { faceDown: [...card.faceDown] } : {}),
      };
      ctx.events.push({ type: 'cardReturned', data: { player: owner, cardId: id, reason: 'card-effect' } });
      // The return moment itself: the card's own ability (its guards were read above) and the two sides'
      // watchers, the same way `leaveField`'s hand destination reads them. The 退場時/登場時 moments stay
      // silent for a peel (Q544/Q1098/Q1762) — only the return is a real moment of this move.
      if (ownReturn.length) ctx.queue.push(makeTask(s, owner, id, ownReturn));
      for (const task of collectTriggered(ctx, owner, 'onReturnedToHand', id, undefined, { line: here.line })) ctx.queue.push(task);
      for (const task of collectTriggered(ctx, otherOf(owner), 'onReturnedToHand', id, undefined, { crossSide: true, line: here.line })) ctx.queue.push(task);
      break;
    }
    // 「このキャラはアクティブにならない」 (as long as its own condition holds) refuses the effect route
    // the same way it refuses the ready step. 「自分の効果以外でアクティブにならない」 refuses the
    // opponent's effects but lets the controller's own effects through.
    case 'activate': {
      if (!card) return false;
      const forbids = staticForbids(s, id, owner);
      if (forbids.activate) return false;
      if (forbids.activateOwnOnly && f.player !== owner) return false;
      if (!card.active) {
        // 「アクティブにする効果を受けた時に1回だけレストのままにする。」 (Q394/Q797/Q102/Q1420) — the
        // activation *effect* is absorbed: one charge is spent and the card stays rested, with no
        // transition and no 「アクティブになった時」 watcher (the same consumption the ready step makes
        // in `activateField`).
        if ((card.cannotActivateCharges ?? 0) > 0) { card.cannotActivateCharges = card.cannotActivateCharges! - 1; break; }
        card.active = true;
        // 「この効果でカードを3枚以上アクティブにした場合」 — the identity of what *this effect* stood up,
        // recorded before the watcher is raised just as `restedIds` is recorded at the rest site.
        (f.activatedIds ??= []).push(id);
        // 「レストのこのキャラが効果でアクティブになった時」 — the cause the print names, recorded before
        // the transition's own watcher is raised so the gate reads this activation.
        logTurnEvent(s, 'activatedByEffect', owner, id);
        ctx.queue.push(...collectTriggered(ctx, owner, 'onActivated', id, undefined, { activation: 'effect' }));
      }
      break;
    }
    case 'bp':
      // 「相手のキャラの効果で〔…BPをマイナスされない〕。」 (AOT-2-028) — the routed spelling of the
      // immunity asks where this operation comes from: the frame's own source card, an opponent's, and
      // a character (an event card's or a trigger's effect is a different route the print excludes).
      if (card && (amount ?? 0) < 0
        && refusesBpMinusFrom(s, id, owner, enemyCharacterEffect(s, f, owner))) break;
      // 「相手の効果で〔このキャラが場を離れるか、このキャラのBPがマイナスされる〕場合、代わりにこの
      // キャラをエナジーLに移動させてもよい。」 (KMY-P-002) — the penalty's own offer: an opponent's
      // effect is about to lower the carrier's BP while it holds the relocation treatment and the energy
      // line has room, so the owner may decline it for a move. The question parks the frame and is
      // answered by the carrier's owner, who may be the opponent of the effect's controller.
      if (card && (amount ?? 0) < 0 && f.player !== owner && !s.pending
        && activeStatics(s, id, owner).some(m => m.type === 'energyMoveSubstitute')
        && s.players[owner].energy.length < lineCapacity(s, owner, 'energy')
        && !staticForbids(s, id, owner).move) {
        f.stage = 'bpMinusSubstitute';
        f.selections ??= {};
        f.selections.__bpMinus = [id, String(amount ?? 0), duration ?? ''];
        request(ctx, f, 'cards', '可以改为移动到能量线代替受到 BP 削减（可不选）', 0, 1, [id], owner);
        return true;
      }
      // A printed period longer than 「このターン中」 rides on the step (「次の自分のターン開始時まで、
      // BP+3000」), and the modifier expires on the turn `expiryOf` names rather than at this turn's end.
      // The period is read from the *effect's user* (类AZ, Q-family): 「自分のターン」 in a duration names
      // the caster's turn, not the target card's owner's — a cross-side penalty (「相手のキャラは次の
      // 自分のターン開始時まで」) has to cover the opponent's turn, which anchoring on the target's owner
      // got wrong (it collapsed to 「このターン中」). Self-targets are unchanged (owner === f.player).
      if (card) {
        // 「このキャラはこのバトル中、BP+2000。」 — an `attackEnd` period is scoped to the *battle*,
        // not the turn: the battle's own number rides the entry (the same `expiresBattle` the grant
        // channels carry), and every BP read drops it once that battle is over.
        const expiresBattle = duration === 'attackEnd' ? s.battle?.seq : undefined;
        card.bpModifiers.push({ amount: amount ?? 0, expiresTurn: duration ? expiryOf(ctx, f.player, duration) : s.turn, ...(expiresBattle !== undefined ? { expiresBattle } : {}) });
      }
      // 「このキャラのBPがプラスされた時」 — the moment the increase *lands*. Only a raise counts (a
      // penalty is the other direction), and only the effect route fires it: a continuous static is
      // recomputed, never applied, so nothing "happens" for a watcher to answer. The minus sibling
      // (「このキャラがBPをマイナスする効果を受けた時」) is raised here for the other sign.
      if (card && (amount ?? 0) > 0) ctx.queue.push(...collectTriggered(ctx, owner, 'onBpIncreased', id));
      if (card && (amount ?? 0) < 0) ctx.queue.push(...collectTriggered(ctx, owner, 'onBpDecreased', id));
      // 「この効果で相手のキャラのBPが0以下になった場合、…」 (EVA-1-042) — the frame's own record of
      // the characters this effect's penalties brought to 0 or below, read by the printed follow-up.
      if (card && (amount ?? 0) < 0 && getBP(s, card) <= 0) (f.bpZeroIds ??= []).push(id);
      break;
    case 'impact': if (card) (card.impactModifiers ??= []).push({ value: amount ?? 1, additive: relative, expiresTurn: s.turn }); break;
    case 'damage': if (card && (amount ?? 1) !== 0) (card.keywordModifiers ??= []).push({ keywords: { damage: amount ?? 1 }, ...(relative ? { relative: true } : {}), expiresTurn: s.turn }); break;
    case 'evade': if (card) (card.evadeModifiers ??= []).push({ maxBP: amount ?? 0, expiresTurn: s.turn }); break;
    // 「相手は選ばれたキャラ以外のキャラでこのアタックをブロックできない。」 (KGD-1-044) — the chosen card
    // alone may block the *open* battle; the record rides the battle (not the slot) because the
    // restriction is the attack's own and ends with it, and `block`'s validation reads it back.
    case 'blockOnly': if (s.battle && id) s.battle.onlyBlockerId = id; break;
    case 'checkmate': if (card) {
      card.bpModifiers.push({ amount: amount ?? 2000, expiresTurn: s.turn });
      if (fields(s, player).some(c => getDefinition(s, c.cardId).name === 'ルルーシュ・ランペルージ')) (card.impactModifiers ??= []).push({ value: 1, additive: true, expiresTurn: s.turn });
    } break;
    case 'move': {
      // 「このキャラは移動できない。」 refuses both the movement phase and an effect's `move`, which is
      // why the check lives here as well as in `engine.ts#move`. The owner-scoped 「相手の効果で…移動せず」
      // (YYH-1-027) refuses only the opponent's effects: the frame's player decides.
      if (card) {
        const forbids = staticForbids(s, id, owner);
        if (forbids.move || (forbids.moveOpponentOnly && f.player !== owner)) return false;
      }
      // 「このキャラを別のラインに移動させる」 — a step that names no destination moves the card to the
      // *other* line, the only line it is not on. No compiled definition emits a destination-less move
      // otherwise, so the reading is opt-in.
      const dest = line ?? (here ? (here.line === 'front' ? 'energy' : 'front') : undefined);
      // 「このカードはエナジーLに〔登場・移動〕できず」 — the same refusal for the destination, read here
      // because an effect may move a card onto the energy line without any movement-phase action.
      if (card && dest === 'energy' && staticImmunity(s, id, owner).noEnergy) return false;
      // 「このカードはフロントLに〔登場・移動〕できない」 — the front-line sibling for effect moves
      // (drawing a swap'ed placement past it was round-103 RC-04 / Q1967). The reminder spelling's
      // carve-out (「このカードの[起動メイン]以外で」) is read here, not at placement.
      if (card && dest === 'front' && frontMoveForbidden(s, id, owner, f.player, f.sourceId)) return false;
      // The line's capacity is read through `lineCapacity` like every other placement path: a literal
      // four ignored a 「置けるカードの枚数がN枚減る」 in play, so an effect could move a card onto a
      // shortened line.
      if (card && dest && here!.line !== dest) {
        if (s.players[owner][dest].length < lineCapacity(s, owner, dest)) {
          effectLineMove(ctx, f, id, owner, here!.line, dest);
        } else if (s.players[owner][dest].length) {
          // 「（移動させる時に…空きがない場合、…カードを1枚選んでリムーブエリアに置いてから
          // 移動させる）」 — the overflow handling printed as a reminder on 17 cards: the line's owner
          // picks one of its cards for the removal area, and the move completes onto the freed slot.
          // The chooser is the line's owner (the prints name them 「相手は」 / 「そのカードがある場の
          // プレイヤーは」 — for an effect moving the opponent's card they are the same player).
          f.stage = 'moveFullLine';
          f.selections ??= {};
          f.selections.__moveFull = [id];
          request(ctx, f, 'cards', '移动目标战线已满：该战线的持有者选择 1 张卡置于移除区', 1, 1, lineOverflowCandidates(s, f, owner, dest, id), owner);
          return true;
        }
      }
      break;
    }
    case 'deploy': case 'deployRested': {
      if (card || definition.kind === 'event') return false;
      // 「このキャラが自分の場にある場合、自分の場に〈X〉は登場できない。」 — the field-side refusal the
      // play and raid actions read, honoured by the effect route as well.
      if (deployForbidden(s, owner, id)) return false;
      // A field card's home is the energy line (the play action refuses any other line, and
      // `deployTaken` reads the same; Q1670/Q2082) — so a printed 「自分の場に」 arrival places it
      // there rather than on the front line the bare 場 spelling defaults to.
      // An *unqualified* 「自分の場に」 arrival of a character offers the line the same way the play
      // action's `to` does (Q1059/Q819/Q820/Q2072): front or energy, minus whichever line the card's
      // own statics close. Only a print that names the line skips the question.
      let target: 'front' | 'energy';
      if (definition.kind === 'field') target = 'energy';
      else if (line !== undefined) target = line;
      else {
        const immunity = staticImmunity(s, id, owner);
        const lines: ('front' | 'energy')[] = [...(immunity.noFront ? [] : ['front' as const]), ...(immunity.noEnergy ? [] : ['energy' as const])];
        if (lines.length === 0) return false;
        if (lines.length === 1) target = lines[0]!;
        else {
          f.stage = 'deployLine';
          f.selections ??= {};
          f.selections.__deployLine = [id, operation];
          // The chooser is the card's owner — the player whose field receives it (「相手は自身の…に
          // 登場させる」 answers for the opponent, the ordinary 「自分の場に」 for the controller).
          request(ctx, f, 'option', '选择登场战线：front = 前线，energy = 能量线', 1, 1, lines, owner);
          return true;
        }
      }
      // 「このカードはエナジーLに〔登場・移動〕できず」 — an effect placement onto the energy line respects
      // the same refusal the play action carries.
      if (target === 'energy' && staticImmunity(s, id, owner).noEnergy) return false;
      // 「このカードはフロントLに登場できず」 — placement is closed outright; the reminder spelling's
      // carve-out only ever covers 移動, so the plain `noFront` reading is the right one here.
      if (target === 'front' && staticImmunity(s, id, owner).noFront) return false;
      // A full line is not a silent trip to 場外: the placer picks one of the line's cards for the
      // removal area and the placement lands on the freed slot (Q819/Q1024/Q987, the same
      // 「1枚リムーブエリアに置き」 step the play route's `ensureRoom` replace carries).
      if (s.players[owner][target].length >= lineCapacity(s, owner, target)) {
        f.stage = 'deployFullLine';
        f.selections ??= {};
        f.selections.__deployFull = [id, operation, target];
        // Q875: the cards *this effect* brings in are not valid room-makers — 「この効果で登場させる
        // カード以外のカードをリムーブエリアに置いてそれぞれ登場させます」. The placements already made
        // are the sequential stand-ins for the not-yet-entered ones (`f.deployedIds`). A line made only
        // of this effect's own placements (unreachable in the corpus) keeps the full pool so the
        // question stays answerable.
        request(ctx, f, 'cards', '登场战线已满：选择该战线 1 张卡置于移除区', 1, 1, lineOverflowCandidates(s, f, owner, target, id), owner);
        return true;
      }
      // Where it came from has to be read *before* the move, and the placement is an effect's doing
      // by construction — this branch only runs while an effect is resolving.
      const from = zoneOfCard(s, owner, id);
      removeFromZone(s, owner, id);
      // 「このキャラは登場時アクティブで登場する」 — the card's own static answers over the placement's
      // own default (Q1964), the same precedence the play route gives it (engine.ts:1512).
      s.players[owner][target].push({ cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`, entered: { from, by: 'effect', turn: s.turn, ...causeOf(f, s) }, underneath: [], active: operation === 'deploy' || staticEnterActive(s, id, owner) === true, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [] });
      logTurnEvent(s, 'entered', owner, id, { via: 'effect', from, causeOwner: f.player });
      clearEnteredDiscounts(s, owner, id);
      // 「この効果で〈X〉を登場させた場合、そのキャラを…」 — the placement is recorded on the resolving
      // frame, the only place that can say *this effect* brought the card in.
      f.deployedIds = [...(f.deployedIds ?? []), id];
      // The entered card rides as the watcher's *subject*, so an 「登場した…キャラ」 follow-up reaches it
      // through the `E` binding (KMR-2-028; the hand channel has always bound it this way).
      if (f.deploymentBatch?.phase !== 'place') ctx.queue.push(...collectTriggered(ctx, owner, 'entered', id, id));
      ctx.events.push({ type: 'cardDeployed', data: { player: owner, cardId: id, destination: target } });
      // 「…を登場させる」 starts the placed card's own [登場時] (Q478 — GNT-1-006's own FAQ), the same
      // reading the raid leg makes below; a print that swallows it (「この効果で登場した…の[登場時]は
      // 発動しない」) rides as `suppressOnPlay`, which `normalizeSteps` puts on this step.
      const entrySteps = suppressOnPlay ? [] : placedEntrySteps(s, owner, definition);
      if (entrySteps.length && !suppressOnPlay) {
        const queued = makeEntryTask(s, owner, id, entrySteps);
        setQueue(f, [...(f.queue?.effects ?? []), queued]);
      }
      break;
    }
    case 'raid': {
      // 「…を自分の場にレストで登場させるかレイドさせる」 — the raid leg of an effect's either/or: the chosen
      // card is placed as a raid *top* onto the chosen base, for free (nothing is paid for an effect's
      // raid), and the placement counts as a *use* so 「APを支払わずに使用している」 sees it.
      // `baseBind` may be the literal `'source'` (「…を1枚このキャラにレイドさせてもよい」): the base is
      // the card whose ability is resolving, which is never one of its own selections.
      // 「…選んだキャラのレイド元のカードにレイドさせる」 — the base is not a binding but the card a
      // *peel* uncovered (`peelBases`): the top of the named card went to 場外 and the follow-up raids
      // the hand card onto the base that stayed behind.
      const baseId = baseFromPeel !== undefined
        ? (f.selections?.[baseFromPeel] ?? []).map(chosen => f.peelBases?.[chosen]).find((candidate): candidate is CardId => candidate !== undefined)
        : baseBind === 'source' ? f.sourceId : baseBind ? (f.selections?.[baseBind] ?? [])[0] : undefined;
      if (baseId === undefined || baseId === id) return false;
      if (deployForbidden(s, owner, id)) return false;
      const here = findField(s, owner, baseId);
      if (!here || !raidBaseEligible(s, owner, id, baseId)) return false;
      const target = effectRaidLine(ctx, f, id, baseId, line);
      if (target === undefined) return s.pending !== null;
      let from: NonNullable<FieldCard['entered']>['from'] = 'hand';
      // 「レイド状態のこのキャラの一番上のカードを…レイドさせてもよい」 — the raider is already on the
      // field, stacked on a base. It moves onto the new base as a re-raid: per the FAQ (Q1185–Q1190) the
      // old base stays on the field, inheriting the stack's active/rested state (Q1187) with every
      // effect the raid card had received voided (Q1188/Q1189); the revealed base's 【登場時】 does not
      // fire (Q1186), while the moving card's own 【登場時】 runs again (Q1190).
      if (card) {
        const slot = findField(s, owner, id);
        if (!slot || slot.card.underneath.length === 0) return false;
        // The revealed base carries no `entered` record: the RAID collapsed it into an id, so its entry
        // history is gone and inventing one would let an entrant-counting condition see a card that may
        // not have entered this turn. (A deliberate narrow reading — the base reads as "no record".)
        const left: FieldCard = {
          cardId: slot.card.underneath[0]!, instanceId: `${slot.card.underneath[0]}@${s.revision}#${ctx.events.length}`,
          underneath: slot.card.underneath.slice(1),
          active: slot.card.active, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
        };
        const raidedLen = ctx.queue.length;
        queueRaided(ctx, owner, baseId, id);
        s.players[owner][slot.line].splice(s.players[owner][slot.line].indexOf(slot.card), 1);
        s.players[owner][here.line].splice(s.players[owner][here.line].indexOf(here.card), 1);
        const moved: FieldCard = {
          cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`, entered: { from: 'hand', by: 'effect', turn: s.turn, raid: true, ...causeOf(f, s) },
          underneath: [baseId], active: true, attacksThisTurn: slot.card.attacksThisTurn, blocksThisTurn: slot.card.blocksThisTurn, bpModifiers: [],
          ...(slot.card.faceDown?.length || here.card.faceDown?.length ? { faceDown: [...(slot.card.faceDown ?? []), ...(here.card.faceDown ?? [])] } : {}),
        };
        s.players[owner][target].push(moved);
        s.players[owner][slot.line].push(left);
        for (const task of ctx.queue.slice(raidedLen)) {
          if (task.sourceId === id) task.sourceInstance = moved.instanceId ?? moved.cardId;
        }
        f.deployedIds = [...(f.deployedIds ?? []), id];
        logTurnEvent(s, 'entered', owner, id, { via: 'effect', raid: true, from: 'hand', causeOwner: f.player });
        ctx.queue.push(...collectTriggered(ctx, owner, 'onRaid', id, id));
        ctx.events.push({ type: 'raidPlayed', data: { player: owner, cardId: id, baseId } });
        const reSteps = suppressOnPlay ? [] : [...placedEntrySteps(s, owner, definition), ...(definition.onRaid ?? [])];
        // 「この効果で登場した…キャラの[登場時]は発動しない」 — the placement this step makes was
        // printed to swallow the raider's own [登場時]/[レイド] (Q1190 says they would otherwise run).
        if (reSteps.length && !suppressOnPlay) {
          const queued = makeEntryTask(s, owner, id, reSteps);
          setQueue(f, [...(f.queue?.effects ?? []), queued]);
        }
        break;
      }
      // The raider is in 手札 or 場外, so its departure zone is recorded rather than assumed.
      from = zoneOfCard(s, owner, id);
      removeFromZone(s, owner, id);
      logTurnEvent(s, 'used', owner, id, { free: true, raid: true, via: 'effect', usedFrom: from === 'sideline' ? 'sideline' : 'hand' });
      const raidedLen = ctx.queue.length;
      queueRaided(ctx, owner, baseId, id);
      s.players[owner][here.line].splice(s.players[owner][here.line].indexOf(here.card), 1);
      // The base's hidden stack travels with the slot, exactly as it does on the re-raid route above:
      // the base card was carrying these face-down cards, and dropping them here would send them out of
      // every zone at once (the conservation invariant refuses the whole command).
      const top: FieldCard = {
        cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`, entered: { from, by: 'effect', turn: s.turn, raid: true, ...causeOf(f, s) },
        underneath: [baseId], active: true, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
        ...(here.card.faceDown?.length ? { faceDown: [...here.card.faceDown] } : {}),
      };
      s.players[owner][target].push(top);
      for (const task of ctx.queue.slice(raidedLen)) {
        if (task.sourceId === id) task.sourceInstance = top.instanceId ?? top.cardId;
      }
      logTurnEvent(s, 'entered', owner, id, { via: 'effect', raid: true, from, causeOwner: f.player });
      // An effect-driven raid is a placement this effect made, the same frame fact the deploy branch records.
      f.deployedIds = [...(f.deployedIds ?? []), id];
      if (f.deploymentBatch?.phase !== 'place') {
        ctx.queue.push(...collectTriggered(ctx, owner, 'entered', id, id));
        ctx.queue.push(...collectTriggered(ctx, owner, 'onRaid', id, id));
      }
      ctx.events.push({ type: 'raidPlayed', data: { player: owner, cardId: id, baseId } });
      // The raider's own 登場時/レイド abilities run after the current effect, as their own task (the
      // card's text speaks about itself).
      const steps = suppressOnPlay ? [] : [...placedEntrySteps(s, owner, definition), ...(definition.onRaid ?? [])];
      if (steps.length && !suppressOnPlay) {
        const queued = makeEntryTask(s, owner, id, steps);
        setQueue(f, [...(f.queue?.effects ?? []), queued]);
      }
      break;
    }
    case 'toUnder': {
      // Face-down cards placed under the effect source (「このキャラの下に置く」), or under a *chosen*
      // host — 「自分の場の〈奈落〉1枚の下に置く」 names the host through the frame selection in
      // `underBind` (the same channel `millTop.underBind` uses). With the binding unset or its answer
      // empty the instruction has no host and the card stays where it was.
      const hostId = underBind ? (f.selections?.[underBind] ?? [])[0] : f.sourceId;
      const holder = hostId !== undefined ? findField(s, s.cards[hostId]?.owner ?? player, hostId) : undefined;
      if (!holder) return false;
      // A card cannot be placed under itself: the self-host spelling (「このキャラの下に」) would otherwise
      // splice the host off its own line and push it into its own hidden stack, where it is in no zone.
      if (id === hostId) return false;
      {
        // 「手札から置いた場合」 — the origin zone, read before the card leaves it; once the card is
        // under the host nothing can tell where it came from. The host rides along, so the
        // 「この効果でこのキャラの下に」 spelling can ask whether *this* card was the host.
        if (zoneOfCard(s, owner, id) === 'hand') {
          (f.underFromHandIds ??= []).push(id);
          (f.underFromHandHosts ??= []).push(hostId!);
        }
        const placed = findField(s, owner, id);
        if (placed) {
          const went = leaveField(ctx, owner, id, 'sideline', 'effect-under');
          // `'stayed'`: the printed leave price was paid (「支付此卡下方 1 张里侧卡后留下」) — the card
          // keeps its line and is *not* placed under the host. A redirect (e.g. `leaveToHand`) also
          // wins over the placement, like the `effect-deck` routes read their own exit.
          if (went !== 'sideline') return false;
          // The card itself belongs under the host, not in 場外: undo the borrow's parking step. Its
          // RAID base and hidden stack stay where `leaveField` sent them.
          removeFromZone(s, owner, id);
        } else {
          removeFromZone(s, owner, id);
        }
        (holder.card.faceDown ??= []).push(id);
        // The same release as `moveUnder`: `actSource` on an event card (NIK-2-018) places the card the
        // frame is holding, and the end-of-frame park must not add it to 場外 a second time.
        if (id === f.eventCard) delete f.eventCard;
        ctx.events.push({ type: 'cardPlacedUnder', data: { player, cardId: id } });
      }
      break;
    }
    case 'loseEffects': if (card) { card.effectsLostUntilTurn = duration ? expiryOf(ctx, f.player, duration) : s.turn; markAttackEndLapse(card, 'effectsLost', duration === 'untilOpponentAttackEnd'); } break;
    // 「[自分のターン中]の効果を失わせる」 (RNK-1-072/089) — the narrower loss: only the abilities the printed
    // tag gates stop applying, read where that condition evaluates (`Condition.turnOf`).
    case 'loseSelfTurnEffects': if (card) card.selfTurnEffectsLostUntilTurn = duration ? expiryOf(ctx, f.player, duration) : s.turn; break;
    // 「それは…まで、アクティブにならない。」 — read by `staticForbids.activate` beside the static form, so
    // the ready steps and every effect route refuse the same way.
    // Every duration here is read from the *caster's* side (类AZ): 「自分のターン」/「相手のターン」 name
    // the caster's turns — the target's owner may be the opponent — so the expiry is computed from the
    // frame's player, as the 「次の相手のアタックフェイズ終了時まで」 case always did.
    case 'cannotActivate': if (card) { card.cannotActivateUntilTurn = duration ? expiryOf(ctx, f.player, duration) : s.turn; markAttackEndLapse(card, 'cannotActivate', duration === 'untilOpponentAttackEnd'); } break;
    case 'topToSideline': {
      // 「レイド状態の…の一番上のカードを場外に置く」 — the raider leaves, its base stays: the top card
      // retires *alone* and the stack beneath it (the base plus anything under it) becomes the line's
      // card again, inheriting the slot's own state. A card with no stack is simply the top card.
      if (!card) return false;
      // A peel is still a retirement of the top card: the unconditional 「退場しない」 refusals block it,
      // and the routed opponent-removal guard above covers the rest via `LEAVES_FIELD`.
      if (staticForbids(s, id, owner).retire) return false;
      const slot = here!;
      const [baseId, ...deep] = card.underneath;
      const inherits = { active: card.active, attacksThisTurn: card.attacksThisTurn, blocksThisTurn: card.blocksThisTurn };
      const faceDown = card.faceDown ?? [];
      // Detach before the retirement runs: `leaveField` sends the whole stack it finds to 場外 with the
      // card, which would drag the very base the print keeps on the line.
      card.underneath = [];
      card.faceDown = [];
      // 「そのキャラのレイド元のカードに…を与える」 — the base this peel uncovers, remembered under the
      // *top's* id (the binding the sentence named) so the following grant can name it.
      if (baseId !== undefined) (f.peelBases ??= {})[id] = baseId;
      // 「この効果で場外に置いたカードとカードナンバー/必要エナジーが異なる〈X〉」 — the peeled card
      // joins the frame's own discard record, which is the only place the follow-up can read what this
      // effect just sent to 場外.
      (f.discardedIds ??= []).push(id);
      leaveField(ctx, owner, id, 'sideline', 'raid-top');
      if (baseId !== undefined) {
        s.players[owner][slot.line].push({
          cardId: baseId, instanceId: `${baseId}@${s.revision}#${ctx.events.length}`,
          underneath: deep, ...inherits, bpModifiers: [],
          ...(faceDown.length ? { faceDown: [...faceDown] } : {}),
        });
      }
      break;
    }
    case 'topToDeckBottom': {
      // 「レイド状態の上のこのカードを自分の山札の下に置く」 — the same peel as `topToSideline`, with the
      // departing top card reaching its owner's deck bottom: `leaveField` parks it in 場外 with all its
      // bookkeeping (retire refusals, 退場時 abilities), and the pile copy is moved on to the deck.
      if (!card) return false;
      if (staticForbids(s, id, owner).retire) return false;
      const slot = here!;
      const [baseId, ...deep] = card.underneath;
      const inherits = { active: card.active, attacksThisTurn: card.attacksThisTurn, blocksThisTurn: card.blocksThisTurn };
      const faceDown = card.faceDown ?? [];
      card.underneath = [];
      card.faceDown = [];
      leaveField(ctx, owner, id, 'sideline', 'raid-top');
      removeFromZone(s, owner, id);
      s.players[owner].deck.push(id);
      if (baseId !== undefined) {
        s.players[owner][slot.line].push({
          cardId: baseId, instanceId: `${baseId}@${s.revision}#${ctx.events.length}`,
          underneath: deep, ...inherits, bpModifiers: [],
          ...(faceDown.length ? { faceDown: [...faceDown] } : {}),
        });
      }
      break;
    }
    case 'topToDeckTop': {
      // 「レイド状態のこのキャラの一番上のカードを自分の山札の上に置く。」 (RNK-1-059) — the deck-*top*
      // sibling of `topToDeckBottom`, otherwise identical: `leaveField` parks the departing top card in
      // 場外 with all its bookkeeping (retire refusals, 退場時 abilities) and the pile copy is moved on to
      // the deck — unshifted here, so it becomes the next card drawn.
      if (!card) return false;
      if (staticForbids(s, id, owner).retire) return false;
      const topSlot = here!;
      const [topBaseId, ...topDeep] = card.underneath;
      const topInherits = { active: card.active, attacksThisTurn: card.attacksThisTurn, blocksThisTurn: card.blocksThisTurn };
      const topFaceDown = card.faceDown ?? [];
      card.underneath = [];
      card.faceDown = [];
      leaveField(ctx, owner, id, 'sideline', 'raid-top');
      removeFromZone(s, owner, id);
      s.players[owner].deck.unshift(id); noteDeckTop(s.players[owner]);
      if (topBaseId !== undefined) {
        s.players[owner][topSlot.line].push({
          cardId: topBaseId, instanceId: `${topBaseId}@${s.revision}#${ctx.events.length}`,
          underneath: topDeep, ...topInherits, bpModifiers: [],
          ...(topFaceDown.length ? { faceDown: [...topFaceDown] } : {}),
        });
      }
      break;
    }
    case 'bottomToField': {
      // 「レイド状態のこのキャラの一番下のカードを自分の場にアクティブで登場させる」 — the deepest card
      // of the stack leaves it and enters the field on its own, standing up; the rest of the stack stays.
      // A stack with nothing underneath has no bottom to move.
      if (!card || !card.underneath.length) return false;
      const baseId = card.underneath[card.underneath.length - 1]!;
      card.underneath = card.underneath.slice(0, -1);
      const target = line ?? 'front';
      if (s.players[owner][target].length >= lineCapacity(s, owner, target)) { s.players[owner].sideline.push(baseId); break; }
      clearTemporaryFieldState(s, baseId);
      s.players[owner][target].push({
        cardId: baseId, instanceId: `${baseId}@${s.revision}#${ctx.events.length}`,
        entered: { from: 'under', by: 'effect', turn: s.turn, ...causeOf(f, s) }, underneath: [], active: true,
        attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
      });
      logTurnEvent(s, 'entered', owner, baseId, { via: 'effect' });
      ctx.queue.push(...collectTriggered(ctx, owner, 'entered', baseId, baseId));
      ctx.events.push({ type: 'cardDeployed', data: { player: owner, cardId: baseId, destination: target } });
      break;
    }
    case 'underToSideline': {
      // 「そのキャラの下にあるカードを全て場外に置く」 — the raid bases and the face-down pile under the
      // target all leave for their owners' discard piles; the target itself stays on the field.
      // 「…下の**裏向きのカード**を全て場外に置く」 narrows the subject to the hidden pile: the base a
      // stack sits on is not 裏向き and stays where it is (`faceDownOnly`). The mirror narrowing
      // (`underOnly`, 「このキャラのレイド元のカードを場外に置く」) takes the base alone.
      if (!card) break;
      const faceDown = [...(card.faceDown ?? [])];
      const hidden = underOnly ? [...card.underneath] : faceDownOnly ? faceDown : [...faceDown, ...card.underneath];
      if (!underOnly) card.faceDown = [];
      if (!faceDownOnly) card.underneath = [];
      for (const hiddenId of hidden) s.players[s.cards[hiddenId]?.owner ?? owner].sideline.push(hiddenId);
      // 「この効果で場外に置いたカード1枚につき、…」 — the departed pile joins the frame's own discard
      // record the way every other effect-driven 場外 placement does, counting *and* naming the cards:
      // a hidden card is not on a line, but reaching 場外 by this effect is the fact the follow-ups read.
      if (hidden.length) {
        (f.discardedIds ??= []).push(...hidden);
        f.discardedCount = (f.discardedCount ?? 0) + hidden.length;
      }
      // 「…の下から裏向きのカードが場外に置かれた時」 — the face-down cards only (a raid base was never
      // 裏向き); the target character is the event's subject and each departed card is its `eventSubject`.
      for (const hiddenId of faceDown) {
        ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToSideline', id, hiddenId));
        // The departed card's own watcher, read straight off its definition (see `collectHiddenWatchers`).
        ctx.queue.push(...collectHiddenWatchers(ctx, s.cards[hiddenId]?.owner ?? owner, hiddenId));
      }
      break;
    }
    case 'placeSourceUnder': {
      // 「そのキャラの下にこのキャラを表向きで置き」 — the source slides under the bound card and becomes
      // its raid base; the bound card thereby reaches レイド状態. The source's own stack travels with it,
      // keeping the deeper cards above it.
      const hostId = baseBind ? (f.selections?.[baseBind] ?? [])[0] : undefined;
      if (hostId === undefined || hostId === id) break;
      const host = findField(s, owner, hostId);
      if (!host) break;
      const self = findField(s, owner, id);
      // 「…選んだキャラの下にこのキャラを表向きで置く。（レイド状態になる）」 (OPM-P-002) — the source may
      // still be in *hand* (the print's このキャラ slides from there); the hand copy is consumed into the
      // stack instead of requiring a slot. The printed reminder says the *state* results, not a RAID
      // action, so no raid watchers fire — the same reading the field-source path has always had.
      if (!self) {
        const hand = s.players[owner].hand;
        const at = hand.indexOf(id);
        if (at === -1) break;
        hand.splice(at, 1);
        clearTemporaryFieldState(s, id);
        host.card.underneath.push(id);
        break;
      }
      const travels = [id, ...self.card.underneath];
      clearTemporaryFieldState(s, id, self.card);
      s.players[owner][self.line].splice(s.players[owner][self.line].indexOf(self.card), 1);
      host.card.underneath.push(...travels);
      break;
    }
    case 'reveal': {
      // 「この効果で手札を公開した場合」 — the reveal leaves no board trace, so the frame counts the
      // hand cards it made public while it resolves.
      if (zoneOfCard(s, owner, id) === 'hand') {
        f.revealedHandCount = (f.revealedHandCount ?? 0) + 1;
        // 「このターン中に自分の効果で自分の手札を公開している場合」 (DST-P-002) — the turn record.
        logTurnEvent(s, 'revealedFromHand', owner, undefined, { causeOwner: f.player, causeId: f.sourceId });
        queueRevealedFromHand(ctx, [id], f.sourceId);
      }
      // 「公開したカードが［特徴：濤］の場合」 (KGR-1-001) — the revealed card's identity for the
      // condition that follows, the same record the looks write. Appended rather than replaced: a
      // reveal printed beside a look narrows the same frame's "what this effect showed".
      (f.revealedIds ??= []).push(id);
      f.revealedFrom = 'hand';
      ctx.events.push({ type: 'cardRevealed', data: { player: owner, cardId: id } });
      break;
    }
    // 「…の発生エナジー+[色]」 on a chosen card; `amount` is unused, the colours ride on `energy`.
    // The printed period rides on the step (「次の自分のターン開始時まで」 has to survive the opponent's
    // turn), read through the same `expiryOf` every other timed modifier uses.
    case 'energy': if (card && energy) (card.energyModifiers ??= []).push({ energy, expiresTurn: expiryOf(ctx, f.player, duration ?? 'turn') }); break;
    case 'energyCostUp': {
      if (!card) break;
      const raise = { amount: amount ?? 1, expiresTurn: expiryOf(ctx, f.player, duration ?? 'turn') };
      (card.energyCostModifiers ??= []).push({ ...raise });
      persistentEnergyCostModifiers(s, id).push({ ...raise });
      break;
    }
    // 「選んだ相手のキャラはこのターン中、選んだ〈X〉のアタックを可能ならブロックしなければならない。」
    // (KGR-1-069) — the demand lands on the bound blocker with the *attacking* card's effective names,
    // read off the base binding at resolution (the names are runtime values). The block step reads the
    // record back while it lasts.
    case 'mustBlockAttacker': {
      if (!card) break;
      const attackerIds = baseBind ? f.selections?.[baseBind] ?? [] : [];
      const names = attackerIds.flatMap(base => {
        const baseOwner = s.cards[base]?.owner;
        return baseOwner === undefined ? [] : effectiveNames(s, base, baseOwner);
      });
      if (names.length) (card.mustBlockAttacker ??= []).push({ names, expiresTurn: s.turn });
      break;
    }
    // The grant is applied by the shared tail below; there is nothing else for this operation to do.
    case 'grantKeywords': break;
  }
  if (keywords && card) (card.keywordModifiers ??= []).push({ keywords, ...(relative ? { relative: true } : {}), expiresTurn: duration ? expiryOf(ctx, f.player, duration) : s.turn });
  if (energy && card && operation !== 'energy') (card.energyModifiers ??= []).push({ energy, expiresTurn: s.turn });
  return true;
}

/**
 * Whether `retiringId` itself buys its survival — 「代わりに自分の手札を1枚場外に置いてもよい」.
 *
 * The *cost* form of `retireSubstitute`: the carrier offers the payment while it sits on the field, and
 * the printed 「自分の手札がN枚以上あり」 gate is checked where the offer would be made. Only an
 * effect-driven retirement reaches this question — a battle loss or a BP check is not 「効果で」.
 */
function retireCauseFails(cause: Extract<StaticModifier, { type: 'retireSubstitute' }>['cause'], owner: PlayerId, effectPlayer: PlayerId, trigger: boolean, route: 'characterEffect' | 'eventEffect' | 'trigger' = 'characterEffect', battle = false): boolean {
  // 「相手の効果で」 — only an opponent's effect triggers the offer; 「相手のトリガーの効果で」 narrows it to
    // a life card's own trigger resolution (see `isTriggerResolution`); 「相手のイベントの効果で」 (MSS-1-034)
    // narrows it to the event-card route, which the resolving frame records. Both cause routes are effect
    // routes, so a battle's loss never satisfies them.
    if (cause === 'opponentEffect') return battle || effectPlayer === owner;
    if (cause === 'opponentTrigger') return battle || effectPlayer === owner || !trigger;
    if (cause === 'opponentEventEffect') return battle || effectPlayer === owner || route !== 'eventEffect';
    // 「相手の効果やバトルによって」 (BLC-2-067) — the effect route keeps the opponent-cause test, and the
    // battle route (the caller passes `battle`) always qualifies: the battle is against the opponent.
    if (cause === 'opponentEffectOrBattle') return !battle && effectPlayer === owner;
    if (cause === 'anyEffect') return battle;
  return false;
}

export function retireCostSubstitute(s: GameState, owner: PlayerId, retiringId: CardId, effectPlayer: PlayerId, trigger = false, route: 'characterEffect' | 'eventEffect' | 'trigger' = 'characterEffect', battle = false, probe = false): { hand?: number; under?: number; life?: number; top?: boolean; replenish?: number; base?: boolean; carrierId?: CardId; energy?: true; follow?: CardEffect[]; rest?: boolean; toRemoval?: boolean } | undefined {
  const causeFails = (cause: Extract<StaticModifier, { type: 'retireSubstitute' }>['cause']): boolean =>
      retireCauseFails(cause, owner, effectPlayer, trigger, route, battle);
  const spend = (id: CardId, modifier: StaticModifier): boolean => probe || spendReplacementUse(s, id, owner, modifier);
  const hand = s.players[owner].hand.length;
  const here = findField(s, owner, retiringId)?.card;
  const hidden = here?.faceDown?.length ?? 0;
  // 「相手の効果で〔このキャラが場を離れるか、…〕場合、代わりにこのキャラをエナジーLに移動させて
  // もよい。」 (KMY-P-002) — the relocation offer: only an opponent's effect raises it, and only while
  // the energy line has room for the arrival (the move is the whole of the substitution).
  if (!battle && effectPlayer !== owner
    && activeStatics(s, retiringId, owner).some(m => m.type === 'energyMoveSubstitute')
    && s.players[owner].energy.length < lineCapacity(s, owner, 'energy')) {
    return { energy: true };
  }
  for (const modifier of activeStatics(s, retiringId, owner)) {
    if (modifier.type !== 'retireSubstitute') continue;
    if (modifier.hand === undefined && modifier.under === undefined && modifier.top === undefined && modifier.replenish === undefined && modifier.base === undefined) continue;
    if (causeFails(modifier.cause)) continue;
    // 「そうした場合、レイド状態のこのキャラの一番上のカードを自分の場外に置く。」 (BLC-2-067) — the
    // follow-up the accepted offer runs on the saved card, whichever price bought the slot.
    const follow = modifier.follow?.length ? modifier.follow : undefined;
    // 「…代わりに自分の山札の上から1枚を裏向きでこのキャラの下に置いてもよい。」 (MGS-1-099) — the
    // replenish price, offered only while the printed stack gate holds and the deck can actually pay it
    // (an empty deck has nothing to place, which would save the card for free).
    if (modifier.replenish !== undefined) {
      if ((modifier.underMax === undefined || hidden <= modifier.underMax) && s.players[owner].deck.length >= modifier.replenish) {
        return { replenish: modifier.replenish, ...(follow ? { follow } : {}) };
      }
      continue;
    }
    // 「…代わりにこのキャラの下の裏向きのカードを1枚場外に置いてもよい。」 — the hidden-stack price,
    // offered only while the card really holds that many face-down cards.
    if (modifier.under !== undefined && hidden >= modifier.under) return { under: modifier.under, ...(follow ? { follow } : {}) };
    // 「…代わりにレイド状態の上のこのカードを場外に置いてもよい。」 — the peel price, offered only
    // while the carrier is really stacked (a card with no base has no surviving slot to pay for).
    if (modifier.top === true && (here?.underneath.length ?? 0) > 0) return { top: true, ...(follow ? { follow } : {}) };
    // 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 (ARK-1-059) — the base price,
    // offered only while the card is really stacked; the charge of a printed 「[ターン1]」 is spent here,
    // where the replacement answers.
    if (modifier.base === true && (here?.underneath.length ?? 0) > 0 && spend(retiringId, modifier)) {
      return { base: true, carrierId: retiringId, ...(follow ? { follow } : {}) };
    }
    if (modifier.hand !== undefined && hand >= (modifier.minHand ?? modifier.hand)) return { hand: modifier.hand, ...(follow ? { follow } : {}) };
  }
  // 「自分の場の〈X〉以外のキャラが相手のキャラの効果で場を離れる場合、代わりに自分のライフエリアに
  // あるカードを1枚場外に置いてもよい。」 — the life-area price, carried by *another* of the owner's
  // field cards (a protector), so the scan covers the whole field; the modifier's own `filter` narrows
    // which retiring cards it covers, read with the protector as the source. The base price rides the
    // same protector route (「このキャラか自分のエナジーLのキャラが…」, ARK-1-059): the protector pays
    // with its own stack; the quoted-composite price (MSS-1-034's rest + hand discard) and the removal
    // redirect (WBK-1-017) ride the same scan.
  const life = s.players[owner].life.length;
  for (const card of [...s.players[owner].front, ...s.players[owner].energy]) {
    if (card.cardId === retiringId) continue;
    for (const modifier of activeStatics(s, card.cardId, owner)) {
        if (modifier.type !== 'retireSubstitute' || (modifier.life === undefined && modifier.base !== true && modifier.rest !== true && modifier.toRemoval !== true)) continue;
      if (causeFails(modifier.cause)) continue;
      if (modifier.filter && !matchesFilter(s, retiringId, modifier.filter, card.cardId)) continue;
      // 「…代わりに「アクティブのこのキャラをレストにし、自分の手札を2枚場外に置く。」をしてもよい。」
      // (MSS-1-034) — the protected card must be standing (a rested one cannot pay the resting) and the
      // hand must hold the printed minimum; the charge is spent where the offer is taken up.
      if (modifier.rest === true) {
        if (here?.active !== true) continue;
        if (hand < (modifier.minHand ?? modifier.hand ?? 0)) continue;
        if (spend(card.cardId, modifier)) {
          return { rest: true, ...(modifier.hand !== undefined ? { hand: modifier.hand } : {}) };
        }
        continue;
      }
      // 「…代わりにそのキャラとそのキャラのレイド元のカードをリムーブエリアに置いてもよい。」
      // (WBK-1-017) — no price at all: the protected card is *diverted* to the removal area.
      if (modifier.toRemoval === true) {
        if (spend(card.cardId, modifier)) return { toRemoval: true };
        continue;
      }
      // 「[ターン1]」 on the protector's own replacement: the charge is spent where the offer is taken up.
      if (modifier.life !== undefined && life >= (modifier.minLife ?? modifier.life) && spend(card.cardId, modifier)) return { life: modifier.life };
      if (modifier.base === true && card.underneath.length > 0 && spend(card.cardId, modifier)) {
        const baseFollow = modifier.follow?.length ? modifier.follow : undefined;
        return { base: true, carrierId: card.cardId, ...(baseFollow ? { follow: baseFollow } : {}) };
      }
    }
  }
  return undefined;
}

/**
 * 「このキャラが場から手札に戻る場合、代わりに自分の手札を1枚場外に置いてもよい。」 — the buy-off
 * price for a *return*, read from the returning card's own statics (the same shape the retirement
 * cost uses). `undefined` means the printed offer is not available, so the return runs as printed.
 */
function returnCostSubstitute(s: GameState, owner: PlayerId, returningId: CardId): number | undefined {
  const hand = s.players[owner].hand.length;
  for (const modifier of activeStatics(s, returningId, owner)) {
    if (modifier.type !== 'returnSubstitute') continue;
    if (hand < (modifier.minHand ?? modifier.hand)) continue;
    return modifier.hand;
  }
  return undefined;
}

/**
 * 「レイド状態の…の一番上のカードを場外に置く」 without a resolving frame — the battle-loss
 * substitution's follow-up (BLC-2-067): the top card retires alone and the base takes the slot over.
 * The in-effect spelling (`case 'topToSideline'`) additionally records the peel for the sentences that
 * read 「この効果で場外に置いたカード」 and 「そのキャラのレイド元のカードに…」; a battle's behind-the-
 * scenes substitution has no such readers, so only the board movement is shared.
 */
export function peelTopToSideline(ctx: Context, owner: PlayerId, id: CardId): void {
  const s = ctx.state;
  const here = findField(s, owner, id);
  if (!here) return;
  // A peel is still a retirement of the top card: the unconditional 「退場しない」 refusals block it.
  if (staticForbids(s, id, owner).retire) return;
  const card = here.card;
  const [baseId, ...deep] = card.underneath;
  const inherits = { active: card.active, attacksThisTurn: card.attacksThisTurn, blocksThisTurn: card.blocksThisTurn };
  const faceDown = card.faceDown ?? [];
  card.underneath = [];
  card.faceDown = [];
  leaveField(ctx, owner, id, 'sideline', 'raid-top');
  if (baseId !== undefined) {
    clearTemporaryFieldState(s, baseId);
    s.players[owner][here.line].push({
      cardId: baseId, instanceId: `${baseId}@${s.revision}#${ctx.events.length}`,
      underneath: deep, ...inherits, bpModifiers: [],
      ...(faceDown.length ? { faceDown: [...faceDown] } : {}),
    });
  }
}

function savedOwnerFollow(s: GameState, framePlayer: PlayerId, steps: CardEffect[], savedId: CardId): CardEffect[] {
  const savedOwner = s.cards[savedId]?.owner;
  return structuredClone(steps).map((step): CardEffect => {
    // `countSource` draws compute their own width; only the plain printed count is re-targeted here.
    if (step.type !== 'draw' || step.countSource !== undefined) return step;
    if (savedOwner === undefined || savedOwner === framePlayer) return step;
    const { type: _draw, ...rest } = step;
    return { ...rest, type: 'drawTo', player: 'opponent' };
  });
}

/**
 * The cards that may retire *instead of* `retiringId` — the owner's other field cards carrying a
 * `retireSubstitute` static whose subject filter and cause accept this retirement.
 */
function retireSubstitutes(s: GameState, owner: PlayerId, retiringId: CardId, effectPlayer: PlayerId, trigger = false): { ids: CardId[]; follow?: CardEffect[] } {
  const here = findField(s, owner, retiringId);
  if (!here) return { ids: [] };
  const ids: CardId[] = [];
  let follow: CardEffect[] | undefined;
  // The substitute-direction modifiers the retiring card itself carries (its own 「…代わりにXを退場させて
  // もよい」). Collected across the candidate walk so their 「[ターン1]」 charges can be spent once, below.
  const substMods: Extract<StaticModifier, { type: 'retireSubstitute' }>[] = [];
  for (const card of [...s.players[owner].front, ...s.players[owner].energy]) {
    if (card.cardId === retiringId) continue;
    const cardHere = findField(s, owner, card.cardId);
    let ok = false;
    for (const modifier of activeStatics(s, card.cardId, owner)) {
      if (modifier.type !== 'retireSubstitute' || modifier.substitute) continue;
      if (modifier.hand !== undefined || modifier.under !== undefined || modifier.life !== undefined || modifier.top !== undefined || modifier.base === true || modifier.replenish !== undefined) continue;
      // 「代わりにアクティブのこのキャラを退場させてもよい」 — the printed state of the substitute.
      if (modifier.active !== undefined && card.active !== modifier.active) continue;
      if (retireCauseFails(modifier.cause, owner, effectPlayer, trigger)) continue;
      if (modifier.line !== undefined && modifier.line !== here.line) continue;
      // The filter belongs to the *substitute's* static, so that card is the source the source-dependent
      // fields (`other` / `self`) read against — the same convention every selection uses.
      if (modifier.filter && !matchesFilter(s, retiringId, modifier.filter, card.cardId)) continue;
      // 「そうした場合、その〈X〉を…」 — the printed follow-up belongs to the same static, and runs after
      // the substitution is accepted (the saved card is bound to the frame as `__saved`).
      if (modifier.follow?.length) follow ??= modifier.follow;
      ok = true;
      break;
    }
    // 「このキャラが相手の効果で退場する場合、代わりに自分のフロントLの[特徴：寄生昆虫]を1枚退場
    // させてもよい。」 — the mirrored reading: the modifier sits on the card that would die and names
    // its substitutes. `line` bounds the *candidate's* slot, and the candidate is the filter's subject
    // with the retiring card as the static's source.
    if (!ok) {
      for (const modifier of activeStatics(s, retiringId, owner)) {
        if (modifier.type !== 'retireSubstitute' || !modifier.substitute) continue;
        if (modifier.active !== undefined && card.active !== modifier.active) continue;
        if (retireCauseFails(modifier.cause, owner, effectPlayer, trigger)) continue;
        if (modifier.line !== undefined && cardHere?.line !== modifier.line) continue;
        if (!matchesFilter(s, card.cardId, modifier.substitute, retiringId)) continue;
        if (modifier.follow?.length) follow ??= modifier.follow;
        if (!substMods.includes(modifier)) substMods.push(modifier);
        ok = true;
        break;
      }
    }
    if (ok) ids.push(card.cardId);
  }
  // 「[ターン1]…代わりに自分のフロントLの［特徴：寄生昆虫］を1枚退場させてもよい。」 (TRK-1-091) —
  // the charge the substitute-direction replacement prints is spent where the offer is made, the same
  // point the cost forms spend theirs (and only when an offer is actually made): once used, no further
  // offer this turn, so the printed retirement runs instead.
  if (ids.length) {
    for (const modifier of substMods) {
      if (!spendReplacementUse(s, retiringId, owner, modifier)) return { ids: [] };
    }
  }
  return { ids, ...(follow ? { follow } : {}) };
}

/** The standing paid chooser-upgrade (YYH-1-050), read where a single-pick chooser opens: the holder
 *  that would pay, if it currently can (active, a face-down card beneath). The board is re-read when
 *  the answer lands, so a price that stopped being payable mid-question simply cannot be accepted. */
function paidChooseUpgradeOffer(s: GameState, player: PlayerId): { holderId: CardId; count: number } | undefined {
  for (const entry of fieldStatics(s, player)) {
    const modifier = entry.modifiers.find(m => m.type === 'paidChooseUpgrade');
    if (!modifier || modifier.type !== 'paidChooseUpgrade') continue;
    const slot = findField(s, player, entry.id)?.card;
    if (slot && slot.active && (slot.faceDown?.length ?? 0) >= 1) return { holderId: entry.id, count: modifier.count };
  }
  return undefined;
}

function applyTargets(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'choose' }>, ids: string[]): void {
  chargeSelectionTax(ctx, f, ids);
  // 「自分のAPカードを1枚アクティブにしてもよい。そうした場合、…」 (IMC-1-061) — the answer is an
  // outcome like a selection's, so its handled count feeds the 「そうした場合」 gate: the `gained`
  // reader takes `didCount`, the same marker the `select` path writes. Left unset, the gate read a
  // count an earlier step had left behind (opening on a declined pick).
  f.didCount = ids.length;
  for (const id of ids) applyOperation(ctx, f, id, e.operation, e.amount, undefined, undefined);
  // The same parking rule as the `act` step: an operation that asked a question owns the pending.
  if (ctx.state.pending) return;
}

/** The field cards a `grantStatic` / `grantTrigger` writes to, with their owners. */
function grantTargets(ctx: Context, f: EffectFrame, target: string | string[]): [PlayerId, FieldCard][] {
  const s = ctx.state;
  // 「それらに…を与える」 names several bindings, and every bound card receives the abilities; a plain
  // string is one binding (or the source), exactly as before.
  const ids = target === 'source'
    ? [f.sourceId]
    : (Array.isArray(target) ? target : [target]).flatMap(bind => f.selections?.[bind] ?? []);
  const out: [PlayerId, FieldCard][] = [];
  for (const id of ids) {
    const owner = s.cards[id]?.owner;
    if (owner === undefined) continue;
    const here = findField(s, owner, id);
    if (here) out.push([owner, here.card]);
  }
  return out;
}

/**
 * The bases a 「そのキャラのレイド元のカードに…を与える」 grant lands on: for every top card the binding
 * names, the base the peel above uncovered (`frame.peelBases`), found on the line it now holds.
 */
function raidBaseTargets(ctx: Context, f: EffectFrame, bind: string): [PlayerId, FieldCard][] {
  const s = ctx.state;
  const out: [PlayerId, FieldCard][] = [];
  for (const topId of f.selections?.[bind] ?? []) {
    const baseId = f.peelBases?.[topId];
    if (baseId === undefined) continue;
    const owner = s.cards[baseId]?.owner;
    if (owner === undefined) continue;
    const here = findField(s, owner, baseId);
    if (here) out.push([owner, here.card]);
  }
  return out;
}

function markAttackEndLapse(card: FieldCard, kind: 'cannotActivate' | 'effectsLost', on: boolean): void {
  const rest = (card.attackEndLapse ?? []).filter(entry => entry !== kind);
  const next = on ? [...rest, kind] : rest;
  if (next.length) card.attackEndLapse = next; else delete card.attackEndLapse;
}

/**
 * The turn number a `Duration` expires on. See `Duration` in `types.ts` for why the two differ.
 *
 * 「次の自分のターン開始時まで」 has to cover the opponent's turn, so on the controller's own turn it
 * has to survive one further turn number than 「このターン中」 does; off-turn the two coincide, because
 * the controller's next turn start *is* the next turn number.
 */
function expiryOf(ctx: Context, owner: PlayerId, duration: Duration): number {
  const s = ctx.state;
  if (duration === 'turn') return s.turn;
  // 「…かぎり」 — no counter governs the grant; the read side drops it when the named source leaves.
  if (duration === 'whileSource') return Number.MAX_SAFE_INTEGER;
  if (duration === 'untilOwnTurnStart') return s.activePlayer === owner ? s.turn + 1 : s.turn;
  // 「次の相手のターン中」 — the grant covers the opponent's *next* whole turn: granted on the owner's
  // turn it has to survive turn+1 and lapse when the owner's following turn opens (turn+2); granted
  // mid-opponent-turn that same period ends at the next turn number.
  if (duration === 'untilOpponentTurnEnd') return s.activePlayer === owner ? s.turn + 2 : s.turn + 1;
  // 「次の相手のアタックフェイズ終了時まで」 — the period ends inside the opponent's *next* turn. When the
  // opponent is already the active player and their attack phase has not yet closed, that is this turn
  // (Q571: a [レイドトリガー] grant resolving mid-attack lapses with the attack phase in progress);
  // once their end phase is reached, the next attack phase is their next turn's, one full round later.
  if (duration === 'untilOpponentAttackEnd') {
    if (s.activePlayer === owner) return s.turn + 1;
    return s.phase === 'end' ? s.turn + 2 : s.turn;
  }
  // 'attackEnd' — 「…のアタック終了時まで」, kept on the per-turn fallthrough it has always had.
  if (s.activePlayer === owner) return s.turn + 1;
  return s.phase === 'attack' || s.phase === 'end' ? s.turn + 2 : s.turn;
}

/** Runs deterministic instructions until a human choice is necessary. The frame owns looked-at cards. */
/**
 * The transfer half of the effect-route `move`: the card leaves its line and lands on the other one,
 * with the frame's own move record, the turn log and the watcher queue.
 *
 * Shared with the full-line overflow answer, which performs the same transfer after the removal the
 * printed reminder (`（移動させる時に…空きがない場合…）`) required — so the two routes can never
 * disagree about what "moved" leaves behind.
 */
function effectLineMove(ctx: Context, f: EffectFrame, id: CardId, owner: PlayerId, from: 'front' | 'energy', dest: 'front' | 'energy'): void {
  const s = ctx.state;
  const line = s.players[owner][from];
  const at = line.findIndex(entry => entry.cardId === id);
  if (at === -1) return;
  const card = line[at]!;
  line.splice(at, 1);
  s.players[owner][dest].push(card);
  // The same 「…かぎり」 ending the movement-phase route applies: the card left `from`, and a grant whose
  // print named that line does not come back with it (Q933/Q934).
  expireWhileSourceGrants(s, id, from);
  // 「この効果で移動させたキャラを1枚まで選び、…」 — the identity of what *this effect* moved is only
  // knowable here; on the board the card is indistinguishable from one that was already there.
  (f.movedIds ??= []).push(id);
  // The line left and the line reached are both recorded: 「エナジーLからフロントLに移動した時」 asks
  // about the direction, which neither the board nor the bare log entry answers.
  logTurnEvent(s, 'moved', owner, id, { line: from, to: dest, causeOwner: f.player });
  ctx.events.push({ type: 'characterMoved', data: { player: owner, cardId: id, destination: dest } });
  // 「…が移動した時」 — queued the way a retirement is: the effect that moved the card finishes
  // resolving first, and the watcher reads the move from the turn log with its phase attached.
  ctx.queue.push(...collectTriggered(ctx, owner, 'onMoved', id));
}
/**
 * Takes the top `count` cards of `target`'s deck to the step's destination.
 *
 * Shared by the immediate form of `millTop` and by the answer to its optional offer, so the two can
 * never disagree about where an unplaced card goes. The declared-count form (`upTo`) passes its
 * declaration as `count`: the printed width stays on `e.count` for every reader that names it.
 */
function millOnto(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'millTop' }>, target: PlayerId, count: number = e.count): void {
  const s = ctx.state;
  // 「山札の下から」 reads the deep end; every other printing takes the top.
  const cards = e.from === 'bottom'
    ? s.players[target].deck.splice(Math.max(0, s.players[target].deck.length - count), count)
    : s.players[target].deck.splice(0, count);
    noteDeckTop(s.players[target]);
  // 「…そのカードの必要エナジーの数×1000以下のBPの…」 (RNK-1-044) — the cards this step took from the
  // deck, recorded where a following clause's 「そのカード」 can name them. Recorded before the
  // destination branches: the binding follows the cards, not the pile they landed in.
  if (e.bind) (f.selections ??= {})[e.bind] = [...cards];
  if (e.to === 'under') {
    // `underBind` names the host when the printed text says 「選んだキャラの下に」; without it the
    // host is the effect source, which is what 「このキャラの下に」 means.
    const hostId = e.underBind ? (f.selections?.[e.underBind] ?? [])[0] : f.sourceId;
    const holder = hostId !== undefined ? findField(s, s.cards[hostId]?.owner ?? f.player, hostId) : undefined;
    // 「…置いてもよい。そうした場合、…」 (MGS-1-075/076) — the placement is what the printed
    // follow-up gates on, and it is the step's own "handled N" marker (`gained` reads it): set only
    // where the placement actually happened, so a declined or unrun mill leaves the branch closed.
    if (holder) f.didCount = cards.length;
    if (holder) (holder.card.faceDown ??= []).push(...cards);
    // 「…を1枚選び、そのキャラの下に置く」 with nothing chosen: the sentence did not happen, so the
    // deck keeps its cards. (The unbound spelling below keeps the sideline fallback — there the host
    // is the effect source, and 「このキャラの下に」 has no meaning once it has left the field.)
    else if (e.underBind) { s.players[target].deck.unshift(...cards); noteDeckTop(s.players[target]); }
    else {
      const aside: CardId[] = [];
      for (const id of cards) {
        if (sidelineRedirectsToRemoval(s, id)) { s.players[target].removal.push(id); (f.removedIds ??= []).push(id); }
        else { s.players[target].sideline.push(id); aside.push(id); (f.discardedIds ??= []).push(id); }
      }
      noteDeckToSideline(ctx, target, aside, f.sourceId);
    }
  } else if (e.to === 'sideline') {
    // 「…以外でこのカードが場外に置かれる場合、代わりにリムーブエリアに置く。」 — a mill is not the
    // card's own use, so each card's destination is decided here. The cards that reach 場外 join the
    // frame's own discard record: 「この効果で山札から場外に置いたカードから1枚まで手札に加える」 names
    // them, and by the time that sentence runs the pile is indistinguishable from the rest.
    const aside: CardId[] = [];
    for (const id of cards) {
      if (sidelineRedirectsToRemoval(s, id)) { s.players[target].removal.push(id); (f.removedIds ??= []).push(id); }
      else { s.players[target].sideline.push(id); aside.push(id); (f.discardedIds ??= []).push(id); }
    }
    // Keep deck-origin identities separate from later hand payments in the same frame.
    f.milledToSidelineIds = [...new Set([...(f.milledToSidelineIds ?? []), ...aside])];
    // The placement happened for every card the deck yielded (場外, or the redirect's リムーブ): the
    // step's own "handled N" marker (`gained` reads it) is what the 「そうした場合」 gate compares
    // against the printed count (Q686, IMS-2-043: a deck too short to reach the count leaves the
    // follow-up unprocessed even though the cards it had are placed). Set only here, where the
    // placement actually ran — a declined mill never calls `millOnto`.
    f.didCount = cards.length;
    noteDeckToSideline(ctx, target, aside, f.sourceId);
  } else if (e.to === 'life') {
    // The life area keeps a per-slot face flag, so a placement goes through the same helper the damage
    // flip and `toLife` use; a raw push would desynchronise `lifeFaceUp` from `life`.
    addToLife(s, target, cards, e.faceUp === true);
  } else {
    s.players[target][e.to].push(...cards);
    // 「このターン中、自分はそのカードをリムーブエリアから使用できる。」 (KJN-1-006…) — a mill onto the
    // removal area is a placement the frame's own removal record must carry, the same channel the
    // `act`-route removal writes; `allowRemovalUse` reads it back for the turn's permission.
    if (e.to === 'removal') (f.removedIds ??= []).push(...cards);
  }
  ctx.events.push({ type: 'cardsMilled', data: { player: target, cards, destination: e.to } });
}

/** The cards the frame sent to 場外 that are still there — the subject of 「この効果で場外に置いたカード」. */
function discardedStillInSideline(s: GameState, f: EffectFrame): CardId[] {
  return (f.discardedIds ?? []).filter(id => {
    const owner = s.cards[id]?.owner;
    return owner !== undefined && s.players[owner].sideline.includes(id);
  });
}

/**
 * What `discardedUnder` is about.
 *
 * Two printings share the step: 「この効果で場外に置いたカードを…」, whose subject is this frame's own
 * discard record, and 「自分の効果で自分の手札を1枚場外に置いた時、…そのカードを…」, which resolves on a
 * field character and speaks about the card the *raising event* named. Either way the reader only accepts
 * cards that are still in the sideline — a later effect may already have moved one on.
 */
function underPlacementSubjects(s: GameState, f: EffectFrame): CardId[] {
  if (f.discardedIds?.length) return discardedStillInSideline(s, f);
  const subject = f.eventSubject;
  if (subject === undefined) return [];
  const owner = s.cards[subject]?.owner;
  return owner !== undefined && s.players[owner].sideline.includes(subject) ? [subject] : [];
}


/** 「このターン中に自分の山札から…カードを公開して手札に加えている」 — logs each card the reveal route
 * delivered to its owner's hand, the fact KMR-1-002/003/031 read back through `Condition.turnEvent`.
 */
function logRevealedToHand(ctx: Context, cards: CardId[]): void {
  for (const id of cards) {
    const owner = ctx.state.cards[id]?.owner;
    if (owner !== undefined) logTurnEvent(ctx.state, 'revealedToHand', owner, id);
  }
}

function placeUnder(ctx: Context, f: EffectFrame, host: FieldCard, ids: CardId[]): void {
  const s = ctx.state;
  for (const id of ids) {
    const pile = s.players[s.cards[id]!.owner].sideline;
    pile.splice(pile.indexOf(id), 1);
  }
  (host.faceDown ??= []).push(...ids);
  ctx.events.push({ type: 'cardPlacedUnder', data: { player: f.player, cards: ids } });
  f.didCount = ids.length;
}

/**
 * A draw an effect caused: the cards, the turn log's `drew` fact, and the 「自分の効果でカードを引いた時」
 * watcher channel.
 *
 * The frame's own player is the printed effect's controller, which is whose effect did it — the draw may
 * still land on the other side (「相手はカードを1枚引く」), and that side's watchers are collected for it.
 */
function effectDraw(ctx: Context, f: EffectFrame, player: PlayerId, count: number): void {
  if (count <= 0) return;
  // 「自分の効果で相手がカードを引く場合、代わりに自分が同じ枚数カードを引く。」 (SYN-1-070/079/096) —
  // the redirect names the side whose *effect* drew, so only the effect's own controller may divert a
  // draw aimed at the other side; a draw onto one's own board is never redirected. The redirected draw
  // is itself an effect draw (the same effect is what caused it), so a later 「引いたカードの枚数」 reads
  // it, and the *drawer's* `onDrew` watchers are collected.
  if (player !== f.player && drawRedirectsToSelf(ctx.state, f.player)) {
    draw(ctx, f.player, count, { via: 'effect', causeOwner: f.player });
    ctx.queue.push(...collectTriggered(ctx, f.player, 'onDrew'));
    return;
  }
  draw(ctx, player, count, { via: 'effect', causeOwner: f.player });
  ctx.queue.push(...collectTriggered(ctx, player, 'onDrew'));
}

/** Count is declared before any card is drawn; zero must not raise draw events. */
function drawStep(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'draw' | 'drawTo' }>, count: number): void {
  const target = e.type === 'drawTo' ? scopePlayer(f.player, e.player) : f.player;
  if (count > 0) {
    if (e.type === 'draw') {
      f.drewFaceDownCount = (f.drewFaceDownCount ?? 0) + (faceUpTop(ctx.state, target) === undefined ? 1 : Math.max(0, count - 1));
    }
    effectDraw(ctx, f, target, count);
  }
  f.didCount = count;
  if (count === 0) { f.gainedCount = 0; f.discardedCount = 0; }
}

/**
 * Whether this player's effect-draws aimed at the other side are diverted to this player.
 *
 * The redirect is a fact about the *controller* (「自分の効果で相手がカードを引く場合」), not about the
 * card that happens to be resolving: every card on the player's own field carrying the modifier diverts,
 * its condition evaluated per holding card (SYN-1-070's atZone/turnOf gate, SYN-1-079's turn-granted
 * ability), beside the player-scope grants. The read stays a boolean: Q789 — a second copy does not
 * stack, the diverted draw is still one draw.
 */
function drawRedirectsToSelf(state: GameState, player: PlayerId): boolean {
  if (fieldStatics(state, player).some(({ modifiers }) => modifiers.some(m => m.type === 'opponentDrawRedirect'))) return true;
  return playerStatics(state, player).some(m => m.type === 'opponentDrawRedirect');
}

function frameProducedResult(f: EffectFrame): boolean {
  return (f.didCount ?? 0) > 0 || (f.gainedCount ?? 0) > 0 || (f.discardedCount ?? 0) > 0
    || (f.readiedAp ?? 0) > 0 || (f.retiredOwn ?? 0) > 0 || (f.retiredOpponent ?? 0) > 0
    || (f.movedIds?.length ?? 0) > 0 || (f.deployedIds?.length ?? 0) > 0
    || (f.restedIds?.length ?? 0) > 0 || (f.activatedIds?.length ?? 0) > 0
    || (f.removedIds?.length ?? 0) > 0 || (f.deckBottomIds?.length ?? 0) > 0
    || (f.underFromHandIds?.length ?? 0) > 0 || (f.discardedIds?.length ?? 0) > 0
    || f.acted === true;
}

/** Plan the whole instruction without moving cards, then reuse ordinary placement lifecycles. */
function runDeploymentBatch(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'deployBatch' }>): boolean {
  const s = ctx.state, owner = f.player, p = s.players[owner];
  const batch = f.deploymentBatch ??= {
    phase: 'pick', index: 0, pools: e.groups.map(filter => eligibleFor(s, f, 'ownHand', filter)), plans: [], entered: [],
  };
  const bases = (id: CardId) => fields(s, owner).map(c => c.cardId).filter(base =>
    !batch.plans.some(plan => plan.baseId === base) && raidBaseEligible(s, owner, id, base)
    && !staticImmunity(s, id, owner)[findField(s, owner, base)!.line === 'front' ? 'noFront' : 'noEnergy']);
  while (true) {
    f.stage = 'deploymentBatch';
    if (batch.phase === 'pick') {
      while (batch.index < batch.pools.length) {
        const options = batch.pools[batch.index]!.filter(id => p.hand.includes(id) && !batch.plans.some(plan => plan.id === id));
        if (options.length) {
          request(ctx, f, 'cards', '同时登场：选择本组最多 1 张手牌（可放弃）', 0, 1, options);
          return true;
        }
        batch.index++;
      }
      batch.phase = 'mode'; batch.index = 0;
    } else if (batch.phase === 'mode') {
      if (batch.index === batch.plans.length) { batch.phase = 'space'; batch.index = 0; continue; }
      const plan = batch.plans[batch.index]!;
      if (bases(plan.id).length) {
        request(ctx, f, 'option', '同时登场：选择休息登场或突进', 1, 1, ['deploy', 'raid']);
        return true;
      }
      plan.mode = 'deploy'; batch.phase = 'line';
    } else if (batch.phase === 'base') {
      request(ctx, f, 'cards', '同时登场：选择突进基底', 1, 1, bases(batch.plans[batch.index]!.id));
      return true;
    } else if (batch.phase === 'line') {
      const plan = batch.plans[batch.index]!, immunity = staticImmunity(s, plan.id, owner);
      const lines = (e.line ? [e.line] : ['front' as const, 'energy' as const])
        .filter(line => !(line === 'front' ? immunity.noFront : immunity.noEnergy));
      if (!lines.length || deployForbidden(s, owner, plan.id)) { batch.plans.splice(batch.index, 1); batch.phase = 'mode'; continue; }
      if (lines.length > 1) {
        request(ctx, f, 'option', '选择登场战线：front = 前线，energy = 能量线', 1, 1, lines);
        return true;
      }
      plan.line = lines[0]!; batch.index++; batch.phase = 'mode';
    } else if (batch.phase === 'space') {
      // RAID replaces its base in its original line. Optional moves cannot free these slots yet.
      const line = (['front', 'energy'] as const).find(line =>
        p[line].length + batch.plans.filter(plan => plan.mode === 'deploy' && plan.line === line).length > lineCapacity(s, owner, line));
      if (line) {
        const count = p[line].length + batch.plans.filter(plan => plan.mode === 'deploy' && plan.line === line).length - lineCapacity(s, owner, line);
        const options = lineOverflowCandidates(s, f, owner, line).filter(id => !batch.plans.some(plan => plan.baseId === id));
        requireRule(options.length >= count, 'INVALID_CHOICE', '同时登场没有足够的规则腾位目标。');
        request(ctx, f, 'cards', '同时登场：选择既存卡置于移除区，腾出全部位置', count, count, options);
        return true;
      }
      batch.phase = 'place';
      for (const plan of batch.plans) {
        requireRule(p.hand.includes(plan.id), 'INVALID_CHOICE', '同时登场的手牌已失效。');
        if (plan.mode === 'raid') {
          (f.selections ??= {}).__batchBase = [plan.baseId!];
          applyOperation(ctx, f, plan.id, 'raid', undefined, plan.line, undefined, false, undefined, undefined, '__batchBase', undefined, undefined, false, undefined, false, false, true);
          delete f.selections.__batchBase;
          const placed = findField(s, owner, plan.id);
          if (placed) placed.card.active = false;
        } else {
          applyOperation(ctx, f, plan.id, e.rested ? 'deployRested' : 'deploy', undefined, plan.line, undefined, false, undefined, undefined, undefined, undefined, undefined, false, undefined, false, false, true);
        }
        requireRule(s.pending === null, 'INVALID_CHOICE', '同时登场的落位计划已失效。');
        if (findField(s, owner, plan.id)) batch.entered.push(plan.id);
      }
      for (const id of batch.entered) ctx.queue.push(...collectTriggered(ctx, owner, 'entered', id, id));
      for (const plan of batch.plans) if (plan.mode === 'raid') {
        const placed = findField(s, owner, plan.id); if (placed) placed.card.active = true;
      }
      batch.phase = 'move'; batch.index = 0;
    } else if (batch.phase === 'move') {
      while (batch.index < batch.plans.length) {
        const plan = batch.plans[batch.index]!, here = findField(s, owner, plan.id);
        if (plan.mode === 'raid' && here?.line === 'energy' && !frontMoveForbidden(s, plan.id, owner, f.player, f.sourceId)) {
          request(ctx, f, 'option', '选择突进战线：front = 移至前线，energy = 留在能量线', 1, 1, ['front', 'energy']);
          return true;
        }
        batch.index++;
      }
      for (const id of batch.entered) {
        const definition = getDefinition(s, id), plan = batch.plans.find(plan => plan.id === id)!;
        if (plan.mode === 'raid') ctx.queue.push(...collectTriggered(ctx, owner, 'onRaid', id, id));
        const steps = [...placedEntrySteps(s, owner, definition), ...(plan.mode === 'raid' ? definition.onRaid ?? [] : [])];
        if (steps.length) setQueue(f, [...(f.queue?.effects ?? []), makeEntryTask(s, owner, id, steps)]);
      }
      f.didCount = batch.entered.length;
      delete f.deploymentBatch;
      checkBP(ctx);
      return s.pending !== null;
    } else if (batch.phase === 'moveSpace') {
      const plan = batch.plans[batch.index]!;
      request(ctx, f, 'cards', '突进战线已满：选择该战线 1 张卡置于移除区', 1, 1, lineOverflowCandidates(s, f, owner, 'front', plan.id));
      return true;
    } else throw new Error('Unexpected deployment batch phase');
  }
}

function answerDeploymentBatch(ctx: Context, f: EffectFrame, selected: CardId[]): void {
  const s = ctx.state, batch = f.deploymentBatch!;
  const plan = batch.plans[batch.index];
  switch (batch.phase) {
    case 'pick':
      recordChosen(ctx, f, selected);
      if (selected[0]) batch.plans.push({ id: selected[0], mode: 'deploy' });
      batch.index++; break;
    case 'mode':
      plan!.mode = selected[0] === 'raid' ? 'raid' : 'deploy';
      batch.phase = plan!.mode === 'raid' ? 'base' : 'line'; break;
    case 'base':
      recordChosen(ctx, f, selected);
      plan!.baseId = selected[0]!;
      plan!.line = findField(s, f.player, selected[0]!)!.line;
      batch.index++; batch.phase = 'mode'; break;
    case 'line':
      plan!.line = selected[0] as 'front' | 'energy';
      batch.index++; batch.phase = 'mode'; break;
    case 'space':
      for (const id of selected) overflowRemoval(ctx, f, f.player, id);
      break;
    case 'move': {
      const here = findField(s, f.player, plan!.id)!;
      if (selected[0] === 'front' && s.players[f.player].front.length >= lineCapacity(s, f.player, 'front')) {
        batch.phase = 'moveSpace'; break;
      }
      if (selected[0] === 'front') effectLineMove(ctx, f, plan!.id, f.player, here.line, 'front');
      batch.index++; break;
    }
    case 'moveSpace':
      overflowRemoval(ctx, f, f.player, selected[0]!);
      if (s.players[f.player].front.length < lineCapacity(s, f.player, 'front')) effectLineMove(ctx, f, plan!.id, f.player, 'energy', 'front');
      batch.index++; batch.phase = 'move'; break;
    default: throw new Error('Unexpected deployment batch answer');
  }
}

function runEffects(ctx: Context): void {
  syncLedger(ctx, 'rule');
  runEffectsCore(ctx);
  syncLedger(ctx, 'effect');
}
function runEffectsCore(ctx: Context): void {
  const s = ctx.state;
  const f = s.effect!;
  const p = s.players[f.player];
  // Retire triggers raised while this frame was paused join the frame's own queue.
  if (ctx.queue.length) {
    const queued = ctx.queue.splice(0, ctx.queue.length);
    setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
  }
  while (f.index < f.steps.length) {
    const e = f.steps[f.index]!;
    switch (e.type) {
      case 'deployBatch':
        if (runDeploymentBatch(ctx, f, e)) return;
        break;
      case 'departureAnswer':
        s.departureChoices ??= {};
        s.departureChoices[e.cardId] = e.destination;
        break;
      case 'departurePaySelect':
        request(ctx, f, 'cards', e.prompt, e.count, e.count, [...e.candidates]);
        return;
      case 'resumeCommand':
        s.pending = structuredClone(e.pendingBefore);
        if (e.effectBefore) s.effect = structuredClone(e.effectBefore);
        else delete s.effect;
        executeResumedCommand(ctx, e.command);
        return;
      case 'triggerEntryChoice': {
        f.stage = 'triggerEntryChoice';
        const options = Object.keys(e.commands);
        if (e.phase === 'replacement') request(ctx, f, 'option', '是否发动 GET 替代登场？0 = 正常获得，1 = 替代为休息登场并在成功后弃手', 1, 1, options, f.player);
        else if (e.phase === 'line') request(ctx, f, 'option', '选择登场战线：front = 前线，energy = 能量线', 1, 1, options, f.player);
        else request(ctx, f, 'cards', '登场战线已满：选择该战线 1 张卡置于移除区', 1, 1, options, f.player);
        return;
      }
      // A draw counts as "something happened" for a following 「そうした場合」: the branch asks
      // whether the previous instruction produced a result, and drawing is that result. Without the
      // marker, every 「カードをN枚引いてもよい。そうした場合、…」 card compiled into a branch that
      // could never open.
      // 「…1枚につき、自分はカードを1枚引く」 — the count is a board count read here, where the step runs.
      case 'draw': {
        const count = e.countSource ? tierCount(ctx, f, e.countSource) * e.count : e.count;
        if (e.upTo && count > 0) {
          f.stage = 'drawCount';
          request(ctx, f, 'option', `选择抽牌张数（0～${count} 张）`, 1, 1, Array.from({ length: count + 1 }, (_, k) => `${k} 张`));
          return;
        }
        drawStep(ctx, f, e, count);
        break;
      }
      // 「この効果で場外に置いたカードと同じ枚数」 — read from the frame, because the discard it names has
      // already happened and nothing on the board remembers how large it was.
      case 'drawByCount': {
        // 「自分のアクティブのAPカードの枚数分、カードを引く」 — the count is read here, where the board is
        // authoritative (an AP card may have activated since the ability started).
        const count = tierCount(ctx, f, e.count);
        if (count > 0) effectDraw(ctx, f, f.player, count);
        break;
      }
      case 'drawDiscarded': {
        // 「…山札の下に置いたカードと同じ枚数」 reads the frame's own deck-bottom record; the bare
        // spelling reads the discard record it always has.
        const count = e.to === 'deckBottom' ? (f.deckBottomIds?.length ?? 0) : (f.discardedCount ?? 0);
        if (count > 0) effectDraw(ctx, f, f.player, count);
        break;
      }
      case 'drawByRested': {
        // 「この効果でキャラがレストになったプレイヤーはカードを1枚引く」 — the frame's own rest record
        // names the card, and its owner is the player the print hands the draw to. (The printed
        // sentence rests one card; the most recent entry is read.)
        const rested = f.restedIds ?? [];
        const owner = rested.length ? s.cards[rested[rested.length - 1]!]?.owner : undefined;
        if (owner !== undefined) effectDraw(ctx, f, owner, e.count);
        break;
      }
      case 'drawTo': {
        if (e.upTo) {
          f.stage = 'drawCount';
          request(ctx, f, 'option', `选择抽牌张数（0～${e.count} 张）`, 1, 1,
            Array.from({ length: e.count + 1 }, (_, k) => `${k} 张`), scopePlayer(f.player, e.player));
          return;
        }
        drawStep(ctx, f, e, e.count);
        break;
      }
      case 'drawToSize': {
        // 「手札がN枚になるようにカードを引く」 — up to the printed size, floored at zero.
        const target = scopePlayer(f.player, e.player);
        const amount = Math.max(0, e.count - s.players[target].hand.length);
        effectDraw(ctx, f, target, amount);
        f.didCount = amount;
        break;
      }
      case 'drawToEqual': {
        // 「自分の手札が相手の手札と同じ枚数になるようにカードを引く」 — the difference, floored at
        // zero (already at parity or ahead draws nothing).
        const target = scopePlayer(f.player, e.player);
        const opponent = otherOf(target);
        const amount = Math.max(0, s.players[opponent].hand.length - s.players[target].hand.length);
        effectDraw(ctx, f, target, amount);
        f.didCount = amount;
        break;
      }
      case 'playerDamage': {
        // 「相手プレイヤーにNダメージ。」 — accumulated, not dealt here: the damage opens a pending
        // decision, and the life triggers it reveals may need an effect frame of their own while this
        // one is still open. The frame's tail deals the total. See `CardEffect`'s `playerDamage`.
        f.playerDamage = (f.playerDamage ?? 0) + e.count;
        break;
      }
      case 'readyAp': {
        let count = e.count;
        for (let i = 0; i < 3 && count > 0; i++) if (p.ap[i] === 'rested') { p.ap[i] = 'active'; count--; }
        f.readiedAp = (f.readiedAp ?? 0) + (e.count - count);
        ctx.events.push({ type: 'apReadied', data: { player: f.player, amount: e.count - count } }); break;
      }
      case 'ifName':
        if (fields(s, f.player).some(c => getDefinition(s, c.cardId).name === e.name)) f.steps.splice(f.index + 1, 0, ...structuredClone(e.effects));
        break;
      case 'choose': {
        let options = eligibleFor(s, f, e.zone, e.filter);
        // 「自分のレストのAPカードを…選び」 — the slot's own state is the qualifier, read here because an
        // AP slot has no card for a filter to match against.
        if (e.zone === 'ownAp' && e.apState !== undefined) {
          options = options.filter(id => p.ap[Number(id.slice('ap:'.length))] === e.apState);
        }
        if (!options.length && e.fallbackReturnSelf && source(s, f)) options = [f.sourceId];
        if (options.length) { request(ctx, f, e.zone === 'ownAp' ? 'ap' : 'cards', prompts[e.operation], e.min, e.max, options); return; }
        break;
      }
      case 'select': {
        // 「アタックしている相手のキャラを1枚選び、…」 — the battle's own attacker, bound without asking.
        // It is not a board predicate: the card attacked from its own line, which is the *opponent's* side
        // of this effect, and the battle may already be over by the time the step runs — so the binding is
        // read from the battle the ability is resolving inside of.
        if (e.battleAttacker) {
          f.selections ??= {};
          f.selections[e.bind] = s.battle ? [s.battle.attackerId] : [];
          break;
        }
        const printed = e.printedMin ?? (e.upTo ? 1 : e.min >= 1 ? e.min : e.max <= 7 ? e.max : undefined);
        if (printed === undefined) delete f.selectPrinted;
        else f.selectPrinted = printed;
        delete f.selections?.__selectAct;
        // 「…1枚につき、この効果で登場させるキャラの必要エナジーの範囲+N。」 — the requirement ceiling the
        // selection filters on is raised by a board count, read here so the offer always holds the number
        // the print allows at the moment it is made. The raise reaches the `anyOf` branches too: they are
        // part of the same printed candidate set (BLC-4-056).
        let filter = e.filter;
        if (e.maxEnergyPer && filter) {
          const raise = e.maxEnergyPer.amount * tierCountOf(s, f.player, f.sourceId, e.maxEnergyPer.count);
          if (raise > 0) filter = raiseMaxEnergy(filter, raise);
        }
        // 「退場させたキャラの必要エナジーの数×1000以下のBPの…」 (BLC-4-008) / 「そのカードの必要エナ
        // ジーの数×1000以下のBPの…」 (RNK-1-044) — the ceiling may come from a *frame* fact (this
        // effect's own retirement records, the cards a mill just bound). `matchesFilter` is state-only
        // and answers 0 for those sources, so the frame-derived ceiling is folded into a plain `maxBP`
        // here, where the resolving frame is in scope; a board-count ceiling keeps `matchesFilter`'s own
        // reading and is left alone.
        if (filter?.bpCeiling && FRAME_TIER_SOURCES.has(filter.bpCeiling.count.source)) {
          const ceiling = (filter.bpCeiling.base ?? 0) + tierCount(ctx, f, filter.bpCeiling.count) * filter.bpCeiling.per;
          const { bpCeiling: _frameCeiling, ...rest } = filter;
          void _frameCeiling;
          filter = { ...rest, maxBP: rest.maxBP === undefined ? ceiling : Math.min(rest.maxBP, ceiling) };
        }
        if (filter && (filter.maxBP !== undefined || filter.minBP !== undefined) && e.all !== true) {
          const widen = (current: CardFilter, raise: number): CardFilter => raise === 0 ? current : ({
            ...current,
            ...(current.maxBP !== undefined ? { maxBP: current.maxBP + raise } : {}),
            ...(current.minBP !== undefined ? { minBP: Math.max(0, current.minBP - raise) } : {}),
          });
          // 「自分が「BPの範囲に指定がある効果」でキャラを選ぶ際、指定できるBPの範囲+500。」 — the *standing*
          // widening a card on the controller's own field broadcasts to its BP-bound selections, read here
          // where the candidates are bound so the offer already holds the widened range. The colour-trigger
          // spelling (「自分が赤の[カラートリガー]で…」) covers only that colour's trigger resolution, which
          // this frame is when its source is a colour-trigger card that is not on the field.
          const sourceDefinition = peekDefinition(s, f.sourceId);
          const sourceColor = sourceDefinition?.trigger?.type === 'color' && findField(s, f.player, f.sourceId) === undefined
            ? COLORS.find(colour => (sourceDefinition.requiredEnergy[colour] ?? 0) > 0)
            : undefined;
          const standing = selectBpRangeBonus(s, f.player, sourceColor);
          const widenings = (p.pendingSelectBp ?? []).filter(entry => entry.expiresTurn >= s.turn);
          const raise = standing + widenings.reduce((total, entry) => total + entry.amount, 0);
          if (raise > 0) filter = widen(filter, raise);
          // A turn-long widening (「このターン中、…選ぶ際、指定できるBPの範囲+1000」) is not spent by
          // the use: it stays parked and widens every later BP-bound selection of the turn.
          if (widenings.length) {
            p.pendingSelectBp = (p.pendingSelectBp ?? []).filter(entry => entry.expiresTurn < s.turn || entry.all === true);
          }
        }
        // 「選ばれたキャラのうち1枚」 — the pool is the union of the named bindings rather than a zone
        // (the cards an earlier sentence selected; they may sit on either board by now).
        // 「この効果で移動させたキャラを1枚まで選び」 — the frame's own move record, the same
        // frame-scoped pool shape read from `movedIds`.
        // 「全ては」 / `auto` selections never print 「選び」, so their pool keeps protected cards
        // (Q906 narrow reading — see `eligibleFor`).
        const allPicks = e.auto === true || e.all === true;
        let options = e.fromBinds?.length
          ? e.fromBinds.flatMap(bind => f.selections?.[bind] ?? []).filter(id => matchesFilter(s, id, filter, f.sourceId))
          : e.movedByThisEffect
            ? (f.movedIds ?? []).filter(id => matchesFilter(s, id, filter, f.sourceId))
            : eligibleFor(s, f, e.zones ?? e.zone, filter, allPicks);
        // 「このキャラの下か自分の場の〈X〉の下の裏向きのカード」 (KGR-1-001) — the printed union of two
        // hosts' hidden piles: the source's own, plus every own field card the subject admits. Read
        // beside `eligibleFor` so the per-card filter and protections still apply to the picks.
        if (e.underHosts) {
          const allowed = new Set<CardId>(findField(s, f.player, f.sourceId)?.card.faceDown ?? []);
          for (const slot of [...s.players[f.player].front, ...s.players[f.player].energy]) {
            if (!matchesFilter(s, slot.cardId, e.underHosts, f.sourceId)) continue;
            for (const hidden of slot.faceDown ?? []) allowed.add(hidden);
          }
          options = options.filter(id => allowed.has(id));
        }
        // 「このターン中、自分が次に発動させる〈X〉の[起動メイン]は、自分の場のキャラを選ぶ代わりに
        // 相手のフロントLのキャラを選んで発動させてもよい。」 (HTR-2-046) — the waiting swap: the first
        // matching activation's selection over the printed zone offers the other pool as well (one pool,
        // so the pick may come from either side), and the record is spent by that selection — taken or not.
        if (!e.fromBinds?.length && !e.movedByThisEffect) {
          const swaps = p.nextActivationSelectSwap ?? [];
          const at = swaps.findIndex(entry => entry.expiresTurn >= s.turn && entry.from === e.zone && matchesFilter(s, f.sourceId, entry.filter));
          if (at !== -1) {
            const entry = swaps.splice(at, 1)[0]!;
            if (swaps.length) p.nextActivationSelectSwap = swaps;
            else delete p.nextActivationSelectSwap;
            options = [...options, ...eligibleFor(s, f, entry.zone, filter)];
          }
        }
        // 「そのキャラ以外の」 — a candidate already bound by the named earlier selection drops out.
        if (e.excludeBind !== undefined) {
          const excluded = new Set(f.selections?.[e.excludeBind] ?? []);
          if (excluded.size) options = options.filter(id => !excluded.has(id));
        }
        // 「この効果で登場させたカード以外の」 (KJN-1-074) — the cards this effect just deployed drop out
        // of the offer, read from the frame's own placement record.
        if (e.excludeDeployedByThisEffect) {
          const deployed = new Set(f.deployedIds ?? []);
          if (deployed.size) options = options.filter(id => !deployed.has(id));
        }
        // 「この効果で登場させたキャラを1枚まで選び、アクティブにする。」 (ARK-1-032) — the candidates are
        // exactly this effect's own placements, the positive twin of the exclusion above.
        if (e.deployedByThisEffect) {
          const deployed = new Set(f.deployedIds ?? []);
          options = options.filter(id => deployed.has(id));
        }
        // 「アタックしているキャラ以外の自分のフロントLのキャラを1枚選び、…」 (IMS-1-089) — the battle's
        // attacker drops out, the exclusion twin of `battleAttacker` above. Read from the battle the
        // ability is resolving inside of; outside a battle there is no attacker and nothing drops out.
        if (e.excludeBattleAttacker && s.battle) {
          options = options.filter(id => id !== s.battle!.attackerId);
        }
        // 「〈X〉のこの効果でこのターン中に既に選んだキャラは選べない。」 — the same card's earlier
        // activations this turn have already marked their picks; those candidates drop out here. The
        // trait-qualified spelling (「このターン中に[特徴：X]の効果で選ばれているキャラは、この効果で
        // 選べない。」) spans every source carrying the trait instead of one card, and reads either
        // player's records unless the print says 自分の.
        if (e.excludeChosenThisTurn) {
          if (e.excludeChosenThisTurn === true) {
            const chosen = new Set(p.chosenByEffectThisTurn?.[f.sourceId] ?? []);
            if (chosen.size) options = options.filter(id => !chosen.has(id));
          } else {
            const trait = e.excludeChosenThisTurn.trait;
            const players: PlayerId[] = e.excludeChosenThisTurn.both ? [f.player, otherOf(f.player)] : [f.player];
            options = options.filter(id => !players.some(owner => choseCardThisTurn(s, owner, { cardId: id, trait })));
          }
        }
        // 「BPが同じ…を2枚選び」 — the relation between two picks, which no single-card filter carries:
        // each candidate must match the *current* BP of the card the earlier binding holds.
        if (e.sameBpAsBind !== undefined) {
          const anchors = f.selections?.[e.sameBpAsBind] ?? [];
          const anchorBp = anchors.length ? bpOfCard(s, anchors[0]!) : undefined;
          if (anchorBp !== undefined) options = options.filter(id => bpOfCard(s, id) === anchorBp);
        }
        // 「選んだキャラと同じカード名の…カードを1枚まで」 (BCV-1-006) — the name sibling of
        // `sameBpAsBind`: the candidate must carry one of the *effective names* the earlier binding's
        // card holds. The binding is still the previous pick here (this step's answer rebinds it), which
        // is what lets 「そのキャラ」 in a later sentence speak about *this* pick.
        if (e.sameNameAsBind !== undefined) {
          const anchors = f.selections?.[e.sameNameAsBind] ?? [];
          const anchorNames = new Set(anchors.flatMap(id => {
            const owner = s.cards[id]?.owner;
            return owner === undefined ? [] : effectiveNames(s, id, owner);
          }));
          // With no anchor (the earlier pick was declined, or found nobody) the printed 「同じカード名」 has
          // nothing to name, so nobody qualifies — leaving the pool untouched would re-open the very
          // over-broad reading this field exists to close.
          options = options.filter(id => {
            if (!anchorNames.size) return false;
            const owner = s.cards[id]?.owner;
            return owner !== undefined && effectiveNames(s, id, owner).some(name => anchorNames.has(name));
          });
        }
        // 「選んだカードと必要エナジーが同じ」 (KMR-2-034) — the candidate's requirement must equal the
        // card the earlier binding holds, compared as colour × count with the zero rows dropped. Both
        // sides read `effectiveRequiredEnergy`, the count/filter-side reader every zone already uses: the
        // field anchor sees the field-side statics, a hand candidate the hand-side ones. With no anchor
        // (the earlier pick was declined) nobody qualifies — reopening the whole hand pool would be the
        // over-broad reading this field exists to close.
        if (e.sameEnergyAsBind !== undefined) {
          const anchors = f.selections?.[e.sameEnergyAsBind] ?? [];
          const anchor = anchors.length ? energyRequirementKey(effectiveRequiredEnergy(s, anchors[0]!)) : undefined;
          options = options.filter(id => anchor !== undefined && energyRequirementKey(effectiveRequiredEnergy(s, id)) === anchor);
        }
        if (e.differentNameFromBind !== undefined) {
          const anchors = f.selectionNames?.[e.differentNameFromBind]
            ?? (f.selections?.[e.differentNameFromBind] ?? []).flatMap(id => effectiveNames(s, id, f.player));
          options = anchors.length ? options.filter(id => !effectiveNames(s, id, s.cards[id]!.owner).some(name => anchors.includes(name))) : [];
        }
        // 「…をそれぞれ同じ枚数望むだけ…」 (TKG-1-052) — this pick's width is the one the named earlier
        // binding already answered. A zero width is not a question at all (the print's "any number"
        // includes none), so it binds nothing and moves on.
        const sameCount = e.sameCountAsBind !== undefined ? (f.selections?.[e.sameCountAsBind] ?? []).length : undefined;
        if (sameCount === 0) { f.selections ??= {}; f.selections[e.bind] = []; break; }
        // 「別のラインのキャラ1枚と位置を入れ替える」 (KGR-1-031) — the partner must sit on a different
        // line than the card an earlier selection bound. A relation between two picks, so like
        // `sameBpAsBind` it lives on the step: the candidate loop is where both cards' slots are readable.
        if (e.differentLineFromBind !== undefined) {
          const anchors = f.selections?.[e.differentLineFromBind] ?? [];
          const anchorLines = new Set(anchors.flatMap(id => {
            const owner = s.cards[id]?.owner;
            const line = owner === undefined ? undefined : locate(s, owner, id)?.line;
            return line === undefined ? [] : [line];
          }));
          if (anchorLines.size) {
            options = options.filter(id => {
              const owner = s.cards[id]?.owner;
              const line = owner === undefined ? undefined : locate(s, owner, id)?.line;
              return line !== undefined && !anchorLines.has(line);
            });
          }
        }
        // 「この効果で場外に置いたカードとカードナンバー/必要エナジーが異なる〈X〉」 — a relation to the
        // card this effect just sent to 場外, which only the frame's own record answers. With nothing
        // removed the print's follow-up would not run at all; the filter then admits nobody rather than
        // silently widening to every card.
        if (filter && (filter.cardNumberDiffersFromRemoved || filter.energyDiffersFromRemoved)) {
          const removed = f.discardedIds ?? [];
          const removedNumbers = removed.map(id => peekDefinition(s, id)?.functionalId).filter((value): value is string => value !== undefined);
          const removedEnergies = removed.map(id => {
            const definition = peekDefinition(s, id);
            return definition === undefined ? undefined : Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
          }).filter((value): value is number => value !== undefined);
          options = options.filter(id => {
            const definition = peekDefinition(s, id);
            if (!definition) return false;
            if (filter.cardNumberDiffersFromRemoved && removedNumbers.includes(definition.functionalId)) return false;
            if (filter.energyDiffersFromRemoved) {
              const total = Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
              if (removedEnergies.includes(total)) return false;
            }
            return true;
          });
        }
        // 「そのカードと必要エナジーの数か元々のBPが同じ…」 (JJK-3-049) / 「この効果で場外に置いたカードと
        // 元々のBPが同じ…」 (OPM-1-098) — the equality twin of the pair above, off the same record and with
        // the print's own か between the two enabled halves. Nothing discarded means the printed clause
        // never ran; the filter then admits nobody rather than widening to every card.
        if (filter && filter.asRemoved) {
          const removedDefs = (f.discardedIds ?? []).map(id => peekDefinition(s, id)).filter((d): d is NonNullable<typeof d> => d !== undefined);
          const energies = new Set(removedDefs.map(d => Object.values(d.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0)));
          const printedBps = new Set(removedDefs.map(d => d.bp ?? 0));
          options = options.filter(id => {
            const definition = peekDefinition(s, id);
            if (!definition) return false;
            if (!removedDefs.length) return false;
            if (filter.asRemoved!.energy) {
              const total = Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
              if (energies.has(total)) return true;
            }
            if (filter.asRemoved!.originalBp && printedBps.has(definition.bp ?? 0)) return true;
            return false;
          });
        }
        // 「公開したカードのBP以下」 (REZ-1-044/060) — a relation to the card this effect just revealed:
        // its BP is read with the Re:Zero treatments, and no candidate-side field could carry it. With
        // nothing revealed the printed clause would not have run, so the filter then admits nobody.
        // 「この効果で退場させた〈X〉のBP以下」 (BTR-1-078) — the ceiling is the retirement-time BP the
        // frame recorded (current BP, Q414). Nothing retired means the printed clause would not have run,
        // so the filter admits nobody.
        if (filter && filter.retiredBpCeiling) {
          const bps = f.retiredBps ?? [];
          const ceiling = bps.length ? Math.max(...bps) : undefined;
          options = ceiling === undefined ? [] : options.filter(id => {
            const owner = s.cards[id]?.owner;
            return owner !== undefined && currentBP(s, id, owner) <= ceiling;
          });
        }
        if (filter && filter.revealedBpCeiling) {
          const revealed = f.revealedIds ?? [];
          const ceilings = revealed.map(id => revealedBpOf(s, id, f.player)).filter((value): value is number => value !== undefined);
          const ceiling = ceilings.length ? Math.max(...ceilings) : undefined;
          options = ceiling === undefined ? [] : options.filter(id => (peekDefinition(s, id)?.bp ?? Number.NEGATIVE_INFINITY) <= ceiling);
        }
        // 「公開したカードと同じカード名のカード」 (HTR-2-051, Q624) — the name sibling of the ceiling
        // above, read off the same frame record: the candidate's effective names must include one of the
        // revealed card's names (Q624: the match is by printed name, so a different card number with the
        // same name qualifies). With nothing revealed the printed clause would not have run, so the
        // filter admits nobody.
        if (filter && filter.sameNameAsRevealed) {
          const revealed = f.revealedIds ?? [];
          const revealedNames = new Set(revealed.flatMap(id => {
            const owner = s.cards[id]?.owner;
            return owner === undefined ? [] : effectiveNames(s, id, owner);
          }));
          options = options.filter(id => {
            if (!revealedNames.size) return false;
            const owner = s.cards[id]?.owner;
            return owner !== undefined && effectiveNames(s, id, owner).some(name => revealedNames.has(name));
          });
        }
        // 「公開したカードの必要エナジーの数×1000以下のBP」 (CGD-1-069) — the energy-axis sibling of
        // the ceiling above, read off the same frame record: the candidate's printed BP may not exceed
        // 1000 × the revealed card's printed required-energy total. With nothing revealed the printed
        // clause would not have run, so the filter admits nobody.
        if (filter && filter.revealedEnergyBpCeiling) {
          const revealed = f.revealedIds ?? [];
          const ceilings = revealed
            .map(id => peekDefinition(s, id))
            .filter((definition): definition is NonNullable<typeof definition> => definition !== undefined)
            .map(definition => Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0) * 1000);
          const ceiling = ceilings.length ? Math.max(...ceilings) : undefined;
          options = ceiling === undefined ? [] : options.filter(id => (peekDefinition(s, id)?.bp ?? Number.NEGATIVE_INFINITY) <= ceiling);
        }
        // 「この効果でリムーブエリアに置いたカードのBPの合計以下の…」 (KMR-2-068) — the sibling ceiling over
        // the cards this effect just moved: the candidate's printed BP may not exceed their total. An
        // empty record leaves the ceiling at zero, so nobody qualifies (nothing was moved, nothing is
        // small enough) — the same reading the print gives an effect whose move found no card.
        if (filter && filter.removedBpCeiling !== undefined) {
          const moved = filter.removedBpCeiling === 'removal' ? (f.removedIds ?? []) : (f.discardedIds ?? []);
          const ceiling = moved.reduce((total, id) => total + (peekDefinition(s, id)?.bp ?? 0), 0);
          options = options.filter(id => (peekDefinition(s, id)?.bp ?? Number.NEGATIVE_INFINITY) <= ceiling);
        }
        f.selections ??= {};
        if (e.declaredTarget) {
          const declared = f.declared?.targetId;
          if (declared !== undefined) {
            if (options.includes(declared)) {
              const total = selectionTaxHandTotal(s, f, [declared]);
              if (total > 0) {
                const p = s.players[f.player];
                if (total > p.hand.length) { f.selections[e.bind] = []; break; }
                f.selectionTaxDeferred = { mode: 'declared', bind: e.bind, declared };
                f.stage = 'option';
                request(ctx, f, 'cards', '选择支付选择税弃置的手牌', total, total, [...p.hand]);
                return;
              }
              chargeSelectionTax(ctx, f, [declared]); f.selections[e.bind] = [declared];
            }
            else f.selections[e.bind] = [];
            break;
          }
          const useTarget = peekDefinition(s, f.sourceId)?.useTarget;
          if (useTarget) options = options.filter(id => !matchesFilter(s, id, useTarget.filter, f.sourceId));
        }
        // 「…全てを退場させる」 — every matching candidate is bound, with nothing to answer: the printed
        // 「全て」 is not a choice, so no decision is opened and no cap applies. Placed before the cap
        // and ask paths because neither is part of this reading. (`eligibleFor` has already dropped
        // cards the printed protections exclude, which is the whole of "every *matching* card".)
        if (e.all) { f.selections[e.bind] = options; recordChosen(ctx, f, options); break; }
        // 「…1枚につき、『+1枚』される」 — the cap is raised by a board count, read here so the choice
        // always offers the number the print allows at the moment it is made.
        const cap = e.maxPer ? e.max + e.maxPer.amount * tierCountOf(s, f.player, f.sourceId, e.maxPer.count) : e.max;
        // 「…のカード名1種類につき、この効果で場外に置く手札の枚数-1。」 / 「…1枚につき、選べる
        // …の枚数+1。」 — the printed count adjusted by a board count, read where the step runs (the
        // board may have moved since the ability started). Only a *fixed* printed count (min > 0,
        // SMD-1-031) moves both ends together; a width spelling printed as 「N枚**まで**選び」 keeps its
        // 0 floor and lets the delta raise the ceiling alone (KGR-1-011 / KJN-1-049).
        const delta = e.countDelta ? tierCount(ctx, f, e.countDelta.count) * e.countDelta.amount : 0;
        // 「…をそれぞれ同じ枚数望むだけ…」 — a forced width overrides both printed ends: the earlier
        // binding answered the count, and this pick must match it card for card.
        const min = sameCount !== undefined ? sameCount : Math.max(0, e.min + (e.min > 0 ? delta : 0));
        const capped = sameCount !== undefined ? sameCount : Math.max(0, cap + delta);
        // The 「そうした場合」 gate asks for the count this pick *actually* printed: a fixed count moved by the
        // board delta (SMD-1-031's 「置く枚数-1」) is satisfied by the reduced number, not by the 6 the print
        // starts from. Only the fixed-count spelling (the one whose floor `min` moved above) is adjusted; a
        // 「まで」 width, `printedMin` and `upTo` keep the printed-count reading chosen above (KGR-1-011).
        if (delta !== 0 && e.min > 0 && e.printedMin === undefined && !e.upTo && f.selectPrinted !== undefined) f.selectPrinted = Math.max(0, f.selectPrinted + delta);
        if (e.auto) { f.selections[e.bind] = options.slice(0, capped); recordChosen(ctx, f, f.selections[e.bind]!); break; }
        // 「N枚を…してもよい」 (binary, `printedMin`): fewer candidates than the printed count means the offer cannot
        // be taken up, so nothing is asked (Q685; an answer of 1..N-1 would be refused anyway).
        if (e.printedMin !== undefined && e.min === 0 && options.length < e.printedMin && sameCount === undefined) { f.selections[e.bind] = []; break; }
        if (options.length && capped > 0) {
          // 「自分の手札を1枚相手が選ぶ」 — the *opponent* answers this one. The pending decision carries
          // who must answer, and every command is checked against it, so naming them here is the whole
          // mechanism: the cards stay hidden from their owner's side of the table either way.
          const chooser = e.choose === 'opponent' ? otherOf(f.player) : f.player;
          const next = f.steps[f.index + 1];
          const recovery = e.zone === 'ownSideline' && next?.type === 'act' && next.target === e.bind && next.operation === 'return';
          const prompt = recovery ? `选择最多 ${capped} 张场外卡加入手牌${min === 0 ? '（可不回收）' : ''}`
            : e.restOptional ? '可放弃：选择至多若干张卡' : prompts.return.replace('要返回手牌的卡', '目标卡');
          request(ctx, f, e.zone === 'ownAp' || e.zone === 'enemyAp' ? 'ap' : 'cards', prompt, Math.min(min, capped), capped, options, chooser);
          // 「この効果で同じカード名のキャラを選ぶことはできない」 — enforced where the choice is made.
          if (e.distinctNames && s.pending?.type === 'effect') s.pending.distinctNames = true;
          // 「各必要エナジーにつき1枚まで」 — one card per printed requirement total, refused where the
          // answer arrives (the same `pending.distinctEnergy` the look takes set).
          if (e.distinctEnergy && s.pending?.type === 'effect') s.pending.distinctEnergy = true;
          // 「必要エナジーの合計が4以上になるように望む枚数」 (MMM-2-012) — the printed total floor on the
          // open-width pick, refused where the answer arrives.
          if (e.energySumMin !== undefined && s.pending?.type === 'effect') s.pending.energySumMin = e.energySumMin;
          // 「BPの合計が6000以下になるように…選び、退場させる」 (TLR-1-030) 与「BPの合計が4000以上に
          // なるように…レストにする」 (DST-1-078) — the set bounds on the pick, the same lifecycle.
          if (e.bpSumMax !== undefined && s.pending?.type === 'effect') s.pending.bpSumMax = e.bpSumMax;
          if (e.bpSumMin !== undefined && s.pending?.type === 'effect') s.pending.bpSumMin = e.bpSumMin;
          return;
        }
        f.selections[e.bind] = [];
        break;
      }
      case 'act': {
        const ids = f.selections?.[e.target] ?? [];
        if (e.operation === 'retire' && ids.length === 1) {
          const retiring = ids[0]!;
          const owner = s.cards[retiring]?.owner;
          // 「…代わりに自分の手札を1枚場外に置いてもよい」 — the carrier's own cost offer comes first:
          // the owner may pay from hand (choosing which cards) and the retirement is cancelled.
          const trigger = f.route === 'trigger';
          const cost = owner === undefined ? undefined : retireCostSubstitute(s, owner, retiring, f.player, trigger, f.route ?? 'characterEffect');
          if (owner !== undefined && cost !== undefined) {
            f.stage = 'substituteCost';
            f.selections ??= {};
            f.selections.__retiring = [retiring];
            // 「そうした場合、…」 — the cost form's own follow-up (BLC-2-067) runs on the saved card once
            // the offer is accepted, the same channel the substitute form beside it uses.
            if (cost.follow?.length) f.substituteFollow = structuredClone(cost.follow);
            // 「…代わりに…してもよい」 — the offer is declinable, so nothing is forced: an empty answer
            // lets the printed retirement run.
            if (cost.rest === true) {
              // 「…代わりに「アクティブのこのキャラをレストにし、自分の手札をN枚場外に置く。」をしてもよい。」
              // (MSS-1-034) — the price has two parts; the answer picks the hand cards and the resting
              // happens with the payment.
              f.selections.__payRest = [retiring, String(cost.hand ?? 0)];
              request(ctx, f, 'cards', `可以休息该角色并弃 ${cost.hand ?? 0} 张手牌代替离场（可不选）`, 0, cost.hand ?? 0, [...s.players[owner].hand], owner);
            } else if (cost.toRemoval === true) {
              // 「…代わりにそのキャラとそのキャラのレイド元のカードをリムーブエリアに置いてもよい。」
              // (WBK-1-017) — no price to choose: the single answer is the retiring card itself.
              f.selections.__payRemove = [retiring];
              request(ctx, f, 'cards', '可以将该角色与其RAID基底卡置入移除区代替退场（可不选）', 0, 1, [retiring], owner);
            } else if (cost.under !== undefined) {
              f.selections.__payUnder = [retiring];
              const pile = [...(findField(s, owner, retiring)?.card.faceDown ?? [])];
              request(ctx, f, 'cards', `可以将卡下 ${cost.under} 张里侧卡置于场外代替退场（可不选）`, 0, cost.under, pile, owner);
            } else if (cost.life !== undefined) {
              f.selections.__payLife = [retiring];
              request(ctx, f, 'cards', `可以将生命区 ${cost.life} 张卡置于场外代替离场（可不选）`, 0, cost.life, [...s.players[owner].life], owner);
            } else if (cost.top === true) {
              // 「…代わりにレイド状態の上のこのカードを場外に置いてもよい。」 — the peel price is the
              // carrier itself, so the offer's single answer is the retiring card; an empty answer lets
              // the printed retirement run.
              f.selections.__payTop = [retiring];
              request(ctx, f, 'cards', '可以将此卡置入场外、让基底留在场上代替退场（可不选）', 0, 1, [retiring], owner);
            } else if (cost.base === true) {
              // 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 (ARK-1-059) — the base
              // price: the offered answer is the *paying* card (the retiring card itself, or the
              // protector that watches over it), whose first under-card leaves for 場外.
              const paying = cost.carrierId ?? retiring;
              f.selections.__payBase = [paying];
              request(ctx, f, 'cards', '可以将此角色的RAID基底卡置入场外代替退场（可不选）', 0, 1, [paying], owner);
            } else if (cost.replenish !== undefined) {
              // 「…代わりに自分の山札の上から1枚を裏向きでこのキャラの下に置いてもよい。」 — the
              // replenish price has nothing to choose either; the single answer is the retiring card,
              // and the printed count rides the record so the answer handler places the same number.
              f.selections.__payReplenish = [retiring, String(cost.replenish)];
              request(ctx, f, 'cards', '可以将牌库顶的卡面朝下置于此卡下方代替退场（可不选）', 0, 1, [retiring], owner);
            } else if (cost.energy === true) {
              // 「…代わりにこのキャラをエナジーLに移動させてもよい。」 (KMY-P-002) — the relocation
              // price: the single answer is the retiring card; accepting cancels the departure and moves
              // it to the energy line instead.
              f.selections.__payEnergy = [retiring];
              request(ctx, f, 'cards', '可以改为移动到能量线代替离场（可不选）', 0, 1, [retiring], owner);
            } else {
              request(ctx, f, 'cards', `可以弃 ${cost.hand} 张手牌代替退场（可不选）`, 0, cost.hand!, [...s.players[owner].hand], owner);
            }
            return;
          }
          const substitutes = owner === undefined ? { ids: [] } : retireSubstitutes(s, owner, retiring, f.player, trigger);
          if (owner !== undefined && substitutes.ids.length) {
            f.stage = 'substitute';
            f.selections ??= {};
            f.selections.__retiring = [retiring];
            // 「そうした場合、その〈X〉を…」 — the follow-up the offered static prints runs once the
            // substitution is accepted; the frame carries it until the answer arrives.
            if (substitutes.follow) f.substituteFollow = structuredClone(substitutes.follow);
            request(ctx, f, 'cards', '可以由其他角色代为退场（可不选）', 0, 1, substitutes.ids, owner);
            return;
          }
        }
        // 「このキャラが場から手札に戻る場合、代わりに自分の手札を1枚場外に置いてもよい」 — the same
        // cost offer for a *return*: the carrier buys its way out of the hand with `hand` cards, and
        // declining lets the printed return run. Reuses the retirement answer flow through
        // `f.substituteOp`, so one answer handler serves both destinations.
        if (e.operation === 'return' && ids.length === 1) {
          const returning = ids[0]!;
          const owner = s.cards[returning]?.owner;
          const cost = owner === undefined ? undefined : returnCostSubstitute(s, owner, returning);
          if (owner !== undefined && cost !== undefined) {
            f.stage = 'substituteCost';
            f.substituteOp = 'return';
            f.selections ??= {};
            f.selections.__retiring = [returning];
            request(ctx, f, 'cards', `可以弃 ${cost} 张手牌代替回到手牌（可不选）`, 0, cost, [...s.players[owner].hand], owner);
            return;
          }
        }
        // 「…1枚につき、このターン中、BP±N」 / 「…1枚につき、さらに『BP+1000』される」 — the amount is read
        // from the board where the step runs (the frame's own history is part of it), so a count that changes
        // between two resolutions of the same ability gives each its own value.
        // 「自分の場のキャラの最大BP分BPをプラスし」 — the amount is an extremum over a pool, the amount
        // sibling of the `bound` filter field.
        let amount = e.amountPer ? (e.amount ?? 0) + e.amountPer.amount * tierCount(ctx, f, e.amountPer.count) : e.amount;
        if (e.amountFrom) amount = (amount ?? 0) + poolBpExtremum(ctx, f, e.amountFrom);
        let acted = 0;
        const offerLeavePrice = e.operation === 'retire' && ids.length > 1;
        for (let i = 0; i < ids.length; i++) {
          if (applyOperation(ctx, f, ids[i]!, e.operation, amount, e.line, e.keywords, e.relative === true, e.energy, e.duration, e.baseBind, e.underBind, e.chooser, e.faceUp === true, e.baseFromPeel, e.faceDownOnly === true, e.underOnly === true, e.suppressOnPlay === true, false, offerLeavePrice)) acted++;
          // A question one placement asked owns the frame; the ids still behind it ride along so the
          // answer's handler drains them in printed order (a multi-pick deploy asks once per card, and a
          // move onto a full line asks once per overflowing card — KIN-1-001/Q1522).
          if (s.pending) {
            if ((e.operation === 'deploy' || e.operation === 'deployRested' || e.operation === 'move' || e.operation === 'raid') && i + 1 < ids.length) {
              (f.selections ??= {}).__actRest = ids.slice(i + 1);
            }
            return;
          }
        }
        // An operation may ask a question of its own (「相手の山札の上か下の相手が選んだ方に置く」 stages
        // a top-or-bottom choice). The frame must park here, or the loop would walk past the pending and
        // the frame's own close would overwrite it with the battle resume.
        if (s.pending) return;
        f.didCount = acted;
        recordSelectAct(f, e.target, acted);
        break;
      }
      case 'actSource': {
        const c = source(s, f);
        // 「レイド状態のこのキャラの一番上のカードを…」 (Q1047) — the printed subject is the raid
        // stack's top card, which exists only while the source is stacked: with nothing underneath the
        // instruction does nothing at all, and the records a 「そうした場合」 follow-up reads stay empty.
        // The bare 「このキャラの一番上のカード」 spelling deliberately keeps the self-peel reading, so
        // the gate rides the qualified emit's flag alone.
        if (e.raidTopOnly && !(c && c.underneath.length > 0)) break;
        // 「レイド状態のこのキャラの一番上のカードを自分の場外に置いてもよい。」 (SMD-1-061) — the
        // optional spelling of a source-scoped operation: the question comes before anything moves, and a
        // decline leaves every record untouched (the printed 「そうした場合」 follow-ups read those
        // records). The accepted answer re-queues a confirmed copy, the same two-pass shape the optional
        // look uses.
        if (e.optional && !f.actConfirmed) {
          f.stage = 'actSourceOptional';
          request(ctx, f, 'option', '是否把最上面的卡放置到场外？0 = 不放置（不变），1 = 放置', 1, 1, ['0', '1']);
          return;
        }
        delete f.actConfirmed;
        // 「場外にある場合」 abilities act on their own card while it sits in the discard pile, where
        // there is no `FieldCard` for `source()` to find. A task whose source *was* on the field keeps
        // the instance check (its `sourceInstance` is set), so the fallback only reaches cards that
        // were already in 場外 when the ability was collected — the printed 「場外のこのカード」 family.
        // The *event card being resolved* is the third shape: it is held by the frame (`eventCard`) and
        // in no zone at all, so 「このカードをリムーブエリアに置く」 on an event card names it.
        // A field source moved by this frame's own actSource may return from its recorded actual zone;
        // this does not let other operations act on a departed source, or recover a source lost elsewhere.
        const movedSource = e.operation === 'return' && f.sourceMovedTo !== undefined
          && s.players[f.player][f.sourceMovedTo].includes(f.sourceId);
        const triggerReplayRemoval = (f as EffectFrame & { triggerReplayRemoval?: true }).triggerReplayRemoval === true;
        const pileSource = f.sourceInstance === undefined
          || f.abilityEvent === 'onRetire' || f.abilityEvent === 'onLeftField' || f.abilityEvent === 'onReturnedToHand';
        const id = c ? c.cardId
          : movedSource ? f.sourceId
          : triggerReplayRemoval && s.players[f.player].removal.includes(f.sourceId) ? f.sourceId
          // 「場外にある場合」 and 「手札にあるこのカードを…」 abilities act on their own card from the pile
          // or the hand, where there is no `FieldCard` for `source()` to find.
          : pileSource && s.players[f.player].sideline.includes(f.sourceId) ? f.sourceId
            : pileSource && s.players[f.player].hand.includes(f.sourceId) ? f.sourceId
              : f.sourceInstance === undefined && f.abilityEvent === 'onRemoved' && s.players[f.player].removal.includes(f.sourceId) ? f.sourceId
              : f.eventCard === f.sourceId ? f.sourceId
                : undefined;
        if (id !== undefined) {
          // 「…1枚につき、このキャラはこのターン中、BP+500」 — the amount scales with a count read where the
          // step resolves (a frame-scoped count only exists here), the same reading `act.amountPer` gives.
          const amount = e.amountPer ? (e.amount ?? 0) + e.amountPer.amount * tierCount(ctx, f, e.amountPer.count) : e.amount;
          // 「このカードを裏向きでその〈ラピ〉の下に置く」 — `underBind` names a *bound* host; without it
          // 「このカードの下に」 never names a host other than the source. `baseFromPeel` belongs to the
          // `act` shape's raid leg alone, which an `actSource` step never carries.
          const did = applyOperation(ctx, f, id, e.operation, amount, e.line, e.keywords, e.relative === true, e.energy, e.duration, e.baseBind, e.underBind, undefined, e.faceUp === true, undefined, e.faceDownOnly === true, e.underOnly === true, e.suppressOnPlay === true, e.operation === 'retire' || e.operation === 'remove' || e.operation === 'return',
            e.operation === 'retire');
          // The printed destination has been applied; the frame's end-of-resolution park (「事件卡入场外」)
          // must not send the card to 場外 a second time.
          if (id === f.eventCard && LEAVES_FIELD.has(e.operation)) delete f.eventCard;
          // The same parking rule as the `act` step: an operation that asked a question (the deploy
          // line / full-line questions) owns the pending, and the answer's handler writes the count.
          if (s.pending) return;
          f.didCount = did ? 1 : 0;
        }
        break;
      }
      case 'discard': {
        const target = scopePlayer(f.player, e.player);
        const hand = s.players[target].hand;
        // A filtered discard only accepts cards the filter selects, and the player picks which of
        // them go. The unfiltered opponent / single-card-optional paths keep their existing behaviour
        // so no already-implemented card changes; a filtered discard always asks.
        const eligible = e.filter ? hand.filter(id => matchesFilter(s, id, e.filter, f.sourceId)) : hand;
        // 「このキャラの下の裏向きのカードの枚数分、自分の手札を場外に置く。」 (MGS-1-075/076) — the
        // printed width is a board count (with the frame's `underIds` snapshot as the retire-time
        // fallback), and `count` is the placeholder the reader overrides.
        // 「全て」 (`all`) is whatever the filter accepts right now, with no width of its own.
        const want = e.all ? eligible.length : e.countSource ? tierCount(ctx, f, e.countSource) : e.count;
        // A *cost* cannot be paid in part: the ability that prints it is illegal with too few cards.
        if (e.strict && eligible.length < want) requireRule(false, 'INVALID_CHOICE', '手牌不足，无法支付该效果的费用。');
        const count = Math.min(want, eligible.length);
        {
          const next = f.steps[f.index + 1];
          if (!e.all && !e.optional && e.max === undefined && want >= 1
            && next?.type === 'gained' && next.on === undefined && next.filter === undefined
            && next.exclude === undefined && next.min === undefined) f.discardPrinted = want;
          else delete f.discardPrinted;
        }
        if (count === 0) { f.discardedCount = 0; f.didCount = 0; break; }
        // 「自分の手札を2枚場外に置いてもよい。」 — the binary offer (Q685: 「まで」と書かれていないため、2枚を置くか、
        // 1枚も置かないかを選択する必要があります): with fewer eligible cards than the printed count it cannot be
        // taken up at all, and an answer of 1..N-1 is refused where it arrives (`discardBinary`).
        if (isBinaryOptionalDiscard(e) && eligible.length < e.count) { f.discardedCount = 0; f.didCount = 0; break; }
        if (!e.all) {
          f.stage = 'discard';
          f.selections ??= {};
          f.selections.__discard = [];
          // 「自分の手札を1枚以上場外に置き」 — the printed floor with an open top: the answer may carry
          // anything from `count` up to the cap (and to whatever is actually there).
          const upper = Math.min(e.max ?? count, eligible.length);
          const lower = e.optional ? 0 : count;
          // 「相手は自身の手札を2枚場外に置いてもよい。」 (KMR-1-088) — a *declinable* discard of the
          // opponent's own hand is the opponent's decision: the question goes to them (`chooser`), the
          // same redirect `chooseOption.chooser === 'opponent'` uses.
          request(ctx, f, 'cards', (upper === lower ? `选择 ${count} 张手牌送至场外` : `选择 ${lower}~${upper} 张手牌送至场外`) + (e.optional ? '（可不弃牌）' : ''), lower, upper, eligible, target);
          return;
        }
        {
          const picked = eligible.slice(0, count);
          s.players[target].hand = hand.filter(id => !picked.includes(id));
          if (e.to === 'removal') {
            // 「このカードが使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く。」 —
            // a discard is not a use, so the static's holder reaches 場外 (and joins the frame's discard
            // record below) instead of the removal area.
            for (const id of picked) {
              if (removalRedirectsToSideline(s, id, f.sourceId)) { s.players[target].sideline.push(id); continue; }
              s.players[target].removal.push(id);
              (f.removedIds ??= []).push(id);
            }
          } else {
          // 「…以外でこのカードが場外に置かれる場合、代わりにリムーブエリアに置く。」 — a discard is not
          // the card's own use, so each card's destination is decided here.
          for (const id of picked) (sidelineRedirectsToRemoval(s, id) ? s.players[target].removal : s.players[target].sideline).push(id);
          }
          // 「このターン中に自分の手札を場外に置いている」 reads the turn log, which records the cards
          // themselves so a name/trait filter can be applied later; the effect's controller rides along
          // for the 「自分の効果で」 spelling.
          const causeOwner = s.cards[f.sourceId]?.owner;
          for (const id of picked) logTurnEvent(s, 'discardedFromHand', target, id, causeOwner === undefined ? {} : { causeOwner, causeId: f.sourceId });
          // 「自分の効果で自分の手札を1枚場外に置いた時、…」 — the moment a *hand* card reached 場外.
          // Raised per card with that card as the event's subject, so 「そのカード」 can name it; the
          // effect's own source rides along as the cause, which is what 「〈X〉の効果で」 narrows.
          for (const id of [...new Set(picked)]) ctx.queue.push(...collectTriggered(ctx, target, 'onDiscardedFromHand', id, id, { causeId: f.sourceId }));
          f.discardedCount = picked.length;
          f.didCount = picked.length;
          // The identities too, exactly as the asked-for discard records them: 「この効果で場外に置いた
          // カード」 is asked about whichever route actually sent the cards away, and an unfiltered optional
          // discard resolves on this one.
          f.discardedIds = [...picked];
          ctx.events.push({ type: 'effectDiscarded', data: { player: target, cards: picked } });
          break;
        }
      }
      case 'discardSameEnergy': {
        // 「自分の手札の必要エナジーが同じカードを3枚場外に置く」 — the group shares one required-energy
        // layout *among themselves* (Q1140), which no per-card filter can express, so the choice is asked
        // as a plain hand selection and the relation is validated where the answer arrives.
        const hand = p.hand;
        const groups = new Map<string, number>();
        for (const id of hand) { const sig = energySignature(s, id); groups.set(sig, (groups.get(sig) ?? 0) + 1); }
        if (hand.length < e.count || ![...groups.values()].some(n => n >= e.count)) {
          // No feasible group: the printed discard cannot happen, and a following 「そうした場合」 falls through.
          f.discardedCount = 0;
          f.didCount = 0;
          break;
        }
        f.selections ??= {};
        f.selections.__discard = [];
        request(ctx, f, 'cards', `选择 ${e.count} 张必要能量相同的卡送至场外${e.optional ? '（可不选）' : ''}`, e.optional ? 0 : e.count, e.count, [...hand]);
        if (s.pending?.type === 'effect') s.pending.sameEnergy = true;
        return;
      }
      case 'delayMainEnd': {
        // 「このメインフェイズ終了時、…」 — parked on the player, not the source card: the delayed
        // instruction outlives its source (a delayed effect is created by the resolution, not held by
        // the card), and the main phase's close runs it.
        p.delayedMainEnd = [...(p.delayedMainEnd ?? []), { turn: s.turn, sourceId: f.sourceId, steps: structuredClone(e.effects) }];
        break;
      }
      case 'delayOpponentTurnStart': {
        // 「次の相手のターン開始時、…」 — parked on the *controller* with the number that opponent turn
        // will have. Activated on the controller's own turn the number is `+1`; an activation during the
        // opponent's turn (a permission effect) names the turn after it, `+2`. The current bindings ride
        // along: the delayed instruction speaks about 「選んだキャラ」, whose selection frame will be gone.
        const nextOpponentTurn = s.turn + (s.activePlayer === f.player ? 1 : 2);
        const bindings = f.selections && Object.keys(f.selections).length ? structuredClone(f.selections) : undefined;
        p.delayedTurnStart = [...(p.delayedTurnStart ?? []), { turn: nextOpponentTurn, sourceId: f.sourceId, steps: structuredClone(e.effects), ...(bindings ? { bindings } : {}) }];
        break;
      }
      case 'delayAttackPhaseStart': {
        // 「このターンのアタックフェイズ開始時、…」 — parked on the player, not the source card: the
        // instruction is created by this resolution and must still resolve after its source has left
        // (KGD-1-037 retires itself when the main phase closes, before the attack phase opens). Turn-
        // stamped so the phase opening consumes exactly the entries of the turn that created them.
        p.delayedAttackStart = [...(p.delayedAttackStart ?? []), { turn: s.turn, sourceId: f.sourceId, steps: structuredClone(e.effects) }];
        break;
      }
      case 'delayAttackPhaseEnd': {
        // The mirror for 「このターンのアタックフェイズ終了時、…」 — the event cards' reading (the use
        // resolves in the main phase, the printed moment comes later in the same turn).
        p.delayedAttackEnd = [...(p.delayedAttackEnd ?? []), { turn: s.turn, sourceId: f.sourceId, steps: structuredClone(e.effects) }];
        break;
      }
      case 'clashReveal': {
        // 「自分と相手は自身の山札の上から1枚を公開し、公開したカードを自身の山札の下に置く。」 — both
        // sides reveal their own deck top; the two cards are recorded on the frame before they go back,
        // because once they are in the deck nothing tells them apart.
        const other = otherOf(f.player);
        const mine = p.deck.splice(0, Math.min(e.count, p.deck.length));
        const theirs = s.players[other].deck.splice(0, Math.min(e.count, s.players[other].deck.length));
        f.clashSelf = [...mine];
        f.clashOpponent = [...theirs];
        if (e.to === 'bottom') { p.deck.push(...mine); s.players[other].deck.push(...theirs); }
        else { p.deck.unshift(...mine); s.players[other].deck.unshift(...theirs); noteDeckTop(p); noteDeckTop(s.players[other]); }
        f.revealedIds = [...mine];
        f.revealedFrom = 'deck';
        if (mine.length) queueRevealedFromDeck(ctx, mine);
        if (theirs.length) queueRevealedFromDeck(ctx, theirs);
        f.didCount = mine.length + theirs.length;
        ctx.events.push({ type: 'clashRevealed', data: { player: f.player, cards: [...mine, ...theirs] } });
        break;
      }
      case 'millTop': {
        const target = scopePlayer(f.player, e.player);
        // 「…を裏向きで…の下に置いてもよい」 — the placement is the player's choice, and the host is
        // already fixed, so there is no selection left to decline through. The decision offers the host
        // itself as the single option: choosing it performs the placement, choosing nothing keeps the
        // deck as it was. (Without the flag the step is the printed 「置く」 and runs immediately.)
        if (e.optional) {
          const hostId = e.underBind ? (f.selections?.[e.underBind] ?? [])[0] : f.sourceId;
          if (hostId !== undefined && s.players[target].deck.length) {
            f.stage = 'mill';
            // The single answer is "yes": a mill to 場外 (KGR-1-015) places nothing under a host, so the
            // prompt says where the card goes rather than borrowing the under-placement wording.
            request(ctx, f, 'cards', e.to === 'sideline' ? '可将牌库顶的卡置入场外（可不选）' : '可将牌库顶的卡面朝下置于该角色下方（可不选）', 0, 1, [hostId]);
            return;
          }
          break;
        }
        // 「…N枚まで場外に置く」 — Q677/Q678: the controller declares a count from 0 to N *before* any
        // card moves, and the declaration is binding (Q679/Q680). What can be declared is the printed N
        // capped by what the deck actually holds; an empty deck (or an under-placement whose host is
        // already gone) leaves 0 as the only legal declaration, so no question is raised.
        if (e.upTo) {
          const cap = Math.min(e.count, s.players[target].deck.length);
          const hostId = e.to === 'under' ? (e.underBind ? (f.selections?.[e.underBind] ?? [])[0] : f.sourceId) : undefined;
          if (cap > 0 && (e.to !== 'under' || hostId !== undefined)) {
            f.stage = 'millCount';
            request(ctx, f, 'option', `从牌库顶将 0～${cap} 张${e.to === 'sideline' ? '置于场外' : e.to === 'removal' ? '置于移除区' : '面朝下置于该角色下方'}（先声明张数）`, 1, 1,
              Array.from({ length: cap + 1 }, (_, k) => `${k} 张`));
            return;
          }
          millOnto(ctx, f, e, target, 0);
          break;
        }
        millOnto(ctx, f, e, target);
        break;
      }
      case 'allowRemovalUse': {
        // 「このターン中、自分はそのカードをリムーブエリアから使用できる。」 — the frame's own removals,
        // narrowed to this player's cards (「自分は」). The record lives on the player, keyed by turn:
        // `removalUseAllowed` ignores it once the turn has moved on.
        const record = p.removalUseForTurn?.turn === s.turn ? p.removalUseForTurn : (p.removalUseForTurn = { turn: s.turn, ids: [] });
        for (const id of f.removedIds ?? []) {
          if (s.cards[id]?.owner === f.player && !record.ids.includes(id)) record.ids.push(id);
        }
        break;
      }
      case 'lookTop':
        f.held = p.deck.splice(0, 1); noteDeckTop(p);
        f.stage = 'topBottom';
        // An empty deck still shows the step: the look ran, found nothing, and the player confirms it
        // rather than the instruction disappearing (round-124 ②).
        if (f.held.length) request(ctx, f, 'topBottom', '查看牌库顶：放回顶部，或放到牌库底', 1, 1, ['top', 'bottom']);
        else request(ctx, f, 'cards', '查看牌库顶：牌库为空，无可选卡，点击确认继续', 0, 0, []);
        return;
      case 'search': {
        f.held = p.deck.splice(0, e.count); noteDeckTop(p); f.taken = 0; f.stage = 'take';
        // The pick is asked even when the deck (or the filter) leaves nothing to offer — the empty
        // offer is a confirm, not a vanished step (round-124 ②).
        const candidates = f.held.filter(id => matchesFilter(s, id, e.filter, f.sourceId, undefined, true));
        request(ctx, f, 'cards', lookTakePrompt({
          lead: `查看 ${f.held.length} 张牌`, from: `查看的 ${f.held.length} 张牌`,
          floor: 0, max: Math.min(e.max, candidates.length), dest: '加入手牌', reveal: false, empty: !candidates.length,
        }), 0, e.max, candidates);
        return;
      }
      case 'lookReveal': {
        // 「自分の山札の上から2枚見てもよい」 — the look itself is optional. Nothing has been lifted yet,
        // so declining leaves the deck exactly as it was; accepting re-enters this same step.
        if (e.optional && !f.lookConfirmed) {
          f.stage = 'lookOptional';
          request(ctx, f, 'option', e.from === 'under' ? '0 = 不查看（不变），1 = 查看卡下的卡'
            : e.from === 'life' ? '0 = 不查看（不变），1 = 查看生命区的卡'
              : '0 = 不查看（牌序不变），1 = 查看牌库顶的卡', 1, 1, ['0', '1']);
          return;
        }
        delete f.lookConfirmed;
        f.revealedFrom = e.from ?? 'deck';
        // 「相手は自身の山札の上から1枚を公開する」 — the looked deck may be the opponent's. Only the
        // reveal-in-place destinations are legal there (validation refuses the rest): the card is shown
        // and put back on top.
        const deckP = e.player === 'opponent' ? s.players[otherOf(f.player)] : p;
        if (e.from === 'life') {
          // 「自分のライフエリアにあるカードを全て見てもよい。そうした場合、見たカードを望む順で自分の
          // ライフエリアに置く。」 — the whole life area is lifted into the frame (the same "held, in no
          // zone" state every look uses, so a reorder cannot duplicate or drop a slot) and answered as one
          // ordering question; the `bottom` stage writes the answered order back into the slots. The
          // positional face-up flags travel by card id.
          f.held = [...p.life];
          f.heldLifeFaceUp = Object.fromEntries(f.held.map((id, i) => [id, p.lifeFaceUp?.[i] === true]));
          p.life = [];
          p.lifeFaceUp = [];
          f.taken = 0;
          f.revealedIds = [...f.held];
          f.gainedCount = 0;
          if (!f.held.length) break;
          f.stage = 'bottom';
          request(ctx, f, 'order', '按顺序点击：先选的放在生命区最上', f.held.length, f.held.length, f.held);
          return;
        }
        if (e.from === 'under') {
          // 「このキャラの下の裏向きのカードを見て、その中から…」 — the hidden stack under the source takes
          // the deck's place. The looked cards are *lifted out* of the stack while the choice is open and
          // put back when it closes, so the frame's `held` means the same thing here as it does for a
          // deck look: cards the effect is holding, in no zone until it is done with them. (Leaving them
          // under the character while they are also "held" made the same card sit in two places.)
          const host = findField(s, f.player, f.sourceId);
          // A host that has already left the field (a battle loss, or a self-retire cost printed above the
          // sentence) filed its hidden stack in 場外 before this frame opened; the frame's snapshot
          // (`sourceStack` / the retire task's `underIds`) remembers which cards those were, and only
          // those still in the pile are looked at — the same filed-stack fallback `takeUnder` (BLC-4-034)
          // and `underCount` make. Without it the look read an empty stack and the whole sentence died
          // (CGD-1-025).
          const filed = host !== undefined ? undefined
            : (f.sourceStack ?? f.underIds ?? []).filter(id => s.players[f.player].sideline.includes(id));
          if (filed?.length) s.players[f.player].sideline = s.players[f.player].sideline.filter(id => !filed.includes(id));
          f.held = host ? [...(host.card.faceDown ?? [])] : [...(filed ?? [])];
          if (host) host.card.faceDown = [];
          f.taken = 0;
          // 「見て、その中から1枚まで公開し、場外に置く。公開したカードが…の場合、…」 — the same record the
          // deck look writes: 「公開したカード」 answers against what the look lifted, whatever the source
          // pile was.
          f.revealedIds = [...f.held];
          // A lift-only under-look (max 0) whose stack is empty has nothing to ask about; a printed pick
          // (max > 0) asks even when nothing qualifies — the empty offer is a confirm, not a vanished
          // step (round-124 ②), and the answer's `placeRemainder` is what puts the stack back.
          if (!f.held.length && e.max === 0) { f.gainedCount = 0; break; }
          const under = f.held.filter(id => matchesFilter(s, id, e.filter, f.sourceId));
          if (e.max > 0) {
            f.stage = 'take';
            request(ctx, f, 'cards', lookTakePrompt({
              lead: `查看 ${f.held.length} 张卡下的卡`, from: `查看的 ${f.held.length} 张卡下的卡`,
              floor: 0, max: Math.min(e.max, under.length), dest: takeDestinationText(e.take), reveal: e.reveal === true, empty: !under.length,
            }), 0, Math.min(e.max, under.length), under);
            return;
          }
          // Nothing is choosable, so the stack goes back where it was; there is no deck to reorder.
          f.gainedCount = 0;
          if (host) host.card.faceDown = [...f.held];
          else if (f.held.length) s.players[f.player].sideline.push(...f.held);
          f.held = [];
          break;
        }
        // 「N枚分、…を見る」 — the number may itself be a board count (「相手の場のレストのキャラの枚数分」),
        // so it is resolved here rather than baked into the step. A printed base with a per-count raise
        // (「山札の上から『1枚』見て、…1枚につき、この効果で見る山札の枚数+1」) carries both: the base in
        // `count`, the raise in `countPer`.
        const lookCount = (e.countSource ? tierCountOf(s, f.player, f.sourceId, e.countSource) : e.count)
          + (e.countPer ? e.countPer.amount * tierCount(ctx, f, e.countPer.count) : 0);
        // 「自分の山札の**下**から1枚を公開してもよい」 — the looked cards come off the deck's bottom;
        // everything downstream (the take, the rest placement) is the same machinery either way.
        f.held = e.from === 'deckBottom'
          ? deckP.deck.splice(Math.max(0, deckP.deck.length - lookCount), lookCount)
          : deckP.deck.splice(0, lookCount);
        f.taken = 0;
        // 「公開したカードが〈X〉の場合」 reads this after the step is over, when the card may already be in
        // hand or back on the deck — the record is the only thing that still knows which card it was.
        f.revealedIds = [...f.held];
        // An empty deck with no printed pick (max 0) simply ends the look; with a pick the offer still
        // goes out as a confirm (round-124 ②), and the answer's tail places nothing.
        if (!f.held.length && e.max === 0) { f.gainedCount = 0; break; }
        // 「…1種類につき、この効果で登場させるキャラの必要エナジーの範囲+1」 (KGD-1-026) — the requirement
        // ceiling the take filters on is raised by a board count, read here so the offer always holds the
        // number the print allows at the moment it is made (the same shape the `select` reader applies;
        // the raise reaches the `anyOf` branches like it does there).
        let takeFilter = e.filter;
        if (e.maxEnergyPer && takeFilter) {
          const raise = e.maxEnergyPer.amount * tierCount(ctx, f, e.maxEnergyPer.count);
          if (raise > 0) takeFilter = raiseMaxEnergy(takeFilter, raise);
        }
        let candidates = f.held.filter(id => matchesFilter(s, id, takeFilter, f.sourceId, f.declared, true));
        // A replacement-only take (takeGateOnly): the offer holds exactly the cards the printed gate
        // admits; a card failing it is never offered, and the base's own placement stands.
        if (e.takeGateOnly === true && e.takeGate) candidates = candidates.filter(id => !takeGateFails(s, f, e, id));
        // 「公開したN枚のカードの必要エナジーの数が全て同じか、連続するNつの数だった場合、『公開したカードを
        // 全て手札に加える』に代わる。」 (SYN-1-062) — the take widens to every lifted card and no question
        // is asked; the whole set joins the hand through the same bookkeeping a full take would use.
        if (e.takeAllEnergyRun !== undefined && energyRunHolds(s, f.held, e.takeAllEnergyRun)) {
          const hand = e.player === 'opponent' ? s.players[otherOf(f.player)].hand : p.hand;
          f.taken = f.held.length;
          f.gainedCount = f.held.length;
          f.gainedIds = [...f.held];
          f.didCount = f.held.length;
          if (e.reveal && f.held.length) { queueRevealedFromDeck(ctx, f.held); }
          hand.push(...f.held);
          if (e.reveal && f.held.length) queueDeckToHand(ctx, f.held, f.sourceId);
          if (f.held.length) ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: [...f.held] } });
          f.held = [];
          break;
        }
        // `max` 0 means the print takes nothing here (the takes ride on `takeGroups` below, or the look is
        // lift-only), so no question exists to ask. A printed pick (max > 0) is *always* asked — with an
        // empty candidate pool it becomes the confirm that keeps the step visible (round-124 ②).
        if (e.max > 0) {
          f.stage = 'take';
          // 「相手は見たカードが…の場合、公開し手札に加えてもよい」 — when the looked deck is the
          // opponent's, *they* answer which card (if any) joins their own hand.
          const chooser = e.takeChooser === 'opponent' ? otherOf(f.player) : e.player === 'opponent' ? otherOf(f.player) : f.player;
          // 「その中から…1枚を指定する」 — a *mandatory* take: the printed count leaves the looked set for
          // good, so the answer may not fall short of `takeMin`.
          const floor = Math.min(e.takeMin ?? 0, Math.min(e.max, candidates.length));
          request(ctx, f, 'cards', lookTakePrompt({
            lead: `查看 ${f.held.length} 张牌`, from: `查看的 ${f.held.length} 张牌`,
            floor, max: Math.min(e.max, candidates.length), dest: takeDestinationText(e.take), reveal: e.reveal === true, empty: !candidates.length,
          }), floor, Math.min(e.max, candidates.length), candidates, chooser);
          // 「異なるカード名の…をそれぞれ1枚ずつ」 — a same-name pick is refused when the choice is made.
          if (e.distinctNames && s.pending?.type === 'effect') s.pending.distinctNames = true;
          // 「必要エナジーが異なる…を望む枚数」 — the same enforcement over the requirement totals.
          if (e.distinctEnergy && s.pending?.type === 'effect') s.pending.distinctEnergy = true;
          // 「…をBPの合計が7500以下になるように望む枚数」 — the same enforcement over the printed BP.
          if (e.bpSumMax !== undefined && s.pending?.type === 'effect') s.pending.bpSumMax = e.bpSumMax;
          // 「その中から相手がランダムに1枚選ぶ。」 (KIN-1-038) — nobody chooses: the engine draws one
          // candidate uniformly (the reproducible PRNG `shuffle` uses) and answers the question it just
          // asked, so every destination below — the take's own machinery — handles it unchanged. With an
          // empty pool there is nothing to draw, so the confirm stays for the player.
          if (e.takeRandomBy && candidates.length) {
            const pick = randomPick(s, candidates);
            chooseEffect(ctx, (s.pending as EffectDecision).choiceId, [pick]);
          }
          return;
        }
        // 「その中から〈A〉と〈B〉をそれぞれ1枚まで…」 — the printed subjects are asked one at a time,
        // each over what the earlier ones left. A look whose primary take is empty starts at group 0.
        if (e.takeGroups?.length) {
          // The primary take's fields are written as if it had been answered empty (the same state the
          // skipped question would have produced), so a follow-up reading `gainedCount` cannot tell the two
          // spellings apart.
          f.taken = 0; f.gainedCount = 0; f.didCount = 0; f.gainedIds = [];
          f.takeGroupIndex = 0;
          if (requestTakeGroup(ctx, f, e)) return;
        }
        // 「自分の山札の上から1枚を公開し、山札の上か場外に置く。」 — the reveal-in-place look spends its
        // public moment here. The take paths above announce their own reveal for the cards they actually
        // took, and this lift-only route (`max` 0, no take groups) reaches none of them: without this the
        // printed 公開 verb would record nothing and fire no deck-reveal watcher.
        if (e.reveal && f.held.length) queueRevealedFromDeck(ctx, f.held);
        f.stage = 'bottom';
        if (e.rest === 'sideline') {
          // The remainder goes aside; its identities are what 「この効果で場外に置いたカードに…がある場合」
          // asks about.
          f.discardedIds = [...f.held];
          f.didCount = f.held.length;
          f.gainedCount = 0;
          p.sideline.push(...f.held);
          // 「自分の山札から場外に置かれた時」 — the looked cards came from the deck (this branch is the
          // deck-read spelling; an under-host look takes the other branch).
          noteDeckToSideline(ctx, f.player, f.held, f.sourceId);
          f.held = [];
          break;
        }
        if (e.rest === 'removal') {
          // 「残りをリムーブエリアに置く」 — the remainder goes to the removal area, a different pile from
          // 場外. Recorded on the frame the same way an explicit `remove` operation is, so
          // 「この効果でリムーブエリアに置いたカード1枚につき」 counts these too. 「使用されること以外で
          // リムーブエリアに置かれる場合、代わりに場外に置く。」 redirects its holder: that card reaches
          // 場外 instead and joins the sibling branch's records and deck→場外 watchers.
          f.gainedCount = 0;
          const aside: CardId[] = [];
          for (const id of f.held) {
            if (removalRedirectsToSideline(s, id, f.sourceId)) { p.sideline.push(id); aside.push(id); continue; }
            p.removal.push(id);
            (f.removedIds ??= []).push(id);
          }
          if (aside.length) {
            f.discardedIds = [...(f.discardedIds ?? []), ...aside];
            noteDeckToSideline(ctx, f.player, aside, f.sourceId);
          }
          f.held = [];
          break;
        }
        if (e.rest === 'topOrRemoval') {
          // 「山札の上かリムーブエリアに置く」 — the destination is the player's choice: 0 puts the cards
          // back on the deck's top, 1 sends them to the removal area.
          f.gainedCount = 0;
          f.stage = 'placeTopRemoval';
          request(ctx, f, 'cards', '0 = 放回牌库顶，1 = 置于移除区', 1, 1, ['0', '1']);
          return;
        }
        if (e.rest === 'topOrSideline') {
          f.gainedCount = 0;
          f.stage = 'placeTopSideline';
          request(ctx, f, 'cards', '0 = 放回牌库顶，1 = 置于场外', 1, 1, ['0', '1']);
          return;
        }
        if (e.rest === 'topOrSidelineOpponent') {
          // 「…公開されたカードを相手の山札の上か場外に置く」 (BLC-1-022 / KMR-1-113) — the looked deck is
          // the opponent's (`deckP` above), and the 場外 half is the *opponent's* pile too: the print gives
          // the choice to the effect player, but both destinations stay on the looked player's side. The
          // answer writes `deckP` / the opponent's sideline, never the controller's.
          f.gainedCount = 0;
          f.stage = 'placeTopSidelineOpp';
          request(ctx, f, 'cards', '0 = 对方牌库顶，1 = 对方场外', 1, 1, ['0', '1']);
          return;
        }
        if (e.rest === 'topOrBottom') {
          // 「山札の上か下に置く」 — 无取牌路径的上下二选一（有取牌的说明在应答尾部另问）。
          f.gainedCount = 0;
          f.stage = 'faceUpTopBottom';
          request(ctx, f, 'topBottom', '把卡放到牌库顶还是牌库底', 1, 1, ['top', 'bottom']);
          return;
        }
        // The deck is the one *looked at* (`deckP`), not the controller's: 「相手の山札の上から1枚を公開し、
        // 山札の上に戻す」 puts the card back on the opponent's deck. Hard-coding `p.deck` here moved the
        // card into the wrong player's deck and tripped the conservation invariant (`KMR-1-113`).
        if (e.rest === 'top') { f.gainedCount = 0; deckP.deck.unshift(...f.held); noteDeckTop(deckP); f.held = []; break; }
        if (e.rest === 'topBottomFaceUp') {
          // 「そのカードを山札の上か下に置く。上に置いた場合、そのカードを表向きにする。」 — the
          // destination is the player's choice, and the top one arrives face-up (the print's second
          // sentence states that half; the question carries both so the chooser knows what top means).
          f.gainedCount = 0;
          f.stage = 'faceUpTopBottom';
          request(ctx, f, 'topBottom', '把卡放到牌库顶（表侧）还是牌库底', 1, 1, ['top', 'bottom']);
          return;
        }
        if (e.rest === 'topOrUnder') {
          // 「…山札の上に置くか、裏向きで自分の場の〈X〉1枚の下に置く」 — the destination is asked, not
          // assumed: the stage below records the mode (and the host, when the cards go under one).
          f.gainedCount = 0;
          f.stage = 'placeTopUnder';
          request(ctx, f, 'cards', '0 = 放回牌库顶，1 = 面朝下置于角色下方', 1, 1, ['0', '1']);
          return;
        }
        if (e.rest === 'splitTop') {
          // 「山札の上と下に望む枚数ずつ望む順で置く」 — which cards go on top *is* the decision, so it is
          // asked as a free choice rather than derived from an ordering.
          f.stage = 'bottom';
          request(ctx, f, 'cards', '选择放到牌库顶的卡（其余按当前顺序放到牌库底）', 0, f.held.length, f.held);
          return;
        }
        if (e.rest === 'splitTopSideline') {
          // 「その中から望む枚数を望む順で自分の山札の上に置き、残りを場外に置く」 — the same free
          // choice over what goes on top, with the remainder sent to 場外 instead of the deck's bottom.
          f.stage = 'bottom';
          request(ctx, f, 'cards', '选择放到牌库顶的卡（其余送至场外）', 0, f.held.length, f.held);
          return;
        }
        request(ctx, f, 'order', lookOrderPrompt(e.rest), f.held.length, f.held.length, f.held);
        return;
      }
      case 'self': {
        const c = source(s, f);
        if (c) {
          if (e.energyBonus) (c.energyModifiers ??= []).push({ energy: e.energyBonus, expiresTurn: s.turn });
          if (e.impact) (c.impactModifiers ??= []).push({ value: e.impact, additive: e.relative === true, expiresTurn: s.turn });
          if (e.bp) c.bpModifiers.push({ amount: e.bp, expiresTurn: s.turn });
          // 「このキャラのBPがプラスされた時」 — the source-scoped raise fires the watcher too.
          if (e.bp && e.bp > 0) ctx.queue.push(...collectTriggered(ctx, f.player, 'onBpIncreased', f.sourceId));
          if (e.keywords) {
            if (e.lose) (c.lostKeywords ??= []).push({ keywords: e.keywords, expiresTurn: s.turn });
            else (c.keywordModifiers ??= []).push({ keywords: e.keywords, ...(e.relative ? { relative: true } : {}), expiresTurn: s.turn });
          }
          if (e.retireMainEnd) c.retireAtMainEnd = s.turn;
          // Same "it happened" marker the other action steps set, so a 「そうした場合」 after a
          // 「…を得てもよい」 branch sees that the grant ran.
          f.didCount = 1;
        }
        break;
      }
      case 'boostTrait':
        for (const c of fields(s, f.player)) if (getDefinition(s, c.cardId).kind === 'character' && hasTrait(getDefinition(s, c.cardId), e.trait)) c.bpModifiers.push({ amount: e.amount, expiresTurn: s.turn });
        break;
      case 'if': {
        const holds = evalIf(ctx, f, e.condition);
        const branch = holds ? e.then : e.else;
        if (branch?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(branch));
        // 「…の場合、〜する。そうした場合、…」 — a conditional that resolves to nothing is itself no
        // result: the frame's last-action records must not keep standing from the steps before the
        // conditional, or the following gate opens on a clause that never happened (OPM-1-082: the
        // BP+1000 wrote `didCount`, the life gate failed, and the retire still ran).
        else {
          f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0;
          if (!holds) logEvent(ctx, 'conditionUnmet', { player: f.player, cardId: f.sourceId, pub: visibility(ctx, [f.sourceId]).pub.length });
        }
        break;
      }
      case 'gained': {
        const holds = gainedHolds(ctx, f, e);
        // 「場外に置いたカードが…の場合、そのカードを…してもよい」 (MCR-2-069) — the card the gate read is
        // bound as `G`, so the follow-up acts on the very card the condition named rather than on a fresh
        // pool read (by then the pile holds other discards too).
        if (holds && e.on === 'discarded' && e.filter !== undefined) {
          const matched = (f.discardedIds ?? []).filter((id: string) => matchesFilter(s, id, e.filter!, f.sourceId));
          f.selections = { ...(f.selections ?? {}), G: matched };
        }
        // 「この効果で自分のフロントLの〈フロストノヴァ〉をレストにした場合、それをアクティブにする。」
        // (ARK-1-033) — the same binding rule for the rest record: the follow-up 「それを」 acts on the very
        // card the gate named, not on a fresh pool read (the frame may have rested several cards).
        if (holds && e.on === 'rested' && e.filter !== undefined) {
          const matched = (f.restedIds ?? []).filter((id: string) => matchesFilter(s, id, e.filter!, f.sourceId));
          f.selections = { ...(f.selections ?? {}), G: matched };
        }
        const branch = holds ? e.then : e.else;
        if (branch?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(branch));
        break;
      }
      case 'ifSelected': {
        const holds = (f.selections?.[e.bind]?.length ?? 0) > 0;
        const branch = holds ? e.then : e.else;
        if (branch?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(branch));
        break;
      }
      case 'chooseOption': {
        if (e.entrySharedLimitKey && (p.sharedLimitUsed?.[e.entrySharedLimitKey] ?? -1) >= s.turn) break;
        // 「このターン中、自分の紫のカードの効果で「以下から1つ選ぶ」効果は「以下から全て選ぶ」に代えて
        // もよい。」 — while the offer stands and the source is a *purple* card, a single-pick chooser asks
        // the printed mode question before it runs; 「全て」 makes every option mandatory. Any other count
        // (a printed 「2つ選ぶ」) is not the printed shape and keeps its own reading.
        const chooseAll = p.purpleChooseAll;
        // 「その効果は「以下から2つ選ぶ」に代わる」 — a *paid-for* mode swap, applied outright rather than
        // offered: the chooser takes two branches instead of one and no question is asked about it.
        if (chooseAll?.count !== undefined && chooseAll.untilTurn === s.turn && chooseAll.count > e.count && e.options.length > chooseAll.count) {
          if (chooseAll.remaining !== undefined && chooseAll.remaining <= 1) delete p.purpleChooseAll;
          else if (chooseAll.remaining !== undefined) p.purpleChooseAll = { ...chooseAll, remaining: chooseAll.remaining - 1 };
          f.steps.splice(f.index + 1, 0, { ...e, count: chooseAll.count });
          break;
        }
        if (e.count === 1 && chooseAll !== undefined && chooseAll.untilTurn === s.turn
          && (chooseAll.remaining === undefined || chooseAll.remaining > 0) && e.options.length > 1) {
          const sourceDefinition = peekDefinition(s, f.sourceId);
          if (sourceDefinition && (Object.hasOwn(sourceDefinition.requiredEnergy, 'purple') || treatedAsAllColors(s, f.sourceId))) {
            f.stage = 'chooseAllMode';
            f.selections ??= {};
            request(ctx, f, 'option', '该效果可以改为全部选择：选择 1 项还是全部？', 1, 1, ['one', 'all']);
            return;
          }
        }
        // 「自分の場のキャラが「以下から1つ選ぶ」効果を発動する際、…してもよい。そうした場合、その効果は
        // 「以下から2つ選ぶ」に代わる。」 (YYH-1-050) — the watcher's offer rides the chooser itself: a
        // single-pick chooser coming from one of *this player's own field characters* asks the printed
        // price question first, and accepting re-runs the chooser at the raised count. The price is paid
        // in the answer branch, where the board is re-read.
        if (e.count === 1 && e.options.length > 1 && findField(s, f.player, f.sourceId)) {
          const upgrade = paidChooseUpgradeOffer(s, f.player);
          if (upgrade) {
            f.stage = 'paidChooseUpgrade';
            f.selections ??= {};
            request(ctx, f, 'option', '可以支付代价（休息该卡并移除其下1张里侧卡），将「选1项」升级为「选2项」？upgrade = 升级，keep = 保持原样', 1, 1, ['upgrade', 'keep']);
            return;
          }
        }
        // 「このターン中に〈X〉が既に選んだ効果は選べない」 — options already taken this turn under this
        // card's name are not offered again. With none left the chooser does nothing, which is exactly
        // what the print gives the player on the third resolution. The `@source` key is the
        // 「…既に選んだ**このキャラ**の効果は選べない」 spelling, whose memory belongs to the resolving
        // card rather than to a printed name.
        const repeatKey = e.forbidRepeat === undefined ? undefined : repeatKeyOf(e, f, s);
        const taken = repeatKey ? new Set(s.players[f.player].chosenOptionsThisTurn?.[repeatKey] ?? []) : undefined;
        // 「…合計枚数を満たすものを、以下から2つまで選ぶ。」 (MSS-1-004) — a printed *option* is only
        // offerable while its own threshold holds; the index keeps its place, so the answer still names
        // the printed branch and `forbidRepeat`'s memory stays aligned.
        // A per-bullet lock spends only the indices it trails (Q1901); an unqualified lock spends every
        // index it remembers.
        const offered = e.options.map((_, i) => i).filter(i => !(taken?.has(i) && (e.forbidRepeatOnly === undefined || e.forbidRepeatOnly.includes(i)))
          && (e.optionGates?.[i] == null || evalIf(ctx, f, e.optionGates[i]!)));
        // 「自分の場の[特徴：ガンメン]1枚につき、以下から1つまで選ぶ」 — how many branches the chooser
        // offers is a board count, read where the chooser runs. The single multi-pick answer already
        // cannot take one option twice, which is the printed 「（同じものは選べない）」.
        const width = e.countSource ? tierCount(ctx, f, e.countSource) : e.count;
        const max = Math.min(width, offered.length);
        // 「…『2つ』に代えてもよい」 — a widened count the player may decline down to `min`; without the
        // field the choice is exactly `count`, which is what every other chooser prints.
        const min = Math.min(e.min ?? max, max);
        if (max <= 0) break;
        f.stage = 'option';
        f.selections ??= {};
        f.selections.__options = [];
        // 「相手は…してもよい」 — the answer is the opponent's to give, so the pending names them.
        const chooser = e.chooser === 'opponent' ? otherOf(f.player) : f.player;
        // 「放回牌库顶 / 置于场外」 — a chooser whose compiled branches carry printed names spells them into
        // the question. Presentation only: the engine still answers by option index (`chooseEffect`), and
        // `choiceOptionLabel` reads the same names to title each answer.
        const names = e.labels?.length ? `（${e.labels.join(' / ')}）` : '';
        request(ctx, f, 'option', (min === max ? `从以下 ${e.options.length} 项中选择 ${max} 项` : `从以下 ${e.options.length} 项中选择 ${min}～${max} 项`) + names, min, max, offered.map(i => String(i)), chooser);
        return;
      }
      case 'payAp': {
        // 「このターン中、そのキャラは[起動メイン]を発動する際、[APを1支払う]を行わずに発動できる。」
        // (TKG-1-018) — a granted `activationApFree` static on the resolving card waives the activation
        // cost tag itself: only a marked cost step is waived, so an effect-body 「APを支払ってもよい」
        // still pays. Continuous, unlike the one-shot waiver below.
        if (e.asCost && ownStaticsOf(s, f.sourceId, f.player).some(m => m.type === 'activationApFree')) {
          f.didCount = 0;
          break;
        }
        // 「このターン中、次に発動する〈X〉の[起動メイン]は[APを1支払う]を失う」 (SYN-P-003) — the
        // waiver is consumed by the first matching activation's cost step: the cost is gone, so neither
        // the availability check nor the payment runs.
        {
          const waivers = s.players[f.player].nextActivationApFree ?? [];
          const waiveAt = waivers.findIndex(entry => entry.expiresTurn >= s.turn && matchesFilter(s, f.sourceId, entry.filter));
          if (waiveAt !== -1) {
            waivers.splice(waiveAt, 1);
            if (waivers.length) s.players[f.player].nextActivationApFree = waivers;
            else delete s.players[f.player].nextActivationApFree;
            f.didCount = 0;
            break;
          }
        }
        // 「このキャラの[起動メイン]の[APを1支払う]は[手札を1枚場外に置く]に代えてもよい。」 (TKG-1-026) —
        // the activation's own AP cost may be paid with a hand card instead. Offered as a declinable
        // question (the printed 「代えてもよい」) only while the hand really holds a card and the tag is
        // the printed [APを1支払う] (one AP for one card); declining pays the AP exactly as printed.
        if (e.asCost && e.count === 1 && p.hand.length
          && ownStaticsOf(s, f.sourceId, f.player).some(m => m.type === 'activationCostSubstitute')) {
          f.stage = 'apCostSubstitute';
          request(ctx, f, 'cards', '可以用 1 张手牌送至场外代替支付 AP（不选择则支付 AP）', 0, 1, [...p.hand]);
          return;
        }
        const available = p.ap.filter(a => a === 'active').length;
        if (available < e.count) {
          if (e.optional) { f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0; break; }
          requireRule(false, 'INSUFFICIENT_AP', '可用 AP 不足。');
        }
        if (e.optional) {
          f.stage = 'option';
          request(ctx, f, 'option', `是否支付 ${e.count} AP（可不支付）`, 1, 1, ['支付', '不支付']);
          return;
        }
        let remaining = e.count;
        for (let i = 0; i < 3 && remaining > 0; i++) if (p.ap[i] === 'active') { p.ap[i] = 'rested'; remaining--; }
        // The card named is the source of the effect that paid, which is what 「…の効果でAPを支払って
        // いる」 filters on; the player is whoever the effect belongs to.
        logTurnEvent(s, 'apPaidByEffect', f.player, f.sourceId);
        ctx.events.push({ type: 'apSpent', data: { player: f.player, amount: e.count } });
        f.didCount = e.count;
        if (e.then?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(e.then));
        break;
      }
      case 'payDiscard': {
        const count = Math.min(e.count, p.hand.length);
        if (count === 0) { f.discardedCount = 0; break; }
        f.stage = 'discard';
        f.selections ??= {};
        f.selections.__discard = [];
        request(ctx, f, 'cards', `选择 ${count} 张手牌送至场外`, count, count, [...p.hand]);
        return;
      }
      case 'note': break;
      case 'winGame': {
        // 「自分はゲームに勝利する。」 (BCV-1-028) — an effect-driven win: the *other* player is the
        // loser, recorded like every other finished game (the resume machinery is left untouched; the
        // frame closes against a finished state the way a conceding player's does).
        finish(ctx, otherOf(f.player), 'card-effect');
        return;
      }
      case 'revealLooked': {
        // The public half of a look: the cards the look already lifted (`revealedIds`) are shown to the
        // table, and only those matching `filter` are offered — the printed 「…の場合」 *is* the gate.
        // Nothing moves; a card that stays on the deck is still revealed (the print's own 「公開した
        // カードを山札の上に置く」 says where it stays).
        const looked = (f.revealedIds ?? []).filter(id => matchesFilter(s, id, e.filter, f.sourceId));
        if (!looked.length) { f.didCount = 0; break; }
        if (e.optional) {
          f.stage = 'revealOptional';
          request(ctx, f, 'option', `0 = 不公开（无后续），1 = 公开刚才看到的卡`, 1, 1, ['0', '1']);
          return;
        }
        revealLooked(ctx, f, looked);
        break;
      }
      case 'takeRevealed': {
        const taken = (f.revealedIds ?? []).filter(id => {
          const owner = s.cards[id]?.owner;
          return owner !== undefined && s.players[owner].deck.includes(id);
        });
        for (const id of taken) {
          const owner = s.cards[id]!.owner;
          removeFromZone(s, owner, id);
          s.players[owner].hand.push(id);
        }
        if (taken.length) ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: taken } });
        logRevealedToHand(ctx, taken);
        queueDeckToHand(ctx, taken, f.sourceId);
        f.gainedCount = taken.length;
        f.gainedIds = [...taken];
        f.didCount = taken.length;
        break;
      }
      case 'deckTopFaceUp': {
        // 「自分の山札の上から1枚を表向きにする。」 — the mark names the card, so it lapses by itself the
        // moment another card takes the top; an empty deck has nothing to turn and prints nothing.
        const top = p.deck[0];
        if (top !== undefined) p.deckTopFaceUp = top;
        break;
      }
      case 'takeFaceUpTop': {
        // 「自分の山札の上に表向きのカードがある場合、そのカードを手札に加えてもよい。」 — the face-up
        // condition is part of the offer, so it is checked here rather than by a surrounding gate. The
        // 「…してもよい」 question is asked over the one card the print names.
        const top = faceUpTop(s, f.player);
        // No face-up top is no result: this step resolves empty, so the counters a following
        // 「そうした場合」 loose gate reads must not carry an earlier step's outcome (SMD-1-018: the
        // select/rest before it left `didCount` set and the gate opened with nothing added to hand).
        if (top === undefined) { f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0; break; }
        f.stage = 'faceUpTake';
        f.selections ??= {};
        f.selections.__faceUpTop = [top];
        request(ctx, f, 'cards', '将牌库顶的表侧卡加入手牌', e.optional ? 0 : 1, 1, [top]);
        return;
      }
      case 'faceUpLife': {
        // 「(自分の|相手の)ライフを1枚まで表向きにする。」 — asked over *slots*: a life area's contents
        // are hidden, so the chooser names a position rather than a card. Already face-up slots are not
        // offered under 「(裏向きの)ライフを1枚」, while 「それが裏向きの場合、表向きにする」 (`includeFaceUp`)
        // offers every slot — picking a face-up one is legal and the flip is a no-op (Q1656).
        const target = scopePlayer(f.player, e.who ?? 'self');
        const tp = s.players[target];
        const slots = tp.life.map((_, i) => i).filter(i => e.includeFaceUp === true || !lifeIsFaceUp(s, target, i));
        // No slot to pick is no result: the step resolves empty, so an earlier step's counters must not
        // carry a following 「そうした場合」 gate (SMD-1-006: the cost discard stayed readable).
        if (!slots.length) { f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0; break; }
        const max = Math.min(e.max ?? 1, slots.length);
        const min = e.optional ? 0 : max;
        f.stage = 'faceUpLife';
        f.selections ??= {};
        request(ctx, f, 'cards', '选择要翻为表侧的生命卡', min, max, slots.map(i => `life:${i}`), scopePlayer(f.player, e.chooser ?? 'self'));
        return;
      }
      case 'useRevealed': {
        // 「公開したカードが緑のイベントカードの場合、必要エナジーを無視してAPを支払わずにそのカードを
        // 使用する」 — the card the look revealed (and the print already sent to 場外) is used for free.
        // Only cards still in 場外 qualify, and the printed gate rides on the step's own `filter`.
        const usable = (f.revealedIds ?? []).filter(id => {
          const owner = s.cards[id]?.owner;
          if (owner === undefined || !s.players[owner].sideline.includes(id)) return false;
          return e.filter === undefined || matchesFilter(s, id, e.filter, f.sourceId);
        });
        const queued: EffectTask[] = [];
        for (const id of usable) {
          const definition = peekDefinition(s, id);
          if (!definition) continue;
          logTurnEvent(s, 'used', f.player, id, { free: true });
          if (definition.kind === 'event') {
            // The card is already in 場外 — where an event resolves to anyway.
            if (definition.onPlay?.length) queued.push(makeEntryTask(s, f.player, id, placedEntrySteps(s, f.player, definition)));
          } else {
            // A non-event revealed card cannot be "used" from 場外 (an event-only permission); it stays
            // where it is. The printed gate is always an event card for this wording.
            continue;
          }
        }
        if (queued.length) setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
        f.gainedCount = 0;
        f.gainedIds = [];
        if (usable.length) ctx.events.push({ type: 'cardsUsedFree', data: { player: f.player, cards: usable } });
        break;
      }
      case 'markStatement': {
        // 「相手は「手札に〈X〉がある。」か「…がない。」のどちらかを選ぶ。」 (FMA-1-096) — the picked
        // claim is what the follow-up 「相手が選んだ通りの場合」 reads; it lives on the frame.
        f.statementChoice = e.has;
        break;
      }
      case 'useChosen': {
        // 「自分の手札から必要エナジーが2以下の青のイベントカードをAPを支払わずに1枚使用できる。」
        // (KGD-1-049) — the card the selection above bound is used for free: the same records the
        // revealed sibling writes (the `used` log with `free: true`), the event resolving its own
        // `onPlay` from 場外, where the use leaves it.
        // 「APを支払わずに」 waives the AP alone, not the card's own use requirements (Q1914): a card
        // whose 必要エナジー is not currently satisfied is not usable, so it is skipped even when the
        // selection bound it (the pool-narrowing compile filter is the offer-side half). Only an
        // explicit 「必要エナジーを無視して」 lifts the requirement, and that spelling rides other steps.
        const ids = (f.selections?.[e.bind ?? 'A'] ?? []).filter(id => p.hand.includes(id) && energySatisfied(s, f.player, id));
        const queued: EffectTask[] = [];
        for (const id of ids) {
          const definition = peekDefinition(s, id);
          if (!definition || definition.kind !== 'event') continue;
          p.hand = p.hand.filter(candidate => candidate !== id);
          p.sideline.push(id);
          logTurnEvent(s, 'used', f.player, id, { free: true });
          if (definition.onPlay?.length) queued.push(makeEntryTask(s, f.player, id, placedEntrySteps(s, f.player, definition)));
        }
        if (queued.length) setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
        f.gainedCount = ids.length;
        if (ids.length) ctx.events.push({ type: 'cardsUsedFree', data: { player: f.player, cards: ids } });
        break;
      }
      case 'useSelf': {
        // 「このカードを必要エナジーを無視してAPを支払わずに使用してもよい。」 (KGR-1-041) — the hand card
        // uses *itself* for free: the same records `useChosen` writes, with the resolving card as the
        // used one. Only an event still in the owner's hand qualifies (the printed moment guarantees it,
        // but a later sentence may have moved the card on).
        const id = f.sourceId;
        const definition = peekDefinition(s, id);
        if (definition && definition.kind === 'event' && p.hand.includes(id)) {
          p.hand = p.hand.filter(candidate => candidate !== id);
          p.sideline.push(id);
          p.eventsUsedThisTurn = (p.eventsUsedThisTurn ?? 0) + 1;
          logTurnEvent(s, 'used', f.player, id, { free: true });
          if (definition.onPlay?.length) setQueue(f, [makeEntryTask(s, f.player, id, placedEntrySteps(s, f.player, definition)), ...(f.queue?.effects ?? [])]);
          ctx.events.push({ type: 'cardsUsedFree', data: { player: f.player, cards: [id] } });
        }
        break;
      }
      case 'revealHand': {
        if (e.upTo) {
          const owner = e.player === 'opponent' ? otherOf(f.player) : f.player;
          const kept = new Set(e.keepBind ? f.selections?.[e.keepBind] ?? [] : []);
          const options = s.players[owner].hand.filter(id => !kept.has(id));
          (f.selections ??= {}).__revealed = [];
          if (options.length) {
            f.stage = 'revealHandSubset';
            request(ctx, f, 'cards', '选择要公开的手牌（可选 0 张）', 0, options.length, options, owner);
            return;
          }
          break;
        }
        // 「相手は自身の手札を全て公開する」 names whose hand is shown; without it the subject is the
        // effect's own controller (「自分の手札を望む枚数公開する」).
        const shownPlayer = e.player === 'opponent' ? otherOf(f.player) : f.player;
        // 「相手は自身の手札から1枚を残し、それ以外の手札を全て公開する。」 (SYN-1-045) — the bound card
        // (the owner's own keep) stays concealed; the reveal is everything else, and that is the set the
        // following pick reads back through `__revealed`.
        const kept = new Set(e.keepBind !== undefined ? f.selections?.[e.keepBind] ?? [] : []);
        const shown = s.players[shownPlayer].hand.filter(id => !kept.has(id));
        f.selections ??= {};
        f.selections.__revealed = [...shown];
        // 「このターン中に自分の効果で自分の手札を公開している場合」 (DST-P-002) — the whole-hand reveal
        // is one turn record, attributed to the effect's controller.
        logTurnEvent(s, 'revealedFromHand', shownPlayer, undefined, { causeOwner: f.player, causeId: f.sourceId });
        queueRevealedFromHand(ctx, shown, f.sourceId);
        ctx.events.push({ type: 'handRevealed', data: { player: shownPlayer, cards: [...shown] } });
        break;
      }
      case 'revealHandToBottom': {
        // 「自分の手札を1枚公開し、自分の山札の下に置く。」 — one hand card is made public, then its
        // owner puts it on the bottom of their deck. The identity is recorded on the frame before the
        // card leaves: a following 「公開したカードが…」 reads the record, because by then the card is
        // back in the deck and indistinguishable from the rest. An empty hand has nothing to offer.
        if (p.hand.length) {
          const max = Math.min(e.count, p.hand.length);
          f.stage = 'revealHandPick';
          request(ctx, f, 'cards', e.optional ? '公开一张手牌并置于牌库底（可不选）' : '公开一张手牌并置于牌库底', e.optional ? 0 : max, max, [...p.hand]);
          return;
        }
        f.gainedCount = 0; f.didCount = 0;
        break;
      }
      case 'tiered': {
        const value = tierCount(ctx, f, e.count);
        // One splice for the whole list: splicing per tier would insert each later tier *before* the
        // previous one, because every insert lands at the same index.
        const insert: CardEffect[] = [];
        for (const tier of e.tiers) {
          if (tier.min > value) continue;
          // 「・0枚：…」 names one exact band, not a floor: with a bare `min` it would fire on every count
          // and stack with the band above it.
          if (tier.max !== undefined && value > tier.max) continue;
          // A keyword-only tier (「・6枚以上：[インパクト（1）]」) produces no steps, so it is carried as
          // a `self` grant — the same encoding the neighbouring 「このキャラは[K]を得る」 uses. When the
          // list's lead chose the receiver (「自分の場の〈宿儺〉を1枚選び、…得る」, JJK-1-061) the grant
          // lands on that binding instead; `impact` keeps its own operation so the additive flag the
          // self route splits out survives the trip.
          if (tier.keywords) {
            if (e.target) {
              const { impact, ...rest } = tier.keywords;
              if (impact !== undefined) insert.push({ type: 'act', target: e.target, operation: 'impact', amount: impact, ...(tier.relative ? { relative: true } : {}) });
              if (Object.keys(rest).length) insert.push({ type: 'act', target: e.target, operation: 'grantKeywords', keywords: rest, ...(tier.relative ? { relative: true } : {}) });
            } else insert.push({ type: 'self', keywords: tier.keywords, ...(tier.relative ? { relative: true } : {}) });
          }
          insert.push(...tier.effects);
        }
        if (insert.length) f.steps.splice(f.index + 1, 0, ...structuredClone(insert));
        break;
      }
      case 'grantStatic': {
        // 「アタック終了時まで」 — the grant is scoped to the battle that is running when it is made;
        // its number is what the read side checks. A grant made outside a battle has no such scope,
        // so the turn expiry is all it gets.
        const expiresBattle = e.duration === 'attackEnd' ? s.battle?.seq : undefined;
        // A player-scope grant (「自分はこのターン中、…できない」) has no card to land on: the restriction
        // governs every effect the player resolves, so it installs on the player state.
        if (e.target === 'player' || e.target === 'opponentPlayer') {
          // 「相手は次の相手のターンの移動フェイズで…」 — a restriction the *opponent* carries: it installs
          // on their player state, and the duration is still read from this effect's controller (the
          // printed period is the controller's "until the opponent's next turn ends").
          const subject = e.target === 'opponentPlayer' ? otherOf(f.player) : f.player;
          const expiresTurn = expiryOf(ctx, f.player, e.duration);
          (s.players[subject].grantedStatics ??= []).push({ abilities: structuredClone(e.abilities), expiresTurn, grantedBy: f.sourceId, ...(expiresBattle !== undefined ? { expiresBattle } : {}), ...(e.duration === 'untilOpponentAttackEnd' ? { endsWithAttackPhase: true as const } : {}) });
          ctx.events.push({ type: 'staticGranted', data: { player: subject, expiresTurn } });
          break;
        }
        const targets = e.target === 'raidBase' ? raidBaseTargets(ctx, f, e.raidBaseOf ?? 'A') : grantTargets(ctx, f, e.target);
        // 「［特徴：X］の効果で…与えられている場合」 (KIN-1-051) — the granting card's printed traits,
        // recorded beside every grant so the gate can ask who granted the modifier.
        const sourceTraits = peekDefinition(s, f.sourceId)?.traits ?? [];
        for (const [owner, card] of targets) {
          // 类AZ: a cross-side grant (「相手のキャラは次の自分のターン開始時まで」) reads its period from
          // the user, not the target's owner — see the bp-modifier site above.
          const expiresTurn = expiryOf(ctx, f.player, e.duration);
          (card.grantedStatics ??= []).push({
            abilities: structuredClone(e.abilities), expiresTurn, ...(expiresBattle !== undefined ? { expiresBattle } : {}),
            ...(e.duration === 'untilOpponentAttackEnd' ? { endsWithAttackPhase: true as const } : {}),
            grantedBy: f.sourceId,
            // 「…かぎり」 grants name the card whose presence keeps them alive; the identity (and the
            // line the print names) is recorded here, checked by `grantedStaticsOf`.
            ...(e.duration === 'whileSource' ? { sourceId: f.sourceId, ...(e.sourceLine ? { sourceLine: e.sourceLine } : {}) } : {}),
            ...(sourceTraits.length ? { sourceTraits: [...sourceTraits] } : {}),
          });
          ctx.events.push({ type: 'staticGranted', data: { player: owner, cardId: card.cardId, expiresTurn } });
        }
        break;
      }
      case 'grantActivated': {
        // 「…が持つ[起動メイン]を全て得る」 — the source cards are read here, at resolution time, so the
        // copies follow the board (a character that enters the line later is not covered, which is what
        // 「…が持つ」 printed as a resolved instruction means). `sameLine` is the line the *target* sits on;
        // a bound source and the effect's own removal record cover the rest.
        const targets = grantTargets(ctx, f, e.target);
        const from = e.from;
        const donors: CardId[] = 'sameLine' in from
          ? targets.flatMap(([owner, card]) => {
              const located = locate(s, owner, card.cardId);
              if (!located) return [];
              const accept = from.filter;
              return s.players[owner][located.line]
                .map(entry => entry.cardId)
                .filter(id => id !== card.cardId && (!accept || matchesFilter(s, id, accept, card.cardId)));
            })
          : 'bind' in from
            ? (f.selections?.[from.bind] ?? [])
            : (f.removedIds ?? []).filter(id => s.players[s.cards[id]?.owner ?? f.player].removal.includes(id));
        if (!donors.length) break;
        // 「選んだキャラが持つ[APを1支払う]を含む[起動メイン]を1つ得る。」 (TKG-1-026) — the donors are
        // narrowed to abilities carrying the printed AP-cost tag, and to `max` of them. When more qualify
        // than the cap, the participant chooses which — the print says 「1つ得る」 and leaves the pick to
        // the one gaining them.
        {
          const abilities = donors.flatMap(id => peekDefinition(s, id)?.activated ?? [])
            .filter(ability => e.apCostOnly !== true || hasApCostTag(ability.effects));
          if (!abilities.length) break;
          if (e.max !== undefined && abilities.length > e.max) {
            f.stage = 'grantPick';
            f.grantPick = {
              abilities: structuredClone(abilities),
              targets: targets.map(([owner, card]) => ({ owner, cardId: card.cardId })),
              duration: e.duration, max: e.max,
              ...(donors.length === 1 ? { donorId: donors[0]! } : {}),
            };
            f.selections ??= {};
            request(ctx, f, 'option', `选择要获得的 ${e.max} 个[起动]效果`, e.max, e.max, abilities.map((_, at) => String(at)));
            return;
          }
          for (const [owner, card] of targets) {
            const expiresTurn = expiryOf(ctx, f.player, e.duration);
            (card.grantedActivated ??= []).push({ abilities: structuredClone(abilities), expiresTurn, ...(donors.length === 1 ? { sourceId: donors[0]! } : {}) });
            ctx.events.push({ type: 'activatedGranted', data: { player: owner, cardId: card.cardId, expiresTurn, count: abilities.length } });
          }
        }
        break;
      }
      case 'useFromSideline': {
        // 「自分の場外から〈X〉を1枚まで必要エナジーを無視してAPを支払い使用する。」 (YYH-1-083) — the
        // effect route of a normal use starting from the discard pile: the requirement is ignored, the
        // printed AP is paid (「APを支払わずに」 carries `free`), and the event resolves its own `onPlay`.
        // The destination is 場外 — where a used card goes, so a card used from 場外 stays put — unless
        // the effect rewrites it to the removal area (`to`, the 「場外に置く代わりに…」 sentence). A use
        // the player cannot afford is skipped, not raised as an error: the effect offers 「1枚まで」 and
        // the payment is inside it.
        const useQueue: EffectTask[] = [];
        for (const id of f.selections?.[e.bind ?? 'A'] ?? []) {
          const definition = peekDefinition(s, id);
          const owner = s.cards[id]?.owner;
          if (!definition || definition.kind !== 'event' || owner === undefined) continue;
          if (!s.players[owner].sideline.includes(id)) continue;
          // A waiting 「次に手札か場外から使用する…の消費APを-1する」 entry (its 場外 half) prices the use;
          // it is spent once the use happens — read and spend stay apart, as in the play path, so a use
          // the player cannot afford is skipped and the entry outlives it.
          const cost = e.free === true ? 0 : Math.max(0, (definition.apCost ?? 0) + sidelineUseDiscount(s, owner, id));
          if (s.players[owner].ap.filter(slot => slot === 'active').length < cost) continue;
          // The AP is rested inline, the same payment the `payAp` step makes, and the turn log records
          // 「…の効果でAPを支払って…」 against the paying effect's own source.
          let remaining = cost;
          for (let i = 0; i < 3 && remaining > 0; i++) if (s.players[owner].ap[i] === 'active') { s.players[owner].ap[i] = 'rested'; remaining--; }
          if (cost > 0) logTurnEvent(s, 'apPaidByEffect', owner, f.sourceId);
          spendSidelineUseDiscount(s, owner, id);
          if (e.to === 'removal') {
            removeFromZone(s, owner, id);
            s.players[owner].removal.push(id);
            (f.removedIds ??= []).push(id);
          }
          s.players[owner].eventsUsedThisTurn = (s.players[owner].eventsUsedThisTurn ?? 0) + 1;
          logTurnEvent(s, 'used', owner, id, { free: cost === 0 });
          if (definition.onPlay?.length) useQueue.push(makeEntryTask(s, owner, id, placedEntrySteps(s, owner, definition)));
        }
        if (useQueue.length) setQueue(f, [...useQueue, ...(f.queue?.effects ?? [])]);
        f.didCount = (f.selections?.[e.bind ?? 'A'] ?? []).length;
        break;
      }
      case 'retrieveRetired': {
        // 「相手はこの効果で退場させたキャラを1枚手札に加える。」 (KMR-1-088) — the frame's retirement
        // record, either side: the card named is whatever this effect sent off the field, and the
        // print's 「1枚」 takes the first still sitting in its owner's 場外 (the effect that names this
        // follow-up retires a single chosen character, so the record holds one).
        for (const id of [...(f.retiredIdsOwn ?? []), ...(f.retiredIdsOpponent ?? [])]) {
          const owner = s.cards[id]?.owner;
          if (owner === undefined || !s.players[owner].sideline.includes(id)) continue;
          removeFromZone(s, owner, id);
          s.players[owner].hand.push(id);
          ctx.events.push({ type: 'cardReturned', data: { player: owner, cardId: id } });
          break;
        }
        break;
      }
      case 'grantTurnAbilities': {
        // 「このキャラは…この効果でリムーブエリアに置いたカードが持つ全ての[自分のターン中]の効果と
        // [相手のターン中]の効果を得る。」 (KMR-2-067/068) — the donors are read at resolution time
        // exactly as `grantActivated` reads its own: a bound selection or the effect's removal record.
        // Only abilities carrying a `turnOf` condition are copied (the print names the two turn tags);
        // each copy keeps its own condition, so it applies on its printed turn.
        const donors = 'bind' in e.from
          ? (f.selections?.[e.from.bind] ?? [])
          : (f.removedIds ?? []);
        if (!donors.length) break;
        const turnScoped = (condition: Condition | undefined): boolean =>
          condition !== undefined
          && (condition.type === 'turnOf' || (condition.type === 'all' && condition.conditions.some(turnScoped)));
        for (const [owner, card] of grantTargets(ctx, f, e.target)) {
          const triggers = donors.flatMap(id => (peekDefinition(s, id)?.triggered ?? []).filter(a => turnScoped(a.condition)));
          const statics = donors.flatMap(id => (peekDefinition(s, id)?.static ?? []).filter(a => turnScoped(a.condition)));
          if (!triggers.length && !statics.length) continue;
          const expiresTurn = expiryOf(ctx, f.player, e.duration);
          if (triggers.length) {
            (card.grantedAbilities ??= []).push(...triggers.map(ability => ({ ability: structuredClone(ability), expiresTurn })));
          }
          if (statics.length) {
            (card.grantedStatics ??= []).push({
              abilities: structuredClone(statics), expiresTurn, grantedBy: donors[0]!,
              ...(donors.length > 1 ? { grantedByAll: [...donors] } : {}),
            });
          }
          ctx.events.push({ type: 'turnAbilitiesGranted', data: { player: owner, cardId: card.cardId, expiresTurn, count: triggers.length + statics.length } });
        }
        break;
      }
      case 'grantTrigger': {
        const expiresBattle = e.duration === 'attackEnd' ? s.battle?.seq : undefined;
        // 「自分はこのターン中、「自分のキャラがレイドした時、カードを1枚まで引く。」を得る」 — the
        // ability belongs to the *player* rather than to any one card, so it must fire whichever of that
        // player's cards raises the event. It installs on the player state and is collected there.
        if (e.target === 'player') {
          const expiresTurn = expiryOf(ctx, f.player, e.duration);
          const ability: TriggeredAbility = {
            event: e.event, effects: structuredClone(e.effects),
            ...(e.oncePerTurn ? { oncePerTurn: true } : {}),
            ...(e.sharedLimit ? { sharedLimit: true } : {}),
            ...(e.condition ? { condition: structuredClone(e.condition) } : {}),
            ...(e.eventCard ? { eventCard: structuredClone(e.eventCard) } : {}),
            ...(e.scope ? { scope: e.scope } : {}),
          };
          (p.grantedAbilities ??= []).push({ abilities: [ability], expiresTurn });
          ctx.events.push({ type: 'abilityGranted', data: { player: f.player, event: e.event, expiresTurn } });
          break;
        }
        for (const [owner, card] of grantTargets(ctx, f, e.target)) {
          const expiresTurn = expiryOf(ctx, f.player, e.duration);
          const ability: TriggeredAbility = {
            event: e.event, effects: structuredClone(e.effects),
            ...(e.oncePerTurn ? { oncePerTurn: true } : {}),
            ...(e.sharedLimit ? { sharedLimit: true } : {}),
            ...(e.condition ? { condition: structuredClone(e.condition) } : {}),
            // 「…が登場した時」 may name a *different* card than the listener (「特徴に「ALO」を持つ〈キリト〉が
            // 登場した時」 granted to ユイ), which is what these two fields carry.
            ...(e.eventCard ? { eventCard: structuredClone(e.eventCard) } : {}),
            ...(e.scope ? { scope: e.scope } : {}),
          };
          (card.grantedAbilities ??= []).push({ ability, expiresTurn, ...(expiresBattle !== undefined ? { expiresBattle } : {}) });
          ctx.events.push({ type: 'abilityGranted', data: { player: owner, cardId: card.cardId, event: e.event, expiresTurn } });
        }
        break;
      }
      case 'moveUnder': {
        // Either side may be the effect's own card, named by the literal `'source'` because it is never
        // one of its own selections: `to: 'source'` is 「このキャラの下に移動させる」 and `from:
        // 'source'` is 「このカードを裏向きで〈X〉の下に置く」, which moves the card whose ability is
        // resolving — it may be on a line, in 場外, or already under another card, depending on where
        // the ability resolved from.
        const source = e.from === 'source' ? [f.sourceId] : (f.selections?.[e.from] ?? []);
        const destination = e.to === 'source' ? f.sourceId : (f.selections?.[e.to] ?? [])[0];
        if (!destination || !source.length) break;
        const owner = s.cards[destination]?.owner;
        if (owner === undefined) break;
        const host = findField(s, owner, destination);
        if (!host) break;
        for (const id of source) {
          if (id === destination) continue;
          const cardOwner = s.cards[id]?.owner;
          if (cardOwner === undefined) continue;
          // 「手札から置いた場合」 — read the origin before the card leaves it (the same record
          // `toUnder` keeps, whose host answer lives beside the ids).
          const fromHand = zoneOfCard(s, cardOwner, id) === 'hand';
          let carried: CardId[] = [];
          if (e.from === 'source') {
            const here = findField(s, cardOwner, id);
            if (here) {
              clearTemporaryFieldState(s, id, here.card);
              s.players[cardOwner][here.line].splice(s.players[cardOwner][here.line].indexOf(here.card), 1);
              s.players[cardOwner].sideline.push(...here.card.underneath, ...(here.card.faceDown ?? []));
            } else {
              removeFromZone(s, cardOwner, id);
            }
          } else {
            // A bound card may sit on a line, in a hidden stack under a host, or in a plain zone
            // (「自分の手札を1枚裏向きで〈X〉の下に置く」 moves a hand card). It is removed from
            // wherever it actually is before the destination claims it — removing only from hidden
            // stacks left a hand card in the hand *and* underneath, which the conservation check
            // rejected (the whole command rolled back, TKN-1-095/096).
            const here = findField(s, cardOwner, id);
            if (here) {
              clearTemporaryFieldState(s, id, here.card);
              s.players[cardOwner][here.line].splice(s.players[cardOwner][here.line].indexOf(here.card), 1);
              // 「そのキャラとそのキャラの下の裏向きのカードを…このキャラの下に置き」 — the printed
              // move carries the pile along; without it those cards would have nowhere to stay and go
              // to 場外, which is a different instruction.
              if (e.withFaceDown) carried = [...(here.card.faceDown ?? [])];
              s.players[cardOwner].sideline.push(...here.card.underneath, ...(e.withFaceDown ? [] : here.card.faceDown ?? []));
            } else {
              let wasUnder = false;
              for (const card of [...s.players[cardOwner].front, ...s.players[cardOwner].energy]) {
                const at = card.faceDown?.indexOf(id) ?? -1;
                if (at !== -1) { card.faceDown!.splice(at, 1); wasUnder = true; break; }
              }
              if (!wasUnder) removeFromZone(s, cardOwner, id);
            }
          }
          // 「…の下に表向きで置く」 (FMA-1-003) — the placed card joins the face-up stack (the host reaches
          // レイド状態); the default remains the hidden pile.
          if (e.faceUp) host.card.underneath.push(id, ...carried);
          else (host.card.faceDown ??= []).push(id, ...carried);
          // 「このカードを裏向きで〈X〉の下に置く」 may name the *event card being resolved*, which rides
          // the frame (`eventCard`) and is in no zone at that moment. The printed placement has now
          // happened, so the frame must let go: the end-of-frame park would otherwise send it to 場外 as
          // well (INVALID_STATE 卡片同时处于多个区域, seed 3534 / CSM-1-076).
          if (id === f.eventCard) delete f.eventCard;
          if (fromHand) {
            (f.underFromHandIds ??= []).push(id);
            (f.underFromHandHosts ??= []).push(destination);
          }
        }
        f.didCount = source.length;
        ctx.events.push({ type: 'underCardsMoved', data: { player: owner, cards: source } });
        break;
      }
      case 'watchBound': {
        // 「このターン中、選んだキャラが〔退場するか、このキャラのアタックをブロックした時〕、この
        // キャラはこのターン中、…を得る。」 (HTR-2-059) — the records land on the *source* (its effects
        // run from there when the moment arrives), keyed by the bound cards' identity.
        const host = findField(s, f.player, f.sourceId)?.card;
        const ids = f.selections?.[e.target] ?? [];
        if (host && ids.length && e.effects.length) {
          host.boundWatches = [...(host.boundWatches ?? []),
            ...ids.flatMap(id => e.events.map(kind => ({
              id, kind, effects: structuredClone(e.effects),
              ...(kind === 'blockedAttack' ? { attackerId: f.sourceId } : {}),
              expiresTurn: s.turn,
            })))];
        }
        break;
      }
      case 'takeUnder': {
        // 「そのキャラの下の裏向きのカードを1枚手札に加え」 — the host is the *bound* card, or the source
        // itself when the step prints it with no selection in front (「このキャラの下の裏向きのカードを
        // 1枚手札に加える」). A stack no larger than the printed count moves whole (the print is
        // mandatory); a larger one is the owner's pick, asked below.
        //
        // 「…の下か自分の場の〈X〉の下の裏向きのカードから1枚まで公開し、手札に加える」 (KGR-1-001) —
        // `fromCards` reads the binding as the hidden cards *themselves* (a pick across several hosts'
        // piles), so the move goes card by card out of whichever stack holds it.
        if (e.fromCards) {
          let moved = 0;
          const takenIds: CardId[] = [];
          for (const id of f.selections?.[e.target] ?? []) {
            const owner = s.cards[id]?.owner;
            if (owner === undefined) continue;
            const hostId = hostOfUnder(s, owner, id);
            const host = hostId === undefined ? undefined : findField(s, owner, hostId);
            const at = host?.card.faceDown?.indexOf(id) ?? -1;
            if (!host || at === -1) continue;
            host.card.faceDown!.splice(at, 1);
            s.players[owner].hand.push(id);
            moved += 1;
            takenIds.push(id);
            // 「このキャラの下の裏向きのカードを手札に加えた時」 — the host is the event's subject.
            ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToHand', hostId!, id));
          }
          f.didCount = moved;
          f.gainedCount = (f.gainedCount ?? 0) + moved;
          f.gainedIds = [...(f.gainedIds ?? []), ...takenIds];
          break;
        }
        const ids = e.target === 'source' ? [f.sourceId] : (f.selections?.[e.target] ?? []);
        let moved = 0;
        const takenAll: CardId[] = [];
        const options: CardId[] = [];
        for (const id of ids) {
          const owner = s.cards[id]?.owner;
          const here = owner === undefined ? undefined : findField(s, owner, id);
          // A host that has already left the field (the printed self-retire cost above the sentence,
          // BLC-4-034) has filed its hidden stack in 場外; the frame remembers which ids those were, and
          // only those still in the pile are taken.
          const filed = id === f.sourceId && here === undefined && owner !== undefined
            ? (f.sourceStack ?? []).filter(card => s.players[owner].sideline.includes(card))
            : undefined;
          const stack = here?.card.faceDown ?? filed ?? [];
          if (owner === undefined || !stack.length) continue;
          // 「…をN枚まで手札に加える」 (BLC-4-034) — the printed 「まで」 leaves the take declinable, so
          // even a stack that fits inside the count goes through the offer (0..N).
          if (!e.optional && (e.all || stack.length <= e.count)) {
            const taken = filed === undefined ? stack.splice(0, stack.length) : [...filed];
            if (filed !== undefined) s.players[owner].sideline = s.players[owner].sideline.filter(card => !filed.includes(card));
            s.players[owner].hand.push(...taken);
            moved += taken.length;
            takenAll.push(...taken);
            // 「このキャラの下の裏向きのカードを手札に加えた時」 — the host is the event's subject.
            for (const card of taken) ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToHand', id, card));
          } else options.push(...stack);
        }
        f.didCount = moved;
        f.gainedCount = (f.gainedCount ?? 0) + moved;
        f.gainedIds = [...(f.gainedIds ?? []), ...takenAll];
        if (options.length) {
          f.stage = 'take';
          const max = Math.min(e.count, options.length);
          request(ctx, f, 'cards', e.optional ? `从卡下选择最多 ${e.count} 张加入手牌（可不选）` : `从卡下选择 ${e.count} 张加入手牌`, e.optional ? 0 : max, max, options);
          return;
        }
        break;
      }
      case 'discardedUnder': {
        // The cards *this effect* sent to 場外, read from the frame — 「この効果で場外に置いたカードを
        // 裏向きでこのキャラの下に置く」. Anything already moved on by a later effect is left where it is;
        // the identity is only a claim about which pile the card was put in, not a hold on the card.
        // 「この効果で退場させたキャラを全てこのキャラの下に裏向きで置く」 — the retirement record
        // instead of the discard record, narrowed to cards still in 場外.
        const ids = (e.from === 'retired'
          ? (f.retiredIdsOwn ?? []).filter(id => s.players[s.cards[id]?.owner ?? f.player].sideline.includes(id))
          : underPlacementSubjects(s, f))
          .filter(id => e.name === undefined || peekDefinition(s, id)?.name === e.name);
        if (!ids.length) break;
        // 「そのカードを…〈クレア・カゲノー〉1枚の下に裏向きで置いてもよい。」 (KJN-1-014) — the host is
        // a *chosen* card (`underBind`) rather than the effect source; the source itself stays the host
        // for the unbound spelling.
        const hostId = e.underBind !== undefined ? (f.selections?.[e.underBind] ?? [])[0] : f.sourceId;
        const host = hostId === undefined ? undefined : findField(s, f.player, hostId);
        if (!host) break;
        // 「そのカードを裏向きでこのキャラの下に置いてもよい」 — the placement is the player's choice and
        // the card is already fixed, so the host itself is offered back as the single option.
        if (e.optional) {
          f.stage = 'place';
          request(ctx, f, 'cards', '可将该卡面朝下置于该角色下方（可不选）', 0, 1, [host.card.cardId]);
          return;
        }
        placeUnder(ctx, f, host.card, ids);
        break;
      }
      case 'remainderToHand': {
        // 「…をそれぞれ1枚まで選び、その中から2枚までを自分の場にレストで登場させ、残りを手札に加える。」
        // — the bound cards the later question did not take join their owners' hands. A card a step in
        // between already moved (the deployed picks) is left where it is.
        const pool = e.from.flatMap(bind => f.selections?.[bind] ?? []);
        const taken = new Set(f.selections?.[e.exclude] ?? []);
        let moved = 0;
        for (const id of new Set(pool)) {
          if (taken.has(id)) continue;
          const owner = s.cards[id]?.owner;
          if (owner === undefined) continue;
          if (!s.players[owner].sideline.includes(id)) continue;
          removeFromZone(s, owner, id);
          s.players[owner].hand.push(id);
          // The same 場外→手札 arrival as `case 'return'`'s: this route (「残りを手札に加える」) takes
          // its cards out of the discard pile too, so the moment and its record are raised here as well.
          logTurnEvent(s, 'sidelineToHand', owner, id, { via: 'effect', causeId: f.sourceId });
          ctx.queue.push(...collectTriggered(ctx, owner, 'onSidelineToHand', id, id, { causeId: f.sourceId }));
          moved++;
        }
        f.didCount = moved;
        break;
      }
      case 'eventCardToDeckTop': {
        // 「…そのカードを自分の山札の上に置いてもよい。」 — the raising event's card (still in 場外)
        // returns to the top of its owner's deck, the same subject `recoverDiscarded` moves to the hand.
        const ids = underPlacementSubjects(s, f);
        for (const id of ids) {
          const owner = s.cards[id]?.owner;
          if (owner === undefined) continue;
          removeFromZone(s, owner, id);
          s.players[owner].deck.unshift(id); noteDeckTop(s.players[owner]);
          ctx.events.push({ type: 'cardPlacedOnDeck', data: { player: owner, cardId: id } });
        }
        f.didCount = ids.length;
        break;
      }
      case 'recoverDiscarded': {
        // 「場外に置いたそのカードを1枚まで手札に加える」 — the same subject `discardedUnder` reads (the
        // raising event's card, or this effect's own discard record), moving the cards to hand instead of
        // under a host. Only cards still in 場外 qualify, and the FAQ for this family (Q642–Q644) is
        // explicit that a card placed by an earlier event — or a card with the same name already there —
        // is not eligible, which is why the subject is read per task rather than from the pile.
        const ids = e.from === 'deck'
          ? (f.milledToSidelineIds ?? []).filter(id => s.players[s.cards[id]!.owner].sideline.includes(id))
          : underPlacementSubjects(s, f);
        if (!ids.length) { f.didCount = 0; break; }
        f.stage = 'recoverDiscarded';
        request(ctx, f, 'cards', `选择至多 ${e.max} 张本次置于场外的卡加入手牌（可不选）`, 0, e.max, ids);
        return;
      }
      case 'declare': {
        // `what` names which quantity is being declared; an unknown one is left for the schema rather
        // than silently declaring nothing.
        if (e.what === 'trait') {
          // 「自分の場にある「高校」を含む特徴を1つ指定する」 — the candidates are the traits the
          // controller's *own field* actually prints, optionally narrowed to those containing the
          // printed fragment, so the declaration can never name a trait the board does not offer.
          const traits = new Set<string>();
          for (const line of ['front', 'energy'] as const) {
            for (const card of s.players[f.player][line]) {
              const definition = peekDefinition(s, card.cardId);
              for (const trait of definition?.traits ?? []) {
                if (e.contains !== undefined && !trait.includes(e.contains)) continue;
                traits.add(trait);
              }
            }
          }
          const options = [...traits];
          if (!options.length) break;
          f.stage = 'declare';
          f.declared ??= {};
          request(ctx, f, 'option', '指定特征', 1, 1, options);
          return;
        }
        if (e.what === 'name') {
          // 「…から1つ指定する」 — the candidates are the printed list itself, so the declaration can
          // never name anything else.
          const options = [...e.candidates];
          if (!options.length) break;
          f.stage = 'declare';
          f.declared ??= {};
          request(ctx, f, 'option', '指定卡名', 1, 1, options);
          return;
        }
        if (e.what !== 'energyCount') break;
        // Only totals that occur in the catalog are offered, so the declaration is always one some
        // card can satisfy; the engine reads them from its own catalog rather than guessing a range.
        const totals = new Set<number>();
        for (const definition of Object.values(s.catalog)) {
          const total = Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
          if (total >= e.min && total <= e.max) totals.add(total);
        }
        const options = [...totals].sort((a, b) => a - b).map(String);
        if (!options.length) break;
        f.stage = 'declare';
        f.declared ??= {};
        request(ctx, f, 'option', '指定必要能量的数量', 1, 1, options);
        return;
      }
      case 'swapLines': {
        // Either side may be the effect's own source (「…を1枚選び、このキャラと位置を入れ替える」).
        // It is named by the literal `'source'` because the source card is never a selection binding.
        const side = (bind: string): CardId[] =>
          bind === 'source' ? [f.sourceId] : (f.selections?.[bind] ?? []);
        const first = side(e.a);
        const second = side(e.b);
        const pairs = Math.min(first.length, second.length);
        const moved: CardId[] = [];
        // The line each card left, for the 「moved」 log below. A cross-line swap is a move for both
        // halves, and the direction readers (`conditions.ts` `turnEvent.line` / `toLine`) need the
        // departure line; a same-line exchange changes no line, so it stays out of the map (and out of
        // the direction readings) — only the position moved.
        const departedLine = new Map<CardId, 'front' | 'energy'>();
        for (let i = 0; i < pairs; i++) {
          const left = findField(s, s.cards[first[i]!]?.owner ?? f.player, first[i]!);
          const right = findField(s, s.cards[second[i]!]?.owner ?? f.player, second[i]!);
          if (!left || !right) continue;
          // A swap only makes sense between two cards of one player; a cross-player pair would be a
          // move each and is not what 「位置を入れ替える」 prints.
          const owner = s.cards[first[i]!]!.owner;
          if (owner !== s.cards[second[i]!]!.owner) continue;
          const leftLine = left.line;
          const rightLine = right.line;
          const leftForbids = staticForbids(s, first[i]!, owner);
          if (leftForbids.move || (leftForbids.moveOpponentOnly && f.player !== owner)) continue;
          const rightForbids = staticForbids(s, second[i]!, owner);
          if (rightForbids.move || (rightForbids.moveOpponentOnly && f.player !== owner)) continue;
          // 「このカードはフロントLに〔登場・移動〕できない」 — for a cross-line swap each card *moves*
          // to the other's line, so the refusal (with the reminder spelling's carve-out) applies to the
          // half that would land on the front (Q1967: 「位置を入れ替える効果で移動できますか→いいえ」).
          if (leftLine !== rightLine) {
            if (rightLine === 'front' && frontMoveForbidden(s, first[i]!, owner, f.player, f.sourceId)) continue;
            if (leftLine === 'front' && frontMoveForbidden(s, second[i]!, owner, f.player, f.sourceId)) continue;
            // 「このカードはエナジーLに〔登場・移動〕できない」 — the mirror half (BLC-1-081, Q568:
            // 「位置を入れ替える効果で…移動できますか→いいえ」). The printed energy refusals carry no
            // carve-out (all seven corpus cards are unconditional), so the plain static read is the
            // whole rule here; the front half above keeps its carve-out reading.
            if (rightLine === 'energy' && staticImmunity(s, first[i]!, owner).noEnergy) continue;
            if (leftLine === 'energy' && staticImmunity(s, second[i]!, owner).noEnergy) continue;
          }
          if (leftLine === rightLine) {
            // Same line: exchange the two slots, so every other card keeps its position. Skipping
            // these instead (the old behaviour, when only two-line wordings existed) made a
            // 「位置を入れ替える」 whose partner happened to share the line a silent no-op.
            const line = s.players[owner][leftLine];
            const leftAt = line.indexOf(left.card);
            const rightAt = line.indexOf(right.card);
            if (leftAt === -1 || rightAt === -1 || leftAt === rightAt) continue;
            line[leftAt] = right.card;
            line[rightAt] = left.card;
          } else {
            s.players[owner][leftLine].splice(s.players[owner][leftLine].indexOf(left.card), 1);
            s.players[owner][rightLine].splice(s.players[owner][rightLine].indexOf(right.card), 1);
            s.players[owner][rightLine].push(left.card);
            s.players[owner][leftLine].push(right.card);
            // first[i] came from `leftLine`, second[i] from `rightLine` — record each card's own
            // departure line (not the post-swap one) for the 「moved」 event.
            departedLine.set(first[i]!, leftLine);
            departedLine.set(second[i]!, rightLine);
            // Each half of a cross-line swap leaves its line, ending the 「…かぎり」 grants that named it
            // (the same rule the `move` routes apply).
            expireWhileSourceGrants(s, first[i]!, leftLine);
            expireWhileSourceGrants(s, second[i]!, rightLine);
          }
          moved.push(first[i]!, second[i]!);
        }
        for (const id of moved) {
          // A swap moves both cards to the *other* line, so the lines are swapped rather than named one
          // by one — `to` is read from the slots, which by now hold the post-swap arrangement, while
          // `line` is the line the card left (`departedLine`, filled in only for a cross-line swap).
          const at = locate(s, s.cards[id]!.owner, id);
          const from = departedLine.get(id);
          logTurnEvent(s, 'moved', s.cards[id]!.owner, id, {
            ...(from ? { line: from } : {}),
            ...(at ? { to: at.line } : {}),
            causeOwner: f.player,
          });
          // Both cards of a swap changed line, so both are the subject of 「…が移動した時」.
          ctx.queue.push(...collectTriggered(ctx, s.cards[id]!.owner, 'onMoved', id));
        }
        // A completed exchange is something the frame "did": a following 「そうした場合、このキャラを
        // アクティブにする」 (TSK-1-023) or 「…BP+2000」 (HTR-2-074) gates on exactly that fact. Without
        // the record the follow-up could never run, because none of these selections moved a card.
        f.didCount = moved.length;
        ctx.events.push({ type: 'linesSwapped', data: { player: f.player, cards: moved } });
        break;
      }
      case 'battleLoserTo': {
        // Only meaningful inside a battle — the trigger this is printed on has just won one, and the
        // comparison that reads it runs as soon as the queue drains.
        // Q1464/Q1466/Q1468 (MCR-1-080 family): the replacement is the battle resolution's ① step and
        // `compareBattle` has already applied it *before* this queue when it pre-read the step — the
        // flag keeps this copy from re-arming a replacement that already ran.
        if (s.battle && s.battle.loserSent !== true) { s.battleLoserTo = e.destination; s.battleLoserToSource = f.sourceId; }
        break;
      }
      case 'nextUseAp': {
        p.nextUseAp = [...(p.nextUseAp ?? []), { filter: structuredClone(e.filter), amount: e.amount, expiresTurn: s.turn, ...(e.zones ? { zones: [...e.zones] } : {}), ...(e.perEnergy ? { usedSignatures: [] } : {}) }];
        ctx.events.push({ type: 'nextUseDiscount', data: { player: f.player, amount: e.amount } });
        break;
      }
      case 'nextUseActive': {
        // 「…は消費APが-1され、アクティブで場に登場する。」 (ARK-1-055) — the arrival rider waiting beside
        // the discount: the next matching use enters the field active regardless of the printed レスト
        // arrival. Spent by the same use, in `consumeNextUseDiscount`.
        p.nextUseActive = [...(p.nextUseActive ?? []), { filter: structuredClone(e.filter), expiresTurn: s.turn, ...(e.all ? { all: true } : {}) }];
        break;
      }
      case 'nextRaidAp': {
        // The raid-scoped sibling of the waiting AP discount — parked on the player and spent by the
        // raid action alone (`consumeRaidDiscount`).
        p.nextRaidAp = [...(p.nextRaidAp ?? []), { filter: structuredClone(e.filter), amount: e.amount, expiresTurn: s.turn }];
        ctx.events.push({ type: 'nextRaidDiscount', data: { player: f.player, amount: e.amount } });
        break;
      }
      case 'nextRaidEnergy': {
        // The energy sibling of the raid-scoped waiting discount; consulted only while a raid is being
        // priced and spent by `consumeRaidDiscount`.
        p.nextRaidEnergy = [...(p.nextRaidEnergy ?? []), { filter: structuredClone(e.filter), color: e.color, amount: e.amount, expiresTurn: s.turn }];
        ctx.events.push({ type: 'nextUseEnergyDiscount', data: { player: f.player, color: e.color, amount: e.amount } });
        break;
      }
      case 'attackNoDamage': {
        // 「このキャラはこのアタックでダメージを与えず」 (SYN-P-002) — the open battle's damage step is
        // waived when the attack resolves unblocked.
        if (s.battle) s.battle.noDamage = true;
        break;
      }
      case 'nextActivationApFree': {
        // 「次に発動する〈X〉の[起動メイン]は[APを1支払う]を失う」 — parked on the player; the first
        // matching activation's `payAp` spends it (the step skips the cost entirely).
        p.nextActivationApFree = [...(p.nextActivationApFree ?? []), { filter: structuredClone(e.filter), expiresTurn: s.turn }];
        break;
      }
      case 'nextActivationSelectSwap': {
        // 「次に発動させる〈X〉の[起動メイン]は、自分の場のキャラを選ぶ代わりに相手のフロントLの
        // キャラを選んで発動させてもよい」 (HTR-2-046) — parked on the player; the first matching
        // activation's own selection offers both pools and spends the record.
        p.nextActivationSelectSwap = [...(p.nextActivationSelectSwap ?? []), { filter: structuredClone(e.filter), from: e.from, zone: e.zone, expiresTurn: s.turn }];
        break;
      }
      case 'nextEnergyDiscount': {
        // 「…次に〈X〉が自分の場に登場するまで」 must survive the opponent's turn, so its period rides
        // on `untilOwnTurnStart` the way every other printed 「…まで」 does; a plain 「このターン中」 one
        // lapses with the turn.
        p.nextEnergyDiscount = [...(p.nextEnergyDiscount ?? []), {
          filter: structuredClone(e.filter), color: e.color, amount: e.amount,
          expiresTurn: expiryOf(ctx, f.player, e.untilEnter ? 'untilOwnTurnStart' : 'turn'),
          ...(e.untilEnter ? { enterFilter: structuredClone(e.untilEnter) } : {}),
        }];
        break;
      }
      case 'nextUseEnergy': {
        // The energy sibling of the waiting AP discount — parked on the player for the same reason
        // (the granting ability is already resolved) and spent by `consumeNextUseDiscount` on the use.
        p.nextUseEnergy = [...(p.nextUseEnergy ?? []), { filter: structuredClone(e.filter), color: e.color, amount: e.amount, expiresTurn: s.turn }];
        ctx.events.push({ type: 'nextUseEnergyDiscount', data: { player: f.player, color: e.color, amount: e.amount } });
        break;
      }
      case 'nextSelectBp': {
        // 「次に…BPの範囲+1000」 — parked on the player; the next BP-bound selection spends it. The
        // turn-long spelling (「このターン中、自分が「BPの範囲に指定がある効果」でキャラを選ぶ際、
        // 指定できるBPの範囲+1000」) is not spent on the first use, so it enters marked `all`.
        p.pendingSelectBp = [...(p.pendingSelectBp ?? []), { amount: e.amount, expiresTurn: s.turn, ...(e.all ? { all: true } : {}) }];
        ctx.events.push({ type: 'nextSelectBpWidened', data: { player: f.player, amount: e.amount } });
        break;
      }
      case 'purpleChooseAll': {
        // 「…[、次に]…「以下から1つ選ぶ」効果は「以下から全て選ぶ」に代えてもよい。」 — the standing offer
        // on the player. A second copy of the 「次に」 spelling stacks its budget rather than replacing it.
        const prior = p.purpleChooseAll;
        if (e.next && prior?.untilTurn === s.turn && prior.remaining !== undefined) {
          p.purpleChooseAll = { untilTurn: s.turn, remaining: prior.remaining + 1 };
        } else {
          p.purpleChooseAll = { untilTurn: s.turn, ...(e.next ? { remaining: 1 } : {}), ...(e.count !== undefined ? { count: e.count } : {}) };
        }
        break;
      }
      case 'replayAbility': {
        const asSelf = 'asSelf' in e && e.asSelf === true;
        // 「このキャラのレイド元のカードが持つ[登場時]か[退場時]をこのキャラが発動してもよい。」
        // (ARK-1-007) — the base's printed abilities run *as this character's* (「このキャラが発動する」),
        // so they splice into the current frame like the `'source'` spelling. The base is read off the
        // frame: a 退場時 resolution happens after the stack was carried off the field (`makeTask`'s
        // `raidBase`), which is the only place it still exists.
        if (e.target === 'raidBase') {
          const steps: CardEffect[] = [];
          for (const base of f.raidBase ?? []) {
            const definition = peekDefinition(s, base);
            if (!definition) continue;
            for (const ev of e.events) {
              // 「…の[登場時]を…発動する」 is a firing of that entry effect, so a named-tail budget on the
              // base's 【登場時】 applies here too (Q2061-family).
              if (ev === 'onPlay') { const entry = prepareEntryEffects(s, f.player, definition); if (entry.length) trackEntryBudget(f, definition); steps.push(...entry); }
              else steps.push(...(definition.triggered ?? []).filter(a => a.event === 'onRetire').flatMap(a => a.effects));
            }
          }
          if (steps.length) f.steps.splice(f.index + 1, 0, ...structuredClone(steps));
          break;
        }
        // Read from the definition at resolution time, so the ability re-runs exactly what that card
        // prints rather than a snapshot taken when the outer ability compiled.
        const stepsOf = (id: CardId): CardEffect[] => {
          const definition = peekDefinition(s, id);
          if (!definition) return [];
          if (e.event === 'onPlay') return prepareEntryEffects(s, s.cards[id]?.owner ?? f.player, definition);
          if (e.event === 'trigger') {
            // 「そのカードの[トリガー]を発動する」 — the life trigger's own template, read from the same
            // `trigger` field the life batch reads. The fixed kinds become their printed action; the two
            // targeted kinds ([アクティブ] / [スペシャル]) become a selection plus that action, because
            // this route has no batch target to draw on. [レイド] gains its reading here (SMD-1-061's
            // replacement selects 「〈南雲〉以外の[レイドトリガー]」 cards): the trigger text prints
            // 「このカードを手札に加えるか、必要エナジーを満たしている場合、レイドさせる。」, so the
            // either/or is the printed choice — the hand leg returns the card, the raid leg picks a base
            // the card's own RAID condition accepts (`raidBaseFor: 'source'`, which reads this nested
            // task's source) and places it as a free effect-raid. [ファイナル] has no reading outside
            // the life batch and stays a no-op.
            const trigger = definition.trigger;
            if (!trigger) return [];
            switch (trigger.type) {
              case 'color': return trigger.effects ?? [];
              case 'draw': return [{ type: 'draw', count: 1 }];
              case 'get': return [{ type: 'actSource', operation: 'return' }];
              case 'active': return [
                { type: 'select', bind: 'A', zone: 'ownField', filter: { kind: 'character' }, min: 0, max: 1, restOptional: true },
                { type: 'act', target: 'A', operation: 'activate' },
                { type: 'act', target: 'A', operation: 'bp', amount: trigger.bpBonus },
              ];
              case 'special': return [
                { type: 'select', bind: 'A', zone: 'enemyFront', filter: { kind: 'character' }, min: 0, max: 1, restOptional: true },
                { type: 'act', target: 'A', operation: 'retire' },
              ];
              case 'raid': return [
                {
                  type: 'chooseOption', count: 1,
                  // 「…か、必要エナジーを満たしている場合、レイドさせる。」 (SMD-1-061) — the raid leg
                  // is offered only while the replayed card's own requirement is satisfied (Q57/Q54: a
                  // [レイド]トリガー's raid pays no AP but must meet the energy). `selfEnergySatisfied`
                  // reads the nested task's source, which is the replayed card itself.
                  options: [
                    [{ type: 'actSource', operation: 'return' }],
                    [
                      { type: 'select', bind: 'B', zone: 'ownField', filter: { kind: 'character', raidBaseFor: 'source' }, min: 0, max: 1, restOptional: true },
                      { type: 'actSource', operation: 'raid', baseBind: 'B' },
                    ],
                  ],
                  optionGates: [undefined, { type: 'selfEnergySatisfied' }],
                },
              ];
              default: return [];
            }
          }
          const event = e.event === 'onAttack' ? 'onAttack' : 'onRetire';
          // The replayed card's own ability gate must be answered where it resolved from. On the field
          // the `raidState` read sees its slot; a *returned* card (MGS-1-046, Q1644) has none, so the
          // departure stack the `case 'return'` snapshot captured (`returnedStacks`) stands in for it —
          // without the read a non-RAID MGS-1-101 replayed its fenced [退場時] although Q1644 says the
          // card lost it. A card neither on the field nor departed (removal area / リムーブエリア)
          // carries no snapshot and answers the condition as it stands, like every other off-field read.
          const eventOwner = s.cards[id]?.owner ?? f.player;
          const onField = findField(s, eventOwner, id) !== undefined;
          const departed = !onField && (s.players[eventOwner].hand.includes(id) || s.players[eventOwner].sideline.includes(id));
          const stack = departed ? f.returnedStacks?.[id] : undefined;
          const conditionCtx = stack ? { raidBase: stack.underneath } : undefined;
          return (definition.triggered ?? [])
            .filter(a => a.event === event && (a.condition === undefined || evalCondition(s, id, eventOwner, a.condition, conditionCtx)))
            .flatMap(a => a.effects);
        };
        if (e.target === 'source') {
          const steps = stepsOf(f.sourceId);
          if (steps.length) {
            if (e.event === 'onPlay' && (ctx.queue.length || f.queue?.effects.length)) {
              // Q1792: a retirement raised by this ability and the replayed entry are simultaneous
              // moment abilities. Queue the entry as its own resolution so either may be chosen first.
              const task = makeEntryTask(s, f.player, f.sourceId, steps);
              if (f.sourceInstance !== undefined) task.sourceInstance = f.sourceInstance;
              setQueue(f, [...ctx.queue.splice(0), ...(f.queue?.effects ?? []), task]);
            } else {
              if (e.event === 'onPlay') trackEntryBudget(f, peekDefinition(s, f.sourceId));
              f.steps.splice(f.index + 1, 0, ...structuredClone(steps));
            }
          }
          break;
        }
        const queued: EffectTask[] = [];
        // 「そのカード」 — the card the previous sentence sent aside, which lives on the frame's own
        // records rather than in a binding: a removal-discard writes `removedIds`, an ordinary one
        // `discardedIds`.
        const subjects = e.target === 'discarded'
          // A discard to リムーブエリア records the card in *both* `discardedIds` and `removedIds`.
          // Keep the first occurrence only: the same card must replay one trigger, not two (NIK-2-010).
          ? [...new Set([...(f.discardedIds ?? []), ...(f.removedIds ?? [])])]
          : f.selections?.[e.target] ?? [];
        const replayable = e.event === 'onPlay'
          ? subjects.filter(id => !effectsSuppressed(s, id))
          : subjects;
        // 「…をこのキャラが発動する」 (`asSelf`) — the resolving card performs the replayed steps, so they
        // splice into this frame exactly like the `'source'` spelling: every 「このキャラ」 in them is this
        // card (Q524: 「このキャラの下」 is this card's stack; Q525: 【ダメージ2】 lands on this card), and
        // the subject card need not even be on the field (HTR-2-050 replays a card just sent to 場外).
        if (asSelf) {
          const steps = replayable.flatMap(id => stepsOf(id));
          if (steps.length) {
            if (e.event === 'onPlay') for (const id of replayable) trackEntryBudget(f, peekDefinition(s, id));
            f.steps.splice(f.index + 1, 0, ...structuredClone(steps));
          }
          break;
        }
        for (const id of replayable) {
          const steps = stepsOf(id);
          if (!steps.length) continue;
          // 「…の[トリガー]を発動する」 is the same fact the life batch records when a trigger is activated
          // rather than let go to 場外, so 「このターン中に(自分か相手の)[トリガー]が発動している場合」
          // answers for this route too.
          if (e.event === 'trigger') logTurnEvent(s, 'triggered', s.cards[id]?.owner ?? f.player, id);
          const owner = s.cards[id]?.owner;
          // Only a *field* card can be the source of a nested task; anything else would run with no
          // `sourceInstance` and have its own 「このキャラ」 resolve against nothing.
          // Only a *field* card can be the source of a nested task; anything else would run with no
          // `sourceInstance` and have its own 「このキャラ」 resolve against nothing. A trigger replay is
          // the exception: its steps are the trigger's own template (省 target selections), and the card
          // itself may be sitting in 場外 or リムーブエリア when 「そのカードの[トリガー]を発動する」 asks for it.
          // 「手札に戻したキャラの[退場時]を発動し、…」 (MGS-1-046) — the card the sentence above returned is
          // exactly whose 退場時 the print asks to run: a retirement replay is allowed for a card that has
          // just left the field (in hand or 場外), not only for one still holding a slot.
          const departed = owner !== undefined && (s.players[owner].hand.includes(id) || s.players[owner].sideline.includes(id));
          if (owner === undefined || (e.event !== 'trigger' && !findField(s, owner, id) && !(e.event === 'onRetire' && departed))) continue;
          // A *returned* card's stack rides along (captured by `case 'return'`): the retirement route
          // hands its own stack to the nested task the same way, so a replayed 「このキャラのレイド元」
          // reads the base the card left behind instead of nothing (MGS-1-046, Q1644).
          const returnedStack = departed ? f.returnedStacks?.[id] : undefined;
          const task = makeTask(s, owner, id, steps, undefined, returnedStack?.underneath, returnedStack?.faceDown);
          // 「そのカードの[トリガー]を発動する」 — the replayed card can be in リムーブエリア, where
          // `makeTask` finds no field instance. Mark that removal-replay source explicitly so
          // `actSource` can resolve 「このカード」 without globally accepting removal-area sources.
          if (e.event === 'trigger' && s.players[owner].removal.includes(id)) {
            (task as EffectTask & { triggerReplayRemoval?: true }).triggerReplayRemoval = true;
          }
          if (e.event === 'onPlay') {
            const key = entryBudgetKeyOf(peekDefinition(s, id));
            if (key !== undefined) task.limitBudgetKeys = [...(task.limitBudgetKeys ?? []), key];
          }
          queued.push(task);
        }
        if (queued.length) setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
        break;
      }
    }
    f.index++; f.stage = 'step';
  }
  // 「効果中にBPが0になったとしても、その効果の処理が終わった時にＢＰが0でないならば退場しません」
  // (Q1898/Q1899) — the BP-zero scan runs once, here, at the end of the effect processing rather than
  // after every step: a card that dips to 0 while this effect resolves (a static was counting a card the
  // effect has just moved away) is not retired as long as the effect end leaves it above 0. The scan
  // still runs before the frame teardown, so a retirement it orders queues its [退場時] watchers into
  // ctx.queue, where the drain below picks them up like any other moment ability.
  checkBP(ctx);

  if (f.lifeArrival !== undefined) {
    // The trigger card waited outside every zone while its effect resolved (Q73); it reaches 場外 now.
    const owner = s.cards[f.lifeArrival]?.owner ?? f.player;
    if (!s.players[owner].sideline.includes(f.lifeArrival)) s.players[owner].sideline.push(f.lifeArrival);
    ctx.queue.push(...collectTriggered(ctx, f.player, 'onLifeToSideline', f.lifeArrival, f.lifeArrival));
  }
  // The *last* step can raise a "moment" ability too (a swap that moved a character raises 「移動した時」
  // watchers), and the drain above only runs before the first step. Without this second drain those tasks
  // are left in `ctx.queue` while the frame closes, and the command drops them: the watcher never fires.
  if (ctx.queue.length) {
    const queued = ctx.queue.splice(0, ctx.queue.length);
    setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
  }
  requireRule(f.held.length === 0, 'INVALID_STATE', '效果区仍有未归位的卡牌。');
  if (f.limitBudgetKeys?.length) settleLimitBudgets(s, f.player, f.limitBudgetKeys, frameProducedResult(f));
  if (f.eventCard) p.sideline.push(f.eventCard);
  const resume = f.resume;
  const queue = f.queue;
  const burn = f.playerDamage;
  delete s.effect; s.pending = null;
  // 「相手プレイヤーにNダメージ。」 resolves now that no frame is open, so the trigger batch it opens
  // can start effects of its own (a life card's colour trigger) without colliding with this frame.
  if (burn) { damagePlayer(ctx, f.player, burn, f.sourceId); return; }
  if (queue && queue.effects.length) {
    s.pending = { type: 'queue', player: queue.effects[0]!.player, effects: queue.effects, resume: queue.resume, ...(queue.defenderId !== undefined ? { defenderId: queue.defenderId } : {}), ...(queue.damageCount !== undefined ? { damageCount: queue.damageCount } : {}), ...(resume ? { triggerResume: resume } : {}) };
    return;
  }
  if (resume) { settleTriggers(ctx, resume); return; }
  if (queue) applyQueueResume(ctx, queue.resume, queue.defenderId, queue.damageCount);
}

function evalIf(ctx: Context, f: EffectFrame, condition: Condition): boolean {
  // The frame's bindings are handed over so 「選んだキャラが〈X〉の場合」 can ask about the card the
  // preceding `select` chose. Every other predicate ignores the context.
  return evalCondition(ctx.state, f.sourceId, f.player, condition, {
    ...(f.battleSnapshot !== undefined ? { battle: f.battleSnapshot } : {}),
    ...(f.selections ? { selections: f.selections } : {}),
    ...(f.statementChoice !== undefined ? { statementChoice: f.statementChoice } : {}),
    ...(f.revealedIds ? { revealed: f.revealedIds } : {}),
    ...(f.revealedFrom !== undefined ? { revealedFrom: f.revealedFrom } : {}),
    ...(f.revealedHandCount ? { revealedHand: f.revealedHandCount } : {}),
    // 「公開したカードが必要エナジーを満たし」 — the energy check the condition vocabulary cannot run
    // itself (it lives here, beside the board reads it needs).
    energySatisfied: (id: CardId) => energySatisfied(ctx.state, f.player, id),
    ...(f.retiredOwn ? { retiredOwn: f.retiredOwn } : {}),
    ...(f.retiredOpponent ? { retiredOpponent: f.retiredOpponent } : {}),
    ...(f.retiredIdsOwn?.length ? { retiredIdsOwn: f.retiredIdsOwn } : {}),
    ...(f.retiredIdsOpponent?.length ? { retiredIdsOpponent: f.retiredIdsOpponent } : {}),
    ...(f.discardedIds?.length ? { discardedIds: f.discardedIds } : {}),
    ...(f.discardedIds?.length ? { discardedEnergySum: f.discardedIds.reduce((sum, id) => sum + Object.values(peekDefinition(ctx.state, id)?.requiredEnergy ?? {}).reduce((a, n) => a + (n ?? 0), 0), 0) } : {}),
    ...(f.restedIds?.length ? { restedThisEffect: f.restedIds.length } : {}),
    ...(f.removedIds?.length ? { removedIds: f.removedIds } : {}),
    ...(f.deckBottomIds?.length ? { deckBottomIds: f.deckBottomIds } : {}),
    ...(f.bpZeroIds?.length ? { bpZeroIds: f.bpZeroIds } : {}),
    ...(f.underFromHandIds?.length ? { underFromHand: f.underFromHandIds.length } : {}),
    ...(f.underFromHandHosts?.some(host => host === f.sourceId)
      ? { underFromHandToSource: f.underFromHandHosts.filter(host => host === f.sourceId).length } : {}),
    ...(f.drewFaceDownCount ? { drewFaceDown: f.drewFaceDownCount } : {}),
    ...(f.declared ? { declared: f.declared } : {}),
    // 「このキャラがバトルによって退場した場合」 — guarded steps inside a 退場時 ability resolve after
    // the removal, so the cause travels on the frame (see `EffectTask.retireReason`), and the
    // cause *card* beside it for 「自分の効果によって」「自分の〈X〉の効果で」.
    ...(f.retireReason !== undefined ? { retireReason: f.retireReason } : {}),
    ...(f.departedLine !== undefined ? { departedLine: f.departedLine } : {}),
    ...(f.retireCauseId !== undefined ? { retireCauseId: f.retireCauseId } : {}),
    ...(f.raidBase?.length ? { raidBase: f.raidBase } : {}),
    // 「自分の公開したカードの必要エナジーの数が相手の公開したカードの必要エナジーの数以上だった場合」 —
    // the clash's two revealed cards, read by printed required-energy total. Recorded only when both
    // halves exist: a one-sided reveal answers nothing about the other side.
    ...(f.clashSelf?.length && f.clashOpponent?.length ? {
      clashSelfEnergy: requiredEnergyTotal(ctx.state, f.clashSelf[0]!),
      clashOpponentEnergy: requiredEnergyTotal(ctx.state, f.clashOpponent[0]!),
    } : {}),
  });
}

function requiredEnergyTotal(state: GameState, id: CardId): number {
  const definition = peekDefinition(state, id);
  if (!definition) return 0;
  const owner = state.cards[id]?.owner;
  const set = owner !== undefined && state.players[owner].deck.includes(id)
    ? handStaticsOf(state, id).find((m): m is Extract<StaticModifier, { type: 'energyCostSet' }> => m.type === 'energyCostSet')
    : undefined;
  const energy = set ? set.energy : definition.requiredEnergy;
  return Object.values(energy).reduce((sum, n) => sum + (n ?? 0), 0);
}

/**
 * Evaluates a tier threshold source against the authoritative state.
 *
 * The shared reader lives in `conditions.ts` because `staticBp` needs the same answer for a 「N枚につき」
 * bonus; only the revealed-hand channel is added here, since it lives on this frame.
 */
/**
 * 「自分の場のキャラの最大BP分」 — the extremum of a pool's BP, read where the step resolves.
 *
 * A field card contributes its *current* BP (modifiers included, the value the table shows); a card in
 * 場外 has no slot, so its printed BP answers — the same split every `bound`-style reader makes.
 */
function poolBpExtremum(ctx: Context, f: EffectFrame, spec: { stat: 'bp'; extreme: 'max' | 'min'; who: PlayerScope; zone: 'field' | 'sideline'; other?: boolean }): number {
  const s = ctx.state;
  const poolOwner = scopePlayer(f.player, spec.who);
  const pool = spec.zone === 'field'
    ? [...s.players[poolOwner].front, ...s.players[poolOwner].energy].map(slot => ({ id: slot.cardId, bp: getBP(s, slot) }))
    : s.players[poolOwner].sideline.map(id => ({ id, bp: peekDefinition(s, id)?.bp ?? 0 }));
  const values = pool
    .filter(({ id }) => !(spec.other && id === f.sourceId) && peekDefinition(s, id)?.kind === 'character')
    .map(({ bp }) => bp);
  if (!values.length) return 0;
  return spec.extreme === 'max' ? Math.max(...values) : Math.min(...values);
}

function tierCount(ctx: Context, f: EffectFrame, count: TierCount): number {
  // 「このキャラの下の裏向きカードの枚数分…」 inside a [退場時] ability (TRK-P-003): the card is already
  // in 場外 and its hidden stack was filed with it, so the live slot read finds nothing — the count
  // falls back to the snapshot the retirement carried (`underIds`, the same channel `raidBase` uses).
  if (count.source === 'underCount' && !count.all && !count.line && f.underIds && !findField(ctx.state, f.player, f.sourceId)) {
    return f.underIds.length;
  }
  // 「この効果でレストにしたカードの必要エナジーの合計」 — summed over the frame's own restings, so a
  // board full of already-rested cards contributes nothing.
  if (count.source === 'restedEnergySum') {
    let total = 0;
    for (const id of f.restedIds ?? []) {
      const definition = peekDefinition(ctx.state, id);
      if (!definition) continue;
      total += Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
    }
    return total;
  }
  // 「この効果で(場外から)リムーブエリアに置いたカード1枚につき」 — the frame's own removals, the same
  // frame-scoped reading as `restedEnergySum` above.
  if (count.source === 'removedByThisEffect') return (f.removedIds ?? []).length;
  // 「この効果で退場させたキャラの枚数分」 — the frame's own retirement records, kept per side because the
  // printed subject names one. A retirement neither record covers (a battle's loser, a BP-zero) does not
  // count, which is the printed distinction between this count and 場外's contents.
  if (count.source === 'retiredByThisEffect') {
    const own = (f.retiredIdsOwn ?? []).length;
    const theirs = (f.retiredIdsOpponent ?? []).length;
    return count.who === 'both' ? own + theirs : count.who === 'opponent' ? theirs : own;
  }
  // 「この効果で場外に置いたカードの必要エナジーの数」 — summed over the frame's own discards, the
  // discard-channel sibling of `restedEnergySum`.
  if (count.source === 'discardedEnergySum') {
    let total = 0;
    for (const id of f.discardedIds ?? []) {
      const definition = peekDefinition(ctx.state, id);
      if (!definition) continue;
      total += Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
    }
    return total;
  }
  if (count.source === 'retiredEnergySum') {
    let total = 0;
    for (const id of [...(f.retiredIdsOwn ?? []), ...(f.retiredIdsOpponent ?? [])]) {
      total += retiredRequiredEnergyTotal(ctx.state, id);
    }
    return total;
  }
  // 「この効果で場外に置いたカード1枚につき」 — the sibling for the discard pile.
  // 「レストにした枚数により、…」 / 「この効果で場外に置いたカード1枚につき、…」 — the frame's own
  // restings/discards, the same frame-scoped reading as `removedByThisEffect`.
  if (count.source === 'restedByThisEffect') return (f.restedIds ?? []).length;
  if (count.source === 'discardedByThisEffect') {
    const ids = f.discardedIds ?? [];
    if (!count.filter) return ids.length;
    return ids.filter(id => matchesFilter(ctx.state, id, count.filter!, f.sourceId)).length;
  }
  // 「この効果で選んだキャラの枚数」 — how many cards this resolution's own selection bound, the frame
  // reading of a count no board fact carries.
  if (count.source === 'selectedCount') return (f.selections?.[count.bind ?? 'A'] ?? []).length;
  if (count.source === 'selectedDamageBonus') {
    let total = 0;
    for (const id of f.selections?.[count.bind ?? 'A'] ?? []) {
      const owner = ctx.state.cards[id]?.owner;
      const slot = owner === undefined ? undefined : findField(ctx.state, owner, id);
      const definition = peekDefinition(ctx.state, id);
      if (owner === undefined || slot === undefined || definition === undefined) continue;
      const printed = Math.max(1, definition.keywords?.damage ?? 1);
      total += Math.max(0, getDamage(ctx.state, slot.card) - printed);
    }
    return total;
  }
  // 「登場かレイドさせたキャラの元々の必要エナジー」 (IMC-1-009) — the *printed* requirement total of
  // the card(s) the named binding holds, summed like `discardedEnergySum` reads its own record.
  if (count.source === 'boundPrintedEnergy') {
    let total = 0;
    for (const id of f.selections?.[count.bind ?? 'A'] ?? []) {
      const definition = peekDefinition(ctx.state, id);
      if (!definition) continue;
      total += Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
    }
    return total;
  }
  // 「公開した紫のカードの必要エナジーの数により」 (MMM-2-016) — the printed requirement total of the
  // card this effect just revealed (the frame's `revealedIds`). `color` narrows to the revealed card's
  // printed colour; with no matching reveal there is no count at all, and -1 sits below every tier's
  // floor so no band fires (the same "admits nobody" convention `revealedBpCeiling` gives the
  // selection side).
  if (count.source === 'revealedEnergy') {
    for (const id of f.revealedIds ?? []) {
      const definition = peekDefinition(ctx.state, id);
      if (!definition) continue;
      if (count.color && !Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(ctx.state, id)) continue;
      return Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
    }
    return -1;
  }
  // 「自分の場に〈X〉がある場合、…1枚につき…」 — the printed gate around a count: the condition is the
  // same state predicate `tierCountOf` evaluates (no frame context in it), while the inner count goes
  // through *this* frame-aware reader, so a frame-scoped reading inside the gate (IYS-1-071's
  // 「この効果で…置いたカード1枚につき」) keeps its meaning instead of answering 0.
  if (count.source === 'gated') {
    return evalIf(ctx, f, count.condition) ? tierCount(ctx, f, count.count) : 0;
  }
  // 「…2枚につき」 — the unit division around whatever the inner count is, read through this same
  // frame-aware reader so a frame-scoped inner count (「この効果でレストにしたカード」) keeps its
  // reading inside the division.
  if (count.source === 'perUnit') return Math.floor(tierCount(ctx, f, count.count) / count.per);
  const base = tierCountOf(ctx.state, f.player, f.sourceId, count, f.departedLine);
  if (count.source !== 'revealedTraitNames') return base;
  if (count.zone !== undefined) return base;
  const player = scopePlayer(f.player, count.who);
  const names = new Set<string>();
  for (const id of [...fields(ctx.state, player).map(c => c.cardId), ...(f.selections?.__revealed ?? [])]) {
    const definition = peekDefinition(ctx.state, id);
    if (definition && hasTrait(definition, count.trait)) names.add(definition.name);
  }
  return names.size;
}

/**
 * 「必要エナジーが同じ」 — a comparable signature of a card's required-energy layout.
 *
 * Colour *and* count have to match (「赤1」 is a different requirement from 「赤2」), and the layout is
 * normalised to sorted colour/count pairs so two printings of one requirement compare equal. A zero row
 * is not part of the requirement: 「[赤-]」 and 「[青-]」 both ask for nothing, so they *are* the same
 * requirement — the colour there is the card's own colour identity, which is why the notation keeps it,
 * not something the cost asks the player for. Counting the zero rows would split one "0 点" group into
 * one group per colour.
 */
function energySignature(state: GameState, id: CardId): string {
  const energy = peekDefinition(state, id)?.requiredEnergy ?? {};
  return energyRequirementKey(energy);
}

/**
 * The comparison key both requirement readers share: colour × count, zero rows dropped, colours sorted —
 * `energySignature` (the printed group-discard signature) and `sameEnergyAsBind` (two live reads) must
 * agree on what "the same requirement" means.
 */
function energyRequirementKey(energy: Energy): string {
  return Object.entries(energy)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b)).map(([color, n]) => `${color}${n ?? 0}`).join(',');
}

/**
 * Whether a gated replacement take is the player's option. Every gated spelling in the pool prints
 * 「…てもよい」 except the random-pick flow (`takeRandomBy`, KIN-1-038), whose trait gate is a branch
 * of the print (「…の場合、登場させる。…以外の場合、手札に加える」) and stays forced. A replacement-only take
 * (`takeGateOnly`) already is the player's pick: it is offered only the cards the gate admits.
 */
function takeReplacementIsOptional(e: Extract<CardEffect, { type: 'lookReveal' }>): boolean {
  return e.takeGate !== undefined && e.takeGateOnly !== true && e.takeRandomBy === undefined;
}

/**
 * Whether a picked card fails the printed gates a replacement take carries (`lookReveal.takeGate`).
 *
 * The gates read the picked card itself: its AP cost, whether the chooser's energy already covers its
 * requirement, and — the Re:Zero spelling — whether it carries one of the printed names
 * (「公開したカードが必要エナジーを満たす〈ベアトリス〉の場合、『…』に代えてもよい」). A failing card is
 * taken to hand the ordinary way, which is the print's own default.
 */
function takeGateFails(s: GameState, f: EffectFrame, e: Extract<CardEffect, { type: 'lookReveal' }>, picked: CardId): boolean {
  const gate = e.takeGate;
  if (!gate) return false;
  const definition = peekDefinition(s, picked);
  if (gate.maxApCost !== undefined && (definition?.apCost ?? 0) > gate.maxApCost) return true;
  if (gate.energySatisfied === true && !energySatisfied(s, f.player, picked)) return true;
  if (gate.names?.length) {
    const owner = s.cards[picked]?.owner ?? f.player;
    if (!effectiveNames(s, picked, owner).some(name => gate.names!.includes(name))) return true;
  }
  // 「公開したカードが消費APが1の黄の〈龐煖〉の場合」 (KGD-1-033) — a printed *subject* the named gates
  // above cannot spell (colour, exact price, name together) rides as an ordinary `CardFilter` over the
  // picked card, read through the same `matchesFilter` every other subject uses.
  if (gate.filter !== undefined && !matchesFilter(s, picked, gate.filter, f.sourceId)) return true;
  return false;
}

/**
 * Places one looked card on the front line (「…を自分の場に[レストで]登場させる」).
 *
 * Shared by the plain take and by the deploy leg of 「登場させるかレイドさせる」, so the two arrive the
 * same way: by effect, from the deck, active unless the print said レストで.
 */
function deployTaken(ctx: Context, f: EffectFrame, id: CardId, rested: boolean, line: 'front' | 'energy' = 'front'): void {
  const s = ctx.state;
  const p = s.players[f.player];
  const definition = peekDefinition(s, id);
  // 「自分の場にアクティブで登場させる」 (SMD-1-026's 〈坂本商店〉か… arm) — a FIELD card's home is the
  // energy line (the play action refuses any other line, and the look's `use` leg reads the same');
  // Q1670 answers that the printed front-line arrival cannot place a field. An event has no board
  // arrival at all and falls to 場外. Before this, any non-character take was quietly dumped to 場外 —
  // correct for events, wrong for fields.
  const target: 'front' | 'energy' = definition?.kind === 'field' ? 'energy' : line;
  const room = lineCapacity(s, f.player, target);
  if (!definition || definition.kind === 'event' || p[target].length >= room) { p.sideline.push(id); return; }
  // 「このカードはフロントLに登場できず」/「エナジーLに登場できず」 — the arrival honours the same
  // refusals the `deploy` branch and the play action carry; a closed line sends the card to 場外, the
  // destination every refused arrival in this path has (`deployTakenAskingLine`'s both-closed case).
  const immunity = staticImmunity(s, id, f.player);
  if ((target === 'front' && immunity.noFront) || (target === 'energy' && immunity.noEnergy)) { p.sideline.push(id); return; }
  p[target].push({
    cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`,
    entered: { from: 'deck', by: 'effect', turn: s.turn, ...causeOf(f, s) },
    // The same static precedence as the deploy branch and the play route (Q1964).
    underneath: [], active: !rested || staticEnterActive(s, id, f.player) === true, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
  });
  logTurnEvent(s, 'entered', f.player, id, { via: 'effect', from: 'deck', causeOwner: f.player });
  f.deployedIds = [...(f.deployedIds ?? []), id];
  ctx.queue.push(...collectTriggered(ctx, f.player, 'entered', id, id));
  ctx.events.push({ type: 'cardDeployed', data: { player: f.player, cardId: id, destination: target } });
  // The placement is a real entry: the taken card's own [登場時] runs after the effect (Q478), the same
  // reading `raidTaken` makes for the raid leg of the same either/or.
  const steps = placedEntrySteps(s, f.player, definition);
  if (steps.length) {
    const queued = makeEntryTask(s, f.player, id, steps);
    setQueue(f, [...(f.queue?.effects ?? []), queued]);
  }
}

/**
 * The line question the deploy legs of 「…を自分の場に登場させるかレイドさせる」 share (Q2072): an
 * unqualified arrival of a *character* offers front or energy — minus whichever line the card's own
 * statics close — the same way `case 'deploy'` asks for the act route.
 *
 * Returns true only when the question was raised: the settled answer lands in `takeDeployLine`, which
 * finishes the placement and the take's tail. A one-line card deploys straight away; a card both lines
 * refuse is not deployed (it joins 場外, the destination every refused arrival has in this path).
 */
function deployTakenWithSpace(ctx: Context, f: EffectFrame, id: CardId, rested: boolean, line: 'front' | 'energy'): boolean {
  const s = ctx.state;
  if (s.players[f.player][line].length >= lineCapacity(s, f.player, line)) {
    f.stage = 'takeDeployFullLine';
    f.selections ??= {};
    f.selections.__takeDeploy = [id, rested ? 'rested' : 'active', line];
    request(ctx, f, 'cards', `选择${line === 'front' ? '前线' : '能量线'}的一张卡移除，腾出登场位置`, 1, 1, lineOverflowCandidates(s, f, f.player, line, id), f.player);
    return true;
  }
  deployTaken(ctx, f, id, rested, line);
  return false;
}

export function entryLineOptions(s: GameState, player: PlayerId, id: CardId, fixedLine?: 'front' | 'energy'): ('front' | 'energy')[] {
  const definition = peekDefinition(s, id);
  if (!definition || definition.kind === 'event' || (definition.kind === 'field' && fixedLine === 'front')) return [];
  const immunity = staticImmunity(s, id, player);
  const line = definition.kind === 'field' ? 'energy' : fixedLine;
  return [...(immunity.noFront || line === 'energy' || lineCapacity(s, player, 'front') === 0 ? [] : ['front' as const]), ...(immunity.noEnergy || line === 'front' || lineCapacity(s, player, 'energy') === 0 ? [] : ['energy' as const])];
}

function deployTakenAskingLine(ctx: Context, f: EffectFrame, id: CardId, rested: boolean, fixedLine?: 'front' | 'energy'): boolean {
  const s = ctx.state;
  const definition = peekDefinition(s, id);
  if (!definition || definition.kind === 'event') { deployTaken(ctx, f, id, rested); return false; }
  const lines = entryLineOptions(s, f.player, id, fixedLine);
  if (lines.length === 0) { s.players[f.player].sideline.push(id); return false; }
  if (lines.length === 1) return deployTakenWithSpace(ctx, f, id, rested, lines[0]!);
  f.stage = 'takeDeployLine';
  f.selections ??= {};
  f.selections.__takeDeploy = [id, rested ? 'rested' : 'active'];
  request(ctx, f, 'option', '选择登场战线：front = 前线，energy = 能量线', 1, 1, lines, f.player);
  return true;
}

/** The held card has already been logged as used; resuming a line choice only places it. */
function useTakenWithSpace(ctx: Context, f: EffectFrame, id: CardId, line: 'front' | 'energy', overflowSettled = false): boolean {
  const s = ctx.state, p = s.players[f.player];
  if (!entryLineOptions(s, f.player, id).includes(line)) { p.sideline.push(id); return false; }
  if (p[line].length >= lineCapacity(s, f.player, line)) {
    if (overflowSettled) { p.sideline.push(id); return false; }
    f.stage = 'takeUseFullLine';
    f.selections ??= {};
    f.selections.__takeUse = [id, line];
    request(ctx, f, 'cards', '登场战线已满：选择该战线 1 张卡置于移除区', 1, 1, lineOverflowCandidates(s, f, f.player, line, id), f.player);
    return true;
  }
  p[line].push({
    cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`,
    entered: { from: 'deck', by: 'play', turn: s.turn },
    underneath: [], active: true, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
  });
  logTurnEvent(s, 'entered', f.player, id, { from: 'deck' });
  ctx.queue.push(...collectTriggered(ctx, f.player, 'entered', id, id));
  ctx.events.push({ type: 'cardDeployed', data: { player: f.player, cardId: id, destination: line } });
  const definition = peekDefinition(s, id)!;
  const steps = placedEntrySteps(s, f.player, definition);
  if (steps.length) setQueue(f, [...(f.queue?.effects ?? []), makeEntryTask(s, f.player, id, steps)]);
  return false;
}

function useTakenAskingLine(ctx: Context, f: EffectFrame, id: CardId): boolean {
  const lines = entryLineOptions(ctx.state, f.player, id);
  if (!lines.length) { ctx.state.players[f.player].sideline.push(id); return false; }
  if (lines.length === 1) return useTakenWithSpace(ctx, f, id, lines[0]!);
  f.stage = 'takeUseLine';
  f.selections ??= {};
  f.selections.__takeUse = [id];
  request(ctx, f, 'option', '选择登场战线：front = 前线，energy = 能量线', 1, 1, lines, f.player);
  return true;
}

/**
 * Places a held looked card as a raid top onto `baseId` — the raid leg of an effect's
 * 「…登場させるかレイドさせる」.
 *
 * The card is held by the effect rather than sitting in a zone, so the placement mirrors the `raid`
 * operation without its zoned sourcing: base eligibility is the same `raidBaseEligible` gate, the
 * raider's own 登場時/レイド abilities queue afterwards, and a base that vanished between the mode
 * choice and this step sends the card to 場外 instead.
 */
function raidTaken(ctx: Context, f: EffectFrame, id: CardId, baseId: CardId, line?: 'front' | 'energy'): boolean {
  const s = ctx.state;
  const here = findField(s, f.player, baseId);
  if (!here || !raidBaseEligible(s, f.player, id, baseId) || deployForbidden(s, f.player, id)) { s.players[f.player].sideline.push(id); return false; }
  const target = effectRaidLine(ctx, f, id, baseId, line, true);
  if (s.pending) return true;
  if (target === undefined) { s.players[f.player].sideline.push(id); return false; }
  const definition = peekDefinition(s, id);
  const raidedLen = ctx.queue.length;
  queueRaided(ctx, f.player, baseId, id);
  s.players[f.player][here.line].splice(s.players[f.player][here.line].indexOf(here.card), 1);
  const step = f.steps[f.index];
  const from = step?.type === 'lookReveal' && step.from === 'under' ? 'under' : 'deck';
  const top: FieldCard = {
    cardId: id, instanceId: `${id}@${s.revision}#${ctx.events.length}`,
    entered: { from, by: 'effect', turn: s.turn, raid: true, ...causeOf(f, s) },
    underneath: [baseId], active: true, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [],
    ...(here.card.faceDown?.length ? { faceDown: [...here.card.faceDown] } : {}),
  };
  s.players[f.player][target].push(top);
  for (const task of ctx.queue.slice(raidedLen)) {
    if (task.sourceId === id) task.sourceInstance = top.instanceId ?? top.cardId;
  }
  f.deployedIds = [...(f.deployedIds ?? []), id];
  logTurnEvent(s, 'used', f.player, id, { free: true, raid: true, via: 'effect', usedFrom: from });
  logTurnEvent(s, 'entered', f.player, id, { via: 'effect', raid: true, from, causeOwner: f.player });
  ctx.queue.push(...collectTriggered(ctx, f.player, 'entered', id, id));
  ctx.queue.push(...collectTriggered(ctx, f.player, 'onRaid', id, id));
  ctx.events.push({ type: 'raidPlayed', data: { player: f.player, cardId: id, baseId } });
  const steps = [...(definition ? placedEntrySteps(s, f.player, definition) : []), ...(definition?.onRaid ?? [])];
  if (steps.length) {
    const queued = makeEntryTask(s, f.player, id, steps);
    setQueue(f, [...(f.queue?.effects ?? []), queued]);
  }
  return false;
}

/** Q44/Q48: decide the optional front move before the raid and its entry abilities. */
function effectRaidLine(ctx: Context, f: EffectFrame, id: CardId, baseId: CardId, line?: 'front' | 'energy', taken = false): 'front' | 'energy' | undefined {
  const s = ctx.state, owner = s.cards[id]?.owner ?? f.player;
  const base = findField(s, owner, baseId);
  if (!base) return undefined;
  const immunity = staticImmunity(s, id, owner);
  const lines = base.line === 'front' ? ['front' as const]
    : [...(immunity.noFront ? [] : ['front' as const]), ...(immunity.noEnergy ? [] : ['energy' as const])];
  if (line === undefined && lines.length > 1) {
    f.stage = taken ? 'takeRaidLine' : 'raidLine';
    (f.selections ??= {}).__raid = [id, baseId];
    request(ctx, f, 'option', '选择突进战线：front = 移至前线，energy = 留在能量线', 1, 1, lines, owner);
    return undefined;
  }
  const target = line ?? lines[0];
  if (target === undefined || !lines.includes(target) || (target === 'front' && immunity.noFront)) return undefined;
  if (target !== base.line && s.players[owner][target].length >= lineCapacity(s, owner, target)) {
    f.stage = taken ? 'takeRaidFullLine' : 'raidFullLine';
    (f.selections ??= {}).__raid = [id, baseId, target];
    const candidates = lineOverflowCandidates(s, f, owner, target, id);
    if (!candidates.length) return undefined;
    request(ctx, f, 'cards', '突进战线已满：选择该战线 1 张卡置于移除区', 1, 1, candidates, owner);
    return undefined;
  }
  return target;
}

function resumeRaidOperation(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'act' | 'actSource' }>, id: CardId, baseId: CardId, line: 'front' | 'energy'): void {
  // Store the resolved base directly: it may be the source or a base a previous peel uncovered.
  (f.selections ??= {}).__raidBase = [baseId];
  applyOperation(ctx, f, id, 'raid', undefined, line, undefined, undefined, undefined, undefined, '__raidBase', undefined, undefined, undefined, undefined, undefined, undefined, e.suppressOnPlay === true);
  delete f.selections.__raidBase;
}

/**
 * Asks the next 「それぞれ」 group of a looked-card take, over the cards the earlier picks left.
 *
 * The groups are asked in printed order; a group with nothing matching among the remaining cards still
 * asks — as the confirm that keeps the printed step visible (round-124 ②). Returns whether a question
 * was opened — `false` means every group has been asked and the look moves on.
 */
function requestTakeGroup(ctx: Context, f: EffectFrame, e: Extract<CardEffect, { type: 'lookReveal' }>): boolean {
  const groups = e.takeGroups ?? [];
  for (let index = f.takeGroupIndex ?? 0; index < groups.length; index++) {
    const group = groups[index]!;
    const candidates = f.held.filter(id => matchesFilter(ctx.state, id, group.filter, f.sourceId, undefined, true));
    const max = Math.min(group.max, candidates.length);
    f.takeGroupIndex = index;
    f.stage = 'takeGroup';
    request(ctx, f, 'cards', candidates.length
      ? `从剩余的 ${f.held.length} 张中选至多 ${max} 张${e.takeGroupsTo === 'sideline' ? '置于场外' : '加入手牌'}（可不选）`
      : `从剩余的 ${f.held.length} 张中：无可选卡，点击确认继续`, 0, max, candidates);
    // 「異なるカード名の…をそれぞれ1枚まで」 may belong to one group alone (TRK-P-002's blue
    // 食材 group); the parent `distinctNames` would constrain every group instead.
    if (group.distinctNames && ctx.state.pending?.type === 'effect') ctx.state.pending.distinctNames = true;
    return true;
  }
  return false;
}




/**
 * The act loop parks mid-way when a placement asks its own question (the line / full-line questions a
 * multi-pick deploy raises once per card); the ids still behind the parked one ride `__actRest`. This
 * drains the next one — which may itself park, leaving the queue in place for the following answer.
 */
function drainParkedAct(ctx: Context, f: EffectFrame, operation: CardOperation | undefined, suppressOnPlay = false, line?: 'front' | 'energy'): void {
  const rest = f.selections?.__actRest;
  if (!rest?.length || operation === undefined) return;
  const next = rest.shift()!;
  if (!rest.length) delete f.selections!.__actRest;
  // The parked ids belong to the step that asked the question, so its printed suppression and
  // destination (`line`, the move step's own) ride along.
  applyOperation(ctx, f, next, operation, undefined, line, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, suppressOnPlay);
}

/** 满线腾位候选的唯一来源：Q875排除本效果已登场的卡；移动/放置卡自身始终排除，余下为空时退回该线可腾位卡。 */
export function lineOverflowCandidates(s: GameState, f: EffectFrame, owner: PlayerId, line: 'front' | 'energy', placing?: CardId): CardId[] {
  const cards = s.players[owner][line].map(card => card.cardId).filter(id => id !== placing);
  const deployed = new Set(f.deployedIds ?? []);
  const legal = cards.filter(id => !deployed.has(id));
  return legal.length ? legal : cards;
}

/** Rule-driven line overflow still belongs to this move/deploy's result record. */
function overflowRemoval(ctx: Context, f: EffectFrame, owner: PlayerId, id: CardId): void {
  if (!findField(ctx.state, owner, id)) return;
  const went = leaveField(ctx, owner, id, 'removal', 'line-capacity');
  if (went === 'removal') {
    (f.removedIds ??= []).push(id);
    ctx.queue.push(...collectTriggered(ctx, owner, 'onRemoved', id, undefined, {causeId:f.sourceId}));
  } else if (went === 'sideline') (f.discardedIds ??= []).push(id);
}
export { overflowRemoval };

/** 「N枚を場外に置いてもよい」 — optional, a fixed printed width of two or more (no 「まで」, no 「望む枚数」, no floor/ceiling pair). */
function isBinaryOptionalDiscard(e: Extract<CardEffect, { type: 'discard' }>): boolean {
  return e.optional === true && e.all !== true && e.max === undefined && e.countSource === undefined && e.count >= 2 && e.count < ANY_COUNT;
}

export function lifeSlotCode(s: GameState, chooser: PlayerId, id: string): string | undefined {
  const owner = s.cards[id]?.owner;
  if (owner === undefined) return undefined;
  const slot = s.players[owner].life.indexOf(id);
  return slot < 0 ? undefined : `${owner === chooser ? 'life' : 'oppLife'}:${slot}`;
}
/** 位置码还原成真实卡 id：只还原候选里确实存在、且位置对得上的那张；其余原样交给后面的合法性检查。 */
function blindLifeSelection(s: GameState, selected: string[]): string[] {
  const pending = s.pending;
  if (pending?.type !== 'effect') return selected;
  return selected.map(code => {
    if (pending.options.includes(code)) return code;
    const match = /^(life|oppLife):(\d+)$/.exec(code);
    if (!match) return code;
    const owner = match[1] === 'life' ? pending.player : otherOf(pending.player);
    const id = s.players[owner].life[Number(match[2])];
    return id !== undefined && pending.options.includes(id) ? id : code;
  });
}
/**
 * Resolve the hand-card frame opened for a selection tax. The cards the chooser picked (not the first
 * hand entries) go to 場外; then the parked answer is restored and replayed with `selectionTaxPaid` so
 * `chargeSelectionTax` runs only the AP/rest halves. A `declared` target has no effect answer to
 * replay: its binding is committed here and the step advances.
 */
function resolveSelectionTaxPayment(ctx: Context, f: EffectFrame, pending: EffectDecision | null, choiceId: string, selected: string[]): boolean {
  const deferred = f.selectionTaxDeferred;
  if (!deferred) return false;
  requireRule(pending?.type === 'effect' && pending.choiceId === choiceId, 'INVALID_CHOICE', '效果选择已失效。');
  requireRule(selected.length >= pending.min && selected.length <= pending.max && new Set(selected).size === selected.length && selected.every(id => pending.options.includes(id)), 'INVALID_CHOICE', '请选择规定数量、不重复的合法选项。');
  const p = ctx.state.players[f.player];
  for (const id of selected) requireRule(p.hand.includes(id), 'INVALID_CHOICE', '该手牌已不在手牌中。');
  delete f.selectionTaxDeferred;
  for (const id of selected) {
    p.hand.splice(p.hand.indexOf(id), 1);
    p.sideline.push(id);
  }
  f.selectionTaxPaid = true;
  if (deferred.mode === 'declared') {
    f.selections ??= {};
    f.selections[deferred.bind] = [deferred.declared];
    chargeSelectionTax(ctx, f, [deferred.declared]);
    delete f.selectionTaxPaid;
    f.index++; f.stage = 'step'; runEffects(ctx);
    return true;
  }
  // Restore the selection answer the chooser was giving when the tax frame interrupted it.
  ctx.state.pending = deferred.pending;
  f.stage = deferred.stage;
  try {
    chooseEffectCore(ctx, deferred.choiceId, deferred.selected);
  } finally {
    delete f.selectionTaxPaid;
  }
  return true;
}
export function chooseEffect(ctx: Context, choiceId: string, selected: string[]): void {
  selected = blindLifeSelection(ctx.state, selected);
  syncLedger(ctx, 'rule');
  logChoice(ctx, choiceId, selected);
  chooseEffectCore(ctx, choiceId, selected);
  syncLedger(ctx, 'effect');
}
function logChoice(ctx: Context, choiceId: string, selected: string[]): void {
  const pending = ctx.state.pending;
  if (pending?.type !== 'effect' || pending.choiceId !== choiceId) return;
  if (pending.kind === 'cards') {
    const cards = selected.filter(id => ctx.state.cards[id] !== undefined);
    if (!selected.length && pending.min === 0) logEvent(ctx, 'choicePicked', { player: pending.player, cards: [], pub: [], own: [] });
    else if (selected.length) logEvent(ctx, 'choicePicked', { player: pending.player, cards: selected, ...visibility(ctx, cards) });
    return;
  }
  const label = selected.length === 1 ? ({ front: '前线', energy: '能量线', top: '牌库顶', bottom: '牌库底', 支付: '支付', 不支付: '不支付' } as Record<string, string>)[selected[0]!] : undefined;
  if (label !== undefined) logEvent(ctx, 'optionPicked', { player: pending.player, label });
}
function chooseEffectCore(ctx: Context, choiceId: string, selected: string[]): void {
  const s = ctx.state, f = s.effect, pending = s.pending;
  if (f && pending?.type === 'effect' && resolveSelectionTaxPayment(ctx, f, pending, choiceId, selected)) return;
  requireRule(f && pending?.type === 'effect' && choiceId === pending.choiceId, 'INVALID_CHOICE', '效果选择已失效。');
  requireRule(selected.length >= pending.min && selected.length <= pending.max && new Set(selected).size === selected.length && selected.every(id => pending.options.includes(id)), 'INVALID_CHOICE', '请选择规定数量、不重复的合法选项。');
  // 「異なるカード名の…をそれぞれ1枚ずつ」 — the set may not hold two cards sharing a printed name.
  requireRule(!pending.distinctNames || new Set(selected.map(id => peekDefinition(s, id)?.name)).size === selected.length, 'INVALID_CHOICE', '同一卡名的卡不能重复选择。');
  // 「必要エナジーが異なる…」 — no two picks may share a printed required-energy total.
  requireRule(!pending.distinctEnergy || new Set(selected.map(id => Object.values(peekDefinition(s, id)?.requiredEnergy ?? {}).reduce((sum, n) => sum + (n ?? 0), 0))).size === selected.length, 'INVALID_CHOICE', '必要能量相同的卡不能重复选择。');
  // 「…をBPの合計が7500以下になるように望む枚数公開し手札に加える」 — the picked set's BP may not add up
  // past the ceiling; the select path's own bound (TLR-1-030) lands on the same pending field. A field
  // card contributes the BP the board shows (its modifiers count); an off-field pick — where the take
  // route reads — has no current value, so its printed BP is the whole read.
  if (pending.bpSumMax !== undefined || pending.bpSumMin !== undefined) {
    const bpOf = (id: string): number => {
      const owner = s.cards[id]?.owner ?? f.player;
      const slot = findField(s, owner, id);
      return slot ? getBP(s, slot.card) : (peekDefinition(s, id)?.bp ?? 0);
    };
    if (pending.bpSumMax !== undefined) {
      requireRule(selected.reduce((sum, id) => sum + bpOf(id), 0) <= pending.bpSumMax, 'INVALID_CHOICE', '所选的卡 BP 合计超过上限。');
    }
    // 「BPの合計が4000以上になるように望む枚数レストにする」 (DST-1-078) — a non-empty set must reach the
    // floor; an empty set is the printed decline (a forced `min` is refused by the width check above).
    if (pending.bpSumMin !== undefined) {
      requireRule(selected.length === 0 || selected.reduce((sum, id) => sum + bpOf(id), 0) >= pending.bpSumMin, 'INVALID_CHOICE', '所选的卡 BP 合计不足下限。');
    }
  }
  // 「必要エナジーの合計が4以上になるように望む枚数」 (MMM-2-012) — the picked set's requirement totals
  // must reach the floor; read through `effectiveRequiredEnergy` like every other 必要エナジーの合計.
  requireRule(pending.energySumMin === undefined
    || selected.reduce((sum, id) => sum + Object.values(effectiveRequiredEnergy(s, id)).reduce((total, n) => total + (n ?? 0), 0), 0) >= pending.energySumMin,
  'INVALID_CHOICE', '所选的卡必要能量合计不足下限。');
  const e = f.steps[f.index]!;
  if (e.type === 'discard' && isBinaryOptionalDiscard(e)) {
    requireRule(selected.length === 0 || selected.length === e.count, 'INVALID_CHOICE', '请选择完整的规定张数，或不选择。');
  }
  if (e.type === 'select' && e.min === 0 && e.printedMin !== undefined) {
    requireRule(selected.length === 0 || selected.length >= e.printedMin, 'INVALID_CHOICE', '请选择完整的规定张数，或不选择。');
  }
  const p = s.players[f.player];
  if (e.type === 'triggerEntryChoice') {
    const command = e.commands[selected[0]!];
    requireRule(command !== undefined, 'INVALID_CHOICE', '触发替代应答已失效。');
    requireRule(e.pendingBefore.player === f.player && e.pendingBefore.getResolution?.cardId === f.sourceId
      && e.pendingBefore.getResolution.phase === e.phase && command.player === f.player
      && JSON.stringify(e.pendingBefore) === JSON.stringify(f.resume), 'INVALID_CHOICE', '触发续接与已保存的决定不一致。');
    s.pending = structuredClone(e.pendingBefore);
    delete s.effect;
    executeResumedCommand(ctx, command);
    return;
  }
  // 「必要エナジーが同じカードを3枚場外に置く」 — either the whole group or nothing, and every member
  // shares one required-energy signature. A partial pick (1–2 cards) is not what the print offers.
  requireRule(
    !pending.sameEnergy || selected.length === 0
      || (e.type === 'discardSameEnergy' && selected.length === e.count && new Set(selected.map(id => energySignature(s, id))).size === 1),
    'INVALID_CHOICE', '所选的卡必须必要能量相同且数量正确。',
  );
  s.pending = null;
  // 「相手はイベントカードの効果でこのキャラを選ぶ際に、追加で自身の手札を1枚場外に置かないと選べない」
  // (SAO-1-087) — the hand half is a choice, not a `hand.shift()`: park the selection answer, ask the
  // chooser which hand cards pay, and replay the answer once they are moved. AP/rest stay in
  // `chargeSelectionTax`, which skips only the hand half while `selectionTaxPaid` is set. The same gate
  // covers every `select` and `choose` target, so the 17 pool cards that tax hand pay through it too.
  if (f.stage === 'step' && !f.selectionTaxPaid && (e.type === 'select' || e.type === 'choose')) {
    const total = selectionTaxHandTotal(s, f, selected);
    if (total > 0) {
      const p = s.players[f.player];
      requireRule(total <= p.hand.length, 'INVALID_CHOICE', '手牌不足支付选择税。');
      f.selectionTaxDeferred = { mode: 'answer', pending, choiceId, selected: [...selected], stage: f.stage };
      f.stage = 'option';
      request(ctx, f, 'cards', '选择支付选择税弃置的手牌', total, total, [...p.hand]);
      return;
    }
  }
  if (e.type === 'revealHand' && f.stage === 'revealHandSubset') {
    const owner = e.player === 'opponent' ? otherOf(f.player) : f.player;
    (f.selections ??= {}).__revealed = [...selected];
    f.didCount = selected.length;
    if (selected.length) {
      logTurnEvent(s, 'revealedFromHand', owner, undefined, { causeOwner: f.player, causeId: f.sourceId });
      queueRevealedFromHand(ctx, selected, f.sourceId);
      ctx.events.push({ type: 'handRevealed', data: { player: owner, cards: [...selected] } });
      f.stage = 'revealHandConfirm';
      request(ctx, f, 'option', '已公开所选手牌，请双方确认后继续', 1, 1, ['continue']);
      return;
    }
  } else if (e.type === 'revealHand' && f.stage === 'revealHandConfirm') {
    // Q199/Q204: stop displaying this hand set before resolving its tiers/battle continuation.
    const revealed = new Set(f.selections?.__revealed ?? []);
    if (s.publicReveals) s.publicReveals = s.publicReveals.filter(id => !revealed.has(id));
  } else if (e.type === 'deployBatch') {
    answerDeploymentBatch(ctx, f, selected);
    if (runDeploymentBatch(ctx, f, e)) return;
  }
  else if (e.type === 'choose') applyTargets(ctx, f, e, selected);
  else if (e.type === 'select') {
    chargeSelectionTax(ctx, f, selected);
    f.selections ??= {};
    f.selections[e.bind] = selected;
    f.selectionNames ??= {};
    f.selectionNames[e.bind] = selected.flatMap(id => effectiveNames(s, id, s.cards[id]!.owner));
    recordChosen(ctx, f, selected);
    // 「…を1枚選ぶ。そうした場合、…」 — binding a card is a result, which is what a following
    // `gained` asks about. Without this the branch read whatever the frame last did (nothing, at the
    // head of a 登場時 frame), so the whole consequent was unreachable.
    f.didCount = selected.length;
  }
  else if (e.type === 'recoverDiscarded') {
    for (const id of selected) {
      const owner = s.cards[id]!.owner;
      requireRule(s.players[owner].sideline.includes(id), 'INVALID_CHOICE', '该卡已不在场外。');
      removeFromZone(s, owner, id);
      s.players[owner].hand.push(id);
      ctx.events.push({ type: 'cardRecovered', data: { player: owner, cardId: id } });
    }
    f.didCount = selected.length;
  }
  else if (e.type === 'payAp' && f.stage === 'option') {
    f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0;
    if (selected[0] === '支付') f.steps.splice(f.index + 1, 0, { ...e, optional: false });
  }
  else if (e.type === 'discard' || e.type === 'payDiscard') {
    const target = e.type === 'discard' ? scopePlayer(f.player, e.player) : f.player;
    s.players[target].hand = s.players[target].hand.filter(id => !selected.includes(id));
    // 「自分の手札を1枚リムーブエリアに置いてもよい」 — the printed destination may be the removal area
    // rather than 場外; the frame records it the same way an explicit `remove` does.
    if (e.type === 'discard' && e.to === 'removal') {
      // The same per-card redirect as the unasked spelling: the static's holder reaches 場外 instead
      // (and still joins `discardedIds` below, the way every answered discard records its picks).
      for (const id of selected) {
        if (removalRedirectsToSideline(s, id, f.sourceId)) { s.players[target].sideline.push(id); continue; }
        s.players[target].removal.push(id);
        (f.removedIds ??= []).push(id);
      }
    } else {
    // 「…以外でこのカードが場外に置かれる場合、代わりにリムーブエリアに置く。」 — a discard is not the
    // card's own use, so each card's destination is decided here.
    for (const id of selected) (sidelineRedirectsToRemoval(s, id) ? s.players[target].removal : s.players[target].sideline).push(id);
    }
    const causeOwner = s.cards[f.sourceId]?.owner;
    for (const id of selected) logTurnEvent(s, 'discardedFromHand', target, id, causeOwner === undefined ? {} : { causeOwner, causeId: f.sourceId });
    // The same moment for the asked-for discard; the card itself rides along as the event's subject, and
    // the resolving effect's own source is the event's *cause* so a watcher written 「〈X〉の効果で…」 can
    // tell whose effect did it.
    for (const id of selected) ctx.queue.push(...collectTriggered(ctx, target, 'onDiscardedFromHand', id, id, { causeId: f.sourceId }));
    f.discardedCount = selected.length;
    f.didCount = selected.length;
    f.discardedIds = [...selected];
    if (e.type === 'payDiscard' && e.then?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(e.then));
    ctx.events.push({ type: 'effectDiscarded', data: { player: target, cards: selected } });
  } else if (e.type === 'discardSameEnergy') {
    // The same departure as an ordinary asked-for discard, so the log, the `onDiscardedFromHand`
    // watchers and the 「そうした場合」 counters all read it identically.
    p.hand = p.hand.filter(id => !selected.includes(id));
    // 「…以外でこのカードが場外に置かれる場合、代わりにリムーブエリアに置く。」 — a discard is not the
    // card's own use, so each card's destination is decided here.
    for (const id of selected) (sidelineRedirectsToRemoval(s, id) ? p.removal : p.sideline).push(id);
    const causeOwner = s.cards[f.sourceId]?.owner;
    for (const id of selected) logTurnEvent(s, 'discardedFromHand', f.player, id, causeOwner === undefined ? {} : { causeOwner, causeId: f.sourceId });
    for (const id of selected) ctx.queue.push(...collectTriggered(ctx, f.player, 'onDiscardedFromHand', id, id, { causeId: f.sourceId }));
    f.discardedCount = selected.length;
    f.didCount = selected.length;
    f.discardedIds = [...selected];
    ctx.events.push({ type: 'effectDiscarded', data: { player: f.player, cards: selected } });
  } else if (e.type === 'declare') {
    // The option is the number (or the trait name) itself, carried as a string by the decision channel.
    if (e.what === 'trait') {
      f.declared = { ...(f.declared ?? {}), ...(selected[0] !== undefined ? { trait: selected[0] } : {}) };
      ctx.events.push({ type: 'traitDeclared', data: { player: f.player, value: selected[0] ?? '' } });
    } else if (e.what === 'name') {
      f.declared = { ...(f.declared ?? {}), ...(selected[0] !== undefined ? { name: selected[0] } : {}) };
      ctx.events.push({ type: 'traitDeclared', data: { player: f.player, value: selected[0] ?? '' } });
    } else {
      f.declared = { ...(f.declared ?? {}), energyCount: Number(selected[0]) };
      ctx.events.push({ type: 'energyCountDeclared', data: { player: f.player, value: Number(selected[0]) } });
    }
    // 「…指定してもよい。そうした場合、…」 (DST-1-035/065) — a declaration is a result like any other,
    // which is what the following 「そうした場合」 gate reads. A declined declaration never reaches here.
    f.didCount = 1;
  } else if (e.type === 'chooseOption' && f.stage === 'chooseAllMode') {
    // The answer to the printed mode question: 「全て」 splices every branch in printed order (the same
    // shape the ordinary answer uses), 「1つ」 falls back to the ordinary single pick. The offer's budget is
    // spent either way — the chance was this chooser.
    const offer = p.purpleChooseAll;
    if (offer?.remaining !== undefined) {
      if (offer.remaining <= 1) delete p.purpleChooseAll;
      else p.purpleChooseAll = { ...offer, remaining: offer.remaining - 1 };
    }
    if (selected[0] === 'all') {
      // 「全て」 resolves every branch in printed order (Q1320/Q1324) — one splice of the whole
      // ordered block, since repeated same-position inserts would reverse it.
      const block = e.options.flatMap(option => structuredClone(option));
      if (block.length && e.entrySharedLimitKey) p.sharedLimitUsed = { ...(p.sharedLimitUsed ?? {}), [e.entrySharedLimitKey]: s.turn };
      // An offer whose every branch resolved to nothing did nothing (see the ordinary answer below).
      if (!block.length) { f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0; }
      f.steps.splice(f.index + 1, 0, ...block);
    } else {
      f.stage = 'option';
      f.selections ??= {};
      f.selections.__options = [];
      request(ctx, f, 'option', `从以下 ${e.options.length} 项中选择 1 项`, 1, 1, e.options.map((_, i) => String(i)));
      return;
    }
  } else if (e.type === 'chooseOption' && f.stage === 'paidChooseUpgrade') {
    // The answer to the watcher's price question (YYH-1-050). The offer is re-read here — the printed
    // 「してもよい」 prices what the board shows *now*: paying rests the holder and sends one face-down
    // card beneath it to 場外 (a real placing, so the same under-departure watchers fire), then the
    // chooser re-runs at the raised count. Anything else — a decline, or a price that stopped being
    // payable — falls back to the ordinary single pick.
    const upgrade = selected[0] === 'upgrade' ? paidChooseUpgradeOffer(s, f.player) : undefined;
    if (upgrade) {
      const owner = f.player;
      applyOperation(ctx, f, upgrade.holderId, 'rest');
      const here = findField(s, owner, upgrade.holderId);
      const hidden = here?.card.faceDown?.shift();
      if (hidden !== undefined) {
        s.players[s.cards[hidden]?.owner ?? owner].sideline.push(hidden);
        ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToSideline', upgrade.holderId, hidden));
        ctx.queue.push(...collectHiddenWatchers(ctx, s.cards[hidden]?.owner ?? owner, hidden));
      }
      f.steps.splice(f.index + 1, 0, { ...e, count: upgrade.count });
    } else {
      f.stage = 'option';
      f.selections ??= {};
      f.selections.__options = [];
      request(ctx, f, 'option', `从以下 ${e.options.length} 项中选择 1 项`, 1, 1, e.options.map((_, i) => String(i)));
      return;
    }
  } else if (e.type === 'chooseOption') {
    if (e.forbidRepeat) {
      const repeatKey = repeatKeyOf(e, f, s);
      const memory = (p.chosenOptionsThisTurn ??= {});
      const spent = selected.map(Number).filter(i => e.forbidRepeatOnly === undefined || e.forbidRepeatOnly.includes(i));
      memory[repeatKey] = [...(memory[repeatKey] ?? []), ...spent];
    }
    // The chosen branches resolve where the chooser sits, in printed order. Every instruction that follows
    // the chooser — the rest of the same sentence, a 「そうした場合、…」 gate — speaks about what the
    // chosen branch *did*, so it has to run after it; splicing each option at its own index instead put a
    // branch behind the instructions that follow the chooser whenever a non-first option was taken.
    // The whole ordered block goes in with a single splice: repeated same-position inserts would reverse
    // the branches (Q1092/Q1075/Q1476 — 「上にある効果から処理」).
    const picks = selected.map(Number).sort((a, b) => a - b);
    const block = picks.flatMap(index => structuredClone(e.options[index]!));
    if (block.length && e.entrySharedLimitKey) {
      const spent = p.sharedLimitUsed?.[e.entrySharedLimitKey];
      requireRule(spent === undefined || spent < s.turn, 'INVALID_CHOICE', '本回合已发动过该登场时效果。');
      p.sharedLimitUsed = { ...(p.sharedLimitUsed ?? {}), [e.entrySharedLimitKey]: s.turn };
    }
    // The chosen branch is what a following 「そうした場合」 asks about. An empty branch (「何もしない」)
    // resolves no instruction, so the records from the steps before the chooser must not keep standing
    // (KGD-1-070: taking the no-op branch still activated the deployed card).
    if (!block.length) { f.didCount = 0; f.gainedCount = 0; f.discardedCount = 0; }
    f.steps.splice(f.index + 1, 0, ...block);
  } else if (e.type === 'grantActivated' && f.stage === 'grantPick') {
    // The answer to the qualifying-ability pick (TKG-1-026's 「…を1つ得る」 with more donors than the
    // cap): the chosen abilities are copied onto the recorded targets, exactly as the unpicked branch
    // would have copied them.
    const pick = f.grantPick;
    delete f.grantPick;
    if (pick) {
      const chosen = selected.map(Number).filter(at => Number.isInteger(at) && at >= 0 && at < pick.abilities.length).slice(0, pick.max);
      if (chosen.length) {
        const abilities = chosen.map(at => pick.abilities[at]!);
        for (const target of pick.targets) {
          const here = findField(s, target.owner, target.cardId);
          if (!here) continue;
          const expiresTurn = expiryOf(ctx, f.player, pick.duration);
          (here.card.grantedActivated ??= []).push({ abilities: structuredClone(abilities), expiresTurn, ...(pick.donorId !== undefined ? { sourceId: pick.donorId } : {}) });
          ctx.events.push({ type: 'activatedGranted', data: { player: target.owner, cardId: target.cardId, expiresTurn, count: abilities.length } });
        }
      }
    }
  } else if (e.type === 'payAp' && f.stage === 'apCostSubstitute') {
    // The answer to the hand-card substitution (TKG-1-026): a chosen card pays the activation cost in
    // place of the AP — the AP row is untouched — while declining pays the AP exactly as the marked
    // step would have (availability was deliberately not checked when the offer was made, because the
    // substitution exists precisely for the activations the AP row cannot pay).
    if (selected.length) {
      p.hand = p.hand.filter(id => !selected.includes(id));
      p.sideline.push(...selected);
      ctx.events.push({ type: 'effectDiscarded', data: { player: f.player, cards: selected } });
      f.didCount = 1;
    } else {
      const available = p.ap.filter(a => a === 'active').length;
      if (available < e.count && !e.optional) requireRule(false, 'INSUFFICIENT_AP', '可用 AP 不足。');
      let remaining = Math.min(e.count, available);
      for (let i = 0; i < 3 && remaining > 0; i++) if (p.ap[i] === 'active') { p.ap[i] = 'rested'; remaining--; }
      logTurnEvent(s, 'apPaidByEffect', f.player, f.sourceId);
      ctx.events.push({ type: 'apSpent', data: { player: f.player, amount: e.count } });
      f.didCount = e.count;
    }
    if (e.then?.length) f.steps.splice(f.index + 1, 0, ...structuredClone(e.then));
  } else if (e.type === 'lookTop') {
    if (selected[0] === 'top') p.deck.unshift(...f.held); else p.deck.push(...f.held); noteDeckTop(p);
    f.held = [];
  } else if ((e.type === 'act' || e.type === 'actSource') && f.stage === 'moveFullLine') {
    const moving = f.selections?.__moveFull?.[0];
    if (f.selections) delete f.selections.__moveFull;
    const owner = moving === undefined ? undefined : s.cards[moving]?.owner;
    const movingFrom = owner === undefined || moving === undefined ? undefined : locate(s, owner, moving)?.line;
    const overflowLine = e.line ?? (movingFrom === undefined ? undefined : movingFrom === 'front' ? 'energy' : 'front');
    const candidates = owner === undefined || overflowLine === undefined ? [] : lineOverflowCandidates(s, f, owner, overflowLine, moving);
    for (const chosen of selected) {
      if (!candidates.includes(chosen)) continue;
      const chosenOwner = s.cards[chosen]?.owner;
      if (chosenOwner === undefined || !findField(s, chosenOwner, chosen)) continue;
      overflowRemoval(ctx, f, chosenOwner, chosen);
    }
    if (moving !== undefined && owner !== undefined) {
      const from = locate(s, owner, moving)?.line;
      const dest = e.line ?? (from === undefined ? undefined : (from === 'front' ? 'energy' : 'front'));
      if (from !== undefined && dest !== undefined && from !== dest && s.players[owner][dest].length < lineCapacity(s, owner, dest)) {
        effectLineMove(ctx, f, moving, owner, from, dest);
      }
    }
    // The same resumption the deploy handlers make: the ids parked behind this one re-enter in printed
    // order (each may ask its own full-line question), and the step's count lands once they are done.
    if (s.pending) return;
    drainParkedAct(ctx, f, e.operation, e.suppressOnPlay === true, e.line);
    if (s.pending) return;
    const parkedCount = e.type === 'act' ? (f.selections?.[e.target] ?? []).length : 1;
    f.didCount = parkedCount;
    if (e.type === 'act') recordSelectAct(f, e.target, parkedCount);
  } else if ((e.type === 'act' || e.type === 'actSource') && (f.stage === 'raidLine' || f.stage === 'raidFullLine')) {
    const full = f.stage === 'raidFullLine';
    const [raider, baseId, recorded] = f.selections?.__raid ?? [];
    if (f.selections) delete f.selections.__raid;
    const line = full ? recorded : selected[0];
    if (raider !== undefined && baseId !== undefined && (line === 'front' || line === 'energy')) {
      if (full) for (const id of selected) {
        const owner = s.cards[raider]?.owner ?? f.player;
        if (lineOverflowCandidates(s, f, owner, line, raider).includes(id)) overflowRemoval(ctx, f, owner, id);
      }
      resumeRaidOperation(ctx, f, e, raider, baseId, line);
    }
    if (s.pending) return;
    // Multiple raiders resume in printed order and each receives its own destination question.
    while (f.selections?.__actRest?.length) {
      const next = f.selections.__actRest.shift()!;
      if (!f.selections.__actRest.length) delete f.selections.__actRest;
      applyOperation(ctx, f, next, 'raid', undefined, e.line, undefined, undefined, undefined, undefined, e.baseBind, undefined, undefined, undefined, e.type === 'act' ? e.baseFromPeel : undefined, undefined, undefined, e.suppressOnPlay === true);
      if (s.pending) return;
    }
    const parkedCount = e.type === 'act' ? (f.selections?.[e.target] ?? []).length : 1;
    f.didCount = parkedCount;
    if (e.type === 'act') recordSelectAct(f, e.target, parkedCount);
  } else if ((e.type === 'act' || e.type === 'actSource') && f.stage === 'deployLine') {
    // The answer to the line question `case 'deploy'` raised: the placement re-enters with the
    // chosen line, which may itself raise the full-line question below.
    const [deployed, operation] = f.selections?.__deployLine ?? [];
    if (f.selections) delete f.selections.__deployLine;
    const chosenLine = selected[0];
    if (deployed !== undefined && (chosenLine === 'front' || chosenLine === 'energy')) {
      // The step's own `suppressOnPlay` rides the re-entry: the parked answer is the same placement.
      applyOperation(ctx, f, deployed, operation as CardOperation, undefined, chosenLine, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, e.suppressOnPlay === true);
    }
    if (s.pending) return;
    drainParkedAct(ctx, f, operation as CardOperation | undefined, e.suppressOnPlay === true);
    if (s.pending) return;
    const parkedCount = e.type === 'act' ? (f.selections?.[e.target] ?? []).length : 1;
    f.didCount = parkedCount;
    if (e.type === 'act') recordSelectAct(f, e.target, parkedCount);
  } else if ((e.type === 'act' || e.type === 'actSource') && f.stage === 'deployFullLine') {
    // The answer to the full-line question: the picked card goes to the removal area (the rules
    // procedure the print's 「1枚リムーブエリアに置き」 names, routed as the move reminder does), and
    // the placement completes onto the freed slot. Effect-removal protection does not stop this rule
    // procedure; rule redirects and the actual destination still determine this frame's records.
    const [deployed, operation, recorded] = f.selections?.__deployFull ?? [];
    if (f.selections) delete f.selections.__deployFull;
    const line = recorded === 'front' || recorded === 'energy' ? recorded : undefined;
    const deployOwner = deployed === undefined ? undefined : s.cards[deployed]?.owner;
    for (const chosen of selected) {
      if (deployOwner === undefined || line === undefined || !lineOverflowCandidates(s, f, deployOwner, line, deployed).includes(chosen)) continue;
      const chosenOwner = s.cards[chosen]?.owner;
      if (chosenOwner === undefined || !findField(s, chosenOwner, chosen)) continue;
      overflowRemoval(ctx, f, chosenOwner, chosen);
    }
    if (deployed !== undefined && deployOwner !== undefined && line !== undefined
      && s.players[deployOwner][line].length < lineCapacity(s, deployOwner, line)) {
      applyOperation(ctx, f, deployed, operation as CardOperation, undefined, line, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, e.suppressOnPlay === true);
    }
    if (s.pending) return;
    drainParkedAct(ctx, f, operation as CardOperation | undefined, e.suppressOnPlay === true);
    if (s.pending) return;
    const parkedCount = e.type === 'act' ? (f.selections?.[e.target] ?? []).length : 1;
    f.didCount = parkedCount;
    if (e.type === 'act') recordSelectAct(f, e.target, parkedCount);
  } else if (e.type === 'millTop' && f.stage === 'mill') {
    // Declining is the empty selection: the offered card is left where it is, which is the whole of what
    // 「…してもよい」 gives the player to decide here.
    if (selected.length) millOnto(ctx, f, e, scopePlayer(f.player, e.player));
  } else if ((e.type === 'draw' || e.type === 'drawTo') && f.stage === 'drawCount') {
    const count = Number(String(selected[0]).replace(/[^0-9]/g, ''));
    drawStep(ctx, f, e, count);
  } else if (e.type === 'millTop' && f.stage === 'millCount') {
    // The declared count is the answer (Q678: it was named before any card moved, and it is binding —
    // Q679/Q680). Exactly that many cards are placed; the declaration is what `gained`'s 「そうした
    // 場合」 gate then compares against the printed width, the same reading a short deck gets (Q686).
    const declared = Number(String(selected[0] ?? '').replace(/[^0-9]/g, ''));
    millOnto(ctx, f, e, scopePlayer(f.player, e.player), Number.isFinite(declared) ? declared : 0);
  } else if (e.type === 'discardedUnder' && f.stage === 'place') {
    // Same reading as the mill's: an empty selection leaves the card in 場外.
    if (selected.length) {
      const hostId = e.underBind !== undefined ? (f.selections?.[e.underBind] ?? [])[0] : f.sourceId;
      const host = hostId === undefined ? undefined : findField(s, f.player, hostId);
      const ids = underPlacementSubjects(s, f).filter(id => e.name === undefined || peekDefinition(s, id)?.name === e.name);
      if (host && ids.length) placeUnder(ctx, f, host.card, ids);
    }
  } else if (e.type === 'faceUpLife') {
    // 「自分のライフを1枚まで表向きにする。」 — the answers are slot ids of the form `life:N`; the flag
    // goes on the slot the print names. An empty answer is the optional spelling declining.
    const target = scopePlayer(f.player, e.who ?? 'self');
    const tp = s.players[target];
    const slots = selected.map(id => Number(id.slice('life:'.length))).filter(i => Number.isInteger(i) && i >= 0 && i < tp.life.length);
    for (const i of slots) {
      const flags = tp.life.map((_, index) => tp.lifeFaceUp?.[index] ?? false);
      flags[i] = true;
      tp.lifeFaceUp = flags;
    }
    if (slots.length) ctx.events.push({ type: 'lifeFacedUp', data: { player: target, slots, cards: slots.map(i => tp.life[i]!) } });
    f.didCount = slots.length;
  } else if (e.type === 'takeFaceUpTop') {
    // 「自分の山札の上に表向きのカードがある場合、そのカードを手札に加えてもよい。」 — the accepted
    // take; the card leaves the deck top, which is where its face-up mark lived.
    const top = f.selections?.__faceUpTop?.[0];
    if (top !== undefined && selected.includes(top)) {
      removeFromZone(s, f.player, top);
      p.hand.push(top);
      if (p.deckTopFaceUp === top) delete p.deckTopFaceUp;
      ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: [top] } });
      logRevealedToHand(ctx, [top]);
      f.gainedCount = 1; f.gainedIds = [top]; f.didCount = 1;
    } else {
      f.gainedCount = 0; f.didCount = 0;
    }
    delete f.selections?.__faceUpTop;
  } else if (e.type === 'search' || e.type === 'lookReveal') {
    const rest = e.type === 'lookReveal' ? e.rest : 'bottom';
    // The deck the look is about — the opponent's for 「相手は自身の山札の上から1枚を公開する」.
    const deckP = e.type === 'lookReveal' && e.player === 'opponent' ? s.players[otherOf(f.player)] : p;
    /**
     * Where the cards nobody took go. Shared by the single-take path and by the second pick of
     * 「…を1枚まで自分の場にレストで登場させ、1枚を手札に加え、残りを…」, so both end the look the same way.
     */
    const placeRemainder = (): boolean => {
      if (e.type === 'lookReveal' && e.from === 'under') {
        // The cards were lifted out of the stack when the look began; the untaken ones go back under the
        // character, in the order they were looked at. A host that has since left the field has no stack
        // to return to: the cards came back out of 場外 (the filed-stack fallback above), and that is
        // where the untaken ones stay.
        const host = findField(s, f.player, f.sourceId);
        if (f.held.length) {
          if (host) (host.card.faceDown ??= []).push(...f.held);
          else s.players[f.player].sideline.push(...f.held);
        }
        f.held = [];
        return false;
      }
      if (!f.held.length) return false;
      if (rest === 'sideline') {
        f.discardedIds = [...f.held];
        f.didCount = f.held.length;
        p.sideline.push(...f.held);
        // 「自分の山札から場外に置かれた時」 — a look over a host's hidden stack is not 「山札から」.
        if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, f.held, f.sourceId);
        f.held = [];
        return false;
      }
      if (rest === 'top') { deckP.deck.unshift(...f.held); noteDeckTop(deckP); f.held = []; return false; }
      if (rest === 'removal') {
        // 「残りをリムーブエリアに置く」 — the same frame record the main path writes, so both spellings
        // of the remainder agree. The per-card redirect and the deck→場外 watcher match the `sideline`
        // branch above (「使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く。」).
        const aside: CardId[] = [];
        for (const id of f.held) {
          if (removalRedirectsToSideline(s, id, f.sourceId)) { p.sideline.push(id); aside.push(id); continue; }
          p.removal.push(id);
          (f.removedIds ??= []).push(id);
        }
        if (aside.length) {
          f.discardedIds = [...(f.discardedIds ?? []), ...aside];
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, aside, f.sourceId);
        }
        f.held = [];
        return false;
      }
      // The `topOrUnder` / `topOrRemoval` destinations are asked at the tail of the look itself, not here
      // (a take path never prints them); should the ask be skipped, the cards keep their looked order on top.
      if (rest === 'topOrUnder' || rest === 'topOrRemoval') { deckP.deck.unshift(...f.held); noteDeckTop(deckP); f.held = []; return false; }
      if (rest === 'topOrSideline') {
        f.stage = 'placeTopSideline';
        request(ctx, f, 'cards', '0 = 放回牌库顶，1 = 置于场外', 1, 1, ['0', '1']);
        return true;
      }
      // 「残りを自分の山札の上か下に置く」 (KMR-1-053) — the destination itself is the question. Unlike
      // the pair above this *is* printed behind takes, so the ask lands here, over what the picks left.
      if (rest === 'topOrBottom') {
        f.gainedCount = 0;
        f.stage = 'faceUpTopBottom';
        request(ctx, f, 'topBottom', '把剩余卡放到牌库顶还是牌库底', 1, 1, ['top', 'bottom']);
        return true;
      }
      request(ctx, f, 'order', lookOrderPrompt(rest), f.held.length, f.held.length, f.held);
      return true;
    };
    const finishPrimaryTake = (selected: CardId[], takeMode: string): boolean => {
      if (selected.length) ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: selected, ...(takeMode === 'hand' ? {} : { to: takeMode }) } });

      // A *second* pick from what the first one left, before the remainder is placed. It is asked even
      // when the pool it reads is empty (round-124 ②): the printed pick is a step the player sees, with
      // the confirm standing in for the vanished offer.
      if (e.type === 'lookReveal' && e.secondTake) {
        if (takeMode === 'sideline' && e.secondTake.to !== 'under') {
          // The subsequent hand-gain condition refers only to the hand pick, not the aside pick.
          f.gainedCount = 0; f.gainedIds = []; f.didCount = 0; f.discardedCount = 0;
        }
        const second = f.held.filter(id => matchesFilter(s, id, e.secondTake!.filter, f.sourceId, undefined, true));
        const secondMax = Math.min(e.secondTake.max, second.length);
        // The printed floor: the deploy-then-hand spellings let this pick be declined, while the
        // 「…1枚を裏向きで…の下に置き」 spelling (KMR-1-053) mandates it. Never more than what is there.
        const secondMin = Math.min(e.secondTake.min ?? 0, secondMax);
        f.stage = 'take2';
        request(ctx, f, 'cards', second.length
          ? (e.secondTake.to === 'under'
            ? `从剩余的 ${f.held.length} 张中选 ${secondMin === secondMax ? secondMin : `${secondMin}~${secondMax}`} 张背面朝下置于该角色下方`
            : `从剩余的 ${f.held.length} 张中再选至多 ${secondMax} 张加入手牌（可不选）`)
          : `从剩余的 ${f.held.length} 张中：无可选卡，点击确认继续`, secondMin, secondMax, second);
        return true;
      }
      // 「その中から〈A〉と〈B〉をそれぞれ1枚まで」 — the groups ask *after* the primary take, each over
      // what the earlier picks left (a look whose primary take is empty opens group 0 here too).
      if (e.type === 'lookReveal' && e.takeGroups?.length) {
        f.takeGroupIndex = 0;
        if (requestTakeGroup(ctx, f, e)) return true;
      }
      f.stage = 'bottom';
      if (placeRemainder()) return true;
      return false;
    };
    const continuePlainDeploy = (): boolean => {
      const pendingIds = f.selections?.__takeDeployRest ?? [];
      const rested = e.type === 'lookReveal' && e.take === 'deployRested';
      while (pendingIds.length) {
        const id = pendingIds.shift()!;
        if (deployTakenAskingLine(ctx, f, id, rested, e.type === 'lookReveal' ? e.takeLine : undefined)) return true;
        f.held = f.held.filter(h => h !== id);
      }
      if (f.selections) delete f.selections.__takeDeployRest;
      return finishPrimaryTake(f.selections?.A ?? [], rested ? 'deployRested' : 'deploy');
    };
    // 「手札に加える代わりに…してもよい」 — the print's own default when the replacement is declined (or the
    // picked card fails the printed gates): the revealed card joins the hand, and a public take raises the
    // deck→hand arrival the plain take does (the deck-reveal watchers fire with the pick itself).
    const replacementToHand = (ids: CardId[]): void => {
      p.hand.push(...ids);
      f.gainedCount = ids.length;
      f.gainedIds = [...ids];
      f.didCount = ids.length;
      logRevealedToHand(ctx, ids);
      if (e.type === 'lookReveal' && e.reveal && ids.length) queueDeckToHand(ctx, ids, f.sourceId);
      f.held = f.held.filter(id => !ids.includes(id));
    };
    // The arrival leg of 「登場させるかレイドさせる」 for the picked card: ask deploy-or-RAID when a base
    // accepts it, otherwise it simply arrives. Returns true while a question is open.
    const startDeployOrRaid = (ids: CardId[]): boolean => {
      const takeRested = e.type === 'lookReveal' && e.take === 'deployRestedOrRaid';
      const raider = ids[0]!;
      const bases = fields(s, f.player).filter(c => c.cardId !== raider && raidBaseEligible(s, f.player, raider, c.cardId));
      if (bases.length) {
        f.stage = 'takeMode';
        request(ctx, f, 'cards', '选择放置方式：0 = 登场，1 = RAID', 1, 1, ['0', '1']);
        return true;
      }
      // No base qualifies, so the raid leg does not exist and the card simply 登場s. The rest of the
      // selection (the printed form caps it at one) is deployed the same way.
      for (const id of ids) {
        if (deployTakenAskingLine(ctx, f, id, takeRested, e.type === 'lookReveal' ? e.takeLine : undefined)) return true;
        f.held = f.held.filter(h => h !== id);
      }
      return false;
    };
    if (f.stage === 'lookOptional') {
      // 「…見てもよい」 — the accepted look re-enters the same step (nothing was lifted before the
      // question, so the deck is untouched on either answer). The shared tail below advances the index
      // and resumes the loop; returning early here would leave the frame open with no pending decision.
      if (selected[0] === '1') { f.lookConfirmed = true; f.steps.splice(f.index + 1, 0, structuredClone(e)); }
      else f.gainedCount = 0;
    }
    if (f.stage === 'faceUpTopBottom') {
      // 「…山札の上か下に置く。上に置いた場合、そのカードを表向きにする。」 — the answer to the
      // destination question. Only the card that lands on *top* is turned face-up, and only the topmost
      // of a multiple set can be the deck's public top; the plain 「上か下」 spelling (rest `topOrBottom`)
      // asks the same question without the reveal rider.
      if (selected[0] === 'top') {
        deckP.deck.unshift(...f.held); noteDeckTop(deckP);
        if (e.type === 'lookReveal' && e.rest === 'topBottomFaceUp' && f.held[0] !== undefined) deckP.deckTopFaceUp = f.held[0];
      } else deckP.deck.push(...f.held);
      f.held = [];
      f.gainedCount = 0;
    } else if (f.stage === 'placeTopUnder') {
      // 「山札の上に置くか、裏向きで自分の場の〈X〉1枚の下に置く」 — the remainder's destination is the
      // player's choice: 0 puts it back on top, 1 offers the characters the printed filter admits (an
      // empty list keeps the cards on top, the same reading the engine gives a choice with no answers).
      if (selected[0] === '1') {
        const hosts = fields(s, f.player).filter(c => matchesFilter(s, c.cardId, e.type === 'lookReveal' ? e.underHostFilter : undefined, f.sourceId));
        if (hosts.length) {
          f.stage = 'placeHost';
          request(ctx, f, 'cards', '选择放置卡下的角色', 1, 1, hosts.map(c => c.cardId));
          return;
        }
      }
      f.stage = 'bottom';
      deckP.deck.unshift(...f.held); noteDeckTop(deckP);
      f.held = [];
      f.gainedCount = 0;
    } else if (f.stage === 'placeTopRemoval') {
      // 「山札の上かリムーブエリアに置く」 — the answer to the destination question: 1 sends the looked
      // cards to the removal area (recorded on the frame, as every removal route is); anything else puts
      // them back on the deck's top in the order they were looked at. The per-card redirect and the
      // deck→場外 watcher match the `sideline` remainder branch.
      if (selected[0] === '1') {
        const aside: CardId[] = [];
        for (const id of f.held) {
          if (removalRedirectsToSideline(s, id, f.sourceId)) { p.sideline.push(id); aside.push(id); continue; }
          p.removal.push(id);
          (f.removedIds ??= []).push(id);
        }
        if (aside.length) {
          f.discardedIds = [...(f.discardedIds ?? []), ...aside];
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, aside, f.sourceId);
        }
      } else {
        deckP.deck.unshift(...f.held); noteDeckTop(deckP);
      }
      f.held = [];
      f.gainedCount = 0;
      f.stage = 'bottom';
    } else if (f.stage === 'placeTopSideline') {
      // 「山札の上か場外に置く」 — 1 files the looked cards to 場外 (the same records the sideline
      // remainder branch writes); anything else restores the looked order on the deck's top.
      if (selected[0] === '1') {
        p.sideline.push(...f.held);
        f.discardedIds = [...(f.discardedIds ?? []), ...f.held];
        if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, f.held, f.sourceId);
      } else {
        deckP.deck.unshift(...f.held); noteDeckTop(deckP);
      }
      f.held = [];
      f.gainedCount = 0;
      f.stage = 'bottom';
    } else if (f.stage === 'placeTopSidelineOpp') {
      // 「…公開されたカードを相手の山札の上か場外に置く」 — both destinations belong to the *opponent*:
      // 1 files the looked cards to the opponent's 場外 (the 「自分の山札から場外に置かれた時」 watchers
      // and the turn log are the opponent's, because the card came out of their deck), anything else
      // restores the looked order on the opponent's deck's top.
      const foe = s.players[otherOf(f.player)];
      if (selected[0] === '1') {
        foe.sideline.push(...f.held);
        f.discardedIds = [...(f.discardedIds ?? []), ...f.held];
        if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, otherOf(f.player), f.held, f.sourceId);
      } else {
        foe.deck.unshift(...f.held); noteDeckTop(foe);
      }
      f.held = [];
      f.gainedCount = 0;
      f.stage = 'bottom';
    } else if (f.stage === 'placeHost') {
      const host = selected[0] !== undefined ? fields(s, f.player).find(c => c.cardId === selected[0]) : undefined;
      if (host && f.held.length) (host.faceDown ??= []).push(...f.held);
      else deckP.deck.unshift(...f.held); noteDeckTop(deckP);
      f.held = [];
      f.gainedCount = 0;
      f.stage = 'bottom';
    } else if (f.stage === 'takeReplace') {
      // The answer to 「…に代えてもよい」: 1 swaps the base take for the printed arrival, 0 keeps the base take
      // (the revealed card joins the hand). The card stayed in `held` while the question was open.
      const picked = f.selections?.A ?? [];
      if (selected[0] !== '1') {
        replacementToHand(picked);
        if (finishPrimaryTake(picked, 'hand')) return;
      } else if (e.type === 'lookReveal' && (e.take === 'deployOrRaid' || e.take === 'deployRestedOrRaid')) {
        if (startDeployOrRaid(picked)) return;
        f.stage = 'bottom';
        if (placeRemainder()) return;
      } else {
        f.selections ??= {};
        f.selections.__takeDeployRest = [...picked];
        if (continuePlainDeploy()) return;
        f.index++; f.stage = 'step'; runEffects(ctx); return;
      }
    } else if (f.stage === 'takeMode') {
      // 「…を1枚まで公開し手札に加えるか、場外に置く」 — the destination question for a looked take. One
      // answer governs the whole pick; the cards stayed in `held` while it was open, so they are in no
      // zone until this resolves.
      if (e.type === 'lookReveal' && e.take === 'handOrSideline') {
        const chosen = f.selections?.A ?? [];
        if (selected[0] === '0') {
          p.hand.push(...chosen);
          f.gainedCount = chosen.length; f.gainedIds = [...chosen]; f.didCount = chosen.length;
          if (e.reveal && e.from !== 'under' && chosen.length) queueRevealedFromDeck(ctx, chosen);
          ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: chosen } });
        } else {
          p.sideline.push(...chosen);
          // 「この効果で場外に置いたカード」 reads which cards went aside, the same record the ordinary
          // 場外 take writes.
          f.discardedIds = [...chosen];
          f.gainedCount = 0; f.gainedIds = [];
          if (e.from !== 'under') noteDeckToSideline(ctx, f.player, chosen, f.sourceId);
        }
        f.held = f.held.filter(id => !chosen.includes(id));
        f.stage = 'bottom';
        if (placeRemainder()) return;
        return;
      }
      // 「…登場させるかレイドさせる」 — how the held card arrives. 0 deploys it; 1 offers the bases its
      // printed RAID condition accepts (the same eligibility the running RAID action uses).
      const raider = (f.selections?.A ?? [])[0];
      const rested = e.type === 'lookReveal' && e.take === 'deployRestedOrRaid';
      if (selected[0] === '1' && raider !== undefined) {
        const bases = fields(s, f.player).filter(c => c.cardId !== raider && raidBaseEligible(s, f.player, raider, c.cardId));
        if (bases.length) {
          f.stage = 'takeBase';
          request(ctx, f, 'cards', '选择 RAID 基底', 1, 1, bases.map(c => c.cardId));
          return;
        }
      }
      if (raider !== undefined) {
        if (deployTakenAskingLine(ctx, f, raider, rested, e.type === 'lookReveal' ? e.takeLine : undefined)) return;
        f.held = f.held.filter(id => id !== raider);
      }
      f.stage = 'bottom';
      if (placeRemainder()) return;
    } else if (f.stage === 'takeUseLine' || f.stage === 'takeUseFullLine') {
      const full = f.stage === 'takeUseFullLine';
      const [parked, storedLine] = f.selections?.__takeUse ?? [];
      if (f.selections) delete f.selections.__takeUse;
      const line = (full ? storedLine : selected[0]) === 'energy' ? 'energy' : 'front';
      if (parked !== undefined) {
        if (full) for (const id of selected) if (lineOverflowCandidates(s, f, f.player, line, parked).includes(id)) overflowRemoval(ctx, f, f.player, id);
        if (useTakenWithSpace(ctx, f, parked, line, full)) return;
        f.held = f.held.filter(id => id !== parked);
        f.gainedCount = 0; f.gainedIds = [];
        ctx.events.push({ type: 'cardsUsedFree', data: { player: f.player, cards: [parked] } });
        if (finishPrimaryTake([parked], 'use')) return;
      }
    } else if (f.stage === 'takeDeployLine' || f.stage === 'takeDeployFullLine') {
      const full = f.stage === 'takeDeployFullLine';
      const [parked, mode, storedLine] = f.selections?.__takeDeploy ?? [];
      if (f.selections) delete f.selections.__takeDeploy;
      const line = full ? (storedLine === 'energy' ? 'energy' : 'front') : (selected[0] === 'energy' ? 'energy' : 'front');
      if (parked !== undefined) {
        if (full) {
          for (const id of selected) if (lineOverflowCandidates(s, f, f.player, line, parked).includes(id)) overflowRemoval(ctx, f, f.player, id);
          deployTaken(ctx, f, parked, mode === 'rested', line);
        } else if (deployTakenWithSpace(ctx, f, parked, mode === 'rested', line)) return;
        f.held = f.held.filter(h => h !== parked);
      }
      if (e.type === 'lookReveal' && (e.take === 'deploy' || e.take === 'deployRested')) {
        if (continuePlainDeploy()) return;
      } else {
        f.stage = 'bottom';
        if (placeRemainder()) return;
      }
    } else if (f.stage === 'takeBase') {
      const raider = (f.selections?.A ?? [])[0];
      if (raider !== undefined && selected.length) {
        if (raidTaken(ctx, f, raider, selected[0]!)) return;
        f.held = f.held.filter(id => id !== raider);
      }
      f.stage = 'bottom';
      if (placeRemainder()) return;
    } else if (f.stage === 'takeRaidLine' || f.stage === 'takeRaidFullLine') {
      const full = f.stage === 'takeRaidFullLine';
      const [raider, baseId, recorded] = f.selections?.__raid ?? [];
      if (f.selections) delete f.selections.__raid;
      const line = full ? recorded : selected[0];
      if (raider !== undefined && baseId !== undefined && (line === 'front' || line === 'energy')) {
        if (full) for (const id of selected) if (lineOverflowCandidates(s, f, f.player, line, raider).includes(id)) overflowRemoval(ctx, f, f.player, id);
        if (raidTaken(ctx, f, raider, baseId, line)) return;
        f.held = f.held.filter(id => id !== raider);
      }
      f.stage = 'bottom';
      if (placeRemainder()) return;
    } else if (f.stage === 'take2') {
      // 「…を1枚まで自分の場にレストで登場させ、**1枚を手札に加え**、残りを望む順で山札の下に置く」 —
      // the second pick, answered before the remainder is placed so the card it takes is not counted
      // among them. Adding to hand is the default destination; the 「…1枚を裏向きで自分の場の
      // ［特徴：ドクター］の下に置き」 spelling (KMR-1-053) tucks the pick face down under the effect
      // source instead — the same host rule `take: 'under'` uses, and nothing was "added to hand", so
      // the gained records stay at the first pick's.
      if (selected.length) {
        if (e.type === 'lookReveal' && e.secondTake?.to === 'under') {
          const host = findField(s, f.player, f.sourceId);
          if (host) (host.card.faceDown ??= []).push(...selected);
          else p.sideline.push(...selected);
          ctx.events.push({ type: 'cardPlacedUnder', data: { player: f.player, cards: selected } });
        } else {
          p.hand.push(...selected);
          f.gainedCount = (f.gainedCount ?? 0) + selected.length;
          f.gainedIds = [...(f.gainedIds ?? []), ...selected];
          f.didCount = (f.didCount ?? 0) + selected.length;
          ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: selected } });
          logRevealedToHand(ctx, selected);
          if (e.type === 'lookReveal' && e.reveal && e.from !== 'under') {
            queueRevealedFromDeck(ctx, selected);
            queueDeckToHand(ctx, selected, f.sourceId);
          }
          // The second pick off a hidden-stack look is the same under→hand moment (DST-1-074's watcher
          // must see it whichever take path the effect used).
          if (e.type === 'lookReveal' && e.from === 'under') for (const id of selected) ctx.queue.push(...collectTriggered(ctx, f.player, 'onUnderToHand', f.sourceId, id));
        }
      }
      f.held = f.held.filter(id => !selected.includes(id));
      f.stage = 'bottom';
      if (placeRemainder()) return;
    } else if (f.stage === 'take') {
      f.taken = selected.length; f.gainedCount = selected.length; f.didCount = selected.length;
      // 「公開したカードが［特徴：柱］の場合」 (KMY-1-030) — the *public* card a follow-up speaks about is
      // the one this take revealed by taking it (Q1688/OPM-1-020's corrected texts read 「公開したカード」
      // as the card 「1枚公開し手札に加える」 moved); the whole looked set only while it is still being
      // looked at. A declined take leaves nothing 公開した (Q296), so the record narrows to the pick.
      f.revealedIds = [...selected];
      const takeMode = e.type === 'lookReveal' ? e.take ?? 'hand' : 'hand';
      // The identities, not just the count: 「〈X〉を手札に加えた場合」 and 「〈X〉以外を…」 ask *which* card
      // arrived. Recorded before the destination is decided, because 「場外に置く」 take-aside cards are
      // not "added to hand" and must not satisfy the discriminator either way.
      f.gainedIds = takeMode === 'hand' ? [...selected] : [];
      // A 「公開し」 take announces its reveal at the destination branch below — the one that also
      // excludes a card diverted to 場外 by the printed redirect — so the reveal fires exactly once.
      if (takeMode === 'under') {
        // 「…を裏向きでこのフィールドの下に置く」 — the looked card goes face down under the effect
        // source. Nothing was "added to hand", so the discriminators stay at zero.
        const host = findField(s, f.player, f.sourceId);
        if (host) (host.card.faceDown ??= []).push(...selected);
        else p.sideline.push(...selected);
        f.gainedCount = 0;
        f.gainedIds = [];
        ctx.events.push({ type: 'cardPlacedUnder', data: { player: f.player, cards: selected } });
      } else if (takeMode === 'top') {
        // 「…を公開し自分の山札の上か場外に置く」 — the print offers "top of deck or 場外"; the
        // pool-wide reading of this choice keeps the card on top (the same reading the 1-card
        // 「…を見る。そのカードを山札の上か場外に置く」 family has always used), preserving the
        // order the cards were chosen in.
        deckP.deck.unshift(...selected); noteDeckTop(deckP);
        f.gainedCount = 0;
        f.gainedIds = [];
      } else if (takeMode === 'deployOrRaid' || takeMode === 'deployRestedOrRaid') {
        // 「…を自分の場に[レストで]登場させるかレイドさせる」 — from a looked card. The card stays in
        // `held` (it is in no zone) so the conservation invariant holds while the follow-up questions are
        // open; the raid leg cannot reuse the `raid` operation's hand/sideline sourcing, so the flow is
        // staged instead: ask how it arrives, then — for a raid — which base.
        f.selections ??= {};
        f.selections.A = [...selected];
        f.gainedCount = 0;
        // 「公開したカードが消費APが1のキャラカードで必要エナジーを満たす場合、手札に加える代わりに…」 —
        // the replacement is only offered while the picked card passes the printed gates; a card that
        // fails them is taken to hand the ordinary way (the print's own default). The gates read the
        // first (and only) picked card.
        // The print reveals the picked card ahead of either destination, so both legs announce it.
        if (e.type === 'lookReveal' && e.reveal && selected.length) queueRevealedFromDeck(ctx, selected);
        if (e.type === 'lookReveal' && selected.length && takeGateFails(s, f, e, selected[0]!)) {
          replacementToHand(selected);
          if (finishPrimaryTake(selected, 'hand')) return;
        } else if (e.type === 'lookReveal' && selected.length && takeReplacementIsOptional(e)) {
          // 「…代わりに…登場させるかレイドさせてもよい」 — the arrival is the player's option; declining keeps
          // the printed default (the card joins the hand).
          f.stage = 'takeReplace';
          request(ctx, f, 'option', '是否改为登场（RAID）代替加入手牌？0 = 仍加入手牌，1 = 改为登场（RAID）', 1, 1, ['0', '1']);
          return;
        } else if (selected.length) {
          if (startDeployOrRaid(selected)) return;
        }
      } else if (takeMode === 'use') {
        // 「…を公開し『APを支払わずに使用する』に代えてもよい」 (SYN-1-102) — the printed 公開 covers
        // this branch too: the hand leg announces its own at the destination branch below, and
        // without this the used card's reveal was never announced: its deck-reveal watchers (and
        // the turn's reveal log that 「山札から公開された時」-style conditions read) stayed silent.
        if (e.type === 'lookReveal' && e.reveal && selected.length) queueRevealedFromDeck(ctx, selected);
        // 「…をAPを支払わずに使用する」 — the looked card is *used* as if played: a character enters the
        // chosen legal line, an event resolves and goes to the sideline, a field goes to the energy line. Its
        // own onPlay runs as a queued task (with the looked card as the source, so 「このカード」 speaks
        // about the right card). Nothing is paid, and the turn log records the use as free — which is
        // exactly what 「APを支払わずに使用している」 reads back.
        const queued: EffectTask[] = [];
        for (const id of selected) {
          const definition = peekDefinition(s, id);
          if (!definition) continue;
          // `usedFrom: 'deck'` — the use started from the deck, which 「山札から使用されている場合」
          // (SYN-1-032) and 「このターン中に自分が山札からカードを使用している場合」 (SYN-1-015) read
          // back. The free flag stays for the 「APを支払わずに使用している」 spelling.
          logTurnEvent(s, 'used', f.player, id, { free: true, usedFrom: 'deck' });
          if (definition.kind === 'event') {
            p.sideline.push(id);
            if (definition.onPlay?.length) queued.push(makeEntryTask(s, f.player, id, placedEntrySteps(s, f.player, definition)));
          } else {
            if (useTakenAskingLine(ctx, f, id)) return;
          }
        }
        if (queued.length) setQueue(f, [...queued, ...(f.queue?.effects ?? [])]);
        f.gainedCount = 0;
        f.gainedIds = [];
        ctx.events.push({ type: 'cardsUsedFree', data: { player: f.player, cards: selected } });
      } else if (takeMode === 'handOrSideline') {
        // 「…を1枚まで公開し手札に加えるか、場外に置く」 — the printed either/or between the hand and the
        // discard pile. The cards stay in `held` (they are in no zone) while the question is open.
        f.selections ??= {};
        f.selections.A = [...selected];
        f.gainedCount = 0; f.gainedIds = [];
        f.stage = 'takeMode';
        request(ctx, f, 'option', '0 = 加入手牌，1 = 送至场外', 1, 1, ['0', '1']);
        return;
      } else if (takeMode === 'topOrSideline') {
        // 「…1枚まで公開し自分の山札の上か場外に置く」 (JJK-2-005) — the printed either/or between the
        // deck top and 場外, asked after the pick. The card stays in `held` (it is in no zone) while the
        // question is open; the answer writes the same records its `top` / `sideline` siblings write.
        if (selected.length) {
          f.selections ??= {};
          f.selections.A = [...selected];
          f.gainedCount = 0; f.gainedIds = [];
          f.stage = 'takeTopSideline';
          request(ctx, f, 'cards', '0 = 放回牌库顶，1 = 置于场外', 1, 1, ['0', '1']);
          return;
        }
        // A declined pick has no destination to ask about; the common tail places the remainder.
      } else if (takeMode === 'deploy' || takeMode === 'deployRested') {
        // 「選ばれたカードを公開し、…」 (KIN-1-038) — where the print reveals the picked card ahead of
        // either destination, the public moment fires here too: the hand leg below already announces its
        // own, and the 登場 leg announced nothing until now.
        if (e.type === 'lookReveal' && e.reveal && selected.length) queueRevealedFromDeck(ctx, selected);
        if (e.type === 'lookReveal' && selected.length && takeGateFails(s, f, e, selected[0]!)) {
          replacementToHand(selected);
          if (finishPrimaryTake(selected, 'hand')) return;
        } else if (e.type === 'lookReveal' && selected.length && takeReplacementIsOptional(e)) {
          // 「…に代えてもよい」 — declining the replacement keeps the base take (the card joins the hand).
          f.selections ??= {};
          f.selections.A = [...selected];
          f.stage = 'takeReplace';
          request(ctx, f, 'option', '是否改为登场（RAID）代替加入手牌？0 = 仍加入手牌，1 = 改为登场（RAID）', 1, 1, ['0', '1']);
          return;
        } else {
          // 「…を自分の場に[レストで]登場させる」 — the looked card enters the field rather than the hand.
          // The chosen cards are bound to `A` so a following 「登場させたキャラをアクティブにする」 has
          // something to name, which is the only handle the printed wording gives.
          f.selections ??= {};
          f.selections.A = [...selected];
          f.gainedCount = 0;
          // 「…を1枚まで自分のエナジーLにレストで登場させる。」 (MGS-1-015) — the printed arrival line.
          f.selections.__takeDeployRest = [...selected];
          if (continuePlainDeploy()) return;
          f.index++; f.stage = 'step'; runEffects(ctx); return;
        }
      } else {
        // 「相手は…公開し手札に加えてもよい」 — a take from the *opponent's* deck joins the opponent's own
        // hand, not the effect controller's; every other destination keeps its usual owner. 「…を1枚まで
        // リムーブエリアに置く」 takes the card aside to the removal area instead.
        if (takeMode === 'removal') {
          p.removal.push(...selected);
          f.removedIds = [...(f.removedIds ?? []), ...selected];
          f.gainedCount = 0;
          f.gainedIds = [];
        }
        // 「公開したカードがイベントカードの場合、『場外に置く』に代わる。」 (OPM-1-020) — a picked card
        // the printed filter names reaches 場外 instead of the hand; the arrival records split with it, so
        // 「手札に加えた場合」 (and a `discardAfterTake` gated on it) sees only the cards that did arrive.
        const diverted = takeMode === 'hand' && e.type === 'lookReveal' && e.takeToSidelineIf !== undefined
          ? selected.filter(id => matchesFilter(s, id, e.takeToSidelineIf!, f.sourceId))
          : [];
        if (diverted.length) {
          p.sideline.push(...diverted);
          f.discardedIds = [...(f.discardedIds ?? []), ...diverted];
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, diverted, f.sourceId);
          const arrived = selected.filter(id => !diverted.includes(id));
          f.gainedCount = arrived.length;
          f.gainedIds = [...arrived];
        }
        const toHand = diverted.length ? selected.filter(id => !diverted.includes(id)) : selected;
        const destination = takeMode === 'sideline' ? p.sideline
          : e.type === 'lookReveal' && e.player === 'opponent' ? s.players[otherOf(f.player)].hand : p.hand;
        if (takeMode !== 'removal') destination.push(...toHand);
        // 「この効果で場外に置いたカードに…がある場合」 reads which cards went aside, so the identities
        // are recorded the same way a discard's are.
        if (takeMode === 'sideline') f.discardedIds = [...selected];
        // 「自分の山札から場外に置かれた時」 — a taken card that went to 場外 came from the deck (unless
        // the look was over a host's hidden stack, which is not 「山札から」).
        if (takeMode === 'sideline' && e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, selected, f.sourceId);
        if (takeMode === 'hand' && e.type === 'lookReveal' && e.reveal && e.from !== 'under' && toHand.length) {
          queueRevealedFromDeck(ctx, toHand);
          // 「公開され、手札に加わった時」 (KGR-1-041) — the arrival half, raised where the card lands.
          queueDeckToHand(ctx, toHand, f.sourceId);
        }
        // 「このキャラの下の裏向きのカードを見て、…手札に加える」 — a take whose pile was a hidden stack
        // (the look lifted it out of the host) raises the same moment the dedicated `takeUnder` operation
        // does; the host is the look's own source, which is where the stack was read from.
        if (takeMode === 'hand' && e.type === 'lookReveal' && e.from === 'under') {
          for (const id of toHand) ctx.queue.push(...collectTriggered(ctx, f.player, 'onUnderToHand', f.sourceId, id));
        }
      }
      f.held = f.held.filter(id => !selected.includes(id));
      if (finishPrimaryTake(selected, takeMode)) return;
    } else if (f.stage === 'takeTopSideline') {
      // 「…1枚まで公開し自分の山札の上か場外に置く」 (JJK-2-005) — the answer to the destination
      // question: 0 puts the picked card back on its *owner's* deck top, 1 files it to its owner's 場外.
      // Both zones follow the card's owner (the deck the take lifted from), so a take out of a looked
      // deck stays with that deck's player. `finishPrimaryTake` receives the real destination, so the
      // public take log names 牌库顶 / 場外 instead of the generic hand wording.
      const chosen = f.selections?.A ?? [];
      const owner = chosen.length ? s.cards[chosen[0]!]?.owner ?? f.player : f.player;
      const dest = selected[0] === '1' ? 'sideline' : 'top';
      if (chosen.length) {
        if (dest === 'sideline') {
          s.players[owner].sideline.push(...chosen);
          f.discardedIds = [...(f.discardedIds ?? []), ...chosen];
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, owner, chosen, f.sourceId);
        } else {
          s.players[owner].deck.unshift(...chosen); noteDeckTop(s.players[owner]);
        }
      }
      if (f.selections) delete f.selections.A;
      f.held = f.held.filter(id => !chosen.includes(id));
      f.gainedCount = 0; f.gainedIds = [];
      if (finishPrimaryTake(chosen, dest)) return;
    } else if (e.type === 'lookReveal' && f.stage === 'takeGroup') {
      // 「その中から〈A〉と〈B〉をそれぞれ1枚まで…」 — one group's pick. The taken cards join the hand
      // exactly as the primary take's do; the next group then asks over what this one left. The sideline
      // spelling (「…をそれぞれ1枚まで場外に置き」) sends them to 場外 instead, recorded on the frame so
      // 「この効果で場外に置いた…1枚につき」 sees them.
      if (selected.length) {
        if (e.takeGroupsTo === 'sideline') {
          p.sideline.push(...selected);
          f.discardedIds = [...(f.discardedIds ?? []), ...selected];
        } else {
          p.hand.push(...selected);
          f.gainedCount = (f.gainedCount ?? 0) + selected.length;
          f.gainedIds = [...(f.gainedIds ?? []), ...selected];
          f.didCount = (f.didCount ?? 0) + selected.length;
          ctx.events.push({ type: 'cardsRevealedToHand', data: { player: f.player, cards: selected } });
          logRevealedToHand(ctx, selected);
          // 「…をそれぞれ1枚まで公開し手札に加える」 — the grouped picks carry the same public-take
          // channel the single-filter take raises: the taken cards fire their 「山札から公開された時」
          // watchers and the deck→hand arrival (KGR-1-041's 「公開され、手札に加わった時」).
          if (e.reveal) {
            queueRevealedFromDeck(ctx, selected);
            queueDeckToHand(ctx, selected, f.sourceId);
          }
          // A grouped take off a hidden-stack look is the same under→hand moment as the primary take.
          if (e.type === 'lookReveal' && e.from === 'under') for (const id of selected) ctx.queue.push(...collectTriggered(ctx, f.player, 'onUnderToHand', f.sourceId, id));
        }
      }
      f.held = f.held.filter(id => !selected.includes(id));
      f.takeGroupIndex = (f.takeGroupIndex ?? 0) + 1;
      if (requestTakeGroup(ctx, f, e)) return;
      f.stage = 'bottom';
      if (placeRemainder()) return;
    } else if (f.stage === 'bottom') {
      // 「望む順で山札の上に置く」 orders the cards *and* puts them on top; plain `'top'` keeps the
      // order they were looked at, which is right when the print asks for no ordering.
      if (rest === 'top' || rest === 'orderTop') { deckP.deck.unshift(...selected); noteDeckTop(deckP); }
      else if (rest === 'splitTop') {
        // The chosen cards go on top (in the order chosen) and everything else keeps its order below.
        const kept = f.held.filter(id => !selected.includes(id));
        deckP.deck.unshift(...selected); noteDeckTop(deckP);
        deckP.deck.push(...kept);
        f.held = [];
      } else if (rest === 'splitTopSideline') {
        // The chosen cards go on top; everything else is sent to 場外 — the printed replacement reading
        // of the ordering question (「残りを場外に置く」). Two or more chosen cards still have to be
        // ordered explicitly: the first `cards` answer only picks *which* cards go on top. Park the
        // remainder on the frame, ask the order over the chosen cards, and place them by that answer.
        const parked = f.selections?.__splitTopRest;
        if (parked !== undefined) {
          const kept = parked;
          delete f.selections!.__splitTopRest;
          deckP.deck.unshift(...selected); noteDeckTop(deckP);
          f.discardedIds = [...kept];
          f.didCount = kept.length;
          p.sideline.push(...kept);
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, kept, f.sourceId);
          f.held = [];
        } else if (selected.length >= 2) {
          f.selections ??= {};
          f.selections.__splitTopRest = f.held.filter(id => !selected.includes(id));
          request(ctx, f, 'order', lookOrderPrompt('splitTopSideline'), selected.length, selected.length, selected);
          return;
        } else {
          const kept = f.held.filter(id => !selected.includes(id));
          deckP.deck.unshift(...selected); noteDeckTop(deckP);
          f.discardedIds = [...kept];
          f.didCount = kept.length;
          p.sideline.push(...kept);
          if (e.type === 'lookReveal' && e.from !== 'under') noteDeckToSideline(ctx, f.player, kept, f.sourceId);
          f.held = [];
        }
      } else if (rest === 'lifeOrder') {
        // 「見たカードを望む順で自分のライフエリアに置く」 — the answered order *is* the new life area;
        // the positional flags are rebuilt from the record the lift made, so a face-up card keeps its state
        // wherever it lands.
        p.life = [...selected];
        p.lifeFaceUp = selected.map(id => f.heldLifeFaceUp?.[id] === true);
        delete f.heldLifeFaceUp;
        f.held = [];
      } else deckP.deck.push(...selected);
      f.held = [];
    }
    const after = e.type === 'search' ? (e.discardAfterTake ? 1 : undefined) : e.discardAfterTake;
    if (f.stage !== 'discard' && after !== undefined && (f.gainedCount ?? 0) > 0 && p.hand.length) {
      const count = Math.min(after, p.hand.length);
      f.stage = 'discard';
      f.selections ??= {};
      f.selections.__discard = [];
      request(ctx, f, 'cards', `选择 ${count} 张手牌送至场外（可以是刚加入的牌）`, count, count, [...p.hand]);
      return;
    }
    if (f.stage === 'discard') {
      p.hand = p.hand.filter(id => !selected.includes(id)); p.sideline.push(...selected);
      ctx.events.push({ type: 'effectDiscarded', data: { player: f.player, cards: selected } });
    }
  } else if (e.type === 'actSource' && f.stage === 'actSourceOptional') {
    // 「…置いてもよい。」 — the accepted answer re-queues a confirmed copy; declining does nothing at
    // all, so neither the frame's records nor the board change.
    if (selected[0] === '1') {
      f.actConfirmed = true;
      f.steps.splice(f.index + 1, 0, structuredClone(e));
    }
  } else if (e.type === 'act' && f.stage === 'deckChoice') {
    // The answer to the top-or-bottom question `case 'toDeckTopOrBottom'` raised: the card leaves its
    // current zone through the ordinary departure bookkeeping and lands on the named end of its owner's
    // deck — the same route `toDeckTop` / `toDeckBottom` take.
    const decked = (f.selections?.__deckChoice ?? [])[0];
    if (f.selections) delete f.selections.__deckChoice;
    if (decked !== undefined) {
      const owner = s.cards[decked]?.owner ?? f.player;
      const went = findField(s, owner, decked) ? leaveField(ctx, owner, decked, 'sideline', 'effect-deck') : 'sideline';
      if (went === 'sideline') {
        removeFromZone(s, owner, decked);
        if (selected[0] === 'top') { s.players[owner].deck.unshift(decked); noteDeckTop(s.players[owner]); }
        else s.players[owner].deck.push(decked);
      }
    }
  } else if (e.type === 'act' && f.stage === 'substitute') {
    // 「代わりにこのキャラを退場させてもよい」 — the answer to the offer made in `case 'act'`: a chosen
    // substitute retires in place of the card that was about to, and declining retires that card.
    const retiring = f.selections?.__retiring ?? [];
    if (f.selections) delete f.selections.__retiring;
    const substitute = selected[0];
    if (substitute !== undefined) {
      applyOperation(ctx, f, substitute, 'retire');
      // 「そうした場合、その〈X〉をレストにする。」 — the follow-up the substitution carried, run on the
      // card that was saved. It is bound as `__saved` for the steps, which the compiler emits against.
      const follow = f.substituteFollow;
      delete f.substituteFollow;
      if (follow?.length && retiring[0] !== undefined) {
        f.selections ??= {};
        f.selections.__saved = [retiring[0]];
        f.steps.splice(f.index + 1, 0, ...savedOwnerFollow(s, f.player, follow, retiring[0]));
      }
    }
    else if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, 'retire');
  } else if (e.type === 'revealHandToBottom') {
    // The answer to the reveal: the picked cards become public — the frame record, the turn log and the
    // event all agree — and go to the bottom of their owner's deck. Declining (an empty answer) leaves
    // the record empty, which is exactly what the following 「公開したカードが…」 then reads as false.
    for (const id of selected) {
      const owner = s.cards[id]?.owner ?? f.player;
      s.players[owner].hand = s.players[owner].hand.filter(handId => handId !== id);
      s.players[owner].deck.push(id);
      logTurnEvent(s, 'revealedFromHand', owner, undefined, { causeOwner: f.player, causeId: f.sourceId });
      ctx.events.push({ type: 'cardRevealed', data: { player: owner, cardId: id } });
    }
    queueRevealedFromHand(ctx, selected, f.sourceId);
    f.revealedIds = [...selected];
    f.revealedFrom = 'hand';
    f.revealedHandCount = (f.revealedHandCount ?? 0) + selected.length;
    f.didCount = selected.length;
    f.gainedCount = 0;
  } else if (e.type === 'revealLooked' && f.stage === 'revealOptional') {
    const looked = (f.revealedIds ?? []).filter(id => matchesFilter(s, id, e.filter, f.sourceId));
    if (selected[0] === '1' && looked.length) revealLooked(ctx, f, looked);
    else f.didCount = 0;
  } else if (e.type === 'act' && f.stage === 'substituteCost') {
    // 「…代わりに自分の手札を1枚場外に置いてもよい」 — the answer to the carrier's own cost offer: the
    // chosen hand cards are discarded and the departure is cancelled; declining lets it run as printed.
    // `substituteOp` records which destination the offer was buying out of (retirement or 手札に戻る).
    const retiring = f.selections?.__retiring ?? [];
    const substituteOp = f.substituteOp ?? 'retire';
    const payUnder = f.selections?.__payUnder !== undefined;
    const payLife = f.selections?.__payLife !== undefined;
    const payTop = f.selections?.__payTop !== undefined;
    const payEnergy = f.selections?.__payEnergy !== undefined;
    const baseRecord = f.selections?.__payBase;
    const payRest = f.selections?.__payRest;
    const payRemove = f.selections?.__payRemove !== undefined;
    const replenishRecord = f.selections?.__payReplenish;
      if (f.selections) { delete f.selections.__retiring; delete f.selections.__payUnder; delete f.selections.__payLife; delete f.selections.__payTop; delete f.selections.__payEnergy; delete f.selections.__payBase; delete f.selections.__payReplenish; delete f.selections.__payRest; delete f.selections.__payRemove; }
    delete f.substituteOp;
    if (selected.length) {
      const payer = retiring[0] !== undefined ? s.cards[retiring[0]]?.owner : undefined;
      if (payer !== undefined) {
        if (payRemove) {
          // 「…代わりにそのキャラとそのキャラのレイド元のカードをリムーブエリアに置いてもよい。」
          // (WBK-1-017) — the protected card still leaves the field, but to the removal area, and the
          // stack beneath it follows. The bases live in no zone (`remove` cannot reach them through
          // `removeFromZone`), so they are peeled off the slot first and each moved on as its own card;
          // a base-less character simply moves alone.
          const host = findField(s, payer, retiring[0]!);
          const bases = host ? [...host.card.underneath] : [];
          if (host) host.card.underneath = [];
          if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, 'remove');
          for (const base of bases) applyOperation(ctx, f, base, 'remove');
        } else if (payRest !== undefined) {
          // 「…代わりに「アクティブのこのキャラをレストにし、自分の手札をN枚場外に置く。」をしてもよい。」
          // (MSS-1-034) — the protected card survives, standing→rested, and the chosen hand cards pay.
          if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, 'rest');
          s.players[payer].hand = s.players[payer].hand.filter(id => !selected.includes(id));
          s.players[payer].sideline.push(...selected);
          ctx.events.push({ type: 'effectDiscarded', data: { player: payer, cards: selected } });
        } else if (payEnergy) {
          // 「…代わりにこのキャラをエナジーLに移動させてもよい。」 (KMY-P-002) — the relocation accepted:
          // the departure is cancelled and the card steps to the energy line (the `move` operation
          // carries the capacity check, the turn-log entry and the 「移動した時」 watchers).
          if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, 'move', undefined, 'energy');
        } else if (payTop) {
          // 「…代わりにレイド状態の上のこのカードを場外に置いてもよい。」 — the peel: the top card leaves
          // for 場外 (its own route, with its own 退場時) and the base takes the slot over.
          if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, 'topToSideline');
        } else if (baseRecord !== undefined) {
          // 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 (ARK-1-059) — the base price:
          // the paying card's first under-card leaves for 場外 while the top keeps the slot. The card
          // sits in no zone (`zoneOfCard` answers 'under' and `removeFromZone` does not reach
          // `underneath`), so the detach is written here; the arrival joins the frame's own discard
          // record, which is the channel the printed follow-ups read.
          const carrierId = baseRecord[0];
          const carrier = carrierId === undefined ? undefined : findField(s, payer, carrierId);
          const baseId = carrier?.card.underneath[0];
          if (carrier && baseId !== undefined) {
            carrier.card.underneath.splice(0, 1);
            s.players[payer].sideline.push(baseId);
            (f.discardedIds ??= []).push(baseId);
          }
        } else if (payUnder) {
          // 「このキャラの下の裏向きのカードを1枚場外に置いてもよい」 — the hidden-stack price: the
          // chosen cards leave the carrier's face-down pile for 場外.
          const host = findField(s, payer, retiring[0]!);
          for (const id of selected) {
            const at = host?.card.faceDown?.indexOf(id) ?? -1;
            if (at !== -1) { host!.card.faceDown!.splice(at, 1); s.players[payer].sideline.push(id); }
          }
          ctx.events.push({ type: 'underCardsSentToSideline', data: { player: payer, cards: selected } });
        } else if (payLife) {
          // 「代わりに自分のライフエリアにあるカードを1枚場外に置いてもよい」 — the life-area price: the
          // chosen life cards leave the area for 場外, keeping the slot flags aligned.
          for (const id of selected) removeFromLife(s, payer, id);
          s.players[payer].sideline.push(...selected);
          ctx.events.push({ type: 'lifeCardSentToSideline', data: { player: payer, cards: selected } });
        } else if (replenishRecord !== undefined) {
          // 「…代わりに自分の山札の上から1枚を裏向きでこのキャラの下に置いてもよい。」 — the replenish
          // price: the printed count of deck-top cards joins the carrier's own hidden stack, face down.
          const count = Math.max(0, Number(replenishRecord[1] ?? 0) || 0);
          const host = findField(s, payer, retiring[0]!);
          const cards = s.players[payer].deck.splice(0, Math.min(count, s.players[payer].deck.length)); noteDeckTop(s.players[payer]);
          if (host && cards.length) (host.card.faceDown ??= []).push(...cards);
        } else {
          s.players[payer].hand = s.players[payer].hand.filter(id => !selected.includes(id));
          s.players[payer].sideline.push(...selected);
          ctx.events.push({ type: 'effectDiscarded', data: { player: payer, cards: selected } });
        }
        const costFollow = f.substituteFollow;
        delete f.substituteFollow;
        if (costFollow?.length && retiring[0] !== undefined && substituteOp === 'retire') {
          f.selections ??= {};
          f.selections.__saved = [retiring[0]];
          f.steps.splice(f.index + 1, 0, ...savedOwnerFollow(s, f.player, costFollow, retiring[0]));
        }
      }
    } else if (retiring[0] !== undefined) applyOperation(ctx, f, retiring[0]!, substituteOp);
  } else if (e.type === 'act' && f.stage === 'bpMinusSubstitute') {
    // 「相手の効果で…このキャラのBPがマイナスされる場合、代わりにこのキャラをエナジーLに移動させて
    // もよい。」 (KMY-P-002) — the answer to the penalty's own offer: accepting moves the carrier to the
    // energy line instead, declining applies the penalty the step would have applied (the same records
    // the `bp` operation writes: the modifier, the zero-BP mark and the 「BPがマイナスされた時」 queue).
    const record = f.selections?.__bpMinus ?? [];
    const targetId = record[0];
    const amount = Number(record[1] ?? 0);
    const duration = record[2] ? record[2] as Duration : undefined;
    if (f.selections) delete f.selections.__bpMinus;
    if (selected.length && targetId !== undefined) {
      applyOperation(ctx, f, targetId, 'move', undefined, 'energy');
    } else if (targetId !== undefined) {
      const targetOwner = s.cards[targetId]?.owner;
      const targetCard = targetOwner === undefined ? undefined : findField(s, targetOwner, targetId)?.card;
      if (targetCard) {
        const expiresBattle = duration === 'attackEnd' ? s.battle?.seq : undefined;
        targetCard.bpModifiers.push({ amount, expiresTurn: duration ? expiryOf(ctx, f.player, duration) : s.turn, ...(expiresBattle !== undefined ? { expiresBattle } : {}) });
        if (amount < 0) ctx.queue.push(...collectTriggered(ctx, targetOwner!, 'onBpDecreased', targetId));
        if (amount < 0 && getBP(s, targetCard) <= 0) (f.bpZeroIds ??= []).push(targetId);
      }
    }
  } else if (e.type === 'takeUnder') {
    // The answer to the >N hidden-stack pick `case 'takeUnder'` raised: the chosen cards leave the stack
    // under their host and join their owner's hand. The card is looked for *inside* a slot's `faceDown`,
    // not as a slot of its own — a hidden card is in no line.
    for (const id of selected) {
      const owner = s.cards[id]?.owner;
      if (owner === undefined) continue;
      // 「[このカードを退場させる]…」 (BLC-4-034) — the printed stack of a self-retired host is already in
      // 場外; the answer moves it on from there, with the host's id (the frame's source) as the event
      // subject the way the on-field path uses the host slot.
      if (s.players[owner].sideline.includes(id)) {
        s.players[owner].sideline = s.players[owner].sideline.filter(card => card !== id);
        s.players[owner].hand.push(id);
        ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToHand', f.sourceId, id));
        continue;
      }
      for (const line of ['front', 'energy'] as const) {
        const host = s.players[owner][line].find(entry => entry.faceDown?.includes(id));
        if (!host) continue;
        host.faceDown!.splice(host.faceDown!.indexOf(id), 1);
        s.players[owner].hand.push(id);
        // 「このキャラの下の裏向きのカードを手札に加えた時」 — raised per card with the host as subject.
        ctx.queue.push(...collectTriggered(ctx, owner, 'onUnderToHand', host.cardId, id));
        break;
      }
    }
    f.didCount = (f.didCount ?? 0) + selected.length;
    f.gainedCount = (f.gainedCount ?? 0) + selected.length;
    f.gainedIds = [...(f.gainedIds ?? []), ...selected];
  } else if (e.type === 'departurePaySelect') {
    s.departurePayChoices = { ...(s.departurePayChoices ?? {}), [e.cardId]: [...selected] };
  } else requireRule(false, 'INVALID_STATE', '当前指令不接受选择。');
  f.index++; f.stage = 'step'; runEffects(ctx);
}
