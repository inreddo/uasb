import type { CardId, FieldCard, GameEvent, GameState, PlayerId } from './types.ts';

export type LedgerZone = 'deck' | 'hand' | 'life' | 'front' | 'energy' | 'sideline' | 'removal' | 'under' | 'down' | 'limbo';

/** 一张卡此刻所在的位置。`pub` = 双方都能看到它是哪张卡。 */
export interface Loc { z: LedgerZone; o: PlayerId; pub: boolean; i: number }

interface FieldProps {
  active: boolean;
  /** 修饰记录的多重集合（kind|payload|期限 → 个数）。 */
  mods: Map<string, number>;
  cac: number; cau: number; effLost: number; selfLost: number; retMain: number; retEnd: number;
}

interface Snap {
  locs: Map<CardId, Loc>;
  fields: Map<CardId, FieldProps & { owner: PlayerId }>;
  ap: [number, number];
  /** 各玩家牌库顶当前翻开的那张（若有）。 */
  top: [CardId | undefined, CardId | undefined];
}

export interface Ledger {
  last: Snap;
  /** 已折进账本的 ctx.events 下标。 */
  cursor: number;
  /** 当前不在任何区域的卡（正在被效果持有 / 打出的事件卡等）及其最后已知位置。 */
  limbo: Map<CardId, Loc>;
  /** 本命令内已被显式公开过的卡。 */
  announced: Set<CardId>;
  /** 卡的主人私下看过的卡（自己牌库 / 生命被效果「看」，正被效果帧持有）：对主人写卡名，对手仍只写张数。 */
  known: Set<CardId>;
  out: { at: number; event: GameEvent }[];
}

interface LedgerCtx { state: GameState; events: GameEvent[]; ledger?: Ledger }

const FIELD_LINES = ['front', 'energy'] as const;
const OWNERS = [0, 1] as const;

function keywordCode(keywords: Record<string, unknown>, relative?: boolean): string {
  return Object.entries(keywords).flatMap(([key, value]) => {
    if (value === false || value === undefined) return [];
    if (typeof value === 'number') return [`${key}${relative ? '+' : '='}${value}`];
    return [key];
  }).sort().join(',');
}

function fieldProps(c: FieldCard): FieldProps {
  const mods = new Map<string, number>();
  const add = (key: string) => mods.set(key, (mods.get(key) ?? 0) + 1);
  for (const m of c.bpModifiers) add(`bp|${m.amount}|${m.expiresTurn}|${m.expiresBattle ?? ''}`);
  for (const m of c.keywordModifiers ?? []) add(`kw|${keywordCode(m.keywords as Record<string, unknown>, m.relative)}|${m.expiresTurn}`);
  for (const m of c.lostKeywords ?? []) add(`lost|${keywordCode(m.keywords as Record<string, unknown>)}|${m.expiresTurn}`);
  for (const m of c.impactModifiers ?? []) add(`kw|impact${m.additive ? '+' : '='}${m.value}|${m.expiresTurn}`);
  for (const m of c.evadeModifiers ?? []) add(`evade|${m.maxBP}|${m.expiresTurn}`);
  for (const m of c.energyModifiers ?? []) add(`eng|${JSON.stringify(m.energy)}|${m.expiresTurn}`);
  for (const m of c.energyCostModifiers ?? []) add(`cost|${m.amount}|${m.expiresTurn}`);
  return {
    active: c.active, mods,
    cac: c.cannotActivateCharges ?? 0, cau: c.cannotActivateUntilTurn ?? 0,
    effLost: c.effectsLostUntilTurn ?? 0, selfLost: c.selfTurnEffectsLostUntilTurn ?? 0,
    retMain: c.retireAtMainEnd ?? 0, retEnd: c.retireAtEnd ?? 0,
  };
}

function takeSnapshot(s: GameState): Snap {
  const locs = new Map<CardId, Loc>();
  const fields: Snap['fields'] = new Map();
  for (const o of OWNERS) {
    const p = s.players[o];
    p.deck.forEach((id, i) => locs.set(id, { z: 'deck', o, pub: i === 0 && p.deckTopFaceUp === id, i }));
    p.hand.forEach((id, i) => locs.set(id, { z: 'hand', o, pub: false, i }));
    p.life.forEach((id, i) => locs.set(id, { z: 'life', o, pub: p.lifeFaceUp?.[i] === true, i }));
    p.sideline.forEach((id, i) => locs.set(id, { z: 'sideline', o, pub: true, i }));
    p.removal.forEach((id, i) => locs.set(id, { z: 'removal', o, pub: true, i }));
    for (const line of FIELD_LINES) {
      p[line].forEach((c, i) => {
        locs.set(c.cardId, { z: line, o, pub: true, i });
        fields.set(c.cardId, { ...fieldProps(c), owner: o });
        c.underneath.forEach((id, j) => locs.set(id, { z: 'under', o, pub: true, i: j }));
        (c.faceDown ?? []).forEach((id, j) => locs.set(id, { z: 'down', o, pub: false, i: j }));
      });
    }
  }
  const top = (o: PlayerId) => s.players[o].deck[0] !== undefined && s.players[o].deck[0] === s.players[o].deckTopFaceUp ? s.players[o].deck[0] : undefined;
  return { locs, fields, ap: [s.players[0].ap.filter(a => a === 'active').length, s.players[1].ap.filter(a => a === 'active').length], top: [top(0), top(1)] };
}

/** 命令开始时建立账本。基线里已不在任何区域的卡（上一条命令留下的效果持有卡）记为「来源未知」。 */
export function createLedger(ctx: LedgerCtx): void {
  const last = takeSnapshot(ctx.state);
  const limbo = new Map<CardId, Loc>();
  for (const id of Object.keys(ctx.state.cards)) if (!last.locs.has(id)) limbo.set(id, { z: 'limbo', o: ctx.state.cards[id]!.owner, pub: false, i: 0 });
  ctx.ledger = { last, cursor: ctx.events.length, limbo, announced: new Set(ctx.state.publicReveals ?? []), known: new Set(), out: [] };
  noteLooked(ctx.state, ctx.ledger);
}

function noteLooked(s: GameState, L: Ledger): void {
  const frame = s.effect;
  if (!frame) return;
  for (const id of frame.held) if (s.cards[id]?.owner === frame.player) L.known.add(id);
}

/** 纯日志事件：不进 `ctx.events`（它的长度参与 instanceId），命令结束时按位置插回结果序列。 */
export function logEvent(ctx: LedgerCtx, type: string, data: GameEvent['data']): void {
  ctx.ledger?.out.push({ at: ctx.events.length, event: { type, data } });
}

/** 此刻哪些卡对所有人可见（`pub`），哪些只有卡的主人看得到（`own`）；其余的只能写张数。 */
export function visibility(ctx: LedgerCtx, ids: CardId[]): { pub: CardId[]; own: CardId[] } {
  const L = ctx.ledger;
  const pub: CardId[] = [], own: CardId[] = [];
  if (!L) return { pub, own };
  for (const id of ids) {
    const loc = L.last.locs.get(id) ?? L.limbo.get(id);
    if (L.announced.has(id) || pubOf(loc)) pub.push(id);
    else if (ownOf(loc) || L.known.has(id)) own.push(id);
  }
  return { pub, own };
}

/** 命令结束时把纯日志事件插回显式事件序列。 */
export function mergeLogEvents(ctx: LedgerCtx): GameEvent[] {
  const ledger = ctx.ledger;
  if (!ledger || !ledger.out.length) return ctx.events;
  const merged: GameEvent[] = [];
  let next = 0;
  for (let i = 0; i <= ctx.events.length; i++) {
    while (next < ledger.out.length && ledger.out[next]!.at <= i) merged.push(ledger.out[next++]!.event);
    if (i < ctx.events.length) merged.push(ctx.events[i]!);
  }
  return merged;
}

const ANNOUNCING = new Set(['cardPlayed', 'raidPlayed', 'abilityActivated', 'cardRevealed', 'cardsRevealed', 'handRevealed', 'clashRevealed', 'cardsUsedFree', 'lifeRevealed', 'cardDeployed']);
/** 这些显式事件已经在日志里写明了某些卡的去向，账本不再重复报同一张卡的搬运。 */
const NARRATING = new Set([
  'cardsDrawn', 'cardPlayed', 'raidPlayed', 'characterMoved', 'characterRetired', 'cardRemoved', 'cardReturned',
  'cardsRevealedToHand', 'effectDiscarded', 'handDiscarded', 'cardsMilled', 'triggerResolved', 'cardsUsedFree', 'linesSwapped',
  'lifeRevealed', 'lifeFacedUp',
]);

/** 由账本 / `logEvent` 产生的纯日志事件类型（不进 state，不参与回放）；测试据此核对「显式事件序列不变」。 */
export const LOG_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'cardsMoved', 'cardsRested', 'cardsStood', 'bpChanged', 'keywordsGranted', 'keywordsLost', 'evadeGranted', 'energyModified', 'energyCostRaised',
  'readyBlocked', 'effectsLost', 'retireScheduled', 'apChanged', 'deckTopFlipped', 'effectBegan', 'choicePicked', 'optionPicked', 'conditionUnmet', 'readySkipped',
]);

function idsOf(data: GameEvent['data']): string[] {
  const out: string[] = [];
  for (const key of ['cardId', 'baseId', 'raiderId']) { const v = data[key]; if (typeof v === 'string') out.push(v); }
  if (Array.isArray(data.cards)) for (const v of data.cards) if (typeof v === 'string') out.push(v);
  return out;
}

/** 这条显式事件是否已在日志里写明了它所涉及的卡的去向（与 shared 的 publicLog 渲染保持一致）。 */
function narrates(e: GameEvent): boolean {
  if (!NARRATING.has(e.type)) return false;
  if (e.type === 'cardReturned') return typeof e.data.reason === 'string' && !returnedElsewhere(e.data);
  if (e.type === 'cardsMilled') return e.data.destination === 'sideline' || e.data.destination === 'removal';
  return true;
}

export function returnedElsewhere(data: GameEvent['data']): boolean {
  return data.reason === 'raid-top' || data.reason === 'effect-deck' || data.reason === 'effect-life' || data.to === 'deckBottom';
}

function pubOf(l: Loc | undefined): boolean { return l !== undefined && l.pub; }
function ownOf(l: Loc | undefined): boolean { return l !== undefined && (l.z === 'hand' || l.z === 'down'); }

type Scope = 'rule' | 'effect';

/**
 * 同步一次：把「上次同步以来」state 的变化折成纯日志事件。
 * `rule` 只报卡牌去向（规则处理 / 费用）；`effect` 额外报横置 / 起立 / BP / 关键词 / AP 等效果结果。
 */
export function syncLedger(ctx: LedgerCtx, scope: Scope): void {
  const L = ctx.ledger;
  if (!L) return;
  const s = ctx.state;
  const fresh = ctx.events.slice(L.cursor);
  L.cursor = ctx.events.length;
  for (const e of fresh) if (ANNOUNCING.has(e.type)) for (const id of idsOf(e.data)) L.announced.add(id);
  noteLooked(s, L);
  const cur = takeSnapshot(s);
  // 开局 / 起手换牌是整体洗牌与发牌，已有自己的日志行：静默重置基线。
  const rebase = fresh.some(e => e.type === 'matchStarted' || e.type === 'mulliganChosen');
  const emitAt = ctx.events.length;
  const push = (type: string, data: GameEvent['data']) => L.out.push({ at: emitAt, event: { type, data } });
  if (!rebase) {
    const claimed = new Set<string>();
    for (const e of fresh) if (narrates(e)) for (const id of idsOf(e.data)) claimed.add(id);
    // ---- 卡牌去向
    const groups = new Map<string, { o: PlayerId; from: Loc | undefined; to: Loc; ids: CardId[] }>();
    for (const [id, now] of cur.locs) {
      const before = L.last.locs.get(id);
      const from = before ?? L.limbo.get(id);
      if (from === undefined) continue;
      const viaLimbo = before === undefined;
      const sameZone = from.z === now.z && from.o === now.o;
      // 同区不算搬运；只有「离开又放回牌库」（看牌后放回）要报，其余同区变化是排序。
      if (sameZone && !(viaLimbo && now.z === 'deck')) continue;
      if (claimed.has(id)) continue;
      const key = `${s.cards[id]!.owner}|${from.z}|${now.z}|${now.o}`;
      const group = groups.get(key);
      if (group) group.ids.push(id); else groups.set(key, { o: s.cards[id]!.owner, from, to: now, ids: [id] });
    }
    for (const group of groups.values()) {
      const pub: string[] = [], own: string[] = [];
      for (const id of group.ids) {
        const from = L.last.locs.get(id) ?? L.limbo.get(id);
        if (pubOf(from) || pubOf(cur.locs.get(id)) || L.announced.has(id)) pub.push(id);
        else if (ownOf(from) || ownOf(cur.locs.get(id)) || L.known.has(id)) own.push(id);
      }
      // 放回牌库：看这批卡落在牌库的什么位置（顶 / 底 / 中间）。
      let pos = '';
      if (group.to.z === 'deck') {
        const deckLen = s.players[group.to.o].deck.length;
        const idx = group.ids.map(id => cur.locs.get(id)!.i).sort((a, b) => a - b);
        if (idx.every((v, k) => v === k)) pos = 'top'; else if (idx.every((v, k) => v === deckLen - idx.length + k)) pos = 'bottom'; else pos = 'mid';
        group.ids.sort((a, b) => cur.locs.get(a)!.i - cur.locs.get(b)!.i);
      }
      push('cardsMoved', { player: group.o, cards: group.ids, pub, own, from: group.from?.z ?? 'limbo', to: group.to.z, ...(pos ? { pos } : {}), scope });
    }
    // ---- 牌库顶被翻为表向（同一张卡原地翻开；新放上去的卡已由搬运行写明）
    for (const o of OWNERS) {
      const id = cur.top[o];
      const before = id === undefined ? undefined : L.last.locs.get(id);
      if (id !== undefined && cur.top[o] !== L.last.top[o] && before?.z === 'deck' && before.o === o && before.i === 0 && !claimed.has(id)) push('deckTopFlipped', { player: o, cards: [id] });
    }
    // ---- 效果结果（规则处理里的横置 / 起立 / AP 属于规则本身，不报）
    if (scope === 'effect') {
      const apSeen = new Set<number>();
      for (const e of fresh) if ((e.type === 'apSpent' || e.type === 'apReadied') && typeof e.data.player === 'number') apSeen.add(e.data.player);
      for (const o of OWNERS) {
        const delta = cur.ap[o] - L.last.ap[o];
        if (delta !== 0 && !apSeen.has(o)) push('apChanged', { player: o, delta });
      }
      diffFields(L.last, cur, s.turn, push);
    }
  }
  const limbo = new Map<CardId, Loc>();
  for (const id of Object.keys(s.cards)) if (!cur.locs.has(id)) limbo.set(id, L.last.locs.get(id) ?? L.limbo.get(id) ?? { z: 'limbo', o: s.cards[id]!.owner, pub: false, i: 0 });
  L.last = cur;
  L.limbo = limbo;
}

/** 持续期间的简码：本次战斗 / 本回合 / 下回合 / 更久。 */
function untilOf(expiresTurn: number, turn: number, expiresBattle?: string): string {
  if (expiresBattle !== undefined && expiresBattle !== '') return 'battle';
  if (expiresTurn <= turn) return 'turn';
  if (expiresTurn === turn + 1) return 'next';
  return 'long';
}

function diffFields(prev: Snap, cur: Snap, turn: number, push: (type: string, data: GameEvent['data']) => void): void {
  const rested = new Map<PlayerId, string[]>(), stood = new Map<PlayerId, string[]>();
  const grouped = new Map<string, { type: string; player: PlayerId; cards: string[]; data: GameEvent['data'] }>();
  const add = (type: string, player: PlayerId, id: string, data: GameEvent['data']) => {
    const key = `${type}|${player}|${JSON.stringify(data)}`;
    const g = grouped.get(key);
    if (g) g.cards.push(id); else grouped.set(key, { type, player, cards: [id], data });
  };
  for (const [id, now] of cur.fields) {
    const before = prev.fields.get(id);
    // 新登场的卡没有「变化前」：它登场后立刻挂上的修饰仍然要报，所以以空基线比较（active 除外）。
    if (before && before.active !== now.active) (now.active ? stood : rested).set(now.owner, [...((now.active ? stood : rested).get(now.owner) ?? []), id]);
    for (const [key, count] of now.mods) {
      const gained = count - (before?.mods.get(key) ?? 0);
      if (gained <= 0) continue;
      const [kind, payload, until, battle] = key.split('|');
      const when = untilOf(Number(until), turn, battle);
      for (let n = 0; n < gained; n++) {
        if (kind === 'bp') add('bpChanged', now.owner, id, { amount: Number(payload), until: when });
        else if (kind === 'kw') add('keywordsGranted', now.owner, id, { kw: payload!, until: when });
        else if (kind === 'lost') add('keywordsLost', now.owner, id, { kw: payload!, until: when });
        else if (kind === 'evade') add('evadeGranted', now.owner, id, { maxBP: Number(payload), until: when });
        else if (kind === 'eng') add('energyModified', now.owner, id, { until: when });
        else if (kind === 'cost') add('energyCostRaised', now.owner, id, { amount: Number(payload), until: when });
      }
    }
    if (now.cac > (before?.cac ?? 0)) add('readyBlocked', now.owner, id, { charges: now.cac - (before?.cac ?? 0) });
    if (now.cau > (before?.cau ?? 0)) add('readyBlocked', now.owner, id, { charges: 0 });
    if (now.effLost > (before?.effLost ?? 0) || now.selfLost > (before?.selfLost ?? 0)) add('effectsLost', now.owner, id, {});
    if (now.retMain > (before?.retMain ?? 0)) add('retireScheduled', now.owner, id, { when: 'main' });
    if (now.retEnd > (before?.retEnd ?? 0)) add('retireScheduled', now.owner, id, { when: 'end' });
  }
  for (const [player, cards] of rested) push('cardsRested', { player, cards });
  for (const [player, cards] of stood) push('cardsStood', { player, cards });
  for (const g of grouped.values()) push(g.type, { player: g.player, cards: g.cards, ...g.data });
}
