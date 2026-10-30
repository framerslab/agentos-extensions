/** Google's grant for the files a person picks, on the auth module's redirect flow, with its fixed faults. */
export * from './GoogleOAuthFlow.js';
/** Drive's calls: a file's metadata, its export or download under a byte cap, a Doc's export for reading as text, and the connected account. */
export * from './drive.js';
/** A Doc's Markdown as Google exports it, without the pictures the export embeds as data addresses. */
export * from './markdown.js';
/** The account source connector over the files a person picked. */
export * from './GoogleDrivePickedConnector.js';
/** The Drive and Docs addresses a person pastes, read without a request: the file, folder or shared drive each names. */
export * from './links.js';
