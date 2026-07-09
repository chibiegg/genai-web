import { getDb, ITEMS_TABLE } from './db';

const BATCH_SIZE = 100;

type ItemKey = Record<string, unknown>;

// DynamoDB 時代の TransactWrite(Delete) 相当。キーは {id, createdDate} または {pk, sk} 形式を受け付ける。
export const transactDeleteItems = async (keys: { Key: ItemKey }[]): Promise<void> => {
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const pks: string[] = [];
    const sks: string[] = [];
    for (const { Key } of batch) {
      pks.push(String(Key.pk ?? Key.id));
      sks.push(String(Key.sk ?? Key.createdDate));
    }

    // 単一ステートメントでまとめて削除する（バッチ内は原子的）
    await getDb().query(
      `DELETE FROM ${ITEMS_TABLE}
       WHERE (pk, sk) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [pks, sks],
    );
  }
};
