// 源内 Web API サーバ（AWS 非依存構成）。
// 既存の Lambda ハンドラをアダプタ経由でマウントし、単一の常駐プロセスとして提供する。
//
// 必須環境変数:
//   DATABASE_URL        PostgreSQL 接続文字列
//   OIDC_ISSUER         OIDC IdP の issuer URL（例: http://localhost:8180/realms/genai）
//   MODEL_IDS           利用可能モデル ID の JSON 配列
//   MODEL_PROVIDER      'sakura'
//   SAKURA_AI_BASE_URL / SAKURA_AI_API_KEY
//   BUCKET_NAME / S3_ENDPOINT / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
//   AUTH_PROVIDER       'oidc'

import './shim'; // predictStream の awslambda グローバルより先に読み込む

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { PassThrough, Readable } from 'node:stream';

import { handler as createChat } from '../../cdk/lambda/createChat';
import { handler as createMessages } from '../../cdk/lambda/createMessages';
import { handler as createSystemContext } from '../../cdk/lambda/createSystemContext';
import { handler as deleteChat } from '../../cdk/lambda/deleteChat';
import { handler as deleteFile } from '../../cdk/lambda/deleteFile';
import { handler as deleteSystemContext } from '../../cdk/lambda/deleteSystemContext';
import { handler as findChatById } from '../../cdk/lambda/findChatById';
import { handler as getFileDownloadSignedUrl } from '../../cdk/lambda/getFileDownloadSignedUrl';
import { handler as getFileUploadSignedUrl } from '../../cdk/lambda/getFileUploadSignedUrl';
import { handler as listChats } from '../../cdk/lambda/listChats';
import { handler as listMessages } from '../../cdk/lambda/listMessages';
import { handler as listSystemContexts } from '../../cdk/lambda/listSystemContexts';
import { handler as predict } from '../../cdk/lambda/predict';
import { predictStreamHandler } from '../../cdk/lambda/predictStream';
import { handler as predictTitle } from '../../cdk/lambda/predictTitle';
import { ensureSchema } from '../../cdk/lambda/repository/db';
import { handler as updateSystemContextTitle } from '../../cdk/lambda/updateSystemContextTitle';
import { handler as updateTitle } from '../../cdk/lambda/updateTitle';

import { adapt, buildEvent, LambdaHandler } from './adapter';
import { authMiddleware } from './auth';
import { exAppsRoutes, startExAppWorker } from './routes/exapps';
import { teamsRoutes } from './routes/teams';
import { transcribeRoutes } from './routes/transcribe';
import { ensureTeamSchema } from './teamSchema';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

app.get('/healthz', (c) => c.json({ status: 'ok' }));

// 認証必須の API 群
const api = new Hono();
api.use('*', authMiddleware);

// predict
api.post('/predict', adapt(predict as LambdaHandler));
api.post('/predict/title', adapt(predictTitle as LambdaHandler));

// predict/stream: Lambda Response Streaming の代替。
// JSONL（application/x-ndjson）でストリーミングチャンクを返す。
api.post('/predict/stream', async (c) => {
  const event = await buildEvent(c, c.get('claims'), c.get('idToken'));
  const body = JSON.parse(event.body ?? '{}');

  const pass = new PassThrough();
  const context = {
    callbackWaitsForEmptyEventLoop: false,
    // 添付ファイルの所有者チェックに使う identityId（OIDC では sub）
    identity: { cognitoIdentityId: c.get('claims').sub },
  };

  // ハンドラはイベントとして PredictRequest そのもの（HTTP ボディ）を受け取る
  predictStreamHandler(body, pass, context as never)
    .catch((e: unknown) => {
      console.error('predictStream error:', e);
      pass.write(JSON.stringify({ text: 'エラーが発生しました。', stopReason: 'error' }) + '\n');
    })
    .finally(() => pass.end());

  return c.newResponse(Readable.toWeb(pass) as ReadableStream, 200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
});

// chats
api.post('/chats', adapt(createChat as LambdaHandler));
api.get('/chats', adapt(listChats as LambdaHandler));
api.get('/chats/:chatId', adapt(findChatById as LambdaHandler));
api.delete('/chats/:chatId', adapt(deleteChat as LambdaHandler));
api.put('/chats/:chatId/title', adapt(updateTitle as LambdaHandler));
api.get('/chats/:chatId/messages', adapt(listMessages as LambdaHandler));
api.post('/chats/:chatId/messages', adapt(createMessages as LambdaHandler));

// systemcontexts
api.post('/systemcontexts', adapt(createSystemContext as LambdaHandler));
api.get('/systemcontexts', adapt(listSystemContexts as LambdaHandler));
api.delete('/systemcontexts/:systemContextId', adapt(deleteSystemContext as LambdaHandler));
api.put('/systemcontexts/:systemContextId/title', adapt(updateSystemContextTitle as LambdaHandler));

// file（署名付き URL は S3 互換オブジェクトストレージに対して発行される）
api.post('/file/url', adapt(getFileUploadSignedUrl as LambdaHandler));
api.get('/file/url', adapt(getFileDownloadSignedUrl as LambdaHandler));
api.delete('/file/:fileName', adapt(deleteFile as LambdaHandler));

// チーム管理・AIアプリ管理・AIアプリ実行（クリーンルーム実装）
api.route('/', teamsRoutes);
api.route('/', exAppsRoutes);

// 文字起こし（AI Engine の Whisper 互換 API）
api.route('/', transcribeRoutes);

app.route('/', api);

const port = parseInt(process.env.PORT ?? '3001', 10);

const main = async () => {
  // 起動時にスキーマを適用する（存在すれば no-op）
  await ensureSchema();
  await ensureTeamSchema();
  // 共通アプリチーム（全ユーザーが利用可能なアプリを配置するチーム）を作成する
  const { createTeamWithId } = await import('./teamRepository');
  const { COMMON_TEAM_ID } = await import('../../cdk/lambda/utils/constants');
  await createTeamWithId(COMMON_TEAM_ID, '共通アプリチーム');
  // AIアプリ非同期実行のポーリングワーカーを開始する
  startExAppWorker();
  console.log(`genai-web server listening on :${port}`);
  serve({ fetch: app.fetch, port });
};

main().catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});

export default app;
