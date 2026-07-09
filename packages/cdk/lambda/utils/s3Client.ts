import { S3Client } from '@aws-sdk/client-s3';

// S3 クライアントの共有ファクトリ。
// S3_ENDPOINT が設定されている場合は S3 互換オブジェクトストレージ
// （さくらのオブジェクトストレージ・MinIO 等）へ接続する。
// 互換ストレージでは path-style アドレッシングを使用する。
let instance: S3Client | undefined;

export const getS3Client = (): S3Client => {
  if (!instance) {
    const endpoint = process.env.S3_ENDPOINT;
    instance = endpoint ? new S3Client({ endpoint, forcePathStyle: true }) : new S3Client({});
  }
  return instance;
};
