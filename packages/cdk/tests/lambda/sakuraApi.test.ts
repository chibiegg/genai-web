import { UnrecordedMessage } from 'genai-web';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import sakuraApi, {
  ThinkTagFilter,
  createOpenAiMessages,
} from '../../lambda/utils/sakuraApi';

const encoder = new TextEncoder();

const sseResponse = (events: string[]): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
};

describe('ThinkTagFilter', () => {
  test('think ブロックを除去する', () => {
    const filter = new ThinkTagFilter();
    const output = filter.push('<think>考え中...</think>こんにちは') + filter.flush();
    expect(output).toBe('こんにちは');
  });

  test('チャンク境界で分割されたタグを処理できる', () => {
    const filter = new ThinkTagFilter();
    let output = '';
    for (const chunk of ['<thi', 'nk>思考', 'テキスト</th', 'ink>回答', 'です']) {
      output += filter.push(chunk);
    }
    output += filter.flush();
    expect(output).toBe('回答です');
  });

  test('think ブロックがない場合はそのまま出力する', () => {
    const filter = new ThinkTagFilter();
    let output = '';
    for (const chunk of ['こんにちは', '、世界 < 1 です']) {
      output += filter.push(chunk);
    }
    output += filter.flush();
    expect(output).toBe('こんにちは、世界 < 1 です');
  });
});

describe('createOpenAiMessages', () => {
  test('system ロールを system メッセージに変換する', async () => {
    const messages: UnrecordedMessage[] = [
      { role: 'system', content: 'あなたはアシスタントです' },
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんにちは！' },
      { role: 'user', content: '質問です' },
    ];
    const result = await createOpenAiMessages(messages);
    expect(result).toEqual([
      { role: 'system', content: 'あなたはアシスタントです' },
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんにちは！' },
      { role: 'user', content: '質問です' },
    ]);
  });

  test('base64 画像を data URL の image_url パートに変換する', async () => {
    const imageData = Buffer.from('fake-image').toString('base64');
    const messages: UnrecordedMessage[] = [
      {
        role: 'user',
        content: 'この画像は？',
        extraData: [
          {
            type: 'image',
            name: 'photo.png',
            source: { type: 'base64', mediaType: 'image/png', data: imageData },
          },
        ],
      },
    ];
    const result = await createOpenAiMessages(messages);
    expect(result).toHaveLength(1);
    const content = result[0].content as { type: string; image_url?: { url: string } }[];
    expect(content[0]).toEqual({ type: 'text', text: 'この画像は？' });
    expect(content[1].type).toBe('image_url');
    expect(content[1].image_url?.url).toBe(`data:image/png;base64,${imageData}`);
  });

  test('テキストファイルは本文に展開する', async () => {
    const fileData = Buffer.from('カラム1,カラム2\n値1,値2').toString('base64');
    const messages: UnrecordedMessage[] = [
      {
        role: 'user',
        content: '集計して',
        extraData: [
          {
            type: 'file',
            name: 'data.csv',
            source: { type: 'base64', mediaType: 'text/csv', data: fileData },
          },
        ],
      },
    ];
    const result = await createOpenAiMessages(messages);
    expect(result[0].content).toContain('【添付ファイル: data.csv】');
    expect(result[0].content).toContain('カラム1,カラム2');
  });

  test('非対応形式のファイルは注記に置き換える', async () => {
    const messages: UnrecordedMessage[] = [
      {
        role: 'user',
        content: '読んで',
        extraData: [
          {
            type: 'file',
            name: 'doc.pdf',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'AAAA' },
          },
        ],
      },
    ];
    const result = await createOpenAiMessages(messages);
    expect(result[0].content).toContain('doc.pdf');
    expect(result[0].content).toContain('対応していない');
  });
});

describe('sakuraApi.invokeStream', () => {
  beforeEach(() => {
    process.env.SAKURA_AI_BASE_URL = 'https://api.example.test/v1';
    process.env.SAKURA_AI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SAKURA_AI_BASE_URL;
    delete process.env.SAKURA_AI_API_KEY;
  });

  test('SSE をパースして JSONL チャンクを生成する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'こんに' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'ちは' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        '[DONE]',
      ]),
    );

    const chunks: { text: string; stopReason?: string; metadata?: unknown }[] = [];
    for await (const line of sakuraApi.invokeStream(
      { type: 'sakura', modelId: 'preview/Kimi-K2.6' },
      [{ role: 'user', content: 'こんにちは' }],
      'chat',
    )) {
      chunks.push(JSON.parse(line));
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );

    const text = chunks.map((c) => c.text).join('');
    expect(text).toBe('こんにちは');

    const stopChunk = chunks.find((c) => c.stopReason);
    expect(stopChunk?.stopReason).toBe('end_turn');

    const usageChunk = chunks.find((c) => c.metadata) as {
      metadata: { usage: { provider: string; inputTokens: number; outputTokens: number } };
    };
    expect(usageChunk.metadata.usage.provider).toBe('sakura');
    expect(usageChunk.metadata.usage.inputTokens).toBe(10);
    expect(usageChunk.metadata.usage.outputTokens).toBe(5);
  });

  test('API エラー時は error stopReason のチャンクを返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('upstream error', { status: 500 }),
    );

    const chunks: { text: string; stopReason?: string }[] = [];
    for await (const line of sakuraApi.invokeStream(
      { type: 'sakura', modelId: 'preview/Kimi-K2.6' },
      [{ role: 'user', content: 'test' }],
      'chat',
    )) {
      chunks.push(JSON.parse(line));
    }

    expect(chunks[chunks.length - 1].stopReason).toBe('error');
  });
});

describe('sakuraApi.invoke', () => {
  beforeEach(() => {
    process.env.SAKURA_AI_BASE_URL = 'https://api.example.test/v1';
    process.env.SAKURA_AI_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SAKURA_AI_BASE_URL;
    delete process.env.SAKURA_AI_API_KEY;
  });

  test('非ストリーミング応答から thinking を除去して返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '<think>思考</think>回答テキスト' } }],
        }),
        { status: 200 },
      ),
    );

    const result = await sakuraApi.invoke(
      { type: 'sakura', modelId: 'preview/Qwen3.6-35B-A3B' },
      [{ role: 'user', content: 'テスト' }],
      'chat',
    );
    expect(result).toBe('回答テキスト');
  });
});
