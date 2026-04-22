export function asiText(run, keys, fallback = "") {
  if (!run?.asi) return fallback;
  for (const key of keys) {
    const value = run.asi[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return fallback;
}

export function asiPreview(run) {
  return asiText(run, ["next_action_hint", "hypothesis", "evidence", "rollback_reason"], "No ASI note");
}
