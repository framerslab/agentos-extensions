---
'@framers/agentos-ext-google-drive': minor
---

`parseDriveLink(text)` reads the Drive and Docs addresses a person pastes, without a request: a Doc, Sheet or Slides address, `/file/d/<id>`, `/open?id=`, `/uc?id=` and `drive.usercontent.google.com/download?id=` as a file, `/drive/folders/<id>` as a folder and `/drive/shared-drives/<id>` as a shared drive, a signed-in account's `/u/<n>/` allowed. Any other address on `docs.google.com`, `drive.google.com` and `drive.usercontent.google.com` is `refused` (a Form, a Drawing, the publish-to-the-web form, Drive's own pages, an address carrying credentials), and another host's is `null`.
