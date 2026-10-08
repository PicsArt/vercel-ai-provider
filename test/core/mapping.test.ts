import { describe, expect, it } from 'vitest';
import { PicsartInputError } from '../../src/core/errors';
import { mapRequest } from '../../src/core/mapping';
import type { CatalogModel, MediaKind, MediaRequest } from '../../src/core/types';
import { editModel, imageModel, noFilesModel, promptlessModel, videoListModel, videoModel } from '../fixtures/catalog';

const IMG = 'https://cdn.test/a.png';
const IMG2 = 'https://cdn.test/b.png';
const IMG3 = 'https://cdn.test/c.png';

const request = (model: CatalogModel, fields: Partial<MediaRequest>): MediaRequest => ({
  kind: model.mode as MediaKind,
  modelId: model.id,
  n: 1,
  ...fields,
});

const warning = (feature: string) => expect.objectContaining({ type: 'unsupported', feature });

describe('mapRequest', () => {
  it('sends the prompt', () => {
    expect(mapRequest(imageModel, request(imageModel, { prompt: 'a mug' })).params).toEqual({ prompt: 'a mug' });
  });

  it('warns when the model takes no prompt', () => {
    const result = mapRequest(promptlessModel, request(promptlessModel, { prompt: 'x', inputImages: [{ url: IMG }] }));
    expect(result.params).toEqual({ imageUrls: [IMG] });
    expect(result.warnings).toEqual([warning('prompt')]);
  });

  it('keeps an allowed aspect ratio and warns on others', () => {
    expect(mapRequest(imageModel, request(imageModel, { aspectRatio: '16:9' })).params).toEqual({ aspectRatio: '16:9' });
    const result = mapRequest(imageModel, request(imageModel, { aspectRatio: '21:9' }));
    expect(result.params).toEqual({});
    expect(result.warnings).toEqual([warning('aspectRatio')]);
  });

  it('maps an exact size to resolution and warns on other sizes', () => {
    expect(mapRequest(imageModel, request(imageModel, { size: '1024x1024' })).params).toEqual({ resolution: '1024x1024' });
    const result = mapRequest(imageModel, request(imageModel, { size: '2048x2048' }));
    expect(result.params).toEqual({});
    expect(result.warnings).toEqual([warning('size')]);
  });

  it('maps a video resolution to its height option', () => {
    expect(mapRequest(videoModel, request(videoModel, { resolution: '1280x720' })).params).toEqual({ resolution: '720p' });
    expect(mapRequest(videoModel, request(videoModel, { resolution: '1920x1080' })).params).toEqual({ resolution: '1080P' });
    expect(mapRequest(videoModel, request(videoModel, { resolution: '3840x2160' })).warnings).toEqual([warning('resolution')]);
  });

  it('accepts durations inside the range and on the step', () => {
    expect(mapRequest(videoModel, request(videoModel, { duration: 5 })).params).toEqual({ duration: 5 });
    expect(mapRequest(videoModel, request(videoModel, { duration: 3.5 })).warnings).toEqual([warning('duration')]);
    expect(mapRequest(videoModel, request(videoModel, { duration: 20 })).warnings).toEqual([warning('duration')]);
  });

  it('matches enum durations by value', () => {
    expect(mapRequest(videoListModel, request(videoListModel, { duration: 10 })).params).toEqual({ duration: 10 });
    expect(mapRequest(videoListModel, request(videoListModel, { duration: 7 })).warnings).toEqual([warning('duration')]);
  });

  it('maps fps, seed and generateAudio when the model has them', () => {
    expect(mapRequest(videoModel, request(videoModel, { fps: 30, generateAudio: true })).params).toEqual({ fps: 30, generateAudio: true });
    expect(mapRequest(imageModel, request(imageModel, { seed: 7 })).params).toEqual({ seed: 7 });
    expect(mapRequest(imageModel, request(imageModel, { fps: 30 })).warnings).toEqual([warning('fps')]);
  });

  it('puts input images into the image list and enforces its limit', () => {
    expect(mapRequest(imageModel, request(imageModel, { inputImages: [{ url: IMG }, { url: IMG2 }] })).params).toEqual({ imageUrls: [IMG, IMG2] });
    expect(() => mapRequest(imageModel, request(imageModel, { inputImages: [{ url: IMG }, { url: IMG2 }, { url: IMG3 }] }))).toThrow(PicsartInputError);
  });

  it('puts the first image into a required single-image field', () => {
    expect(mapRequest(editModel, request(editModel, { inputImages: [{ url: IMG }, { url: IMG2 }] })).params).toEqual({ startFrame: IMG, imageUrls: [IMG2] });
  });

  it('rejects input images for models without image inputs and names the required inputs', () => {
    expect(() => mapRequest(noFilesModel, request(noFilesModel, { inputImages: [{ url: IMG }] }))).toThrow(/sourceImageId/);
  });

  it('maps the mask only when the model takes one', () => {
    expect(mapRequest(imageModel, request(imageModel, { mask: { url: IMG } })).params).toEqual({ mask: IMG });
    expect(() => mapRequest(editModel, request(editModel, { mask: { url: IMG } }))).toThrow(PicsartInputError);
  });

  it('maps first and last frames', () => {
    expect(mapRequest(videoModel, request(videoModel, { firstFrame: { url: IMG }, lastFrame: { url: IMG2 } })).params).toEqual({ startFrame: IMG, endFrame: IMG2 });
    expect(mapRequest(videoListModel, request(videoListModel, { firstFrame: { url: IMG } })).params).toEqual({ imageUrls: [IMG] });
    expect(() => mapRequest(videoListModel, request(videoListModel, { lastFrame: { url: IMG } }))).toThrow(PicsartInputError);
  });

  it('enforces the image list limit when a first frame joins input images', () => {
    expect(() => mapRequest(videoListModel, request(videoListModel, { firstFrame: { url: IMG }, inputImages: [{ url: IMG2 }] }))).toThrow(PicsartInputError);
  });

  it('routes references by media type or file extension', () => {
    expect(mapRequest(videoListModel, request(videoListModel, { references: [{ url: 'https://cdn.test/clip.mp4' }] })).params).toEqual({ videoUrl: 'https://cdn.test/clip.mp4' });
    expect(mapRequest(videoListModel, request(videoListModel, { references: [{ url: 'https://cdn.test/clip', mediaType: 'video/mp4' }] })).params).toEqual({ videoUrl: 'https://cdn.test/clip' });
    expect(mapRequest(videoListModel, request(videoListModel, { references: [{ url: IMG }] })).params).toEqual({ imageUrls: [IMG] });
    expect(() => mapRequest(videoListModel, request(videoListModel, { references: [{ url: 'https://cdn.test/asset' }] }))).toThrow(/mediaType/);
  });

  it('rejects a second video for a single-video model', () => {
    const references = [{ url: 'https://cdn.test/one.mp4' }, { url: 'https://cdn.test/two.mp4' }];
    expect(() => mapRequest(videoListModel, request(videoListModel, { references }))).toThrow(PicsartInputError);
  });

  it('enforces the video list limit for video references', () => {
    const model: CatalogModel = {
      id: 'test-video-refs',
      name: 'Test Video References',
      mode: 'video',
      params: {
        prompt: { kind: 'text', required: true },
        sourceVideo: { kind: 'file', required: true, accept: 'video' },
        videoUrls: { kind: 'file', required: false, accept: 'video', array: { max: 2 } },
      },
    };
    const clips = ['https://cdn.test/1.mp4', 'https://cdn.test/2.mp4', 'https://cdn.test/3.mp4', 'https://cdn.test/4.mp4'];
    const references = (count: number) => clips.slice(0, count).map((url) => ({ url }));
    expect(mapRequest(model, request(model, { references: references(3) })).params).toEqual({ sourceVideo: clips[0], videoUrls: [clips[1], clips[2]] });
    expect(() => mapRequest(model, request(model, { references: references(4) }))).toThrow(/at most 2 video/);
  });

  it('passes known extra parameters and warns on unknown ones', () => {
    const result = mapRequest(imageModel, request(imageModel, { extra: { seed: 5, notAParam: 1 } }));
    expect(result.params).toEqual({ seed: 5 });
    expect(result.warnings).toEqual([warning('providerOptions.picsart.notAParam')]);
  });

  it('drops extra keys that only exist on Object.prototype', () => {
    const result = mapRequest(imageModel, request(imageModel, { extra: { constructor: 1, toString: 2 } }));
    expect(result.params).toEqual({});
    expect(result.warnings).toEqual([warning('providerOptions.picsart.constructor'), warning('providerOptions.picsart.toString')]);
  });
});
