import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sdkCatalog } from '../src/core/catalog';

const root = fileURLToPath(new URL('..', import.meta.url));

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? typescriptFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('package', () => {
  it('names no Picsart model in source, tests or README', async () => {
    const ids = (await sdkCatalog().listModels()).map((model) => model.id);
    expect(ids.length).toBeGreaterThan(0);
    const pattern = `(?<![\\w-])(?<!\\w\\.)(?:${ids.map(escapeRegExp).join('|')})(?![\\w-])(?!\\.\\w)`;
    const files = [...typescriptFiles(join(root, 'src')), ...typescriptFiles(join(root, 'test')), join(root, 'README.md')];
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(new RegExp(pattern, 'g'))].map((match) => `${file.slice(root.length)}: ${match[0]}`));
    expect(offenders).toEqual([]);
  });
});
