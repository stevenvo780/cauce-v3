# `liveness.ts` — why, not just what

The comments in `liveness.ts` were trimmed to fit the repo's comment-density gate
(`scripts/calidad.mjs`). This file keeps the full prose that was cut, so the reasoning behind each
check is not lost — only moved.

## `PasteSessionLivenessRunner` (class)

What the PANE says about the generation, as opposed to what the transcript file says.

Both answers this layer gives come from one capture read with the same detectors the arbiter uses
before pasting, and both fail closed: a capture that could not be taken is never evidence of life
and never evidence of health.

## `paneStillGenerating`

The pane is still generating, so a merged turn is alive however quiet the transcript is.

`lastActivityAt` only sees the transcript FILE grow, and one uninterrupted extended-thinking or
tool block writes nothing for longer than the silence window. Silence on disk is not death. An
unreadable capture returns false, so a dead pane still falls through to the release path: the
genuinely lost paste must keep coming out as ambiguous.

## `paneIsIdle`

A modal, a blank pane or an unsent `[Pasted text …]` all count as occupied: any of them could be
OUR lost paste still sitting in the box, and pasting would concatenate onto it.

## `healCurrentQuarantine`

Lifts the quarantine of a generation that is STILL alive and proves it is healthy.

Until now a quarantine only lifted when the pane generation CHANGED (`stale`), i.e. when a person
respawned the TUI. Inside one live generation it was permanent, so every delivery after it came out
as `session_identity_unverified` and the shared conversation stopped receiving anything. That is
what stranded heraclito for hours.

The evidence demanded is direct and current: the SAME generation is still there, it is not painting
its "generating" band, and its input box is a free, empty prompt. Together they say no turn is in
flight, which is the only thing the quarantine was protecting against.

It CANNOT execute a delivery twice. The one that armed this quarantine already ended AMBIGUOUS and
is never resent from here; the invariant "No degrade — that would execute twice" governs that
delivery's own turn in `harvest` and is untouched. What is released is the pane, for the NEXT
delivery.

Fail-closed at every step: an unreadable capture, a marker of another generation, a marker that
cannot be read or times out, a pending this process did not arm, or a tmux clear that does not
credit its postcondition — each of them preserves the quarantine.

## `releaseDurableQuarantine`

Removes the on-disk marks of this generation, or none at all.

A pending of THIS generation that this process did not arm belongs to a commit whose terminal
boundary nobody observed — typically an adapter that died mid-turn — and only the envelope proof of
`reconcileTerminalPending` discharges it. It is checked BEFORE the canonical marker is touched:
clearing half of the barrier would leave the generation with no barrier at all.

The aggregate check at the end (canonical + sidecars + half-written `.tmp`) exists because anything
still crediting this generation keeps the quarantine, whatever the individual reads above said.
