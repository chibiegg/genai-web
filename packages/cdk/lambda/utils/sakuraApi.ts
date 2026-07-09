import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ApiInterface, ExtraData, UnrecordedMessage } from 'genai-web';
import { authorizeOwnedKey } from './fileOwnership';
import { HttpError } from './httpError';
import { getS3Client } from './s3Client';
import { FileRetrievalError, parseS3Uri } from './s3Uri';
import { streamingChunk } from './streamingChunk';

// さくらのAI Engine（OpenAI 互換 Chat Completions API）のプロバイダ実装。
// bedrockApi と同じ ApiInterface を満たし、utils/api.ts のディスパッチテーブルから利用する。

// Converse 版（models.ts）と同じ添付ファイル保持上限。
const MAX_DOCUMENTS_PER_REQUEST = 5;
const MAX_IMAGES_PER_REQUEST = 20;

// テキストとして本文展開できる添付ファイルの mediaType / 拡張子
const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
]);
const TEXT_EXTENSIONS = new Set(['csv', 'html', 'json', 'md', 'txt', 'xml', 'yaml', 'yml']);

const getBaseUrl = (): string => {
  return (
    process.env.SAKURA_AI_BASE_URL ||
    process.env.SAKURA_AI_ENGINE_BASE_URL ||
    'https://api.ai.sakura.ad.jp/v1'
  ).replace(/\/+$/, '');
};

const getApiKey = (): string => {
  const apiKey = process.env.SAKURA_AI_API_KEY || process.env.SAKURA_AI_ENGINE_TOKEN;
  if (!apiKey) {
    throw new Error('SAKURA_AI_API_KEY is not configured');
  }
  return apiKey;
};

// s3 ソースの添付を取得して bytes 化する（models.ts の fetchS3SourceBytes と同じ検証を行う）。
const fetchS3SourceBytes = async (
  extra: ExtraData,
  identityId: string | undefined,
): Promise<Buffer> => {
  const bucketName = process.env.BUCKET_NAME;
  if (!bucketName) {
    throw new FileRetrievalError('BUCKET_NAME is not configured');
  }

  const parsed = parseS3Uri(extra.source.data);
  if (!parsed) {
    throw new FileRetrievalError(`Invalid S3 URI: ${extra.name}`);
  }

  // bucket 名検証（任意 S3 オブジェクトの読み取り防止）
  if (parsed.bucket !== bucketName) {
    throw new FileRetrievalError(`S3 bucket mismatch for ${extra.name}`);
  }

  // 所有者チェック（IDOR 対策・deny by default）
  if (!identityId?.trim()) {
    throw new FileRetrievalError('identityId is required to read an S3 attachment');
  }
  if (!authorizeOwnedKey(parsed.key, identityId.trim())) {
    throw new FileRetrievalError(`Access denied for ${extra.name}`);
  }

  try {
    const response = await getS3Client().send(
      new GetObjectCommand({ Bucket: bucketName, Key: parsed.key }),
    );
    const byteArray = await response.Body?.transformToByteArray();
    if (!byteArray) {
      throw new FileRetrievalError(`Empty S3 object for ${extra.name}`);
    }
    return Buffer.from(byteArray);
  } catch (e) {
    if (e instanceof FileRetrievalError) {
      throw e;
    }
    throw new FileRetrievalError(`Failed to fetch S3 object for ${extra.name}`, { cause: e });
  }
};

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAiContentPart[];
};

const isTextAttachment = (extra: ExtraData): boolean => {
  if (TEXT_MEDIA_TYPES.has(extra.source.mediaType)) {
    return true;
  }
  if (extra.source.mediaType.startsWith('text/')) {
    return true;
  }
  const ext = extra.name.split('.').pop()?.toLowerCase();
  return ext !== undefined && TEXT_EXTENSIONS.has(ext);
};

// 会話履歴の全 extraData のうち、リクエストに含める対象を判定する（models.ts と同じ方針）。
const selectRetainedExtraData = (messages: UnrecordedMessage[]): Set<ExtraData> => {
  const retained = new Set<ExtraData>();
  let documentCount = 0;
  let imageCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const extraData = messages[i].extraData;
    if (!extraData) continue;
    for (let j = extraData.length - 1; j >= 0; j--) {
      const extra = extraData[j];
      if (extra.type === 'file') {
        if (documentCount < MAX_DOCUMENTS_PER_REQUEST) {
          retained.add(extra);
          documentCount++;
        }
      } else if (extra.type === 'image') {
        if (imageCount < MAX_IMAGES_PER_REQUEST) {
          retained.add(extra);
          imageCount++;
        }
      } else {
        retained.add(extra);
      }
    }
  }
  return retained;
};

// UnrecordedMessage[] を OpenAI 互換の messages 配列に変換する。
// - system role はシステムプロンプトに設定
// - 画像は data URL（image_url パート）に変換（VL 非対応モデルでは API 側でエラーになるため注意）
// - テキスト系ファイルは本文をメッセージに展開
// - PDF / Office 文書・動画はテキスト抽出手段がないためスキップし、その旨をモデルに伝える
export const createOpenAiMessages = async (
  messages: UnrecordedMessage[],
  identityId?: string,
): Promise<OpenAiMessage[]> => {
  const system = messages.find((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');

  const retainedExtraData = selectRetainedExtraData(conversation);

  const resolveBytes = async (extra: ExtraData): Promise<Buffer> => {
    if (extra.source.type === 's3') {
      return fetchS3SourceBytes(extra, identityId);
    }
    return Buffer.from(extra.source.data, 'base64');
  };

  const result: OpenAiMessage[] = [];
  if (system) {
    result.push({ role: 'system', content: system.content });
  }

  for (const message of conversation) {
    const textParts: string[] = [message.content];
    const imageParts: OpenAiContentPart[] = [];

    for (const extra of message.extraData ?? []) {
      if (!retainedExtraData.has(extra)) {
        continue;
      }

      if (extra.type === 'image') {
        const bytes = await resolveBytes(extra);
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${extra.source.mediaType};base64,${bytes.toString('base64')}` },
        });
      } else if (extra.type === 'file' && isTextAttachment(extra)) {
        const bytes = await resolveBytes(extra);
        textParts.push(`【添付ファイル: ${extra.name}】\n${bytes.toString('utf-8')}`);
      } else if (extra.type === 'file' || extra.type === 'video') {
        console.warn(`Unsupported attachment type for sakura provider: ${extra.name}`);
        textParts.push(
          `【注記: 添付ファイル「${extra.name}」はこの環境では読み取りに対応していないため、内容を参照できません。】`,
        );
      }
    }

    const role = message.role === 'user' ? 'user' : 'assistant';
    if (imageParts.length > 0) {
      result.push({
        role,
        content: [{ type: 'text', text: textParts.join('\n\n') }, ...imageParts],
      });
    } else {
      result.push({ role, content: textParts.join('\n\n') });
    }
  }

  return result;
};

// thinking モデル（Qwen3 系等）が出力する <think>...</think> ブロックを
// ストリーミング中に除去するフィルタ。タグがチャンク境界で分割されても処理できるよう、
// タグ長分の末尾を持ち越しながら逐次処理する。
export class ThinkTagFilter {
  private buffer = '';
  private inThink = false;

  push(text: string): string {
    this.buffer += text;
    let output = '';

    for (;;) {
      if (this.inThink) {
        const end = this.buffer.indexOf('</think>');
        if (end === -1) {
          // 閉じタグの一部が末尾にかかっている可能性があるため、タグ長-1 だけ残して破棄
          this.buffer = this.buffer.slice(
            Math.max(this.buffer.length - ('</think>'.length - 1), 0),
          );
          return output;
        }
        this.buffer = this.buffer.slice(end + '</think>'.length);
        this.inThink = false;
      } else {
        const start = this.buffer.indexOf('<think>');
        if (start === -1) {
          // 末尾に開始タグの先頭部分がかかっている場合のみ持ち越し、それ以外は全て出力
          const lastLt = this.buffer.lastIndexOf('<');
          if (lastLt !== -1 && '<think>'.startsWith(this.buffer.slice(lastLt))) {
            output += this.buffer.slice(0, lastLt);
            this.buffer = this.buffer.slice(lastLt);
          } else {
            output += this.buffer;
            this.buffer = '';
          }
          return output;
        }
        output += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + '<think>'.length);
        this.inThink = true;
      }
    }
  }

  flush(): string {
    const rest = this.inThink ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }
}

const stripThinking = (text: string): string => {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
};

// OpenAI finish_reason → Bedrock StopReason 互換値へのマッピング
const mapStopReason = (finishReason: string): string => {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filtered';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
};

type ChatCompletionBody = {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  max_tokens?: number;
};

const buildRequestBody = (
  modelId: string,
  messages: OpenAiMessage[],
  stream: boolean,
): ChatCompletionBody => {
  const body: ChatCompletionBody = { model: modelId, messages };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (process.env.SAKURA_TEMPERATURE) {
    body.temperature = Number(process.env.SAKURA_TEMPERATURE);
  }
  if (process.env.SAKURA_MAX_TOKENS) {
    body.max_tokens = Number(process.env.SAKURA_MAX_TOKENS);
  }
  return body;
};

const postChatCompletions = async (body: ChatCompletionBody): Promise<Response> => {
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Sakura AI Engine returned ${response.status}: ${errorBody.slice(0, 500)}`);
  }
  return response;
};

// SSE ストリームを 1 行ずつの data ペイロードとして返す
async function* iterateSseData(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        yield trimmed.slice('data:'.length).trim();
      }
    }
  }
}

const sakuraApi: ApiInterface = {
  invoke: async (model, messages, _id, identityId) => {
    const openAiMessages = await createOpenAiMessages(messages, identityId);
    const response = await postChatCompletions(
      buildRequestBody(model.modelId, openAiMessages, false),
    );
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return stripThinking(data.choices?.[0]?.message?.content ?? '');
  },
  invokeStream: async function* (model, messages, _id, identityId) {
    try {
      const openAiMessages = await createOpenAiMessages(messages, identityId);
      const response = await postChatCompletions(
        buildRequestBody(model.modelId, openAiMessages, true),
      );

      const thinkFilter = new ThinkTagFilter();

      for await (const data of iterateSseData(response)) {
        if (data === '[DONE]') {
          break;
        }

        let parsed: {
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          } | null;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          console.warn('Failed to parse SSE chunk from Sakura AI Engine');
          continue;
        }

        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          const outputText = thinkFilter.push(delta);
          if (outputText) {
            yield streamingChunk({ text: outputText });
          }
        }

        if (choice?.finish_reason) {
          const rest = thinkFilter.flush();
          if (rest) {
            yield streamingChunk({ text: rest });
          }
          yield streamingChunk({
            text: '',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            stopReason: mapStopReason(choice.finish_reason) as any,
          });
          // usage は finish 後の最終チャンクで届くため break しない。
        }

        if (parsed.usage) {
          const inputTokens = parsed.usage.prompt_tokens ?? 0;
          const outputTokens = parsed.usage.completion_tokens ?? 0;
          yield streamingChunk({
            text: '',
            metadata: {
              usage: {
                model: model.modelId,
                provider: 'sakura',
                inputTokens,
                outputTokens,
                totalTokens: parsed.usage.total_tokens ?? inputTokens + outputTokens,
              },
            },
          });
        }
      }
    } catch (e) {
      if (e instanceof FileRetrievalError) {
        console.error(e);
        yield streamingChunk({
          text: '添付ファイルの読み込みに失敗しました。ファイルを再度添付してお試しください。',
          stopReason: 'error',
        });
      } else {
        console.error(e);
        yield streamingChunk({
          text: 'エラーが発生しました。管理者に以下のエラーを報告してください。\n' + e,
          stopReason: 'error',
        });
      }
    }
  },
  generateImage: async () => {
    throw new HttpError(400, '画像生成はさくらのAI Engineでは利用できません。');
  },
};

export default sakuraApi;
