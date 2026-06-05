# Research, Fanout, And Finalization Reference

Load this for broad product study, qualitative research, fanout lanes, or branch finalization.

## Deep Research

Use research loops for broad, qualitative, product-study, UX, architecture, or documentation prompts. Keep `sources.md` dated and claim-specific, write judgment in `synthesis.md`, filter hallucinations, then convert accepted findings into `quality-gaps.md`.

`quality_gap=0` closes the accepted checklist for the current round only. It does not prove discovery is complete.

## Fanout

Use `research-fanout --dry-run` when serial packets are burning time. Dispatch read-only scout lanes first. Implementation lanes need an explicit worktree or write scope before mutating commands run. Big-idea lanes are advice only and require human approval before measured packet work.

## Finalization

Run `finalize-preview` before branch creation. Current-tree finalization is for cases where the final branch contents are correct but old kept commits were corrected, reverted, or bundled with unkept support commits.

Runway order: preview, approve, create review branches, verify, merge into trunk, verify the merge, cleanup. Keep generated finalization artifacts until merge success. Do not suggest branch cleanup until merge verification has succeeded.
