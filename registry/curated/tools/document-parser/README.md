# @framers/agentos-ext-document-parser

A document reader for hosts that read files from people they do not know, such as the attachments of a person's mail. The host writes a file into the parser's spool and asks for it over a Unix socket; the parser reads it with AgentOS's `loadIsolated` under the request's bounds, deletes it, and answers one line: the text, or the reason it was not read. One file, one answer. The parser runs as a process of its own, so a reader that a hostile file exhausts or stalls never runs in the host's process. Its container image runs that process as uid and gid 1000; started with no network and a read-only root, as the examples below start it, its one writable place is the spool's volume.

The host's side:

```ts
import { documentParserClient } from '@framers/agentos-ext-document-parser';

const parser = documentParserClient('/run/parser/parser.sock');
const answer = await parser.parse('/run/parser/spool/7f3a.pdf', 'pdf', { maxPages: 50 });
if (answer.ok) index(answer.text, answer.pages, answer.truncated);
else record(answer.failed); // 'scanned', 'too_long', ...
```

The parser's side, as a process:

```bash
PARSER_SOCKET=/run/parser/parser.sock PARSER_SPOOL=/run/parser/spool npx agentos-document-parser
```

or as a container beside the host's, on the shared volume that [Running it in a container](#running-it-in-a-container) sets up:

```bash
docker run -d --network none --read-only --user 1000:1000 -v parser-spool:/run/parser \
  ghcr.io/framerslab/agentos-document-parser:0.1.0
```

## Install

```bash
npm install @framers/agentos-ext-document-parser @framers/agentos
```

`@framers/agentos` 0.14.20 or later is a peer.

The package declares Node `^22.16.0 || >=24`, what the parser needs; the client and the protocol alone run on any Node 22. The parser needs:

- `worker.getHeapStatistics()`, with which the reader bounds each read's memory outside its heap: Node 22.16 and 24.0 add it, and Node 23 lacks it.
- On Node 22, unpdf 1.6.1 or later. AgentOS's PDF reader runs unpdf's build of pdf.js, which calls `Promise.try`; Node 22's V8 lacks it, Node 24 has it, and unpdf polyfills it from 1.6.1 on. AgentOS admits unpdf from 1.4.0 (`^1.4.0`), so a fresh install takes a release with the polyfill, while a lockfile that holds an older one keeps it.

Before it listens, the parser reads a one-page PDF built into the package, and refuses to start where that read fails, with the error's own words (such as `TypeError: Promise.try is not a function`): otherwise every PDF would answer `malformed`, which a host records as the file's fault.

## The protocol

One connection carries one request line and one answer line, each a JSON object ending in a newline.

The request:

```json
{"id":"9b1f0c3e2d","path":"/run/parser/spool/7f3a.pdf","kind":"pdf","bounds":{"maxPages":50,"timeoutMs":20000}}
```

The answers:

```json
{"id":"9b1f0c3e2d","ok":true,"text":"First page Second page","pages":2,"truncated":false}
{"id":"9b1f0c3e2d","ok":false,"failed":"scanned"}
```

`id` is 1 to 64 letters, digits, `_` or `-`, and the answer carries the request's own. `kind` is one of `PARSER_KINDS`: `pdf`, `docx`, `text` and `markdown`. `pages` is a PDF's page count and `null` for every other kind; `truncated` says the text was cut at `maxCharacters`.

`parseRequest(line, spool)` reads a request as the parser does, and refuses it, in this order: a path that does not resolve inside the spool (`outside_spool`, so `/run/parser/spool/../x` is refused), a kind it does not read (`unsupported`), and a bound that is not a whole number from 1 to its ceiling (`malformed`). A refusal is already a complete answer. A line that is not JSON or has no valid `id` is no request at all: `parseRequest` returns `null`. `parseAnswer(line)` reads an answer as the client does and returns `null` for anything else.

## The client

`documentParserClient(socketPath, connectTimeoutMs = 5000, answerGraceMs = 5000)` returns `{ parse(path, kind, bounds, signal?) }`. Each call opens a connection of its own. The connection has `connectTimeoutMs` to open; the answer is due within the connect time, the read's `timeoutMs` and `answerGraceMs`, so no call waits longer than that. The parser reads one file at a time unless its `concurrency` says otherwise: a host that asks for several files at once gets the later answers later, and a call that gives up leaves its read to be skipped, or finished and its file deleted.

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

`PARSER_FAILURES` names every reason a read fails. A host shows each as its own state, in words of its own such as these, and never the error's text.

| `failed` | Meaning | A host shows |
|---|---|---|
| `too_large` | The file is past `maxBytes`, or a Word file's archive inflates past the loader's bound | Not read: too large |
| `too_long` | A PDF has more pages than `maxPages` | Not read: too many pages |
| `scanned` | A PDF has pages and no text layer; reading it needs OCR, which this parser does not run | Not read: a scan, with no text |
| `encrypted` | The file is password-protected | Not read: password-protected |
| `malformed` | The reader cannot read the file (not a PDF, not a Word archive, a read that took more than 256 MiB), the path is missing or is not a file (a folder, a link, a pipe), or a bound was out of range | Not read: the file could not be read |
| `timeout` | The read passed `timeoutMs` | Not read: it took too long |
| `unsupported` | A kind the parser does not read | Not read: a kind it does not read |
| `outside_spool` | A path outside the parser's spool, or one whose links lead outside it | Nothing to a person: the host asked for a path outside the spool, a fault of its own |

## The reader

Each read runs in a worker thread of the parser's process, through AgentOS's `loadIsolated`, under bounds of its own besides the request's: 256 MiB of heap, 256 MiB outside the heap (the array buffers pdf.js and JSZip fill), and 50,000,000 bytes for what a Word file's archive inflates to. A file past `maxBytes` is refused before a worker starts. The text is trimmed; a PDF's pages come out as one text with its runs of whitespace collapsed, and a PDF with pages and no text is `scanned`.

PDFs are read with `PdfLoader` (unpdf's build of pdf.js), Word files with `DocxLoader` (mammoth, after the archive's bound check), text and Markdown with their loaders. pdf.js prints its own warnings on standard error, outside the parser's lines; one of them can quote an operator from a PDF's content stream.

## The server

`startDocumentParser(options)` reads its one-page PDF (and throws, before anything is made, when that read fails), makes the spool when it is missing (mode 0770, whatever the process's umask; a spool already there keeps its own), removes a socket file an earlier run left, listens on the socket and sets its mode, and resolves with `{ stop, healthy }`.

| Option | Default | |
|---|---|---|
| `socketPath` | | The socket's path |
| `spool` | | The folder the parser reads files from |
| `socketMode` | `0o660` | The socket file's mode: its owner and its group, the host's user, may connect |
| `concurrency` | 1 | Reads at once, 1 to 64; the others wait their turn in the order they came |
| `requestTimeoutMs` | 5,000 | How long a connection has to send its request line, from its start, and to close once it has its answer, from the answer |
| `logger` | none | Where its lines go: AgentOS's `ILogger` shape, `info` and `warn` |

For each connection the server:

1. reads one request line with `parseRequest`, and answers a refusal at once, after deleting the file that a request refused for its kind or a bound names in the spool;
2. follows the path's links, and refuses a path that leads outside the spool as `outside_spool` without reading or deleting anything there;
3. waits for a read slot; a caller that left while it waited gets no read;
4. opens the file read-only, never through a link in its last part, checks that it is a file and its size against `maxBytes`, and reads it;
5. deletes the file, whatever the read gave, and then answers.

A connection that has sent no line `requestTimeoutMs` after it opened, a line past 8,192 characters or a line that is not a request is closed without an answer, and one still open `requestTimeoutMs` after its answer is closed, so `stop()` never waits on it. Each time runs from its start, so a caller that sends a byte at a time cannot put it off. A caller keeps its side of the connection open until the answer comes, as `documentParserClient` does: a caller that closes its side first has left, and its request is read no further. The server never deletes a folder, and never a file outside the spool. `stop()` stops listening and resolves once every connection has closed: a read under way finishes and is answered first.

## The binary

`agentos-document-parser` runs the server with AgentOS's pino logger, which writes JSON lines on standard output. Its settings are environment variables:

| Variable | Default | |
|---|---|---|
| `PARSER_SOCKET` | `/run/parser/parser.sock` | The socket's path |
| `PARSER_SPOOL` | `/run/parser/spool` | The spool |
| `PARSER_CONCURRENCY` | 1 | Reads at once |
| `PARSER_LOG_LEVEL` | `info` | One of pino's levels: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

`agentos-document-parser health` exits 0 once the socket accepts a connection and 1 when it does not within two seconds; it loads nothing but the socket, so it serves as a container's healthcheck. SIGTERM and SIGINT stop the parser once its connections have closed. A start that fails (a setting out of range, a socket that cannot listen, a reader that cannot read its one-page PDF, as on Node 22 with an unpdf before 1.6.1) writes one `failed_to_start` line at the error level and exits 1.

## Running it in a container

The image `ghcr.io/framerslab/agentos-document-parser` runs the binary on Node 22 as uid and gid 1000, with the socket at `/run/parser/parser.sock` and the spool at `/run/parser/spool`. Its healthcheck runs `node dist/bin.js health` every five seconds. The main thread's heap is held to 256 MiB (`NODE_OPTIONS=--max-old-space-size=256`), and its files belong to root, so the parser can change none of them. It holds this pack and the `@framers/agentos` release that the repository's lockfile resolves for it, with that release's dependencies and TypeScript, a peer the release requires, and none of their optional packages; nothing it loads needs one. Each package is the version `pnpm-lock.yaml` records, installed by pnpm's frozen install and checked against the integrity the lockfile records, so the image takes a new release of a dependency only through a change to the lockfile, and Dependabot changes the lockfile with a release only once that release is three days old (`@framers` packages aside). Its base is Node 22's `bookworm-slim` image, named in the Dockerfile by its Node release and its digest, which Dependabot moves to each later Node 22 release once that release's image is three days old. Two builds of one commit hold the same packages on the same base, though not byte for byte the same image, so pin a release's tag, which is pushed once, or the digest its run prints.

| Tag | What it is |
|---|---|
| `:<version>`, such as `:0.1.0` | The image of that release, pushed once from the commit that raised the pack's version and never moved |
| `:sha-<commit>`, such as `:sha-2fb54f1` | The image of each commit to `master` that changes the pack, named by the commit's first seven characters |

The host and the parser share one volume, a tmpfs, mounted at `/run/parser` in both containers, and both run as 1000:1000, the volume's owner. The image's `/run/parser` belongs to 1000:1000 as well, so a named volume first mounted there starts out as that user's. The parser makes the spool (mode 0770) and the socket (mode 0660) there; the host writes each file into the spool under a random name, asks for it by that path, and deletes the file itself when the call rejects. A container's own `tmpfs:` mount cannot be shared with another container, so a named volume backed by tmpfs is used, and its files leave with the last container that mounts it. Size it for the files a host writes before their answers come: 64 MiB holds six files at the default `maxBytes`.

```bash
docker volume create --driver local \
  --opt type=tmpfs --opt device=tmpfs --opt o=size=64m,uid=1000,gid=1000,mode=0770 parser-spool
docker run -d --name parser --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges --memory 1g --pids-limit 64 --cpus 1 \
  -v parser-spool:/run/parser ghcr.io/framerslab/agentos-document-parser:0.1.0
```

With Docker Compose, the host's service mounts the same volume at the same path, runs as the same user, and starts once the parser is healthy:

```yaml
services:
  parser:
    image: ghcr.io/framerslab/agentos-document-parser:0.1.0
    network_mode: none
    read_only: true
    user: '1000:1000'
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    mem_limit: 1g
    pids_limit: 64
    cpus: '1'
    volumes:
      - parser-spool:/run/parser
    restart: unless-stopped
  host:
    image: your-host # reads with documentParserClient('/run/parser/parser.sock')
    user: '1000:1000'
    volumes:
      - parser-spool:/run/parser
    depends_on:
      parser:
        condition: service_healthy

volumes:
  parser-spool:
    driver: local
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: 'size=64m,uid=1000,gid=1000,mode=0770'
```

A container's memory limit has to hold the parser's own bounds: the main thread's heap (256 MiB) and, for each read under way, its worker's heap (256 MiB) and the memory its reader holds outside the heap (256 MiB), with Node's own besides. A limit under their sum holds ordinary files, but a file that drives a read to its bounds can then end the whole process before the read's own bound refuses the file; its caller's call then rejects (`document_parser_closed`, or the socket's own error), and the host's other calls fail until the container restarts. 1 GiB holds one read at its bounds; give each further read of `PARSER_CONCURRENCY` 512 MiB more.

The image's lifecycle test (`image/lifecycle.sh`, run by the `document-parser-image.yml` workflow) starts it as above beside a client container from the same image. It reads a text, Markdown, PDF and Word file through the socket, checks five refusals (a scanned PDF, a PDF past its page bound, a Word file that inflates past the loader's bound, a read past its deadline and a path outside the spool), and checks that each file is gone after its answer. Before it starts them, it checks that every package under the image's `node_modules` is at a version `pnpm-lock.yaml` lists (`image/installed.mjs`). It also checks, from what Docker recorded for the parser's container, that the parser ran with no network, a read-only root, every capability dropped and none added, no new privileges, uid and gid 1000 and the tmpfs volume at `/run/parser`, and that its lines carry no file's text.

## What it never does

- It needs no network: it installs nothing when it starts, checks its PDF reader on a file built into the package, and answers over a Unix socket. The image does not cut its own network; run its container with none (`--network none`, `network_mode: none`), as the examples above and the lifecycle test do.
- It reads and deletes nothing outside its spool: a path that resolves outside it, or whose links lead out of it, is refused untouched, and it never deletes a folder.
- It keeps no file after its answer: the file is deleted before the answer is written, whatever the read gave, and when the caller has left.
- It writes no file's text, name or path to a line.
- It never runs as root in its image, and cannot change its own files there.

## The lines

Each line's message is its state, and its fields are typed (`DocumentParserLogFields`): `event` is `document_parser`, and `state` is one of:

| `state` | Fields | When |
|---|---|---|
| `listening` | `concurrency` | The server listens |
| `answered` | `kind`, `bytes`, `pages`, `truncated`, `ms`; or `kind`, `failed`, `bytes`, `ms` | A read was answered |
| `refused` | `failed`, and `kind` once checked | A request was refused before any read |
| `abandoned` | `kind`, `ms` | The caller left before its answer; the file was deleted all the same |
| `dropped` | `reason`: `no_line_in_time`, `line_too_long`, `not_a_request` or `held_open` | The server closed a connection: no request came, or the caller held it open after its answer |
| `not_removed` (warn) | `code`, such as `ERR_FS_EISDIR` | A path in the spool could not be deleted |
| `not_accepted` (warn) | `code`, such as `EMFILE` | A connection could not be accepted |
| `stopped` | | The server stopped |
| `failed_to_start` (error) | `code`: the reason | The process could not start |

A line never carries a file's text, name or path, nor a kind the protocol did not check.

## License

Apache-2.0
