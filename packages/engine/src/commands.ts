import type { Command } from './types.ts';
import { requireRule } from './validation.ts';

/** Runtime boundary for commands originating from JSON or a future network adapter. */
export function validateCommand(value: unknown): asserts value is Command {
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const optionalStr = (v: unknown): boolean => v === undefined || str(v);
  const optionalBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every(str);
  const line = (v: unknown): boolean => v === 'front' || v === 'energy';
  const keys = (v: object, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
  requireRule(obj(value) && keys(value, ['player', 'expectedRevision', 'action']), 'INVALID_COMMAND', '命令格式无效。');
  requireRule((value.player === 0 || value.player === 1) && Number.isSafeInteger(value.expectedRevision) && (value.expectedRevision as number) >= 0, 'INVALID_COMMAND', '玩家或版本号无效。');
  const a = value.action;
  requireRule(obj(a) && typeof a.type === 'string', 'INVALID_COMMAND', '缺少动作。');
  let valid = false;
  switch (a.type) {
    case 'reorderFaceDown': valid = keys(a, ['type', 'cardId', 'order']) && str(a.cardId) && strings(a.order); break;
    case 'advance': case 'extraDraw': case 'concede': valid = keys(a, ['type']); break;
    case 'mulligan': valid = keys(a, ['type', 'redraw']) && typeof a.redraw === 'boolean'; break;
    case 'move': valid = keys(a, ['type', 'moves', 'remove']) && Array.isArray(a.moves) && a.moves.every(m => obj(m) && keys(m, ['cardId', 'to']) && str(m.cardId) && line(m.to)) && (a.remove === undefined || strings(a.remove)); break;
    case 'play': valid = keys(a, ['type', 'cardId', 'to', 'replace', 'declare', 'revealHand']) && str(a.cardId) && (a.to === undefined || line(a.to)) && optionalStr(a.replace) && optionalStr(a.declare) && (a.revealHand === undefined || (Array.isArray(a.revealHand) && a.revealHand.every(id => str(id)))); break;
    case 'raid': valid = keys(a, ['type', 'cardId', 'baseId', 'moveToFront', 'replace']) && str(a.cardId) && str(a.baseId) && optionalBool(a.moveToFront) && optionalStr(a.replace); break;
    case 'attack': valid = keys(a, ['type', 'cardId', 'targetId', 'askTarget']) && str(a.cardId) && optionalStr(a.targetId) && (a.askTarget === undefined || a.askTarget === true); break;
    case 'block': valid = keys(a, ['type', 'cardId']) && (a.cardId === null || str(a.cardId)); break;
    case 'chooseDamage': valid = keys(a, ['type', 'slots']) && Array.isArray(a.slots) && a.slots.every(n => Number.isSafeInteger(n) && n >= 0); break;
    case 'resolveTrigger': valid = keys(a, ['type', 'cardId', 'activate', 'targetId', 'baseId', 'moveToFront', 'replace', 'substitute', 'getReplacement', 'getEntryLine']) && str(a.cardId) && typeof a.activate === 'boolean' && optionalStr(a.targetId) && optionalStr(a.baseId) && optionalBool(a.moveToFront) && optionalStr(a.replace) && (a.substitute === undefined || a.substitute === 'draw' || a.substitute === 'active' || a.substitute === 'get' || a.substitute === 'deployRested') && optionalBool(a.getReplacement) && (a.getEntryLine === undefined || line(a.getEntryLine)); break;
    case 'activate': valid = keys(a, ['type', 'cardId', 'index']) && str(a.cardId) && (a.index === undefined || (Number.isSafeInteger(a.index) && (a.index as number) >= 0)); break;
    case 'chooseEffect': valid = keys(a, ['type', 'choiceId', 'selected']) && str(a.choiceId) && strings(a.selected); break;
    case 'resolveEffect': valid = keys(a, ['type', 'taskId']) && str(a.taskId); break;
    case 'discard': valid = keys(a, ['type', 'cards']) && strings(a.cards); break;
    case 'resolveReady': valid = keys(a, ['type', 'ready']) && strings(a.ready); break;
    case 'resolveDamageSubstitute': valid = keys(a, ['type', 'accept']) && typeof a.accept === 'boolean'; break;
    case 'resolveBattleLossSubstitute': valid = keys(a, ['type', 'accept', 'cards']) && typeof a.accept === 'boolean' && (a.cards === undefined || strings(a.cards)); break;
    case 'resolveLineOverflow': valid = keys(a, ['type', 'cardId']) && str(a.cardId); break;
    case 'resolveEnergyOverflow': valid = keys(a, ['type', 'cardId']) && str(a.cardId); break;
    case 'resolveAttackTarget': valid = keys(a, ['type', 'targetId']) && (a.targetId === null || str(a.targetId)); break;
    case 'resolveSelectionTax': valid = keys(a, ['type', 'cards']) && strings(a.cards); break;
  }
  requireRule(valid, 'INVALID_COMMAND', '动作名称、字段或参数类型无效。');
}
