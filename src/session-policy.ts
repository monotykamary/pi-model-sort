// Model history is an interactive preference, not authority over worker runs.
export const isInteractiveModelSession = (mode: string | undefined, parentRun?: string): boolean =>
  mode === "tui" && !parentRun;

const SELECTION_FLAGS = new Set([
  "--model", "--provider", "--models", "--thinking",
  "--session", "--resume", "-r", "--continue", "-c", "--fork",
]);

export const shouldSelectMru = (
  mode: string | undefined,
  reason: string,
  argv: readonly string[],
  parentRun?: string,
): boolean => {
  if (!isInteractiveModelSession(mode, parentRun)) return false;
  if (reason !== "startup" && reason !== "new") return false;
  // Pi does not expose initial model provenance on ExtensionContext. Respect
  // explicit CLI selection/restoration, including --flag=value spellings.
  for (const arg of argv) {
    if (arg === "--") break;
    if (SELECTION_FLAGS.has(arg.split("=", 1)[0]!)) return false;
  }
  return true;
};
