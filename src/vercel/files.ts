import { APICallError, InvalidArgumentError, UnsupportedFunctionalityError, type Experimental_VideoModelV4File, type ImageModelV4CallOptions, type ImageModelV4File } from '@ai-sdk/provider';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import type { MediaFileRef } from '../core/types';
import { isAbortError } from './errors';

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function toFileRef(file: ImageModelV4File | Experimental_VideoModelV4File, argument: string): MediaFileRef {
  if (file.type === 'url') {
    if (!isHttpUrl(file.url)) {
      throw new InvalidArgumentError({ argument, message: `Picsart takes input media as http(s) URLs, and ${argument} isn't one. Upload the file and pass its public URL.` });
    }
    const mediaType = 'mediaType' in file ? file.mediaType : undefined;
    return mediaType ? { url: file.url, mediaType } : { url: file.url };
  }
  throw new UnsupportedFunctionalityError({
    functionality: `${argument} given as bytes`,
    message: 'Picsart takes input media as http(s) URLs. Upload the file and pass its URL instead of bytes or a data: URL.',
  });
}

export function picsartOptions(providerOptions: ImageModelV4CallOptions['providerOptions'] | undefined): Record<string, unknown> | undefined {
  const options = providerOptions?.picsart;
  return options ? { ...options } : undefined;
}

export async function downloadBytes(fetchFn: FetchFunction, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!isHttpUrl(url)) {
    throw new APICallError({ message: 'Picsart returned a result URL that is not http(s), so it was not downloaded.', url, requestBodyValues: {}, isRetryable: false });
  }
  try {
    const response = await fetchFn(url, { signal });
    if (!response.ok) {
      throw new APICallError({ message: `Downloading the Picsart result failed with HTTP ${response.status}.`, url, requestBodyValues: {}, statusCode: response.status, isRetryable: false });
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (isAbortError(error) || APICallError.isInstance(error)) throw error;
    throw new APICallError({
      message: `Downloading the Picsart result failed: ${error instanceof Error ? error.message : String(error)}`,
      url,
      requestBodyValues: {},
      isRetryable: false,
      cause: error,
    });
  }
}
