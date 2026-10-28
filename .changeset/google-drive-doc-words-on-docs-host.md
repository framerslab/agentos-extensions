---
'@framers/agentos-ext-google-drive': patch
---

`parseDriveLink` refuses a Doc's, a Sheet's and a Slides deck's form on drive.google.com (`/document/d/<id>`, `/spreadsheets/d/<id>` and `/presentation/d/<id>`, bare, with an account's index after the word, or under a Google Apps domain, `/a/<domain>/`), which Drive answers 404 on that host and serves on docs.google.com alone; each was answered as the file. `/file/d/<id>` stays a file on both hosts, which serve it.
