function matches(pattern: string, value: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -2);
    return value.startsWith(prefix);
  }

  if (pattern === "**") {
    return true;
  }

  return pattern === value;
}

export function evaluatePathPolicy(input: {
  changedFiles: string[];
  allowlistPaths: string[];
  denylistPaths: string[];
  maxFilesTouched: number;
}): { allowed: boolean; humanGateHit: boolean; reason: string | null } {
  if (input.changedFiles.length > input.maxFilesTouched) {
    return { allowed: false, humanGateHit: true, reason: `max files exceeded: ${input.changedFiles.length}` };
  }

  for (const file of input.changedFiles) {
    if (input.denylistPaths.some((pattern) => matches(pattern, file))) {
      return { allowed: false, humanGateHit: true, reason: `denylist match: ${file}` };
    }
  }

  if (input.allowlistPaths.length > 0) {
    for (const file of input.changedFiles) {
      if (!input.allowlistPaths.some((pattern) => matches(pattern, file))) {
        return { allowed: false, humanGateHit: true, reason: `allowlist miss: ${file}` };
      }
    }
  }

  return { allowed: true, humanGateHit: false, reason: null };
}
