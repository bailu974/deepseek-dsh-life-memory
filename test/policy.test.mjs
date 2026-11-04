import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePolicy } from '../index.js';

const base = {
  forgetThresholdTokens: 20000,
  forgetTurns: 200,
  keepCompletedTurns: 5,
  qqPolicy: {
    aggressive: { forgetThresholdTokens: 20000, forgetTurns: 200, keepCompletedTurns: 5 },
    gentle: { forgetThresholdTokens: 60000, forgetTurns: 10, keepCompletedTurns: 20 },
  },
};

function sessionsFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-'));
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify(content), 'utf8');
  return file;
}

test('列表里的会话走 aggressive，其它走 gentle', () => {
  const file = sessionsFile({ sessions: { 'group:1': 'session-aaa', 'private:2': 'session-bbb' } });
  const settings = { ...base, sessionsFile: file };

  const a = resolvePolicy(settings, 'session-aaa');
  assert.equal(a.forgetThresholdTokens, 20000);
  assert.equal(a.keepCompletedTurns, 5);

  const b = resolvePolicy(settings, 'session-zzz');
  assert.equal(b.forgetThresholdTokens, 60000);
  assert.equal(b.keepCompletedTurns, 20);
});

test('旧名字 qqSessionsFile 仍然有效', () => {
  const file = sessionsFile({ 'group:1': 'session-aaa' });
  const settings = { ...base, qqSessionsFile: file };
  assert.equal(resolvePolicy(settings, 'session-aaa').forgetThresholdTokens, 20000);
});

test('没配策略或没配列表时，原样返回 settings', () => {
  assert.equal(resolvePolicy({ ...base }, 'session-aaa').forgetThresholdTokens, 20000);
  const noPolicy = { forgetThresholdTokens: 30000, sessionsFile: sessionsFile({ a: 'session-aaa' }) };
  assert.equal(resolvePolicy(noPolicy, 'session-aaa').forgetThresholdTokens, 30000);
});

test('列表文件改了会自动跟上（带 mtime 缓存）', () => {
  const file = sessionsFile({ 'group:1': 'session-aaa' });
  const settings = { ...base, sessionsFile: file };
  assert.equal(resolvePolicy(settings, 'session-bbb').keepCompletedTurns, 20);

  fs.writeFileSync(file, JSON.stringify({ 'group:2': 'session-bbb' }), 'utf8');
  // 故意把 mtime 往前拨，确保缓存失效
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  assert.equal(resolvePolicy(settings, 'session-bbb').keepCompletedTurns, 5);
});
