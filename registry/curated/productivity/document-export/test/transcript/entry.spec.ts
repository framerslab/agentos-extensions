import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, '../../src/transcript');

describe('the transcript entry', () => {
  it('imports nothing but its own files and fflate', () => {
    const outside: string[] = [];
    for (const file of readdirSync(folder)) {
      const source = readFileSync(join(folder, file), 'utf8');
      for (const match of source.matchAll(/(?:import|export)\s(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('./') && match[1] !== 'fflate') outside.push(`${file}: ${match[1]}`);
      }
    }
    expect(outside).toEqual([]);
  });
});
