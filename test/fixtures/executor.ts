import type { ExecutorResult, ExecutorStatus, MediaExecutor } from '../../src/core/types';

export interface ExecutorCall {
  modelId: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface StatusCall {
  modelId: string;
  generationId: string;
  signal?: AbortSignal;
}

export function fakeExecutor(options: {
  validate?: MediaExecutor['validate'];
  generate?: (call: ExecutorCall, index: number) => Promise<ExecutorResult>;
  start?: (call: ExecutorCall, index: number) => Promise<{ generationId: string }>;
  status?: (call: StatusCall, index: number) => Promise<ExecutorStatus>;
} = {}) {
  const calls: ExecutorCall[] = [];
  const starts: ExecutorCall[] = [];
  const statusCalls: StatusCall[] = [];
  const executor: MediaExecutor = {
    validate: options.validate ?? (() => ({ valid: true })),
    async generate(modelId, params, callOptions) {
      const call: ExecutorCall = { modelId, params, signal: callOptions?.signal };
      calls.push(call);
      const index = calls.length;
      if (options.generate) return options.generate(call, index);
      const count = typeof params.count === 'number' ? params.count : 1;
      return {
        items: Array.from({ length: count }, (_, item) => ({ url: `https://cdn.test/${index}-${item}.png` })),
        generationId: `gen-${index}`,
        credits: 2 * count,
        balance: 100 - index,
      };
    },
    async start(modelId, params, callOptions) {
      const call: ExecutorCall = { modelId, params, signal: callOptions?.signal };
      starts.push(call);
      return options.start ? options.start(call, starts.length) : { generationId: `job-${starts.length}` };
    },
    async status(modelId, generationId, callOptions) {
      const call: StatusCall = { modelId, generationId, signal: callOptions?.signal };
      statusCalls.push(call);
      return options.status ? options.status(call, statusCalls.length) : { state: 'pending' };
    },
  };
  return { calls, starts, statusCalls, executor };
}
