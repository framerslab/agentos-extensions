# @framers/agentos-ext-google-drive

## 0.1.2

### Patch Changes

- [#207](https://github.com/framerslab/agentos-extensions/pull/207) [`42c3d4a`](https://github.com/framerslab/agentos-extensions/commit/42c3d4a59abebe2525798a8b2b88371a25a3661e) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleDrivePickedConnector` throws `ReadCapExceeded` from `read`, `list` and `changesSince` when a file's metadata answer passes its 1 MiB cap, such as an intercepting proxy's page or a wrong `baseUrl`'s answer, rather than answering the file `removed`, so a caller keeps its copies of files that are still in Drive.

## 0.1.1

### Patch Changes

- Updated dependencies [[`03d31a2`](https://github.com/framerslab/agentos-extensions/commit/03d31a251d0d0ca3c90489a12a6901c1c38b07fc)]:
  - @framers/agentos-ext-account-sources@0.2.0

## 0.1.0

### Minor Changes

- [#204](https://github.com/framerslab/agentos-extensions/pull/204) [`6e5e004`](https://github.com/framerslab/agentos-extensions/commit/6e5e004b63515da7fa74bb46bbe7205a187eccc4) Thanks [@jddunn](https://github.com/jddunn)! - Add a library for Google Drive files a person picked: `GoogleOAuthFlow`, Google's grant for the `drive.file` scope on the auth module's `RedirectOAuthFlow` (offline access, incremental authorization, consent, revocation); Drive's calls for a file's metadata, its export or download under a byte cap, and the connected account; and `GoogleDrivePickedConnector`, an account source connector that reads picked files by id, exports Docs, Sheets and Slides as Markdown, CSV and text, downloads other files, answers a file it can no longer read as gone with its reason, and reports changes by Drive's version.
