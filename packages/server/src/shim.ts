// Lambda 専用グローバル（awslambda.streamifyResponse）のシム。
// predictStream.ts はモジュールトップレベルで streamifyResponse を呼ぶため、
// import より前にこのモジュールを読み込んでグローバルを定義しておく。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).awslambda = {
  streamifyResponse: (f: unknown) => f,
};

export {};
