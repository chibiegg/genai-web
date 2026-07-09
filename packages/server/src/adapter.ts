// Lambda ハンドラ（APIGatewayProxyEvent → APIGatewayProxyResult）を
// Hono のルートハンドラとして呼び出すアダプタ。
// 既存の packages/cdk/lambda/*.ts を無改修で常駐 API サーバに載せる。

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { Context, Handler } from 'hono';
import type { AuthClaims } from './auth';

export type LambdaHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

export const buildEvent = async (
  c: Context,
  claims: AuthClaims,
  idToken: string,
): Promise<APIGatewayProxyEvent> => {
  const url = new URL(c.req.url);

  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryStringParameters[key] = value;
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.header())) {
    headers[key] = value;
  }
  // ハンドラ（resolveRequestIdentityId 等）が参照する Authorization ヘッダを保証する
  headers['Authorization'] = `Bearer ${idToken}`;

  const rawBody = await c.req.text();

  return {
    body: rawBody || null,
    headers,
    multiValueHeaders: {},
    httpMethod: c.req.method,
    isBase64Encoded: false,
    path: url.pathname,
    pathParameters: c.req.param() as Record<string, string>,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: url.pathname,
    requestContext: {
      accountId: '',
      apiId: 'local',
      authorizer: { claims },
      protocol: 'HTTP/1.1',
      httpMethod: c.req.method,
      identity: {} as APIGatewayProxyEvent['requestContext']['identity'],
      path: url.pathname,
      stage: 'local',
      requestId: crypto.randomUUID(),
      requestTimeEpoch: Date.now(),
      resourceId: '',
      resourcePath: url.pathname,
    },
  };
};

// Lambda ハンドラを Hono ハンドラに変換する
export const adapt = (handler: LambdaHandler): Handler => {
  return async (c) => {
    const claims = c.get('claims');
    const idToken = c.get('idToken');
    const event = await buildEvent(c, claims, idToken);

    const result = await handler(event);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      headers[key] = String(value);
    }

    // 204/205/304 はボディを持てない（Response コンストラクタの制約）
    const body = [204, 205, 304].includes(result.statusCode) ? null : (result.body ?? '');
    return c.newResponse(body, result.statusCode as 200, headers);
  };
};
