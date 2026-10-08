import { createPicsart } from './vercel/provider';

export { createPicsart, DEFAULT_BASE_URL, type PicsartModelInfo, type PicsartProvider, type PicsartProviderSettings } from './vercel/provider';
export { remoteCatalog, sdkCatalog, type RemoteCatalogOptions } from './core/catalog';
export { DEFAULT_PLAYGROUND_URL } from './core/playground';
export type { CatalogModel, CatalogParam, MediaKind, ModelCatalog } from './core/types';
export type { PicsartImageMetadata, PicsartItemMetadata, PicsartVideoMetadata } from './vercel/metadata';
export { VERSION } from './version';

export const picsart = createPicsart();
