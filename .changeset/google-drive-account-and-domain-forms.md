---
'@framers/agentos-ext-google-drive': patch
---

`parseDriveLink` reads a signed-in account's index before the forms that name an item by their query, `/u/<n>/uc?id=`, `/u/<n>/open?id=`, `/u/<n>/folderview?id=` and `/u/<n>/embeddedfolderview?id=` on drive.google.com and docs.google.com, which Drive redirects to the same address without it; each answered `refused`. It reads the embedded folder view (`/embeddedfolderview?id=<id>`), the mobile folder view (`/drive/mobile/folders/<id>`) and the older Google Apps forms under a domain (`/a/<domain>/open?id=`, `/uc?id=`, `/folderview?id=`, `/embeddedfolderview?id=`, `/file/d/<id>` and a Doc's, a Sheet's or a Slides deck's `/<word>/d/<id>`), which Drive serves for the same item and which were refused. The forms Drive answers 404 stay refused: an account's index or a domain before `/drive/`, both together, an account's index after a domain, and a domain without a dot.
