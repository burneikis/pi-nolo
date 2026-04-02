/**
 * Determines whether a bash command is safe to auto-approve.
 * A command is safe if it matches a known safe prefix AND contains no dangerous patterns.
 */
export function isSafeCommand(
  command: string,
  safePrefixes: string[],
  dangerousRegexes: RegExp[],
): boolean {
  const trimmed = command.trim();

  // Dangerous patterns take priority — any match means unsafe
  for (const re of dangerousRegexes) {
    if (re.test(trimmed)) return false;
  }

  // Must match a safe prefix
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
