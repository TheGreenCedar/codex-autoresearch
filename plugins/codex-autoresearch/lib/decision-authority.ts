export interface DecisionAuthorityAction {
  kind?: unknown;
}

export function selectDecisionAuthority<
  TCanonical extends DecisionAuthorityAction,
  TBlocker extends DecisionAuthorityAction,
>(canonicalAction: TCanonical, blockerAction: TBlocker, blocked: boolean): TCanonical | TBlocker;
export function selectDecisionAuthority<
  TCanonical extends DecisionAuthorityAction,
  TBlocker extends DecisionAuthorityAction,
>(
  canonicalAction: TCanonical | null,
  blockerAction: TBlocker | null,
  blocked: boolean,
): TCanonical | TBlocker | null;
export function selectDecisionAuthority(
  canonicalAction: DecisionAuthorityAction | null,
  blockerAction: DecisionAuthorityAction | null,
  blocked: boolean,
): DecisionAuthorityAction | null {
  if (!blocked || !blockerAction) return canonicalAction || blockerAction;
  if (canonicalAction?.kind === "watchdog" && blockerAction.kind === "preflight") {
    return canonicalAction;
  }
  return blockerAction;
}
