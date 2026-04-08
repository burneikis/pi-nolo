import { STDOUT_REDIRECT_RE, PREFIX_DANGEROUS_FLAGS } from "./config.js";

// --- xargs command extractor ---

// xargs flags that consume the next token as their argument.
const XARGS_FLAGS_WITH_ARGS = new Set([
  "-n", "-P", "-I", "-L", "-d", "-a",
  "--max-args", "--max-procs", "--replace", "--max-lines",
  "--delimiter", "--arg-file",
]);

/**
 * Given a segment that starts with "xargs", return the command xargs will run
 * (i.e. the first non-flag token after xargs and its own flags), or null if
 * xargs is being called with no explicit command (uses echo by default, safe).
 */
export function getXargsCommand(segment: string): string | null {
  const rest = segment.slice("xargs".length).trim();
  if (!rest) return null;
  const tokens = rest.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) break;
    // Flags like -n1 or -P4 embed their argument -- no extra token to skip.
    // Flags like -n 1 or -I {} consume the next token.
    const bare = tok.split("=")[0]; // handle --flag=value form
    if (XARGS_FLAGS_WITH_ARGS.has(bare) && !tok.includes("=")) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return i < tokens.length ? tokens[i] : null;
}

// --- Quote-aware shell operator splitter ---

/**
 * Splits a command on |, ||, &&, and ; but ignores operators that appear
 * inside single or double quoted strings. This prevents false splits on
 * grep patterns like "foo\|bar" or awk programs like '{print $1|"sort"}'.
 */
export function splitOnShellOperators(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
    } else if (!inSingle && !inDouble) {
      if (command.startsWith("||", i)) {
        segments.push(current);
        current = "";
        i += 2;
      } else if (command.startsWith("&&", i)) {
        segments.push(current);
        current = "";
        i += 2;
      } else if (ch === "|" || ch === ";") {
        segments.push(current);
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }

  if (current) segments.push(current);
  return segments;
}

// --- Safety check ---

/**
 * Returns true if the command is considered safe (read-only) and should be
 * auto-approved without user confirmation.
 *
 * A command is safe when every segment (split on |, &&, ||, ;) starts with a
 * known safe prefix and the command contains no stdout redirects or unsafe
 * constructs. Two layers of dangerous-pattern checks are applied:
 *   global  -- checked on the full command string (backticks, $(), rm, sudo, eval, source)
 *   segment -- checked per segment (sh/bash as commands, find -exec/-delete, system() calls)
 * Stderr redirects such as 2>/dev/null are allowed.
 */
export function isSafeCommand(
  command: string,
  safePrefixes: string[],
  dangerousRegexes: RegExp[],
  segmentDangerousRegexes: RegExp[],
): boolean {
  const trimmed = command.trim();

  // Global check: constructs dangerous regardless of context.
  for (const re of dangerousRegexes) {
    if (re.test(trimmed)) return false;
  }

  // Block stdout redirects (writes to files). Only 2> (stderr) is exempted.
  if (STDOUT_REDIRECT_RE.test(trimmed)) return false;

  // Split compound commands on shell operators and verify every segment
  // individually. A compound read-only command like
  //   ls foo && cat bar | head -20 2>/dev/null
  // is safe as long as each segment (ls, cat, head) is a safe prefix.
  const segments = splitOnShellOperators(trimmed);
  if (segments.every((s) => !s.trim())) return false;

  for (const segment of segments) {
    // Strip fd/stderr redirects (e.g. 2>/dev/null, 2>&1) before checks.
    const clean = segment.replace(/\s+\d*>(?:&\d+|\S*)/g, "").trim();
    if (!clean) continue;

    // Segment check: dangerous flags or calls within otherwise-safe commands.
    // Applied here (not globally) to avoid false positives on filenames and
    // arguments -- e.g. \bsh\b would fire on deploy.sh in a git show argument.
    for (const re of segmentDangerousRegexes) {
      if (re.test(clean)) return false;
    }

    let matched = false;

    // xargs is allowed when the command it runs is itself a safe prefix.
    if (clean === "xargs" || clean.startsWith("xargs ")) {
      const sub = getXargsCommand(clean);
      // No explicit command means xargs uses echo -- safe.
      if (sub === null) {
        matched = true;
      } else {
        for (const prefix of safePrefixes) {
          if (sub === prefix || sub.startsWith(prefix + " ")) {
            matched = true;
            break;
          }
        }
      }
    }

    if (!matched) {
      for (const prefix of safePrefixes) {
        if (
          clean === prefix ||
          clean.startsWith(prefix + " ") ||
          clean.startsWith(prefix + "\n")
        ) {
          // Check prefix-specific dangerous flags before accepting
          const flags = PREFIX_DANGEROUS_FLAGS[prefix];
          if (flags?.some((re) => re.test(clean))) return false;
          matched = true;
          break;
        }
      }
    }

    if (!matched) return false;
  }

  return true;
}
