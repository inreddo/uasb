import type { CardId, GameState, PlayerId, StaticModifier } from './types.ts';
import { availableTriggerReplacements, getApCost, getBP, getDamage, getDefinition, getEnergy, getGeneratedEnergy, getImpact, getKeywords, requiredEnergyOf } from './engine.ts';
import { activeStatics, effectiveRequiredEnergy, protectionAttribution, staticCanStep, staticForbids, staticProtection, staticSnipeTax } from './conditions.ts';
import { requireRule } from './validation.ts';
import { choiceOptionLabel } from './choice-labels.ts';
import { activationCostFailure, lifeSlotCode } from './effects.ts';
import { actionHints } from './action-hints.ts';

function liveKeywords(state: GameState, cardId: CardId, controller: PlayerId) {
  const merged = getKeywords(state, cardId);
  return {
    step: !!merged.step || staticCanStep(state, cardId, controller),
    snipe: !!merged.snipe, doubleAttack: !!merged.doubleAttack, doubleBlock: !!merged.doubleBlock, impactNegate: !!merged.impactNegate,
  };
}

export type CardLimit = 'cannotAttack' | 'cannotBlock' | 'retireMainEnd' | 'retireEnd' | 'retireAttackEnd' | 'retireOpponentAttackEnd';
function cardLimits(state: GameState, card: import('./types.ts').FieldCard, forbids: ReturnType<typeof staticForbids>): CardLimit[] {
  const out: CardLimit[] = [];
  if (forbids.attack) out.push('cannotAttack');
  if (forbids.block) out.push('cannotBlock');
  if (card.retireAtMainEnd === state.turn) out.push('retireMainEnd');
  if (card.retireAtEnd === state.turn) out.push('retireEnd');
  for (const grant of card.grantedAbilities ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    const { ability } = grant;
    if (!ability.effects.length || !ability.effects.every(step => step.type === 'actSource' && step.operation === 'retire')) continue;
    const opponentTurn = ability.condition?.type === 'turnOf' && ability.condition.who === 'opponent';
    if (ability.event === 'onAttackPhaseEnd') out.push(opponentTurn ? 'retireOpponentAttackEnd' : 'retireAttackEnd');
    else if (ability.event === 'onEndPhaseStart') out.push('retireEnd');
    else if (ability.event === 'onMainEnd') out.push('retireMainEnd');
  }
  return [...new Set(out)];
}

/** The effect routes 「選ばれない」 refuses; `any` is the unqualified 「相手の効果で選ばれない」. */
export type CardProtectionRoute = 'characterEffect' | 'eventEffect' | 'trigger' | 'any';
export type CardProtectionEntry = {
  route: CardProtectionRoute;
  both?: true;
  /** 「特徴に「X」を持たない…キャラの効果で」 — only such a cause is refused. */
  sourceNotTrait?: string;
  /** 「レイド状態でない相手のキャラの効果で」 — a raid-state cause still chooses it. */
  sourceNotRaid?: true;
  /** Printed on the card, or installed by an effect (its own or a broadcast). */
  origin: 'printed' | 'granted';
  grantedByName?: string;
};
export type CardBlockEvadeEntry = {
  /** 「BP N以上」 — a blocker whose current BP is at least this is refused. */
  minBP: number;
  /** Printed on the card, or installed by an effect (its own or a broadcast). */
  origin: 'printed' | 'granted';
  /** The card name that installed a granted restriction, when that source is still on the field. */
  grantedByName?: string;
};
/** The protections a field card currently carries; omitted entirely when the card carries none. */
export type CardProtection = {
  cannotBeChosenBy: CardProtectionEntry[];
  cannotBeSniped?: true;
  cannotBeBlockedByAtLeast?: CardBlockEvadeEntry[];
};

export type CardSelectionTax = {
  amount: number;
  kind: 'ap' | 'hand' | 'rest';
};

/**
 * The name a grant source still on the field gives, or `undefined` when it left (a card in hand or a
 * hidden zone would leak that card's identity, so it is not projected).
 */
function cardNameOnField(state: GameState, sourceId: CardId): string | undefined {
  const owner = state.cards[sourceId]?.owner;
  if (owner === undefined) return undefined;
  const onField = [...state.players[owner].front, ...state.players[owner].energy].some(card => card.cardId === sourceId);
  return onField ? getDefinition(state, sourceId).name : undefined;
}

/** A structural key for one protection modifier, used only to tell a printed copy from a grant. */
function protectionKey(modifier: Extract<StaticModifier, { type: 'cannotBeChosenBy' }>): string {
  return JSON.stringify([modifier.source ?? 'any', modifier.both === true, modifier.sourceNotTrait ?? null, modifier.sourceNotRaid === true]);
}

/** A structural key for one at-least restriction, used only to tell a printed copy from a grant. */
function blockEvadeKey(modifier: Extract<StaticModifier, { type: 'cannotBeBlockedByAtLeast' }>): string {
  return JSON.stringify(modifier.minBP);
}

function cardBlockEvade(state: GameState, cardId: CardId, controller: PlayerId): CardBlockEvadeEntry[] {
  const printed = new Set((getDefinition(state, cardId).static ?? [])
    .flatMap(ability => ability.modifiers)
    .filter((modifier): modifier is Extract<StaticModifier, { type: 'cannotBeBlockedByAtLeast' }> => modifier.type === 'cannotBeBlockedByAtLeast')
    .map(blockEvadeKey));
  // The card's own grant slot is the one home whose source identity is readable here; a modifier that
  // never reaches `activeStatics` (expired, orphaned `whileSource`) cannot be matched by identity anyway.
  const installedBy = new Map<StaticModifier, CardId>();
  const holder = [...state.players[controller].front, ...state.players[controller].energy].find(card => card.cardId === cardId);
  for (const grant of holder?.grantedStatics ?? []) {
    if (grant.grantedBy === undefined) continue;
    for (const ability of grant.abilities) for (const modifier of ability.modifiers) {
      if (modifier.type === 'cannotBeBlockedByAtLeast') installedBy.set(modifier, grant.grantedBy);
    }
  }
  const out: CardBlockEvadeEntry[] = [];
  for (const modifier of activeStatics(state, cardId, controller)) {
    if (modifier.type !== 'cannotBeBlockedByAtLeast') continue;
    const source = installedBy.get(modifier);
    const name = source !== undefined ? cardNameOnField(state, source) : undefined;
    const entry: CardBlockEvadeEntry = {
      minBP: modifier.minBP,
      origin: source !== undefined ? 'granted' : printed.has(blockEvadeKey(modifier)) ? 'printed' : 'granted',
      ...(name !== undefined ? { grantedByName: name } : {}),
    };
    // A printed line plus a grant of the same bound arrive twice; identical explanations collapse.
    if (out.some(one => JSON.stringify(one) === JSON.stringify(entry))) continue;
    out.push(entry);
  }
  // The tightest bound first — the one the block check stands on, and the order the client labels.
  out.sort((a, b) => a.minBP - b.minBP);
  return out;
}

function cardProtection(state: GameState, cardId: CardId, controller: PlayerId, cannotBeSniped: boolean): CardProtection | undefined {
  const printed = new Set((getDefinition(state, cardId).static ?? [])
    .flatMap(ability => ability.modifiers)
    .filter((modifier): modifier is Extract<StaticModifier, { type: 'cannotBeChosenBy' }> => modifier.type === 'cannotBeChosenBy')
    .map(protectionKey));
  const grantedBy = new Map<StaticModifier, CardId>();
  for (const entry of protectionAttribution(state, cardId, controller)) {
    if (entry.grantedBy !== undefined) grantedBy.set(entry.modifier, entry.grantedBy);
  }
  const out: CardProtectionEntry[] = [];
  for (const modifier of staticProtection(state, cardId, controller)) {
    const installedBy = grantedBy.get(modifier);
    const name = installedBy !== undefined ? cardNameOnField(state, installedBy) : undefined;
    const entry: CardProtectionEntry = {
      route: modifier.source === undefined || modifier.source === 'any' ? 'any' : modifier.source,
      ...(modifier.both === true ? { both: true as const } : {}),
      ...(modifier.sourceNotTrait !== undefined ? { sourceNotTrait: modifier.sourceNotTrait } : {}),
      ...(modifier.sourceNotRaid === true ? { sourceNotRaid: true as const } : {}),
      origin: installedBy !== undefined ? 'granted' : printed.has(protectionKey(modifier)) ? 'printed' : 'granted',
      ...(name !== undefined ? { grantedByName: name } : {}),
    };
    // The same route can arrive twice (a broadcast plus a grant); the client would draw one label per
    // distinct explanation, so identical entries collapse.
    if (out.some(one => JSON.stringify(one) === JSON.stringify(entry))) continue;
    out.push(entry);
  }
  const blockEvade = cardBlockEvade(state, cardId, controller);
  if (!out.length && !cannotBeSniped && !blockEvade.length) return undefined;
  return {
    cannotBeChosenBy: out,
    ...(cannotBeSniped ? { cannotBeSniped: true as const } : {}),
    ...(blockEvade.length ? { cannotBeBlockedByAtLeast: blockEvade } : {}),
  };
}

function cardSelectionTaxes(state: GameState, cardId: CardId, controller: PlayerId, onField: boolean): CardSelectionTax[] {
  const definition = getDefinition(state, cardId);
  const printed = (definition.static ?? [])
    .flatMap(ability => ability.modifiers)
    .filter((modifier): modifier is Extract<StaticModifier, { type: 'selectionTax' }> => modifier.type === 'selectionTax');
  const live = onField
    ? activeStatics(state, cardId, controller).filter((modifier): modifier is Extract<StaticModifier, { type: 'selectionTax' }> => modifier.type === 'selectionTax')
    : printed;
  const order = { ap: 0, hand: 1, rest: 2 } as const;
  const out: CardSelectionTax[] = [];
  for (const modifier of live) {
    const entry: CardSelectionTax = { amount: modifier.amount, kind: modifier.kind };
    if (out.some(one => one.amount === entry.amount && one.kind === entry.kind)) continue;
    out.push(entry);
  }
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.amount - b.amount);
}

export type PlayerViewOptions = { revealHands?: boolean };

/** The only state projection intended for a future client. No hidden IDs, RNG, or deck order. */
export function getPlayerView(state: GameState, viewer: PlayerId | null, options: PlayerViewOptions = {}) {
  requireRule(viewer === null || viewer === 0 || viewer === 1, 'INVALID_CHOICE', '视角必须为玩家 0、1 或旁观者 null。');
  const revealHands = viewer === null && options.revealHands === true;
  const visible = (id: CardId) => {
    const definition = structuredClone(getDefinition(state, id));
    const owner = state.cards[id]?.owner ?? 0;
    const p = state.players[owner];
    const field = [...p.front, ...p.energy].find(c => c.cardId === id);
    const activated = [...(definition.activated ?? []), ...(field?.grantedActivated ?? [])
      .filter(grant => grant.expiresTurn >= state.turn).flatMap(grant => grant.abilities)];
    // The online client has no authoritative state for checkAction. Project the usage budget from
    // the same per-instance / shared / pile keys the activate command consumes: a field card carries
    // `abilityUsed`, a pile card's plain 「[ターン1]」 is keyed by its card instance on the player, and
    // the named-tail `sharedLimit` budget is shared by every copy of the printed card in either zone.
    const unusedActivated = activated.flatMap((ability, index) => {
      const used = ability.sharedLimit === true && ability.oncePerTurn === true
        ? p.sharedLimitUsed?.[`a:${definition.functionalId}:${index}`]
        : field
          ? field.abilityUsed?.[index]
          : (p.hand.includes(id) ? p.handTriggeredUsed : p.sidelineTriggeredUsed)?.[`act:${id}:${index}`];
      return ability.oncePerTurn && used === state.turn ? [] : [{ index, rest: ability.rest }];
    });
    // Current values are projected separately from the printed definition so the
    // client can distinguish future effect changes without altering card art.
    // A card in hand carries the price a plain use would pay right now (hand-scoped discounts, a waiting
    // 「次に使用する」 reduction) — the same getters the engine charges from; elsewhere the printed price stands.
    const inHand = state.players[state.cards[id]?.owner ?? 0].hand.includes(id);
    const selectionTax = cardSelectionTaxes(state, id, owner, field !== undefined);
    return {
      id, definition,
      ...(activated.length && viewer === owner ? { unusedActivated } : {}),
      ...(activated.length && viewer === owner ? { activationCosts: activated.map((ability, index) => ({ index, payable: activationCostFailure(state, owner, id, ability.effects) === undefined })) } : {}),
      currentName: definition.name,
      currentApCost: inHand ? getApCost(state, id) : definition.apCost,
      currentRequiredEnergy: inHand ? requiredEnergyOf(state, id)
        : field ? effectiveRequiredEnergy(state, id)
        : structuredClone(definition.requiredEnergy),
      ...(selectionTax.length ? { selectionTax } : {}),
    };
  };
  const players = ([0, 1] as const).map(player => {
    const p = state.players[player];
    const field = (line: 'front' | 'energy') => p[line].map(c => {
      const forbids = staticForbids(state, c.cardId, player);
      const protection = cardProtection(state, c.cardId, player, forbids.sniped);
      return {
      ...visible(c.cardId), active: c.active,
      bp: getDefinition(state, c.cardId).kind === 'character' ? getBP(state, c) : null,
      underneath: c.underneath.map(visible),
      faceDown: { count: c.faceDown?.length ?? 0, ...(viewer === player ? { cards: (c.faceDown ?? []).map(visible) } : {}) },
      attacksThisTurn: c.attacksThisTurn, blocksThisTurn: c.blocksThisTurn,
      bpModifiers: structuredClone(c.bpModifiers),
      producedEnergy: getGeneratedEnergy(state, c), impact: getImpact(state, c),
      // Live DAMAGE (default 1; granted / relative / stripped all folded in) and the live keyword flags — the
      // printed `definition.keywords` alone misses every grant and every loss. STEP also reads the static
      // `canStep`, the same pair the move check accepts.
      damage: getDamage(state, c),
      keywords: liveKeywords(state, c.cardId, player),
      cannotBlockBelow: Math.max(0, ...(c.evadeModifiers ?? []).filter(m => m.expiresTurn >= state.turn).map(m => m.maxBP)),
      retireAtMainEnd: c.retireAtMainEnd === state.turn,
      limits: cardLimits(state, c, forbids),
      ...(protection ? { protection } : {}),
      ...(forbids.energyAttack ? { canAttackFromEnergy: true as const } : {}),
      // Both are "why this card does not stand up", the same story `skipsNextReady` reads.
      cannotActivateCharges: c.cannotActivateCharges ?? 0,
      cannotActivateUntilTurn: c.cannotActivateUntilTurn ?? 0,
    }; });
    return {
      player, deckCount: p.deck.length,
      // A face-up deck top is public by rule; `deckTopFaceUp` only ever names the card currently on top.
      deckTop: p.deckTopFaceUp !== undefined && p.deckTopFaceUp === p.deck[0] ? visible(p.deck[0]!) : null,
      hand: { count: p.hand.length, ...(viewer === player || revealHands ? { cards: p.hand.map(visible) } : {}) },
      // The life area's flags are positional (`PlayerState.lifeFaceUp`): which slots are face-up is
      // public, and so are the cards in them (Q2178) — the face-up slots project their card faces
      // (slot-aligned; face-down slots stay `null`).
      life: { count: p.life.length, slots: p.life.map((_, slot) => slot),
        faceUpSlots: p.life.map((_, slot) => slot).filter(slot => p.lifeFaceUp?.[slot] === true),
        faceUpCards: p.life.map((id, slot) => p.lifeFaceUp?.[slot] === true ? visible(id) : null) },
      front: field('front'), energy: field('energy'), producedEnergy: getEnergy(state, player),
      ap: [...p.ap], sideline: p.sideline.map(visible), removal: p.removal.map(visible),
      turnsStarted: p.turnsStarted,
      mulligan: p.mulligan,
    };
  });
  const pending = state.pending;
  const decision = pending === null ? null : {
    type: pending.type, player: pending.player,
    ...(pending.type === 'block' ? { mandatory: pending.mandatory === true } : {}),
    ...(pending.type === 'triggers' ? { revealed: pending.cards.map(visible) } : {}),
    ...(pending.type === 'triggers' || pending.type === 'queue' ? { effects: (pending.effects ?? []).filter(t => pending.type !== 'queue' || t.player === pending.player).map(t => ({ id: t.id, source: visible(t.sourceId) })) } : {}),
    ...(pending.type === 'triggers' && viewer === pending.player ? { triggerToGetAvailable: availableTriggerReplacements(state, pending.player, 'triggerToGetSubstitute').length > 0 } : {}),
    ...(pending.type === 'effect' && viewer === pending.player ? { choice: {
      id: pending.choiceId, kind: pending.kind, prompt: pending.prompt, min: pending.min, max: pending.max,
      // Some `cards`-kind questions offer engine control codes rather than card ids (`life:N`, `'0'/'1'`
      // — the "which destination" shapes); only ids that name a real instance get their card projected.
      options: pending.options.map(id => {
        const slot = lifeSlotCode(state, pending.player, id);
        if (slot) return { id: slot };
        const label = choiceOptionLabel(state.effect!, pending, id);
        return { id, ...(label ? { label } : {}), ...((pending.kind === 'cards' || pending.kind === 'order') && state.cards[id] !== undefined ? { card: visible(id) } : {}) };
      }),
      looked: state.effect!.held.map(visible), source: visible(state.effect!.sourceId),
      ...(state.effect!.steps[state.effect!.index]?.type === 'triggerEntryChoice' ? { effectiveTrigger: 'get' as const } : {}),
      // Set constraints on the answer: every candidate stays offerable, but a set that violates one is
      // refused where it arrives — the client can only warn about them if they are projected.
      ...(pending.distinctNames ? { distinctNames: true } : {}),
      ...(pending.sameEnergy ? { sameEnergy: true } : {}),
      ...(pending.distinctEnergy ? { distinctEnergy: true } : {}),
      ...(pending.bpSumMax !== undefined ? { bpSumMax: pending.bpSumMax } : {}),
      ...(pending.bpSumMin !== undefined ? { bpSumMin: pending.bpSumMin } : {}),
      ...(pending.energySumMin !== undefined ? { energySumMin: pending.energySumMin } : {}),
    } } : {}),
    ...(pending.type === 'discard' || pending.type === 'damage' ? { count: pending.count } : {}),
    ...(pending.type === 'damage' ? { damagedPlayer: pending.damagedPlayer } : {}),
    ...(pending.type === 'optionalReady' ? { cards: pending.cards.map(visible) } : {}),
    ...(pending.type === 'damageSubstitute' ? {
      damagedPlayer: pending.damagedPlayer, count: pending.count, reduceTo: pending.reduceTo, substituteCardId: pending.substituteCardId,
    } : {}),
    ...(pending.type === 'battleLossSubstitute' ? { cardId: pending.cardId, hand: pending.hand ?? 0 } : {}),
    ...(pending.type === 'attackTarget' ? {
      attackerId: pending.attackerId,
      cards: pending.candidates.map(visible),
      ...(pending.declared !== undefined ? { declared: pending.declared } : {}),
      snipeTax: pending.candidates.map(id => ({ id, ...(staticSnipeTax(state, id, pending.player) ?? {}) })),
    } : {}),
    // 「上限を超えた分をリムーブ」(Q997) — the line's cards are public, so the owner's answer can be
    // offered from the view alone.
    ...(pending.type === 'lineOverflow' ? { line: pending.line, cards: pending.cards.map(visible) } : {}),
    ...(pending.type === 'selectionTaxHand' ? {
      count: pending.count,
      ...(viewer === pending.player ? { cards: pending.cards.map(visible) } : {}),
    } : {}),
    // 「満线腾位」(Q1614) — the energy line is public too; the winner picks one of these for removal.
    ...(pending.type === 'energyOverflow' ? { defender: pending.defender, cards: pending.cards.map(visible) } : {}),
  };
  const hints = actionHints(state, viewer);
  const battle = state.battle === null ? null : structuredClone(state.battle);
  if (battle?.declare !== undefined) delete battle.declare;
  return {
    schemaVersion: state.schemaVersion, rulesVersion: state.rulesVersion, revision: state.revision,
    status: state.status, firstPlayer: state.firstPlayer, activePlayer: state.activePlayer,
    turn: state.turn, phase: state.phase, extraDrawUsed: state.extraDrawUsed,
    publicReveals: (state.publicReveals ?? []).map(id => ({ ...visible(id), player: state.cards[id]!.owner })),
    players, decision, battle, outcome: structuredClone(state.outcome),
    canAct: state.status !== 'finished' && viewer === (pending?.player ?? state.activePlayer),
    ...(hints ? { actionHints: hints } : {}),
  };
}

export type PlayerView = ReturnType<typeof getPlayerView>;
