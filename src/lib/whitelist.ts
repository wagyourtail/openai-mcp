import { execFile } from "node:child_process";

export interface WhitelistEntry {
  /**
   * If non-null, argv[1] must be one of these values (e.g. git -> ["status","log","diff"]).
   * null/undefined = any arguments allowed.
   */
  allow_args?: string[] | null;
}

export interface CommandWhitelist {
  enabled: boolean;
  commands: Record<string, WhitelistEntry>;
}

export function checkCommand(
  argv: string[],
  wl: CommandWhitelist,
): { ok: true } | { ok: false; reason: string } {
  if (!wl.enabled) return { ok: false, reason: "run_command is disabled in config" };
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: "argv must be a non-empty array" };
  }
  // Bare command names resolve via PATH (safe). An argv[0] containing a slash is
  // only allowed if the FULL absolute path is itself a whitelist key — otherwise
  // "/tmp/evil/rg" would match the "rg" entry and run arbitrary code.
  const cmd = argv[0];
  const isPath = cmd.includes("/");
  const entry = wl.commands[cmd];
  if (!entry) {
    return {
      ok: false,
      reason: isPath
        ? `command path "${cmd}" is not whitelisted (only bare names or exact absolute paths may be whitelisted)`
        : `"${cmd}" is not in the command whitelist`,
    };
  }
  if (isPath && !cmd.startsWith("/")) {
    return { ok: false, reason: `relative command paths like "${cmd}" are not allowed` };
  }
  if (entry.allow_args != null && argv.length > 1) {
    if (!entry.allow_args.includes(argv[1])) {
      return {
        ok: false,
        reason: `"${cmd} ${argv[1]}" not allowed — argv[1] must be one of: ${entry.allow_args.join(", ")}`,
      };
    }
  }
  if (entry.allow_args != null && argv.length === 1) {
    return { ok: false, reason: `"${cmd}" requires a subcommand, one of: ${entry.allow_args.join(", ")}` };
  }
  return { ok: true };
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Minimal env for child processes — secrets in the server env must not leak. */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TZ",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
];

export function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.LANG ??= "C.UTF-8";
  return env;
}

/**
 * Execute argv via execFile — NO SHELL. `;`, `&&`, `|`, `>` are just literal
 * arguments, so shell injection is structurally impossible. Runs with a
 * scrubbed environment (a whitelisted `env`/`jq -n 'env'` can't leak secrets).
 */
export function runWhitelisted(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; maxOutputChars: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxOutputChars * 4,
        env: safeEnv(),
      },
      (err, stdout, stderr) => {
        const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        resolve({
          ok: !err,
          stdout: stdout.slice(0, opts.maxOutputChars),
          stderr: stderr.slice(0, opts.maxOutputChars),
          code: typeof (err as { code?: number })?.code === "number" ? (err as { code: number }).code : err ? 1 : 0,
          timedOut,
        });
      },
    );
  });
}
