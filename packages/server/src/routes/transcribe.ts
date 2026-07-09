// 文字起こし（Amazon Transcribe の代替）。
// さくらのAI Engine の Whisper 互換 API（/audio/transcriptions）を使用する。
// 制約: Whisper には話者分離（speaker diarization）がないため speakerLabel は無視される。

import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { Hono } from 'hono';
import { getDb } from '../../../cdk/lambda/repository/db';
import { authorizeOwnedKey } from '../../../cdk/lambda/utils/fileOwnership';
import { getS3Client } from '../../../cdk/lambda/utils/s3Client';

const getBaseUrl = (): string =>
  (
    process.env.SAKURA_AI_BASE_URL ||
    process.env.SAKURA_AI_ENGINE_BASE_URL ||
    'https://api.ai.sakura.ad.jp/v1'
  ).replace(/\/+$/, '');

const getApiKey = (): string => {
  const key = process.env.SAKURA_AI_API_KEY || process.env.SAKURA_AI_ENGINE_TOKEN;
  if (!key) {
    throw new Error('SAKURA_AI_API_KEY is not configured');
  }
  return key;
};

const WHISPER_MODEL_ID = () => process.env.WHISPER_MODEL_ID || 'whisper-large-v3-turbo';

// audioKey は署名付き URL のパスから抽出されるため、
// path-style（MinIO 等）ではバケット名が先頭に付く。ここで除去する。
const normalizeAudioKey = (audioKey: string): string => {
  const bucket = process.env.BUCKET_NAME ?? '';
  if (bucket && audioKey.startsWith(`${bucket}/`)) {
    return audioKey.slice(bucket.length + 1);
  }
  return audioKey;
};

const runTranscription = async (jobName: string, audioKey: string): Promise<void> => {
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: audioKey }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error('音声ファイルの取得に失敗しました');
    }

    const form = new FormData();
    form.append('file', new Blob([Buffer.from(bytes)]), audioKey.split('/').pop() ?? 'audio.webm');
    form.append('model', WHISPER_MODEL_ID());
    form.append('language', 'ja');

    const response = await fetch(`${getBaseUrl()}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getApiKey()}` },
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Whisper API returned ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as { text?: string };
    const transcripts = [{ transcript: data.text ?? '' }];

    await getDb().query(
      `UPDATE transcribe_jobs SET status = 'COMPLETED', transcripts = $2 WHERE job_name = $1`,
      [jobName, JSON.stringify(transcripts)],
    );
  } catch (e) {
    console.error('Transcription failed', e);
    await getDb().query(
      `UPDATE transcribe_jobs SET status = 'FAILED', error = $2 WHERE job_name = $1`,
      [jobName, String(e)],
    );
  }
};

export const transcribeRoutes = new Hono();

// POST /transcribe/url — 音声アップロード用の署名付き URL を発行する
transcribeRoutes.post('/transcribe/url', async (c) => {
  const claims = c.get('claims');
  const body = (await c.req.json()) as { filename?: string; mediaFormat: string };
  const filename = body.filename || `audio.${body.mediaFormat || 'webm'}`;

  const key = `${claims.sub}/${crypto.randomUUID()}/${filename}`;
  const command = new PutObjectCommand({ Bucket: process.env.BUCKET_NAME, Key: key });
  const signedUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 3600 });

  return c.json(signedUrl);
});

// POST /transcribe/start — 文字起こしジョブを開始する
transcribeRoutes.post('/transcribe/start', async (c) => {
  const claims = c.get('claims');
  const body = (await c.req.json()) as { audioKey?: string };
  if (!body.audioKey) {
    return c.json({ error: 'audioKey は必須です。' }, 400);
  }

  const audioKey = normalizeAudioKey(body.audioKey);
  // 所有者チェック（他ユーザーの音声ファイルを指定できないようにする）
  if (!authorizeOwnedKey(audioKey, claims.sub)) {
    return c.json({ error: 'この音声ファイルへのアクセス権がありません。' }, 403);
  }

  const jobName = crypto.randomUUID();
  await getDb().query(
    `INSERT INTO transcribe_jobs (job_name, user_id, status) VALUES ($1, $2, 'IN_PROGRESS')`,
    [jobName, claims.sub],
  );

  // 非同期で実行（フロントエンドは result をポーリングする）
  void runTranscription(jobName, audioKey);

  return c.json({ jobName });
});

// GET /transcribe/result/{jobName}
transcribeRoutes.get('/transcribe/result/:jobName', async (c) => {
  const claims = c.get('claims');
  const res = await getDb().query(
    'SELECT * FROM transcribe_jobs WHERE job_name = $1 AND user_id = $2',
    [c.req.param('jobName'), claims.sub],
  );
  const row = res.rows[0];
  if (!row) {
    return c.json({ error: 'ジョブが見つかりませんでした。' }, 404);
  }
  return c.json({
    status: String(row.status),
    languageCode: String(row.language_code),
    transcripts: (row.transcripts as { transcript: string }[] | null) ?? undefined,
  });
});
