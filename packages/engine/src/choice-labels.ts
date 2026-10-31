import type { CardEffect, EffectDecision, EffectFrame, CardFilter, Keywords, Condition } from './types.ts';
import { ANY_COUNT } from './types.ts';
import { takeDestinationText } from './effects.ts';
import { optionalEntryChoice } from './optional-entry.ts';

/** Presentation only: read the resolving frame, never infer branches from a card's bullet indices. */
const circled = (n: number) => '⓪①②③④⑤⑥⑦⑧⑨'[n] ?? `（${n}）`;
const signed = (n: number) => n >= 0 ? `+${n}` : String(n);
const color: Record<string, string> = { purple: '紫', green: '绿', blue: '蓝', red: '红', yellow: '黄' };
const zone: Record<string, string> = { ownField: '我方场上', opponentField: '对方场上', ownFront: '我方前线', opponentFront: '对方前线', ownEnergy: '我方能量线', opponentEnergy: '对方能量线', ownHand: '我方手牌', opponentHand: '对方手牌', ownSideline: '我方场外', opponentSideline: '对方场外', ownRemoval: '我方移除区', opponentRemoval: '对方移除区', ownAp: '我方 AP', ownDeck: '我方牌库', opponentDeck: '对方牌库', under: '此角色下方', front: '前线', energy: '能量线', sideline: '场外', removal: '移除区' };
Object.assign(zone, { enemyField: '对方场上', enemyFront: '对方前线', enemyEnergy: '对方能量线', enemyHand: '对方手牌', enemySideline: '对方场外', enemyRemoval: '对方移除区', enemyDeck: '对方牌库', enemyLife: '对方生命区', enemyAp: '对方 AP', ownLife: '我方生命区', ownUnder: '此角色下方', ownUnderAll: '我方角色下方', ownRaidUnder: '此角色的突进元', ownRaidBottom: '此角色突进堆栈底部', eventRaidUnder: '事件角色的突进元', blocker: '阻挡角色', hand: '手牌', life: '生命区' });
const event: Record<string, string> = { onPlay: '登场时', onRetire: '退场时', onAttack: '攻击时', onAttackDeclare: '攻击宣言时', onBlock: '阻挡时', onAttackPhaseEnd: '攻击阶段结束时', onAttackEnd: '攻击结束时', onMainEnd: '主阶段结束时', onEndPhase: '结束阶段时', onTurnStart: '回合开始时', onRaided: '被突进时', onUnblockedAttack: '攻击且未被阻挡时', onBlocked: '攻击被阻挡时', onBattleWin: '战斗获胜时' };
const keyword: Record<string, string> = { impact: '冲击', damage: '伤害', impactNegate: '冲击无效', snipe: '瞄准攻击', step: '移动', doubleBlock: '双重阻挡', doubleAttack: '双重攻击' };
function keywords(k: Keywords): string {
  return Object.entries(k).filter(([, v]) => v !== false && v !== undefined).map(([key, v]) => `【${keyword[key] ?? key}${typeof v === 'number' ? circled(v) : ''}】`).join('、');
}
function filter(f: Pick<CardFilter, 'color' | 'name' | 'names' | 'nameContains' | 'trait' | 'raid' | 'maxBP' | 'minBP' | 'maxEnergy' | 'minEnergy' | 'kind'> = {}): string {
  return [f.color && `${color[f.color]}色`, f.name && `〈${f.name}〉`, f.names && f.names.map(n => `〈${n}〉`).join('／'), f.nameContains && `卡名含「${f.nameContains}」`, f.trait && `[特征：${f.trait}]`, f.raid === true && '突进状态', f.raid === false && '非突进状态', f.maxBP !== undefined && `BP≤${f.maxBP}`, f.minBP !== undefined && `BP≥${f.minBP}`, f.maxEnergy !== undefined && `所需能量≤${f.maxEnergy}`, f.minEnergy !== undefined && `所需能量≥${f.minEnergy}`, f.kind && ({ character: '角色', event: '事件', field: '场地' }[f.kind])].filter(Boolean).join('、');
}
function duration(d?: string): string {
  return d === undefined || d === 'turn' ? '在本回合中' : ({ untilOwnTurnStart: '直到我方下个回合开始', untilOpponentAttackEnd: '直到对方攻击结束', attackEnd: '直到本次攻击结束', untilOpponentTurnEnd: '直到对方下个回合结束', whileSourceOnField: '在来源仍在场期间' } as Record<string, string>)[d] ?? '在卡文指定期间';
}
function subject(target?: string | string[]): string { return target === 'source' || target === '__self' ? '此角色' : target === 'opponentPlayer' ? '对方' : '所选卡牌'; }
function bounds(c: { min?: number; max?: number }): string {
  return [c.min !== undefined && `≥${c.min}`, c.max !== undefined && `≤${c.max}`].filter(Boolean).join('且');
}
function condition(c: Condition): string {
  const who = 'who' in c && c.who === 'opponent' ? '对方' : '我方';
  switch (c.type) {
    case 'any': case 'all': return c.conditions.map(condition).join(c.type === 'any' ? '或' : '且');
    case 'not': return `不满足「${condition(c.condition)}」`;
    case 'hasName': return `${who}场上有〈${c.name}〉`;
    case 'hasTrait': return `${who}场上有[特征：${c.trait}]`;
    case 'fieldCount': return `${who}${c.sameLine ? '同一战线' : c.line ? zone[c.line] : '场上'}${filter(c)}卡牌数量${bounds(c)}`;
    case 'lifeCount': return `${who}生命数量${bounds(c)}`;
    case 'handCount': return `${who}手牌数量${bounds(c)}`;
    case 'sidelineCount': case 'removalCount': return `${who}${c.type === 'sidelineCount' ? '场外' : '移除区'}${filter(c)}卡牌数量${bounds(c)}`;
    case 'selectedHas': return `所选卡牌符合${filter(c) || '卡文指定条件'}`;
    case 'atZone': return `此角色在${zone[c.zone]}`;
    case 'underCount': return `此角色下方卡牌数量${bounds(c)}`;
    case 'enteredVia': return `此角色从${c.from ? zone[c.from] ?? c.from : '卡文指定区域'}登场`;
    case 'turnOf': return `当前为${who}回合`;
    case 'selfActive': return '此角色处于活跃状态';
    case 'producedEnergy': return `${who}产生能量${bounds(c)}`;
    case 'selfBp': return `此角色 BP${bounds(c)}`;
    case 'raidUnderEnergy': return `突进元所需能量${bounds(c)}`;
    case 'selectionCount': return `所选卡牌数量${bounds(c)}`;
    case 'faceUpCount': return `正面朝上的生命卡牌数量${bounds(c)}`;
    case 'distinctNames': return `${who}卡文指定区域内不同卡名数量${bounds(c)}`;
    case 'turnEvent': return '本回合已发生卡文指定事件';
    case 'usedEventThisTurn': return '本回合已使用事件卡';
    default: return '满足卡文条件';
  }
}

function lookedLabel(e: Extract<CardEffect, { type: 'lookReveal' }>): string {
  const rest: Record<string, string> = { bottom: '放到牌库底', top: '放回牌库顶', orderTop: '按所选顺序放回牌库顶', sideline: '置于场外', topOrSideline: '放回牌库顶或置于场外', splitTopSideline: '分配至牌库顶或场外', splitTop: '分配至牌库顶或底', topOrBottom: '放回牌库顶或底', topBottomFaceUp: '按卡文分配至牌库顶或底' };
  return `查看${e.player === 'opponent' ? '对方' : '我方'}${e.from === 'under' ? '角色下方' : '牌库顶'} ${e.count} 张牌${e.max ? `，${e.reveal ? '公开并' : ''}${takeDestinationText(e.take)}最多 ${e.max} 张${filter(e.filter) ? `（${filter(e.filter)}）` : ''}` : ''}，剩余${rest[e.rest] ?? '按卡文处理'}`;
}

function operation(e: Extract<CardEffect, { type: 'act' | 'actSource' | 'choose' }>): string | undefined {
  const target = e.type === 'actSource' ? '此角色' : '所选卡牌';
  const amount = 'amount' in e ? e.amount ?? 0 : 0;
  const d = duration('duration' in e ? e.duration : undefined);
  const line = 'line' in e && e.line ? `至${zone[e.line]}` : '';
  switch (e.operation) {
    case 'activate': return `将${target}转为活跃状态`;
    case 'rest': return `将${target}转为休息状态`;
    case 'bp': return `${target}${d} BP${'amountPer' in e && e.amountPer ? `按卡文计数每单位${signed(e.amountPer.amount)}` : signed(amount)}`;
    case 'impact': case 'damage': return `${target}${d}获得【${keyword[e.operation]}${'relative' in e && e.relative ? signed(amount) : circled(amount)}】`;
    case 'grantKeywords': return 'keywords' in e ? `${target}${d}获得${keywords(e.keywords ?? {})}` : undefined;
    case 'return': return `将${target}返回手牌`;
    case 'retire': return `使${target}退场`;
    case 'remove': return `将${target}置于移除区`;
    case 'move': return `将${target}移动${line || '至另一条战线'}`;
    case 'raid': return `用${target}进行突进${line}`;
    case 'deploy': case 'deployRested': return `将${target}以${e.operation === 'deploy' ? '活跃' : '休息'}状态登场${line}`;
    case 'readyAp': return '将所选 AP 转为活跃状态';
    case 'toDeckTop': return `将${target}放回牌库顶`;
    case 'toDeckBottom': return `将${target}放到牌库底`;
    case 'toUnder': return `将${target}置于此角色下方`;
    case 'topToSideline': return `将${target}的突进顶牌置于场外`;
    case 'topToDeckBottom': return `将${target}的突进顶牌放到牌库底`;
    case 'raidTopToHand': return `将${target}的突进顶牌加入手牌`;
    case 'underToSideline': return `将${target}下方的卡牌置于场外`;
    case 'placeSourceUnder': return `将此角色置于${target}下方`;
    case 'reveal': return `公开${target}`;
    case 'loseEffects': return `${target}${d}失去全部原有效果`;
    case 'energy': return `${target}${d}产生能量增加${'energy' in e ? Object.entries(e.energy ?? {}).map(([c, n]) => `${color[c]}×${n}`).join('、') : ''}`;
    default: return undefined;
  }
}

/**
 * Runtime replay steps carry no action of their own: `resumeCommand` re-runs the command whose option
 * it accompanies, so it must not blank out that option's readable label (the runtime-built
 * `departureAnswer` pair is the only current writer). Every other step stays authoritative — one
 * unreadable step hides the whole label.
 */
const controlFlowReplay = new Set<CardEffect['type']>(['resumeCommand']);
/** Summaries identify the action; the source card remains the authority for its detailed conditions. */
export function effectBranchLabel(steps: CardEffect[]): string | undefined {
  const described = steps.filter(s => !controlFlowReplay.has(s.type));
  if (steps.length && !described.length) return undefined;
  const parts = described.map(stepLabel).filter(s => s !== '');
  return parts.some(s => s === undefined) ? undefined : parts.length ? parts.join('；') : '不执行此可选效果';
}
function stepLabel(e: CardEffect): string | undefined {
  switch (e.type) {
    case 'departureAnswer': return e.destination === 'top' ? '将顶牌置于场外，让基底留场' : e.destination === 'removal' ? '改为置于移除区' : '保留原处理';
    case 'resumeCommand': return undefined;
    case 'act': case 'actSource': return operation(e);
    case 'draw': case 'drawTo': return `${'player' in e && e.player === 'opponent' ? '对方' : '我方'}抽${e.upTo ? '至多' : ''} ${e.count} 张牌`;
    case 'drawToSize': return `${e.player === 'opponent' ? '对方' : '我方'}抽牌至手牌为 ${e.count} 张`;
    case 'takeRevealed': return '将公开的卡加入手牌';
    case 'discard': return `${e.player === 'opponent' ? '对方' : '我方'}将${e.all ? '全部' : e.optional && e.count >= ANY_COUNT ? '任意张' : ` ${e.count} 张`}手牌置于场外`;
    case 'select': return `选择${zone[e.zone] ?? '卡文指定区域'}${e.max >= ANY_COUNT ? '任意张' : `${e.min === 0 ? '最多' : ''} ${e.max} 张`}${filter(e.filter) ? `（${filter(e.filter)}）` : '卡牌'}`;
    case 'deployBatch': return `从手牌各组选择最多1张，同时${e.rested ? '休息' : '活跃'}登场或突进`;
    case 'choose': {
      const action = operation(e);
      return action && `从${zone[e.zone] ?? '卡文指定区域'}选择${e.min === 0 ? '最多' : ''} ${e.max} 张${filter(e.filter) ? `（${filter(e.filter)}）` : ''}，${action}`;
    }
    case 'self': return `此角色${duration()}${[e.bp !== undefined && ` BP${signed(e.bp)}`, e.keywords && `${e.lose ? '失去' : '获得'}${keywords(e.keywords)}`, e.impact !== undefined && `获得【冲击${circled(e.impact)}】`, e.energyBonus && `产生能量增加${Object.entries(e.energyBonus).map(([c,n]) => `${color[c] ?? c}×${n}`).join('、')}`, e.retireMainEnd && '在主阶段结束时退场'].filter(Boolean).join('、')}`;
    case 'if': {
      const then = effectBranchLabel(e.then ?? []), otherwise = e.else?.length ? effectBranchLabel(e.else) : '';
      return then && (otherwise !== undefined) ? `${condition(e.condition)}时：${then}${otherwise ? `；否则：${otherwise}` : ''}` : undefined;
    }
    case 'gained': { const then = effectBranchLabel(e.then ?? []); return then && `成功执行前述处理后：${then}`; }
    case 'lookReveal': return lookedLabel(e);
    case 'chooseOption': { const labels = e.options.map(effectBranchLabel); return labels.every(s => s !== undefined) ? `从下列选择 ${e.count} 项：${labels.join(' / ')}` : undefined; }
    case 'grantTrigger': { const label = effectBranchLabel(e.effects); return label && `${subject(e.target)}${duration(e.duration)}获得「${event[e.event] ?? '卡文指定时机'}：${label}」`; }
    case 'grantStatic': {
      const labels = e.abilities.flatMap(a => a.modifiers.map(m => {
        switch (m.type) {
          case 'keywords': return `获得${keywords(m.keywords)}`;
          case 'bp': return `BP${signed(m.amount)}`;
          case 'energy': return `产生能量增加${Object.entries(m.energy).map(([c, n]) => `${color[c]}×${n}`).join('、')}`;
          case 'cannotAttack': return '不能攻击';
          case 'cannotBlock': return '不能阻挡';
          case 'doesNotRetire': return m.source === 'battle' ? '本次战败不会退场' : '不会退场';
          case 'cannotBeChosenBy': return '不能被卡文指定的效果选择';
          case 'cannotBeBlockedBy': return `不能被${m.maxBP !== undefined ? ` BP≤${m.maxBP}` : filter(m.filter) || '卡文指定'}的角色阻挡`;
          case 'cannotBeBlockedByAtLeast': return `不能被 BP≥${m.minBP} 的角色阻挡`;
          case 'generatesFromFront': return '在前线也产生能量';
          case 'grantToHand': return `赋予手牌${filter(m.filter)}卡文指定的能力`;
          case 'countsAsEventAsWell': return '将符合卡文条件的卡牌也视为事件卡';
          default: return undefined;
        }
      }));
      return labels.every(s => s !== undefined) ? `${subject(e.target)}${duration(e.duration)}${labels.join('、')}` : undefined;
    }
    case 'replayAbility': return `发动${e.target === 'raidBase' ? '突进元' : '所选卡牌'}的${('events' in e ? e.events : [e.event]).map(x => `【${event[x] ?? x}】`).join('／')}效果`;
    case 'swapLines': return '交换所选角色的战线位置';
    case 'nextUseAp': return `下次使用${filter(e.filter) || '卡牌'}的 AP 消耗${signed(e.amount)}`;
    case 'nextRaidEnergy': return `下次突进${filter(e.filter) || '角色'}所需${color[e.color]}能量${signed(e.amount)}`;
    case 'nextSelectBp': return `下次选择目标的 BP 范围${signed(e.amount)}`;
    case 'moveUnder': return '将所选卡牌置于指定角色下方';
    case 'takeUnder': return `将角色下方的${e.count >= 99 ? '全部' : e.count}张卡牌加入手牌`;
    case 'millTop': return `将${e.player === 'opponent' ? '对方' : '我方'}牌库顶 ${e.count} 张牌置于${zone[e.to ?? 'sideline'] ?? '指定区域'}`;
    case 'declare': return e.what === 'energyCount' ? '指定所需能量的数量' : `指定${e.what === 'name' ? '卡名' : '特征'}`;
    case 'payAp': { const then = e.then?.length ? effectBranchLabel(e.then) : ''; return then !== undefined ? `支付 ${e.count} AP${then ? `；${then}` : ''}` : undefined; }
    case 'playerDamage': return `对对方造成 ${e.count} 点伤害`;
    case 'useFromSideline': return `使用所选场外卡牌${e.free ? '（免 AP）' : ''}`;
    case 'useSelf': return '使用此卡牌';
    case 'allowRemovalUse': return '本回合允许使用移除区中的卡牌';
    case 'eventCardToDeckTop': return '将此事件卡放回牌库顶';
    case 'deckTopFaceUp': return '将牌库顶的卡牌翻为正面朝上';
    case 'markStatement': return `声明手牌中${e.has ? '有' : '没有'}卡文指定的卡牌`;
    default: return undefined;
  }
}

export function choiceOptionLabel(frame: EffectFrame, pending: EffectDecision, id: string): string | undefined {
  const current = frame.steps[frame.index];
  if (current?.type === 'revealHand' && frame.stage === 'revealHandConfirm') return id === 'continue' ? '确认种类，继续结算' : undefined;
  if (current?.type === 'deployBatch') {
    if (frame.deploymentBatch?.phase === 'mode') return id === 'deploy' ? `${current.rested ? '以休息状态' : '以活跃状态'}登场` : id === 'raid' ? '突进' : undefined;
    if (frame.deploymentBatch?.phase === 'line') return id === 'front' ? '前线' : id === 'energy' ? '能量线' : undefined;
    if (frame.deploymentBatch?.phase === 'move') return id === 'front' ? '移至前线' : id === 'energy' ? '留在能量线' : undefined;
  }
  if (current?.type === 'triggerEntryChoice') {
    if (current.phase === 'replacement') return id === '0' ? '正常获得' : id === '1' ? '发动替代：休息登场后弃手' : undefined;
    if (current.phase === 'line') return id === 'front' ? '前线' : id === 'energy' ? '能量线' : undefined;
  }
  if (frame.stage === 'takeUseLine') return id === 'front' ? '前线' : id === 'energy' ? '能量线' : undefined;
  if (frame.stage === 'raidLine' || frame.stage === 'takeRaidLine') {
    return id === 'front' ? '移至前线' : id === 'energy' ? '留在能量线' : undefined;
  }
  if (!/^\d+$/.test(id)) return undefined;
  const step = frame.steps[frame.index];
  if (step?.type === 'chooseOption' && frame.stage === 'option') {
    // 「放回牌库顶 / 置于场外」 — a compiled branch name is the printed wording, so it wins over the
    // per-branch summary; absent labels keep the older `effectBranchLabel` reading.
    const printed = step.labels?.[Number(id)];
    if (printed) return printed;
    const branch = step.options[Number(id)];
    if (!branch) return undefined;
    const label = effectBranchLabel(branch);
    if (!optionalEntryChoice([step])) return label;
    const whole = frame.index === frame.steps.length - 1 && frame.steps.slice(0, frame.index).every(s => s.type === 'if');
    const timing = step.entrySharedLimitKey ? '登场时' : frame.abilityEvent ? event[frame.abilityEvent] : undefined;
    if (whole || step.entrySharedLimitKey) {
      const ability = `${timing ?? ''}效果`;
      return branch.length ? `发动${ability}${label ? `（${label}）` : ''}` : `不发动${ability}`;
    }
    return branch.length ? `执行此可选处理${label ? `（${label}）` : ''}` : '不执行此可选处理';
  }
  if (frame.stage === 'grantPick') {
    const ability = frame.grantPick?.abilities[Number(id)];
    return ability ? effectBranchLabel(ability.effects) : undefined;
  }
  // Destination / yes-no questions already spell out each answer in the engine prompt.
  const labelled = pending.prompt.match(new RegExp(`(?:^|[，,：:？?])\\s*${id}\\s*=\\s*([^，,]+)`));
  if (labelled) return labelled[1]!.trim();
  if (step?.type === 'declare' && step.what === 'energyCount') return `所需能量 ${id}`;
  if (step?.type === 'millTop') return `${id} 张`;
  return undefined;
}
