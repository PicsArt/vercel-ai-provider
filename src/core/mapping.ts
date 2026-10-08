import { PicsartInputError } from './errors';
import type { CatalogModel, CatalogParam, MediaFileRef, MediaRequest, MediaWarning } from './types';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'];

export interface MappedRequest {
  params: Record<string, unknown>;
  warnings: MediaWarning[];
}

type Field = [key: string, param: CatalogParam];

function fileFields(model: CatalogModel, accepts: Array<CatalogParam['accept']>): Field[] {
  return Object.entries(model.params).filter(([key, param]) => param.kind === 'file' && accepts.includes(param.accept) && key !== 'mask');
}

function enumIds(param: CatalogParam | undefined): string[] {
  return param?.kind === 'enum' ? (param.options ?? []).map((option) => String(option.id)) : [];
}

function isOnStep(param: CatalogParam, value: number): boolean {
  if (param.step === undefined || param.step <= 0) return true;
  const steps = (value - (param.min ?? 0)) / param.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function referenceKind(reference: MediaFileRef): 'image' | 'video' {
  if (reference.mediaType?.startsWith('image/')) return 'image';
  if (reference.mediaType?.startsWith('video/')) return 'video';
  let path: string;
  try {
    path = new URL(reference.url).pathname.toLowerCase();
  } catch {
    path = reference.url.toLowerCase();
  }
  if (IMAGE_EXTENSIONS.some((extension) => path.endsWith(extension))) return 'image';
  if (VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension))) return 'video';
  throw new PicsartInputError('inputReferences', `Can't tell whether ${reference.url} is an image or a video. Pass it as { data: url, mediaType }.`);
}

function describeInputs(model: CatalogModel): string {
  const files = Object.entries(model.params)
    .filter(([, param]) => param.kind === 'file')
    .map(([key, param]) => `${key} (${param.accept ?? 'file'}${param.array ? ' list' : ''})`);
  const required = Object.entries(model.params)
    .filter(([, param]) => param.required && param.kind !== 'file')
    .map(([key]) => key);
  const takes = files.length > 0 ? `takes ${files.join(', ')}` : 'takes no file inputs';
  return required.length > 0
    ? `${model.id} ${takes}; it also requires ${required.join(', ')} (pass through providerOptions.picsart).`
    : `${model.id} ${takes}.`;
}

export function mapRequest(model: CatalogModel, request: MediaRequest): MappedRequest {
  const params: Record<string, unknown> = {};
  const warnings: MediaWarning[] = [];
  const spec = (key: string): CatalogParam | undefined => (Object.hasOwn(model.params, key) ? model.params[key] : undefined);
  const unsupported = (feature: string, details: string): void => {
    warnings.push({ type: 'unsupported', feature, details });
  };

  const applyValue = (key: string, feature: string, value: string | number | boolean): void => {
    const param = spec(key);
    if (!param) {
      unsupported(feature, `${model.id} has no ${key} setting.`);
      return;
    }
    if (param.kind === 'enum') {
      const match = (param.options ?? []).find((option) => String(option.id) === String(value));
      if (!match) {
        unsupported(feature, `${String(value)} isn't allowed for ${model.id}. Allowed: ${enumIds(param).join(', ')}.`);
        return;
      }
      params[key] = match.id;
      return;
    }
    if (param.kind === 'range' && typeof value === 'number') {
      const inRange = (param.min === undefined || value >= param.min) && (param.max === undefined || value <= param.max);
      if (!inRange || !isOnStep(param, value)) {
        const step = param.step ? ` in steps of ${param.step}` : '';
        unsupported(feature, `${value} is outside ${model.id}'s allowed ${key}: ${param.min ?? '-'} to ${param.max ?? '-'}${step}.`);
        return;
      }
    }
    params[key] = value;
  };

  if (request.prompt !== undefined) {
    if (spec('prompt')) params.prompt = request.prompt;
    else unsupported('prompt', `${model.id} takes no prompt.`);
  }
  if (request.aspectRatio !== undefined) applyValue('aspectRatio', 'aspectRatio', request.aspectRatio);
  if (request.size !== undefined) {
    const allowed = enumIds(spec('resolution'));
    if (allowed.includes(request.size)) params.resolution = request.size;
    else unsupported('size', `${model.id} has no ${request.size} size. Allowed resolutions: ${allowed.join(', ') || 'none'}. Use providerOptions.picsart.resolution to pick one.`);
  }
  if (request.resolution !== undefined) {
    const allowed = enumIds(spec('resolution'));
    const height = request.resolution.split('x')[1];
    const match = [request.resolution, `${height}p`, `${height}P`].find((candidate) => allowed.includes(candidate));
    if (match) params.resolution = match;
    else unsupported('resolution', `${model.id} has no ${request.resolution} resolution. Allowed: ${allowed.join(', ') || 'none'}.`);
  }
  if (request.duration !== undefined) applyValue('duration', 'duration', request.duration);
  if (request.fps !== undefined) applyValue('fps', 'fps', request.fps);
  if (request.seed !== undefined) applyValue('seed', 'seed', request.seed);
  if (request.generateAudio !== undefined) applyValue('generateAudio', 'generateAudio', request.generateAudio);

  const imageFields = fileFields(model, ['image', 'media']);
  const imageList = imageFields.find(([, param]) => param.array);
  const addImages = (argument: string, urls: string[], position: 'start' | 'end' = 'end'): void => {
    if (!imageList) throw new PicsartInputError(argument, `${model.id} doesn't take more images. ${describeInputs(model)}`);
    const [key, param] = imageList;
    const current = asList(params[key]);
    const next = position === 'start' ? [...urls, ...current] : [...current, ...urls];
    if (param.array?.max !== undefined && next.length > param.array.max) {
      throw new PicsartInputError(argument, `${model.id} takes at most ${param.array.max} image(s) in ${key}; got ${next.length}.`);
    }
    params[key] = next;
  };

  if (request.inputImages && request.inputImages.length > 0) {
    if (imageFields.length === 0) throw new PicsartInputError('files', `${model.id} doesn't take input images. ${describeInputs(model)}`);
    const urls = request.inputImages.map((file) => file.url);
    const primary = imageFields.find(([, param]) => !param.array && param.required);
    if (primary) {
      params[primary[0]] = urls[0];
      if (urls.length > 1) addImages('files', urls.slice(1));
    } else {
      addImages('files', urls);
    }
  }
  if (request.mask) {
    if (spec('mask')?.kind === 'file') params.mask = request.mask.url;
    else throw new PicsartInputError('mask', `${model.id} doesn't take a mask. ${describeInputs(model)}`);
  }
  if (request.firstFrame) {
    if (spec('startFrame')?.kind === 'file') params.startFrame = request.firstFrame.url;
    else if (imageList) addImages('image', [request.firstFrame.url], 'start');
    else throw new PicsartInputError('image', `${model.id} doesn't take a start image. ${describeInputs(model)}`);
  }
  if (request.lastFrame) {
    if (spec('endFrame')?.kind === 'file') params.endFrame = request.lastFrame.url;
    else throw new PicsartInputError('frameImages', `${model.id} doesn't take an end frame. ${describeInputs(model)}`);
  }

  const videoFields = [...fileFields(model, ['video', 'media'])].sort(
    ([, a], [, b]) => Number(b.required) - Number(a.required) || Number(Boolean(a.array)) - Number(Boolean(b.array)),
  );
  for (const reference of request.references ?? []) {
    if (referenceKind(reference) === 'image') {
      addImages('inputReferences', [reference.url]);
      continue;
    }
    const target = videoFields.find(([key, param]) => (param.array
      ? param.array.max === undefined || asList(params[key]).length < param.array.max
      : params[key] === undefined));
    if (!target) {
      const list = videoFields.find(([, param]) => param.array?.max !== undefined);
      throw new PicsartInputError('inputReferences', list
        ? `${model.id} takes at most ${list[1].array?.max} video(s) in ${list[0]}; got more.`
        : `${model.id} doesn't take another video. ${describeInputs(model)}`);
    }
    const [key, param] = target;
    params[key] = param.array ? [...asList(params[key]), reference.url] : reference.url;
  }

  for (const [key, value] of Object.entries(request.extra ?? {})) {
    if (spec(key)) params[key] = value;
    else unsupported(`providerOptions.picsart.${key}`, `${model.id} has no "${key}" parameter, so it wasn't sent.`);
  }

  return { params, warnings };
}
