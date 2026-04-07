/**
 * Returns true if the command is considered safe (read-only) and should be
 * auto-approved without user confirmation.
 */
export function isSafeCommand(
  command: string,
  safePrefixes: string[],
  dangerousRegexes: RegExp[],
): boolean {
  const trimmed = command.trim();

  // Dangerous patterns take priority — any match → unsafe
  for (const re of dangerousRegexes) {
    if (re.test(trimmed)) return false;
  }

  // Safe if it starts with (or exactly matches) a known safe prefix
  for (const prefix of safePrefixes) {
    if (
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.startsWith(prefix + "\n")
    ) {
      return true;
    }
  }

  return false;
}
