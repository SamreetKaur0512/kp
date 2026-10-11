import test from 'node:test';
import assert from 'node:assert/strict';
import { fanChatHistoryFilter } from '../fan-chat-history.js';

test('new accounts only load public chat messages posted since registration', () => {
  const registeredAt = new Date('2026-10-11T12:00:00.000Z');
  assert.deepEqual(fanChatHistoryFilter({ createdAt: registeredAt }), {
    createdAt: { $gte: registeredAt },
  });
});

test('legacy accounts without a valid registration date keep existing chat history', () => {
  assert.deepEqual(fanChatHistoryFilter({}), {});
  assert.deepEqual(fanChatHistoryFilter({ createdAt: '2026-10-11' }), {});
  assert.deepEqual(fanChatHistoryFilter({ createdAt: new Date(Number.NaN) }), {});
});
