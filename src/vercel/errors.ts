import { AISDKError, APICallError, InvalidArgumentError, NoSuchModelError, type JSONObject } from '@ai-sdk/provider';
import { ApiError } from '@picsart/ai-sdk';
import { PicsartCatalogError, PicsartInputError, PicsartModelError, PicsartStartedJobError, PicsartValidationError } from '../core/errors';

export interface ErrorContext {
  modelId: string;
  modelType: 'imageModel' | 'videoModel';
  url: string;
  signal?: AbortSignal;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function asNonRetryable(error: APICallError): APICallError {
  return new APICallError({
    message: error.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: error.statusCode,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody,
    cause: error,
    data: error.data,
    isRetryable: false,
  });
}

function isJSONObject(value: unknown): value is JSONObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withGenerationId(error: unknown, generationId: string): unknown {
  if (!APICallError.isInstance(error)) return error;
  const data = isJSONObject(error.data) ? error.data : {};
  const picsart = isJSONObject(data.picsart) ? data.picsart : {};
  return new APICallError({
    message: error.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: error.statusCode,
    responseHeaders: error.responseHeaders,
    responseBody: error.responseBody,
    isRetryable: error.isRetryable,
    data: { ...data, picsart: { ...picsart, generationId } },
    cause: error.cause,
  });
}

export function toProviderError(error: unknown, context: ErrorContext): unknown {
  if (error instanceof PicsartStartedJobError) return withGenerationId(toProviderError(error.cause, context), error.generationId);
  if (APICallError.isInstance(error) && error.isRetryable) return asNonRetryable(error);
  if (isAbortError(error) || AISDKError.isInstance(error)) return error;
  if (error instanceof PicsartModelError) {
    return new NoSuchModelError({ modelId: context.modelId, modelType: context.modelType, message: error.message });
  }
  if (error instanceof PicsartInputError) return new InvalidArgumentError({ argument: error.argument, message: error.message });
  if (error instanceof PicsartValidationError) return new InvalidArgumentError({ argument: 'providerOptions.picsart', message: error.message });
  if (error instanceof PicsartCatalogError) {
    return new APICallError({ message: error.message, url: error.url, requestBodyValues: { modelId: context.modelId }, statusCode: error.status, isRetryable: false, cause: error });
  }
  if (error instanceof ApiError) {
    return new APICallError({
      message: error.message,
      url: context.url,
      requestBodyValues: { modelId: context.modelId },
      statusCode: error.status,
      isRetryable: false,
      data: { code: error.code },
      cause: error,
    });
  }
  return new APICallError({
    message: error instanceof Error ? error.message : String(error),
    url: context.url,
    requestBodyValues: { modelId: context.modelId },
    isRetryable: false,
    cause: error,
  });
}

function readStatus(error: unknown): number | undefined {
  return error instanceof ApiError || error instanceof PicsartCatalogError ? error.status : undefined;
}

function isTransientRead(error: unknown): boolean {
  const status = readStatus(error);
  if (status === undefined) return error instanceof TypeError;
  // @picsart/ai-sdk reports a non-JSON 2xx read as 200 and an unrecognized task state as 408
  return (status >= 200 && status < 300) || status === 408 || status === 429 || status >= 500;
}

export function toStatusError(error: unknown, context: ErrorContext, generationId: string): unknown {
  if (APICallError.isInstance(error)) return withGenerationId(error, generationId);
  if (isAbortError(error) || AISDKError.isInstance(error)) return error;
  if (error instanceof PicsartInputError) return new InvalidArgumentError({ argument: error.argument, message: error.message });
  if (error instanceof PicsartModelError) {
    return new NoSuchModelError({ modelId: context.modelId, modelType: context.modelType, message: error.message });
  }
  return new APICallError({
    message: error instanceof Error ? error.message : String(error),
    url: error instanceof PicsartCatalogError ? error.url : context.url,
    requestBodyValues: { modelId: context.modelId },
    statusCode: readStatus(error),
    isRetryable: isTransientRead(error),
    data: { ...(error instanceof ApiError ? { code: error.code } : {}), picsart: { generationId } },
    cause: error,
  });
}

export async function withProviderErrors<T>(context: ErrorContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // @picsart/ai-sdk reports an abort as ApiError 499; the caller expects its own abort reason.
    if (context.signal?.aborted) throw context.signal.reason ?? error;
    throw toProviderError(error, context);
  }
}

export function withGeneratedResults(error: unknown, picsart: JSONObject): unknown {
  if (!APICallError.isInstance(error)) return error;
  return new APICallError({
    message: error.message,
    url: error.url,
    requestBodyValues: error.requestBodyValues,
    statusCode: error.statusCode,
    isRetryable: false,
    data: { picsart },
    cause: error.cause,
  });
}
