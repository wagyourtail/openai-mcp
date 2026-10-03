#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { buildContext } from "./context.ts";
import { registerCompletionTools } from "./tools/completions.ts";
import { registerFileTaskTools } from "./tools/filetasks.ts";
import { registerDelegateTools } from "./tools/delegate.ts";
import { registerWriteTools } from "./tools/writes.ts";
import { registerManageTools } from "./tools/manage.ts";
import { registerDynamicToolTools, loadPersistedDynamicTools } from "./tools/dynamic.ts";
import { registerWhitelistTools } from "./tools/whitelist.ts";
import { registerPrompts } from "./prompts.ts";
import { setRequestTimeout } from "./tools/helpers.ts";

const INSTRUCTIONS = `local_llm is a LOCAL SUBAGENT service: its tools run on a cheap local model
(default Ollama) so YOU don't spend expensive tokens on low-complexity work.

When to use it:
- Mechanical/monotonous work: summarizing, extracting, classifying, reformatting,
  boilerplate, simple rewrites, batch transforms over many files.
- Bulk file inspection: file contents are read SERVER-SIDE and never enter your
  context — only compact results come back (check delegated_bytes in responses).
- run_local_agent delegates a whole task: the local model runs its own tool loop
  (read/search/stage_write/whitelisted commands) and returns only a final answer.

When NOT to use it: real reasoning, security-sensitive changes, architecture
decisions, or anything where a wrong answer is worse than no answer — small models
produce plausible garbage sometimes. Use verify:"self" for a second-pass check.

PRAGMATIC WRITE WORKFLOW:
- Default write_mode is "propose": nothing reaches disk. You review get_diff and
  apply the change with YOUR OWN edit tools. Best for consequential changes —
  the diff tokens are a fair price for keeping your native review flow.
- For bulk mechanical batches (map_files over many files), propose mode forces
  you to re-write every file — expensive. Instead: set_write_mode("write") for
  the batch (it belongs in ask-permissions), review a SAMPLE of diffs with
  get_diff, commit_write the batch, then revert_write anything bad. Set it back
  to "propose" when done.
- Long delegations: sync calls that outlast agent_sync_grace_ms return a job_id
  (poll get_job) instead of losing the result; run_async:true skips the wait.
  Steer with control_job — inject corrections mid-flight, pause, or cancel.

INPUT-SIZING:
- Prefer \`paths\` (agent reads on demand) over \`files\` (inlined) for anything
  large or numerous — the small model's context is small; context_warning will
  tell you when you've blown it.
- Pick model by fit: code transforms -> a coder model, general text -> instruct
  models. list_models + get_system_resources tell you what fits VRAM.

Safety model: local-model writes are staged ops only; run_command is
whitelist-only argv-exec (no shell); file access limited to detected+configured
roots; dynamic tools + run_command need env flags.

Workflow hint: call get_server_info first to see providers/roots/flags/mode, and
get_usage_stats at the end of a session to see what you saved.`;

async function main(): Promise<void> {
  const ctx = buildContext();
  setRequestTimeout(ctx.config.limits.request_timeout_s * 1000);
  const loaded = loadPersistedDynamicTools();

  const server = new McpServer(
    { name: "local_llm", version: "0.1.0" },
    {
      instructions: INSTRUCTIONS,
      capabilities: { tools: {}, prompts: {} },
    },
  );

  registerCompletionTools(server, ctx);
  registerFileTaskTools(server, ctx);
  registerDelegateTools(server, ctx);
  registerWriteTools(server, ctx);
  registerManageTools(server, ctx);
  registerDynamicToolTools(server, ctx);
  registerWhitelistTools(server, ctx);
  registerPrompts(server);

  // Root detection: cwd (the project dir Devin spawned us from) unless disabled.
  if (ctx.config.trust_cwd) ctx.guard.addRoot(process.cwd(), "cwd");

  await server.connect(new StdioServerTransport());

  // MCP roots capability: if the client advertises workspace roots, add them and
  // keep them in sync via roots/list_changed.
  const clientCaps = server.server.getClientCapabilities() as { roots?: unknown } | undefined;
  if (clientCaps?.roots) {
    const refreshRoots = async (): Promise<void> => {
      try {
        const { roots } = await server.server.listRoots();
        ctx.guard.setRootsForSource(
          "mcp-roots",
          roots
            .filter((r) => r.uri.startsWith("file://"))
            .map((r) => fileURLToPath(r.uri)),
        );
        console.error(`local_llm: mcp roots -> ${ctx.guard.rootList.join(", ")}`);
      } catch (e) {
        console.error("local_llm: roots refresh failed:", e instanceof Error ? e.message : e);
      }
    };
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      void refreshRoots();
    });
    await refreshRoots();
  }

  // Server logs must go to stderr — stdout is the protocol channel.
  console.error(
    `local_llm ready: providers=[${ctx.providers.names().join(", ")}] ` +
      `roots=[${ctx.guard.rootDetails.map((r) => `${r.path}(${r.source})`).join(", ")}] ` +
      `dynamic=${ctx.env.dynamicTools}(${loaded} loaded) run_command=${ctx.env.runCommand}`,
  );
}

main().catch((e) => {
  console.error("local_llm fatal:", e);
  process.exit(1);
});
