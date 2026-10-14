---
"@framers/agentos-ext-google-drive": minor
---

Add a library for Google Drive files a person picked: `GoogleOAuthFlow`, Google's grant for the `drive.file` scope on the auth module's `RedirectOAuthFlow` (offline access, incremental authorization, consent, revocation); Drive's calls for a file's metadata, its export or download under a byte cap, and the connected account; and `GoogleDrivePickedConnector`, an account source connector that reads picked files by id, exports Docs, Sheets and Slides as Markdown, CSV and text, downloads other files, answers a file it can no longer read as gone with its reason, and reports changes by Drive's version.
