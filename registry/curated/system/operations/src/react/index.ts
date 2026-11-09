/**
 * @fileoverview `./react` (D39): headless hooks over the product's `fetch` for the person's pages
 * (`useRequests`, `useRequest`, `useStream`), the composer (`useComposer`), staff's pages
 * (`useStaffList`, `useStaffRequest`) and the jobs page (`useJobs`, `useJob`), and `Markdown`, the
 * sanitized renderer of a message's body (D19). The hooks render nothing and carry no words: the
 * product's pages do both.
 */
export { Markdown, LINK_REL, type MarkdownProps } from './Markdown.js';
export { joinPath, queryOf, readJson, SseParser, pageVisible, type JsonAnswer, type OpsClient, type OpsRead, type SseFrame } from './client.js';
export { useComposer, COMPOSER_BODY_MAX, COMPOSER_PICTURES_MAX, type OpsTemplate, type UseComposerOptions, type UseComposerResult } from './hooks/useComposer.js';
export { useRequest, type OpsRequestView } from './hooks/useRequest.js';
export { useRequests, type OpsRequestsPage } from './hooks/useRequests.js';
export { useStaffList } from './hooks/useStaffList.js';
export { useStaffRequest, type OpsStaffRequestView } from './hooks/useStaffRequest.js';
export { useStream, STREAM_POLL_MS, STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MS, type StreamMode, type UseStreamOptions, type UseStreamResult } from './hooks/useStream.js';
export { useJobs, type OpsJobsFilter, type UseJobsResult } from './hooks/useJobs.js';
export { useJob, type OpsJobCommand, type OpsJobCommandAnswer, type UseJobResult } from './hooks/useJob.js';
export { JOBS_GIVE_UP_MS, JOBS_POLL_MS, JOBS_READ_TIMEOUT_MS, type OpsPolledState } from './hooks/usePolled.js';
