import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { jsonResult } from "./helpers.ts";
import {
  dynamicEnabled,
  listDynamicTools,
  loadPersistedTools,
  persistTools,
  registerDynamicTool,
  unregisterDynamicTool,
  validateDynamicTool,
  type DynamicTool,
} from "../lib/dynamic-tools.ts";
import { dynamicToolsPath } from "../config.ts";

export function registerDynamicToolTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "register_tool",
    {
      description:
        "Register a NEW tool that the local model can call during run_local_agent (persists for this " +
        "server session; persist=true saves it across restarts). kind='shell': an executable + argv " +
        "template with ${param} placeholders (execFile, no shell). kind='js': a JS function body run in " +
        "node:vm as (body)(args). Requires LOCAL_LLM_DYNAMIC_TOOLS=1 on the server.",
      inputSchema: {
        name: z.string().describe("Tool name, ^[a-zA-Z0-9_-]{1,64}$"),
        description: z.string().describe("What it does — the local model picks tools by this text"),
        input_schema: z
          .record(z.string(), z.unknown())
          .describe("JSON Schema object for the parameters (type:'object', properties, required)"),
        kind: z.enum(["shell", "js"]),
        command: z.string().optional().describe("shell kind: executable name/path"),
        args_template: z
          .array(z.string())
          .optional()
          .describe('shell kind: argv template, e.g. ["--format", "${fmt}", "${input}"]'),
        body: z.string().optional().describe("js kind: function source, e.g. '(args) => args.a + args.b'"),
        persist: z.boolean().optional().describe("Save to dynamic_tools.json so it survives restarts"),
      },
    },
    async ({ name, description, input_schema, kind, command, args_template, body, persist }) => {
      const spec: DynamicTool = {
        name,
        description,
        input_schema,
        kind,
        command,
        args_template,
        body,
        persist: persist ?? false,
        created_at: new Date().toISOString(),
      };
      const check = validateDynamicTool(spec);
      if (!check.ok) throw new Error(check.reason);
      registerDynamicTool(spec);
      if (spec.persist) await persistTools(dynamicToolsPath());
      return jsonResult({
        registered: name,
        kind,
        persist: spec.persist,
        note: "Now available to the local model inside run_local_agent (and listed via list_dynamic_tools).",
      });
    },
  );

  server.registerTool(
    "unregister_tool",
    {
      description: "Remove a runtime-registered dynamic tool.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const removed = unregisterDynamicTool(name);
      if (removed) await persistTools(dynamicToolsPath()).catch(() => {});
      return jsonResult({ removed });
    },
  );

  server.registerTool(
    "list_dynamic_tools",
    {
      description: "List runtime-registered tools available to the local agent.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        enabled: dynamicEnabled(),
        tools: listDynamicTools().map(({ name, description, kind, input_schema, persist }) => ({
          name,
          description,
          kind,
          input_schema,
          persist,
        })),
      }),
  );
}

/** Call at startup: load persisted dynamic tools (only when the feature flag is on). */
export function loadPersistedDynamicTools(): number {
  if (!dynamicEnabled()) return 0;
  return loadPersistedTools(dynamicToolsPath());
}
