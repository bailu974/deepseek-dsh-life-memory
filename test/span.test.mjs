import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectForgettableSpan } from '../index.js';

/** 造一个够用的假会话：surface 顺序 + 事件表 + 取消息。 */
function makeSession({ turns = 12, charsPerMessage = 1700, omitTurns = [], unbalancedTurns = [] } = {}) {
  const events = [];
  const surface = [];
  const messages = new Map();
  let seq = 1;

  for (let t = 1; t <= turns; t += 1) {
    events.push({ seq: seq++, type: 'turn/start', data: { turn: t } });

    const userSeq = seq++;
    events.push({ seq: userSeq, type: 'user/message', data: {} });
    messages.set(userSeq, { content: [{ type: 'text', text: 'u'.repeat(charsPerMessage) }] });

    const asstSeq = seq++;
    const content =
      unbalancedTurns.includes(t)
        ? [{ type: 'text', text: 'a'.repeat(charsPerMessage) }, { type: 'tool-call' }]
        : [{ type: 'text', text: 'a'.repeat(charsPerMessage) }];
    events.push({ seq: asstSeq, type: 'assistant/message', data: { message: { content } } });
    messages.set(asstSeq, { content });

    events.push({ seq: seq++, type: 'turn/end', data: { turn: t } });

    if (!omitTurns.includes(t)) surface.push(userSeq, asstSeq);
  }

  const eventMap = new Map(events.map((e) => [e.seq, e]));
  return {
    surface: { nodes: surface },
    snapshotEvents: () => events,
    eventAt: (s) => eventMap.get(s),
    deriveEventMessage: (event) => messages.get(event?.seq),
  };
}

const baseOptions = { forgetThresholdTokens: 20000, forgetTurns: 200, keepCompletedTurns: 5 };

test('一次砍到位：超得多就一次切掉多轮，而不是每轮切 2 轮', () => {
  const session = makeSession({ turns: 15 });
  // 每轮约 2*1700*0.6 ≈ 2040 token，15 轮 ≈ 30600；阈值 20000 → 需要腾 10600，约 5~6 轮
  const span = selectForgettableSpan(session, { ...baseOptions, totalTokens: 30600 });
  assert.ok(span, '应该选中一段可切区间');
  assert.ok(span.turns.length >= 4, `应该一次切掉多轮，实际 ${span.turns.length}`);
  assert.ok(span.turns.length < 15, '不该把整段历史都切掉');
});

test('回归：折叠过一次之后，下一次仍能继续折叠（旧实现只会折一次）', () => {
  const turns = 15;
  const first = makeSession({ turns });
  const span1 = selectForgettableSpan(first, { ...baseOptions, totalTokens: 30600 });
  assert.ok(span1);

  // 把第一次切掉的轮次从 surface 上拿掉，模拟「折叠已经发生」
  const session2 = makeSession({ turns, omitTurns: span1.turns });
  const span2 = selectForgettableSpan(session2, { ...baseOptions, totalTokens: 30600 });
  assert.ok(span2, '折叠过的会话还应该能继续切，不能返回 null');
  assert.ok(!span2.turns.some((t) => span1.turns.includes(t)), '不该重复切已经折掉的轮次');
});

test('保护最近 keepCompletedTurns 轮', () => {
  const turns = 15;
  const session = makeSession({ turns });
  const span = selectForgettableSpan(session, { ...baseOptions, totalTokens: 30600 });
  assert.ok(span);
  const keepFrom = turns - baseOptions.keepCompletedTurns + 1;
  const protectedTurns = span.turns.filter((t) => t >= keepFrom);
  assert.equal(protectedTurns.length, 0, `最近 ${baseOptions.keepCompletedTurns} 轮不该被切：${protectedTurns}`);
});

test('工具调用未闭合的区间不切（否则请求会带半个 step）', () => {
  const turns = 6;
  // 第 3 轮故意留一个没回应的 tool-call，它落在可切区间里
  const session = makeSession({ turns, unbalancedTurns: [3] });
  const span = selectForgettableSpan(session, { ...baseOptions, keepCompletedTurns: 1, totalTokens: 99999 });
  assert.equal(span, null, '未闭合的 tool-call 会让平衡校验失败，应该返回 null');
});

test('不够可切的轮次时返回 null', () => {
  const session = makeSession({ turns: 3 });
  const span = selectForgettableSpan(session, { ...baseOptions, totalTokens: 99999 });
  assert.equal(span, null);
});
