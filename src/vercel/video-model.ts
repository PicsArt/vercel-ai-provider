import {
  APICallError,
  InvalidArgumentError,
  type Experimental_VideoModelV4,
  type Experimental_VideoModelV4CallOptions,
  type Experimental_VideoModelV4OperationStartResult,
  type Experimental_VideoModelV4OperationStatusResult,
  type Experimental_VideoModelV4Result,
  type JSONObject,
  type JSONValue,
} from '@ai-sdk/provider';
import { PicsartJobFailedError } from '../core/errors';
import { isPlaygroundLink } from '../core/playground';
import { isGenerationId, mediaStatus, runMedia, startMedia, type RunDependencies } from '../core/run';
import type { MediaCallResult, MediaOperation, MediaRequest } from '../core/types';
import { toStatusError, withProviderErrors, type ErrorContext } from './errors';
import { picsartOptions, toFileRef } from './files';
import { itemMetadata, toSharedWarnings, usageMetadata, type PicsartVideoMetadata } from './metadata';
import { createPicsart } from './provider';
import type { PicsartRuntime, PicsartSerializedConfig } from './runtime';
import { serializeModel, WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from './serialization';

type StartOptions = Parameters<NonNullable<Experimental_VideoModelV4['doStart']>>[0];
type StatusOptions = Parameters<NonNullable<Experimental_VideoModelV4['doStatus']>>[0];

// ai keeps only the last call's top-level credits when it merges calls, so each video carries its own
function videoMetadata(result: MediaCallResult): PicsartVideoMetadata {
  const credits = result.credits !== undefined ? { credits: result.credits } : {};
  return { videos: result.items.map((item) => ({ ...itemMetadata(item), ...credits })), ...usageMetadata(result) };
}

function isObject(value: JSONValue): value is JSONObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CallHeaders = Record<string, string | undefined> | undefined;

function picsartHeaders(headers: CallHeaders): CallHeaders {
  return headers && Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'idempotency-key'));
}

export class PicsartVideoModel implements Experimental_VideoModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'picsart.video';
  readonly maxVideosPerCall = 1;
  readonly doStart?: (options: StartOptions) => Promise<Experimental_VideoModelV4OperationStartResult>;
  readonly doStatus?: (options: StatusOptions) => Promise<Experimental_VideoModelV4OperationStatusResult>;

  static [WORKFLOW_SERIALIZE](model: PicsartVideoModel) {
    return serializeModel(model.modelId, model.runtime);
  }

  static [WORKFLOW_DESERIALIZE](options: { modelId: string; config: PicsartSerializedConfig }) {
    return createPicsart(options.config).video(options.modelId);
  }

  constructor(readonly modelId: string, private readonly runtime: PicsartRuntime) {
    if (runtime.asyncOperations) {
      this.doStart = (options) => this.start(options);
      this.doStatus = (options) => this.status(options);
    }
  }

  async doGenerate(options: Experimental_VideoModelV4CallOptions): Promise<Experimental_VideoModelV4Result> {
    return withProviderErrors(this.context(options.abortSignal), async () => {
      const result = await runMedia(this.dependencies(options.headers), this.request(options), { signal: options.abortSignal });
      return {
        videos: this.videos(result),
        warnings: toSharedWarnings(result.warnings),
        providerMetadata: { picsart: videoMetadata(result) },
        response: this.response(),
      };
    });
  }

  private async start(options: StartOptions): Promise<Experimental_VideoModelV4OperationStartResult> {
    return withProviderErrors(this.context(options.abortSignal), async () => {
      const { operation, warnings } = await startMedia(this.dependencies(options.headers), this.request(options), { signal: options.abortSignal });
      if (!isGenerationId(operation.generationId)) {
        throw new APICallError({
          message: 'Picsart started the job but returned a generation id this provider cannot check. The id is in data.picsart.generationId.',
          url: this.runtime.baseURL,
          requestBodyValues: { modelId: this.modelId },
          isRetryable: false,
          data: { picsart: { generationId: operation.generationId } },
        });
      }
      if (options.webhookUrl) warnings.push({ type: 'unsupported', feature: 'webhookUrl', details: 'Picsart sends no webhook. Check the job with experimental_getVideoStatus.' });
      return {
        operation,
        warnings: toSharedWarnings(warnings),
        providerMetadata: { picsart: { generationId: operation.generationId, ...(operation.playgroundUrl ? { playgroundUrl: operation.playgroundUrl } : {}) } },
        response: this.response(),
      };
    });
  }

  private async status(options: StatusOptions): Promise<Experimental_VideoModelV4OperationStatusResult> {
    const operation = this.operation(options.operation);
    try {
      const status = await mediaStatus(this.dependencies(options.headers), operation, { signal: options.abortSignal });
      if (status.state === 'pending') return { status: 'pending', response: this.response() };
      const { result } = status;
      return {
        status: 'completed',
        videos: this.videos(result),
        warnings: [],
        providerMetadata: { picsart: videoMetadata(result) },
        response: this.response(),
      };
    } catch (error) {
      if (options.abortSignal?.aborted) throw options.abortSignal.reason ?? error;
      if (error instanceof PicsartJobFailedError) return { status: 'error', error: error.message, response: this.response() };
      throw toStatusError(error, this.context(options.abortSignal), operation.generationId);
    }
  }

  private operation(value: JSONValue): MediaOperation {
    if (!isObject(value) || value.modelId !== this.modelId || !isGenerationId(value.generationId)) {
      throw new InvalidArgumentError({
        argument: 'operation',
        message: `Pass the operation that experimental_startVideo returned for Picsart model "${this.modelId}".`,
      });
    }
    const { playgroundUrl } = value;
    return {
      modelId: this.modelId,
      generationId: value.generationId,
      ...(typeof playgroundUrl === 'string' && isPlaygroundLink(playgroundUrl, this.runtime.playgroundUrl) ? { playgroundUrl } : {}),
    };
  }

  private request(options: Experimental_VideoModelV4CallOptions): MediaRequest {
    const lastFrame = options.frameImages?.find((frame) => frame.frameType === 'last_frame');
    return {
      kind: 'video',
      modelId: this.modelId,
      prompt: options.prompt,
      n: options.n,
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      duration: options.duration,
      fps: options.fps,
      seed: options.seed,
      generateAudio: options.generateAudio,
      firstFrame: options.image ? toFileRef(options.image, 'image') : undefined,
      lastFrame: lastFrame ? toFileRef(lastFrame.image, 'frameImages') : undefined,
      references: options.inputReferences?.map((reference) => toFileRef(reference, 'inputReferences')),
      extra: picsartOptions(options.providerOptions),
    };
  }

  private videos(result: MediaCallResult): Experimental_VideoModelV4Result['videos'] {
    // octet-stream makes ai fall back to the downloaded file's media type
    return result.items.map((item) => ({ type: 'url' as const, url: item.url, mediaType: 'application/octet-stream' }));
  }

  private dependencies(headers: CallHeaders): RunDependencies {
    return { catalog: this.runtime.catalog, executor: this.runtime.executor(picsartHeaders(headers)), playgroundUrl: this.runtime.playgroundUrl, limits: this.runtime.limits };
  }

  private context(signal: AbortSignal | undefined): ErrorContext {
    return { modelId: this.modelId, modelType: 'videoModel', url: this.runtime.baseURL, signal };
  }

  private response() {
    return { timestamp: new Date(), modelId: this.modelId, headers: undefined };
  }
}
