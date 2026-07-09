// リポジトリ層は PostgreSQL 実装のため、PGlite（WASM 版 PostgreSQL）で実挙動を検証する。
import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.TTL_DAYS = '30';
});

import { PGlite } from '@electric-sql/pglite';
import type { ToBeRecordedMessage, UsageCostEntry } from 'genai-web';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureSchema, ITEMS_TABLE, setQueryExecutor } from '../../../lambda/repository/db';
import { batchCreateMessages, listMessages } from '../../../lambda/repository/messageRepository';

const pglite = new PGlite();
const executor = {
  query: async (text: string, params?: unknown[]) => {
    const res = await pglite.query(text, params as never[]);
    return { rows: res.rows as Record<string, unknown>[] };
  },
};

const baseMessage: ToBeRecordedMessage = {
  role: 'assistant',
  content: 'hello',
  messageId: 'msg-1',
  usecase: '/chat',
};

const usageEntry: UsageCostEntry = {
  usage: {
    model: 'jp.anthropic.claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  },
  estimatedCost: { totalCost: 0.01155, currency: 'USD' },
};

describe('messageRepository.batchCreateMessages', () => {
  beforeEach(async () => {
    setQueryExecutor(executor);
    await ensureSchema(executor);
    await executor.query(`DELETE FROM ${ITEMS_TABLE}`);
  });

  afterAll(() => {
    setQueryExecutor(undefined);
  });

  it('usageCostHistory を含むメッセージは保存後も当該フィールドが保持される（金額は number 型）', async () => {
    const messages: ToBeRecordedMessage[] = [
      {
        ...baseMessage,
        usageCostHistory: [usageEntry],
      },
    ];
    await batchCreateMessages(messages, 'user-1', 'chat-1');

    const stored = await listMessages('chat-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].usageCostHistory).toEqual([usageEntry]);
    const history = stored[0].usageCostHistory as UsageCostEntry[];
    expect(typeof history[0].estimatedCost!.totalCost).toBe('number');
  });

  it('usageCostHistory が undefined の場合は属性ごと落として保存（後方互換）', async () => {
    const messages: ToBeRecordedMessage[] = [{ ...baseMessage }];
    const items = await batchCreateMessages(messages, 'user-1', 'chat-1');
    expect('usageCostHistory' in items[0]).toBe(false);

    const stored = await listMessages('chat-1');
    expect('usageCostHistory' in stored[0]).toBe(false);
  });

  it('usageCostHistory が空配列の場合は属性ごと落として保存', async () => {
    const messages: ToBeRecordedMessage[] = [{ ...baseMessage, usageCostHistory: [] }];
    const items = await batchCreateMessages(messages, 'user-1', 'chat-1');
    expect('usageCostHistory' in items[0]).toBe(false);

    const stored = await listMessages('chat-1');
    expect('usageCostHistory' in stored[0]).toBe(false);
  });

  it('複数 entry（continue/retry 想定）はすべて保存される', async () => {
    const second: UsageCostEntry = {
      usage: { ...usageEntry.usage, inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      estimatedCost: { totalCost: 0.0198, currency: 'USD' },
    };
    const messages: ToBeRecordedMessage[] = [
      { ...baseMessage, usageCostHistory: [usageEntry, second] },
    ];
    await batchCreateMessages(messages, 'user-1', 'chat-1');

    const stored = await listMessages('chat-1');
    expect(stored[0].usageCostHistory).toEqual([usageEntry, second]);
  });

  it('メッセージは chat#chatId 配下に createdDate 順で保存される', async () => {
    const messages: ToBeRecordedMessage[] = [
      { ...baseMessage, messageId: 'msg-1', createdDate: '100#0', content: 'old' },
      { ...baseMessage, messageId: 'msg-2', createdDate: '200#0', content: 'new' },
    ];
    const items = await batchCreateMessages(messages, 'user-1', 'chat-2');
    expect(items[0].id).toBe('chat#chat-2');
    expect(items[0].userId).toBe('user#user-1');
    expect(items[0].feedback).toBe('none');

    const stored = await listMessages('chat-2');
    expect(stored.map((m) => m.createdDate)).toEqual(['100#0', '200#0']);
  });
});
