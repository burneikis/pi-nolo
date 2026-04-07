import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { NoloConfig } from "./types.js";

// --- Defaults ---

export const DEFAULT_SAFE_PREFIXES = [
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
  "env",
  "printenv",
  "git status",
  "git log",
  "git diff",
  "git show",
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
];

export const DEFAULT_DANGEROUS_PATTERNS = [
  "\\|",
  "&&",
  "\\|\\|",
  ";",
  "`",
  "\\$\\(",
  ">\\s",
  ">>",
  "\\brm\\b",
  "\\bsudo\\b",
  "\\beval\\b",
  "\\bexec\\b",
  "\\bsource\\b",
  "\\bsh\\b",
  "\\bbash\\b",
];

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
  let dangerousPatterns = DEFAULT_DANGEROUS_PATTERNS;
  if (globalCfg?.dangerousPatterns) dangerousPatterns = globalCfg.dangerousPatterns;
  if (projectCfg?.dangerousPatterns) dangerousPatterns = projectCfg.dangerousPatterns;

  return {
    safePrefixes,
    dangerousRegexes: dangerousPatterns.map((p) => new RegExp(p)),
  };
}
