---
'@framers/agentos-ext-zip-files': patch
---

The pack takes archiver 8, an ES module that exports each format's archive as a class, so it builds its zip with `new ZipArchive({ zlib: { level: 6 } })` in place of the `archiver('zip', ...)` call that archiver 7's default export answered and archiver 8 no longer has.
