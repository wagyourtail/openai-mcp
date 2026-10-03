# openai-mcp

MCP server that offloads low-complexity work (summarize/extract/classify/map_files,
run_local_agent, staged writes, model management) to a local ollama or
OpenAI-compatible model. Entry point `src/index.ts` (deps preflight → `server.ts`).

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `node --test test/*.test.ts` (parsers tested against fixtures, no network)
- `npm run smoke` — end-to-end vs live ollama (needs `gemma4:e4b` or config default pulled)
- `npm run configure` — interactive installer (runs `npm install` if needed, registers with Devin)

## Dogfooding: use local_llm itself

The `local_llm` MCP server is expected to be registered in the session. When a task
fits its strengths, delegate instead of doing it in-context — that's the product:

- `summarize`/`map_files` for bulk file inspection; `extract`/`classify` for parsing
  chores; `complete` for drafting pure parsers/transforms; `run_local_agent` for
  mechanical multi-step file work.
- Don't delegate security-sensitive logic, GPU-identity matching, or anything where a
  plausible-but-wrong answer is worse than none — small models hallucinate. `verify:"self"`
  helps but does not guarantee correctness; always review delegated output.

## Conventions

- GPU identity is PCI bus id — never trust tool enumeration order
  (nvtop/DRM cardN/lspci orders differ). See `src/lib/sysinfo.ts`.
- Ollama env discovery falls back `/proc` → systemd unit → journal; report
  `env_source` rather than silently reporting no pinning.
- Read-only tools go in `ALLOW_TOOLS` in `scripts/configure.ts` + the README
  permissions block; anything that writes/deletes/pulls goes in `ASK_TOOLS`.
- Staged writes: nothing the local model writes reaches disk without `commit_write`.
