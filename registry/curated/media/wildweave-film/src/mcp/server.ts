/**
 * @module @framers/agentos-ext-wildweave-film/mcp/server
 *
 * The MCP server: one `McpServer` named `wildweave-film` with every tool registered under the
 * name it has in AgentOS. Each tool's input schema is the committed draft-07 JSON Schema the
 * AgentOS tool carries (the SDK lists it as given and validates a call's arguments against it
 * before the tool runs, answering its own `isError` text on a mismatch), and each answer is one
 * text block holding the tool's JSON, `{ ok: true, result }` or `{ ok: false, error }`, with
 * `isError` set on a failure.
 */
import { McpServer, fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { PACKAGE_VERSION, createToolContext, type PackConfig } from '../index.js';
import type { Logger } from '../log.js';
import { toolJsonSchema } from '../schemas.js';
import { TOOL_DEFINITIONS, type ToolContext } from '../tools.js';

/** The MCP server's name, what a host's configuration calls it. */
export const MCP_SERVER_NAME = 'wildweave-film';

/**
 * A server with every tool registered. Pass the tool context to share one client across the
 * servers a stateless HTTP handler makes, one per request.
 */
export function createWildweaveMcpServer(config: PackConfig, log: Logger, ctx: ToolContext = createToolContext(config, log)): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: PACKAGE_VERSION });
  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.name,
      {
        title: def.displayName,
        description: def.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(toolJsonSchema(def.name).input as unknown as JsonSchemaType),
        annotations: { title: def.displayName, readOnlyHint: !def.hasSideEffects, openWorldHint: def.mode !== 'local' },
      },
      async (args) => {
        const started = Date.now();
        const answer = await def.run(args, ctx);
        log.info(
          {
            event: 'wildweave_film.call',
            tool: def.name,
            mode: def.mode,
            host: 'mcp',
            ok: answer.ok,
            ms: Date.now() - started,
            ...(answer.ok ? {} : { code: answer.error.code }),
            requestId: answer.ok ? answer.requestId : answer.error.requestId,
          },
          'tool call',
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }], ...(answer.ok ? {} : { isError: true }) };
      },
    );
  }
  return server;
}
