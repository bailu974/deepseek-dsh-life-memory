import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { installForgettingHook } from '../index.js';

/** 造一个能被钩子驱动的假会话。 */
function makeSession({ id, turns = 8, charsPerMessage = 900, unbalancedTurns = [] } = {}) {
  const events = [];
  const messages = new Map();
  let seq = 1;
  const surface = [];

  for (let t = 1; t <= turns; t += 1) {
    events.push({ seq: seq++, type: 'turn/start', data: { turn: t } });

    const u = seq++;
    const uContent = [{ type: 'text', text: 'u'.repeat(charsPerMessage) }];
    events.push({ seq: u, type: 'user/message', data: { message: { content: uContent } } });
    messages.set(u, { content: uContent });
    surface.push(u);

    const a = seq++;
    const aContent = [{ type: 'text', text: 'a'.repeat(charsPerMessage) }];
    if (unbalancedTurns.includes(t)) aContent.push({ type: 'tool-call', id: 'c' + t });
    events.push({ seq: a, type: 'assistant/message', data: { message: { content: aContent } } });
    messages.set(a, { content: aContent });
    surface.push(a);

    events.push({ seq: seq++, type: 'turn/end', data: { turn: t } });
  }

  const eventMap = new Map(events.map((e) => [e.seq, e]));

  return {
    id,
    surface: { nodes: surface },
    snapshotEvents: () => events,
    eventAt: (sq) => eventMap.get(sq),
    deriveEventMessage: (event) => messages.get(event?.seq),
    append(type, data, opts) {
      events.push({ seq: seq++, type, data });
      if (opts?.surfaceOp?.op === 'replace') {
        const { startSeq, endSeq } = opts.surfaceOp;
        const keep = this.surface.nodes.filter((n) => n < startSeq || n > endSeq);
        this.surface.nodes = [...keep, seq - 1].sort((a, b) => a - b);
      }
    },
    /** 模拟「已经折过一次」：把最旧的 N 轮从 surface 上抹掉 */
    dropOldestTurns(n) {
      const turnMap = new Map();
      let turn = null;
      for (const e of events) {
        if (e.type === 'turn/start') turn = e.data?.turn;
        else if (e.type === 'turn/end') turn = null;
        else if (turn !== null) turnMap.set(e.seq, turn);
      }
      this.surface.nodes = this.surface.nodes.filter((node) => (turnMap.get(node) ?? 0) > n);
    },
  };
}

function makeCtx() {
  const handlers = [];
  return {
    handlers,
    on(name, fn) {
      if (name === 'agent/pre-step') handlers.push(fn);
    },
    get() {
      return undefined; // 没有 tokenMeter，走粗估
    },
    logger: { info() {}, warn() {} },
    async run(agent, turn) {
      for (const fn of handlers) {
        await fn({ agent, turn, signal: undefined }, async () => {});
      }
    },
  };
}

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lm-'));
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS memory_clues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    created_at INTEGER,
    keywords TEXT,
    seed_tokens TEXT,
    summary TEXT
  )`);
  return db;
}

const settings = {
  autoForget: true,
  forgetThresholdTokens: 2000,
  forgetTurns: 200,
  keepCompletedTurns: 2,
  limit: 5,
  maxPromptChars: 1800,
};

test('回归：两个会话在同一轮次各自折叠，互不干扰（旧实现只用全局 lastCutTurn）', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  installForgettingHook(ctx, settings, () => db);

  const a = makeSession({ id: 'session-A', turns: 8 });
  const b = makeSession({ id: 'session-B', turns: 8 });

  const beforeA = a.surface.nodes.length;
  const beforeB = b.surface.nodes.length;

  await ctx.run({ id: 'session-A', session: a }, 7);
  await ctx.run({ id: 'session-B', session: b }, 7);

  assert.ok(a.surface.nodes.length < beforeA, 'A 应该被折叠');
  assert.ok(b.surface.nodes.length < beforeB, 'B 处在同一轮次也必须被折叠');

  const rows = db.prepare('SELECT session_id FROM memory_clues').all();
  const ids = rows.map((r) => r.session_id).sort();
  assert.deepEqual(ids, ['session-A', 'session-B']);
  db.close();
});

test('未闭合的 compaction/start 只在最近才算「进行中」，陈旧的不该永久挡住', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  installForgettingHook(ctx, settings, () => db);

  // 造一个 40 个事件之前就 start、之后再没 end 的残留
  const a = makeSession({ id: 'session-stale', turns: 8 });
  const before = a.surface.nodes.length;
  a.snapshotEvents().push({ seq: 9999, type: 'compaction/start', data: {} });
  for (let i = 0; i < 30; i += 1) a.snapshotEvents().push({ seq: 10000 + i, type: 'user/message', data: {} });

  await ctx.run({ id: 'session-stale', session: a }, 7);
  assert.ok(a.surface.nodes.length < before, '陈旧 start 不该阻止折叠');
  db.close();
});

test('最旧那段工具没闭合时，会往后退一段继续折（不是直接放弃）', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  installForgettingHook(ctx, settings, () => db);

  const a = makeSession({ id: 'session-skip', turns: 10, unbalancedTurns: [1] });
  const before = a.surface.nodes.length;

  await ctx.run({ id: 'session-skip', session: a }, 9);
  assert.ok(a.surface.nodes.length < before, '应该跳过第 1 段、折后面的');
  db.close();
});

test('折叠提示本身不会被当成素材再折一次', async () => {
  const db = makeDb();
  const ctx = makeCtx();
  installForgettingHook(ctx, settings, () => db);

  const s = makeSession({ id: 'session-notice', turns: 8 });
  // 在最旧的几轮里塞一条「记忆已折叠」提示，模拟上一次折叠留下的 checkpoint
  const events = s.snapshotEvents();
  const noticeSeq = 2;
  events.push({ seq: 9001, type: 'user/message', data: { message: { content: [{ type: 'text', text: '【🧠 记忆已折叠】为了腾出空间，我已淡忘更早的 2 轮对话，留下的线索：旧线索。' }] } } });
  s.surface.nodes.unshift(9001);

  await ctx.run({ id: 'session-notice', session: s }, 7);

  const rows = db.prepare('SELECT keywords, seed_tokens FROM memory_clues').all();
  assert.ok(rows.length > 0, '应该折了一次');
  for (const r of rows) {
    const text = String(r.keywords) + ' ' + String(r.seed_tokens);
    assert.ok(!text.includes('记忆已折叠'), '线索里不该出现折叠提示：' + text.slice(0, 80));
  }
  db.close();
});
