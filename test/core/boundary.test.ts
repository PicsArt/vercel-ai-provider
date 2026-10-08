import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreDir = fileURLToPath(new URL('../../src/core', import.meta.url));

describe('core boundary', () => {
  it('never imports the Vercel AI SDK', () => {
    const files = readdirSync(coreDir).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(coreDir, file), 'utf8');
      expect(source, file).not.toMatch(/from\s+['"](ai|@ai-sdk\/[^'"]+)['"]/);
    }
  });
});
