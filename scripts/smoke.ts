/**
 * End-to-end smoke test: spawns the real server over stdio via the MCP client,
 * lists tools, and exercises the main flows against a live ollama.
 *
 * Usage: node scripts/smoke.ts   (requires ollama running + a small model pulled)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "index.ts");

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text?: string }[])[0]?.text ?? "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text, _error: res.isError };
  }
};

async function main(): Promise<void> {
  if (!(await ollamaUp())) {
    console.log("ollama not reachable at localhost:11434 — skipping live smoke test");
    process.exit(0);
  }

  // Scratch workspace + config with allowed_roots.
  const work = mkdtempSync(join(tmpdir(), "openai-mcp-smoke-"));
  mkdirSync(join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs", "alpha.md"), "# Alpha\n\nAlpha handles user authentication via JWT tokens.\n");
  writeFileSync(join(work, "docs", "beta.md"), "# Beta\n\nBeta is the billing module. It invoices monthly.\n");
  writeFileSync(join(work, "data.txt"), "Contact: jane.doe@example.com, phone +1-555-0142\n");
  const cfgPath = join(work, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      providers: { local: { type: "ollama", base_url: "http://localhost:11434", default_model: "llama3.1:8b", num_ctx: 8192 } },
      allowed_roots: [work],
      limits: { num_ctx: 8192, max_steps: 8, agent_timeout_s: 90 },
    }),
  );

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      LOCAL_LLM_CONFIG: cfgPath,
      LOCAL_LLM_RUN_COMMAND: "1",
      LOCAL_LLM_DYNAMIC_TOOLS: "1",
    } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(transport);
  console.log("connected");

  section("tools advertised");
  const tools = await client.listTools();
  console.log(tools.tools.map((t) => t.name).join(", "));

  section("get_server_info");
  const info = await call(client, "get_server_info");
  console.log("providers:", JSON.stringify(info.providers));

  section("list_models");
  const models = await call(client, "list_models");
  console.log(JSON.stringify(models).slice(0, 400));

  section("get_system_resources");
  const res = await call(client, "get_system_resources");
  console.log(JSON.stringify(res).slice(0, 500));

  section("complete (tiny)");
  const comp = await call(client, "complete", { prompt: "Reply with exactly the word: PINEAPPLE", max_tokens: 10 });
  console.log("text:", JSON.stringify(comp.text));

  section("summarize (server-side file read)");
  const summ = await call(client, "summarize", { glob: join(work, "docs", "*.md") });
  console.log(JSON.stringify(summ.summaries).slice(0, 600));
  console.log("delegated_bytes:", summ.delegated_bytes);

  section("extract (schema)");
  const ext = await call(client, "extract", {
    path: join(work, "data.txt"),
    instruction: "extract email and phone",
    schema: { type: "object", required: ["email"], properties: { email: { type: "string" }, phone: { type: "string" } } },
  });
  console.log(JSON.stringify(ext.results));

  section("run_local_agent (delegated task)");
  const agent = await call(client, "run_local_agent", {
    task: `What do the docs in directory "${join(work, "docs")}" say each module does? Use read_file to check each file, then answer with one line per module.`,
    allowed_tools: ["list_dir", "read_file"],
    verify: "self",
  });
  console.log("answer:", JSON.stringify(agent.final_answer).slice(0, 500));
  console.log("steps:", (agent.steps as unknown[]).length, "verification:", JSON.stringify(agent.verification));

  section("propose_write + commit");
  const pw = await call(client, "propose_write", {
    path: join(work, "data.txt"),
    instruction: "Replace the phone number with REDACTED",
  });
  console.log("op:", pw.op_id, "kind:", pw.kind);
  console.log("diff:", String(pw.diff).slice(0, 400));
  const commit = await call(client, "commit_write", { op_id: pw.op_id });
  console.log("committed:", JSON.stringify(commit));
  console.log("file now:", readFileSync(join(work, "data.txt"), "utf-8").trim());
  if (existsSync(join(work, "data.txt"))) {
    const ok = readFileSync(join(work, "data.txt"), "utf-8").includes("REDACTED");
    console.log("REDACTED applied:", ok);
  }

  section("register_tool (js) + use in agent");
  await call(client, "register_tool", {
    name: "shout",
    description: "Uppercases the input text",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    kind: "js",
    body: "(args) => args.text.toUpperCase()",
  });
  const agent2 = await call(client, "run_local_agent", {
    task: 'Call the tool named "shout" with text "hello devin" and return its output verbatim.',
    allowed_tools: ["shout"],
    max_steps: 4,
  });
  console.log("agent with dynamic tool:", JSON.stringify(agent2.final_answer).slice(0, 300));

  section("get_usage_stats");
  const stats = await call(client, "get_usage_stats");
  console.log(JSON.stringify(stats.stats, null, 2).slice(0, 800));

  await client.close();
  console.log("\nsmoke test complete");
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
