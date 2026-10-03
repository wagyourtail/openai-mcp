import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { saveCommandWhitelist } from "../config.ts";
import { jsonResult } from "./helpers.ts";

export function registerWhitelistTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_command_whitelist",
    {
      description:
        "Show which commands the local agent's run_command tool may execute (argv-level whitelist, no shell).",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        enabled: ctx.config.command_whitelist.enabled,
        run_command_flag: ctx.env.runCommand,
        commands: ctx.config.command_whitelist.commands,
        note: "Entries with allow_args constrain argv[1] (e.g. git subcommands). Update via update_command_whitelist (writes server config file).",
      }),
  );

  server.registerTool(
    "update_command_whitelist",
    {
      description:
        "Add/remove commands the local agent may run. Writes the server config file — prefer " +
        "tight allow_args over broad access. This tool should stay in Devin's 'ask' permissions.",
      inputSchema: {
        add: z
          .array(
            z.object({
              name: z.string().describe("Command name (basename, e.g. 'rg' or 'git')"),
              allow_args: z
                .array(z.string())
                .nullable()
                .optional()
                .describe("If set, argv[1] must be one of these (e.g. ['status','diff']). null = any args."),
            }),
          )
          .optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    async ({ add, remove }) => {
      const commands = { ...ctx.config.command_whitelist.commands };
      for (const r of remove ?? []) delete commands[r];
      for (const a of add ?? []) {
        commands[a.name] = { allow_args: a.allow_args ?? null };
      }
      await saveCommandWhitelist(ctx.configPath, commands, ctx.config.command_whitelist.enabled);
      ctx.config.command_whitelist.commands = commands;
      return jsonResult({
        updated: true,
        added: (add ?? []).map((a) => a.name),
        removed: remove ?? [],
        commands: Object.keys(commands),
        config_path: ctx.configPath,
      });
    },
  );
}
