import { InvokeWithResponseStreamCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { fetchAuthSession } from 'aws-amplify/auth';
import { authProvider, getAuthToken } from '@/lib/auth';
import {
  CreateChatResponse,
  CreateMessagesRequest,
  CreateMessagesResponse,
  PredictRequest,
  PredictResponse,
  PredictTitleRequest,
  PredictTitleResponse,
  UpdateTitleRequest,
  UpdateTitleResponse,
} from 'genai-web';
import { genUApi } from '@/lib/fetcher';
import { decomposeId } from '@/utils/decomposeId';

export const createChat = async () => {
  const res = await genUApi.post<CreateChatResponse>('chats', {});
  return res.data;
};

export const createMessages = async (_chatId: string, req: CreateMessagesRequest) => {
  const chatId = decomposeId(_chatId);
  const res = await genUApi.post<CreateMessagesResponse>(`chats/${chatId}/messages`, req);
  return res.data;
};

export const deleteChat = async (chatId: string) => {
  return genUApi.delete<void>(`chats/${chatId}`);
};

export const updateTitle = async (chatId: string, title: string) => {
  const req: UpdateTitleRequest = {
    title,
  };
  const res = await genUApi.put<UpdateTitleResponse>(`chats/${chatId}/title`, req);
  return res.data;
};

export const predict = async (req: PredictRequest): Promise<string> => {
  const res = await genUApi.post<PredictResponse>('predict', req);
  return res.data;
};

// OIDC 構成では API サーバの /predict/stream（JSONL の HTTP ストリーミング）を利用する。
// Lambda Response Streaming の直接呼び出し（Cognito 構成）の代替。
async function* predictStreamHttp(req: PredictRequest) {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('認証されていません。');
  }

  const base = (import.meta.env.VITE_APP_API_ENDPOINT as string).replace(/\/+$/, '');
  const res = await fetch(`${base}/predict/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(req),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ストリーミングリクエストに失敗しました (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    yield decoder.decode(value, { stream: true });
  }
}

export async function* predictStream(req: PredictRequest) {
  if (authProvider === 'oidc') {
    yield* predictStreamHttp(req);
    return;
  }

  const token = (await fetchAuthSession()).tokens?.idToken?.toString();
  if (!token) {
    throw new Error('認証されていません。');
  }

  const region = import.meta.env.VITE_APP_REGION;
  const userPoolId = import.meta.env.VITE_APP_USER_POOL_ID;
  const idPoolId = import.meta.env.VITE_APP_IDENTITY_POOL_ID;
  const providerName = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const lambda = new LambdaClient({
    region,
    credentials: fromCognitoIdentityPool({
      clientConfig: { region },
      identityPoolId: idPoolId,
      logins: {
        [providerName]: token,
      },
    }),
  });

  const res = await lambda.send(
    new InvokeWithResponseStreamCommand({
      FunctionName: import.meta.env.VITE_APP_PREDICT_STREAM_FUNCTION_ARN,
      Payload: JSON.stringify(req),
    }),
  );
  const events = res.EventStream!;

  for await (const event of events) {
    if (event.PayloadChunk) {
      yield new TextDecoder('utf-8').decode(event.PayloadChunk.Payload);
    }

    if (event.InvokeComplete) {
      break;
    }
  }
}

export const predictTitle = async (req: PredictTitleRequest) => {
  const res = await genUApi.post<PredictTitleResponse>('predict/title', req);
  return res.data;
};
