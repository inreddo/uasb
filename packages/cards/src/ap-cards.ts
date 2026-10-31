import apData from '../data/ap-cards.json' with { type: 'json' };

export interface ApCardRecord {
  id: string;
  work: string;
  name: string;
  /** `/cards/<image>` 的 WebP 文件名。 */
  image: string;
}

export const apCards = apData as unknown as ApCardRecord[];

export function isFreeApCard(id: string): boolean {
  return /-AP01$/.test(id);
}

export function apCardPrice(id: string): number {
  if (isFreeApCard(id)) return 0;
  const tail = id.slice(id.lastIndexOf('/') + 1);
  return /_p\d+/.test(tail) || tail.includes('★') ? 10 : 3;
}

export const apCardById: ReadonlyMap<string, ApCardRecord> = new Map(apCards.map(card => [card.id, card]));
