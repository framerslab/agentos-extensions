---
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
---

The Google speech packs hand the client the key file's path as written, and read the credentials variable from the environment.

- A key file is given to the client by its path, made absolute and with its links kept, after a check that the path as the file system reads it and as the client reads it reach the same file. The real path, which #124 handed on, stopped opening on a Kubernetes Secret volume at its next update: the kubelet links each file through a timestamped directory that an update replaces and removes. A path whose `..` follows a link, and so reaches two files, is refused with a message that quotes none of it. The check needs no `realpath(3)`, which on musl needs `/proc`.
- `GOOGLE_CLOUD_STT_CREDENTIALS` and `GOOGLE_CLOUD_TTS_CREDENTIALS` are read from the environment when no secret gives them. AgentOS's extension manager reads the environment only for the ids in its own catalog, which has neither, so a variable set as SKILL.md said left the client on Application Default Credentials without a word.
