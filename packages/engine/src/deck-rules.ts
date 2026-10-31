/** Japanese construction rules, separate from effect support and the optional ban list.
 * Sources: official JP FAQ Q4–Q8 and CHAMPIONSHIP26-27 regulation.
 * copyLimit is printed card text, NOT a tournament restriction.
 */
export interface ConstructionCard {
  id: string;
  functionalId: string;
  work: string;
  copyLimit?: number;
  trigger?: { type: string };
  /**
   * 「このカードは自分の手札と山札でトリガーを持たないカードとして扱う」 (SHY-P-002) — a deck card with
   * the flag does not count toward the deck's SPECIAL trigger budget.
   */
  noTriggerInHandDeck?: boolean;
}
export const DECK_SIZE = 50;
export const AP_CARDS = 3;
export const SPECIAL_TRIGGERS = ['special', 'color', 'final'] as const;
export type DeckIssue = { code: 'size' | 'unknown' | 'work' | 'copies' | 'trigger'; message: string; cardId?: string };

type CatalogIndex = { byId: Map<string, ConstructionCard>; limits: Map<string, number> };
/** Catalogs are module-level constants; rebuilding these maps per call dominated the deck grid's render cost. */
const indexCache = new WeakMap<readonly ConstructionCard[], CatalogIndex>();
function catalogIndex(catalog: readonly ConstructionCard[]): CatalogIndex {
  let index = indexCache.get(catalog);
  if (!index) {
    const byId = new Map(catalog.map(card => [card.id, card]));
    const limits = new Map<string, number>();
    // The most restrictive metadata wins if alternate print records disagree.
    for (const card of catalog) limits.set(card.functionalId, Math.min(limits.get(card.functionalId) ?? 50, card.copyLimit ?? 4));
    index = { byId, limits };
    indexCache.set(catalog, index);
  }
  return index;
}

export function inspectDeck(deck: readonly string[], catalog: readonly ConstructionCard[]) {
  const { byId, limits } = catalogIndex(catalog);
  const counts = new Map<string, number>();
  const works = new Set<string>();
  const triggers: Record<string, number> = { special: 0, color: 0, final: 0 };
  const issues: DeckIssue[] = [];
  if (deck.length !== DECK_SIZE) issues.push({ code: 'size', message: `主牌组需要正好 50 张，当前 ${deck.length} 张${deck.length < 50 ? `，还差 ${50 - deck.length} 张` : `，超出 ${deck.length - 50} 张`}。` });
  for (const id of new Set(deck)) {
    if (!byId.has(id)) issues.push({ code: 'unknown', cardId: id, message: `卡库中不存在：${id}。` });
  }
  for (const id of deck) {
    const card = byId.get(id);
    if (!card) continue;
    counts.set(card.functionalId, (counts.get(card.functionalId) ?? 0) + 1);
    works.add(card.work);
    // 「自分の手札と山札でトリガーを持たないカードとして扱う」 (SHY-P-002) — a deck card with the flag
    // does not count toward the deck's SPECIAL trigger budget.
    if (card.trigger && !card.noTriggerInHandDeck && SPECIAL_TRIGGERS.some(type => type === card.trigger!.type)) triggers[card.trigger.type]!++;
  }
  if (works.size > 1) issues.push({ code: 'work', message: `只能使用同一作品代码的卡牌，当前包含 ${[...works].join('、')}。` });
  for (const [id, count] of counts) {
    const limit = limits.get(id) ?? 4;
    if (count > limit) issues.push({ code: 'copies', cardId: id, message: `${id}（含异画／再录）最多 ${limit} 张，当前 ${count} 张。` });
  }
  for (const type of SPECIAL_TRIGGERS) if (triggers[type]! > 4) issues.push({ code: 'trigger', message: `${type.toUpperCase()} 触发合计最多 4 张，当前 ${triggers[type]} 张。` });
  return { legal: issues.length === 0, issues, total: deck.length, unique: counts.size, counts, works: [...works], triggers };
}

export function additionIssue(deck: readonly string[], cardId: string, catalog: readonly ConstructionCard[]): string | null {
  if (deck.length >= DECK_SIZE) return '主牌组已满 50 张，请先移除卡牌。';
  const issue = inspectDeck([...deck, cardId], catalog).issues.find(item => item.code !== 'size');
  if (!issue) return null;
  return issue.code === 'copies' || issue.code === 'trigger' ? issue.message.replace('当前 ', '添加后为 ') : issue.message;
}
