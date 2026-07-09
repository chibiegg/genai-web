// AIアプリの実行（invoke）・実行履歴・非同期ポーリングワーカー。
// プロトコルは docs/AIアプリAPI仕様.md に準拠（x-api-key / x-user-id、202 + status_url）。

import type { UsageMetadata } from 'genai-web';
import { Hono } from 'hono';
import { COMMON_TEAM_ID } from '../../../cdk/lambda/utils/constants';
import { summarizeFromUsageMetadata } from '../../../cdk/lambda/utils/estimatedCostSummary';
import {
  assertPublicEndpointUrl,
  isExAppUrlValidationError,
  requestValidatedExAppUrl,
  resolveRelativeStatusUrl,
} from '../../../cdk/lambda/utils/exAppUrlSecurity';
import { predictExAppTitle } from '../../../cdk/lambda/utils/predictExAppTitle';
import * as repo from '../teamRepository';
import { generateStableUserId } from '../userIdentifier';
import { isSystemAdmin, isTeamMember } from './teams';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ローカル開発時に 127.0.0.1 等のエンドポイントを許可する（SSRF 検証をスキップ）
const allowPrivateEndpoints = (): boolean =>
  process.env.EXAPP_ALLOW_PRIVATE_ENDPOINTS === 'true';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type ExAppRequestOptions = {
  method: string;
  headers: Record<string, string>;
  body?: string;
};

type ExAppResponse = {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

const fetchExApp = async (url: string, options: ExAppRequestOptions): Promise<ExAppResponse> => {
  if (allowPrivateEndpoints()) {
    return fetch(url, options);
  }
  const validated = await assertPublicEndpointUrl(url);
  return requestValidatedExAppUrl(validated, options);
};

const toHistoryContent = (
  body: unknown,
  status: 'ACCEPTED' | 'COMPLETED' | 'ERROR',
): repo.HistoryContent => {
  const record = isRecord(body) ? body : {};
  const outputs =
    typeof record.outputs === 'string' ? record.outputs : JSON.stringify(record.outputs ?? '');
  const usageMetadata = Array.isArray(record.usageMetadata)
    ? (record.usageMetadata as UsageMetadata[])
    : undefined;
  let totalEstimatedCost;
  try {
    totalEstimatedCost = usageMetadata ? summarizeFromUsageMetadata(usageMetadata) : undefined;
  } catch {
    totalEstimatedCost = undefined;
  }
  return {
    outputs,
    status,
    artifacts: Array.isArray(record.artifacts)
      ? (record.artifacts as repo.HistoryContent['artifacts'])
      : undefined,
    usageMetadata,
    totalEstimatedCost,
  };
};

const predictAndSaveTitle = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
  inputs: Record<string, unknown>,
  outputs: string,
): Promise<void> => {
  try {
    const title = await predictExAppTitle(inputs, outputs);
    if (title) {
      await repo.updateInvokeHistoryTitle(teamId, exAppId, userId, createdDate, title);
    }
  } catch (e) {
    console.error('Failed to predict title for ExApp history', e);
  }
};

export const exAppsRoutes = new Hono();

// GET /exapps — 利用可能な公開済みアプリ一覧（apiKey は伏せる）
exAppsRoutes.get('/exapps', async (c) => {
  const claims = c.get('claims');
  const apps = await repo.listPublishedExAppsForUser(claims.sub, COMMON_TEAM_ID);
  return c.json(apps.map((app) => ({ ...app, apiKey: '' })));
});

// POST /exapps/invoke
exAppsRoutes.post('/exapps/invoke', async (c) => {
  const claims = c.get('claims');
  const userId = claims.sub;
  const createdDate = `${Date.now()}`;

  const body = (await c.req.json().catch(() => null)) as {
    teamId?: string;
    exAppId?: string;
    inputs?: Record<string, unknown>;
    sessionId?: string;
  } | null;

  const teamId = body?.teamId ?? '';
  const exAppId = body?.exAppId ?? '';
  const inputs = isRecord(body?.inputs) ? body.inputs : undefined;
  if (!teamId || !exAppId || !inputs) {
    return c.json({ outputs: 'パラメータが不正です。' }, 400);
  }

  let sessionId: string | undefined;
  if (body?.sessionId) {
    if (typeof body.sessionId === 'string' && UUID_V4_REGEX.test(body.sessionId)) {
      sessionId = body.sessionId;
    } else {
      return c.json({ outputs: 'sessionIdはUUID v4形式である必要があります。' }, 400);
    }
  }

  if (!isSystemAdmin(claims) && !(await isTeamMember(claims, teamId))) {
    return c.json(
      { outputs: 'チームメンバーではないため実行できません。権限を見直してください。' },
      403,
    );
  }

  const app = await repo.findExAppById(teamId, exAppId);
  const team = await repo.findTeamById(teamId);
  if (!app || !team) {
    return c.json({ outputs: 'リクエストされたAIアプリが見つかりませんでした。' }, 404);
  }

  const stableUserId = generateStableUserId(userId);
  const requestBody: Record<string, unknown> = { inputs };
  if (sessionId) {
    requestBody.sessionId = sessionId;
  }

  let responseBody: unknown;
  let status: 'ACCEPTED' | 'COMPLETED' | 'ERROR' = 'COMPLETED';
  let httpStatus = 200;

  try {
    const response = await fetchExApp(app.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': app.apiKey,
        'x-user-id': stableUserId,
      },
      body: JSON.stringify(requestBody),
    });
    httpStatus = response.status;

    try {
      responseBody = await response.json();
    } catch {
      responseBody = { outputs: await response.text() };
    }

    const statusUrl =
      isRecord(responseBody) && typeof responseBody.status_url === 'string'
        ? responseBody.status_url
        : undefined;

    if (response.status === 202 && statusUrl) {
      // 非同期実行: ポーリングジョブを登録する
      status = 'ACCEPTED';
      const absoluteStatusUrl = allowPrivateEndpoints()
        ? new URL(statusUrl, app.endpoint).toString()
        : resolveRelativeStatusUrl(statusUrl, await assertPublicEndpointUrl(app.endpoint)).url.toString();

      await repo.enqueueExAppJob({
        teamId,
        exAppId,
        userId,
        createdDate,
        stableUserId,
        statusUrl: absoluteStatusUrl,
        endpoint: app.endpoint,
      });
    } else if (response.status >= 400) {
      status = 'ERROR';
    } else if (isRecord(responseBody)) {
      // 同期実行成功: usageMetadata から合計コストを付与（フェイルセーフ）
      try {
        const raw = responseBody.usageMetadata;
        if (Array.isArray(raw)) {
          const total = summarizeFromUsageMetadata(raw as UsageMetadata[]);
          if (total !== undefined) {
            (responseBody as Record<string, unknown>).totalEstimatedCost = total;
          }
        }
      } catch (e) {
        console.warn('Failed to summarize totalEstimatedCost', e);
      }
    }
  } catch (error) {
    status = 'ERROR';
    if (isExAppUrlValidationError(error)) {
      responseBody = {
        outputs: 'AIアプリのAPIエンドポイントまたはステータスURLが安全ではないため実行できません。',
      };
      httpStatus = 502;
    } else {
      console.error('Error in exapps/invoke', error);
      responseBody = { outputs: 'サーバ側でエラーが発生しました。管理者へご連絡ください。' };
      httpStatus = 500;
    }
  }

  await repo.createInvokeHistory(
    teamId,
    exAppId,
    userId,
    createdDate,
    team.teamName,
    app.exAppName,
    inputs,
    toHistoryContent(responseBody, status),
    sessionId,
  );

  if (status === 'COMPLETED') {
    const outputs = isRecord(responseBody) ? responseBody.outputs : undefined;
    void predictAndSaveTitle(
      teamId,
      exAppId,
      userId,
      createdDate,
      inputs,
      typeof outputs === 'string' ? outputs : JSON.stringify(outputs ?? {}),
    );
  }

  return c.json(responseBody as Record<string, unknown>, httpStatus as 200);
});

// GET /exapps/histories?teamId=&exAppId=&exclusiveStartKey=
exAppsRoutes.get('/exapps/histories', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.query('teamId') ?? '';
  const exAppId = c.req.query('exAppId') ?? '';
  if (!teamId || !exAppId) {
    return c.json({ error: 'teamId と exAppId は必須です。' }, 400);
  }
  const result = await repo.listInvokeHistories(
    teamId,
    exAppId,
    claims.sub,
    c.req.query('exclusiveStartKey'),
  );
  return c.json(result);
});

// GET /exapps/history?teamId=&exAppId=&createdDate=
exAppsRoutes.get('/exapps/history', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.query('teamId') ?? '';
  const exAppId = c.req.query('exAppId') ?? '';
  const createdDate = c.req.query('createdDate') ?? '';
  const history = await repo.getInvokeHistory(teamId, exAppId, claims.sub, createdDate);
  if (!history) {
    return c.json({ error: '履歴が見つかりませんでした。' }, 404);
  }
  return c.json({ history });
});

// DELETE /teams/{teamId}/exapps/{exAppId}/history?createdDate=
exAppsRoutes.delete('/teams/:teamId/exapps/:exAppId/history', async (c) => {
  const claims = c.get('claims');
  const createdDate = c.req.query('createdDate') ?? '';
  await repo.deleteInvokeHistory(
    c.req.param('teamId'),
    c.req.param('exAppId'),
    claims.sub,
    createdDate,
  );
  return c.newResponse(null, 204);
});

// ---- 非同期ポーリングワーカー（SQS の代替、in-process） ----

const POLL_INTERVAL_SEC = 5;
const MAX_POLL_ATTEMPTS = 120; // 5秒 × 120 = 最大10分

const pollOnce = async (): Promise<void> => {
  const job = await repo.claimNextExAppJob(POLL_INTERVAL_SEC);
  if (!job) {
    return;
  }

  const app = await repo.findExAppById(job.teamId, job.exAppId);
  if (!app) {
    await repo.completeExAppJob(job.jobId);
    return;
  }

  const finish = async (body: unknown, status: 'COMPLETED' | 'ERROR') => {
    await repo.updateInvokeHistoryContent(
      job.teamId,
      job.exAppId,
      job.userId,
      job.createdDate,
      toHistoryContent(body, status),
    );
    await repo.completeExAppJob(job.jobId);
    if (status === 'COMPLETED') {
      const history = await repo.getInvokeHistory(
        job.teamId,
        job.exAppId,
        job.userId,
        job.createdDate,
      );
      if (history) {
        void predictAndSaveTitle(
          job.teamId,
          job.exAppId,
          job.userId,
          job.createdDate,
          history.inputs,
          history.outputs,
        );
      }
    }
  };

  try {
    const response = await fetchExApp(job.statusUrl, {
      method: 'GET',
      headers: {
        'x-api-key': app.apiKey,
        'x-user-id': job.stableUserId,
      },
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = { outputs: await response.text() };
    }

    const jobStatus =
      isRecord(body) && typeof body.status === 'string' ? body.status.toUpperCase() : undefined;

    if (response.status >= 400 || jobStatus === 'ERROR' || jobStatus === 'FAILED') {
      await finish(body, 'ERROR');
    } else if (jobStatus === 'COMPLETED' || (jobStatus === undefined && isRecord(body) && 'outputs' in body)) {
      await finish(body, 'COMPLETED');
    } else if (job.attempts >= MAX_POLL_ATTEMPTS) {
      await finish({ outputs: 'AIアプリの処理がタイムアウトしました。' }, 'ERROR');
    } else if (isRecord(body) && typeof body.progress === 'string') {
      // 進捗のみ更新（ステータスは IN_PROGRESS）
      const history = await repo.getInvokeHistory(
        job.teamId,
        job.exAppId,
        job.userId,
        job.createdDate,
      );
      if (history) {
        await repo.updateInvokeHistoryContent(job.teamId, job.exAppId, job.userId, job.createdDate, {
          outputs: history.outputs,
          status: 'IN_PROGRESS',
          progress: body.progress,
        });
      }
    }
  } catch (e) {
    console.error('ExApp polling error', e);
    if (job.attempts >= MAX_POLL_ATTEMPTS) {
      await finish({ outputs: 'AIアプリのステータス確認に失敗しました。' }, 'ERROR');
    }
  }
};

let workerTimer: NodeJS.Timeout | undefined;

export const startExAppWorker = (): void => {
  if (workerTimer) {
    return;
  }
  workerTimer = setInterval(() => {
    pollOnce().catch((e) => console.error('ExApp worker error', e));
  }, 1000);
  workerTimer.unref();
};
