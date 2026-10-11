---
'@framers/agentos-ext-image-generation': patch
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
---

The images directory is checked before a provider is asked for an image, and a refusal names what to change.

- With no host `saveImage`, `generate_image`, `editImage`, `upscaleImage` and `variateImage` make and check the images directory and the caller's directory in it, write access included, before they call the provider. A provider bills for the image it makes; a directory the saver refused used to cost every call its result. Replicate is checked too: AgentOS asks it in sync mode, where it can answer with a `data:` URL that is saved like any other image data.
- Every directory above the images directory must still belong to this user or root and be writable by no one else unless it is sticky: a user who could rename an entry there could swap the tree between a check and the write or read that follows it, and Node has no `openat` to pin a checked directory. The error now names that directory, its owner and its mode (for example, a disk-backed Kubernetes `emptyDir` at `/tmp`: owner uid 0, mode 0777, not sticky), and SKILL.md says how a pod's volume passes: made sticky (by an init container, or `emptyDir.mode: 01777` where the cluster has Kubernetes 1.37's alpha `EmptyDirVolumeMode` gate) or given to the service's user, or replaced by a host `saveImage`.
- A saved image is read only from the caller's own directory, matched by device and inode and never a link, and every directory it is opened through must pass the same rule as those above the images directory; once the file is open the path is checked again to reach that file in that directory.
