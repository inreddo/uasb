import type { AbilityEvent, CardDefinition, CardEffect, CardFilter, CardId, CardInstance, Color, Condition, Energy, FieldCard, GameState, Keywords, Line, PlayerId, PlayerScope, StaticAbility, StaticModifier, TierCount, TriggeredAbility } from './types.ts';
import { COLORS } from './validation.ts';
import { hasTrait, traitName } from './traits.ts';

/** Reads a definition straight from the private catalog; never throws on a missing card. */
export function peekDefinition(state: GameState, id: CardId): CardDefinition | undefined {
  const instance: CardInstance | undefined = Object.hasOwn(state.cards, id) ? state.cards[id] : undefined;
  return instance ? state.catalog[instance.definitionId] : undefined;
}

export function locate(state: GameState, player: PlayerId, id: CardId): { line: Line; active: boolean } | undefined {
  for (const line of ['front', 'energy'] as const) {
    const card = state.players[player][line].find(c => c.cardId === id);
    if (card) return { line, active: card.active };
  }
  return undefined;
}

export const otherOf = (player: PlayerId): PlayerId => (player === 0 ? 1 : 0);

const sumOf = (energy: Energy): number => Object.values(energy).reduce((sum, n) => sum + (n ?? 0), 0);

/** The `FieldCard` for an id, or `undefined` when it is not on the field. */
const findFieldOf = (state: GameState, player: PlayerId, id: CardId) =>
  [...state.players[player].front, ...state.players[player].energy].find(card => card.cardId === id);
const resolveScope = (viewer: PlayerId, who: PlayerScope): PlayerId => (who === 'self' ? viewer : otherOf(viewer));

/** True while a resolving effect has stripped this field card of its own abilities. */
export function effectsSuppressed(state: GameState, id: CardId): boolean {
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return false;
  const located = locate(state, owner, id);
  if (!located) return false;
  const card = state.players[owner][located.line].find(c => c.cardId === id)!;
  if (card.effectsLostUntilTurn !== undefined && card.effectsLostUntilTurn >= state.turn) return true;
  // 「自分の場にこのフィールドがあるかぎり、そのキャラは元々の効果を全て失い…」 — the same suppression
  // installed as a *grant* rather than as a one-shot operation: while a live granted ability carries
  // `loseEffects`, the card's printed abilities are stripped too. Read straight off `grantedStatics` (not
  // through `ownAbilities`) so the walk cannot re-enter itself, with the same expiry, battle scope and
  // `whileSource` rules `ownAbilities` applies to every grant.
  for (const grant of card.grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
    if (grant.sourceId !== undefined) {
      const sourceOwner = state.cards[grant.sourceId]?.owner;
      const source = sourceOwner === undefined ? undefined : locate(state, sourceOwner, grant.sourceId);
      if (!source) continue;
      if (grant.sourceLine !== undefined && source.line !== grant.sourceLine) continue;
    }
    if (grant.abilities.some(ability => ability.modifiers.some(modifier => modifier.type === 'loseEffects'))) return true;
  }
  return false;
}

/** Guards against a conditional static reading the BP that depends on it. */
let evaluationDepth = 0;
const MAX_DEPTH = 6;

/**
 * Guards the group-grant broadcast against its own reflection.
 *
 * Reading a card's abilities looks at the other cards that broadcast onto it, and each of those needs its
 * own conditions evaluated — which may read *this* card's abilities again (a grant whose condition counts
 * the granted keyword is enough). The depth is the bound: past it the broadcast is skipped, which leaves
 * the abilities the card carries in its own right.
 */
let broadcastDepth = 0;

/**
 * Every static ability the card currently carries: its printed ones plus the ones an effect
 * installed on this instance.
 *
 * The two live in different places on purpose — a printed ability is part of the shared definition
 * while a grant belongs to one field card and expires — so they are merged here, at the single point
 * every reader already goes through.
 */
export function staticAbilitiesOf(state: GameState, id: CardId, controller: PlayerId): StaticAbility[] {
  const abilities = ownAbilities(state, id, controller);
  // Group grants: 「自分の場の〈X〉は「…」を得る。」 — a static the *controller's other field cards* carry
  // broadcasts onto every field card its filter accepts. Read here rather than written onto the targets,
  // so the grant follows the board: a matching card that enters later is covered, and the abilities
  // vanish with the granting card. `ownStaticsOf` (never this function) is what the broadcasters are read
  // through, so a grant can never re-broadcast — which is also what keeps the walk one level deep.
  if (broadcastDepth >= MAX_DEPTH) return abilities;
  const applied = new Set<string>();
  broadcastDepth++;
  try {
    for (const holder of [...state.players[controller].front, ...state.players[controller].energy]) {
      // Narrowed read: the scan consumes only `grantToField`, so holders carrying none of them never have
      // their conditions evaluated. The unfiltered read evaluated every 「…場合、…」 static on every field
      // card just to find grant sources (round-104 FAM-D: seed 4632 fanned out through here).
      const granted = ownStaticsOfType(state, holder.cardId, controller,
        m => m.type === 'grantToField') as Extract<StaticModifier, { type: 'grantToField' }>[];
      if (!granted.length) continue;
      const sourceName = peekDefinition(state, holder.cardId)?.name ?? holder.cardId;
      for (const modifier of granted) {
        // `granted` is the *abilities* carrying a grantToField (`wanted` keeps the ability, not the
        // modifier), so a modifier list that holds others beside the grant — an ability's own `bp` half —
        // is narrowed here: only the grant decides who receives, and only its filter has one.
        if (modifier.type !== 'grantToField') continue;
        if (!grantMatches(state, id, controller, modifier.filter, holder.cardId)) continue;
        // 「〈X〉のこの効果は重複しない。」 — a second copy of the same source applies nothing more.
        if (modifier.nonStacking && applied.has(sourceName)) continue;
        if (modifier.nonStacking) applied.add(sourceName);
        // 「…を得ない。」 covers the broadcast route too: a group grant is still a grant.
        const refused = refusedGrantTypes(state, id);
        if (refused.size) {
          for (const ability of modifier.statics) {
            const kept = ability.modifiers.filter(entry => !refused.has(entry.type));
            if (kept.length) abilities.push({ ...ability, modifiers: kept });
          }
          continue;
        }
        abilities.push(...modifier.statics);
      }
    }
    // 「自分は次の自分のターン開始時まで、「〈…〉以外の自分の場のキャラを相手が効果で選ぶ際、相手は追加で
    // 自身の手札を1枚場外に置かないと選べない。」を得る。」 — a *player-scope* grant can broadcast too: the
    // printed rule rides on the player rather than on a card, and reaches the same field group. Each
    // ability's own condition is evaluated with the card being asked about as the source, since a
    // player-scope ability has no card of its own.
    for (const grant of state.players[controller].grantedStatics ?? []) {
      if (grant.expiresTurn < state.turn) continue;
      if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
      for (const ability of grant.abilities) {
        if (ability.condition && !evalCondition(state, id, controller, ability.condition)) continue;
        for (const modifier of ability.modifiers) {
          if (modifier.type !== 'grantToField') continue;
          if (!grantMatches(state, id, controller, modifier.filter)) continue;
          abilities.push(...modifier.statics);
        }
      }
    }
  } finally {
    broadcastDepth--;
  }
  return abilities;
}

/**
 * The triggered abilities a controller's *other* field cards broadcast onto this card
 * (`StaticModifier.grantToField.triggers` — 「自分の場の赤の「〈A〉と〈B〉」全ては、「[アタック時]…」
 * を得る。」).
 *
 * The triggered sibling of the static broadcast `staticAbilitiesOf` merges: read from the broadcasters at
 * collection time rather than installed per target, so a matching card that enters later is covered and
 * the abilities vanish with the source. `ownStaticsOf` never sees the broadcasts, which is what keeps
 * the walk one level deep.
 */
export function grantedTriggersOf(state: GameState, id: CardId, controller: PlayerId): TriggeredAbility[] {
  if (broadcastDepth >= MAX_DEPTH) return [];
  const out: TriggeredAbility[] = [];
  const applied = new Set<string>();
  broadcastDepth++;
  try {
    for (const holder of [...state.players[controller].front, ...state.players[controller].energy]) {
      // Narrowed read: the scan consumes only `grantToField`, so holders carrying none of them never have
      // their conditions evaluated. The unfiltered read evaluated every 「…場合、…」 static on every field
      // card just to find grant sources (round-104 FAM-D: seed 4632 fanned out through here).
      const granted = ownStaticsOfType(state, holder.cardId, controller,
        m => m.type === 'grantToField') as Extract<StaticModifier, { type: 'grantToField' }>[];
      if (!granted.length) continue;
      const sourceName = peekDefinition(state, holder.cardId)?.name ?? holder.cardId;
      for (const modifier of granted) {
        if (!modifier.triggers?.length) continue;
        if (!grantMatches(state, id, controller, modifier.filter, holder.cardId)) continue;
        if (modifier.nonStacking && applied.has(sourceName)) continue;
        if (modifier.nonStacking) applied.add(sourceName);
        out.push(...modifier.triggers);
      }
    }
  } finally {
    broadcastDepth--;
  }
  return out;
}

/** Printed abilities plus the ones an effect installed on this instance — the card's *own*, no broadcasts. */
function ownAbilities(state: GameState, id: CardId, controller: PlayerId): StaticAbility[] {
  // 「元々の効果を失う」 takes the *printed* statics only: 「得た効果は失われない」 (Q2223), so the
  // grants installed below still ride along on a suppressed card.
  const abilities: StaticAbility[] = effectsSuppressed(state, id) ? [] : [...(peekDefinition(state, id)?.static ?? [])];
  const here = locate(state, controller, id);
  if (here) {
    const field = state.players[controller][here.line].find(c => c.cardId === id);
    const refused = refusedGrantTypes(state, id);
    for (const grant of field?.grantedStatics ?? []) {
      if (grant.expiresTurn < state.turn) continue;
      // 「アタック終了時まで」 — the grant lives only while the battle it was made in is still open.
      if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
      // 「自分のフロントLにこのキャラがあるかぎり」 — a `whileSource` grant lives exactly as long as the
      // card the printed sentence names stays on the field (and on the printed line, when it names one).
      if (grant.sourceId !== undefined) {
        const owner = state.cards[grant.sourceId]?.owner;
        const source = owner === undefined ? undefined : locate(state, owner, grant.sourceId);
        if (!source) continue;
        if (grant.sourceLine !== undefined && source.line !== grant.sourceLine) continue;
      }
      for (const ability of grant.abilities) {
        // 「「…アタックできない。」と「…ブロックできない。」と「…アタックもブロックもできない。」を得ない。」
        // — the refused abilities are dropped from every grant; the card's own printed statics above are
        // untouched, which is what tells a refusal from a self-restriction.
        if (!refused.size) { abilities.push(ability); continue; }
        const kept = ability.modifiers.filter(modifier => !refused.has(modifier.type));
        if (kept.length) abilities.push({ ...ability, modifiers: kept });
      }
    }
  }
  return abilities;
}

/** The types a card refuses to *receive* through grants (「…を得ない。」), read from its printed statics. */
function refusedGrantTypes(state: GameState, id: CardId): Set<string> {
  const refused = new Set<string>();
  for (const ability of peekDefinition(state, id)?.static ?? []) {
    for (const modifier of ability.modifiers) {
      if (modifier.type !== 'refuseGrantedAbilities') continue;
      for (const type of modifier.abilities ?? ['cannotAttack', 'cannotBlock']) refused.add(type);
    }
  }
  return refused;
}

/** Abilities whose condition is being evaluated right now, so their nested read of themselves is cut. */
let evaluatingAbilities: Set<string> | undefined;

/** The same cut for the conditions `globalEnergyDeltas` evaluates, keyed separately from the above. */
let evaluatingEnergyDeltas: Set<string> | undefined;

function liveModifiers(state: GameState, id: CardId, controller: PlayerId, abilities: StaticAbility[], wanted?: (m: StaticModifier) => boolean): StaticModifier[] {
  if (!abilities.length) return [];
  const out: StaticModifier[] = [];
  for (const [index, ability] of abilities.entries()) {
    if (wanted && !ability.modifiers.some(wanted)) continue;
    if (ability.condition) {
      if (evaluationDepth >= MAX_DEPTH) continue;
      // A condition reads the board, and board reads (`effectiveNames` / `getBP` / tier counts) come back
      // through `activeStatics`, which re-enters here for the *same* card: a tier list's condition needs
      // the card's own BP bonus, and two cards whose name conditions read each other would evaluate each
      // other's statics forever (the depth cap bounds the nesting but not the branching — every level
      // walks the field, so depth 6 is still astronomically wide). The in-progress ability contributes
      // nothing to its own nested read while every other ability still resolves: acyclic self-reads see
      // the card's other statics, and a genuine cycle is cut at the first repeated ability.
      const key = `${state.revision}:${controller}:${id}:${index}`;
      const evaluating = (evaluatingAbilities ??= new Set());
      if (evaluating.has(key)) continue;
      evaluating.add(key);
      // The counter is module-global, so a throw must not leave it raised: every later conditional
      // static on every card would read as "too deep" and silently drop its abilities.
      evaluationDepth++;
      let holds: boolean;
      try { holds = evalCondition(state, id, controller, ability.condition); } finally { evaluationDepth--; evaluating.delete(key); }
      if (!holds) continue;
    }
    for (const modifier of ability.modifiers) if (modifier.type !== 'loseEffects') out.push(modifier);
  }
  return out;
}

export function ownStaticsOf(state: GameState, id: CardId, controller: PlayerId): StaticModifier[] {
  return liveModifiers(state, id, controller, ownAbilities(state, id, controller));
}

/** The same own-modifier read, narrowed to the modifier types the caller consumes (`wanted`). */
function ownStaticsOfType(state: GameState, id: CardId, controller: PlayerId, wanted: (m: StaticModifier) => boolean): StaticModifier[] {
  return liveModifiers(state, id, controller, ownAbilities(state, id, controller), wanted);
}

/** Every static modifier whose condition currently holds (suppression is read in `ownAbilities`). */
export function activeStatics(state: GameState, id: CardId, controller: PlayerId): StaticModifier[] {
  return liveModifiers(state, id, controller, staticAbilitiesOf(state, id, controller));
}
/** The same read, narrowed to the modifier types the caller consumes (see `liveModifiers`). */
function activeStaticsOfType(state: GameState, id: CardId, controller: PlayerId, wanted: (m: StaticModifier) => boolean): StaticModifier[] {
  return liveModifiers(state, id, controller, staticAbilitiesOf(state, id, controller), wanted);
}

export function handLimitOf(state: GameState, player: PlayerId): number {
  let limit = 8;
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    for (const modifier of activeStatics(state, card.cardId, player)) if (modifier.type === 'handLimit') limit = modifier.count;
  }
  return limit;
}

/**
 * 「自分の効果で自分の手札のキャラカードのBPを参照する場合、BP+1000されたものとして扱ってもよい。」
 * (REZ-1-058/066) — the raise the reading player's statics put on a revealed hand card's BP.
 *
 * Read from the controller's field statics (058, its own state tags evaluated as the ability condition)
 * and from the statics granted to the *player* for the turn (066, installed by `grantStatic`), the two
 * homes a player-scope treatment can have. The printed 「してもよい」 is read as always-on: every use in
 * the pool widens a condition or a ceiling its controller is trying to satisfy, so the option's
 * advantageous half is the whole of what the reads need.
 */
export function handBpReferenceBonusOf(state: GameState, controller: PlayerId): number {
  let total = 0;
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[controller][line]) {
      for (const modifier of ownStaticsOf(state, slot.cardId, controller)) {
        if (modifier.type === 'handBpReferenceBonus') total += modifier.amount;
      }
    }
  }
  for (const grant of state.players[controller].grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
    for (const ability of grant.abilities) {
      for (const modifier of ability.modifiers) {
        if (modifier.type === 'handBpReferenceBonus') total += modifier.amount;
      }
    }
  }
  return total;
}

/**
 * 「自分の効果で自分の場外にあるイベントカードの枚数を参照する場合、その枚数は1枚多くあるものとして
 * 扱う。〈巴 マミ〉のこの効果は重複しない。」 (MMM-2-007) — the printed +1 for the *controller's own*
 * references to their sideline's event count.
 *
 * The named card's copies do not stack, so the bonus is summed once per distinct card identity rather
 * than once per copy. Read by both count channels (`Condition.sidelineCount` and the `sideline` tier
 * source); only plain event-card counts take it — a count the print narrows further (「青のイベント
 * カード」) names a different subject and the phantom +1 card does not answer it.
 */
function sidelineEventBonus(state: GameState, player: PlayerId): number {
  const seen = new Set<string>();
  let total = 0;
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[player][line]) {
      const definition = peekDefinition(state, slot.cardId);
      if (!definition || seen.has(definition.functionalId)) continue;
      for (const modifier of activeStatics(state, slot.cardId, player)) {
        if (modifier.type !== 'sidelineEventCountBonus') continue;
        seen.add(definition.functionalId);
        total += modifier.amount;
        break;
      }
    }
  }
  return total;
}

/**
 * 「自分の〈X〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — whether this card counts as an event
 * card *while it sits in its owner's 場外*: a carrier on that field prints the treatment for a name the
 * card carries. Every kind comparison over sideline cards honours it through this one predicate, and the
 * sideline-membership guard is inside, so no read about a card in another zone changes.
 */
export function sidelineAsEventTreated(state: GameState, id: CardId): boolean {
  const owner = state.cards[id]?.owner;
  if (owner === undefined || !state.players[owner].sideline.includes(id)) return false;
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[owner][line]) {
      for (const modifier of activeStatics(state, slot.cardId, owner)) {
        if (modifier.type !== 'sidelineAsEvent') continue;
        if (effectiveNames(state, id, owner).includes(modifier.name)) return true;
      }
    }
  }
  return false;
}

/**
 * 「自分の黄の〔〈戦慄のタツマキ〉と〈地獄のフブキ〉〕の効果に記載されている「イベントカード」を
 * 「イベントカードかキャラカード」に代えてもよい。」 (OPM-P-001) — whether the *effect's source* is one
 * of the named, colour-matching cards being rewritten by a carrier on its controller's field. Read where
 * a filter's `kind` test would otherwise reject a character card for an event-card subject.
 */
export function eventCardRewritesToCharacter(state: GameState, sourceId: CardId | undefined): boolean {
  if (sourceId === undefined) return false;
  const owner = state.cards[sourceId]?.owner;
  if (owner === undefined) return false;
  const definition = peekDefinition(state, sourceId);
  if (!definition) return false;
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[owner][line]) {
      for (const modifier of activeStatics(state, slot.cardId, owner)) {
        if (modifier.type !== 'eventCardAlsoCharacter') continue;
        if (modifier.color && !Object.hasOwn(definition.requiredEnergy, modifier.color) && !treatedAsAllColors(state, sourceId)) continue;
        if (!effectiveNames(state, sourceId, owner).some(name => modifier.names.includes(name))) continue;
        return true;
      }
    }
  }
  return false;
}

/** Whether a sideline count names exactly 「イベントカードの枚数」 — the subject `sidelineEventBonus` covers. */
function plainEventCount(count: { kind?: string; color?: Color; trait?: string; notTrait?: string; name?: string; names?: string[]; nameContains?: string; apCost?: number; hasTrait?: boolean; traits?: string[]; alsoRemoval?: boolean; other?: boolean }): boolean {
  return count.kind === 'event' && count.color === undefined && count.trait === undefined && count.notTrait === undefined
    && count.name === undefined && count.names === undefined && count.nameContains === undefined && count.apCost === undefined
    && count.hasTrait !== true && count.traits === undefined && count.alsoRemoval !== true && count.other !== true;
}

/**
 * The BP a *revealed* card answers 「BP4000以上」 / 「…のBP以下」 reads with: its printed value, the
 * `revealedAsCharacter` replacement (REZ-1-065 — while revealed from the hand it *is* a BP4000
 * character card), and the hand-BP treatment above. `undefined` when the card prints no BP at all.
 */
export function revealedBpOf(state: GameState, id: CardId, controller: PlayerId): number | undefined {
  const definition = peekDefinition(state, id);
  if (!definition) return undefined;
  const treatment = (definition.static ?? [])
    .flatMap(ability => ability.modifiers)
    .find((modifier): modifier is Extract<StaticModifier, { type: 'revealedAsCharacter' }> => modifier.type === 'revealedAsCharacter');
  const base = treatment?.bp ?? definition.bp;
  if (base === undefined) return undefined;
  return base + handBpReferenceBonusOf(state, controller);
}

/**
 * 「このカードは全ての場所で…カードとしても扱う」 (REZ-1-001/SNF-1-053 family, Q1295/Q1298) — the printed
 * treatment (`CardDefinition.alsoKinds`) answers the asked kind wherever a card's kind is read.
 */
export function answersKind(definition: CardDefinition | undefined, kind: 'character' | 'field' | 'event'): boolean {
  return definition !== undefined && (definition.kind === kind || (definition.alsoKinds ?? []).includes(kind));
}

const characterNameCache = new WeakMap<GameState['catalog'], Map<string, boolean>>();
export function characterNameInCatalog(state: GameState, name: string): boolean {
  let cache = characterNameCache.get(state.catalog);
  if (!cache) { cache = new Map(); characterNameCache.set(state.catalog, cache); }
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const found = Object.values(state.catalog).some(definition => definition.name === name && answersKind(definition, 'character'));
  cache.set(name, found);
  return found;
}

function dropsFromCharacterNameAxis(state: GameState, definition: CardDefinition, matched: string[]): boolean {
  return !answersKind(definition, 'character') && matched.length > 0
    && matched.every(name => characterNameInCatalog(state, name));
}

/** 「…としても扱う」 — whether a revealed card counts as the asked kind (REZ-1-065's character half). */
export function revealedKindOf(definition: CardDefinition, kind: 'character' | 'field' | 'event'): boolean {
  if (answersKind(definition, kind)) return true;
  if (kind !== 'character') return false;
  return (definition.static ?? []).flatMap(ability => ability.modifiers).some(modifier => modifier.type === 'revealedAsCharacter');
}

/**
 * Whether a group grant's subject accepts this card.
 *
 * Only the fields a printed group subject uses are resolved, and the compiler emits no others: everything
 * here reads the same facts `matchesFilter` does (kind, colours, traits, names — aliases included), so the
 * grant can never cover a different set than the printed subject names.
 */
function grantMatches(state: GameState, id: CardId, controller: PlayerId, filter: CardFilter, sourceId?: CardId): boolean {
  const definition = peekDefinition(state, id);
  if (!definition) return false;
  const names = effectiveNames(state, id, controller);
  if (filter.anyOf?.length && !filter.anyOf.some(sub => grantMatches(state, id, controller, sub, sourceId))) return false;
  // 「自分の場の**他の**キャラ全ては…」 — the granting card itself drops out of its own broadcast.
  if (filter.other && sourceId !== undefined && id === sourceId) return false;
  if (filter.kind && !answersKind(definition, filter.kind)) return false;
  if (filter.color && !Object.hasOwn(definition.requiredEnergy, filter.color) && !treatedAsAllColors(state, id)) return false;
  if (filter.notColor && (Object.hasOwn(definition.requiredEnergy, filter.notColor) || treatedAsAllColors(state, id))) return false;
  if (filter.trait && !hasTrait(definition, filter.trait)) return false;
  if (filter.notTrait && hasTrait(definition, filter.notTrait)) return false;
  if (filter.name && !names.includes(filter.name)) return false;
  if (filter.names && !filter.names.some(name => names.includes(name))) return false;
  if (filter.notNames?.length && names.some(name => filter.notNames!.includes(name))) return false;
  if (filter.nameContains && !names.some(name => name.includes(filter.nameContains!))) return false;
  // 「元々のBPが2500以下の自分のフロントLのキャラは、相手の効果で選ばれない。」 — the printed-BP bound
  // and the *line* of the recipient. Both are read the way `matchesFilter` reads them (the definition's
  // `bp`, the slot's line), so a broadcast group and a selection filter never disagree about one card.
  if (filter.printedBP) {
    // 「元々のBP」 with a bound: a card that prints *no* BP (a field) is never 「…以下」/「…以上」 —
    // Q2070, read here the way the used-card log already reads it.
    const bp = definition.bp;
    if (bp === undefined) return false;
    if (filter.printedBP.min !== undefined && bp < filter.printedBP.min) return false;
    if (filter.printedBP.max !== undefined && bp > filter.printedBP.max) return false;
  }
  if (filter.zone !== undefined) {
    const here = locate(state, controller, id);
    if (!here || here.line !== filter.zone) return false;
  }
  // 「〈ドーベルマン〉以外の自分の場の必要エナジーが3のキャラ全ては、BP+1000。」 (ARK-1-050) — the
  // recipient's printed requirement, read the same way every selection filter reads it, so a broadcast
  // group and a selection never disagree about one card.
  if (filter.minEnergy !== undefined || filter.maxEnergy !== undefined) {
    const total = Object.values(effectiveRequiredEnergy(state, id)).reduce((a, b) => a + (b ?? 0), 0);
    if (filter.minEnergy !== undefined && total < filter.minEnergy) return false;
    if (filter.maxEnergy !== undefined && total > filter.maxEnergy) return false;
  }
  // 「裏向きのカードが下にあるキャラ全ては…」 (BLK-1-021/090) — the recipient's own hidden stack, a
  // *slot* fact like the line above; read the way the selection and event-card filters read it so a
  // broadcast group never reaches a card the printed subject excludes.
  if (filter.underCount !== undefined) {
    const here = locate(state, controller, id);
    const slot = here ? state.players[controller][here.line].find(c => c.cardId === id) : undefined;
    const hidden = slot?.faceDown?.length ?? 0;
    if (filter.underCount.min !== undefined && hidden < filter.underCount.min) return false;
    if (filter.underCount.max !== undefined && hidden > filter.underCount.max) return false;
  }
  // 「[レイド]を持つ／持たない」 — the printed RAID ability, the same field every other reader uses.
  if (filter.raidAbility !== undefined && (definition.raid !== undefined) !== filter.raidAbility) return false;
  // 「[アタック時]/[ブロック時]を持つ」 — the printed triggered ability, read by the same helper every
  // other filter reader uses.
  if (filter.attackAbility !== undefined && printsAbility(definition, 'onAttack', state, id) !== filter.attackAbility) return false;
  if (filter.blockAbility !== undefined && printsAbility(definition, 'onBlock', state, id) !== filter.blockAbility) return false;
  // 「[ダメージ（2）]か[2回ブロック]を持つキャラ全て」 (ARK-1-099) — a game keyword the recipient must
  // carry, read through the same effective set (printed plus granted) `matchesFilter` reads, so the
  // broadcast group and a selection never disagree about one card.
  if (filter.hasKeyword !== undefined && !effectiveKeywordsFor(state, id, controller)[filter.hasKeyword]) return false;
  return true;
}

/**
 * 「手札から使用すること以外でこのカードが場外に置かれる場合、代わりにこのカードをリムーブエリアに
 * 置く。」 — whether a card bound for 場外 reaches the removal area instead.
 *
 * Read at the placements that *file* a card (a discard, a mill). The card's own use is exempt by the
 * printed 「手札から使用すること以外で」, and that route never passes through these sites.
 */
export function sidelineRedirectsToRemoval(state: GameState, id: CardId): boolean {
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return false;
  return activeStatics(state, id, owner).some(m => m.type === 'sidelineToRemoval');
}

/**
 * 「このターン中、相手の[ブロック時]…は発動しない。」 — whether `holder`'s statics silence `holder`'s
 * opponent's triggers of `event`. Read where a trigger batch is collected for that opponent.
 */
export function forbiddenTriggers(state: GameState, holder: PlayerId, event: AbilityEvent): boolean {
  return playerStatics(state, holder).some(m => m.type === 'forbidTriggers' && (m.events ?? []).includes(event));
}

/** The keyword half of the same silence: 「[インパクト無効]は発動しない」. */
export function forbiddenKeyword(state: GameState, holder: PlayerId, keyword: 'impactNegate'): boolean {
  return playerStatics(state, holder).some(m => m.type === 'forbidTriggers' && (m.keywords ?? []).includes(keyword));
}

/**
 * 「このキャラとバトルをしたキャラはこのバトル中、[インパクト無効]を失う。」 (BCV-1-004) — the battle's
 * *other participant* strips the named keyword from this card. Read where the keyword would apply, from
 * the counterpart's own statics; outside a battle there is no counterpart and nothing is stripped.
 */
export function battleOpponentStripsKeyword(state: GameState, opponentId: CardId, keyword: 'impactNegate'): boolean {
  const owner = state.cards[opponentId]?.owner;
  if (owner === undefined) return false;
  return activeStatics(state, opponentId, owner).some(m => m.type === 'battleOpponentLosesKeywords' && m.keywords.includes(keyword));
}

/**
 * Whether a card prints the named triggered ability — 「[アタック時]を持つ」 / 「[ブロック時]を持つ」.
 *
 * A definition fact, like `raidAbility`: the ability has to be printed on the card (`triggered` entries
 * carry the event), not granted to an instance by some other effect.
 *
 * Q1531/Q1540/Q1542 — a 【レイド】-fence-internal ability (its condition carries the `raidState` gate)
 * is *not held* while the card is not a raid top card: 「レイドを持つキャラがレイド状態でない場合、
 * レイドによって囲まれている部分は無効になります」. Every other condition part stays a printed fact
 * (「[アタック時]を持つ」 never asks whether the timing currently fires). When the caller has no state
 * (pure definition reads) the printed presence is answered as before.
 */
export function printsAbility(definition: CardDefinition | undefined, event: 'onAttack' | 'onBlock', state?: GameState, id?: CardId): boolean {
  const abilities = definition?.triggered?.filter(ability => ability.event === event) ?? [];
  if (!abilities.length) return false;
  if (state === undefined || id === undefined) return true;
  return abilities.some(ability => !raidFenceBlocksNow(state, id, ability.condition));
}

/** Whether `condition` carries a `raidState` gate anywhere in its tree. */
function conditionHasRaidState(condition: Condition): boolean {
  if (condition.type === 'raidState') return true;
  if (condition.type === 'all' || condition.type === 'any') return condition.conditions.some(conditionHasRaidState);
  if (condition.type === 'not') return conditionHasRaidState(condition.condition);
  return false;
}

/**
 * Whether a fence-internal ability is currently dead: its condition carries a `raidState` gate and the
 * card is not stacked as a raid top card (the same slot read `evalCondition`'s `raidState` makes).
 */
function raidFenceBlocksNow(state: GameState, id: CardId, condition: Condition | undefined): boolean {
  if (!condition || !conditionHasRaidState(condition)) return false;
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return false;
  const here = locate(state, owner, id);
  const slot = here ? state.players[owner][here.line].find(card => card.cardId === id) : undefined;
  return (slot?.underneath.length ?? 0) === 0;
}

/**
 * Whether a permission static lets this player use the card from リムーブエリア —
 * 「自分は自分のリムーブエリアの…を使用できる」.
 *
 * Read from the player's field: the permission sits on a card (usually carrying its own state tag as a
 * `StaticAbility.condition`), and it covers whichever removal card its filter accepts. The filter is
 * matched with `grantMatches`, the reader that already carries the permission phrases' vocabulary.
 */
export function removalUseAllowed(state: GameState, player: PlayerId, id: CardId): boolean {
  // 「このターン中、自分はそのカードをリムーブエリアから使用できる。」 — one effect's own removals this
  // turn (`PlayerState.removalUseForTurn`), the frame-scoped sibling of the permission statics below.
  const record = state.players[player].removalUseForTurn;
  if (record?.turn === state.turn && record.ids.includes(id)) return true;
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    for (const modifier of activeStatics(state, card.cardId, player)) {
      if (modifier.type !== 'useFromRemoval') continue;
      if (grantMatches(state, id, player, modifier.filter)) return true;
    }
  }
  return false;
}

/**
 * 「このキャラが自分の場にある場合、自分の場に〈カミナ〉は登場できない。」 — whether one of `player`'s
 * field cards forbids this card from being deployed to that field.
 *
 * A placement refusal read where a placement is attempted (a play, a RAID, an effect's deploy), from the
 * deploying player's own field — the modifier sits on the *guard* card, not on the card it excludes.
 */
export function deployForbidden(state: GameState, player: PlayerId, id: CardId): boolean {
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    if (card.cardId === id) continue;
    for (const modifier of activeStatics(state, card.cardId, player)) {
      if (modifier.type === 'forbidDeploy' && grantMatches(state, id, player, modifier.filter)) return true;
    }
  }
  return false;
}

/**
 * 「このカードが使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く。」 — whether a
 * card bound for リムーブエリア reaches the discard pile instead.
 *
 * `bySourceId` is the resolving effect's own source. The printed exemption is 「使用されること以外で」: the
 * card's own use (its own effect placing itself, as `TTG-1-040` prints) is left alone, while every other
 * effect's placement is redirected.
 */
export function removalRedirectsToSideline(state: GameState, id: CardId, bySourceId?: CardId): boolean {
  if (bySourceId !== undefined && bySourceId === id) return false;
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return false;
  return activeStatics(state, id, owner).some(m => m.type === 'removalToSideline');
}

/**
 * 「自分が「BPの範囲に指定がある効果」で…キャラを選ぶ際、指定できるBPの範囲+1000。」 — how much this
 * player's own effects widen a printed BP range when they offer a selection. Summed over the player's
 * field statics and any player-scope grants, like every other stacking modifier.
 *
 * `triggerColor` is the colour of the colour trigger whose resolution is asking, or `undefined` when this
 * selection is not a colour trigger's — a static that prints 「自分が赤の[カラートリガー]で…」 covers only
 * its own colour. The field scan is the one `playerStatics` walks for player-scope grants, except here the
 * modifier sits on a *card*.
 */
export function selectBpRangeBonus(state: GameState, player: PlayerId, triggerColor?: Color): number {
  let total = 0;
  for (const { modifiers } of fieldStatics(state, player)) {
    for (const modifier of modifiers) {
      // The discriminant and both fields it carries are read in one statement: the field-wiring audit
      // scans a window from each `=== 'selectBpRangeBonus'` occurrence, and the split `continue` form put
      // the `colorTrigger` read above the only one.
      if (modifier.type === 'selectBpRangeBonus'
        && (modifier.colorTrigger === undefined || modifier.colorTrigger === triggerColor)) total += modifier.amount;
    }
  }
  for (const modifier of playerStatics(state, player)) if (modifier.type === 'selectBpRangeBonus') total += modifier.amount;
  return total;
}

/**
 * 「…の効果でのみ選ぶことができる」 — the source filters this card's own controller allows for the
 * *opponent's* selections of it. Absent means no restriction; several copies list their filters
 * (the candidate must match one of them).
 */
export function selectableOnlyByFilters(state: GameState, id: CardId, controller: PlayerId): CardFilter[] {
  const out: CardFilter[] = [];
  for (const modifier of activeStatics(state, id, controller)) {
    if (modifier.type === 'selectableOnlyBy') out.push(modifier.source);
  }
  return out;
}

export function fieldStatics(state: GameState, player: PlayerId): { id: CardId; modifiers: StaticModifier[] }[] {
  const out: { id: CardId; modifiers: StaticModifier[] }[] = [];
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    const modifiers = activeStatics(state, card.cardId, player);
    if (modifiers.length) out.push({ id: card.cardId, modifiers });
  }
  return out;
}

/** Names the card counts as, including 〈alias〉 statics. Used by RAID and name conditions. */
export function effectiveNames(state: GameState, id: CardId, controller: PlayerId): string[] {
  const definition = peekDefinition(state, id);
  if (!definition) return [];
  // Narrowed read: this function consumes only the three name modifiers, so abilities carrying none of
  // them never have their *conditions* evaluated. The unfiltered `activeStatics` made every 「…場合、…」
  // static on the card evaluate just to answer a name lookup — and a `hasName` condition reaches back
  // into `effectiveNames` for field cards, which is the cycle round-104 FAM-D (seed 4632) blew up on.
  const statics = activeStaticsOfType(state, id, controller,
    m => m.type === 'nameOverride' || m.type === 'aliasName' || m.type === 'notAliasName');
  // 「カード名が〈X〉に変わり」 (KMR-2-095/096) — a *replacement*: the printed name drops out entirely,
  // which is what tells it apart from `aliasName` (「〈X〉としても扱う」).
  const overrides = statics.filter((m): m is Extract<StaticModifier, { type: 'nameOverride' }> => m.type === 'nameOverride');
  if (overrides.length) return [...new Set(overrides.map(m => m.name))];
  const names = [definition.name];
  const excluded: string[] = [];
  for (const modifier of statics) {
    if (modifier.type === 'aliasName' && !names.includes(modifier.name)) names.push(modifier.name);
    if (modifier.type === 'notAliasName') excluded.push(modifier.name);
  }
  return names.filter(name => !excluded.includes(name));
}

function countedUnlistedNames(definition: CardDefinition, effective: string[]): string[] {
  if (effective.includes(definition.name)) return [definition.name];
  return effective.length > 1 ? effective : [definition.name];
}

/**
 * Whether `player`'s effect selections this turn include the named card.
 *
 * The record (`PlayerState.chosenByEffectThisTurn`) is keyed by the *choosing effect's source card*,
 * so every qualifier is answered off that card's definition at evaluation time — the card may already
 * have left the field, and nothing on the board remembers who chose what.
 */
export function choseCardThisTurn(state: GameState, player: PlayerId, query: { cardId?: CardId; trait?: string; name?: string; names?: string[] }): boolean {
  if (query.cardId === undefined && query.trait === undefined && query.name === undefined && query.names === undefined) return false;
  const record = state.players[player].chosenByEffectThisTurn ?? {};
  for (const [sourceId, chosen] of Object.entries(record)) {
    if (query.cardId !== undefined && !chosen.includes(query.cardId)) continue;
    const definition = peekDefinition(state, sourceId);
    if (query.trait !== undefined && !hasTrait(definition, query.trait)) continue;
    if (query.name !== undefined && !effectiveNames(state, sourceId, state.cards[sourceId]?.owner ?? player).includes(query.name)) continue;
    if (query.names !== undefined && !query.names.some(name => effectiveNames(state, sourceId, state.cards[sourceId]?.owner ?? player).includes(name))) continue;
    return true;
  }
  return false;
}

/**
 * Whether a card matches the subject a 「…が退場した時」 watcher names.
 *
 * A deliberately narrow reader: the compiler only emits the fields the printed subject forms use
 * (〈name〉 / カード名に「X」を含む / 特徴 / 種類 / 色). The full `matchesFilter` lives in `effects.ts`,
 * which the engine core cannot import without a cycle, so anything richer stays unmapped at compile time.
 */
export function matchesEventCard(state: GameState, id: CardId, filter: CardFilter, line?: Line, listenerId?: CardId): boolean {
  const definition = peekDefinition(state, id);
  if (!definition) return false;
  // 「カード名に「イサム」か「ガルド」を含む…」 — a union of subjects, where any one alternative is
  // enough; the enclosing filter's other fields still apply on top, the same composition `matchesFilter`
  // gives the field filters.
  if (filter.anyOf?.length && !filter.anyOf.some(sub => matchesEventCard(state, id, sub, line, listenerId))) return false;
  // 「自分の場の**他の**キャラが退場した時」 — the listener's own card drops out of the subject.
  if (filter.other && listenerId !== undefined && id === listenerId) return false;
  if (filter.self && listenerId !== undefined && id !== listenerId) return false;
  // 「相手のフロントLのキャラが退場した時」 — the *line* the event card sat on. The card has left the
  // field by the time a watcher is collected, so the line is handed over by the raising call; a caller
  // that cannot name it matches nothing rather than matching the wrong line.
  if (filter.zone !== undefined && filter.zone !== line) return false;
  // 「自分の場の**レイド状態の**キャラのアタック終了時」 — the slot's stack state, read where the event
  // fires (the attacker is still on its line). The same read `CardFilter.raid` gives a selection.
  if (filter.raid !== undefined) {
    const owner = state.cards[id]?.owner;
    const here = owner === undefined ? undefined : locate(state, owner, id);
    const slot = here ? state.players[owner!][here.line].find(c => c.cardId === id) : undefined;
    if (((slot?.underneath.length ?? 0) > 0) !== filter.raid) return false;
  }
  // 「このキャラと別のラインに〈X〉が登場した時」 (GIM-2-002/023) — the event card's line against the
  // *listener's*: the print excludes the line the listening card itself sits on (and 「同じライン」 names
  // the mirror). Both cards must have a slot, which is why the listener is handed over.
  if (filter.differentLine || filter.sameLine) {
    const owner = state.cards[id]?.owner;
    const here = owner === undefined ? undefined : locate(state, owner, id);
    const listenerOwner = listenerId === undefined ? undefined : state.cards[listenerId]?.owner;
    const listenerHere = listenerId === undefined || listenerOwner === undefined ? undefined : locate(state, listenerOwner, listenerId);
    if (!here || !listenerHere) return false;
    if (filter.differentLine && here.line === listenerHere.line) return false;
    if (filter.sameLine && here.line !== listenerHere.line) return false;
  }
  // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — a watched card that has
  // reached 場外 answers event-card subjects through the treatment.
  if (filter.kind && !answersKind(definition, filter.kind) && !(filter.kind === 'event' && sidelineAsEventTreated(state, id))) return false;
  // 「自分のリムーブエリアから〈X〉が登場した時」 (KMR-2-028) — the entry's origin zone, read off the
  // slot's own `entered` record (the entered card is still on the field when the watcher is collected).
  // The same read `Condition.selectedHas.enteredFrom` makes of a bound card.
  if (filter.enteredFrom !== undefined) {
    const enteredOwner = state.cards[id]?.owner;
    const enteredHere = enteredOwner === undefined ? undefined : locate(state, enteredOwner, id);
    const entry = enteredHere ? state.players[enteredOwner!][enteredHere.line].find(c => c.cardId === id)?.entered : undefined;
    if (entry?.from !== filter.enteredFrom) return false;
  }
  if (filter.color && !Object.hasOwn(definition.requiredEnergy, filter.color) && !treatedAsAllColors(state, id)) return false;
  if (filter.trait && !hasTrait(definition, filter.trait)) return false;
  if (filter.notTrait && hasTrait(definition, filter.notTrait)) return false;
  if (filter.notColor && (Object.hasOwn(definition.requiredEnergy, filter.notColor) || treatedAsAllColors(state, id))) return false;
  if (filter.raidAbility !== undefined && (definition.raid !== undefined) !== filter.raidAbility) return false;
  // 「そのキャラの下に裏向きのカードがあり」 — a bound on the event card's own hidden stack, read the same
  // way a selection's `underCount` is read. The card is still on its line when the moment is raised.
  if (filter.underCount !== undefined) {
    const owner = state.cards[id]?.owner;
    const here = owner === undefined ? undefined : locate(state, owner, id);
    const slot = here ? state.players[owner!][here.line].find(c => c.cardId === id) : undefined;
    const n = slot?.faceDown?.length ?? 0;
    if (filter.underCount.min !== undefined && n < filter.underCount.min) return false;
    if (filter.underCount.max !== undefined && n > filter.underCount.max) return false;
}
  if (filter.attackAbility !== undefined && printsAbility(definition, 'onAttack', state, id) !== filter.attackAbility) return false;
  if (filter.blockAbility !== undefined && printsAbility(definition, 'onBlock', state, id) !== filter.blockAbility) return false;
  // 「[K]を持つキャラ」 — a game keyword on the event's own card, read from the merged set (printed plus
  // granted) so a keyword handed out by an effect counts, which is exactly what the prints watch for
  // (WBK-1-055 grants インパクト無効 and listens for characters that carry it).
  if (filter.hasKeyword !== undefined) {
    const owner = state.cards[id]?.owner;
    if (owner === undefined || !effectiveKeywordsFor(state, id, owner)[filter.hasKeyword]) return false;
  }
  if (filter.printedBP) {
    const printed = definition.bp;
    if (printed === undefined) return false;
    if (filter.printedBP.min !== undefined && printed < filter.printedBP.min) return false;
    if (filter.printedBP.max !== undefined && printed > filter.printedBP.max) return false;
  }
  // 「BP3000以下のキャラにブロックされた時」 — a BP bound on the event's own card (the blocker, still on
  // its line when the block is declared). Read as the value the table shows, exactly like `getBP`, so a
  // pumped blocker answers with its current size.
  if (filter.maxBP !== undefined || filter.minBP !== undefined) {
    const owner = state.cards[id]?.owner;
    const bp = owner === undefined ? (definition.bp ?? 0) : currentBP(state, id, owner);
    if (filter.maxBP !== undefined && bp > filter.maxBP) return false;
    if (filter.minBP !== undefined && bp < filter.minBP) return false;
  }
  // 「[ドロートリガー]を持つカード」 / 「[トリガー]を持たないカード」 — the *printed* life trigger, read from
  // the same `CardDefinition.trigger` field the trigger check itself consults. Neither form may be
  // collapsed into the other: the pool prints both in this exact position and they name disjoint sets.
  if (filter.hasTrigger !== undefined && (definition.trigger !== undefined) !== filter.hasTrigger) return false;
  if (filter.triggerType !== undefined && definition.trigger?.type !== filter.triggerType) return false;
  if (filter.name !== undefined || filter.names !== undefined || filter.nameContains !== undefined || filter.notNames !== undefined) {
    const owner = state.cards[id]?.owner ?? 0;
    const names = effectiveNames(state, id, owner);
    if (filter.name !== undefined && !names.includes(filter.name)) return false;
    if (filter.names !== undefined && !filter.names.some(name => names.includes(name))) return false;
    if (filter.nameContains !== undefined && !names.some(name => name.includes(filter.nameContains!))) return false;
    if (filter.notNames !== undefined && names.some(name => filter.notNames!.includes(name))) return false;
  }
  return true;
}

export function staticEnergyBonus(state: GameState, id: CardId, controller: PlayerId): Energy {
  const bonus: Energy = {};
  for (const modifier of activeStatics(state, id, controller)) {
    if (modifier.type === 'energy') for (const color of COLORS) bonus[color] = (bonus[color] ?? 0) + (modifier.energy[color] ?? 0);
    // 「このカードの下の裏向きのカード1枚につき、このカードの発生エナジー+[緑]」 — a per-count energy
    // bonus, evaluated where the energy is read so it tracks the hidden stack as it changes.
    else if (modifier.type === 'energyPer') {
      const times = tierCountOf(state, controller, id, modifier.count);
      for (const color of COLORS) bonus[color] = (bonus[color] ?? 0) + (modifier.energy[color] ?? 0) * times;
    }
  }
  return bonus;
}

/**
 * Whether the effect whose source is `sourceId` is a *life card's own trigger* being resolved —
 * 「相手のトリガーの効果で」.
 *
 * A trigger effect is identified by the **resolving frame's route**, not by the source card merely
 * having a printed `trigger` and being off the field: a card raided/deployed by a trigger then resolves
 * its own [登場時] as a card effect (the default character/event route), and a SPECIAL event used from
 * hand is likewise not a trigger. `resolveTrigger`'s inline/SPECIAL tasks carry `route:'trigger'`.
 *
 * The two consumer sites now read `route` directly; this helper remains the shared definition for
 * future readers and tests. It is true only while a trigger-route frame is resolving for this source.
 */
export function isTriggerResolution(state: GameState, sourceId: CardId, player: PlayerId): boolean {
  const frame = state.effect;
  return frame !== undefined && frame.route === 'trigger' && frame.sourceId === sourceId && frame.player === player;
}

export function staticKeywords(state: GameState, id: CardId, controller: PlayerId): Keywords {
  const keywords: Keywords = {};
  for (const modifier of activeStatics(state, id, controller)) if (modifier.type === 'keywords') Object.assign(keywords, modifier.keywords);
  return keywords;
}

/**
 * 「相手の場のキャラ全ては、「[ステップ]、[狙い撃ち]、…」を全て失う。」 — the keywords the *other* side's
 * statics strip from this card.
 *
 * Read from the opposing field rather than installed on each target, so the strip follows the board: a
 * card that enters later is covered and the strip lapses with its source. The printed line, when one is
 * named, is matched against where the card sits now.
 */
export function strippedKeywords(state: GameState, id: CardId, controller: PlayerId): Keywords {
  const out: Keywords = {};
  const other = otherOf(controller);
  const line = locate(state, controller, id)?.line;
  for (const card of [...state.players[other].front, ...state.players[other].energy]) {
    for (const modifier of activeStatics(state, card.cardId, other)) {
      if (modifier.type !== 'stripKeywords') continue;
      if (modifier.line !== undefined && modifier.line !== line) continue;
      Object.assign(out, modifier.keywords);
    }
  }
  return out;
}

export function staticBp(state: GameState, id: CardId, controller: PlayerId): number {
  let total = 0;
  for (const modifier of activeStatics(state, id, controller)) {
    if (modifier.type === 'bp') total += modifier.amount;
    // A per-count bonus is evaluated here, where the BP is read, so it tracks the count as it changes.
    else if (modifier.type === 'bpPer') total += tierCountOf(state, controller, id, modifier.count) * modifier.amount;
  }
  return total;
}

/**
 * The value of a `TierCount` for one card, against the authoritative state.
 *
 * Shared by `effects.ts` (which reads it inside a resolving frame) and `staticBp` (which reads it
 * outside one), so a tier list and a 「N枚につき」 bonus can never disagree about the same count.
 */
/**
 * The required-energy signature a card is *read* with by every count and filter.
 *
 * 「場にあるこのカードは必要エナジーを[黄×3]としても扱う」 replaces the printed signature while the
 * card sits on the field, so a 「必要エナジーが3のキャラ」 count and a 「必要エナジーが3以下」 filter
 * both see the replacement — which is the whole point of the line. Off the field (or without the
 * modifier) the printed symbols answer, exactly what every reader used before.
 */
/**
 * 「公開したN枚のカードの必要エナジーの数が全て同じか、連続するNつの数だった場合」 (SYN-1-062, Q782) —
 * the card set's *effective* requirement totals are all equal, or exactly N consecutive numbers (each
 * one apart by 1, so 「0・1・2」 and 「2・3・4」 both qualify and a duplicate pair does not).
 */
export function energyRunHolds(state: GameState, ids: CardId[], count: number): boolean {
  if (ids.length !== count) return false;
  const totals: number[] = [];
  for (const id of ids) {
    if (!peekDefinition(state, id)) return false;
    const energy = effectiveRequiredEnergy(state, id);
    totals.push(Object.values(energy).reduce((sum, value) => sum + (value ?? 0), 0));
  }
  const unique = [...new Set(totals)].sort((a, b) => a - b);
  if (unique.length === 1) return true;
  return unique.length === count && unique.every((value, index) => index === 0 || value === unique[index - 1]! + 1);
}

/**
 * Whether the card occupies one of the two positions 「自分の場とレイド元のこのカード」 names: a slot of
 * the owner's field, or the レイド元 stack beneath one. The scan mirrors `zone-presence`'s `zoneOfCard`
 * without importing the effects module (the one-way dependency the two files keep).
 */
function onFieldOrRaidSource(state: GameState, id: CardId, owner: PlayerId): boolean {
  if (locate(state, owner, id)) return true;
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[owner][line]) {
      if (slot.underneath.includes(id)) return true;
    }
  }
  return false;
}

type EnergyReadPosition = { hand: boolean; sideline: boolean };

/** Where the card actually sits right now, for the zone gate below. */
function zonePositionOf(state: GameState, id: CardId, owner: PlayerId): EnergyReadPosition {
  return { hand: state.players[owner].hand.includes(id), sideline: state.players[owner].sideline.includes(id) };
}

function deltaScopeHolds(scope: 'hand' | 'sideline' | 'handOrSideline' | undefined, position: EnergyReadPosition): boolean {
  if (scope === 'hand') return position.hand;
  if (scope === 'sideline') return position.sideline;
  if (scope === 'handOrSideline') return position.hand || position.sideline;
  return true;
}

export function effectiveRequiredEnergy(state: GameState, id: CardId): Energy {
  return requiredEnergyReading(state, id);
}

function requiredEnergyReading(state: GameState, id: CardId, position?: EnergyReadPosition): Energy {
  const definition = peekDefinition(state, id);
  if (!definition) return {};
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return { ...definition.requiredEnergy };
  const here = locate(state, owner, id);
  const statics = activeStaticsOfType(state, id, owner, m => m.type === 'energyCostSetAll' || (here !== undefined && m.type === 'energyCostSetOnField'));
  const override = statics.find(
    (m): m is Extract<StaticModifier, { type: 'energyCostSetAll' }> => m.type === 'energyCostSetAll',
  ) ?? statics.find(
    (m): m is Extract<StaticModifier, { type: 'energyCostSetOnField' }> => m.type === 'energyCostSetOnField',
  );
  // 「自分の効果で場外に置くこのカードの必要エナジーは[青×3]としても扱う。」 (KMR-2-026) — the sideline
  // scope of the same replacement family, read only while the card actually sits in its owner's 場外.
  // The modifier is the card's own printed static, so `ownStaticsOf` is the whole read (the same
  // narrower reader `energyCostDeltaOnField` uses, and for the same reason: no broadcast grants exist).
  const sidelineOverride = !override && state.players[owner].sideline.includes(id)
    ? ownStaticsOf(state, id, owner).find((m): m is Extract<StaticModifier, { type: 'energyCostSetInSideline' }> => m.type === 'energyCostSetInSideline')
    : undefined;
  const effective = override ?? sidelineOverride;
  return withEnergySignatureDeltas(state, id, owner, effective ? { ...effective.energy } : { ...definition.requiredEnergy }, position);
}

export type EnergyCostRaise = { amount: number; expiresTurn: number };
type PersistentEnergyCostLedger = CardInstance & { energyCostModifiers?: EnergyCostRaise[] };

/** The raise record kept on the card instance (empty when the effect never placed one). */
export function instanceEnergyCostModifiers(state: GameState, id: CardId): EnergyCostRaise[] {
  return (state.cards[id] as PersistentEnergyCostLedger | undefined)?.energyCostModifiers ?? [];
}

/** The card instance's raise record, created on first write (`energyCostUp`). */
export function persistentEnergyCostModifiers(state: GameState, id: CardId): EnergyCostRaise[] {
  return ((state.cards[id] as PersistentEnergyCostLedger).energyCostModifiers ??= []);
}

export type RetiredEnergyBroadcast = { amount: number; turn: number };
type RetirementBroadcastLedger = CardInstance & { retiredEnergyBroadcast?: RetiredEnergyBroadcast };

/** The colourless raise the controller's *other* field cards broadcast onto `id`'s requirement. */
function broadcastEnergyCostRaise(state: GameState, id: CardId, owner: PlayerId): number {
  let total = 0;
  for (const slot of [...state.players[owner].front, ...state.players[owner].energy]) {
    if (slot.cardId === id) continue;
    for (const modifier of ownStaticsOf(state, slot.cardId, owner)) {
      if (modifier.type === 'energyCostDeltaForOthers') total += modifier.amount;
    }
  }
  return total;
}

/**
 * Writes the exit-instant broadcast snapshot. Called from `leaveField` while the card still sits on its
 * line, which is the only state the broadcast is readable in; an exit with no broadcast raise clears an
 * older record so a later retirement cannot inherit one.
 */
export function recordRetiredEnergyBroadcast(state: GameState, id: CardId): void {
  const owner = state.cards[id]?.owner;
  const instance = state.cards[id] as RetirementBroadcastLedger | undefined;
  if (owner === undefined || instance === undefined) return;
  const amount = broadcastEnergyCostRaise(state, id, owner);
  if (amount > 0) instance.retiredEnergyBroadcast = { amount, turn: state.turn };
  else delete instance.retiredEnergyBroadcast;
}

/** The retirement-time required-energy total: the live reading plus the exit-instant broadcast snapshot. */
export function retiredRequiredEnergyTotal(state: GameState, id: CardId): number {
  let total = Object.values(effectiveRequiredEnergy(state, id)).reduce((sum, n) => sum + (n ?? 0), 0);
  const record = (state.cards[id] as RetirementBroadcastLedger | undefined)?.retiredEnergyBroadcast;
  if (record !== undefined && record.turn === state.turn) total += record.amount;
  return total;
}

/**
 * Applies every signature-level delta layer to one required-energy reading.
 *
 * Split out of `effectiveRequiredEnergy` so the dual-value reader below can put the same layers on the
 * printed signature and on each alternate 「…としても扱う」 signature — a discount or raise printed beside
 * a set line must land on every reading equally, or the variants would disagree about the same card's
 * other statics. `result` is the base signature the layers modify; the caller owns the copy.
 */
function withEnergySignatureDeltas(state: GameState, id: CardId, owner: PlayerId, result: Energy, position: EnergyReadPosition = zonePositionOf(state, id, owner)): Energy {
  // 「…場合、自分の場とレイド元のこのカードの必要エナジーを[赤×N]減らす。」 (MGS-1-078〜082) — the
  // self-reduction scoped to the two printed positions: a slot of the owner's field, or the レイド元 stack
  // beneath one (`effectiveRequiredEnergy` is also reached for cards in hand or in the discard pile, which
  // the print does not cover — the gate is what keeps those reads at the printed signatures).
  if (onFieldOrRaidSource(state, id, owner)) {
    for (const modifier of ownStaticsOf(state, id, owner)) {
      if (modifier.type === 'energyCostDeltaOnField') {
        result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
        continue;
      }
      // 「…N枚につき…[色×M]減らす」 on the field: of that family only the unqualified 「全ての場所で」
      // spelling reaches the field — the qualified ones exclude it by their own words, so a field-side
      // read (a count filter asking this card's requirement) applies just this one.
      if (modifier.type === 'energyCostDeltaPer' && modifier.scope === 'allPlaces') {
        const units = Math.floor(tierCountOf(state, owner, id, modifier.count) / modifier.per);
        if (units > 0) result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount * units);
      }
    }
  } else {
    // 「場外にあるこのカードの必要エナジーを[黄×2]減らす。」 (ARK-1-007) — a plain `energyCostDelta` is
    // this card's own static and applies wherever a requirement is *read* while the card is off the
    // field (Q1217/Q1219: the sideline card is fetched at requirement 0). `handStaticsOf` is the same
    // source `requiredEnergyOf` reads for the play cost, and returns nothing on the field — so the two
    // sides can never double-apply the same discount.
    for (const modifier of handStaticsOf(state, id)) {
      if (modifier.type === 'energyCostDelta') {
        if (!deltaScopeHolds(modifier.scope, position)) continue;
        result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
        continue;
      }
      // The per-count reduction reads its count from the same side: Q481's 「手札から登場させる」 effect
      // asks this reader for the reduced value, so a discount that exists while the card is off the field
      // must land here too. The printed zone qualifier gates it — 「手札にある」 requires the hand,
      // 「場と場外以外の全ての場所で」 refuses the sideline; the field-excluding spellings are off the
      // field here by construction.
      if (modifier.type === 'energyCostDeltaPer') {
        if (modifier.scope === 'hand' && !position.hand) continue;
        if (modifier.scope === 'notFieldNotSideline' && position.sideline) continue;
        const units = Math.floor(tierCountOf(state, owner, id, modifier.count) / modifier.per);
        if (units > 0) result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount * units);
      }
    }
  }
  // 「自分の全ての場所にある全ての〈X〉の必要エナジーを[色]減らす」 — the cross-zone discount, applied
  // wherever a requirement is *read* (this reader answers the field/count side; `requiredEnergyOf`
  // answers the play-cost side from the same modifiers).
  for (const modifier of globalEnergyDeltas(state, id)) {
    result[modifier.color] = Math.max(0, (result[modifier.color] ?? 0) + modifier.amount);
  }
  const raisedSlot = owner !== undefined ? findFieldOf(state, owner, id) : undefined;
  const instanceRaises = instanceEnergyCostModifiers(state, id);
  for (const modifier of instanceRaises.length ? instanceRaises : raisedSlot?.energyCostModifiers ?? []) {
    if (modifier.expiresTurn >= state.turn) result.any = (result.any ?? 0) + modifier.amount;
  }
  // 「自分の場の他のキャラ全ての必要エナジーを2増やす。」 (BLC-4-012) — the colourless raise broadcast
  // from the controller's *other* field cards. Read straight off the field: the holders' conditions are
  // state tags (turn / line), not requirement counts, so this walk cannot re-enter the way the
  // `EVA-1-031` fan-out did (`energyCostDeltaOnField`'s note above records that incident).
  if (raisedSlot) {
    const broadcast = broadcastEnergyCostRaise(state, id, owner!);
    if (broadcast !== 0) result.any = (result.any ?? 0) + broadcast;
  }
  // 「自分の山札にある紫のカードの必要エナジーを1減らす。」 (MMM-2-017) — the deck-scoped colourless
  // reduction: read while the card sits in its owner's deck, broadcast from the owner's field. The
  // holders' conditions are state tags like the raise above, so this walk cannot re-enter.
  if (owner !== undefined && state.players[owner].deck.includes(id)) {
    for (const slot of [...state.players[owner].front, ...state.players[owner].energy]) {
      for (const modifier of ownStaticsOf(state, slot.cardId, owner)) {
        if (modifier.type !== 'deckEnergyCostDelta') continue;
        if (Object.keys(modifier.filter).length && !grantMatches(state, id, owner, modifier.filter, slot.cardId)) continue;
        // A colourless *reduction* comes off the printed symbols — the largest share first — because the
        // requirement is paid per colour and a colourless share could never be spent (the `'any'` key is
        // a count-only channel; raising into it is the increase's business). A single-colour deck card
        // loses one symbol of its own colour, which is what 「必要エナジーを1減らす」 means for counts.
        let remaining = Math.abs(modifier.amount);
        const entries = (Object.entries(result) as [string, number | undefined][])
          .filter(([key, n]) => key !== 'any' && (n ?? 0) > 0)
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
        for (const [key] of entries) {
          if (remaining <= 0) break;
          const current = result[key as Color] ?? 0;
          const take = Math.min(current, remaining);
          result[key as Color] = current - take;
          remaining -= take;
        }
      }
    }
  }
  return result;
}

/**
 * The 「必要エナジーを…としても扱う」 alternate signatures the card carries *in its current position*.
 *
 * Q805–Q809 answer the wording for 「全ての場所で」: 「元々の必要エナジーの数と青×5の**どちらとしても**
 * 扱う」 — the printed signature is not replaced, the two readings stand side by side. The three
 * `energyCostSet*` kinds each print a position, and the alternate is applicable only there:
 *  - `energyCostSetAll` 「全ての場所で…としても扱う」 — every position, no gate;
 *  - `energyCostSetOnField` 「場にあるこのカードは…としても扱う」 — while the card sits on one of its
 *    owner's lines (Q1126 「自分の場で必要エナジーを参照する際」);
 *  - `energyCostSetInSideline` 「自分の効果で場外に置くこのカードの…」 — while the card sits in its
 *    owner's 場外 (the gate `effectiveRequiredEnergy` applies to this scope too).
 * A replacement-only 「…として扱ってもよい」 (`energyCostSet`, the deck/play-cost scope) is a different
 * spelling with its own readers (`requiredEnergyOf`, `revealedHas`) and is not one of these readings.
 *
 * The statics are read through the same readers `effectiveRequiredEnergy` uses (broadcast grants included
 * where the single reader honours them), so an alternate cannot appear from a static that reader ignores.
 */
function energySignatureAlternates(state: GameState, id: CardId, owner: PlayerId): Energy[] {
  const out: Energy[] = [];
  // 「全ての場所で…としても扱う」 — no position qualifier: every zone reads the alternate.
  for (const modifier of activeStaticsOfType(state, id, owner, m => m.type === 'energyCostSetAll')) {
    if (modifier.type === 'energyCostSetAll') out.push({ ...modifier.energy });
  }
  // 「場にあるこのカードは…としても扱う」 — Q1126 names 自分の場 as the scope of the reference read.
  if (locate(state, owner, id)) {
    for (const modifier of activeStaticsOfType(state, id, owner, m => m.type === 'energyCostSetOnField')) {
      if (modifier.type === 'energyCostSetOnField') out.push({ ...modifier.energy });
    }
  }
  // 「自分の効果で場外に置くこのカードの…」 — the card's own printed static, read only in its 場外.
  if (state.players[owner].sideline.includes(id)) {
    for (const modifier of ownStaticsOf(state, id, owner)) {
      if (modifier.type === 'energyCostSetInSideline') out.push({ ...modifier.energy });
    }
  }
  return out;
}

/** The comparison key the variant de-duplication uses: colour × count, zero rows dropped, colours sorted. */
function energyVariantKey(energy: Energy): string {
  return Object.entries(energy)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([color, n]) => `${color}${n ?? 0}`)
    .join(',');
}

/**
 * The required-energy readings a *selection filter* may match: the printed signature **and** each
 * alternate 「必要エナジーを…としても扱う」 signature applicable in the card's current position.
 *
 * 「…としても扱う」 is a dual reading (Q805–Q809 / Q1126: 「元々の必要エナジーの数と…のどちらとしても
 * 扱う」), so a bound such as 「必要エナジーが0」 must admit a card whose *other* reading satisfies it —
 * KMR-2-026 in 場外 is the round-167 case (printed blue-0, alternate blue×3). Counts and sums deliberately
 * keep the single `effectiveRequiredEnergy` value (this round's G-scope: `fieldEnergySum`,
 * `sidelineEnergyVariety`, `energyRunHolds` are unchanged); only the selection filter's min/max bounds
 * read these variants.
 *
 * Every alternate gets the same delta layers as the printed one (a discount or raise printed on the card
 * applies to the requirement whichever reading is used), and duplicate signatures collapse to one. The
 * printed signature is always first. `owner` is the player the statics are read against (the card's
 * controller — the caller has it, and a hidden card's own state record may not).
 */
export function effectiveRequiredEnergyVariants(state: GameState, id: CardId, owner: PlayerId): Energy[] {
  const definition = peekDefinition(state, id);
  if (!definition) return [];
  const variants: Energy[] = [];
  const seen = new Set<string>();
  for (const base of [{ ...definition.requiredEnergy }, ...energySignatureAlternates(state, id, owner)]) {
    const variant = withEnergySignatureDeltas(state, id, owner, base);
    const key = energyVariantKey(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(variant);
  }
  return variants;
}

function revealSideIsDeck(state: GameState, id: CardId, ctx: ConditionContext | undefined, self = false): boolean {
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return false;
  if (locate(state, owner, id)) return false;
  const from = self ? undefined : ctx?.revealedFrom;
  if (from !== undefined) return from === 'deck' || from === 'deckBottom';
  const p = state.players[owner];
  return p.deck.includes(id)
    || (!p.hand.includes(id) && !p.sideline.includes(id) && !p.removal.includes(id) && !p.life.includes(id));
}

function revealedRequiredEnergyTotal(state: GameState, id: CardId): number {
  return sumOf(requiredEnergyReading(state, id, { hand: false, sideline: false }));
}

export function printedEnergyTotal(definition: CardDefinition): number {
  return Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
}

function revealedApCost(state: GameState, id: CardId, deckSide: boolean): number {
  const definition = peekDefinition(state, id);
  if (!definition) return 0;
  // `handStaticsOf` already refuses a card that sits on a line, so the deck-scoped set only appears for
  // an off-field card; the reveal-time position gate is what keeps it to the deck side.
  const set = handStaticsOf(state, id).find((m): m is Extract<StaticModifier, { type: 'apCostSet' }> => m.type === 'apCostSet');
  if (!set) return definition.apCost;
  return deckSide ? set.amount : definition.apCost;
}

/**
 * 「自分の全ての場所にある全ての〈X〉の必要エナジーを[色]減らす」 — the discounts a field card
 * broadcasts over every card its controller owns.
 *
 * The subject's own zones are all of the controller's (field, hand, deck, discard pile), so the read
 * starts from the field the broadcaster sits on and matches the *target* card's definition; the card
 * may be anywhere, including the deck. The filter vocabulary is the same definition-based subset
 * `definitionMatchesSubset` reads, so a subject the reader cannot carry is refused at compile time rather
 * than read wider here.
 */
export function globalEnergyDeltas(state: GameState, id: CardId): Extract<StaticModifier, { type: 'globalEnergyCostDelta' }>[] {
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return [];
  const out: Extract<StaticModifier, { type: 'globalEnergyCostDelta' }>[] = [];
  for (const line of ['front', 'energy'] as const) {
    for (const slot of state.players[owner][line]) {
      for (const [index, ability] of (peekDefinition(state, slot.cardId)?.static ?? []).entries()) {
        // An ability with no broadcast modifier contributes nothing here whatever its condition says,
        // so the condition is not evaluated at all (the same pre-filter `liveModifiers` applies).
        if (!ability.modifiers.some(m => m.type === 'globalEnergyCostDelta')) continue;
        if (ability.condition) {
          if (evaluationDepth >= MAX_DEPTH) continue;
          // Same re-entrancy cut as `liveModifiers`: this reader is itself reachable from a condition's
          // board read (`effectiveRequiredEnergy` ← a required-energy count/filter), so a broadcaster
          // whose condition asks for a requirement — 「必要エナジーが3のキャラが3枚以上ある場合」 style
          // — re-enters here for the same broadcaster and recursed without end (KJ8-1-012/018, caught by
          // the round-55 full run). The in-progress ability contributes nothing to its own nested read.
          const key = `${state.revision}:${slot.cardId}:${index}:energyDelta`;
          const evaluating = (evaluatingEnergyDeltas ??= new Set());
          if (evaluating.has(key)) continue;
          evaluating.add(key);
          evaluationDepth++;
          let holds: boolean;
          try { holds = evalCondition(state, slot.cardId, owner, ability.condition); } finally { evaluationDepth--; evaluating.delete(key); }
          if (!holds) continue;
        }
        for (const modifier of ability.modifiers) {
          if (modifier.type !== 'globalEnergyCostDelta') continue;
          if (!definitionMatchesSubset(state, id, owner, modifier.filter)) continue;
          out.push(modifier);
        }
      }
    }
  }
  return out;
}

/**
 * 「自分の効果で［特徴：X］を数える場合、このキャラは2枚分として扱ってもよい。」 — extra weight for a
 * counted card: while the card's own controller is the player doing the counting and the count names the
 * printed trait, the card contributes one more than its slot. Read beside both counting paths (`TierCount`
 * and `Condition.fieldCount`) so a per-count bonus and a threshold gate never disagree about one card.
 */
function countWeightBonus(state: GameState, card: FieldCard, countingPlayer: PlayerId, countedTraits: (string | undefined)[]): number {
  const definition = peekDefinition(state, card.cardId);
  if (!definition) return 0;
  const owner = state.cards[card.cardId]?.owner;
  if (owner === undefined || owner !== countingPlayer) return 0;
  let bonus = 0;
  for (const modifier of activeStaticsOfType(state, card.cardId, owner, m => m.type === 'countsAsMultiple')) {
    if (modifier.type !== 'countsAsMultiple') continue;
    if (!countedTraits.includes(modifier.trait)) continue;
    if (!hasTrait(definition, modifier.trait)) continue;
    bonus += modifier.count - 1;
  }
  return bonus;
}

export function tierCountOf(state: GameState, controller: PlayerId, sourceId: CardId, count: TierCount, departedLine?: Line): number {
  // The frame-scoped sources carry no `who` (and no state-only answer); `restedEnergySum` lands in the
  // same branch so the reader's `who` is never asked of a source that does not have one. `sum` carries no
  // `who` of its own — its parts each name their own scope — and `gated` wraps another source, so both
  // re-enter rather than reading `who` themselves.
  const who = resolveScope(controller, count.source === 'boundPrintedEnergy' || count.source === 'underCount' || count.source === 'eventsUsedThisTurn' || count.source === 'restedEnergySum' || count.source === 'restedByThisEffect' || count.source === 'discardedByThisEffect' || count.source === 'removedByThisEffect' || count.source === 'retiredByThisEffect' || count.source === 'discardedEnergySum' || count.source === 'retiredEnergySum' || count.source === 'sum' || count.source === 'turnEventRetired' || count.source === 'selfMovedThisTurn' || count.source === 'selfAttackedThisTurn' || count.source === 'handDiscardedThisTurn' || count.source === 'gated' || count.source === 'selectedCount' || count.source === 'selectedDamageBonus' || count.source === 'perUnit' || count.source === 'revealedEnergy' ? 'self' : count.who);

  switch (count.source) {
    case 'triggerKinds': {
      const kinds = new Set<string>();
      for (const id of state.players[who].sideline) {
        if (count.other && id === sourceId) continue;
        const definition = peekDefinition(state, id);
        if (!definition || (!answersKind(definition, 'event') && !sidelineAsEventTreated(state, id))) continue;
        if (!Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(state, id)) continue;
        const total = Object.values(effectiveRequiredEnergy(state, id)).reduce((sum, n) => sum + (n ?? 0), 0);
        if (total <= count.maxEnergy && definition.trigger) kinds.add(definition.trigger.type);
      }
      return kinds.size;
    }
    // 「…N枚につき」 — the unit division wraps another count, so both the scope and the value come from the
    // inner source; re-entering with that source answers both.
    case 'perUnit': return Math.floor(tierCountOf(state, who, sourceId, count.count, departedLine) / count.per);
    // 「自分のアクティブのAPカードの枚数分」 — the AP row is a fixed triple of slot states, not a zone of
    // cards, so the count walks it directly.
    case 'apCount':
      return state.players[resolveScope(controller, count.who)].ap.filter(slot => slot === count.state).length;
    // 「この効果で場外に置いたカードの必要エナジーの数」 — a frame fact: outside a resolving effect there
    // is no "this effect", so the state-only reader answers 0 and `effects.ts#tierCount` is authoritative.
    case 'discardedEnergySum':
      return 0;
    // 「退場させたキャラの必要エナジーの数」 — the same frame-scoped reading over the retirement records.
    case 'retiredEnergySum':
      return 0;
    // 「公開したカードの必要エナジーの数」 (MMM-2-016 / CGD-1-069) — the reveal record lives on the
    // resolving frame, so the state-only reader has no count to give. Unlike the frame-scoped sums
    // above, 0 would falsely satisfy every 「N以下」 band: the absent count answers -1, below every
    // floor, and `effects.ts#tierCount` is authoritative while a frame is open.
    case 'revealedEnergy':
      return -1;
    case 'turnEventRetired': {
      // 「このターン中に退場したキャラ」 — the log records each retirement with the card; the kind is read
      // from that card's definition. `who` absent counts both players, which the wording that names no
      // owner means.
      const scope = count.who === undefined ? undefined : resolveScope(controller, count.who);
      return (state.turnEvents ?? []).filter(entry =>
        entry.event === 'retired'
        && (scope === undefined || entry.player === scope)
        && entry.cardId !== undefined
        && peekDefinition(state, entry.cardId)?.kind === 'character').length;
    }
    // 「このターン中にこのキャラが移動した回数1回につき」 — the same log's `moved` entries, read by the
    // effect source's identity. The same relation `Condition.turnEvent`'s `self: true` reads.
    case 'selfMovedThisTurn':
      return (state.turnEvents ?? []).filter(entry => entry.event === 'moved' && entry.cardId === sourceId).length;
    // 「このターン中にこのキャラがアタックした回数」 — the same reading over the `attacked` entries.
    case 'selfAttackedThisTurn':
      return (state.turnEvents ?? []).filter(entry => entry.event === 'attacked' && entry.cardId === sourceId).length;
    // 「このターン中に自分の効果で場外に置いた自分の手札の合計枚数」 — the log's hand→場外 entries for
    // the controller; `ownEffect` narrows to its own effects, the same relation `Condition.turnEvent`
    // reads for 「自分の効果で…置いている」.
    case 'handDiscardedThisTurn':
      return (state.turnEvents ?? []).filter(entry =>
        entry.event === 'discardedFromHand'
        && entry.player === controller
        && (count.ownEffect !== true || entry.causeOwner === controller)).length;
    // 「このターン中に自分のキャラがレイドした回数」 — the log's raid entries, the count form of the
    // 「レイドしている」 gate. `who` absent counts both sides, which a wording naming no owner means.
    case 'raidCountThisTurn': {
      const scope = count.who === undefined ? undefined : resolveScope(controller, count.who);
      return (state.turnEvents ?? []).filter(entry =>
        entry.event === 'entered' && entry.raid === true
        && (scope === undefined || entry.player === scope)).length;
    }
    // 「自分の場外にあるカードの必要エナジーの数の種類」 (TKG-1-042) — distinct printed requirement
    // totals across the named zones, the energy-axis sibling of `distinctNames`.
    case 'distinctEnergyValues': {
      const zones: ('field' | 'sideline')[] = count.zone === 'field' ? ['field'] : count.zone === 'sideline' ? ['sideline'] : ['field', 'sideline'];
      const totals = new Set<number>();
      const pool = zones.flatMap(zone => zone === 'sideline'
        ? state.players[who].sideline
        : [...state.players[who].front, ...state.players[who].energy].map(card => card.cardId));
      for (const id of pool) {
        const definition = peekDefinition(state, id);
        if (!definition) continue;
        totals.add(Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0));
      }
      return totals.size;
    }
    // 「この効果で選んだキャラの枚数」 — a frame fact: outside a resolving effect there is no "this
    // effect", so the state-only reader answers 0 and `effects.ts#tierCount` is authoritative.
    case 'selectedCount':
      return 0;
    // 「選んだ〈チェン〉と同じ数の[ダメージ（+1）]」 (ARK-2-051) — a frame fact over the bound cards'
    // damage-bonus layers, so the state-only reader answers 0 and `effects.ts#tierCount` is authoritative.
    case 'selectedDamageBonus':
      return 0;
    // 「登場かレイドさせたキャラの元々の必要エナジー」 — the same frame-scoped channel: the binding
    // only exists while the effect resolves.
    case 'boundPrintedEnergy':
      return 0;
    // 「自分の場に〈X〉がある場合、…1枚につき…」 — the wrapped count reads zero while the printed
    // condition fails. The condition is a state predicate (no resolution context required); the
    // frame-scoped predicates would be meaningless here and answer false, which is the safe reading.
    case 'gated':
      return evalCondition(state, sourceId, controller, count.condition, departedLine === undefined ? undefined : { departedLine }) ? tierCountOf(state, controller, sourceId, count.count, departedLine) : 0;
    case 'underCount': {
      if (count.all) {
        let total = 0;
        // 「自分のフロントLのキャラの下の裏向きのカード」 — the hosting line when the phrase names one.
        for (const line of count.line !== undefined ? [count.line] : (['front', 'energy'] as const)) {
          for (const card of state.players[who][line]) total += card.faceDown?.length ?? 0;
        }
        return total;
      }
      const here = locate(state, controller, sourceId);
      return here ? (state.players[controller][here.line].find(c => c.cardId === sourceId)?.faceDown?.length ?? 0) : 0;
    }
    case 'sideline':
      return state.players[who].sideline.filter(id => {
        // 「自分の場外にある**他の**フィールドカード1枚につき」 — the source itself does not count.
        if (count.other && id === sourceId) return false;
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — the sideline-as-event
        // treatment widens the kind test wherever a sideline card is counted.
        if (count.kind && !answersKind(definition, count.kind) && !(count.kind === 'event' && sidelineAsEventTreated(state, id))) return false;
        if (count.color && !Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(state, id)) return false;
        if (count.trait && !hasTrait(definition, count.trait)) return false;
        if (count.notTrait && hasTrait(definition, count.notTrait)) return false;
        // 「自分の場外にある〈X〉1枚につき」 — names are read through the *effective* names, the same
        // reader `sidelineCount` and `fieldCount` use, so an 〈alias〉 in the discard pile answers too
        // (Q2077; CSM-1-016's sibling on the tier side).
        const names = effectiveNames(state, id, who);
        if (count.name !== undefined && !names.includes(count.name)) return false;
        // 「自分の場外にある〈A〉と〈B〉の合計枚数」 — an any-of list, both names contributing to one count.
        if (count.names?.length && !count.names.some(name => names.includes(name))) return false;
        if (count.nameContains !== undefined && !names.some(name => name.includes(count.nameContains!))) return false;
        // 「自分の場外にある消費APが2で特徴を持つカードの枚数」 (KMR-1-001) — the printed price and the
        // presence of any trait at all, counted over the same subject the gate reads.
        if (count.apCost !== undefined && definition.apCost !== count.apCost) return false;
        if (count.hasTrait && (definition.traits?.length ?? 0) === 0) return false;
        if (count.name !== undefined || count.names?.length) {
          const matched = [count.name, ...(count.names ?? [])]
            .filter((name): name is string => name !== undefined && names.includes(name));
          if (dropsFromCharacterNameAxis(state, definition, matched)) return false;
        }
        return true;
      }).length
        // 「自分の効果で自分の場外にあるイベントカードの枚数を参照する場合、その枚数は1枚多くあるものと
        // して扱う。」 (MMM-2-007) — the printed +1, read only where the reference is the controller's own
        // (「自分の…自分の」) and the subject is the plain event-card count.
        + (who === controller && plainEventCount(count) ? sidelineEventBonus(state, who) : 0);
    case 'energyCount': return state.players[who].energy.length;
    // 「自分の発生エナジーにより」 (FMA-1-023/026) — the produced-symbols total, read exactly where
    // `Condition.producedEnergy` reads it.
    case 'producedEnergy': {
      return energySourceSlots(state, who).reduce((sum, card) => {
        const generated = getGeneratedEnergyFor(state, card.cardId, who);
        if (count.color !== undefined) return sum + (generated[count.color] ?? 0);
        return sum + Object.values(generated).reduce((a, b) => a + (b ?? 0), 0);
      }, 0);
    }
    case 'fieldCount': {
      // 「同じラインの…」 reads the line the effect source occupies, exactly where
      // `Condition.fieldCount.sameLine` reads it — same phrase, same relation.
      const sourceLine = count.sameLine
        ? departedLine ?? locate(state, state.cards[sourceId]?.owner ?? controller, sourceId)?.line
        : undefined;
      const pool = count.sameLine
        ? (sourceLine ? state.players[who][sourceLine] : [])
        : count.line ? state.players[who][count.line] : [...state.players[who].front, ...state.players[who].energy];
      const matched = pool.filter(card => {
        const definition = peekDefinition(state, card.cardId);
        if (!definition) return false;
        if (count.kind && !answersKind(definition, count.kind)) return false;
        if (count.color && !Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(state, card.cardId)) return false;
        // 「［特徴：四聖剣］と〈藤堂 鏡志朗〉と〈月下（藤堂機）〉1枚につき」 — a *mixed list* is a union:
        // a card counts when it carries the trait **or** bears one of the names (the conjunctive reading
        // would count only cards that are both, which for a mixed list is none). With no `names` the
        // trait stays the plain inclusion it has always been.
        if (count.names?.length || count.traits?.length) {
          const names = effectiveNames(state, card.cardId, who);
          const fragment = count.nameContains;
          const byTrait = (count.trait !== undefined && hasTrait(definition, count.trait))
            || (count.traits ?? []).some(trait => hasTrait(definition, trait));
          const byName = (count.names ?? []).some(candidate => names.includes(candidate));
          const byFragment = fragment !== undefined && names.some(name => name.includes(fragment));
          if (!byTrait && !byName && !byFragment) return false;
        } else if (count.trait && !hasTrait(definition, count.trait)) return false;
        if (count.notTrait && hasTrait(definition, count.notTrait)) return false;
        if (count.notColor && (Object.hasOwn(definition.requiredEnergy, count.notColor) || treatedAsAllColors(state, card.cardId))) return false;
        // 「[アタック時]/[ブロック時]を持つ」 — the printed triggered ability, read the same way the
        // filter and condition readers read it.
        if (count.attackAbility !== undefined && printsAbility(definition, 'onAttack', state, card.cardId) !== count.attackAbility) return false;
        if (count.blockAbility !== undefined && printsAbility(definition, 'onBlock', state, card.cardId) !== count.blockAbility) return false;
        // 「[起動メイン]を持つ」 — the printed activated ability (see `Condition.fieldCount.hasActivated`).
        if (count.hasActivated !== undefined && (definition.activated !== undefined) !== count.hasActivated) return false;
        // 「必要エナジーが3の」 — the requirement total, read like every other energy bound (including
        // an on-field 「…としても扱う」 replacement).
        if (count.minEnergy !== undefined || count.maxEnergy !== undefined) {
          const total = Object.values(effectiveRequiredEnergy(state, card.cardId)).reduce((a, b) => a + (b ?? 0), 0);
          if (count.minEnergy !== undefined && total < count.minEnergy) return false;
          if (count.maxEnergy !== undefined && total > count.maxEnergy) return false;
        }
        // 「BP4000以上の」 — the current BP, read exactly where `Condition.fieldCount.minBP` reads it.
        if (count.minBP !== undefined || count.maxBP !== undefined) {
          const bp = currentBP(state, card.cardId, who);
          if (count.minBP !== undefined && bp < count.minBP) return false;
          if (count.maxBP !== undefined && bp > count.maxBP) return false;
        }
        // 「レストのキャラ」「アクティブのキャラ」 — the slot's own state, which no definition carries.
        if (count.rested !== undefined && card.active === count.rested) return false;
        if (count.active !== undefined && card.active !== count.active) return false;
        // 「レイド状態の」 — the stack, not the printed RAID ability; read exactly where
        // `Condition.fieldCount.raid` reads it, so a count and a gate can never disagree.
        if (count.raid !== undefined && ((card.underneath.length > 0) !== count.raid)) return false;
        // 「[トリガー]を持つカードの枚数×1000以下」 — the *printed* trigger, read exactly where
        // `Condition.fieldCount.hasTrigger` reads it.
        if (count.hasTrigger !== undefined && (definition.trigger !== undefined) !== count.hasTrigger) return false;
        // 「自分の場の[2回ブロック]を持つキャラ1枚につき」 (ARK-1-087) — the printed keyword, read off
        // the same effective set (printed + granted) `CardFilter.hasKeyword` reads. The list spelling is
        // an any-of union, exactly like `Condition.fieldCount.hasKeywords`.
        if (count.hasKeyword !== undefined && !effectiveKeywordsFor(state, card.cardId, who)[count.hasKeyword]) return false;
        if (count.hasKeywords !== undefined && !count.hasKeywords.some(keyword => effectiveKeywordsFor(state, card.cardId, who)[keyword])) return false;
        // 「元々のBPが…の」 — what the card prints, ignoring every modifier the board applied.
        if (count.printedBP) {
          const printed = definition.bp;
          if (printed === undefined) return false;
          if (count.printedBP.min !== undefined && printed < count.printedBP.min) return false;
          if (count.printedBP.max !== undefined && printed > count.printedBP.max) return false;
        }
        // 「元々の消費APが2以上の」 — the printed AP cost, the same `definition.apCost` bound the
        // field-count condition reads.
        if (count.minApCost !== undefined || count.maxApCost !== undefined) {
          const ap = definition.apCost ?? 0;
          if (count.minApCost !== undefined && ap < count.minApCost) return false;
          if (count.maxApCost !== undefined && ap > count.maxApCost) return false;
        }
        // 「元々の消費AP」 — the printed sibling of minApCost/maxApCost (Q1122), read like printedBP above.
        if (count.printedApCost) {
          const ap = definition.apCost ?? 0;
          if (count.printedApCost.min !== undefined && ap < count.printedApCost.min) return false;
          if (count.printedApCost.max !== undefined && ap > count.printedApCost.max) return false;
        }
        // 「他の」 excludes the effect source, and names are read through 〈alias〉 like everywhere else.
        if (count.other && card.cardId === sourceId) return false;
        // The single-name forms (a list of `names`/`traits` is already handled as the union above, so it
        // must not be re-checked here — the conjunctive second test would undo the union).
        if (count.name !== undefined || count.nameContains !== undefined) {
          const names = effectiveNames(state, card.cardId, who);
          if (count.name !== undefined && !names.includes(count.name)) return false;
          if (count.nameContains !== undefined && !names.some(name => name.includes(count.nameContains!))) return false;
        }
        return true;
      });
      let total = matched.length;
      for (const card of matched) total += countWeightBonus(state, card, who, [count.trait, ...(count.traits ?? [])]);
      return total;
    }
    case 'handCount': return state.players[who].hand.length;
    case 'drewThisTurn': {
      // 「このターン中に自分が引いたカードの枚数」 — the cards, not the draw events: one entry per draw,
      // each carrying its `cardCount`, summed. A single draw of four is four cards.
      return (state.turnEvents ?? []).reduce((sum, entry) =>
        entry.event === 'drew' && entry.player === who ? sum + (entry.count ?? 1) : sum, 0);
    }
    case 'lifeCount': return state.players[who].life.length;
    case 'eventsUsedThisTurn':
      // 「このターン中に自分が使用した[特徴：食べ物]の枚数」 — a *narrowed* count has to read the log,
      // because the per-player counter holds no identity.
      if (count.trait !== undefined || count.kind !== undefined) {
        return (state.turnEvents ?? []).filter(entry => {
          if (entry.event !== 'used' || entry.player !== who || entry.cardId === undefined) return false;
          const definition = peekDefinition(state, entry.cardId);
          if (!definition) return false;
          if (count.kind !== undefined && !answersKind(definition, count.kind)) return false;
          return count.trait === undefined || hasTrait(definition, count.trait);
        }).length;
      }
      if (count.other) {
        // 「このターン中に自分が使用した**他の**イベントカード」 — the log records each use with the card
        // that was used, so the source drops out by identity rather than by subtracting from a count.
        return (state.turnEvents ?? []).filter(entry =>
          entry.event === 'used' && entry.player === who && entry.cardId !== undefined && entry.cardId !== sourceId
          && answersKind(peekDefinition(state, entry.cardId), 'event')).length;
      }
      return state.players[who].eventsUsedThisTurn ?? 0;
    case 'removal':
      return state.players[who].removal.filter(id => {
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        if (count.kind && !answersKind(definition, count.kind)) return false;
        // 「自分の場外とリムーブエリアにある〈ジャイガー〉」 — the named-subject half, read exactly like
        // the sibling `sideline` source so a cross-pile sum can never disagree with its own parts
        // (effective names, so an 〈alias〉 answers here too).
        const names = effectiveNames(state, id, who);
        if (count.name !== undefined && !names.includes(count.name)) return false;
        if (count.names?.length && !count.names.some(name => names.includes(name))) return false;
        if (count.name !== undefined || count.names?.length) {
          const matched = [count.name, ...(count.names ?? [])]
            .filter((name): name is string => name !== undefined && names.includes(name));
          if (dropsFromCharacterNameAxis(state, definition, matched)) return false;
        }
        return true;
      }).length;
    case 'distinctNames': {
      const zone: 'front' | 'energy' | 'field' | 'sideline' | 'fieldOrSideline' | 'removal' = count.zone ?? 'field';
      const pool = zone === 'sideline' ? state.players[who].sideline
        : zone === 'removal' ? state.players[who].removal
          : zone === 'front' ? state.players[who].front.map(c => c.cardId)
            : zone === 'energy' ? state.players[who].energy.map(c => c.cardId)
              : zone === 'fieldOrSideline' ? [...state.players[who].front, ...state.players[who].energy].map(c => c.cardId).concat(state.players[who].sideline)
                : [...state.players[who].front, ...state.players[who].energy].map(c => c.cardId);
      const names = new Set<string>();
      for (const id of pool) {
        if (count.other && id === sourceId) continue;
        const definition = peekDefinition(state, id);
        if (!definition) continue;
        // 「…としても扱う」 aliases answer for the listed names too (Q512/Q516: a 〈神楽〉 with 〈定春〉
        // underneath counts as 定春), but one card contributes exactly *one* count (Q470): the printed
        // name when it is listed, otherwise the first listed name the card answers to.
        const effective = effectiveNames(state, id, who);
        if (count.names?.length && !count.names.some(name => effective.includes(name))) continue;
        // 「〈X〉以外の…カード名の種類の数」 — the excluded cards do not count toward the total.
        if (count.notNames?.length && count.notNames.some(name => effective.includes(name))) continue;
        if (count.kind && !answersKind(definition, count.kind) && !(count.kind === 'event' && sidelineAsEventTreated(state, id))) continue;
        // 「〔イベントカードとフィールドカード〕」 — a union of kinds counted in one pool.
        if (count.kinds?.length && !count.kinds.some(kind => answersKind(definition, kind)) && !(count.kinds.includes('event') && sidelineAsEventTreated(state, id))) continue;
        if (count.color && !Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(state, id)) continue;
        if (count.trait && !hasTrait(definition, count.trait)) continue;
        if (count.notTrait && hasTrait(definition, count.notTrait)) continue;
        if (count.by === 'energy') {
          names.add(COLORS.map(c => definition.requiredEnergy[c] ?? 0).join('/'));
        } else if (count.names?.length) {
          for (const name of count.names) if (effective.includes(name)) names.add(name);
        } else {
          for (const name of countedUnlistedNames(definition, effective)) names.add(name);
        }
      }
      return names.size;
    }
    // 「自分の場の黄のカードの特徴の種類数分」 — the trait-count sibling of `distinctNames`: the same
    // field pool, counted by distinct printed traits (a card with two matching traits contributes two),
    // read exactly where `Condition.distinctTraits` reads them.
    case 'distinctTraits': {
      const traits = new Set<string>();
      for (const card of [...state.players[who].front, ...state.players[who].energy]) {
        if (count.other && card.cardId === sourceId) continue;
        const definition = peekDefinition(state, card.cardId);
        if (!definition) continue;
        if (count.color !== undefined && !Object.hasOwn(definition.requiredEnergy, count.color) && !treatedAsAllColors(state, card.cardId)) continue;
        for (const trait of definition.traits ?? []) {
          if (count.traitContains !== undefined && !trait.includes(count.traitContains)) continue;
          traits.add(trait);
        }
      }
      return traits.size;
    }
    // 「このキャラのBPにより」 as a *tier* source reads the same value its gate does. Guarded like
    // `activeStatics` so a count that reads the very BP it feeds cannot recurse.
    case 'selfBp': {
      if (evaluationDepth >= MAX_DEPTH) return 0;
      evaluationDepth++;
      const owner = state.cards[sourceId]?.owner ?? controller;
      const value = currentBP(state, sourceId, owner);
      evaluationDepth--;
      return value;
    }
    // The revealed-hand channel lives on the effect frame, not the state, so it is zero outside one.
    // A printed line (`zone`) narrows the field pool the same way it does for `distinctNames`.
    case 'revealedTraitNames': {
      const names = new Set<string>();
      const pool = count.zone === 'front' ? state.players[who].front
        : count.zone === 'energy' ? state.players[who].energy
          : [...state.players[who].front, ...state.players[who].energy];
      for (const card of pool) {
        const definition = peekDefinition(state, card.cardId);
        if (!definition || !hasTrait(definition, count.trait)) continue;
        for (const name of countedUnlistedNames(definition, effectiveNames(state, card.cardId, who))) names.add(name);
      }
      return names.size;
    }
    // 「この効果でレストにしたカードの必要エナジーの合計」 is read from the resolving frame's own record
    // (`effects.ts#tierCount`); without a frame there is no "this effect" and the sum is zero.
    case 'restedEnergySum': return 0;
    // 「この効果で(場外から)リムーブエリアに置いたカード」 — the same frame-scoped reading, over
    // `removedIds`, read in `effects.ts#tierCount`; without a frame there is no "this effect" and the
    // count is zero.
    case 'removedByThisEffect': return 0;
    // 「この効果で退場させたキャラの枚数分」 — the same frame-scoped reading, over `retiredIdsOwn` /
    // `retiredIdsOpponent`, read in `effects.ts#tierCount`.
    case 'retiredByThisEffect': return 0;
    // 「レストにした枚数により、…」 / 「この効果で場外に置いたカード1枚につき、…」 — the same
    // frame-scoped reading, over `restedIds` / `discardedIds`, read in `effects.ts#tierCount`.
    case 'restedByThisEffect': return 0;
    case 'discardedByThisEffect': return 0;
    // 「…の枚数と、…の枚数を合計し」 — each part is read by the very same function, so a sum and its
    // own parts can never disagree.
    case 'sum': return count.counts.reduce((total, part) => total + tierCountOf(state, who, sourceId, part, departedLine), 0);
  }
}

export function staticImpact(state: GameState, id: CardId, controller: PlayerId): number {
  // 「…1枚につき、このキャラは[インパクト（+1）]を得る」 — a per-count keyword is read here, where the
  // keyword is asked, so it tracks the count exactly like `staticBp`'s `bpPer`.
  return activeStatics(state, id, controller).reduce((total, m) =>
    total + (m.type === 'impact' ? m.amount : m.type === 'keywordPer' && m.keyword === 'impact' ? tierCountOf(state, controller, id, m.count) * m.amount : 0), 0);
}

export function staticDamage(state: GameState, id: CardId, controller: PlayerId): number {
  return activeStatics(state, id, controller).reduce((total, m) =>
    total + (m.type === 'damage' ? m.amount : m.type === 'keywordPer' && m.keyword === 'damage' ? tierCountOf(state, controller, id, m.count) * m.amount : 0), 0);
}

export function staticApCostDelta(state: GameState, id: CardId, controller: PlayerId): number {
  return activeStatics(state, id, controller).reduce((total, m) => total + (m.type === 'apCostDelta' ? m.amount : 0), 0);
}

export function staticEnterActive(state: GameState, id: CardId, controller: PlayerId): boolean | undefined {
  const modifiers = activeStatics(state, id, controller);
  if (modifiers.some(m => m.type === 'enterActive')) return true;
  if (modifiers.some(m => m.type === 'enterRested')) return false;
  return undefined;
}

export function staticCanStep(state: GameState, id: CardId, controller: PlayerId): boolean {
  return activeStatics(state, id, controller).some(m => m.type === 'canStep');
}

export function staticAllColors(state: GameState, id: CardId, controller: PlayerId): boolean {
  return activeStatics(state, id, controller).some(m => m.type === 'allColors');
}

export function treatedAsAllColors(state: GameState, id: CardId): boolean {
  const definition = peekDefinition(state, id);
  if (!definition?.static?.some(ability => ability.modifiers.some(modifier => modifier.type === 'allColors'))) return false;
  const owner = state.cards[id]?.owner;
  return owner !== undefined && staticAllColors(state, id, owner);
}

export function staticEvade(state: GameState, id: CardId, controller: PlayerId): number {
  return Math.max(0, ...activeStatics(state, id, controller)
    .filter((m): m is Extract<StaticModifier, { type: 'cannotBeBlockedBy' }> => m.type === 'cannotBeBlockedBy' && m.maxBP !== undefined)
    .map(m => m.maxBP!));
}

/**
 * Blocker-side refusals written as a *subject filter* (「…カード名に「X」を含むキャラをブロックできない」).
 *
 * Kept apart from `staticEvade`'s BP bound: the filter is matched against the candidate blocker by the
 * same `matchesFilter` a selection uses, so a name fragment or a trait reads exactly the way it does
 * everywhere else. The caller (the block action) owns the matching.
 */
export function staticBlockerFilters(state: GameState, id: CardId, controller: PlayerId): CardFilter[] {
  return activeStatics(state, id, controller)
    .filter((m): m is Extract<StaticModifier, { type: 'cannotBeBlockedBy' }> => m.type === 'cannotBeBlockedBy' && m.filter !== undefined)
    .map(m => m.filter!);
}

/** Lowest BP at which a blocker is still rejected by a static restriction, or undefined. */
/**
 * The lowest BP at or above which this sniper may not designate a target, or `undefined`.
 *
 * 「このキャラはBP2500以上のキャラを[狙い撃ち]で指定できない」 is a restriction on the *sniper*, so it is
 * read from the attacker's own statics. Repeated copies take the tightest bound, like every other
 * threshold the table shows.
 */
export function staticSnipeCeiling(state: GameState, id: CardId, controller: PlayerId): number | undefined {
  const values = activeStatics(state, id, controller)
    .filter((m): m is Extract<StaticModifier, { type: 'cannotBeSniped' }> => m.type === 'cannotBeSniped' && m.maxBP !== undefined)
    .map(m => m.maxBP!);
  return values.length ? Math.min(...values) : undefined;
}

export function staticEvadeAtLeast(state: GameState, id: CardId, controller: PlayerId): number | undefined {
  const values = activeStatics(state, id, controller).filter(m => m.type === 'cannotBeBlockedByAtLeast').map(m => m.minBP);
  return values.length ? Math.min(...values) : undefined;
}

/**
 * Whether a BP-minus operation is refused — 「BPをマイナスする効果を受けない」 (every route) or its
 * routed spelling 「相手のキャラの効果で〔…BPをマイナスされない〕。」 (AOT-2-028), which refuses only
 * while the operation comes from the opponent's character effect.
 */
export function refusesBpMinusFrom(state: GameState, id: CardId, controller: PlayerId, enemyCharacterEffect: boolean): boolean {
  return activeStatics(state, id, controller).some(modifier => {
    if (modifier.type !== 'immuneToBpMinus') return false;
    if (modifier.source === undefined) return true;
    return enemyCharacterEffect;
  });
}

export function staticImmunity(state: GameState, id: CardId, controller: PlayerId): { bpMinus: boolean; noFront: boolean; noFrontMove: boolean; noEnergy: boolean } {
  const modifiers = activeStatics(state, id, controller);
  return {
    bpMinus: modifiers.some(m => m.type === 'immuneToBpMinus'),
    noFront: modifiers.some(m => m.type === 'cannotEnterFront'),
    noFrontMove: modifiers.some(m => m.type === 'cannotMoveToFront'),
    noEnergy: modifiers.some(m => m.type === 'cannotEnterEnergy'),
  };
}

/**
 * Whether the front line is closed to `id` for *this* effect — the carve-out-aware reading of
 * `cannotMoveToFront` the effect routes use (move / swapLines; placement reads `cannotEnterFront` and
 * stays closed unconditionally).
 *
 * 「自分の効果以外で…移動できない」 (BLC-4-060/MST-1-026) leaves the controller's own effects free;
 * 「このカードの効果以外で」/「このカードの[起動メイン]以外で」 (GMR-1-030/048, RNK-1-111, KGD-1-009)
 * leaves this card's own effect alone. `player` is the resolving effect's controller and `sourceId` its
 * source card, exactly the two facts the printed carve-outs name.
 */
export function frontMoveForbidden(state: GameState, id: CardId, owner: PlayerId, player: PlayerId, sourceId: CardId | undefined): boolean {
  return activeStatics(state, id, owner).some(m => {
    if (m.type !== 'cannotMoveToFront') return false;
    if (m.except === 'ownEffects') return player !== owner;
    if (m.except === 'selfEffect') return sourceId !== id;
    return true;
  });
}

/**
 * What the card's 「選ばれない」 / 「〜できない」 / 「〜しない」 statics currently forbid.
 *
 * Read as one record because every caller wants the same set of questions and several of them ask
 * more than one at a time (a selection checks protection while a move checks `move`).
 */
export function staticForbids(state: GameState, id: CardId, controller: PlayerId): {
  attack: boolean; block: boolean; blockFirstAttack: boolean; move: boolean; moveOpponentOnly: boolean; movePhase: boolean; retire: boolean; energyAttack: boolean; mustBeBlocked: boolean; mustBlockCeiling?: number; mustBlockOverSelf?: boolean; mustBlockFirstAttack?: boolean; activate: boolean; activateOwnOnly: boolean; readyStep: boolean; sniped: boolean;
} {
  const modifiers = activeStatics(state, id, controller);
  const has = (type: StaticModifier['type']): boolean => modifiers.some(m => m.type === type);
  const located = locate(state, controller, id);
  const field = located ? state.players[controller][located.line].find(c => c.cardId === id) : undefined;
  const timedActivate = (field?.cannotActivateUntilTurn ?? -1) >= state.turn;
  const blocking = modifiers.filter((m): m is Extract<StaticModifier, { type: 'mustBeBlocked' }> => m.type === 'mustBeBlocked');
  const ceilings = blocking.filter(m => m.maxBP !== undefined).map(m => m.maxBP!);
  return {
    attack: has('cannotAttack'),
    block: has('cannotBlock'),
    // 「最初のアタックをブロックできない」 — the timed half (`attackCount`) is read where a block is
    // chosen, because the static itself cannot see the turn's attack log from here.
    blockFirstAttack: has('cannotBlockFirstAttack'),
    // `move` keeps only the source-less spelling (「このキャラは移動できない。」 refuses every route);
    // 「相手の効果で…移動せず」 (YYH-1-027) carries `source: 'opponent'` and reads through
    // `moveOpponentOnly` where the cause is known — the same split the retirement refusals make below.
    move: modifiers.some(m => m.type === 'cannotMove' && m.source === undefined),
    moveOpponentOnly: modifiers.some(m => m.type === 'cannotMove' && m.source === 'opponent'),
    // 「移動フェイズで移動できない。」 — the *phase* refusal, read only by the movement-phase action; an
    // effect's move checks `move` alone, which is exactly the split the two spellings print.
    movePhase: has('cannotMovePhase'),
    // A routed refusal (「…の効果で退場しない」) is deliberately *not* counted here: this flag is read
    // wherever a retirement happens, including from a battle or the rules, and an unconditional refusal is
    // strictly wider than one that names its routes. The routes are checked at the effect that asks.
    retire: modifiers.some(m => m.type === 'doesNotRetire' && m.source === undefined),
    energyAttack: has('canAttackFromEnergy'),
    mustBeBlocked: has('mustBeBlocked'),
    // 「可能ならBPN以下のでブロックしなければならない」 — repeated copies take the tightest ceiling, the
    // same way every other threshold the table shows does.
    ...(ceilings.length ? { mustBlockCeiling: Math.min(...ceilings) } : {}),
    // 「このキャラよりもBPが大きいキャラでブロックしなければならない」 (KJN-1-001) — the demand's floor
    // is this card's BP, read where the demand is; the two spellings are not merged because a card may
    // print both and each keeps its own direction.
    ...(blocking.some(m => m.overSelf) ? { mustBlockOverSelf: true } : {}),
    // 「1回目のアタックを」 (KJN-1-016) — the turn log answers this, not the board, so the flag is read
    // beside `mustBeBlocked` and consulted where the attack demand is.
    ...(blocking.some(m => m.firstAttack) ? { mustBlockFirstAttack: true } : {}),
    activate: has('cannotActivate') || timedActivate,
    // 「自分の効果以外でアクティブにならない」 — the ready step refuses it like any activation ban, but an
    // effect of the card's own controller may still activate it (read at the effect's own `activate`).
    activateOwnOnly: has('cannotActivateExceptOwn'),
    // 「スタートフェイズとエンドフェイズにアクティブにならない」 — only the two ready steps are
    // refused; `activate` deliberately stays false so an effect may still stand the card up.
    readyStep: has('cannotReadyStep'),
    // The *target* side of `cannotBeSniped` — the passive 「…で指定されない」 protection only. A
    // modifier carrying `maxBP` is the same sentence's other direction: the card is the *sniper* and
    // the threshold refuses targets at or above it (`staticSnipeCeiling`, 0053 §8), so it must not
    // protect its carrier here (IMS-1-036 was refused as a target although its print only limits its
    // own sniping).
    sniped: modifiers.some(m => m.type === 'cannotBeSniped' && m.maxBP === undefined),
  };
}

/**
 * The statics an effect installed on a *player* rather than on a card.
 *
 * 「自分はこのターン中、自分の効果でライフエリアにあるカードを場外に置くことができない」 belongs to
 * the player: it applies wherever that player's own effects would move a life card, regardless of which
 * card is resolving. The grants carry their own expiry, so this filters to the ones still in force.
 */
export function playerStatics(state: GameState, player: PlayerId): StaticModifier[] {
  const out: StaticModifier[] = [];
  for (const grant of state.players[player].grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
    out.push(...grant.abilities.flatMap(ability => ability.modifiers));
  }
  return out;
}

/**
 * The 「選ばれない」 protection the card carries against the opponent's effects.
 *
 * Returned as the list of *routes* that are blocked rather than a single boolean: 「相手のキャラの効果
 * で選ばれない」 and 「相手のトリガーの効果で選ばれない」 protect against different things, and folding
 * them into one flag would let an event card choose a card that only protected itself from characters.
 * `'any'` covers every route, which is what the unqualified 「相手の効果で選ばれない」 prints.
 */
export function staticProtection(state: GameState, id: CardId, controller: PlayerId): Extract<StaticModifier, { type: 'cannotBeChosenBy' }>[] {
  // The modifiers themselves, not just their routes: the owner axis (`both`) and the source narrowing
  // (`sourceNotTrait`) differ per entry, so the caller has to see each one whole.
  return activeStatics(state, id, controller).filter(
    (modifier): modifier is Extract<StaticModifier, { type: 'cannotBeChosenBy' }> => modifier.type === 'cannotBeChosenBy',
  );
}

export interface ProtectionAttribution {
  /** The modifier object the `staticProtection` read hands back (identity match). */
  modifier: Extract<StaticModifier, { type: 'cannotBeChosenBy' }>;
  /**
   * The card whose effect installed the grant; absent for a printed static and for a grant recorded
   * before `grantedBy` existed (older snapshots). `grantedByAll` is not projected here: one source id is
   * what the client can name.
   */
  grantedBy?: CardId;
}

export function protectionAttribution(state: GameState, id: CardId, controller: PlayerId): ProtectionAttribution[] {
  const out: ProtectionAttribution[] = [];
  const push = (modifier: StaticModifier, grantedBy: CardId | undefined): void => {
    if (modifier.type !== 'cannotBeChosenBy') return;
    out.push({ modifier, ...(grantedBy !== undefined ? { grantedBy } : {}) });
  };
  // 1. Grants installed on the card's own field slot — the same expiry / `whileSource` gates `ownAbilities`
  // applies, so an expired or orphaned grant cannot attribute a live modifier.
  const located = locate(state, controller, id);
  if (located) {
    const field = state.players[controller][located.line].find(card => card.cardId === id);
    for (const grant of field?.grantedStatics ?? []) {
      if (grant.expiresTurn < state.turn) continue;
      if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
      if (grant.sourceId !== undefined) {
        const sourceOwner = state.cards[grant.sourceId]?.owner;
        const source = sourceOwner === undefined ? undefined : locate(state, sourceOwner, grant.sourceId);
        if (!source) continue;
        if (grant.sourceLine !== undefined && source.line !== grant.sourceLine) continue;
      }
      for (const ability of grant.abilities) for (const modifier of ability.modifiers) push(modifier, grant.grantedBy);
    }
  }
  // 2. Player-level grants broadcasting onto the field — the same condition / filter gates
  // `staticAbilitiesOf` applies at its own player-grant loop.
  for (const grant of state.players[controller].grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) continue;
    for (const ability of grant.abilities) {
      if (ability.condition && !evalCondition(state, id, controller, ability.condition)) continue;
      for (const modifier of ability.modifiers) {
        if (modifier.type !== 'grantToField') continue;
        if (!grantMatches(state, id, controller, modifier.filter)) continue;
        for (const staticAbility of modifier.statics) for (const entry of staticAbility.modifiers) push(entry, grant.grantedBy);
      }
    }
  }
  // 3. Another field card's broadcast; the holder is the source the print names.
  for (const holder of [...state.players[controller].front, ...state.players[controller].energy]) {
    const granted = ownStaticsOfType(state, holder.cardId, controller,
      m => m.type === 'grantToField') as Extract<StaticModifier, { type: 'grantToField' }>[];
    for (const modifier of granted) {
      if (!grantMatches(state, id, controller, modifier.filter, holder.cardId)) continue;
      for (const staticAbility of modifier.statics) for (const entry of staticAbility.modifiers) push(entry, holder.cardId);
    }
  }
  return out;
}

/**
 * Whether 「このキャラは相手の効果で場を離れない。」 refuses an effect that is trying to take the card off
 * the field. `route` is the effect's own route, so a protection that names one refuses only that one.
 *
 * The owner's own effects are never refused — the printed subject is 「相手の効果」 — and the caller checks
 * that, because only it knows whose effect is resolving.
 */
export function refusesOpponentRemoval(state: GameState, id: CardId, controller: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger', byOpponent = true): boolean {
  const hit = activeStatics(state, id, controller).find(
    modifier => modifier.type === 'doesNotLeaveField'
      && (byOpponent || modifier.anyOwner === true)
      && (modifier.source === undefined || modifier.source === route),
  );
  if (!hit) return false;
  // 「[ターン1]相手の効果でこのキャラが場を離れる場合、代わりに場を離れない。」 — the printed per-turn
  // limit: the charge is spent here, at the moment the protection actually answers a leave.
  return spendReplacementUse(state, id, controller, hit);
}

/**
 * Whether a replacement static's printed 「[ターン1]」 still has its use for this turn, spending it here.
 *
 * An ability without the tag always answers (nothing to spend). The budget is the *printed name's*, not
 * the instance's (Q1723): two copies of 〈葛城 ミサト〉 on one field share the single per-turn use, so the
 * stamp lives on the player (`PlayerState.sharedLimitUsed`) keyed by functional id — the same player-level
 * scheme the activated and onPlay channels carry. The ability's own text stays part of the key, so two
 * *different* replacements on one card still keep two independent budgets, which is what the print gives
 * each.
 */
export function spendReplacementUse(state: GameState, id: CardId, controller: PlayerId, modifier: StaticModifier): boolean {
  const ability = staticAbilitiesOf(state, id, controller).find(candidate => candidate.modifiers.includes(modifier));
  if (!ability?.oncePerTurn) return true;
  // A card with no slot answers without spending — the same shape the per-instance read had.
  const located = locate(state, controller, id);
  if (!located) return true;
  const definition = peekDefinition(state, id);
  const key = `sub:${definition?.functionalId ?? id}:${JSON.stringify(ability)}`;
  const player = state.players[controller];
  if (player.sharedLimitUsed?.[key] === state.turn) return false;
  player.sharedLimitUsed = { ...(player.sharedLimitUsed ?? {}), [key]: state.turn };
  return true;
}

/**
 * Whether 「バトルの敗北…で場を離れず」 refuses the battle-loss removal — the rules' own comparison,
 * which is not an effect route, so it is asked about separately from `refusesOpponentRemoval`.
 */
export function refusesBattleDefeat(state: GameState, id: CardId, controller: PlayerId): boolean {
  return activeStatics(state, id, controller).some(modifier => (modifier.type === 'doesNotLeaveField' && modifier.battle === true)
    || (modifier.type === 'doesNotRetire' && modifier.source === 'battle'));
}

/**
 * The same question for *退場* alone — 「このキャラは相手のキャラの効果やイベントカードの効果で退場しな
 * い。」.
 *
 * Kept apart from `refusesOpponentRemoval` because the two cover different destinations: this one still
 * lets an effect send the card to 手札 or リムーブエリア, which is exactly the difference between 「退場しな
 * い」 and 「場を離れない」. Callers check the destination, the owner and the route before asking.
 */
export function refusesRetire(state: GameState, id: CardId, controller: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger'): boolean {
  return activeStatics(state, id, controller).some(
    modifier => modifier.type === 'doesNotRetire' && modifier.source !== undefined && modifier.source === route,
  );
}

/**
 * 「自分と相手の場のキャラ全ては、効果で退場しない。」 (MSS-1-056) — a player-scope grant that refuses
 * every effect-driven retirement for the turn, whichever side the character belongs to. Read from both
 * players' grants: the carrier may be either player's, and the printed subject spans the whole table.
 */
export function allCharsNoRetireByEffect(state: GameState): boolean {
  return ([0, 1] as const).some(player => playerStatics(state, player).some(m => m.type === 'allCharsNoRetireByEffect'));
}

/**
 * 「このキャラは相手の効果でレストにならない。」 — refuses an *opponent's* effect that would rest this card.
 *
 * The owner check belongs to the caller, exactly as `refusesOpponentRemoval`'s does: the printed subject
 * is 「相手の効果で」, so the controller's own effects may still rest the card.
 */
export function refusesRest(state: GameState, id: CardId, controller: PlayerId, ownEffect = false, causeId?: CardId): boolean {
  // The plain spelling covers the opponent's effects (read cross-side, matching its printed subject);
  // the `own` variant (ARK-1-079's granted lock) covers the owner's own card effects instead; `both`
  // (「自分と相手の」, ARK-1-023) covers either side.
  return activeStatics(state, id, controller).some(modifier => {
    if (modifier.type !== 'doesNotRest') return false;
    if (modifier.both === true) { /* both players' effects */ }
    else if (modifier.own === true ? !ownEffect : ownEffect) return false;
    // 「特徴に「X」を持たない…キャラの効果で」 — the refusal reads the resolving cause's printed trait; a
    // cause that cannot be read (absent, not a character, or carrying the trait) is not refused.
    if (modifier.sourceNotTrait !== undefined) {
      if (causeId === undefined) return false;
      const cause = peekDefinition(state, causeId);
      if (!cause || cause.kind !== 'character' || hasTrait(cause, modifier.sourceNotTrait)) return false;
    }
    return true;
  });
}

/**
 * 「このキャラは[自分と]相手の効果で手札に戻らない。」 — refuses an effect that would return the card to
 * a hand. `ownEffect` is true when the controller's own effect is the one asking: only the 「自分と相手の
 * 効果で」 spelling (`both`) refuses those, which is the whole difference between it and the plain form.
 */
export function refusesHandReturn(state: GameState, id: CardId, controller: PlayerId, ownEffect: boolean, route: 'effect' | 'battle' = 'effect'): boolean {
  return activeStatics(state, id, controller).some(
    modifier => modifier.type === 'doesNotReturn' && (route === 'battle' ? modifier.rules === true : (!ownEffect || modifier.both === true)),
  );
}

/**
 * Cost modifiers a card applies to *itself* while it sits in hand.
 *
 * 「手札にあるこのカードの必要エナジーを[色]減らす」 / 「…消費APを-Nする」 are written as statics on
 * the card, but a card in hand has no `FieldCard` for `activeStatics` to walk — it only sees the field —
 * so the discount was silently dropped and the card cost its full printed price. Read straight from the
 * definition instead, and only while the card is *not* on the field, so a card that keeps the modifier
 * after entering is not reduced twice.
 */
export function handStaticsOf(state: GameState, id: CardId): StaticModifier[] {
  const owner = state.cards[id]?.owner;
  if (owner === undefined) return [];
  if (locate(state, owner, id)) return [];
  const out: StaticModifier[] = [];
  for (const ability of peekDefinition(state, id)?.static ?? []) {
    if (ability.condition && !evalCondition(state, id, owner, ability.condition)) continue;
    out.push(...ability.modifiers);
  }
  // 「[フロントLにある場合]自分の手札にある…の必要エナジーを[緑×1]減らす」 — a card on the field that
  // discounts its owner's hand. The broadcaster is a field card (so it has a slot for its own condition),
  // while the cards it reaches have none; the read therefore starts from the field.
  for (const slot of [...state.players[owner].front, ...state.players[owner].energy]) {
    for (const ability of peekDefinition(state, slot.cardId)?.static ?? []) {
      if (ability.condition && !evalCondition(state, slot.cardId, owner, ability.condition)) continue;
      for (const modifier of ability.modifiers) {
        if (modifier.type !== 'grantToHand' || !state.players[owner].hand.includes(id)) continue;
        if (!definitionMatchesSubset(state, id, owner, modifier.filter)) continue;
        out.push(...modifier.modifiers);
      }
    }
  }
  // 「そうした場合、このターン中、自分の手札にある全ての〈X〉の必要エナジーを[黄×1]減らす」 — the same
  // discount installed by a *resolving effect* on the player (it names no card and outlives its source),
  // read here with its expiry so a play after the turn ends pays the printed price again.
  for (const grant of state.players[owner].grantedStatics ?? []) {
    if (grant.expiresTurn < state.turn) continue;
    for (const ability of grant.abilities) {
      if (ability.condition && !evalCondition(state, id, owner, ability.condition)) continue;
      for (const modifier of ability.modifiers) {
        if (modifier.type !== 'grantToHand' || !state.players[owner].hand.includes(id)) continue;
        if (!definitionMatchesSubset(state, id, owner, modifier.filter)) continue;
        out.push(...modifier.modifiers);
      }
    }
  }
  return out;
}

/**
 * Whether the cards a definition-scope filter names include this card.
 *
 * A deliberately small subset — the qualifiers a printed hand discount or a raid-base subject uses (a
 * trait, an exclusion, a printed requirement floor, a colour, a kind, and the base's own hidden stack).
 * Importing `matchesFilter` would close the `effects → conditions` cycle, which the two modules keep
 * open in one direction only; a field the compiler emits outside this subset is refused there rather
 * than read narrower here. The callers are `handStaticsOf` (the hand-discount channel),
 * `globalEnergyDeltas` and `requiredEnergyOf`'s `raidEnergyCostDelta` base check — the first two have
 * only a definition (no slot) to match; the raid-base check reads `underCount` off the base's slot.
 */
export function definitionMatchesSubset(state: GameState, id: CardId, owner: PlayerId, filter: CardFilter): boolean {
  const definition = peekDefinition(state, id);
  if (!definition) return false;
  const own = ownStaticsOf(state, id, owner);
  const onField = locate(state, owner, id) !== undefined;
  const set = own.find((m): m is Extract<StaticModifier, { type: 'energyCostSetAll' }> => m.type === 'energyCostSetAll')
    ?? (onField ? own.find((m): m is Extract<StaticModifier, { type: 'energyCostSetOnField' }> => m.type === 'energyCostSetOnField') : undefined);
  const total = Object.values(set?.energy ?? definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
  // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — the subset matcher follows the
  // same treatment while the card sits in 場外.
  if (filter.kind && !answersKind(definition, filter.kind) && !(filter.kind === 'event' && sidelineAsEventTreated(state, id))) return false;
  if (filter.color && !Object.hasOwn(definition.requiredEnergy, filter.color) && !treatedAsAllColors(state, id)) return false;
  if (filter.trait && !hasTrait(definition, filter.trait)) return false;
  if (filter.notTrait && hasTrait(definition, filter.notTrait)) return false;
  const names = effectiveNames(state, id, owner);
  if (filter.name !== undefined && !names.includes(filter.name)) return false;
  if (filter.names?.length && !filter.names.some(name => names.includes(name))) return false;
  // 「カード名に「X」を含む…」 — the fragment test, read like every other name reader. Before this the
  // filter field was silently ignored, so a discount naming a fragment reached every card in hand.
  if (filter.nameContains !== undefined && !names.some(name => name.includes(filter.nameContains!))) return false;
  if (filter.minEnergy !== undefined && total < filter.minEnergy) return false;
  if (filter.maxEnergy !== undefined && total > filter.maxEnergy) return false;
  if (filter.notNames?.length && names.some(name => filter.notNames!.includes(name))) return false;
  // 「裏向きのカードが下にあるキャラにレイドする際、必要エナジーを[赤×2]減らす」 — the one qualifier of
  // this subset that is a *slot* fact rather than a definition fact. The only caller that reaches it with
  // a slot in play is the raid-base check (`requiredEnergyOf`), where the base sits on a line by
  // definition; the read goes through that line, and a card with no slot counts zero stack.
  if (filter.underCount) {
    const slot = [...state.players[owner].front, ...state.players[owner].energy].find(c => c.cardId === id);
    const count = slot?.faceDown?.length ?? 0;
    if (filter.underCount.min !== undefined && count < filter.underCount.min) return false;
    if (filter.underCount.max !== undefined && count > filter.underCount.max) return false;
  }
  return true;
}

/** 「このキャラとのバトルで敗北した相手のキャラは…」 — where a losing defender goes instead. */
export function staticBattleLoserTo(state: GameState, id: CardId, controller: PlayerId): 'energy' | 'removal' | 'hand' | 'deckBottom' | 'stay' | undefined {

  const modifiers = activeStatics(state, id, controller).filter((m): m is Extract<StaticModifier, { type: 'battleLoserTo' }> => m.type === 'battleLoserTo');
  return modifiers.length ? modifiers[modifiers.length - 1]!.destination : undefined;
}

/**
 * 「BPN以下のキャラとのバトルで敗北したこのキャラは、退場する代わりにエナジーLに移動する。」 (KMR-2-009).
 *
 * Read from the *loser's* own statics — the mirror of `staticBattleLoserTo`, which reads the winner's.
 * `opponentBP` is the BP of the card it fought, which the printed 「BPN以下のキャラとのバトルで」 names.
 */
export function staticSelfBattleLoserTo(state: GameState, id: CardId, controller: PlayerId, opponentBP: number): 'energy' | 'removal' | 'hand' | 'deckBottom' | undefined {
  const modifiers = activeStatics(state, id, controller).filter((m): m is Extract<StaticModifier, { type: 'selfBattleLoserTo' }> => m.type === 'selfBattleLoserTo');
  for (const modifier of modifiers) {
    if (modifier.opponentMaxBP === undefined || opponentBP <= modifier.opponentMaxBP) return modifier.destination;
  }
  return undefined;
}

/**
 * How many cards a line holds once every 「置けるカードの枚数がN枚減る」 is folded in.
 *
 * Four is the printed capacity the engine already uses for both lines; a reduction is read from any
 * card the player has in play, because the wording is about the *player's* line, not the card's own.
 */
/**
 * The colour-trigger replacements the player's field offers for `color` (「自分が緑の[カラートリガー]を
 * 発動する場合、代わりに「…」をしてもよい」).
 *
 * Scanned over the field like `lineCapacity`: the source is a card, and its own conditions decide when
 * the offer stands. Every matching copy contributes, so two copies of one card still offer the choice once
 * per printed effect (the engine asks each replacement as one option).
 */
export function staticColorTriggerReplacements(state: GameState, player: PlayerId, color: Color): CardEffect[][] {
  const out: CardEffect[][] = [];
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    for (const modifier of activeStatics(state, card.cardId, player)) {
      if (modifier.type === 'colorTriggerReplacement' && modifier.color === color) out.push(modifier.effects);
    }
  }
  return out;
}

export function lineCapacity(state: GameState, player: PlayerId, line: Line): number {
  let capacity = 4;
  for (const card of [...state.players[player].front, ...state.players[player].energy]) {
    for (const modifier of activeStatics(state, card.cardId, player)) {
      if (modifier.type === 'lineCapacity' && modifier.line === line) capacity -= modifier.amount;
    }
  }
  return Math.max(0, capacity);
}

/**
 * 「…選ぶ際に、追加でAPをN支払わないと選べない」 — the wording's cost, or `undefined`.
 *
 * Read for the *route* the choosing effect takes: a tax that names 「キャラの効果やイベントカードの効果で」
 * charges those routes and not a trigger's. Several taxes on one card are *cumulative* (Q796: 同一〈サニー〉
 * に二度与えられた場合は「重複します」) — the amounts sum, and a print that does not stack says so with
 * 「この効果は重複しない」, which the broadcast route drops as `nonStacking` before it ever lands here.
 */
export type SelectionTaxRest = { amount: number; restFilter?: CardFilter };
export type SelectionTax = { ap: number; hand: number; rest: SelectionTaxRest[] };

export function staticSelectionTax(state: GameState, id: CardId, controller: PlayerId, route: 'characterEffect' | 'eventEffect' | 'trigger'): SelectionTax | undefined {
  const modifiers = activeStatics(state, id, controller)
    .filter((m): m is Extract<StaticModifier, { type: 'selectionTax' }> => m.type === 'selectionTax')
    .filter(m => m.sources === undefined || m.sources.includes(route));
  if (!modifiers.length) return undefined;
  // The payments are different currencies: AP and hand are sums, while each rest entry keeps its own
  // filter (WBK-1-060 grants an AP tax beside WBK-1-061's printed rest tax; merging them into one kind
  // would charge rest twice and swallow the AP).
  const tax: SelectionTax = { ap: 0, hand: 0, rest: [] };
  for (const modifier of modifiers) {
    if (modifier.kind === 'ap') tax.ap += modifier.amount;
    else if (modifier.kind === 'hand') tax.hand += modifier.amount;
    else tax.rest.push({ amount: modifier.amount, ...(modifier.restFilter ? { restFilter: modifier.restFilter } : {}) });
  }
  return tax;
}

/**
 * 「…と[狙い撃ち]でこのキャラを指定する際に」 — the selection tax a [狙い撃ち] *designation* pays.
 *
 * A designation is a command rather than an effect selection, so it never passes through the routes
 * `staticSelectionTax` reads; the tax carries its own `snipe` flag and this reader collects exactly
 * those, whoever the effect's source would have been.
 */
export function staticSnipeTax(state: GameState, id: CardId, chooser: PlayerId): { amount: number; kind: 'ap' | 'hand' | 'rest' } | undefined {
  const owner = state.cards[id]?.owner;
  if (owner === undefined || owner === chooser) return undefined;
  const modifiers = activeStatics(state, id, owner)
    .filter((m): m is Extract<StaticModifier, { type: 'selectionTax' }> => m.type === 'selectionTax' && m.snipe === true);
  if (!modifiers.length) return undefined;
  return { amount: Math.max(...modifiers.map(m => m.amount)), kind: modifiers[0]!.kind };
}

/** Field cards on the player's front line that also contribute energy. */
export function frontLineEnergyCards(state: GameState, player: PlayerId): CardId[] {
  const allFromFront = playerStatics(state, player).some(m => m.type === 'fieldGeneratesFromFront');
  return state.players[player].front
    .filter(card => allFromFront || activeStatics(state, card.cardId, player).some(m => m.type === 'generatesFromFront'))
    .map(card => card.cardId);
}

/**
 * The slots a player *produces* energy from: the energy line plus every front-line producer
 * (「フロントLにある場合もエナジーを発生させる」 / the player-scope broadcast of it) — the same set
 * `getEnergy` reads, so a 「発生エナジー」 count and the energy a use actually pays with never disagree.
 */
function energySourceSlots(state: GameState, player: PlayerId): GameState['players'][0]['energy'] {
  const allFromFront = playerStatics(state, player).some(m => m.type === 'fieldGeneratesFromFront');
  const out = [...state.players[player].energy];
  for (const card of state.players[player].front) {
    if (allFromFront || activeStatics(state, card.cardId, player).some(m => m.type === 'generatesFromFront')) out.push(card);
  }
  return out;
}

/**
 * A field card's current BP, including static and temporary modifiers.
 *
 * A local copy for the same reason as `getGeneratedEnergyFor`: `engine.ts` imports this module, so the
 * dependency cannot run the other way.
 */
export function currentBP(state: GameState, cardId: CardId, controller: PlayerId): number {
  const here = locate(state, controller, cardId);
  const field = here ? state.players[controller][here.line].find(c => c.cardId === cardId) : undefined;
  return (peekDefinition(state, cardId)?.bp ?? 0) + staticBp(state, cardId, controller)
    + (field?.bpModifiers.filter(m => m.expiresBattle === undefined || state.battle?.seq === m.expiresBattle).reduce((n, m) => n + m.amount, 0) ?? 0);
}

/**
 * Energy a single field card produces, including static bonuses. Imported lazily through this
 * local copy so `conditions.ts` keeps no runtime dependency on `engine.ts`.
 */
function getGeneratedEnergyFor(state: GameState, cardId: CardId, controller: PlayerId): Energy {
  const definition = peekDefinition(state, cardId);
  if (!definition) return {};
  const here = locate(state, controller, cardId);
  const field = here ? state.players[controller][here.line].find(c => c.cardId === cardId) : undefined;
  const result: Energy = { ...definition.generatedEnergy };
  const bonuses: Energy[] = [];
  if (field?.active && definition.activeEnergyBonus) bonuses.push(definition.activeEnergyBonus);
  const staticBonus = staticEnergyBonus(state, cardId, controller);
  if (Object.keys(staticBonus).length) bonuses.push(staticBonus);
  for (const modifier of field?.energyModifiers ?? []) if (modifier.expiresTurn >= state.turn) bonuses.push(modifier.energy);
  for (const bonus of bonuses) for (const color of COLORS) result[color] = (result[color] ?? 0) + (bonus[color] ?? 0);
  // The player-scope multiplication, mirroring `engine.ts#getGeneratedEnergy` so a condition reading a
  // card's production sees the same doubled value the energy line pays with.
  for (const modifier of playerStatics(state, controller)) {
    if (modifier.type !== 'energyGenMultiplier') continue;
    for (const color of COLORS) result[color] = (result[color] ?? 0) * modifier.factor;
  }
  return result;
}

/**
 * Everything a predicate may need beyond the authoritative state.
 *
 * Only `selectedHas` uses it: 「選んだキャラが〈X〉の場合」 asks about a card a *previous* `select` in
 * the same resolving effect bound, and that binding lives on the effect frame, not in the game state.
 * Passing nothing is always valid — a predicate evaluated outside a resolving effect simply has no
 * selection and `selectedHas` is false there.
 */
export interface ConditionContext {
  /** Line carried by the departure task; the source may already be absent or re-entered elsewhere. */
  departedLine?: Line;
  selections?: Record<string, CardId[]>;
  /**
   * 「相手は「手札に〈X〉がある。」か「…がない。」のどちらかを選ぶ。」 (FMA-1-096) — which claim the
   * opponent picked at the top of this resolution (`true` = "the hand has it"), for
   * `statementMatchesHand`.
   */
  statementChoice?: boolean;
  /** The cards the resolving effect just revealed, for `revealedHas`. */
  revealed?: CardId[];
  revealedFrom?: 'deck' | 'deckBottom' | 'under' | 'life' | 'hand';
  /**
   * Why a retirement is happening, for `retireCause` (「このキャラがバトルによって退場した場合」).
   *
   * The reason lives in the call that removed the card — a battle's loser going to 場外 reads
   * `'battle'` — and is handed over only while 退場時 abilities are being read.
   */
  retireReason?: string;
  activation?: 'effect' | 'ready-step' | 'rule';
  /**
   * The *card* whose effect ordered the retirement, for the qualified spellings of `retireCause`
   * (「自分の効果によって」「自分の〈憎普天〉の効果で」).
   *
   * The ordering effect's frame is the only place the cause card's identity survives: 場外, the
   * retiring card and the cause card are indistinguishable afterwards.
   */
  retireCauseId?: CardId;
  /**
   * The battle whose close is raising the watchers, for `battleDefender` on the `onAttackEnd`
   * channel: `endBattle` clears `state.battle` before the queue is raised (KMR-2-083 / Q1781), so
   * the condition falls back to this snapshot there.
   */
  battle?: NonNullable<GameState['battle']>;
  /** How many hand cards the resolving effect has made public, for `thisEffectRevealedHand`. */
  revealedHand?: number;
  /** 「必要エナジーを満たし」 — whether the chooser's produced energy covers a card, for `revealedHas.energySatisfied`. */
  energySatisfied?: (id: CardId) => boolean;
  /** How many of the resolving effect's own characters it has retired, for `thisEffectRetired`. */
  retiredOwn?: number;
  /** How many of the opponent's characters the resolving effect has retired. */
  retiredOpponent?: number;
  /**
   * The identities behind the counts above, for the qualified spelling
   * 「この効果で必要エナジーが0のキャラを退場させた場合」. The cards are already in 場外 by the time
   * the sentence is read, so the frame's record is the only place their identity survives.
   */
  retiredIdsOwn?: CardId[];
  retiredIdsOpponent?: CardId[];
  /**
   * The identities the resolving effect sent to 場外, for `thisEffectDiscardedKind`
   * (「この効果で場外に置いたカードの種類に応じて、…」).
   */
  discardedIds?: CardId[];
  /** How many characters the resolving effect has rested, for `thisEffectRested`. */
  restedThisEffect?: number;
  /**
   * The required-energy totals of the two cards the resolving effect's clash revealed, for
   * `clashCompare` (「自分の公開したカードの必要エナジーの数が相手の…以上だった場合」) — the reference
   * total each card's own deck-scoped 「として扱ってもよい」 replacement answers with (`requiredEnergyTotal`).
   */
  clashSelfEnergy?: number;
  clashOpponentEnergy?: number;
  /**
   * The identities the resolving effect sent to リムーブエリア, for `thisEffectRemoved`
   * (「この効果でBPが5000のキャラをリムーブエリアに置いた場合」). The same frame-fact channel as
   * `retiredIdsOwn`: the removal area cannot tell which cards this effect moved.
   */
  removedIds?: CardId[];
  /**
   * The identities the resolving effect put at the bottom of a deck, for
   * `thisEffectDeckBottomName` (「この効果で自分の山札の下に置いたキャラが〈X〉の場合」) — the same
   * frame-fact channel; a deck's bottom records nothing.
   */
  deckBottomIds?: CardId[];
  /** The printed required-energy *sum* over what the effect discarded, for the sibling condition. */
  discardedEnergySum?: number;
  /** The characters the resolving effect's BP penalties brought to 0 or below, for `thisEffectBpZero`. */
  bpZeroIds?: CardId[];
  /** How many cards the effect placed under a host from hand, for `thisEffectUnderFromHand`. */
  underFromHand?: number;
  /** Of those, how many went under the effect's own source, for `thisEffectUnderFromHandToSource`. */
  underFromHandToSource?: number;
  /**
   * How many cards the resolving effect's draws took from face-down tops, for `drewFaceDown`
   * (「この効果で表向きではないカードを引いた場合」).
   */
  drewFaceDown?: number;
  /** The numbers the resolving effect declared for itself (「この効果で指定した数」). */
  declared?: { energyCount?: number; trait?: string };
  /**
   * The raid stack the resolving task carried off the field (「…が手札に戻った時、このキャラのレイド元
   * のカードが…場外にある場合」). A task raised by a *departure* resolves after the card left the
   * field, where a live read of the stack finds nothing; the base then comes from the task.
   */
  raidBase?: CardId[];
}

/** Keywords a single field card currently has, printed plus granted. Mirrors `engine.ts#getKeywords`. */
function effectiveKeywordsFor(state: GameState, cardId: CardId, controller: PlayerId): Keywords {
  const definition = peekDefinition(state, cardId);
  const here = locate(state, controller, cardId);
  const field = here ? state.players[controller][here.line].find(c => c.cardId === cardId) : undefined;
  // 「【レイド】で囲まれた部分の効果は無効になります。」 (Q51) — the keywords a card prints inside its
  // ◆レイド fence are read only while it is stacked as a raid top card, the same gate `engine.getKeywords`
  // applies. Read off the slot like the `raid` filter flag, so a card off the field carries none of them.
  const fenced = (field?.underneath.length ?? 0) > 0 ? definition?.raidScopedKeywords : undefined;
  const merged: Keywords = { ...(definition?.keywords ?? {}), ...(fenced ?? {}), ...staticKeywords(state, cardId, controller) };
  if (!field) return merged;
  const bag = merged as Record<string, unknown>;
  for (const modifier of field?.keywordModifiers ?? []) {
    if (modifier.expiresTurn < state.turn) continue;
    for (const [key, value] of Object.entries(modifier.keywords)) {
      if (key === 'damage' || key === 'impact') bag[key] = Math.max(typeof bag[key] === 'number' ? bag[key] as number : 0, value as number);
      else if (value) bag[key] = true;
    }
  }
  return merged;
}

/**
 * 「選んだキャラが〜」 against the cards a previous `select` bound.
 *
 * A singular 「選んだキャラ」 in the printed text always follows a 「〜を1枚選び」, so with one bound
 * card every reading agrees. When the preceding selection took several cards the honest reading of
 * 「選んだキャラが〈X〉」 is "the characters you chose are 〈X〉", which is answered by requiring *all*
 * bound cards to match: that is the weaker claim, and a weaker reading is the safe one. An empty
 * binding is false — nothing was chosen, so nothing can be the chosen character.
 */
function selectedHasHolds(state: GameState, controller: PlayerId, sourceId: CardId, condition: Extract<Condition, { type: 'selectedHas' }>, ctx: ConditionContext | undefined): boolean {
  const ids = ctx?.selections?.[condition.bind ?? 'A'] ?? [];
  if (!ids.length) return false;
  return ids.every(id => {
    // 「選んだキャラがこのキャラ以外の場合」 — the source itself is excluded; a card that could not be
    // read at all never matches either way.
    if (condition.notSelf && id === sourceId) return false;
    // 「このキャラの効果でリムーブエリアに置かれた場合」 — the bound card *is* the effect's own source.
    if (condition.self && id !== sourceId) return false;
    const definition = peekDefinition(state, id);
    if (!definition) return false;
    // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — a bound card that has since
    // reached 場外 answers the kind test through the treatment.
    if (condition.kind && !answersKind(definition, condition.kind) && !(condition.kind === 'event' && sidelineAsEventTreated(state, id))) return false;
    if (condition.trait && !hasTrait(definition, condition.trait)) return false;
    if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, id)) return false;
    if (condition.name !== undefined || condition.names !== undefined || condition.nameContains !== undefined) {
      const names = effectiveNames(state, id, state.cards[id]?.owner ?? controller);
      if (condition.name !== undefined && !names.includes(condition.name)) return false;
      if (condition.names !== undefined && !condition.names.some(wanted => names.includes(wanted))) return false;
      if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
    }
    if (condition.raidAbility !== undefined && (definition.raid !== undefined) !== condition.raidAbility) return false;
    // 「手札から登場させた場合」 (KMR-1-022) — the bound card's own entry record; a card that is not on
    // the field (or entered by no route this record knows) has no entry to match.
    if (condition.enteredFrom !== undefined) {
      const owner = state.cards[id]?.owner ?? controller;
      const here = locate(state, owner, id);
      const entry = here ? state.players[owner][here.line].find(card => card.cardId === id)?.entered : undefined;
      if (entry?.from !== condition.enteredFrom) return false;
    }
    if (condition.keyword !== undefined) {
      const value = effectiveKeywordsFor(state, id, state.cards[id]?.owner ?? controller)[condition.keyword];
      const wanted = condition.keywordAmount ?? 1;
      const holds = condition.keyword === 'damage' || condition.keyword === 'impact'
        ? typeof value === 'number' && value >= wanted
        : value === true || (typeof value === 'number' && value > 0);
      if (holds !== (condition.hasKeyword ?? true)) return false;
    }
    const owner = state.cards[id]?.owner ?? controller;
    const here = locate(state, owner, id);
    // 「選んだキャラのBPがN以上の場合」 — the current BP, modifiers included, the same value the
    // field-count bounds read.
    if (condition.minBP !== undefined || condition.maxBP !== undefined) {
      const bp = currentBP(state, id, owner);
      if (condition.minBP !== undefined && bp < condition.minBP) return false;
      if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
    }
    if (condition.minEnergy !== undefined || condition.maxEnergy !== undefined || condition.energyEqualsDeclared) {
      const total = Object.values(effectiveRequiredEnergy(state, id)).reduce((sum, n) => sum + (n ?? 0), 0);
      if (condition.minEnergy !== undefined && total < condition.minEnergy) return false;
    if (condition.maxEnergy !== undefined && total > condition.maxEnergy) return false;
      // 「…の必要エナジーの数がこの効果で指定した数と同じだった場合」 — the announced number.
      if (condition.energyEqualsDeclared && ctx?.declared?.energyCount !== total) return false;
    }
    // 「選んだキャラの元々の消費APが2以上の場合」 — the printed AP cost, read the same way
    // `CardFilter.minApCost` / `Condition.fieldCount.minApCost` read it.
    if (condition.minApCost !== undefined || condition.maxApCost !== undefined) {
      const ap = definition.apCost ?? 0;
      if (condition.minApCost !== undefined && ap < condition.minApCost) return false;
      if (condition.maxApCost !== undefined && ap > condition.maxApCost) return false;
    }
    // 「そのカードと同じカード名を持つカードが自分の場になく」 (KJN-1-077) — the bound card's owner's
    // field holds no card sharing one of its effective names, the bound-card read of the same test
    // `CardFilter.nameNotInOwnField` makes about a candidate.
    if (condition.nameNotInOwnField === true) {
      const names = effectiveNames(state, id, owner);
      const fieldNames = new Set<string>();
      for (const slot of [...state.players[owner].front, ...state.players[owner].energy]) {
        for (const name of effectiveNames(state, slot.cardId, owner)) fieldNames.add(name);
      }
      if (names.some(name => fieldNames.has(name))) return false;
    }
    // 「［特徴：X］の効果で…を与えられている場合」 (KIN-1-051) — one of the named modifiers was installed
    // on the bound card by a live `grantStatic` grant whose recorded source traits include the printed
    // one. Expiry and battle scope are read the way every grant read applies them.
    if (condition.grantedByTrait !== undefined && condition.grantedModifiers?.length) {
      const slot = here ? state.players[owner][here.line].find(entry => entry.cardId === id) : undefined;
      const granted = (slot?.grantedStatics ?? []).some(grant => {
        if (grant.expiresTurn < state.turn) return false;
        if (grant.expiresBattle !== undefined && state.battle?.seq !== grant.expiresBattle) return false;
        const fromTrait = (grant.sourceTraits ?? []).some(trait =>
          trait === condition.grantedByTrait || traitName(trait) === traitName(condition.grantedByTrait!));
        if (!fromTrait) return false;
        return grant.abilities.some(ability => ability.modifiers.some(modifier =>
          condition.grantedModifiers!.includes(modifier.type as 'cannotAttack' | 'cannotBlock')));
      });
      if (!granted) return false;
    }
    // 「そのカードが必要エナジーを満たす」 (KJN-1-077) — the bound card's requirement against its owner's
    // produced energy, computed from the same pieces `selfEnergySatisfied` uses.
    if (condition.energySatisfied === true) {
      const allFromFront = playerStatics(state, owner).some(m => m.type === 'fieldGeneratesFromFront');
      const produced: Energy = {};
      const add = (cardId: CardId): void => {
        const generated = getGeneratedEnergyFor(state, cardId, owner);
        for (const color of COLORS) produced[color] = (produced[color] ?? 0) + (generated[color] ?? 0);
      };
      for (const slot of state.players[owner].energy) add(slot.cardId);
      for (const slot of state.players[owner].front) {
        if (allFromFront || activeStatics(state, slot.cardId, owner).some(m => m.type === 'generatesFromFront')) add(slot.cardId);
      }
      const required = effectiveRequiredEnergy(state, id);
      const meets = treatedAsAllColors(state, id)
        ? sumOf(produced) >= sumOf(required)
        : COLORS.every(color => (produced[color] ?? 0) >= (required[color] ?? 0));
      if (!meets) return false;
    }
    if (condition.zone !== undefined && here?.line !== condition.zone) return false;
    if (condition.rested !== undefined && (here?.active === true) === condition.rested) return false;
    if (condition.active !== undefined && here?.active !== condition.active) return false;
    // 「選んだキャラがこのターン中に移動フェイズ以外で移動している」 — the bound card's own move in the
    // turn log, excluding the movement phase's ordinary one (the phase the entry was recorded in).
    if (condition.movedNotByMovePhaseThisTurn && !(state.turnEvents ?? []).some(entry => entry.event === 'moved' && entry.cardId === id && entry.phase !== 'movement')) return false;
    if (condition.restedByEffectThisTurn !== undefined && restedByEffectThisTurn(state, id, controller) !== condition.restedByEffectThisTurn) return false;
    if (condition.raid !== undefined) {
      const field = here ? state.players[owner][here.line].find(c => c.cardId === id) : undefined;
      if (((field?.underneath.length ?? 0) > 0) !== condition.raid) return false;
    }
    // 「選んだキャラが〈シモン〉かレイド元が〈シモン〉のキャラの場合」 — the chosen card's raid base,
    // read through the same `effectiveNames` every other 〈X〉 test uses.
    if (condition.raidUnderName !== undefined || condition.raidUnderNames !== undefined) {
      const field = here ? state.players[owner][here.line].find(c => c.cardId === id) : undefined;
      const baseId = field?.underneath.at(-1);
      const baseNames = baseId === undefined ? [] : effectiveNames(state, baseId, owner);
      if (condition.raidUnderName !== undefined && !baseNames.includes(condition.raidUnderName)) return false;
      if (condition.raidUnderNames !== undefined && !condition.raidUnderNames.some(n => baseNames.includes(n))) return false;
    }
    // 「選んだキャラの下に裏向きのカードがある場合」 — the chosen card's own hidden stack, read off its
    // slot like every other `underCount` reader. A card that has left the field has no slot, so no
    // stack, which is the honest answer for 「…がある」.
    if (condition.underCount !== undefined) {
      const field = here ? state.players[owner][here.line].find(c => c.cardId === id) : undefined;
      const count = field?.faceDown?.length ?? 0;
      if (condition.underCount.min !== undefined && count < condition.underCount.min) return false;
      if (condition.underCount.max !== undefined && count > condition.underCount.max) return false;
    }
    // 「選んだキャラのBPが5000以上になった場合」 — the *current* BP, so the grants the same effect just
    // applied are part of the answer (the sentence is printed after them).
    if (condition.minBP !== undefined || condition.maxBP !== undefined) {
      const bp = currentBP(state, id, owner);
      if (condition.minBP !== undefined && bp < condition.minBP) return false;
      if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
    }
    return true;
  });
}

/**
 * 「〜が自分の効果で登場していた」 / 「…から登場していた」 against the recorded entry.
 *
 * Without `who` the subject is the effect source; with it, the question is whether *any* of that
 * player's field cards entered that way, which is what 「このターン中に自分のキャラが…登場している」
 * asks. A card with no record never entered through the paths that write one, so every clause of the
 * predicate is false for it — the honest reading of "we do not know how this got here".
 */
function enteredViaHolds(state: GameState, controller: PlayerId, sourceId: CardId, condition: Extract<Condition, { type: 'enteredVia' }>): boolean {
  const matches = (cardId: CardId, owner: PlayerId): boolean => {
    const here = locate(state, owner, cardId);
    const entry = here ? state.players[owner][here.line].find(c => c.cardId === cardId)?.entered : undefined;
    if (!entry) return false;
    if (condition.from !== undefined && entry.from !== condition.from) return false;
    if (condition.by !== undefined && entry.by !== condition.by) return false;
    if (condition.ownEffect !== undefined && (entry.causeOwner === undefined || (entry.causeOwner === controller) !== condition.ownEffect)) return false;
    // 「自分の〔キャラ・フィールド〕の効果で登場していた場合」 — which *kind* of card's effect placed it.
    // Only effect placements record a cause kind, so a played card never matches a byKind clause.
    if (condition.byKind !== undefined && (entry.causeKind === undefined || !condition.byKind.includes(entry.causeKind))) return false;
    // 「〈メモリチェンジ〉の効果で登場していた」 (KMR-2-048/054/057) — the placing effect's source *name*.
    if (condition.causeName !== undefined && entry.causeName !== condition.causeName) return false;
    if (condition.thisTurn && entry.turn !== state.turn) return false;
    // 「キャラカードが…登場している」 — the kind is read from the placed card, so a フィールド put on the
    // energy line by the same route is not a character entering.
    if (condition.kind !== undefined && !answersKind(peekDefinition(state, cardId), condition.kind)) return false;
    if (condition.raid !== undefined && (entry.raid === true) !== condition.raid) return false;
    // 「〈影山 飛雄〉が登場している」 — the *subject* narrows which entrance counts, read through the
    // card's effective names like every other name test.
    if (condition.name !== undefined || condition.nameContains !== undefined) {
      const names = effectiveNames(state, cardId, owner);
      if (condition.name !== undefined && !names.includes(condition.name)) return false;
      if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
    }
    return true;
  };
  if (condition.who === undefined) return matches(sourceId, state.cards[sourceId]?.owner ?? controller);
  const player = resolveScope(controller, condition.who);
  return [...state.players[player].front, ...state.players[player].energy].some(card => matches(card.cardId, player));
}

/**
 * 「このターン中に…した」 — counts what the turn's log recorded, optionally narrowed to one card.
 *
 * `self` asks about the effect source's own events (「このキャラが移動している」); otherwise the
 * question is about a *player* (「自分の場のキャラが退場している」), and `who` picks whose — the
 * controller's by default, which is what a wording that names nobody means.
 *
 * The `kind` / `color` / `trait` filters read the definition of the card the event names, so
 * 「自分のキャラの効果でAPを支払っている」 is this predicate with `kind: 'character'` rather than a
 * second mechanism.
 */
export function restedByEffectThisTurn(state: GameState, id: CardId, controller?: PlayerId): boolean {
  // The printed phrasing this flag comes from is always 「**自分の効果で**アクティブからレストになった」
  // (DST-P-003, NGR-1-010, TKG-1-094): with a controller given, the entry's own cause owner must be that
  // player — an opponent's effect resting the card does not satisfy it.
  return (state.turnEvents ?? []).some(entry => entry.event === 'restedByEffect' && entry.cardId === id
    && (controller === undefined || entry.causeOwner === controller));
}

/** 「このターン中に登場した」 — the turn log recorded this card's entrance (NIK-1-077, CGH-1-094). */
export function enteredThisTurn(state: GameState, id: CardId): boolean {
  return (state.turnEvents ?? []).some(entry => entry.event === 'entered' && entry.cardId === id);
}

function turnEventHolds(state: GameState, controller: PlayerId, sourceId: CardId, condition: Extract<Condition, { type: 'turnEvent' }>, ctx?: ConditionContext): boolean {
  if (condition.event === 'activatedByEffect' && ctx?.activation !== undefined) {
    if (ctx.activation !== 'effect') return false;
  }
  const log = state.turnEvents ?? [];
  const min = condition.min ?? (condition.max !== undefined ? 0 : 1);
  const max = condition.max ?? Infinity;
  // 「このターン中に自分がカードを4枚以上引いている」 — the *card* total beside the entry total, hoisted to
  // the same head for the same reason as `min`/`max` above. `causeNameContains` is hoisted with it, for
  // that same reason: the wiring scan reads only the function's head, and both predicates are consulted
  // at the loop below.
  const cardCount = condition.cardCount;
  const causeNameContains = condition.causeNameContains;
  // 「異なるカード名の…が3種類以上登場している」 (MMM-2-027 族) — the same matching entries counted on
  // their *names* rather than one apiece. The set is filled at the loop's tail, where every entry filter
  // has already passed; the bounds that replace `min`/`max` live on `distinctNames` itself.
  const distinct = condition.distinctNames;
  const distinctSeen = new Set<string>();
  // `who: 'both'` has no single owner to resolve — the entry loop keeps every player's entries.
  const player = condition.self ? (state.cards[sourceId]?.owner ?? controller)
    : condition.who === 'both' ? undefined
    : resolveScope(controller, condition.who ?? 'self');
  let total = 0;
  // 「このターン中に自分がカードを4枚以上引いている」 — the *card* total beside the entry total: a draw of
  // four cards is one entry, so the two readings are different questions over the same log.
  let cards = 0;
  for (const entry of log) {
    if (entry.event !== condition.event) continue;
    if (condition.cause !== undefined && entry.cause !== condition.cause) continue;
    // 「自分の移動フェイズ以外で…移動した」 / 「アタックフェイズ中に…移動した」 — the phase the entry was
    // recorded in is part of the fact, so both spellings read the record rather than the current phase.
    // The phase is the *subject's own turn's* phase: 「自分のメインフェイズ中」 must not open on the
    // opponent's main phase (MCR-2-022/054), and 「自分の移動フェイズ以外」 must not swallow an
    // own-card move made during the opponent's movement phase. The entry carries the active player
    // beside the phase (logTurnEvent) for exactly this comparison.
    if (condition.notPhase !== undefined && entry.phase === condition.notPhase && entry.activePlayer === entry.player) continue;
    if (condition.phase !== undefined && (entry.phase !== condition.phase || entry.activePlayer !== entry.player)) continue;
    // 「このターン中に自分のフロントLのキャラが…レストになった」 — the line the card was on *when the
    // event happened*, recorded with the event so a later move cannot change the answer.
    if (condition.line !== undefined && entry.line !== condition.line) continue;
    // 「エナジーLからフロントLに移動した」 — the line the card reached, the other half of the direction.
    if (condition.toLine !== undefined && entry.to !== condition.toLine) continue;
    // 「APを支払わずに使用している」 — whether the use paid its printed cost is part of the fact.
    if (condition.free !== undefined && (entry.free ?? false) !== condition.free) continue;
    // 「[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) — whether the activation behind the
    // entry carried the AP-cost tag, recorded with it. A distinct field from `apCost`, which filters the
    // entry's *card* by its printed cost.
    if (condition.activatedApCost !== undefined && (entry.apCost ?? false) !== condition.activatedApCost) continue;
    // 「このターン中に自分の効果で自分の場にキャラが登場している」 — the arrival route recorded with the
    // entry. Entries that wrote none were played as cards, so absence reads as `'play'` (the same
    // default `FieldCard.entered.by` gives a played card).
    if (condition.via !== undefined && (entry.via ?? 'play') !== condition.via) continue;
    // 「自分の効果で手札から登場している」 — the origin zone of the placement. An entry that recorded
    // none has an unknown origin and satisfies no named zone.
    if (condition.from !== undefined && entry.from !== condition.from) continue;
    // 「このターン中に…レイドしている」 — whether the entry was a RAID is part of the fact.
    if (condition.raid !== undefined && (entry.raid ?? false) !== condition.raid) continue;
    // 「このターン中に自分の効果で…している」 — whose effect raised the entry. Records without a cause
    // (rule-driven ones) match neither spelling of this qualifier.
    if (condition.ownEffect !== undefined && (entry.causeOwner !== undefined && entry.causeOwner === player) !== condition.ownEffect) continue;
    // 「このターン中に自分か相手の効果で自分か相手が…」 (SYN-1-048) — raised by *an effect* of either
    // player, the spelling `ownEffect` cannot say (it resolves to one owner). Read off the record's own
    // `causeOwner` presence: cost-driven entries recorded none and are exactly what the qualifier excludes.
    if (condition.byEffect !== undefined && (entry.causeOwner !== undefined) !== condition.byEffect) continue;
    // 「自分のリムーブエリアから使用されている」 — the zone the use started from, recorded with it.
    if (condition.usedFrom !== undefined && (entry.usedFrom ?? 'hand') !== condition.usedFrom) continue;
    if (condition.self) {
      if (entry.cardId !== sourceId) continue;
    } else if (condition.who === 'both') {
      // 「キャラが2枚以上退場」 — no owner named, so both players' entries count toward one threshold.
    } else {
      if (entry.player !== player) continue;
      // 「他のキャラが…した」 — every event of mine *except* this card's own. `self: true` asks the
      // opposite question (did *this* card act), so the two cannot share a flag.
      if (condition.excludeSelf && entry.cardId === sourceId) continue;
    }
    if (condition.kind !== undefined || condition.color !== undefined || condition.notColor !== undefined || condition.raidAbility !== undefined || condition.trait !== undefined || condition.name !== undefined || condition.nameContains !== undefined || condition.nameContainsAny !== undefined || condition.apCost !== undefined || condition.printedBP !== undefined || condition.printedEnergy !== undefined || condition.triggerType !== undefined) {
      // An event that names no card cannot satisfy a card filter: absence of evidence is not a match.
      if (entry.cardId === undefined) continue;
      const definition = peekDefinition(state, entry.cardId);
      if (!definition) continue;
      // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — a logged card now in 場外
      // answers the kind test through the treatment.
      if (condition.kind !== undefined && !answersKind(definition, condition.kind) && !(condition.kind === 'event' && sidelineAsEventTreated(state, entry.cardId))) continue;
      if (condition.color !== undefined && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, entry.cardId)) continue;
      // 「黄以外のカード」 — the exclusion spelled out, read off the same colour keys `color` reads.
      if (condition.notColor !== undefined && (Object.hasOwn(definition.requiredEnergy, condition.notColor) || treatedAsAllColors(state, entry.cardId))) continue;
      // 「[レイド]を持つ黄以外のカード」 — the *printed* RAID ability, the same read `selectedHas.raidAbility`
      // gives it (distinct from `raid`, which asks whether the entry itself was a raid).
      if (condition.raidAbility !== undefined && (definition.raid !== undefined) !== condition.raidAbility) continue;
      if (condition.trait !== undefined && !hasTrait(definition, condition.trait)) continue;
      // 「このターン中に消費APが2のカードを使用している」 — the printed price of the card that was used.
      // 「消費APが2の」 is an exact price; the object spelling is the bounded 「元々の消費APが2以上の」,
      // read against the same printed value.
      if (condition.apCost !== undefined) {
        const bound = typeof condition.apCost === 'number' ? { min: condition.apCost, max: condition.apCost } : condition.apCost;
        if (bound.min !== undefined && definition.apCost < bound.min) continue;
        if (bound.max !== undefined && definition.apCost > bound.max) continue;
      }
      // 「[ゲット]を持つキャラが登場している」 — the printed trigger, read from the definition for the
      // same reason as `printedBP`: the entered card may already have left the field.
      if (condition.triggerType !== undefined && definition.trigger?.type !== condition.triggerType) continue;
      // 「元々のBPが…」 — the printed value, read from the definition because the card itself is gone.
      if (condition.printedBP !== undefined) {
        const bp = definition.bp;
        if (bp === undefined) continue;
        if (condition.printedBP.min !== undefined && bp < condition.printedBP.min) continue;
        if (condition.printedBP.max !== undefined && bp > condition.printedBP.max) continue;
      }
      // 「元々の必要エナジーが6以上」 — the printed requirement total, read the same way (`printedBP`'s
      // sibling): the used card may already be anywhere, so the definition is the only source.
      if (condition.printedEnergy !== undefined) {
        const total = Object.values(definition.requiredEnergy).reduce((sum, n) => sum + (n ?? 0), 0);
        if (condition.printedEnergy.min !== undefined && total < condition.printedEnergy.min) continue;
        if (condition.printedEnergy.max !== undefined && total > condition.printedEnergy.max) continue;
      }
      // A name is read through the card's *effective* names, so an 〈alias〉 granted by a static counts.
      if (condition.name !== undefined || condition.nameContains !== undefined || condition.nameContainsAny !== undefined) {
        const names = effectiveNames(state, entry.cardId, entry.player);
        if (condition.name !== undefined && !names.includes(condition.name)) continue;
        if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) continue;
        // 「「オーズ」か「バース」を含む」 — the any-of spelling; one matching fragment satisfies the union.
        if (condition.nameContainsAny !== undefined && !names.some(name => condition.nameContainsAny!.some(fragment => name.includes(fragment)))) continue;
      }
    }
    // 「カード名に「オーズ」を含むキャラの効果で…」 — the printed qualifier names the effect's *source
    // card*, which the entry recorded as its cause; entries raised by no effect have no cause to read.
    if (causeNameContains !== undefined) {
      if (entry.causeId === undefined) continue;
      const names = effectiveNames(state, entry.causeId, entry.player);
      if (!names.some(name => name.includes(causeNameContains))) continue;
    }
    // 「自分のキャラの効果で…」 — the *kind* of the effect's source card, read off the same `causeId`.
    if (condition.causeKind !== undefined) {
      if (entry.causeId === undefined || peekDefinition(state, entry.causeId)?.kind !== condition.causeKind) continue;
    }
    // 「自分のイベントカードか〈煉獄 杏寿郎〉の効果で…」 — one matching alternative satisfies the union;
    // each reads the same `causeId` the single-alternative spellings above use.
    if (condition.causeAnyOf !== undefined) {
      if (entry.causeId === undefined) continue;
      const causeDefinition = peekDefinition(state, entry.causeId);
      const causeNames = effectiveNames(state, entry.causeId, entry.player);
      if (!condition.causeAnyOf.some(alt =>
        (alt.kind === undefined || causeDefinition?.kind === alt.kind)
        && (alt.name === undefined || causeNames.includes(alt.name))
        && (alt.nameContains === undefined || causeNames.some(name => name.includes(alt.nameContains!))))) continue;
    }
    // 「この**このキャラの**…によってキャラが退場している」 — the cause card is this condition's own
    // source. The entry is written only by the effect route, so a rule-driven retirement has no cause to
    // match (which is the printed distinction).
    if (condition.causeSelf && entry.causeId !== sourceId) continue;
    total++;
    cards += entry.count ?? 1;
    // The distinct-name axis reads the *printed* name of whatever card the entry names — the same axis
    // `distinctNames` counts on. An entry that names no card contributes nothing to it.
    if (distinct !== undefined && entry.cardId !== undefined) {
      const definition = peekDefinition(state, entry.cardId);
      if (definition) distinctSeen.add(definition.name);
    }
  }
  if (distinct !== undefined) {
    // An absent lower bound means 「一度でもあった」 unless a ceiling is printed, the same default the
    // entry bounds above take.
    const lo = distinct.min ?? (distinct.max !== undefined ? 0 : 1);
    const hi = distinct.max ?? Infinity;
    return distinctSeen.size >= lo && distinctSeen.size <= hi;
  }
  if (cardCount !== undefined) {
    const lo = cardCount.min ?? 0;
    const hi = cardCount.max ?? Infinity;
    // A card-total predicate reads the cards alone: 「カードを4枚以上引いている」 says nothing about how
    // many times the draw happened, so the entry bounds are not applied on top of it.
    return cards >= lo && cards <= hi;
  }
  return total >= min && total <= max;
}

/** Declarative predicates only; no implicit assumptions about timing or visibility. */
export function evalCondition(state: GameState, sourceId: CardId, controller: PlayerId, condition: Condition, ctx?: ConditionContext): boolean {
  const located = (): { line: Line; active: boolean } | undefined => locate(state, controller, sourceId);
  switch (condition.type) {
    case 'lineHasSpace': {
      const who = resolveScope(controller, condition.who);
      return state.players[who][condition.line].length < lineCapacity(state, who, condition.line);
    }
    case 'turnOf': {
      // 「[自分のターン中]の効果を失わせる」 (RNK-1-072/089) — while the suppression lasts, the tag itself
      // is switched off for the card carrying the ability, which is exactly what losing the *tagged*
      // effects means. Two carriers: the card's own slot flag (the targeted operation) and a
      // player-scope broadcast whose subject names the card (「自分の場の〈X〉全ては…失う。」).
      if (condition.who === 'self') {
        const owner = state.cards[sourceId]?.owner;
        const here = owner === undefined ? undefined : locate(state, owner, sourceId);
        const until = here ? state.players[owner!][here.line].find(card => card.cardId === sourceId)?.selfTurnEffectsLostUntilTurn : undefined;
        if (until !== undefined && state.turn <= until) return false;
        if (owner !== undefined) {
          const names = effectiveNames(state, sourceId, owner);
          for (const modifier of playerStatics(state, owner)) {
            if (modifier.type !== 'selfTurnEffectsLost') continue;
            if (modifier.names === undefined || modifier.names.some(name => names.includes(name))) return false;
          }
        }
      }
      return resolveScope(controller, condition.who) === state.activePlayer;
    }
    case 'line': return located()?.line === condition.line;
    case 'atZone': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      const here = locate(state, owner, sourceId);
      if (condition.zone === 'front') return here?.line === 'front';
      if (condition.zone === 'energy') return here?.line === 'energy';
      return here === undefined;
    }
    case 'isActive': case 'selfActive': return located()?.active === true;
    case 'isRested': case 'selfRested': return located()?.active === false;
    // 「レイド状態」 (Q51) — the source is stacked as a raid top card. Read from its own slot like the
    // `raid` filter flag, so a card off the field (hand, 場外, リムーブエリア) answers false — unless
    // the resolving task carries the departure stack (`ConditionContext.raidBase`, recorded when a
    // returned card's replay asks after it left the field: MGS-1-046 × MGS-1-101, Q1644), which stands
    // in for the slot that is gone.
    case 'raidState': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      const here = locate(state, owner, sourceId);
      const slot = here ? state.players[owner][here.line].find(card => card.cardId === sourceId) : undefined;
      return (slot?.underneath.length ?? 0) > 0 || (ctx?.raidBase?.length ?? 0) > 0;
    }
    case 'hasName': {
      const player = resolveScope(controller, condition.who);
      return [...state.players[player].front, ...state.players[player].energy]
        .some(c => effectiveNames(state, c.cardId, player).includes(condition.name));
    }
    case 'hasNameContains': {
      const player = resolveScope(controller, condition.who);
      return [...state.players[player].front, ...state.players[player].energy]
        .some(c => effectiveNames(state, c.cardId, player).some(n => n.includes(condition.fragment)));
    }
    case 'hasTrait': {
      const player = resolveScope(controller, condition.who);
      return [...state.players[player].front, ...state.players[player].energy]
        .some(c => hasTrait(peekDefinition(state, c.cardId), condition.trait));
    }
    case 'fieldAll': {
      const player = resolveScope(controller, condition.who);
      // The line is optional: 「自分の場のキャラが全て…」 covers both lines, while 「自分のフロントLの
      // キャラが全て…」 names one. An empty zone is *not* vacuously true — the print describes the
      // characters the controller has, so "all of them" with none of them says nothing.
      const wide = condition.line
        ? state.players[player][condition.line]
        : [...state.players[player].front, ...state.players[player].energy];
      // 「…キャラが全て…」 names the *characters* of the zone: the compiled filter's `kind` is the
      // subject selector, applied before the `every` predicate. A non-character field card sharing the
      // zone must not fail "all of them" (MMM-1-036's ほむらの武器); a 「…カードが全て…」 subject
      // carries no kind and keeps the whole zone.
      const pool = condition.filter.kind
        ? wide.filter(entry => { const d = peekDefinition(state, entry.cardId); return d !== undefined && answersKind(d, condition.filter.kind!); })
        : wide;
      if (!pool.length) return false;
      // The filter subset the compiler may emit for this node (`unreadQualifier` refuses the rest), read
      // inline: importing `matchesFilter` from `effects.ts` would close the cycle
      // `effects → conditions`, which the two modules already keep open in one direction only.
      return pool.every(card => {
        const d = peekDefinition(state, card.cardId);
        if (!d) return false;
        if (condition.filter.kind && !answersKind(d, condition.filter.kind)) return false;
        if (condition.filter.color && !Object.hasOwn(d.requiredEnergy, condition.filter.color) && !treatedAsAllColors(state, card.cardId)) return false;
        if (condition.filter.trait && !hasTrait(d, condition.filter.trait)) return false;
        if (condition.filter.notTrait && hasTrait(d, condition.filter.notTrait)) return false;
        // 「自分の場にあるキャラが全て特徴を持たない場合」 (REZ-1-020) — every one of them prints no
        // traits at all; the same reading `matchesFilter` gives the field.
        if (condition.filter.noTraits && (d.traits?.length ?? 0) > 0) return false;
        // Names are read through `effectiveNames` — the settled rule for every 〈X〉 test — so a card that
        // counts as 〈X〉 through an alias satisfies 「全て〈X〉」 the same way it satisfies `hasName`. The
        // printed name alone left such a card failing a gate the print opens (a 〈悪魔ほむら〉 that is also
        // 〈暁美 ほむら〉 did not count as 暁美 ほむら).
        const names = effectiveNames(state, card.cardId, player);
        if (condition.filter.name !== undefined && !names.includes(condition.filter.name)) return false;
        if (condition.filter.names?.length && !condition.filter.names.some(n => names.includes(n))) return false;
        if (condition.filter.nameContains !== undefined && !names.some(n => n.includes(condition.filter.nameContains!))) return false;
        return true;
      });
    }
    case 'fieldCount': {
      const player = resolveScope(controller, condition.who);
      // 「同じラインに〈X〉がある」 reads the line the effect source currently occupies: the phrase names
      // no line of its own, and the same card prints it whether it sits on the front or energy line.
      // 「このキャラと別のラインに〈X〉がある」 is the mirror relation: the pool is the *other* line, and
      // a source that has left the field has no line, so no candidate matches.
      const sourceHere = condition.sameLine || condition.differentLine
        ? locate(state, state.cards[sourceId]?.owner ?? controller, sourceId)
        : undefined;
      const sourceLine = ctx?.departedLine ?? sourceHere?.line;
      const wide = condition.sameLine
        ? (sourceLine ? state.players[player][sourceLine] : [])
        : condition.differentLine
          ? (sourceLine ? state.players[player][sourceLine === 'front' ? 'energy' : 'front'] : [])
          : condition.line ? state.players[player][condition.line] : [...state.players[player].front, ...state.players[player].energy];
      // 「このキャラのBPが元々のBPより低い」 (SAO-2-053) — the subject is the *effect source itself*
      // (for a granted ability, the card it was granted to), not whichever card of the line happens to
      // be debuffed. Without the narrowing the gate opened on any debuffed card of the player's field.
      const pool = condition.self ? wide.filter(card => card.cardId === sourceId) : wide;
      // Names are matched against the card's *effective* names, the same set `hasName` /
      // `hasNameContains` read, so a line-scoped presence and a zone-wide one agree on 〈alias〉.
      const wanted = condition.name;
      const wantedFragment = condition.nameContains;
      const excludedFragment = condition.notNameContains;
      const matched = pool.filter(card => {
        const definition = peekDefinition(state, card.cardId);
        if (!definition) return false;
        // 「BPが5000以上の〔カード名に「X」を含むキャラか〈Y〉〕」 — a union of subjects inside the
        // count: any branch admits the card, the enclosing bounds below still apply on top.
        if (condition.anyOf?.length) {
          const byBranch = condition.anyOf.some(branch => {
            if (branch.kind && !answersKind(definition, branch.kind)) return false;
            if (branch.color && !Object.hasOwn(definition.requiredEnergy, branch.color) && !treatedAsAllColors(state, card.cardId)) return false;
            if (branch.notColor && (Object.hasOwn(definition.requiredEnergy, branch.notColor) || treatedAsAllColors(state, card.cardId))) return false;
            if (branch.trait && !hasTrait(definition, branch.trait)) return false;
            if (branch.notTrait && hasTrait(definition, branch.notTrait)) return false;
            const names = effectiveNames(state, card.cardId, player);
            if (branch.name !== undefined && !names.includes(branch.name)) return false;
            if (branch.names !== undefined && !branch.names.some(n => names.includes(n))) return false;
            if (branch.nameContains !== undefined && !names.some(n => n.includes(branch.nameContains!))) return false;
            if (branch.notNames !== undefined && names.some(n => branch.notNames!.includes(n))) return false;
            // 「〔[アタック時]を持つキャラか[ブロック時]を持つキャラ〕」 — a branch's own printed-ability
            // test, read like the flat fields above.
            if (branch.attackAbility !== undefined && printsAbility(definition, 'onAttack', state, card.cardId) !== branch.attackAbility) return false;
            if (branch.blockAbility !== undefined && printsAbility(definition, 'onBlock', state, card.cardId) !== branch.blockAbility) return false;
            if (branch.hasActivated !== undefined && (definition.activated !== undefined) !== branch.hasActivated) return false;
            // 「他の」 on a branch excludes the effect source, exactly as it does on the flat filter.
            if (branch.other && card.cardId === sourceId) return false;
            return true;
          });
          if (!byBranch) return false;
        }
        if (condition.kind && !answersKind(definition, condition.kind)) return false;
        if (condition.trait && !hasTrait(definition, condition.trait)) return false;
        // 「…が3枚以上あり、その中に〈X〉がある」 (AND-1-010) — a name *among* the counted subject: it
        // reads in addition to the trait (never as the union `names` makes), so a card that is not the
        // trait but bears the name does not count.
        if (condition.namedAmong?.length && !condition.namedAmong.some(name => effectiveNames(state, card.cardId, player).includes(name))) return false;
        // 「特徴を持つカード」 (RNK-1-040) — the bare existence test: the card prints at least one trait.
        if (condition.traitPresent !== undefined && ((definition.traits?.length ?? 0) > 0) !== condition.traitPresent) return false;
        if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, card.cardId)) return false;
        if (condition.notTrait && hasTrait(definition, condition.notTrait)) return false;
        // 「「X」以外の特徴」 — a trait other than the named one; a traitless card does not match.
        if (condition.traitOtherThan !== undefined && !(definition.traits ?? []).some(trait => trait !== condition.traitOtherThan)) return false;
        if (condition.notColor && (Object.hasOwn(definition.requiredEnergy, condition.notColor) || treatedAsAllColors(state, card.cardId))) return false;
        if (condition.names?.length || condition.traits?.length) {
          const names = effectiveNames(state, card.cardId, player);
          const byName = (condition.names ?? []).some(name => names.includes(name));
          const byTrait = (condition.traits ?? []).some(trait => hasTrait(definition, trait));
          if (!byName && !byTrait) return false;
        }
        if (wanted !== undefined || wantedFragment !== undefined || excludedFragment !== undefined) {
          const names = effectiveNames(state, card.cardId, player);
          if (wanted !== undefined && !names.includes(wanted)) return false;
          if (wantedFragment !== undefined && !names.some(n => n.includes(wantedFragment))) return false;
          if (excludedFragment !== undefined && names.some(n => n.includes(excludedFragment))) return false;
        }
        if (condition.notNames?.length) {
          const names = effectiveNames(state, card.cardId, player);
          if (names.some(name => condition.notNames!.includes(name))) return false;
        }
        if (condition.other && card.cardId === sourceId) return false;
        // 「BP N 以上のキャラがある」 reads the *current* BP, including modifiers — the same value a
        // selection filter would use, so a condition and a filter never disagree about the same card.
        if (condition.minBP !== undefined || condition.maxBP !== undefined) {
          const bp = currentBP(state, card.cardId, player);
          if (condition.minBP !== undefined && bp < condition.minBP) return false;
          if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
        }
        // 「元々のBP」 reads what the card prints, ignoring everything the board has done to it.
        if (condition.printedBP) {
          const printed = definition.bp;
          if (printed === undefined) return false;
          if (condition.printedBP.min !== undefined && printed < condition.printedBP.min) return false;
          if (condition.printedBP.max !== undefined && printed > condition.printedBP.max) return false;
        }
        // 「元々の消費APが N 以上」 — the printed AP cost, read exactly where `CardFilter.minApCost` reads
        // it (`definition.apCost`, which no modifier moves).
        if (condition.minApCost !== undefined || condition.maxApCost !== undefined) {
          const ap = definition.apCost ?? 0;
          if (condition.minApCost !== undefined && ap < condition.minApCost) return false;
          if (condition.maxApCost !== undefined && ap > condition.maxApCost) return false;
        }
        // 「元々の消費AP」 — the printed sibling of minApCost/maxApCost (Q1122), read like printedBP above.
        if (condition.printedApCost) {
          const ap = definition.apCost ?? 0;
          if (condition.printedApCost.min !== undefined && ap < condition.printedApCost.min) return false;
          if (condition.printedApCost.max !== undefined && ap > condition.printedApCost.max) return false;
        }
        if (condition.raid !== undefined && ((card.underneath.length > 0) !== condition.raid)) return false;
        // 「[2回ブロック]を持つカードがある」 — the *effective* keyword set, so a granted keyword counts
        // the same way a printed one does.
        if (condition.hasKeyword !== undefined && !effectiveKeywordsFor(state, card.cardId, player)[condition.hasKeyword]) return false;
        // 「[インパクト]か[ダメージ]を持つ」 — the any-of list reads the same effective keyword set.
        if (condition.hasKeywords !== undefined) {
          const held = effectiveKeywordsFor(state, card.cardId, player);
          if (!condition.hasKeywords.some(keyword => held[keyword])) return false;
        }
        // 「[トリガー]を持たないカードが N 枚以上ある」 — the *printed* trigger, not the effective
        // keyword set: a トリガー is a card-text field and is never granted or removed by other effects.
        if (condition.hasTrigger !== undefined && (definition.trigger !== undefined) !== condition.hasTrigger) return false;
        // 「[レイド]を持つキャラ」 — the *printed* RAID ability, the same read `selectedHas.raidAbility`
        // makes. Not `condition.raid`, which asks whether the slot is stacked on a base.
        if (condition.raidAbility !== undefined && (definition.raid !== undefined) !== condition.raidAbility) return false;
        // 「[アタック時]を持つキャラ」 — the printed triggered ability, the same predicate the filter
        // readers make, so a count and a filter never disagree about one card.
        if (condition.attackAbility !== undefined && printsAbility(definition, 'onAttack', state, card.cardId) !== condition.attackAbility) return false;
        if (condition.blockAbility !== undefined && printsAbility(definition, 'onBlock', state, card.cardId) !== condition.blockAbility) return false;
        if (condition.hasActivated !== undefined && (definition.activated !== undefined) !== condition.hasActivated) return false;
        // 「元々のBPよりBPが低いキャラがある」 — a comparison between the printed value and the current
        // one, both taken from the same card.
        if (condition.bpBelowPrinted && currentBP(state, card.cardId, player) >= (definition.bp ?? 0)) return false;
        // 「このキャラのBPが元々のBPより高い」 — the strict mirror: the current BP must *exceed* the
        // printed one, so equal BP satisfies neither reading.
        if (condition.bpAbovePrinted && currentBP(state, card.cardId, player) <= (definition.bp ?? 0)) return false;
        // 「…1枚レストにしないとこのカードは使用できない」 (JJK-1-063, Q1244) — a character granted
        // 「自身のカードの効果でレストにできない」 cannot pay this use's rest price, so it is not a payer
        // for the count either. Read with the same `refusesRest(ownEffect=true)` gate `act rest` applies
        // at execution (the cause is the effect source), so the gate and the payment can never disagree.
        if (condition.restable && refusesRest(state, card.cardId, player, true, sourceId)) return false;
        // 「レストのキャラ」「アクティブのキャラ」 — the slot's state, read exactly as `TierCount` reads
        // it, so a threshold and a condition never disagree.
        if (condition.rested !== undefined && card.active === condition.rested) return false;
        if (condition.active !== undefined && card.active !== condition.active) return false;
        // 「このカードと同じカードナンバーのカード」 (FMA-1-079) — the printed number (`functionalId`)
        // compared against the effect source's; the pool narrows to the matching cards so the printed
        // 「無い」 reads as `max: 0` over exactly them.
        if (condition.noSameCardNumber) {
          const selfNumber = peekDefinition(state, sourceId)?.functionalId;
          if (selfNumber === undefined || definition.functionalId !== selfNumber) return false;
        }
        // 「…の下に裏向きのカードがある」 — the counted card's own hidden stack, the same `faceDown`
        // pile `CardFilter.underCount` reads.
        if (condition.underCount) {
          const hidden = card.faceDown?.length ?? 0;
          if (condition.underCount.min !== undefined && hidden < condition.underCount.min) return false;
          if (condition.underCount.max !== undefined && hidden > condition.underCount.max) return false;
        }
        // 「必要エナジーが N のキャラ」 compares the *total* symbols, the same quantity the deck's energy
        // payment counts.
        if (condition.minEnergy !== undefined || condition.maxEnergy !== undefined) {
          const total = Object.values(effectiveRequiredEnergy(state, card.cardId)).reduce((sum, n) => sum + (n ?? 0), 0);
          if (condition.minEnergy !== undefined && total < condition.minEnergy) return false;
          if (condition.maxEnergy !== undefined && total > condition.maxEnergy) return false;
        }
        return true;
      });
      let total = matched.length;
      for (const card of matched) total += countWeightBonus(state, card, player, [condition.trait, ...(condition.traits ?? [])]);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'fieldCountCompare': {
      // 「自分のフロントLのキャラの数が相手のフロントLのキャラの数以上」 — the two sides are counted by
      // the same reader (kind and slot state), so a gate and a count never disagree about one card.
      const countSide = (player: PlayerId, side: { line?: Line; rested?: boolean; active?: boolean }): number => {
        const pool = side.line ? state.players[player][side.line] : [...state.players[player].front, ...state.players[player].energy];
        return pool.filter(card => {
          const definition = peekDefinition(state, card.cardId);
          if (!definition) return false;
          if (condition.kind && !answersKind(definition, condition.kind)) return false;
          if (side.rested !== undefined && card.active === side.rested) return false;
          if (side.active !== undefined && card.active !== side.active) return false;
          return true;
        }).length;
      };
      const mine = countSide(controller, condition.left);
      const theirs = countSide(otherOf(controller), condition.right);
      if (condition.op === 'atLeast') return mine >= theirs;
      if (condition.op === 'more') return mine > theirs;
      if (condition.op === 'atMost') return mine <= theirs;
      return mine < theirs;
    }
    case 'handCount': {
      const player = resolveScope(controller, condition.who);
      const hand = state.players[player].hand;
      // 「自分の手札が他に2枚以上ある」 — the source itself does not count; while the gate is read the
      // card sits in the hand being played, and the printed 「他に」 is exactly that exclusion.
      let held = condition.other && hand.includes(sourceId) ? hand.filter(id => id !== sourceId) : hand;
      // 「自分の手札の[A]か[B]を1枚場外に置く」 (GNT-1-043) — the count reads only the cards the printed
      // discard would take, so the branch gate and the discard can never disagree about the pool. The
      // matcher is `definitionMatchesSubset` (importing `matchesFilter` would close the
      // effects → conditions cycle); a printed 〔A か B〕 union rides its `anyOf` branches, and the
      // remaining fields still apply on top of the union.
      if (condition.filter) {
        const { anyOf, ...rest } = condition.filter;
        held = held.filter(id => {
          const holder = state.cards[id]?.owner ?? player;
          if (anyOf?.length && !anyOf.some(sub => definitionMatchesSubset(state, id, holder, sub))) return false;
          return definitionMatchesSubset(state, id, holder, rest);
        });
      }
      const total = held.length;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'revealedPlusField': {
      // 「自分の場と手札から公開した[特徴：X]が合計N枚以上ある場合」 — the field's matching cards plus the
      // hand cards the play being priced revealed. The field half is public by nature; the hand half
      // lives on the player for exactly as long as the pricing needs it.
      const revealed = state.players[controller].revealedHandAtUse ?? [];
      const onField = [...state.players[controller].front, ...state.players[controller].energy]
        .filter(c => hasTrait(peekDefinition(state, c.cardId), condition.trait)).length;
      const inHand = revealed.filter(id => hasTrait(peekDefinition(state, id), condition.trait)).length;
      return onField + inHand >= condition.min;
    }
    case 'revealedTraitNames': {
      const player = resolveScope(controller, condition.who ?? 'self');
      const names = new Set<string>();
      for (const line of ['front', 'energy'] as const) {
        for (const card of state.players[player][line]) {
          const definition = peekDefinition(state, card.cardId);
          if (!definition || !hasTrait(definition, condition.trait)) continue;
          for (const name of countedUnlistedNames(definition, effectiveNames(state, card.cardId, player))) names.add(name);
        }
      }
      for (const id of ctx?.selections?.__revealed ?? []) {
        const definition = peekDefinition(state, id);
        if (!definition || !hasTrait(definition, condition.trait)) continue;
        for (const name of countedUnlistedNames(definition, effectiveNames(state, id, state.cards[id]?.owner ?? player))) names.add(name);
      }
      return (condition.min === undefined || names.size >= condition.min)
        && (condition.max === undefined || names.size <= condition.max);
    }
    case 'lifeCount': {
      const total = state.players[resolveScope(controller, condition.who)].life.length;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'lifeSum': {
      // 「自分と相手のライフの合計」 — one total over both life areas, which is what the printed subject
      // names whichever player the ability belongs to.
      const total = state.players[0].life.length + state.players[1].life.length;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'raidUnderEnergy': {
      // The base directly beneath the source — the card this raid covered. A card with no base (not in
      // raid state) has no 「レイド元」 to speak about, so the comparison is false for it either way:
      // reading a total of zero instead made every 「…N以下」 spelling true for a card that had none.
      const here = locate(state, controller, sourceId);
      const field = here ? state.players[controller][here.line].find(c => c.cardId === sourceId) : undefined;
      const liveBase = field?.underneath.at(-1);
      const base = liveBase ?? ctx?.raidBase?.at(-1);
      if (base === undefined) return false;
      const definition = peekDefinition(state, base);
      if (!definition) return false;
      const total = liveBase !== undefined
        ? Object.values(effectiveRequiredEnergy(state, base)).reduce((sum, value) => sum + (value ?? 0), 0)
        : Object.values(definition.requiredEnergy).reduce((sum, value) => sum + (value ?? 0), 0);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'raidUnderTrait': {
      // The same base, read for the trait it prints. No base means no trait, so the predicate is false
      // for a card that is not in raid state.
      const here = locate(state, controller, sourceId);
      const field = here ? state.players[controller][here.line].find(c => c.cardId === sourceId) : undefined;
      const base = field?.underneath.at(-1);
      const definition = base ? peekDefinition(state, base) : undefined;
      return definition !== undefined && hasTrait(definition, condition.trait);
    }
    case 'raidUnderBp': {
      // The same base, read for its BP (「このキャラがレイドする際のレイド元のBPが4000以上だった場合」).
      // The printed value: the base is underneath, not a slot of its own, so no slot modifiers apply to
      // it — the same reading `raidUnderEnergy` gives the required energy.
      const here = locate(state, controller, sourceId);
      const field = here ? state.players[controller][here.line].find(c => c.cardId === sourceId) : undefined;
      const base = field?.underneath.at(-1);
      const definition = base ? peekDefinition(state, base) : undefined;
      if (!definition) return false;
      const bp = definition.bp ?? 0;
      return (condition.min === undefined || bp >= condition.min) && (condition.max === undefined || bp <= condition.max);
    }
    case 'raidUnderName': {
      // 「このキャラのレイド元が〈X〉の場合」 (no `who`) reads the effect source's own base; with `who`
      // it asks whether *any* of that player's field characters carries such a base — the second half
      // of 「自分の場か自分のキャラのレイド元に」, whose first half is an ordinary `fieldCount`.
      const matchesBase = (baseId: CardId, owner: PlayerId): boolean => {
        const definition = peekDefinition(state, baseId);
        if (!definition) return false;
        if (condition.name !== undefined || condition.names !== undefined || condition.nameContains !== undefined) {
          const names = effectiveNames(state, baseId, owner);
          if (condition.name !== undefined && !names.includes(condition.name)) return false;
          if (condition.names !== undefined && !condition.names.some(n => names.includes(n))) return false;
          if (condition.nameContains !== undefined && !names.some(n => n.includes(condition.nameContains!))) return false;
        }
        return true;
      };
      if (condition.who === undefined) {
        const here = locate(state, controller, sourceId);
        const field = here ? state.players[controller][here.line].find(c => c.cardId === sourceId) : undefined;
        const base = field?.underneath.at(-1) ?? ctx?.raidBase?.at(-1);
        return base !== undefined && matchesBase(base, controller);
      }
      const player = resolveScope(controller, condition.who);
      return [...state.players[player].front, ...state.players[player].energy]
        .some(slot => slot.underneath.length > 0 && matchesBase(slot.underneath.at(-1)!, player));
    }
    case 'energyCount': {
      const total = state.players[resolveScope(controller, condition.who)].energy.length;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'sidelineCount': {
      const player = resolveScope(controller, condition.who);
      // 「自分の場外とリムーブエリアに…合計 N 枚以上ある」 — one pool over the two piles, read like
      // `TierCount.sum`'s sideline+removal pair so a gate and a count can never disagree.
      const pool = condition.alsoRemoval
        ? [...state.players[player].sideline, ...state.players[player].removal]
        : state.players[player].sideline;
      const total = pool.filter(id => {
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        // 「自分の場外に**他の**イベントカードが6枚以上ある場合」 (REZ-1-032) — the source card itself
        // drops out of the pile.
        if (condition.other && id === sourceId) return false;
        // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — the treatment widens the
        // gate's kind test.
        if (condition.kind && !answersKind(definition, condition.kind) && !(condition.kind === 'event' && sidelineAsEventTreated(state, id))) return false;
        if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, id)) return false;
        if (condition.trait && !hasTrait(definition, condition.trait)) return false;
        if (condition.traits?.length && !condition.traits.some(trait => hasTrait(definition, trait))) return false;
        // 「［特徴：X］以外の…」 — the exclusion the sibling `trait` cannot express. Emitted by the tier
        // readers; without a reader here the count ran over the very cards the print excludes.
        if (condition.notTrait && hasTrait(definition, condition.notTrait)) return false;
        // 「特徴を持たないキャラカード」 — a card that prints no traits at all, the same predicate
        // `CardFilter.noTraits` reads.
        if (condition.noTraits && (definition.traits?.length ?? 0) > 0) return false;
        // 「自分の場外にある消費APが2で特徴を持つカードの枚数」 (KMR-1-001) — the printed price and the
        // presence of any trait at all, the gate half of the tier count's own fields.
        if (condition.apCost !== undefined && definition.apCost !== condition.apCost) return false;
        if (condition.hasTrait && (definition.traits?.length ?? 0) === 0) return false;
        // 「[レイド]を持つ〈X〉」 — the *printed* RAID ability, read from the same `CardDefinition.raid`
        // the filter predicate and the field count read.
        if (condition.raidAbility !== undefined && (definition.raid !== undefined) !== condition.raidAbility) return false;
        // Names are read the same way `fieldCount` reads them — through the *effective* names, so a
        // 〈alias〉 counts (and is excluded) in 場外 too. The comment said so while the code compared the
        // printed name: Q2077's 〈ボム〉-as-〈レゼ〉 in the discard pile failed its own gate (CSM-1-016).
        const names = effectiveNames(state, id, player);
        if (condition.name !== undefined && !names.includes(condition.name)) return false;
        if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
        if (condition.names?.length && !condition.names.some(name => names.includes(name))) return false;
        if (condition.name !== undefined || condition.names?.length) {
          const matched = [condition.name, ...(condition.names ?? [])]
            .filter((name): name is string => name !== undefined && names.includes(name));
          if (dropsFromCharacterNameAxis(state, definition, matched)) return false;
        }
        // 「…が〈X〉のみ」 — the named cards drop out of the count, mirroring `fieldCount.notNames`.
        if (condition.notNames?.length && condition.notNames.some(name => names.includes(name))) return false;
        // 「場外にBP4000以上のキャラカードがある」 — a card in the discard pile has no modifiers, so its
        // printed BP *is* its BP.
        if (condition.minBP !== undefined && (definition.bp ?? 0) < condition.minBP) return false;
        if (condition.maxBP !== undefined && (definition.bp ?? 0) > condition.maxBP) return false;
        // 「[スペシャルトリガー]を持つカード」 — the printed trigger kind, read from the same definition
        // field `CardFilter.triggerType` reads.
        if (condition.triggerType !== undefined && definition.trigger?.type !== condition.triggerType) return false;
        return true;
      }).length
        // 「自分の効果で自分の場外にあるイベントカードの枚数を参照する場合、その枚数は1枚多くあるものと
        // して扱う。」 (MMM-2-007, Q2346) — the printed +1 reaches the *gates* too; read only for the
        // controller's own side and the plain event-card count, like the tier-source sibling above.
        + (player === controller && plainEventCount(condition) ? sidelineEventBonus(state, player) : 0);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'removalCount': {
      const player = resolveScope(controller, condition.who);
      const total = state.players[player].removal.filter(id => {
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        if (condition.kind && !answersKind(definition, condition.kind)) return false;
        // 「…に〈X〉がある場合」 — the named subject narrows the pile like every other named count, on
        // the effective names (an 〈alias〉 answers here the way `sidelineCount` reads it, Q2077).
        const names = effectiveNames(state, id, player);
        if (condition.name !== undefined && !names.includes(condition.name)) return false;
        if (condition.names !== undefined && !condition.names.some(name => names.includes(name))) return false;
        if (condition.name !== undefined || condition.names?.length) {
          const matched = [condition.name, ...(condition.names ?? [])]
            .filter((name): name is string => name !== undefined && names.includes(name));
          if (dropsFromCharacterNameAxis(state, definition, matched)) return false;
        }
        return true;
      }).length;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'distinctNames': {
      const player = resolveScope(controller, condition.who);
      // 場外 holds instance ids; the lines hold `FieldCard`s. Both resolve through `peekDefinition`.
      const line = (name: 'front' | 'energy'): string[] => state.players[player][name].map(card => card.cardId);
      const ids = condition.zone === 'sideline' ? [...state.players[player].sideline]
        : condition.zone === 'removal' ? [...state.players[player].removal]
        : condition.zone === 'front' ? line('front')
        : condition.zone === 'energy' ? line('energy')
        : condition.zone === 'fieldOrSideline' ? [...line('front'), ...line('energy'), ...state.players[player].sideline]
        : [...line('front'), ...line('energy')];
      const names = new Set<string>();
      for (const id of ids) {
        // 「このカード以外の…」 — the effect source's own name does not count.
        if (condition.other && id === sourceId) continue;
        const definition = peekDefinition(state, id);
        if (!definition) continue;
        // 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — the treatment widens the
        // distinct-name pool's kind test too (its name then counts as an event card's).
        if (condition.kind && !answersKind(definition, condition.kind) && !(condition.kind === 'event' && sidelineAsEventTreated(state, id))) continue;
        if (condition.trait && !hasTrait(definition, condition.trait)) continue;
        if (condition.notTrait && hasTrait(definition, condition.notTrait)) continue;
        if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, id)) continue;
        const effective = effectiveNames(state, id, player);
        if (condition.nameContains && !effective.some(name => name.includes(condition.nameContains!))) continue;
        // 「〈A〉、〈B〉、〈C〉のカード名の種類の数」 — only the *listed* names count, answered through the
        // effective names (Q512/Q516's alias counts, one card one count per Q470). Without the list
        // check the predicate read every distinct name on the board, so the gate opened on any three
        // differently named characters and the card kept abilities the print only grants for that trio.
        if (condition.names?.length && !condition.names.some(name => effective.includes(name))) continue;
        // 「〈X〉以外の…」 — the named cards are excluded from the count.
        if (condition.notNames?.length && condition.notNames.some(name => effective.includes(name))) continue;
        // 「〔イベントカードとフィールドカード〕」 (BLC-4-069) — a union of kinds counted in one pool.
        if (condition.kinds?.length && !condition.kinds.includes(definition.kind) && !(condition.kinds.includes('event') && sidelineAsEventTreated(state, id))) continue;
        if (condition.by === 'energy') {
          names.add(COLORS.map(c => definition.requiredEnergy[c] ?? 0).join('/'));
        } else if (condition.names?.length) {
          for (const name of condition.names) if (effective.includes(name)) names.add(name);
        } else {
          for (const name of countedUnlistedNames(definition, effective)) names.add(name);
        }
      }
      const total = names.size;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'sidelineEnergyVariety': {
      // 「自分の場外にあるカードの必要エナジーの数が N 種類以上ある場合」 — distinct required-energy
      // totals in the sideline, grouped the way `energySignature` groups them (positive rows only, so
      // every 「[色-]」 card shares the one empty signature). A card's own signature-replacement statics
      // are read here: 「全ての場所で…としても扱う」 reaches the discard pile by its own wording, and
      // 「自分の効果で場外に置くこのカードの…」 (KMR-2-026) names it outright.
      const player = resolveScope(controller, condition.who);
      const kinds = new Set<string>();
      for (const id of state.players[player].sideline) {
        const definition = peekDefinition(state, id);
        if (!definition) continue;
        const override = ownStaticsOf(state, id, player).find(
          (m): m is Extract<StaticModifier, { type: 'energyCostSetInSideline' | 'energyCostSetAll' }> =>
            m.type === 'energyCostSetInSideline' || m.type === 'energyCostSetAll',
        );
        kinds.add(Object.entries(override?.energy ?? definition.requiredEnergy)
          .filter(([, n]) => (n ?? 0) > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([color, n]) => `${color}${n}`).join(','));
      }
      return (condition.min === undefined || kinds.size >= condition.min)
        && (condition.max === undefined || kinds.size <= condition.max);
    }
    case 'distinctTraits': {
      // 「自分の場の他のカードに、「高校」を含む異なる特徴が3種類以上ある場合」 — distinct *traits*
      // (not cards: a card printing two matching traits contributes two) carrying the printed fragment.
      // The pool is the controller's whole field, both lines, read through the definitions.
      const player = resolveScope(controller, condition.who);
      const traits = new Set<string>();
      for (const card of [...state.players[player].front, ...state.players[player].energy]) {
        if (condition.other && card.cardId === sourceId) continue;
        const definition = peekDefinition(state, card.cardId);
        // 「自分の場の黄のカードの特徴が3種類以上」 — one printed colour narrows the pool, read exactly
        // where `Condition.fieldCount.color` reads it (a required-energy symbol).
        if (condition.color !== undefined && (!definition || (!Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, card.cardId)))) continue;
        // 「自分の場のキャラの特徴が3種類以上」 (IMS family) — the print names characters: a field card's
        // traits (they print some) are in the pool for 「カード」 spellings only. Read through the same
        // identity predicate `fieldCount.kind` uses, so alsoKinds answers here too.
        if (condition.kind && !answersKind(definition, condition.kind)) continue;
        for (const trait of definition?.traits ?? []) {
          if (condition.traitContains !== undefined && !trait.includes(condition.traitContains)) continue;
          traits.add(trait);
        }
      }
      const total = traits.size;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'producedEnergy': {
      const player = resolveScope(controller, condition.who);
      const total = energySourceSlots(state, player).reduce((sum, card) => {
        const generated = getGeneratedEnergyFor(state, card.cardId, player);
        // 「自分の青のエナジーが4以上」 — one colour's produced symbols rather than the whole line.
        if (condition.color !== undefined) return sum + (generated[condition.color] ?? 0);
        return sum + Object.values(generated).reduce((a, b) => a + (b ?? 0), 0);
      }, 0);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'selfBp': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      const here = locate(state, owner, sourceId);
      if (!here) return false;
      // `withStatics` reads the BP the table shows, including continuous bonuses: a tier list gated on
      // 「このキャラのBPにより」 has to see the card's own 「N枚につき BP+…」 bonus, or a card whose
      // size comes from that bonus could never reach its own thresholds. The default stays the narrow
      // read, which is the one that cannot re-enter the modifier it gates.
      const value = condition.withStatics
        ? currentBP(state, sourceId, owner)
        : (peekDefinition(state, sourceId)?.bp ?? 0) + state.players[owner][here.line].find(c => c.cardId === sourceId)!.bpModifiers.filter(m => m.expiresBattle === undefined || state.battle?.seq === m.expiresBattle).reduce((n, m) => n + m.amount, 0);
      return (condition.min === undefined || value >= condition.min) && (condition.max === undefined || value <= condition.max);
    }
    // 「このキャラが[インパクト]を持つ場合のみ発動できる」 — the source's own effective keyword set,
    // the same read the field-count branch gives each card.
    case 'selfHasKeyword': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      return effectiveKeywordsFor(state, sourceId, owner)[condition.keyword] !== undefined;
    }
    case 'underCount': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      let total = 0;
      if (condition.all) {
        // 「自分の場のキャラの下に裏向きのカードがない」 counts every character's hidden stack, not the
        // source's own — the two questions differ on a board with several hosts.
        const player = resolveScope(controller, condition.who ?? 'self');
        for (const line of ['front', 'energy'] as const) {
          for (const card of state.players[player][line]) total += card.faceDown?.length ?? 0;
        }
      } else if (condition.printedBP) {
        // 「このキャラの下に元々のBPが3000以上のカードがある場合」 — the subject is a *card in the
        // stack*, so both halves count: the raid bases (`underneath`) and the face-down pile. The bound
        // is the printed BP, the same value every other `printedBP` reader takes.
        const here = locate(state, owner, sourceId);
        const holder = here ? state.players[owner][here.line].find(c => c.cardId === sourceId) : undefined;
        for (const id of [...(holder?.underneath ?? []), ...(holder?.faceDown ?? [])]) {
          const bp = peekDefinition(state, id)?.bp;
          if (bp === undefined) continue;
          if (condition.printedBP.min !== undefined && bp < condition.printedBP.min) continue;
          if (condition.printedBP.max !== undefined && bp > condition.printedBP.max) continue;
          total++;
        }
      } else if (condition.names?.length) {
        // 「このキャラの下に〈定春〉がある場合」 (GNT-1-086) — a *named* card in the source's own stack.
        // Both halves are searched, the same pool `printedBP` counts, and the name is read through
        // `effectiveNames` so a granted alias counts.
        const here = locate(state, owner, sourceId);
        const holder = here ? state.players[owner][here.line].find(c => c.cardId === sourceId) : undefined;
        for (const id of [...(holder?.underneath ?? []), ...(holder?.faceDown ?? [])]) {
          const names = effectiveNames(state, id, owner);
          if (names.some(name => condition.names!.includes(name))) total++;
        }
      } else {
        const here = locate(state, owner, sourceId);
        total = here ? (state.players[owner][here.line].find(c => c.cardId === sourceId)?.faceDown?.length ?? 0) : 0;
      }
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    // 「…と…が合計 N 枚以上ある」 — each part read by the same `tierCountOf`, so a gate and any count
    // printed beside it can never disagree.
    case 'countSum': {
      let total = 0;
      for (const part of condition.counts) total += tierCountOf(state, controller, sourceId, part, ctx?.departedLine);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'fieldEnergySum': {
      // 「自分の場のキャラの必要エナジーの合計がN以上」 — every colour value on the card's effective
      // signature, summed over the controller's characters on both lines (the same pool 「自分の場の
      // キャラ」 names everywhere else).
      const player = resolveScope(controller, condition.who);
      let total = 0;
      for (const line of ['front', 'energy'] as const) {
        for (const card of state.players[player][line]) {
          const definition = peekDefinition(state, card.cardId);
          if (!definition || definition.kind !== 'character') continue;
          for (const value of Object.values(effectiveRequiredEnergy(state, card.cardId))) total += value ?? 0;
        }
      }
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'eventsUsedThisTurn': {
      // 「このターン中に自分が使用しているイベントカードの枚数により」 — the same counter the tier count
      // reads, so a threshold and a count can never disagree.
      const total = state.players[resolveScope(controller, condition.who)].eventsUsedThisTurn ?? 0;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'usedEventThisTurn': {
      // 「…**他の**イベントカードを使用している」 — the source drops out by identity, so the question is
      // read from the turn log (the counter holds no identity). A used card's kind comes off its
      // definition, the same read the use *count*'s `other` form makes.
      if (condition.other) {
        return (state.turnEvents ?? []).some(entry =>
          entry.event === 'used' && entry.player === controller && entry.cardId !== undefined && entry.cardId !== sourceId
          && answersKind(peekDefinition(state, entry.cardId), 'event'));
      }
      return (state.players[controller].eventsUsedThisTurn ?? 0) > 0;
    }
    // 「自分の手札の枚数が相手より少ない」 — the two hands compared; the strict spellings shift by one.
    case 'handCountCompare': {
      const mine = state.players[controller].hand.length;
      const theirs = state.players[otherOf(controller)].hand.length;
      switch (condition.op) {
        case 'lt': return mine < theirs;
        case 'gt': return mine > theirs;
        case 'le': return mine <= theirs;
        case 'ge': return mine >= theirs;
        case 'eq': return mine === theirs;
      }
    }
    // 「この効果で手札を公開した場合」 — counted on the resolving frame; outside one there is no
    // "this effect" and the answer is no.
    case 'thisEffectRevealedHand': return (ctx?.revealedHand ?? 0) >= (condition.min ?? 1);
    case 'thisEffectRetired': {
      const ids = condition.who === 'opponent' ? ctx?.retiredIdsOpponent : ctx?.retiredIdsOwn;
      // 「この効果で必要エナジーが0のキャラを退場させた場合」 — the printed qualifier narrows *which*
      // retirements count, so the frame's identity record is read rather than the plain count. A
      // context that carries no ids (an older call path) answers with the count only when no qualifier
      // is printed — a filtered question cannot be answered from a bare number.
      if (condition.maxEnergy !== undefined || condition.minEnergy !== undefined) {
        return (ids ?? []).some(id => {
          const definition = peekDefinition(state, id);
          if (!definition) return false;
          const total = retiredRequiredEnergyTotal(state, id);
          if (condition.maxEnergy !== undefined && total > condition.maxEnergy) return false;
          if (condition.minEnergy !== undefined && total < condition.minEnergy) return false;
          return true;
        });
      }
      const count = condition.who === 'opponent' ? (ctx?.retiredOpponent ?? 0)
        : condition.who === 'both' ? (ctx?.retiredOwn ?? 0) + (ctx?.retiredOpponent ?? 0)
        : (ctx?.retiredOwn ?? 0);
      if (count < (condition.min ?? 1)) return false;
      return condition.max === undefined || count <= condition.max;
    }
    case 'thisEffectDiscardedKind': {
      // 「・キャラカード：…」 — the bullet fires when the effect's own discard sent at least one card of
      // that kind away. Read against the frame's discard record; the kinds follow `alsoKinds` the same
      // way every other kind test does (a card that counts as an event counts here too).
      return (ctx?.discardedIds ?? []).some(id => {
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        return definition.kind === condition.kind || (definition.alsoKinds ?? []).includes(condition.kind);
      });
    }
    // 「この効果で〈アウロラ〉を場外に置いた場合」 (KJN-1-014) — the named narrowing of the same discard
    // record: one of the cards this effect sent to 場外 printed that name.
    case 'thisEffectDiscardedName':
      return (ctx?.discardedIds ?? []).some(id => peekDefinition(state, id)?.name === condition.name);
    // 「この効果で自分の山札の下に置いたキャラが〈メフィスト〉の場合」 (ARK-1-019) — the named
    // narrowing of the frame's deck-bottom record, the deck sibling of the discard check above.
    case 'thisEffectDeckBottomName':
      return (ctx?.deckBottomIds ?? []).some(id => peekDefinition(state, id)?.name === condition.name);
    // 「この効果でキャラを2枚以上レストにしていた場合」 — the frame's own restings, the same frame-fact
    // channel as `thisEffectRetired`; outside a resolving effect there is no "this effect" and the answer
    // is no.
    case 'thisEffectRested': return (ctx?.restedThisEffect ?? 0) >= (condition.min ?? 1);
    case 'thisEffectRemoved': {
      // 「この効果でBPが5000のキャラをリムーブエリアに置いた場合」 — one of the cards this effect moved
      // into the removal area carried that BP. Outside a resolving effect there is no "this effect".
      return (ctx?.removedIds ?? []).some(id => {
        const definition = peekDefinition(state, id);
        if (!definition || definition.kind !== 'character' || definition.bp === undefined) return false;
        if (condition.minBP !== undefined && definition.bp < condition.minBP) return false;
        if (condition.maxBP !== undefined && definition.bp > condition.maxBP) return false;
        // 「この移動によって相手のキャラがリムーブエリアに置かれていない場合」 (JJK-3-012) — the printed
        // side, read from the removed card's owner.
        if (condition.who !== undefined) {
          const owner = state.cards[id]?.owner;
          if (owner === undefined || owner !== resolveScope(controller, condition.who)) return false;
        }
        return true;
      });
    }
    // 「この効果で相手のキャラのBPが0以下になった場合」 — one of the characters this effect's own
    // penalties brought to 0 or below. `who` names the printed side; without it either side counts.
    case 'thisEffectBpZero': {
      const ids = ctx?.bpZeroIds ?? [];
      if (ids.length === 0) return false;
      return ids.some(id => {
        const owner = state.cards[id]?.owner;
        if (owner === undefined) return false;
        return condition.who === undefined || owner === resolveScope(controller, condition.who);
      });
    }
    case 'thisEffectDiscardedEnergySum': {
      const total = ctx?.discardedEnergySum ?? 0;
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'thisEffectUnderFromHand': return (ctx?.underFromHand ?? 0) >= (condition.min ?? 1);
    case 'thisEffectUnderFromHandToSource': return (ctx?.underFromHandToSource ?? 0) >= (condition.min ?? 1);
    // 「この効果で表向きではないカードを引いた場合」 — a fact about the draw this effect performed, read
    // from the frame the same way the 「この効果で…した」 family is.
    case 'drewFaceDown': return (ctx?.drewFaceDown ?? 0) >= 1;
    case 'faceUpCount': {
      // 「…山札かライフに表向きのカードがある場合」 — the deck counts only its public top (the card the
      // mark names, while it is still on top); every life slot counts its own flag. `who: 'both'` sums the
      // two players, which is what 「自分と相手の…に合計N枚」 asks.
      const zones = condition.zones ?? ['deck', 'life'];
      const countOf = (player: PlayerId): number => {
        const p = state.players[player];
        let n = 0;
        if (zones.includes('deck') && p.deck[0] !== undefined && p.deckTopFaceUp === p.deck[0]) n++;
        if (zones.includes('life')) n += p.life.filter((_, i) => p.lifeFaceUp?.[i] === true).length;
        return n;
      };
      const total = condition.who === 'both' || condition.who === undefined
        ? countOf(0) + countOf(1)
        : countOf(resolveScope(controller, condition.who));
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'turnEvent': return turnEventHolds(state, controller, sourceId, condition, ctx);
    case 'deckCount': {
      const count = state.players[resolveScope(controller, condition.who)].deck.length;
      return (condition.min === undefined || count >= condition.min) && (condition.max === undefined || count <= condition.max);
    }
    case 'energyCountCompare': {
      // 「発生エナジーの数」 — the symbols each side produces right now. Read through the same statics the
      // engine's own `getEnergy` folds in (a front-line production only counts under 「フロントLにある
      // 場合もエナジーを発生させる」), inlined here because the engine module imports this one.
      const totalOf = (player: PlayerId): number => {
        const sum = (id: CardId): number => Object.values(getGeneratedEnergyFor(state, id, player)).reduce((acc: number, n) => acc + (n ?? 0), 0);
        const allFromFront = playerStatics(state, player).some(m => m.type === 'fieldGeneratesFromFront');
        let total = 0;
        for (const field of state.players[player].energy) total += sum(field.cardId);
        for (const field of state.players[player].front) {
          if (!allFromFront && !activeStatics(state, field.cardId, player).some(m => m.type === 'generatesFromFront')) continue;
          total += sum(field.cardId);
        }
        return total;
      };
      const mine = totalOf(controller);
      const theirs = totalOf(otherOf(controller));
      if (condition.op === 'eq') return mine === theirs;
      return condition.op === 'gt' ? mine > theirs : mine < theirs;
    }
    case 'inBattle': {
      const battle = state.battle;
      if (!battle) return false;
      return battle.attackerId === sourceId || battle.blockerId === sourceId || battle.targetId === sourceId;
    }
    case 'isRaidState': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      const here = locate(state, owner, sourceId);
      const card = here ? state.players[owner][here.line].find(c => c.cardId === sourceId) : undefined;
      return (card?.underneath.length ?? 0) > 0;
    }
    case 'selfApCost': {
      const value = peekDefinition(state, sourceId)?.apCost ?? 0;
      return (condition.min === undefined || value >= condition.min) && (condition.max === undefined || value <= condition.max);
    }
    // 「このキャラの必要エナジーが5以上」 — the source's own printed requirement total, totalled like
    // `fieldCount.minEnergy` (an on-field replacement included).
    case 'selfRequirement': {
      const total = Object.values(effectiveRequiredEnergy(state, sourceId)).reduce((sum, n) => sum + (n ?? 0), 0);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    case 'selectedHas': return selectedHasHolds(state, controller, sourceId, condition, ctx);
    // 「合計2枚選んだ場合」 — the bindings live on the resolving frame, so the count is zero outside one.
    case 'selectionCount': {
      const total = condition.binds.reduce((sum, bind) => sum + (ctx?.selections?.[bind]?.length ?? 0), 0);
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    // 「このカードが必要エナジーを満たしている場合」 (AND-1-046) — the source's own requirement against its
    // controller's produced energy, computed from the same pieces the `producedEnergy` gate uses (front
    // producers included). The engine-core `energySatisfied` cannot be called here: `conditions` never
    // imports `engine`.
    case 'selfEnergySatisfied': {
      const owner = state.cards[sourceId]?.owner ?? controller;
      const allFromFront = playerStatics(state, owner).some(m => m.type === 'fieldGeneratesFromFront');
      const produced: Energy = {};
      const add = (id: CardId): void => {
        const generated = getGeneratedEnergyFor(state, id, owner);
        for (const color of COLORS) produced[color] = (produced[color] ?? 0) + (generated[color] ?? 0);
      };
      for (const slot of state.players[owner].energy) add(slot.cardId);
      for (const slot of state.players[owner].front) {
        if (allFromFront || activeStatics(state, slot.cardId, owner).some(m => m.type === 'generatesFromFront')) add(slot.cardId);
      }
      const required = effectiveRequiredEnergy(state, sourceId);
      if (treatedAsAllColors(state, sourceId)) return sumOf(produced) >= sumOf(required);
      return COLORS.every(color => (produced[color] ?? 0) >= (required[color] ?? 0));
    }
    // 「「APを1支払い、…」をしてもよい」 (KGD-1-044/061 族) — the chooser's own AP gate, read with the same
    // payer and the same active-AP count the `payAp` step spends.
    case 'selfApAvailable':
      return state.players[controller].ap.filter(ap => ap === 'active').length >= Math.max(1, condition.count ?? 1);
    // 「この効果で選んだキャラの必要エナジーの合計が4以上の場合」 (MGS-1-094) — the summed *requirement
    // total* over the bound picks, read through the same `effectiveRequiredEnergy` every count uses so a
    // 「としても扱う」 replacement counts at its replacement value.
    case 'selectionEnergySum': {
      let total = 0;
      for (const bind of condition.binds) {
        for (const id of ctx?.selections?.[bind] ?? []) {
          total += Object.values(effectiveRequiredEnergy(state, id)).reduce((sum, n) => sum + (n ?? 0), 0);
        }
      }
      return (condition.min === undefined || total >= condition.min) && (condition.max === undefined || total <= condition.max);
    }
    // 「選んだキャラのカード名が同じ場合」 — the two bound cards share a name, read through
    // `effectiveNames` like every other 〈X〉 test (an alias counts). Both sides must hold a card: a
    // declined selection has no name to compare, and the printed gate then does not hold.
    case 'boundSameName': {
      const left = ctx?.selections?.[condition.a] ?? [];
      const right = ctx?.selections?.[condition.b] ?? [];
      if (!left.length || !right.length) return false;
      const namesOf = (id: CardId) => effectiveNames(state, id, state.cards[id]?.owner ?? controller);
      const leftNames = new Set(left.flatMap(namesOf));
      return right.some(id => namesOf(id).some(name => leftNames.has(name)));
    }
    case 'enteredVia': return enteredViaHolds(state, controller, sourceId, condition);
    // 「相手が選んだ通りの場合」 (FMA-1-096) — the opponent's picked claim against the controller's hand
    // as it stands now; with no pick on the frame there is no claim to match, so the gate stays closed.
    case 'statementMatchesHand': {
      if (ctx?.statementChoice === undefined) return false;
      const holds = state.players[controller].hand.some(id => effectiveNames(state, id, controller).includes(condition.name));
      return holds === ctx.statementChoice;
    }
    case 'revealedHas': {
      // 「このカードを公開し、BPが4000以上の場合」 (REZ-1-047) — the source itself is the revealed card:
      // the reveal is performative and the card stays in hand, so the frame's record is not needed.
      const ids = condition.self ? [sourceId] : (ctx?.revealed ?? []);
      return ids.some(id => {
        const definition = peekDefinition(state, id);
        if (!definition) return false;
        if (condition.kind && !revealedKindOf(definition, condition.kind)) return false;
        if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, id)) return false;
        if (condition.trait && !hasTrait(definition, condition.trait)) return false;
        // 「公開したカードが[特徴：X]以外の場合」 — the exclusion half, read like `CardFilter.notTrait`.
        if (condition.notTrait && hasTrait(definition, condition.notTrait)) return false;
        const names = effectiveNames(state, id, state.cards[id]?.owner ?? controller);
        if (condition.name !== undefined && !names.includes(condition.name)) return false;
        if (condition.names !== undefined && !condition.names.some(name => names.includes(name))) return false;
        // 「〈X〉以外の…」 — the exclusion half, read the same way `CardFilter.notNames` is: a revealed card
        // carrying one of the listed names fails, however well it matches the rest of the predicate.
        if (condition.notNames?.length && names.some(name => condition.notNames!.includes(name))) return false;
        if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
        if (condition.minEnergy !== undefined || condition.maxEnergy !== undefined || condition.energyEqualsDeclared) {
          const totals = [revealedRequiredEnergyTotal(state, id)];
          if (state.cards[id]?.owner === controller) {
            const alternate = ownStaticsOf(state, id, controller).find(m => m.type === 'requiredEnergyAlternateWhileRevealed');
            if (alternate?.type === 'requiredEnergyAlternateWhileRevealed') {
              const alternateTotal = Object.values(alternate.energy).reduce((sum, n) => sum + (n ?? 0), 0);
              if (!totals.includes(alternateTotal)) totals.push(alternateTotal);
            }
          }
          if (revealSideIsDeck(state, id, ctx, condition.self)) {
            const set = handStaticsOf(state, id).find((m): m is Extract<StaticModifier, { type: 'energyCostSet' }> => m.type === 'energyCostSet');
            if (set) {
              const setTotal = Object.values(set.energy).reduce((sum, n) => sum + (n ?? 0), 0);
              if (!totals.includes(setTotal)) totals.push(setTotal);
            }
          }
          if (condition.minEnergy !== undefined && !totals.some(total => total >= condition.minEnergy!)) return false;
          if (condition.maxEnergy !== undefined && !totals.some(total => total <= condition.maxEnergy!)) return false;
          // 「…の必要エナジーの数がこの効果で指定した数と同じだった場合」 — the announced number.
          if (condition.energyEqualsDeclared && !totals.some(total => ctx?.declared?.energyCount === total)) return false;
        }
        if (condition.maxApCost !== undefined && revealedApCost(state, id, revealSideIsDeck(state, id, ctx, condition.self)) > condition.maxApCost) return false;
        // 「公開したカードがBP4000以上のキャラカードの場合」 — the revealed card's BP, read with the
        // Re:Zero treatments (`revealedBpOf`). A card printing no BP fails either bound: 「BP4000以上」 is
        // a fact about a value the card does not have.
        if (condition.minBP !== undefined || condition.maxBP !== undefined) {
          const bp = revealedBpOf(state, id, controller);
          if (bp === undefined) return false;
          if (condition.minBP !== undefined && bp < condition.minBP) return false;
          if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
        }
        // 「必要エナジーを満たし」 — the chooser's energy covers the revealed card's requirement; the
        // producer is handed in through the condition context (the energy computation lives in the
        // engine, which this module cannot import).
        if (condition.energySatisfied && !(ctx?.energySatisfied?.(id) ?? false)) return false;
        // 「[レイド]を持つ」 — the revealed card's printed RAID ability, read like every other filter.
        if (condition.raidAbility !== undefined && (definition.raid !== undefined) !== condition.raidAbility) return false;
        return true;
      });
    }
    case 'battleAttacker': {
      const battle = state.battle;
      if (!battle) return false;
      const definition = peekDefinition(state, battle.attackerId);
      if (!definition) return false;
      const field = findFieldOf(state, battle.attacker, battle.attackerId);
      if (condition.raid !== undefined && ((field?.underneath.length ?? 0) > 0) !== condition.raid) return false;
      if (condition.kind && !answersKind(definition, condition.kind)) return false;
      if (condition.color && !Object.hasOwn(definition.requiredEnergy, condition.color) && !treatedAsAllColors(state, battle.attackerId)) return false;
      if (condition.trait && !hasTrait(definition, condition.trait)) return false;
      // 「アタックしている相手のキャラが[インパクト]を持つ」 — the attacker's *effective* keywords
      // (printed plus granted), the same set every other keyword reader takes.
      if (condition.keyword !== undefined && !effectiveKeywordsFor(state, battle.attackerId, battle.attacker)[condition.keyword]) return false;
      // 「…が[インパクト]か[ダメージ]を持つ」 (AND-1-024) — the printed 「か」 is an any-of over the listed
      // keywords.
      if (condition.keywords?.length) {
        const held = effectiveKeywordsFor(state, battle.attackerId, battle.attacker);
        if (!condition.keywords.some(keyword => held[keyword])) return false;
      }
      // 「アタックしている相手のキャラのBPが4500以上」 — the current BP, read exactly like the sibling
      // `selectedHas` / `fieldCount` bounds.
      if (condition.minBP !== undefined || condition.maxBP !== undefined) {
        const bp = currentBP(state, battle.attackerId, battle.attacker);
        if (condition.minBP !== undefined && bp < condition.minBP) return false;
        if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
      }
      // 「アタックしている相手のキャラの元々のBPが3000以下」 — the *printed* value, read from the
      // definition (the current one folds every modifier, which 「元々の」 excludes).
      if (condition.printedBP !== undefined) {
        const printed = definition.bp;
        if (printed === undefined) return false;
        if (condition.printedBP.min !== undefined && printed < condition.printedBP.min) return false;
        if (condition.printedBP.max !== undefined && printed > condition.printedBP.max) return false;
      }
      const names = effectiveNames(state, battle.attackerId, battle.attacker);
      if (condition.name !== undefined && !names.includes(condition.name)) return false;
      if (condition.names !== undefined && !condition.names.some(name => names.includes(name))) return false;
      if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
      return true;
    }
    case 'battleDefender': {
      // 「BP5000以上のキャラとのバトルに勝利した時」 — the card that took the block. A *designated*
      // (狙い撃ち) attack fights its target without any blocker ever being declared
      // (`battle.targetId`; engine.ts runs the same 'compare' route), so the defender is either id —
      // reading only `blockerId` left AOT-2-007's battle-win gate false on every designated victory.
      // `endBattle`'s channels (`onAttackEnd` and its win/loss-narrowed siblings) read the battle it
      // already cleared via the context snapshot (KMR-2-083 / Q1781).
      const battle = ctx?.battle ?? state.battle;
      const defenderId = battle?.blockerId ?? battle?.targetId;
      if (defenderId === undefined) return false;
      const definition = peekDefinition(state, defenderId);
      if (!definition) return false;
      if (condition.minBP !== undefined || condition.maxBP !== undefined) {
        const bp = currentBP(state, defenderId, battle!.defender);
        if (condition.minBP !== undefined && bp < condition.minBP) return false;
        if (condition.maxBP !== undefined && bp > condition.maxBP) return false;
      }
      const names = effectiveNames(state, defenderId, battle!.defender);
      if (condition.name !== undefined && !names.includes(condition.name)) return false;
      if (condition.nameContains !== undefined && !names.some(name => name.includes(condition.nameContains!))) return false;
      return true;
    }
    case 'phase': return state.phase === condition.phase && state.activePlayer === controller;
    case 'retireCause': {
      // A battle's loser may go straight to 場外 (`'battle'`) or overflow through the energy line
      // (`'battle-overflow'`); both are 「バトルによって退場」.
      const route = ctx?.retireReason;
      const byRoute = condition.cause === 'battle' ? route === 'battle' || route === 'battle-overflow'
        : condition.cause === 'bpZero' ? route === 'bp-zero'
        // 「自分の効果でこのキャラが場を離れた時」 — the departure an *effect* caused, which is every reason
        // the call sites write for an effect's own removal and none of the rule-driven ones (a battle, a
        // BP-zero, a line or movement capacity) or the card's own printed machinery (a raid peel).
        : route === 'card-effect' || route === 'effect-deck'
          || route === 'effect-return' || route === 'effect-life' || route === 'effect-under'
          || route === 'end-phase-effect' || route === 'main-end-effect'
          || route === 'leave-redirect' || route === 'special-trigger';
      if (!byRoute) return false;
      // 「自分の効果によって」 / 「相手の効果によって」 — the cause card's owner against the retiring
      // card's controller: `own: true` wants the same player, `own: false` the other one (ARK-1-091).
      // A cause that recorded no card cannot answer either spelling.
      if (condition.own !== undefined) {
        const causeOwner = ctx?.retireCauseId === undefined ? undefined : state.cards[ctx.retireCauseId]?.owner;
        if (causeOwner === undefined) return false;
        if (condition.own ? causeOwner !== controller : causeOwner === controller) return false;
      }
      // 「自分の〈憎普天〉の効果で退場した」 — the cause card's *effective* names, the same set every
      // other 〈X〉 test reads.
      if (condition.name !== undefined || condition.names !== undefined) {
        if (ctx?.retireCauseId === undefined) return false;
        const cause = ctx.retireCauseId;
        const names = effectiveNames(state, cause, state.cards[cause]?.owner ?? controller);
        if (condition.name !== undefined && !names.includes(condition.name)) return false;
        if (condition.names !== undefined && !condition.names.some(name => names.includes(name))) return false;
      }
      return true;
    }
    // 「このターン中にこのキャラが自分の[特徴：X]の効果で選ばれている場合」 — the asking player's own
    // selection record, scanned for entries whose *source card* matches the printed qualifier. A card
    // that is not on the field still answers (the record is keyed by the chooser's card id), which is
    // the print's point: the choice happened earlier in the turn.
    case 'chosenByEffectThisTurn':
      return choseCardThisTurn(state, resolveScope(controller, condition.who), {
        ...(condition.self ? { cardId: sourceId } : {}),
        ...(condition.trait !== undefined ? { trait: condition.trait } : {}),
        ...(condition.name !== undefined ? { name: condition.name } : {}),
        ...(condition.names !== undefined ? { names: condition.names } : {}),
      });
    // 「自分の公開したカードの必要エナジーの数が相手の…以上だった場合」 — the two revealed totals, from
    // the resolving frame. Without them (a clash that revealed nothing, or no resolution at all) the
    // predicate is false, which is the honest answer to "did my card meet theirs".
    case 'clashCompare': {
      const mine = ctx?.clashSelfEnergy;
      const theirs = ctx?.clashOpponentEnergy;
      if (mine === undefined || theirs === undefined) return false;
      return condition.compare === 'atLeast' ? mine >= theirs : mine < theirs;
    }
    case 'not': return !evalCondition(state, sourceId, controller, condition.condition, ctx);
    case 'all': return condition.conditions.every(c => evalCondition(state, sourceId, controller, c, ctx));
    case 'any': return condition.conditions.some(c => evalCondition(state, sourceId, controller, c, ctx));
  }
}
