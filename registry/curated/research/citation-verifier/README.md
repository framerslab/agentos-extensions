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

Deprecated. Every version from 0.1.1 on carries npm's `deprecated` field, set from this package's `package.json`, so `npm install` prints this notice. The package stays on npm so existing installs keep resolving, and it gets a new patch only when the files it ships change. Removed in a future major.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
