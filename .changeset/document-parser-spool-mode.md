---
'@framers/agentos-ext-document-parser': patch
---

The spool the parser makes is mode 0770 whatever the process's umask. `mkdir`'s mode passed through the umask, 022 in a container by default, and left the spool 0750, so a host that shares the parser's group under a uid of its own could not write a file into it (`EACCES`). A spool that is already there keeps its mode.
