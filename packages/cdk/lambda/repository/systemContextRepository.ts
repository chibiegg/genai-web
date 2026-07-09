import * as crypto from 'crypto';
import { SystemContext } from 'genai-web';
import { calcExpireAt, getDb, ITEMS_TABLE } from './db';

export const findSystemContextById = async (
  _userId: string,
  _systemContextId: string,
): Promise<SystemContext | null> => {
  const userId = `systemContext#${_userId}`;
  const systemContextId = `systemContext#${_systemContextId}`;
  const res = await getDb().query(
    `SELECT attributes FROM ${ITEMS_TABLE}
     WHERE pk = $1 AND attributes->>'systemContextId' = $2 LIMIT 1`,
    [userId, systemContextId],
  );

  if (res.rows.length === 0) {
    return null;
  }
  return res.rows[0].attributes as SystemContext;
};

export const listSystemContexts = async (_userId: string): Promise<SystemContext[]> => {
  const userId = `systemContext#${_userId}`;
  const res = await getDb().query(
    `SELECT attributes FROM ${ITEMS_TABLE} WHERE pk = $1 ORDER BY sk COLLATE "C" DESC`,
    [userId],
  );
  return res.rows.map((row) => row.attributes as SystemContext);
};

export const createSystemContext = async (
  _userId: string,
  title: string,
  systemContext: string,
): Promise<SystemContext> => {
  const userId = `systemContext#${_userId}`;
  const systemContextId = `systemContext#${crypto.randomUUID()}`;
  const expire_at = calcExpireAt();
  const item = {
    id: userId,
    createdDate: `${Date.now()}`,
    systemContextId: systemContextId,
    systemContext: systemContext,
    systemContextTitle: title,
    expire_at,
  };

  await getDb().query(
    `INSERT INTO ${ITEMS_TABLE} (pk, sk, attributes, expire_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (pk, sk) DO UPDATE SET attributes = EXCLUDED.attributes, expire_at = EXCLUDED.expire_at`,
    [item.id, item.createdDate, JSON.stringify(item), expire_at],
  );

  return item;
};

export const updateSystemContextTitle = async (
  _userId: string,
  _systemContextId: string,
  title: string,
): Promise<SystemContext> => {
  const systemContext = await findSystemContextById(_userId, _systemContextId);
  const res = await getDb().query(
    `UPDATE ${ITEMS_TABLE}
     SET attributes = attributes || jsonb_build_object('systemContextTitle', $3::text)
     WHERE pk = $1 AND sk = $2
     RETURNING attributes`,
    [systemContext?.id, systemContext?.createdDate, title],
  );

  return res.rows[0]?.attributes as SystemContext;
};

export const deleteSystemContext = async (
  _userId: string,
  _systemContextId: string,
): Promise<void> => {
  // System Context の削除
  const systemContext = await findSystemContextById(_userId, _systemContextId);
  if (systemContext) {
    await getDb().query(`DELETE FROM ${ITEMS_TABLE} WHERE pk = $1 AND sk = $2`, [
      systemContext.id,
      systemContext.createdDate,
    ]);
  }
};
