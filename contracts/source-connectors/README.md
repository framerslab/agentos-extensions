# Account-source connector conformance

`conformance.ts` holds the cases an account-source connector passes against a synthetic stand-in of its provider. Every connector passes the common cases. A connector also passes the policy cases that its own documented behavior promises, and its subject declares which. A connector's installed contract registers the cases:

```ts
import { connectorConformance } from './conformance.js';

connectorConformance({
  name: 'Example',
  policy: { selectsItems: true },                      // its selection names items, not containers
  async open() {
    const standin = await startExampleStandin();       // loopback only, synthetic records
    const connector = new ExampleConnector({ baseUrl: standin.origin }); // built from the registry package
    return {
      connector,
      selection: { ids: ['doc-1'] },                    // a selection the connector accepts, covering `present`
      present: 'doc-1',                                 // an item the stand-in holds
      removed: 'doc-404',                               // a well-formed id the stand-in answers as no longer held
      cursor: standin.cursor,                           // a cursor the connector accepts for that selection
      requests: () => standin.requests.length,
      failChanges: () => standin.failNext(),
      close: () => standin.close(),
    };
  },
});
```

## The cases

| Case | Registered | Promise |
|---|---|---|
| Empty listing | always | `list({ ids: [] })` answers `{ items: [], gone: [] }` and sends no request |
| Read shape | always | `read` of `present` keeps that id, its `ref.kind` is the connector's `kind`, `ref.readAt` is an ISO 8601 time, and its content is text, or bytes with a media type |
| Removed read | always | `read` of `removed` answers `{ id: removed, reason: 'removed' }` |
| Aborted call | always | `list`, `read` and `changesSince` with an aborted signal reject and send no request |
| Failed change request | always | `changesSince` rejects when the stand-in fails its request, so no cursor is answered |
| Exact item listing | `selectsItems` | `list` of `present` and `removed` answers `present` alone, and `removed` as `{ id, reason: 'removed' }` |
| Empty changes | `selectsItems` | `changesSince` of an empty selection answers no changed or gone item and sends no request |
| Selection limit | `limitsSelection` | `list` and `changesSince` of the case's `oversized` ids reject before any request |

Listing order, cursor encoding, document normalization and scope isolation belong to each connector and stay in its own cases.

## Pointing another connector at it

1. Write a stand-in for the provider's API that listens on loopback only, serves synthetic records, counts every request it receives and can fail the next request of a change set.
2. Write a subject file that calls `connectorConformance` with the connector built from its registry package against that stand-in. Set `selectsItems` when the selection names items, as the Google Drive connector's picked files do. Leave it out when the selection names containers, as the GitHub documents connector's repositories do. Set `limitsSelection` and give `oversized` only when the connector itself refuses an oversized selection. Each `open()` builds a fresh connector and stand-in, and `close()` releases both.
3. In the connector's installed-consumer workflow, copy `contracts/source-connectors/conformance.ts`, the stand-in and the subject into one empty directory outside the checkout. Install the connector and `@framers/agentos-ext-account-sources` at exact registry versions without `overrides`, compile with `--module NodeNext --moduleResolution NodeNext`, and run the subject with `node --test`.

The Gmail source is the working example. Its subject, [`registry/curated/productivity/gmail-source/test/gmail-source.conformance.ts`](../../registry/curated/productivity/gmail-source/test/gmail-source.conformance.ts), declares both policies; its stand-in and storage fixture sit beside it; and [`.github/workflows/gmail-source-contract.yml`](../../.github/workflows/gmail-source-contract.yml) installs and runs them.
