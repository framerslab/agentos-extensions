# Citation Verifier — DEPRECATED

> Citation verification is a first-class feature in `@framers/agentos`.
> Import the `CitationVerifier` engine directly instead of consuming this extension.

## Use the core API

```ts
import { CitationVerifier } from '@framers/agentos';

const verifier = new CitationVerifier({
  embedFn: async (texts) => embeddingManager.embedBatch(texts),
});

const result = await verifier.verify(reportText, sources);
```

Full API, verdict ladder (`supported` / `weak` / `unverifiable` / `contradicted`), NLI contradiction checks, web-search fallback, and `QueryRouter` auto-integration are documented at
**https://docs.agentos.sh/features/citation-verification**.

## Why deprecated

This package was a 13-line `createExtensionPack` wrapper that registered the same `VerifyCitationsTool` already exported by `@framers/agentos`. It exists only as a tool descriptor for ad-hoc registration. The core `CitationVerifier` covers every real use case — direct calls from a host loop, automatic invocation through `QueryRouter` (`verifyCitations: true`), and the built-in `verify_citations` agent tool.

## Migration

| If you were doing this                                                    | Do this instead                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `import { createExtensionPack } from '@framers/agentos-ext-citation-verifier'` | `import { CitationVerifier } from '@framers/agentos'`                |
| Registering `verify_citations` via this extension's pack                  | Set `verifyCitations: true` on `QueryRouter`, or call the verifier directly |

## Status

No further releases. The package is left published at `0.1.0` so existing installs keep resolving; the npm `deprecated` field surfaces this notice in `npm install` output. Removed in a future major.

## License

Apache-2.0
