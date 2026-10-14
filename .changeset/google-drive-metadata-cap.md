---
"@framers/agentos-ext-google-drive": patch
---

`GoogleDrivePickedConnector` throws `ReadCapExceeded` from `read`, `list` and `changesSince` when a file's metadata answer passes its 1 MiB cap, such as an intercepting proxy's page or a wrong `baseUrl`'s answer, rather than answering the file `removed`, so a caller keeps its copies of files that are still in Drive.
