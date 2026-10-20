# @framers/agentos-ext-document-parser

A document reader for hosts that read files from people they do not know, such as the attachments of a person's mail. The host writes a file into the parser's spool and asks for it over a Unix socket; the parser reads it with AgentOS's `loadIsolated` under the request's bounds and answers one line: the text, or the reason it was not read.

```ts
import { documentParserClient } from '@framers/agentos-ext-document-parser';

const parser = documentParserClient('/run/parser/parser.sock');
const answer = await parser.parse('/run/parser/spool/7f3a.pdf', 'pdf', { maxPages: 50 });
if (answer.ok) console.log(answer.pages, answer.text.length, answer.truncated);
else console.log(answer.failed); // 'scanned', 'too_long', ...
```

## Install

```bash
npm install @framers/agentos-ext-document-parser @framers/agentos
```

`@framers/agentos` 0.14.20 or later is a peer. Node 22.16 or later: the reader bounds each read's memory outside its heap with `worker.getHeapStatistics()`, which Node 22.16 adds.

## The protocol

One connection carries one request line and one answer line, each a JSON object ending in a newline.

The request:

```json
{"id":"9b1f0c3e2d","path":"/run/parser/spool/7f3a.pdf","kind":"pdf","bounds":{"maxPages":50,"timeoutMs":20000}}
```

The answers:

```json
{"id":"9b1f0c3e2d","ok":true,"text":"First page\nSecond page","pages":2,"truncated":false}
{"id":"9b1f0c3e2d","ok":false,"failed":"scanned"}
```

`id` is 1 to 64 letters, digits, `_` or `-`, and the answer carries the request's own. `kind` is one of `PARSER_KINDS`: `pdf`, `docx`, `text` and `markdown`. `pages` is a PDF's page count and `null` for every other kind; `truncated` says the text was cut at `maxCharacters`.

`parseRequest(line, spool)` reads a request as the parser does, and refuses it, in this order: a path that does not resolve inside the spool (`outside_spool`, so `/run/parser/spool/../x` is refused), a kind it does not read (`unsupported`), and a bound that is not a whole number from 1 to its ceiling (`malformed`). A refusal is already a complete answer. A line that is not JSON or has no valid `id` is no request at all: `parseRequest` returns `null`. `parseAnswer(line)` reads an answer as the client does and returns `null` for anything else.

## The client

`documentParserClient(socketPath, connectTimeoutMs = 5000, answerGraceMs = 5000)` returns `{ parse(path, kind, bounds, signal?) }`. Each call opens a connection of its own, so a stuck read never holds a later call. The connection has `connectTimeoutMs` to open; the answer is due within the connect time, the read's `timeoutMs` and `answerGraceMs`.

A call resolves with the parser's answer. It rejects, never with a file's content, when the read's outcome is unknown:

| Error message | When |
|---|---|
| `document_parser_connect_timeout` | No connection within `connectTimeoutMs` |
| `document_parser_answer_timeout` | A connection, and no answer within its time |
| `document_parser_invalid_answer` | A line that is not an answer to this call, or one past 16,000,000 characters |
| `document_parser_closed` | The server closed the connection without an answer |
| `document_parser_aborted` | The call's `signal` aborted |
| The socket's own error | `ENOENT` or `ECONNREFUSED` when no parser listens |

None of these says anything about the file: the host deletes its copy and may ask again later.

## The bounds

| Bound | Default | Ceiling | Past the bound |
|---|---|---|---|
| `maxBytes` | 10,000,000 | 50,000,000 | Refused as `too_large` before the file is read |
| `maxPages` | 50 | 500 | A PDF with more pages is refused as `too_long`; the loader merges a PDF's pages, so the bound refuses and never cuts |
| `timeoutMs` | 20,000 | 120,000 | The read ends and is answered `timeout` |
| `maxCharacters` | 1,000,000 | 2,000,000 | The text is cut there, never inside a surrogate pair, and answered with `truncated: true` |

`DEFAULT_BOUNDS` and `BOUND_CEILINGS` export these figures. Characters are UTF-16 code units, as JavaScript counts a string's length. The character ceiling keeps an answer line under the client's 16,000,000-character limit even when every code unit is escaped.

## The failures

`PARSER_FAILURES` names every reason a read fails. A host shows each as its own state and never the error's text.

| `failed` | Meaning |
|---|---|
| `too_large` | The file is past `maxBytes`, or a Word file's archive inflates past the loader's bound |
| `too_long` | A PDF has more pages than `maxPages` |
| `scanned` | A PDF has pages and no text layer; reading it needs OCR, which this parser does not run |
| `encrypted` | The file is password-protected |
| `malformed` | The reader cannot read the file (not a PDF, not a Word archive, a read that ran out of memory), the file is missing, or a bound was out of range |
| `timeout` | The read passed `timeoutMs` |
| `unsupported` | A kind the parser does not read |
| `outside_spool` | A path outside the parser's spool |

## License

Apache-2.0
