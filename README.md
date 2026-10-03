# openai-mcp — a local subagent for Devin

An MCP server that lets Devin offload **low-complexity, monotonous work** to a cheap local model
(Ollama by default, or any OpenAI-compatible endpoint) instead of burning frontier tokens on it.

The headline feature is `run_local_agent`: the small model runs its **own tool loop server-side**
(read/search files, run whitelisted commands, stage writes). File contents and intermediate steps
never enter Devin's context — only a compact final answer comes back. Think of it as a local,
free-tier version of Devin's cloud subagents.

## Why it actually saves tokens

- **Server-side file I/O.** `summarize`, `extract`, `map_files`, and `run_local_agent` take
  paths/globs and read files inside the server process. A 200KB file summarized this way costs
  Devin ~500 tokens instead of ~60k.
- **Compact results.** Tool results, diffs, and agent steps are truncated/capped before returning.
- **Visible savings.** Every response reports `usage` and `delegated_bytes` — bytes processed
  that never entered Devin's context. `get_usage_stats` totals it for the session.

## Requirements

- Node **>= 22.18** (runs TypeScript natively — no build step). Verified on Node 26.
- Ollama (`ollama serve`) for the default provider, or any OpenAI-compatible `/v1` endpoint.
- `rg` (ripgrep) if you want `search_files`.

## Setup

### 1. Server config

```bash
npm run configure     # interactive wizard: probes ollama, writes ~/.config/openai-mcp/config.json,
                      # prints the Devin registration JSON
# or: cp config.example.json ~/.config/openai-mcp/config.json  (edit by hand)
```

**File roots are auto-detected.** Effective roots = `allowed_roots` (config) ∪ workspace roots the
MCP client advertises (the spec's `roots` capability) ∪ the directory Devin spawned the server from
(= your project dir, controlled by `trust_cwd: true`). So file tools work out of the box inside the
project, and `allowed_roots` is for *extra* directories outside it. `deny_globs` blocks secrets
everywhere. `get_server_info` shows each root with its source.

### 2. Register with Devin

**Devin settings → MCP → Add custom MCP** (or edit `~/.config/devin/mcp_config.json`):

```json
{
  "mcpServers": {
    "local_llm": {
      "command": "node",
      "args": ["/home/william/Documents/openai-mcp/src/index.ts"],
      "env": {
        "LOCAL_LLM_CONFIG": "/home/william/.config/openai-mcp/config.json",
        "LOCAL_LLM_RUN_COMMAND": "1",
        "LOCAL_LLM_DYNAMIC_TOOLS": "1"
      }
    }
  }
}
```

CLI equivalent: `devin mcp add -s user local_llm -- node /home/william/Documents/openai-mcp/src/index.ts`

Omit the two `LOCAL_LLM_*` env flags to disable shell access and dynamic tools entirely.

### 3. Recommended Devin permissions

In `~/.config/devin/config.json`:

```json
{
  "permissions": {
    "allow": ["mcp__local_llm__chat", "mcp__local_llm__complete", "mcp__local_llm__summarize",
              "mcp__local_llm__extract", "mcp__local_llm__classify", "mcp__local_llm__map_files",
              "mcp__local_llm__run_local_agent", "mcp__local_llm__list_models",
              "mcp__local_llm__get_system_resources", "mcp__local_llm__list_staged",
              "mcp__local_llm__get_diff", "mcp__local_llm__discard_write",
              "mcp__local_llm__get_usage_stats", "mcp__local_llm__list_dynamic_tools",
              "mcp__local_llm__get_command_whitelist", "mcp__local_llm__get_job",
              "mcp__local_llm__list_jobs", "mcp__local_llm__get_server_info",
              "mcp__local_llm__propose_write", "mcp__local_llm__list_commits",
              "mcp__local_llm__revert_write"],
    "ask":   ["mcp__local_llm__commit_write", "mcp__local_llm__pull_model",
              "mcp__local_llm__download_model",
              "mcp__local_llm__register_tool", "mcp__local_llm__update_command_whitelist",
              "mcp__local_llm__unload_model"]
  }
}
```

`ask` = you get an approve button before writes hit disk, models download, or new tools register.

## Tools

| Tool | What it does |
|---|---|
| `run_local_agent` | **Local subagent.** Small model runs its own tool loop; returns final answer + staged op ids. `verify:"self"` adds a critique pass. `run_async:true` runs it as a background job (poll `get_job`). |
| `chat` / `complete` | Raw completions passthrough. |
| `summarize` | Summarize files/globs server-side; only summaries return. |
| `extract` | Structured JSON extraction, optional schema validation + retry. |
| `classify` | Label text/files into candidate labels. |
| `map_files` | Apply one instruction across a glob — `report` results or `stage_writes` for review. |
| `propose_write` | Local model rewrites/creates one file → staged diff. |
| `list_staged` / `get_diff` / `commit_write` / `discard_write` | Staged-write lifecycle. **Nothing the local model writes reaches disk without `commit_write`.** Commit refuses if the file drifted since staging (`force=true` overrides). |
| `list_commits` / `revert_write` | Undo: `revert_write(commit_id)` stages a revert op restoring pre-commit content. |
| `list_models` | Models per provider (sizes, capabilities). |
| `get_system_resources` | RAM + VRAM + loaded models (local ollama only). |
| `pull_model` | Download a model on ollama — background job, poll `get_job`. |
| `download_model` | Download from Hugging Face via `hf` CLI (for llama.cpp/TabbyAPI/vLLM servers). Background job. |
| `unload_model` | Free a model's VRAM. |
| `register_tool` / `unregister_tool` / `list_dynamic_tools` | Give the local agent new tools at runtime (`shell` templates or `js` snippets). |
| `get_command_whitelist` / `update_command_whitelist` | Manage what `run_command` may execute. |
| `get_usage_stats` / `get_server_info` | Session savings + effective config. |

Slash commands (MCP prompts): `/mcp__local_llm__delegate <task> [files]` and `/mcp__local_llm__cheap_summary <path> [focus]`.

## Progress

Two free/cheap progress channels:
- **MCP `notifications/progress`**: `run_local_agent` reports each agent step and `map_files`
  reports per-file completion — *if* the client attaches a `progressToken`. These go to client UI
  plumbing, **not into the model context — zero token cost.**
- **Job polling**: `run_async:true` on `run_local_agent` (and `pull_model`/`download_model`) returns
  a `job_id`; `get_job` shows live progress + the final `result`. Polling costs a few tokens per
  call, but only when Devin chooses to check.

## Safety model

- **Staged writes**: local-model output lands in a review queue, never directly on disk. Devin (or you,
  via the `ask` permission) reviews `get_diff` before `commit_write` (atomic tmp+rename).
- **`run_command`**: whitelist-only, executed via `execFile` argv — **no shell**, so `;`, `&&`, `|`, `>`
  are literal arguments and can't inject. `allow_args` constrains subcommands (e.g. git → read-only verbs).
- **File scope**: union of configured `allowed_roots` + MCP-advertised workspace roots + cwd
  (disable with `trust_cwd: false`), minus `deny_globs` for secrets.
- **VRAM**: ollama calls set `num_ctx` explicitly (default 16384) — an unbounded context blew up the
  KV-cache allocation on a 16GB GPU. `get_system_resources` + `unload_model` help manage memory.
- **Honesty**: the instructions tell Devin *not* to delegate anything where a plausible-but-wrong answer
  is worse than no answer. 8B models produce garbage sometimes — `verify:"self"` and staged diffs
  are the mitigations, not a guarantee.

## Provider config

Two types:
- `ollama` → native `/api` (chat with `num_ctx`/`keep_alive`/tools, pull, ps, unload). Local or remote.
- `openai` → generic `/v1` (chat completions, list models). Works with LM Studio, vLLM, llama.cpp,
  OpenAI proper (`api_key_env` references an env var — never store keys in the file).

Quick single-provider env mode (no config file): `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_API_KEY_ENV`,
`LOCAL_LLM_MODEL`, `LOCAL_LLM_PROVIDER_TYPE`.

### llama.cpp / exllamav3 / vLLM

These already work — their servers (`llama-server`, TabbyAPI, vLLM) all expose an
OpenAI-compatible `/v1`, so just add `type: "openai"` provider entries:

```json
"llamacpp": { "type": "openai", "base_url": "http://localhost:8080/v1", "default_model": "local-model" },
"tabby":    { "type": "openai", "base_url": "http://localhost:5000/v1", "api_key_env": "TABBY_API_KEY" }
```

What you lose vs. `ollama`-type providers: no `num_ctx` control (llama.cpp uses `-c` at launch),
no `pull`/`ps`/`unload` management, and no system-resources introspection for remote hosts.
`download_model` fills the acquisition gap — it runs `hf download` as a job (requires the `hf` CLI
from `huggingface_hub`). Note `llama-server` can't hot-load a downloaded GGUF without a restart;
TabbyAPI can load via its own admin endpoints.

## Dev

```bash
npm install
npm test            # unit tests (node:test)
npm run smoke       # end-to-end: spawns server, hits real ollama
npm run build       # optional: emit dist/ for node<22.18 or distribution
node src/index.ts   # run the server standalone (stdin MCP)
```
