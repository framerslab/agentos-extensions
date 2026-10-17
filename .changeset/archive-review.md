---
'@framers/agentos-ext-document-export': patch
---

The archive reader decodes entry names by their UTF-8 flag, an Info-ZIP Unicode Path field or code page 437; refuses a local header that does not repeat its directory record's method, encryption bits and name, bytes in the directory past its records other than one digital signature, and a ZIP64 end record whose own size does not fit; reads a valid DEFLATE stream whatever empty blocks it holds while feeding the inflater at most 16 steps of 8 KiB past the step that ends the stream; refuses a false recorded size as `format` whatever the cap; and refuses a read stopped while a read of the `Blob` is pending as `stopped`, at once, ending its worker whenever the stop lands.
