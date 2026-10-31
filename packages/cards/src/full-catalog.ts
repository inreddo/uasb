/**
 * Generated full-pool catalog (Model B).
 *
 * `catalog.json` holds one definition per functional identity; `printing-catalog.json`
 * expands those identities to one definition per physical print, so deck entries and
 * library entries share the same ids. Regenerate with `pnpm cards:catalog`.
 */
import type { CardDefinition } from '../../engine/src/index.ts';
import catalogData from '../data/catalog.json' with { type: 'json' };
import printingData from '../data/printing-catalog.json' with { type: 'json' };
import libraryData from '../data/library-cards.json' with { type: 'json' };

export interface FullLibraryCard {
  id: string;
  functionalId: string;
  work: string;
  workName: string;
  name: string;
  kind: CardDefinition['kind'];
  apCost: number;
  requiredEnergy: CardDefinition['requiredEnergy'];
  generatedEnergy: CardDefinition['generatedEnergy'];
  bp?: number;
  triggerType: string;
  copyLimit: number;
  effectText: string;
  triggerText: string;
  /** Display-only Chinese reference (official simplified-Chinese site or manual translation). */
  translatedName?: string;
  effectTextZh?: string;
  triggerTextZh?: string;
  traits: string;
  availability: 'playable' | 'catalog-only';
  imageFile?: string;
  sourceUrl?: string;
  printStage: string;
}

/** One definition per functional identity, in canonical order. */
export const functionalCatalog = catalogData as unknown as CardDefinition[];
/** One definition per physical print; the id is the printing card key. */
export const printingCatalog = printingData as unknown as CardDefinition[];
/** Display records for every archived printing, including not-yet-implemented ones. */
export const fullLibraryCards = libraryData as unknown as FullLibraryCard[];
