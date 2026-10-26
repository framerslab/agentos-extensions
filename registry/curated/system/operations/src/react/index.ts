/**
 * @fileoverview `./react` (D39): headless hooks over the product's `fetch` for the person's pages
 * (`useRequests`, `useRequest`, `useStream`), the composer (`useComposer`) and staff's pages
 * (`useStaffList`, `useStaffRequest`), and `Markdown`, the sanitized renderer of a message's body
 * (D19). The hooks render nothing and carry no words: the product's pages do both.
 */
export { Markdown, LINK_REL, MARKDOWN_SCHEMA, type MarkdownProps } from './Markdown.js';
export { joinPath, queryOf, readJson, SseParser, pageVisible, type JsonAnswer, type OpsClient, type OpsRead, type SseFrame } from './client.js';
export { useComposer, COMPOSER_BODY_MAX, COMPOSER_PICTURES_MAX, type OpsTemplate, type UseComposerOptions, type UseComposerResult } from './hooks/useComposer.js';
export { useRequest, type OpsRequestView } from './hooks/useRequest.js';
export { useRequests, type OpsRequestsPage } from './hooks/useRequests.js';
export { useStaffList } from './hooks/useStaffList.js';
export { useStaffRequest, type OpsStaffRequestView } from './hooks/useStaffRequest.js';
export { useStream, STREAM_POLL_MS, STREAM_RECONNECT_MS, type StreamMode, type UseStreamOptions, type UseStreamResult } from './hooks/useStream.js';
