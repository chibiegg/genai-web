import { RecordedMessage, ToBeRecordedMessage } from 'genai-web';
import { calcExpireAt, getDb, ITEMS_TABLE } from './db';

export const listMessages = async (_chatId: string): Promise<RecordedMessage[]> => {
  const chatId = `chat#${_chatId}`;
  const res = await getDb().query(
    `SELECT attributes FROM ${ITEMS_TABLE} WHERE pk = $1 ORDER BY sk COLLATE "C" ASC`,
    [chatId],
  );

  return res.rows.map((row) => row.attributes as RecordedMessage);
};

export const batchCreateMessages = async (
  messages: ToBeRecordedMessage[],
  _userId: string,
  _chatId: string,
): Promise<RecordedMessage[]> => {
  const userId = `user#${_userId}`;
  const chatId = `chat#${_chatId}`;
  const createdDate = Date.now();
  const feedback = 'none';
  const expire_at = calcExpireAt();

  const items: RecordedMessage[] = messages.map((m: ToBeRecordedMessage, i: number) => {
    // 配列が存在し非空のときだけ Item に含める。金額値（number 型）はそのまま保存される。
    const usageCostHistory =
      Array.isArray(m.usageCostHistory) && m.usageCostHistory.length > 0
        ? m.usageCostHistory
        : undefined;
    return {
      id: chatId,
      createdDate: m.createdDate ?? `${createdDate + i}#0`,
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      trace: m.trace,
      extraData: m.extraData,
      userId,
      feedback,
      usecase: m.usecase,
      llmType: m.llmType ?? '',
      expire_at,
      ...(usageCostHistory !== undefined ? { usageCostHistory } : {}),
    };
  });

  // DynamoDB BatchWrite(Put) と同じく upsert セマンティクスで書き込む
  const db = getDb();
  for (const item of items) {
    await db.query(
      `INSERT INTO ${ITEMS_TABLE} (pk, sk, attributes, expire_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pk, sk) DO UPDATE SET attributes = EXCLUDED.attributes, expire_at = EXCLUDED.expire_at`,
      [item.id, item.createdDate, JSON.stringify(item), expire_at],
    );
  }

  return items;
};
