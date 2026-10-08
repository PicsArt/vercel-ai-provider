import { ApiError, ApiRunMode, Model, type AiClient, type ApiRunOptions, type GenerateResult } from '@picsart/ai-sdk';
import { PicsartJobFailedError, PicsartModelError, PicsartStartedJobError } from './errors';
import type { ReadOutcome, ReadOutcomeLog } from './status-reads';
import type { ExecutorResult, ExecutorStatus, MediaExecutor, MediaKind } from './types';

export const SERVER_MODELS_API = 'v1/models';

// MODE_POLL_DEFAULTS of @picsart/ai-sdk 6.29.0, which it does not export
const SERVER_POLL: Record<MediaKind, Pick<ApiRunOptions, 'pollingInterval' | 'retriesCount'>> = {
  image: { pollingInterval: 1000, retriesCount: 1200 },
  video: { pollingInterval: 2000, retriesCount: 1800 },
};

export const sdkValidate: MediaExecutor['validate'] = (modelId, params) => {
  let descriptor: ReturnType<typeof Model>;
  try {
    descriptor = Model(modelId);
  } catch {
    throw new PicsartModelError(modelId, `The installed @picsart/ai-sdk doesn't know "${modelId}". Update @picsart/ai-sdk, or set execution: 'server' to let Picsart's servers run it.`);
  }
  return descriptor.validate(params);
};

export const serverValidate: MediaExecutor['validate'] = () => undefined;

function fromGenerateResult(result: GenerateResult): ExecutorResult {
  return {
    items: result.items.map((item) => ({
      url: item.url,
      ...(item.metadata ? { metadata: { ...item.metadata } as Record<string, unknown> } : {}),
    })),
    ...(result.generationId ? { generationId: result.generationId } : {}),
    ...(result.usage ? { credits: result.usage.credits } : {}),
    ...(result.usage?.balance !== undefined ? { balance: result.usage.balance } : {}),
  };
}

function isStillRunning(error: unknown): boolean {
  return error instanceof ApiError && error.status === 408 && error.code === 'timeout';
}

function throwIfJobFailed(outcome: ReadOutcome | undefined, modelId: string, generationId: string): void {
  const envelope = outcome?.envelope;
  if (envelope?.status === 'FAILED') {
    throw new PicsartJobFailedError(modelId, generationId, envelope.message ?? 'Picsart reported the job as failed.');
  }
}

function classifyRead(error: unknown, outcome: ReadOutcome | undefined, modelId: string, generationId: string): ExecutorStatus {
  throwIfJobFailed(outcome, modelId, generationId);
  const envelope = outcome?.envelope;
  if (envelope?.status === 'COMPLETED') {
    const message = envelope.hasResult ? (error instanceof Error ? error.message : String(error)) : envelope.message ?? 'Picsart finished the job without a result.';
    throw new PicsartJobFailedError(modelId, generationId, message);
  }
  if (isStillRunning(error) && (envelope?.status === 'ACCEPTED' || envelope?.status === 'IN_PROGRESS')) return { state: 'pending' };
  throw error;
}

export function sdkExecutor(client: Pick<AiClient, 'generate' | 'submit' | 'result'>, { readOutcome }: { readOutcome?: ReadOutcomeLog } = {}): MediaExecutor {
  return {
    validate: sdkValidate,
    async generate(modelId, params, options) {
      return fromGenerateResult(await client.generate(modelId as never, params as never, { signal: options.signal }));
    },
    async start(modelId, params, options) {
      return { generationId: await client.submit(modelId as never, params as never, { signal: options?.signal }) };
    },
    async status(modelId, generationId, options) {
      try {
        const result = await client.result(modelId as never, generationId, { maxAttempts: 1, intervalMs: 1, signal: options?.signal });
        throwIfJobFailed(readOutcome?.last(generationId), modelId, generationId);
        return { state: 'completed', result: fromGenerateResult(result) };
      } catch (error) {
        if (error instanceof PicsartJobFailedError) throw error;
        if (readOutcome) return classifyRead(error, readOutcome.last(generationId), modelId, generationId);
        if (isStillRunning(error)) return { state: 'pending' };
        throw error;
      } finally {
        readOutcome?.forget(generationId);
      }
    },
  };
}

export interface ServerRunner {
  run(api: string, payload: Record<string, unknown>, options?: ApiRunOptions): Promise<{ result: unknown; usage?: { credits: number }; id?: string }>;
}

interface ServerModelsResult {
  url?: string;
  items?: Array<{ url: string; metadata?: Record<string, unknown> }>;
}

export function serverExecutor(runner: ServerRunner): MediaExecutor {
  return {
    validate: serverValidate,
    async generate(modelId, params, options) {
      let acceptedId: string | undefined;
      const response = await runner.run(SERVER_MODELS_API, { model: modelId, params }, {
        mode: ApiRunMode.ASYNC,
        abortSignal: options.signal,
        ...SERVER_POLL[options.kind],
        onAccepted: (id) => {
          acceptedId = id;
        },
      }).catch((error: unknown) => {
        throw acceptedId ? new PicsartStartedJobError(modelId, acceptedId, error) : error;
      });
      const result = (response.result ?? {}) as ServerModelsResult;
      const items = result.items && result.items.length > 0 ? result.items : result.url ? [{ url: result.url }] : [];
      const mapped: ExecutorResult = {
        items: items.map((item) => ({ url: item.url, ...(item.metadata ? { metadata: item.metadata } : {}) })),
      };
      const generationId = response.id || acceptedId;
      if (generationId) mapped.generationId = generationId;
      if (response.usage) mapped.credits = response.usage.credits;
      return mapped;
    },
  };
}
