# @picsart/vercel-ai-provider

Picsart image and video models for the [Vercel AI SDK](https://ai-sdk.dev).

## Install

```bash
npm install @picsart/vercel-ai-provider ai
```

Requires Node 22 or newer and AI SDK 7 (`ai@^7`). Set `PICSART_API_KEY` ([create a key](https://picsart.com/api-platform/docs/authentication)).

The package is ESM only. `require()` loads it on Node versions that can `require` ES modules, which Node 22.12 and newer can.

The key is read when the first request is made. With the default catalog, importing the package and listing models need no key.

## Use

By default the model list is the catalog bundled with your installed `@picsart/ai-sdk`, so list models instead of hardcoding IDs:

```ts
import { generateImage, experimental_generateVideo } from 'ai';
import { picsart } from '@picsart/vercel-ai-provider';

const imageModels = await picsart.listModels({ mode: 'image' });
const [imageModel] = imageModels.filter((model) => model.inputType === 't2i' && model.requiredParams.length === 0);
const { image, images } = await generateImage({
  model: picsart.image(imageModel.id),
  prompt: 'a ceramic mug on a marble table',
  aspectRatio: '16:9',
});

console.log(image.mediaType, image.uint8Array.length);
console.log(images[0].providerMetadata?.picsart); // { url, generationId, playgroundUrl, ... }

const videoModels = await picsart.listModels({ mode: 'video' });
const [videoModel] = videoModels.filter((model) => model.inputType === 't2v' && model.requiredParams.length === 0);
const { video } = await experimental_generateVideo({
  model: picsart.video(videoModel.id),
  prompt: 'steam rises from a ceramic mug',
});

console.log(video.mediaType, video.uint8Array.length);
```

`listModels` returns `{ id, name, mode, inputType, requiredParams }` for each model. `inputType` says what a model takes: `t2i`, `i2i`, `t2v`, `i2v`, `a2v` and `v2v` (text, image, audio or video in, image or video out). It is left out when the catalog has none. `requiredParams` lists the parameters a model requires besides `prompt`; some text-to-image and text-to-video models also require reference images or IDs, so an empty list is how you find a model that runs from a prompt alone.

Unless you set `playgroundUrl: false`, every generated item carries a `playgroundUrl` that opens the same model and settings in the Picsart AI Playground.

To choose models by what they accept, read their parameters from `picsart.catalog`, the catalog the provider was configured with. The same names are the keys of `providerOptions.picsart`:

```ts
import { picsart } from '@picsart/vercel-ai-provider';

const videoModels = await picsart.catalog.listModels({ mode: 'video' });
const withStartFrame = videoModels.filter((model) => model.params.startFrame?.kind === 'file');
console.log(withStartFrame.map((model) => model.id));
console.log(Object.keys(withStartFrame[0]?.params ?? {}));
```

## Long videos on serverless

A Picsart video takes minutes, which is longer than many serverless functions can run. Start the job in one request, store its `operation`, and check it from a later request:

```ts
import { experimental_getVideoStatus, experimental_startVideo } from 'ai';
import { picsart } from '@picsart/vercel-ai-provider';

const [videoModel] = (await picsart.listModels({ mode: 'video' })).filter((model) => model.inputType === 't2v' && model.requiredParams.length === 0);

// First request: start the job and store the operation (plain JSON).
const { operation } = await experimental_startVideo({
  model: picsart.video(videoModel.id),
  prompt: 'steam rises from a ceramic mug',
});
const saved = JSON.stringify(operation);

// Any later request: check the job once.
const status = await experimental_getVideoStatus(picsart.video(videoModel.id), { operation: JSON.parse(saved) });
if (status.status === 'completed') {
  for (const video of status.videos) if (video.type === 'url') console.log(video.url);
} else if (status.status === 'error') {
  console.error(status.error);
} // 'pending': check again later
```

- `status` is `pending` while the job runs, `completed` with the Picsart URLs in `videos[i].url`, or `error` when Picsart reported the job as failed or as completed with no usable result. `error` holds Picsart's message when it sent one, and otherwise says what was missing. A completed status carries `providerMetadata.picsart` with `videos`, plus `credits` and `balance` when Picsart reports them, as `experimental_generateVideo` does.
- `experimental_getVideoStatus` doesn't download the video. Fetch the URL yourself.
- The `operation` holds the model ID you passed to `picsart.video()`, the Picsart generation ID and, unless `playgroundUrl` is `false`, the playground link. Pass it to a model created with the same ID; any other value fails with an `InvalidArgumentError`.
- Each `experimental_startVideo` call starts one video. Start more videos with more calls.
- A status check that Picsart refuses, such as a rejected API key (401, 403) or an unknown job (404), throws an `APICallError` with `statusCode` and `data.code`. It says nothing about the job, so don't start the video again because of it.
- Every `APICallError` from a status check carries the job's ID in `data.picsart.generationId`.
- Starting a job is never retried. A status check that hits a rate limit, a server error, a dropped connection or an unreadable response is retried by `ai` (`maxRetries`, default 2), because a status check starts nothing.

In one long-running process, `experimental_generateVideo({ ..., poll: { intervalMs: 10_000, timeoutMs: 1_800_000 } })` runs the same start and status calls and downloads the video when it is done (`ai` checks every 5 seconds for up to 10 minutes by default). Without `poll`, it waits for the job inside a single call.

When the poll times out, `ai` throws a plain `Error` without the job's ID, and the Picsart job keeps running and is charged. To keep the ID whatever happens, call `experimental_startVideo` and `experimental_getVideoStatus` yourself.

Picsart sends no webhooks: `webhookUrl` comes back as an `unsupported` warning, and `experimental_generateVideo({ webhook })` falls back to polling.

This needs `execution: 'sdk'` (the default). With `execution: 'server'`, `experimental_startVideo` fails because the model has no `doStart`.

## Settings

```ts
import { createPicsart } from '@picsart/vercel-ai-provider';

const picsart = createPicsart({
  apiKey: process.env.PICSART_API_KEY,         // default: PICSART_API_KEY
  baseURL: 'https://api.picsart.com',           // default
  headers: { 'x-my-app': 'demo' },              // added to every Picsart API call
  fetch: globalThis.fetch,                      // Picsart API, catalog and image download requests
  catalog: 'sdk',                               // 'sdk' | { url, ttlMs } | your own ModelCatalog
  execution: 'sdk',                             // 'sdk' | 'server'
  playgroundUrl: 'https://picsart.com/ai-playground/', // default; false for no links
  maxGenerationsPerCall: 100,                   // default; the largest n one call accepts
  maxConcurrentJobs: 4,                         // default; Picsart jobs one call runs at once
});
```

| Setting | What it changes |
|---|---|
| `catalog: 'sdk'` | Models come from the installed `@picsart/ai-sdk`. New Picsart models arrive with an `@picsart/ai-sdk` update. |
| `catalog: { url, ttlMs }` | Models come from a catalog service at `url` (`GET {url}/v1/models-catalog`), cached for `ttlMs` (default 10 minutes). Only for a deployment where such a service is reachable; see below. |
| `catalog: yourCatalog` | Any object with `getModel(id)` and `listModels(filter?)`, typed as `ModelCatalog`. |
| `execution: 'sdk'` | Requests are built on your side by `@picsart/ai-sdk` and checked against the model's schema before anything is submitted, so a bad request fails before credits are spent. |
| `execution: 'server'` | Requests go to Picsart's `v1/models` API as `{ model, params }` and Picsart resolves the model. There is no local check, and `balance` is not reported. A call waits for the job as long as `@picsart/ai-sdk` does: up to 20 minutes for an image and an hour for a video. If the job fails after Picsart accepted it, the error's `data.picsart.generationId` holds its ID. |
| `maxGenerationsPerCall` | The largest `n` one model call accepts (default 100). A larger `n` fails with an `InvalidArgumentError` for `n` before anything is sent or charged. Split the request into smaller calls, or raise the limit. |
| `maxConcurrentJobs` | How many Picsart jobs one model call runs at the same time (default 4). The other jobs start as earlier ones finish. Once the call's `abortSignal` fires, no further job starts. |

`maxGenerationsPerCall` and `maxConcurrentJobs` must be positive whole numbers; any other value makes `createPicsart` throw an `InvalidArgumentError`.

`fetch` is not used for video downloads; those go through `ai`'s `download` option.

Requests to the Picsart API and the catalog service carry `platform: api` and `X-Touchpoint: sdk`, the headers `@picsart/ai-sdk` adds when it is given an API key. A header of the same name that you set in `headers`, or in the `headers` of a call, is kept. Result downloads carry no Picsart headers and no credentials.

The default `'sdk'` catalog is the supported option. Picsart's catalog service is not reachable with an API key through the public gateway today: `api.picsart.com` answers `401` to catalog requests. Use `catalog: { url }` only for a deployment where a catalog service is reachable.

`catalog: { url }` sends your API key to that URL as a bearer token, so point it only at a catalog service you trust.

`remoteCatalog({ url })` and `sdkCatalog()` are exported for building your own catalog. A standalone `remoteCatalog({ url })` sends no API key and no gateway headers unless you give it a `fetch` that adds them; use `catalog: { url }` to fetch the catalog with your key. A catalog service that has no catalog route at `url` fails with an error instead of listing no models.

Whichever `execution` you pick, a model must be listed by the `catalog` before it can run. The default `'sdk'` catalog lists only the models of your installed `@picsart/ai-sdk`, so to use a newer model, update `@picsart/ai-sdk`, or pair `execution: 'server'` with your own `ModelCatalog` that lists it.

### Workflow

Models from `createPicsart`, and the default `picsart` provider, can cross Workflow step boundaries, so a model created outside a `"use step"` function can be passed into one.

- The API key is never serialized. The restored model reads `PICSART_API_KEY`, so set it wherever the step runs.
- A custom `fetch` is not carried over; the restored model uses the global `fetch`. A model whose provider uses a `remoteCatalog(...)` instance or any other custom `ModelCatalog` object cannot be serialized: serializing fails with a `SerializationError`, because a restored model would read its models from a different catalog. Use `catalog: 'sdk'` or `catalog: { url, ttlMs }` for models that cross Workflow steps.
- `baseURL`, `catalog: { url, ttlMs }`, `execution`, `playgroundUrl`, `maxGenerationsPerCall`, `maxConcurrentJobs` and `headers` are carried over, except headers that look like credentials. A header is dropped when its name contains `auth`, `token`, `key`, `secret`, `cookie`, `session`, `password`, `credential`, `signature` or `jwt`, when its value starts with `Bearer ` or `Basic `, or when its value contains your `apiKey` or the current `PICSART_API_KEY`.
- Serializing fails with a `SerializationError` when `baseURL`, `catalog.url` or `playgroundUrl` carries credentials: a user name or password in the URL, a query or fragment parameter that the header rule above would drop (such as `?token=` or `#access_token=`), or your `apiKey` or the current `PICSART_API_KEY` anywhere in it.
- Workflow state is trusted input. A restored model sends `PICSART_API_KEY` to the serialized `baseURL` and `catalog.url`.

## Inputs and outputs

- Input images, frames and references must be `http:` or `https:` URLs. Other schemes, bytes and `data:` URLs are rejected before anything is sent. Non-http(s) strings passed through `ai` may be rejected by `ai` itself, before they reach this provider. Pass them as `prompt.images` and `prompt.mask` for images, and as `prompt.image`, `frameImages` and `inputReferences` for video.
- Reference media is treated as an image or a video by its `mediaType`, or by its file extension when no type is given. If neither tells, the call fails and asks for `{ data: url, mediaType }`.
- A model that doesn't take an input you pass (a mask, a last frame, more images) fails with an `InvalidArgumentError` that lists the inputs it does take.
- Settings a model doesn't support come back as warnings and are not sent. Picsart-specific parameters go in `providerOptions.picsart`, keyed by the model's parameter names. Keys the model doesn't have come back as warnings too.
- For a model that makes several images per job, the provider sets `count` from `n`. A `providerOptions.picsart.count` that differs from what it sends comes back as a warning; use `n` instead.
- `generateImage` sends all `n` images to one model call, which runs the Picsart jobs they need, `maxConcurrentJobs` at a time. An `n` above `maxGenerationsPerCall` fails before anything is sent or charged. If some of those jobs fail, the images that succeeded are returned with a warning. Passing `maxImagesPerCall` to `generateImage` splits the request into several calls again, and then one failed call fails the whole request.
- A video call makes one video. With `n > 1`, `ai` makes one call per video and fails the whole request when any of them fails, so the videos that finished, and were charged, are lost. Ask for one video per call, or start each video with `experimental_startVideo`.
- Failures surface as AI SDK errors: `NoSuchModelError` for an unknown model, `InvalidArgumentError` for input or parameters Picsart would reject, `UnsupportedFunctionalityError` for bytes and `data:` inputs, `LoadAPIKeyError` when a request is made with no key configured, and `APICallError` for API failures (`statusCode`, and the Picsart error code in `data.code` when Picsart sent one). An account without enough credits fails at submit with `data.code` `NOT_ENOUGH_AVAILABLE_CREDITS`, before anything is charged.
- Errors are never retried automatically, because a retry would run (and charge) the generation again. The one exception is a status check of a started video (see [Long videos on serverless](#long-videos-on-serverless)), which starts nothing.
- If downloading a generated image fails after Picsart has finished the job, the error is an `APICallError` whose `data.picsart` holds the generated `urls`, plus `credits` and `balance` when Picsart reported them, so nothing paid for is lost. A result URL that is not `http:` or `https:` is never downloaded and fails the same way.
- Generated videos are downloaded by `ai` itself. Pass `experimental_generateVideo({ download })` to control that download. The Picsart URL is also in `providerMetadata.picsart.videos[i].url`.

## Credits

Picsart reports the credits a job cost, and the balance left when it knows it. Where you read them depends on the media type.

`providerMetadata.picsart` has the shape of `PicsartImageMetadata` for an image call and `PicsartVideoMetadata` for a video, and each generated image's own `providerMetadata.picsart` has the shape of `PicsartItemMetadata`. All three types are exported.

For images, `generateImage` keeps only `picsart.images` in the merged `result.providerMetadata`. Credits and balance are in `result.calls[i].providerMetadata.picsart`, one entry per `ai` call (one call, unless you pass `maxImagesPerCall`). Sum `credits` over the calls for the total:

```ts
import { generateImage } from 'ai';
import { picsart, type PicsartImageMetadata } from '@picsart/vercel-ai-provider';

const [imageModel] = (await picsart.listModels({ mode: 'image' })).filter((model) => model.inputType === 't2i' && model.requiredParams.length === 0);
const result = await generateImage({ model: picsart.image(imageModel.id), prompt: 'a ceramic mug', n: 6 });

const credits = result.calls.reduce(
  (sum, call) => sum + ((call.providerMetadata?.picsart as PicsartImageMetadata | undefined)?.credits ?? 0),
  0,
);
console.log(`${result.images.length} images, ${credits} credits`);
```

For video, ask for one video per call. Each result's `providerMetadata.picsart` then holds the `credits` and `balance` of its job:

```ts
import { experimental_generateVideo } from 'ai';
import { picsart, type PicsartVideoMetadata } from '@picsart/vercel-ai-provider';

const [videoModel] = (await picsart.listModels({ mode: 'video' })).filter((model) => model.inputType === 't2v' && model.requiredParams.length === 0);
const model = picsart.video(videoModel.id);

const first = await experimental_generateVideo({ model, prompt: 'steam rises from a ceramic mug' });
const second = await experimental_generateVideo({ model, prompt: 'a ceramic mug turns on a marble table' });

const creditsOf = (result: typeof first) => (result.providerMetadata.picsart as PicsartVideoMetadata).credits ?? 0;
console.log(`2 videos, ${creditsOf(first) + creditsOf(second)} credits`);
```

With `n > 1`, `ai` concatenates `picsart.videos` but keeps the top-level `credits` and `balance` of the last call only. Each `videos[i].credits` is the cost of the job that produced that video.

## Development

```bash
npm ci
npm test            # unit tests only: no network and no credits, even when PICSART_API_KEY is set
npm run typecheck
npm run build
PICSART_API_KEY=... npm run test:live   # spends credits: one cheap image, one short video (started, then polled)
```

`test:live` sets `PICSART_LIVE=1`. The live suite runs only when both `PICSART_API_KEY` and `PICSART_LIVE=1` are set.
