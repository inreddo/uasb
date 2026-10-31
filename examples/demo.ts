import { applyCommand, createMatch, getPlayerView } from '../packages/engine/src/index.ts';
import { exampleCatalog, exampleDeck } from './cards.ts';
import { chooseExampleAction } from './policy.ts';

let state = createMatch({ catalog: exampleCatalog, decks: [exampleDeck, exampleDeck], firstPlayer: 0, seed: 20260924 });
console.log('UNION ARENA 基础引擎演示｜合成测试卡｜双方按固定策略行动（不阻挡）');
for (let step = 0; state.status !== 'finished'; step++) {
  if (step >= 2000) throw new Error('演示未在预期步数内结束。');
  const player = state.pending?.player ?? state.activePlayer;
  const view = getPlayerView(state, player);
  const action = chooseExampleAction(view);
  const result = applyCommand(state, { player, expectedRevision: state.revision, action });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  state = result.state;
  for (const event of result.events) {
    if (event.type === 'turnStarted') console.log(`第 ${event.data.turn} 回合，玩家 ${Number(event.data.player) + 1}，可用 AP ${event.data.usableAp}`);
    if (event.type === 'lifeRevealed') console.log(`  玩家 ${Number(event.data.player) + 1} 受到伤害，双方剩余生命 ${state.players.map(p => p.life.length).join(' : ')}`);
  }
}
console.log(`对局结束：玩家 ${state.outcome!.winner + 1} 获胜，原因 ${state.outcome!.reason}，共 ${state.revision} 个合法动作。`);
