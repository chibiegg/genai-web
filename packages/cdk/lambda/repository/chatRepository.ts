import * as crypto from 'crypto';
import { Chat, ListChatsResponse } from 'genai-web';
import { calcExpireAt, getDb, ITEMS_TABLE } from './db';
import { listMessages } from './messageRepository';

const LIST_CHATS_LIMIT = 100;

export const createChat = async (_userId: string): Promise<Chat> => {
  const userId = `user#${_userId}`;
  const chatId = `chat#${crypto.randomUUID()}`;
  const expire_at = calcExpireAt();
  const item = {
    id: userId,
    createdDate: `${Date.now()}`,
    chatId,
    usecase: '',
    title: '',
    updatedDate: '',
    expire_at,
  };

  await getDb().query(
    `INSERT INTO ${ITEMS_TABLE} (pk, sk, attributes, expire_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (pk, sk) DO UPDATE SET attributes = EXCLUDED.attributes, expire_at = EXCLUDED.expire_at`,
    [item.id, item.createdDate, JSON.stringify(item), expire_at],
  );

  return item;
};

export const findChatById = async (_userId: string, _chatId: string): Promise<Chat | null> => {
  const userId = `user#${_userId}`;
  const chatId = `chat#${_chatId}`;
  const res = await getDb().query(
    `SELECT attributes FROM ${ITEMS_TABLE} WHERE pk = $1 AND attributes->>'chatId' = $2 LIMIT 1`,
    [userId, chatId],
  );

  if (res.rows.length === 0) {
    return null;
  }
  return res.rows[0].attributes as Chat;
};

export const listChats = async (
  _userId: string,
  _exclusiveStartKey?: string,
): Promise<ListChatsResponse> => {
  const userId = `user#${_userId}`;
  // DynamoDB の LastEvaluatedKey 相当。sk（createdDate）のキーセットページネーション。
  const exclusiveStartKey = _exclusiveStartKey
    ? (JSON.parse(Buffer.from(_exclusiveStartKey, 'base64').toString()) as { sk: string })
    : undefined;

  const params: unknown[] = [userId];
  let where = 'pk = $1';
  if (exclusiveStartKey) {
    params.push(exclusiveStartKey.sk);
    where += ` AND sk < $${params.length}`;
  }
  params.push(LIST_CHATS_LIMIT);

  const res = await getDb().query(
    `SELECT sk, attributes FROM ${ITEMS_TABLE} WHERE ${where} ORDER BY sk COLLATE "C" DESC LIMIT $${params.length}`,
    params,
  );

  const lastRow = res.rows.length === LIST_CHATS_LIMIT ? res.rows[res.rows.length - 1] : undefined;

  return {
    data: res.rows.map((row) => row.attributes as Chat),
    lastEvaluatedKey: lastRow
      ? Buffer.from(JSON.stringify({ sk: lastRow.sk })).toString('base64')
      : undefined,
  };
};

export const setChatTitle = async (id: string, createdDate: string, title: string) => {
  const res = await getDb().query(
    `UPDATE ${ITEMS_TABLE}
     SET attributes = attributes || jsonb_build_object('title', $3::text)
     WHERE pk = $1 AND sk = $2
     RETURNING attributes`,
    [id, createdDate, title],
  );
  return res.rows[0]?.attributes as Chat;
};

export const deleteChat = async (_userId: string, _chatId: string): Promise<void> => {
  // Chat の削除
  const chatItem = await findChatById(_userId, _chatId);
  if (chatItem) {
    await getDb().query(`DELETE FROM ${ITEMS_TABLE} WHERE pk = $1 AND sk = $2`, [
      chatItem.id,
      chatItem.createdDate,
    ]);
  }

  // Message の削除（メッセージは pk = chat#chatId で保存されている）
  const messageItems = await listMessages(_chatId);
  if (messageItems.length > 0) {
    await getDb().query(`DELETE FROM ${ITEMS_TABLE} WHERE pk = $1`, [`chat#${_chatId}`]);
  }
};
