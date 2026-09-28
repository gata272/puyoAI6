# Route Recovery Policy

## Purpose

The benchmark logs identified a recurring failure mode: the evaluator could retain
a long theoretical trigger route after the visible NEXT pieces could no longer
start or continue that route. The board then accumulated puyos until the normal
survival correction became too late to recover.

This change adds a small, state-aware recovery layer without replacing the normal
long-chain search objective.

## States

`CONNECTED` means a theoretical route of at least six links has a visible trigger
path of at least two steps. `WEAK` means the visible path is one step. `STALE`
means the route is at least six links long but the visible trigger path is zero
while measured safe moves are five or fewer. Three consecutive stale observations
become `ABANDON`.

The stale/abandon state is never rewarded. Positive recovery score comes only from
improving safe moves, improving the next safe horizon, visible follow-up chains,
or rebuild opportunities.

## Search integration

Normal long-chain construction remains the dominant objective. During pruning, recovery
candidates are reserved only inside the narrowing safety window; the reserve is a
diversity mechanism, not an unconditional score bonus.

At final selection, recovery is allowed to replace a stale/weak best candidate only
when another root has either reconnected the visible route or gained at least two
safe moves, while retaining productive chain/rebuild evidence unless the safety
improvement itself is substantial.

The current repository still keeps the existing 16-node active frontier cap.
The recovery change intentionally does not widen the beam yet; widening it is a
separate experiment because the benchmark history showed that changing pruning
and recovery at the same time makes regressions difficult to attribute.

## Diagnostics

The native AI can expose `routeRecovery`, `staleAge`, `recoveryScore`, and
`recoveryEscape` through the existing debug decision log. These fields are intended
to make future benchmark analysis distinguish route failure from ordinary height
pressure.

## Regression scope

This change deliberately does not add unknown-NEXT sampling, new virtual-chain
width features, or a new global phase-dependent score. Those are subsequent steps
and can be evaluated without conflating them with the route-recovery change.

## Visible NEXT reachability and runway reserve

The recovery layer now begins observing root candidates before the safety horizon
becomes critical when the board contains concrete trigger material. The visible
probe deliberately samples three categories of placements: immediate-chain moves,
low-risk landings, and quiet construction moves. This prevents the probe itself
from becoming biased toward premature firing.

A small 1-3 chain receives a limited cashout penalty only when all of the following
hold: the board still has at least seven safe next placements, the static route is
at least six links, and the visible next pieces expose no meaningful continuation.
The penalty disappears during REBUILD and is reduced when the visible path or a
substantial clearing opportunity provides evidence that the fire is useful.

When the current best root reaches six or fewer safe placements, the beam keeps one
alternative root with at least two additional safe placements when its visible route
and current chain value remain close. This is a reserve only; it does not add a
positive score to the safer root.
