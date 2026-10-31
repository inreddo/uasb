export type PlayerId = 0 | 1;
export type CardId = string;
export type Line = 'front' | 'energy';
export type Color = 'red' | 'blue' | 'green' | 'yellow' | 'purple';
/**
 * A required- or generated-energy signature.
 *
 * Colours are the printed symbols; the extra `any` key is the *colourless* share only two cards print
 * (「必要エナジーを2増やす」, BLC-4-011/012). It is a count, not a payment: the per-colour comparisons
 * (`requireEnergy` / `energySatisfied`) read the named colours only, so a raise with no colour never
 * hardens a coloured requirement — the house has no colourless-payment model to spend it with.
 */
export type Energy = Partial<Record<Color | 'any', number>>;
export type Phase = 'setup' | 'start' | 'movement' | 'main' | 'attack' | 'end';
export type ApState = 'inactive' | 'active' | 'rested';

export const ANY_COUNT = 99;

/** Only these fully implemented primitives are accepted. No raw text interpretation. */
export type BasicEffect =
  | { type: 'draw'; count: number; /** 「N枚まで引く」: recipient declares 0..N before drawing. */ upTo?: boolean;
      /**
       * 「相手のフロントLのアクティブのキャラ1枚につき、自分はカードを1枚引く。」 — the number of cards
       * drawn is a board count, read where the step runs. When present it replaces `count`.
       */
      countSource?: TierCount }

  | { type: 'readyAp'; count: number }
  /** 「この効果で場外に置いたカードと同じ枚数を引く」 — the count comes from the frame's own discard. */
  | { type: 'drawDiscarded'; /** 「…山札の下に置いたカードと同じ枚数」 — the destination the sentence names. Absent = 場外. */
      to?: 'deckBottom' };
export interface CardFilter {
  kind?: 'character' | 'field' | 'event';
  color?: Color;
  trait?: string;
  name?: string;
  /** Any-of name list, used when several 〈names〉 share one clause. */
  names?: string[];
  /**
   * 「〈X〉以外の」 — cards whose effective names exclude every listed one.
   *
   * `other` excludes one card (the source); this excludes a *set*, which is what 「〈X〉以外の[特徴：Y]」
   * says and what no existing field expresses.
   */
  notNames?: string[];
  /**
   * 「［特徴：X］以外の」 — cards carrying this trait are *excluded*.
   *
   * A trait, not a name: a card that prints two traits still qualifies through the other one, so the
   * exclusion cannot be folded into `trait` (which reads as "carries X"). Read alongside `trait` when a
   * subject prints both an inclusion and an exclusion.
   */
  notTrait?: string;
  /** 「黄以外の」 — cards of this colour are excluded, the colour counterpart of `notTrait`. */
  notColor?: Color;
  nameContains?: string;
  /**
   * 「カード名に「X」を含まない」 — the exclusion counterpart of `nameContains`.
   *
   * A subject that prints only the exclusion (「自分のエナジーLのカード名に「イサム」を含まないキャラ」) is not
   * expressible with `name`/`names`: it is a *fragment* test, and reading it as "any name" would let the
   * effect reach the very card the print excludes.
   */
  notNameContains?: string;
  maxEnergy?: number;
  minEnergy?: number;
  /**
   * 「元々の必要エナジー」 — whether the `minEnergy`/`maxEnergy` bounds read the *printed* requirement
   * alone.
   *
   * The default bounds read the effective requirement: the hand/sideline discounts a card applies to
   * itself and the 「…としても扱う」 alternates (`effectiveRequiredEnergyVariants`). That is the right
   * question where the filter picks a card for the zone it sits in, but a subject that prints
   * 「元々の」 asks for the card face's own number (MMM-2-051: 梓 みふゆ prints 緑×5 and reads 緑×3 in
   * hand). Only the printed sum is read then — no discount, no alternate.
   */
  energyBasis?: 'printed';
  /**
   * 「発生エナジーが1以下の…キャラ」 — a bound on the energy the card *produces*.
   *
   * The counterpart of `minEnergy`/`maxEnergy`, which read the printed *requirement*: the two point in
   * opposite directions and most cards have both numbers, so one cannot stand in for the other.
   */
  maxGeneratedEnergy?: number;
  /**
   * 「元々の発生エナジーが2以上の…キャラカード」 (MST-1-062) — the lower bound of the same produced-energy
   * axis, read from the same printed sum. 「元々の」 is the print's own wording, not a separate axis: the
   * generation has no modifier channel here, so printed and current coincide.
   */
  minGeneratedEnergy?: number;
  maxBP?: number;
  minBP?: number;
  maxApCost?: number;
  minApCost?: number;
  other?: boolean;
  active?: boolean;
  rested?: boolean;
  /**
   * 「「次の1回アクティブにならない」キャラ」 (SLG-1-058/060) — the character carries at least one
   * activation charge (`FieldCard.cannotActivateCharges`), the state the rest instructions and the
   * battle-loser charges write. Read off the live slot, like `rested` / `active`.
   */
  skipsNextReady?: boolean;
  /** Opposite of `other`: only the effect source itself. */
  self?: boolean;
  /**
   * 「この効果で自分の場にあるカード名を持つカードは登場させられない。」 (AOT-2-002) — the candidate's
   * effective names must not match any name on the *effect controller's* field. A restriction on a
   * deploy the same effect performs, so it is read where the candidate is offered, against the field of
   * the player the effect belongs to (the source's owner).
   */
  nameNotInOwnField?: boolean;
  /**
   * 「レイド状態の」 — the card is stacked on top of a raid base.
   *
   * A property of the *field slot*, not of the definition: the same card is in raid state or not
   * depending on how it was played, so it is read from the `FieldCard`.
   */
  raid?: boolean;
  /**
   * 「このターン中に自分の効果でアクティブからレストになったことがある」 — the candidate was rested
   * from active by an effect this turn. A fact the turn log carries (no board slot remembers it), read
   * by the same record the `restedByEffect` turn event writes.
   */
  restedByEffectThisTurn?: boolean;
  /**
   * 「このターン中に登場した」 (NIK-1-077, CGH-1-094) — the card entered the field during the current
   * turn, read from the turn log's own entry records the way `restedByEffectThisTurn` reads the rest
   * records. A printed recency qualifier the filter vocabulary did not carry before.
   */
  enteredThisTurn?: boolean;
  /**
   * 「このキャラのBPよりBPが N 以上低い」 — the candidate's current BP is at least N below the *effect
   * source's* current BP. A relation between two cards, readable only where both exist.
   *
   * Two printed variants share the field: a bare 「よりBPが低い」 (TLR-1-048) is the strict reading, the
   * margin-1 case; 「このキャラのBP以下」 (OPM-1-076/AOT-1-036) is the closed reading, margin 0.
   */
  bpBelowSource?: number;
  /**
   * 「BPがこのキャラのBPの半分以下」 (OPM-1-004/TRK-1-054) — the candidate's current BP may not exceed
   * this *fraction* of the effect source's current BP (0.5 for 半分; Q810: source BP8000 → only ≤4000).
   *
   * A separate field from `bpBelowSource` because the bound moves with the source: an absolute margin
   * cannot express a fraction of it. Read at the same relation point, where both cards exist.
   */
  bpBelowSourceRate?: number;
  /**
   * 「このキャラと同じBPの相手のフロントLのキャラ」 — the candidate's current BP *equals* the effect
   * source's current BP.
   *
   * The equality sibling of `bpBelowSource`, and a relation for the same reason: both sides are board
   * values, and the comparison can only be made where both cards exist.
   */
  sameBpAsSource?: boolean;
  /**
   * 「元々のBPよりBPが低い相手のフロントLのキャラ」 (KGR-1-011) — the candidate's current BP against
   * *its own* printed BP, the selection-side sibling of `Condition.fieldCount.bpBelowPrinted`. No other
   * field carries it: `bpBelowSource` compares against the source card, and an absolute bound cannot
   * express a relation whose right-hand side moves with each candidate.
   */
  bpBelowPrinted?: boolean;
  /** 「元々のBPよりBPが高い…キャラ」 — the strict mirror of `bpBelowPrinted` (equal BP satisfies neither). */
  bpAbovePrinted?: boolean;
  restable?: boolean;
  /**
   * 「下にある裏向きのカードがN枚以下(以上/ない)」 — a bound on the candidate's own hidden stack
   * (`FieldCard.faceDown`), not on the raid base (`raid` reads `underneath`, a different pile).
   *
   * Read from the *slot*, like `raid`: the same definition has an empty stack or two cards under it
   * depending on what the game did to the card.
   */
  underCount?: { min?: number; max?: number };
  /** Card has (or lacks, with `hasEffect: false`) a main effect. */
  hasEffect?: boolean;
  /**
   * 「[起動メイン]を持つ」 — the card prints an *activated* ability, read the way `raidAbility` reads the
   * printed RAID: a definition fact, not the slot's state.
   */
  hasActivated?: boolean;
  /**
   * 「[トリガー]を持たない」 — the card prints no trigger ability (`CardDefinition.trigger`).
   *
   * A printed fact about the card, not about its slot: a trigger that has already been consumed does
   * not count as absent. The positive form (`hasTrigger: true`) is the same read of the same field.
   */
  hasTrigger?: boolean;
  /**
   * 「[ドロートリガー]を持つカード」 — the card's printed trigger is the *draw* one; the same read for
   * the other printed kinds the pool names in a subject: 「[カラートリガー]を持つ…」(SMD-1-061's
   * 「場外から『[カラートリガー]』を持つ紫のキャラカード」) and the raid-trigger sibling
   * 「〈南雲〉以外の[レイドトリガー]」 (`'raid'`).
   *
   * `hasTrigger` answers "prints a trigger of any kind"; this answers "prints *this* kind", read off the
   * same `CardDefinition.trigger` the life-area trigger check consults. The distinction is load-bearing
   * in the pool: 「ライフエリアから[ドロートリガー]を持つカードが場外に置かれた時」 and its sibling
   * 「[トリガー]を持たないカード…」 name different cards, and folding one into the other would fire the
   * watcher on exactly the cards it excludes. The four kinds are disjoint in the data (`trigger.type`),
   * which is what lets each spelling answer for exactly its own cards.
   */
  triggerType?: 'color' | 'draw' | 'raid' | 'special';
  /**
   * 「[スペシャルトリガー]と[ファイナルトリガー]を**どちらも持たない**イベントカード」 (CSM-1-024, Q2081)
   * — the exclusion counterpart of `triggerType`: a candidate printing any of the listed kinds is out
   * (a card printing *no* trigger passes 「どちらも持たない」 unchanged). Read off `trigger.type` beside
   * the inclusion check.
   */
  notTriggerType?: ('get' | 'draw' | 'final' | 'raid' | 'active' | 'special' | 'color')[];
  /**
   * 「[レイド]を持つ」 — the card prints the RAID ability (`CardDefinition.raid`).
   *
   * The printed reminder 「(レイド状態かどうかは問わない)」 states the distinction: the predicate is the
   * card's own printed ability, not the stack it currently sits in (`raid`). Read the same way
   * `Condition.fieldCount.raidAbility` reads it, so a filter and a count never disagree.
   */
  raidAbility?: boolean;
  /**
   * 「このターン中にアタックした…」 (SYN-P-002) — the candidate attacked earlier this turn, read from the
   * turn log's `attacked` entries where the selection is bound.
   */
  attackedThisTurn?: boolean;
  /**
   * 「[アタック時]を持つ」「[ブロック時]を持つ」 — the card prints that triggered ability.
   *
   * Like `raidAbility`, a printed fact about the card read from its own definition (`triggered` entries
   * with the matching event): a granted instance of the same ability does not make the card 「持つ」, and
   * the pool's HIQ family asks about the printed text. The two spellerings are one field each so the
   * printed union 「[アタック時]か[ブロック時]を持つ」 can be carried as `anyOf`.
   */
  attackAbility?: boolean;
  blockAbility?: boolean;
  /**
   * 「[K]を持つキャラ」 — a *game keyword* (インパクト / インパクト無効 / ダメージ / ステップ / 狙い撃ち /
   * 2回アタック / 2回ブロック) the candidate must currently have.
   *
   * Unlike `attackAbility` / `blockAbility` / `raidAbility` (printed facts about the card), this reads the
   * card's *live* keywords — printed plus granted — because every print that spells it names a state the
   * game grants as often as it prints (「自分の場の[インパクト無効]を持つキャラがアタックして
   * ブロックされなかった時、…」 watches a keyword the same card family hands out by effect).
   */
  hasKeyword?: keyof Keywords;
  /**
   * 「特徴を持たない」 — the card prints no traits at all.
   *
   * Not a trait name and not the negation of one: 「［特徴：X］以外」 excludes a card that carries X, while
   * this admits only cards carrying nothing. Read off the definition's own `traits`, so a filter and a
   * count agree about the same card.
   */
  noTraits?: boolean;
  /**
   * 「自分の場のカードに「X」以外の特徴がない」 (BLC-4-012/036) — the card carries at least one trait
   * *other than* X. A traitless card does not match (it has no "other" trait), which is what the printed
   * 「以外の特徴がない」 gate asks: no card on the field breaks the set.
   */
  traitOtherThan?: string;
  /**
   * 「この効果で指定した数と同じ必要エナジーの」 — the total required energy equals the number the playing
   * player declared earlier in the same effect (「必要エナジーの数を1つ指定する」).
   *
   * It cannot be a compile-time bound: the value is chosen during resolution, so the filter carries a
   * flag and the value rides on the effect frame.
   */
  energyEqualsDeclared?: boolean;
  /**
   * 「指定した特徴を持つ…」 — the card carries the trait the playing player declared earlier in the same
   * effect (「自分の場にある「高校」を含む特徴を1つ指定する」).
   *
   * Like `energyEqualsDeclared`, a runtime value: the filter carries the flag and the chosen trait rides
   * on the effect frame.
   */
  traitEqualsDeclared?: boolean;
  /**
   * 「元々のBP」 — the *printed* BP, before any modifier.
   *
   * Distinct from `minBP`/`maxBP`, which read the current BP: a card that prints 「元々のBPが N 以上」 is
   * describing what is on the card, not what the board has done to it.
   */
  printedBP?: { min?: number; max?: number };
  /**
   * 「元々の消費AP」 — the *printed* AP cost, the AP sibling of `printedBP`.
   *
   * Distinct from `minApCost`/`maxApCost`, which read the price the card would currently cost — hand-scope
   * reductions included (Q1122). 「元々の」 names what is on the card: the FAQ's 月村手毬 sits in hand
   * discounted to 1 by 花海咲季's static yet still prints 2.
   */
  printedApCost?: { min?: number; max?: number };
  /**
   * 「カード名にこの効果で指定したものを含む…」 (NGR-P-003) — the card name contains the name the same
   * effect declared earlier (`declare` of kind `name`). A runtime value like `traitEqualsDeclared`.
   */
  nameContainsDeclared?: boolean;
  /**
   * 「必要エナジーを満たし」 — the choosing player's produced energy already covers the card's requirement.
   *
   * Not a bound on the printed symbols: the card may cost more than any single bound suggests, as long as
   * the board can pay it. Read where a selection is bound, against the *chooser's* energy line.
   */
  energySatisfied?: boolean;
  /**
   * 「自分の場のキャラの最大BP以下の…」 — a bound whose value is read off *other cards*, not off the card
   * being tested.
   *
   * The fixed bounds (`maxBP` / `minEnergy` / `maxApCost`) all compare against a number printed on the
   * card; this one compares against a quantity measured over a pool of the board, so neither side of the
   * comparison is knowable at compile time. The pool is one of the four corners printed in the pool
   * phrase — whose cards (`who`) and which zone (`zone`) — and the measured quantity is `stat`'s maximum
   * or minimum over it.
   *
   * `other` excludes the effect source from the pool, which is what 「自分の場の**他の**キャラの最大BP」
   * prints; `exclusive` is the strict comparison (「…の最大BP**より**BPが低い」 against 「…以下」).
   */
  bound?: {
    stat: 'bp' | 'requiredEnergy' | 'apCost';
    extreme: 'max' | 'min';
    who: PlayerScope;
    zone: 'field' | 'sideline';
    other?: boolean;
    exclusive?: boolean;
  };
  /**
   * 「自分の場の〈X〉の枚数×1000以下のBPの…」 — a ceiling *computed* from a count (times a printed factor).
   *
   * The `bound` field above takes an extremum over a pool; this one multiplies a count instead, which is
   * what the printed 「…の枚数×1000以下」 asks. The count is read over the effect controller's board
   * (`count.who` carries the printed owner), by the same reader every tier bonus uses, so a 「N枚につき」
   * bonus and this ceiling can never disagree about the same count.
   *
   * `base` is the printed floor the count scales *from*: 「『BP1000』以下の…。自分のフロントLのキャラ
   * 1枚につき、『BP+1000』される。」 raises the quoted 1000 per count, so the ceiling is
   * `base + count × per` (the bare 「…の枚数×1000以下」 form has no base and reads `count × per`).
   */
  bpCeiling?: { count: TierCount; per: number; base?: number };
  /**
   * 「相手のフロントLのキャラか…自分の場の…」 — the *line* and *side* one branch of a union names.
   *
   * A union of two zones (「相手のフロントLのキャラか自分の場の［特徴：X］」) cannot be carried by
   * `anyOf` alone: that unions *subjects*, and each branch also settles which board and which line it
   * lives on. The two fields ride on the branch filters, and the enclosing `select` names both zones.
   */
  zone?: 'front' | 'energy';
  /** The owner a union branch names (「相手の…」 / 「自分の…」). Requires a source to compare against. */
  side?: PlayerScope;
  /**
   * 「〈A〉かカード名に「B」を含むキャラ」 — a union of subjects, satisfied by *any* of the sub-filters.
   *
   * Each alternative is a filter in its own right: the qualifier printed after 「か」 governs only its own
   * alternative (「カード名に「エレン」を含む赤のキャラカードか〈地下室の鍵〉」 is red for the first and
   * unconstrained for the second), which no field on a flat filter can express. When present, the other
   * fields of the enclosing filter still apply (conjunction with the union).
   */
  anyOf?: CardFilter[];
  /**
   * 「このキャラと別のラインにある自分のキャラ」 — the candidate must sit on a *different* line than the
   * effect source.
   *
   * A relation between two cards, so it is a flag rather than a value: the line it compares against is
   * the source's own, read where the selection is bound. Only meaningful while both cards are on the
   * field; a candidate with no slot of its own (or a source that has left the field) is refused.
   */
  differentLine?: boolean;
  /**
   * 「同じラインの…」 — the candidate must sit on the *same* line as the effect source.
   *
   * The mirror of `differentLine`, and a relation for the same reason: the line compared against is the
   * source's own, read where the selection is bound. A source that has left the field has no line, so
   * no candidate can match; the field card a selection is offered over always has one.
   */
  sameLine?: boolean;
  /**
   * 「…をレイドさせる」 — this selection offers only the bases the card bound by `raidBaseFor` may raid
   * onto. A binding name rather than a filter field, because eligibility depends on the *other* card.
   */
  raidBaseFor?: string;
  /**
   * 「レイド元が〈X〉のキャラ」 — the candidate's *raid base* carries the name.
   *
   * Read from the slot's `underneath[0]` (the card the stack covers) through the same `effectiveNames`
   * every other 〈X〉 test uses, so a 「レイド元が〈X〉か〈Y〉」 union and a base-name condition can never
   * disagree about one card. A card that is not in raid state has no base and does not match.
   */
  raidUnderName?: string;
  /** The any-of sibling of `raidUnderName`, for 「レイド元が〔〈A〉か〈B〉〕のキャラ」. */
  raidUnderNames?: string[];
  /**
   * 「自分のリムーブエリアから〈X〉が登場した時」 (KMR-2-028) — where the card *entered the field from*,
   * read off the slot's own entry record. Distinct from `Condition.enteredFrom` (which reads a bound
   * card the same way): this is the event-subject filter a watcher carries, matched by
   * `matchesEventCard` while the entered card is still on the field.
   */
  enteredFrom?: 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under';
  /**
   * 「この効果で退場させた〈X〉のBP以下」 (BTR-1-078) — a ceiling read from the card *this effect* just
   * retired, at the BP it had when it left (Q414: the corrected value, not the printed one). The frame
   * records the retirement-time BPs; the `select` step filters against their maximum, and with nothing
   * retired the printed clause would not have run, so the filter admits nobody.
   */
  retiredBpCeiling?: boolean;
  /**
   * 「この効果で(場外|リムーブエリア)に置いたカードのBPの合計以下の…」 (KMR-2-068) — a ceiling computed
   * from the cards the resolving effect itself just moved: the candidate's printed BP may not exceed
   * their total. Only the frame can answer it, so the `select` step applies it beside
   * `revealedBpCeiling`; `'sideline'` reads the discard record, `'removal'` the removal record.
   */
  removedBpCeiling?: 'sideline' | 'removal';
  /**
   * 「このターン中にレイドしたキャラと同じカード名のカード」 — the candidate's name matches a card that
   * raided this turn. The field *excludes* it, because every print that carries it is a prohibition
   * (「…をレイドさせることはできない」); the turn log's `entered`+`raid` entries are the only record of
   * which names raided.
   */
  notRaidedNameThisTurn?: boolean;
  /**
   * 「この効果で場外に置いたカードとカードナンバーが異なる〈X〉」 — the candidate's card *number* is not
   * the one the resolving effect just sent to 場外 (`EffectFrame.discardedIds`).
   *
   * A relation to the frame's own record rather than a board fact: by the time the follow-up sentence
   * resolves the peeled card sits in the discard pile, indistinguishable from anything else there.
   */
  cardNumberDiffersFromRemoved?: boolean;
  /**
   * 「この効果で場外に置いたカードと必要エナジーが異なるカード」 — the energy sibling of
   * `cardNumberDiffersFromRemoved`, compared on the printed required-energy total.
   */
  energyDiffersFromRemoved?: boolean;
  /**
   * 「そのカードと必要エナジーの数か元々のBPが同じ…」 (JJK-3-049) / 「この効果で場外に置いたカードと
   * 元々のBPが同じ…」 (OPM-1-098) — the equality twin of the `…DiffersFromRemoved` pair: the candidate
   * matches when a printed quantity equals the discarded card's (printed required-energy total /
   * printed BP), each enabled half a match on its own (the print's 「か」). Read off the frame's
   * `discardedIds` like its siblings; with nothing discarded the printed clause never ran, so the
   * filter admits nobody.
   */
  asRemoved?: { energy?: boolean; originalBp?: boolean };
  /**
   * 「このターン中に(自分の)[特徴：X]の効果で選ばれているキャラ」 — a fact about who *chose* the
   * candidate, read from the choosing player's record (`PlayerState.chosenByEffectThisTurn`) against the
   * source card's own definition. `trait`/`name`/`names` name the chooser; `own` narrows to the effect
   * controller's records (the printed 「自分の」), and its absence reads either player's.
   */
  chosenByEffectThisTurn?: { trait?: string; name?: string; names?: string[]; own?: boolean };
  /**
   * 「公開したカードのBP以下」 (REZ-1-044/060) — the candidate's printed BP is at most the BP of the card
   * the resolving effect just revealed (the frame's record, read with the same hand-BP treatment
   * `revealedHas.minBP` applies). A relation to the frame, not to the board: the revealed card is back
   * in the deck (or moved on) by the time the selection is offered, so no filter field over the
   * candidate could express it.
   */
  revealedBpCeiling?: boolean;
  /**
   * 「公開したカードの必要エナジーの数×1000以下のBP」 (CGD-1-069) — the candidate's printed BP is at
   * most 1000 × the printed required-energy total of the card the resolving effect just revealed. The
   * energy-axis sibling of `revealedBpCeiling`, read at the same site off the same frame record; with
   * nothing revealed the printed clause would not have run, so the filter admits nobody.
   */
  revealedEnergyBpCeiling?: boolean;
  /**
   * 「公開したカードと同じカード名のカード」 (HTR-2-051, Q624) — the candidate's effective names must
   * include one of the names of the card the resolving effect just revealed (the frame's record). A
   * relation to the frame, not to the board: the printed name would not exist by the time the selection
   * is offered (Q624 also says matching is by *name* — a different card number with the same printed
   * name qualifies). With nothing revealed the printed clause would not have run, so the filter admits
   * nobody.
   */
  sameNameAsRevealed?: boolean;

}

/** Every place a card identity can live. `own*`/`enemy*` are relative to the effect controller. */
export type ZoneId =
  | 'ownFront' | 'ownEnergy' | 'ownField' | 'ownHand' | 'ownSideline' | 'ownRemoval' | 'ownDeck' | 'ownLife' | 'ownAp'
  /** Face-down cards under the effect source. */
  | 'ownUnder'
  /** Face-down cards under *any* of the controller's field characters (自分の場のキャラの下の裏向きのカード). */
  | 'ownUnderAll'
  | 'ownRaidUnder'
  /**
   * 「レイド状態のこのキャラの一番下のカード」 — the *deepest* card of the stack, a determinate card rather
   * than a pool to choose from (the printed 「一番下」 names one card). Separate from `ownRaidUnder`, which
   * offers the whole stack: a stack deeper than one would otherwise let the player take any base.
   */
  | 'ownRaidBottom'
  /**
   * 「そのキャラのレイド元のカード」 — the *event card's* raid base, as snapshotted when it retired
   * (`EffectTask.raidBase`). Distinct from `ownRaidUnder`, which names the effect source's own stack:
   * a watcher on another card's retirement must reach the retired card's base, not the listener's.
   */
  | 'eventRaidUnder'
  /**
   * 「このキャラをブロックしたキャラ」 (KMR-2-083) — the battle's blocker, read from the task's own
   * snapshot (`EffectTask.battleBlocker`): the open battle is already cleared when the watcher runs.
   */
  | 'blocker'
  | 'enemyFront' | 'enemyEnergy' | 'enemyField' | 'enemyHand' | 'enemySideline' | 'enemyRemoval' | 'enemyDeck' | 'enemyLife' | 'enemyAp';

export type PlayerScope = 'self' | 'opponent';

/**
 * Something that happened *during the current turn*, recorded as it happened.
 *
 * 「このターン中に…した」 is not a state predicate: at the moment it is evaluated the fact it names is
 * already over — the character has retired, the event has been used, the AP has been paid. Nothing in
 * the board can be asked about it afterwards. So the engine keeps a small log of the turn's facts and
 * the predicate counts entries in it.
 *
 * The log is cleared by `beginTurn`, never by a phase change: 「このターン中」 spans the whole turn,
 * including what the opponent did during it.
 */
export type TurnEventKind =
  /** A character left the field for the sideline (場外). Removal and 「手札に戻る」 are not 退場. */
  | 'retired'
  /** A character changed line, by the movement phase or by an effect. */
  | 'moved'
  /** A character went from active to rested because an effect said so. */
  | 'restedByEffect'
  /**
   * 「このターン中にアクティブのこのキャラがレストになっている」 — a character went from active to
   * rested by *any* route: an effect, an activated ability's レスト cost, an attack, or a block.
   *
   * Distinct from `restedByEffect`, which records only the effect route: the printed wording names no
   * cause, and the ability it gates is typically paid for by resting the very card it sits on — the
   * fact asked about is the transition itself, not what caused it.
   */
  | 'rested'
  /**
   * 「このターン中にこのキャラが[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) — a card's
   * [起動メイン] was activated this turn. The card named is the ability's own source; `apCost` records
   * whether that ability carried the printed [APを1支払う] cost tag, which the printed qualifier asks
   * about and nothing on the board remembers afterwards.
   */
  | 'abilityActivated'
  /**
   * 「このターン中に相手がトリガーの効果を発動していた場合」 — a player *activated* a life card's
   * trigger effect (the resolveTrigger route that says 発動), as opposed to letting the card go to 場外.
   *
   * The subject is the resolving player, so no `cardId` is recorded; `who` on the predicate names whose
   * activation is asked about.
   */
  | 'triggered'
  /** AP was paid as part of resolving an effect; the card named is that effect's source. */
  | 'apPaidByEffect'
  /** A card in the life area was moved to its owner's hand. */
  | 'lifeToHand'
  /**
   * A player drew one or more cards (「このターン中に相手がカードを引いている場合」).
   *
   * Recorded for every draw route — the turn's own draw, an extra draw and an effect's draw alike —
   * because the printed gate names no route. The effect route also carries `via: 'effect'` and the
   * causing player, which the phase-qualified trigger spellings read.
   */
  | 'drew'
  /** The player took the once-per-turn extra draw. */
  | 'extraDraw'
  /** A character attacked. */
  | 'attacked'
  /** A card was used from hand (「このターン中に自分が〈X〉を使用している」). */
  | 'used'
  /**
   * A card went from hand to the sideline (「このターン中に自分の手札を場外に置いている」).
   *
   * Distinct from `used`: the card may have been discarded as a cost, by an effect, or by a printed
   * instruction, and none of those *use* it. It is also distinct from `retired`, which is about a
   * character leaving the field.
   */
  | 'discardedFromHand'
  /**
   * 「このターン中に自分の効果で自分の場外からカードが手札に加わっている場合」 — a card moved from the
   * discard pile (場外) to its owner's hand.
   *
   * The mirror of `discardedFromHand` and its own kind for the same reason: the printed 「場外から」 names
   * the origin zone, and a hand reached *from the field* is the different moment `returnedToHand` records.
   * Recorded only for the effect route — nothing else moves a card out of 場外 into a hand.
   */
  | 'sidelineToHand'
  /**
   * A card went from the deck to the sideline (「このターン中に自分の効果で自分の山札のカードが場外に
   * 置かれている」 / 「このカードが自分の効果で自分の山札から場外に置かれた時」).
   *
   * Its own kind rather than a `discardedFromHand` variant: the origin zone is the deck, and the printed
   * 「山札から」 is what distinguishes the two. Recorded only for effect-driven placements — a deck card
   * can reach the sideline no other way.
   */
  | 'milled'
  /**
   * 「このターン中に自分の山札から必要エナジーが5以上のカードが公開されている場合」 (MMM-2-044/056) —
   * a card was *publicly revealed* from a deck this turn (the 公開 verb, not a private look).
   *
   * Distinct from `revealedToHand`, which records the arrival in hand: this one records the reveal
   * itself, so a card revealed and then placed back on the deck still counts, and one revealed and then
   * taken to hand satisfies both. Raised wherever a look is marked public (`lookReveal.reveal`), which
   * is the same flag the deck-reveal watchers read.
   */
  | 'revealedFromDeck'
  /**
   * A character or field card entered the field (「このターン中に…登場している」).
   *
   * Recorded at every placement — a normal play, a RAID, and every effect that deploys (`deploy` /
   * `deployRested` / the looked-card destinations) — because the printed predicate counts entries, not
   * the cards still standing: a card that entered and later retired this turn still "has entered"
   * (Q2354 reads the count form the same way).
   */
  | 'entered'
  /**
   * 「このターン中に自分の場のキャラが相手プレイヤーにダメージを与えている場合」 — a character dealt
   * damage to the other player this turn, by an attack that got through, by インパクト, or by an effect's
   * 「相手プレイヤーにNダメージ。」 whose source is that character.
   *
   * Distinct from `attacked`, which only says the attack was declared: the printed predicate is about the
   * damage *arriving*, and a blocked attack deals none. The entry names the card that dealt it, so the
   * 「場のキャラが」 subject reads `kind: 'character'` off that card's definition.
   */
  | 'dealtPlayerDamage'
  /**
   * 「このターン中に自分の[特徴：X]が場から手札に戻っている」 — a card left the field for its owner's
   * hand.
   *
   * Its own kind rather than a `moved` variant: leaving for the hand is not a retirement (the card is
   * not in 場外) and not a move (it left the field), and the printed wording asks about the return
   * itself. Raised at the single field exit that sends a card to the hand, so every route (an effect,
   * a battle redirect, `leaveToHand`) writes the same record.
   */
  | 'returnedToHand'
  /**
   * 「このターン中に自分の場外のカードが自分の山札に置かれている」 — a card went from 場外 into a
   * deck (top or bottom).
   *
   * The mirror of `milled` (deck → 場外): the origin is the discard pile and the destination a deck,
   * and neither `moved` (which is about lines) nor any other entry records it. Only the 場外 origin is
   * recorded — a hand card shuffled back is a different printed fact and reads as no entry.
   */
  | 'sidelineToDeck'
  /**
   * 「このターン中に自分の山札から…カードを公開して手札に加えている」 (KMR-1-002/003/031) — a card was
   * revealed from the controller's own deck and taken into hand. Its own kind rather than a `used`
   * variant: the printed qualifier is the *look* route (「公開して」), and a card drawn without being
   * revealed is a different fact.
   */
  | 'revealedToHand'
  /**
   * 「このターン中に自分の効果で自分の手札を公開している場合」 (DST-P-002) — a hand card was made public
   * this turn by the revealing player's own effect. One entry per reveal event; the revealing card (when
   * the route named one) rides as `causeId`/`causeOwner` like every other caused entry.
   */
  | 'revealedFromHand'
  /**
   * 「レストのこのキャラが効果でアクティブになった時」 (GIM-2-050) — a card went from rested to active
   * because an effect said so, as opposed to the ready step.
   *
   * The print names the cause, so the record is written at the effect routes only (the `activate`
   * operation, a double-attack/double-block restand and a [アクティブ] life trigger). The transition
   * itself also raises `onActivated`; this entry is what tells the two causes apart.
   */
  | 'activatedByEffect';

export interface TurnEvent {
  event: TurnEventKind;
  /** Whose event this is: the card's owner, or the player who took the action. */
  player: PlayerId;
  /**
   * The card the event names — the one that retired / moved / rested / entered, the event card that
   * was used, the source of the effect that paid AP.
   *
   * A `turnEvent` condition's `kind` / `color` / `trait` filter reads *this* card's definition, so
   * 「自分のキャラの効果でAPを支払っている」 and 「このキャラが移動している」 are the same predicate
   * with different filters rather than two mechanisms.
   */
  cardId?: CardId;
  /**
   * The phase the event happened in.
   *
   * 「自分の移動フェイズ以外でこのキャラが移動した」 is a different fact from 「このターン中に移動した」:
   * the movement-phase move is the turn's ordinary one, and an effect's move during the main phase is
   * what the printed wording cares about. Nothing on the board remembers either afterwards.
   */
  phase?: Phase;
  activePlayer?: PlayerId;
  /**
   * The card was used without paying its printed AP (「APを支払わずに使用している」).
   *
   * A use reduced to zero AP by an effect is a different fact from one that paid, and the printed
   * wording asks about it afterwards — the payment itself is long over.
   */
  free?: boolean;
  via?: 'play' | 'effect';
  /**
   * The entry this record describes was a *RAID* (「このターン中に…レイドしている」).
   *
   * A RAID is a 登場 like any other — which is why it joins the same `entered` record — but the printed
   * 「レイドしていた」 asks specifically about the raid route, and nothing else in the record tells the
   * two apart once the base has been folded into the stack.
   */
  raid?: true;
  /**
   * How a retirement happened (「このターン中にBPが0以下になることか効果によって、キャラが退場している」).
   *
   * The printed qualifier asks whether the retirement was the BP-zero rule, a battle, or an effect —
   * the turn log carries only the fact of the retirement, so the route is recorded beside it. Absent
   * for every other event kind.
   */
  cause?: 'bpZero' | 'battle' | 'effect';
  /**
   * The zone the use started from when that zone is *not* the hand (「自分のリムーブエリアから使用されている
   * 場合」 / 「山札から使用されている場合」).
   *
   * Only the exceptional route is recorded: a card that was used normally has no entry to compare. The
   * deck route is the looked-card use 「…をAPを支払わずに使用する」 (SYN-1-015/032), recorded where that
   * path logs the use.
   */
  usedFrom?: 'hand' | 'sideline' | 'deck' | 'removal' | 'under';
  /**
   * The activated ability behind an `abilityActivated` entry carried the printed [APを1支払う] cost tag
   * (`payAp.asCost`) — the qualifier 「[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) reads it.
   * Absent means the activation had no AP-cost tag.
   */
  apCost?: true;
  /**
   * The line the named card was on when the event happened (「自分のフロントLのキャラが…」).
   *
   * Recorded with the event rather than read from the board later: a card that was rested on the
   * front line and later moved would otherwise answer for wherever it sits now.
   */
  line?: Line;
  /**
   * How many cards the event moved, for the events that carry a number of their own — a draw of four
   * cards is one entry with `count: 4` (「このターン中に自分がカードを4枚以上引いている」).
   *
   * Only the printings that ask about *cards* rather than occurrences read it; an entry that recorded
   * none answers as one, so the occurrence-counting predicates are unchanged.
   */
  count?: number;
  /**
   * The controller of the effect that caused the event (「このターン中に自分の効果で自分の手札を場外に
   * 置いている」).
   *
   * `player` names whose *card* the event is about; this names whose *effect* did it, which the
   * printed 「自分の効果で」 asks about and nothing else in the record carries. Only entries raised by
   * a resolving effect write it.
   */
  causeOwner?: PlayerId;
  /**
   * The *card* whose effect caused the event (「カード名に「オーズ」を含むキャラの効果で自分の手札を3枚以上
   * 場外に置いている」, KMR-1-062).
   *
   * `causeOwner` names the player; the printed qualifier names the source *card*, which the later
   * predicate reads off this definition. Only effect-raised entries write it.
   */
  causeId?: CardId;
  /**
   * The line the named card *reached* (「moved` entries only, 「エナジーLからフロントLに移動した」).
   *
   * `line` records where the card was when the event happened — the line it left; this is the
   * destination, and the two together are the move's direction.
   */
  to?: Line;
  /**
   * Where an `entered` entry came *from* (「自分の効果で手札から登場している」).
   *
   * The `via` detail says whose route brought the card in; this says which zone it left, the other
   * half the printed 「手札から」 names. Read from the board *before* the placement, because the
   * origin zone is gone by the time the predicate runs. Only placements write it — an entry without
   * one predates the field, and every reader treats absence as "unknown origin", not as a match.
   */
  from?: 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under';
}

/** Result applied to each selected card. Timing/zone/duration are explicit, never implied. */
export type CardOperation =
  | 'return' | 'retire' | 'remove' | 'removalToSideline' | 'rest' | 'activate' | 'bp' | 'impact' | 'damage'
  /**
   * 「このターン中、必要エナジーを2増やす。」 (BLC-4-011) — a colourless requirement raise on the bound
   * card for the rest of the turn. `amount` carries the printed N.
   */
  | 'energyCostUp'
  /**
   * 「選んだ相手のキャラはこのターン中、選んだ〈X〉のアタックを可能ならブロックしなければならない。」
   * (KGR-1-069) — a demand written onto the bound blocker (`A`); the attacking card rides the base
   * binding, whose effective names are read at resolution.
   */
  | 'mustBlockAttacker'
  | 'evade' | 'checkmate' | 'readyAp' | 'move' | 'deploy' | 'deployRested' | 'raid' | 'blockOnly'
  | 'toDeckTop' | 'toDeckBottom' | 'toLife' | 'loseEffects' | 'loseSelfTurnEffects' | 'reveal'
  /**
   * 「レイド状態の上のカードを…に置く」 — a *peel*: the top card of a raid stack leaves for the
   * named destination while the base card takes the slot over, keeping its state. Distinct from
   * `retire` / `return`, which take the whole stack (the base rides along through `leaveField`).
   */
  | 'raidTopToHand'
  /**
   * 「エンドフェイズ開始時、そのキャラを退場させる。」 — a *scheduled* retirement: the card stays where
   * it is until this turn's end phase opens, then retires. The scheduled form of `retire` (which
   * happens now); `retireAtMainEnd` is the main-phase-end sibling of the same idea.
   */
  | 'retireEndPhase'
  /**
   * 「相手の山札の上か下の相手が選んだ方に置く」 — the *card's owner* answers top-or-bottom, and the
   * card reaches that deck from wherever it was. Staged: the card is left where it is until the answer,
   * then it leaves through the ordinary departure bookkeeping.
   */
  | 'toDeckTopOrBottom'
  /** Place the card face down under the effect source (このキャラの下に置く). */
  | 'toUnder'
  /** 「…の発生エナジー+[色]」 on a chosen card; the amount rides on `act.energy`. */
  | 'energy'
  /**
   * 「…に[K]を与える」 — a keyword grant and nothing else.
   *
   * `act.keywords` already carries the grant for every operation, but a keyword on its own has no other
   * operation to ride on: before this, a selection that only received keywords (「[狙い撃ち]を与える」)
   * had no operation the compiler could emit and fell to residue.
   */
  | 'grantKeywords'
  /**
   * 「レイド状態のこのキャラの一番上のカードを場外に置く」 — the raid *top* card leaves the field while
   * its base stays on the line, becoming a standalone card again (with the stack's own active state and
   * any deeper stack beneath it). Neither `retire` (which sends the base along) nor `remove` describes
   * that split, and the target may be a chosen card or the effect source.
   */
  | 'topToSideline'
  /**
   * 「レイド状態の上のこのカードを自分の山札の下に置く」 — the same peel with the departing top card
   * reaching its owner's deck bottom instead of the discard pile.
   */
  | 'topToDeckBottom'
  /**
   * 「レイド状態のこのキャラの一番上のカードを自分の山札の上に置く。」 (RNK-1-059) — the deck-*top*
   * sibling of `topToDeckBottom`: the same peel, the same bookkeeping, but the departing top card
   * becomes the next card of its owner's deck.
   */
  | 'topToDeckTop'
  /**
   * 「それは…まで、アクティブにならない。」 — the chosen card refuses every activation (the ready step and
   * effects alike) until the named expiry. The static modifier of the same name covers the printed
   * continuous line 「このキャラは…アクティブにならない」; this operation is the *timed* form a resolving
   * ability installs on another card.
   */
  | 'cannotActivate'
  /**
   * 「レイド状態のこのキャラの一番下のカードを自分の場にアクティブで登場させる」 — the deepest card of
   * the stack leaves it and enters the field on its own, standing up; the remaining stack stays as it
   * was. The entering card records `from: 'under'`.
   */
  | 'bottomToField'
  /**
   * 「そのキャラの下にあるカードを全て場外に置く」 — every card beneath the target (the raid bases and
   * the face-down pile alike) goes to its owner's discard pile; the target itself stays on the field.
   */
  | 'underToSideline'
  /**
   * 「そのキャラの下にこのキャラを表向きで置き」 — the *source* slides under the bound card, becoming its
   * raid base (the bound card thereby reaching レイド状態). The source's own stack travels with it.
   */
  | 'placeSourceUnder';

/**
 * How long an effect-installed modifier or ability lasts.
 *
 * `'turn'` is 「このターン中」: the modifier expires when the turn number advances, because
 * `expiresTurn` is compared with `>=` and `GameState.turn` increments at every turn start.
 * `'untilOwnTurnStart'` is 「次の自分のターン開始時まで」: it has to survive the opponent's turn, so
 * it expires at the *next* turn start of the card's controller rather than at the end of this one.
 * `'untilOpponentAttackEnd'` is 「次の相手のアタックフェイズ終了時まで」: the printed period ends
 * inside the opponent's next turn, which the turn-granular expiry records as that turn — the same
 * reading every other turn-scoped duration uses, with the end phase of the named turn as the small
 * documented overhang.
 */
export type Duration = 'turn' | 'untilOwnTurnStart' | 'untilOpponentAttackEnd' | 'attackEnd'
  /**
   * 「次の相手のターン中、…」 — the grant covers the *opponent's next turn* and lapses when it ends
   * (i.e. when the granter's following turn starts). Longer than 「このターン中」 by that whole turn:
   * on the granter's own turn it has to survive turn+1 and expire at turn+2, and mid-opponent-turn it
   * expires at the turn after this one.
   */
  | 'untilOpponentTurnEnd'
  /**
   * 「自分のフロントLにこのキャラがあるかぎり、そのキャラは…」 — the grant lasts while its *source*
   * remains on the field. Not an expiry: nothing counts down, and the grant ends the moment the source
   * leaves (or, when the print names a line, moves off it), which the read side checks by identity.
   */
  | 'whileSource';

/** Serializable instructions; card text is never evaluated as code. */
export type CardEffect = BasicEffect
  | { type: 'deployBatch'; groups: CardFilter[]; rested: boolean; line?: Line }
  | { type: 'departureAnswer'; cardId: CardId; destination: 'original' | 'removal' | 'top' | 'pay' }
  | { type: 'departurePaySelect'; cardId: CardId; count: number; prompt: string; candidates: CardId[] }
  | { type: 'resumeCommand'; command: Command; pendingBefore: PendingDecision | null; effectBefore?: EffectFrame }
  | { type: 'triggerEntryChoice'; phase: 'replacement' | 'line' | 'overflow'; commands: Record<string, Command>; pendingBefore: TriggerDecision }
  | { type: 'choose'; zone: 'ownFront' | 'ownField' | 'enemyFront' | 'ownSideline' | 'ownAp'; filter?: CardFilter; min: number; max: number; operation: 'return' | 'retire' | 'bp' | 'evade' | 'checkmate' | 'readyAp'; amount?: number; fallbackReturnSelf?: boolean;
      /**
       * 「自分のレストのAPカードを…選び」 — with `zone: 'ownAp'` the AP row's own slot state is what
       * narrows the choice. The `filter` channel cannot carry it: an AP slot has no card definition, so
       * every filter would reject every slot.
       */
      apState?: ApState }
  | { type: 'ifName'; name: string; effects: CardEffect[] }
  | { type: 'lookTop' }
  | { type: 'search'; count: number; filter: CardFilter; max: number; discardAfterTake?: boolean }
  | { type: 'self'; energyBonus?: Energy; impact?: number; retireMainEnd?: boolean; keywords?: Keywords; bp?: number; relative?: boolean;
      /**
       * 「このキャラはこのターン中、[狙い撃ち]を失う。」 (AOT-2-007) — the keyword bag is a *loss*: the
       * named keywords are dropped from every later read this turn (`FieldCard.lostKeywords`).
       */
      lose?: boolean }
  | { type: 'boostTrait'; trait: string; amount: number }
  // --- generic pipeline (Model B addition) ---------------------------------
  /** Bind up to `max` cards (at least `min`) from `zone` into `bind`. An empty `bind` clears it. */
  | { type: 'select'; bind: string; zone: ZoneId;
      /**
       * 「自分の手札か自分の場外から…」 — the *second* zone of a two-zone choice. `zone` stays the first so
       * every existing reader keeps working; the engine offers the cards of both zones as one selection,
       * which is exactly what the printed 「か」 gives the player to decide.
       */
      zones?: ZoneId[];
      /**
       * 「相手は選ばれたキャラのうち1枚を退場させてもよい。」 — the pool is not a zone but the cards an
       * earlier selection already bound (the union of `fromBinds`), which is what the printed
       * 「選ばれたキャラ」 names. `zone` stays filled as a placeholder the engine never reads when this is
       * present.
       */
      fromBinds?: string[]; filter?: CardFilter; min: number; max: number; choose?: PlayerScope; restOptional?: boolean; auto?: boolean; distinctNames?: boolean;
      printedMin?: number;
      /**
       * 「自分の手札を2枚まで場外に置いてもよい。そうした場合、…」 (KJN-1-055; FAQ Q839/Q835) — a printed
       * 「まで」 selection: the player may move *fewer* than `max` (Q677: 0..N), and any placement (≥1)
       * satisfies the follow-up 「そうした場合」. A 「そうした場合」 gate therefore asks 1, not `max` — the
       * write of `EffectFrame.selectPrinted` reads this flag. Without it a min-0/max-N step is
       * indistinguishable from a binary 「N枚を…置いてもよい」 (Q685: 2 or 0, no partial), which keeps
       * reading `max`.
       */
      upTo?: true;
      /**
       * 「…を各必要エナジーにつき1枚まで…」 (EVA-1-079) — at most one card per printed required-energy
       * total: the selection is open (`max` is the cap the pool implies) and an answer that holds two
       * cards of one total is refused where it arrives, exactly as `lookReveal`'s `distinctEnergy`
       * enforces it for its own takes.
       */
      distinctEnergy?: boolean;
      /**
       * 「自分の場外のキャラカードとイベントカードをそれぞれ同じ枚数望むだけリムーブエリアに置いて
       * もよい。」 (TKG-1-052) — this pick must hold exactly as many cards as the named earlier binding
       * did. The earlier pick is the one that asked "how many"; this one is forced to that width, and a
       * zero width binds nothing without opening a question.
       */
      sameCountAsBind?: string;
      /**
       * 「自分の場にある〈筛选〉のカード名1種類につき、この効果で場外に置く手札の枚数-1。」 — the printed
       * count is adjusted by a board count.
       *
       * Written onto the selection the sentence adjusts even though the sentence is printed *after* it:
       * the cards leave the hand before it would resolve, so the number has to be settled when the
       * selection runs. Both ends move together and the total is floored at zero.
       */
      countDelta?: { count: TierCount; amount: number };
      /**
       * 「…全てを退場させる」 — every matching card is bound, with no question asked.
       *
       * Distinct from `auto` (which takes up to `max`) and from a mandatory `min`: the printed 「全て」
       * leaves the player nothing to choose, so the binding is the whole candidate list whatever its
       * size, and `min`/`max` are placeholders for validation only.
       */
      all?: true;
      /**
       * 「〈X〉を選んで使用する場合、…」 — this selection *is* the card's use-time target.
       *
       * The player named it when playing the card (`Action.play.declare`), so the step binds that card
       * instead of asking. When the use carried no declaration (the pool was empty at use time), the
       * step's candidates are narrowed to cards the printed use-target filter does *not* match — paying
       * the full price and then taking the discounted target is not a legal use.
       */
      declaredTarget?: true;
      /**
       * 「自分の場外にある〈宿儺の指〉1枚につき、『+1枚』される」 — the cap `max` is raised (or lowered)
       * by a board count, so it cannot be a compile-time number. The effective cap is
       * `max + amount * count`, read where the choice is offered.
       */
      maxPer?: { count: TierCount; amount: number }
      maxEnergyPer?: { count: TierCount; amount: number }
      /**
       * 「アタックしている相手のキャラを1枚選び、…」 — the target is *the attacker of the battle being
       * resolved* rather than a card picked off a line. The binding is filled from the battle, so the
       * step asks nothing: a plain selection over 「相手のフロントL」 would offer the wrong side of the
       * table (the attacking card sits on the attacker's own line).
       */
      battleAttacker?: true
      /**
       * 「アタックしているキャラ以外の自分のフロントLのキャラを1枚選び、…」 (IMS-1-089) — the battle's
       * attacker drops out of the offer, the exclusion twin of `battleAttacker`. Read from the battle the
       * ability is resolving inside of, since the attacker sits on the *other* player's line.
       */
      excludeBattleAttacker?: true
      /**
       * 「この効果で移動させたキャラを1枚まで選び、…」 — the pool is the cards *this effect* moved
       * between lines (`EffectFrame.movedIds`), a fact no zone can name once the move is done.
       */
      movedByThisEffect?: true
      /**
       * 「この効果で登場させたカード以外の」 (KJN-1-074) — the cards *this effect* deployed drop out of
       * the offer, read from the frame's own placement record (`EffectFrame.deployedIds`) the same way
       * the pool spelling above reads `movedIds`.
       */
      excludeDeployedByThisEffect?: true
      /**
       * 「この効果で登場させたキャラを1枚まで選び、アクティブにする。」 (ARK-1-032) — the pool is the
       * cards *this effect* deployed, the positive twin of the exclusion above (same `deployedIds`
       * record, the same shape `movedByThisEffect` gives the move family).
       */
      deployedByThisEffect?: true
      /**
       * 「このキャラの下か自分の場の〈X〉の下の裏向きのカード」 (KGR-1-001) — read with
       * `zone: 'ownUnderAll'`, the hosts narrow from "every own field card" to the effect source plus
       * the cards this filter admits: the printed union of two hosts' hidden piles.
       */
      underHosts?: CardFilter
      /**
       * 「必要エナジーの合計が4以上になるように望む枚数」 (MMM-2-012) — the pick is open-width but its
       * printed total floor must hold: the answer is refused while the chosen cards' requirement totals
       * sum below this. The `bpSumMax` sibling for the requirement side.
       */
      energySumMin?: number
      /**
       * 「BPの合計が6000以下になるように…を2枚まで選び、退場させる」 (TLR-1-030) — a bound on the *set*
       * the pick takes as a whole, which no per-card filter can carry: the answer is refused while the
       * chosen cards' BP sums past this. 「BPの合計が4000以上になるように…望む枚数レストにする」
       * (DST-1-078) is the floor variant (`bpSumMin`) — a non-empty pick must reach it, while an empty
       * one is the printed decline. Field cards read their current BP, off-field picks their printed one.
       */
      bpSumMax?: number
      bpSumMin?: number
      /**
       * 「…と、そのキャラ以外の[ブロック時]を持つキャラをそれぞれ1枚選び、…」 — a candidate already
       * bound by the named earlier selection is dropped. The exclusion is against *that card*, not a
       * filter: the print's subject is the card the sentence above chose.
       */
      excludeBind?: string;
      /**
       * 「〈X〉のこの効果でこのターン中に既に選んだキャラは選べない。」 — candidates this *same card's
       * effect* already chose this turn drop out. Keyed by the effect's source: the print names the card
       * (「〈鈴木 羽那〉のこの効果で」), and another copy's selections are not this effect's.
       *
       * 「このターン中に[特徴：X]の効果で選ばれているキャラは、この効果で選べない。」 — the qualified
       * spelling names the *chooser's trait* instead of one source card, so the exclusion spans every
       * own card carrying that trait; `both` widens it to either player's records (the print carries no
       * 「自分の」).
       */
      excludeChosenThisTurn?: boolean | { trait: string; both?: boolean };
      /**
       * 「BP2000以下でBPが同じ…を2枚選び」 — each later pick must carry the *same current BP* as the card
       * an earlier selection bound. A relation between two chosen cards, which no single-card filter can
       * carry; read where the earlier binding exists.
       */
      sameBpAsBind?: string;
      /**
       * 「選んだキャラと同じカード名の…カードを1枚まで」 (BCV-1-006) — the candidate must carry one of
       * the *effective names* the card bound by this binding holds. The name sibling of `sameBpAsBind`
       * and on the step for the same reason: the binding is the pick a previous selection made, and it
       * is still in place when this pick's candidates are computed (the answer rebinds it afterwards,
       * which is what makes 「そのキャラ」 refer to the later pick).
       */
      sameNameAsBind?: string;
      /**
       * 「選んだカードと必要エナジーが同じ」 (KMR-2-034) — every candidate's *required energy* must equal
       * the card the earlier binding holds, read as colour × count with the zero rows dropped (blue 2 is
       * not red 2; a colour printed at 0 asks for nothing, so two 0-point signatures are the same). A
       * relation between two picks, so it names the binding rather than carrying a filter field; an empty
       * anchor (the earlier pick was declined) admits nobody rather than reopening the whole pool.
       */
      sameEnergyAsBind?: string;
      /** Candidates must differ from the names captured by an earlier selection (Q: STG-1-041). */
      differentNameFromBind?: string;
      /**
       * 「別のラインのキャラ1枚と位置を入れ替える」 (KGR-1-031) — the candidate must sit on a *different
       * line* than the card an earlier selection bound. Like `sameBpAsBind` a relation between two picks,
       * so it names the binding rather than carrying a filter field.
       */
      differentLineFromBind?: string }
  | {
      type: 'act'; target: string; operation: CardOperation; amount?: number; line?: Line; keywords?: Keywords; relative?: boolean; energy?: Energy; duration?: Duration; baseBind?: string;
      baseFromPeel?: string;
      /**
       * 「このキャラの下の**裏向きのカード**を全て場外に置いてもよい。」 (KGR-1-026) — `underToSideline`
       * narrowed to the face-down pile; the raid base a stack may sit on stays where it is. The bare
       * operation moves 「下にあるカード全て」 (bases included), which is what its own prints say.
       */
      faceDownOnly?: true;
      /**
       * 「このキャラのレイド元のカードを場外に置く。」 (EVA-1-043) — the mirror narrowing of
       * `faceDownOnly`: only the raid base (`underneath`) leaves, and any face-down pile under the same
       * card stays. The bare operation takes both.
       */
      underOnly?: true;
      /**
       * 「…を1枚裏向きで自分の場の〈奈落〉1枚の下に置く」 — the host a `toUnder` places under is a
       * *chosen* card rather than the effect source. Same frame-selection channel as `millTop.underBind`;
       * without it the host is the effect source (「このキャラの下に」).
       */
      underBind?: string;
      /**
       * 「自分の場のフロントLのキャラ1枚につき、このターン中、BP+500」 — the amount itself scales with a
       * board count instead of being printed.
       *
       * It cannot be a compile-time number: the count moves while the card sits on the board, and the
       * printed instruction is applied with whatever value the count holds when it resolves. Read by the
       * same `tierCountOf` every 「N枚につき」 bonus uses, and added to `amount` (which carries a printed
       * base when the wording has one). 「このターン中に退場したキャラ1枚につき、さらに『BP+1000』される」
       * reads the count where the step resolves (the frame's own history is part of it), so that total is
       * `amount + count*amountPer.amount`.
       */
      amountPer?: { count: TierCount; amount: number };
      /**
       * 「…の『自分が選んだ方』に置く」 — who answers a staged either/or the operation asks (today the
       * `toDeckTopOrBottom` top-or-bottom question, the replacement reading of which prints it as
       * 「『自分が選んだ方』に代わる」). Absent keeps the printed default: the *card's owner* answers,
       * which is what 「相手が選んだ方」 names from the effect's point of view.
       */
      chooser?: PlayerScope;
      /**
       * 「自分の場のキャラの最大BP分BPをプラスし」 — the amount is a quantity read off the board
       * (an extremum over a pool), not a printed number. Added to `amount` like `amountPer`.
       */
      amountFrom?: { stat: 'bp'; extreme: 'max' | 'min'; who: PlayerScope; zone: 'field' | 'sideline'; other?: boolean };
      /**
       * 「…を相手のライフエリアに表向きで置く」 / 「…を相手の山札の上に表向きで置く」 — the placed card
       * arrives face-up.
       *
       * Only the two destinations whose state the engine models a face for (`toLife`, `toDeckTop`) read
       * it; the flag is a property of the placement, not of every operation, so every other operation
       * ignores it.
       */
      faceUp?: boolean;
      suppressOnPlay?: true;
    }
  | { type: 'actSource'; operation: CardOperation; amount?: number; line?: Line; relative?: boolean; energy?: Energy; keywords?: Keywords; duration?: Duration; baseBind?: string;
      /**
       * 「このカードを裏向きでその〈ラピ〉の下に置く。」 — the host a `toUnder` places the source under may be
       * a *bound* card rather than the effect source itself. Same frame-selection channel as `act.underBind`.
       */
      underBind?: string;
      /**
       * 「この効果で場外に置いたカード1枚につき、このキャラはこのターン中、BP+500」 — the source-scoped
       * sibling of `act.amountPer`: the amount is read where the step resolves, so a frame-scoped count
       * (「この効果で…」) works and a one-shot 「そうした場合」 gate keeps its printed scope.
       */
      amountPer?: { count: TierCount; amount: number }
      /**
       * 「このカードを自分のライフエリアに表向きで置く。」 — the source-scoped sibling of `act.faceUp`:
       * the card reaches its destination face up. Only the operations that carry a face state read it.
       */
      faceUp?: boolean
      /**
       * 「このキャラの下の**裏向きのカード**を全て場外に置く。」 — the source-scoped sibling of
       * `act.faceDownOnly` for the same `underToSideline` narrowing.
       */
      faceDownOnly?: true
      /** 「このキャラのレイド元のカードを場外に置く。」 — the source-scoped sibling of `act.underOnly`. */
      underOnly?: true
      /**
       * 「レイド状態のこのキャラの一番上のカードを自分の場外に置いてもよい。」 (SMD-1-061) — the
       * optional spelling of a source-scoped operation. Declining leaves everything as it was, so the
       * question is asked before the operation resolves and a decline skips it outright; the printed
       * 「そうした場合」 follow-ups read the frame's own records (`discardedIds`), which a decline
       * leaves untouched.
       */
      optional?: boolean
      /** The source-scoped sibling of `act.suppressOnPlay`, read on the same raid route. */
      suppressOnPlay?: true
      /**
       * 「**レイド状態の**このキャラの一番上のカードを…」 (Q1047) — the printed subject is the raid
       * stack's top card, a referent that exists only while the source is stacked. On a card with nothing
       * underneath the instruction does nothing; without this flag the peel ops would treat the card
       * itself as "the top card" and send it to 場外 (self-destruct). The bare spelling 「このキャラの
       * 一番上のカード」 keeps that self-peel reading, so the flag rides the qualified emit alone.
       */
      raidTopOnly?: true }
  | { type: 'drawTo'; player: PlayerScope; count: number; upTo?: boolean }
  /**
   * 「この効果でキャラがレストになったプレイヤーはカードを1枚引く」 — the draw goes to whoever *owns*
   * the character this effect just rested, whichever side of the table that is.
   *
   * The identity of what the effect rested lives only on the frame (`restedIds`), so the destination
   * cannot be expressed as a `drawTo` scope; with nothing rested the step draws nothing (the printed
   * sentence is always the tail of the 「そうした場合」 gate that only fires when something was).
   */
  | { type: 'drawByRested'; count: number }
  /**
   * 「自分の手札が相手の手札と同じ枚数になるようにカードを引く」 — draws the difference so the hand
   * sizes match (nothing when already at parity).
   */
  | { type: 'drawToEqual'; player: PlayerScope }
  /**
   * 「手札が3枚になるようにカードを引く」 — draws up to a fixed hand size, the difference floored at
   * zero (a hand already at or above the printed size draws nothing).
   *
   * Distinct from `drawToEqual`, which takes the *opponent's* size as its target: no second player is
   * consulted here, so the two can never disagree about a hand.
   */
  | { type: 'drawToSize'; player: PlayerScope; count: number }
  /**
   * 「手札を N 枚場外に置く」. With a `filter` the discard may only take cards that filter accepts,
   * and the choice of which ones is the player's — a filtered discard always asks.
   *
   * `strict` makes it a **cost**: `[手札をN枚場外に置く]` pays for an activated ability, so an
   * insufficient hand has to refuse the ability rather than quietly discard fewer cards. Without the
   * flag the discard narrows to what is there, which is right for a printed instruction and wrong for a
   * cost.
   */
  | { type: 'discard'; player: PlayerScope; count: number;
      /**
       * 「1枚以上場外に置き」 — the discard may take *more* than `count` (the printed floor), up to this
       * cap. The player answers with a set between the two; without the field the discard is exact.
       */
      max?: number; optional?: boolean; filter?: CardFilter; strict?: boolean;
      /**
       * 「自分の手札を全て場外に置く。」 — every card the step's `filter` accepts goes, and nothing is
       * asked: the printed 「全て」 is not a choice and carries no width of its own, so the hand's size at
       * the moment the step runs is the whole of it (a hand above the rulebook's 8 is discarded in full).
       * `count` is only the validator's placeholder (1) here.
       */
      all?: boolean;
      /**
       * 「このキャラの下の裏向きのカードの枚数分、自分の手札を場外に置く。」 (MGS-1-075/076) — the
       * width is a board count read where the step runs (the same `TierCount` channel `draw` reads via
       * its own `countSource`), and the frame's `underIds` snapshot keeps the retire-trigger spelling
       * answerable after the source has left the field.
       */
      countSource?: TierCount;
      /**
       * 「自分の手札を1枚リムーブエリアに置いてもよい。」 — the destination pile. 場外 (the discard pile) is
       * the default; リムーブエリア is a zone of its own, and which one a card went to is observable for
       * the rest of the game.
       */
      to?: 'sideline' | 'removal' }
  | { type: 'millTop'; player: PlayerScope; count: number; to: 'sideline' | 'removal' | 'under' | 'life';
      /**
       * 「自分の山札の**下から**1枚を場外に置く」 (MCR-2-069) — the pile is read from the deck's bottom.
       *
       * Absent means the top, which is what every other printing names; the two ends are different cards
       * and a silent default would take the wrong one.
       */
      from?: 'bottom';
      /**
       * 「山札の上から1枚を**表向きで**自分のライフエリアに置く」 — the card enters the life area face up.
       *
       * Only meaningful with `to: 'life'`: every other destination either has no face state (場外 /
       * リムーブ / カード下) or is the deck itself. The flag rides the placement so `lifeFaceUp` stays
       * index-aligned with `life`, the same way `act.faceUp` does for the 「…をライフエリアに置く」 route.
       */
      faceUp?: boolean;
      underBind?: string; optional?: boolean;
      /**
       * 「自分の山札の上から2枚まで場外に置く。」 (KJN-1-073 と同族) — the printed 「まで」: the
       * controller **declares the count first** and the declaration is binding — 0 is a legal
       * declaration, the number is named before any card moves, and fewer than the declared number may
       * not be placed after the fact (Q677/Q678/Q679/Q680, EX03BT/IMS-2-029). Distinct from `optional`,
       * which is the binary 「N枚を…置いてもよい」 offer: there the only answers are all N or none,
       * which for `count > 1` is narrower than the print (place 1 of an up-to-2 is legal).
       */
      upTo?: boolean;
      /**
       * 「…そのカードの必要エナジーの数×1000以下のBPの…」 (RNK-1-044) — the milled cards are recorded
       * under this binding, so a following clause's 「そのカード」 can name them (the ceiling reads the
       * binding's printed requirement through `boundPrintedEnergy`). Recorded for every destination —
       * 「そのカード」 names the card the step took from the deck, not where it landed.
       */
      bind?: string }
  /**
   * 「このターン中、自分はそのカードをリムーブエリアから使用できる。」 (KJN-1-006/009/023/031/032) —
   * the cards *this effect* put into リムーブエリア become usable from there for the rest of the turn.
   *
   * No filter fits: 「そのカード」 names the very card the frame just moved, which only the frame's own
   * record (`removedIds`) can point at. The step copies those (this player's own) into the player's
   * turn-scoped record, where `removalUseAllowed` reads them beside the permission statics.
   */
  | { type: 'allowRemovalUse' }
  /**
   * 「相手はこの効果で退場させたキャラを1枚手札に加える。」 (KMR-1-088) — the card this effect retired,
   * still sitting in its owner's 場外, returns to its owner's hand. Read off the frame's retirement
   * record (`retiredIdsOwn` / `retiredIdsOpponent`); the print's 「1枚」 takes the first entry still in
   * 場外, which is the whole subject for an effect that retires a single chosen character.
   */
  | { type: 'retrieveRetired' }
  /**
   * 「自分の場外から〈X〉を1枚まで必要エナジーを無視してAPを支払い使用する。」 (YYH-1-083) / 「自分の
   * 場外から必要エナジーを満たす〈X〉を1枚までAPを支払って使用する。」 (SLG-1-034) / 「そのイベント
   * カードを必要エナジーを無視してAPを支払わずに使用する。」 (KGR-1-015) — the effect route of a use
   * starting from the discard pile: the requirement is ignored, the printed AP is paid (「APを支払わずに」
   * carries `free`, which skips the payment), the event resolves its own `onPlay`, and the card goes back
   * to 場外 — the destination a used card normally reaches, and where a card used *from* 場外 therefore
   * stays — unless the effect rewrites it (`to: 'removal'`, the 「場外に置く代わりにリムーブエリアに
   * 置く」 sentence). A use the player cannot afford is skipped rather than raised as an error — the
   * effect offers 「1枚まで」 and the payment is inside it.
   */
  | { type: 'useFromSideline'; bind?: string; free?: true; to?: 'sideline' | 'removal' }
  | { type: 'if'; condition: Condition; then: CardEffect[]; else?: CardEffect[] }
  /** "そうした場合" / "手札に加えた場合" — runs `then` when the previous action produced a result. */
  /**
   * 「…した場合」 — the outcome of the immediately preceding action.
   *
   * With no discriminator it asks only *whether* something happened (`gainedCount` /
   * `discardedCount` / `didCount`). The optional discriminator narrows it to **which** cards were
   * taken: 「〈X〉を手札に加えた場合」 / 「〈X〉以外を手札に加えた場合」 / 「キャラカードを手札に加えた
   * 場合」 / 「2枚手札に加えた場合」 all read the cards the last look added, not just how many. Without
   * it the compiler had to drop the qualifier, which made 「〈X〉以外を…」 fire on the exact card it was
   * printed to exclude.
   */
  | { type: 'gained'; then?: CardEffect[]; else?: CardEffect[]; on?: 'gained' | 'discarded' | 'moved' | 'deployed' | 'rested' | 'activated' | 'apReadied'; min?: number; filter?: CardFilter; exclude?: boolean }
  /** "戻せない場合" — branches on whether a previous `select` bound any card. */
  | { type: 'ifSelected'; bind: string; then?: CardEffect[]; else?: CardEffect[] }
  /**
   * "以下から N つ選ぶ" — the chosen branches are inlined in place.
   *
   * `forbidRepeat` is 「このターン中に〈X〉が既に選んだ効果は選べない」: within one turn, an option index
   * already taken under this key (the printed card name) is not offered again. The memory lives on the
   * player (`chosenOptionsThisTurn`) rather than on the frame, because the limitation spans every
   * resolution of the ability in the turn — a second attack finds the first one's choice already gone.
   */
  | { type: 'chooseOption'; count: number; options: CardEffect[][]; forbidRepeat?: string;
      /** Runtime reservation for a wholly optional onPlay: spent only when its non-empty branch is accepted. */
      entrySharedLimitKey?: string;
      /**
       * 「〈X〉のこの効果は1ターンに1回のみ**選べる**。」 trailing *one bullet* (KGD-1-006, Q1901): only
       * these option indices are spent by `forbidRepeat`'s memory — the branches the lock does not trail
       * stay repeatable (「「…」がない方の効果は何度でも選ぶことが可能」). Absent = every index is spent.
       */
      forbidRepeatOnly?: number[];
      /**
       * 「自分の場の[特徴：ガンメン]1枚につき、以下から1つまで選ぶ」 — how many picks the chooser offers
       * is a board count, so it cannot be a compile-time number. Present replaces `count`; the same
       * `tierCountOf` reader every 「N枚につき」 uses answers it where the chooser runs.
       */
      countSource?: TierCount;
      /**
       * 「以下から『1つ』選ぶ。…場合、『2つ』に代えてもよい」 — the *lower* end of the count. Absent
       * means exactly `count`; `1` with `count: 2` offers "take one or two", which is what the printed
       * optional widening leaves the player to decide.
       */
      min?: number;
      /**
       * 「相手は…してもよい」 — the *opponent* answers this chooser rather than the effect's
       * controller. The pending decision already names its answering player, so the field only
       * redirects which side sees it.
       */
      chooser?: PlayerScope;
      /**
       * 「自分の場外にある〈A〉と〈B〉の合計枚数を満たすものを、以下から2つまで選ぶ。」 (MSS-1-004) —
       * per-option availability: option `k` is offered only while `optionGates[k]` holds (a missing
       * entry, or a missing array, offers the option unconditionally). The option *indices* do not
       * shift — an unoffered option keeps its place — so `forbidRepeat`'s memory and the answer's
       * indices still name the printed branches.
       */
      optionGates?: (Condition | undefined | null)[];
      /**
       * 「放回牌库顶 / 置于场外」 — pure presentation: the printed branch names, one per `options` entry in
       * printed order. The engine never branches on them: `effects.ts` spells them into the chooser prompt
       * and `choice-labels.ts#choiceOptionLabel` answers each branch with its own name. Absent keeps the
       * older per-branch summary (`effectBranchLabel`) for every chooser whose branches the compiler can
       * already describe.
       */
      labels?: string[] }
  /** Resource payment as an explicit cost gate; subsequent steps run only when paid. */
  /** `asCost` marks the payment as the activated ability's own [APを1支払う] cost tag, which the
   *  `activationApFree` static can waive; an effect-body 「APを支払う」 carries no flag and always pays. */
  | { type: 'payAp'; count: number; optional?: boolean; then?: CardEffect[]; asCost?: boolean }
  | { type: 'payDiscard'; count: number; optional?: boolean; then?: CardEffect[] }
  /**
   * 「自分の手札の必要エナジーが同じカードを3枚場外に置く」 — a group discard whose members must share one
   * required-energy signature (Q1140: the three cards match *each other*, not the source).
   *
   * Its own step rather than a `discard` with a filter: the constraint is a relation *within* the chosen
   * set, which no per-card filter can carry. Sets `discardedCount` / `discardedIds`, so a following
   * 「そうした場合」 reads it the same way it reads an ordinary discard; an impossible group leaves the
   * counters at zero and lets the branch fall through.
   */
  | { type: 'discardSameEnergy'; count: number; optional?: boolean }
  /**
   * 「このメインフェイズ終了時、…」 — a delayed instruction parked on the *player* until this turn's main
   * phase ends.
   *
   * Not a granted trigger: a delayed effect created by a resolving ability runs independently of its
   * source, so it must not die with the card that made it. The steps run when the main phase closes,
   * in the same queue as the printed 「メインフェイズ終了時」 abilities.
   */
  | { type: 'delayMainEnd'; effects: CardEffect[] }
  /**
   * 「次の相手のターン開始時、…」 — the instruction is parked on the controller and runs when the
   * opponent's next turn opens (joining that turn's 「ターン開始時」 queue).
   *
   * The bindings the current resolution made (`f.selections`) travel with the parked copy: the delayed
   * instruction speaks about 「選んだキャラ」, and by the time it runs the frame that selected the card is
   * long gone. See `PlayerState.delayedTurnStart`.
   */
  | { type: 'delayOpponentTurnStart'; effects: CardEffect[] }
  /**
   * 「このターンのアタックフェイズ開始時、…」 — a delayed instruction parked on the *player* until this
   * turn's attack phase opens.
   *
   * The 「このターンの」 prefix is the whole reading: the sentence is created by the resolution around it
   * (an activation, an entry, an event use) and exists for the current turn alone, so it can never be a
   * printed watcher (a standing ability would fire every turn and on the opponent's phase as well). The
   * steps are parked on the controller and survive the source leaving the field, exactly like
   * `delayMainEnd`; the phase opening consumes them once (engine's `takeDelayedAttack`).
   */
  | { type: 'delayAttackPhaseStart'; effects: CardEffect[] }
  /**
   * 「このターンのアタックフェイズ終了時、…」 — the same one-turn delay at the attack phase's close
   * (`delayAttackPhaseStart`'s mirror). Event cards use it: the use resolves in the main phase, the
   * printed moment comes later in the same turn.
   */
  | { type: 'delayAttackPhaseEnd'; effects: CardEffect[] }
  | {
      type: 'lookReveal'; count: number;
      /**
       * 「相手の場のレストのキャラの枚数分」 — the number of cards looked at is itself a board count, so
       * it cannot be a compile-time constant. When present it replaces `count`.
       */
      countSource?: TierCount;
      /**
       * 「自分のフロントLのBP4000以上の［特徴：ミシリス］1枚につき、この効果で見る山札の枚数+1。」 — the
       * looked count is *raised* by a board count on top of a printed base. `count` carries the base
       * (「山札の上から『1枚』見て」) and this adds `amount × count` where the look resolves, the same
       * shape `maxEnergyPer` gives a selection.
       */
      countPer?: { count: TierCount; amount: number };
      maxEnergyPer?: { count: TierCount; amount: number };
      /**
       * Where the cards nobody took go. `topOrSidelineOpponent` (BLC-1-022 / KMR-1-113) is the
       * opponent-deck counterpart of `topOrSideline`: the looked card belongs to the opponent, so *both*
       * destinations are theirs — back on the opponent's deck top or filed to the opponent's 場外 — while
       * the effect player makes the choice.
       */
      filter?: CardFilter; max: number; rest: 'bottom' | 'top' | 'sideline' | 'order' | 'orderTop' | 'lifeOrder' | 'splitTop' | 'splitTopSideline' | 'topOrUnder' | 'removal' | 'topOrRemoval' | 'topOrSideline' | 'topOrSidelineOpponent' | 'topBottomFaceUp' | 'topOrBottom'; discardAfterTake?: number;
      /**
       * 「公開したN枚のカードの必要エナジーの数が全て同じか、連続するNつの数だった場合、『公開したカードを
       * 全て手札に加える』に代わる。」 (SYN-1-062) — with the looked cards' requirement totals all equal or
       * N consecutive numbers (Q782), the take widens to *all* of them and no question is asked. The value
       * is the printed N (the run's length, and the count the look lifted).
       */
      takeAllEnergyRun?: number;
      /**
       * 「公開したカードが消費APが1のキャラカードで必要エナジーを満たす場合、手札に加える代わりに…」 /
       * 「…必要エナジーを満たす〈ベアトリス〉の場合、…」 — the *replacement* take (`deployOrRaid` /
       * `deployRestedOrRaid` / `deployRested`) is only offered while the picked card passes these
       * printed gates; a card that fails them is taken to hand the ordinary way. `names` is the Re:Zero
       * name gate, read through `effectiveNames` like every other 〈X〉 test.
       */
      takeGate?: { maxApCost?: number; energySatisfied?: boolean; names?: string[]; filter?: CardFilter };
      /**
       * 「…場合、『自分の手札を1枚場外に置き、公開したカードを…登場させる』に代えてもよい。」 (BCV-1-058) —
       * a replacement-only take whose base prints no take at all: the question offers only cards passing
       * `takeGate`, and a card failing it stays where the base put it (no hand fallback — that reading
       * belongs to the printings whose base take was 手札に加える).
       */
      takeGateOnly?: true;
      /**
       * 「…山札の上に置くか、裏向きで自分の場の〈奈落〉1枚の下に置く」 — with `rest: 'topOrUnder'`
       * the remainder's destination is the player's choice: back on the deck, or face down under a
       * character this filter admits (the ask lists them, and an empty list keeps the cards on top).
       */
      underHostFilter?: CardFilter;
      /**
       * Where the looked cards go.
       *
       * `deployOrRaid` / `deployRestedOrRaid` are the either/or forms: after the pick the player is asked
       * which way the card arrives, and the raid leg then asks which base — the same two questions the
       * select-based 「登場させるかレイドさせる」 encoding asks, staged inside the look because the card is
       * held by the effect rather than sitting in the hand or the discard pile.
       *
       * `topOrSideline` (JJK-2-005) asks after the pick: the chosen card goes back on its *owner's* deck
       * top or to its owner's 場外. Both zones follow the card's owner, so a take out of a looked deck
       * stays with that deck's player; the ask is the take-side counterpart of `rest: 'topOrSideline'`.
       */
      take?: 'hand' | 'sideline' | 'deploy' | 'deployRested' | 'deployOrRaid' | 'deployRestedOrRaid' | 'under' | 'use' | 'top' | 'removal' | 'handOrSideline' | 'topOrSideline';
      /**
       * 「公開したカードがイベントカードの場合、『場外に置く』に代わる。」 (OPM-1-020) — a picked card the
       * filter names reaches 場外 instead of the hand. Not the player's choice (unlike `take`): the printed
       * replacement is decided by the card itself, so it rides as a condition on the answer. The arrival
       * records split with the card, so a take where everything was diverted counts as nothing gained.
       */
      takeToSidelineIf?: CardFilter;
      /**
       * 「その中から〈蛇切縄〉を1枚まで自分の**エナジーL**にレストで登場させる。」 (MGS-1-015) — the line
       * a `deploy`/`deployRested` take arrives on. Absent means the front line, which is what every other
       * printed spelling of this family means.
       */
      takeLine?: 'front' | 'energy';
      /**
       * 「…を公開し手札に加える」 — the take is a *public* reveal, not the private 見る the engine otherwise
       * models. The distinction is observable: a revealed card fires its own 「山札から公開された時」
       * watchers, while a privately looked-at one does not. Set only when the printed spelling says
       * 「公開し」.
       */
      reveal?: boolean;
      /**
       * Which end of the deck the looked cards come from (「自分の山札の**下**から1枚を公開してもよい」).
       *
       * `'under'` is the face-down stack beneath the source; `'deckBottom'` is the deck's own bottom,
       * which nothing else can name — a look that reads the top cards and reports them as the bottom's
       * would take the wrong card.
       */
      from?: 'deck' | 'deckBottom' | 'under' | 'life';
      /**
       * 「…見てもよい」 — the look itself is the player's choice. Declining leaves the deck exactly as it
       * was (nothing has been lifted yet), which is the whole of what the optional wording gives.
       */
      optional?: boolean;
      /**
       * 「相手は自身の山札の上から1枚を公開する」 — which player's deck is looked at.
       *
       * Only the reveal-in-place destinations make sense for the opponent's deck (the card is shown and
       * put back), so the hand / field destinations refuse the opponent scope at validation time.
       */
      player?: PlayerScope;
      /**
       * 「…を1枚まで自分の場にレストで登場させ、1枚を手札に加え、残りを…」 — a *second* pick over the cards
       * the first one left. Two picks rather than one wider one because the printed destinations differ:
       * the deployed card never reaches 手札, and the hand card never reaches 場. The destination is
       * normally the hand; `to: 'under'` is the 「…1枚を裏向きで自分の場の［特徴：ドクター］の下に置き、
       * 残りを…」 spelling (KMR-1-053), which tucks the pick face down under the effect source (the same
       * host rule `take: 'under'` uses). `min` is the printed floor of the second pick (absent = the
       * declinable 「可不选」 the deploy-then-hand spellings print).
       */
      secondTake?: { max: number; filter?: CardFilter; to?: 'hand' | 'under'; min?: number };
      /**
       * 「その中から〈A〉と〈B〉をそれぞれ1枚まで公開し手札に加える」 — one pick *per printed subject*.
       *
       * Each group is its own question over the cards the previous groups left, because the printed
       * subjects are separate (「［特徴：ペンギン急便］とBPが2500のキャラカード」) and a flat filter could
       * not say "one of each" — it would let either subject take both cards.
       */
      takeGroups?: {
        filter?: CardFilter;
        max: number;
        /**
         * 「異なるカード名の…をそれぞれ1枚まで」 on this group alone (TRK-P-002: different-name blue
         * 食材 each once, then 〈小松〉 once). A group's own distinctness is kept here rather than on
         * the parent so the other groups are not constrained by it.
         */
        distinctNames?: boolean;
      }[];
      /**
       * 「…をそれぞれN枚まで場外に置き、残りを望む順で山札の上に置く」 — where the group picks land.
       * The group mechanism grew up around 「公開し手札に加える」 (the default); the sideline spelling is
       * the same question with a different destination.
       */
      takeGroupsTo?: 'hand' | 'sideline';
      /** 「異なるカード名の…をそれぞれ1枚ずつ」 — the taken cards must all have different names. */
      distinctNames?: boolean;
      /**
       * 「必要エナジーが異なる赤の〔…〕を望む枚数公開し手札に加える」 — the taken cards must all have
       * *different* printed required-energy totals.
       *
       * A constraint on the chosen set, not on the candidates — the same shape `distinctNames` gives:
       * every looked card stays offerable and a second pick of one total is what is refused.
       */
      distinctEnergy?: boolean;
      /**
       * 「その中から赤のキャラカードをBPの合計が7500以下になるように望む枚数公開し手札に加える」 — the
       * taken set's printed BP may not add up past this ceiling. Enforced where the answer arrives, the
       * same place `distinctEnergy` is.
       */
      bpSumMax?: number;
      /**
       * 「相手はその中から1枚を指定する」 — the *opponent* answers which cards the controller keeps (the
       * designated ones are those left behind). Same question the ordinary take asks, answered by the
       * other side; the engine's own `player` scope names whose deck was looked at, which is a different
       * question.
       */
      takeChooser?: PlayerScope;
      /**
       * 「その中から…1枚を指定する」 — the printed take is *mandatory*: exactly this many cards leave the
       * looked set for its destination, and the answer may not fall short. Absent (the norm) is the
       * 「N枚まで」 reading, where zero is a legal answer.
       */
      takeMin?: number;
      /**
       * 「その中から相手がランダムに1枚選ぶ。」 (KIN-1-038) — the pick is uniform and *nobody chooses*:
       * the engine draws one candidate with its reproducible PRNG (the same generator `shuffle` uses)
       * and answers the take with it, so the destination machinery below handles it unchanged. The value
       * names the side the print attributes the pick to (the opponent), which is flavour, not a chooser.
       */
      takeRandomBy?: PlayerScope;
    }
  /**
   * 「自分と相手は自身の山札の上から1枚を公開し、公開したカードを自身の山札の下に置く。」 — both
   * players reveal their own deck top and put it back. The two revealed cards are recorded on the frame
   * (`clashSelf` / `clashOpponent`) so the sentences that follow can compare them; once the cards are
   * back in the deck nothing distinguishes them from the rest.
   */
  | { type: 'clashReveal'; count: number; to: 'bottom' | 'top' }
  | { type: 'note'; text: string }
  /** 「自分はゲームに勝利する。」 (BCV-1-028) — the effect-driven win; the game finishes with the opponent as the loser. */
  | { type: 'winGame' }
  /**
   * 「自分のアクティブのAPカードの枚数分、カードを引く」 — a draw whose count is a board fact (the AP row),
   * read where the step resolves.
   */
  | { type: 'drawByCount'; count: TierCount }
  /**
   * 「公開したカードが緑のイベントカードの場合、必要エナジーを無視してAPを支払わずにそのカードを
   * 使用する。」 — the card the preceding look revealed (and the print already sent to 場外) is used as if
   * played, for free.
   *
   * The card's identity lives only on the frame (`revealedIds`), so the step reads that; only cards
   * still in 場外 qualify (a later instruction may have moved one on), and `filter` carries the printed
   * gate (the sentence's own 「…の場合」 condition). The use mirrors `lookReveal.take 'use'`: an event
   * card resolves its own `onPlay` and stays in 場外, and the turn log records the use as free.
   */
  | { type: 'useRevealed'; filter?: CardFilter }
  /**
   * 「自分の手札から必要エナジーが2以下の青のイベントカードをAPを支払わずに1枚使用できる。」 (KGD-1-049) —
   * the hand sibling of `useRevealed`: the selection printed above has bound the card(s), and this step
   * uses them for free — the same records the revealed spelling writes (`used` log with `free: true`, the
   * event resolving its own `onPlay`), with the card leaving the hand for 場外 where an event ends up.
   */
  | { type: 'useChosen'; bind?: string }
  /**
   * 「このカードを必要エナジーを無視してAPを支払わずに使用してもよい。」 (KGR-1-041) — the resolving
   * card (still in its owner's hand) uses *itself* for free, resolving its own event effect.
   */
  | { type: 'useSelf' }
  /**
   * 「相手は「手札に〈X〉がある。」か「手札に〈X〉がない。」のどちらかを選ぶ。」 (FMA-1-096) — the picked
   * claim is recorded on the frame (`EffectFrame.statementChoice`); the choice itself is an ordinary
   * `chooseOption` whose branches carry one of these, one per statement.
   */
  | { type: 'markStatement'; has: boolean }
  /**
   * "…の数により以下の効果が全て発動する" — every tier whose threshold is met fires, in order.
   *
   * A tier may be nothing but keyword tags (「・6枚以上：[インパクト（1）]」), which produces no steps
   * at all; `keywords` carries that grant so the tier is not silently empty.
   *
   * `target` names the binding a lead selection made when the list grants to the *chosen* card rather
   * than to 「このキャラ」 (JJK-1-061: 「自分の場の〈宿儺〉を1枚選び、…以下の効果を全て得る」) — the
   * keyword-only tiers then land on the binding's cards instead of on the effect source.
   */
  | { type: 'tiered'; count: TierCount; tiers: { min: number; max?: number; effects: CardEffect[]; keywords?: Keywords; relative?: boolean }[]; target?: string }
  /**
   * 「自分の手札を望む枚数公開する」 / 「相手は自身の手札を全て公開する」 — information only; the revealed
   * cards feed `tiered` / `revealedTraitNames`. `player` names *whose* hand is shown («相手は自身の
   * 手札を…»), defaulting to the effect's own controller.
   *
   * `keepBind` names a selection whose cards stay *concealed* — 「相手は自身の手札から1枚を残し、それ以外の
   * 手札を全て公開する。」 (SYN-1-045): the bound card is the one the hand's owner keeps, and everything
   * else is what the reveal shows (and what `__revealed` hands to the pick that follows).
   */
  | { type: 'revealHand'; player?: PlayerScope; keepBind?: string; /** Any subset, including none; absent means whole hand. */ upTo?: true }
  /**
   * 「自分の手札を1枚公開し、自分の山札の下に置く。」 (REZ-1-034/045/060) — one hand card is made public
   * and then goes to the bottom of its owner's deck.
   *
   * The choice is the printed 「1枚」 (`optional` is the 「1枚まで」 spelling); the revealed identity is
   * recorded on the frame (`revealedIds`), which is what a follow-up 「公開したカードが…」 reads — the
   * card itself is back in the deck by then and indistinguishable from the rest.
   */
  | { type: 'revealHandToBottom'; count: number; optional?: boolean }
  /**
   * 「見たカードが…の場合、公開してもよい。」 — reveal the card the effect just looked at, in place.
   *
   * `lookReveal` lifts cards *privately*; this step is the public half, and the card does not move for
   * it (the print's own 「公開したカードを…に置く」 confirms where it stays). `optional` asks the
   * player whether to reveal, and only the cards matching `filter` are offered — the printed condition
   * is the gate itself. Answering yes is the step's `didCount` marker, so a following 「そうした場合、
   * …」 reads it exactly like any other produced-a-result gate, and revealing raises the deck-reveal
   * watchers (「このカードが山札から公開された時」) for the cards that became public.
   */
  | { type: 'revealLooked'; filter?: CardFilter; optional?: boolean }
  /**
   * 「(公開したカードの必要エナジーがN以上の場合、)そのカードを手札に加える」 — the card the look above
   * revealed joins its owner's hand. The reveal put it back on the deck, so the step reads the frame's
   * own `revealedIds` (the only place that identity still exists) and takes exactly those cards.
   */
  | { type: 'takeRevealed' }
  /**
   * 「自分の山札の上から1枚を表向きにする。」 — the deck's top card becomes public information.
   *
   * The mark lives on the player (`PlayerState.deckTopFaceUp`) as the *card's* id, so it lasts exactly
   * while that card stays on top. An empty deck has nothing to turn and the step does nothing.
   */
  | { type: 'deckTopFaceUp' }
  /**
   * 「自分の山札の上に表向きのカードがある場合、そのカードを手札に加えてもよい。」 — the public top
   * card joins the hand.
   *
   * The face-up condition is part of what the print offers, so the step checks it itself rather than
   * relying on a surrounding gate; `optional` is the 「…してもよい」 spelling. The card leaves the deck
   * top, which is exactly the moment its face-up mark lapses.
   */
  | { type: 'takeFaceUpTop'; optional?: boolean }
  /**
   * 「自分の(裏向きの)ライフを1枚表向きにする。」 / 「相手は自身のライフを1枚選び、それが裏向きの
   * 場合、表向きにする。」 — flip life cards face-up.
   *
   * Asked over *slots* rather than card ids (the contents of a life area are hidden information, and the
   * existing life selections only ever name a card the print already sent there). `who` names whose life
   * area; `chooser` who answers, defaulting to the effect's controller — the 「相手は自身の…を…選び」
   * spelling hands the question to the life area's owner. Already face-up slots are not offered, so
   * 「裏向きのライフを1枚」 (mandatory) with nothing to flip does nothing; the 「それが裏向きの場合」
   * spelling instead offers *every* slot (`includeFaceUp`, Q1656 — a face-up pick is legal and the flip
   * is a no-op), which is the print's own reading of the qualifier.
   */
  | { type: 'faceUpLife'; who?: PlayerScope; max?: number; optional?: boolean; chooser?: PlayerScope; includeFaceUp?: true }
  /**
   * 「このキャラは〈本文〉を得る」 / 「〈选〉に〈本文〉を与える」 — installs a *whole ability* on the
   * target, not just a keyword.
   *
   * The printed body may be a continuous modifier (「このキャラはBP4000以上のキャラにブロックされ
   * ない。」) or a triggered one (「メインフィズ終了時、このキャラを退場させる。」), so the two are
   * separate steps: `grantStatic` carries `StaticAbility[]` (conditions preserved), `grantTrigger`
   * carries one event-keyed ability. Both write onto the *field card* rather than the definition,
   * because the grant is per-instance and expires; `CardDefinition` is shared by every copy.
   */
  /** 「それらに…を与える」 — `target` may name several bindings at once, and every bound card gets the
   *  abilities. A single binding is written as a plain string, so existing steps are unchanged. */
  | { type: 'grantStatic'; target: 'source' | 'A' | 'player' | 'opponentPlayer' | 'raidBase' | 'cause' | string[]; abilities: StaticAbility[]; duration: Duration;
      /**
       * `target: 'opponentPlayer'` installs the abilities on the *other* player's state — 「相手は次の相手の
       * ターンの移動フェイズで…」 governs the opponent's own actions. The duration is still read from the
       * resolving effect's controller (the printed period is their "until the opponent's next turn ends").
       */
      /**
       * 「そのキャラのレイド元のカードに…を与える」 — with `target: 'raidBase'`, which binding's peeled
       * tops the grant follows (the base each peel uncovered, recorded on the frame).
       */
      raidBaseOf?: string;
      /** 「自分の**フロントL**にこのキャラがあるかぎり」 — the line the `whileSource` grant's source must stay on. */
      sourceLine?: Line }
  /**
   * 「このキャラはこのターン中、…が持つ[起動メイン]を全て得る。」 / 「…この効果でリムーブエリアに置いた
   * カードが持つ全ての[起動メイン]を与える。」 — copied *activated* abilities, installed on `target`.
   *
   * The copies are read from their cards *definitions* at resolution time (nothing is copied at compile
   * time), and the `activate` action reads them after the target's printed list, so a copy is activated
   * exactly like an ability the card prints.
   */
  | { type: 'grantActivated'; target: string; duration: Duration;
      from:
        | { sameLine: true; filter?: CardFilter }
        | { bind: string }
        | { removedByThisEffect: true };
      /**
       * 「選んだキャラが持つ[APを1支払う]を含む[起動メイン]を1つ得る。」 (TKG-1-026) — only donated
       * abilities carrying the printed [APを1支払う] cost tag (`payAp.asCost`) are copied, and at most
       * `max` of them. When more qualify than `max`, the participant chooses which ones.
       */
      apCostOnly?: boolean; max?: number }
  /**
   * 「このキャラは…この効果でリムーブエリアに置いたカードが持つ全ての[自分のターン中]の効果と
   * [相手のターン中]の効果を得る。」 (KMR-2-067/068) — the turn-scoped half of the `grantActivated`
   * family: the donors' *own turn-gated* abilities, triggered and static alike, are copied onto the
   * target. Only abilities carrying a `turnOf` condition are copied — the print names exactly
   * 「[自分のターン中]」/「[相手のターン中]」 effects — and each copy keeps its own condition, so it
   * applies on its printed turn. The donors are read at resolution time, like `grantActivated`'s.
   */
  | { type: 'grantTurnAbilities'; target: 'source' | 'A'; duration: Duration;
      from: { bind: string } | { removedByThisEffect: true } }
  | { type: 'grantTrigger'; target: 'source' | 'A' | 'player'; event: AbilityEvent; effects: CardEffect[]; duration: Duration; oncePerTurn?: boolean; sharedLimit?: boolean; condition?: Condition;
      /**
       * 「自分の場の他のキャラが…した時」 / 「特徴に「ALO」を持つ〈キリト〉が登場した時」 — the event's own card
       * must match, and the listener may watch *another* card. Read exactly as the printed ability's same two
       * fields are, so a granted watcher and a printed one can never disagree.
       */
      eventCard?: CardFilter; scope?: TriggeredAbility['scope'] }
  /**
   * 「このキャラの[登場時]を発動する」 / 「そのカードの[退場時]を発動する」 — runs a printed ability
   * of the named card again from the middle of this one.
   *
   * The steps come from that card's own array, read at resolution time, so the printed order and its
   * own costs are preserved. `'source'` is spliced into the current frame, which keeps 「このキャラは…」
   * pointing at the source; a *chosen* card has to run as its own task, because its text speaks about
   * itself and would otherwise resolve against the wrong card.
   *
   * `'trigger'` is 「そのカードの[トリガー]を発動する」 — the life trigger's own template (`Trigger`), not
   * a text array: colour triggers splice their `effects`, the fixed kinds become their printed action, and
   * the two targeted kinds ([アクティブ] / [スペシャル]) become a selection plus that action. A card with
   * no trigger, or a template the engine cannot run outside the life batch ([レイド] / [ファイナル]), is a
   * no-op.
   *
   * `'discarded'` is 「そのカード」 pointing at the card the previous sentence just sent aside (「自分の
   * 手札の〈X〉を1枚リムーブエリアに置いてもよい。そうした場合、そのカードの[トリガー]を発動する」) — the
   * frame's own discard/removal record, which no binding carries.
   *
   * `asSelf` is the 「…をこのキャラが発動する」 spelling (BLK-1-046's 「そのキャラが持つ全ての[アタック時]を
   * このキャラが発動する」): the *resolving card* performs the replayed steps, so every 「このキャラ」 in
   * them reads it (Q524/Q525 — ownUnder is this card's stack, 【ダメージ2】 lands on this card), and the
   * steps splice into the current frame like the `'source'` spelling. Without it the replayed card is the
   * source (Q1644 for MGS-1-046's returned-card replay depends on that reading).
   */
  | { type: 'replayAbility'; target: 'source' | 'A' | 'discarded'; event: 'onPlay' | 'onRetire' | 'onAttack' | 'trigger'; asSelf?: true }
  /**
   * 「このキャラのレイド元のカードが持つ[登場時]か[退場時]をこのキャラが発動してもよい。」 (ARK-1-007)
   * — the raid base's printed abilities re-run with *this* character as the source (「このキャラが発動
   * する」), so the steps are spliced into the current frame like the `'source'` spelling. The base rides
   * on the frame (`EffectFrame.raidBase`), which is how a 退場時 resolution can still read it.
   */
  | { type: 'replayAbility'; target: 'raidBase'; events: ('onPlay' | 'onRetire')[] }
  /** 「このターン中、次に手札から使用する〈对象〉の消費APを-Nする」 — a discount waiting to be spent. */
  | { type: 'nextUseAp'; filter: CardFilter; amount: number;
      /** 「次にリムーブエリアから使用する…」 or 「次に手札か場外から使用する…」 — the source zones the
       * discounted use may start from. Absent = hand alone (YYH-1-090 spells 場外 out, both listed). */
      zones?: ('hand' | 'sideline' | 'removal')[];
      /**
       * 「各必要エナジーにつき1枚まで、消費APが-1される」 — the discount is spent *per printed
       * required-energy signature* rather than once: the first matching use of each distinct total takes
       * it, and a second use of the same total pays full price while other totals still qualify.
       */
      perEnergy?: boolean }
  /**
   * 「…は消費APが-1され、**アクティブで場に登場する**。」 (ARK-1-055) — the arrival rider printed
   * beside a waiting discount: the next matching use enters the field active. Parked on the player like
   * `nextUseAp` and spent by the same use (`consumeNextUseDiscount`).
   */
  | { type: 'nextUseActive'; filter: CardFilter;
      /**
       * 「合計9種類以上ある場合、『自分の場に登場させる［特徴：X］全て』に代わる。」 (IMC-1-098) — the
       * widened reading of the rider: *every* matching arrival this turn enters active, so the entry is
       * not spent by the first use (`consumeNextUseDiscount` keeps it alive for the turn).
       */
      all?: boolean }
  /**
   * 「このターン中、次に〈X〉が自分の場に登場するまで、手札にある〈X〉全ての必要エナジーを[色×N]減らす。」
   * — a *waiting* energy reduction that is not scoped to one use.
   *
   * The sibling of `nextUseAp`, with the same lifecycle: the reduction is read while a matching card is
   * still in hand (`requiredEnergyOf`) and is consumed when such a card is *used*, or dropped when the
   * named entry arrives (`untilEnter`) — whichever the print names. `untilEnter` is the entry that ends
   * the period (「次に〈戸愚呂（弟）〉が自分の場に登場するまで」); an entry with no such clause simply
   * lapses at the turn's end like every other 「このターン中」 reduction.
   */
  | { type: 'nextEnergyDiscount'; filter: CardFilter; color: Color; amount: number; untilEnter?: CardFilter }
  /**
   * 「このターン中、次に手札から使用する〈对象〉の**必要エナジー**を[色×N]減らす」 — the energy sibling of
   * `nextUseAp`, waiting on the player the same way and consumed by the next matching use.
   *
   * A step rather than a static: the discount is granted by a resolving ability (whose source may since
   * have left the field or the hand), applies to exactly one use, and must lapse with the turn.
   */
  | { type: 'nextUseEnergy'; filter: CardFilter; color: Color; amount: number }
  /**
   * 「このターン中、次に手札から**レイド**する〈X〉の消費APを-1する」 — the raid-only sibling of
   * `nextUseAp`.
   *
   * A step rather than a static for the same reason, and a separate channel because the print says
   * レイド: a plain play of a matching card must neither take the discount nor spend it.
   */
  | { type: 'nextRaidAp'; filter: CardFilter; amount: number }
  /**
   * 「このターン中、次に自分が手札からレイドさせる〈浦飯 幽助〉の必要エナジーを[緑×1]減らす」
   * (YYH-P-002) — the energy sibling of `nextRaidAp`, and the raid-scoped sibling of `nextUseEnergy`:
   * consulted only while a raid is being priced (an ordinary play of a matching card pays full price)
   * and spent by the raid that took it (`consumeRaidDiscount`).
   */
  | { type: 'nextRaidEnergy'; filter: CardFilter; color: Color; amount: number }
  /**
   * 「このターン中、自分が次に発動させる〈X〉の[起動メイン]は、自分の場のキャラを選ぶ代わりに相手の
   * フロントLのキャラを選んで発動させてもよい。」 (HTR-2-046) — the next activation of a matching card
   * may select its target off the printed pool: the `from`-zone selection offers the `zone` cards as well
   * (one pool, so the pick may come from either side), and the waiting record is spent by that first
   * matching selection whether or not the offer is taken.
   */
  | { type: 'nextActivationSelectSwap'; filter: CardFilter; from: ZoneId; zone: ZoneId }
  /**
   * 「このターン中、次に発動する赤の〈デイジーオーガ〉の[起動メイン]は[APを1支払う]を失う」
   * (SYN-P-003) — the next activation of a matching card loses its [APをN支払う] cost. Parked on the
   * player and consumed by the first matching `payAp` step (the cost-bearing head of an activated
   * ability), so neither the availability check nor the payment runs for that activation.
   */
  | { type: 'nextActivationApFree'; filter: CardFilter }
  /**
   * 「このキャラはこのアタックでダメージを与えず」 (SYN-P-002) — waives the open battle's unblocked
   * damage; the battle still closes.
   */
  | { type: 'attackNoDamage' }
  /**
   * 「このターン中、次に自分が「BPの範囲に指定がある効果」でキャラを選ぶ際、指定できるBPの範囲+1000。」
   * — a widening that waits on the player and is spent by the *next* selection carrying a BP bound.
   *
   * Read where a selection's candidates are bound: a `maxBP` bound rises by `amount` (and a `minBP`
   * bound falls by it), which is what the printed parenthetical describes (「BP2000以下のキャラを選べる
   * 効果でBP3000以下を選べるようになる」). Kept on the player because the granting ability is already
   * resolved when the next selection happens.
   *
   * `all` is the turn-long spelling 「このターン中、自分が「BPの範囲に指定がある効果」でキャラを選ぶ際、
   * 指定できるBPの範囲+1000」 — every BP-bound selection for the rest of the turn, so the entry is not
   * spent by the first one.
   */
  | { type: 'nextSelectBp'; amount: number; all?: boolean }
  /**
   * 「このターン中[、次に]自分の紫のカードの効果で「以下から1つ選ぶ」効果は「以下から全て選ぶ」に
   * 代えてもよい。」 — installs the player-scoped offer (`PlayerState.purpleChooseAll`); `next` is the
   * 「次に」 spelling, which spends the offer on the first such chooser.
   */
  | { type: 'purpleChooseAll'; next?: boolean; count?: number }
  /**
   * 「このバトルで敗北した相手のキャラは、退場する代わりに〈行き先〉」 *as part of a resolving ability*.
   *
   * The static modifier of the same name covers the printed continuous line; this step covers the
   * wording written inside a battle-win trigger, which applies to the battle that just happened rather
   * than to every battle the card takes part in. It parks the destination for `sendBattleLoser`.
   */
  | { type: 'battleLoserTo'; destination: 'energy' | 'removal' | 'hand' | 'deckBottom' | 'stay' }

  /**
   * 「必要エナジーの数を1つ指定する」 — the player names a number of energy symbols, and later instructions
   * in the same effect read it back.
   *
   * The range is open on the upper side in print (「1つ」), but only totals that actually occur in the
   * catalog are offered, so the declared number is always one a card can satisfy.
   */
  | { type: 'declare'; what: 'energyCount'; min: number; max: number }
  /**
   * 「自分の場にある「高校」を含む特徴を1つ指定する」 — the player names one trait carried by a card on
   * their own field (optionally narrowed to those containing a printed fragment).
   *
   * The candidates are read from the board at resolution, like `energyCount`'s totals, so the declaration
   * can never name a trait the board does not offer. The value rides the frame's `declared.trait` and is
   * read back by `CardFilter.traitEqualsDeclared`.
   */
  | { type: 'declare'; what: 'trait'; contains?: string }
  /**
   * 「「美花莉」、「ノノア」、「アリア」から1つ指定する」 (NGR-P-003) — the player names one of the printed
   * candidates. Later instructions read it back through `CardFilter.nameContainsDeclared`.
   */
  | { type: 'declare'; what: 'name'; candidates: string[] }
  /**
   * 「…の下の裏向きのカードを…の下に移動させる」 — moves every card bound by `from` under the single
   * card bound by `to`.
   *
   * The destination is another *card*, not a zone: a face-down card under one character is not in a
   * zone the engine can name, so the move has to be expressed between two bindings. Either side may be
   * the literal `'source'`: `to: 'source'` is 「このキャラの下に移動させる」, and `from: 'source'` is
   * 「このカードを裏向きで〈X〉の下に置く」 — the card whose ability is resolving, removed from wherever
   * it is (a line, 場外, or another hidden stack) before the host claims it.
   */
  | { type: 'moveUnder'; from: string | 'source'; to: string | 'source';
      /**
       * 「そのキャラとそのキャラの下の裏向きのカードを裏向きでこのキャラの下に置き」 — the card carried
       * along with the face-down pile already beneath it (KMR-1-048/050/051). The plain move leaves a
       * line for the host, and anything stacked under the moved card has nowhere to stay — the same
       * route `leaveField` gives a raided base — so without this flag a printed 「そのキャラの下の
       * 裏向きのカード」 would silently be sent to 場外 instead of following the character.
       */
      withFaceDown?: boolean;
      /**
       * 「自分の場外の…を1枚、自分のフロントLの…1枚の下に**表向きで**置く。」 (FMA-1-003) — the placed card
       * joins the host's `underneath` (the face-up stack), making the host a レイド状態 card, instead of
       * the hidden `faceDown` pile a plain `moveUnder` fills.
       */
      faceUp?: boolean }
  /**
   * 「この効果で場外に置いたカードを裏向きでこのキャラの下に置く」 — the cards *this effect* sent to the
   * discard pile are moved face down under the effect source.
   *
   * A step of its own rather than a `select`+`act`: the subject is a fact about the resolving effect's own
   * history (`discardedIds`), which no zone or filter can name — by the time the instruction runs the
   * cards are in 場外 and indistinguishable from everything else there.
   */
  | {
      type: 'discardedUnder'; optional?: boolean;
      /**
       * 「この効果で退場させたキャラを全てこのキャラの下に裏向きで置く」 — the subject is the frame's own
       * *retirement* record rather than its discard record: a character this effect retired never enters
       * `discardedIds`, and a discard instruction never enters `retiredIdsOwn`.
       */
      from?: 'retired';
      /**
       * 「そのカードを裏向きのカードが下にない自分の場の〈クレア・カゲノー〉1枚の下に裏向きで置いてもよい。」
       * (KJN-1-014) — the host is a *chosen* card rather than the effect source, the same frame-binding
       * channel `millTop.underBind` reads. Absent, the host is the effect source.
       */
      underBind?: string;
      /**
       * The printed name a placement is narrowed to: only the frame's own discards using it are placed.
       * KJN-1-014 states the narrowing in its *condition* (「この効果で〈アウロラ〉を場外に置いた場合」)
       * rather than on this step, so the compiled card leaves it unset.
       */
      name?: string;
    }
  /**
   * 「場外に置いたそのカードを1枚まで手札に加える」 — the card the *event that raised this ability*
   * sent to 場外 returns to its owner's hand.
   *
   * The subject is the same one `discardedUnder` speaks about — the raising event's own card
   * (`EffectTask.eventSubject`), or this effect's own discard record when the ability discarded during
   * its own resolution — and only cards still in 場外 qualify (a later effect may have moved one on).
   * Up to `max` of them; the FAQ for the 天子 family is explicit that a card placed by an *earlier*
   * event is not eligible (Q644), which is what reading the task's own subject gives.
   */
  | { type: 'recoverDiscarded'; max: number; from?: 'deck' }
  /**
   * 「…をそれぞれ1枚まで選び、その中からN枚までを…登場させ、残りを手札に加える。」 — the cards the
   * earlier bindings hold that a later selection did not take move to their owners' hands.
   *
   * The pool is the union of the named bindings (`from`); `exclude` names the binding whose picks stay,
   * i.e. the cards the sentence above deployed. A card a later step already moved on is left where it is.
   */
  | { type: 'remainderToHand'; from: string[]; exclude: string }
  /**
   * 「自分のキャラの効果で自分の手札から［特徴：ファイズギア］を場外に置いた時、そのカードを自分の山札の上に
   * 置いてもよい。」 (KMR-1-081) — the card the *raising event* sent to 場外 goes to the top of its owner's deck.
   *
   * The same subject `recoverDiscarded` reads, with the deck's top as the destination; the printed
   * 「置いてもよい」 is encoded by the caller as a one-of-two chooser against doing nothing.
   */
  | { type: 'eventCardToDeckTop' }
  /**
   * 「そのキャラの下の裏向きのカードを N 枚手札に加え」 — take hidden cards out of the stack under the
   * *bound* card (the one the selection named), not under the effect source.
   *
   * Mandatory: when the host holds N or fewer cards the whole stack moves; when it holds more, which of
   * them is taken is the owner's choice — the cards are face-down to everyone else, but their owner put
   * them there.
   */
  /**
   * 「このターン中、選んだキャラが〔退場するか、このキャラのアタックをブロックした時〕、このキャラは
   * このターン中、…を得る。」 (HTR-2-059) — the *bound* watcher: the named binding's cards are recorded
   * on the source this turn, and `effects` run (from the source) when one of them retires or blocks the
   * source's attack.
   */
  | { type: 'watchBound'; target: string; events: ('retire' | 'blockedAttack')[]; effects: CardEffect[] }
  | { type: 'takeUnder'; target: string; count: number;
      /**
       * 「このカードの下の裏向きのカード全てを手札に加える」 — the whole hidden stack moves, with no
       * print count to compare it against (and no pick asked: 「全て」 names every card).
       */
      all?: true;
      /**
       * 「…の下か自分の場の〈X〉の下の裏向きのカードから1枚まで公開し、手札に加える」(KGR-1-001) —
       * the binding holds the hidden cards *themselves* (a pick across several hosts' piles, which the
       * host-bound reading cannot express), so each leaves whichever stack holds it.
       */
      fromCards?: true;
      /**
       * 「このキャラの下の裏向きのカードを1枚まで手札に加える。」 (BLC-4-034) — the printed 「N枚まで」
       * leaves the take declinable: the offer is asked (0..N) even when the stack fits inside the count,
       * which the mandatory form moves whole without asking.
       */
      optional?: boolean }
  /**
   * 「…の位置を入れ替える」 — exchange the field slots of two cards.
   *
   * Each side names a binding; either side may be the literal `'source'`, which is how
   * 「…を1枚選び、このキャラと位置を入れ替える」 names the card whose ability is resolving — it is the
   * effect's own source and never appears in `f.selections`. The two selections are the same width
   * (or one side is the single source), so the nth of one trades places with the nth of the other.
   *
   * Expressed as one step because a `move` on each side would need its own capacity check and would
   * fail when both lines are full — which is exactly when a swap is what the print asks for. Two
   * cards on the *same* line exchange their slots, so a 「位置を入れ替える」 never silently does
   * nothing; only a pair that has left the field is skipped.
   */
  | { type: 'swapLines'; a: string; b: string }
  /**
   * 「相手プレイヤーにNダメージ。」 — player burn dealt outside any battle.
   *
   * The life area is the same one the battle damage path empties, so the two share the `damage` pending
   * and the trigger batch that follows it (see `damagePlayer`). What the step cannot do is resolve
   * *inside* the effect loop: that opens a pending decision while a frame is still open, and a life
   * card's colour trigger would then need `startEffect` for a frame that is already taken. So the
   * amount is accumulated on the frame and dealt once the frame's steps are done — every printing of
   * this wording is the last instruction of its ability (all five pool-wide), which is what makes the
   * deferral read the same as the print.
   */
  | { type: 'playerDamage'; count: number };

/** Count expressions usable as a tier threshold source. */
export type TierCount =
  | { source: 'triggerKinds'; who: PlayerScope; color: Color; maxEnergy: number; other?: boolean }
  | { source: 'underCount'; all?: boolean;
      /**
       * 「自分のフロントLのキャラの下の裏向きのカード」 — the line the hosting characters sit on. The
       * unqualified 「自分の場のキャラの下の裏向きのカード」 spans both lines and leaves it unset.
       */
      line?: Line }
  | { source: 'sideline'; who: PlayerScope; kind?: 'character' | 'field' | 'event'; color?: Color; trait?: string; notTrait?: string; name?: string; nameContains?: string;
      /**
       * 「自分の場外にある〈A〉と〈B〉の合計枚数」 — an any-of *name list*, counted once over both.
       *
       * A single `name` cannot carry it: 「〈A〉と〈B〉」 prints two names, and reading only the first
       * would undercount while no field could express the second. Read the same way
       * `Condition.sidelineCount.names` reads them, so a gate and its count never disagree.
       */
      names?: string[];
      /**
       * 「自分の場外にある**他の**フィールドカード1枚につき」 — the effect source itself drops out of the
       * count. A `TierCount` has no source context of its own, so the reader excludes it by identity at
       * evaluation time, the same way `fieldCount.other` does.
       */
      other?: boolean;
      /**
       * 「自分の場外にある消費APが2で特徴を持つカードの枚数」 (KMR-1-001) — the *printed price* and the
       * presence of any trait at all, both part of the counted subject.
       */
      apCost?: number; hasTrait?: boolean }
  | { source: 'energyCount'; who: PlayerScope }
  /**
   * 「自分の発生エナジーにより、このキャラは以下の効果を全て得る」 (FMA-1-023/026) — the symbols the
   * player's energy line produces, the count form of `Condition.producedEnergy` (same reader, so a tier
   * and its gate can never disagree).
   */
  | { source: 'producedEnergy'; who: PlayerScope; color?: Color }
  | { source: 'fieldCount'; who: PlayerScope; kind?: 'character' | 'field' | 'event'; trait?: string; notTrait?: string; color?: Color; notColor?: Color; name?: string; nameContains?: string;
      /**
       * 「自分の場の［特徴：四聖剣］と〈藤堂 鏡志朗〉と〈月下（藤堂機）〉1枚につき」 — a *union* of a
       * trait and several names, each card counting once. Every listed subject counts a card that
       * matches any of them, which is the printed 「1枚につき」 over a mixed list; two separate counts
       * would double-count nothing but could not express "per printed card" either.
       */
      names?: string[]; line?: Line; other?: boolean; rested?: boolean; active?: boolean;
      /**
       * 「〈A〉、［特徴：X］、［特徴：Y］の合計枚数」 — one count over a union of listed names and traits.
       *
       * Every card matching *any* listed subject counts once, the same union `Condition.fieldCount` reads
       * for 「…が合計 N 枚以上ある」; a card matching two of them is still one card.
       */
      traits?: string[];
      /**
       * 「自分のフロントLの**レイド状態の**［特徴：X］1枚につき」 — the slot's stack state, read the same
       * way `CardFilter.raid` and `Condition.fieldCount.raid` read it. Dropping it counts every ［特徴：X］
       * including the ones that are not in raid state, which multiplies the bonus over a wider set.
       */
      raid?: boolean;
      /**
       * 「相手の場の**[トリガー]を持つ**カードの枚数×1000以下のBP」 — the printed trigger, read from the same
       * `CardDefinition.trigger` field `Condition.fieldCount.hasTrigger` reads, so a count and a gate can
       * never disagree about the same card.
       */
      hasTrigger?: boolean;
      /**
       * 「**元々のBPが2500以下の**自分の場のレストの［特徴：Y］1枚につき」 — the *printed* BP, which a
       * bound printed in front of the counted phrase narrows. Read like `Condition.fieldCount.printedBP`.
       */
      printedBP?: { min?: number; max?: number };
      /**
       * 「**同じライン**の必要エナジーが3のキャラの枚数により、…」 — the pool is the effect source's own
       * line, read exactly where `Condition.fieldCount.sameLine` reads it: same phrase, same relation, so
       * a count and a gate can never disagree about which cards the line holds.
       */
      sameLine?: boolean;
      /**
       * 「同じラインの**必要エナジーが3の**キャラ1枚につき」 — the printed requirement total, the bound
       * `CardFilter.minEnergy` / `maxEnergy` and `Condition.fieldCount` already carry.
       */
      minEnergy?: number; maxEnergy?: number;
      /**
       * 「自分のフロントLの**元々の消費APが2以上の**キャラ1枚につき」 — the printed AP cost, the same
       * `CardDefinition.apCost` bound `Condition.fieldCount.minApCost` reads.
       */
      minApCost?: number; maxApCost?: number;
      /** 「元々の消費AP」 — the printed sibling (Q1122): see CardFilter.printedApCost. */
      printedApCost?: { min?: number; max?: number };
      /**
       * 「自分のフロントLの**BP4000以上の**［特徴：X］1枚につき」 — the *current* BP bound, read exactly
       * where `Condition.fieldCount.minBP` reads it, so a count and a gate can never disagree.
       *
       * 「[アタック時]/[ブロック時]を持つ…1枚につき」 — the printed triggered ability, the same
       * predicate `CardFilter.attackAbility` and `Condition.fieldCount.attackAbility` read.
       */
      minBP?: number; maxBP?: number; attackAbility?: boolean; blockAbility?: boolean;
      /** 「[起動メイン]を持つ…1枚につき」 — the printed activated ability, as `Condition.fieldCount` reads it. */
      hasActivated?: boolean;
      /**
       * 「自分の場の[2回ブロック]を持つキャラ1枚につき」 (ARK-1-087) — the subject is a printed keyword,
       * read through the same effective-keyword set `Condition.fieldCount.hasKeyword` and
       * `CardFilter.hasKeyword` read, so a count, a gate and a filter can never disagree about one card.
       * The list spelling (`hasKeywords`) counts a card matching **any** listed keyword, the same union
       * `Condition.fieldCount.hasKeywords` reads.
       */
      hasKeyword?: keyof Keywords; hasKeywords?: (keyof Keywords)[] }
  | { source: 'handCount'; who: PlayerScope }
  /**
   * 「このターン中に自分が引いたカードの枚数」 (SYN-1-070) — the *cards* drawn this turn, summed from the
   * turn log's `drew` entries (one entry per draw, each carrying its own `cardCount`). Distinct from the
   * condition-side `turnEvent drew.cardCount`, which asks a threshold; this is the raw count a ceiling
   * scales with.
   */
  | { source: 'drewThisTurn'; who: PlayerScope }
  /**
   * 「自分のアクティブのAPカードの枚数分」 — how many of the player's AP cards are in the named state.
   *
   * The AP row is a small fixed set of slot states (`PlayerState.ap`), not a zone of cards, so no other
   * count expression reaches it. `state` names the printed slot state (「アクティブの」/「レストの」).
   */
  | { source: 'apCount'; who: PlayerScope; state: 'active' | 'rested' }
  /**
   * 「この効果で場外に置いたカードの必要エナジーの数」 — the sum of the *printed* required-energy totals
   * over the cards the resolving effect sent to 場外 (`EffectFrame.discardedIds`).
   *
   * Frame-scoped like `restedEnergySum`: outside a resolving effect there is no "this effect", so the
   * state-only reader in `conditions.ts` answers 0 and the frame reader in `effects.ts` is authoritative.
   */
  | { source: 'discardedEnergySum' }
  /**
   * 「退場させたキャラの必要エナジーの数×1000以下のBPの…」 — the sum of the *printed* required-energy
   * totals over the cards the resolving effect retired (`EffectFrame.retiredIdsOwn` /
   * `retiredIdsOpponent`). The retirement-channel sibling of `discardedEnergySum`: the printed clause
   * reads one card's energy, and both lists are summed so the count cannot depend on which side of the
   * table the character stood on.
   */
  | { source: 'retiredEnergySum' }
  /**
   * 「このターン中に退場したキャラN枚につき」 — the turn log's retirement count.
   *
   * `who` absent counts *both* players' retirements, which is what the wording that names no owner
   * means. Read from the same log `Condition.turnEvent` reads, so a count and a gate can never
   * disagree about which retirements happened.
   */
  | { source: 'turnEventRetired'; who?: PlayerScope }
  /**
   * 「このターン中にこのキャラが移動した回数1回につき」 — the turn log's `moved` entries narrowed to the
   * effect source's own card. Read from the same log `Condition.turnEvent` reads (`self: true`), so a
   * count and a gate can never disagree about which moves happened.
   */
  | { source: 'selfMovedThisTurn' }
  /**
   * 「このターン中にこのキャラがアタックした回数」 — the turn log's `attacked` entries narrowed to the
   * effect source's own card, the same relation `Condition.turnEvent` reads for
   * 「このターン中にこのキャラがアタックしている」.
   */
  | { source: 'selfAttackedThisTurn' }
  /**
   * 「このターン中に自分の効果で場外に置いた自分の手札の合計枚数により」 (DST-1-008) — the turn log's
   * `discardedFromHand` entries counted for the controller. With `ownEffect` only the entries the
   * controller's own effect caused count — the same relation `Condition.turnEvent.ownEffect` reads, so
   * a count and a gate can never disagree about which discards happened.
   */
  | { source: 'handDiscardedThisTurn'; ownEffect?: boolean }
  /**
   * 「このターン中に自分のキャラがレイドした回数」 — the turn log's `entered` entries carrying the
   * `raid` detail, the count form of the 「レイドしている」 gate. The entry names the raider, so `who`
   * picks whose raids count.
   */
  | { source: 'raidCountThisTurn'; who: PlayerScope }
  /**
   * 「この効果で選んだキャラの枚数」 — how many cards the resolving effect's own selection holds. The
   * count is only a fact about the frame, so the state-only reader answers 0 and `effects.ts` is
   * authoritative; `bind` names which selection (default `'A'`, the compiler's first binding).
   */
  | { source: 'selectedCount'; bind?: string }
  /**
   * 「選んだ〈チェン〉と同じ数の[ダメージ（+1）]を得る。」 (ARK-2-051) — the damage-*bonus* layers the cards
   * the named binding holds carry, summed: a Chen at damage 4 (default 1 + three +1s) contributes 3, which
   * is the print's 「[ダメージ（+1）]の数」. The printed base is excluded, so a character that merely prints
   * a higher DAMAGE lends nothing. A frame fact like `selectedCount`: the state-only reader answers 0 and
   * `effects.ts#tierCount` is authoritative.
   */
  | { source: 'selectedDamageBonus'; bind?: string }
  /**
   * 「この効果でリムーブエリアに置いたカード1枚につき」 — the cards *this effect* sent to リムーブエリア,
   * read from the resolving frame's own record (`EffectFrame.removedIds`) the way `restedEnergySum` reads
   * its `restedIds`. Identity is only a claim about what this effect did — once in the removal area a
   * card this effect moved is indistinguishable from one that was already there — so it lives on the
   * frame. Outside a resolving effect there is no "this effect": the state-only reader answers 0 and the
   * frame reader in `effects.ts` is authoritative.
   */
  | { source: 'removedByThisEffect' }
  /**
   * 「この効果で場外に置いた(手札|カード)1枚につき」 — the cards *this effect* sent to 場外, read from the
   * resolving frame's own record (`EffectFrame.discardedIds`). The sibling of `removedByThisEffect` for
   * the discard pile: 「この効果で場外に置いたカード1枚につき、このキャラはこのターン中、BP+500」 is a
   * claim about what this effect did, and once in the pile the cards are indistinguishable from the rest.
   */
  | { source: 'discardedByThisEffect';
      filter?: CardFilter }
  | { source: 'lifeCount'; who: PlayerScope }
  | { source: 'eventsUsedThisTurn';
      /**
       * 「このターン中に自分が使用した**他の**イベントカード」 — the source card drops out of the count.
       *
       * The per-player counter already includes the source (it is incremented when the card is played,
       * before its own effect resolves), so the exclusion is read from the turn log by identity instead
       * of subtracting.
       */
      other?: boolean;
      /**
       * 「このターン中に自分が使用した[特徴：食べ物]の枚数」 — the count narrowed by what the *used*
       * card prints. The per-player counter cannot answer it (it holds no identity), so a narrowed
       * count reads the turn log's `used` entries, which record the card itself. `kind` defaults to
       * nothing, so a caller that names only a trait counts every kind of use the log recorded.
       */
      trait?: string; kind?: 'character' | 'field' | 'event' }
  /**
   * 「自分の場に〈X〉がある場合、…1枚につき…」 — a count that is *zero* while the printed condition
   * fails. The gate is part of the count rather than a wrapper step: the same phrase feeds a `bpCeiling`
   * evaluated where a selection is bound, where no step can pose as a condition.
   */
  | { source: 'gated'; condition: Condition; count: TierCount }
  /** Distinct card names among the controller's field plus revealed hand cards carrying `trait`. */
  | { source: 'revealedTraitNames'; who: PlayerScope; trait: string;
      /**
       * 「自分のフロントLの[特徴：X]のカード名の種類数」 — the printed line, when the phrase names one.
       *
       * Absent reads the whole field plus the revealed-hand channel (the 「場と手札から公開した」
       * spelling). `front` / `energy` narrow the field pool to that line, which is what a print that
       * names フロントL asks for; without the distinction the count silently spanned both lines.
       */
      zone?: 'front' | 'energy' }
  /**
   * Cards in リムーブエリア — a different pile from 場外, so it needs its own threshold source
   * (「自分のリムーブエリアにあるカードの枚数により、…」).
   */
  | { source: 'removal'; who: PlayerScope; kind?: 'character' | 'field' | 'event';
      /**
       * 「自分の場外とリムーブエリアにある〈ジャイガー〉1枚につき」 — a *named* subject in the removal
       * area. The two piles are counted by different sources, so a cross-pile count is a `sum` of one
       * of these and a `sideline`; each side needs the same name vocabulary for that to be expressible.
       */
      name?: string; names?: string[] }
  /**
   * Distinct card *names* among the listed cards on a zone — 「自分の場にある〈A〉、〈B〉、〈C〉の
   * カード名の種類の数」. Distinct from `revealedTraitNames`, which asks about a trait rather than an
   * explicit list and reads the revealed-hand channel as well.
   */
  | { source: 'distinctNames'; who: PlayerScope; names?: string[]; kind?: 'character' | 'field' | 'event'; kinds?: ('character' | 'field' | 'event')[]; trait?: string; notTrait?: string; color?: Color; zone?: 'front' | 'energy' | 'field' | 'sideline' | 'fieldOrSideline' | 'removal'; other?: boolean;
      /**
       * 「〈A〉以外の自分の場のキャラのカード名の種類の数」 — an *excluded* name list, the mirror of
       * `names`: the named cards do not count toward the distinct-name total.
       */
      notNames?: string[];
      /**
       * 「必要エナジーが異なる…がN種類以上ある」 — the distinctness axis: `'energy'` counts distinct
       * printed required-energy *signatures* instead of names (two 〈綾波 レイ〉 with different costs are
       * two). Absent means the ordinary card-name reading.
       */
      by?: 'name' | 'energy' }
  /**
   * 「このキャラのBPにより、このキャラは以下の効果を全て得る」 — the threshold source is the source card's
   * own current BP, and the tiers are printed as 「・BPN以上：」 bullets.
   *
   * Like `selfBp` among the conditions, the value is read where the gate is evaluated, so a bonus that
   * raises the character's BP turns its tiers on without any bookkeeping.
   */
  | { source: 'selfBp'; who: PlayerScope }
  /**
   * 「自分の場の黄のカードの特徴の種類数分」 — the number of distinct *traits* printed across the named
   * player's field cards, optionally narrowed to one colour.
   *
   * The count-side sibling of `Condition.distinctTraits`: a card printing two matching traits contributes
   * two, exactly how the condition's reader counts them, so a look size and a gate can never disagree.
   */
  | { source: 'distinctTraits'; who: PlayerScope; color?: Color; traitContains?: string; other?: boolean }
  /**
   * 「この効果でレストにしたカードの必要エナジーの合計」 — the sum of the printed required energy over the
   * cards *this effect* rested (its own `restedIds`).
   *
   * Frame-scoped like `revealedTraitNames`: outside a resolving effect there is no "this effect", so the
   * state-only reader in `conditions.ts` answers 0 and the frame reader in `effects.ts` is authoritative.
   */
  | { source: 'restedEnergySum' }
  /**
   * 「この効果で場外からリムーブエリアに置いたカード1枚につき」 — the cards *this effect* moved into
   * リムーブエリア, counted off the frame's own record (`removedIds`). Only a claim about what the
   * effect did: once in the removal area the cards are indistinguishable from anything else there.
   */
  | { source: 'removedByThisEffect' }
  /**
   * 「登場かレイドさせたキャラの元々の必要エナジー1につき、このキャラはこのターン中、BP-1000。」
   * (IMC-1-009) — the *printed* required-energy total of the card(s) an earlier selection bound. A frame
   * fact like `selectedCount`: the binding lives on the resolving frame, so outside a resolution the
   * state-only reader answers 0.
   */
  | { source: 'boundPrintedEnergy'; bind?: string }
  /**
   * 「自分の場外にあるカードの必要エナジーの数の種類1つにつき」 (TKG-1-042) — how many *distinct*
   * printed requirement totals the named zone's cards carry. A board fact, read anywhere.
   */
  | { source: 'distinctEnergyValues'; who: PlayerScope; zone: 'sideline' | 'field' | 'fieldOrSideline' }
  /**
   * 「この効果で退場させたキャラの枚数分」 — how many characters *this effect* retired, read from the
   * frame's own `retiredIdsOwn` / `retiredIdsOpponent` records. Distinct from `discardedByThisEffect`,
   * which counts the cards this effect sent to 場外 as an instruction: a retirement by *another* rule
   * (a battle, a BP-zero) writes neither record, and a retire instruction writes this one alone.
   */
  | { source: 'retiredByThisEffect'; who?: 'self' | 'opponent' | 'both' }
  /**
   * 「レストにした枚数により、…」 / 「この効果で場外に置いたカード1枚につき、…」 — how many cards
   * *this effect* rested (`restedIds`) or discarded (`discardedIds`).
   *
   * Frame-scoped like `removedByThisEffect`: the identity of "what this effect did" has no trace on the
   * board once it is done, so it lives on the resolving frame. Outside a resolving effect there is no
   * "this effect": the state-only reader answers 0 and the frame reader in `effects.ts` is authoritative.
   */
  | { source: 'restedByThisEffect' }
  /**
   * 「自分の手札の枚数と、自分の場の［特徴：ALO］の枚数を合計し」 — several counts added together.
   *
   * Each part is an ordinary count expression, read exactly as it would be on its own, so a sum can
   * never disagree with the counts it is made of. No single source can carry it: the printed total
   * spans zones (`handCount` + `fieldCount`), and reading either one alone would undercount.
   */
  | { source: 'sum'; counts: TierCount[] }
  /**
   * 「相手の場のレストのキャラ2枚につき」 / 「自分のリムーブエリアにあるカード3枚につき」 — a count read
   * *per printed unit*: the pool is divided down by the unit before the value is used.
   *
   * The division is a floor, the way a 「N枚につき」 quantity reads (five cards under 「2枚につき」 is two
   * pairs, and the odd card still standing is not a pair). A unit of 1 is the plain count and is never
   * wrapped — the reader unwraps it, so the existing one-per vocabulary keeps its shape.
   */
  | { source: 'perUnit'; per: number; count: TierCount }
  /**
   * 「公開した紫のカードの必要エナジーの数により、…以下の効果を全て得る」 (MMM-2-016) — the printed
   * required-energy total of the card the resolving effect just revealed (the frame's `revealedIds`),
   * the reveal-axis sibling of the codebase's frame-scoped counts.
   *
   * `color` narrows to the revealed card's printed colour. With no revealed card of that colour there
   * is no count at all: the frame reader answers -1, which sits below every tier's floor so no band
   * fires — the same "admits nobody" convention `revealedBpCeiling` gives the selection side.
   */
  | { source: 'revealedEnergy'; color?: Color };
export type Trigger =
  | { type: 'get' }
  | { type: 'draw' }
  | { type: 'final' }
  | { type: 'raid' }
  | { type: 'active'; bpBonus: number }
  | { type: 'special' }
  /** [カラー] triggers carry a card-specific effect instead of a fixed template. */
  | { type: 'color'; effects: CardEffect[] };

/** Declarative predicates. Evaluated against the authoritative state only. */
export type Condition =
  | { type: 'lineHasSpace'; who: PlayerScope; line: Line }
  | { type: 'turnOf'; who: PlayerScope }
  | { type: 'line'; line: Line }
  | { type: 'atZone'; zone: 'sideline' | 'front' | 'energy' }
  | { type: 'isActive' }
  | { type: 'isRested' }
  | { type: 'selfActive' }
  | { type: 'selfRested' }
  /**
   * 「レイド状態」 — the source card is stacked as a raid top card (`underneath.length > 0`).
   *
   * The gate the compiler installs on the parts of a card that print inside its ◆レイド fence (Q51:
   * 「【レイド】で囲まれた部分の効果は無効になります。」). Read from the source's own slot, so a card in
   * hand, 場外 or リムーブエリア — where the fence can never be open — answers false.
   */
  | { type: 'raidState' }
  | { type: 'hasName'; who: PlayerScope; name: string }
  | { type: 'hasNameContains'; who: PlayerScope; fragment: string }
  | { type: 'hasTrait'; who: PlayerScope; trait: string }
  | {
      type: 'fieldCount'; who: PlayerScope; min?: number; max?: number; kind?: 'character' | 'field' | 'event'; line?: Line; trait?: string; notTrait?: string; color?: Color; notColor?: Color; name?: string; nameContains?: string; notNameContains?: string;
      /**
       * 「〈A〉と〈B〉が合計 N 枚以上ある」「[特徴：X]と[特徴：Y]が合計 N 枚以上ある」 — a *sum* over
       * several subjects. Every card matching any listed name (or trait) counts once, which is what the
       * printed 「合計」 asks; two separate counts would double-count a card that matches both.
       */
      names?: string[]; traits?: string[]; notNames?: string[];
      other?: boolean; minBP?: number; maxBP?: number; printedBP?: { min?: number; max?: number }; raid?: boolean; minEnergy?: number; maxEnergy?: number; traitOtherThan?: string;
      /**
       * 「…が3枚以上あり、その中に〈X〉がある」 (AND-1-010) — a named card *within the counted subject*,
       * read in addition to the trait instead of as a union with it (`names` unions, which would count a
       * リップ elsewhere).
       */
      namedAmong?: string[];
      /**
       * 「自分のフロントLに元々の消費APが2以上のキャラがある」 — the *printed* AP cost, the same
       * `CardDefinition.apCost` bound `CardFilter.minApCost` reads, so a count and a filter never
       * disagree about one card. The 「元々の」 is how the pool spells it; no modifier moves `apCost`.
       */
      minApCost?: number; maxApCost?: number;
      /** 「元々の消費AP」 — the printed sibling (Q1122): see CardFilter.printedApCost. */
      printedApCost?: { min?: number; max?: number };
      /**
       * 「BPが5000以上の〔カード名に「X」を含むキャラか〈Y〉〕」 — a union of subjects inside the count:
       * a card counts when it matches **any** branch, the enclosing bounds applying on top. The picker
       * reads one branch vocabulary (kind / colour / names / traits), the same set `parseFilter`
       * compiles for these spans.
       */
      anyOf?: CardFilter[];
      /**
       * 「[2回ブロック]を持つカードがある」 — the subject is a printed keyword, so the count reads the
       * card's effective keywords (printed + granted), the same set `getKeywords` answers with.
       */
      hasKeyword?: keyof Keywords;
      /**
       * 「[インパクト]か[ダメージ]を持つキャラがある」 — an *any-of* keyword list, the multi-keyword
       * spelling of `hasKeyword`. Read as the same union the `names` / `traits` arrays give: a card
       * counts when it holds **any** listed keyword, each read off the effective keyword set.
       */
      hasKeywords?: (keyof Keywords)[];
      /**
       * 「[トリガー]を持たないカードが N 枚以上ある」 — the printed trigger, read from the same
       * `CardDefinition.trigger` field `CardFilter.hasTrigger` reads, so a condition and a filter can
       * never disagree about the same card.
       */
      hasTrigger?: boolean;
      /**
       * 「自分の場に特徴を持つカードがない場合」 (RNK-1-040) — whether the card prints *any* trait at all.
       *
       * Distinct from `trait`, which names one trait and admits every other card; `traits` lists several
       * as a union. This is the bare existence test the printed 「特徴を持つ」 gives, and the negative
       * spelling is what the gate above writes (a `not` around the positive count).
       */
      traitPresent?: boolean;
      /**
       * 「[レイド]を持つ」 — the *printed* RAID ability (`CardDefinition.raid`), the same predicate
       * `selectedHas.raidAbility` reads.
       *
       * Distinct from `raid`, which is a state of the slot: a card that has the RAID ability is not
       * 「レイド状態」 until it is actually stacked on a base, and vice versa.
       */
      raidAbility?: boolean;
      /**
       * 「[アタック時]を持つ」「[ブロック時]を持つ」 — the *printed* triggered ability, the same
       * predicate `CardFilter.attackAbility` / `CardFilter.blockAbility` read, so a count and a filter
       * can never disagree about one card.
       */
      attackAbility?: boolean;
      blockAbility?: boolean;
      /**
       * 「[起動メイン]を持つ」 — the *printed* activated ability (`CardDefinition.activated`), the same
       * predicate `CardFilter.hasActivated` reads. Q422's raid-frame carve-out (a 起動メイン framed by
       * the [レイド] box on a non-raid-state card does not count) has no data marker in the pool yet;
       * when such a print appears, this predicate is where the exclusion goes.
       */
      hasActivated?: boolean;
      /**
       * 「同じラインに〈X〉がある」 — the pool is the effect source's *own* line, which is not a printed
       * line name: the same phrase means the front line on a front-line card and the energy line on an
       * energy-line one. The source's line is read when the condition is evaluated.
       */
      sameLine?: boolean;
      /**
       * 「このキャラと別のラインに〈X〉がある」 — the candidate must sit on a line *different* from the
       * effect source's own.
       *
       * The mirror of `sameLine` for the same reason: the line compared against is the source's, read
       * where the condition is evaluated. A source that has left the field has no line, so no candidate
       * can match; a card on the *other* line of a two-line board always does.
       */
      differentLine?: boolean;
      /**
       * 「自分の場の〈A〉か〈B〉の下に裏向きのカードがある」 — a bound on the *counted card's own* hidden
       * stack. The same face-down pile `CardFilter.underCount` and the `underCount` condition read, so a
       * subject narrowed by a name and a subject narrowed by a filter can never disagree about it.
       */
      underCount?: { min?: number; max?: number };
      /**
       * 「元々のBPよりBPが低いキャラがある」 — a comparison between the card's printed BP and its
       * current one. No filter field can express it, because both sides come from the same card.
       */
      bpBelowPrinted?: boolean;
      /**
       * 「このキャラのBPが元々のBPより低い/高い」 — the pool is the effect source *itself* rather than
       * its whole line (SAO-2-053/MCR-2-067: the comparison is about the granted card, so a debuffed
       * sibling must not satisfy it).
       */
      self?: boolean;
      /**
       * 「このキャラのBPが元々のBPより高い」 — the strict mirror of `bpBelowPrinted`: the current BP
       * *exceeds* the printed one. Kept as its own flag rather than a negation because the two are
       * compared strictly on opposite sides (equal BP satisfies neither reading).
       */
      bpAbovePrinted?: boolean;
      /**
       * 「…を1枚レストにしないとこのカードは使用できない」 (JJK-1-063) — only cards *this effect's own
       * rest* may touch are counted, the same gate `act rest` reads: a card granted 「自身のカードの
       * 効果でレストにできない」 (ARK-1-079) cannot pay the price, so Q1244's "use impossible while the
       * only payer is locked" closes through the count. Read with `refusesRest(ownEffect=true)` against
       * the effect source.
       */
      restable?: boolean;
      /**
       * 「相手の場にレストのキャラがある」「自分のフロントLにアクティブのキャラがない」 — the *slot*
       * state of the counted cards.
       *
       * Distinct from `selfRested` / `selfActive`, which ask about the effect source alone. Read the
       * same way `CardFilter.rested` and `TierCount.fieldCount.rested` read the field slot, so a count,
       * a filter and a threshold never disagree about the same card.
       */
      rested?: boolean; active?: boolean;
      /**
       * 「自分の場にこのカードと同じカードナンバーのカードが無い場合」 (FMA-1-079) — the pool narrows to
       * cards sharing the effect source's printed card number (`CardDefinition.functionalId`), so the
       * printed 「無い」 reads as `max: 0` over that narrowed pool.
       */
      noSameCardNumber?: boolean;
    }
  | { type: 'handCount'; who: PlayerScope; min?: number; max?: number;
      /**
       * 「自分の手札が他に2枚以上ある」 (AOT-2-034) — the count excludes the effect source itself, which
       * is the card the printed 「他に」 names while it sits in the hand being played.
       */
      other?: boolean;
      /**
       * 「自分の手札の[A]か[B]を1枚場外に置く」 (GNT-1-043) — the hand is counted *through this filter*:
       * the gate that decides whether a discard leg can be offered must ask about the very cards the
       * discard would take, or it opens a branch that resolves to nothing.
       */
      filter?: CardFilter }
  /**
   * 「自分の場と手札から公開した[特徴：X]が合計N枚以上ある場合」 — the field's matching cards plus the
   * hand cards revealed as part of *using* this card (`PlayerState.revealedHandAtUse`). A cost gate:
   * it is read while the play's AP is being priced, when both halves are on the table.
   */
  | { type: 'revealedPlusField'; trait: string; min: number }
  /**
   * 「自分の場と手札から公開した[特徴：X]の種類が N 種類以上ある場合」 (HTR-P-001) — the distinct card
   * *names* carrying the trait across the controller's field and the hand cards the resolving effect
   * revealed (the frame's own record, `EffectFrame.selections.__revealed`). The same pool
   * `TierCount.revealedTraitNames` counts; reading the gate from the frame keeps the two from ever
   * disagreeing about which cards the phrase names.
   */
  | { type: 'revealedTraitNames'; who?: PlayerScope; trait: string; min?: number; max?: number }
  /**
   * 「自分の山札が15枚以下の場合、…」 — how many cards are still in the deck.
   *
   * A `PlayerState` fact like `handCount`: the deck is a zone, not a board, and the printed gate is
   * about its size right now (a card that moves in or out changes the answer).
   */
  | { type: 'deckCount'; who: PlayerScope; min?: number; max?: number }
  /**
   * 「自分のフロントLのキャラの数が相手のフロントLのキャラの数以上の場合」 — a comparison between two
   * board counts.
   *
   * Neither side is a fixed number, so no single `fieldCount` bound can express it: `min`/`max` compare
   * against a printed value, and this compares the controller's line against the opponent's. The two
   * sides carry the slot qualifiers the pool prints (line and slot state), read by the same count reader
   * `fieldCount` uses so a gate and a count never disagree about one card.
   */
  | {
      type: 'fieldCountCompare';
      kind?: 'character' | 'field';
      left: { line?: Line; rested?: boolean; active?: boolean };
      right: { line?: Line; rested?: boolean; active?: boolean };
      op: 'atLeast' | 'more' | 'atMost' | 'less';
    }
  | { type: 'lifeCount'; who: PlayerScope; min?: number; max?: number }
  /**
   * 「自分と相手のライフの合計がN以下(以上)の場合」 — the two players' life areas counted as *one pool*.
   *
   * Distinct from `lifeCount`, which names one side: the printed subject is the sum, and the same total
   * is used by both a static BP gate and a hand-scope discount, so it needs its own condition rather
   * than two `lifeCount`s the compiler would have to add up per reader.
   */
  | { type: 'lifeSum'; min?: number; max?: number }
  /**
   * 「このキャラのレイド元が必要エナジーN以上」 — the *required energy* of the card directly beneath the
   * effect source (the one this raid covered), read from the slot's `underneath` stack.
   *
   * A card that is not in raid state has no base, so its total is zero — which is what makes
   * 「…1以上の場合」 false there, the reading the print intends.
   */
  | { type: 'raidUnderEnergy'; min?: number; max?: number }
  /**
   * 「このキャラのレイド元が［特徴：X］の場合」 — the *trait* of the card directly beneath the effect
   * source, the sibling of `raidUnderEnergy`. A card that is not in raid state has no base, so the
   * predicate is false there, which is what makes 「…の場合」 read as printed.
   */
  | { type: 'raidUnderTrait'; trait: string }
  /**
   * 「このキャラがレイドする際のレイド元のBPが4000以上だった場合」 — the *BP* of the card directly beneath
   * the effect source, the sibling of `raidUnderEnergy`. Like it, a card that is not in raid state has no
   * base and the predicate is false there.
   */
  | { type: 'raidUnderBp'; min?: number; max?: number }
  /**
   * 「このキャラのレイド元が〈X〉の場合」 / 「自分の場か自分のキャラのレイド元に〈X〉がある場合」 —
   * the *name* of a raid base, the sibling of `raidUnderTrait`.
   *
   * Without `who` it reads the effect source's own base (false when the card stands alone, which is what
   * makes 「…の場合」 read as printed). With `who` it asks whether *any* of that player's field characters
   * has such a base — the second half of 「自分の場か自分のキャラのレイド元に」, whose first half is an
   * ordinary `fieldCount`; the printed 「か」 unions the two.
   */
  | { type: 'raidUnderName'; name?: string; names?: string[]; nameContains?: string; who?: PlayerScope }
  | { type: 'energyCount'; who: PlayerScope; min?: number; max?: number }
  /**
   * 「自分と相手の発生エナジーの数が同じ場合、…」 — the two players' *generated* energy totals compared.
   *
   * A total, not a line size: the phrase counts the symbols the board actually produces (a character on
   * the front line produces none unless a static says otherwise).
   */
  | { type: 'energyCountCompare'; op: 'eq' | 'gt' | 'lt' }
  /** Cards in the sideline (場外) matching an optional kind/colour/trait filter. */
  | { type: 'sidelineCount'; who: PlayerScope; min?: number; max?: number; kind?: 'character' | 'field' | 'event'; color?: Color; trait?: string; notTrait?: string; name?: string; nameContains?: string; names?: string[]; traits?: string[];
      /**
       * 「自分の場外に**他の**イベントカードが6枚以上ある場合」 (REZ-1-032) — the source card itself
       * drops out of the pile count. For the spelling's own use the difference is invisible (an event
       * resolving is in no zone and cannot be in the pile), but the qualifier is modelled rather than
       * dropped so a sibling print counting a card that *can* sit in the pile reads exactly.
       */
      other?: boolean;
      /**
       * 「自分の場と場外にあるBP4000以上のカードが〈X〉のみ」 — the named cards drop out of the pile
       * count; with `max: 0` that "none outside the name" is the "only" reading, the same composition
       * `fieldCount.notNames` makes. Read off the printed name, the same set `names` reads.
       */
      notNames?: string[]; minBP?: number; maxBP?: number;
      /**
       * 「自分の場外にある消費APが2で特徴を持つカードの枚数」 (KMR-1-001) — the *printed price* and the
       * presence of any trait at all, the gate half of the tier count's `TierCount.sideline` fields.
       */
      apCost?: number; hasTrait?: boolean;
      /**
       * 「相手の場外に[スペシャルトリガー]を持つカードが2枚以上ある場合」 — the *printed* trigger kind,
       * read from the same `CardDefinition.trigger` field `CardFilter.triggerType` reads, so a pile
       * count and a filter can never disagree about the same card.
       */
      triggerType?: 'draw' | 'special';
      /**
       * 「自分の場外とリムーブエリアに[特徴：X]が合計 N 枚以上ある場合」 — the count spans *both* piles,
   * one pool, read like `TierCount.sum`'s sideline+removal pair. Excluding the removal area would
   * under-count exactly the cards the printed 「と」 adds.
       */
      alsoRemoval?: boolean;
      /**
       * 「特徴を持たないキャラカード」 — a card with no traits at all in the discard pile.
       *
       * Not the same as `notTrait`: that excludes cards carrying one named trait, while this admits only
       * cards carrying none. Read exactly like `CardFilter.noTraits`.
       */
      noTraits?: boolean;
      /**
       * 「自分の場外に[レイド]を持つ〈X〉が3枚以上ある場合」 — the *printed* RAID ability, read from the
       * same `CardDefinition.raid` the filter predicate (`CardFilter.raidAbility`) and the field count
       * read. A card in the pile is not stacked on anything, so this is the only RAID fact it can carry.
       */
      raidAbility?: boolean }
  /**
   * Cards in the **リムーブエリア** — a zone of its own, not the sideline.
   *
   * 場外 (the discard pile) is `sideline`; リムーブエリア is where 「リムーブエリアに置く」 puts cards and
   * nothing brings them back from. The two are counted by different conditions on purpose: a card that
   * asks for 「自分のリムーブエリアにカードが9枚以上ある」 is not asking about the discard pile.
   */
  | { type: 'removalCount'; who: PlayerScope; min?: number; max?: number; kind?: 'character' | 'field' | 'event';
      /**
       * 「自分のリムーブエリアに〈五条 悟〉がある場合」 — the same pile narrowed by a card name, read like
       * every other named count (`TierCount.removal` carries the same field for its 「N枚につき」 reading).
       */
      name?: string; names?: string[] }
  /**
   * Distinct card *names* among the cards a filter selects — 「自分の場に［特徴：X］のカード名が N 種類
   * 以上ある」 / 「異なるカード名を持つ…が N 種類以上ある」.
   *
   * `zone` says which cards count: `'front'` is フロントL, `'energy'` is エナジーL, `'field'` is 場
   * (both lines) and `'sideline'` is 場外. Names, not copies, so two printings of one identity count
   * once — and the scope has to be exact, because counting the energy line for a card that only names
   * the front line would make it stronger than printed.
   */
  /**
   * `zone` says which cards count: `'front'` フロントL, `'energy'` エナジーL, `'field'` 場 (both lines),
   * `'sideline'` 場外, and `'fieldOrSideline'` 場と場外 *together* — 「自分の場と場外に…が合計 N 種類以上」
   * counts one pool made of both, which is not the sum of two separate counts (the same name on the
   * field and in the discard pile is still one name).
   */
  | {
      type: 'distinctNames'; who: PlayerScope; min?: number; max?: number; kind?: 'character' | 'field' | 'event';
      color?: Color; trait?: string; notTrait?: string; zone?: 'front' | 'energy' | 'field' | 'sideline' | 'fieldOrSideline' | 'removal';
      /** 「緑の〔イベントカードとフィールドカード〕」 — a *union* of kinds counted together. */
      kinds?: ('character' | 'field' | 'event')[];
      names?: string[];
      /**
       * 「〈A〉以外の自分の場のキャラのカード名の種類の数」 — the named cards drop out of the distinct-name
       * count. The mirror of `names`, read by the same predicate.
       */
      notNames?: string[];
      /**
       * 「カード名に「ライダー」を含み、異なるカード名のキャラが8枚以上ある」 — only names containing this
       * string count. A qualifier `names` cannot carry: the pool names one card each time, and the
       * printed count is over a *class* of names (`KMR-1-004`).
       */
      nameContains?: string;
      other?: boolean;
      /**
       * 「自分の場外に必要エナジーが異なる赤の〈綾波 レイ〉が2種類以上ある」 (EVA-1-071) — the
       * distinctness axis: `'energy'` counts distinct printed required-energy *signatures* instead of
       * names, so two cards of the same name with different costs are two kinds. Absent means the
       * ordinary card-name reading.
       */
      by?: 'name' | 'energy';
    }
  /**
   * 「自分の場の他のカードに、「高校」を含む異なる特徴が3種類以上ある場合」 — distinct *traits*
   * carrying a printed fragment, counted over the controller's own field. 「自分の場の**キャラ**の特徴が
   * 3種類以上」 (IMS family) narrows the pool to one printed kind — field cards print traits too, but the
   * print names characters only.
   *
   * Not a `distinctNames`: the subject counts traits, not cards (a card printing two matching traits
   * contributes two), and 「含む」 is a fragment test. The corpus prints it on the HIQ 高校 family, where
   * the qualifying traits are the school names (烏野高校 / 音駒高校 / …) rather than any one literal.
   */
  | { type: 'distinctTraits'; who: PlayerScope; traitContains?: string; color?: Color; min?: number; max?: number; other?: boolean; kind?: 'character' | 'field' | 'event' }
  /**
   * 「自分の場外にあるカードの必要エナジーの数が N 種類以上ある場合」 (TKG family) — the number of
   * *distinct required-energy totals* among the named player's sideline cards.
   *
   * A zero row is not a requirement, so 「[赤-]」 and 「[青-]」 are the same (empty) kind — the grouping
   * `energySignature` uses everywhere else. Distinct from `distinctNames`, which counts card *names*.
   */
  | { type: 'sidelineEnergyVariety'; who: PlayerScope; min?: number; max?: number }
  /** Total energy produced by the player's energy line. */
  | { type: 'producedEnergy'; who: PlayerScope; min?: number; max?: number; color?: Color }
  /**
   * The effect source's current BP.
   *
   * By default this is measured *without* re-entering continuous statics — the value a
   * 「このキャラのBPがN以上の場合」 clause tests, which never depends on the modifier it gates.
   * `withStatics` reads the BP a player actually sees, continuous bonuses included; it is what a
   * 「このキャラのBPにより、…以下の効果を全て得る」 tier list needs, because the card's own
   * 「…枚につき BP+…」 bonus is exactly what is supposed to move those tiers.
   */
  | { type: 'selfBp'; min?: number; max?: number; withStatics?: boolean }
  /**
   * 「このキャラが[インパクト]を持つ場合のみ発動できる」 (MCR-2-017) — the effect source's own *effective*
   * keyword set (printed plus granted), the same read `selectedHas.keyword` gives a bound card. A
   * gate about the source cannot ride on `fieldCount`, which counts some pool of the board.
   */
  | { type: 'selfHasKeyword'; keyword: keyof Keywords }
  /** Face-down cards under the effect source, or — with `all` — the total across the controller's field. */
  | { type: 'underCount'; min?: number; max?: number; all?: boolean; who?: PlayerScope;
      /**
       * 「このキャラの下に元々のBPが3000以上のカードがある場合」 — a bound on the *printed* BP of a
       * card in the stack, read like every other `printedBP` bound (the modifier-inflated value a
       * `minBP` filter would see is not what the print asks about).
       */
      printedBP?: { min?: number; max?: number };
      /**
       * 「このキャラの下に〈定春〉がある場合」 (GNT-1-086) — a *named* card in the source's own stack.
       * Both halves of the stack are searched (raid bases and the face-down pile, the same pool
       * `printedBP` counts) and the name is read through `effectiveNames`, like every other name check.
       */
      names?: string[] }
  /**
   * 「自分の場のキャラの必要エナジーの合計がN以上」 — the printed requirement total over the
   * controller's own characters, the subject the トリコ energy-sum gates count.
   *
   * The total is the sum of every colour value on the card's *effective* signature (`[青×5]` counts
   * 5), read through `effectiveRequiredEnergy` so a 「としても扱う」 replacement counts at its
   * replacement value, exactly as the same cards intend.
   */
  | { type: 'fieldEnergySum'; who: PlayerScope; min?: number; max?: number }
  /**
   * 「自分の場の[特徴：念獣]と自分の場のキャラの下の裏向きのカードが合計2枚以上ある場合」 — a *sum*
   * over several counts, the condition sibling of `TierCount.sum`. Each part is an ordinary count
   * expression read by the same `tierCountOf`, so a gate can never disagree with a count printed
   * beside it.
   */
  | { type: 'countSum'; counts: TierCount[]; min?: number; max?: number }
  /** The controller has used at least one event card this turn. */
  /**
   * 「このターン中に自分が使用しているイベントカードの枚数により」 (CSM-1-010) — the per-turn event-use
   * *counter* with a threshold. Distinct from `usedEventThisTurn` (a boolean over the same counter) and
   * from the log-based `turnEvent used` (which also counts narrowed spellings): this reads exactly the
   * number `TierCount.eventsUsedThisTurn` counts, so a gate and a count can never disagree.
   */
  | { type: 'eventsUsedThisTurn'; who: PlayerScope; min?: number; max?: number }
  | { type: 'usedEventThisTurn';
      /**
       * 「このターン中に自分が**他の**イベントカードを使用している場合」 (CSM-1-040 / CSM-1-037) — the
       * source card itself drops out of the question (it is already counted when its own effect
       * resolves). Read from the turn log by identity, like the `other` form of the use *count*.
       */
      other?: boolean }
  /**
   * 「自分の手札の枚数が相手より少ない」 — the two players' hand sizes compared. `op` reads the
   * controller's count against the opponent's ("lt" is より少ない).
   */
  | { type: 'handCountCompare'; op: 'lt' | 'gt' | 'le' | 'ge' | 'eq' }
  /**
   * 「この効果で手札を公開した場合」 — the resolving effect itself made at least one hand card public.
   *
   * A frame fact like `selectionCount`: the reveal has no lasting trace on the board, so the effect
   * records what it revealed while it resolves.
   */
  | { type: 'thisEffectRevealedHand'; min?: number }
  /**
   * 「この効果で場外に置いたカードの種類に応じて、以下の効果を全て発動する」 — the resolving effect
   * discarded at least one card of this kind (「・キャラカード：…」).
   *
   * A frame fact like `thisEffectRevealedHand`: the discarded cards' identity lives on the frame
   * (`discardedIds`), and by the time the bullet that asks is read they are indistinguishable from
   * anything else in 場外.
   */
  | { type: 'thisEffectDiscardedKind'; kind: 'character' | 'field' | 'event' }
  /**
   * 「この効果で〈アウロラ〉を場外に置いた場合」 (KJN-1-014) — the resolving effect's own discard record
   * narrowed by a card *name*, the named sibling of `thisEffectDiscardedKind` reading the same
   * `discardedIds`.
   */
  | { type: 'thisEffectDiscardedName'; name: string }
  /**
   * 「この効果で自分の山札の下に置いたキャラが〈メフィスト〉の場合」 (ARK-1-019) — the resolving
   * effect's own deck-bottom record (`EffectFrame.deckBottomIds`) narrowed by a card name, the same
   * frame-fact channel `thisEffectDiscardedName` reads; the deck's bottom carries no identity.
   */
  | { type: 'thisEffectDeckBottomName'; name: string }
  /**
   * 「この効果で相手のキャラを退場させ、…場合」 — the resolving effect itself sent a character to 場外.
   *
   * The same frame-fact channel as `thisEffectRevealedHand`; `who` names whose characters the retirement
   * must have taken (「相手のキャラ」 is `'opponent'`).
   */
  | { type: 'thisEffectRetired'; who?: PlayerScope | 'both'; min?: number; max?: number;
      /**
       * 「この効果で必要エナジーが0のキャラを退場させた場合」 — the retirement must have taken a card
       * whose printed requirement total falls in this window. Read against the frame's own retirement
       * record (`retiredIds*`), the same identity channel the plain count uses.
       */
      maxEnergy?: number; minEnergy?: number }
  /**
   * 「この効果でキャラを2枚以上レストにしていた場合」 — the resolving effect itself turned that many
   * characters from active to rested.
   *
   * The same frame-fact channel as `thisEffectRetired`, read from the frame's own `restedIds`: once
   * rested, a card this effect rested is indistinguishable from one that already was.
   */
  | { type: 'thisEffectRested'; min?: number }
  /**
   * 「この効果でBPが5000のキャラをリムーブエリアに置いた場合」 — the resolving effect itself sent a
   * character of that BP to リムーブエリア.
   *
   * The same frame-fact channel as `thisEffectRetired`, read from the frame's own removal record
   * (`removedIds`): once in the removal area the card's identity as "what this effect moved" is gone.
   * The BP is the card's printed value — a card in the removal area carries no modifiers.
   */
  | { type: 'thisEffectRemoved'; minBP?: number; maxBP?: number;
      /**
       * 「この移動によって相手のキャラがリムーブエリアに置かれていない場合」 (JJK-3-012) — whose
       * characters the removal must have taken, read from the removed cards' owners the same way
       * `thisEffectBpZero` reads its side.
       */
      who?: PlayerScope }
  /**
   * 「この効果で相手のキャラのBPが0以下になった場合、…」 (EVA-1-042) — the frame's own BP record: the
   * characters this effect's BP changes brought to 0 or below. A frame fact like `thisEffectRemoved`:
   * once the check has run the card is in 場外 and nothing on the board remembers why.
   */
  | { type: 'thisEffectBpZero'; who?: PlayerScope }
  /**
   * 「手札から置いた場合」 — the card the resolving effect just placed under a host came from the hand
   * (「自分の手札か場外から…の下に…置く」, whose two zones the player chooses between when picking the
   * card). A frame fact: once the card is under the host its origin is gone.
   */
  | { type: 'thisEffectUnderFromHand'; min?: number }
  /**
   * 「この効果でこのキャラの下に裏向きのカードを置いた場合」 (MHA-P-003) — the same frame fact narrowed
   * to placements made under the *source itself*: a card the effect placed under another copy of the
   * named host does not satisfy it.
   */
  | { type: 'thisEffectUnderFromHandToSource'; min?: number }
  /**
   * 「場外に置いたカードの元々の必要エナジーの合計が15以上の場合」 — the *sum* of the printed required
   * energy over the cards this effect sent to 場外, the frame-fact sibling of `thisEffectDiscardedKind`
   * and the condition form of `TierCount.discardedEnergySum`.
   */
  | { type: 'thisEffectDiscardedEnergySum'; min?: number; max?: number }
  /** The effect source is currently stacked as a raid top card. */
  | { type: 'isRaidState' }
  /**
   * 「このキャラのバトル中、このキャラは…」 — the effect source is a participant in the battle being
   * resolved: the attacker, the blocker, or the card a 狙い撃ち attack named. A battle that is over (or
   * one between two other cards) is not 「このキャラのバトル」.
   */
  | { type: 'inBattle' }
  /**
   * 「自分のメインフェイズ中」 / 「自分のアタックフェイズ中」 — the game is in the controller's own named
   * phase right now.
   *
   * The current phase, not a log entry: an ability that resolves during the main phase (a 登場時 from a
   * play) reads it as true, while the same ability fired from an effect outside the main phase does not.
   */
  | { type: 'phase'; phase: 'main' | 'attack' }
  /**
   * 「このキャラがバトルによって退場した場合」 — the *cause* of the retirement a 退場時 ability is answering.
   *
   * Not a state predicate: the card is already leaving when its 退場時 abilities are read, and the
   * reason lives only in the call that removed it. Evaluated through `ConditionContext.retireReason`;
   * false when no reason is passed, which is the honest answer outside a retirement.
   *
   * 「自分の効果によって、このキャラが退場している場合」 names *whose* effect (`own`, read off the
   * cause card's owner) and 「自分の〈憎普天〉の効果で退場した」 names the cause *card* (`name`/`names`,
   * read off its definition) — both off `ConditionContext.retireCauseId`, which the retirement carries
   * from the effect frame that ordered it.
   */
  | { type: 'retireCause'; cause: 'battle' | 'effect' | 'bpZero'; own?: boolean; name?: string; names?: string[] }
  /**
   * 「このターン中にこのキャラが自分の[特徴：X]の効果で選ばれている場合」 — the retirement-time sibling
   * of `CardFilter.chosenByEffectThisTurn`, read from the asking player's own selection record. `self`
   * names the condition's own source card as the card that must have been chosen; `trait`/`name`/`names`
   * qualify the *chooser*.
   */
  | { type: 'chosenByEffectThisTurn'; who: PlayerScope; self?: boolean; trait?: string; name?: string; names?: string[] }
  /** The effect source's printed AP cost. */
  | { type: 'selfApCost'; min?: number; max?: number }
  /**
   * 「このキャラの必要エナジーが5以上の場合のみ発動できる」 — the effect source's printed required-energy
   * total, read the way `fieldCount.minEnergy` totals a candidate's symbols (including an on-field
   * 「…としても扱う」 replacement).
   */
  | { type: 'selfRequirement'; min?: number; max?: number }
  /**
   * 「自分の公開したカードの必要エナジーの数が相手の公開したカードの必要エナジーの数以上だった場合」 —
   * the two cards the resolving effect's own clash revealed, compared by printed required energy.
   *
   * A frame fact like `thisEffectRemoved`: the compared cards are back in their decks by the time the
   * sentence is read, so only the resolution knows what they were. False when the effect revealed no such
   * pair (nothing was revealed, or the effect is not resolving at all).
   */
  | { type: 'clashCompare'; compare: 'atLeast' | 'less' }
  /**
   * The character a *previous* `select` in the same effect bound — 「選んだキャラが〈X〉の場合」.
   *
   * This is the only condition that is not a pure state predicate: it reads the resolving frame's
   * selections, which `evalCondition` receives through its optional context argument. Every other
   * predicate is evaluated against the authoritative state alone and stays valid outside a resolving
   * effect; this one has no meaning there, so it is false when no selection context is passed.
   *
   * `bind` defaults to `'A'`, the bind name the compiler's selection rules emit.
   */
  | {
      type: 'selectedHas'; bind?: string;
      kind?: 'character' | 'field' | 'event'; trait?: string; color?: Color;
      name?: string; names?: string[]; nameContains?: string;
      /** Printed zone of the chosen card (「選んだキャラがエナジーＬにある」). */
      zone?: 'front' | 'energy';
      rested?: boolean;
      /** 「そのキャラが…アクティブの場合」 — the chosen card's slot state, the sibling of `rested`. */
      active?: boolean;
      /** 「選んだキャラがこのキャラ以外の場合」 — the chosen card is not the effect's own source. */
      notSelf?: boolean;
      /**
       * 「このキャラの効果でリムーブエリアに置かれた場合」 (KMR-2-035) — the bound card *is* the
       * effect's own source, the positive twin of `notSelf`. Read off the watcher's `cause` binding
       * (the effect source the event carried), which the engine hands to the frame as a selection.
       */
      self?: boolean;
      /**
       * 「選んだキャラがこのターン中に移動フェイズ以外で移動している場合」 — the bound card's own move
       * this turn, other than the movement phase's ordinary one, read from the turn log.
       */
      movedNotByMovePhaseThisTurn?: boolean;
      /** 「選んだキャラがこのターン中、自分の効果でアクティブからレストになったことがある」. */
      restedByEffectThisTurn?: boolean;
      /**
       * 「そのカードの必要エナジーの数がこの効果で指定した数と同じだった場合」 (DST-P-002) — the chosen
       * card's printed requirement total against the number announced earlier in the same effect.
       */
      energyEqualsDeclared?: boolean;
      /** The chosen card is stacked as a raid top card (「レイド状態」). */
      raid?: boolean;
      /**
       * 「手札から登場させた場合」 (KMR-1-022) — where the chosen card entered the field *from*, read off
       * its own entry record (`FieldCard.entered.from`). Only a card on the field has such a record, so
       * the predicate is false for a card that never entered.
       */
      enteredFrom?: 'hand' | 'sideline' | 'deck' | 'removal';
      /**
       * 「そのカードと同じカード名を持つカードが自分の場になく」 (KJN-1-077) — no card on the bound
       * card's owner's field shares a name with it (the same test `CardFilter.nameNotInOwnField` gives a
       * *candidate*, read here about a card already bound).
       */
      nameNotInOwnField?: boolean;
      /**
       * 「そのカードが必要エナジーを満たす」 (KJN-1-077) — the bound card's requirement against its
       * owner's produced energy, the selected-card sibling of `selfEnergySatisfied`.
       */
      energySatisfied?: boolean;
      /**
       * 「［特徴：X］の効果で…を与えられている場合」 (KIN-1-051) — the bound card carries one of
       * `grantedModifiers` as a live `grantStatic` grant whose recorded `sourceTraits` include
       * `grantedByTrait`.
       */
      grantedByTrait?: string; grantedModifiers?: ('cannotAttack' | 'cannotBlock')[];
  /** The chosen card carries a printed RAID ability (「[レイド]を持たない」). */
  raidAbility?: boolean;
      /** A printed keyword, with its printed value for the numeric ones (「[ダメージ（2）]を持つ」). */
      keyword?: keyof Keywords;
      keywordAmount?: number;
      hasKeyword?: boolean;
      /**
       * 「選んだキャラのBPが2500以上の場合」 / 「選んだキャラのBPが5000以上になった場合」 — the bound card's
       * *current* BP, the same value `Condition.fieldCount`'s bounds read: modifiers the same effect has
       * already applied count (the printed sentence follows the grants it asks about).
       */
      minBP?: number; maxBP?: number;
      /**
       * 「選んだキャラが必要エナジーが4以上の〈ウォーズマン〉の場合」 — the bound card's printed
       * required-energy total, read the way `CardFilter.minEnergy` reads it everywhere else.
       */
      minEnergy?: number; maxEnergy?: number;
      /**
       * 「選んだキャラの元々の消費APが2以上の場合」 — the bound card's printed AP cost, the same
       * `CardDefinition.apCost` bound `CardFilter.minApCost` and `Condition.fieldCount.minApCost` read.
       */
      minApCost?: number; maxApCost?: number;
      /** 「元々の消費AP」 — the printed sibling (Q1122): see CardFilter.printedApCost. */
      printedApCost?: { min?: number; max?: number };
      /**
       * 「選んだキャラの下に裏向きのカードがある場合」 — a bound on the chosen card's own hidden stack,
       * read off its slot like `CardFilter.underCount`. A bound card that has left the field has no
       * stack, so the predicate is false there — the honest reading of 「…がある」.
       */
      underCount?: { min?: number; max?: number };
      /** 「選んだキャラが〈シモン〉かレイド元が〈シモン〉のキャラの場合」 — the chosen card's raid base name. */
      raidUnderName?: string; raidUnderNames?: string[];
    }
  /**
   * How a card *entered* the field — 「このキャラが自分の効果で登場していた」.
   *
   * The origin is recorded once, when the card is placed, and never recomputed: it is a fact about
   * that placement, not about the current board. `who` absent means the effect source itself; with
   * `who` the predicate asks whether *any* of that player's field cards entered that way, which is
   * the 「このターン中に自分のキャラが…登場している」 reading.
   */
  | {
      type: 'enteredVia'; who?: PlayerScope; from?: 'hand' | 'sideline' | 'removal' | 'deck'; by?: 'play' | 'effect'; thisTurn?: boolean; name?: string; nameContains?: string;
      /**
       * 「〈メモリチェンジ〉の効果で登場していた」 (KMR-2-048/054/057) — the placing *effect's source card*
       * is one of these names. Distinct from `name`, which reads the card that entered: the printed
       * 「〈X〉の効果で」 names the cause, not the subject.
       */
      causeName?: string;
      /** Require the placing effect's controller to match (or differ from) the entrant's owner. */
      ownEffect?: boolean;
      /** 「キャラカードが…登場している」 — only a character counts, not a フィールド placed on the energy line. */
      kind?: 'character' | 'field';
      /**
       * 「…レイドさせている」 — the placement was a RAID. A separate flag rather than a `by` value: a RAID
       * *is* a play, so folding it into `by` would make every existing 「手札から登場していた」-style
       * condition stop matching raided cards.
       */
      raid?: boolean;
      /**
       * 「このキャラが自分の〔キャラ・フィールド〕の効果で登場していた場合」 — the *kind* of card whose
       * effect placed it. `by: 'effect'` says an effect did it; this says which kind of source, which
       * only the placement site knows. A list because the printed 〔A・B〕 unions kinds.
       */
      byKind?: ('character' | 'field' | 'event')[];
    }  /**
   * 「このターン中に…した／している／していた／したことがある」 — counts the turn's recorded events.
   *
   * `who` defaults to the effect's controller ("自分の…"), because that is what the printed wording
   * means when it names no one. `self: true` narrows it to the effect source itself, which is the
   * 「このキャラが…」 reading — the two are different questions and must not be collapsed.
   *
   * `kind` / `color` / `trait` filter the *named card* (the one that retired, moved, was used as the
   * effect that paid AP, and so on). `min` / `max` bound the count; an absent bound is open.
   */
  | {
      /**
       * `who: 'both'` is 「…が合計 N 枚以上…」 over a subject that names no owner (「このターン中にキャラが
       * 2枚以上退場している場合」): the entries of *both* players count toward one threshold. Distinct
       * from a `{ any: [...] }` union of per-side predicates, whose thresholds apply per side.
       */
      type: 'turnEvent'; event: TurnEventKind; who?: PlayerScope | 'both'; self?: boolean; min?: number; max?: number; kind?: 'character' | 'field' | 'event'; color?: Color; trait?: string; excludeSelf?: boolean; name?: string; nameContains?: string; phase?: Phase; notPhase?: Phase; free?: boolean;
      /** 「BPが0以下になることか効果によって」 — the retirement's route, recorded with the log entry. */
      cause?: 'bpZero' | 'battle' | 'effect';
      /**
       * 「[APを1支払う]を含む[起動メイン]を発動している」 (TKG-1-026) — whether the activated ability
       * behind an `abilityActivated` entry carried the printed AP-cost tag. Distinct from `apCost`,
       * which bounds the entry's *card* by its printed cost.
       */
      activatedApCost?: boolean;
      /**
       * 「このターン中に自分がカードを4枚以上引いている」 — a *card* total over the matching entries,
       * as opposed to `min`/`max`, which count the entries themselves. A draw of four cards is one
       * entry carrying `count: 4`, so the two readings are different questions over the same log.
       */
      cardCount?: { min?: number; max?: number };
      /** 「エナジーLからフロントLに移動した」 — the line the event's card *reached* (recorded with the event). */
      toLine?: Line;
      /** 「自分のフロントLのキャラが…」 — the line the named card was on when the event happened. */
      line?: Line;
      via?: 'play' | 'effect';
      /**
       * 「自分の効果で手札から登場している」 — the `entered` entry's origin zone, recorded with the
       * placement. `via` says an effect did it; this says the card left the *hand*, which no other
       * field of the record carries. Entries that recorded none satisfy neither spelling.
       */
      from?: 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under';
      /**
       * 「このターン中に自分の場に[ゲット]を持つキャラが登場している場合」 (EVA-1-003) — the entered
       * card's *printed trigger*, read off its definition at evaluation time like `printedBP`
       * (the card may already have left the field). [ゲット] is `trigger.type === 'get'`.
       */
      triggerType?: 'get' | 'draw' | 'special';
      /**
       * 「このターン中に消費APが2のカードを使用している場合」 — the *used card's printed AP cost*.
       *
       * The `used` log entry names the card, so the value is read off its definition at evaluation
       * time. Kept apart from the other card filters because the printed qualifier is the price the
       * card paid, not its name, colour or kind (Q514: only the controller's own uses count).
       *
       * 「このターン中に自分の場に元々の消費APが2以上のカードが登場している場合」 (FMA-1-059/063) —
       * the *bounded* spelling over placed cards; the comparator decides the bound, the same reading
       * `CardFilter.minApCost` makes of 「元々の消費APが N 以上」.
       */
      apCost?: number | { min?: number; max?: number };
      /**
       * 「元々のBPが4000以上の…が退場している」 — the *printed* BP of the card the event names.
       *
       * Read from the logged card's definition, since the card has already left by the time the clause is
       * evaluated; the same field `Condition.fieldCount.printedBP` and `CardFilter.printedBP` read.
       */
      printedBP?: { min?: number; max?: number };
      /**
       * 「このターン中に自分が元々の必要エナジーが6以上のイベントカードを使用している」 — the *printed*
       * required-energy total of the card the `used` entry names.
       *
       * The sibling of `printedBP` for the same reason: the used card may already be in 場外, so the
       * value is read off its definition at evaluation time, and the printed total is not inferable
       * from anything on the board.
       */
      printedEnergy?: { min?: number; max?: number };
      /**
       * 「…がレイドしている／していた」 — the entry was a RAID. Read from the record's own `raid` detail
       * (nothing else distinguishes a raid entry from a plain one after the fact).
       */
      raid?: boolean;
      usedFrom?: 'hand' | 'removal' | 'deck';
      /**
       * 「このターン中に自分の効果で自分の手札を場外に置いている場合」 — the entry was raised by *this
       * player's own* effect, read off the record's `causeOwner`. `false` is the opponent-effect spelling;
       * an entry that recorded no cause (a rule-driven entry) satisfies neither.
       */
      ownEffect?: boolean;
      /**
       * 「このターン中に自分か相手の効果で自分か相手が手札を場外に置いている場合」 (SYN-1-048) — the
       * entry was raised by *an effect* of either player, which is what distinguishes it from a discard
       * paid as a cost (`ownEffect` cannot say this: it resolves to one owner, and records with no cause
       * match neither of its spellings). Read off the record's own `causeOwner` presence.
       */
      byEffect?: boolean;
      /**
       * 「…黄以外のカードを公開して手札に加えている」 (KMR-1-002/003/031) — the event's card is *not*
       * this colour. The negative sibling of `color`: a card printing 「黄以外」 names an exclusion, and
       * folding it into `color` would match exactly the cards the print excludes.
       */
      notColor?: Color;
      /**
       * 「[レイド]を持つ…カードを公開して手札に加えている」 — the event's card carries the *printed*
       * RAID ability, read from its definition at evaluation time like `printedBP`. Distinct from
       * `raid`, which asks whether the entry itself was a raid.
       */
      raidAbility?: boolean;
      /**
       * 「カード名に「オーズ」か「バース」を含むキャラがアタックしている」 (KMR-1-063/065) — an any-of
       * name-fragment list; `nameContains` carries a single fragment, and a two-name subject is a union
       * of predicates rather than one wider one.
       */
      nameContainsAny?: string[];
      /**
       * 「カード名に「オーズ」を含むキャラの効果で…」 (KMR-1-062) — the printed qualifier names the *cause
       * card* rather than the event's own card, so it is read off `TurnEvent.causeId`'s definition.
       */
      causeNameContains?: string;
      /**
       * 「**自分のキャラ**の効果で自分の手札から…を場外に置いた時」 (KMR-1-081) — the *kind* of card whose
       * effect raised the entry, read off `TurnEvent.causeId`'s definition. `ownEffect` says whose effect
       * it was; this says what kind of card it was.
       */
      causeKind?: 'character' | 'field' | 'event';
      /**
       * 「このターン中に自分のイベントカードか〈煉獄 杏寿郎〉の効果で…」 — a union over the cause card,
       * where each alternative may name a kind, an exact name or a name fragment. The siblings above
       * carry one alternative each; the printed か takes several.
       */
      causeAnyOf?: Array<{ kind?: 'character' | 'field' | 'event'; name?: string; nameContains?: string }>;
      /**
       * 「このターン中に**このキャラの**[登場時]によってキャラが退場している場合」 — the cause card is
       * the condition's own source, read off the entry's `causeId`.
       */
      causeSelf?: boolean;
      /**
       * 「このターン中に自分の場に異なるカード名の[特徴：X]が3種類以上登場している場合」 (MMM-2-027 族)
       * — the matching entries' card *names*, deduplicated, instead of the entries themselves.
       *
       * Every entry filter above still applies (`trait` / `kind` / `via` / …), so this is the same log
       * query with a different counting axis: a card that entered and later left the field still counts
       * (the log survives the moment), and two entrances of one name count once. The name is the
       * *printed* `definition.name`, the axis `distinctNames` counts on. Bounds live here rather than on
       * `min`/`max` so the two readings cannot be confused: with this key present the entry bounds are
       * not consulted at all.
       */
      distinctNames?: { min?: number; max?: number };
    }
  /**
   * 「公開したカードが〈X〉の場合」 — a fact about the card the effect just looked at.
   *
   * Nothing on the board answers this: the card may already be in hand, or back on the deck. The frame
   * records what it revealed, and the predicate reads that record.
   */
  | { type: 'revealedHas'; kind?: 'character' | 'field' | 'event'; name?: string; names?: string[]; notNames?: string[]; nameContains?: string; trait?: string; notTrait?: string; color?: Color; minEnergy?: number; maxEnergy?: number; maxApCost?: number;
      /**
       * 「必要エナジーを満たし」 — the revealing player's produced energy already covers the card's
       * requirement (the chooser's energy line, read where the condition is evaluated).
       */
      energySatisfied?: boolean;
      /** 「[レイド]を持つ」 — the revealed card's *printed* RAID ability, the same field `CardFilter.raidAbility` reads. */
      raidAbility?: boolean;
      /**
       * 「公開したカードがBP4000以上のキャラカードの場合」 (REZ-1-034/045) — the revealed card's printed
       * BP, read with the Re:Zero hand-BP treatment (`handBpReferenceBonus` 「BP+1000されたものとして
       * 扱ってもよい」 / a revealed card's `revealedAsCharacter`), the same value the
       * `revealedBpCeiling` filter compares against.
       */
      minBP?: number; maxBP?: number;
      /**
       * 「このカードを公開し、BPが4000以上の場合」 (REZ-1-047) — the *source* card is the revealed card.
       * The reveal is performative (the card stays in hand), so the predicate reads the source itself
       * rather than the frame's record; a frame with no reveal at all can still ask this.
       */
      self?: boolean;
      /** 「…の必要エナジーの数がこの効果で指定した数と同じ」 — the announced number, read from the frame. */
      energyEqualsDeclared?: boolean }
  /**
   * 「アタックしている相手のキャラが…」 — a fact about the card that declared the battle being resolved.
   *
   * It is not a board predicate: the attacker may have retired to the battle's result, and the question
   * is about *this* attack rather than about any card currently on a line. False outside a battle.
   */
  | { type: 'battleAttacker'; raid?: boolean; trait?: string; color?: Color; name?: string; names?: string[]; nameContains?: string; kind?: 'character' | 'field' | 'event';
      /**
       * 「アタックしている相手のキャラの元々のBPがN以下」 — the attacker's *printed* BP, the sibling of
       * `minBP`/`maxBP` (which read the current, modifier-folded value).
       */
      printedBP?: { min?: number; max?: number };
      /** 「アタックしている相手のキャラが[インパクト]を持つ」 — the attacker's effective keywords. */
      keyword?: keyof Keywords;
      /**
       * 「アタックしている相手のキャラが[インパクト]か[ダメージ]を持つ場合」 (AND-1-024) — the printed
       * 「か」 union: any one of the listed keywords satisfies it, which one `keyword` cannot carry.
       */
      keywords?: (keyof Keywords)[];
      /** 「アタックしている相手のキャラのBPが4500以上」 — its current BP, the value the table shows. */
      minBP?: number; maxBP?: number }
  /**
   * 「BP5000以上のキャラとのバトルに勝利した時」 (AOT-2-007) — a fact about the card that *took the
   * block* (the battle's defender), the mirror of `battleAttacker`. False while no blocker is recorded:
   * an unblocked attack fought no character, so no 「…とのバトル」 happened.
   */
  | { type: 'battleDefender'; minBP?: number; maxBP?: number; name?: string; nameContains?: string }
  /**
   * 「自分か相手の山札かライフに表向きのカードがある場合」 — how many cards are face-up among the named
   * players' deck tops and life areas.
   *
   * Only `deck` reads a card's own face (`PlayerState.deckTopFaceUp` names the top card); every other
   * deck card is face-down by definition. `who: 'both'` is the 「自分か相手の」 / 「自分と相手の」 spelling,
   * which counts the two players together — 「合計3枚以上」 is `min: 3` on that sum.
   */
  | { type: 'faceUpCount'; who?: PlayerScope | 'both'; zones?: ('deck' | 'life')[]; min?: number; max?: number }
  /**
   * 「この効果で表向きではないカードを引いた場合」 — the draw this effect just performed took at least one
   * card that was not the face-up top.
   *
   * A frame fact like `thisEffectRested`: by the time the sentence is read the card is in hand and
   * indistinguishable from anything else drawn, so only the drawing itself can say what was pulled.
   */
  | { type: 'drewFaceDown' }
  | { type: 'not'; condition: Condition }
  | { type: 'all'; conditions: Condition[] }
  | { type: 'any'; conditions: Condition[] }
  /**
   * 「選んだキャラのカード名が同じ場合」 — two bindings of the same effect hold cards that *share a card
   * name* (aliases are read through `effectiveNames`, like every other 〈X〉 test). Both bindings must be
   * non-empty; a declined selection answers false, which is what the printed gate means.
   */
  | { type: 'boundSameName'; a: string; b: string }
  /**
   * 「合計2枚選んだ場合」 — how many cards the listed bindings hold together.
   *
   * A sentence that follows several selections counts *their sum*, which no single binding carries:
   * 「相手のフロントLのキャラと、発生エナジーが1以下の相手のエナジーLのキャラをそれぞれ1枚まで選び、
   * それらをレストにする。合計2枚選んだ場合、…」 asks whether both choices were actually made. The
   * `min` is the printed 「合計N枚」; a binding that was never made contributes zero.
   */
  | { type: 'selectionCount'; binds: string[]; min?: number; max?: number }
  /**
   * 「このカードが必要エナジーを満たしている場合」 (AND-1-046) — the effect source's own requirement against
   * its controller's produced energy. The condition sibling of the engine-core `energySatisfied` (which
   * `conditions.ts` cannot call — the module never imports `engine.ts`), read wherever a printed gate on
   * the card's own energy has to ride on a step rather than on a hand-only channel.
   */
  | { type: 'selfEnergySatisfied'; who?: PlayerScope }
  /**
   * 「「APを1支払い、…」をしてもよい」 (KGD-1-044/061 族) — the paying player's active AP covers the
   * branch's own `payAp` total. The AP sibling of `selfEnergySatisfied`, read as the chooser's
   * `optionGates` entry: an option whose branch pays AP it cannot pay must not be offered — answering
   * it would throw `INSUFFICIENT_AP`, refuse the whole command and lock a deterministic policy
   * (fuzz seed 4144). No printed condition spells this; the compiler derives the gate from the branch.
   */
  | { type: 'selfApAvailable'; count?: number }
  /**
   * 「この効果で選んだキャラの必要エナジーの合計が4以上の場合、…」 (MGS-1-094) — the summed requirement
   * total over the bound picks (every colour value on each card's *effective* signature, the same read
   * `fieldEnergySum` / `fieldCount.minEnergy` use). The energy sibling of `selectionCount`, which counts
   * the picks instead of weighing them.
   */
  | { type: 'selectionEnergySum'; binds: string[]; min?: number; max?: number }
  /**
   * 「相手が選んだ通りの場合」 (FMA-1-096) — the statement the opponent picked at the top of this
   * resolution ("the hand has 〈X〉" / "the hand doesn't") against the hand as it stands when the clause
   * is read (the draw and reveal printed between them have already happened). Reading the *chosen*
   * claim, not a board fact, which is why it lives on the frame (`ConditionContext.statementChoice`).
   */
  | { type: 'statementMatchesHand'; name: string }
  /**
   * 「自分のフロントLのキャラが全て［特徴：女神］」 — *every* card in a zone matches, and the zone is
   * non-empty.
   *
   * Not a count: 「全て」 is satisfied by one matching character and by four, and it is *not* satisfied
   * by an empty line (the printed 「自分の場のキャラが全て…」 reads "the characters you have are all
   * X", which says nothing about a board with none). No `fieldCount` bound expresses "all, and at
   * least one", so the predicate is its own node.
   */
  | { type: 'fieldAll'; who: PlayerScope; line?: Line; filter: CardFilter };

/** Always-on modifiers. Recomputed on every read; never stored on the field card. */
export type StaticModifier =
  | { type: 'bp'; amount: number }
  /**
   * 「…N枚につき、このキャラはBP+N」 — a bonus that scales with a count instead of being fixed.
   *
   * It has to be a static rather than a one-shot step because the count changes while the card sits on
   * the field: the printed bonus is whatever the count is at the moment the BP is read.
   */
  | { type: 'bpPer'; count: TierCount; amount: number }
  /**
   * 「自分のフロントＬの［特徴：子供］1枚につき、このキャラは、[ダメージ（+1）]を得る。」 — a *keyword*
   * that scales with a count, the sibling of `bpPer`.
   *
   * Like `bpPer` it is a static rather than a one-shot step: the count changes while the card sits on
   * the field, so the value is read when the keyword is (the same `tierCountOf` reader every 「N枚に
   * つき」 bonus uses). Read by `staticDamage` / `staticImpact` beside their fixed modifiers.
   */
  | { type: 'keywordPer'; keyword: 'damage' | 'impact'; count: TierCount; amount: number }
  | { type: 'energy'; energy: Energy }
  /**
   * 「このカードの下の裏向きのカード1枚につき、このカードの発生エナジー+[緑]」 — an energy bonus that
   * scales with a count, the energy sibling of `bpPer`.
   *
   * Like `bpPer` a static rather than a one-shot step: the hidden stack changes while the card sits on
   * the board, so the value is read when the energy is (the same `tierCountOf` every 「N枚につき」 uses).
   */
  | { type: 'energyPer'; energy: Energy; count: TierCount }
  /**
   * 「自分の場のキャラ全てはフロントLでもエナジーを発生させる」 — a *player-scope* grant: every one of
   * that player's field characters produces energy even on the front line, the broadcast form of the
   * card-scope `generatesFromFront`. Read from `PlayerState.grantedStatics` where the total is summed.
   */
  | { type: 'fieldGeneratesFromFront' }
  /**
   * 「自分の効果で相手がカードを引く場合、代わりに自分が同じ枚数カードを引く。」 (SYN-1-070/079/096) — a
   * replacement over the draw itself: when an effect *this player controls* would draw for the other
   * side, this player draws that many instead.
   *
   * Read where an effect's draw lands (`effectDraw`), so every route that draws through an effect
   * observes it. The card-scope form rides the printing card's `StaticAbility` (its state tags gate it
   * like any other static); the player-scope form arrives through `grantStatic target:'player'` and the
   * same read consults `playerStatics`.
   */
  | { type: 'opponentDrawRedirect' }
  /**
   * 「自分の[退場時]は発動させなくてもよい。」 (GNT-1-057) / 「自分の[退場時]が発動する際、自分の手札を
   * 1枚場外に置いてもよい。そうした場合、その[退場時]は発動しない。」 (GNT-1-036) — a gate over the
   * controller's own [退場時] triggers: when one of the controller's characters retires, the controller may
   * decline its own [退場時] (no `cost`) or pay `cost.hand` hand cards to negate it.
   *
   * Read where the retiring card's own [退場時] list is collected (`leaveField`), scanned over the
   * controller's own field — the printed 「[フロントLにある場合]」 rides on the StaticAbility's own
   * condition like every other state tag.
   */
  | { type: 'retireTriggerGate'; cost?: { hand: number } }
  /**
   * 「自分の場のカード全ての発生エナジーは2倍になる」 — a player-scope multiplier over the generated
   * energy of that player's cards. Entries *multiply* (the printed 「（この効果は重複する）」 says a
   * second copy doubles again), so two holdings are ×4.
   */
  | { type: 'energyGenMultiplier'; factor: number }
  /**
   * 「自分はこのターン中、合計N回までしかアタックできない」 — a player-scope cap on how many attacks
   * that player may declare this turn, counted from the turn log's `attacked` entries.
   */
  | { type: 'attackLimit'; max: number }
  /**
   * 「このキャラが自分の場にある場合、自分の場に〈カミナ〉は登場できない」 — while the carrying card
   * sits on its controller's field, the named cards cannot be deployed to that field (by a play or by an
   * effect's placement). Read where a placement is attempted, from the deploying player's field.
   */
  | { type: 'forbidDeploy'; filter: CardFilter }
  /**
   * 「このカードが使用されること以外でリムーブエリアに置かれる場合、代わりに場外に置く」 — a redirect
   * of every リムーブエリア placement except the card's own 使用, the mirror of `sidelineToRemoval`.
   */
  | { type: 'removalToSideline' }
  | { type: 'impact'; amount: number }
  | { type: 'damage'; amount: number }
  | { type: 'keywords'; keywords: Keywords }
  | { type: 'aliasName'; name: string }
  | { type: 'nameOverride'; name: string }
  /**
   * 「〈日万凛＆朱々〉として扱わない」 (MSS-P-003) — the printed name (or an alias) is *not* one this card
   * counts as. The readers that build a card's effective name list remove it after the aliases are added.
   */
  | { type: 'notAliasName'; name: string }
  | { type: 'allColors' }
  | { type: 'enterActive' }
  | { type: 'enterRested' }
  | { type: 'canStep' }
  /**
   * 「このキャラは BP N 以下のキャラにブロックされない。」 / 「…カード名に「X」を含むキャラをブロック
   * できない。」 — the blocker-side refusal.
   *
   * Two printed spellings: a BP bound (`maxBP`) and a subject filter (「カード名に「デビルーク」を含む
   * キャラ」). The filter form is a `CardFilter`, matched against the *blocker* with the attacker as the
   * effect source — the same `matchesFilter` every selection uses, so a name fragment reads the same way.
   */
  | { type: 'cannotBeBlockedBy'; maxBP?: number; filter?: CardFilter }
  /**
   * 「自分の[レイド]を持つキャラカードはこのキャラにレイドできる。」 — the card *becomes a raid base*
   * for every raider the printed subject names, regardless of the raider's own 〈X〉/特徴 list.
   *
   * Read by `raidBaseEligible` where it judges the base: a matching modifier satisfies the name/trait
   * test with any raider that carries the RAID ability. `filter` narrows the raider when the print names
   * a subject (「〈アスタ〉はこのキャラにレイドできる」); absent means every raid card.
   */
  | { type: 'canBeRaidedBy'; filter?: CardFilter;
      /**
       * 「…はトリガーの効果でこのキャラにレイドできる。」 — the route the permission opens. Absent means
       * every route (the plain spelling); `'trigger'` is the [レイドトリガー] path only, which is
       * narrower than printed if read as the plain grant.
       */
      via?: 'trigger' }
  /** Cannot be blocked by characters whose current BP is at least `minBP`. */
  | { type: 'cannotBeBlockedByAtLeast'; minBP: number }
  /** Immune to effects that reduce this card's BP. */
  | {
      type: 'immuneToBpMinus';
      /**
       * 「相手のキャラの効果で〔退場せず、BPをマイナスされない〕。」 (AOT-2-028) — the passive spelling
       * of the immunity, narrowed to the printed route. Absent covers every effect route, which is what
       * the bare 「BPをマイナスする効果を受けない」 prints.
       */
      source?: 'characterEffect';
    }
  /**
   * 「自分の効果で［特徴：X］を数える場合、このキャラは2枚分として扱ってもよい。」 — while its own
   * controller is the player counting the printed trait, this card weighs `count` instead of one.
   *
   * Read by both counting paths (`TierCount.fieldCount` and `Condition.fieldCount`). The printed 「しても
   * よい」 is not asked as a question: the engine reads the advantageous count, the same convention the
   * 「…としても扱う」 replacement lines follow.
   */
  | { type: 'countsAsMultiple'; trait: string; count: number }
  /**
   * 「自分の効果で自分の手札のキャラカードのBPを参照する場合、BP+1000されたものとして扱ってもよい。」
   * (REZ-1-058/066) — while its controller's effects read a hand card's BP (the revealed card of a
   * 「公開したカードが…」 / 「公開したカードのBP以下」 clause), the value read is raised by `amount`.
   *
   * The printed 「してもよい」 is not asked as a question: every use of the bonus in the pool widens a
   * condition its controller is trying to satisfy (a `minBP` threshold, or an upper bound on the cards
   * an effect may choose), so reading it as always-on is the advantageous half the option offers — the
   * same convention `countsAsMultiple` follows. Installed on a field card (with its own state tags as
   * the ability condition) or granted to the player for the turn.
   */
  | { type: 'handBpReferenceBonus'; amount: number }
  /**
   * 「自分の効果で自分の場外にあるイベントカードの枚数を参照する場合、その枚数は1枚多くあるものとして
   * 扱う。〈巴 マミ〉のこの効果は重複しない。」 (MMM-2-007) — the printed +1 to *this player's own*
   * references to their sideline's event-card count (both the `sidelineCount` gate and the `sideline`
   * tier source). The named card's copies do not stack: the read counts the bonus once per distinct
   * card identity, however many copies sit on the field.
   */
  | { type: 'sidelineEventCountBonus'; amount: number }
  /**
   * 「自分の〈フルル〉は場外でイベントカードとしても扱う。」 (TOA-P-001) — the named card counts as an
   * event card while it sits in its owner's 場外, for every read that compares a sideline card's kind
   * (counts, gates, filters and watchers alike). Read through `sidelineAsEventTreated`, which requires
   * the card to actually be in the sideline, so no other zone's reads change.
   */
  | { type: 'sidelineAsEvent'; name: string }
  /**
   * 「自分の黄の〔〈戦慄のタツマキ〉と〈地獄のフブキ〉〕の効果に記載されている「イベントカード」を
   * 「イベントカードかキャラカード」に代えてもよい。」 (OPM-P-001) — a text rewrite of the named cards'
   * effects: while a carrier stands on their controller's field, an event-card filter *made by* a named
   * (and colour-matching) card also admits character cards. The rewrite is permissive — the printed
   * 「代えてもよい」 lets the player choose, and the widened reading is the one every use offers.
   */
  | { type: 'eventCardAlsoCharacter'; names: string[]; color?: Color }
  /**
   * 「自分の効果で自分の手札から公開しているこのカードは元々のBPが4000のキャラカードとしても扱う。」
   * (REZ-1-065) — while this card is the card another effect revealed, it counts as a character card
   * with printed BP `bp` for every revealed-card read (`revealedHas` kind/BP, `revealedBpCeiling`).
   *
   * Read straight off the case's own definition (the card is in hand or already back in the deck), with
   * no board source — the print carries no state tags.
   */
  | { type: 'revealedAsCharacter'; bp?: number }
  /**
   * Cannot be played onto the front line (the placement refusal 登場できず).
   *
   * The *movement* refusal is a separate modifier (`cannotMoveToFront`): the standalone print
   * 「フロントLに登場できない」 (KJN-1-011) closes placement only, and reading this modifier at the
   * move routes wrongly locked that card's own [起動メイン] (Q2111).
   */
  | { type: 'cannotEnterFront'; except?: 'ownEffects' | 'selfEffect' }
  /**
   * 「フロントLに移動できない」 — the movement half of the combined spelling
   * (「フロントLに登場できず、フロントLに移動できない」 / 「フロントLに〔登場・移動〕できない」).
   *
   * `except` carries the reminder spelling's carve-out: 「自分の効果以外で…移動できない」 leaves the
   * controller's own effects free (`'ownEffects'`), 「このカードの[起動メイン]以外で…」 leaves this
   * card's own effect alone (`'selfEffect'`). The movement phase's move action is never carved out.
   */
  | { type: 'cannotMoveToFront'; except?: 'ownEffects' | 'selfEffect' }
  /** This character also produces energy while it sits on the front line. */
  | { type: 'generatesFromFront' }
  | { type: 'apCostDelta'; amount: number }
  /**
   * 「このカードを手札からレイドする際に、消費APを-Nする」 (BLC-4-050/HIQ-1-106/MCR-2-036/TKG-1-089/
   * WBK-1-024) — the discount scoped to the *raid* route: an ordinary play pays the printed price.
   * Read only where the raid's own use price is computed (`getApCost`'s `viaRaid`), the AP-side sibling
   * of `raidEnergyCostDelta`.
   */
  | { type: 'apCostDeltaOnRaid'; amount: number }
  /**
   * 「山札にあるこのカードは消費APを1として扱ってもよい。」 (SYN-1-016) — a deck-scope *replacement* of the
   * card's AP price, the AP sibling of `energyCostSet`. Read by `getApCost` through `handStaticsOf` (which
   * already covers a card in no field slot — hand or deck); the printed 「してもよい」 is the permission and
   * reads as always-on, the same way the requirement-side spelling does. Later reductions still apply to
   * the overridden price, exactly like `requiredEnergyOf` orders its own override.
   */
  | { type: 'apCostSet'; amount: number }
  | { type: 'energyCostDelta'; color: Color; amount: number; scope?: 'hand' | 'sideline' | 'handOrSideline' }
  /**
   * 「自分の場外にあるイベントカード2枚につき、全ての場所でこのカードの必要エナジーを[青×1]減らす。」 —
   * a reduction that scales with a board count *per printed unit*: the count is read where the cost is
   * asked (the same `TierCount` reader every 「N枚につき」 bonus uses), divided by `per` and floored, and
   * the reduction is `amount` per whole unit. A fixed %-style `energyCostDelta` cannot carry it, and
   * folding the count away would apply the reduction at a size the board may not have reached.
   *
   * `scope` is the printed zone qualifier — where the card must sit for the reduction to exist:
   * 「手札にある」 (`'hand'`), 「場以外の全ての場所で」 (`'notField'`), 「場と場外以外の全ての場所で」
   * (`'notFieldNotSideline'`) or the unqualified 「全ての場所で」 (`'allPlaces'`). Read by
   * `requiredEnergyOf` (the play-cost side) and `effectiveRequiredEnergy` (the count/filter side, where
   * 「手札から登場させる効果」 references the reduced number per Q481); every spelling but `'allPlaces'`
   * excludes the field by its own words, and `'allPlaces'` is the one the field-side read admits.
   */
  | { type: 'energyCostDeltaPer'; color: Color; amount: number; count: TierCount; per: number; scope?: 'hand' | 'notField' | 'notFieldNotSideline' | 'allPlaces' }
  /**
   * 「このカードが、［特徴：陸］にレイドする際、必要エナジーを[緑×2]減らす。」 / 「自分の手札から
   * ［特徴：マーレの戦士］がレイドする際、そのカードの必要エナジーを[緑×1]減らす。」 — a reduction that
   * applies only to a **RAID**, optionally narrowed to the base it raids onto.
   *
   * Separate from `energyCostDelta`: that one discounts any use of the card, while the printed
   * 「レイドする際」 pays nothing on a plain play. `baseFilter` names the printed base subject
   * (「［特徴：陸］に」); absent means any base. Read by `requiredEnergyOf` where the raid's own price is
   * asked, which is the only route that hands the base over.
   */
  | {
      type: 'raidEnergyCostDelta'; color: Color; amount: number; baseFilter?: CardFilter; count?: TierCount; per?: number;
      /**
       * 「…レイドする際、自分のリムーブエリアにカードが3枚以上ある場合、必要エナジーを[紫×2]減らす。」
       * — a printed condition on the *card's own raid*, evaluated where the requirement is asked. The
       * reduction exists only while the condition holds, which is what 「…ある場合」 says.
       */
      condition?: Condition;
      /**
       * 「このキャラに〈アルミン・アルレルト（超大型巨人）〉がレイドする際、そのカードの必要エナジーを
       * [赤×2]減らす。」 (AOT-2-068) — the *base-side* reading: the source sits on the field and names the
       * raider, so the modifier is read from the base being raided onto (`raidBaseId`) rather than from
       * the raider's own hand statics. `raiderFilter` is the named raider; a branch with no filter is
       * never emitted (the print always names someone).
       */
      asBase?: boolean; raiderFilter?: CardFilter;
    }
  /**
   * 「自分が「BPの範囲に指定がある効果」で…キャラを選ぶ際、指定できるBPの範囲+1000。」 — the controller's
   * own effects that select by a BP bound accept a wider range.
   *
   * Read where a selection's candidates are built (`eligibleFor`), not by `matchesFilter` generally: the
   * print says 「選ぶ際」, so counting conditions (「BP4000以上のキャラが2枚以上ある場合」) are not widened.
   * The bonus expands the printed range at *both* ends — the printed example only shows a ceiling
   * (「BP2000以下を…BP3000以下」), and a floor-only bound widens by the same +N so the wording's "the
   * range gains N" holds on both sides. `colorTrigger` is the printed narrowing
   * 「自分が赤の[カラートリガー]でキャラを選ぶ際」 — only a colour trigger's own resolution of that
   * colour is covered.
   */
  | { type: 'selectBpRangeBonus'; amount: number; colorTrigger?: Color }
  /**
   * 「自分が緑の[カラートリガー]を発動する場合、代わりに「…」をしてもよい」 — a replacement offered
   * where the player resolves a colour trigger of `color`. Read from the player's *field* (unlike the
   * granted-on-player statics), because the source is a card and its own conditions gate the offer.
   */
  | { type: 'colorTriggerReplacement'; color: Color; effects: CardEffect[] }
  /**
   * 「山札にあるこのカードは必要エナジーを[C×N]として扱ってもよい」 — an absolute replacement of the
   * printed requirement while the card is *not* on the field.
   *
   * It is a *set*, not a delta: the printed line names the whole requirement, and applying it as a
   * reduction would leave the original symbols in place.
   */
  | { type: 'energyCostSet'; energy: Energy }
  /**
   * 「場にあるこのカードは必要エナジーを[黄×3]としても扱う」 — the same whole-signature replacement
   * while the card *is on the field*.
   *
   * Read wherever a card's requirement is measured — a selection's `maxEnergy`, a count's energy
   * bounds, a colour test — so the card counts as the printed replacement for other cards' effects.
   * `energyCostSet` above is the hand/deck-scope sibling and is read where a card's *play cost* is
   * paid; this one never touches the play cost, because a card on the field is already paid for.
   */
  | { type: 'energyCostSetOnField'; energy: Energy }
  /**
   * 「…場合、自分の場とレイド元のこのカードの必要エナジーを[赤×N]減らす。」 (MGS-1-078〜082) — the
   * self-reduction that applies only in the two positions the print names: a slot of the controller's own
   * field, or the レイド元 stack beneath one. Read by `effectiveRequiredEnergy` (the count/filter side) with
   * that position gate; the play cost from hand is untouched — `requiredEnergyOf` does not read this type,
   * and the printed 「場とレイド元の」 is exactly what excludes the hand.
   */
  | { type: 'energyCostDeltaOnField'; color: Color; amount: number }
  /**
   * 「自分の場の他のキャラ全ての必要エナジーを2増やす。」 (BLC-4-012) — a *colourless* raise broadcast
   * over the controller's field characters other than the source. Kept apart from `globalEnergyCostDelta`
   * (every zone the controller owns) and `energyCostDeltaOnField` (self-scoped) because the print names
   * precisely the other field cards. The amount lands on the `'any'` share of the requirement, so counts
   * read it while per-colour payment is untouched (see `Energy`).
   */
  | { type: 'energyCostDeltaForOthers'; amount: number }
  /**
   * 「自分の山札にある紫のカードの必要エナジーを1減らす。」 (MMM-2-017) — the deck-scoped, colourless
   * reduction: read while the card sits in its owner's *deck* (the zone the print names), applied as the
   * `'any'` share so counts read it while per-colour payment is untouched (see `Energy`).
   */
  | { type: 'deckEnergyCostDelta'; filter: CardFilter; amount: number }
  /**
   * 「このカードは全ての場所で必要エナジーを[青×5]としても扱う。」 — the whole-signature replacement
   * with **no** location qualifier: in hand, on the field, in the discard pile and the removal area
   * alike, the printed symbols are read as the replacement.
   *
   * The union of `energyCostSet` (the play-cost side, read in `requiredEnergyOf`) and
   * `energyCostSetOnField` (the count/filter side, read in `effectiveRequiredEnergy`): both readers
   * honour it, which is what 「全ての場所」 prints.
   */
  | { type: 'energyCostSetAll'; energy: Energy }
  /**
   * 「自分の効果で場外に置くこのカードの必要エナジーは[青×3]としても扱う。」 (KMR-2-026) — the
   * *sideline* scope of the same replacement family: while the card sits in its owner's 場外, every
   * requirement read other cards make (counts, filters, energy-variety checks) sees the replacement.
   * Neither the play cost nor an on-field read is touched — the print names the discard pile alone.
   * Read by `effectiveRequiredEnergy` and `sidelineEnergyVariety` through `ownStaticsOf`.
   */
  | { type: 'energyCostSetInSideline'; energy: Energy }
  /**
   * 「自分の効果で自分の手札から公開しているこのカードは必要エナジーを[紫×3]としても扱う。」
   * (DST-1-040) — while the card is being referenced as a revealed hand card, its requirement total may
   * equally be read as this alternate signature (Q723: 「3と4の望む方で扱うことができます」). The card
   * stays in hand — nothing on the board changes — so the reading is scoped to the reveal record the
   * referencing sentence reads (the `revealedHas` comparisons), not to `effectiveRequiredEnergy`.
   */
  | { type: 'requiredEnergyAlternateWhileRevealed'; energy: Energy }
  /**
   * 「このキャラは、相手の効果で選ばれない。」 — the opponent's effects cannot bind this card.
   *
   * `source` narrows *which* of the opponent's effects the protection covers, and it is never
   * broader than printed: 「相手のキャラの効果で選ばれない」 must not stop an event card, and
   * 「相手のトリガーの効果で選ばれない」 must not stop a character ability. An absent `source` is the
   * plain 「相手の効果で選ばれない」, which covers every route.
   */
  | { type: 'cannotBeChosenBy'; source?: 'characterEffect' | 'eventEffect' | 'trigger' | 'any';
      /**
       * 「自分と相手のキャラの効果で…選ばれない」 (ARK-1-023) — the refusal covers the controller's own
       * effects as well. Absent is the plain 「相手の効果で」, which only the other side's effects meet.
       */
      both?: true;
      /**
       * 「特徴に「X」を持たない…キャラの効果で」 (ARK-1-023) — only effects whose *source card* is a
       * character lacking the trait are refused. Read against the resolving cause, which must exist.
       */
      sourceNotTrait?: string;
      /**
       * 「レイド状態でない相手のキャラの効果で選ばれない。」 (YYH-1-008) — only effects whose *source
       * character* is **not** in raid state are refused (a stacked cause's effect still chooses this
       * card). Read against the resolving cause's field slot, which must exist.
       */
      sourceNotRaid?: true }
  /**
   * 「相手はキャラの効果でこのキャラを選ぶ際に、元々のBPが4000のキャラの効果でのみ選ぶことができる。」
   * — the opponent may select this card only through effects whose *source card* matches this filter.
   *
   * The third selection restriction beside `cannotBeChosenBy` (which names the route): the route is
   * ordinary, but the cause's own card is narrowed. Read where a choice's candidates are offered, against
   * the resolving effect's source — the printed value is 「元々のBP」, a definition fact, so an effect
   * whose source has since left the field still answers correctly.
   */
  | { type: 'selectableOnlyBy'; source: CardFilter }
  /**
   * 「自分の場のキャラが「以下から1つ選ぶ」効果を発動する際、アクティブのこのキャラをレストにし、
   * このキャラの下に置かれた裏向きのカードを1枚場外に置いてもよい。そうした場合、その効果は
   * 「以下から2つ選ぶ」に代わる。」 (YYH-1-050) — a standing offer read where a single-pick chooser of
   * the controller's own field character opens: the holder (active, with a face-down card beneath) may
   * pay that printed price to raise the chooser's count. Carries the raised `count`.
   */
  | { type: 'paidChooseUpgrade'; count: number }
  /**
   * 「[狙い撃ち]で指定されない。」 — a declared attack may not name this card as its target.
   *
   * Separate from `cannotBeChosenBy`: a snipe is not an effect choosing a card, so the 「選ばれない」
   * routes say nothing about it, and the two are printed side by side (「相手の効果で選ばれず、
   * [狙い撃ち]で指定されない。」) exactly because they are different permissions.
   */
  /**
   * `[狙い撃ち]` protection, in the two printed directions.
   *
   * Without `maxBP` it is the passive 「このキャラは[狙い撃ち]で指定されない」 — the carrying card can
   * never be designated. With `maxBP` it is the *active* 「**このキャラは**BP2500以上のキャラを[狙い撃ち]で
   * 指定できない」: the carrying card is the sniper, and the threshold refuses only the targets at or
   * above that BP (it can still snipe smaller characters, and can still attack normally).
   */
  | { type: 'cannotBeSniped'; maxBP?: number }
  /** 「相手はこのキャラのアタックを可能ならブロックしなければならない。」 */
  /**
   * 「相手はこのキャラのアタックを可能ならブロックしなければならない」 — with `maxBP` the printed
   * qualifier 「可能ならBPN以下ので」: the obligation (and the refusal of a larger blocker) only holds
   * while a legal blocker within that ceiling exists.
   */
  | { type: 'mustBeBlocked'; maxBP?: number;
      /**
       * 「このキャラよりもBPが大きいキャラでブロックしなければならない」 (KJN-1-001) — the obligation's
       * *floor* is this card's own current BP: a blocker at or below it does not satisfy the demand, and
       * while one above it exists the smaller blocker cannot be chosen.
       */
      overSelf?: boolean;
      /**
       * 「1回目のアタックを可能ならブロックしなければならない」 (KJN-1-016) — the obligation covers only
       * this turn's first attack, read from the turn log where the demand is checked.
       */
      firstAttack?: boolean }
  /**
   * 「このキャラは、相手の〈X〉のアタックを可能ならブロックしなければならない。」 (CGD-1-069) — the
   * *blocker-side* demand naming its attacker, the static sibling of the `mustBlockAttacker` field
   * record KGR-1-069 writes: while this card can legally block an attack by a character whose effective
   * names include one of `names`, it must be the blocker. Read where the block step picks the
   * designated blocker, from the defender's own side. Without `names` it is the unnamed spelling
   * 「このキャラは、相手のアタックを…」 (JJK-1-084): the obligation covers any opponent attack.
   */
  | { type: 'mustBlockAttacker'; names?: string[] }
  /**
   * 「自分のフロントLに〈クイン〉がある場合、相手の場のキャラは可能ならアタックしなければならない。」
   * — the opponent's characters are *obliged* to attack: the attack phase cannot be closed while one
   * of their characters could still attack. Read where the phase's end is asked (the only site that
   * can tell "has not attacked yet" from "may not attack"), the mirror of `mustBeBlocked`.
   *
   * `self` is the printed-on-this-card spelling 「このキャラは可能ならアタックしなければならない。」:
   * the obligation lands on the card's *own* controller and on *this* character, not on the opponent
   * the bare form obliges. Both directions are read at the same phase-close site.
   */
  | { type: 'mustAttack'; self?: boolean }
  | { type: 'cannotAttack' }
  /** A restriction on this card as a RAID base, regardless of the route placing the raider. */
  | { type: 'cannotBeRaided' }
  | { type: 'overflowToSideline' }
  | { type: 'optionalLeaveToRemoval' }
  /**
   * 「自分はこのターン中、「〈X〉以外のキャラでアタックできない。」を得る。」 (AOT-2-034) — the
   * *player-scope* restriction: this turn only characters counting as one of `names` may attack. Read
   * where an attack is declared, from the attacker's controller's player statics; a card-scope
   * `cannotAttack` cannot express it (it would need one modifier per character, and none for the ones
   * that enter later).
   */
  | { type: 'attackOnlyNames'; names: string[] }
  | { type: 'cannotBlock' }
  /**
   * 「このキャラは移動できない。」 — neither the movement phase nor an effect may change its line.
   * 「このキャラは相手の効果で…移動せず…」 (YYH-1-027) rides `source: 'opponent'`: only an *opponent's*
   * effect may not change the line; the movement phase and the controller's own effects still may.
   * Read through `moveOpponentOnly` beside the source-less `move`, the way `activate`/`activateOwnOnly`
   * are split.
   */
  | { type: 'cannotMove'; source?: 'opponent' }
  /**
   * 「移動フェイズで移動できない。」 — only the movement phase is refused; an effect may still change the
   * card's line. Narrower than `cannotMove` on purpose: the print names the phase, and reading it as the
   * unbounded refusal would also block the effect moves the printed line allows.
   */
  | { type: 'cannotMovePhase' }
  /**
   * 「「このキャラはアタックできない。」と「…ブロックできない。」と「…アタックもブロックもできない。」を
   * 得ない。」 — a refusal to *receive* those abilities from any grant: modifiers another card's
   * `grantStatic` / group broadcast would install on this card are dropped while the refusal holds. Its
   * own printed abilities are untouched, and so is a *cost* of the same shape (the print names grants).
   */
  | { type: 'refuseGrantedAbilities'; abilities?: ('cannotAttack' | 'cannotBlock')[] }
  /** 「このカードはエナジーLに登場できない。」 — the energy line refuses this card. */
  | { type: 'cannotEnterEnergy' }
  /**
   * 「このキャラは退場しない。」 — it never reaches 場外 from a battle or an effect.
   *
   * `source` narrows the routes the refusal covers — 「相手のキャラの効果やイベントカードの効果で退場
   * しない。」 names two of the three. Absent means every route, which is what the bare spelling prints.
   * Only 退場 is covered: 手札に戻る and リムーブエリア are different destinations, and the wording that
   * refuses *those* is 「場を離れない」 (`doesNotLeaveField`).
   */
  // `battle` prevents this battle defeat before any destination replacement (Q1474), without
  // refusing effect-driven retirement while that battle is open.
  | { type: 'doesNotRetire'; source?: 'characterEffect' | 'eventEffect' | 'trigger' | 'battle' }
  /**
   * 「このキャラは相手の効果で場を離れない。」 — no effect of the *opponent* may take it off the field.
   *
   * Narrower than `doesNotRetire` on two axes: it covers every destination (手札 / 場外 / リムーブエリア /
   * 山札), not only 場外, and it refuses only the opponent's effects — the controller's own effects, a
   * battle loss and the rules (BP 0, line capacity) still move it. `source` narrows the route the way
   * `cannotBeChosenBy` does; absent means every route.
   */
  | { type: 'doesNotLeaveField'; source?: 'characterEffect' | 'eventEffect' | 'trigger';
      /**
       * 「このキャラは**バトルの敗北**とカードの効果で場を離れず」 (KMR-1-052) — the battle-defeat route,
       * which no effect route names: the loss is the rules' own comparison, so it rides as its own flag
       * and the battle path asks for it separately.
       */
      battle?: boolean;
      anyOwner?: boolean }
  /**
   * 「このキャラは相手の効果でレストにならず、手札に戻らない。」 — the opponent's effects cannot rest
   * this card.
   *
   * A refusal at the *operation* site, like `doesNotLeaveField`: only the opponent's effects are
   * covered (the printed subject is 「相手の効果で」), the movement phase and the rules still rest the
   * card if they say so, and the refusal covers the `rest` operation itself rather than any one route.
   */
  | { type: 'doesNotRest';
      /**
       * 「相手の場のキャラを1枚まで選び、…自身のカードの効果でレストにできない。」 (ARK-1-079) — the
       * refusal is scoped to the *owner's own* card effects (the plain spelling covers the opponent's,
       * read cross-side, the same axis `doesNotReturn.both` splits).
       */
      own?: true;
      /**
       * 「自分と相手のキャラの効果で…レストにならず」 (ARK-1-023) — the same both-players spelling
       * `doesNotReturn.both` records.
       */
      both?: true;
      /**
       * 「特徴に「X」を持たない…キャラの効果で」 (ARK-1-023) — only effects whose *source card* is a
       * character lacking the trait are refused. Read against the resolving cause, which must exist.
       */
      sourceNotTrait?: string }
  /**
   * 「このキャラは[自分と]相手の効果で手札に戻らない。」 — an effect cannot send it back to a hand.
   *
   * Narrower than `doesNotLeaveField` on the destination axis (only 手札, so 場外 / リムーブエリア /
   * 山札 destinations still work) and wider on the owner axis when the print says 「自分と相手の」 —
   * that spelling refuses the controller's own effects too, which is what `both` records.
   */
  // `rules` is the unqualified 「手札に戻らず」 spelling (Q1720); owner-qualified effect refusals
  // do not cover the rules' battle replacement (Q1469).
  | { type: 'doesNotReturn'; both?: boolean; rules?: true }
  /**
   * 「このキャラが場を離れる場合、代わりにこのカードを手札に戻す。」 — a *redirect* rather than a refusal:
   * whenever the card would leave the field for any destination (場外 / リムーブエリア / 山札, the battle
   * loss and the rules included), it reaches its owner's hand instead. A leave that already goes to the
   * hand is left alone — the redirect would say the same thing.
   */
  | { type: 'leaveToHand';
      /**
       * 「…手札に戻す効果以外の**相手の効果で**場を離れる場合、代わりに手札に戻す。」 (REZ-1-074) — the
       * printed cause narrows the redirect to the opponent's effects; the rules and battle losses keep
       * their own destinations. Absent is the unqualified 「場を離れる場合」, every route.
       */
      cause?: 'opponentEffect' }
  /**
   * 「このキャラが自分の場から手札に戻る場合、代わりにこのキャラとこのキャラのレイド元のカードを手札に
   * 戻す。」 — the return's *scope* widens: the card reaches the hand as it would anyway, and the stack
   * beneath it comes along instead of going to 場外. Only the hand destination is touched; a retirement
   * or a removal of the same card keeps its printed behaviour.
   */
  | { type: 'returnBaseToHand' }
  /**
   * 「このキャラが退場する場合、代わりにリムーブエリアに置かれる。」 — a *redirect* sibling of
   * `leaveToHand`: a leave bound for 場外 (a battle loss, a rule, an opponent's effect) reaches the
   * removal area instead. The two other leaf destinations are left alone — the wording speaks about
   * 退場 (the discard destination) and says nothing about a return to hand or an existing removal.
   */
  | {
      type: 'retireToRemoval';
      /**
       * 「BPが0以下になることによってこのキャラが退場する場合、代わりにリムーブエリアに置かれる。」 —
       * the printed *route* narrows the redirect to the BP-zero rule, while the bare spelling covers every
       * 場外 destination. Read where a leave passes.
       */
      source?: 'bpZero';
    }
  /**
   * 「手札から使用すること以外でこのカードが場外に置かれる場合、代わりにこのカードをリムーブエリアに
   * 置く。」 — a redirect of every *discard-pile* placement except the card's own use: the printed
   * exemption is 「手札から使用すること」, so the play's own destination is left alone while a discard,
   * a mill or any other effect that would file the card into 場外 sends it to the removal area instead.
   */
  | { type: 'sidelineToRemoval' }
  /**
   * 「このターン中、相手の[ブロック時]と[インパクト無効]は発動しない。」 — a silence the controller
   * imposes on the other side: triggers of the named events do not fire, and the named keywords do not
   * apply, while the modifier holds. Installed on the *player* (it names whose opponent is silenced),
   * and read from there at the trigger batch and at the keyword's own application.
   */
  | { type: 'forbidTriggers'; events?: AbilityEvent[]; keywords?: 'impactNegate'[] }
  /**
   * 「このキャラとバトルをしたキャラはこのバトル中、[インパクト無効]を失う。」 (BCV-1-004) — the
   * carrier strips the named keywords from whichever card it fights, for the battle it is in. Read at
   * the battle's keyword sites with the *other* participant as the carrier's counterpart.
   */
  | { type: 'battleOpponentLosesKeywords'; keywords: 'impactNegate'[] }
  /**
   * 「自分の[ドロートリガー]か[アクティブ]を発動する場合、代わりに[ゲット]にしてもよい。」 (EVA-1-018)
   * — a permission on the *controller's* life triggers, read where a trigger of one of the named kinds
   * is resolved with `substitute: 'get'`.
   */
  | { type: 'triggerToGetSubstitute' }
  /**
   * 「自分と相手の場のキャラ全ては、効果で退場しない。」 (MSS-1-056) — a player-scope grant for the turn:
   * every effect-driven retirement fails, for both players' characters. Read at the retirement site from
   * whichever player carries the active grant; battle losses and BP-zero rules are not 「効果で」 and are
   * unaffected.
   */
  | { type: 'allCharsNoRetireByEffect' }
  /**
   * 「自分の手札の上限は15枚になる。」 — replaces the rulebook's limit (8) for this card's controller.
   * Read where the end-of-attack-phase overflow is checked; the limit is a property of the player, not
   * of any one card, so the reader scans the controller's field like every other player-scope static.
   */
  | { type: 'handLimit'; count: number }
  /**
   * 「最初のアタックをブロックできない」 — while this turn's first attack is the one being blocked, the
   * card cannot take the block. Read where a block is chosen; once any attack has happened the refusal
   * lapses (the print names only the turn's *first* attack).
   */
  | { type: 'cannotBlockFirstAttack' }
  /**
   * 「自分はAPを支払わずにエクストラドローしてもよい。」 — the player's once-per-turn extra draw costs no
   * AP while this static applies.
   *
   * A permission on the player rather than on the draw: the extra draw is a rule action, so nothing but a
   * static can change what it costs.
   */
  | { type: 'freeExtraDraw' }
  /**
   * 「このキャラはこのキャラのレイド元のカードが持つ[登場時][アタック時]を全て得る。」 (SMD-1-071) — the
   * character gains the *printed* abilities of the card beneath it, for the events the print lists.
   *
   * Read where abilities are collected: the `onPlay` half joins the card's own 登場時 when it raids onto
   * the base (`raid()`), the `onAttack` half joins `collectTriggered`'s printed list. The base is read
   * from the stack, so nothing needs to be copied at compile time.
   */
  | { type: 'copyRaidBaseAbilities'; events: ('onPlay' | 'onAttack')[] }
  /**
   * 「相手は次の相手のターンの移動フェイズでエナジーLのキャラをフロントLに移動できず、フロントLのキャラを
   * エナジーLへ移動できる。」 (SMD-1-080) — the movement phase's directions are swapped for the player
   * carrying this: energy-line characters stay put, and front-line characters step back for free.
   *
   * Player-scope (installed on the opponent via `grantStatic target: 'opponentPlayer'`) because it governs
   * the player's movement phase as a whole, not any one card.
   */
  | { type: 'moveDirectionSwap' }
  /**
   * 「このカードの[ゲット]を発動する場合、代わりに[ドロートリガー]か[アクティブ]にしてもよい。」
   * (SMD-1-060) — the card's own permission, read where its life trigger is resolved and offered as the
   * `substitute` answer on `Action.resolveTrigger`.
   */
  | { type: 'getTriggerSubstitute' }
  /** 「このキャラはエナジーLからアタックできる。」 */
  | { type: 'canAttackFromEnergy' }
  /**
   * 「自分の場の〈X〉は「…」を得る。」 — a *group* grant the source broadcasts to its own side's field.
   *
   * A broadcast rather than an install on each target, because the grant is continuous: a matching card
   * that enters later is covered, and the abilities disappear with the source. `nonStacking` is the
   * printed 「〈X〉のこの効果は重複しない。」 — two copies of the source apply it once.
   */
  | { type: 'grantToField'; filter: CardFilter; statics: StaticAbility[]; nonStacking?: boolean;
      /**
       * 「自分の場の赤の「〈A〉と〈B〉と〈C〉」全ては、「[アタック時]…」を得る。」 — the broadcast may carry
       * whole *triggered* abilities as well as statics. Read exactly like `statics` (same filter, same
       * continuous lifetime); the two lists are separate because a triggered ability needs the event it
       * listens for, which no `StaticAbility` carries.
       */
      triggers?: TriggeredAbility[] }
  /**
   * 「自分の手札にある…の必要エナジーを[緑×1]減らす」 — a card on the field discounting the cards in its
   * owner's hand.
   *
   * A hand card has no slot, so `grantToField` cannot reach it: the discount is read by `handStaticsOf`
   * while that card is still in hand, from the *broadcaster's* statics. `filter` names which hand cards
   * the reduction applies to, and `modifiers` are the cost modifiers they receive.
   */
  | { type: 'grantToHand'; filter: CardFilter; modifiers: StaticModifier[] }
  /**
   * 「自分の全ての場所にある全ての〈X〉の必要エナジーを[緑×1]減らす。」 — a discount the source
   * broadcasts to *every* card its controller owns, in whichever zone the card happens to be (field,
   * hand, deck, discard pile).
   *
   * Wider than `grantToHand`, which reaches the hand alone: the printed 「全ての場所」 is what makes a
   * card discounted on release as well as in hand, and the two must not be collapsed into one channel.
   * `filter` names the subject the print gives; read wherever a requirement is measured
   * (`requiredEnergyOf` / `effectiveRequiredEnergy`).
   */
  | { type: 'globalEnergyCostDelta'; filter: CardFilter; color: Color; amount: number }
  /**
   * 「相手は…選ぶ際に、追加でAPをN支払わないと選べない。」 — a tax on choosing this card.
   *
   * The cost is paid by whoever *chooses*, not by this card's controller, so it is read where a
   * selection is bound rather than as a modifier on the chooser. It is a *cost*, not a refusal: the card
   * is still choosable, and a chooser that cannot pay simply cannot take it.
   */
  | {
      type: 'selectionTax'; amount: number; kind: 'ap' | 'hand' | 'rest';
      /** The routes the tax names (「キャラの効果やイベントカードの効果で…選ぶ際に」); absent means every route. */
      sources?: ('characterEffect' | 'eventEffect' | 'trigger')[];
      /**
       * 「…このキャラを選ぶ際**と[狙い撃ち]でこのキャラを指定する際**に、追加で…」 (KGD-1-020) — the tax
       * also covers being designated by a [狙い撃ち] attack, which is a *command* rather than an effect
       * selection; the designation path reads this flag and charges the same payment.
       */
      snipe?: boolean;
      /**
       * 「自身のフロントLのアクティブのBP3000以上のキャラを1枚レストにしなければ選べない。」
       * (WBK-1-061) — with `kind: 'rest'` the payment is resting the chooser's *own* characters, and this
       * filter names which of them may pay (`zone` = the line, `active`, `minBP`). Absent means any
       * active character of theirs.
       */
      restFilter?: CardFilter;
    }
  /**
   * 「このキャラとのバトルで敗北した相手のキャラは、退場する代わりに〈行き先〉に移動する/置かれる」.
   *
   * Replaces the battle's *loser* destination, so it is read where the battle is decided rather than
   * as a modifier on either participant: the card it applies to is the one that lost, not the one
   * that printed the line.
   */
  /**
   * 「BPN以下のキャラとのバトルで敗北したこのキャラは、退場する代わりにエナジーLに移動する。」 (KMR-2-009) —
   * the loser-side spelling: the modifier sits on the card that loses, and `opponentMaxBP` narrows the
   * battle by the BP of the card it fought. Read where the losing defender is sent away.
   */
  | { type: 'selfBattleLoserTo'; destination: 'energy' | 'removal' | 'hand' | 'deckBottom'; opponentMaxBP?: number }
  | { type: 'battleLoserTo'; destination: 'energy' | 'removal' | 'hand' | 'deckBottom' | 'stay' }
  /**
   * 「このキャラとのバトルで敗北した相手のキャラは、退場しない。」 (DST-1-070) — `'stay'`: the loser keeps
   * its slot instead of moving anywhere. A destination like the others (the sentence is the same one with
   * the move spelled out as 「退場しない」 rather than as a replacement place).
   */

  /** 「自分のフロントLに置けるカードの枚数がN枚減る」 — the line holds `amount` fewer cards. */
  | { type: 'lineCapacity'; line: Line; amount: number }
  /**
   * 「〈マキマ〉以外の自分の紫のキャラカードは全ての場所でイベントカードとしても扱う。」
   * (CSM-1-022 / CSM-1-024 / CSM-1-037) — cards matching `filter` also count as *event cards* while used.
   *
   * Read where a use is counted: a use of a matching card bumps the per-turn event-use counter the
   * 「イベントカードを使用している／使用した枚数」 family reads. The static sits on a field card and
   * reaches the controller's uses (a broadcast, like `lineCapacity`), not the card's own kind.
   */
  | { type: 'countsAsEventAsWell'; filter: CardFilter }
  /**
   * 「このキャラの下に裏向きのカードがある場合、このキャラはアクティブにならない」 — the ready step and
   * every effect that would activate it leave it rested while the condition holds.
   */
  | { type: 'cannotActivate' }
  /**
   * 「このターン中、そのキャラは[起動メイン]を発動する際、[APを1支払う]を行わずに発動できる。」
   * (TKG-1-018) — the card's *activation-cost* AP payments are waived for as long as the grant lives.
   *
   * Read at the `payAp` step whose `asCost` flag says the payment is the ability's own cost tag; an
   * effect-driven 「APを支払ってもよい」 inside some ability's body is not a cost and still pays. Unlike
   * `PlayerState.nextActivationApFree` (SYN-P-003's 「次に発動する…」) this is a continuous static: it
   * waives every matching activation while it lasts, and consumes nothing.
   */
  | { type: 'activationApFree' }
  /**
   * 「このキャラの[起動メイン]の[APを1支払う]は[手札を1枚場外に置く]に代えてもよい。」 (TKG-1-026) —
   * the card's *activation-cost* AP payments may instead be paid with one hand card to 場外. Offered as
   * a declinable question at the marked `payAp` step (the same `asCost` site `activationApFree` waives),
   * only while the hand really holds a card; declining pays AP as printed.
   */
  | { type: 'activationCostSubstitute' }
  /**
   * 「自分が必要エナジーを満たしているキャラカードの[ゲット]を発動する場合、代わりにそのカードを自分の場に
   * レストで登場させてもよい。」 (EVA-1-008) — the mirrored twin of `getTriggerSubstitute`: this field card
   * grants the resolving player the permission to read a character life card's [ゲット] as a rested
   * deployment (`substitute: 'deployRested'`). Read where the life trigger is answered; the printed
   * per-turn limit rides as the static's own `oncePerTurn`.
   */
  | { type: 'getTriggerDeploySubstitute' }
  /**
   * 「そのキャラはスタートフェイズとエンドフェイズにアクティブにならない」 — only the two *ready steps*
   * (the start phase's and the attack phase's close) leave the card rested, while an effect of either
   * player may still activate it.
   *
   * Narrower than `cannotActivate` on purpose: the print names the phases, so reading it as the
   * all-routes refusal would refuse activations the printed line allows.
   */
  | { type: 'cannotReadyStep' }
  /**
   * 「エンドフェイズにこのキャラをアクティブにしなくてもよい。」 — the *permission* mirror of
   * `cannotReadyStep`: the end phase's ready step leaves this card to its controller, who answers whether
   * it stands up. Only the end phase asks (the print names that phase); the start of turn still readies
   * it like any other card.
   */
  | { type: 'maySkipReadyStep' }
  /**
   * 「自分が一度に2ダメージ以上受ける場合、代わりに1ダメージにしてもよい。」 — the controller may take a
   * smaller burst instead of a printed one. `min` is the size the offer answers (「2ダメージ以上」) and
   * `to` the amount that replaces it.
   *
   * The decision is the *damaged* player's, and the printed 「[ターン1]」 budget is a per-turn mark on the
   * card this modifier sits on, so it can protect once a turn and no more.
   */
  | { type: 'damageSubstitute'; min: number; to: number }
  /**
   * 「このキャラが与えたダメージによるトリガーチェックでは、相手は[アクティブ]を発動できない。」 — when
   * the damage *this card* dealt turns up life cards, their owner may not activate the [アクティブ]
   * trigger among them.
   *
   * Read at the trigger batch, from the card the damage came from — the pending records that origin,
   * because nothing on the board remembers which character dealt the damage by the time the batch is
   * answered.
   */
  | {
      type: 'forbidActiveTrigger';
      /**
       * Which trigger kinds the gate silences. Absent means `['active']` — the spelling the two existing
       * carriers print (「相手は[アクティブ]を発動できない。」), so their IR is unchanged. BCV-1-046 prints
       * the ドロートリガー sibling (「相手は[ドロートリガー]を発動できない。」), which rides here rather
       * than as a second modifier type: one gate, one read path.
       *
       * The type name is the historical spelling of the [アクティブ] print; the merge round may want to
       * rename it now that it covers more than アクティブ.
       */
      triggers?: ('active' | 'draw' | 'special')[];
    }
  /**
   * 「相手がこのキャラを[スペシャルトリガー]で退場させる場合、代わりに相手はその[スペシャルトリガー]
   * を持つカードを手札に加える。」 — the special trigger aimed at this card is answered differently: the
   * card survives, and the life card carrying the trigger joins the *resolving player's* hand.
   *
   * Read where a special trigger would send its target to 場外 — the one site that can tell this route
   * from every other retirement, because a trigger resolution is not an "effect that retires".
   */
  | { type: 'specialTriggerRetireReplacement' }
  /**
   * 「自分の効果以外でアクティブにならない。」 — the card refuses the ready step and the *opponent's*
   * effects, while its controller's own effects may still activate it. `cannotActivate` refuses every
   * route, so the two are separate members rather than one flag with a scope.
   */
  | { type: 'cannotActivateExceptOwn' }
  /**
   * 「自分はこのターン中、自分の効果でライフエリアにあるカードを場外に置くことができない」 — a
   * player-scope restriction: it forbids the *controller's own effects* from sending a life card to the
   * discard pile, whichever card is resolving.
   */
  | { type: 'cannotSendLifeToSideline' }
  /**
   * 「自分は手札のカードを使用できない」 — the player may not play or raid cards from hand for the
   * stated period. Player-scope: it refuses the action wherever it originates, not one card's use.
   */
  | { type: 'cannotUseHandCards';
      /**
       * 「自分はこのターン中、手札からイベントカードを使用できない。」 — the printed subject narrows
       * which hand cards the refusal covers; absent means every hand card, which is what the bare
       * 「手札のカードを使用できない」 prints. Read with `matchesFilter` where a use is attempted.
       */
      filter?: CardFilter }
  /**
   * 「…が…退場する場合、代わりにこのキャラを退場させてもよい」 — this card offers itself as the
   * substitute for another character's retirement.
   *
   * The modifier sits on the *substitute*; `filter` narrows which retiring cards it covers and `cause`
   * which retirements (`'opponentEffect'` is 「相手の(キャラの)効果によって」). `'notBpZero'`
   * (「BPが0以下になること以外で」) is recorded for a future battle path: the effect-driven retirement
   * this is read at is never caused by a BP check.
   */
  /**
   * 「このキャラが場から手札に戻る場合、代わりに自分の手札を1枚場外に置いてもよい。」 — the *return*
   * sibling of `retireSubstitute`'s cost form: while the carrier sits on the field, an effect sending it
   * to hand may be bought off by moving `hand` cards from its controller's hand to the discard pile.
   *
   * A destination-scoped refusal of its own: `doesNotReturn` refuses the return outright, while this
   * one offers the owner a price, which is a different promise and must not be folded into it.
   */
  | { type: 'returnSubstitute'; hand: number; minHand?: number }
  /**
   * 「相手の効果で〔このキャラが場を離れるか、このキャラのBPがマイナスされる〕場合、代わりにこの
   * キャラをエナジーLに移動させてもよい。」 (KMY-P-002) — the *relocation* substitution: the carrier
   * survives an opponent's effect by moving to the energy line instead. One printed treatment with two
   * answered moments: the retirement offer (read beside `retireSubstitute`'s cost form) and a penalty
   * about to land on the carrier (read where a negative `bp` operation runs). Offered only while the
   * energy line has room, because the move is the whole point of the substitution.
   */
  | { type: 'energyMoveSubstitute' }
  | {
      type: 'retireSubstitute'; filter?: CardFilter; line?: Line; cause?: 'opponentEffect' | 'opponentTrigger' | 'notBpZero' | 'opponentEffectOrBattle' | 'opponentEventEffect' | 'anyEffect';
      /**
       * 「…このキャラが場を離れる場合、代わりに…」 — the print names **every** departure (場を離れる), not
       * only retirement. While true the offer covers every route that makes the carrier leave the field —
       * returned to hand, put on the deck top/bottom, placed in the life or removal area, battle defeat,
       * rule retirement — resolved at the single `leaveField` exit; paying the price cancels the departure.
       * The price rides this modifier's existing fields (`under` / `hand` / `life` / `base` / `substitute`).
       * Absent keeps the older retirement-only offer.
       */
      leave?: true;
      /**
       * 「…代わりに自分の手札を1枚場外に置いてもよい。」 — the *cost* form: the carrier itself offers to
       * survive by moving `hand` cards from its controller's hand to the discard pile. `minHand` is the
       * printed 「自分の手札がN枚以上あり」 gate when it differs from the cost.
       */
      hand?: number; minHand?: number;
      /**
       * 「このキャラが相手の効果で退場する場合、代わりに自分のフロントLの[特徴：寄生昆虫]を1枚退場
       * させてもよい。」 — the *other direction*: the modifier sits on the card that would retire, and
       * `substitute` names the cards that may die in its place. The mirror of `filter`, which names the
       * retiring card from a substitute's own static; `line` then bounds the *substitute's* slot rather
       * than the retiring card's.
       */
      substitute?: CardFilter;
      /**
       * 「…代わりにこのキャラの下の裏向きのカードを1枚場外に置いてもよい。」 — the *hidden-stack*
       * cost form: the carrier survives by sending this many face-down cards under it to 場外. The
       * third price beside `hand` (a hand discard) and `substitute` (another character's retirement).
       */
      under?: number;
      /**
       * 「このキャラの下の裏向きのカードが2枚以下で、このキャラが相手の効果で退場する場合、代わりに
       * 自分の山札の上から1枚を裏向きでこのキャラの下に置いてもよい。」 (MGS-1-099) — the *replenish*
       * price: the carrier survives by taking this many cards from the top of its owner's deck face-down
       * onto its own hidden stack. The fourth price beside `hand` (a hand discard), `substitute` (another
       * character's retirement) and `under` (spending the pile it already has). Offered only while the deck
       * really holds that many cards.
       */
      replenish?: number;
      /**
       * 「このキャラの下の裏向きのカードが2枚以下で、…」 — the printed *gate* on the replenish price: the
       * offer exists only while the carrier's hidden stack is at or below this size (the same face-down
       * count `Condition.underCount` reads).
       */
      underMax?: number;
      /**
       * 「自分の場の〈X〉以外のキャラが相手のキャラの効果で場を離れる場合、代わりに自分のライフエリア
       * にあるカードを1枚場外に置いてもよい。」 — the *life-area* price, and the one form read from
       * *another* card: the modifier sits on a protector that watches over its owner's field (its own
       * `filter` names which retiring cards it covers), while the price is paid from the life area.
       * `minLife` is the printed 「自分のライフがN以上」 gate when one is written.
       */
      life?: number; minLife?: number;
      /**
       * 「このキャラが退場する場合、代わりにレイド状態の上のこのカードを場外に置いてもよい。」
       * (EVA-1-041) — the *peel* price: the carrier sends the top card of its raid stack (itself) to 場外
       * and the base takes the slot over, which is the `topToSideline` operation. Offered only while the
       * carrier really is stacked; a carrier with no base has nothing to buy the slot's survival with.
       */
      top?: boolean;
      /**
       * 「…代わりにこのキャラのレイド元のカードを場外に置いてもよい。」 (ARK-1-059) — the *base*
       * price: the stack's first under-card leaves for 場外 while the top keeps the slot. Offered only
       * while the paying card really is stacked. Read from the paying card itself (the cost forms'
       * home) or, when the printed subject is 「このキャラか自分の…のキャラ」, from a protector whose
       * own static watches over the retiring card.
       */
      base?: true;
      /**
       * 「そうした場合、その〈X〉をレストにする。」 — instructions that run *only when the substitution was
       * taken*, on the card the substitution saved.
       *
       * The saved card is bound to the frame as `__saved` when the offer is accepted, and these steps run
       * after the substitute has retired. They cannot be plain steps on the card's ability: the substitution
       * happens inside another effect's resolution, where no step of this card is running.
       */
      follow?: CardEffect[];
      /**
       * 「…代わりにアクティブのこのキャラを退場させてもよい。」 (RNK-1-013) — the *state* the substitute
       * must be in. The offer is candidate-side, so this reads the carrier's own slot: a rested card has
       * no slot to give and the print says as much by naming アクティブ.
       */
      active?: boolean;
      /**
       * 「…代わりに「アクティブのこのキャラをレストにし、自分の手札を2枚場外に置く。」をしてもよい。」
       * (MSS-1-034) — a *quoted composite* price offered by a protector: the protected card survives by
       * being rested (it must be standing) and by moving `hand` cards from its controller's hand to 場外.
       * Read from the same field-wide scan `life` uses; the resting happens where the offer is accepted.
       */
      rest?: true;
      /**
       * 「…代わりにそのキャラとそのキャラのレイド元のカードをリムーブエリアに置いてもよい。」
       * (WBK-1-017) — the *destination* substitution offered by a protector: the protected card still
       * leaves the field, but to リムーブエリア, and the raid bases under it follow. Neither a price nor a
       * refusal — the card is not saved, it is diverted — so it is its own field on the field-wide scan.
       */
      toRemoval?: true;
    }
  /**
   * 「このキャラは自分と相手の効果でリムーブエリアに置くことができない。」 — the removal-area sibling of
   * `doesNotLeaveField`, and deliberately *not* folded into it: that one covers every destination and only
   * the opponent's effects, while this one covers only リムーブエリア and *both* players' effects (a printed
   * 「自分と相手の効果で」 names the controller's own effects too).
   */
  | { type: 'cannotBeRemovedByEffect' }
  /**
   * 「自分は自分のリムーブエリアの〈…〉を使用できる。」 — a permission that lets the player *use* cards
   * from リムーブエリア while it holds (usually gated on the source's own state tag).
   *
   * Read where the `play` action checks where the card came from: without it the hand is the only zone a
   * use may start from. The filter vocabulary is the one the permission phrases print (kind / colour /
   * trait / name / a union of them).
   */
  | { type: 'useFromRemoval'; filter: CardFilter }
  /**
   * 「自分の緑の[カラートリガー]の効果に記載されている「キャラカード」を「フィールドカード」に代えてもよい。」
   * — a standing offer to read the text of the controller's colour triggers differently, one colour at a
   * time.
   *
   * The rewrite is textual, exactly as printed: subjects that named the `from` kind name the `to` kind
   * instead for that resolution, which the engine offers as the trigger's own either/or reading.
   */
  | { type: 'colorTriggerSubstitute'; color: Color; from: 'character' | 'field' | 'event'; to: 'character' | 'field' | 'event' }
  | { type: 'loseEffects' }
  /**
   * 「自分の場の〈X〉全ては[自分のターン中]の効果を失う。」 (RNK-1-089) — the named cards' *self-turn-tagged*
   * effects stop applying while this player-scope modifier lasts.
   *
   * Read where `Condition.turnOf` with `who: 'self'` evaluates: the tag itself is switched off for a card
   * the `names` list covers, which is exactly what losing the tagged effects means. A narrowing of
   * `loseEffects`, which strips everything instead.
   */
  | { type: 'selfTurnEffectsLost'; names?: string[] }
  /**
   * 「相手の場のキャラ全ては、「[ステップ]、[狙い撃ち]、…」を全て失う。」 — the source strips the named
   * keywords from every character on the *other* side of the table.
   *
   * Read where a card's keywords are gathered: the reader scans the opposing field for this modifier and
   * removes what it names, so the strip covers printed and granted keywords alike, follows the board (a
   * card that enters later is covered) and lapses with the source. `line` narrows the printed subject when
   * the sentence names one; absent means the whole field, which is what 「相手の場のキャラ全て」 prints.
   */
  | { type: 'stripKeywords'; keywords: Keywords; line?: Line }
  /**
   * 「このキャラのアタックをブロックしたキャラの[ブロック時]は発動しない。」 — the attacker silences its
   * blocker's own `[ブロック時]` watchers. Read where the block's abilities are collected, from the
   * *attacker* (whose static it is) — the blocker is the battle's own record, not a selection.
   */
  | { type: 'forbidBlockerAbilities' }
  /**
   * 「このキャラとのバトルによって退場したキャラの[退場時]は発動しない。」 — a battle participant
   * silences the retiring other participant's own 退場時 watchers. Read where a battle's loser leaves the
   * field, from the opposing participant recorded on the open battle.
   */
  | { type: 'forbidBattleLoserAbilities' }
  /**
   * 「自分の場のカード名に「バサラ」を含むキャラの効果に記載されている「退場する代わりに、手札に戻る。」
   * は「退場する代わりに、相手の山札の下に置かれる。」に代わる。」 (MCR-2-075) — a *text* rewrite of the
   * controller's own named cards: while this static is on the field, the one-shot battle-loser
   * destination such an effect prints reads as the deck's bottom instead. `nameContains` carries the
   * printed fragment, checked against the effect's source card.
   */
  | { type: 'loserToDeckBottom'; nameContains: string }
export interface StaticAbility {
  /** Absent means "always on". */
  condition?: Condition;
  modifiers: StaticModifier[];
  /**
   * 「[ターン1]相手の効果でこのキャラが場を離れる場合、代わりに場を離れない。」 — the printed per-turn
   * limit on a *replacement* static. A continuous bonus has no per-turn meaning, so only the abilities a
   * replacement reads carry it; the use is spent at the moment the replacement actually answers, on the
   * *player's* stamp (`PlayerState.sharedLimitUsed`, keyed by functional id) — the limit is the printed
   * name's, so two copies of one card share the single use (Q1723).
   */
  oncePerTurn?: boolean;
}

/** Event-keyed triggered abilities that are not the printed life trigger. */
/**
 * 「このキャラが退場するか場から手札に戻った時」 — the card left the field *whichever* way it went.
 *
 * Distinct from `onRetire`, which is 場外 alone: a 退場 ability must keep answering only the discard
 * destination (「手札に戻る」 is printed as an alternative to it, never as a retirement), while this one
 * names both routes on purpose. Raised by `leaveField` for the sideline and hand destinations alike.
 */
export type AbilityEvent = 'onPlay' | 'onRaid' | 'onAttack' | 'onBlock' | 'onBlockWin' | 'onRetire' | 'onMainEnd' | 'onAttackPhaseEnd' | 'onDamage' | 'onOpponentAttack' | 'onUnblockedAttack' | 'onAttackEnd' | 'onBattleWinAttackEnd' | 'onBattleLossAttackEnd' | 'onBlockedBattleEnd' | 'onBattleWin' | 'onBattleLose' | 'onTurnStart' | 'onBlocked' | 'onRaided' | 'onRestedByEffect' | 'onMoved' | 'onDiscardedFromHand' | 'onMilled' | 'onLifeToSideline' | 'onRevealedFromDeck' | 'onRevealedFromHand' | 'onDeckToHand' | 'onReturnedToHand' | 'onLeftField' | 'onAbilityActivated' | 'onRemoved' | 'onChosenByEffect'
  /**
   * 「〜がアタックする際、…」(「際」) — the declaration moment: after the attacker is rested and the battle
   * exists, before the 狙い撃ち designation and before 「アタック時」 (`onAttack`). Raised for the attacking
   * player only; a [狙い撃ち] granted here is usable by *this* attack, which is the whole point.
   */
  | 'onAttackDeclare'
  /**
   * 「〜がアタックする際」 stayed distinct from `onAttack` on purpose: Q66 keeps 「アタック時」 after the
   * designation, and moving the 540 printed 「アタック(した)時」 clauses would change their moment.
   */
  /**
   * 「自分のエンドフェイズ開始時、…」 (AOT-2-066) — the end phase opening, raised where the phase opens
   * and ahead of the ready step. A distinct moment from `onMainEnd`, which fires before the attack phase.
   */
  | 'onEndPhaseStart'
  /** 「自分のメインフェイズ開始時、…」 (KMR-2-080) — the main phase opening of the controller's turn. */
  | 'onMainPhaseStart'
  /**
   * 「自分のアタックフェイズ開始時」 / 「相手のアタックフェイズ開始時」 — the attack phase opened. Raised
   * for the turn player first and then for the other one, exactly like `onAttackPhaseEnd`, so 「自分の」
   * and 「相手の」 listen to the same moment and are told apart by whose turn it is.
   */
  | 'onAttackPhaseStart'
  /**
   * 「このキャラのBPがプラスされた時」 — an effect *raised* this character's BP.
   *
   * Raised where a positive `bp` operation lands on a field card. Continuous statics are not events —
   * nothing "happens" when a modifier is recomputed — so only the effect route fires this, which is
   * what the printed moment names.
   */
  | 'onBpIncreased'
  /**
   * 「このキャラがBPをマイナスする効果を受けた時」 — an effect *lowered* this character's BP. The mirrored
   * sibling of `onBpIncreased`, raised at the same site for the other sign (only the effect route: a
   * continuous static is recomputed, never applied).
   */
  | 'onBpDecreased'
  /**
   * 「〈X〉以外の自分の場のキャラの下から裏向きのカードが1枚場外に置かれた時」 — a *face-down* card
   * beneath a character reached the discard pile. The event's subject is the *host* character (the card
   * the printed subject names), and the departed hidden card rides as `eventSubject` so 「そのカード」
   * can put it back under another host.
   */
  | 'onUnderToSideline'
  /**
   * 「このキャラの下の裏向きのカードを手札に加えた時」 (DST-1-074) — a *face-down* card beneath a
   * character reached its owner's hand. The subject is the *host* character (the printed subject), the
   * same shape `onUnderToSideline` uses; the taken hidden card rides as `eventSubject`.
   */
  | 'onUnderToHand'
  /**
   * 「レストのこのキャラがアクティブになった時」 — a rested card stood up, by the ready step or an
   * effect. The *transition* is the moment: a card that was already active is not 「レストの…がアクティ
   * ブになった」 when an instruction visits it.
   */
  | 'onActivated'
  /**
   * 「…が登場した時」 — a card reached the field, by a play, a RAID or an effect.
   *
   * The same moment the turn log records as `entered`, raised so a watcher can listen for it: the log
   * answers "did something enter this turn", while a trigger needs to run at the entry itself.
   */
  | 'entered'
  /**
   * 「自分のアタックフェイズ開始時」 — the attack phase opens, before any attack is declared.
   *
   * The opening sibling of `onAttackPhaseEnd`, raised where the phase changes and collected from the
   * player whose attack phase it is.
   */
  | 'onAttackPhaseStart'
  /**
   * 「自分のメインフェイズ中に、自分の効果でカードを引いた時」 — an effect made the player draw.
   *
   * Raised only on the *effect* route (the turn's own draw and the extra draw are not 「自分の効果で」);
   * the printed phase qualifier rides on the ability's own `turnEvent` condition, which the just-written
   * log entry satisfies.
   */
  | 'onDrew'
  /**
   * 「このカードが自分の効果で自分の場外から手札に加わった時」 (SLG-1-003 族) — a card reached its
   * owner's hand *from the discard pile*. The arriving card is the event's subject and now sits in the
   * hand, so the listener is the hand card itself (`TriggeredAbility.zone: 'hand'` with an
   * `eventCard: { self: true }` subject pin).
   *
   * Distinct from `onReturnedToHand`, which is the field→hand route: 場外 and 場 are different origins
   * and the prints tell them apart.
   */
  | 'onSidelineToHand';
export interface TriggeredAbility {
  /** The moved source was explicitly a face-down card, rather than a face-up RAID base. */
  underFaceDown?: true;
  /**
   * 「アタックして…バトルに勝利した時」 — the win belongs to the *attacker*. A defending card that wins the
   * comparison raises 「バトルに勝利した時」 (Q763/Q1084/Q1086) but not this spelling.
   */
  attackerOnly?: true;
  event: AbilityEvent;
  condition?: Condition;
  /**
   * The event's *card* must match this filter — 「自分の場のカード名に「ミハエル」を含むキャラが退場した時」.
   *
   * Distinct from `condition`, which is about the card the ability sits on: a watcher listens from one
   * card for an event about another, and the printed subject narrows which events count.
   */
  eventCard?: CardFilter;
  /**
   * The *effect that caused* the event must match this filter — 「自分の場の〈黎 星刻〉か〈神虎〉の効果で
   * 自分の手札を場外に置いた時」.
   *
   * A third card identity, distinct from both `eventCard` (the card the event is about) and the source:
   * the discard event's subject is the hand card that was sent to 場外, while this filter narrows the
   * ability's own cause — the resolving effect's source card. Absent means "any cause", which is what
   * the bare 「自分の効果で」 prints.
   */
  eventSource?: CardFilter;
  oncePerTurn?: boolean;
  /**
   * Which budget the per-turn counters share. Absent = this ability's own index.
   *
   * 「自分の場の[アタック時]を持つキャラがアタックした時**か**、自分の場の[ブロック時]を持つキャラが
   * ブロックした時、…」 prints one 「ターン1」 over *two* events; compiled as two abilities, they must
   * count against one budget or the sentence fires twice a turn.
   */
  limitKey?: string;
  /** Printed "N ターンに M 回" style limit; both bounds kept verbatim. */
  limitTurns?: number;
  limitCount?: number;
  nameLimit?: string;
  /**
   * 「〈X〉のこの効果は1ターンに1回のみ発動できる。」 — the *named-tail* limit, shared by every copy of
   * the printed card rather than counted per instance.
   *
   * Q770 contrasts the two spellings: a plain 「[ターン1]」 budget belongs to each copy (two copies each
   * fire once), while the tail naming 〈X〉 is answered by 「同じカードが複数枚ある場合、いずれか1枚のみ
   * 発動します」 (Q2308/Q1223/Q1749 …). Set together with `oncePerTurn`; the engine keys the budget by
   * functional identity on the player when this flag is present.
   */
  sharedLimit?: true;
  /**
   * Whose card the event is about.
   *
   * `'self'` (the default) is 「このキャラが…した時」: only the card that acted fires. `'anyOfMine'` is
   * 「自分の場のキャラが…した時」, where the ability sits on one card but listens for *any* of its
   * controller's characters — so it is collected even when the engine names a different card as the
   * event's subject. `'anyOfTheirs'` is 「相手のフロントLのキャラが退場した時」: a watcher on the
   * *opponent's* cards, collected from the controller's field when an event happens on the other side.
   */
  scope?: 'self' | 'anyOfMine' | 'anyOfTheirs';
  /**
   * 「手札にあるこのカードを…」 — the ability works while the card is *in hand* rather than on the field.
   *
   * Such an ability is collected from the hand (`collectTriggered`'s hand scan) and budgeted per printed
   * card on the player (`PlayerState.handTriggeredUsed`), because a hand card has no `FieldCard` slot.
   * The event is still raised by the field: 「[レイド]を持たない自分の〈ラピ〉のアタック終了時、…」.
   */
  zone?: 'hand';
  /**
   * 「このカードの必要エナジーを満たしている場合」 — a gate on the *hand card's own* requirement, which the
   * `Condition` vocabulary cannot express (`energySatisfied` lives in the engine core). Checked where the
   * hand scan collects the ability, the same place the requirement would be asked for a play.
   */
  handGate?: 'energySatisfied';
  effects: CardEffect[];
}

export interface ActivatedAbility {
  /** 「[レストにする]」 — activating requires the card to be active and rests it. */
  rest: boolean;
  oncePerTurn?: boolean;
  /**
   * 「〈X〉のこの効果は1ターンに1回のみ発動できる。」 — the named-tail limit is shared by every copy of
   * the printed card (Q770/Q2308): one budget per functional identity per turn, on the player. Set
   * together with `oncePerTurn`; a plain 「[ターン1]」 stays per instance.
   */
  sharedLimit?: true;
  condition?: Condition;
  effects: CardEffect[];
  /**
   * 「[リムーブエリアにある場合][起動メイン]…」 / 「このカードが自分の手札にあり、必要エナジーを満たす
   * 場合のみ発動できる。」 — the ability is activated while the card sits in リムーブエリア or in *hand*
   * rather than on the field. Absent (the norm) reads the card from its field slots; a card in a pile has no
   * `FieldCard`, so the per-turn budget lives on the player for the same reason the sideline-trigger channel
   * does. The hand spelling always carries its own 「必要エナジーを満たす」 gate, which rides on `handGate`.
   */
  zone?: 'removal' | 'hand';
  /**
   * 「必要エナジーを満たす場合のみ発動できる」 — a gate on the hand card's own requirement, checked where
   * the activation is claimed (the condition vocabulary cannot express it; `energySatisfied` lives in the
   * engine core). Read only for `zone: 'hand'`.
   */
  handGate?: 'energySatisfied';
}

export interface Keywords {
  step?: boolean;
  damage?: number;
  impact?: number;
  impactNegate?: boolean;
  doubleAttack?: boolean;
  doubleBlock?: boolean;
  snipe?: boolean;
}

export interface CardDefinition {
  id: string;
  /** Shared by alternate printings; NOT the translated name. */
  functionalId: string;
  /** Explicit printed construction exception; defaults to 4. Not a ban-list limit. */
  copyLimit?: number;
  work: string;
  name: string;
  implementation: 'core-v1' | 'unsupported';
  kind: 'character' | 'field' | 'event';
  apCost: number;
  requiredEnergy: Energy;
  generatedEnergy: Energy;
  bp?: number;
  traits?: string[];
  keywords?: Keywords;
  /**
   * 「【レイド】で囲まれた部分の効果は無効になります。」 (Q51) — printed keywords that sit inside the
   * card's ◆レイド fence (the band and the grey zone under it on the card face).
   *
   * They stay printed keywords — a raided card carries them exactly like `keywords` — but they are read
   * only while the card is stacked as a raid top card (`underneath.length > 0`). Which printed lines the
   * fence covers is a per-card layout fact read off the card image, so only adjudicated cards carry this
   * bucket (see `RAID_FENCED` in the compiler).
   */
  raidScopedKeywords?: Keywords;
  /** Basic RAID: match any listed original name or trait. No exceptional RAID conditions. */
  raid?: { names?: string[]; traits?: string[]; nameContains?: string[];
    /**
     * 「[レイド]カード名に「Ｗ」と「ジョーカー」を含むキャラ…」 (KMR-2-049/055) — one 「カード名に」 head
     * shared by several 「を含む」 tails: the base's name must contain *every* listed fragment. Distinct
     * from `nameContains` (a 「か」 union, satisfied by any one fragment): the shared-head 「と」 print
     * is a conjunction, and reading it as the union would admit bases the line excludes.
     */
    nameContainsAll?: string[];
    /**
     * 「[レイド]必要エナジーが4以下の紫のキャラ…」 — the base condition written as a filter over the base's
     * own definition (SMD-1-071). Read beside the name/trait lists: a base matching any printed part is
     * eligible.
     */
    filter?: CardFilter };
  /**
   * 「このカードは、レイド状態の〈X〉の一番上のカードをそのレイド元の下に裏向きで置き、そのレイド元に
   * レイドできる。」 — an *exceptional raid route* instead of the basic name/trait list: the base is the
   * card underneath a raid-state 〈X〉, and the 〈X〉 on top is peeled face down onto that base as this
   * card raids onto it.
   *
   * `notRaidedThisTurn` is the printed 「このターン中にレイドしていない」 qualifier on 〈X〉.
   */
  raidFromRaidTop?: { names?: string[]; nameContains?: string[]; notRaidedThisTurn?: boolean };
  /**
   * Printed restriction on *using* the card — 「このカードは〈条件〉の場合のみ使用できる」.
   *
   * This is a gate on the `play` action, not on any one ability: it is checked once, where the card
   * leaves the hand, against the state at that moment. Keeping it off `onPlay` matters because an
   * event's `onPlay` runs *after* the card is already paid for and in flight — a gate there would
   * spend the AP and then do nothing, and the client could not grey the card out.
   */
  playCondition?: Condition;
  /**
   * 「このキャラはレイド以外で登場できない」 — the card may only reach the field by RAID.
   *
   * A gate on the `play` action, like `playCondition`, because it decides whether the card can leave
   * the hand at all; a condition on an ability could not grey the card out in the client.
   */
  raidOnly?: boolean;
  /**
   * 「このカードは自分の効果かレイドでのみ登場できる。」 (AOT-2-067) — the ordinary `play` is refused; a
   * deploy by an effect or the RAID action still reaches the field. Checked at the same site as
   * `raidOnly`, since both decide whether the card may leave the hand by a plain use.
   */
  raidOrEffectOnly?: boolean;
  /**
   * 「手札にあるこのカードの必要エナジーは発生エナジーの色を無視して満たせる。」 — the card's requirement
   * may be paid with energy of any colour.
   *
   * A printed permission on the card itself, read where its use is priced (`energySatisfied`), and only
   * while the card is in hand — the print scopes it to 「手札にあるこのカードの」, and a card's printed
   * requirement only ever gates a use from hand.
   */
  ignoresEnergyColor?: true;
  /**
   * 「このキャラは、このターン中に自分の〈X〉が退場している場合のみレイドできる。」 — a gate on the
   * *raid* action, the sibling of `playCondition`. Checked once where the base is chosen and before
   * anything is paid; kept off the abilities for the same reason `playCondition` is.
   */
  raidCondition?: Condition;
  /**
   * 「（レイドしたキャラの[登場時]とこの効果は望む順で処理する）」 — the raid watcher's printed ordering
   * permission (TTG-1-004/034/045 et al.): the raider's [登場時] task joins the same queue as this
   * watcher's, so the controller picks the order (`resolveEffect`'s taskId). Without it the raider's
   * entry ran as an immediate frame and the choice never existed.
   */
  raidOrderChoice?: true;
  /**
   * 「このカードの[レイドトリガー]はレイドできる場合、発動しレイドしなければならない。」 (KMR-1-041)
   * — the printed RAID trigger is *obligatory*: while a legal base exists the life-trigger batch cannot
   * decline it, and the base must actually be chosen (the trigger cannot be activated bare). The gate
   * is read where the trigger is answered (`resolveTrigger`); with no eligible base the printed
   * 「レイドできる場合」 fails and the ordinary activate/decline choice stands.
   */
  raidTriggerForced?: boolean;
  /** 「〈X〉はNターンにM枚のみ使用できる」 — how often this card may be used per N turns. */
  useLimit?: { turns: number; count: number };
  /**
   * 「〈X〉を選んで使用する場合、このカードの消費APを-1する。」 — the card is used *with a named target*.
   *
   * The target is declared on the `play` action (`declare`), priced here (`apCostDelta` applies when the
   * declared card matches `filter`), and handed to the effect's linked selection — the first `select`
   * the compiler marked `declaredTarget` — which binds it instead of asking. `zone` is the linked
   * selection's own pool, captured at compile time so the declaration can be validated against the same
   * cards the effect could take.
   */
  useTarget?: { filter: CardFilter; zone: 'ownFront' | 'ownField'; apCostDelta: number };
  /**
   * 「このカードを使用する際に、自分の手札を望む枚数公開する。」 — the use begins by revealing any number
   * of hand cards. The reveal is part of the *play action* (`Action.play.revealHand`), so a cost
   * modifier gated on what was revealed (「…公開した［特徴：X］が合計N枚以上ある場合、消費APを-1する」)
   * can be priced before the AP is spent.
   */
  useReveal?: true;
  /**
   * 「このカードは全ての場所でイベントカードとしても扱う」 — the card counts as these kinds wherever a
   * rule asks about its kind.
   *
   * Kept beside `kind` (which stays the printed one, because it decides where the card can be played)
   * and read by the deck-construction rules, so an event that is also a character satisfies both
   * quotas instead of only its printed one.
   */
  alsoKinds?: ('character' | 'field' | 'event')[];
  onPlay?: CardEffect[];
  onRaid?: CardEffect[];
  /**
   * 「〈X〉のこの効果は1ターンに1回のみ発動できる。」 printed over the 【登場時】 block: the entry
   * effect is budgeted once per printed card per turn (Q2061/Q1107/Q2123 — the second copy played in
   * the same turn does not fire its 【登場時】 at all). The `onPlay` array has no per-ability slot to
   * carry the limit, so the flag rides on the definition; the engine checks and spends it where the
   * array starts (a plain `play`, a RAID, or a replay of the entry).
   */
  onPlaySharedLimit?: true;
  activeOnPlay?: boolean;
  activeEnergyBonus?: Energy;
  /**
   * 「[起動メイン]」 abilities, in printed order.
   *
   * A list rather than a single ability: 56 cards print two such blocks, and one is not a special case of
   * the other — each has its own cost, condition and per-turn budget, and the player picks which to
   * activate. The index is part of the command, so the engine never has to guess.
   */
  activated?: ActivatedAbility[];
  trigger?: Trigger;
  /**
   * 「このカードは自分の手札と山札でトリガーを持たないカードとして扱う」 (SHY-P-002) — the printed life
   * trigger is absent while the card sits in its owner's hand or deck (a filter asking 「[トリガー]を持つ」
   * there must not find it, and deck construction does not count it).
   */
  noTriggerInHandDeck?: boolean;
  /** Always-on modifiers evaluated at read time (Model B addition). */
  static?: StaticAbility[];
  /** Event-keyed triggered abilities other than the printed life trigger (Model B addition). */
  triggered?: TriggeredAbility[];
}

export interface CardInstance {
  id: CardId;
  definitionId: string;
  owner: PlayerId;
}

export interface FieldCard {
  cardId: CardId;
  /**
   * How this card reached the field, recorded at the moment it was placed.
   *
   * `by` separates a normal play (the `play` action, including RAID) from a placement an *effect*
   * made, which is what 「自分の効果で登場していた」 asks about; `from` is the zone it left. The turn
   * is kept because 「このターン中に…登場している」 re-reads the same fact later in the turn, long
   * after the placement itself.
   */
  entered?: { from: 'hand' | 'sideline' | 'deck' | 'life' | 'removal' | 'under'; by: 'play' | 'effect'; turn: number; raid?: boolean;
    /**
     * 「自分の〔キャラ・フィールド〕の効果で登場していた場合」 — the kind of card whose effect placed it,
     * recorded at the placement. Only effect placements write it (a played card has no cause), and the
     * kind — not the identity — is what the printed 〔A・B〕 label asks about.
     */
    causeKind?: 'character' | 'field' | 'event';
    /**
     * 「〈X〉の効果で登場していた」 (KMR-2-048/054/057) — the placing effect source's card *name*, the
     * identity where `causeKind` holds the kind. Recorded only by effect placements, the same rule.
     */
    causeName?: string;
    /** Controller of the effect that placed this instance; never inferred from its current owner. */
    causeOwner?: PlayerId };
  /** Underlying physical cards, not independent field characters. */
  underneath: CardId[];
  /** Face-down cards stacked under this character (このキャラの下の裏向きのカード). */
  faceDown?: CardId[];
  active: boolean;
  attacksThisTurn: number;
  blocksThisTurn: number;
  bpModifiers: { amount: number; expiresTurn: number; expiresBattle?: number }[];
  /**
   * 「このターン中、必要エナジーを2増やす。」 (BLC-4-011) — the per-card turn raise an effect writes
   * onto the chosen character. Read by `effectiveRequiredEnergy` as the colourless `'any'` share.
   */
  energyCostModifiers?: { amount: number; expiresTurn: number }[];
  /**
   * 「選んだ相手のキャラはこのターン中、選んだ〈X〉のアタックを可能ならブロックしなければならない。」
   * (KGR-1-069) — the demand sits on the *blocker* and names the attacking card by its effective names
   * (read off the selection binding at resolution, which is why this is a runtime record and not a
   * static). Read at the battle's block step: while one matches the attacker, this card must block.
   */
  mustBlockAttacker?: { names: string[]; expiresTurn: number }[];
  /**
   * 「このターン中、選んだキャラが〔退場するか、このキャラのアタックをブロックした時〕、このキャラは
   * このターン中、…を得る。」 (HTR-2-059) — watchers this card holds on a *bound* other card, keyed by
   * that card's identity. Retirement is checked where the card leaves for 場外; a block of this card's
   * attack where the blocker is declared (the attacker id distinguishes it from other block watchers).
   * Cleared with the turn like every other 「このターン中」 record.
   */
  boundWatches?: { id: CardId; kind: 'retire' | 'blockedAttack'; effects: CardEffect[]; attackerId?: CardId; expiresTurn: number }[];
  instanceId?: string;
  /**
   * Turn each 「[起動メイン]」 ability of this card was last activated, keyed by its index.
   *
   * Per ability rather than per card: a card printing two once-per-turn abilities may use *either* each
   * turn, which the card-wide single counter could not express.
   */
  abilityUsed?: Record<string, number>;
  energyModifiers?: { energy: Energy; expiresTurn: number }[];
  impactModifiers?: { value: number; additive: boolean; expiresTurn: number }[];
  /**
   * Temporary keyword grants (DAMAGE / IMPACT / …) that expire at end of turn.
   *
   * `relative` marks a grant written 「[ダメージ（+1）]」 / 「[インパクト（+1）]」, which *raises* the
   * keyword by that much instead of setting it. Without the flag a card that already has the keyword
   * silently ignores the grant (the merge takes a maximum), so the effect would be narrower than
   * printed on exactly the cards the grant is meant to help.
   */
  keywordModifiers?: { keywords: Keywords; expiresTurn: number; relative?: boolean }[];
  /**
   * 「このキャラはこのターン中、[狙い撃ち]を失う。」 (AOT-2-007) — temporary keyword *losses*, applied
   * where every keyword read lands (`getKeywords`), the negative sibling of `keywordModifiers`.
   */
  lostKeywords?: { keywords: Keywords; expiresTurn: number }[];
  evadeModifiers?: { maxBP: number; expiresTurn: number }[];
  retireAtMainEnd?: number;
  /**
   * 「エンドフェイズ開始時、そのキャラを退場させる。」 — the turn whose end phase retires the card when
   * it opens. Same shape as `retireAtMainEnd`, one step later.
   */
  retireAtEnd?: number;
  /** Turn until which the card's own abilities are stripped (元々の効果を失う). */
  effectsLostUntilTurn?: number;
  /**
   * 「[自分のターン中]の効果を失わせる」 (RNK-1-072/089) — the turn until which the card's *self-turn-tagged*
   * effects stop applying. A narrowing of `effectsLostUntilTurn`: only the abilities the printed
   * 「[自分のターン中]」 gates are switched off, read where that condition evaluates.
   */
  selfTurnEffectsLostUntilTurn?: number;
  /** Turn until which the card may not become active again (次の N 回アクティブにならない). */
  cannotActivateUntilTurn?: number;
  attackEndLapse?: ('cannotActivate' | 'effectsLost')[];
  /** Remaining "does not become active" charges from rest effects. */
  cannotActivateCharges?: number;
  /** Per-ability activation counters keyed by triggered-ability index. */
  triggeredUsed?: Record<string, number>;
  /**
   * Statics an effect installed on this instance (「このキャラは〈本文〉を得る」 / 「…を与える」).
   *
   * Kept on the field card rather than the definition because the grant is per-instance and expires;
   * `CardDefinition` is shared by every copy of the card, so writing there would grant it to all of
   * them forever. `expiresTurn` compares with `>=`, matching every other timed modifier.
   *
   * A 「…かぎり」 grant also records the card whose presence keeps it alive (`sourceId`, and the printed
   * line when one is named): the read side drops the grant once that card has left the field.
   */
  grantedStatics?: { abilities: StaticAbility[]; expiresTurn: number; expiresBattle?: number;
    endsWithAttackPhase?: true; sourceId?: CardId; sourceLine?: Line;
    grantedBy?: CardId;
    grantedByAll?: CardId[];
    /**
     * The *printed traits* of the card whose effect made the grant (KIN-1-051's 「［特徴：X］の効果で…
     * 与えられている場合」). Recorded as strings rather than as a `sourceId`: an id would tie the grant's
     * life to the source's presence (the `whileSource` rule reads it that way), and the printed gate
     * asks about the effect, not where its card went.
     */
    sourceTraits?: string[] }[];
  /** Triggered abilities an effect installed on this instance, under the same expiry rule. */
  grantedAbilities?: { ability: TriggeredAbility; expiresTurn: number; expiresBattle?: number }[];
  /**
   * 「…が持つ[起動メイン]を全て得る」 — activated abilities an effect copied onto this instance.
   *
   * They are *activated* like the card's own (`activate` reads them after the printed list), so they live
   * apart from `grantedAbilities`, which the trigger collection reads; each copy carries the expiry of the
   * printed 「このターン中」 and the card it was copied from.
   */
  grantedActivated?: { abilities: ActivatedAbility[]; expiresTurn: number; sourceId?: CardId }[];
  /**
   * 「レイド状態の上のカードを…に置く」 — which base each peeled top card uncovered, keyed by the *top's*
   * id (the binding the sentence named). The following 「そのキャラのレイド元のカードに…」 reads it, since
   * the base is not a selection and the top has already left the field.
   */
  peelBases?: Record<CardId, CardId>;
}

export interface EffectTask {
  id: string;
  player: PlayerId;
  sourceId: CardId;
  sourceInstance?: string;
  steps: CardEffect[];
  /** Printed timing used by optional-activation prompts; absent on older snapshots. */
  abilityEvent?: AbilityEvent;
  /**
   * The ability came from the source's *printed* triggered list (not a grant). A printed watcher queued
   * in the same frame as a 「元々の効果を失う」 step is re-checked at resolution (Q1807, KMR-2-049).
   */
  printedWatcher?: true;
  /**
   * Which route this effect came from, for 「〜の効果で選ばれない」.
   *
   * 「相手のキャラの効果で選ばれない」 and 「相手のトリガーの効果で選ばれない」 protect against
   * different things, so the protection has to be matched against the actual route rather than
   * collapsed into "an opponent's effect". Defaults from the source card's kind.
   */
  route?: 'characterEffect' | 'eventEffect' | 'trigger';
  /**
   * 「このキャラのレイド元のカード」 *as it stood when the source left the field* — the underneath
   * stack the retirement collected.
   *
   * A 「[退場時]」 ability resolves from 場外, and `leaveField` has already sent the base there with
   * it; the live `ownRaidUnder` read (`findField` on the source) therefore finds nothing. This
   * snapshot is what the printed wording means, and it is also the guard that the cards are really
   * the ones that left: the reader refuses ids that are not in the sideline.
   */
  raidBase?: CardId[];
  /**
   * The face-down stack the source had when it left the field, snapshotted for the same reason
   * `raidBase` is: a [退場時] ability resolves from 場外, and `leaveField` has already filed the stack
   * with the card, so a live slot read finds nothing. TRK-P-003's 「このキャラの下の裏向きカードの
   * 枚数分」 reads this snapshot when the slot is gone.
   */
  underIds?: CardId[];
  /**
   * The card the *event that raised this ability* was about, when that card is not the source.
   *
   * 「自分の効果で自分の手札を1枚場外に置いた時、…そのカードを裏向きでこのキャラの下に置いてもよい」
   * resolves on a field character but speaks about a card that is already in 場外, so the effect needs a
   * handle on it. Kept apart from `EffectFrame.eventCard`, which means the *イベントカード* being resolved
   * and is returned to the sideline when the effect ends.
   */
  eventSubject?: CardId;
  /**
   * The blocker of the battle this ability is answering (「このキャラをブロックしたキャラ」, KMR-2-083).
   *
   * Like `raidBase`, the fact is gone by the time the effect resolves: `endBattle` clears `s.battle`
   * before the queue it raised runs, so the open battle cannot answer afterwards. The raising site
   * snapshots the blocker here, and the `'blocker'` select zone reads it back.
   */
  battleBlocker?: CardId;
  /** Battle facts for conditions evaluated after the attack-close queue has cleared live state.battle. */
  battleSnapshot?: NonNullable<GameState['battle']>;
  /**
   * The target the card was *used with* (「〈X〉を選んで使用する場合」), recorded by `play` from the
   * action's declaration and read by the linked `declaredTarget` selection. Carried on the task so the
   * frame keeps it for the whole resolution, like `raidBase`.
   */
  declared?: { targetId?: CardId };
  /**
   * Selections to re-seed onto the frame when this task starts resolving.
   *
   * A delayed task (「次の相手のターン開始時、…」) speaks about a card the *creating* resolution selected,
   * and that frame is gone by the time the task runs; the parked copy carries the bindings so `select`-
   * reading steps and conditions still name the card. Absent for ordinary tasks, whose bindings are the
   * ones their own resolution makes.
   */
  bindings?: Record<string, CardId[]>;
  /**
   * Why the retirement this ability is answering happened (「このキャラがバトルによって退場した場合」).
   *
   * The cause is transient — it lives in the `leaveField` call, not on the board — so it rides on the
   * task itself: a guarded 「…場合、…」 inside the ability is compiled as an `if` step, which is
   * evaluated when the ability *resolves*, long after the removal. Conditions on the ability itself are
   * evaluated at collection time instead (see `leaveField`), and both read the same value.
   */
  retireReason?: string;
  /**
   * The card whose effect ordered the retirement, for the qualified spellings of `retireCause`
   * (「自分の効果によって」「自分の〈憎普天〉の効果で退場した」).
   *
   * Recorded beside `retireReason` for the same reason: the ordering frame is gone by the time the
   * ability resolves, and 場外 holds no trace of who ordered the removal.
   */
  retireCauseId?: CardId;
  /** Original line of a departed effect source, retained for sameLine/differentLine reads. */
  departedLine?: Line;
  /** The life card whose trigger this task resolves; raise its sideline arrival only after it finishes. */
  lifeArrival?: CardId;
  limitBudgetKeys?: string[];
}
/**
 * How play continues once a queued ability list is exhausted.
 *
 * `'attackDeclare'` is the 「際」 batch of the two-stage attack — `continueAttack` resumes after it, so the
 * designation window and `onAttack` run in the printed order.
 */
export type QueueResume = 'attackDeclare' | 'block' | 'compare' | 'mainEnd' | 'attackPhaseStart' | 'attackPhaseStartOpponent' | 'attackEnd' | 'attackEndOpponent' | 'unblockedDamage' | 'battleWin' | 'battleLose' | 'none';
export interface TriggerDecision { type: 'triggers'; player: PlayerId; cards: CardId[]; effects?: EffectTask[]; outsideBattle?: true;
  /** Activated effective GET, retained while its optional entry replacement and line are decided. */
  getResolution?: { cardId: CardId; effectiveTrigger: 'get'; phase: 'replacement' | 'line' | 'overflow'; sourceId?: CardId; entryLine?: Line };
  /** The card whose damage turned these life cards up, carried over from the `damage` pending. */
  sourceId?: CardId }
/** Ordered ability queue raised by an event; resolves before the interrupted play step continues. */
export interface QueueDecision { type: 'queue'; player: PlayerId; effects: EffectTask[]; resume: QueueResume; defenderId?: CardId; damageCount?: number; triggerResume?: TriggerDecision }
/** One optional hand card per printed group; choices precede every placement (Q819/Q820). */
export interface DeploymentBatch {
  phase: 'pick' | 'mode' | 'base' | 'line' | 'space' | 'place' | 'move' | 'moveSpace';
  index: number;
  pools: CardId[][];
  plans: { id: CardId; mode: 'deploy' | 'raid'; line?: Line; baseId?: CardId }[];
  entered: CardId[];
}

export type SelectionTaxDeferred =
  | { mode: 'answer'; pending: EffectDecision; choiceId: string; selected: CardId[]; stage: EffectFrame['stage'] }
  | { mode: 'declared'; bind: string; declared: CardId };

export interface EffectFrame extends EffectTask {
  deploymentBatch?: DeploymentBatch;
  /** Actual destination after this frame's actSource moved its field source; only return may use it. */
  sourceMovedTo?: 'sideline' | 'removal' | 'hand';
  /** Parked frame remains private and owns its held cards while a replacement answer is collected. */
  suspended?: EffectFrame;
  /**
   * 「…選ぶ際に、追加で自身の手札を1枚場外に置かないと選べない」 — the original answer parked while
   * the chooser picks which hand cards pay the tax. Restored once the hand frame resolves.
   */
  selectionTaxDeferred?: SelectionTaxDeferred;
  /** The current answer has already paid the hand half of its selection tax; `chargeSelectionTax` skips it. */
  selectionTaxPaid?: boolean;
  index: number;
  stage: 'revealHandSubset' | 'revealHandConfirm' | 'deploymentBatch' | 'recoverDiscarded' | 'triggerEntryChoice' | 'step' | 'take' | 'take2' | 'takeGroup' | 'takeMode' | 'takeReplace' | 'takeBase' | 'raidLine' | 'raidFullLine' | 'takeRaidLine' | 'takeRaidFullLine' | 'takeDeployLine' | 'takeDeployFullLine' | 'takeUseLine' | 'takeUseFullLine' | 'lookOptional' | 'actSourceOptional' | 'revealOptional' | 'revealHandPick' | 'bottom' | 'discard' | 'topBottom' | 'option' | 'chooseAllMode' | 'paidChooseUpgrade' | 'declare' | 'substitute' | 'substituteCost' | 'bpMinusSubstitute' | 'mill' | 'millCount' | 'drawCount' | 'moveFullLine' | 'deployLine' | 'deployFullLine' | 'place' | 'placeTopUnder' | 'placeTopRemoval' | 'placeTopSideline' | 'placeTopSidelineOpp' | 'placeHost' | 'deckChoice' | 'faceUpLife' | 'faceUpTake' | 'faceUpTopBottom' | 'apCostSubstitute' | 'grantPick' | 'takeTopSideline';
  held: CardId[];
  taken: number;
  /**
   * The next 「それぞれ」 group a looked-card pick has to ask about.
   *
   * The groups are asked one at a time over what the previous picks left, so the frame remembers how far
   * the list got; it is per-frame state, not part of the serialised effect.
   */
  takeGroupIndex?: number;
  /** The player accepted an optional look (「…見てもよい」); the re-entered step skips the question. */
  lookConfirmed?: boolean;
  /**
   * The *printed* card count the selection step just made was asking for (「N枚」 → N; 「N枚まで」 → N;
   * 「N枚以上」 → N), remembered for the 「そうした場合」 follow-up.
   *
   * Q561/Q562/Q574/Q575: when the instruction could not reach its printed count (fewer cards in the
   * pool), moving what there was still leaves 「条件は満たされていない」 — the follow-up does not resolve.
   * The `gained` reader consumes this record; instructions that are not selections keep the loose
   * "anything happened" reading.
   */
  selectPrinted?: number;
  /**
   * 「…を自分の場外に置いてもよい。」 (SMD-1-061) — the accepted answer to an optional `actSource`,
   * re-queued as a confirmed copy the same way `lookConfirmed` re-queues an optional look.
   */
  actConfirmed?: boolean;
  resume?: TriggerDecision;
  /**
   * Which departure destination the `substituteCost` offer above is buying the card out of
   * (「…退場する場合、代わりに」 vs 「…手札に戻る場合、代わりに」). One answer handler serves both.
   */
  substituteOp?: 'retire' | 'return';
  eventCard?: CardId;
  /** Cards bound by `select`, keyed by bind name. Cleared when the frame ends. */
  selections?: Record<string, CardId[]>;
  /** Effective names at selection time, retained when paying with or retiring the selected card. */
  selectionNames?: Record<string, string[]>;
  /**
   * 「相手は「手札に〈X〉がある。」か「…がない。」のどちらかを選ぶ。」 (FMA-1-096) — which claim the
   * opponent picked (`true` = "the hand has it"), read by `Condition.statementMatchesHand`.
   */
  statementChoice?: boolean;
  /** Number of cards actually taken by the last `lookReveal`, feeding `gained`. */
  gainedCount?: number;
  /**
   * 「レイド状態の上のカードを…に置く」 — which base each peeled top card uncovered, keyed by the *top's*
   * id (the binding the sentence named). The following 「そのキャラのレイド元のカードに…」 reads it.
   */
  peelBases?: Record<CardId, CardId>;
  /** The identities taken by the last `lookReveal`, so `gained` can ask *which* card arrived. */
  gainedIds?: CardId[];
  /** The identities the last `lookReveal` looked at, for 「公開したカードが〈X〉の場合」. */
  revealedIds?: CardId[];
  revealedFrom?: 'deck' | 'deckBottom' | 'under' | 'life' | 'hand';
  /** Hand cards this effect has made public (「この効果で手札を公開した」), counted where the reveal runs. */
  revealedHandCount?: number;
  /**
   * 「そうした場合、その〈X〉をレストにする。」 — the follow-up of the substitute offer currently open.
   *
   * Stashed while the substitution question is pending: the substitution happens inside *another* effect's
   * resolution, so no step of the printing card is running to carry it. The saved card is bound as
   * `__saved` when the offer is accepted, and the steps run after the substitute has retired.
   */
  substituteFollow?: CardEffect[];
  /**
   * 「[このカードを退場させる]このキャラの下の裏向きのカードを1枚まで手札に加える。」 (BLC-4-034) —
   * the hidden stack the source carried when its own retire step ran. The stack leaves for 場外 with the
   * card, so the sentence that follows reads its identity from here.
   */
  sourceStack?: CardId[];
  /**
   * 「この効果で〈X〉を登場させた場合、そのキャラを…」 — the cards *this effect* placed on the field, by
   * a deployment or an effect-driven raid. A frame fact like `gainedIds`: the placement is over by the
   * time the sentence that asks about it is read, and the board cannot tell this effect's arrivals from
   * any other. The identities let the gate ask *which* card arrived.
   */
  deployedIds?: CardId[];
  /** The identities the last `discard` sent away, for 「…を場外に置いた場合」. */
  discardedIds?: CardId[];
  discardPrinted?: number;
  acted?: true;
  /** Deck-origin cards actually sent to sideline by this frame, separate from later hand payments. */
  milledToSidelineIds?: CardId[];
  /** Count of the most recent `discard`, feeding `gained`. */
  discardedCount?: number;
  /**
   * 「手札に戻したキャラの[退場時]を発動し、…」 (MGS-1-046) — the stack each returned card carried when
   * the return sent it to the hand, keyed by the card. A replay of its abilities resolves while the card
   * is in the hand, where a live read of 「このキャラのレイド元」/the hidden stack finds nothing (Q1644).
   */
  returnedStacks?: Record<CardId, { underneath: CardId[]; faceDown: CardId[] }>;
  /**
   * The cards *this effect* sent to the bottom of their owner's deck.
   *
   * 「この効果で山札の下に置いたカードと同じ枚数のカードを引く」 counts a quantity no board slot
   * remembers: a card at the deck's bottom is indistinguishable from every other, so the identity of
   * "what this effect moved there" lives on the frame, like `restedIds`.
   */
  deckBottomIds?: CardId[];
  /** Number of results produced by the most recent resolving action, feeding `gained`. */
  didCount?: number;
  /**
   * 「この効果でカードを3枚以上アクティブにした場合」 — the cards *this effect* turned active.
   *
   * A frame fact like `restedIds`: once a card is active, the board cannot tell whether this effect or
   * the ready step stood it up, so the identity lives on the resolving frame.
   */
  activatedIds?: CardId[];
  /**
   * 「自分のAPカードを1枚アクティブにしてもよい。そうした場合、…」 (IMC-1-061) — the AP slots this
   * effect readied. AP slots have no card id for `activatedIds` to hold, so the 「そうした場合」 gate
   * reads their own count (Q509's AP-side record).
   */
  readiedAp?: number;
  clashSelf?: CardId[];
  clashOpponent?: CardId[];
  /**
   * 「この効果で表向きではないカードを引いた場合」 — how many cards this effect's draws took that were not
   * the face-up top.
   *
   * A frame fact like `discardedCount`: the drawn cards are in hand by the time the sentence is read,
   * and only the draw itself saw which of them were publicly face-up.
   */
  drewFaceDownCount?: number;
  /**
   * 「この効果で相手のキャラを退場させ、…場合、…」 — how many characters *this* effect sent to 場外,
   * split by whose they were.
   *
   * A frame fact like `discardedCount`: the retirement is over by the time the sentence that asks about
   * it is read, and the board cannot tell a card this effect retired from one the battle did. The two
   * sides are counted apart because the printed subject names one of them (「相手のキャラ」).
   */
  retiredOwn?: number;
  retiredOpponent?: number;
  /**
   * The identities behind `retiredOwn` / `retiredOpponent`, for the qualified spelling
   * 「この効果で必要エナジーが0のキャラを退場させた場合」. The count alone cannot answer which cards
   * they were, and the cards are already in 場外 and indistinguishable from anything else there.
   */
  retiredIdsOwn?: CardId[];
  /** The BP each card had when *this effect* retired it (`CardFilter.retiredBpCeiling`, Q414). */
  retiredBps?: number[];
  retiredIdsOpponent?: CardId[];
  restedIds?: CardId[];
  /**
   * The cards *this effect* moved between lines, for 「この効果で移動させたキャラを…選び」. The same
   * frame-scoped shape as `restedIds`: after the move the board cannot tell a card this effect moved
   * from one that was already there.
   */
  movedIds?: CardId[];
  /**
   * 「…が持つ[APを1支払う]を含む[起動メイン]を1つ得る」 (TKG-1-026) — the pending pick while the
   * participant answers which of the qualifying donated abilities is copied. The targets are recorded by
   * identity (`owner`/`cardId`), because the answer arrives on the next state and a `FieldCard` reference
   * would be stale by then.
   */
  grantPick?: { abilities: ActivatedAbility[]; targets: { owner: PlayerId; cardId: CardId }[]; duration: Duration; max: number; donorId?: CardId };
  /**
   * The cards *this effect* placed under a host from the owner's *hand* (「手札から置いた場合」). The
   * zone a `toUnder` picked its card from is gone once the card is under the host, so the frame keeps
   * the origin for the sentence that asks about it.
   */
  underFromHandIds?: CardId[];
  /**
   * The hosts those placements landed under, index-aligned with `underFromHandIds` — the
   * 「この効果でこのキャラの下に…置いた場合」 reading (MHA-P-003) asks whether one of them is the
   * effect's own source.
   */
  underFromHandHosts?: CardId[];
  /**
   * 「自分のライフエリアにあるカードを全て見てもよい。そうした場合、見たカードを望む順で自分のライフ
   * エリアに置く。」 — the face-up flag of each lifted life card, keyed by id.
   *
   * The life area's flags are positional (`PlayerState.lifeFaceUp`), and the lift empties the slots while
   * the ordering question is open; without this record a reordered life card would lose (or steal) the
   * face-up state of the slot it lands in.
   */
  heldLifeFaceUp?: Record<CardId, boolean>;
  removedIds?: CardId[];
  /**
   * The characters this effect's BP penalties brought to 0 or below, for 「この効果で相手のキャラのBPが
   * 0以下になった場合」 (EVA-1-042). The BP check retires them right away, so the frame is the only
   * place the fact survives.
   */
  bpZeroIds?: CardId[];
  /** Remaining queued abilities plus how to resume play when the queue empties. */
  queue?: { effects: EffectTask[]; resume: QueueResume; defenderId?: CardId; damageCount?: number };
  /**
   * Player burn accumulated by `playerDamage` steps, dealt at the frame's tail.
   *
   * It cannot resolve mid-loop the way `draw` does: the burst opens a `damage` pending, and the trigger
   * batch that follows may itself need a frame — which this very frame occupies. See `CardEffect`'s
   * `playerDamage` for why the deferral matches the print.
   */
  playerDamage?: number;
  /**
   * Values the resolving effect declared for itself (「この効果で指定した数」), readable by later filters
   * and conditions in the *same* effect and gone when it ends.
   */
  declared?: { energyCount?: number; targetId?: CardId; trait?: string; name?: string };
}
export interface EffectDecision {
  type: 'effect'; player: PlayerId; choiceId: string;
  kind: 'cards' | 'ap' | 'order' | 'topBottom' | 'option';
  prompt: string; min: number; max: number; options: string[];
  /**
   * 「異なるカード名の…をそれぞれ1枚ずつ」 — the chosen cards must all have different card names.
   *
   * A constraint on the *set*, not on the candidates: every looked card stays offerable, and picking two
   * of one name is what is refused. Filtering the option list instead would have to re-filter after each
   * pick, which the single-shot decision cannot express.
   */
  distinctNames?: boolean;
  /**
   * 「必要エナジーが同じカードを3枚場外に置く」 — the chosen set must share one required-energy
   * signature, and be the whole group or nothing.
   *
   * Like `distinctNames`, a constraint on the *set* rather than on the candidates: the player may pick
   * any hand cards, and an answer whose members disagree (or that is short of the printed count) is
   * refused where it arrives.
   */
  sameEnergy?: boolean;
  /**
   * 「必要エナジーが異なる…を望む枚数公開し手札に加える」 — every chosen card must have a *different*
   * printed required-energy total. The mirror of `sameEnergy`.
   */
  distinctEnergy?: boolean;
  /**
   * 「…をBPの合計が7500以下になるように望む枚数公開し手札に加える」 — the chosen set's *sum of printed BP*
   * may not exceed the printed ceiling. The select path's own `select.bpSumMax`/`bpSumMin` (TLR-1-030 /
   * DST-1-078) lands on the same pending field: field picks read current BP, off-field picks printed BP.
   *
   * A constraint on the set like `distinctEnergy`: every looked card is offerable on its own, and an
   * answer that overshoots the total is refused where it arrives.
   */
  bpSumMax?: number;
  /**
   * 「BPの合計が4000以上になるように…望む枚数レストにする」 (DST-1-078) — the floor sibling: a non-empty
   * pick must reach it; an empty pick is the printed decline and stays legal.
   */
  bpSumMin?: number;
  /**
   * 「必要エナジーの合計が4以上になるように望む枚数」 (MMM-2-012) — the sibling floor on the same
   * question: the answer's requirement totals must reach it (see `select.energySumMin`).
   */
  energySumMin?: number;
}

export interface PlayerState {
  deck: CardId[];
  hand: CardId[];
  /** Hidden slots in display order. Commands select zero-based slots, never hidden card IDs. */
  life: CardId[];
  front: FieldCard[];
  energy: FieldCard[];
  sideline: CardId[];
  removal: CardId[];
  ap: [ApState, ApState, ApState];
  turnsStarted: number;
  mulligan: 'pending' | 'keep' | 'redraw';
  /** Event cards the player has used this turn (their OWN turn only). */
  eventsUsedThisTurn?: number;
  /**
   * 「このターン中、自分はそのカードをリムーブエリアから使用できる。」 — the cards an effect this turn
   * put into リムーブエリア and stamped as usable from there (`removalUseAllowed` reads this beside the
   * permission statics). Turn-scoped by comparison like every other per-turn record: an entry from an
   * earlier turn is ignored rather than cleaned.
   */
  removalUseForTurn?: { turn: number; ids: CardId[] };
  /**
   * The hand cards revealed as part of the play now being executed (`Action.play.revealHand`), readable
   * by the cost's own condition while it is priced. Cleared once the use's AP has been settled — the
   * printed reveal lasts for the pricing, not the turn.
   */
  revealedHandAtUse?: CardId[];
  /**
   * 「〈X〉はNターンにM枚のみ使用できる」 — uses of one card this turn, keyed by functional id.
   *
   * Kept per player rather than on the definition because a card with a use limit is a *player*
   * restriction over the turn, and the definition is shared by every copy in both decks.
   */
  useCounts?: Record<string, number>;
  /**
   * 「〈X〉のこの効果でこのターン中に既に選んだキャラは選べない。」 — the cards one source card's effect
   * has already chosen this turn, keyed by that source's id.
   *
   * Per player and per turn, like `useCounts`: the reading is about the turn's own history, and the
   * record is dropped when the next turn starts (`beginTurn`).
   */
  chosenByEffectThisTurn?: Record<string, CardId[]>;
  chosenOptionsThisTurn?: Record<string, number[]>;
  /**
   * 「このターン中、次に手札から使用する〈对象〉の消費APを-Nする」 — discounts waiting to be spent.
   *
   * The wording names the *next* card used from hand, so the entries are consumed the moment a
   * matching card is played; an entry that outlives the turn lapses with `expiresTurn`.
   */
  nextUseAp?: { filter: CardFilter; amount: number; expiresTurn: number;
    /**
     * The source zones a use may start from to attend this entry: the printed qualifier「手札から」/
     * 「場外から」/「リムーブエリアから」. Hand alone when not spelled out; 「手札か場外から」 (YYH-1-090)
     * lists both, and whichever matching use comes first spends the entry.
     */
    zones?: ('hand' | 'sideline' | 'removal')[];
    /**
     * The printed required-energy totals this entry has already discounted (「各必要エナジーにつき1枚まで」).
     * Present only for the per-signature spelling, which is not spent by its first use.
     */
    usedSignatures?: number[] }[];
  /**
   * 「…は消費APが-1され、アクティブで場に登場する。」 (ARK-1-055) — the arrival rider waiting beside the
   * discount: the next matching use enters the field *active* regardless of the printed レスト arrival.
   * Same lifecycle as `nextUseAp` — read at the placement, spent by the same use.
   */
  nextUseActive?: { filter: CardFilter; expiresTurn: number; all?: boolean }[];
  /**
   * Waiting energy reductions («the `nextEnergyDiscount` step») still in force.
   *
   * `expiresTurn` is the turn the reduction lapses on; `enterFilter` (when the print names one) ends it
   * earlier, when a matching card *enters* the player's field — the 「次に〈X〉が登場するまで」 period.
   */
  nextEnergyDiscount?: { filter: CardFilter; color: Color; amount: number; expiresTurn: number; enterFilter?: CardFilter }[];
  /**
   * 「このターン中、次に手札から使用する〈对象〉の必要エナジーを[色×N]減らす」 — energy reductions
   * waiting to be spent, the sibling of `nextUseAp`. Same lifecycle: consumed by the first matching use,
   * lapsed by `expiresTurn`.
   */
  nextUseEnergy?: { filter: CardFilter; color: Color; amount: number; expiresTurn: number }[];
  /**
   * 「このターン中、次に手札からレイドする〈X〉の消費APを-1する」 — raid discounts waiting to be spent.
   *
   * Same lifecycle as `nextUseAp`, kept apart because the printed moment is レイド: only the raid action
   * consults and consumes these entries.
   */
  nextRaidAp?: { filter: CardFilter; amount: number; expiresTurn: number }[];
  /**
   * 「このターン中、次に自分が手札からレイドさせる〈X〉の必要エナジーを[色×N]減らす」 (YYH-P-002) —
   * energy reductions waiting for the next raid, the energy sibling of `nextRaidAp`.
   */
  nextRaidEnergy?: { filter: CardFilter; color: Color; amount: number; expiresTurn: number }[];
  /**
   * 「このターン中、次に発動する〈X〉の[起動メイン]は[APをN支払う]を失う」 (SYN-P-003) — activation
   * waivers waiting to be spent by the first matching activation's AP-cost step.
   */
  nextActivationApFree?: { filter: CardFilter; expiresTurn: number }[];
  /**
   * 「このターン中、自分が次に発動させる〈X〉の[起動メイン]は、自分の場のキャラを選ぶ代わりに相手の
   * フロントLのキャラを選んで発動させてもよい。」 (HTR-2-046) — waiting selection swaps, spent by the
   * first matching activation's own selection (the same one-shot lifecycle `nextActivationApFree` gives
   * the cost waiver beside it).
   */
  nextActivationSelectSwap?: { filter: CardFilter; from: ZoneId; zone: ZoneId; expiresTurn: number }[];
  /**
   * 「このターン中、次に…BPの範囲+1000」 — BP-bound widenings waiting to be spent by the next BP-bound
   * selection. Lapses with the turn like every other 「このターン中」 record.
   */
  pendingSelectBp?: { amount: number; expiresTurn: number; all?: boolean }[];
  /**
   * Statics an effect installed on the *player* — 「自分はこのターン中、…できない」.
   *
   * Kept beside the player rather than on a card because the restriction governs the player's effects
   * as a whole: it must hold wherever one of that player's effects would perform the forbidden move,
   * whichever card is resolving. Each grant carries its own expiry, like the card-scope ones.
   */
  grantedStatics?: { abilities: StaticAbility[]; expiresTurn: number; expiresBattle?: number; endsWithAttackPhase?: true;
    grantedBy?: CardId }[];
  /**
   * Triggered abilities an effect installed on the *player* — 「自分はこのターン中、「自分のキャラが
   * レイドした時、カードを1枚まで引く。」を得る」.
   *
   * The sibling of `grantedStatics`: the ability belongs to the player rather than to any one card, so it
   * must fire whichever card raised the event. Each grant carries its own expiry like every other grant.
   */
  grantedAbilities?: { abilities: TriggeredAbility[]; expiresTurn: number }[];
  /**
   * Turn each 「[場外にある場合]」 ability last fired, keyed by `${functionalId}:${index}`.
   *
   * Per *name* rather than per copy: the FAQ for the コアメダル cards says two copies in the discard pile
   * may not both fire in one turn, which rules out a per-instance counter. A card in 場外 has no
   * `FieldCard` to carry `triggeredUsed` either, so the counter lives on the player.
   */
  sidelineTriggeredUsed?: Record<string, number>;
  /**
   * Turn each *hidden-card* ability (「裏向きのこのカードが…下から場外に置かれた時、…」) last fired,
   * keyed by `${functionalId}:${index}`. A face-down card under a host has no `FieldCard` slot for the
   * usual per-ability counter — mirrors `sidelineTriggeredUsed` for the same reason.
   */
  underTriggeredUsed?: Record<string, number>;
  /**
   * Turn each hand-scoped ability (「手札にあるこのカードを…」) last fired, keyed by `${functionalId}:${index}`.
   *
   * A card in hand has no `FieldCard` for the usual per-ability counter — mirrors `sidelineTriggeredUsed`
   * for the hand channel, the same way that channel mirrors the field one.
   */
  handTriggeredUsed?: Record<string, number>;
  /**
   * Turn each 「このカードが山札から公開された時、…」 ability last fired, keyed by `${functionalId}:${index}`.
   *
   * The source of such an ability is *in the deck* when it fires — it has no `FieldCard` for the usual
   * per-ability counter, and the same-name limit the corpus prints means the counter belongs to the
   * printed card rather than to one copy. Mirrors `sidelineTriggeredUsed` for the deck-reveal channel.
   */
  revealTriggeredUsed?: Record<string, number>;
  /**
   * Turn each *named-tail* limit (「〈X〉のこの効果は1ターンに1回のみ発動できる。」) was spent, for the
   * budgets that are shared by name rather than counted per copy (Q770/Q2308).
   *
   * Keys: `t:${functionalId}:${index}` for a field triggered ability, `a:${functionalId}:${index}` for a
   * field activated one, `entry:${functionalId}` for a 【登場時】 block. Values are the turn number, the
   * same channel convention `handTriggeredUsed` uses.
   */
  sharedLimitUsed?: Record<string, number>;
  limitReserved?: Record<string, { turn: number; to: 'shared' | 'hand' | 'sideline' | 'under' | 'card'; ref?: string; ability?: string }>;
  deckTopFaceUp?: CardId;
  /**
   * 「自分の裏向きのライフを1枚表向きにする。」 — one flag per `life` slot, same length and order.
   *
   * A life card is placed face down and stays hidden until it is flipped; the flag is what a face-up
   * life card means, and it travels with its slot (a slot removed takes its flag along).
   */
  lifeFaceUp?: boolean[];
  /**
   * 「このターン中[、次に]自分の紫のカードの効果で「以下から1つ選ぶ」効果は「以下から全て選ぶ」に
   * 代えてもよい。」 — a standing offer on the player: the next (or every) single-pick chooser of a
   * purple source asks the printed mode question before it runs. `remaining` absent means the rest of
   * the turn; `1` is the 「次に」 spelling.
   */
  purpleChooseAll?: {
    untilTurn: number;
    remaining?: number;
    /**
     * 「その効果は「以下から2つ選ぶ」に代わる」 — the mode a *paid-for* swap installs: the next chooser
     * of the controller's own side takes two branches instead of one. Absent means the printed 「全て選ぶ」
     * offer, which is the shape every other card prints.
     */
    count?: number;
  };
  /**
   * 「このメインフェイズ終了時、…」 — instructions parked until the main phase of `turn` closes.
   *
   * Player-scoped rather than installed on the source card: the delayed instruction was created by an
   * effect that has already resolved, and it survives its source leaving the field. Entries for past
   * turns are dropped when the phase closes.
   */
  delayedMainEnd?: { turn: number; sourceId: CardId; steps: CardEffect[] }[];
  /**
   * 「次の相手のターン開始時、…」 — instructions parked on this player until the opponent's turn opens.
   *
   * `turn` is the number that turn will have when it begins; `bindings` are the selections the creating
   * resolution had made, re-seeded onto the delayed frame (`startEffect` copies them onto `selections`),
   * because 「選んだキャラ」 must still name the card after the original frame is gone.
   */
  delayedTurnStart?: { turn: number; sourceId: CardId; steps: CardEffect[]; bindings?: Record<string, CardId[]> }[];
  /**
   * 「このターンのアタックフェイズ開始時、…」 — instructions parked until this turn's attack phase opens.
   *
   * Player-scoped for the same reason as `delayedMainEnd`: the instruction was created by a resolution
   * that has already finished and it outlives its source (KGD-1-037 retires itself at the main phase's
   * end before the attack phase even starts). Entries are always stamped with the creating turn; the
   * phase consumes the current turn's entries once and `beginTurn` drops anything left over.
   */
  delayedAttackStart?: { turn: number; sourceId: CardId; steps: CardEffect[] }[];
  /** 「このターンのアタックフェイズ終了時、…」 — the close-of-phase mirror of `delayedAttackStart`. */
  delayedAttackEnd?: { turn: number; sourceId: CardId; steps: CardEffect[] }[];
}

export interface Battle {
  attacker: PlayerId;
  attackerId: CardId;
  defender: PlayerId;
  targetId?: CardId;
  /**
   * The card that took the block, recorded when the block is declared.
   *
   * `compareBattle` receives it as an argument, and nothing else on the battle names it — 「このキャラの
   * バトル中」 has to answer for the defender as well as the attacker.
   */
  blockerId?: CardId;
  /**
   * 「相手は選ばれたキャラ以外のキャラでこのアタックをブロックできない。」 (KGD-1-044) — the one card that
   * may block *this* attack. Written by the effect's own `blockOnly` operation while the battle is open
   * (the effect resolves during the attack), and read where a block declaration is validated; it dies
   * with the battle like the other attack-scoped records.
   */
  onlyBlockerId?: CardId;
  /**
   * A running number identifying *this* battle (「アタック終了時まで」).
   *
   * Modifiers scoped to the attack are granted while the battle is open and must stop applying the
   * moment it closes; the sequence number is what distinguishes "this battle" from a later one in the
   * same turn, which no turn counter can.
   */
  seq?: number;
  /**
   * 「このキャラがバトルに勝利したアタック終了時、…」 — the comparison's outcome, recorded when the
   * attacker wins so the attack-end raise can fire the win-narrowed watcher. Not readable after the
   * battle closes, which is why the moment has its own ability event (`onBattleWinAttackEnd`) rather
   * than an `onAttackEnd` condition.
   */
  won?: boolean;
  /**
   * 「バトルを行ったアタックの終了後のみ発動します」 (MGS-1-021 / Q1625) — whether a BP comparison
   * actually ran for this attack. `won` is only ever written on a win, so an unblocked attack that went
   * straight to damage and a comparison the attacker actually lost are indistinguishable by `won`
   * alone; the attack-end raise for the loss-narrowed watcher must read this flag beside it. Dies with
   * the battle like the other attack-scoped records.
   */
  compared?: true;
  /**
   * 「アタックしてブロックされなかった時」 (Q931) — a 狙い撃ち-declared attack never opens a block
   * window, so its unblocked moment is raised from the comparison resume rather than the decline
   * route; the flag keeps that raise to one per battle, because the queue jumps back into the same
   * resume after the watchers resolve. Dies with the battle like the other attack-scoped records.
   */
  unblockedRaised?: true;
  opponentAttackRaised?: true;
  /**
   * The attacker's 「アタックをブロックされた時」 batch of the block pair — raised once the blocker's
   * own 「ブロックした時」 batch has resolved (or immediately when that batch was empty). Only ever set
   * with a `blockerId` present (a 狙い撃ち attack never opens a block, so its comparison resume must not
   * raise the moment). Dies with the battle.
   */
  blockedRaised?: true;
  /**
   * 「[2回ブロック]」 — the blocker whose 「ブロックした時アクティブにする」 is still owed (Q428). The
   * standing-up runs once the block's own watcher batches (「ブロックした時」, then the attacker's
   * 「ブロックされた時」) have resolved: a 「次の1回アクティブにならない」 that lands with them absorbs
   * this very activation — the card stays rested and the charge is spent, instead of the charge waiting
   * for the next ready step. Dies with the battle.
   */
  doubleBlockReactivate?: CardId;
  /**
   * 「このバトルで敗北した相手のキャラは退場する代わりに、手札に戻る。」 (MCR-1-080 family, Q1464/Q1466/
   * Q1468) — the battle resolution's ① step runs *before* the winner's 「バトルに勝利した時」 ability (③),
   * so `compareBattle` pre-reads the replacement from the win tasks and sends the loser before raising
   * them. The queued copy of the step then no-ops on this flag; it dies with the battle.
   */
  loserSent?: true;
  /**
   * 「このキャラはこのアタックでダメージを与えず」 (SYN-P-002) — the attacker's own watcher waived the
   * unblocked damage; the battle still closes, but no damage decision opens.
   */
  noDamage?: boolean;
  declare?: {
    /** The command's own designation, honoured after the declaration batch if it is still legal. */
    targetId?: CardId;
    /** 「際 after-effect: ask the attacker again」 — only this opens the `attackTarget` decision. */
    ask?: true;
  };
}

export type PendingDecision =
  | { type: 'mulligan'; player: PlayerId }
  /** `mandatory` marks 「可能ならブロックしなければならない」: declining is illegal while a blocker exists. */
  | { type: 'block'; player: PlayerId; mandatory?: boolean }
  /**
   * 「[狙い撃ち]（相手のフロントLのキャラを指定してアタックでき…）」 — the designation window after the
   * declaration-time (「際」) effects have resolved. Candidates were filtered at the moment the window
   * opened (snipe live, the opponent's front line, no protection, the sniper's BP ceiling, the designation
   * tax payable); nothing can change the board while this decision is open, so the answer only has to be
   * one of `candidates`.
   *
   * `declared` is the command's pre-declared target for the client to highlight (the engine does not
   * assume it is legal). `queued` is the usual carrier for abilities raised while the window was being
   * set up, so a future change cannot silently drop them.
   */
  | { type: 'attackTarget'; player: PlayerId; attackerId: CardId; candidates: CardId[]; declared?: CardId; queued?: EffectTask[] }
  /**
   * `outsideBattle` marks 「相手プレイヤーにNダメージ。」 with no battle open — see `damagePlayer`.
   *
   * `queued` carries abilities that were raised *while this damage was being set up* (a retirement
   * watcher fired by the battle that just resolved). The command that raised them ends with this very
   * pending open, so a `ctx.queue` left behind would be dropped with it; `chooseDamage` hands them to
   * the trigger batch instead, where they resolve like any other waiting task.
   */
  | { type: 'damage'; player: PlayerId; damagedPlayer: PlayerId; count: number; outsideBattle?: true; queued?: EffectTask[];
      /**
       * The card the damage came from (the attacking character, or the effect's source for a burn). The
       * trigger batch that follows reads it for 「このキャラが与えたダメージによるトリガーチェック」.
       */
      sourceId?: CardId }
  | TriggerDecision
  | QueueDecision
  | EffectDecision
  | { type: 'discard'; player: PlayerId; count: number;
      /**
       * Abilities raised while this decision was being set up (the end phase's ready-step activation
       * watchers). The command that raised them ends with this pending open, so a `ctx.queue` left
       * behind would be dropped with it; answering the discard hands them back to the queue.
       */
      queued?: EffectTask[] }
  /**
   * 「エンドフェイズにこのキャラをアクティブにしなくてもよい。」 — the end phase's ready step, asked
   * instead of taken, for the cards whose print leaves it to their controller. `cards` are exactly those
   * (already rested, already excused by `cannotActivate`-style statics); everything else was stood up
   * before the question opened.
   */
  | { type: 'optionalReady'; player: PlayerId; cards: CardId[]; queued?: EffectTask[] }
  /**
   * 「自分が一度に2ダメージ以上受ける場合、代わりに1ダメージにしてもよい。」 — the question is the
   * *damaged* player's (`damagedPlayer`), and the answer either takes `reduceTo` or the printed `count`.
   * Everything else the damage would have done (whose life area is hit, which card dealt it, whether a
   * battle was open) is carried here so the answer resumes exactly the damage that was asked about.
   */
  | { type: 'damageSubstitute'; player: PlayerId; damagedPlayer: PlayerId; count: number; sourceId?: CardId; outsideBattle?: true; substituteCardId: CardId; reduceTo: number }
  /**
   * 「相手の効果やバトルによってこのキャラが場を離れる場合、代わりに自分の手札を1枚場外に置いてもよい。」
   * (BLC-2-067) — the losing card's own bought-off departure, asked of its owner while the battle waits
   * for the loser to leave: accepting pays `hand` cards and keeps the card on the field (the accepted
   * offer then runs `follow`, the printed 「そうした場合、…」 instructions); declining lets the loss run
   * as printed. The resumption after the answer is the battle's normal tail (インパクト damage and the
   * battle's close), which the answer handler itself performs.
   */
  | { type: 'battleLossSubstitute'; player: PlayerId; cardId: CardId; hand?: number; follow?: CardEffect[] }
  /**
   * 「（このカードが…にある場合、…に置けるカードの枚数が1枚減る）」 の着地で上限を超えたときの解消
   * (Q997/Q985/Q1406). `cards` are the line's residents at the moment the question opened; the *owner*
   * (not the active player) picks one of them for the removal area, and the check re-runs until the line
   * fits — so a line still over capacity asks again with a fresh list.
   */
  | { type: 'lineOverflow'; player: PlayerId; line: Line; cards: CardId[]; queued?: EffectTask[] }
  | { type: 'energyOverflow'; player: PlayerId; defender: PlayerId; defenderId: CardId; cards: CardId[]; queued?: EffectTask[] }
  | { type: 'selectionTaxHand'; player: PlayerId; count: number; cards: CardId[];
      /**
       * The trigger batch that was open when the tax question interrupted it. Restored by the answer, which
       * then finishes that batch (its `effects` may also have grown while the question was being set up).
       */
      triggers: TriggerDecision;
      /** The `resolveTrigger` answer that chose the target (engine-side resume; never client-supplied). */
      resume: Extract<Action, { type: 'resolveTrigger' }> };

export type Outcome = {
  winner: PlayerId;
  loser: PlayerId;
  /** `'card-effect'` is 「自分はゲームに勝利する。」 (BCV-1-028) — the winner won by effect, not by attrition. */
  reason: 'life-zero' | 'deck-out' | 'concede' | 'card-effect';
};

/** Authoritative/private snapshot. Never send this object or internal events to a client. */
export interface GameState {
  /** One-shot destination answers for an interrupted atomic command; consumed at its leaf move. */
  departureChoices?: Record<CardId, 'original' | 'removal' | 'top' | 'pay'>;
  departurePayChoices?: Record<CardId, CardId[]>;
  schemaVersion: 2;
  rulesVersion: 'ua-effects-2026-09-25';
  revision: number;
  status: 'setup' | 'playing' | 'finished';
  catalog: Record<string, CardDefinition>;
  cards: Record<CardId, CardInstance>;
  players: [PlayerState, PlayerState];
  firstPlayer: PlayerId;
  activePlayer: PlayerId;
  turn: number;
  phase: Phase;
  extraDrawUsed: boolean;
  /**
   * What has already happened this turn, in order. Cleared by `beginTurn`, so it never spans turns.
   *
   * Optional so that a save written before this field existed restores as an empty log rather than
   * failing validation — the missing entry means "nothing recorded", which is what those saves had.
   */
  turnEvents?: TurnEvent[];
  rng: number;
  /**
   * Where the current battle's loser goes instead of the sideline, set by a resolving ability and
   * consumed by the comparison that follows it. Cleared with the battle.
   */
  battleLoserTo?: 'energy' | 'removal' | 'hand' | 'deckBottom' | 'stay';
  /** The source card of the effect that set  — the text-rewrite static checks it. */
  battleLoserToSource?: CardId;

  pending: PendingDecision | null;
  battle: Battle | null;
  /** Last issued `Battle.seq`, so every battle gets its own number (「アタック終了時まで」). */
  battleSeq?: number;
  outcome: Outcome | null;
  effect?: EffectFrame;
  publicReveals?: CardId[];
}

export type Action =
  /** Inspecting/reordering one's field materials is independent of turn/decision priority. */
  | { type: 'reorderFaceDown'; cardId: CardId; order: CardId[] }
  | { type: 'mulligan'; redraw: boolean }
  | { type: 'advance' }
  | { type: 'extraDraw' }
  | { type: 'move'; moves: { cardId: CardId; to: Line }[]; remove?: CardId[] }
  | {
      type: 'play'; cardId: CardId; to?: Line; replace?: CardId;
      /**
       * 「〈X〉を選んで使用する場合、このカードの消費APを-1する。」 — the target this card is *used
       * with*, named before the AP is paid.
       *
       * The printed condition reads the choice that is part of using the card, so the choice cannot wait
       * for the effect's own selection: the declaration is made here, the printed discount is priced
       * from it (`getApCost`), and the linked selection binds it instead of asking again. A card with no
       * `useTarget` refuses a stray declaration; a card with one requires it whenever the linked pool
       * has a candidate (an empty pool is the 「対象がいなくても使用できる」 case, Q110).
       */
      declare?: CardId;
      /**
       * 「このカードを使用する際に、自分の手札を望む枚数公開する。」 — the hand cards this use reveals.
       * Part of *using* the card, like `declare`: named before the AP is paid so a cost modifier gated
       * on the reveal can price the use, and refused on a card that prints no such reveal.
       */
      revealHand?: CardId[];
    }
  | { type: 'raid'; cardId: CardId; baseId: CardId; moveToFront?: boolean; replace?: CardId }
  | {
      type: 'attack'; cardId: CardId;
      /**
       * The pre-declared 狙い撃ち target (the legacy meaning). Without declaration-time watchers this is
       * validated and paid immediately, exactly as before; with them it is honoured after the 「際」 batch
       * when still legal, and dropped with a log line otherwise.
       */
      targetId?: CardId;
      /** 「際 effects first, then ask me」 — only this ever opens the `attackTarget` decision. */
      askTarget?: true;
    }
  | { type: 'block'; cardId: CardId | null }
  | { type: 'chooseDamage'; slots: number[] }
  | { type: 'resolveTrigger'; cardId: CardId; activate: boolean; targetId?: CardId; baseId?: CardId; moveToFront?: boolean; replace?: CardId;
      /** Only a saved effective-GET decision permits these continuation answers. */
      getReplacement?: boolean; getEntryLine?: Line;
      /**
       * 「このカードの[ゲット]を発動する場合、代わりに[ドロートリガー]か[アクティブ]にしてもよい。」
       * (SMD-1-060) — the card's own permission lets its [ゲット] be activated *as* one of the named kinds.
       * The substituted kind carries that kind's whole resolution (its effect and the destination its life
       * card takes), and is refused when the resolved card does not print the permission.
       *
       * `'get'` is the mirrored direction (EVA-1-018): the card's trigger is a [ドロートリガー] or
       * [アクティブ], and the *controller's* field card grants the permission to read it as [ゲット] —
       * the life card reaches the hand instead of resolving its printed kind.
       *
       * `'deployRested'` is retained as legacy GET-activation intent; it still asks the separate entry
       * replacement before placing anything. Effective GET may originate in a chosen conversion.
       * The continuation selects a legal line, uses rule overflow, and discards only after entry.
       */
      substitute?: 'draw' | 'active' | 'get' | 'deployRested' }
  | { type: 'activate'; cardId: CardId; index?: number }
  | { type: 'chooseEffect'; choiceId: string; selected: string[] }
  | { type: 'resolveEffect'; taskId: string }
  | { type: 'discard'; cards: CardId[] }
  /**
   * 「エンドフェイズにこのキャラをアクティブにしなくてもよい。」 — the answer to the end phase's optional
   * ready step: exactly the cards to stand up, chosen from the ones the pending offered. Cards left out
   * stay rested, which is the printed permission.
   */
  | { type: 'resolveReady'; ready: CardId[] }
  /**
   * 「…代わりに1ダメージにしてもよい。」 — the damaged player accepts or declines the substitution. An
   * accepted answer spends the card's per-turn mark.
   */
  | { type: 'resolveDamageSubstitute'; accept: boolean }
  /** 「…代わりに自分の手札を1枚場外に置いてもよい」 on a battle loss (BLC-2-067): `cards` names the hand cards paid when accepting. */
  | { type: 'resolveBattleLossSubstitute'; accept: boolean; cards?: CardId[] }
  /** 「…に置けるカードの枚数が減った結果、上限を超えた」 (Q997/Q985/Q1406): the line's owner names the card to remove. */
  | { type: 'resolveLineOverflow'; cardId: CardId }
  /** 「満线のエナジーLに敗者が移る場合、相手（胜者）が1枚選んでリムーブする」 (Q1614, RC-06B): the winner names the resident to remove. */
  | { type: 'resolveEnergyOverflow'; cardId: CardId }
  | { type: 'resolveSelectionTax'; cards: CardId[] }
  /** The `attackTarget` answer: designate one of the offered candidates, or `null` = attack normally. */
  | { type: 'resolveAttackTarget'; targetId: CardId | null }
  | { type: 'concede' };

export interface Command {
  player: PlayerId;
  /** Required optimistic concurrency guard. Repeated or stale commands are rejected. */
  expectedRevision: number;
  action: Action;
}

export interface GameEvent {
  /** Events are an internal diagnostic stream and MAY contain hidden card IDs. */
  type: string;
  data: Record<string, string | number | boolean | null | string[] | number[]>;
}

export type ErrorCode =
  | 'INVALID_COMMAND' | 'STALE_COMMAND' | 'GAME_FINISHED' | 'WRONG_PLAYER'
  | 'WRONG_PHASE' | 'DECISION_PENDING' | 'INVALID_CARD' | 'INVALID_TARGET'
  | 'INVALID_CHOICE' | 'INSUFFICIENT_AP' | 'INSUFFICIENT_ENERGY'
  | 'LINE_FULL' | 'NOT_ACTIVE' | 'DECK_EMPTY' | 'EXTRA_DRAW_USED'
  | 'INVALID_DECK' | 'UNSUPPORTED_CARD' | 'INVALID_STATE';

export type CommandResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; state: GameState; events: []; error: { code: ErrorCode; message: string } };

export interface MatchConfig {
  catalog: CardDefinition[];
  decks: [string[], string[]];
  firstPlayer: PlayerId;
  seed: number;
}
