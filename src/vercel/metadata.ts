import type { JSONObject, SharedV4Warning } from '@ai-sdk/provider';
import type { MediaCallResult, MediaItem, MediaWarning } from '../core/types';

export type PicsartItemMetadata = {
  url: string;
  generationId?: string;
  playgroundUrl?: string;
  metadata?: JSONObject;
};

export type PicsartUsageMetadata = {
  credits?: number;
  balance?: number;
};

export type PicsartImageMetadata = PicsartUsageMetadata & {
  images: PicsartItemMetadata[];
};

export type PicsartVideoMetadata = PicsartUsageMetadata & {
  videos: Array<PicsartItemMetadata & { credits?: number }>;
  generationId?: string;
  playgroundUrl?: string;
};

export function itemMetadata(item: MediaItem): PicsartItemMetadata {
  return {
    url: item.url,
    ...(item.generationId ? { generationId: item.generationId } : {}),
    ...(item.playgroundUrl ? { playgroundUrl: item.playgroundUrl } : {}),
    ...(item.metadata ? { metadata: item.metadata as JSONObject } : {}),
  };
}

export function usageMetadata(result: MediaCallResult): PicsartUsageMetadata {
  return {
    ...(result.credits !== undefined ? { credits: result.credits } : {}),
    ...(result.balance !== undefined ? { balance: result.balance } : {}),
  };
}

export function toSharedWarnings(warnings: MediaWarning[]): SharedV4Warning[] {
  return warnings.map((warning) => (warning.type === 'other'
    ? { type: 'other', message: warning.message }
    : { type: warning.type, feature: warning.feature, ...(warning.details ? { details: warning.details } : {}) }));
}
