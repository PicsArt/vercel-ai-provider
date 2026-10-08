import type { ImageModelV4, ImageModelV4CallOptions, ImageModelV4Result } from '@ai-sdk/provider';
import { runMedia } from '../core/run';
import type { CatalogModel } from '../core/types';
import { withGeneratedResults, withProviderErrors } from './errors';
import { downloadBytes, picsartOptions, toFileRef } from './files';
import { itemMetadata, toSharedWarnings, usageMetadata, type PicsartImageMetadata } from './metadata';
import { createPicsart } from './provider';
import { catalogModel, type PicsartRuntime, type PicsartSerializedConfig } from './runtime';
import { serializeModel, WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from './serialization';

function hasImageInputs(model: CatalogModel | undefined): boolean {
  return Object.entries(model?.params ?? {}).some(([key, param]) => param.kind === 'file' && (param.accept === 'image' || param.accept === 'media') && key !== 'mask');
}

function unhandledSafe<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

export class PicsartImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'picsart.image';

  static [WORKFLOW_SERIALIZE](model: PicsartImageModel) {
    return serializeModel(model.modelId, model.runtime);
  }

  static [WORKFLOW_DESERIALIZE](options: { modelId: string; config: PicsartSerializedConfig }) {
    return createPicsart(options.config).image(options.modelId);
  }

  constructor(readonly modelId: string, private readonly runtime: PicsartRuntime) {}

  // one ai call per request: runMedia plans the Picsart jobs itself and keeps the ones that succeed
  readonly maxImagesPerCall = Number.MAX_SAFE_INTEGER;

  get supportsFileInputs(): Promise<boolean> {
    return unhandledSafe(catalogModel(this.runtime, this.modelId).then(hasImageInputs));
  }

  get supportsMaskInputs(): Promise<boolean> {
    return unhandledSafe(catalogModel(this.runtime, this.modelId).then((model) => model?.params.mask?.kind === 'file'));
  }

  async doGenerate(options: ImageModelV4CallOptions): Promise<ImageModelV4Result> {
    const context = { modelId: this.modelId, modelType: 'imageModel' as const, url: this.runtime.baseURL, signal: options.abortSignal };
    return withProviderErrors(context, async () => {
      const result = await runMedia(
        { catalog: this.runtime.catalog, executor: this.runtime.executor(options.headers), playgroundUrl: this.runtime.playgroundUrl, limits: this.runtime.limits },
        {
          kind: 'image',
          modelId: this.modelId,
          prompt: options.prompt,
          n: options.n,
          aspectRatio: options.aspectRatio,
          size: options.size,
          seed: options.seed,
          inputImages: options.files?.map((file) => toFileRef(file, 'files')),
          mask: options.mask ? toFileRef(options.mask, 'mask') : undefined,
          extra: picsartOptions(options.providerOptions),
        },
        { signal: options.abortSignal },
      );
      const images = await Promise.all(result.items.map((item) => downloadBytes(this.runtime.fetch, item.url, options.abortSignal)))
        .catch((error: unknown) => {
          throw withGeneratedResults(error, { urls: result.items.map((item) => item.url), ...usageMetadata(result) });
        });
      const picsart: PicsartImageMetadata = { images: result.items.map(itemMetadata), ...usageMetadata(result) };
      return {
        images,
        isRetryable: false,
        warnings: toSharedWarnings(result.warnings),
        providerMetadata: { picsart },
        response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
      };
    });
  }
}
