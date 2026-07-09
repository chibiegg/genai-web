// PostgreSQL 実装の chatRepository / systemContextRepository を PGlite で検証する。
import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.TTL_DAYS = '30';
});

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createChat,
  deleteChat,
  findChatById,
  listChats,
  setChatTitle,
} from '../../../lambda/repository/chatRepository';
import { ensureSchema, ITEMS_TABLE, setQueryExecutor } from '../../../lambda/repository/db';
import { batchCreateMessages, listMessages } from '../../../lambda/repository/messageRepository';
import {
  createSystemContext,
  deleteSystemContext,
  findSystemContextById,
  listSystemContexts,
  updateSystemContextTitle,
} from '../../../lambda/repository/systemContextRepository';

const pglite = new PGlite();
const executor = {
  query: async (text: string, params?: unknown[]) => {
    const res = await pglite.query(text, params as never[]);
    return { rows: res.rows as Record<string, unknown>[] };
  },
};

describe('chatRepository (PostgreSQL)', () => {
  beforeEach(async () => {
    setQueryExecutor(executor);
    await ensureSchema(executor);
    await executor.query(`DELETE FROM ${ITEMS_TABLE}`);
  });

  afterAll(() => {
    setQueryExecutor(undefined);
  });

  it('createChat / findChatById / listChats が DynamoDB 時代と同じ形状を返す', async () => {
    const chat = await createChat('user-1');
    expect(chat.id).toBe('user#user-1');
    expect(chat.chatId).toMatch(/^chat#/);
    expect(chat.title).toBe('');

    const found = await findChatById('user-1', chat.chatId.replace('chat#', ''));
    expect(found).not.toBeNull();
    expect(found!.chatId).toBe(chat.chatId);

    const list = await listChats('user-1');
    expect(list.data).toHaveLength(1);
    expect(list.lastEvaluatedKey).toBeUndefined();

    // 他ユーザーには見えない
    expect(await findChatById('user-2', chat.chatId.replace('chat#', ''))).toBeNull();
    expect((await listChats('user-2')).data).toHaveLength(0);
  });

  it('listChats は新しい順に返す', async () => {
    // createdDate（ミリ秒）が単調増加するよう順に作成
    const c1 = await createChat('user-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const c2 = await createChat('user-1');

    const list = await listChats('user-1');
    expect(list.data.map((c) => c.chatId)).toEqual([c2.chatId, c1.chatId]);
  });

  it('setChatTitle でタイトルが更新される', async () => {
    const chat = await createChat('user-1');
    const updated = await setChatTitle(chat.id, chat.createdDate, '新しいタイトル');
    expect(updated.title).toBe('新しいタイトル');
    expect(updated.chatId).toBe(chat.chatId);
  });

  it('deleteChat はチャットとメッセージを削除する', async () => {
    const chat = await createChat('user-1');
    const chatId = chat.chatId.replace('chat#', '');
    await batchCreateMessages(
      [{ role: 'user', content: 'hi', messageId: 'm1', usecase: '/chat' }],
      'user-1',
      chatId,
    );
    expect(await listMessages(chatId)).toHaveLength(1);

    await deleteChat('user-1', chatId);

    expect(await findChatById('user-1', chatId)).toBeNull();
    expect(await listMessages(chatId)).toHaveLength(0);
  });
});

describe('systemContextRepository (PostgreSQL)', () => {
  beforeEach(async () => {
    setQueryExecutor(executor);
    await ensureSchema(executor);
    await executor.query(`DELETE FROM ${ITEMS_TABLE}`);
  });

  afterAll(() => {
    setQueryExecutor(undefined);
  });

  it('作成・一覧・タイトル更新・削除が機能する', async () => {
    const created = await createSystemContext('user-1', 'タイトル', 'あなたは翻訳者です');
    expect(created.systemContextId).toMatch(/^systemContext#/);

    const list = await listSystemContexts('user-1');
    expect(list).toHaveLength(1);
    expect(list[0].systemContext).toBe('あなたは翻訳者です');

    const rawId = created.systemContextId.replace('systemContext#', '');
    const updated = await updateSystemContextTitle('user-1', rawId, '更新後タイトル');
    expect(updated.systemContextTitle).toBe('更新後タイトル');

    await deleteSystemContext('user-1', rawId);
    expect(await findSystemContextById('user-1', rawId)).toBeNull();
    expect(await listSystemContexts('user-1')).toHaveLength(0);
  });
});
