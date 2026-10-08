export type WorkflowState = 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface ReadOutcome {
  http?: number;
  network?: true;
  envelope?: { status: WorkflowState; hasResult: boolean; message?: string };
}

export interface ReadOutcomeLog {
  last(generationId: string): ReadOutcome | undefined;
  forget(generationId: string): void;
}

type PicsartFetch = (url: string, init?: RequestInit) => Promise<Response>;

const WORKFLOW_STATES = new Set<string>(['ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED']);
const RESULT_READ = /\/([^/]+)\/result$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readId(url: string): string | undefined {
  try {
    const segment = RESULT_READ.exec(new URL(url).pathname)?.[1];
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function envelopeOf(response: Response): Promise<ReadOutcome['envelope']> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const task = asRecord(asRecord(body)?.response);
  const status = task?.status;
  if (typeof status !== 'string' || !WORKFLOW_STATES.has(status)) return undefined;
  const result = asRecord(task?.result);
  const message = [result?.message, result?.error, result?.reason].find((value): value is string => typeof value === 'string' && value !== '');
  return { status: status as WorkflowState, hasResult: Boolean(task?.result), ...(message ? { message } : {}) };
}

export function recordStatusReads(fetch: PicsartFetch): { fetch: PicsartFetch; log: ReadOutcomeLog } {
  const outcomes = new Map<string, ReadOutcome>();
  return {
    async fetch(url, init) {
      const generationId = readId(url);
      if (generationId === undefined) return fetch(url, init);
      outcomes.delete(generationId);
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        outcomes.set(generationId, { network: true });
        throw error;
      }
      const envelope = response.ok ? await envelopeOf(response) : undefined;
      outcomes.set(generationId, { http: response.status, ...(envelope ? { envelope } : {}) });
      return response;
    },
    log: {
      last: (generationId) => outcomes.get(generationId),
      forget: (generationId) => {
        outcomes.delete(generationId);
      },
    },
  };
}
