import type { CatalogModel, CatalogParam, ModelCatalog } from '../../src/core/types';

const text = (required = false): CatalogParam => ({ kind: 'text', required });
const choice = (ids: Array<string | number>): CatalogParam => ({ kind: 'enum', required: false, options: ids.map((id) => ({ id })) });
const range = (min: number, max: number, step: number): CatalogParam => ({ kind: 'range', required: false, min, max, step });
const file = (accept: CatalogParam['accept'], options: { required?: boolean; max?: number } = {}): CatalogParam => ({
  kind: 'file',
  required: options.required ?? false,
  accept,
  ...(options.max !== undefined ? { array: { max: options.max } } : {}),
});

export const imageModel: CatalogModel = {
  id: 'test-image',
  name: 'Test Image',
  mode: 'image',
  inputType: 't2i',
  params: {
    prompt: text(true),
    aspectRatio: choice(['1:1', '16:9']),
    count: choice([1, 2, 4]),
    resolution: choice(['1K', '1024x1024']),
    seed: range(0, 100, 1),
    imageUrls: file('image', { max: 2 }),
    mask: file('image'),
  },
};

export const editModel: CatalogModel = {
  id: 'test-edit',
  name: 'Test Edit',
  mode: 'image',
  inputType: 'i2i',
  params: {
    prompt: text(true),
    startFrame: file('image', { required: true }),
    imageUrls: file('image', { max: 2 }),
  },
};

export const noFilesModel: CatalogModel = {
  id: 'test-no-files',
  name: 'Test No Files',
  mode: 'image',
  inputType: 'i2i',
  params: { sourceImageId: text(true) },
};

export const promptlessModel: CatalogModel = {
  id: 'test-promptless',
  name: 'Test Promptless',
  mode: 'image',
  inputType: 'i2i',
  params: { imageUrls: file('image', { required: true, max: 1 }) },
};

export const videoModel: CatalogModel = {
  id: 'test-video',
  name: 'Test Video',
  mode: 'video',
  inputType: 't2v',
  params: {
    prompt: text(true),
    aspectRatio: choice(['16:9', 'adaptive']),
    duration: range(3, 15, 1),
    resolution: choice(['720p', '1080P']),
    fps: choice([24, 30]),
    generateAudio: { kind: 'boolean', required: false },
    startFrame: file('image'),
    endFrame: file('image'),
  },
};

export const videoListModel: CatalogModel = {
  id: 'test-video-list',
  name: 'Test Video List',
  mode: 'video',
  inputType: 'i2v',
  params: {
    prompt: text(true),
    duration: choice([5, 10]),
    imageUrls: file('image', { max: 1 }),
    videoUrl: file('video', { required: true }),
  },
};

export function memoryCatalog(models: CatalogModel[]): ModelCatalog {
  return {
    async getModel(id) {
      return models.find((model) => model.id === id);
    },
    async listModels(filter) {
      return models.filter((model) => !filter?.mode || model.mode === filter.mode);
    },
  };
}

export const testCatalog = memoryCatalog([imageModel, editModel, noFilesModel, promptlessModel, videoModel, videoListModel]);
