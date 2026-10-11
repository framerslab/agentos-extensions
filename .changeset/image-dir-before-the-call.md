---
'@framers/agentos-ext-image-generation': patch
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
---

The images directory is checked before a provider is asked for an image, and the directories above it are no longer checked.

- With no host `saveImage`, `generate_image`, `editImage`, `upscaleImage` and `variateImage` make and check the images directory and the caller's directory in it, write access included, before they call the provider. A provider bills for the image it makes; a directory the saver refused used to cost every call its result. Replicate is checked too: AgentOS asks it in sync mode, where it can answer with a `data:` URL that is saved like any other image data.
- The rule that every directory above the images directory must belong to this user or root, and be writable by others only when sticky, is gone. It refused a Kubernetes emptyDir mount (0777, no sticky bit), which a pod with a read-only root file system often has at `/tmp`. A saved image is still read only through the images directory's real path and the caller's own directory, never a link, and once the file is open the path is checked again to reach that file in that directory, so whoever can rename a directory above it can move where images are saved but cannot make one caller's image a source for another, or put a file of their own in its place.
