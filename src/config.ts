import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { NoloConfig } from "./types.js";

// --- Defaults ---

export const DEFAULT_SAFE_PREFIXES = [
  "cd",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",
  "grep",
  "rg",
  "fd",
  "tree",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whoami",
  "pwd",
  "echo",
  "date",
  "uname",
  "printenv",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "id",
  "hostname",
  "md5sum",
  "sha256sum",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git blame",
  "git ls-files",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "npm list",
  "npm outdated",
  "npm view",
  "node --version",
  "python --version",
  "cargo --version",
  "rustc --version",
  "go version",
  // shell built-ins used as no-ops or fallbacks
  "true",
  "false",
  ":",
  // common read-only pipeline filters
  "sort",
  "uniq",
  "cut",
  "tr",
  "sed",
  "jq",
  "column",
  "paste",
  "comm",
  "diff",
  "less",
  "more",
];

// Checked against the full command string before splitting.
// Catches constructs that are dangerous regardless of which command uses them.
export const DEFAULT_DANGEROUS_PATTERNS = [
  "`",          // backtick command substitution
  "\\$\\(",    // $() command substitution
  "\\brm\\b",
  "\\bsudo\\b",
  "\\beval\\b",
  "\\bsource\\b",
];

// Checked against each individual segment after splitting on shell operators.
// Catches dangerous flags or calls that appear within otherwise-safe commands.
// Keeping these per-segment avoids false positives such as \bsh\b matching
// a .sh filename in a git show or grep argument.
export const DEFAULT_SEGMENT_DANGEROUS_PATTERNS = [
  "^sh\\b",                            // sh used as a command
  "^bash\\b",                          // bash used as a command
  "^exec\\b",                          // exec shell builtin
  "[ \\t]-(?:exec|execdir|ok|delete)\\b", // find flags that run or delete
  "[ \\t]-(?:x|X)\\b",                   // fd -x/-X (exec)
  "[ \\t]--(?:exec|exec-batch)\\b",       // fd --exec/--exec-batch
  "\\bsystem\\s*\\(",                  // awk/sed system() call
];

// Per-prefix dangerous flags. These are checked only when a segment matches
// the given safe prefix, avoiding false positives on other commands.
// Patterns are tested against the segment string.
export const PREFIX_DANGEROUS_FLAGS: Record<string, RegExp[]> = {
  "git branch": [/\s-[dDmMcC]\b/],
  "git remote": [/\s(?:add|remove|rename|set-url)\b/],
  "git tag":    [/\s-[df]\b/],
  "sort":        [/\s-o\b/, /\s--output\b/],
};

// Matches stdout redirects (> or >>). Only 2> (stderr) is exempted; any other
// fd-prefixed or bare redirect is treated as a potential file write.
export const STDOUT_REDIRECT_RE = /(?<!2)>>?(?!&)/;

// --- Loader ---

function loadJsonFile(path: string): Partial<NoloConfig> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export interface LoadedConfig {
  safePrefixes: string[];
  dangerousRegexes: RegExp[];
  segmentDangerousRegexes: RegExp[];
}

export function loadConfig(): LoadedConfig {
  const globalPath = join(homedir(), ".pi", "agent", "nolo.json");
  const projectPath = join(".pi", "nolo.json");

  const globalCfg = loadJsonFile(globalPath);
  const projectCfg = loadJsonFile(projectPath);

  // Merge safe prefixes: union of defaults + global + project
  let safePrefixes = [...DEFAULT_SAFE_PREFIXES];
  if (globalCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...globalCfg.safePrefixes])];
  }
  if (projectCfg?.safePrefixes) {
    safePrefixes = [...new Set([...safePrefixes, ...projectCfg.safePrefixes])];
  }

  // Dangerous patterns: project overrides global overrides defaults
  let dangerousPatterns: string[] = DEFAULT_DANGEROUS_PATTERNS;
  if (globalCfg?.dangerousPatterns) dangerousPatterns = globalCfg.dangerousPatterns;
  if (projectCfg?.dangerousPatterns) dangerousPatterns = projectCfg.dangerousPatterns;

  // Segment dangerous patterns: same override semantics
  let segmentDangerousPatterns: string[] = DEFAULT_SEGMENT_DANGEROUS_PATTERNS;
  if (globalCfg?.segmentDangerousPatterns) {
    segmentDangerousPatterns = globalCfg.segmentDangerousPatterns;
  }
  if (projectCfg?.segmentDangerousPatterns) {
    segmentDangerousPatterns = projectCfg.segmentDangerousPatterns;
  }

  return {
    safePrefixes,
    dangerousRegexes: dangerousPatterns.map((p) => new RegExp(p)),
    segmentDangerousRegexes: segmentDangerousPatterns.map((p) => new RegExp(p)),
  };
}
