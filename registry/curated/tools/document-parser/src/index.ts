/**
 * @framers/agentos-ext-document-parser: a document reader over a Unix socket. A host writes a file into the parser's
 * spool and asks for it by path; the parser reads it with AgentOS's isolated loader under the request's bounds,
 * deletes the file, and answers one line with the text or the reason it was not read.
 *
 * @packageDocumentation
 */
export {
  PARSER_KINDS, PARSER_FAILURES, DEFAULT_BOUNDS, BOUND_CEILINGS, parseRequest, parseAnswer,
} from './protocol.js';
export type {
  ParserKind, ParserFailure, ParserBounds, ParserRequest, ParserAnswer, ParserRefusal,
} from './protocol.js';
export { documentParserClient } from './client.js';
export type { DocumentParser } from './client.js';
export { startDocumentParser } from './server.js';
export type { DocumentParserOptions, DocumentParserServer } from './server.js';
export type {
  DocumentParserLogger, DocumentParserLogFields, DocumentParserLogState, DocumentParserDropReason,
} from './log.js';
