import { encodeDeepLinkPayload } from '@picsart/ai-sdk';

export const DEFAULT_PLAYGROUND_URL = 'https://picsart.com/ai-playground/';

export function buildPlaygroundUrl(baseUrl: string, modelId: string, params: Record<string, unknown>): string | undefined {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('aistate', encodeDeepLinkPayload(modelId, params as Parameters<typeof encodeDeepLinkPayload>[1]));
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isPlaygroundLink(link: string, baseUrl: string | false): boolean {
  if (baseUrl === false) return false;
  try {
    const base = new URL(baseUrl);
    const url = new URL(link);
    return link.startsWith(`${base.origin}${base.pathname}`) && url.origin === base.origin && url.pathname === base.pathname;
  } catch {
    return false;
  }
}
