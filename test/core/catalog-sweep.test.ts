import { describe, expect, it } from 'vitest';
import { sdkCatalog } from '../../src/core/catalog';
import { sdkExecutor } from '../../src/core/executors';
import { mapRequest } from '../../src/core/mapping';
import type { CatalogModel, CatalogParam, MediaKind, MediaRequest } from '../../src/core/types';

const IMAGE_URL = 'https://cdn.test/input.png';
const VIDEO_URL = 'https://cdn.test/input.mp4';

const fillable = (key: string, param: CatalogParam): boolean =>
  key === 'prompt' || (param.kind === 'file' && param.accept !== 'audio');

function typicalRequest(model: CatalogModel): MediaRequest | undefined {
  const entries = Object.entries(model.params);
  if (entries.some(([key, param]) => param.required && !fillable(key, param))) return undefined;
  const requiresImage = entries.some(([key, param]) => param.required && param.kind === 'file' && (param.accept === 'image' || param.accept === 'media') && key !== 'mask');
  const requiresVideo = entries.some(([, param]) => param.required && param.kind === 'file' && param.accept === 'video');
  const request: MediaRequest = { kind: model.mode as MediaKind, modelId: model.id, n: 1 };
  if (model.params.prompt) request.prompt = 'a ceramic mug on a marble table';
  if (model.mode === 'image' && (model.inputType === 'i2i' || requiresImage)) request.inputImages = [{ url: IMAGE_URL }];
  if (model.mode === 'video' && (model.inputType === 'i2v' || requiresImage)) request.firstFrame = { url: IMAGE_URL };
  if (requiresVideo || model.inputType === 'v2v') request.references = [{ url: VIDEO_URL, mediaType: 'video/mp4' }];
  return request;
}

describe('installed catalog sweep', () => {
  it('maps a typical request for every model the AI SDK fields can serve', async () => {
    const models = await sdkCatalog().listModels();
    const executor = sdkExecutor({ generate: async () => { throw new Error('not called'); } } as unknown as Parameters<typeof sdkExecutor>[0]);
    const failures: string[] = [];
    let checked = 0;
    for (const model of models) {
      const request = typicalRequest(model);
      if (!request) continue;
      checked += 1;
      try {
        const { params } = mapRequest(model, request);
        const result = executor.validate(model.id, params);
        if (result && !result.valid) failures.push(`${model.id}: ${(result.errors ?? []).join('; ')}`);
      } catch (error) {
        failures.push(`${model.id}: ${(error as Error).message}`);
      }
    }
    expect(checked).toBeGreaterThan(models.length / 2);
    expect(failures).toEqual([]);
  });
});
