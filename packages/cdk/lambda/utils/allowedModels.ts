import { Model } from 'genai-web';
import { HttpError } from './httpError';
import {
  defaultImageGenerationModel,
  defaultModel,
  imageGenerationModelIds,
  modelIds,
  modelProvider,
} from './models';

type RequestedModel = {
  type?: unknown;
  modelId?: unknown;
  sessionId?: unknown;
};

export const modelNotAllowedMessage = 'このモデルは使用できません。';

const allowedTextModelIds = new Set(modelIds);
const allowedImageModelIds = new Set(imageGenerationModelIds);

const isKnownModelType = (value: unknown): value is Model['type'] => {
  return value === 'bedrock' || value === 'sagemaker' || value === 'sakura';
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0;
};

const throwModelNotAllowed = (): never => {
  throw new HttpError(400, modelNotAllowedMessage);
};

const resolveRequestedModel = (requested: RequestedModel | undefined, fallback: Model): Model => {
  const model = requested ?? fallback;

  if (!isKnownModelType(model.type) || !isNonEmptyString(model.modelId)) {
    return throwModelNotAllowed();
  }

  return {
    type: model.type,
    modelId: model.modelId,
    sessionId: isNonEmptyString(model.sessionId) ? model.sessionId : undefined,
  };
};

export const resolveAllowedTextModel = (requested?: RequestedModel): Model => {
  const model = resolveRequestedModel(requested, defaultModel);

  // MODEL_PROVIDER=sakura の環境では、フロントエンドが type を旧値（bedrock）のまま
  // 送信してきてもさくらのAI Engine に振り向ける（モデル ID の許可判定は共通）。
  if (modelProvider === 'sakura' && model.type === 'bedrock') {
    model.type = 'sakura';
  }

  switch (model.type) {
    case 'bedrock':
    case 'sakura':
      if (!allowedTextModelIds.has(model.modelId)) {
        return throwModelNotAllowed();
      }
      return model;
    case 'sagemaker':
      return model;
    default:
      return throwModelNotAllowed();
  }
};

export const resolveAllowedImageModel = (requested?: RequestedModel): Model => {
  const model = resolveRequestedModel(requested, defaultImageGenerationModel);

  if (model.type !== 'bedrock' || !allowedImageModelIds.has(model.modelId)) {
    return throwModelNotAllowed();
  }

  return model;
};

export const isModelNotAllowedError = (error: unknown): error is HttpError => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return (
    'statusCode' in error &&
    error.statusCode === 400 &&
    'message' in error &&
    error.message === modelNotAllowedMessage
  );
};
