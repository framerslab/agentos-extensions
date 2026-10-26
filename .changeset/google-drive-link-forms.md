---
'@framers/agentos-ext-google-drive': patch
---

`parseDriveLink` reads a pasted address as the URL standard reads one, as a browser opens it: the C0 controls and spaces around it are dropped, and every tab and newline in it, and after `http`, `https`, `ws`, `wss` and `ftp` any run of `/` and `\` stands before the host, none included. `https:drive.google.com/file/d/<id>/view`, `https:/docs.google.com/document/d/<id>/edit`, `https:\\drive.google.com\file\d\<id>\view` and an address with a control character before it answered `null`, so a caller that reads `null` as another site's address read these Drive addresses as web pages. After `file` and its two slashes a third slash or backslash leaves the host empty, so `file:///drive.google.com/file/d/<id>` names no host and answers `null`. Drive's `/folderview?id=<id>`, on `drive.google.com` and `docs.google.com`, is the folder Drive redirects it to (`/drive/folders/<id>`), where it was refused.
