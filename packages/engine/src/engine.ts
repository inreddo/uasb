import type {
  Action, CardDefinition, CardEffect, CardFilter, CardId, Command, CommandResult, Condition, Energy, EffectTask, FieldCard, GameEvent, PendingDecision,
  GameState, Keywords, Line, MatchConfig, PlayerId, PlayerState, QueueResume, StaticAbility, StaticModifier, TriggeredAbility, TurnEventKind, TriggerDecision, EffectFrame,
} from './types.ts';
import { validateCommand } from './commands.ts';
import { activationCostFailure, activationSelectBlocked, canPaySelectionTax, canPayTax, chooseEffect, entryLineOptions, fieldIdentity, lineOverflowCandidates, makeTask, matchesFilter, overflowRemoval, payTax, peelTopToSideline, protectedFrom, retireCostSubstitute, selectionTaxFor, settleTriggers, startEffect, useSelectBlocked } from './effects.ts';
import { hasAnyTrait } from './traits.ts';
import { answersKind, battleOpponentStripsKeyword, definitionMatchesSubset, deployForbidden, effectiveNames, effectsSuppressed, evalCondition, forbiddenKeyword, forbiddenTriggers, globalEnergyDeltas, grantedTriggersOf, handStaticsOf, lineCapacity, locate, matchesEventCard, otherOf, peekDefinition, playerStatics, refusesBattleDefeat, removalUseAllowed, staticApCostDelta, staticBattleLoserTo, staticBlockerFilters, staticBp, staticCanStep, staticColorTriggerReplacements, staticDamage, staticEnergyBonus, staticEnterActive, staticEvade, staticEvadeAtLeast, staticForbids, staticImmunity, staticImpact, staticKeywords, staticSelfBattleLoserTo, staticSnipeCeiling, staticSnipeTax, strippedKeywords, tierCountOf, treatedAsAllColors } from './conditions.ts';
import { activeStatics, handLimitOf, refusesHandReturn, refusesOpponentRemoval, refusesRest } from './conditions.ts';
import type { SelectionTax } from './conditions.ts';
import { recordRetiredEnergyBroadcast, removalRedirectsToSideline, spendReplacementUse, ownStaticsOf } from './conditions.ts';
import { shuffle } from './random.ts';
import { optionalEntryChoice } from './optional-entry.ts';
import { createLedger, logEvent, mergeLogEvents, syncLedger } from './log-ledger.ts';
import type { Ledger } from './log-ledger.ts';
import { assertInvariants, COLORS, requireRule, RuleError, validateMatchConfig } from './validation.ts';

export type Context = { state: GameState; events: GameEvent[]; queue: EffectTask[]; ledger?: Ledger };
const emit = (ctx: Context, type: string, data: GameEvent['data'] = {}): void => { ctx.events.push({ type, data }); };

export function getDefinition(state: GameState, cardId: CardId): CardDefinition {
  const instance = Object.hasOwn(state.cards, cardId) ? state.cards[cardId] : undefined;
  requireRule(instance, 'INVALID_CARD', '找不到该实体卡。');
  return state.catalog[instance.definitionId]!;
}

export function findField(state: GameState, player: PlayerId, cardId: CardId): { line: Line; card: FieldCard } | undefined {
  for (const line of ['front', 'energy'] as const) {
    const card = state.players[player][line].find(c => c.cardId === cardId);
    if (card) return { line, card };
  }
  return undefined;
}

/** Printed keywords merged with static grants and this-turn keyword modifiers. */
export function getKeywords(state: GameState, cardId: CardId): Keywords {
  const definition = getDefinition(state, cardId);
  const owner = state.cards[cardId]!.owner;
  const here = findField(state, owner, cardId);
  // 「【レイド】で囲まれた部分の効果は無効になります。」 (Q51) — the keywords printed inside a card's
  // ◆レイド fence are read only while the card is stacked as a raid top card. They are still *printed*
  // keywords (dropped with the rest when the effects are suppressed), so the bucket joins `keywords`
  // before every grant and strip below.
  const fenced = (here?.card.underneath.length ?? 0) > 0 ? definition.raidScopedKeywords : undefined;
  // 「元々の効果を全て失い」 — a suppressed card keeps none of its printed keywords either (the static
  // half already drops through `staticKeywords` → `activeStatics`).
  const merged: Keywords = { ...(effectsSuppressed(state, cardId) ? {} : { ...definition.keywords, ...(fenced ?? {}) }), ...staticKeywords(state, cardId, owner) };
  // 「相手の場のキャラ全ては、「…」を全て失う。」 — the other side's strip, applied after every merge
  // below so it covers printed, static and temporary keywords alike.
  const stripped = strippedKeywords(state, cardId, owner);
  if (here) {
    const bag = merged as Record<string, unknown>;
    // 「[ダメージ（+1）]」 raises what the card already has, so it is summed *after* every absolute
    // grant has been folded in. Treating it as an absolute value would leave a card that already has
    // DAMAGE(2) at 2 instead of 3 — the grant would do nothing on the cards it is printed for.
    const additive: Record<string, number> = {};
    for (const modifier of here.card.keywordModifiers ?? []) {
      if (modifier.expiresTurn < state.turn) continue;
      for (const [key, value] of Object.entries(modifier.keywords)) {
        if (key === 'damage' || key === 'impact') {
          if (modifier.relative) additive[key] = (additive[key] ?? 0) + (value as number);
          else bag[key] = Math.max(typeof bag[key] === 'number' ? bag[key] as number : 0, value as number);
        } else if (value) bag[key] = true;
      }
    }
    for (const [key, value] of Object.entries(additive)) bag[key] = (typeof bag[key] === 'number' ? bag[key] as number : 0) + value;
    // 「このキャラはこのターン中、[狙い撃ち]を失う。」 (AOT-2-007) — the temporary self-loss, applied
    // where every keyword read lands (after the grants, like the opponent's strip below).
    for (const loss of here.card.lostKeywords ?? []) {
      if (loss.expiresTurn < state.turn) continue;
      for (const key of Object.keys(loss.keywords) as (keyof Keywords)[]) delete merged[key];
    }
  }
  for (const key of Object.keys(stripped) as (keyof Keywords)[]) delete merged[key];
  return merged;
}

export function getBP(state: GameState, field: FieldCard): number {
  const owner = state.cards[field.cardId]!.owner;
  return (getDefinition(state, field.cardId).bp ?? 0) + staticBp(state, field.cardId, owner)
    + field.bpModifiers.filter(m => m.expiresBattle === undefined || state.battle?.seq === m.expiresBattle).reduce((n, m) => n + m.amount, 0);
}

export function getImpact(state: GameState, field: FieldCard): number {
  const owner = state.cards[field.cardId]!.owner;
  // 「[インパクト]を全て失う。」 (MHA-1-035 / Q439) — the strip deletes the keyword in `getKeywords`,
  // but the `printed` term below reads the definition around that merge; a stripped IMPACT is gone
  // whole — printed, static and the `impactModifiers` grants alike (`[インパクト+1]` included).
  if (strippedKeywords(state, field.cardId, owner).impact) return 0;
  const modifiers = (field.impactModifiers ?? []).filter(m => m.expiresTurn >= state.turn);
  const additive = modifiers.filter(m => m.additive).reduce((n, m) => n + m.value, 0);
  const nonAdditive = modifiers.filter(m => !m.additive).map(m => m.value);
  const printed = (getDefinition(state, field.cardId).keywords?.impact ?? 0) + staticImpact(state, field.cardId, owner);
  // 「[インパクト（N）]を得る」 reaches the engine by two routes: `operation: 'impact'`, which writes an
  // `impactModifiers` entry, and a plain `keywords` grant, which `getKeywords` folds in. Reading only the
  // first left 29 compile-clean cards granting IMPACT that `getImpact` never saw — the clause was dead.
  // `damage` has consulted `getKeywords` since the relative-grant fix; IMPACT did not, and the two are the
  // same question, so the relative part is subtracted back out here exactly as `getDamage` does.
  const relative = relativeKeywordBonus(state, field.cardId, owner, 'impact');
  const merged = (getKeywords(state, field.cardId).impact ?? 0) - relative;
  return Math.max(printed, merged, ...nonAdditive) + additive;
}

/**
 * The part of a numeric keyword that came from a relative 「（+N）」 grant this turn.
 *
 * `getKeywords` folds relative and absolute grants into a single number, which is right for a plain
 * reader but wrong for a value that has a *default*: DAMAGE defaults to 1 for a character with no
 * printed DAMAGE, so a grant that raises the value must be applied on top of that default rather
 * than merged into it.
 */
function relativeKeywordBonus(state: GameState, cardId: CardId, owner: PlayerId, key: 'damage' | 'impact'): number {
  const here = findField(state, owner, cardId);
  if (!here) return 0;
  let total = 0;
  for (const modifier of here.card.keywordModifiers ?? []) {
    if (modifier.expiresTurn < state.turn || !modifier.relative) continue;
    total += Number(modifier.keywords[key] ?? 0);
  }
  return total;
}

export function getDamage(state: GameState, field: FieldCard): number {
  const owner = state.cards[field.cardId]!.owner;
  // 「[ダメージ]を全て失う。」 (MHA-1-035 / Q440) — a stripped DAMAGE keyword is gone whole: the printed,
  // static and granted terms die with it (including `[ダメージ+1]`, Q440), so the bare default stands.
  if (strippedKeywords(state, field.cardId, owner).damage) return 1;
  const definition = getDefinition(state, field.cardId);
  const relative = relativeKeywordBonus(state, field.cardId, owner, 'damage');
  // A character with no printed DAMAGE deals 1, so 「[ダメージ（+1）]」 has to raise *that*: dropping the
  // `?? 1`, or folding the grant into the default, leaves such a character at 1 and the grant does
  // nothing. The relative part is subtracted back out of `getKeywords` (which has already merged it)
  // and re-applied after the default is in place.
  const absolute = Math.max(
    1,
    (definition.keywords?.damage ?? 1) + staticDamage(state, field.cardId, owner),
    (getKeywords(state, field.cardId).damage ?? 1) - relative,
  );
  return absolute + relative;
}

/**
 * 「山札にあるこのカードは…として扱ってもよい。」 — the cost-replacement statics are worded for one zone
 * (the deck). `handStaticsOf` serves them wherever the card is not on a line, so each replacement reads
 * this before trusting its modifier: only a card actually in the deck qualifies. A card held mid-
 * resolution (no zone at all — an effect is playing it and the origin is the deck) keeps the replacement;
 * hand, sideline, removal and life are zones the words do not name, and a card on a line is the field's
 * own business (`energyCostSetOnField` and friends).
 */
function deckZoneReplacementApplies(state: GameState, owner: PlayerId, cardId: CardId): boolean {
  const p = state.players[owner];
  if (p.deck.includes(cardId)) return true;
  return !p.hand.includes(cardId) && !p.sideline.includes(cardId) && !p.removal.includes(cardId)
    && !p.life.includes(cardId) && !locate(state, owner, cardId);
}

/**
 * The price the card carries on its own — printed, or the 「として扱う」 replacement when it applies —
 * with its own-scope reductions: the *base* both `getApCost` (which adds the use-route terms) and
 * `currentApCostOf` (which does not) build on.
 *
 * A card in hand has no slot; its own definition statics are read through `handStaticsOf`. Reading them
 * through `staticApCostDelta` as well (its `activeStatics` serves owned statics regardless of zone)
 * counted every hand-scoped AP discount twice — the raid-time and use-time discounts alike. The field
 * path keeps the owned-static read for a card actually on a line.
 */
function apPriceBase(state: GameState, cardId: CardId, viaRaid: boolean): number {
  const owner = state.cards[cardId]?.owner ?? 0;
  const handModifiers = handStaticsOf(state, cardId);
  const handDelta = handModifiers.reduce((total, m) => total + (m.type === 'apCostDelta' || (viaRaid && m.type === 'apCostDeltaOnRaid') ? m.amount : 0), 0);
  const definition = getDefinition(state, cardId);
  const ownedDelta = locate(state, owner, cardId) ? staticApCostDelta(state, cardId, owner) : 0;
  // 「山札にあるこのカードは消費APを1として扱ってもよい。」 — the 「として扱う」 replacement comes first,
  // like the requirement-side override: later reductions apply to the named price, not to the printed one.
  const apOverride = handModifiers.find(m => m.type === 'apCostSet');
  const effectiveApOverride = apOverride && deckZoneReplacementApplies(state, owner, cardId) ? apOverride : undefined;
  return Math.max(0, (effectiveApOverride ? effectiveApOverride.amount : definition.apCost) + ownedDelta + handDelta);
}

/**
 * 「消費APがN…」 filters (Q1122) read the price the card would *currently* cost — the same base
 * `getApCost` prices a use from, *without* the use-route terms: a waiting 「次に使用する」 discount and a
 * useTarget declaration belong to a use, not to the card the effect is filtering over.
 */
export function currentApCostOf(state: GameState, cardId: CardId): number {
  return apPriceBase(state, cardId, false);
}

export function getApCost(state: GameState, cardId: CardId, declaredId?: CardId, fromRemoval = false, viaRaid = false): number {
  const owner = state.cards[cardId]?.owner ?? 0;
  const definition = getDefinition(state, cardId);
  const printed = apPriceBase(state, cardId, viaRaid);
  // 「〈X〉を選んで使用する場合、このカードの消費APを-1する。」 — priced from the *declared* target, so
  // the discount is settled before the AP is spent. A use that declared nothing (or a card outside the
  // printed filter) pays the full price, which is what makes the declaration worth carrying on the wire.
  const useDelta = definition.useTarget && declaredId !== undefined && matchesFilter(state, declaredId, definition.useTarget.filter, cardId)
    ? definition.useTarget.apCostDelta : 0;
  let discount = 0;
  for (const entry of state.players[owner].nextUseAp ?? []) {
    // 「次に**リムーブエリアから**使用するカードの消費APを-1する」 — the waiting discount names the zones
    // its use must start from, so a hand use never consumes a removal-scoped entry (and vice versa).
    if (!nextUseEntryAttends(state, entry, cardId, fromRemoval ? 'removal' : 'hand')) continue;
    // 「各必要エナジーにつき1枚まで」 — a signature already discounted by this entry pays full price;
    // other totals still qualify. The total is the printed requirement, read off the definition.
    if (entry.usedSignatures) {
      const total = Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
      if (entry.usedSignatures.includes(total)) continue;
    }
    discount += entry.amount;
  }
  return Math.max(0, printed + discount + useDelta);
}

/**
 * Whether a waiting `nextUseAp` entry attends a use of `cardId` starting from `zone`.
 *
 * The shared predicate behind `getApCost` (read) and the spenders — they must agree on which cards
 * match. No `sourceId`: the entry is matched against a card in no zone of the source long after the
 * granting effect resolved, so there is no source to read `other`/`self`/`bound` against. The compiler
 * refuses subjects carrying those fields for this step (see the `nextUseAp` rules), so none can
 * arrive here.
 */
function nextUseEntryAttends(state: GameState, entry: { filter: CardFilter; expiresTurn: number; zones?: ('hand' | 'sideline' | 'removal')[] }, cardId: CardId, zone: 'hand' | 'sideline' | 'removal'): boolean {
  return entry.expiresTurn >= state.turn
    && (entry.zones ?? ['hand']).includes(zone)
    && matchesFilter(state, cardId, entry.filter);
}

/**
 * Ends the 「…次に〈X〉が自分の場に登場するまで」 periods a placement satisfies.
 *
 * The reduction belongs to the *player* (the cards it discounts are in no zone of their own yet), and
 * the printed period ends the moment a matching card enters — the arrival is the whole point of the
 * clause, so it is read here rather than at any later use. Called from every placement route.
 */
export function clearEnteredDiscounts(s: GameState, player: PlayerId, cardId: CardId): void {
  const list = s.players[player].nextEnergyDiscount;
  if (!list?.length) return;
  const remaining = list.filter(entry => !(entry.enterFilter && matchesFilter(s, cardId, entry.enterFilter)));
  if (remaining.length !== list.length) s.players[player].nextEnergyDiscount = remaining;
}



/**
 * The selection a 「〈X〉を選んで使用する場合」 card binds at use time, in printed order.
 *
 * The compiler marks exactly one `select` when it links a `useTarget` definition to the effect's own
 * selection; the play path validates the declaration against *this* selection's pool, so the discount
 * can never be claimed with a target the effect would not take.
 */
function useTargetSelection(definition: CardDefinition): Extract<CardEffect, { type: 'select' }> | undefined {
  const walk = (steps: CardEffect[]): Extract<CardEffect, { type: 'select' }> | undefined => {
    for (const step of steps) {
      if (step.type === 'select' && step.declaredTarget) return step;
      if (step.type === 'if' || step.type === 'gained' || step.type === 'ifSelected') {
        const found = walk(step.then ?? []) ?? walk(step.else ?? []);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(definition.onPlay ?? []);
}

/** 「このターン中、次に手札からレイドする〈X〉の消費APを-1する」 — the discount a raid matches. */
function raidDiscountTotal(state: GameState, player: PlayerId, cardId: CardId): number {
  let discount = 0;
  for (const entry of state.players[player].nextRaidAp ?? []) {
    if (entry.expiresTurn < state.turn) continue;
    if (!matchesFilter(state, cardId, entry.filter)) continue;
    discount += entry.amount;
  }
  return discount;
}

/** Spends the raid-scoped discount entries the raid action matches, once. */
function consumeRaidDiscount(state: GameState, player: PlayerId, cardId: CardId): void {
  const entries = state.players[player].nextRaidAp ?? [];
  const remaining = entries.filter(entry => !(entry.expiresTurn >= state.turn && matchesFilter(state, cardId, entry.filter)));
  if (remaining.length !== entries.length) state.players[player].nextRaidAp = remaining;
  // The energy sibling is spent on the same raid (YYH-P-002) — a plain play never touches it.
  const energy = state.players[player].nextRaidEnergy ?? [];
  const remainingEnergy = energy.filter(entry => !(entry.expiresTurn >= state.turn && matchesFilter(state, cardId, entry.filter)));
  if (remainingEnergy.length !== energy.length) state.players[player].nextRaidEnergy = remainingEnergy;
}

/**
 * 「このカードは、レイド状態の〈X〉の一番上のカードをそのレイド元の下に裏向きで置き、そのレイド元に
 * レイドできる。」 — the clicked card is the raid-state 〈X〉 itself, and the real base is the card under
 * it. Returns that base when the exceptional route applies; `undefined` leaves the ordinary reading.
 */
function raidFromRaidTopMatch(s: GameState, player: PlayerId, raiderId: CardId, clickedId: CardId): { realBaseId: CardId } | undefined {
  const card = peekDefinition(s, raiderId);
  if (!card?.raidFromRaidTop) return undefined;
  const clicked = findField(s, player, clickedId);
  if (!clicked || clicked.card.underneath.length === 0) return undefined;
  const wanted = card.raidFromRaidTop;
  const names = effectiveNames(s, clickedId, player);
  const matches = wanted.names?.some(n => names.includes(n)) || wanted.nameContains?.some(f => names.some(n => n.includes(f)));
  if (!matches) return undefined;
  // 「このターン中にレイドしていない」 — the printed qualifier on 〈X〉, read off the slot's own entry
  // record (the same fact the turn log would answer, but the slot is still here to answer it).
  if (wanted.notRaidedThisTurn && clicked.card.entered?.raid && clicked.card.entered.turn === s.turn) return undefined;
  const realBaseId = clicked.card.underneath.at(-1)!;
  if (peekDefinition(s, realBaseId)?.kind !== 'character') return undefined;
  return { realBaseId };
}

/** Spends the 「次に使用する…の消費APを-Nする」 entries a play matches, once. */
function consumeNextUseDiscount(state: GameState, player: PlayerId, cardId: CardId, fromRemoval = false): void {
  // Same matching as `getApCost` above, through the shared predicate: the two must agree on which
  // cards attend which entries, zone qualifiers included.
  const zone = fromRemoval ? 'removal' as const : 'hand' as const;
  const mine = (entry: { filter: CardFilter; expiresTurn: number; zones?: ('hand' | 'sideline' | 'removal')[] }): boolean =>
    nextUseEntryAttends(state, entry, cardId, zone);
  const entries = state.players[player].nextUseAp ?? [];
  // 「各必要エナジーにつき1枚まで」 — a per-signature entry is *not* removed by its use: the printed
  // total it just discounted is recorded and the entry stays for the other totals.
  const signature = Object.values(getDefinition(state, cardId).requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
  const remaining = entries.filter(entry => {
    if (!mine(entry)) return true;
    if (entry.usedSignatures) {
      if (!entry.usedSignatures.includes(signature)) entry.usedSignatures.push(signature);
      return true;
    }
    return false;
  });
  if (remaining.length || entries.length) state.players[player].nextUseAp = remaining;
  // The energy siblings are spent on the same use, matched the same way `requiredEnergyOf` matched them.
  const remainingEnergy = (state.players[player].nextUseEnergy ?? []).filter(entry =>
    !(entry.expiresTurn >= state.turn && matchesFilter(state, cardId, entry.filter)));
  if (remainingEnergy.length || state.players[player].nextUseEnergy) state.players[player].nextUseEnergy = remainingEnergy;
  // 「…は消費APが-1され、アクティブで場に登場する。」 (ARK-1-055) — the arrival rider is spent by the same
  // use the discount was; its read happened in `play()` at the placement. The widened 「全て」 entry
  // (IMC-1-098) is *not* spent: it keeps every matching arrival of the turn active.
  const remainingActive = (state.players[player].nextUseActive ?? []).filter(entry =>
    entry.all === true || !(entry.expiresTurn >= state.turn && matchesFilter(state, cardId, entry.filter)));
  if (remainingActive.length || state.players[player].nextUseActive) state.players[player].nextUseActive = remainingActive;
}

/**
 * The 場外 half of the waiting use discount: 「このターン中、次に手札か場外から使用する…の消費APを-1する」
 * (YYH-1-090).
 *
 * A use that starts from the sideline runs through the `useFromSideline` effect route, which prices and
 * pays inline, so it reads and spends its share of the entries here instead of through `getApCost` /
 * `consumeNextUseDiscount`. Both consumers see the same entries, so whichever matching use comes first
 * claims them. Read and spend stay apart, as in the play path: a use the player cannot afford is
 * skipped, and the waiting entry must outlive it.
 */
export function sidelineUseDiscount(state: GameState, player: PlayerId, cardId: CardId): number {
  const total = Object.values(getDefinition(state, cardId).requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
  let discount = 0;
  for (const entry of state.players[player].nextUseAp ?? []) {
    if (!nextUseEntryAttends(state, entry, cardId, 'sideline')) continue;
    if (entry.usedSignatures?.includes(total)) continue;
    discount += entry.amount;
  }
  return discount;
}

/** Spends the entries `sidelineUseDiscount` read, once the sideline use has paid. */
export function spendSidelineUseDiscount(state: GameState, player: PlayerId, cardId: CardId): void {
  const entries = state.players[player].nextUseAp ?? [];
  const signature = Object.values(getDefinition(state, cardId).requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
  const remaining = entries.filter(entry => {
    if (!nextUseEntryAttends(state, entry, cardId, 'sideline')) return true;
    if (entry.usedSignatures) {
      if (!entry.usedSignatures.includes(signature)) entry.usedSignatures.push(signature);
      return true;
    }
    return false;
  });
  if (remaining.length || entries.length) state.players[player].nextUseAp = remaining;
}



export function getGeneratedEnergy(state: GameState, field: FieldCard): Energy {
  const definition = getDefinition(state, field.cardId);
  const owner = state.cards[field.cardId]!.owner;
  const result: Energy = { ...definition.generatedEnergy };
  const bonuses = [
    ...(field.active && definition.activeEnergyBonus ? [definition.activeEnergyBonus] : []),
    staticEnergyBonus(state, field.cardId, owner),
    ...(field.energyModifiers ?? []).filter(m => m.expiresTurn >= state.turn).map(m => m.energy),
  ];
  for (const bonus of bonuses) for (const color of COLORS) result[color] = (result[color] ?? 0) + (bonus[color] ?? 0);
  // 「自分の場のカード全ての発生エナジーは2倍になる」 — a *player-scope* multiplication of what this
  // card produces. Entries multiply (「（この効果は重複する）」), so two holdings are ×4.
  for (const modifier of playerStatics(state, owner)) {
    if (modifier.type !== 'energyGenMultiplier') continue;
    for (const color of COLORS) result[color] = (result[color] ?? 0) * modifier.factor;
  }
  return result;
}

export function getEnergy(state: GameState, player: PlayerId): Energy {
  const energy: Energy = {};
  const sources: FieldCard[] = [...state.players[player].energy];
  // 「自分の場のキャラ全てはフロントLでもエナジーを発生させる。」 — the player-scope broadcast of
  // `generatesFromFront`: while it holds, every one of this player's front-line characters produces.
  const allFromFront = playerStatics(state, player).some(m => m.type === 'fieldGeneratesFromFront');
  for (const card of state.players[player].front) {
    if (allFromFront || activeStatics(state, card.cardId, player).some(m => m.type === 'generatesFromFront')) sources.push(card);
  }
  for (const field of sources) {
    const produced = getGeneratedEnergy(state, field);
    for (const color of COLORS) energy[color] = (energy[color] ?? 0) + (produced[color] ?? 0);
  }
  return energy;
}

function blankPlayer(): PlayerState {
  return { deck: [], hand: [], life: [], front: [], energy: [], sideline: [], removal: [], ap: ['inactive', 'inactive', 'inactive'], turnsStarted: 0, mulligan: 'pending' };
}

export function createMatch(config: MatchConfig): GameState {
  validateMatchConfig(config);
  const state: GameState = {
    schemaVersion: 2, rulesVersion: 'ua-effects-2026-09-25', revision: 0,
    status: 'setup', catalog: Object.fromEntries(structuredClone(config.catalog).map(c => [c.id, c])), cards: {},
    players: [blankPlayer(), blankPlayer()], firstPlayer: config.firstPlayer, activePlayer: config.firstPlayer,
    turn: 0, phase: 'setup', extraDrawUsed: false, rng: config.seed >>> 0,
    pending: { type: 'mulligan', player: config.firstPlayer }, battle: null, outcome: null,
  };
  for (const player of [0, 1] as const) {
    config.decks[player].forEach((definitionId, index) => {
      const id = `p${player}-c${index}`;
      state.cards[id] = { id, definitionId, owner: player };
      state.players[player].deck.push(id);
    });
    shuffle(state, state.players[player].deck);
    state.players[player].hand = state.players[player].deck.splice(0, 7);
  }
  assertInvariants(state);
  return state;
}

export function draw(ctx: Context, player: PlayerId, count: number, opts?: { via?: 'effect'; causeOwner?: PlayerId }): void {
  const cards = ctx.state.players[player].deck.splice(0, count);
  const p = ctx.state.players[player];
  p.hand.push(...cards);
  // 「（山札の一番上ではなくなった場合は裏向きに戻る）」 — the mark a 「表向きにする」 left lapses with the
  // top; every deck write that can change the top maintains it (`noteDeckTop`), this one included.
  noteDeckTop(p);
  // 「このターン中に相手がカードを引いている場合」 — every draw route is recorded; the effect route also
  // names whose effect it was, which the phase-qualified 「自分の効果で」 trigger reads. The card count
  // rides along so 「カードを4枚以上引いている」 can sum cards rather than draw calls.
  logTurnEvent(ctx.state, 'drew', player, undefined, {
    ...(opts?.via !== undefined ? { via: opts.via } : {}),
    ...(opts?.causeOwner !== undefined ? { causeOwner: opts.causeOwner } : {}),
    ...(cards.length ? { count: cards.length } : {}),
  });
  emit(ctx, 'cardsDrawn', { player, cards, count: cards.length });
}

/**
 * Whether the top of `player`'s deck is face-up, and — when it is — which card is showing.
 *
 * The mark is an id rather than a flag so that it lapses by itself: any other card taking the top makes
 * the comparison fail, whatever route put it there.
 */
export function faceUpTop(state: GameState, player: PlayerId): CardId | undefined {
  const p = state.players[player];
  return p.deck[0] !== undefined && p.deckTopFaceUp === p.deck[0] ? p.deck[0] : undefined;
}

/**
 * 「（山札の一番上ではなくなった場合は裏向きに戻る）」 — the face-up mark names the *card*, so the moment a
 * different card takes the top the card it names is face down again and the mark must go. Maintained at
 * every deck write that can change the top: a reader can then trust the mark instead of merely comparing
 * ids, and a card that was covered and later uncovered is not mistaken for the public top again — which
 * the lazy comparison alone cannot tell apart (it sees the same id back on top).
 */
export function noteDeckTop(p: PlayerState): void {
  if (p.deckTopFaceUp !== undefined && p.deck[0] !== p.deckTopFaceUp) delete p.deckTopFaceUp;
}

/** A life slot's face-up flag; a slot with no flag recorded is face down, the way it was placed. */
export function lifeIsFaceUp(state: GameState, player: PlayerId, slot: number): boolean {
  return state.players[player].lifeFaceUp?.[slot] === true;
}

/**
 * Adds cards to a life area, keeping `lifeFaceUp` index-aligned with `life`.
 *
 * The flag array is materialised from the cards present, so the two can never drift apart whatever an
 * earlier instruction did to the area.
 */
export function addToLife(state: GameState, player: PlayerId, ids: CardId[], faceUp = false): void {
  const p = state.players[player];
  const flags = p.life.map((_, i) => p.lifeFaceUp?.[i] ?? false);
  p.life.push(...ids);
  p.lifeFaceUp = [...flags, ...ids.map(() => faceUp)];
}

/** Removes the named life *slots*, taking each slot's face-up flag along, and returns the cards. */
export function removeLifeSlots(state: GameState, player: PlayerId, slots: number[]): CardId[] {
  const p = state.players[player];
  const flags = p.life.map((_, i) => p.lifeFaceUp?.[i] ?? false);
  const cards = slots.map(i => p.life[i]!);
  const keep = p.life.map((_, i) => i).filter(i => !slots.includes(i));
  const kept = keep.map(i => p.life[i]!);
  p.life = kept;
  p.lifeFaceUp = keep.map(i => flags[i]!);
  return cards;
}

/** Removes one life card by identity, keeping `lifeFaceUp` aligned; a no-op when it is not in the area. */
export function removeFromLife(state: GameState, player: PlayerId, id: CardId): boolean {
  const p = state.players[player];
  const at = p.life.indexOf(id);
  if (at === -1) return false;
  removeLifeSlots(state, player, [at]);
  return true;
}

/** A life trigger card still waiting for its effect (Q73) reaches 場外 when the game ends mid-resolution. */
function sendResolvingLifeCard(s: GameState, task: { lifeArrival?: CardId; player: PlayerId }): void {
  const id = task.lifeArrival;
  if (id === undefined) return;
  const owner = s.cards[id]?.owner ?? task.player;
  if (!s.players[owner].sideline.includes(id)) s.players[owner].sideline.push(id);
}

export function finish(ctx: Context, loser: PlayerId, reason: 'life-zero' | 'deck-out' | 'concede' | 'card-effect'): void {
  const s = ctx.state;
  if (s.pending?.type === 'triggers') s.players[s.pending.player].sideline.push(...s.pending.cards);
  else if (s.pending?.type === 'selectionTaxHand') s.players[s.pending.triggers.player].sideline.push(...s.pending.triggers.cards);
  if (s.effect) {
    const f = s.effect;
    // Held cards came from the deck unless the look lifted them out of a life area
    // (「ライフエリアにあるカードを全て見てもよい」) — those go back to life, where the print took them from.
    if (f.heldLifeFaceUp) {
      const flags = s.players[f.player].life.map((_, i) => s.players[f.player].lifeFaceUp?.[i] ?? false);
      s.players[f.player].life = [...f.held];
      s.players[f.player].lifeFaceUp = [...flags, ...f.held.map(id => f.heldLifeFaceUp?.[id] === true)];
      f.held = [];
    }
    s.players[f.player].deck.push(...f.held);
    if (f.eventCard) s.players[f.player].sideline.push(f.eventCard);
    if (f.resume) s.players[f.resume.player].sideline.push(...f.resume.cards);
    for (let task: EffectFrame | undefined = f; task; task = task.suspended) sendResolvingLifeCard(s, task);
    delete s.effect;
  }
  const parkedBatch = s.pending?.type === 'selectionTaxHand' ? s.pending.triggers : undefined;
  for (const task of [...(s.pending?.type === 'triggers' || s.pending?.type === 'queue' ? s.pending.effects ?? [] : parkedBatch?.effects ?? []), ...(s.pending?.type === 'queue' ? s.pending.triggerResume?.effects ?? [] : [])]) sendResolvingLifeCard(s, task);
  s.status = 'finished';
  s.outcome = { winner: otherOf(loser), loser, reason };
  s.pending = null;
  s.battle = null;
  emit(ctx, 'gameFinished', { winner: otherOf(loser), loser, reason });
}

type ActivationCause = 'effect' | 'ready-step' | 'rule';

function activateField(ctx: Context, player: PlayerId, card: FieldCard, cause: ActivationCause = 'rule'): EffectTask[] {
  if ((card.cannotActivateCharges ?? 0) > 0) { card.cannotActivateCharges!--; return []; }
  if (card.active) return [];
  card.active = true;
  return collectTriggered(ctx, ctx.state.cards[card.cardId]?.owner ?? player, 'onActivated', card.cardId, undefined, { activation: cause });
}

/**
 * Records a fact about the current turn for 「このターン中に…した」.
 *
 * Written at the point the fact becomes true and read back by `Condition.turnEvent`; the log is
 * cleared by `beginTurn`, so it is never older than the current turn. Nothing here decides anything
 * by itself — a write site must not be added unless the wording it serves is actually compiled.
 */
export function logTurnEvent(state: GameState, event: TurnEventKind, player: PlayerId, cardId?: CardId, detail?: { free?: boolean; via?: 'play' | 'effect'; raid?: boolean; usedFrom?: 'hand' | 'sideline' | 'deck' | 'removal' | 'under'; line?: 'front' | 'energy'; causeOwner?: PlayerId; causeId?: CardId; to?: 'front' | 'energy'; cause?: 'bpZero' | 'battle' | 'effect'; from?: 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under'; count?: number; apCost?: boolean }): void {
  // The phase is recorded because 「自分の移動フェイズ以外で…移動した」 asks about it and nothing else
  // remembers: by the time the predicate runs, the phase has already changed. The active player rides
  // with it: 「自分のメインフェイズ中」 names the subject's *own* turn (MCR-2-022/054), and a bare
  // phase name cannot tell the two players' identically-named phases apart.
  (state.turnEvents ??= []).push({
    event, player, ...(cardId !== undefined ? { cardId } : {}), phase: state.phase, activePlayer: state.activePlayer,
    // 「APを支払わずに使用している」 — recorded with the *use*, because the payment is over by the time the
    // wording is read.
    ...(detail?.free !== undefined ? { free: detail.free } : {}),
    // 「このターン中に自分の効果で…登場している」 — the arrival route, recorded with the entry for the same
    // reason: the field record it mirrors is gone once the card leaves.
    ...(detail?.via !== undefined ? { via: detail.via } : {}),
    // 「このターン中に…レイドしている」 — the raid route of the entry, for the same reason.
    ...(detail?.raid ? { raid: true as const } : {}),
    // 「自分のリムーブエリアから使用されている」 — the exceptional zone a use started from.
    ...(detail?.usedFrom !== undefined ? { usedFrom: detail.usedFrom } : {}),
    // 「自分のフロントLのキャラが…」 — the line the named card was on when the fact happened.
    ...(detail?.line !== undefined ? { line: detail.line } : {}),
    // 「自分の効果で…している」 — whose effect raised the event, for the wordings that name it.
    ...(detail?.causeOwner !== undefined ? { causeOwner: detail.causeOwner } : {}),
    // 「カード名に「オーズ」を含むキャラの効果で…」 — the source *card* of that effect, which the printed
    // qualifier names (KMR-1-062) and nothing else on the board remembers.
    ...(detail?.causeId !== undefined ? { causeId: detail.causeId } : {}),
    // 「エナジーLからフロントLに移動した」 — the line the card reached, recorded with the move for the
    // same reason: the board only answers where it sits *now*, which a later move changes.
    ...(detail?.to !== undefined ? { to: detail.to } : {}),
    // 「BPが0以下になることか効果によって…退場している」 — the retirement's route, recorded beside the fact.
    ...(detail?.cause !== undefined ? { cause: detail.cause } : {}),
    // 「自分の効果で手札から登場している」 — the origin zone of a placement, read before the move because
    // the origin is gone once the card sits on the field.
    ...(detail?.from !== undefined ? { from: detail.from } : {}),
    // 「このターン中に自分がカードを4枚以上引いている」 — how many cards the event moved, for the
    // events whose printings count cards rather than occurrences.
    ...(detail?.count !== undefined ? { count: detail.count } : {}),
    // 「[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) — whether the activated ability
    // carried the AP-cost tag; the board has no record of what an activation's cost was.
    ...(detail?.apCost ? { apCost: true as const } : {}),
  });
}

/**
 * Whether an activated ability's steps carry the printed [APを1支払う] cost tag (`payAp.asCost`), read
 * anywhere in the step tree — the tag is `costStepsOf`'s leading step, but a grant or a chooser wrapper
 * may nest it. Used by the `abilityActivated` turn record (TKG-1-026) and by `grantActivated`'s
 * 「[APを1支払う]を含む[起動メイン]」 filter, so the two never disagree about one ability.
 */
export function hasApCostTag(steps: CardEffect[] | undefined): boolean {
  for (const step of steps ?? []) {
    if (step.type === 'payAp' && step.asCost) return true;
    if (step.type === 'if' || step.type === 'gained' || step.type === 'ifSelected') {
      if (hasApCostTag(step.then) || hasApCostTag(step.else)) return true;
    } else if (step.type === 'chooseOption') {
      if (step.options.some(option => hasApCostTag(option))) return true;
    }
  }
  return false;
}

function beginTurn(ctx: Context, player: PlayerId): void {
  const s = ctx.state;
  const p = s.players[player];
  s.activePlayer = player;
  s.turn++;
  p.turnsStarted++;
  s.phase = 'start';
  s.extraDrawUsed = false;
  // 「このターン中」 spans the current turn for both players, like turnEvents below. A continuous
  // conditional bonus must not see the inactive player's event count from their previous turn.
  for (const side of s.players) side.eventsUsedThisTurn = 0;
  // 「NターンにM枚」 budgets are read as per-N-turn windows, so the counter starts over with the turn.
  p.useCounts = {};
  // 「…のこの効果でこのターン中に既に選んだキャラは選べない。」 — the turn's own record of what one
  // effect chose; it spans 「このターン中」 alone.
  p.chosenByEffectThisTurn = {};
  p.nextUseAp = (p.nextUseAp ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.nextEnergyDiscount = (p.nextEnergyDiscount ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.nextUseEnergy = (p.nextUseEnergy ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.nextRaidEnergy = (p.nextRaidEnergy ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.nextActivationApFree = (p.nextActivationApFree ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.nextActivationSelectSwap = (p.nextActivationSelectSwap ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.pendingSelectBp = (p.pendingSelectBp ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.grantedStatics = (p.grantedStatics ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.grantedAbilities = (p.grantedAbilities ?? []).filter(entry => entry.expiresTurn >= s.turn);
  p.sidelineTriggeredUsed = {};
  p.limitReserved = {};
  // 「裏向きのこのカードが…下から場外に置かれた時」 — a hidden card has no slot either, so its per-turn
  // budget lives on the player and clears with the turn like the sideline channel's.
  p.underTriggeredUsed = {};
  // 「このカードが山札から公開された時」 abilities fire while the card is in the deck, so their per-turn
  // budget lives on the player as well — and clears with the turn like every other per-turn record.
  p.revealTriggeredUsed = {};
  // 「このターン中に〈X〉が既に選んだ効果は選べない」 — the memory is a fact about the turn, so it
  // clears with the turn like every other per-turn record.
  p.chosenOptionsThisTurn = {};
  // 「このターン中」 never reaches across a turn boundary, and the log belongs to the turn rather than
  // to its active player: what the opponent did during it is equally 「このターン中」.
  s.turnEvents = [];
  // 「このターンのアタックフェイズ開始時/終了時」 — one-turn delays. Their turn is over, so anything still
  // parked (its moment never came: the delay was created after that phase, or during the end phase) is
  // dropped here rather than left in the state to be read by a later turn.
  for (const side of s.players) { delete side.delayedAttackStart; delete side.delayedAttackEnd; }
  for (const side of s.players) for (const card of [...side.front, ...side.energy]) {
    card.attacksThisTurn = 0;
    card.blocksThisTurn = 0;
    card.triggeredUsed = {};
  }
  // 「このキャラはアクティブにならない」 holds through the ready step as well, which is the moment most
  // cards with that restriction would otherwise shake it off.
  const readyTasks: EffectTask[] = [];
  for (const card of [...p.front, ...p.energy]) { const forbids = staticForbids(s, card.cardId, player); if (!forbids.activate && !forbids.activateOwnOnly && !forbids.readyStep) readyTasks.push(...activateField(ctx, player, card, 'ready-step')); }
  const usable = p.turnsStarted >= 3 ? 3 : p.turnsStarted === 2 ? 2 : player === s.firstPlayer ? 1 : 2;
  p.ap = [0, 1, 2].map(i => i < usable ? 'active' : 'inactive') as PlayerState['ap'];
  emit(ctx, 'turnStarted', { player, turn: s.turn, usableAp: usable });
  if (s.turn !== 1) {
    if (p.deck.length === 0) finish(ctx, player, 'deck-out');
    else draw(ctx, player, 1);
  }
  // 「自分のターン開始時、…」 fires for the player whose turn is starting, after the ready step and the
  // draw, so an ability that reads 「手札」 or 「アクティブ」 sees the state the start of turn produced.
  //
  // 「次の相手のターン開始時、…」 instructions parked by the *other* player fire at the same moment and
  // join the same queue, the way the delayed 「メインフェイズ終了時」 instructions join the printed ones.
  // Their bindings travel on the task (`EffectTask.bindings`), since the selecting frame is gone.
  const delayedTasks: EffectTask[] = [];
  for (const side of [0, 1] as const) {
    const parked = s.players[side].delayedTurnStart ?? [];
    const firing = parked.filter(entry => entry.turn === s.turn);
    if (!firing.length) continue;
    s.players[side].delayedTurnStart = parked.filter(entry => entry.turn !== s.turn);
    for (const entry of firing) {
      delayedTasks.push({ ...makeTask(s, side, entry.sourceId, entry.steps), ...(entry.bindings ? { bindings: entry.bindings } : {}) });
    }
  }
  // The ready step's 「レストの…がアクティブになった時」 watchers join the turn-start queue: the
  // transition happened first, and the queue is where a phase's own raised abilities wait.
  const startTasks = [...readyTasks, ...collectTriggered(ctx, player, 'onTurnStart'), ...delayedTasks];
  if (startTasks.length) s.pending = { type: 'queue', player, effects: startTasks, resume: 'none' };
}

function completeMulligan(ctx: Context, player: PlayerId, redraw: boolean): void {
  const s = ctx.state;
  const p = s.players[player];
  requireRule(s.pending?.type === 'mulligan' && p.mulligan === 'pending', 'INVALID_CHOICE', '当前不能重抽起手。');
  if (redraw) {
    const original = p.hand;
    p.hand = p.deck.splice(0, 7);
    p.deck.push(...original);
    shuffle(s, p.deck);
    noteDeckTop(p);
  }
  p.mulligan = redraw ? 'redraw' : 'keep';
  emit(ctx, 'mulliganChosen', { player, redraw });
  if (s.players[otherOf(player)].mulligan === 'pending') {
    s.pending = { type: 'mulligan', player: otherOf(player) };
    return;
  }
  for (const side of s.players) side.life = side.deck.splice(0, 7);
  s.pending = null;
  s.status = 'playing';
  emit(ctx, 'matchStarted');
  beginTurn(ctx, s.firstPlayer);
}

function spendAp(ctx: Context, player: PlayerId, amount: number): void {
  const p = ctx.state.players[player];
  requireRule(p.ap.filter(ap => ap === 'active').length >= amount, 'INSUFFICIENT_AP', '可用 AP 不足。');
  let remaining = amount;
  for (let i = 0; i < 3 && remaining > 0; i++) if (p.ap[i] === 'active') { p.ap[i] = 'rested'; remaining--; }
  emit(ctx, 'apSpent', { player, amount });
}

/**
 * Whether a *use* of `id` counts as an event-card use for `player` — 「…は全ての場所でイベントカード
 * としても扱う」 (CSM family).
 *
 * The broadcast is read from the player's field, like `lineCapacity`: the static sits on a field card
 * that is not the used card itself (the used card has left the hand and may not even be in play yet).
 * Only the non-event use path asks (a printed event card takes the engine's own branch).
 */
function countsAsEventUse(state: GameState, player: PlayerId, id: CardId): boolean {
  // 「このカードは全ての場所でイベントカードとしても扱う」 — the used card's own printed treatment
  // (Q1298): a use of such a card counts as an event-card use the same way a broadcast does.
  if (answersKind(peekDefinition(state, id), 'event')) return true;
  for (const slot of [...state.players[player].front, ...state.players[player].energy]) {
    for (const modifier of activeStatics(state, slot.cardId, player)) {
      if (modifier.type !== 'countsAsEventAsWell') continue;
      if (matchesFilter(state, id, modifier.filter, slot.cardId)) return true;
    }
  }
  return false;
}

/**
 * The energy a card asks for, after its own hand-scope reductions.
 *
 * 「手札にあるこのカードの必要エナジーを[色]減らす」 is printed on the card being played, so each colour
 * is reduced by its own printed amount and never below zero; a card with no such modifier is unchanged.
 */
export function requiredEnergyOf(state: GameState, id: CardId, raidBaseId?: CardId): Energy {
  const owner = state.cards[id]?.owner ?? 0;
  const definition = getDefinition(state, id);
  const modifiers = handStaticsOf(state, id);
  // 「このカードは全ての場所で必要エナジーを[…]としても扱う」 is deliberately NOT read here: the
  // replacement is what *reference* reads see (counts, sums, and the 必要エナジー filters — every
  // `effectiveRequiredEnergy` caller). The price a use pays is the printed requirement: Q805
  // 「手札から使用するには元々の必要エナジーを満たしているだけで使用できます」 (TRK family).
  // The deck-scoped 「山札にあるこのカードは…として扱ってもよい」 spelling does price here, but only
  // while the card actually sits in the deck (a cost question from the hand prices the printed symbols).
  const override = deckZoneReplacementApplies(state, owner, id) ? modifiers.find(m => m.type === 'energyCostSet') : undefined;
  const result: Energy = override ? { ...override.energy } : { ...definition.requiredEnergy };
  for (const modifier of modifiers) {
    if (modifier.type === 'energyCostDelta') {
      if (modifier.scope === 'hand' && !state.players[owner].hand.includes(id)) continue;
      if (modifier.scope === 'sideline' && !state.players[owner].sideline.includes(id)) continue;
      if (modifier.scope === 'handOrSideline'
        && !state.players[owner].hand.includes(id) && !state.players[owner].sideline.includes(id)) continue;
      result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
      continue;
    }
    // 「…N枚につき…[色×M]減らす」 — the count is read here, where the requirement is asked, so the
    // reduction tracks the board; only whole printed units count (`floor(count / per)`).
    if (modifier.type === 'energyCostDeltaPer') {
      // The printed zone qualifier bounds where the reduction exists at all. A play is priced from the
      // hand (deck and removal for the effect-driven routes), so 「手札にある」 restricts and the two
      // field-excluding spellings also refuse a card on a line — what remains of their words here.
      if (modifier.scope === 'hand' && !state.players[owner].hand.includes(id)) continue;
      if ((modifier.scope === 'notField' || modifier.scope === 'notFieldNotSideline')
        && (locate(state, owner, id) || (modifier.scope === 'notFieldNotSideline' && state.players[owner].sideline.includes(id)))) continue;
      const units = Math.floor(tierCountOf(state, owner, id, modifier.count) / modifier.per);
      if (units > 0) result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount * units);
      continue;
    }
    // 「…レイドする際、必要エナジーを[色]減らす」 — paid on a RAID only, and only onto a base the print
    // names. A plain play pays the reduction nothing, which is the whole of what 「レイドする際」 scopes;
    // without a `raidBaseId` there is no base to check and the modifier is skipped.
    if (modifier.type === 'raidEnergyCostDelta') {
      if (raidBaseId === undefined) continue;
      // The base-side spelling is read from the base's own statics below, not from the raider's.
      if (modifier.asBase) continue;
      // 「…レイドする際、自分のリムーブエリアにカードが3枚以上ある場合、…減らす。」 — the printed
      // condition gates the reduction itself, read here where the requirement is asked.
      if (modifier.condition && !evalCondition(state, id, owner, modifier.condition)) continue;
      if (modifier.baseFilter && !definitionMatchesSubset(state, raidBaseId, state.cards[raidBaseId]?.owner ?? owner, modifier.baseFilter)) continue;
      // 「…必要エナジーの数の種類1つにつき、必要エナジーを[紫×1]減らす。」 (TKG-1-042) — the reduction
      // repeats once per printed unit of the count, read here where the requirement is asked so the
      // price tracks the discard pile.
      const units = modifier.count ? Math.floor(tierCountOf(state, owner, id, modifier.count) / (modifier.per ?? 1)) : 1;
      result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount * units);
    }
  }
  // 「自分の全ての場所にある全ての〈X〉の必要エナジーを[色]減らす」 — the broadcast discount, read from
  // the controller's *field* (the same place `handStaticsOf` reads the hand-scope broadcasts) and applied
  // wherever the card is: hand, deck or discard pile.
  for (const modifier of globalEnergyDeltas(state, id)) {
    result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
  }
  // 「…次に〈X〉が自分の場に登場するまで、手札にある〈X〉全ての必要エナジーを[色×N]減らす」 — the
  // *waiting* reduction, read off the player while the card is still in hand (the energy-axis sibling of
  // `nextUseAp`). Its period ends when the named card enters (`clearEnteredDiscounts`) or at the turn it
  // was installed for.
  for (const entry of state.players[owner].nextEnergyDiscount ?? []) {
    if (entry.expiresTurn < state.turn) continue;
    if (matchesFilter(state, id, entry.filter)) result[entry.color] = Math.max(0, (result[entry.color] ?? 0) + entry.amount);
  }
  // 「このターン中、次に手札から使用する〈对象〉の必要エナジーを[色×N]減らす」 — the waiting discount,
  // granted by a resolving ability that may already be gone. Read here where the price is asked, and
  // spent by `consumeNextUseEnergy` on the use that took it. No `sourceId` exists for the filter (the
  // same omission `getApCost` makes for `nextUseAp`), so the compiler refuses subjects carrying
  // `other`/`self`/`bound`.
  for (const entry of state.players[owner].nextUseEnergy ?? []) {
    if (entry.expiresTurn < state.turn) continue;
    if (matchesFilter(state, id, entry.filter)) result[entry.color] = Math.max(0, (result[entry.color] ?? 0) + entry.amount);
  }
  // 「このターン中、次に自分が手札からレイドさせる〈X〉の必要エナジーを[色×N]減らす」 (YYH-P-002) —
  // the raid-scoped sibling (the energy form of `nextRaidAp`): read only while a raid is being priced,
  // so a plain play of a matching card pays the full requirement.
  if (raidBaseId !== undefined) {
    for (const entry of state.players[owner].nextRaidEnergy ?? []) {
      if (entry.expiresTurn < state.turn) continue;
      if (matchesFilter(state, id, entry.filter)) result[entry.color] = Math.max(0, (result[entry.color] ?? 0) + entry.amount);
    }
    // 「このキャラに〈X〉がレイドする際、そのカードの必要エナジーを[色×N]減らす」 (AOT-2-068) — the
    // *base-side* discount: the static lives on the card being raided onto, and the printed subject
    // names the raider. Read here where the raid's price is asked, from the base's own statics.
    const baseOwner = state.cards[raidBaseId]?.owner ?? owner;
    for (const modifier of activeStatics(state, raidBaseId, baseOwner)) {
      if (modifier.type !== 'raidEnergyCostDelta' || !modifier.asBase) continue;
      if (modifier.raiderFilter && !definitionMatchesSubset(state, id, owner, modifier.raiderFilter)) continue;
      result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
    }
  }
  return result;
}



function requireEnergy(state: GameState, player: PlayerId, card: CardDefinition, cardId?: CardId, raidBaseId?: CardId): void {
  if (cardId !== undefined) {
    requireRule(energySatisfied(state, player, cardId, raidBaseId), 'INSUFFICIENT_ENERGY', '产生的能量不足以满足必要能量。');
    return;
  }
  const energy = getEnergy(state, player);
  const required = cardId !== undefined ? requiredEnergyOf(state, cardId, raidBaseId) : card.requiredEnergy;
  requireRule(COLORS.every(c => (energy[c] ?? 0) >= (required[c] ?? 0)), 'INSUFFICIENT_ENERGY', '产生的对应颜色能量不足。');
}

/**
 * 「必要エナジーを満たす」 as a yes/no question — the same comparison `requireEnergy` enforces when
 * playing a card, asked by the effect paths that gate a replacement on the requirement
 * (「公開したカードが…必要エナジーを満たす場合、手札に加える代わりに…」).
 */
export function energySatisfied(state: GameState, player: PlayerId, cardId: CardId, raidBaseId?: CardId): boolean {
  const energy = getEnergy(state, player);
  const required = requiredEnergyOf(state, cardId, raidBaseId);
  const owner = state.cards[cardId]?.owner;
  const handIgnoringColor = owner !== undefined && state.players[owner].hand.includes(cardId) && peekDefinition(state, cardId)?.ignoresEnergyColor === true;
  if (handIgnoringColor || treatedAsAllColors(state, cardId)) {
    const total = Object.values(required).reduce((sum, n) => sum + (n ?? 0), 0);
    const produced = Object.values(energy).reduce((sum, n) => sum + (n ?? 0), 0);
    return produced >= total;
  }
  return COLORS.every(c => (energy[c] ?? 0) >= (required[c] ?? 0));
}

/**
 * A freshly placed field card.
 *
 * `by` records whether the placement came from a normal play (the `play`/`raid` actions) or from an
 * effect, which is the distinction 「自分の効果で登場していた」 draws; the caller doing the placement
 * is the only thing that knows, so it is passed in rather than inferred. Cards placed by an effect
 * skip this helper entirely (see `effects.ts#applyOperation`), because only that path knows the zone
 * the card left.
 */
function newField(state: GameState, cardId: CardId, active: boolean, by: 'play' | 'effect' = 'play', raid = false, from: 'hand' | 'removal' | 'life' = 'hand', causeOwner?: PlayerId): FieldCard {
  // Ordinary play/RAID defaults to hand; a permission-backed removal-area play passes its actual origin.
  // The effect path records its own. `raid` is recorded beside `by` rather than inside it:
  // a RAID is a play, and 「レイドさせている」 has to stay askable without making every 「登場していた」
  // condition stop matching raided cards.
  return { cardId, instanceId: `${cardId}@${state.revision}`, entered: { from, by, turn: state.turn, ...(causeOwner !== undefined ? { causeOwner } : {}), ...(raid ? { raid: true } : {}) }, underneath: [], active, attacksThisTurn: 0, blocksThisTurn: 0, bpModifiers: [] };
}

/**
 * Whether an ability's condition *requires* the card to be in 場外.
 *
 * 「[場外にある場合]…退場した時」 is printed on cards whose ability works from the discard pile, and the
 * tag compiles to `atZone: 'sideline'`. Only such abilities may be collected from the sideline: an
 * ordinary ability with no condition must not fire from the discard pile, so the scan cannot simply
 * read every card there.
 */
function sidelineScoped(condition: Condition | undefined): boolean {
  if (!condition) return false;
  if (condition.type === 'atZone') return condition.zone === 'sideline';
  if (condition.type === 'all') return condition.conditions.some(sidelineScoped);
  return false;
}

/** Collects every ability keyed to `event` from the cards a player currently has on the field. */
export function collectTriggered(ctx: Context, player: PlayerId, event: TriggeredAbility['event'], onlyId?: CardId, subject?: CardId, opts?: { crossSide?: boolean; defending?: boolean; line?: Line; causeId?: CardId; eventCardId?: CardId; underStack?: CardId[]; blocker?: CardId; battle?: NonNullable<GameState['battle']>; activation?: ActivationCause }): EffectTask[] {
  const s = ctx.state;
  const tasks: EffectTask[] = [];
  // 「このターン中、相手の[ブロック時]は発動しない。」 — the other side's silence covers this player's
  // triggers of the named kinds, read from that side's player-scope statics.
  if (forbiddenTriggers(s, otherOf(player), event)) return tasks;
  for (const card of [...s.players[player].front, ...s.players[player].energy]) {
    const definition = peekDefinition(s, card.cardId);
    // The counter key is the ability's own index unless it shares a budget with a sibling (`limitKey`) —
    // the 「…時か、…時」 sentence prints one 「ターン1」 over two abilities.
    // 「元々の効果を全て失い」 — a suppressed card's *printed* watchers do not fire either (the static and
    // keyword halves are dropped in `activeStatics` / `getKeywords`).
    // 「この能力は手札にあるとき働く」 (`zone: 'hand'`) reads the hand channel below, not the field: a
    // copy that is already on the field must not raise it again (AOT-2-066/KMR-1-021 — the field scan
    // handed an entered copy a dead deploy ask every time its condition held).
    const printed: [TriggeredAbility, string][] = (effectsSuppressed(s, card.cardId) ? [] : definition?.triggered ?? [])
      .filter(ability => ability.zone !== 'hand')
      .map((ability, index) => [ability, ability.limitKey ?? String(index)]);
    // 「このキャラはこのキャラのレイド元のカードが持つ[登場時][アタック時]を全て得る。」 (SMD-1-071) — the
    // base's own printed abilities are gained while it sits in the stack. Keyed `r<i>` so their per-turn
    // counters cannot collide with the card's own abilities (the same reason grants use `g<i>`).
    const copying = activeStatics(s, card.cardId, player)
      .filter((m): m is Extract<StaticModifier, { type: 'copyRaidBaseAbilities' }> => m.type === 'copyRaidBaseAbilities');
    if (copying.length) {
      const fromBase = card.underneath
        .flatMap(base => (peekDefinition(s, base)?.triggered ?? []))
        .filter((a): a is TriggeredAbility & { event: 'onPlay' | 'onAttack' } => a.event === 'onPlay' || a.event === 'onAttack')
        .filter(a => copying.some(m => m.events.includes(a.event)));
      for (const ability of fromBase) printed.push([ability, `r${printed.length}`]);
    }
    // A granted ability is keyed under `g<i>` so its 「ターン1」 counter cannot collide with a printed
    // ability's index — the two live in the same `triggeredUsed` bag. Broadcast grants (「自分の場の赤の
    // 「〈A〉と〈B〉」全ては、「[アタック時]…」を得る。」) are read from their sources at collection time and
    // keyed `b<i>` for the same reason.
    const granted: [TriggeredAbility, string][] = [
      ...(card.grantedAbilities ?? [])
        .map((grant, index) => [grant, index] as const)
        .filter(([grant]) => grant.expiresTurn >= s.turn)
        .map(([grant, index]): [TriggeredAbility, string] => [grant.ability, `g${index}`]),
      ...grantedTriggersOf(s, card.cardId, player).map((ability, index): [TriggeredAbility, string] => [ability, `b${index}`]),
    ];
    // Provenance rides along (`printedWatcher`) so `startEffect` can re-read the suppression when the
    // task actually resolves — a printed watcher queued just before a same-frame 「効果を失う」 step
    // must stay silent once that step lands (Q1807).
    const listeners: [TriggeredAbility, string, boolean][] = [
      ...printed.map(([ability, key]): [TriggeredAbility, string, boolean] => [ability, key, true]),
      ...granted.map(([ability, key]): [TriggeredAbility, string, boolean] => [ability, key, false]),
    ];
    for (const [ability, key, fromPrinted] of listeners) {
      if (ability.event !== event) continue;
      if (event === 'onUnderToSideline' && ability.underFaceDown === true) continue;
      // 「アタックして…勝利した時」 is the attacker's; the defending winner raises only the bare spelling.
      if (opts?.defending === true && ability.attackerOnly === true) continue;
      // 「相手のフロントLのキャラが退場した時」 — a cross-table watcher is collected only by the call
      // that raises the event *for the other side*, and the ordinary own-side collection never reaches it.
      const cross = ability.scope === 'anyOfTheirs';
      if (cross !== (opts?.crossSide === true)) continue;
      // `onlyId` names the card the event is *about*; 「自分の場のキャラが…した時」 listens for any of
      // the controller's characters, so it is collected even when a different card is named.
      if (!cross && onlyId !== undefined && card.cardId !== onlyId && ability.scope !== 'anyOfMine') continue;
      // 「カード名に「ミハエル」を含むキャラが退場した時」 — a watcher may narrow *which* card the event
      // must be about. Checked against the event's card, not against the listener; 「…にブロックされた
      // 時」 names a *second* card (the blocker), which the raising call hands over as `eventCardId`.
      const eventCardId = opts?.eventCardId ?? onlyId;
      if (ability.eventCard && eventCardId !== undefined && !matchesEventCard(s, eventCardId, ability.eventCard, opts?.line, card.cardId)) continue;
      // 「自分の場の〈黎 星刻〉か〈神虎〉の効果で…場外に置いた時」 — the event's *cause* is a third card
      // identity. An ability that names one only fires when the event carries a cause (an effect's own
      // source) *of the listening player's own* — the printed 「自分の…の効果で」 — so a same-named card
      // on the other side can never open it.
      const causeId = opts?.causeId;
      if (ability.eventSource && (causeId === undefined || s.cards[causeId]?.owner !== player || !matchesEventCard(s, causeId, ability.eventSource))) continue;
      if (ability.condition && !evalCondition(s, card.cardId, player, ability.condition, {
        ...(opts?.battle ? { battle: opts.battle } : {}),
        ...(opts?.activation !== undefined ? { activation: opts.activation } : {}),
      })) continue;
      // A wholly conditional attack ability has nothing to activate while its prerequisite is false
      // (Q81/Q92). Check before reserving its budget or presenting a queue item. Keep the original `if`
      // for resolution-time rechecking; a trailing step or an else branch still makes a real task.
      const bodyGate = event === 'onAttack' && ability.effects.length === 1 && ability.effects[0]?.type === 'if'
        && !ability.effects[0].else?.length ? ability.effects[0].condition : undefined;
      if (bodyGate && !evalCondition(s, card.cardId, player, bodyGate, {
        ...(opts?.battle ? { battle: opts.battle } : {}),
        selections: { ...(subject !== undefined ? { E: [subject] } : {}), ...(causeId !== undefined ? { cause: [causeId] } : {}) },
        energySatisfied: id => energySatisfied(s, player, id),
      })) continue;
      const budgetKeys: string[] = [];
      if (ability.sharedLimit === true && ability.oncePerTurn === true) {
        const sharedKey = `t:${definition?.functionalId ?? card.cardId}:${key}`;
        if (!reserveLimitBudget(s, player, sharedKey, 'shared')) continue;
        budgetKeys.push(sharedKey);
      } else {
        const used = card.triggeredUsed?.[key] ?? 0;
        if (ability.oncePerTurn && used > 0) continue;
        const perTurnLimit = ability.limitCount ?? 1;
        const window = ability.limitTurns ?? 1;
        if ((ability.oncePerTurn || ability.limitTurns !== undefined) && used >= perTurnLimit * window) continue;
        if (ability.oncePerTurn || ability.limitTurns !== undefined || ability.limitCount !== undefined) {
          const reserveKey = `c:${fieldIdentity(card)}:${key}`;
          if (!reserveLimitBudget(s, player, reserveKey, 'card', fieldIdentity(card), key)) continue;
          budgetKeys.push(reserveKey);
        }
      }
      // 「そのキャラのレイド元のカード」 — the retiring card's stack travels with the watcher's task
      // (`underStack`), the same snapshot the card's own 退場時 ability carries.
      const task = makeTask(s, player, card.cardId, ability.effects, undefined, opts?.underStack);
      task.abilityEvent = ability.event;
      if (budgetKeys.length) task.limitBudgetKeys = budgetKeys;
      if (fromPrinted) task.printedWatcher = true;
      // The event's own subject, when it is a card the corpus says the effect may speak about
      // (「…そのカードを…」). Distinct from `onlyId`, which narrows *which listeners* the event reaches.
      // It also rides as the `E` binding, which is how an effect names the event's card in steps that
      // speak about it (「そのレイドしたキャラの下に…置く」).
      if (subject !== undefined) {
        task.eventSubject = subject;
        task.bindings = { ...(task.bindings ?? {}), E: [subject] };
      }
      // 「その〈黒崎 一護〉に、…を与える」 (BLC-2-021/046) — the watcher's *cause* card (the effect
      // source the printed 「…の効果で」 named) rides as the `cause` binding, so a grant inside the
      // body can name it the way `grantStatic target: 'cause'` does.
      if (causeId !== undefined) task.bindings = { ...(task.bindings ?? {}), cause: [causeId] };
      tasks.push(task);
    }
  }
  // 「[レイド]を持たない自分の〈ラピ〉のアタック終了時、…手札にあるこのカードをその〈ラピ〉にレイド
  // させてもよい。」 — abilities that work while the card is *in hand*. The card has no `FieldCard` to hang
  // a per-turn counter on, so the budget is keyed by functional id on the player (the same channel the
  // sideline scan uses). The event card is bound to `E` on the task, which the effect's raid reads.
  for (const id of s.players[player].hand) {
    const definition = peekDefinition(s, id);
    if (!definition?.triggered) continue;
    for (const [index, ability] of definition.triggered.entries()) {
      if (ability.event !== event || ability.zone !== 'hand') continue;
      if (ability.scope === 'anyOfTheirs' !== (opts?.crossSide === true)) continue;
      // 「そのキャラの下に裏向きのカードがあり」 — the event card's own hidden stack rides on its filter.
      // The listener's own id is handed over as well: the hand channel has no `onlyId` shortcut for the
      // printed 「このカードが…」 (the field scan's subject *is* the slot), so a subject pinned to the
      // listener itself arrives as `eventCard: { self: true }` and is checked here (SLG-1-003 族).
      if (ability.eventCard && (onlyId === undefined || !matchesEventCard(s, onlyId, ability.eventCard, opts?.line, id))) continue;
      // 「自分の…の効果で…した時」 — the event's *cause* must be one of the listening player's own cards
      // of the printed shape, read the same way the field scan reads it.
      if (ability.eventSource && (opts?.causeId === undefined || s.cards[opts.causeId]?.owner !== player || !matchesEventCard(s, opts.causeId, ability.eventSource, opts?.line))) continue;
      if (ability.condition && !evalCondition(s, id, player, ability.condition)) continue;
      // 「このカードの必要エナジーを満たしている場合」 — the hand card's own requirement.
      if (ability.handGate === 'energySatisfied' && !energySatisfied(s, player, id)) continue;
      const key = `${definition.functionalId}:${index}`;
      let handBudget: string[] | undefined;
      if (ability.oncePerTurn) {
        const budgetKey = ability.sharedLimit === true ? `t:${definition.functionalId}:${ability.limitKey ?? index}` : `h:${key}`;
        const ok = ability.sharedLimit === true
          ? reserveLimitBudget(s, player, budgetKey, 'shared')
          : reserveLimitBudget(s, player, budgetKey, 'hand', key);
        if (!ok) continue;
        handBudget = [budgetKey];
      }
      const task = makeTask(s, player, id, ability.effects);
      if (handBudget) task.limitBudgetKeys = handBudget;
      if (onlyId !== undefined) {
        task.eventSubject = onlyId;
        task.bindings = { ...(task.bindings ?? {}), E: [onlyId] };
      }
      // 「〈水篠 旬〉の効果で場外から手札に加わった場合、…に代わる。」 (SLG-1-011) — the raising effect's
      // source rides as the `cause` binding, exactly as the watcher path binds it for
      // 「その〈X〉に、…を与える」.
      if (opts?.causeId !== undefined) task.bindings = { ...(task.bindings ?? {}), cause: [opts.causeId] };
      tasks.push(task);
    }
  }
  // 「[場外にある場合]…」 — abilities that work while the card is in the discard pile. A card there has no
  // `FieldCard` to hang a per-turn counter on, and the printed limit is per *card* rather than per copy
  // (the コアメダル ruling says two copies may not both fire), so the counter is keyed by functional id:
  // 「〈スナイパーライフル〉のこの効果は1ターンに1回のみ発動できる。」
  for (const id of s.players[player].sideline) {
    const definition = peekDefinition(s, id);
    if (!definition?.triggered) continue;
    for (const [index, ability] of definition.triggered.entries()) {
      if (ability.event !== event) continue;
      if (!sidelineScoped(ability.condition)) continue;
      // 「このカードが自分の緑のカードの効果で手札から場外に置かれた時、…」 — the *cause* the printed
      // wording narrows, read the same way the field scan reads it: the resolving effect's own source
      // card, which must be this player's own (「自分の…の効果で」).
      if (ability.eventSource && (opts?.causeId === undefined || s.cards[opts.causeId]?.owner !== player || !matchesEventCard(s, opts.causeId, ability.eventSource))) continue;
      // 「このカードが…手札から場外に置かれた時、…」 — a card listening for its *own* discard names no
      // `eventCard` (the subject is itself), and the event's subject (`onlyId`) is exactly this card;
      // that is the one case a scoped ability with no `eventCard` can answer. Every other subject
      // still requires an `eventCard` match.
      if (onlyId !== undefined && !ability.eventCard && onlyId !== id) continue;
      if (ability.eventCard && (onlyId === undefined || !matchesEventCard(s, onlyId, ability.eventCard))) continue;
      if (ability.condition && !evalCondition(s, id, player, ability.condition)) continue;
      const key = `${definition.functionalId}:${index}`;
      let pileBudget: string[] | undefined;
      if (ability.oncePerTurn) {
        const budgetKey = ability.sharedLimit === true ? `t:${definition.functionalId}:${ability.limitKey ?? index}` : `s:${key}`;
        const ok = ability.sharedLimit === true
          ? reserveLimitBudget(s, player, budgetKey, 'shared')
          : reserveLimitBudget(s, player, budgetKey, 'sideline', key);
        if (!ok) continue;
        pileBudget = [budgetKey];
      }
      // The task names the sideline card as its source, so 「場外のこのカードを手札に加えてもよい」 speaks
      // about the right card.
      const task = makeTask(s, player, id, ability.effects);
      if (pileBudget) task.limitBudgetKeys = pileBudget;
      // 「その〈黒崎 一護〉に、…を与える」 (BLC-2-046) — the watcher's cause card rides as the `cause`
      // binding, the same one the field, hand and arrival scans write; without it a
      // `grantStatic target: 'cause'` body resolved to nothing.
      if (opts?.causeId !== undefined) task.bindings = { ...(task.bindings ?? {}), cause: [opts.causeId] };
      tasks.push(task);
    }
  }
  // 「このカードが手札から場外に置かれた時、…」 — an ability on the *discarded card itself*. It is in
  // 場外 by the time the event is raised, so the field scan above cannot see it; collected only when the
  // event names this very card (`onlyId`), so no other card in the pile answers for it. The per-turn
  // budget needs the same functional-id key the sibling scan uses — the card has no `FieldCard` here.
  if (onlyId !== undefined) {
    const definition = peekDefinition(s, onlyId);
    const arrivedInSideline = s.players[player].sideline.includes(onlyId);
    const arrivedInRemoval = s.players[player].removal.includes(onlyId);
    if (definition?.triggered && (arrivedInSideline || arrivedInRemoval)) {
      for (const [index, ability] of definition.triggered.entries()) {
        // The scan answers for the "card arrived" watchers: the hand-discard one and the deck-mill one
        // (「このカードが自分の効果で自分の山札から場外に置かれた時」), and the removal arrival
        // (「このカードが…リムーブエリアに置かれた時」). Each answers only for its own destination —
        // a card that was redirected to 場外 is not 「リムーブエリアに置かれた」.
        if (ability.event !== event) continue;
        if (ability.event === 'onRemoved') { if (!arrivedInRemoval) continue; }
        else if (ability.event === 'onDiscardedFromHand' || ability.event === 'onMilled' || ability.event === 'onLifeToSideline') { if (!arrivedInSideline) continue; }
        else continue;
        if (ability.scope === 'anyOfTheirs') continue;
        // An ability whose condition routes it through the sideline-scoped scan above is already
        // collected there; collecting it again here would fire it twice for one card.
        if (sidelineScoped(ability.condition)) continue;
        // The cause filter reads the same way it does in the sibling scans.
        if (ability.eventSource && (opts?.causeId === undefined || s.cards[opts.causeId]?.owner !== player || !matchesEventCard(s, opts.causeId, ability.eventSource))) continue;
        if (ability.condition && !evalCondition(s, onlyId, player, ability.condition)) continue;
        const key = `${definition.functionalId}:${index}`;
        let pileBudget: string[] | undefined;
        if (ability.oncePerTurn) {
          const budgetKey = ability.sharedLimit === true ? `t:${definition.functionalId}:${ability.limitKey ?? index}` : `s:${key}`;
          const ok = ability.sharedLimit === true
            ? reserveLimitBudget(s, player, budgetKey, 'shared')
            : reserveLimitBudget(s, player, budgetKey, 'sideline', key);
          if (!ok) continue;
          pileBudget = [budgetKey];
        }
        const task = makeTask(s, player, onlyId, ability.effects);
        task.abilityEvent = ability.event;
        if (pileBudget) task.limitBudgetKeys = pileBudget;
        // The watcher's cause, for 「その〈X〉に、…を与える」 bodies — the same binding the field scan
        // above writes.
        if (opts?.causeId !== undefined) task.bindings = { ...(task.bindings ?? {}), cause: [opts.causeId] };
        tasks.push(task);
      }
    }
  }
  // 「自分はこのターン中、「自分のキャラがレイドした時、カードを1枚まで引く。」を得る」 — a trigger an
  // effect installed on the *player* (`PlayerState.grantedAbilities`). It fires for whichever of their
  // cards raised the event, so it is collected here rather than from a field card. The event's own card
  // becomes the task's source, which is what 「このキャラ」 would name if the granted body printed one.
  if (onlyId !== undefined) {
    for (const grant of s.players[player].grantedAbilities ?? []) {
      if (grant.expiresTurn < s.turn) continue;
      for (const ability of grant.abilities) {
        if (ability.event !== event) continue;
        if (ability.scope === 'anyOfTheirs') continue;
        if (ability.eventCard && !matchesEventCard(s, onlyId, ability.eventCard, opts?.line)) continue;
        if (ability.condition && !evalCondition(s, onlyId, player, ability.condition)) continue;
        tasks.push(makeTask(s, player, onlyId, ability.effects));
      }
    }
  }
  // The battle's blocker rides on every task raised by this event, so a 「このキャラをブロックしたキャラ」
  // reading (`'blocker'` zone) still finds it after `endBattle` has cleared the open battle.
  for (const task of tasks) {
    const blocker = opts?.blocker ?? opts?.battle?.blockerId;
    if (blocker !== undefined) task.battleBlocker = blocker;
    if (opts?.battle !== undefined) task.battleSnapshot = structuredClone(opts.battle);
  }
  return tasks;
}

/**
 * Own material-arrival watchers. Face-down cards are the default; face-up RAID bases may also listen
 * through an unqualified 「このカードが場外に置かれた時」 ability, but never through a face-down-only one.
 *
 * A face-down card under a host has no `FieldCard` slot, so the field walk in `collectTriggered` can
 * never reach it; the ability is read off the departed card's own definition. Its per-turn budget lives
 * on the player (`PlayerState.underTriggeredUsed`, cleared with the turn) for the same reason a
 * sideline card's does.
 */
export function collectHiddenWatchers(ctx: Context, player: PlayerId, hiddenId: CardId, faceDown = true): EffectTask[] {
  const s = ctx.state;
  const definition = peekDefinition(s, hiddenId);
  const tasks: EffectTask[] = [];
  for (const [index, ability] of (definition?.triggered ?? []).entries()) {
    if (ability.event !== 'onUnderToSideline' || ability.zone !== undefined) continue;
    if (ability.underFaceDown === true && !faceDown) continue;
    if (ability.condition && !evalCondition(s, hiddenId, player, ability.condition)) continue;
    const key = `${definition!.functionalId}:${index}`;
    let underBudget: string[] | undefined;
    if (ability.oncePerTurn) {
      const budgetKey = ability.sharedLimit === true ? `t:${definition!.functionalId}:${ability.limitKey ?? index}` : `u:${key}`;
      const ok = ability.sharedLimit === true
        ? reserveLimitBudget(s, player, budgetKey, 'shared')
        : reserveLimitBudget(s, player, budgetKey, 'under', key);
      if (!ok) continue;
      underBudget = [budgetKey];
    }
    const task = makeTask(s, player, hiddenId, ability.effects);
    task.abilityEvent = 'onUnderToSideline';
    if (underBudget) task.limitBudgetKeys = underBudget;
    tasks.push(task);
  }
  return tasks;
}

/** The statics an effect installed on a field card, filtered to the ones still in force. */
export function grantedStaticsOf(state: GameState, card: FieldCard): StaticAbility[] {
  const out: StaticAbility[] = [];
  for (const grant of card.grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    // 「自分のフロントLにこのキャラがあるかぎり」 — the grant lives exactly as long as the card the
    // printed sentence names stays on the field (and on the printed line, when it names one).
    if (grant.sourceId !== undefined) {
      const owner = state.cards[grant.sourceId]?.owner;
      const here = owner === undefined ? undefined : findField(state, owner, grant.sourceId);
      if (!here) continue;
      if (grant.sourceLine !== undefined && here.line !== grant.sourceLine) continue;
    }
    out.push(...grant.abilities);
  }
  return out;
}

/**
 * 「このキャラはBPN以下のキャラにブロックされない。」 — the attacking card's standing refusals against
 * a candidate blocker, read the way `block()` reads them (`evadeModifiers`, `staticEvade`,
 * `staticEvadeAtLeast`, `staticBlockerFilters`) so a "a legal blocker exists" question never counts a
 * card the block action itself would turn away — a demanded block with no *legal* taker must stay
 * declinable, not deadlock the window.
 */
function attackerRefusesBlocker(s: GameState, attackerId: CardId, blockerId: CardId, bp: number): boolean {
  const owner = s.cards[attackerId]?.owner;
  if (owner === undefined) return false;
  const attacker = findField(s, owner, attackerId)?.card;
  if ((attacker?.evadeModifiers ?? []).some(m => m.expiresTurn >= s.turn && bp <= m.maxBP)) return true;
  const evade = staticEvade(s, attackerId, owner);
  if (evade !== undefined && bp <= evade) return true;
  const atLeast = staticEvadeAtLeast(s, attackerId, owner);
  if (atLeast !== undefined && bp >= atLeast) return true;
  return staticBlockerFilters(s, attackerId, owner).some(f => matchesFilter(s, blockerId, f, attackerId));
}

/**
 * Whether `c` may legally take the block for the decision now open — the same facts `block()` requires,
 * read here so every "a legal blocker exists" question (the mandatory flag, the ceiling rule) counts the
 * 「最初のアタックをブロックできない」 refusal the way the actual choice does.
 */
function legalBlockerNow(s: GameState, c: FieldCard, player: PlayerId): boolean {
  if (!c.active) return false;
  const forbids = staticForbids(s, c.cardId, player);
  if (forbids.block) return false;
  if (forbids.blockFirstAttack && (s.turnEvents ?? []).filter(entry => entry.event === 'attacked').length <= 1) return false;
  return s.battle == null || !attackerRefusesBlocker(s, s.battle.attackerId, c.cardId, getBP(s, c));
}

export function applyQueueResume(ctx: Context, resume: QueueResume, defenderId?: CardId, damageCount?: number): void {
  const s = ctx.state;
  if (resume === 'attackDeclare') { continueAttack(ctx); return; }
  if (resume === 'unblockedDamage') {
    // 「このキャラはこのアタックでダメージを与えず」 (SYN-P-002) — the attacker's watcher waived the
    // unblocked damage; the battle still closes.
    if (s.battle?.noDamage) { endBattle(ctx); return; }
    damage(ctx, damageCount ?? 1);
    return;
  }
  if (resume === 'block' && s.battle) {
    // The attacker may have left the field while the queue resolved — its own 「[アタック時]…この
    // キャラを退場させる」 effect (IMC-1-043/KMR-1-070): the attack is over, so the battle closes here
    // instead of opening a block window whose every answer reads the missing attacker (round-102B E-2:
    // the non-null assertion crashed the UI smoke deterministically).
    if (!findField(s, s.battle.attacker, s.battle.attackerId)) { endBattle(ctx); return; }
    // The attack pair's second stage: raised here when the attacker's own アタック時 batch kept the
    // stage to itself (the batch just drained — this resume is where the queue came back to).
    if (raiseOpponentAttack(ctx, 'block', defenderId)) return;
    // 「相手はこのキャラのアタックを可能ならブロックしなければならない。」 forces the decision; the
    // defender still picks *which* character blocks. Computed here rather than at the attack site so
    // every route into the block step (attack, queue resume) sees the same flag.
    const demand = staticForbids(s, s.battle.attackerId, s.battle.attacker);
    // 「可能なら[BPN以下のキャラで]ブロックしなければならない」 — the obligation only holds while a legal
    // blocker within the printed ceiling exists; without one the attack may be declined as normal. The
    // 001 floor and the 016 first-attack narrowing clip the same obligation from the other side.
    const attackerSlot = findField(s, s.battle.attacker, s.battle.attackerId);
    const floor = demand.mustBlockOverSelf && attackerSlot ? getBP(s, attackerSlot.card) : undefined;
    // 「相手はこのキャラの1回目のアタックを可能ならブロックしなければならない。」 (KJN-1-016, Q2116) —
    // the narrowing counts *this attacker's* attacks, not the turn's: another character's attack must
    // not spend the one mandatory block the print grants this card's first attack.
    const demandAttackerId = s.battle.attackerId;
    const firstOnly = demand.mustBlockFirstAttack
      && (s.turnEvents ?? []).filter(entry => entry.event === 'attacked' && entry.cardId === demandAttackerId).length > 1;
    const mandatory = demand.mustBeBlocked && !firstOnly
      && s.players[s.battle.defender].front.some(c => legalBlockerNow(s, c, s.battle!.defender)
        && (demand.mustBlockCeiling === undefined || getBP(s, c) <= demand.mustBlockCeiling)
        && (floor === undefined || getBP(s, c) > floor));
    // 「選んだ相手のキャラはこのターン中、選んだ〈X〉のアタックを可能ならブロックしなければならない。」
    // (KGR-1-069) — the demand that sits on the *blocker*, naming the attacker: while such a card exists
    // and can legally block, it must be the blocker, which is the single-blocker restriction `blockOnly`
    // writes plus the mandatory flag above. A card that cannot legally block does not open the demand.
    const attackerNames = effectiveNames(s, s.battle.attackerId, s.battle.attacker);
    // 「このキャラは、相手の〈X〉のアタックを可能ならブロックしなければならない。」 (CGD-1-069) — the
    // *standing* spelling of the same demand: a granted/printed `mustBlockAttacker` static on the
    // defender's card obliges it exactly like the runtime record beside it. The mandatory flag turns on
    // while one of the obliged cards can legally block; *which* of several obliged cards takes the
    // block is the blocking player's choice (Q1381), which `block`'s own conditional refusal leaves
    // open — a card carrying no matching demand cannot step in instead.
    const obligedBlocker = (card: FieldCard): boolean =>
      (card.mustBlockAttacker ?? []).some(record => record.expiresTurn >= s.turn
        && record.names.some(name => attackerNames.includes(name)))
      || activeStatics(s, card.cardId, s.battle!.defender).some(m => m.type === 'mustBlockAttacker'
        && (m.names === undefined || m.names.some(name => attackerNames.includes(name))));
    const designated = s.players[s.battle.defender].front.some(c => legalBlockerNow(s, c, s.battle!.defender) && obligedBlocker(c));
    s.pending = { type: 'block', player: otherOf(s.battle.attacker), ...(mandatory || designated ? { mandatory: true } : {}) };
    return;
  }
  if (resume === 'compare' && s.battle) {
    if (defenderId === undefined) { endBattle(ctx); return; }
    if (raiseOpponentAttack(ctx, 'compare', defenderId)) return;
    if (raiseBlocked(ctx, 'compare', defenderId)) return;
    if (!findField(s, s.battle.defender, defenderId)
      || !findField(s, s.battle.attacker, s.battle.attackerId)) { endBattle(ctx); return; }
    // 「アタックしてブロックされなかった時」 — a 狙い撃ち-declared attack (Q931) never opens a block
    // window, so the decline route that carries the ordinary attack's unblocked moment is never
    // reached for it. Raised here instead, after the attack's own triggers have resolved and before
    // the comparison; the queue jumps back into this same branch once the watchers finish, which is
    // what the battle-scoped flag keeps from raising a second time.
    if (s.battle.targetId !== undefined && s.battle.unblockedRaised !== true) {
      s.battle.unblockedRaised = true;
      if (raiseQueue(ctx, s.battle.attacker, 'onUnblockedAttack', 'compare', defenderId, s.battle.attackerId)) return;
    }
    // All watcher batches are done: the owed 「ブロックした時アクティブにする」 resolves now, so a
    // charge that landed with them has negated it (Q428).
    finishDoubleBlockReactivate(ctx);
    compareBattle(ctx, defenderId); return;
  }
  // The battle's tail, run once the win triggers have resolved. Everything is re-read from the battle
  // that is still open: the queue may have removed either card, and the impact of the attacker is read
  // from the card as it stands (a trigger may have changed it).
  if (resume === 'battleWin' && s.battle) {
    const attacker = findField(s, s.battle.attacker, s.battle.attackerId);
    if (defenderId === undefined) { endBattle(ctx); return; }
    const defenderPresent = findField(s, s.battle.defender, defenderId) !== undefined;
    // A missing defender is either the queue removing it (the battle is over) or a 类BG replacement
    // already sent it before the queue (MCR-1-080 family) — the pre-applied flag tells them apart, and
    // in the latter reading the impact and the close still run.
    if (!defenderPresent && s.battle.loserSent !== true) { endBattle(ctx); return; }
    // The attacker left the field while the queue resolved: the battle cannot continue from it.
    if (!attacker) { endBattle(ctx); return; }
    // 「相手の[インパクト無効]は発動しない。」 — the defender's opponent may forbid the keyword, which
    // reads as absent where it would apply.
    // 「このキャラとバトルをしたキャラはこのバトル中、[インパクト無効]を失う。」 (BCV-1-004) — the
    // attacker is the defender's counterpart in this battle, so its static strips the keyword.
    const negate = getKeywords(s, defenderId).impactNegate
      && !forbiddenKeyword(s, otherOf(s.cards[defenderId]?.owner ?? 0), 'impactNegate')
      && !battleOpponentStripsKeyword(s, s.battle.attackerId, 'impactNegate');
    const impact = getImpact(s, attacker.card);
    // A bought-off departure (BLC-2-067) parks the battle; the answer handler runs this tail again.
    // A defender already sent with the ① step has nothing left to send.
    if (defenderPresent && s.battle.loserSent !== true && sendBattleLoser(ctx, s.battle, defenderId)) return;
    if (impact && !negate) { damage(ctx, impact); return; }
    endBattle(ctx);
    return;
  }
  if (resume === 'battleLose' && s.battle) { endBattle(ctx); return; }
  if (resume === 'mainEnd') {
    s.phase = 'attack';
    emit(ctx, 'phaseChanged', { phase: s.phase });
    if (raiseQueue(ctx, s.activePlayer, 'onAttackPhaseStart', 'attackPhaseStart')) return;
    if (raiseQueue(ctx, otherOf(s.activePlayer), 'onAttackPhaseStart', 'attackPhaseStartOpponent')) return;
    // The delayed 「このターンのアタックフェイズ開始時」 instructions settle *after* the printed watchers
    // of the same moment (the order `delayMainEnd` already uses: printed abilities first, then the
    // instructions this turn's effects parked). They join one queue even when both sides parked some.
    // Resuming at `none` is enough: the phase is already open by the time they resolve.
    raiseDelayedAttack(ctx, 'start', 'none');
    return;
  }
  if (resume === 'attackPhaseStart') {
    if (raiseQueue(ctx, otherOf(s.activePlayer), 'onAttackPhaseStart', 'attackPhaseStartOpponent')) return;
    raiseDelayedAttack(ctx, 'start', 'none');
    return;
  }
  if (resume === 'attackPhaseStartOpponent') { raiseDelayedAttack(ctx, 'start', 'none'); return; }
  if (resume === 'attackEnd') {
    // The attacking player's 「アタックフェイズ終了時」 abilities resolve first (turn-player order), then
    // the defending player's, and only then does the phase close. Both sides listen to the same moment:
    // 「自分の」 is gated by `turnOf self` and 「相手の」 by `turnOf opponent`, which is what tells them
    // apart now that the event is raised for both players.
    const active = s.activePlayer;
    if (raiseQueue(ctx, otherOf(active), 'onAttackPhaseEnd', 'attackEndOpponent')) return;
    // Same order as the phase's opening: the printed watchers first, then this turn's delayed
    // 「このターンのアタックフェイズ終了時」 instructions. They resume through `attackEndOpponent`,
    // which has already consumed them, so its second pass closes the phase.
    if (raiseDelayedAttack(ctx, 'end', 'attackEndOpponent')) return;
    endAttackPhase(ctx, active);
    emit(ctx, 'phaseChanged', { phase: s.phase });
    return;
  }
  if (resume === 'attackEndOpponent') {
    if (raiseDelayedAttack(ctx, 'end', 'attackEndOpponent')) return;
    endAttackPhase(ctx, s.activePlayer);
    emit(ctx, 'phaseChanged', { phase: s.phase });
    return;
  }
}

/** Raises the queue if any ability listens for `event`; returns true when play must pause. */
function raiseQueue(ctx: Context, player: PlayerId, event: TriggeredAbility['event'], resume: QueueResume, defenderId?: CardId, onlyId?: CardId, damageCount?: number, opts?: { eventCardId?: CardId; subject?: CardId; blocker?: CardId; battle?: NonNullable<GameState['battle']> }): boolean {
  const tasks = collectTriggered(ctx, player, event, onlyId, opts?.subject, opts);
  if (!tasks.length) return false;
  const pending = ctx.state.pending;
  if (pending?.type === 'queue') {
    const ids = new Set(pending.effects.map(task => task.id));
    for (const task of tasks) {
      if (ids.has(task.id)) task.id = `${task.id}:${event}:${pending.effects.length}`;
      ids.add(task.id); pending.effects.push(task);
    }
    pending.player = pending.effects[0]!.player;
  } else {
    ctx.state.pending = { type: 'queue', player: tasks[0]!.player, effects: tasks, resume, ...(defenderId !== undefined ? { defenderId } : {}), ...(damageCount !== undefined ? { damageCount } : {}) };
  }
  return true;
}

/**
 * Takes this turn's 「このターンのアタックフェイズ開始時/終了時」 instructions off both players' parking
 * lists, in the order the printed watchers are raised (turn player first, then the other side).
 *
 * Both sides are read because the printed 「このターン」 is the *turn's* moment, not the creator's: AOT-1-006
 * deployed by an effect during the opponent's turn names that opponent turn's attack phase (the literal
 * reading this round adopts). Every entry is turn-stamped, so an instruction parked in an earlier turn can
 * never fire here; the moment consumes its entries once (`beginTurn` drops anything left over).
 * `makeTask` is built from the entry alone, so the source need not still be on the field (KGD-1-037).
 */
function takeDelayedAttack(s: GameState, moment: 'start' | 'end'): EffectTask[] {
  const tasks: EffectTask[] = [];
  for (const side of [s.activePlayer, otherOf(s.activePlayer)] as const) {
    const p = s.players[side];
    const parked = (moment === 'start' ? p.delayedAttackStart : p.delayedAttackEnd) ?? [];
    const firing = parked.filter(entry => entry.turn === s.turn);
    if (moment === 'start') p.delayedAttackStart = [];
    else p.delayedAttackEnd = [];
    for (const entry of firing) tasks.push(makeTask(s, side, entry.sourceId, entry.steps));
  }
  return tasks;
}

/**
 * Stages the parked attack-phase instructions; returns true when play must pause for them.
 *
 * Called *after* the printed watchers' raise for the same moment (the order `delayMainEnd` uses: printed
 * abilities first, then the delayed instructions in one queue) and before the phase actually opens/closes.
 */
function raiseDelayedAttack(ctx: Context, moment: 'start' | 'end', resume: QueueResume): boolean {
  const tasks = takeDelayedAttack(ctx.state, moment);
  if (!tasks.length) return false;
  const pending = ctx.state.pending;
  if (pending?.type === 'queue') pending.effects.push(...tasks);
  else ctx.state.pending = { type: 'queue', player: tasks[0]!.player, effects: tasks, resume };
  return true;
}

/**
 * 「このキャラとのバトルによって退場したキャラの[退場時]は発動しない。」 — whether an open battle's *other*
 * participant silences this card's own 退場時 watchers.
 *
 * The battle is still on the state when its loser leaves, and the printed subject names the card that
 * fought the silencing character, so only the two participants are consulted — the attacker and whichever
 * card took the defence (the blocker, or the attack's declared target).
 */
function battleSilencesLoserAbilities(s: GameState, loserId: CardId): boolean {
  const battle = s.battle;
  if (!battle) return false;
  const others = [battle.attackerId, battle.blockerId ?? battle.targetId]
    .filter((id): id is CardId => id !== undefined && id !== loserId);
  return others.some(id => {
    const owner = s.cards[id]?.owner;
    return owner !== undefined && activeStatics(s, id, owner).some(m => m.type === 'forbidBattleLoserAbilities');
  });
}

/** The controller's own 「[退場時]」 gate (GNT-1-036/057), if any of their field cards currently holds one. */
function ownRetireTriggerGate(s: GameState, player: PlayerId): Extract<StaticModifier, { type: 'retireTriggerGate' }> | undefined {
  for (const line of ['front', 'energy'] as const) {
    for (const card of s.players[player][line]) {
      const found = activeStatics(s, card.cardId, player)
        .find((m): m is Extract<StaticModifier, { type: 'retireTriggerGate' }> => m.type === 'retireTriggerGate');
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 「…かぎり」 grants die with their source's presence — *permanently*.
 *
 * The print reads 「このキャラがフロントLを離れるまで」 / 「自分のフロントLにこのキャラがあるかぎり」, so
 * the moment the named card leaves the named line (or the field) the grant is over for good — the very
 * same card moving back does not revive it (Q933/Q934). The read side re-checks the source's location
 * on every read (`ownAbilities`), which alone would let a returning card light the grant back up; this
 * is the write side that ends it. An unqualified grant (`sourceLine` absent) survives a move between
 * lines and only ends when the source leaves the field — pass `leftLine` undefined for that exit, or
 * the line the source just left for a move.
 */
export function expireWhileSourceGrants(state: GameState, sourceId: CardId, leftLine?: Line): void {
  for (const owner of [0, 1] as const) {
    for (const line of ['front', 'energy'] as const) {
      for (const slot of state.players[owner][line]) {
        const grants = slot.grantedStatics;
        if (!grants?.length) continue;
        const kept = grants.filter(grant => grant.sourceId !== sourceId || (leftLine !== undefined && grant.sourceLine !== leftLine));
        if (kept.length !== grants.length) slot.grantedStatics = kept;
      }
    }
  }
}

type DepartureAnswer = Extract<CardEffect, { type: 'departureAnswer' }>['destination'];

class DepartureChoice extends Error {
  readonly player: PlayerId;
  readonly cardId: CardId;
  readonly alternative: Exclude<DepartureAnswer, 'original'>;
  /** The price's display name when the alternative is `'pay'`, shown beside the printed departure. */
  readonly label?: string;
  readonly offer?: LeavePayment;
  readonly candidates?: CardId[];
  constructor(player: PlayerId, cardId: CardId, alternative: Exclude<DepartureAnswer, 'original'> = 'removal', label?: string, offer?: LeavePayment, candidates?: CardId[]) {
    super('optional departure replacement'); this.player=player; this.cardId=cardId; this.alternative=alternative;
    if (label !== undefined) this.label = label;
    if (offer !== undefined) this.offer = offer;
    if (candidates !== undefined) this.candidates = candidates;
  }
}

type LeavePayment = {
  price: 'under' | 'hand' | 'life' | 'base' | 'top' | 'rest' | 'retireSelf';
  count: number;
  label: string;
  /** The paying card of a protector form (the carrier for `rest` / `retireSelf`). */
  carrierId?: CardId;
  /** The printed 「そうした場合、…」 follow-up this offer runs on the saved card. */
  follow?: 'peel' | 'rest' | 'moveEnergy';
  /**
   * 「そうした場合、カードを1枚引く」 (ARK-1-059) — how many cards the saved card's owner draws once the
   * price is accepted. The draw belongs to the *protecting* card's controller, which may be the opponent
   * of the frame that owns the departure (user ruling: the follow-up settles on the saved card's owner).
   */
  followDraw?: number;
};

/**
 * The leave reasons an *effect* drives, as `leaveField` records them. Shared by its own cause bookkeeping
 * (`retireCauseId`) and by `leaveCauseFails`, so the funnel's 「この効果で」 reading cannot drift from the
 * one the exit itself spends.
 */
const EFFECT_LEAVE_REASONS: ReadonlySet<string> = new Set(['card-effect', 'effect-deck', 'effect-return', 'effect-life', 'leave-redirect', 'effect-under']);

/**
 * Whether a `retireSubstitute` cause accepts this departure, read the way `effects.ts#retireCauseFails`
 * reads it: a battle defeat satisfies 「バトル」 alone, and a rule's own leave (BP check, full line, the
 * end-phase schedules) is never 「相手の効果」 — so an unqualified or opponent-scoped cause fails there.
 */
function leaveCauseFails(s: GameState, owner: PlayerId, cause: Extract<StaticModifier, { type: 'retireSubstitute' }>['cause'], reason: string, triggerCauseId?: CardId): boolean {
  if (cause === undefined) return false;
  // 「BPが0以下になること以外で」 is the retirement qualifier; it does not turn a BP check into a leave.
  if (cause === 'notBpZero') return reason === 'bp-zero';
  const battle = reason === 'battle' || reason === 'battle-overflow';
  let effectPlayer: PlayerId | undefined;
  let trigger = false;
  let route: 'characterEffect' | 'eventEffect' | 'trigger' = 'characterEffect';
  const frame = s.effect;
  if (reason === 'special-trigger') {
    // A life card's SPECIAL trigger resolves without a frame; its owner is the causing player, and the
    // resolution itself is 「相手のトリガーの効果で」.
    effectPlayer = triggerCauseId !== undefined ? s.cards[triggerCauseId]?.owner : otherOf(owner);
    trigger = true; route = 'trigger';
  } else if (frame) {
    effectPlayer = frame.player;
    trigger = frame.route === 'trigger';
    route = frame.route ?? (peekDefinition(s, frame.sourceId)?.kind === 'event' ? 'eventEffect' : 'characterEffect');
  } else {
    effectPlayer = owner;
  }
  if (cause === 'opponentEffect') return battle || effectPlayer === owner;
  if (cause === 'opponentTrigger') return battle || effectPlayer === owner || !trigger;
  if (cause === 'opponentEventEffect') return battle || effectPlayer === owner || route !== 'eventEffect';
  if (cause === 'anyEffect') return !(reason === 'special-trigger' || EFFECT_LEAVE_REASONS.has(reason));
  // 「相手の効果やバトルによって」 (BLC-2-067): the effect route keeps the opponent test; a battle always
  // qualifies.
  return !battle && effectPlayer === owner;
}

/**
 * The follow-up the accepted price prints, limited to the three board moves the printed family carries.
 * 「そうした場合、…」 follows every price shape (`retireSubstitute.follow`), so each return below spreads it.
 */
function leaveFollow(m: Extract<StaticModifier, { type: 'retireSubstitute' }>): 'peel' | 'rest' | 'moveEnergy' | undefined {
  for (const step of m.follow ?? []) {
    if (step.type !== 'act' && step.type !== 'actSource') continue;
    if (step.operation === 'topToSideline') return 'peel';
    if (step.operation === 'rest') return 'rest';
    if (step.operation === 'move') return 'moveEnergy';
  }
  return undefined;
}

/**
 * 「そうした場合、カードを1枚引く」 (ARK-1-059) — the draw a follow-up prints. The frame-less shapes the
 * exit can run are the ones a price's own sentence carries; `draw` is the only one that targets a player,
 * and it targets the saved card's owner (see `LeavePayment.followDraw`).
 */
function leaveFollowDraw(m: Extract<StaticModifier, { type: 'retireSubstitute' }>): number | undefined {
  let total = 0;
  for (const step of m.follow ?? []) if (step.type === 'draw') total += step.count;
  return total > 0 ? total : undefined;
}

/** The price this departure may be bought off with, or `undefined` when the printed offer does not apply. */
function leavePaymentOffer(ctx: Context, player: PlayerId, cardId: CardId, destination: 'sideline' | 'removal' | 'hand' | 'deckBottom', reason: string, triggerCauseId?: CardId, offerLeavePrice = false): LeavePayment | undefined {
  const s = ctx.state;
  const here = findField(s, player, cardId);
  if (!here) return undefined;
  // A peeled raid top is 「退場でも登場でもない」 (Q544), a redirect already replaced this departure, and a
  // substitute's own retirement must not be substituted again.
  if (reason === 'raid-top' || reason === 'leave-redirect' || reason === 'retire-substitute') return undefined;
  if (reason === 'card-effect' && destination === 'sideline' && !offerLeavePrice) return undefined;
  const retiring = destination === 'sideline';
  const covers = (modifier: Extract<StaticModifier, { type: 'retireSubstitute' }>): boolean =>
    modifier.leave === true || retiring;
  const p = s.players[player];
  const battle = reason === 'battle';
  const causeFails = (cause: Extract<StaticModifier, { type: 'retireSubstitute' }>['cause']): boolean =>
    leaveCauseFails(s, player, cause, reason, triggerCauseId);
  const { card } = here;
  // 「このキャラが…」 — the carrier's own prices. A `filter` names the *protected* cards of a protector
  // form (MSS-1-034 also carries `hand`, ARK-1-059 names 「このキャラか自分のエナジーLのキャラ」), so a
  // filtered modifier is read by the field-wide scan below — but its *own* prices still answer for
  // itself, the same way `effects.ts#retireCostSubstitute` reads the carrier's own stack.
  for (const modifier of activeStatics(s, cardId, player)) {
    if (modifier.type !== 'retireSubstitute' || !covers(modifier)) continue;
    if (causeFails(modifier.cause)) continue;
    const follow = leaveFollow(modifier);
    const followDraw = leaveFollowDraw(modifier);
    const followPart = { ...(follow !== undefined ? { follow } : {}), ...(followDraw !== undefined ? { followDraw } : {}) };
    if (modifier.under !== undefined && (card.faceDown?.length ?? 0) >= modifier.under) {
      if (!spendReplacementUse(s, cardId, player, modifier)) continue;
      return { price: 'under', count: modifier.under, label: `支付此卡下方 ${modifier.under} 张里侧卡后留下`, ...followPart };
    }
    if (modifier.hand !== undefined && p.hand.length >= (modifier.minHand ?? modifier.hand)) {
      // A hand price whose follow-up peels the raid top needs the stack the printed sentence speaks about.
      if (follow === 'peel' && card.underneath.length === 0) continue;
      // The battle-loss question already asked this hand price (`sendBattleLoser`); a second one at the
      // exit would double-ask. Every other price shape is offered here.
      if (battle) continue;
      if (!spendReplacementUse(s, cardId, player, modifier)) continue;
      return { price: 'hand', count: modifier.hand, label: `弃 ${modifier.hand} 张手牌${follow === 'peel' ? '并将突进顶牌置于场外' : ''}后留下`, ...followPart };
    }
    if (modifier.base === true && card.underneath.length > 0) {
      if (!spendReplacementUse(s, cardId, player, modifier)) continue;
      return { price: 'base', count: 1, label: '将此角色的突进元置于场外后留下', ...followPart };
    }
    if (modifier.top === true && card.underneath.length > 0) {
      // 「代わりにレイド状態の上のこのカードを場外に置いてもよい」 — the top card pays and the base keeps
      // the slot. The battle/bp-zero spelling of the same price is offered earlier in this exit.
      if (!spendReplacementUse(s, cardId, player, modifier)) continue;
      return { price: 'top', count: 1, label: '将此卡置于场外、让突进元留在场上', ...followPart };
    }
  }
  // 「自分の場の〈X〉が…場を離れる場合、代わりに…」 — a *protector* carries the price and names the
  // protected cards with its filter, so the scan covers the whole field with that card as the source.
  for (const slot of [...p.front, ...p.energy]) {
    if (slot.cardId === cardId) continue;
    for (const modifier of activeStatics(s, slot.cardId, player)) {
      if (modifier.type !== 'retireSubstitute' || !covers(modifier) || modifier.substitute !== undefined) continue;
      if (modifier.filter && !matchesFilter(s, cardId, modifier.filter, slot.cardId)) continue;
      if (causeFails(modifier.cause)) continue;
      const follow = leaveFollow(modifier);
      const followDraw = leaveFollowDraw(modifier);
      const followPart = { ...(follow !== undefined ? { follow } : {}), ...(followDraw !== undefined ? { followDraw } : {}) };
      if (modifier.life !== undefined) {
        if (p.life.length < (modifier.minLife ?? modifier.life)) continue;
        if (!spendReplacementUse(s, slot.cardId, player, modifier)) continue;
        return { price: 'life', count: modifier.life, carrierId: slot.cardId, label: `将生命区 ${modifier.life} 张卡置于场外后留下`, ...followPart };
      }
      if (modifier.rest === true) {
        // 「「アクティブのこのキャラをレストにし、自分の手札をN枚場外に置く」」 — both halves are prices.
        if (slot.active !== true || p.hand.length < (modifier.minHand ?? modifier.hand ?? 0)) continue;
        if (!spendReplacementUse(s, slot.cardId, player, modifier)) continue;
        return { price: 'rest', count: modifier.hand ?? 0, carrierId: slot.cardId, label: `将此角色转为休息并弃 ${modifier.hand ?? 0} 张手牌后留下`, ...followPart };
      }
      // 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 (ARK-1-059) — the *protector* pays
      // with its own raid base (「このキャラか自分のエナジーLのキャラが…」 covers the energy line), the
      // same read `effects.ts#retireCostSubstitute` gives its protector scan. The base is peeled off the
      // carrier's slot, so the choice names that card (`carrierId`) and the protected card stays.
      if (modifier.base === true && slot.underneath.length > 0) {
        if (!spendReplacementUse(s, slot.cardId, player, modifier)) continue;
        return { price: 'base', count: 1, carrierId: slot.cardId, label: '将此角色的突进元置于场外后留下', ...followPart };
      }
      // A price-less protector instead retires itself in the protected card's place — 「代わりにアクティブ
      // のこのキャラを退場させてもよい」 / 「代わりにこのフィールドを退場させてもよい」.
      if (modifier.life === undefined && modifier.hand === undefined && modifier.under === undefined
        && modifier.base !== true && modifier.top !== true && modifier.replenish === undefined
        && modifier.rest !== true && modifier.toRemoval !== true) {
        if (modifier.active === true && slot.active !== true) continue;
        if (!spendReplacementUse(s, slot.cardId, player, modifier)) continue;
        const name = peekDefinition(s, slot.cardId)?.name ?? '此卡';
        return { price: 'retireSelf', count: 0, carrierId: slot.cardId, label: `让〈${name}〉代为退场后留下`, ...followPart };
      }
    }
  }
  return undefined;
}

function leavePaymentCandidates(ctx: Context, player: PlayerId, cardId: CardId, pay: LeavePayment): CardId[] {
  const s = ctx.state;
  const here = findField(s, player, cardId);
  if (!here) return [];
  const p = s.players[player];
  switch (pay.price) {
    case 'under': return [...(here.card.faceDown ?? [])];
    case 'hand': case 'rest': return [...p.hand];
    case 'life': return [...p.life];
    default: return [];
  }
}

function applyLeavePayment(ctx: Context, player: PlayerId, cardId: CardId, pay: LeavePayment, chosen?: CardId[]): boolean {
  const s = ctx.state;
  const here = findField(s, player, cardId);
  if (!here) return false;
  const p = s.players[player];
  /** The cards this answer pays: the chosen ones when they are a legal pick, else the first `count`. */
  const picks = (pool: CardId[], count: number): CardId[] | undefined => {
    // The pool is only consulted when the choice was actually wide: a pool exactly as large as the price
    // is the determinate payment (「候选数 == 支付数自动」), and a stale record must not narrow it.
    if (chosen === undefined || pool.length <= count) return pool.length >= count ? pool.slice(0, count) : undefined;
    if (chosen.length !== count || new Set(chosen).size !== chosen.length) return undefined;
    return chosen.every(id => pool.includes(id)) ? [...chosen] : undefined;
  };
  switch (pay.price) {
    case 'under': {
      const pile = here.card.faceDown ?? [];
      const payIds = picks(pile, pay.count);
      if (payIds === undefined) return false;
      const paid = payIds.map(id => pile.splice(pile.indexOf(id), 1)[0]!);
      p.sideline.push(...paid);
      emit(ctx, 'underCardsSentToSideline', { player, cards: paid });
      break;
    }
    case 'hand': {
      const paid = picks(p.hand, pay.count);
      if (paid === undefined) return false;
      p.hand = p.hand.filter(id => !paid.includes(id));
      p.sideline.push(...paid);
      emit(ctx, 'effectDiscarded', { player, cards: paid });
      break;
    }
    case 'life': {
      const paid = picks(p.life, pay.count);
      if (paid === undefined) return false;
      for (const id of paid) removeFromLife(s, player, id);
      p.sideline.push(...paid);
      emit(ctx, 'lifeCardSentToSideline', { player, cards: paid });
      break;
    }
    case 'base': {
      // 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 — the paying card is the carrier
      // (the retiring card itself, or the protector that watches over it), and its first under-card leaves
      // for 場外 while its own top keeps the slot.
      const host = pay.carrierId === undefined ? here : findField(s, player, pay.carrierId);
      if (!host) return false;
      const base = host.card.underneath.shift();
      if (base === undefined) return false;
      p.sideline.push(base);
      break;
    }
    case 'top': {
      // 「レイド状態の上のこのカードを場外に置いてもよい」 — the top leaves and the base takes the slot.
      if (!here.card.underneath.length) return false;
      peelTopToSideline(ctx, player, cardId);
      return true;
    }
    case 'rest': {
      const carrier = pay.carrierId === undefined ? undefined : findField(s, player, pay.carrierId);
      if (!carrier || carrier.card.active !== true) return false;
      const paid = picks(p.hand, pay.count);
      if (paid === undefined) return false;
      carrier.card.active = false;
      p.hand = p.hand.filter(id => !paid.includes(id));
      p.sideline.push(...paid);
      emit(ctx, 'effectDiscarded', { player, cards: paid });
      break;
    }
    case 'retireSelf': {
      if (pay.carrierId === undefined) return false;
      // The protector's own retirement: the regular exit, so its 退場時 watchers and the turn log behave
      // exactly like the substitute-direction retirement `effects.ts#retireSubstitutes` performs.
      const went = leaveField(ctx, player, pay.carrierId, 'sideline', 'retire-substitute');
      if (went !== 'sideline') return false;
      break;
    }
  }
  // 「そうした場合、レイド状態のこのキャラの一番上のカードを…」 / 「そうした場合、その〈X〉をレストに…」 —
  // the requested follow-up runs on the card this price saved.
  if (pay.follow === 'peel') peelTopToSideline(ctx, player, cardId);
  if (pay.follow === 'rest') {
    const saved = findField(s, player, cardId);
    if (saved && saved.card.active) {
      saved.card.active = false;
      logTurnEvent(s, 'restedByEffect', player, cardId, { causeOwner: player });
      logTurnEvent(s, 'rested', player, cardId);
    }
  }
  // 「そうした場合、その〈ゴレイヌ〉をエナジーLに移動させる。」 (HTR-2-026) — the saved card steps to the
  // energy line. The printed move is the ordinary one, so the line's capacity is honoured: a full line
  // has no room and the follow-up does nothing rather than exceed it.
  if (pay.follow === 'moveEnergy') {
    const saved = findField(s, player, cardId);
    if (saved && saved.line === 'front' && p.energy.length < lineCapacity(s, player, 'energy')) {
      moveLoserToEnergy(ctx, player, cardId);
    }
  }
  if (pay.followDraw !== undefined && pay.followDraw > 0) {
    draw(ctx, player, pay.followDraw, { via: 'effect', causeOwner: player });
    ctx.queue.push(...collectTriggered(ctx, player, 'onDrew'));
  }
  return true;
}

const TEMPORARY_FIELD_KEYS = ['bpModifiers', 'energyCostModifiers', 'energyModifiers', 'impactModifiers',
  'keywordModifiers', 'lostKeywords', 'evadeModifiers', 'mustBlockAttacker', 'boundWatches', 'grantedStatics',
  'grantedAbilities', 'grantedActivated', 'retireAtMainEnd', 'retireAtEnd', 'effectsLostUntilTurn',
  'selfTurnEffectsLostUntilTurn', 'cannotActivateUntilTurn', 'cannotActivateCharges', 'peelBases'] as const;

export function clearTemporaryFieldState(state: GameState, cardId: CardId, slot?: FieldCard): void {
  if (slot) {
    const record = slot as unknown as Record<string, unknown>;
    for (const key of TEMPORARY_FIELD_KEYS) delete record[key];
    // `bpModifiers` is required by the type; an empty list is the printed-value state.
    slot.bpModifiers = [];
  }
  // The instance ledger is the one record that survives the slot (`conditions.ts#EnergyCostRaise`).
  const instance = state.cards[cardId] as unknown as { energyCostModifiers?: unknown } | undefined;
  if (instance !== undefined) delete instance.energyCostModifiers;
}

export function leaveField(ctx: Context, player: PlayerId, cardId: CardId, destination: 'sideline' | 'removal' | 'hand' | 'deckBottom', reason: string, triggerCauseId?: CardId, offerLeavePrice = false): 'sideline' | 'removal' | 'hand' | 'deckBottom' | 'stayed' {
  const s = ctx.state;
  const p = s.players[player];
  const located = findField(s, player, cardId);
  requireRule(located, 'INVALID_TARGET', '目标不在该玩家的场上。');
  const modifiers = activeStatics(s, cardId, player);
  const notRetired = reason === 'raid-top' || reason === 'effect-deck' || reason === 'effect-life'
    || reason === 'effect-under';
  if (destination === 'removal' && /^(?:line-capacity|movement-capacity|battle-overflow)$/.test(reason)
    && modifiers.some(m => m.type === 'overflowToSideline')) destination = 'sideline';
  // The one-shot destination answers for this atomic command's replay, including this exit's leave price
  // (`'pay'`, see `DepartureAnswer` above).
  const answer = s.departureChoices?.[cardId];
  // A rules retirement still satisfies the unqualified 「退場する場合」 (Q94 + EVA-1-041's text).
  // Reuse the atomic command-replay choice: no BP change, block, draw or departure is committed twice.
  const topOffer = destination === 'sideline' && (reason === 'battle' || reason === 'bp-zero')
    && located.card.underneath.length > 0 && !staticForbids(s, cardId, player).retire
    && modifiers.some(m => 'top' in m && m.top === true
      && (m.cause === undefined || (reason === 'battle' && m.cause === 'notBpZero')));
  if (topOffer) {
    if (answer === undefined) throw new DepartureChoice(player, cardId, 'top');
    if (answer === 'top') {
      if (s.departureChoices) delete s.departureChoices[cardId];
      peelTopToSideline(ctx, player, cardId);
      return 'stayed';
    }
  }
  if (destination !== 'removal' && modifiers.some(m => m.type === 'optionalLeaveToRemoval')) {
    if (answer === undefined) throw new DepartureChoice(player, cardId);
    if (answer === 'removal') destination = 'removal';
  }
  if (answer === undefined) {
    const offer = leavePaymentOffer(ctx, player, cardId, destination, reason, triggerCauseId, offerLeavePrice);
    if (offer) throw new DepartureChoice(player, cardId, 'pay', offer.label, offer, leavePaymentCandidates(ctx, player, cardId, offer));
  } else if (answer === 'pay') {
    const offer = leavePaymentOffer(ctx, player, cardId, destination, reason, triggerCauseId, offerLeavePrice);
    const chosen = s.departurePayChoices?.[cardId];
    if (offer && applyLeavePayment(ctx, player, cardId, offer, chosen)) {
      if (s.departureChoices) delete s.departureChoices[cardId];
      if (s.departurePayChoices) delete s.departurePayChoices[cardId];
      emit(ctx, 'leavePaid', { player, cardId, price: offer.price });
      return 'stayed';
    }
  }
  if (s.departureChoices) delete s.departureChoices[cardId];
  if (s.departurePayChoices) delete s.departurePayChoices[cardId];
  // 「このキャラが場を離れる場合、代わりにこのカードを手札に戻す。」 — the leave redirect covers every
  // route that reaches this function (the battle loss and the rules included, which do not pass through
  // an effect's own operation check); a leave already bound for the hand is left alone.
  // A `cause: 'opponentEffect'` redirect (REZ-1-074) does not cover the rules' own leaves — a battle loss
  // or a BP check never passes through an opponent's effect, so only the unqualified print redirects here.
  if (destination !== 'hand' && activeStatics(s, cardId, player).some(m => m.type === 'leaveToHand' && m.cause === undefined)) destination = 'hand';
  // 「このキャラが退場する場合、代わりにリムーブエリアに置かれる。」 — the redirect scoped to the
  // 退場 destination alone (the wording says nothing about a return to hand or an existing removal),
  // applied at the same single exit as the hand redirect above.
  else if (!notRetired && destination === 'sideline' && activeStatics(s, cardId, player).some(m => m.type === 'retireToRemoval' && (m.source === undefined || reason === 'bp-zero'))) destination = 'removal';
  // 「このキャラは退場しない。」 is a refusal to reach 場外, not a refusal to leave the field: a wording
  // that sends it to the hand or to リムーブエリア still works, which is why only the discard
  // destination is checked.
  if (!notRetired && destination === 'sideline' && staticForbids(s, cardId, player).retire) return 'stayed';
  // The card is going off the field for good (every destination here leaves it), so the 「…かぎり」 grants
  // it sources end now — a later re-entry under the same cardId must not revive them (Q933/Q934).
  expireWhileSourceGrants(s, cardId);
  // A card's own 退場時 conditions are read *before* it leaves the field. Every one of them speaks about
  // the board the card is still on (「このキャラの下に裏向きのカードがない場合」), and a source-scoped
  // predicate evaluated after the removal would read an empty board rather than the one the printed rule
  // asks about — silently turning the guard into a pass. The effects are queued after the removal, so the
  // ability itself still resolves from 場外.
  const definition = peekDefinition(s, cardId);
  // 「元々持っている効果の場合、発動しません」 (Q2211) — an effects-suppressed card's *printed* 退場時/離場
  // watchers stay silent; the abilities it *gained* are untouched (Q1313/Q1314). Read while the card is
  // still on its line (the splice comes later), which is the only state the suppression exists in.
  const printedOnLeave = effectsSuppressed(s, cardId) ? [] : (definition?.triggered ?? []);
  // 「このキャラとのバトルによって退場したキャラの[退場時]は発動しない。」 — the opposing participant's
  // silence over this card's own 退場時 watchers, read while the battle is still open (this call is made
  // from the comparison, before `endBattle`).
  const battleSilenced = (reason === 'battle' || reason === 'battle-overflow') && battleSilencesLoserAbilities(s, cardId);
  // 「退場でも登場でもない」 departures that only *borrow* this exit: the deck-top/bottom and ライフ
  // placements park the field card in 場外 for one step and then move it on (Q544's reading, shared with
  // `raid-top`). They are not a 退場 — Q950/Q2207: no 退場時, no `retired` record, no retirement emit.
  // 「自分の効果によって、このキャラが退場している場合」 / 「自分の〈憎普天〉の効果で退場したなら」 — the
  // *card* whose effect ordered the removal, taken from the frame that is resolving it. The rule-driven
  // routes (a battle, the capacity overflows, a BP-zero) resolve no frame and record none, and a
  // deferred retirement (エンドフェイズ/メインフェイズ終了時) resolves after its frame is gone — those
  // answer 「自分の効果で」 with no, which is narrower than a guess.
  const effectReasons = EFFECT_LEAVE_REASONS;
  // SPECIAL resolves directly, without an effect frame. Its life card is the effect's source;
  // never borrow a stale frame or the attacking character's identity.
  const retireCauseId = reason === 'special-trigger' ? triggerCauseId : effectReasons.has(reason) ? s.effect?.sourceId : undefined;
  const collectOwn = (
    event: TriggeredAbility['event'],
    gate: { retireReason?: string; retireCauseId?: CardId } | undefined,
    allowed: boolean,
  ): { effects: CardEffect[]; keys: string[] } => {
    if (!allowed) return { effects: [], keys: [] };
    const sources: { ability: TriggeredAbility; key: string }[] = [
      ...printedOnLeave.map((ability, index) => ({ ability, key: ability.limitKey ?? String(index) })),
      // Granted abilities count too: 「…に『[退場時]…』を与える」 installs one on the field card, and this
      // is the only place a 退場時 ability is collected — reading only the definition would leave the
      // granted copy permanently silent. Keyed `g<i>` like the field scan's grants.
      ...(located.card.grantedAbilities ?? []).map((grant, index) => ({ grant, index }))
        .filter(entry => entry.grant.expiresTurn >= s.turn)
        .map(({ grant, index }) => ({ ability: grant.ability, key: `g${index}` })),
    ];
    const keys: string[] = [];
    const effects: CardEffect[] = [];
    const identity = fieldIdentity(located.card);
    for (const { ability, key } of sources) {
      if (ability.event !== event || ability.scope === 'anyOfTheirs' || ability.eventCard?.other) continue;
      // 「バトルによって退場した場合」 asks about the *cause*, which only this call knows — a battle's
      // loser reads `'battle'` / `'battle-overflow'` here. 「自分の効果によって」「自分の〈X〉の効果で」 ask
      // one step further and name the cause *card*, which only the resolving frame remembers.
      if (ability.condition && !evalCondition(s, cardId, player, ability.condition, gate)) continue;
      if (ability.oncePerTurn) {
        const budgetKey = ability.sharedLimit === true ? `t:${definition?.functionalId ?? cardId}:${key}` : `c:${identity}:${key}`;
        const ok = ability.sharedLimit === true
          ? reserveLimitBudget(s, player, budgetKey, 'shared')
          : reserveLimitBudget(s, player, budgetKey, 'card', identity, key);
        if (!ok) continue;
        keys.push(budgetKey);
      }
      effects.push(...ability.effects);
    }
    return { effects, keys };
  };
  const retireGateArgs = { retireReason: reason, ...(retireCauseId !== undefined ? { retireCauseId } : {}) };
  const retireOwn = collectOwn('onRetire', retireGateArgs, destination === 'sideline' && !notRetired && !battleSilenced);
  const retireEffects = retireOwn.effects;
  // 「このキャラが(自分の)場から手札に戻った時、…」 — the card's own return watcher, collected before
  // the removal for the same reason the retire ones are: its guards (「レイド元のカードが場外にある場合」,
  // a tier threshold over the hidden stack) read the board the card is still on, and the ability then
  // resolves with the card already in hand.
  const returnOwn = collectOwn('onReturnedToHand', undefined, destination === 'hand');
  const returnEffects = returnOwn.effects;
  if (destination === 'sideline' && !notRetired) {
    for (const watcher of [0, 1] as const) {
      for (const line of ['front', 'energy'] as const) {
        for (const slot of s.players[watcher][line]) {
          const watches = (slot.boundWatches ?? []).filter(watch => watch.expiresTurn >= s.turn && watch.kind === 'retire' && watch.id === cardId);
          for (const watch of watches) ctx.queue.push(makeTask(s, watcher, slot.cardId, watch.effects));
        }
      }
    }
  }
  const baseToHand = destination === 'hand' && located.card.underneath.length > 0
    && activeStatics(s, cardId, player).some(m => m.type === 'returnBaseToHand');
  const leftOwn = collectOwn('onLeftField', retireGateArgs, true);
  const leftEffects = leftOwn.effects;
  // Capture the host-dependent filters while its slot/names still exist. Each hidden card is a
  // separate event subject; visible RAID bases are not 「裏向きのカード」 and raise no such event.
  const underTasks = (located.card.faceDown ?? []).flatMap(hiddenId =>
    collectTriggered(ctx, player, 'onUnderToSideline', cardId, hiddenId, { line: located.line })
      .map(task => ({ ...task, id: `${task.id}:under:${hiddenId}` })));
  if (!notRetired) recordRetiredEnergyBroadcast(s, cardId);
  p[located.line].splice(p[located.line].indexOf(located.card), 1);
  if (destination === 'deckBottom') p.deck.push(cardId); else p[destination].push(cardId);
  // 「このキャラが自分の場から手札に戻る場合、代わりにこのキャラとこのキャラのレイド元のカードを手札に
  // 戻す。」 — the base follows the card to the hand instead of 場外. Only this route is widened; a
  // retirement or a removal of the same card still sends the stack to the sideline below.
  if (baseToHand) p.hand.push(...located.card.underneath);
  else {
    p.sideline.push(...located.card.underneath);
    for (const baseId of located.card.underneath) {
      ctx.queue.push(...collectHiddenWatchers(ctx, s.cards[baseId]!.owner, baseId, false));
    }
  }

  // Face-down cards under a leaving character go to the sideline with it.
  if (located.card.faceDown?.length) {
    p.sideline.push(...located.card.faceDown);
    emit(ctx, 'underCardsSentToSideline', { player, cards: located.card.faceDown });
    ctx.queue.push(...underTasks);
    for (const hiddenId of located.card.faceDown) {
      ctx.queue.push(...collectHiddenWatchers(ctx, s.cards[hiddenId]!.owner, hiddenId));
    }
  }
  // 「退場する代わりに、相手の山札の下に置かれる」 is a departure, not a 退場 and not a removal: it is
  // reported as the card leaving the field for the deck, which the public log renders as a return. The
  // borrow routes (`notRetired`: deck top/bottom, ライフ, a peeled raid top) report the same way.
  // 「…の下に置く」 (`effect-under`) is neither a retirement nor a return to hand — the caller's own
  // `cardPlacedUnder` event reports the placement, so the borrow prints no departure line of its own.
  if (reason !== 'effect-under') emit(ctx, destination === 'sideline' && !notRetired ? 'characterRetired' : destination === 'removal' ? 'cardRemoved' : 'cardReturned', { player, cardId, reason });
  // 「このキャラが退場するか場から手札に戻った時、…」 — the *any-route* departure, printed as two
  // alternatives. The card's own ability is read from its definition rather than through `collectTriggered`,
  // which scans the field the card has just left; the effects queue behind the removal exactly like the
  // 退場時 ones above. （评估已在移除前完成——见上方前移块。）
  if (leftEffects.length) {
    const task = makeTask(s, player, cardId, leftEffects, undefined, located.card.underneath);
    task.abilityEvent = 'onLeftField';
    task.retireReason = reason;
    if (retireCauseId !== undefined) task.retireCauseId = retireCauseId;
    task.departedLine = located.line;
    task.sourceInstance = fieldIdentity(located.card);
    if (leftOwn.keys.length) task.limitBudgetKeys = leftOwn.keys;
    ctx.queue.push(task);
  }
  // 退場 is specifically "to the discard pile". 「手札に戻る」 and 「リムーブエリアに置かれる」 both take
  // the card off the field without retiring it, and cards print the three as alternatives.
  // 「BPが0以下になることか効果によって…退場している」 — the record carries the route beside the fact:
  // the BP-zero rule, a battle's loss (or its energy-line overflow), or an effect. A peeled RAID top
  // never retired (Q544), so it writes no record either — 「このターン中に…が退場している場合」 must
  // not count it (the same exemption the 退場時 collections apply).
  if (destination === 'sideline' && !notRetired) logTurnEvent(s, 'retired', player, cardId, {
    cause: reason === 'bp-zero' ? 'bpZero' : reason === 'battle' || reason === 'battle-overflow' ? 'battle' : 'effect',
    ...(retireCauseId !== undefined ? { causeId: retireCauseId } : {}),
    ...(retireCauseId !== undefined && s.cards[retireCauseId]?.owner !== undefined ? { causeOwner: s.cards[retireCauseId]!.owner } : {}),
  });
  // 「このターン中に自分の[特徴：X]が場から手札に戻っている場合」 — the return record. The single field
  // exit that sends a card to the hand writes it, so every route (an effect, a battle redirect, the
  // `leaveToHand` static) is one fact in the log.
  if (destination === 'hand') logTurnEvent(s, 'returnedToHand', player, cardId);
  if (located.card.underneath.length) emit(ctx, 'raidBaseSentToSideline', { player, cards: located.card.underneath });
  // The retirement's task carries the base it had: the ability resolves from 場外, where a live read of
  // 「このキャラのレイド元」 finds nothing (the base went to the sideline with the card just above).
  // The cause rides along too, for the guarded 「…場合、…」 steps inside the ability, which are
  // evaluated at resolution rather than at collection.
  if (retireEffects.length) {
    const task = makeTask(s, player, cardId, retireEffects, undefined, located.card.underneath, located.card.faceDown);
    task.abilityEvent = 'onRetire';
    task.departedLine = located.line;
    task.sourceInstance = fieldIdentity(located.card);
    if (retireOwn.keys.length) task.limitBudgetKeys = retireOwn.keys;
    task.retireReason = reason;
    if (retireCauseId !== undefined) task.retireCauseId = retireCauseId;
    const gate = ownRetireTriggerGate(s, player);
    if (gate) {
      task.steps = gate.cost === undefined
        ? [{ type: 'chooseOption', count: 1, options: [retireEffects, []] }]
        : [{
          type: 'if', condition: { type: 'handCount', who: 'self', min: gate.cost.hand },
          then: [{
            type: 'chooseOption', count: 1,
            options: [retireEffects, [{ type: 'discard', player: 'self', count: gate.cost.hand, strict: true }]],
          }],
          else: retireEffects,
        }];
    }
    ctx.queue.push(task);
  }
  // The return's task carries the stack the card had, the way the retirement's does: 「このキャラのレイド元
  // のカードが…場外にある場合」 resolves from the hand, where a live read of the base finds nothing.
  if (returnEffects.length) {
    const task = makeTask(s, player, cardId, returnEffects, undefined, located.card.underneath, located.card.faceDown);
    task.abilityEvent = 'onReturnedToHand';
    task.departedLine = located.line;
    task.sourceInstance = fieldIdentity(located.card);
    if (returnOwn.keys.length) task.limitBudgetKeys = returnOwn.keys;
    ctx.queue.push(task);
  }
  if (!notRetired && (destination === 'sideline' || destination === 'removal')) {
    for (const task of collectTriggered(ctx, player, 'onRetire', cardId, cardId, { line: located.line, underStack: located.card.underneath })) {
      if (task.sourceId !== cardId) ctx.queue.push(task);
    }
    // 「相手のフロントLのキャラが退場した時、…」 — a watcher on the *other* player's field. The event's
    // side and line are what the printed subject names, so they are handed over as the collection filter.
    for (const task of collectTriggered(ctx, otherOf(player), 'onRetire', cardId, undefined, { crossSide: true, line: located.line })) {
      ctx.queue.push(task);
    }
  }
  // 「自分の場の〈X〉が手札に戻った時」 — watchers on the *other* cards for the return, the way the
  // retirement watchers run above. The card itself is already in the hand, so a plain collection over
  // the remaining field finds exactly the other cards; the returning card's own ability was collected
  // before the removal (`returnEffects`).
  if (destination === 'hand') {
    for (const task of collectTriggered(ctx, player, 'onReturnedToHand', cardId, undefined, { line: located.line })) {
      if (task.sourceId !== cardId) ctx.queue.push(task);
    }
    for (const task of collectTriggered(ctx, otherOf(player), 'onReturnedToHand', cardId, undefined, { crossSide: true, line: located.line })) {
      ctx.queue.push(task);
    }
  }
  clearTemporaryFieldState(s, cardId, located.card);
  return destination;
}

export function checkBP(ctx: Context): void {
  for (const player of [0, 1] as const) {
    const checked = new Set<CardId>();
    // A top replacement can expose another BP-zero character. Settle that new card now; a refusal
    // that keeps the same card at zero must not cause an endless scan.
    for (;;) {
      const cards = [...ctx.state.players[player].front, ...ctx.state.players[player].energy];
      const card = cards.find(c => !checked.has(c.cardId) && getDefinition(ctx.state, c.cardId).kind === 'character' && getBP(ctx.state, c) <= 0);
      if (!card) break;
      checked.add(card.cardId);
      leaveField(ctx, player, card.cardId, 'sideline', 'bp-zero');
    }
  }
}

function ensureRoom(ctx: Context, player: PlayerId, to: Line, replace: CardId | undefined): void {
  const s = ctx.state;
  const line = s.players[player][to];
  // The capacity is read through `lineCapacity` so a 「置けるカードの枚数がN枚減る」 in play narrows the
  // line the same way for every path that adds a card to it.
  const capacity = lineCapacity(s, player, to);
  requireRule(line.length <= capacity, 'LINE_FULL', '战线容量已被卡牌效果缩减，先移除超出容量的卡。');
  if (line.length === capacity) {
    requireRule(replace !== undefined, 'LINE_FULL', '战线已满，必须选择一张原有卡移除。');
    requireRule(line.some(c => c.cardId === replace), 'INVALID_TARGET', '替换目标不在目标战线。');
    leaveField(ctx, player, replace, 'removal', 'line-capacity');
  } else requireRule(replace === undefined, 'INVALID_CHOICE', '战线未满时不能额外移除卡片。');
}

/**
 * 「（…場合、このラインに置けるカードの枚数が1枚減る）」 — a reduction that lands while its line already
 * holds more cards than the new ceiling (Q997/Q985/Q1406): the line's owner picks one of its cards for
 * the removal area, then the check runs again — repeatedly, until the line fits. Removing the reducing
 * card itself lifts the ceiling again, so every pick is re-counted against the live capacity.
 *
 * The question needs a decision, so it opens at the *command's tail* — after the placement and its own
 * resolution (onPlay, selections) have finished — rather than inside the placement, which cannot park
 * for an answer. Every route that can drop a line's ceiling (play, raid, an effect's deploy or move, a
 * movement-phase move, a granted static) ends its command here. The removal is the rules procedure, not
 * an effect: it is not filtered by the effect-protection statics (`cannotBeChosenBy`-style).
 */
function openLineOverflow(ctx: Context): void {
  const s = ctx.state;
  for (const owner of [0, 1] as const) {
    for (const line of ['front', 'energy'] as const) {
      const slots = s.players[owner][line];
      if (slots.length > lineCapacity(s, owner, line)) {
        s.pending = { type: 'lineOverflow', player: owner, line, cards: slots.map(slot => slot.cardId) };
        emit(ctx, 'lineOverflow', { player: owner, line });
        return;
      }
    }
  }
}

/**
 * 「〈X〉はNターンにM枚のみ使用できる」 — whether this use is still available, and its record.
 *
 * A limit of 「NターンにM枚」 is treated as a per-`N`-turn budget rather than a sliding window, which
 * is how the printed wording reads and what the turn log can answer exactly.
 */
function checkUseLimit(ctx: Context, player: PlayerId, cardId: CardId): void {
  const s = ctx.state;
  const definition = getDefinition(s, cardId);
  if (!definition.useLimit) return;
  const used = s.players[player].useCounts?.[definition.functionalId] ?? 0;
  requireRule(used < definition.useLimit.count, 'INVALID_CHOICE', '该卡的使用次数已达上限。');
}

function recordUse(state: GameState, player: PlayerId, cardId: CardId): void {
  const p = state.players[player];
  const key = getDefinition(state, cardId).functionalId;
  p.useCounts = { ...(p.useCounts ?? {}), [key]: (p.useCounts?.[key] ?? 0) + 1 };
}

export function reserveLimitBudget(s: GameState, player: PlayerId, key: string, to: 'shared' | 'hand' | 'sideline' | 'under' | 'card', ref?: string, ability?: string): boolean {
  const p = s.players[player];
  if ((p.sharedLimitUsed?.[key] ?? -1) >= s.turn) return false;
  const held = p.limitReserved?.[key];
  if (held !== undefined && held.turn >= s.turn) return false;
  p.limitReserved = {
    ...(p.limitReserved ?? {}),
    [key]: { turn: s.turn, to, ...(ref !== undefined ? { ref } : {}), ...(ability !== undefined ? { ability } : {}) },
  };
  return true;
}

/** Settles the reservations a resolution took: commit when it processed anything, release otherwise. */
export function settleLimitBudgets(s: GameState, player: PlayerId, keys: string[] | undefined, commit: boolean): void {
  if (!keys?.length) return;
  const p = s.players[player];
  for (const key of keys) {
    const held = p.limitReserved?.[key];
    if (held === undefined || held.turn < s.turn) continue;
    if (commit) {
      if (held.to === 'shared') p.sharedLimitUsed = { ...(p.sharedLimitUsed ?? {}), [key]: s.turn };
      else if (held.to === 'hand' && held.ref !== undefined) p.handTriggeredUsed = { ...(p.handTriggeredUsed ?? {}), [held.ref]: s.turn };
      else if (held.to === 'sideline' && held.ref !== undefined) p.sidelineTriggeredUsed = { ...(p.sidelineTriggeredUsed ?? {}), [held.ref]: s.turn };
      else if (held.to === 'under' && held.ref !== undefined) p.underTriggeredUsed = { ...(p.underTriggeredUsed ?? {}), [held.ref]: s.turn };
      else if (held.to === 'card' && held.ref !== undefined && held.ability !== undefined) {
        const slot = [...p.front, ...p.energy].find(card => fieldIdentity(card) === held.ref);
        if (slot) slot.triggeredUsed = { ...(slot.triggeredUsed ?? {}), [held.ability]: (slot.triggeredUsed?.[held.ability] ?? 0) + 1 };
      }
    }
    if (p.limitReserved !== undefined) {
      const { [key]: _spent, ...rest } = p.limitReserved;
      p.limitReserved = rest;
    }
  }
}

/**
 * 「〈X〉のこの効果は1ターンに1回のみ発動できる。」 printed over a 【登場時】 block — the entry budget is
 * shared by every copy of the printed card (Q2061/Q1107/Q2123: the second copy played in the same turn
 * does not fire its 【登場時】 at all). The `onPlay` array has no per-ability slot, so the budget lives on
 * the player keyed by functional identity; returns `true` when the entry may fire (spending the budget).
 *
 * Also read by the replay route (「このキャラの[登場時]を発動する」): a second firing in the same turn is
 * the same once-per-turn violation.
 */
export function consumeEntryLimit(s: GameState, player: PlayerId, definition: CardDefinition): boolean {
  if (definition.onPlaySharedLimit !== true) return true;
  const key = `entry:${definition.functionalId}`;
  if (!reserveLimitBudget(s, player, key, 'shared')) return false;
  settleLimitBudgets(s, player, [key], true);
  return true;
}

/** Q1521 + Q2123: declining a wholly optional entry is not an activation, and neither is a resolution
 * that processed nothing (Q1273/Q1586/Q1589) — the budget is reserved here and settled when the entry's
 * own task finishes (see `EffectTask.limitBudgetKeys`). */
export function prepareEntryEffects(s: GameState, player: PlayerId, definition: CardDefinition): CardEffect[] {
  const steps = definition.onPlay ?? [];
  if (definition.onPlaySharedLimit !== true || !steps.length) return steps;
  const key = `entry:${definition.functionalId}`;
  if (!reserveLimitBudget(s, player, key, 'shared')) return [];
  const copy = structuredClone(steps);
  const chooser = optionalEntryChoice(copy);
  if (chooser) chooser.entrySharedLimitKey = key;
  return copy;
}

function attachEntryBudget(task: EffectTask, definition: CardDefinition): void {
  if (definition.onPlaySharedLimit !== true) return;
  task.limitBudgetKeys = [...(task.limitBudgetKeys ?? []), `entry:${definition.functionalId}`];
}

function play(ctx: Context, player: PlayerId, action: Extract<Action, { type: 'play' }>): void {
  const s = ctx.state;
  const p = s.players[player];
  // 「自分は自分のリムーブエリアの〈…〉を使用できる。」 — a permission static widens the zones a use may
  // start from; without one the hand is the only legal source, which is the printed rule.
  const fromRemoval = !p.hand.includes(action.cardId) && p.removal.includes(action.cardId) && removalUseAllowed(s, player, action.cardId);
  requireRule(p.hand.includes(action.cardId) || fromRemoval, 'INVALID_CARD', '只能使用自己的手牌（或经效果许可从移除区使用）。');
  // 「このターン中、自分は手札のカードを使用できない」 — the player-scope restriction refuses the use
  // wherever the card came from hand, before anything is paid. A removal-area use is not a hand use and
  // keeps its own permission path.
  requireRule(!(p.hand.includes(action.cardId) && playerStatics(s, player).some(m => m.type === 'cannotUseHandCards' && (m.filter === undefined || matchesFilter(s, action.cardId, m.filter, action.cardId)))), 'INVALID_CHOICE', '本回合不能使用手牌的卡。');
  const card = getDefinition(s, action.cardId);
  // The printed use condition is checked before anything is paid: 「…のみ使用できる」 refuses the
  // action outright, so a rejected attempt must not cost energy or AP.
  if (card.playCondition) requireRule(evalCondition(s, action.cardId, player, card.playCondition), 'INVALID_CHOICE', '当前不满足该卡的使用条件。');
  // Q1119 (総則) / Q510 — 対象を選ぶ必要があるイベントカードは、その対象全てを選ぶことができない場合、
  // 使用することができません (「まで」形の min0 は可)。 Q2272's activation gate read over the card's own
  // effect steps, before anything is paid — MHA-1-100 refuses the whole use when the forced 〈BP3000以下〉
  // pick has no candidate, rather than resolving only the rest half.
  if (card.kind === 'event') {
    requireRule(!useSelectBlocked(s, player, action.cardId, card.onPlay ?? []), 'INVALID_CHOICE', '效果所需的对象无法全部选择，不能使用。');
  }
  // 「このキャラが自分の場にある場合、自分の場に〈X〉は登場できない。」 — the field-side placement
  // refusal, read where the placement is attempted.
  requireRule(!deployForbidden(s, player, action.cardId), 'INVALID_CHOICE', '场上存在使该卡无法登场的角色。');
  requireRule(!card.raidOnly, 'INVALID_CHOICE', '该角色只能通过 RAID 登场。');
  // 「このカードは自分の効果かレイドでのみ登場できる。」 (AOT-2-067) — the plain play is refused here; the
  // RAID action and an effect's deploy are different routes and reach the card by their own paths.
  requireRule(!card.raidOrEffectOnly, 'INVALID_CHOICE', '该卡只能通过效果或 RAID 登场。');
  checkUseLimit(ctx, player, action.cardId);
  requireEnergy(s, player, card, action.cardId);
  // 「このカードを使用する際に、自分の手札を望む枚数公開する。」 — the reveal is part of *using* the card:
  // it is named before the AP is priced, so a cost modifier gated on what was revealed
  // (「…公開した［特徴：X］が合計N枚以上ある場合、消費APを-1する」) can see it. A card that prints no
  // such reveal refuses a stray one, the way `declare` does.
  if (card.useReveal) {
    const revealed = action.revealHand ?? [];
    requireRule(new Set(revealed).size === revealed.length, 'INVALID_CHOICE', '公开的手牌不能重复。');
    requireRule(revealed.every(id => p.hand.includes(id)), 'INVALID_TARGET', '公开的卡必须来自手牌。');
    p.revealedHandAtUse = [...revealed];
  } else {
    requireRule(action.revealHand === undefined, 'INVALID_CHOICE', '该卡没有"使用时公开手牌"的效果。');
  }
  // 「〈X〉を選んで使用する場合、このカードの消費APを-1する。」 — the target is part of *using* the card:
  // it is declared here, priced from (`getApCost`), and handed to the effect's linked selection. A card
  // without `useTarget` refuses a stray declaration; a card with one requires it whenever the linked
  // pool has a candidate — an empty pool is the 「対象がいなくても使用できる」 case (Q110), where there
  // is nothing to declare and the effect resolves to nothing.
  const linked = card.useTarget ? useTargetSelection(card) : undefined;
  if (action.declare !== undefined) {
    requireRule(card.useTarget !== undefined && linked !== undefined, 'INVALID_CHOICE', '该卡没有“使用时选择目标”的效果。');
  }
  let declaredId: CardId | undefined;
  if (linked) {
    const pool = (linked.zone === 'ownFront' ? p.front : [...p.front, ...p.energy])
      .map(slot => slot.cardId)
      .filter(id => matchesFilter(s, id, linked.filter ?? {}, action.cardId));
    if (action.declare !== undefined) {
      requireRule(pool.includes(action.declare), 'INVALID_TARGET', '宣告的目标不在该效果的可选范围。');
      declaredId = action.declare;
    } else {
      requireRule(pool.length === 0, 'INVALID_TARGET', '使用该卡时必须先宣告作为效果目标的那张卡。');
    }
  }
  const apCost = getApCost(s, action.cardId, declaredId, fromRemoval);
  // The revealed set lives only for the pricing it was made for.
  if (card.useReveal) delete p.revealedHandAtUse;
  const waitingActive = (p.nextUseActive ?? []).some(entry => entry.expiresTurn >= s.turn && matchesFilter(s, action.cardId, entry.filter));
  spendAp(ctx, player, apCost);
  recordUse(s, player, action.cardId);
  consumeNextUseDiscount(s, player, action.cardId, fromRemoval);
  // 「このターン中に自分が〈X〉を使用している」 names the *card*, which neither `eventsUsedThisTurn`
  // (a count) nor any board state can answer after the fact — only the turn log can. The `free` flag
  // answers 「APを支払わずに使用している」: a use an effect reduced to zero AP. The exceptional source
  // zone rides along for 「自分のリムーブエリアから使用されている場合」.
  logTurnEvent(s, 'used', player, action.cardId, { free: apCost === 0 && card.apCost > 0, ...(fromRemoval ? { usedFrom: 'removal' as const } : {}) });
  // The card leaves whichever zone the use started from — the hand normally, リムーブエリア under a
  // permission. Both branches consume it the same way.
  const leaveUseZone = (): void => {
    const at = p.hand.indexOf(action.cardId);
    if (at !== -1) p.hand.splice(at, 1);
    else p.removal.splice(p.removal.indexOf(action.cardId), 1);
  };
  if (card.kind === 'event') {
    requireRule(action.to === undefined && action.replace === undefined, 'INVALID_CHOICE', '事件不占用战线。');
    leaveUseZone();
    p.eventsUsedThisTurn = (p.eventsUsedThisTurn ?? 0) + 1;
    emit(ctx, 'cardPlayed', { player, cardId: action.cardId, destination: 'event' });
    {
      const eventTask = makeTask(s, player, action.cardId, prepareEntryEffects(s, player, card));
      eventTask.abilityEvent = 'onPlay';
      attachEntryBudget(eventTask, card);
      if (declaredId !== undefined) eventTask.declared = { targetId: declaredId };
      startEffect(ctx, eventTask, undefined, action.cardId);
    }
  } else {
    requireRule(action.to !== undefined, 'INVALID_CHOICE', '必须选择登场战线。');
    requireRule(card.kind !== 'field' || action.to === 'energy', 'INVALID_TARGET', '场地只能放置在能量线。');
    requireRule(action.to !== 'front' || !staticImmunity(s, action.cardId, player).noFront, 'INVALID_TARGET', '该卡不能登场到前线。');
    requireRule(action.to !== 'energy' || !staticImmunity(s, action.cardId, player).noEnergy, 'INVALID_TARGET', '该卡不能登场到能量线。');
    ensureRoom(ctx, player, action.to, action.replace);
    leaveUseZone();
    // The arrival rider read above (`waitingActive`) lands here.
    p[action.to].push(newField(s, action.cardId, waitingActive || (staticEnterActive(s, action.cardId, player) ?? card.activeOnPlay ?? false), 'play', false, fromRemoval ? 'removal' : 'hand'));
    // 「このターン中に…登場している」 counts entries, so every placement records one.
    logTurnEvent(s, 'entered', player, action.cardId, { from: fromRemoval ? 'removal' : 'hand' });
    clearEnteredDiscounts(s, player, action.cardId);
    // 「…が登場した時」 — the same moment the log records, raised so a watcher can listen for it. The
    // entered card rides as the watcher's subject too, so an 「登場した…キャラ」 follow-up reaches it
    // through the `E` binding.
    ctx.queue.push(...collectTriggered(ctx, player, 'entered', action.cardId, action.cardId));
    emit(ctx, 'cardPlayed', { player, cardId: action.cardId, destination: action.to });
    // 「〈マキマ〉以外の自分の紫のキャラカードは全ての場所でイベントカードとしても扱う。」 — a use of a
    // matching card counts as an event-card use, the same counter the printed `kind === 'event'` branch
    // above bumps. Read *after* the card is placed, from the controller's field broadcasts.
    if (countsAsEventUse(s, player, action.cardId)) p.eventsUsedThisTurn = (p.eventsUsedThisTurn ?? 0) + 1;
    {
      const placedTask = makeTask(s, player, action.cardId, prepareEntryEffects(s, player, card));
      placedTask.abilityEvent = 'onPlay';
      attachEntryBudget(placedTask, card);
      if (declaredId !== undefined) placedTask.declared = { targetId: declaredId };
      startEffect(ctx, placedTask);
    }
  }
  checkBP(ctx);
}

/**
 * Whether `raiderId` may be raided onto `baseId`.
 *
 * Shared by the raid *action* and by an effect that raids for you (「…を…レイドさせる」), so the two
 * routes can never drift apart: the base must be a plain character with nothing stacked on it, and its
 * effective names or traits must satisfy the raider's printed RAID condition.
 */
export function raidBaseEligible(s: GameState, player: PlayerId, raiderId: CardId, baseId: CardId, via: 'action' | 'trigger' = 'action'): boolean {
  // An empty or unknown raider id means "not eligible", not an error: this predicate is what *offers*
  // the bases of a 「…をレイドさせる」 selection, and the raider binding is empty whenever the printed
  // subject found no candidate. Reading it through `getDefinition` threw `INVALID_CARD` there, which
  // rejected the whole command instead of leaving the choice empty.
  const card = peekDefinition(s, raiderId);
  if (!card) return false;
  if (!card.raid) return false;
  const base = findField(s, player, baseId);
  if (!base) return false;
  if (activeStatics(s, baseId, player).some(m => m.type === 'cannotBeRaided')) return false;
  // 「このカードはフロントLに登場できず」 (BLC-4-075/KGD-1-009, Q1902) — a RAID onto a base standing on
  // the front line arrives there like any other 登場, so the closed line refuses the base the same way
  // the play action refuses `to:'front'`. Only the MOVE-side carve-outs (「自分の効果以外で」「この
  // カードの[起動メイン]以外で」) exist in the prints; the 登場禁止 half is unconditional.
  if (base.line === 'front' && staticImmunity(s, raiderId, player).noFront) return false;
  // 「このカードは、レイド状態の〈X〉の一番上のカードを…そのレイド元にレイドできる。」 — the clicked
  // card is the raid-state 〈X〉, and the real base is the one underneath it.
  if (raidFromRaidTopMatch(s, player, raiderId, baseId)) return true;
  const baseDefinition = getDefinition(s, baseId);
  if (baseDefinition.kind !== 'character' || baseDefinition.raid || base.card.underneath.length > 0) return false;
  // 「自分の[レイド]を持つキャラカードはこのキャラにレイドできる。」 — the *base* grants eligibility to
  // raiders the printed subject names, bypassing the raider's own 〈X〉/特徴 list. Only raiders that carry
  // the RAID ability reach this point (`card.raid` above), so the subject test is the filter alone.
  // 「トリガーの効果でこのキャラにレイドできる。」 — a grant may name the *route* it opens: the trigger
  // route is the [レイドトリガー] path (`fromTrigger`), everything else is an ordinary raid. A grant
  // without `via` reaches every route; one with it only the named one.
  const baseGrants = activeStatics(s, baseId, player)
    .filter((m): m is Extract<StaticModifier, { type: 'canBeRaidedBy' }> => m.type === 'canBeRaidedBy' && (m.via === undefined || m.via === via));
  if (baseGrants.some(grant => grant.filter === undefined || matchesFilter(s, raiderId, grant.filter, baseId))) return true;
  const baseNames = effectiveNames(s, baseId, player);
  // 「[レイド]必要エナジーが4以下の紫のキャラ…」 — a base condition printed as a filter over the base's own
  // definition (SMD-1-071), eligible alongside the named/trait spellings.
  return (card.raid.filter !== undefined && matchesFilter(s, baseId, card.raid.filter, raiderId))
    || card.raid.names?.some(n => baseNames.includes(n))
    || card.raid.nameContains?.some(fragment => baseNames.some(n => n.includes(fragment)))
    // 「カード名に「Ｗ」と「ジョーカー」を含む」 (KMR-2-049/055) — every printed fragment has to appear.
    || card.raid.nameContainsAll?.every(fragment => baseNames.some(n => n.includes(fragment)))
    || hasAnyTrait(baseDefinition, card.raid.traits ?? []);
}

function raid(ctx: Context, player: PlayerId, action: Extract<Action, { type: 'raid' }>, fromTrigger = false): void {
  const s = ctx.state;
  const p = s.players[player];
  const fromRemoval = !p.hand.includes(action.cardId) && p.removal.includes(action.cardId) && removalUseAllowed(s, player, action.cardId);
  requireRule(p.hand.includes(action.cardId) || fromRemoval, 'INVALID_CARD', 'RAID 卡必须在自己的手牌，或经效果许可从移除区使用。');
  requireRule(!(p.hand.includes(action.cardId) && playerStatics(s, player).some(m => m.type === 'cannotUseHandCards' && (m.filter === undefined || matchesFilter(s, action.cardId, m.filter, action.cardId)))), 'INVALID_CHOICE', '本回合不能使用手牌的卡。');
  requireRule(!deployForbidden(s, player, action.cardId), 'INVALID_CHOICE', '场上存在使该卡无法登场的角色。');
  const card = getDefinition(s, action.cardId);
  requireRule(card.raid, 'INVALID_CARD', '该卡没有已实现的 RAID 条件。');
  // 「このキャラは、このターン中に自分の〈X〉が退場している場合のみレイドできる。」 — the printed raid
  // gate, checked before the base is committed and before anything is paid.
  // 「自分の効果でレイドしていた場合」 — the printed raid gate constrains the ordinary raid only: a
  // [レイドトリガー] raid happens as the trigger resolves and skips it (Q1296, SNF-1-067).
  if (card.raidCondition && !fromTrigger) requireRule(evalCondition(s, action.cardId, player, card.raidCondition), 'INVALID_CHOICE', '当前不满足该卡的 RAID 条件。');
  const base = findField(s, player, action.baseId);
  requireRule(base, 'INVALID_TARGET', '找不到自己的 RAID 基底。');
  requireRule(raidBaseEligible(s, player, action.cardId, action.baseId, fromTrigger ? 'trigger' : 'action'), 'INVALID_TARGET', 'RAID 基底的原始名称或特征不匹配。');
  // 「レイド状態の〈X〉の一番上のカードをそのレイド元の下に裏向きで置き、そのレイド元にレイドできる。」
  // — the exceptional route. The clicked card is the raid-state 〈X〉: it is peeled onto the real base
  // (face down), which then takes the slot over and becomes this raid's base.
  const peel = raidFromRaidTopMatch(s, player, action.cardId, action.baseId);
  let effectiveBaseId = action.baseId;
  let carried: CardId[] = [];
  let peeled: CardId[] | undefined;
  if (peel) {
    const line = base.line;
    const topCard = base.card;
    const realBaseId = peel.realBaseId;
    // Deeper bases stacked under the real base ride along into the new stack, the same way
    // `placeSourceUnder` carries a travelling stack.
    carried = topCard.underneath.slice(0, -1);
    // The 〈X〉 itself joins the hidden pile, together with anything already hidden under it.
    peeled = [action.baseId, ...(topCard.faceDown ?? [])];
    s.players[player][line].splice(s.players[player][line].indexOf(topCard), 1);
    s.players[player][line].push({
      cardId: realBaseId, instanceId: `${realBaseId}@${s.revision}#${ctx.events.length}`,
      underneath: [], active: topCard.active, attacksThisTurn: topCard.attacksThisTurn, blocksThisTurn: topCard.blocksThisTurn, bpModifiers: [],
    });
    emit(ctx, 'raidTopPeeled', { player, cardId: action.baseId, baseId: realBaseId, raiderId: action.cardId });
    clearTemporaryFieldState(s, action.baseId, topCard);
    clearTemporaryFieldState(s, realBaseId);
    effectiveBaseId = realBaseId;
  }
  const effectiveBase = peel ? findField(s, player, effectiveBaseId)! : base;
  // 「このカードはフロントLに登場できず」 — a `moveToFront` raid's arrival line is the front whatever the
  // base's own line is (the front-base case is already refused by `raidBaseEligible`; this is the
  // energy-base variant). Checked ahead of the payment so a refused raid costs nothing.
  requireRule(!action.moveToFront || !staticImmunity(s, action.cardId, player).noFront, 'INVALID_TARGET', '该卡不能登场到前线。');
  // The base is handed over so the 「…にレイドする際、必要エナジーを[色]減らす」 reduction can check
  // the printed base subject; an ordinary play never passes one.
  requireEnergy(s, player, card, action.cardId, effectiveBaseId);
  // A removal-area raid is priced and spent on the same axes as a hand raid: `getApCost` and
  // `consumeNextUseDiscount` both take the source zone, so a removal-scoped waiting discount attends it
  // and a hand-scoped one does not. `apCost` is computed once for the spend and the `free` log flag.
  const apCost = Math.max(0, getApCost(s, action.cardId, undefined, fromRemoval, true) + raidDiscountTotal(s, player, action.cardId));
  if (!fromTrigger) spendAp(ctx, player, apCost);
  recordUse(s, player, action.cardId);
  consumeNextUseDiscount(s, player, action.cardId, fromRemoval);
  consumeRaidDiscount(s, player, action.cardId);
  // A RAID is a *use* of the card, so it joins the turn log the same way a play does — 「このターン中に
  // 自分が〈X〉を使用している」 has to see it. `fromTrigger` raids (a life trigger's RAID) pay nothing,
  // which is exactly the 「APを支払わずに使用」 the log records. The `raid` detail tells the two routes
  // apart, which 「…をAPを支払わずに**レイド**している」 (MCR-2-036) needs: a played card that paid no AP
  // is not a raid.
  logTurnEvent(s, 'used', player, action.cardId, { raid: true, ...(fromTrigger ? { free: true } : { free: apCost === 0 && card.apCost > 0 }), ...(fromRemoval ? { usedFrom: 'removal' as const } : {}) });
  const to = action.moveToFront ? 'front' : effectiveBase.line;
  if (to !== effectiveBase.line) ensureRoom(ctx, player, to, action.replace);
  else requireRule(action.replace === undefined, 'INVALID_CHOICE', '原地 RAID 不需要移除其他角色。');
  // Before the base moves underneath: its 「レイドされた時」 ability has to be collected while it is
  // still a field card, and it resolves after the raid's own 登場時/レイド abilities.
  const queueLenBeforeRaided = ctx.queue.length;
  const raidedQueued = queueRaided(ctx, player, effectiveBaseId, action.cardId);
  p[effectiveBase.line].splice(p[effectiveBase.line].indexOf(effectiveBase.card), 1);
  if (fromRemoval) p.removal.splice(p.removal.indexOf(action.cardId), 1);
  else p.hand.splice(p.hand.indexOf(action.cardId), 1);
  // 「自分の効果でレイドしていた場合」 (IMC-1-020, Q2230) — a [レイドトリガー] raid *is* an effect entry,
  // so the trigger route records `by: 'effect'` while a hand raid stays `'play'` (Q374/Q375). The
  // ordinariness of the raid itself rides on the `raid` flag either way, so 「レイドさせている」 is
  // unaffected by the distinction.
  const top = newField(s, action.cardId, true, fromTrigger ? 'effect' : 'play', true, fromRemoval ? 'removal' : 'hand', fromTrigger ? player : undefined);
  top.underneath = [effectiveBaseId, ...carried];
  // 「裏向きのカードが下にあるキャラにレイドする」 — the base's own hidden pile is part of the same
  // physical stack, so it travels under the new top card (the base itself stays as `underneath[0]`).
  // Without this the pile fell out of every zone when the base's slot was spliced away, and the
  // end-of-command card-count invariant rejected the whole raid (BLK-1-090).
  if (peeled) top.faceDown = peeled;
  else if (effectiveBase.card.faceDown?.length) top.faceDown = [...effectiveBase.card.faceDown];
  p[to].push(top);
  clearTemporaryFieldState(s, effectiveBaseId, effectiveBase.card);
  for (const task of ctx.queue.slice(queueLenBeforeRaided)) {
    if (task.sourceId === action.cardId) task.sourceInstance = top.instanceId ?? top.cardId;
  }
  // 「このキャラがエナジーLからフロントLに移動した時、…」 — a `moveToFront` RAID *moves* the raider to the
  // front as well as entering it there. The move leaves the same record an ordinary move does (the line
  // it left and the one it reached), and its watchers are collected here, ahead of the entry ones: the
  // official ruling processes the front-line move first and 【登場時】 afterwards (Q819/Q987/Q1024/Q1040).
  // Without this write the move log only knew the movement-phase and effect routes, so a 「移動した時」
  // watcher never opened for a RAID — the watcher is collected generically, from the event, not card ids.
  if (to !== effectiveBase.line) {
    logTurnEvent(s, 'moved', player, action.cardId, { line: effectiveBase.line, to });
    ctx.queue.push(...collectTriggered(ctx, player, 'onMoved', action.cardId, action.cardId));
  }
  // A RAID is a 登場 too — 「このターン中に…登場している」 has to see it; the `raid` detail is what
  // 「このターン中に…レイドしている」 reads, since nothing else records the route.
  logTurnEvent(s, 'entered', player, action.cardId, { raid: true, from: 'hand' });
  clearEnteredDiscounts(s, player, action.cardId);
  ctx.queue.push(...collectTriggered(ctx, player, 'entered', action.cardId, action.cardId));
  // 「自分のキャラがレイドした時、…」 — the raid *route*'s own moment, raised for the raider. Distinct
  // from `onRaided`, which listens on the base, and from `entered`, which every placement raises: a
  // watcher that names the raid specifically must not fire for an ordinary play. The raider rides as the
  // event's subject, so a watcher's effect can speak about 「そのレイドしたキャラ」 (binding `E`).
  ctx.queue.push(...collectTriggered(ctx, player, 'onRaid', action.cardId, action.cardId));
  emit(ctx, 'raidPlayed', { player, cardId: action.cardId, baseId: action.baseId, destination: to });
  // 「このキャラはこのキャラのレイド元のカードが持つ[登場時][アタック時]を全て得る。」 (SMD-1-071) — the
  // base's own printed 登場時 fires together with the raider's, read from the stack the raid just built.
  const inherited = activeStatics(s, action.cardId, player)
    .filter((m): m is Extract<StaticModifier, { type: 'copyRaidBaseAbilities' }> => m.type === 'copyRaidBaseAbilities' && m.events.includes('onPlay'))
    .flatMap(() => top.underneath.flatMap(base2 => peekDefinition(s, base2)?.onPlay ?? []));
  // A RAID is a 登場 too, so a named-tail 【登場時】 budget applies on this route as well; only the
  // raider's own printed `onPlay` half is gated — the RAID clause and inherited abilities are not it.
  const ownEntry = prepareEntryEffects(s, player, card);
  // 「[レイドトリガー]」 — the raid itself is the trigger's doing, but the raider's own 登場時/レイド
  // sentence is a **card effect**, not the trigger's effect: it takes the default route by card kind,
  // so a 「相手のトリガーの効果で選ばれない」 guard must not bind to its selections. The trigger's own
  // inline/SPECIAL effects keep `route:'trigger'` (see below); `fromTrigger` only controls the queue.
  // An ordinary hand raid (or a 起動メイン's 「レイドさせる」) reads the same default.
  const task = makeTask(s, player, action.cardId, [...ownEntry, ...(card.onRaid ?? []), ...inherited]);
  task.abilityEvent = 'onPlay';
  attachEntryBudget(task, card);
  // 「（レイドしたキャラの[登場時]とこの効果は望む順で処理する）」 — when one of the just-queued watchers
  // prints the ordering permission, the raider's own [登場時] task joins that queue instead of running as
  // an immediate frame, so the controller orders the two (`resolveEffect` picks by taskId). The
  // permission lives on two shapes: a watcher card that prints it carries the flag on its own definition
  // (the raider-side shape, read through the queued task's source), while a *base*'s 「レイドされた時」
  // prints it on an ability whose queued task carries the **raider** as its source — there the base's
  // own definition is the only place the flag exists, guarded by whether its onRaided actually joined
  // the queue (queueRaided's return).
  const orderWithEntry = !fromTrigger && task.steps.length > 0
    && (ctx.queue.some(queued => peekDefinition(s, queued.sourceId)?.raidOrderChoice === true)
      || (raidedQueued && peekDefinition(s, effectiveBaseId)?.raidOrderChoice === true));
  if (fromTrigger) {
    requireRule(s.pending?.type === 'triggers', 'INVALID_STATE', 'RAID 触发缺少生命批次。');
    if (task.steps.length) (s.pending.effects ??= []).push(task);
  } else if (orderWithEntry) {
    // The base-side shape queues this entry task beside the base's [レイドされた時] — both were minted
    // with the raider as their source, so they share one `${revision}:${sourceId}` id; `resolveEffect`
    // addresses by id alone and the queue UI keys by it, which would leave the two indistinguishable
    // and the second unresolvable while the first stands. The suffix keeps both independently resolvable
    // in either order, which is the permission the print grants.
    task.id = `${task.id}:entry`;
    ctx.queue.push(task);
  } else startEffect(ctx, task);
  checkBP(ctx);
}

/**
 * 「このキャラがレイドされた時、…」 — the *base* card's own ability, raised by a RAID played onto it.
 *
 * Collected while the base is still on top and queued with the raider as the effect's source: the
 * base becomes the raider's underneath card, so after the placement nothing can look it up as a
 * field card, while the printed wording keeps speaking about the stack it created.
 */
export function queueRaided(ctx: Context, player: PlayerId, baseId: CardId, raiderId: CardId): boolean {
  const s = ctx.state;
  const base = findField(s, player, baseId);
  if (!base) return false;
  const definition = peekDefinition(s, baseId);
  // 「元々の効果を全て失い」 (Q2211) — a suppressed base's *printed* [レイド時] stays silent; the
  // abilities it gained still fire (the same split every collection site keeps).
  const abilities = [
    ...(effectsSuppressed(s, baseId) ? [] : definition?.triggered ?? []),
    ...(base.card.grantedAbilities ?? []).filter(g => g.expiresTurn >= s.turn).map(g => g.ability),
  ].filter(ability => ability.event === 'onRaided' && (!ability.condition || evalCondition(s, baseId, player, ability.condition)));
  for (const ability of abilities) ctx.queue.push(makeTask(s, player, raiderId, ability.effects));
  // Whether anything joined the queue: the raid's 「望む順」 check needs to know that *this* base's
  // [レイドされた時] is among the queued tasks (the task carries the raider as its source, so the
  // base's own definition is unreachable from the task alone).
  return abilities.length > 0;
}

function move(ctx: Context, player: PlayerId, action: Extract<Action, { type: 'move' }>): void {
  const s = ctx.state;
  const p = s.players[player];
  const removals = action.remove ?? [];
  requireRule(new Set(action.moves.map(m => m.cardId)).size === action.moves.length && new Set(removals).size === removals.length, 'INVALID_CHOICE', '移动或移除目标不能重复。');
  const transfers = action.moves.map(m => {
    const source = findField(s, player, m.cardId);
    requireRule(source && source.line !== m.to && getDefinition(s, m.cardId).kind === 'character', 'INVALID_TARGET', '只能移动自己的角色到另一条战线。');
    // 「移動フェイズで移動できない。」 — the phase-scoped refusal joins the unbounded one here; the effect
    // route (`effects.ts`) reads `move` alone, which is the split the two printed spellings name.
    requireRule(!staticForbids(s, m.cardId, player).move && !staticForbids(s, m.cardId, player).movePhase, 'INVALID_CHOICE', '此角色不能移动。');
    // 「このカードはエナジーLに〔登場・移動〕できず」 — the energy line refuses the card by the movement
    // phase as well, the same refusal the play action already reads for a placement.
    requireRule(m.to !== 'energy' || !staticImmunity(s, m.cardId, player).noEnergy, 'INVALID_TARGET', '该卡不能进入能量线。');
    // 「このカードはフロントLに〔登場・移動〕できない」 — the movement-phase route is 移動 too, so the
    // refusal applies (「…の[起動メイン]以外で移動できない」-style carve-outs never cover a move action).
    // The standalone 「フロントLに登場できない」 reaches only `noFront` and leaves this route open.
    requireRule(m.to !== 'front' || !staticImmunity(s, m.cardId, player).noFrontMove, 'INVALID_TARGET', '该卡不能进入前线。');
    // 「相手は次の相手のターンの移動フェイズでエナジーLのキャラをフロントLに移動できず、フロントLの
    // キャラをエナジーLへ移動できる。」 (SMD-1-080) — the directions are swapped for the player carrying
    // the static: energy→front is refused, front→energy needs no STEP. The `move` action is only legal in
    // the movement phase, so the printed 「移動フェイズで」 is already the only context here.
    const swapped = playerStatics(s, player).some(m => m.type === 'moveDirectionSwap');
    requireRule(!(swapped && m.to === 'front'), 'INVALID_CHOICE', '此角色被限制不能移动到前线。');
    requireRule(swapped || source.line !== 'front' || getKeywords(s, m.cardId).step || staticCanStep(s, m.cardId, player), 'INVALID_CHOICE', '从前线回能量线需要 STEP。');
    return { ...m, source };
  });
  for (const id of removals) requireRule(findField(s, player, id) && !action.moves.some(m => m.cardId === id), 'INVALID_TARGET', '移除目标必须是没有参与移动的原有场上卡。');
  for (const line of ['front', 'energy'] as const) {
    const finalSize = p[line].length - transfers.filter(t => t.source.line === line).length + transfers.filter(t => t.to === line).length;
    const removed = removals.filter(id => findField(s, player, id)?.line === line).length;
    requireRule(removed === Math.max(0, finalSize - lineCapacity(s, player, line)), 'INVALID_CHOICE', '只能移除同时移动后超出战线容量的数量。');
  }
  for (const id of removals) leaveField(ctx, player, id, 'removal', 'movement-capacity');
  // A move takes each card off the line it was on — a 「…かぎり」 grant whose print named that line ends
  // here for good, whether or not the card ever comes back (Q933/Q934). Run before the slots shuffle so
  // every grant target is still on its line to be found.
  for (const transfer of transfers) expireWhileSourceGrants(s, transfer.cardId, transfer.source.line);
  for (const transfer of transfers) p[transfer.source.line].splice(p[transfer.source.line].indexOf(transfer.source.card), 1);
  for (const transfer of transfers) {
    p[transfer.to].push(transfer.source.card);
    logTurnEvent(s, 'moved', player, transfer.cardId, { line: transfer.source.line, to: transfer.to });
    emit(ctx, 'characterMoved', { player, cardId: transfer.cardId, destination: transfer.to });
  }
  s.phase = 'main';
  emit(ctx, 'phaseChanged', { phase: s.phase });
  // 「自分のメインフェイズ開始時、…」 (KMR-2-080) — the main phase opening, raised where the phase is set
  // (ahead of the move watchers below, since the print names the phase's *start*).
  ctx.queue.push(...collectTriggered(ctx, player, 'onMainPhaseStart'));
  // 「このキャラが移動した時」 — raised once the phase is settled, so the entry the watcher reads carries
  // the phase the move actually happened in (movement) rather than the main phase that follows it, and a
  // 「アタックフェイズ中に…移動した」 watcher cannot open on a movement-phase move.
  for (const transfer of transfers) {
    ctx.queue.push(...collectTriggered(ctx, player, 'onMoved', transfer.cardId));
  }
}

export function endBattle(ctx: Context): void {
  const s = ctx.state;
  const battle = s.battle;
  s.pending = null;
  s.battle = null;
  emit(ctx, 'battleEnded');
  for (const player of [0, 1] as const) if (s.players[player].life.length === 0) { finish(ctx, player, 'life-zero'); break; }
  // 「このキャラのアタック終了時」 fires once the battle is over, for the card that declared it — after the
  // comparison and the damage, so an ability that ends the attack can still see the result. The attacker
  // rides as the event's subject (bound `E`), which a watcher on *another* card reads when it names
  // 「そのキャラ」 (MCR-1-041/047 peel the attacking stack's top).
  if (battle && s.status === 'playing' && findField(s, battle.attacker, battle.attackerId)) {
    // A blocked attack's close carries the blocker as well (「このキャラをブロックしたキャラ」,
    // KMR-2-083): `s.battle` is already cleared above, so the raising site snapshots it onto the tasks.
    raiseQueue(ctx, battle.attacker, 'onAttackEnd', 'none', undefined, battle.attackerId, undefined, {
      subject: battle.attackerId,
      ...(battle.blockerId !== undefined ? { blocker: battle.blockerId } : {}),
      battle,
    });
    // 「このキャラがバトルに勝利したアタック終了時、…」 — the same close narrowed to a battle this
    // attacker won. A separate event because the battle is already closed when the watchers are
    // collected and nothing on the board remembers the comparison's outcome.
    if (battle.won) {
      raiseQueue(ctx, battle.attacker, 'onBattleWinAttackEnd', 'none', undefined, battle.attackerId, undefined, { subject: battle.attackerId, battle });
    }
    // 「自分のキャラがバトルに敗北したアタック終了時、…」 (MGS-1-021) — the losing side's sibling of the
    // win-narrowed watcher, raised for the owner of the character that lost the comparison. The attacker
    // lost when a comparison ran and `battle.won` is false; a blocker that lost sits on the winning
    // attacker's board. 「アタックをした先が相手プレイヤーの場合」 (Q1625) ran no battle at all — the
    // unblocked attack reads `compared` as false and raises nothing.
    if (battle.compared && !battle.won) {
      raiseQueue(ctx, battle.attacker, 'onBattleLossAttackEnd', 'none', undefined, battle.attackerId, undefined, { subject: battle.attackerId, battle });
    }
  }
  if (battle && s.status === 'playing' && battle.won && battle.blockerId !== undefined) {
    const blockerOwner = s.cards[battle.blockerId]?.owner;
    if (blockerOwner !== undefined) {
      raiseQueue(ctx, blockerOwner, 'onBattleLossAttackEnd', 'none', undefined, battle.blockerId, undefined, { subject: battle.blockerId, battle });
    }
  }
  // 「このキャラがブロックしたバトルの終了時」 — the *blocker's* own end-of-battle moment. A separate
  // event rather than a second subject on `onAttackEnd`: the printed watchers name which side of the
  // battle they are about, and firing a 「アタック終了時」 ability for the blocker would answer a moment
  // the print never named.
  if (battle && s.status === 'playing' && battle.blockerId !== undefined) {
    const blockerOwner = s.cards[battle.blockerId]?.owner;
    if (blockerOwner !== undefined && findField(s, blockerOwner, battle.blockerId)) {
      raiseQueue(ctx, blockerOwner, 'onBlockedBattleEnd', 'none', undefined, battle.blockerId, undefined, { battle });
    }
  }
}

function damage(ctx: Context, count: number): void {
  const s = ctx.state;
  const battle = s.battle!;
  const amount = Math.min(count, s.players[battle.defender].life.length);
  if (amount === 0) { endBattle(ctx); return; }
  // 「このターン中に自分の場のキャラが相手プレイヤーにダメージを与えている」 — the damage *arriving*
  // (an unblocked attack or インパクト), recorded here where it happens because nothing on the board
  // remembers it afterwards. A blocked attack that dealt nothing never reaches this point.
  logTurnEvent(s, 'dealtPlayerDamage', battle.attacker, battle.attackerId);
  const offer = damageSubstituteOffer(s, battle.defender, amount);
  if (offer) {
    s.pending = { type: 'damageSubstitute', player: battle.defender, damagedPlayer: battle.defender, count: amount, sourceId: battle.attackerId, ...offer };
    emit(ctx, 'damageSubstituteOffered', { player: battle.defender, count: amount, to: offer.reduceTo });
    return;
  }
  openDamage(ctx, { player: battle.attacker, damagedPlayer: battle.defender, count: amount, sourceId: battle.attackerId });
}

/**
 * 「相手プレイヤーにNダメージ。」 — player burn dealt by a resolving effect, with no battle open.
 *
 * The life area and its trigger batch are the battle path's, so the pending is the same `damage` one and
 * `chooseDamage`/`resolveTrigger`/`settleTriggers` need no parallel implementation. Two things differ:
 * the battle fields are read from the *effecting* player instead of `s.battle` (that side is the one who
 * chooses which life cards are revealed, exactly as the attacker does in battle), and `outsideBattle`
 * tells validation that the absence of a battle is the shape of this state rather than a corruption.
 *
 * A burst larger than the life area takes the whole area (the battle path truncates the same way); the
 * frame's own end is what calls this, never the effect loop — see `CardEffect`'s `playerDamage`.
 */
export function damagePlayer(ctx: Context, player: PlayerId, count: number, sourceId?: CardId): void {
  const s = ctx.state;
  const damagedPlayer = otherOf(player);
  const amount = Math.min(count, s.players[damagedPlayer].life.length);
  if (amount === 0) return;
  // The same record the battle path writes: 「このターン中に自分の場のキャラが相手プレイヤーにダメージ
  // を与えている」 counts effect burn too, and `sourceId` names the card that dealt it.
  if (sourceId !== undefined) logTurnEvent(s, 'dealtPlayerDamage', player, sourceId);
  const offer = damageSubstituteOffer(s, damagedPlayer, amount);
  if (offer) {
    // The *answering* player is the damaged one, which is what the command guard reads; the side that
    // would otherwise open the damage question is `otherOf(damagedPlayer)`, restored on the answer.
    s.pending = { type: 'damageSubstitute', player: damagedPlayer, damagedPlayer, count: amount, outsideBattle: true, ...(sourceId !== undefined ? { sourceId } : {}), ...offer };
    emit(ctx, 'damageSubstituteOffered', { player: damagedPlayer, count: amount, to: offer.reduceTo });
    return;
  }
  openDamage(ctx, { player, damagedPlayer, count: amount, outsideBattle: true, ...(sourceId !== undefined ? { sourceId } : {}) });
}

/**
 * The damage question itself, split out so the substitute answer can resume exactly what it asked about.
 */
function openDamage(ctx: Context, pending: Omit<Extract<PendingDecision, { type: 'damage' }>, 'type'>): void {
  const s = ctx.state;
  const opened: Extract<PendingDecision, { type: 'damage' }> = { type: 'damage', ...pending };
  s.pending = opened;
  emit(ctx, 'damageRequested', { player: opened.damagedPlayer, count: opened.count });
  // With one remaining life there is no slot choice. Trigger activation is still a decision.
  if (s.players[opened.damagedPlayer].life.length === 1) chooseDamage(ctx, [0]);
}

/**
 * 「自分が一度に2ダメージ以上受ける場合、代わりに1ダメージにしてもよい。」 — the offer, if the damaged
 * player's own field prints one that answers this burst and its per-turn mark is unspent.
 */
function damageSubstituteOffer(s: GameState, damaged: PlayerId, amount: number): { substituteCardId: CardId; reduceTo: number } | undefined {
  for (const card of [...s.players[damaged].front, ...s.players[damaged].energy]) {
    if (card.triggeredUsed?.damageSubstitute) continue;
    for (const modifier of activeStatics(s, card.cardId, damaged)) {
      if (modifier.type === 'damageSubstitute' && amount >= modifier.min) return { substituteCardId: card.cardId, reduceTo: modifier.to };
    }
  }
  return undefined;
}

function compareBattle(ctx: Context, defenderId: CardId): void {
  const s = ctx.state;
  const battle = s.battle!;
  const attacker = findField(s, battle.attacker, battle.attackerId)!;
  const defender = findField(s, battle.defender, defenderId)!;
  const attackBP = getBP(s, attacker.card);
  const defendBP = getBP(s, defender.card);
  // 「相手の[インパクト無効]は発動しない。」 — the defender's opponent may forbid the keyword; the
  // battle counterpart's strip (「このキャラとバトルをしたキャラは…失う」) reads the same way here.
  const negate = getKeywords(s, defenderId).impactNegate
    && !forbiddenKeyword(s, otherOf(s.cards[defenderId]?.owner ?? 0), 'impactNegate')
    && !battleOpponentStripsKeyword(s, battle.attackerId, 'impactNegate');
  const impact = getImpact(s, attacker.card);
  // The comparison happened (「バトルを行った」): the attack-end raise reads this beside `won` so an
  // unblocked attack's missing outcome is not mistaken for a loss (MGS-1-021 / Q1625).
  battle.compared = true;
  emit(ctx, 'battleCompared', { attackerId: battle.attackerId, defenderId, attackBP, defendBP });
  if (attackBP >= defendBP) {
    // 「アタックしてバトルに勝利した時」 is raised for the attacker alone, and before the loser leaves:
    // the ability's own text may still name the defender (「敗北した相手のキャラは…」), which needs it
    // to be on the field while the queue resolves. The resume is `'battleWin'`, not `'none'`: once the
    // queue empties, the battle's own tail (the loser leaving, インパクト, the end) still has to run.
    // The outcome is recorded on the battle so the attack's close can fire the win-narrowed
    // 「バトルに勝利したアタック終了時」 watchers (`onBattleWinAttackEnd`).
    battle.won = true;
    // 「このバトルで敗北した相手のキャラは退場する代わりに、手札に戻る。」 (Q1464/Q1466/Q1468) — the
    // replacement is the battle resolution's ① step, so the departure and everything its arrival in hand
    // triggers run *before* the win ability's own 「バトルに勝利した時」 effects (③); the printed step
    // order of the ability (draw first) is not the resolution order. The destination is pre-read from the
    // win tasks itself, ahead of the queue that will run them.
    const winTasks = collectTriggered(ctx, battle.attacker, 'onBattleWin', battle.attackerId);
    const replacement = battleLoserReplacement(winTasks);
    if (replacement !== undefined && !battleLossOfferOpens(s, battle, defenderId)) {
      s.battleLoserTo = replacement.destination;
      s.battleLoserToSource = replacement.sourceId;
      sendBattleLoser(ctx, battle, defenderId);
      // Whichever branch the send took (the card left, refused, or stayed), the replacement is settled
      // for this battle: the queued copy of the step must not re-arm it.
      delete s.battleLoserTo; delete s.battleLoserToSource;
      battle.loserSent = true;
    }
    if (winTasks.length) {
      // The departure's own triggers precede the win effects; both wait in the one queue. Without a
      // pre-applied replacement nothing is moved ahead, so the queue is exactly `raiseQueue`'s.
      const departure = battle.loserSent === true ? ctx.queue.splice(0, ctx.queue.length) : [];
      s.pending = { type: 'queue', player: battle.attacker, effects: [...departure, ...winTasks], resume: 'battleWin', defenderId };
      return;
    }
    if (sendBattleLoser(ctx, battle, defenderId)) return;
    if (impact && !negate) { damage(ctx, impact); return; }
  }
  // 「このキャラがアタックしてバトルに敗北した時」 belongs to the *attacker* that lost, so the ability is
  // collected from the attacking player's board and scoped to the attacking card. The same outcome is
  // the *blocker's* victory: 「このキャラがブロックしてバトルに勝利した時」 (HIQ-1-062/ARK-2-062/
  // BLK-1-086, Q1714/Q858) is raised for the blocking card in the same queue — both watchers name this
  // one moment — and `blockerId` alone gates it, so a 狙撃 target's loss is not a block victory (Q1715).
  else {
    const blockerOwner = battle.blockerId !== undefined ? s.cards[battle.blockerId]?.owner : undefined;
    const tasks = [
      ...collectTriggered(ctx, battle.attacker, 'onBattleLose', battle.attackerId),
      // 「このキャラがバトルに勝利した時」 — the *defending* side wins this comparison too: raised for the
      // defending card's owner, scoped to the card that took the defence (Q763/Q1084/Q1086 — being
      // attacked and coming out with the higher BP is a battle victory, `アタックして` is not printed).
      // Ordered after the attacker's loss watchers so the existing attacker-side collection stays put.
      ...collectTriggered(ctx, battle.defender, 'onBattleWin', defenderId, undefined, { defending: true }),
      ...(battle.blockerId !== undefined && blockerOwner !== undefined
        ? collectTriggered(ctx, blockerOwner, 'onBlockWin', battle.blockerId)
        : []),
    ];
    if (tasks.length) { s.pending = { type: 'queue', player: battle.attacker, effects: tasks, resume: 'battleLose' }; return; }
  }
  endBattle(ctx);
}

/**
 * Where the losing defender goes: 場外 by default, or wherever the winner's 「敗北した相手のキャラは
 * 退場する代わりに…」 sends it.
 *
 * The winner's replacement is read from the attacker; the receiving energy line's owner chooses
 * which resident leaves. Q1614 confirms making room before moving, without naming the chooser.
 * The `energyOverflow` decision parks the battle until that owner's answer resumes the send.
 */
/**
 * 「自分の場のカード名に「バサラ」を含むキャラの効果に記載されている「退場する代わりに、手札に戻る。」は
 * 「退場する代わりに、相手の山札の下に置かれる。」に代わる。」 — whether the winner's side holds the static
 * that rewrites a named card's printed destination, and the effect that printed it came from such a card.
 */
function loserToDeckBottom(s: GameState, winner: PlayerId, sourceId: CardId): boolean {
  const definition = peekDefinition(s, sourceId);
  if (!definition) return false;
  const statics = [...s.players[winner].front, ...s.players[winner].energy]
    .flatMap(card => activeStatics(s, card.cardId, winner).filter((m): m is Extract<StaticModifier, { type: 'loserToDeckBottom' }> => m.type === 'loserToDeckBottom'));
  return statics.some(rule => definition.name.includes(rule.nameContains));
}

/**
 * The ① step a winner's 「バトルに勝利した時」 tasks carry, if any — 「敗北した相手のキャラは退場する
 * 代わりに、手札に戻る。」 (MCR-1-080 family). Read ahead of the queue so the departure runs where the
 * FAQ's timing chart puts it (Q1464/Q1466/Q1468: ①回手+诱发 → ③「勝時」效果).
 */
function battleLoserReplacement(tasks: EffectTask[]): { destination: NonNullable<GameState['battleLoserTo']>; sourceId: CardId } | undefined {
  for (const task of tasks) {
    for (const step of task.steps) {
      if (step.type === 'battleLoserTo') return { destination: step.destination, sourceId: task.sourceId };
    }
  }
  return undefined;
}

function battleLossOfferOpens(s: GameState, battle: NonNullable<GameState['battle']>, defenderId: CardId): boolean {
  const cost = retireCostSubstitute(s, battle.defender, defenderId, battle.attacker, false, 'characterEffect', true, true);
  return cost !== undefined && cost.hand !== undefined;
}

function sendBattleLoser(ctx: Context, battle: NonNullable<GameState['battle']>, defenderId: CardId, answered = false): boolean {
  const s = ctx.state;
  // 「このキャラはバトルの敗北…で場を離れず」 — the battle loss is the rules' own comparison, not an
  // effect, so the printed refusal is asked here before any destination is chosen (KMR-1-052).
  if (refusesBattleDefeat(s, defenderId, battle.defender)) return false;
  // An ability that resolved before this comparison may have named a destination for *this* battle; the
  // printed static is the standing version of the same rule, so the one-shot wins.
  let destination = s.battleLoserTo ?? staticBattleLoserTo(s, battle.attackerId, battle.attacker);
  // 「BPN以下のキャラとのバトルで敗北したこのキャラは、退場する代わりに…」 (KMR-2-009) — the loser's own
  // replacement, read only where the winner printed none: the printed winner-side rewrite is the more
  // specific instruction and the engine keeps that precedence.
  if (destination === undefined) {
    const winnerSlot = findField(s, battle.attacker, battle.attackerId);
    destination = staticSelfBattleLoserTo(s, defenderId, battle.defender, winnerSlot ? getBP(s, winnerSlot.card) : 0);
  }
  // 「自分の場のカード名に「バサラ」を含むキャラの効果に記載されている「退場する代わりに、手札に戻る。」
  // は「退場する代わりに、相手の山札の下に置かれる。」に代わる。」 — a text-rewriting static on the
  // winner's side redirects the one-shot a matching (「バサラ」) card's own effect printed.
  if (destination === 'hand' && s.battleLoserToSource !== undefined && loserToDeckBottom(s, battle.attacker, s.battleLoserToSource)) {
    destination = 'deckBottom';
  }
  // 「このキャラとのバトルで敗北した相手のキャラは、退場しない。」 (DST-1-070) — the loser keeps its
  // slot: no leave and no bookkeeping, the battle simply ends with both participants where they are.
  if (destination === 'stay') {
    delete s.battleLoserTo; delete s.battleLoserToSource;
    return false;
  }
  // 「相手の効果やバトルによってこのキャラが場を離れる場合、代わりに自分の手札を1枚場外に置いてもよい。」
  // (BLC-2-067) — the losing card's own bought-off departure, asked of its owner before the departure the
  // destination above describes. The one-shot destination records stay put until the question is
  // answered, so a decline resumes into the same branch it would have taken here.
  if (!answered) {
    const probe = retireCostSubstitute(s, battle.defender, defenderId, battle.attacker, false, 'characterEffect', true, true);
    if (probe && probe.hand !== undefined) {
      const cost = retireCostSubstitute(s, battle.defender, defenderId, battle.attacker, false, 'characterEffect', true);
      if (cost && cost.hand !== undefined) {
        s.pending = {
          type: 'battleLossSubstitute', player: battle.defender, cardId: defenderId, hand: cost.hand,
          ...(cost.follow?.length ? { follow: structuredClone(cost.follow) } : {}),
        };
        emit(ctx, 'battleLossSubstituteOffered', { player: battle.defender, cardId: defenderId });
        return true;
      }
    }
  }
  delete s.battleLoserTo;
  delete s.battleLoserToSource;

  if (destination === 'removal') { leaveField(ctx, battle.defender, defenderId, 'removal', 'battle'); return false; }
  if (destination === 'hand') {
    // Q1720 vs Q1469: an unqualified return refusal covers this rules replacement; an opponent-effect
    // refusal does not. The failed replacement keeps the card on the field, without retiring it.
    if (!refusesHandReturn(s, defenderId, battle.defender, false, 'battle')) leaveField(ctx, battle.defender, defenderId, 'hand', 'battle');
    return false;
  }
  // 「退場する代わりに、相手の山札の下に置かれる」 — the loser leaves the field for its *owner's* deck
  // bottom (the printed 「相手の」 reads from the winner's side). No 退場 watcher fires: the card is not
  // sent to 場外, exactly like the hand route above.
  if (destination === 'deckBottom') { leaveField(ctx, battle.defender, defenderId, 'deckBottom', 'battle'); return false; }
  if (destination !== 'energy') { leaveField(ctx, battle.defender, defenderId, 'sideline', 'battle'); return false; }
  const defender = battle.defender;
  // 「移動できない」キャラ (Q1647: OPM-1-056 番犬マン) does not move to the energy line either: it does not
  // retire and does not move — it stays where it is. The check comes before the capacity handling so a
  // move that will not happen cannot trigger the overflow removal.
  if (staticForbids(s, defenderId, defender).move) return false;
  const loser = s.players[defender];
  if (loser.energy.length >= lineCapacity(s, defender, 'energy')) {
    if (!loser.energy.length) { leaveField(ctx, defender, defenderId, 'sideline', 'battle'); return false; }
    s.pending = { type: 'energyOverflow', player: defender, defender, defenderId, cards: loser.energy.map(slot => slot.cardId) };
    emit(ctx, 'energyOverflowAsked', { player: defender, defender });
    return true;
  }
  moveLoserToEnergy(ctx, defender, defenderId);
  return false;
}

/** The move half of the `'energy'` destination: the losing card slides into the (now free) energy line. */
function moveLoserToEnergy(ctx: Context, defender: PlayerId, defenderId: CardId): void {
  const s = ctx.state;
  const located = findField(s, defender, defenderId);
  if (!located) return;
  s.players[defender][located.line].splice(s.players[defender][located.line].indexOf(located.card), 1);
  s.players[defender].energy.push(located.card);
  emit(ctx, 'characterMoved', { player: defender, cardId: defenderId, destination: 'energy' });
}

function attack(ctx: Context, player: PlayerId, action: Extract<Action, { type: 'attack' }>): void {
  const s = ctx.state;
  // 「自分はこのターン中、合計N回までしかアタックできない。」 — a player-scope cap, counted from the
  // turn log's `attacked` entries (the same log `TierCount.selfAttackedThisTurn` reads the per-card
  // form of). The tightest active cap wins when several are held.
  const limits = playerStatics(s, player).filter((m): m is Extract<StaticModifier, { type: 'attackLimit' }> => m.type === 'attackLimit').map(m => m.max);
  if (limits.length) {
    const used = (s.turnEvents ?? []).filter(entry => entry.event === 'attacked' && entry.player === player).length;
    requireRule(used < Math.min(...limits), 'INVALID_CHOICE', '本回合的アタック次数已达上限。');
  }
  const located = findField(s, player, action.cardId);
  // 「このキャラはエナジーLからアタックできる。」 lifts the front-line requirement for that one card;
  // every other character still has to be on the front line.
  const fromEnergy = located !== undefined && staticForbids(s, action.cardId, player).energyAttack;
  requireRule(located && (located.line === 'front' || (located.line === 'energy' && fromEnergy)), 'INVALID_CARD', '只有自己前线的角色可以攻击。');
  requireRule(!staticForbids(s, action.cardId, player).attack, 'INVALID_CARD', '此角色不能攻击。');
  // 「自分はこのターン中、「〈X〉以外のキャラでアタックできない。」を得る。」 (AOT-2-034) — the
  // player-scope restriction: this turn only characters counting as one of the named cards may attack.
  const attackOnly = playerStatics(s, player).flatMap(m => (m.type === 'attackOnlyNames' ? m.names : []));
  if (attackOnly.length) {
    requireRule(effectiveNames(s, action.cardId, player).some(name => attackOnly.includes(name)), 'INVALID_CARD', '此角色不能攻击。');
  }
  requireRule(located.card.active, 'NOT_ACTIVE', '休息状态不能攻击。');
  // Q1694: only attackable self-obliged cards take precedence, in any order among themselves.
  const mandatory = mandatoryAttackers(s, player);
  requireRule(mandatory.length === 0 || mandatory.includes(action.cardId), 'INVALID_CHOICE', '必须先由可攻击的义务角色攻击。');
  const keywords = getKeywords(s, action.cardId);
  const late = hasDeclarationWatchers(s, player, action.cardId) || action.askTarget === true;
  located.card.active = false;
  logTurnEvent(s, 'rested', player, action.cardId);
  if (keywords.doubleAttack && located.card.attacksThisTurn === 0) {
    located.card.active = true;
    // 「[2回アタック]」 stands the card up mid-attack; that is still 「レストの…がアクティブになった」.
    logTurnEvent(s, 'activatedByEffect', player, action.cardId);
    ctx.queue.push(...collectTriggered(ctx, player, 'onActivated', action.cardId, undefined, { activation: 'rule' }));
  }
  located.card.attacksThisTurn++;
  // Every battle gets its own number: 「アタック終了時まで」 modifiers read it back to know whether
  // the battle they were granted in is still the one running.
  const seq = (s.battleSeq ?? 0) + 1;
  s.battleSeq = seq;
  // The battle exists before the 「際」 batch resolves: `grantStatic{duration:'attackEnd'}` stamps the
  // battle's seq, and the designation window needs the battle it belongs to.
  s.battle = {
    attacker: player, attackerId: action.cardId, defender: otherOf(player), seq,
    ...(late ? {
      declare: {
        ...(action.targetId !== undefined ? { targetId: action.targetId } : {}),
        ...(action.askTarget === true ? { ask: true as const } : {}),
      },
    } : {}),
  };
  // Logged before the attack's own triggers resolve, so 「このターンで最初の自分のキャラのアタック」
  // answers about *this* attack: at that moment the log holds exactly one entry. The line the attacker
  // stood on rides along, which is what 「このターン中に自分のキャラがエナジーLからアタックしていない」
  // reads back (the card may have moved since, and the phase may have changed).
  logTurnEvent(s, 'attacked', player, action.cardId, { line: located.line });
  // The designation is its own moment now; a pre-declared target is reported by `attackTargetDesignated`.
  emit(ctx, 'attackDeclared', { player, cardId: action.cardId, targetId: null });
  // Fast path: no declaration-time watcher → today's immediate designation. It runs after the declaration
  // is recorded so the log reads 宣言 → 指定; the command is atomic, so a refusal still leaves no trace and
  // the error codes/messages are the same ones the old inline check threw.
  if (!late && action.targetId !== undefined) designateTarget(ctx, player, action.cardId, action.targetId);
  if (late) {
    if (raiseQueue(ctx, player, 'onAttackDeclare', 'attackDeclare', undefined, action.cardId)) return;
    continueAttack(ctx);
    return;
  }
  raiseAttackTime(ctx);
}

function hasDeclarationWatchers(s: GameState, player: PlayerId, attackerId: CardId): boolean {
  const concerns = (listenerId: CardId, ability: TriggeredAbility): boolean => {
    if (ability.event !== 'onAttackDeclare') return false;
    // 「際」 is the attacker's own moment: the opponent-side spelling is never collected for it.
    if (ability.scope === 'anyOfTheirs') return false;
    if (listenerId !== attackerId && ability.scope !== 'anyOfMine') return false;
    if (ability.eventCard && !matchesEventCard(s, attackerId, ability.eventCard, undefined, listenerId)) return false;
    return true;
  };
  for (const card of [...s.players[player].front, ...s.players[player].energy]) {
    const definition = peekDefinition(s, card.cardId);
    const printed = effectsSuppressed(s, card.cardId) ? [] : definition?.triggered ?? [];
    for (const ability of printed) if (ability.zone !== 'hand' && concerns(card.cardId, ability)) return true;
    for (const grant of card.grantedAbilities ?? []) if (grant.expiresTurn >= s.turn && concerns(card.cardId, grant.ability)) return true;
    for (const ability of grantedTriggersOf(s, card.cardId, player)) if (concerns(card.cardId, ability)) return true;
  }
  // 「手札にある場合」 — the hand channel has no self/anyOfMine narrowing of its own: `collectTriggered`
  // filters it through `eventCard` only.
  for (const id of s.players[player].hand) {
    for (const ability of peekDefinition(s, id)?.triggered ?? []) {
      if (ability.event !== 'onAttackDeclare' || ability.zone !== 'hand') continue;
      if (ability.scope === 'anyOfTheirs') continue;
      if (ability.eventCard && !matchesEventCard(s, attackerId, ability.eventCard, undefined, id)) continue;
      return true;
    }
  }
  // 「[場外にある場合]…」 — the sideline scan owns only the abilities its own condition scopes there.
  for (const id of s.players[player].sideline) {
    for (const ability of peekDefinition(s, id)?.triggered ?? []) {
      if (ability.event !== 'onAttackDeclare' || !sidelineScoped(ability.condition)) continue;
      if (ability.scope === 'anyOfTheirs') continue;
      if (!ability.eventCard && id !== attackerId) continue;
      if (ability.eventCard && !matchesEventCard(s, attackerId, ability.eventCard)) continue;
      return true;
    }
  }
  for (const grant of s.players[player].grantedAbilities ?? []) {
    if (grant.expiresTurn < s.turn) continue;
    for (const ability of grant.abilities) {
      if (ability.event !== 'onAttackDeclare') continue;
      if (ability.scope === 'anyOfTheirs') continue;
      if (ability.eventCard && !matchesEventCard(s, attackerId, ability.eventCard)) continue;
      return true;
    }
  }
  return false;
}

function snipeSelectionTax(tax: { amount: number; kind: 'ap' | 'hand' | 'rest' } | undefined): SelectionTax | undefined {
  if (!tax || tax.kind === 'rest') return undefined;
  return tax.kind === 'hand' ? { ap: 0, hand: tax.amount, rest: [] } : { ap: tax.amount, hand: 0, rest: [] };
}

/** Whether the target's designation tax could be paid right now — checked, never spent. */
function snipeTaxPayable(s: GameState, targetId: CardId, chooser: PlayerId): boolean {
  return canPayTax(s, targetId, chooser, snipeSelectionTax(staticSnipeTax(s, targetId, chooser)));
}

/**
 * The legal 狙い撃ち candidates for this attack: the attacker must hold the keyword *now*, and each target
 * has to be on the opponent's front line, unprotected, under the sniper's BP ceiling and able to pay its
 * own designation tax. Read after the 「際」 batch resolved, which is the whole point of the two stages.
 */
function designationCandidates(ctx: Context, battle: NonNullable<GameState['battle']>): CardId[] {
  const s = ctx.state;
  const player = battle.attacker;
  const other = battle.defender;
  if (!getKeywords(s, battle.attackerId).snipe) return [];
  const ceiling = staticSnipeCeiling(s, battle.attackerId, player);
  return s.players[other].front
    .filter(card => !staticForbids(s, card.cardId, other).sniped)
    .filter(card => ceiling === undefined || getBP(s, card) < ceiling)
    .filter(card => snipeTaxPayable(s, card.cardId, player))
    .map(card => card.cardId);
}

/**
 * Validates a designation, pays its tax and lands it on the open battle (if there is one).
 *
 * The fast path runs it as the old inline check did — a refusal throws and the whole command rolls back, so
 * an illegal target leaves no tax paid and the error text is unchanged. The slow path runs it after the
 * candidates were filtered; throwing there would mean the engine contradicted itself.
 */
function designateTarget(ctx: Context, player: PlayerId, attackerId: CardId, targetId: CardId): CardId {
  const s = ctx.state;
  requireRule(getKeywords(s, attackerId).snipe, 'INVALID_CHOICE', '指定角色攻击需要 SNIPE。');
  const other = otherOf(player);
  const target = findField(s, other, targetId);
  requireRule(target?.line === 'front', 'INVALID_TARGET', 'SNIPE 只能指定对方前线角色。');
  // 「…は、[狙い撃ち]で指定されない。」 — the protection sits on the *target*, so it is read from the
  // target's own statics rather than from the attacker's.
  requireRule(!staticForbids(s, targetId, other).sniped, 'INVALID_TARGET', '该角色不会被狙击指定。');
  const snipeTax = snipeSelectionTax(staticSnipeTax(s, targetId, player));
  requireRule(canPayTax(s, targetId, player, snipeTax), 'INVALID_TARGET',
    snipeTax?.hand ? '手牌不足，无法指定该角色。' : 'AP不足，无法指定该角色。');
  payTax(ctx, targetId, player, snipeTax, { emitAp: false });
  // 「このキャラはBP2500以上のキャラを[狙い撃ち]で指定できない。」 — the mirrored direction: the threshold
  // sits on the *attacker*, and it refuses only targets at or above it.
  const snipeCeiling = staticSnipeCeiling(s, attackerId, player);
  if (snipeCeiling !== undefined) {
    requireRule(getBP(s, findField(s, other, targetId)!.card) < snipeCeiling, 'INVALID_TARGET', '该角色不能狙击此 BP 以上的角色。');
  }
  if (s.battle) s.battle.targetId = targetId;
  emit(ctx, 'attackTargetDesignated', { player, cardId: attackerId, targetId });
  return targetId;
}

/**
 * The declaration seam: after the 「際」 batch drained, walk the one-shot `Battle.declare` record, open the
 * designation window when the command asked for it, then hand over to 「アタック時」.
 */
function continueAttack(ctx: Context): void {
  const s = ctx.state;
  // Abilities raised while the 「際」 batch resolved ([2回アタック]'s `onActivated`, a trailing grant) go
  // back through the queue before the seam, so none is dropped between the two stages.
  if (ctx.queue.length) {
    s.pending = { type: 'queue', player: ctx.queue[0]!.player, effects: ctx.queue.splice(0), resume: 'attackDeclare' };
    return;
  }
  const battle = s.battle;
  if (!battle) return;
  // The 「際」 effect may retire the attacker (or end the battle outright): the attack closes here.
  if (!findField(s, battle.attacker, battle.attackerId)) { endBattle(ctx); return; }
  if (battle.declare) {
    const { targetId: declared, ask } = battle.declare;
    // One-shot: the seam is consumed before anything can park inside it.
    delete battle.declare;
    const candidates = designationCandidates(ctx, battle);
    if (declared !== undefined && candidates.includes(declared)) {
      designateTarget(ctx, battle.attacker, battle.attackerId, declared);
    } else {
      if (declared !== undefined) {
        emit(ctx, 'attackTargetDropped', {
          player: battle.attacker, cardId: battle.attackerId, targetId: declared,
          reason: candidates.length ? 'illegal' : 'noSnipe',
        });
      }
      if (ask === true && candidates.length) {
        s.pending = {
          type: 'attackTarget', player: battle.attacker, attackerId: battle.attackerId, candidates,
          ...(declared !== undefined ? { declared } : {}),
        };
        emit(ctx, 'attackTargetAsked', { player: battle.attacker, cardId: battle.attackerId, cards: candidates });
        return;
      }
    }
  }
  raiseAttackTime(ctx);
}

/** The 「アタック時」 step, unchanged in timing: designation (if any) is settled before it. */
function raiseAttackTime(ctx: Context): void {
  const s = ctx.state;
  const battle = s.battle!;
  const resume: QueueResume = battle.targetId !== undefined ? 'compare' : 'block';
  if (raiseQueue(ctx, battle.attacker, 'onAttack', resume, battle.targetId, battle.attackerId)) return;
  if (raiseOpponentAttack(ctx, resume, battle.targetId)) return;
  applyQueueResume(ctx, resume, battle.targetId);
}

function raiseOpponentAttack(ctx: Context, resume: QueueResume, defenderId?: CardId): boolean {
  const battle = ctx.state.battle;
  if (battle == null || battle.opponentAttackRaised === true) return false;
  battle.opponentAttackRaised = true;
  return raiseQueue(ctx, otherOf(battle.attacker), 'onOpponentAttack', resume, defenderId);
}

function block(ctx: Context, player: PlayerId, cardId: CardId | null): void {
  const s = ctx.state;
  requireRule(s.pending?.type === 'block' && s.battle, 'INVALID_CHOICE', '当前没有阻挡决策。');
  if (cardId === null) {
    requireRule(s.pending.mandatory !== true, 'INVALID_CHOICE', '攻击者要求必须阻挡（若可以）。');
    emit(ctx, 'blockDeclined', { player });
    const count = getDamage(s, findField(s, s.battle.attacker, s.battle.attackerId)!.card);
    if (raiseQueue(ctx, s.battle.attacker, 'onUnblockedAttack', 'unblockedDamage', undefined, s.battle.attackerId, count)) return;
    damage(ctx, count);
    return;
  }
  const located = findField(s, player, cardId);
  requireRule(located?.line === 'front', 'INVALID_TARGET', '只能用自己的前线角色阻挡。');
  requireRule(!staticForbids(s, cardId, player).block, 'INVALID_TARGET', '此角色不能阻挡。');
  // 「最初のアタックをブロックできない」 — the turn log already holds this attack (written when it was
  // declared, before the block window opened), so "the turn's first attack" is exactly one entry.
  requireRule(!(staticForbids(s, cardId, player).blockFirstAttack
    && (s.turnEvents ?? []).filter(entry => entry.event === 'attacked').length <= 1), 'INVALID_TARGET', '此角色不能阻挡本回合最初的攻击。');
  requireRule(located.card.active, 'NOT_ACTIVE', '休息状态不能阻挡。');
  const attacker = findField(s, s.battle.attacker, s.battle.attackerId)!.card;
  requireRule(!(attacker.evadeModifiers ?? []).some(m => m.expiresTurn >= s.turn && getBP(s, located.card) <= m.maxBP), 'INVALID_TARGET', '此角色的当前 BP 不满足攻击者的阻挡限制。');
  const atLeast = staticEvadeAtLeast(s, s.battle.attackerId, s.cards[s.battle.attackerId]!.owner);
  requireRule(atLeast === undefined || getBP(s, located.card) < atLeast, 'INVALID_TARGET', '此角色的当前 BP 不满足攻击者的阻挡限制。');
  // 「このキャラはBP3000以下のキャラにブロックされない。」 — the *static* half of the same bound (the
  // runtime `evadeModifiers` above are the granted-duration spelling); 72 printed/granted cards carry it.
  const evadeBelow = staticEvade(s, s.battle.attackerId, s.cards[s.battle.attackerId]!.owner);
  requireRule(evadeBelow === undefined || getBP(s, located.card) > evadeBelow, 'INVALID_TARGET', '此角色的当前 BP 不满足攻击者的阻挡限制。');
  // 「このキャラはカード名に「X」を含むキャラをブロックできない。」 — the filter spelling of the same
  // refusal, matched against the candidate blocker with the attacker as the effect source.
  const attackerId = s.battle.attackerId;
  const blockerFilters = staticBlockerFilters(s, attackerId, s.cards[attackerId]!.owner);
  requireRule(!blockerFilters.some(f => matchesFilter(s, cardId, f, attackerId)), 'INVALID_TARGET', '此角色被攻击者的效果禁止阻挡。');
  // 「相手は選ばれたキャラ以外のキャラでこのアタックをブロックできない。」 (KGD-1-044) — the restriction the
  // [アタック時] effect wrote onto this battle: only the named card may block this attack.
  requireRule(s.battle.onlyBlockerId === undefined || s.battle.onlyBlockerId === cardId, 'INVALID_TARGET', '本攻击只能由被指定的角色阻挡。');
  // 「選んだ相手のキャラはこのターン中、選んだ〈X〉のアタックを可能ならブロックしなければならない。」
  // (KGR-1-069) / 「このキャラは、相手の〈X〉のアタックを…」(CGD-1-069) — while an obliged blocker can
  // legally take this attack, a card carrying no matching demand cannot step in. With several obliged
  // cards the blocking player picks one of them (Q1381), which leaving the choice open preserves.
  {
    const attackerNames = effectiveNames(s, attackerId, s.cards[attackerId]!.owner);
    const obliged = (card: FieldCard): boolean =>
      (card.mustBlockAttacker ?? []).some(record => record.expiresTurn >= s.turn && record.names.some(name => attackerNames.includes(name)))
      || activeStatics(s, card.cardId, player).some(m => m.type === 'mustBlockAttacker' && (m.names === undefined || m.names.some(name => attackerNames.includes(name))));
    if (!obliged(located.card) && s.players[player].front.some(c => c.cardId !== cardId && legalBlockerNow(s, c, player) && obliged(c))) {
      requireRule(false, 'INVALID_TARGET', '本攻击必须由被要求阻挡的角色阻挡。');
    }
  }
  // 「可能ならBPN以下のキャラでブロックしなければならない」 — while such a blocker exists, a larger one
  // cannot take the block. The check is conditional on the ceiling being satisfiable, exactly as the
  // printed 「可能なら」 scopes the obligation.
  const demand2 = staticForbids(s, attackerId, s.cards[attackerId]!.owner);
  if (demand2.mustBlockCeiling !== undefined && getBP(s, located.card) > demand2.mustBlockCeiling) {
    const smallExists = s.players[player].front.some(c => c.cardId !== cardId
      && legalBlockerNow(s, c, player) && getBP(s, c) <= demand2.mustBlockCeiling!);
    requireRule(!smallExists, 'INVALID_TARGET', '攻击要求尽可能以低 BP 角色阻挡。');
  }
  // 「このキャラよりもBPが大きいキャラでブロックしなければならない」 (KJN-1-001) — while a blocker above
  // the attacker's own BP exists, a card at or below it cannot take the block (the same conditional the
  // printed 「可能なら」 scopes the ceiling with, mirrored).
  if (demand2.mustBlockOverSelf) {
    const attackerSlot = findField(s, s.cards[attackerId]!.owner, attackerId);
    const floor = attackerSlot ? getBP(s, attackerSlot.card) : undefined;
    if (floor !== undefined && getBP(s, located.card) <= floor) {
      const higherExists = s.players[player].front.some(c => c.cardId !== cardId
        && legalBlockerNow(s, c, player) && getBP(s, c) > floor);
      requireRule(!higherExists, 'INVALID_TARGET', '攻击要求以高于攻击者 BP 的角色阻挡。');
    }
  }
  located.card.active = false;
  logTurnEvent(s, 'rested', player, cardId);
  // The blocker is the battle's own participant for 「このキャラのバトル中」; `compareBattle` receives it
  // as an argument, so without this record nothing on the battle object names it.
  s.battle.blockerId = cardId;
  const keywords = getKeywords(s, cardId);
  // 「ブロックした時アクティブにする」 is *parked*, not taken here: it resolves once the block's own
  // watcher batches (「ブロックした時」, then the attacker's 「ブロックされた時」) have finished, so a
  // 「次の1回アクティブにならない」 that lands with them negates this very activation (Q428).
  if (keywords.doubleBlock && located.card.blocksThisTurn === 0) s.battle.doubleBlockReactivate = cardId;
  located.card.blocksThisTurn++;
  emit(ctx, 'blockDeclared', { player, cardId });
  // 「このターン中、選んだキャラが〔…このキャラのアタックをブロックした時〕、…」 (HTR-2-059) — the
  // bound watchers keyed to this blocker *and* this attacker fire with their holder as the resolving
  // source.
  for (const watcher of [0, 1] as const) {
    for (const line of ['front', 'energy'] as const) {
      for (const slot of s.players[watcher][line]) {
        const watches = (slot.boundWatches ?? []).filter(watch => watch.expiresTurn >= s.turn && watch.kind === 'blockedAttack'
          && watch.id === cardId && watch.attackerId === attackerId);
        for (const watch of watches) ctx.queue.push(makeTask(s, watcher, slot.cardId, watch.effects));
      }
    }
  }
  // 「このキャラのアタックをブロックしたキャラの[ブロック時]は発動しない。」 — the attacker's static
  // silences the blocker's own ブロック時 watchers, so the raise is skipped rather than answered.
  const silencedBlocker = activeStatics(s, s.battle.attackerId, s.battle.attacker).some(m => m.type === 'forbidBlockerAbilities');
  if (!silencedBlocker && raiseQueue(ctx, player, 'onBlock', 'compare', cardId, cardId)) return;
  // 「このキャラがアタックしてブロックされた時」 belongs to the *attacker* — the block pair's second
  // stage, raised here when the blocker's own ブロック時 batch stayed empty and from the comparison
  // resume otherwise (see `raiseBlocked`). The blocker is handed over as the event's own card, so
  // 「BP3000以下のキャラにブロックされた時」 can narrow which blocks it answers.
  if (raiseBlocked(ctx, 'compare', cardId)) return;
  finishDoubleBlockReactivate(ctx);
  compareBattle(ctx, cardId);
}

/**
 * `Battle.blockedRaised`'s raiser — the attacker-side 「アタックをブロックされた時」 batch of the
 * block pair.
 *
 * The blocker rides as the event's *subject* as well: it is the card the printed follow-ups speak
 * about (「このキャラのアタックをブロックしたキャラは…」), which the effect reaches as the `E` binding.
 */
function raiseBlocked(ctx: Context, resume: QueueResume, blockerId: CardId): boolean {
  const s = ctx.state;
  const battle = s.battle;
  if (battle == null || battle.blockerId === undefined || battle.blockedRaised === true) return false;
  battle.blockedRaised = true;
  return raiseQueue(ctx, battle.attacker, 'onBlocked', resume, blockerId, battle.attackerId, undefined, { eventCardId: blockerId, subject: blockerId });
}

/**
 * 「[2回ブロック]」's owed 「ブロックした時アクティブにする」, run once the block's watcher batches have
 * resolved (see `Battle.doubleBlockReactivate`).
 *
 * The attempt takes the same gate the ready step and an activation effect take: a pending 「次の1回
 * アクティブにならない」 spends itself on this activation and the card stays rested (Q428 — the charge
 * is gone afterwards, so the *next* ready step stands the card up normally), and a 「アクティブに
 * ならない」 static refuses the standing-up outright.
 */
function finishDoubleBlockReactivate(ctx: Context): void {
  const s = ctx.state;
  const battle = s.battle;
  const cardId = battle?.doubleBlockReactivate;
  if (battle == null || cardId === undefined) return;
  delete battle.doubleBlockReactivate;
  const located = findField(s, battle.defender, cardId);
  if (!located || located.card.active) return;
  if (staticForbids(s, cardId, battle.defender).activate) return;
  if ((located.card.cannotActivateCharges ?? 0) > 0) { located.card.cannotActivateCharges!--; return; }
  located.card.active = true;
  logTurnEvent(s, 'activatedByEffect', battle.defender, cardId);
  ctx.queue.push(...collectTriggered(ctx, battle.defender, 'onActivated', cardId, undefined, { activation: 'rule' }));
}

function chooseDamage(ctx: Context, slots: number[]): void {
  const s = ctx.state;
  const pending = s.pending;
  requireRule(pending?.type === 'damage', 'INVALID_CHOICE', '当前不需要选择生命。');
  const p = s.players[pending.damagedPlayer];
  requireRule(slots.length === pending.count && new Set(slots).size === slots.length && slots.every(i => i < p.life.length), 'INVALID_CHOICE', '必须选择准确数量且不重复的有效生命位置。');
  const cards = removeLifeSlots(s, pending.damagedPlayer, slots);
  s.pending = {
    type: 'triggers', player: pending.damagedPlayer, cards,
    ...(pending.outsideBattle ? { outsideBattle: true } : {}),
    ...(pending.sourceId !== undefined ? { sourceId: pending.sourceId } : {}),
    // Abilities raised while the damage was being set up (a battle's retirement watcher) resolve in
    // the same batch — the command that raised them ended with this pending open.
    ...(pending.queued?.length ? { effects: pending.queued } : {}),
  };
  emit(ctx, 'lifeRevealed', { player: pending.damagedPlayer, cards });
}

export function availableTriggerReplacements(s: GameState, player: PlayerId, type: 'triggerToGetSubstitute' | 'getTriggerDeploySubstitute'): { cardId: CardId; modifier: StaticModifier }[] {
  return [...s.players[player].front, ...s.players[player].energy].flatMap(card => activeStatics(s, card.cardId, player).flatMap((modifier, index) => {
    if (modifier.type !== type) return [];
    // Spend only on a probe, retrieving its own modifier identities so the shared budget is checked.
    const probe = structuredClone(s), copied = activeStatics(probe, card.cardId, player)[index];
    return copied?.type === type && spendReplacementUse(probe, card.cardId, player, copied) ? [{ cardId: card.cardId, modifier }] : [];
  }));
}

function askGetEntry(ctx: Context, pending: TriggerDecision, phase: 'replacement' | 'line' | 'overflow', answers: Record<string, Partial<Extract<Action, { type: 'resolveTrigger' }>>>): void {
  const get = pending.getResolution!;
  const commands = Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, {
    player: pending.player, expectedRevision: ctx.state.revision,
    action: { type: 'resolveTrigger' as const, cardId: get.cardId, activate: true, ...answer },
  }]));
  startEffect(ctx, makeTask(ctx.state, pending.player, get.cardId, [{ type: 'triggerEntryChoice', phase, commands, pendingBefore: structuredClone(pending) }], 'trigger'), pending);
}

function getEntryFacts(s: GameState, pending: TriggerDecision): EffectFrame {
  const get = pending.getResolution!;
  return { ...makeTask(s, pending.player, get.sourceId ?? get.cardId, [], 'trigger'), index: 0, stage: 'step', held: [], taken: 0 };
}

function continueGetEntry(ctx: Context, pending: TriggerDecision, action: Extract<Action, { type: 'resolveTrigger' }>): { waiting: true } | { waiting: false; line?: Line } {
  const s = ctx.state, get = pending.getResolution!, player = pending.player;
  requireRule(action.cardId === get.cardId && action.activate && action.targetId === undefined && action.baseId === undefined && action.moveToFront === undefined && action.substitute === undefined, 'INVALID_CHOICE', '只能继续当前已发动的GET替代决定。');
  let line: Line;
  if (get.phase === 'replacement') {
    requireRule(typeof action.getReplacement === 'boolean' && action.getEntryLine === undefined && action.replace === undefined, 'INVALID_CHOICE', '必须先决定是否发动GET替代。');
    if (!action.getReplacement) return { waiting: false };
    const source = availableTriggerReplacements(s, player, 'getTriggerDeploySubstitute')[0];
    const lines = entryLineOptions(s, player, get.cardId);
    requireRule(source && !deployForbidden(s, player, get.cardId) && energySatisfied(s, player, get.cardId) && lines.length > 0, 'INVALID_CHOICE', '当前不能发动GET替代登场。');
    requireRule(spendReplacementUse(s, source.cardId, player, source.modifier), 'INVALID_CHOICE', '替代额度已用尽。');
    get.sourceId = source.cardId; get.phase = 'line';
    if (lines.length > 1) { askGetEntry(ctx, pending, 'line', Object.fromEntries(lines.map(to => [to, { getEntryLine: to }]))); return { waiting: true }; }
    line = lines[0]!;
  } else if (get.phase === 'line') {
    requireRule(action.getReplacement === undefined && action.replace === undefined && action.getEntryLine !== undefined && entryLineOptions(s, player, get.cardId).includes(action.getEntryLine), 'INVALID_CHOICE', '请选择合法登场战线。');
    line = action.getEntryLine;
  } else {
    requireRule(action.getReplacement === undefined && action.getEntryLine === undefined && get.entryLine !== undefined && action.replace !== undefined, 'INVALID_CHOICE', '必须先为已选择的战线腾位。');
    line = get.entryLine;
    const facts = getEntryFacts(s, pending);
    requireRule(lineOverflowCandidates(s, facts, player, line, get.cardId).includes(action.replace), 'INVALID_CHOICE', '腾位对象已失效。');
    overflowRemoval(ctx, facts, player, action.replace);
  }
  get.entryLine = line;
  if (s.players[player][line].length >= lineCapacity(s, player, line)) {
    requireRule(get.phase !== 'overflow', 'INVALID_TARGET', '该战线未能腾出登场位置。');
    get.phase = 'overflow';
    const options = lineOverflowCandidates(s, getEntryFacts(s, pending), player, line, get.cardId);
    askGetEntry(ctx, pending, 'overflow', Object.fromEntries(options.map(id => [id, { replace: id }])));
    return { waiting: true };
  }
  return { waiting: false, line };
}

function resolveTrigger(ctx: Context, player: PlayerId, action: Extract<Action, { type: 'resolveTrigger' }>, taxPaid = false): void {
  const s = ctx.state;
  const pending = s.pending;
  requireRule(pending?.type === 'triggers' && pending.cards.includes(action.cardId), 'INVALID_CHOICE', '只能处理本批次尚未处理的生命卡。');
  const p = s.players[player];
  const definition = getDefinition(s, action.cardId);
  const resolution = pending.getResolution;
  let deployLine: Line | undefined;
  if (resolution) {
    const continuation = continueGetEntry(ctx, pending, action);
    if (continuation.waiting) return;
    deployLine = continuation.line;
  } else requireRule(action.getReplacement === undefined && action.getEntryLine === undefined, 'INVALID_CHOICE', '尚未进入GET替代决定。');
  // 「このカードの[ゲット]を発動する場合、代わりに[ドロートリガー]か[アクティブ]にしてもよい。」
  // (SMD-1-060) — the card's own printed permission lets its [ゲット] be activated as another kind. The
  // permission travels with the *card* (it is read from the definition, so it works while the card sits
  // in the life area), and the substituted kind then resolves exactly like a printed one of that kind —
  // its effect and its destination included.
  // 「自分の[ドロートリガー]か[アクティブ]を発動する場合、代わりに[ゲット]にしてもよい。」 (EVA-1-018)
  // — the mirrored direction: the life card prints the draw/active kind and a card on the *resolving
  // player's* field grants the permission to read it as [ゲット] (the life card reaches the hand).
  const converters = action.substitute === 'get' ? availableTriggerReplacements(s, player, 'triggerToGetSubstitute') : [];
  const toGet = action.substitute === 'get' && (definition.trigger?.type === 'draw' || definition.trigger?.type === 'active') && converters.length > 0;
  // 「自分が必要エナジーを満たしているキャラカードの[ゲット]を発動する場合、代わりにそのカードを自分の場に
  // レストで登場させてもよい。」 (EVA-1-008) — the *field* grants the permission, the life card must be a
  // character, and the resolving player must satisfy its requirement. The [ゲット] it reads may itself be a
  // rewritten one (Q1722): only a chosen triggerToGetSubstitute conversion makes a draw/active trigger
  // an effective GET; the saved decision then follows the same chain as a printed GET.
  // Legacy GET deployment intent still requires the separate optional replacement decision.
  const legacyDeploy = action.substitute === 'deployRested' && definition.trigger?.type === 'get' && action.activate;
  const ownSubstitute = action.substitute !== undefined && (action.substitute === 'draw' || action.substitute === 'active')
    && definition.trigger?.type === 'get'
    && (definition.static ?? []).some(ability => ability.modifiers.some(m => m.type === 'getTriggerSubstitute'))
    ? action.substitute : undefined;
  const substitute = resolution ? 'get' as const : ownSubstitute ?? (toGet ? 'get' as const : undefined);
  requireRule(action.substitute === undefined || substitute !== undefined || legacyDeploy, 'INVALID_CHOICE', '此卡没有对应的触发替代能力。');
  // The [アクティブ] template carries a BP bonus the engine reads below; a substituted one has none of
  // its own (the resolution is this card's, not a printed [アクティブ]'s), so it grants no bonus.
  const trigger: CardDefinition['trigger'] = substitute === 'draw' ? { type: 'draw' }
    : substitute === 'active' ? { type: 'active', bpBonus: 0 }
    : substitute === 'get' ? { type: 'get' }
    : definition.trigger;
  const raidTrigger = action.activate && trigger?.type === 'raid';
  // 「このカードの[レイドトリガー]はレイドできる場合、発動しレイドしなければならない。」
  // (KMR-1-041) — the printed obligation: while a legal base exists the printed RAID trigger cannot be
  // declined, and the raid cannot be activated bare (the base must be named). With no eligible base
  // the printed 「レイドできる場合」 fails, so the ordinary choice stands.
  if (definition.raidTriggerForced === true && definition.trigger?.type === 'raid') {
    const raidable = [...p.front, ...p.energy].some(c => raidBaseEligible(s, player, action.cardId, c.cardId, 'trigger'));
    if (raidable) {
      requireRule(action.activate === true, 'INVALID_CHOICE', '该卡的[レイドトリガー]必须发动。');
      requireRule(action.baseId !== undefined, 'INVALID_CHOICE', '该卡的[レイドトリガー]必须选择 RAID 基底并レイド。');
    }
  }
  requireRule(raidTrigger || (action.baseId === undefined && action.moveToFront === undefined && (resolution !== undefined || action.replace === undefined)), 'INVALID_CHOICE', '此触发不接受 RAID 参数。');
  requireRule(action.baseId !== undefined || (action.moveToFront === undefined && (resolution !== undefined || action.replace === undefined)), 'INVALID_CHOICE', '必须先选择 RAID 基底。');
  const targeted = action.activate && (trigger?.type === 'active' || trigger?.type === 'special');
  requireRule(targeted || action.targetId === undefined, 'INVALID_TARGET', '此触发不接受目标。');
  // 「このキャラが与えたダメージによるトリガーチェックでは、相手は[アクティブ]を発動できない。」 — the
  // [アクティブ] trigger of life cards turned up by *that* character's damage cannot be activated. The
  // damage's origin rides on the batch; a batch with no named source is unaffected. The ドロートリガー
  // sibling (BCV-1-046) is the same gate over another kind, carried by the modifier's `triggers` list;
  // an absent list is the field-less [アクティブ] spelling the two older carriers print.
  if (action.activate && trigger !== undefined && pending.sourceId !== undefined) {
    const sourceOwner = s.cards[pending.sourceId]?.owner;
    const forbidden = sourceOwner === undefined ? [] : activeStatics(s, pending.sourceId, sourceOwner)
      .flatMap(m => m.type === 'forbidActiveTrigger' ? (m.triggers ?? ['active']) : []);
    if (forbidden.includes(trigger.type as 'active' | 'draw' | 'special')) {
      requireRule(false, 'INVALID_CHOICE', '该伤害来源禁止发动对应的触发。');
    }
  }
  let destination: 'hand' | 'sideline' = 'sideline';
  let inline: CardEffect[] | undefined;
  if (!resolution && action.activate && toGet) requireRule(spendReplacementUse(s, converters[0]!.cardId, player, converters[0]!.modifier), 'INVALID_CHOICE', '触发转换额度已用尽。');
  if (!resolution && action.activate && trigger?.type === 'get') {
    const eligible = definition.kind === 'character' && !deployForbidden(s, player, action.cardId) && energySatisfied(s, player, action.cardId) && entryLineOptions(s, player, action.cardId).length > 0 && availableTriggerReplacements(s, player, 'getTriggerDeploySubstitute').length > 0;
    requireRule(!legacyDeploy || eligible, 'INVALID_CHOICE', '当前不能以GET替代登场。');
    if (eligible) {
      logTurnEvent(s, 'triggered', player, action.cardId);
      pending.getResolution = { cardId: action.cardId, effectiveTrigger: 'get', phase: 'replacement' };
      askGetEntry(ctx, pending, 'replacement', { '0': { getReplacement: false }, '1': { getReplacement: true } });
      return;
    }
  }
  if (action.activate && trigger) {
    // 「このターン中に相手がトリガーの効果を発動していた場合」 — activating the trigger (rather than
    // letting the card go to 場外) is the fact the log records, for every trigger kind. The tax answer's
    // second half (`taxPaid`) must not record it twice: the first half already did.
    if (!resolution && !taxPaid) logTurnEvent(s, 'triggered', player, action.cardId);
    switch (trigger.type) {
      case 'get': case 'raid': destination = 'hand'; break;
      case 'draw': draw(ctx, player, 1); break;
      case 'final': {
        if (p.life.length === 0 && p.deck.length > 0) {
          addToLife(s, player, [p.deck.shift()!]);
          noteDeckTop(p);
          emit(ctx, 'lifeRestored', { player, count: 1 });
        }
        break;
      }
      case 'color': {
        const definition = getDefinition(s, action.cardId);
        const colour = COLORS.find(candidate => (definition.requiredEnergy[candidate] ?? 0) > 0);
        const replacements = colour ? staticColorTriggerReplacements(s, player, colour) : [];
        if (replacements.length) {
          inline = [{ type: 'chooseOption', count: 1, options: [...replacements.map(steps => structuredClone(steps)), structuredClone(trigger.effects ?? [])] }];
          break;
        }
        inline = trigger.effects;
        // 「自分の緑の[カラートリガー]の効果に記載されている「キャラカード」を「フィールドカード」に代えても
        // よい。」 — the resolving player's substitution statics offer a second reading of the trigger's own
        // text: the printed 「代えてもよい」 becomes the either/or between the original reading and the
        // substituted one. The trigger card's colour is its printed requirement; both readings keep the
        // trigger's own steps, so its costs and order travel with the choice.
        const substitutions = [...p.front, ...p.energy]
          .flatMap(card => activeStatics(s, card.cardId, player))
          .filter((m): m is Extract<StaticModifier, { type: 'colorTriggerSubstitute' }> => m.type === 'colorTriggerSubstitute');
        const applicable = substitutions.filter(m => Object.hasOwn(getDefinition(s, action.cardId).requiredEnergy, m.color));
        const distinct = new Set(applicable.map(m => `${m.from}>${m.to}`));
        if (distinct.size === 1 && inline.length) {
          const rewritten = substitutedTriggerSteps(inline, applicable[0]!);
          if (rewritten) inline = [{ type: 'chooseOption', count: 1, options: [structuredClone(inline), rewritten] }];
        }
        break;
      }
      case 'active': case 'special': {
        const targetPlayer = trigger.type === 'active' ? player : otherOf(player);
        const selectable = trigger.type === 'active'
          ? [...p.front, ...p.energy].filter(c => getDefinition(s, c.cardId).kind === 'character')
          // 「…は、相手のトリガーの効果で選ばれない。」 — a [スペシャルトリガー] *選び* the target, so the
          // protection binds here the way it binds every selection (TOA-1-029/AND-1-010): a protected
          // card is not offered and cannot be named.
          : s.players[targetPlayer].front.filter(c => !protectedFrom(s, c.cardId, player, 'trigger'));
        // `taxPaid` is the answer's own second pass: the tax was just paid, so the affordability filter must
        // not be applied again — paying it can drop the chooser below the very price it just took (the
        // target would otherwise vanish from the pool it was chosen out of).
        const targets = taxPaid ? selectable : selectable.filter(c => canPaySelectionTax(s, c.cardId, player, 'trigger'));
        // Every remaining candidate is above the tax (or there is none at all): declining is the only
        // answer, and the batch must still go on — the 「全部付不起」 case is *not* the deadlock the
        // 「没有合法触发目标」 shape prevents, because the trigger keeps its printed resolution (its card
        // reaches 場外 and `settleTriggers` below carries the batch forward, with no target retired).
        if (targets.length === 0) requireRule(action.targetId === undefined, 'INVALID_TARGET',
          selectable.length ? '剩余目标均无法支付选择税，不能选择。' : '没有合法触发目标。');
        else {
          const target = targets.find(c => c.cardId === action.targetId);
          requireRule(target, 'INVALID_TARGET', selectable.some(c => c.cardId === action.targetId)
            ? '无法支付该卡的选择税，不能选择它。' : '必须选择一个合法触发目标。');
          if (trigger.type === 'special' && !taxPaid) {
            const tax = selectionTaxFor(s, target.cardId, player, 'trigger');
            // The hand half is the chooser's own decision (which of their hand cards pays — 189's ruling);
            // the AP/rest halves ride the same command that answers it, keeping the payment atomic.
            if (tax && tax.hand > 0) {
              s.pending = {
                type: 'selectionTaxHand', player, count: tax.hand, cards: [...p.hand],
                triggers: pending, resume: { ...action },
              };
              return;
            }
            payTax(ctx, target.cardId, player, tax);
          }
          if (trigger.type === 'special') {
            // 「相手がこのキャラを[スペシャルトリガー]で退場させる場合、代わりに相手はその[スペシャル
            // トリガー]を持つカードを手札に加える。」 — the target survives and the life card carrying
            // the trigger joins the *resolving* player's hand instead of retiring it.
            const replaces = activeStatics(s, target.cardId, targetPlayer).some(m => m.type === 'specialTriggerRetireReplacement');
            if (replaces) { destination = 'hand'; emit(ctx, 'specialTriggerReplaced', { player, target: target.cardId }); }
            // 「このキャラは相手のトリガーの効果で場を離れない。」 — the removal refusal covers this route
            // too (it is the trigger's effect sending the target away), so a protected card stays put
            // (KMR-1-052/OPM-1-017; the ask belongs to the target's owner).
            else if (!refusesOpponentRemoval(s, target.cardId, targetPlayer, 'trigger')) {
              leaveField(ctx, targetPlayer, target.cardId, 'sideline', 'special-trigger', action.cardId);
            }
          }
          else {
            // A [アクティブ] life trigger that stands a rested card up is an activation like any other —
            // and 「アクティブにする効果」 absorbs a 「次の1回アクティブにならない」 charge instead of
            // standing the card up (Q102/Q797; the ready step's own consumption lives in `activateField`).
            // 「このキャラはアクティブにならない。」 — the standing refusal the effect-operation path reads
            // (effects.ts `activate`): the activation is absorbed, the card stays rested. `activateOwnOnly`
            // cannot bind here — the [アクティブ] trigger stands up a card of the resolving player's own,
            // so its effect is never "another player's" (DST-1-073, Q747/Q748).
            if (!staticForbids(s, target.cardId, targetPlayer).activate) {
              if (!target.active && (target.cannotActivateCharges ?? 0) > 0) target.cannotActivateCharges!--;
              else {
                const wasRested = !target.active;
                target.active = true;
                if (wasRested) {
                  logTurnEvent(s, 'activatedByEffect', targetPlayer, target.cardId);
                  ctx.queue.push(...collectTriggered(ctx, targetPlayer, 'onActivated', target.cardId, undefined, { activation: 'effect' }));
                }
              }
            }
            if (trigger.bpBonus > 0) target.bpModifiers.push({ amount: trigger.bpBonus, expiresTurn: s.turn });
          }
        }
        break;
      }
    }
  }
  pending.cards.splice(pending.cards.indexOf(action.cardId), 1);
  delete pending.getResolution;
  if (deployLine !== undefined) {
    // The life card reaches the field rested instead of the hand (EVA-1-008). The batch lifted it out of
    // the life area, so it belongs to no zone; the placement is an effect deployment (登場 raises), and
    // the printed 「そうした場合、自分の手札を1枚場外に置く。」 finishes in its own resolving frame before
    // the arrival's queued onPlay tasks. The permission's budget was spent when its offer was accepted.
    p[deployLine].push(newField(s, action.cardId, staticEnterActive(s, action.cardId, player) === true, 'effect', false, 'life', player));
    logTurnEvent(s, 'entered', player, action.cardId, { via: 'effect', from: 'life' });
    ctx.queue.push(...collectTriggered(ctx, player, 'entered', action.cardId, action.cardId));
    emit(ctx, 'cardDeployed', { player, cardId: action.cardId, destination: deployLine });
    // The follow-up sentence belongs to the substituted trigger's own resolution, so it rides the
    // trigger route like the inline task below. The arrival's own onPlay is the card's effect, not the
    // trigger's: it takes the default route (`makeTask`), so trigger-only guards must not bind to it.
    const entry = prepareEntryEffects(s, player, definition);
    if (entry.length) {
      const entryTask = { ...makeTask(s, player, action.cardId, entry), abilityEvent: 'onPlay' as const };
      attachEntryBudget(entryTask, definition);
      ctx.queue.push(entryTask);
    }
  } else if (destination === 'sideline' && inline?.length) {
  } else {
    p[destination].push(action.cardId);
  }
  // 「自分のライフエリアから[ドロートリガー]を持つカードが場外に置かれた時、…」 — the moment a life card
  // reaches the discard pile. Raised into the same batch's `effects`: the trigger the card itself may
  // have answered resolves first, and the watcher belongs to the player whose life moved
  // (`pending.player`, not the command's caller). The event's subject is the life card, which the
  // watcher's `eventCard` filter is matched against — and which its effects may name as 「そのカード」.
  if (destination === 'sideline' && !inline?.length) {
    const watched = collectTriggered(ctx, pending.player, 'onLifeToSideline', action.cardId, action.cardId);
    if (watched.length) (pending.effects ??= []).push(...watched);
  }
  // The batch being resolved is the life area's, so 「ライフを手札に加えた」 is exactly a trigger that
  // sends its card to the hand — the alternative destination is the sideline. The [ゲット]→レスト登場
  // substitution (EVA-1-008) reads the printed kind, not the arrival: its card reaches the field.
  if (destination === 'hand' && deployLine === undefined) logTurnEvent(s, 'lifeToHand', player, action.cardId);
  if (raidTrigger && action.baseId) raid(ctx, player, { type: 'raid', cardId: action.cardId, baseId: action.baseId, ...(action.moveToFront !== undefined ? { moveToFront: action.moveToFront } : {}), ...(action.replace ? { replace: action.replace } : {}) }, true);
  // The trigger's own effects resolve along the *trigger* route: 「相手のトリガーの効果で選ばれない/
  // 退場しない」 (AOT-1-010/BCV-1-098 等 20 卡) read `f.route`, and without this the frame fell back to
  // `characterEffect` — the protection never bound, while a `source:'characterEffect'` guard wrongly did.
  if (inline?.length) {
    const task = makeTask(s, player, action.cardId, inline, 'trigger');
    // The card's own trigger finishes before its life-to-sideline arrival abilities become selectable.
    if (destination === 'sideline') task.lifeArrival = action.cardId;
    (pending.effects ??= []).push(task);
  }
  emit(ctx, 'triggerResolved', { player, cardId: action.cardId, trigger: trigger?.type ?? 'none', activated: action.activate && trigger !== undefined, destination: deployLine ?? destination });
  checkBP(ctx);
  if (deployLine !== undefined) {
    startEffect(ctx, makeTask(s, player, action.cardId, [{ type: 'discard', player: 'self', count: 1 }], 'trigger'), pending);
    return;
  }
  settleTriggers(ctx, pending);
}

/**
 * The substituted reading of a colour trigger's steps —
 * 「…に記載されている「キャラカード」を「フィールドカード」に代えてもよい」.
 *
 * The rewrite is *textual*, exactly as printed: every subject that named the `from` kind names the `to`
 * kind instead, and a deployment the original reading sent to the front line moves to the energy line,
 * where a card of that kind can live (the same convention the `play` action enforces). A trigger holding
 * anything the rewrite cannot carry — a raid, an either/or arrival — refuses the substitution rather
 * than half-rewriting it, and a rewrite that changes nothing offers no choice at all.
 */
function substitutedTriggerSteps(steps: CardEffect[], sub: { from: 'character' | 'field' | 'event'; to: 'character' | 'field' | 'event' }): CardEffect[] | undefined {
  const clone = structuredClone(steps) as unknown;
  let refused = false;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (record.operation === 'raid' || (typeof record.take === 'string' && record.take.includes('Raid'))) { refused = true; return; }
    if (record.kind === sub.from) record.kind = sub.to;
    if ((record.operation === 'deploy' || record.operation === 'deployRested') && sub.to !== 'character') record.line = 'energy';
    for (const value of Object.values(record)) walk(value);
  };
  walk(clone);
  if (refused) return undefined;
  if (JSON.stringify(clone) === JSON.stringify(steps)) return undefined;
  return clone as CardEffect[];
}

/**
 * The tail of the attack phase: the phase closes, every rested card becomes active, and the end phase's
 * hand-limit check runs.
 *
 * Split out because the 「アタックフェイズ終了時」 queue can pause the transition: the phase only closes
 * once every ability listening for that moment (the attacker's first, then the opponent's) has resolved.
 */
/**
 * 「このカードが自分の効果で自分の山札から場外に置かれた時」 — the deck→sideline moment.
 *
 * Read like the 退場時 collection: the ability sits on the card that was moved, which by now is in the
 * sideline, so its definition is read directly rather than through `collectTriggered`'s field scan.
 * The turn log records the same fact for the count form (「このターン中に自分の効果で自分の山札の
 * カードが場外に置かれている」). Only effect-driven placements call this — a deck card cannot reach the
 * sideline any other way, which is the printed 「自分の効果で」.
 */
export function noteDeckToSideline(ctx: Context, player: PlayerId, ids: CardId[], causeId?: CardId): void {
  const s = ctx.state;
  for (const id of ids) {
    logTurnEvent(s, 'milled', player, id, { via: 'effect', ...(causeId !== undefined ? { causeId } : {}) });
    // The printed 「自分の効果で」 narrows the cause: the resolving effect's own source card must belong to
    // the milling player, checked the same way the onRemoved sibling does (a *plain* `eventSource` filter
    // keeps the ownership test when the card's rule carries `eventSourceFilter: {}`).
    ctx.queue.push(...collectTriggered(ctx, player, 'onMilled', id, undefined, { ...(causeId !== undefined ? { causeId } : {}) }));
  }
}

/**
 * 「相手の場のキャラは可能ならアタックしなければならない。」 — whether `player` still owes an attack.
 *
 * The obligation sits on the *opponent's* field (the printed card is theirs) and asks whether any of
 * `player`'s characters could still attack: on a line it may attack from, standing, and not refused
 * by a static. That "could" is the whole of the printed 「可能なら」 — a rested or forbidden board
 * owes nothing.
 */
function attackable(s: GameState, player: PlayerId, slot: FieldCard): boolean {
  if (!slot.active || getDefinition(s, slot.cardId).kind !== 'character') return false;
  const forbids = staticForbids(s, slot.cardId, player);
  if (forbids.attack || (!s.players[player].front.includes(slot) && !forbids.energyAttack)) return false;
  const rules = playerStatics(s, player);
  const names = rules.flatMap(m => m.type === 'attackOnlyNames' ? m.names : []);
  if (names.length && !effectiveNames(s, slot.cardId, player).some(n => names.includes(n))) return false;
  const limits = rules.flatMap(m => m.type === 'attackLimit' ? [m.max] : []);
  const used = (s.turnEvents ?? []).filter(e => e.event === 'attacked' && e.player === player).length;
  return !limits.length || used < Math.min(...limits);
}

function mandatoryAttackers(s: GameState, player: PlayerId): CardId[] {
  return [...s.players[player].front, ...s.players[player].energy]
    .filter(slot => attackable(s, player, slot) && activeStatics(s, slot.cardId, player).some(m => m.type === 'mustAttack' && m.self))
    .map(slot => slot.cardId);
}

function mustAttackPending(s: GameState, player: PlayerId): boolean {
  const opposed = otherOf(player);
  const obliged = [...s.players[opposed].front, ...s.players[opposed].energy]
    .some(slot => activeStatics(s, slot.cardId, opposed).some(m => m.type === 'mustAttack' && !m.self));
  if (obliged && [...s.players[player].front, ...s.players[player].energy].some(slot => attackable(s, player, slot))) return true;
  // 「このキャラは可能ならアタックしなければならない。」 — the obligation printed on the card itself:
  // the exact card that carries the modifier owes the attack, so only *its* ability to attack counts.
  return mandatoryAttackers(s, player).length > 0;
}

function lapseAtAttackPhaseEnd(s: GameState): void {
  for (const side of s.players) {
    for (const card of [...side.front, ...side.energy]) {
      if (card.attackEndLapse?.length) {
        const kept: ('cannotActivate' | 'effectsLost')[] = [];
        for (const kind of card.attackEndLapse) {
          if (kind === 'cannotActivate') {
            if (card.cannotActivateUntilTurn === undefined || card.cannotActivateUntilTurn <= s.turn) delete card.cannotActivateUntilTurn; else kept.push(kind);
          } else if (card.effectsLostUntilTurn === undefined || card.effectsLostUntilTurn <= s.turn) delete card.effectsLostUntilTurn;
          else kept.push(kind);
        }
        if (kept.length) card.attackEndLapse = kept; else delete card.attackEndLapse;
      }
      if (card.grantedStatics?.some(grant => grant.endsWithAttackPhase && grant.expiresTurn <= s.turn)) {
        card.grantedStatics = card.grantedStatics.filter(grant => !(grant.endsWithAttackPhase && grant.expiresTurn <= s.turn));
      }
    }
    if (side.grantedStatics?.some(grant => grant.endsWithAttackPhase && grant.expiresTurn <= s.turn)) {
      side.grantedStatics = side.grantedStatics.filter(grant => !(grant.endsWithAttackPhase && grant.expiresTurn <= s.turn));
    }
  }
}

function endAttackPhase(ctx: Context, player: PlayerId): void {
  const s = ctx.state;
  const p = s.players[player];
  s.phase = 'end';
  lapseAtAttackPhaseEnd(s);
  // 「エンドフェイズ開始時、そのキャラを退場させる。」 — the scheduled retirement fires as the end phase
  // opens, before the ready step (the print names the *start* of the phase). Both sides' cards are
  // scanned: the marker was written on whichever card an effect scheduled, either player's.
  for (const side of [0, 1] as const) {
    for (const card of [...s.players[side].front, ...s.players[side].energy]) {
      if (card.retireAtEnd === s.turn) leaveField(ctx, side, card.cardId, 'sideline', 'end-phase-effect');
    }
  }
  // 「自分のエンドフェイズ開始時、…」 (AOT-2-066) — the phase-start watchers, raised as the phase opens
  // and ahead of the ready step — the same position the `retireAtEnd` markers above fire at.
  ctx.queue.push(...collectTriggered(ctx, player, 'onEndPhaseStart'));
  const readyTasks: EffectTask[] = [];
  // 「エンドフェイズにこのキャラをアクティブにしなくてもよい。」 — the printed permission hands the ready
  // step for that card to its controller. Such a card is *not* stood up here; the question is asked below,
  // ahead of the hand-limit check, so the two end-phase decisions never interleave.
  const optionalReady: CardId[] = [];
  for (const card of [...p.front, ...p.energy]) {
    const forbids = staticForbids(s, card.cardId, player);
    if (forbids.activate || forbids.activateOwnOnly || forbids.readyStep) continue;
    if (!card.active && activeStatics(s, card.cardId, player).some(m => m.type === 'maySkipReadyStep')) { optionalReady.push(card.cardId); continue; }
    readyTasks.push(...activateField(ctx, player, card, 'ready-step'));
  }
  const limit = handLimitOf(s, player);
  if (optionalReady.length) {
    s.pending = { type: 'optionalReady', player, cards: optionalReady, ...(readyTasks.length ? { queued: readyTasks } : {}) };
  } else if (p.hand.length > limit) {
    // The ready step's 「レストの…がアクティブになった時」 watchers ride the pending like the battle's
    // retirement watchers ride a damage decision, so a hand-limit question cannot drop them.
    s.pending = { type: 'discard', player, count: p.hand.length - limit, ...(readyTasks.length ? { queued: readyTasks } : {}) };
  } else ctx.queue.push(...readyTasks);
}

function advance(ctx: Context, player: PlayerId): void {
  const s = ctx.state;
  const p = s.players[player];
  switch (s.phase) {
    case 'start': s.phase = 'movement'; break;
    case 'movement': move(ctx, player, { type: 'move', moves: [] }); return;
    case 'main': {
      for (const side of [0, 1] as const) for (const card of [...s.players[side].front, ...s.players[side].energy]) if (card.retireAtMainEnd === s.turn) leaveField(ctx, side, card.cardId, 'sideline', 'main-end-effect');
      // 「このメインフェイズ終了時、…」 — the delayed instructions parked by this turn's effects join the
      // printed 「メインフェイズ終了時」 abilities in one queue, so the resolving player orders them.
      const delayed = (p.delayedMainEnd ?? []).filter(entry => entry.turn === s.turn);
      p.delayedMainEnd = (p.delayedMainEnd ?? []).filter(entry => entry.turn !== s.turn);
      const tasks = [
        ...collectTriggered(ctx, player, 'onMainEnd'),
        ...delayed.map(entry => makeTask(s, player, entry.sourceId, entry.steps)),
      ];
      if (tasks.length) { s.pending = { type: 'queue', player, effects: tasks, resume: 'mainEnd' }; return; }
      s.phase = 'attack';
      // 「自分のアタックフェイズ開始時」 watchers of the turn player, then (in the resume) the other
      // player's; mirroring the `onAttackPhaseEnd` pair so 「自分の」/「相手の」 are told apart by whose
      // turn it is.
      emit(ctx, 'phaseChanged', { phase: s.phase });
      if (raiseQueue(ctx, player, 'onAttackPhaseStart', 'attackPhaseStart')) return;
      if (raiseQueue(ctx, otherOf(player), 'onAttackPhaseStart', 'attackPhaseStartOpponent')) return;
      raiseDelayedAttack(ctx, 'start', 'none');
      return;
    }
    case 'attack':
      // 「相手の場のキャラは可能ならアタックしなければならない。」 — the phase cannot be closed while
      // the obligation is still satisfiable; the check is here, at the player's own "end the phase"
      // step, because that is the only route the obligation refuses.
      requireRule(!mustAttackPending(s, player), 'INVALID_CHOICE', '仍有角色必须攻击。');
      if (raiseQueue(ctx, player, 'onAttackPhaseEnd', 'attackEnd')) break;
      if (raiseQueue(ctx, otherOf(player), 'onAttackPhaseEnd', 'attackEndOpponent')) break;
      if (raiseDelayedAttack(ctx, 'end', 'attackEndOpponent')) break;
      endAttackPhase(ctx, player);
      break;
    case 'end':
      for (const side of s.players) for (const card of [...side.front, ...side.energy]) {
        card.bpModifiers = card.bpModifiers.filter(m => m.expiresTurn > s.turn);
        if (card.energyModifiers) card.energyModifiers = card.energyModifiers.filter(m => m.expiresTurn > s.turn);
        if (card.impactModifiers) card.impactModifiers = card.impactModifiers.filter(m => m.expiresTurn > s.turn);
        if (card.evadeModifiers) card.evadeModifiers = card.evadeModifiers.filter(m => m.expiresTurn > s.turn);
        if (card.keywordModifiers) card.keywordModifiers = card.keywordModifiers.filter(m => m.expiresTurn > s.turn);
      }
      checkBP(ctx);
      beginTurn(ctx, otherOf(player));
      return;
    default: throw new RuleError('WRONG_PHASE', '当前阶段不能直接推进。');
  }
  emit(ctx, 'phaseChanged', { phase: s.phase });
}

export function executeResumedCommand(ctx: Context, command: Command): void { execute(ctx, command); }

function execute(ctx: Context, command: Command): void {
  const s = ctx.state;
  const { player, action } = command;
  requireRule(s.status !== 'finished', 'GAME_FINISHED', '对局已经结束。');
  if (action.type === 'reorderFaceDown') {
    requireRule(s.status === 'playing', 'INVALID_STATE', '对局尚未开始。');
    const host = findField(s, player, action.cardId);
    requireRule(host !== undefined, 'INVALID_TARGET', '只能排列自己场上宿主的暗置卡。');
    const hidden = host!.card.faceDown ?? [];
    requireRule(hidden.length > 0 && action.order.length === hidden.length
      && new Set(action.order).size === hidden.length && action.order.every(id => hidden.includes(id)),
    'INVALID_CHOICE', '排序必须恰好包含当前暗置堆的全部卡，不得重复或增减。');
    host!.card.faceDown = [...action.order];
    // This changes no rules event, pending decision, RAID base, or public log.
    return;
  }
  if (action.type === 'concede') { finish(ctx, player, 'concede'); return; }
  const concurrentMulligan = s.pending?.type === 'mulligan' && action.type === 'mulligan' && s.players[player].mulligan === 'pending';
  requireRule(concurrentMulligan || player === (s.pending?.player ?? s.activePlayer), 'WRONG_PLAYER', '当前轮到另一名玩家作出决定。');
  if (s.pending) {
    const expected = { mulligan: 'mulligan', block: 'block', attackTarget: 'resolveAttackTarget', damage: 'chooseDamage', triggers: 'resolveTrigger', queue: 'resolveEffect', discard: 'discard', effect: 'chooseEffect', optionalReady: 'resolveReady', damageSubstitute: 'resolveDamageSubstitute', battleLossSubstitute: 'resolveBattleLossSubstitute', lineOverflow: 'resolveLineOverflow', energyOverflow: 'resolveEnergyOverflow', selectionTaxHand: 'resolveSelectionTax' }[s.pending.type];
    requireRule(action.type === expected || (s.pending.type === 'triggers' && action.type === 'resolveEffect'), 'DECISION_PENDING', '必须先完成当前待处理决策。');
  } else {
    const phases: Partial<Record<Action['type'], string>> = { extraDraw: 'start', move: 'movement', play: 'main', raid: 'main', activate: 'main', attack: 'attack' };
    requireRule(action.type === 'advance' || phases[action.type] === s.phase, 'WRONG_PHASE', '当前阶段不允许这个动作。');
  }
  switch (action.type) {
    case 'mulligan': completeMulligan(ctx, player, action.redraw); break;
    case 'advance': advance(ctx, player); break;
    case 'extraDraw': {
      requireRule(!s.extraDrawUsed, 'EXTRA_DRAW_USED', '本回合已经额外抽牌。');
      requireRule(s.players[player].deck.length > 0, 'DECK_EMPTY', '空卡组不能额外抽牌。');
      // 「自分はAPを支払わずにエクストラドローしてもよい」 — a permission the player's own board carries:
      // the printed cost is skipped, and with no AP left the draw is still available (which is the whole
      // point of the wording). Read from the controller's field statics, and from player-scope grants.
      const free = [...s.players[player].front, ...s.players[player].energy]
        .some(c => activeStatics(s, c.cardId, player).some(m => m.type === 'freeExtraDraw'))
        || playerStatics(s, player).some(m => m.type === 'freeExtraDraw');
      if (!free) spendAp(ctx, player, 1);
      draw(ctx, player, 1);
      s.extraDrawUsed = true;
      logTurnEvent(s, 'extraDraw', player);
      break;
    }
    case 'move': move(ctx, player, action); break;
    case 'play': play(ctx, player, action); break;
    case 'raid': raid(ctx, player, action); break;
    case 'activate': {
      const p = s.players[player];
      const card = findField(s, player, action.cardId)?.card;
      // A card may print several activated abilities; the command names which one, and index 0 is the
      // single-ability case every existing caller means. 「…が持つ[起動メイン]を全て得る」 copies are
      // appended after the printed list, so the same index space addresses both.
      const abilities = [
        ...(getDefinition(s, action.cardId).activated ?? []),
        ...(card?.grantedActivated ?? []).filter(grant => grant.expiresTurn >= s.turn).flatMap(grant => grant.abilities),
      ];
      const index = action.index ?? 0;
      const ability = abilities[index];
      requireRule(ability, 'INVALID_CARD', '该卡没有这个起动主阶段效果。');
      // 「元々の効果（場外発動含む）は発動しない」 (Q2209) — an effects-suppressed card's *printed*
      // activated abilities are refused; the ones it gained (`grantedActivated`) are 「得た効果」 and stay.
      // The refusal is index-scoped so the command's index space (and every candidate list built from it)
      // keeps its shape while the suppression holds.
      const printedCount = (getDefinition(s, action.cardId).activated ?? []).length;
      requireRule(!(effectsSuppressed(s, action.cardId) && index < printedCount), 'INVALID_CHOICE', '该角色的元々的效果已被失去。');
      // 「[起動メイン][場外にある場合]…」 — the ability works while its card sits in the discard pile,
      // where there is no FieldCard. Only an ability whose own condition scopes it to 場外 may be
      // activated there, mirroring the rule the trigger collection uses; its per-turn budget lives on
      // the player, and a レスト cost has nothing to rest. 「[リムーブエリアにある場合]」 is the same
      // channel for the removal area, written as the ability's own `zone` tag.
      const sideline = card === undefined && p.sideline.includes(action.cardId) && sidelineScoped(ability.condition);
      const removal = card === undefined && p.removal.includes(action.cardId) && (ability.zone === 'removal' || sidelineScoped(ability.condition));
      // 「このカードが自分の手札にあり、必要エナジーを満たす場合のみ発動できる。」 — the hand channel,
      // the third zone an activated ability may work from. The printed requirement gate is a hard condition
      // of the activation, so a hand card that cannot pay its own cost is refused with the energy code.
      // 「このカードの必要エナジーを満たしている場合のみ発動できる。」 (EVA-1-075) prints the same gate
      // without naming the hand: the ability works from 場外 (its own condition says so) and the gate
      // applies there too — the predicate is the same one either way.
      const hand = card === undefined && ability.zone === 'hand' && p.hand.includes(action.cardId);
      requireRule(!(hand || sideline || removal) || ability.handGate !== 'energySatisfied' || energySatisfied(s, player, action.cardId), 'INSUFFICIENT_ENERGY', '场外/手牌中的发动需要满足必要能量。');
      requireRule(card !== undefined || sideline || removal || hand, 'INVALID_CARD', '只能发动自己场上卡的起动效果。');
      requireRule(!((sideline || removal || hand) && ability.rest), 'INVALID_CHOICE', '场外的卡不能作为休息费用。');
      // Q2272 (総則) — 対象を選ぶ必要がある【起動メイン】は、その対象全てを選ぶことができない場合、発動する
      // ことができません (「まで」形の min0 は可)。 Read before any cost, budget or rest is taken.
      requireRule(!activationSelectBlocked(s, player, action.cardId, ability.effects), 'INVALID_CHOICE', '效果所需的对象无法全部选择，不能发动。');
      if (sideline || removal || hand) {
        // The per-turn budget lives on the player for the same reason the sideline channel's does: a card
        // in a pile has no `FieldCard` to carry `abilityUsed`. It is keyed by the *card instance*: a plain
        // 「[ターン1]」 belongs to each copy (Q770), so two same-name copies in a pile each activate once.
        // The named-tail 「〈X〉のこの効果は…」 (`sharedLimit`) is shared by every copy of the printed card
        // (Q770/Q2308) and keeps the player-level ledger, exactly like the field branch below.
        const sharedKey = ability.sharedLimit === true && ability.oncePerTurn === true
          ? `a:${getDefinition(s, action.cardId).functionalId}:${index}` : undefined;
        const key = `act:${action.cardId}:${index}`;
        const store = hand ? 'handTriggeredUsed' : 'sidelineTriggeredUsed';
        requireRule(sharedKey === undefined || p.sharedLimitUsed?.[sharedKey] !== s.turn, 'INVALID_CHOICE', '本回合已发动过此效果。');
        requireRule(sharedKey !== undefined || !ability.oncePerTurn || p[store]?.[key] !== s.turn, 'INVALID_CHOICE', '本回合已发动过此效果。');
        if (ability.oncePerTurn) {
          if (sharedKey !== undefined) p.sharedLimitUsed = { ...(p.sharedLimitUsed ?? {}), [sharedKey]: s.turn };
          else p[store] = { ...(p[store] ?? {}), [key]: s.turn };
        }
      } else {
        // 「〈X〉のこの効果は1ターンに1回のみ発動できる。」 — the named-tail budget is shared by every copy
        // of the printed card (Q770/Q2308), so it is keyed by functional identity on the player; a plain
        // 「[ターン1]」 keeps the per-instance `abilityUsed` counter below.
        const sharedKey = ability.sharedLimit === true && ability.oncePerTurn === true
          ? `a:${getDefinition(s, action.cardId).functionalId}:${index}` : undefined;
        const used = card!.abilityUsed ?? {};
        requireRule(sharedKey === undefined || p.sharedLimitUsed?.[sharedKey] !== s.turn, 'INVALID_CHOICE', '本回合已发动过此效果。');
        requireRule(sharedKey !== undefined || !ability.oncePerTurn || used[index] !== s.turn, 'INVALID_CHOICE', '本回合已发动过此效果。');
        requireRule(!ability.rest || card!.active, 'NOT_ACTIVE', '发动此效果需要将激活的卡休息。');
        if (ability.rest) {
          // Q1243 — a card under a 「レストにならない」 lock cannot pay a [レストにする] activation cost:
          // the cost is the controller's own doing (Q1340/Q1341), so the own-side refusal reads it
          // (the ability's own card is the rest's cause for the trait-scoped forms).
          requireRule(!refusesRest(s, action.cardId, player, true, action.cardId), 'INVALID_CHOICE', '该卡不会因效果被休息，不能支付[レストにする]发动费用。');
          card!.active = false;
          logTurnEvent(s, 'rested', player, action.cardId);
          // 「発動条件の＃レストにする＃でもこの条件を満たします」 (Q1340/Q1341) — the activation cost is
          // the controller's own doing, so it satisfies 「自分の効果で…レストになった」 as well; the
          // cause owner is the activating player, and the line rides along for the line-narrowed gates.
          const restLine = findField(s, player, action.cardId)?.line;
          logTurnEvent(s, 'restedByEffect', player, action.cardId, { causeOwner: player, ...(restLine ? { line: restLine } : {}) });
        }
        if (sharedKey !== undefined) p.sharedLimitUsed = { ...(p.sharedLimitUsed ?? {}), [sharedKey]: s.turn };
        else card!.abilityUsed = { ...used, [index]: s.turn };
        card!.instanceId ??= fieldIdentity(card!);
      }
      if (ability.condition) requireRule(evalCondition(s, action.cardId, player, ability.condition), 'INVALID_CHOICE', '当前不满足发动条件。');
      // A discard choice must not park an activation whose later printed AP cost is unpayable.
      // This state is the command's private clone, including its rest cost; refusal rolls it all back.
      const costFailure = activationCostFailure(s, player, action.cardId, ability.effects);
      requireRule(costFailure !== 'hand', 'INVALID_CHOICE', '手牌不足，无法支付该效果的费用。');
      requireRule(costFailure !== 'ap', 'INSUFFICIENT_AP', '可用 AP 不足，无法支付发动费用。');
      emit(ctx, 'abilityActivated', { player, cardId: action.cardId, index });
      // 「このターン中にこのキャラが[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) — the
      // turn log's activation record, carrying whether the ability's own cost tag was an AP payment.
      logTurnEvent(s, 'abilityActivated', player, action.cardId, { ...(hasApCostTag(ability.effects) ? { apCost: true } : {}) });
      // 「自分の場の〈X〉の[起動メイン]が発動した時、…」 — the activation moment, watched from another of
      // the controller's cards. Queued behind the ability's own resolution like every other watcher.
      ctx.queue.push(...collectTriggered(ctx, player, 'onAbilityActivated', action.cardId));
      // 「相手が[起動メイン]を発動した時、…」 (BCV-1-008) — the other side's watchers, the same cross-side
      // collection the opponent's retirement and return-to-hand moments use. Raised for the opponent's
      // cards only: the own-side call above never reaches an `anyOfTheirs` ability.
      ctx.queue.push(...collectTriggered(ctx, otherOf(player), 'onAbilityActivated', action.cardId, undefined, { crossSide: true }));
      startEffect(ctx, makeTask(s, player, action.cardId, ability.effects));
      break;
    }
    case 'chooseEffect': chooseEffect(ctx, action.choiceId, action.selected); break;
    case 'resolveEffect': {
      const pending = s.pending;
      requireRule(pending?.type === 'triggers' || pending?.type === 'queue', 'INVALID_CHOICE', '当前没有等待结算的登场效果。');
      const task = pending.effects?.find(t => t.id === action.taskId);
      requireRule(task, 'INVALID_CHOICE', '该效果已结算或不存在。');
      requireRule(pending.type !== 'queue' || task.player === player, 'WRONG_PLAYER', '只能结算自己控制的效果。');
      // Remove the resolved task by identity: two abilities raised from the *same* card in one batch
      // share the `revision:sourceId` id `makeTask` mints, and a filter-by-id dropped every twin at
      // once — the sibling watcher never ran (round-106 ARK-2-062: a granted ブロック勝利 watcher
      // beside the card's own printed one).
      pending.effects = pending.effects!.filter(t => t !== task);
      if (pending.type === 'triggers') startEffect(ctx, task, pending);
      else startEffect(ctx, task, pending.triggerResume, undefined, { effects: pending.effects!, resume: pending.resume, ...(pending.defenderId !== undefined ? { defenderId: pending.defenderId } : {}), ...(pending.damageCount !== undefined ? { damageCount: pending.damageCount } : {}) });
      break;
    }
    case 'attack': attack(ctx, player, action); break;
    case 'block': block(ctx, player, action.cardId); break;
    case 'resolveAttackTarget': {
      // 「[狙い撃ち]」 designation answered: the candidate list was filtered when the window opened and the
      // board cannot change while it is open, so the answer only has to be one of them.
      requireRule(s.pending?.type === 'attackTarget', 'INVALID_CHOICE', '当前没有狙击指定。');
      const pending = s.pending;
      requireRule(player === pending.player, 'WRONG_PLAYER', '只有攻击方可以指定狙击目标。');
      const battle = s.battle;
      requireRule(battle != null && findField(s, battle.attacker, battle.attackerId) !== undefined, 'INVALID_STATE', '战斗已结束。');
      s.pending = null;
      if (pending.queued?.length) ctx.queue.push(...pending.queued);
      if (action.targetId !== null) {
        requireRule(pending.candidates.includes(action.targetId), 'INVALID_TARGET', '该角色不能被狙击指定。');
        designateTarget(ctx, pending.player, pending.attackerId, action.targetId);
      } else {
        // Declining is a normal attack: it still walks 「アタック時」 and then opens the block window.
        emit(ctx, 'attackTargetDeclined', { player: pending.player, cardId: pending.attackerId });
      }
      continueAttack(ctx);
      break;
    }
    case 'chooseDamage': chooseDamage(ctx, action.slots); break;
    case 'resolveTrigger': resolveTrigger(ctx, player, action); break;
    case 'resolveSelectionTax': {
      const pending = s.pending;
      requireRule(pending?.type === 'selectionTaxHand', 'INVALID_CHOICE', '当前没有需要支付的选择税。');
      const p = s.players[player];
      requireRule(action.cards.length === pending.count && new Set(action.cards).size === action.cards.length
        && action.cards.every(id => p.hand.includes(id) && pending.cards.includes(id)),
      'INVALID_CHOICE', '必须选择准确数量且不重复的自己的手牌。');
      const resume = pending.resume;
      requireRule(resume.activate === true && resume.targetId !== undefined, 'INVALID_CHOICE', '选择税续接已失效。');
      payTax(ctx, resume.targetId, player, selectionTaxFor(s, resume.targetId, player, 'trigger'), { hand: action.cards });
      s.pending = pending.triggers;
      resolveTrigger(ctx, player, resume, true);
      break;
    }
    case 'discard': {
      requireRule(s.pending?.type === 'discard', 'INVALID_CHOICE', '当前不需要整理手牌。');
      const p = s.players[player];
      requireRule(action.cards.length === s.pending.count && new Set(action.cards).size === action.cards.length && action.cards.every(id => p.hand.includes(id)), 'INVALID_CHOICE', '必须选择准确数量且不重复的自己的手牌。');
      p.hand = p.hand.filter(id => !action.cards.includes(id));
      // 「このカードが使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く。」 — a
      // hand-limit discard is not a use, so the static's holder reaches 場外 instead (Q: the print's
      // exemption covers only 「使用される」).
      const redirected = action.cards.filter(id => removalRedirectsToSideline(s, id) || ownStaticsOf(s,id,player).some(m => m.type === 'overflowToSideline'));
      p.removal.push(...action.cards.filter(id => !redirected.includes(id)));
      p.sideline.push(...redirected);
      // Abilities raised while this decision was open (the ready step's activation watchers) go back to
      // `ctx.queue`, where the command's tail turns them into the next pending queue.
      if (s.pending.queued?.length) ctx.queue.push(...s.pending.queued);
      s.pending = null;
      emit(ctx, 'handDiscarded', { player, cards: action.cards.filter(id => !redirected.includes(id)), destination: 'removal' });
      if (redirected.length) emit(ctx, 'handDiscarded', { player, cards: redirected, destination: 'sideline' });
      break;
    }
    case 'resolveLineOverflow': {
      // 「上限を超えた分をリムーブ」(Q997/Q985/Q1406) — the line's owner names the card. The removal is
      // the rules procedure itself, so it goes straight through `leaveField` under the same reason the
      // replace route uses (destination redirects stay intact, and any 「リムーブエリアに置かれた時」
      // watcher it raises rides the queue). The tail re-runs `openLineOverflow`: a line still over
      // capacity asks again with a fresh list, one that fits moves on to whatever the removal raised.
      requireRule(s.pending?.type === 'lineOverflow', 'INVALID_CHOICE', '当前没有需要处理超容量的战线。');
      const pending = s.pending;
      requireRule(s.players[pending.player][pending.line].some(slot => slot.cardId === action.cardId), 'INVALID_TARGET', '只能选择超出容量的那条战线上的卡。');
      s.pending = null;
      if (pending.queued?.length) ctx.queue.push(...pending.queued);
      leaveField(ctx, pending.player, action.cardId, 'removal', 'line-capacity');
      break;
    }
    case 'resolveEnergyOverflow': {
      requireRule(s.pending?.type === 'energyOverflow', 'INVALID_CHOICE', '当前没有需要腾出的エナジーL。');
      const pending = s.pending;
      requireRule(player === pending.player, 'INVALID_CHOICE', '只有该能量线的持有者可以选择。');
      requireRule(s.players[pending.defender].energy.some(slot => slot.cardId === action.cardId), 'INVALID_TARGET', '只能选择该エナジーL上的卡。');
      const battle = s.battle;
      requireRule(battle != null && findField(s, battle.attacker, battle.attackerId) !== undefined, 'INVALID_STATE', '战斗已结束。');
      if (battle == null) break; // unreachable: the rule above refused — narrows the type for the tail below
      s.pending = null;
      if (pending.queued?.length) ctx.queue.push(...pending.queued);
      leaveField(ctx, pending.defender, action.cardId, 'removal', 'battle-overflow');
      emit(ctx, 'energyOverflowRemoved', { player: pending.defender });
      moveLoserToEnergy(ctx, pending.defender, pending.defenderId);
      const negate = getKeywords(s, pending.defenderId).impactNegate
        && !forbiddenKeyword(s, otherOf(s.cards[pending.defenderId]?.owner ?? 0), 'impactNegate')
        && !battleOpponentStripsKeyword(s, battle.attackerId, 'impactNegate');
      const impact = getImpact(s, findField(s, battle.attacker, battle.attackerId)!.card);
      if (impact && !negate) { damage(ctx, impact); break; }
      endBattle(ctx);
      break;
    }
    case 'resolveDamageSubstitute': {
      requireRule(s.pending?.type === 'damageSubstitute', 'INVALID_CHOICE', '当前没有可替代的伤害。');
      const pending = s.pending;
      requireRule(player === pending.damagedPlayer, 'INVALID_CHOICE', '只有受到伤害的玩家可以回答。');
      const holder = findField(s, pending.damagedPlayer, pending.substituteCardId)?.card;
      const accepted = action.accept && holder !== undefined;
      logEvent(ctx, 'optionPicked', { player, label: accepted ? `发动伤害替代（伤害改为 ${pending.reduceTo}）` : '不发动伤害替代' });
      if (accepted) (holder.triggeredUsed ??= {}).damageSubstitute = 1;
      s.pending = null;
      // The damage the question was about resumes with the printed count or the substituted one; every
      // other field (whose life area, which card dealt it, whether a battle was open) is carried over.
      openDamage(ctx, {
        player: otherOf(pending.damagedPlayer), damagedPlayer: pending.damagedPlayer,
        count: accepted ? pending.reduceTo : pending.count,
        ...(pending.sourceId !== undefined ? { sourceId: pending.sourceId } : {}),
        ...(pending.outsideBattle ? { outsideBattle: true as const } : {}),
      });
      break;
    }
    case 'resolveBattleLossSubstitute': {
      // 「相手の効果やバトルによってこのキャラが場を離れる場合、代わりに自分の手札を1枚場外に置いて
      // もよい。」 (BLC-2-067) — the losing card's owner answers: accepting pays the hand cards and keeps
      // the card (running the printed follow-up on it), declining lets the loss run. Either way the
      // battle's tail — インパクト damage and the close — runs from here, computed before the departure
      // so the loser's own [インパクト無効] still reads from where it stands.
      requireRule(s.pending?.type === 'battleLossSubstitute', 'INVALID_CHOICE', '当前没有代替离场的报价。');
      const pending = s.pending;
      requireRule(player === pending.player, 'INVALID_CHOICE', '只有该卡的持有者可以回答。');
      const battle = s.battle;
      requireRule(battle != null && findField(s, battle.attacker, battle.attackerId) !== undefined, 'INVALID_STATE', '战斗已结束。');
      if (battle == null) break; // unreachable: the rule above refused — narrows the type for the tail below
      const holder = findField(s, pending.player, pending.cardId);
      const accepted = action.accept === true && holder !== undefined;
      logEvent(ctx, 'optionPicked', { player, label: accepted ? '发动战败替代（代替离场）' : '不发动战败替代' });
      const defenderId = pending.cardId;
      const negate = getKeywords(s, defenderId).impactNegate
        && !forbiddenKeyword(s, otherOf(s.cards[defenderId]?.owner ?? 0), 'impactNegate')
        && !battleOpponentStripsKeyword(s, battle.attackerId, 'impactNegate');
      const impact = getImpact(s, findField(s, battle.attacker, battle.attackerId)!.card);
      if (accepted && pending.hand !== undefined) {
        const cost = action.cards ?? [];
        requireRule(cost.length === pending.hand && new Set(cost).size === cost.length
          && cost.every(id => s.players[pending.player].hand.includes(id)), 'INVALID_CHOICE', '需要选择恰好的手牌数。');
        s.players[pending.player].hand = s.players[pending.player].hand.filter(id => !cost.includes(id));
        s.players[pending.player].sideline.push(...cost);
        // The effect-route cost form records the payment the same way (no `discardedFromHand` log entry:
        // a price the printed static charges is not the hand-discard watcher family's moment).
        ctx.events.push({ type: 'effectDiscarded', data: { player: pending.player, cards: cost } });
      }
      s.pending = null;
      if (accepted) {
        // 「そうした場合、レイド状態のこのキャラの一番上のカードを自分の場外に置く。」 (BLC-2-067) — the
        // follow-up runs on the saved card. Only the shapes the printed family carries are executed
        // (the peel; anything else is ignored rather than guessed).
        for (const step of pending.follow ?? []) {
          if ((step.type === 'act' || step.type === 'actSource') && step.operation === 'topToSideline') {
            peelTopToSideline(ctx, pending.player, defenderId);
          }
        }
      } else {
        sendBattleLoser(ctx, battle, defenderId, true);
      }
      if (impact && !negate) { damage(ctx, impact); break; }
      endBattle(ctx);
      break;
    }
    case 'resolveReady': {
      requireRule(s.pending?.type === 'optionalReady', 'INVALID_CHOICE', '当前不需要选择エンドフェイズ的准备。');
      const pending = s.pending;
      requireRule(action.ready.every(id => pending.cards.includes(id)) && new Set(action.ready).size === action.ready.length,
        'INVALID_CHOICE', '只能从提示中的卡片里选择。');
      const p = s.players[player];
      const readyTasks: EffectTask[] = [];
      if (action.ready.length) logEvent(ctx, 'cardsStood', { player, cards: [...action.ready] });
      const skipped = pending.cards.filter(id => !action.ready.includes(id));
      if (skipped.length) logEvent(ctx, 'readySkipped', { player, cards: skipped });
      for (const id of action.ready) {
        const here = findField(s, player, id);
        if (here) readyTasks.push(...activateField(ctx, player, here.card, 'ready-step'));
      }
      const queued = [...(pending.queued ?? []), ...readyTasks];
      s.pending = null;
      // The hand-limit question the ready step would have asked had no card printed the permission; it is
      // asked now, once the ready answer is in, so neither decision can drop the other's watchers.
      const limit = handLimitOf(s, player);
      if (p.hand.length > limit) s.pending = { type: 'discard', player, count: p.hand.length - limit, ...(queued.length ? { queued } : {}) };
      else ctx.queue.push(...queued);
      break;
    }
  }
  // 「…に置けるカードの枚数が減った結果、上限を超えた」 (Q997/Q985/Q1406) — the settle runs here, at the
  // command's tail, where the placement that dropped the ceiling and its own resolution are both done.
  // It is answered before any watcher the command raised (those ride the pending's `queued`).
  if (!s.pending && !s.effect && s.status === 'playing') openLineOverflow(ctx);
  // Retire triggers raised while the command resolved but not attached to an effect frame.
  if (!s.effect && ctx.queue.length) {
    if (!s.pending) s.pending = { type: 'queue', player: ctx.queue[0]!.player, effects: ctx.queue.splice(0, ctx.queue.length), resume: 'none' };
    // A command that ends on a damage decision would otherwise drop them: the pending carries them
    // until `chooseDamage` hands them to the trigger batch.
    else if (s.pending.type === 'damage') s.pending.queued = [...(s.pending.queued ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
    // The overflow settle holds them the same way: the line is brought back to its capacity before any
    // of the raised watchers may resolve.
    else if (s.pending.type === 'lineOverflow') s.pending.queued = [...(s.pending.queued ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
    // The same for the 満线腾位 question: the slot is freed before the raised watchers may resolve.
    else if (s.pending.type === 'energyOverflow') s.pending.queued = [...(s.pending.queued ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
    // The designation window carries raised abilities the same way, so a future change that raises inside
    // the seam cannot silently drop them (they are handed back when the question is answered).
    else if (s.pending.type === 'attackTarget') s.pending.queued = [...(s.pending.queued ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
    // The same when the command already opened a queue of its own (an attack that raised its `onAttack`
    // watchers *and* stood the card up via 「[2回アタック]」): the later tasks join that queue instead of
    // being dropped. The resolving player picks the order either way.
    else if (s.pending.type === 'queue' || s.pending.type === 'triggers') s.pending.effects = [...(s.pending.effects ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
    else if (s.pending.type === 'selectionTaxHand') s.pending.triggers.effects = [...(s.pending.triggers.effects ?? []), ...ctx.queue.splice(0, ctx.queue.length)];
  }
}

/** Atomic deterministic transition. On rejection the EXACT original state is returned. */
export function applyCommand(state: GameState, command: unknown, opts?: { log?: boolean }): CommandResult {
  try {
    validateCommand(command);
    requireRule(command.expectedRevision === state.revision, 'STALE_COMMAND', '局面已更新，请基于最新版本重新选择。');
    assertInvariants(state);
    const ctx: Context = { state: structuredClone(state), events: [], queue: [] };
    if (opts?.log !== false) createLedger(ctx);
    execute(ctx, command);
    capturePublicReveals(ctx);
    // Each queued ability is chosen by its controller, including tasks raised by the opponent's effect.
    if (ctx.state.pending?.type === 'queue' && ctx.state.pending.effects.length) ctx.state.pending.player = ctx.state.pending.effects[0]!.player;
    if (!ctx.state.pending && !ctx.state.effect) delete ctx.state.publicReveals;
    settleLifeZero(ctx);
    syncLedger(ctx, 'rule');
  ctx.state.revision++;
    assertInvariants(ctx.state);
    return { ok: true, state: ctx.state, events: mergeLogEvents(ctx) };
  } catch (error) {
    if (error instanceof DepartureChoice) {
      // Abandon the trial mutation, including RNG and already-paid costs. The answer replays exactly
      // the validated command against its original pending/frame, so no half-departure is observable.
      const ctx: Context = {state: structuredClone(state),events:[],queue:[]};
      const pendingBefore = ctx.state.pending;
      const effectBefore = ctx.state.effect;
      delete ctx.state.effect;
      const resume: CardEffect = {type:'resumeCommand',command:structuredClone(command as Command),pendingBefore,
        ...(effectBefore ? {effectBefore} : {})};
      const triggerResume = pendingBefore?.type === 'triggers' ? pendingBefore : effectBefore?.resume;
      const answerStep = (destination: DepartureAnswer): CardEffect =>
        ({type:'departureAnswer',cardId:error.cardId,destination});
      const payNoun = error.offer === undefined ? '' : error.offer.price === 'under' ? '里侧卡' : error.offer.price === 'life' ? '生命卡' : '手牌';
      const paySelect: CardEffect | undefined = error.alternative === 'pay' && error.offer !== undefined
        && error.candidates !== undefined && error.offer.count > 0 && error.candidates.length > error.offer.count
        ? {type:'departurePaySelect',cardId:error.cardId,count:error.offer.count,
           prompt:`${error.offer.label} — 选择要支付的 ${error.offer.count} 张${payNoun}`,
           candidates:[...error.candidates]}
        : undefined;
      startEffect(ctx, makeTask(ctx.state,error.player,error.cardId,[{type:'chooseOption',count:1,
        ...(error.label !== undefined ? {labels:['按原路线离场',error.label]} : {}),
        options:[
        [answerStep('original'),resume],
        [...(paySelect ? [paySelect] : []), answerStep(error.alternative), resume],
      ]}]),triggerResume);
      const replacementFrame = (ctx.state as GameState).effect;
      if (effectBefore && replacementFrame) replacementFrame.suspended = effectBefore;
      ctx.state.revision++;
      assertInvariants(ctx.state);
      return {ok:true,state:ctx.state,events:ctx.events};
    }
    if (!(error instanceof RuleError)) throw error;
    return { ok: false, state, events: [], error: { code: error.code, message: error.message } };
  }
}

/**
 * The reveal events that make a card public — the union every reveal site already emits.
 * `cardsRevealed` is the public half of a look (`revealLooked`), `cardsRevealedToHand` a reveal whose
 * card was then taken; the rest name themselves. A private look (「見る」 alone) emits none of these,
 * which is what keeps it hidden.
 */
const PUBLIC_REVEAL_EVENTS = new Set(['cardRevealed', 'cardsRevealed', 'handRevealed', 'clashRevealed', 'cardsRevealedToHand']);

function capturePublicReveals(ctx: Context): void {
  const seen = new Set(ctx.state.publicReveals ?? []);
  let grew = false;
  for (const event of ctx.events) {
    if (!PUBLIC_REVEAL_EVENTS.has(event.type)) continue;
    for (const id of [event.data.cardId, ...(Array.isArray(event.data.cards) ? event.data.cards : [])]) {
      if (typeof id === 'string' && !seen.has(id)) { seen.add(id); grew = true; }
    }
  }
  if (grew) ctx.state.publicReveals = [...seen];
}

/**
 * 「自分のライフが0枚になった場合、敗北しますか？はい、このカードの効果を処理した後に敗北します。」
 * (Q326/Q429) — a life-zero defeat settles once the effect that caused it has finished, on every route.
 *
 * `endBattle` checks at the battle's own close, but an effect-route reduction — a life card retired by
 * a card effect, or battle damage whose life-trigger frame drained to an empty batch — could end the
 * command with life=0 and nothing pending. `assertInvariants` refuses that state («未结算生命归零»),
 * so every later command failed validation and the match deadlocked (round-104 FAM-A: 11 seeds / 8
 * source cards). Deciding here, with no decision and no effect frame left, is the same moment the
 * battle route decides, expressed once for every entry.
 */
function settleLifeZero(ctx: Context): void {
  const s = ctx.state;
  if (s.status !== 'playing' || s.pending || s.effect) return;
  for (const player of [0, 1] as const) if (s.players[player].life.length === 0) { finish(ctx, player, 'life-zero'); break; }
}

/** Useful to preview a concrete UI action; it does not mutate the authoritative state. */
export function checkAction(state: GameState, player: PlayerId, action: Action): { legal: true } | { legal: false; code: string; message: string } {
  const result = applyCommand(state, { player, expectedRevision: state.revision, action }, { log: false });
  return result.ok ? { legal: true } : { legal: false, ...result.error };
}
