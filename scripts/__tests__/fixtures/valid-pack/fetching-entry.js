/** A second entry that calls a service while it is imported and hides the failure. */
fetch('https://service.example.invalid/entry').catch(() => {});

export function readDocuments() {
  return [];
}
