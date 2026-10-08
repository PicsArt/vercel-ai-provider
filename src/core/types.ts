export type MediaKind = 'image' | 'video';

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video'];

export interface MediaFileRef {
  url: string;
  mediaType?: string;
}

export interface MediaRequest {
  kind: MediaKind;
  modelId: string;
  prompt?: string;
  n: number;
  aspectRatio?: string;
  size?: string;
  resolution?: string;
  duration?: number;
  fps?: number;
  seed?: number;
  generateAudio?: boolean;
  inputImages?: MediaFileRef[];
  mask?: MediaFileRef;
  firstFrame?: MediaFileRef;
  lastFrame?: MediaFileRef;
  references?: MediaFileRef[];
  extra?: Record<string, unknown>;
}

export type MediaWarning =
  | { type: 'unsupported' | 'compatibility'; feature: string; details?: string }
  | { type: 'other'; message: string };

export interface MediaItem {
  url: string;
  generationId?: string;
  playgroundUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaCallResult {
  items: MediaItem[];
  credits?: number;
  balance?: number;
  warnings: MediaWarning[];
  modelId: string;
}

export type MediaOperation = {
  modelId: string;
  generationId: string;
  playgroundUrl?: string;
};

export interface MediaStartResult {
  operation: MediaOperation;
  warnings: MediaWarning[];
}

export type MediaStatus = { state: 'pending' } | { state: 'completed'; result: MediaCallResult };

export interface CatalogParam {
  kind: 'enum' | 'catalog' | 'range' | 'boolean' | 'text' | 'file' | 'object' | 'unknown';
  required: boolean;
  options?: Array<{ id: string | number }>;
  min?: number;
  max?: number;
  step?: number;
  accept?: 'image' | 'video' | 'audio' | 'media';
  array?: { min?: number; max?: number };
}

export interface CatalogModel {
  id: string;
  name: string;
  mode: string;
  inputType?: string;
  params: Record<string, CatalogParam>;
}

export interface ModelCatalog {
  getModel(id: string): Promise<CatalogModel | undefined>;
  listModels(filter?: { mode?: MediaKind }): Promise<CatalogModel[]>;
}

export interface ExecutorResult {
  items: Array<{ url: string; metadata?: Record<string, unknown> }>;
  generationId?: string;
  credits?: number;
  balance?: number;
}

export type ExecutorStatus = { state: 'pending' } | { state: 'completed'; result: ExecutorResult };

export interface MediaExecutor {
  validate(modelId: string, params: Record<string, unknown>): { valid: boolean; errors?: string[] } | undefined;
  generate(modelId: string, params: Record<string, unknown>, options: { kind: MediaKind; signal?: AbortSignal }): Promise<ExecutorResult>;
  start?(modelId: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{ generationId: string }>;
  status?(modelId: string, generationId: string, options?: { signal?: AbortSignal }): Promise<ExecutorStatus>;
}
