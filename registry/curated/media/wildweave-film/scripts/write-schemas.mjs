// Writes dist/schemas/<tool>.json, each tool's input and output JSON Schemas (draft-07), from the built
// dist/schemas.js. The build runs it after tsc and npm or pnpm pack runs it before packing (prepack), so
// the tarball carries the files a host or a contract test reads without importing the package.
import { mkdir, writeFile } from 'node:fs/promises';

const here = new URL('../', import.meta.url);
const { TOOL_NAMES, toolJsonSchema } = await import(new URL('dist/schemas.js', here).href);
const folder = new URL('dist/schemas/', here);
await mkdir(folder, { recursive: true });
for (const name of TOOL_NAMES) {
  await writeFile(new URL(`${name}.json`, folder), `${JSON.stringify(toolJsonSchema(name), null, 2)}\n`);
}
