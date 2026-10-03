import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "delegate",
    {
      title: "Delegate to local subagent",
      description:
        "Hand a low-complexity task to the local model via run_local_agent, then review any staged writes.",
      argsSchema: {
        task: z.string().describe("The task to delegate"),
        files: z.string().optional().describe("Relevant file paths (space/comma separated)"),
      },
    },
    ({ task, files }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Use the local_llm run_local_agent tool to complete this low-complexity task on the local model ` +
              `instead of doing it in your own context:\n\n${task}\n\n` +
              (files ? `Relevant files (pass these as the files param): ${files}\n\n` : "") +
              `After it returns: if staged_ops is non-empty, review each with get_diff, then commit_write the good ones and discard_write the rest. Report the outcome briefly.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "cheap_summary",
    {
      title: "Summarize via local model",
      description: "Summarize a file or directory glob without pulling its contents into context.",
      argsSchema: {
        path: z.string().describe("File path or glob pattern"),
        focus: z.string().optional().describe("What to focus on"),
      },
    },
    ({ path, focus }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Use the local_llm summarize tool (which reads files server-side so they don't enter context) ` +
              `on: ${path}` +
              (focus ? `\nFocus: ${focus}` : "") +
              `\nReturn the summaries to me.`,
          },
        },
      ],
    }),
  );
}
