# Pipeline engine specification

Normative behaviour for the Pipeline engine. It supersedes the rule sketches in `PLAN.md`, which
remain the source of the rule IDs. Rule IDs **R1**–**R15** are preserved so golden scenarios can
declare coverage.

Key words **MUST**, **MUST NOT**, **SHOULD** and **MAY** carry their usual force. Text marked
**[Decision]** is a design choice made for this specification, not something the plan stated or the
spikes observed. Text marked **[Unverified]** describes a mechanism no local evidence supports yet.

## 1. Definitions

- **Run** — one execution of one pipeline against one task. It has a `run_id`, a run folder, an
  append-only `events.jsonl`, and exactly one terminal state.
- **Node** — a vertex of the pipeline. Types: `agent`, `gate`, `end`.
- **Turn** — one prompt to an agent, or one execution of a gate, from submission until the engine
  establishes a result for it. A turn belongs to exactly one node entry.
- **Outcome** — the result of a turn, drawn from the ports its node type defines. Agent without
  `verdict`: `done`. Agent with `verdict`: `approve`, `revise`. Gate: `pass`, `fail`. An `end` node
  has no ports and produces no outcome.
- **Port / edge** — a port is an outcome a node can produce; an edge connects a port to a target
  node.
- **Round** — a positive integer counting entries into the `start` node (§R2).
- **Run states** — `running`, `paused`, `done`, `stopped`. `done` and `stopped` are **terminal**:
  once entered, the engine MUST NOT emit further run-log events, send prompts, run gates, or route.
  `paused` is not terminal; it is the state an escalation produces (§R10).
- **Escalation reasons** — exactly `blocked`, `timeout`, `missing_verdict`, `max_rounds`,
  `guard_violation`, `unrouted`. No others exist.

## 2. Rules

### R1 — Start

A run begins at the pipeline's `start` node with `round = 1`. The first prompt sent to the start
node MUST contain the task. `run_started` is the first event of every run. `node_started` for the
start node with `round: 1` is the second event **unless the run reaches a terminal state first** —
a stop accepted before the first entry makes `run_finished` the second event and no entry begins
(§3).

### R2 — Rounds

Every entry into the `start` node after the first, from any edge, increases the round by one. Nodes
other than `start` do not change the round; they carry the round of the entry that reached them, and
report it in their events.

### R3 — Round limit

**[Decision]** Entry into the start node is evaluated as: compute the _candidate_ round (current
round + 1), compare it with the **effective limit**, and only then accept the entry and store the
new round. The effective limit is `max_rounds` plus the cumulative total of any extra-round grants
(§R12); with no grants it is `max_rounds`.

If the candidate round exceeds the effective limit, the engine MUST escalate `max_rounds` **before** any
prompt is sent and before `node_started` is emitted for that entry. The stored round MUST remain the
last accepted value. The refused entry MUST be retained as the run's _pending entry_ so that a grant
of extra rounds can resume exactly that entry (§R12).

`max_rounds: 5` with no grants therefore permits five prompts to the start node; the attempted entry
into round 6 escalates.

### R4 — Agent turns

The engine sends a prompt and waits for the runtime to report a result for **that turn** (§R5,
ownership). Then:

- Result `idle` or `done`, with turn-attributable output available → the outcome is decided by R5.
- Result `blocked` → escalate `blocked`.
- No result established within `turn_timeout` → escalate `timeout`.

A settled lifecycle state is **not** sufficient on its own. `idle`/`done`, a zero exit status from
the runtime CLI, pane occupancy, and an advancing lifecycle counter each fail to establish that the
submitted prompt completed (§7). The engine MUST treat a turn as complete only when the runtime
supplies output attributable to that turn.

### R5 — Agent outcomes

An agent node without `verdict` produces `done`.

An agent node with `verdict: true` produces the outcome named by the last verdict line **in text
attributable to the current turn**: `approve` or `revise`. If the turn is established as complete
and the attributable text contains no verdict line, the engine MUST escalate `missing_verdict`.

**Verdict line syntax.** A line of the turn-scoped text is a verdict line when, and only when, both
steps below succeed. The parser performs both; it MUST NOT assume the runtime has normalised
anything beyond supplying turn-scoped text.

1. **Strip decoration from both ends** of the line: horizontal whitespace (space, tab) and the
   decoration characters `•`, `⏺`, `❯`, `›`, `└`, `⎿`, `|`, and any character in the box-drawing
   block U+2500–U+257F. Stripping is applied only at the ends, never inside.
2. **Match the remainder exactly** against `VERDICT:` followed by zero or more spaces or tabs,
   followed by `APPROVE` or `REVISE`, and nothing further.

Consequences, stated so they cannot be read either way:

- Matching is **case-sensitive**: `verdict: approve` is not a verdict line.
- `VERDICT:APPROVE`, `VERDICT: APPROVE`, `VERDICT:   APPROVE` and `VERDICT:\tAPPROVE` are all valid;
  the separator may be empty.
- Internal whitespace is not otherwise flexible: `VERDICT : APPROVE` is **not** valid, because the
  space precedes the colon and the remainder therefore does not match.
- Any character surviving step 1 other than that exact sequence disqualifies the line — quotation
  marks, a full stop, or any further word. So the echoed instruction
  `'  "VERDICT: APPROVE" or "VERDICT: REVISE".'` fails, on the leading quotation mark and on the
  trailing text, and a mid-sentence mention never matches.

Decoration stripping is deliberately the **parser's** responsibility, matching `PLAN.md` step 08,
which requires its tests to cover box-drawing characters and bullet prefixes around the line. No
runtime normalisation is assumed to exist. Captured reviews show the accepted form as
`"  VERDICT: APPROVE"` (`packages/core/test/fixtures/agent-output/`).

If more than one verdict line appears in the turn-scoped text, the **last** one decides the outcome.

**Verdict ownership.** The runtime MUST supply turn-scoped text before the parser may accept a
verdict from it. The parser MUST NOT take the last matching line from a shared, unbounded capture.
This specification deliberately does **not** mandate the mechanism: a plain scrollback row offset is
**[Unverified]**, because observed truncation and wrapping make its stability unproven
(`docs/output-capture.md`, §Truncation). Step 07 defines the ownership contract, step 12 implements
and verifies the capture mechanism, and step 08 parses only the turn-scoped text it is given.

A turn whose completion is not confirmed remains **pending** until its deadline and then escalates
`timeout` (§R4). It MUST NOT be treated as `missing_verdict`.

### R6 — Read-only guard

Before a turn by an agent whose `permission` is `read-only`, the engine MUST snapshot the working
tree, excluding the run folder (`.pipeline/`). After the turn, any difference MUST escalate
`guard_violation`.

The guard check happens **before** an outcome is accepted and before routing (§4). The guard is
mandatory even when the agent CLI enforces its own read-only mode: enforcement is CLI-specific, is
not equivalent across agents, and is unverified for OpenCode (`docs/agent-cli-notes.md`).

The engine MUST NOT resolve a capture or tooling limitation by granting a read-only reviewer write
access.

**Effective baseline and acceptance.** Each read-only turn has its own **effective baseline**. It
starts as the snapshot taken immediately before that turn. A `guard_violation` records the differing
snapshot observed after the turn. Accepting a violation (§R12) accepts **that specific observed
snapshot and no other**, which then replaces the effective baseline **for that turn** and is
preserved across every later resume of that turn.

A new read-only turn always takes a **fresh** pre-turn snapshot as its effective baseline. An
accepted snapshot is therefore never carried into a later turn, so ordinary changes made by an
implementer between two reviewer turns are not reported as violations.

The guard is never disabled. After acceptance, any further change within the same turn differs from
the new effective baseline and MUST raise a fresh `guard_violation`. Acceptance resolves only the
guard condition; a `blocked` or `timeout` condition applying to the same turn survives it and is
re-evaluated afterwards (§4.3).

### R7 — Gates

A gate runs a command and is decided by that command's **actual process result**: exit status 0 →
`pass`; any other exit status → `fail`; no exit within the gate's `timeout` → escalate `timeout`.

The engine MUST obtain a real exit status. A pane-typing mechanism that reports only that keystrokes
were delivered is insufficient: it supplies no completion signal and no exit status
(`docs/herdr-notes.md`, §`pane run`).

The last lines of the gate's output MUST be written as a handoff file (§R11).

### R8 — Routing

After a valid outcome is accepted, the engine follows the edge connected to that outcome's port. A
port with no edge MUST escalate `unrouted`. Routing occurs only after completion is established, the
guard has passed, and an outcome is valid (§4).

### R9 — End

Entering an `end` node finishes the run with status `done`. The engine MUST send no further prompts
and MUST emit `run_finished` with `status: "done"`. Agent panes are left running.

### R10 — Escalation

An escalation pauses the run, records the reason, notifies the operator, and persists run state to
the run folder. It emits exactly one `escalated` event. The run state becomes `paused`; the run is
not terminal and MAY later be resumed (§R12) or stopped (§R13).

### R11 — Handoffs before prompts

Any content passed to a following node MUST be written to a file in the run folder, and
`handoff_written` MUST be emitted, **before** the prompt that references that file is sent.

This also serves a practical constraint. With large inline prompts, submissions were observed to
report stalled activity, or to settle with no answer present, leaving **delivery unconfirmed**;
short prompts referencing a file were followed by answers appearing in every subsequent attempt
(`docs/output-capture.md`, §Prompt size). Size is the observed correlate, not a demonstrated cause.

### R12 — Resume

Resume re-evaluates the paused node **without re-sending its prompt or re-running its gate**. It
emits one `resumed` event and returns the run to `running`.

| Paused reason     | Resume behaviour                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blocked`         | Continue observing the same turn until it settles again.                                                                                                                                   |
| `missing_verdict` | Re-read the turn-attributable output; do not re-prompt.                                                                                                                                    |
| `max_rounds`      | Requires a grant of extra rounds (e.g. `--extra-rounds 2`). The grant resumes the retained pending entry (§R3) **exactly once**.                                                           |
| `guard_violation` | Requires an explicit choice: accept the working-tree changes, or stop.                                                                                                                     |
| `timeout`         | **[Decision]** Continue observing the existing turn or gate execution under a fresh observation deadline equal to its configured timeout. Reuse an already available result if one exists. |
| `unrouted`        | **[Decision]** Not resumable in this version.                                                                                                                                              |

**Observation deadlines.** A turn's initial deadline starts when the engine submits the prompt, or
launches the gate command, and runs for the node's `turn_timeout` (agents) or the gate's `timeout`.
Whenever a resume continues observing an existing turn — for `blocked`, `missing_verdict` or
`timeout` — it starts a **fresh deadline of that same configured duration**, measured from the
`resumed` event. Remaining time from the original deadline is never carried over, and an expired
original deadline never causes an immediate re-escalation. An operator who resolves a dialog long
after the original timeout therefore gets a full observation budget.

**Extra rounds.** Grants are **cumulative**. `n` MUST be a positive integer; the run keeps a running
total of everything granted, and the effective limit checked by R3 is
`max_rounds + (sum of all grants so far)`. With `max_rounds: 5`, a grant of 2 makes the limit 7, and
a second grant of 2 makes it 9 — a grant never resets or replaces the limit. The grant resumes
the retained pending entry exactly once (§R3); the resulting `resumed` event carries the round of
that entry — the candidate round that was refused, which is now accepted. Subsequent entries
continue from there under the raised limit. A grant of `n <= 0` is refused and emits no event.

Resume MUST NOT automatically resend a prompt or rerun a gate, in any case. A timeout can occur
after the prompt was delivered, so resending risks double submission (`docs/output-capture.md`, §A
settled state does not tell you which prompt completed).

Resuming a `timeout` MUST preserve the turn's identity, its verdict-ownership information, and the
turn's **effective** guard baseline (§R6) — which is the accepted snapshot if one was accepted for
this turn, not necessarily the original pre-turn snapshot. If the original execution cannot be identified or
its result recovered, the engine MUST refuse the resume with an explanation and leave the run
paused; it MUST NOT silently launch a replacement. A refused resume emits **no** event.

`unrouted` indicates a pipeline defect. The operator must stop the run, correct the pipeline, and
start a new run; an active run keeps the pipeline definition it started with.

### R13 — Stop

Stop finalizes the run promptly, **without** waiting for an active turn to settle. The engine MUST
set status `stopped`, emit exactly one `run_finished` with `status: "stopped"`, cancel its own
observation of any active turn, and send no further prompts, routing decisions, or run-log events.

Agent panes and any already-running commands are left running. **Stopping orchestration does not
guarantee that an already-running agent or command stops producing side effects**, including writes
to the working tree.

### R14 — No git writes

The engine MUST NOT write to git: no commits, no resets, no checkouts, no branch or tag changes, no
staging. This holds in every path, including escalation, resume, stop and cleanup.

### R15 — Determinism

Two runs MUST produce identical event sequences — comparing every field except `ts` and `run_id` —
when **all** of the following are equal:

- the pipeline definition,
- the task,
- the effective configuration, including `max_rounds`, timeouts and node settings,
- the scripted runtime results and scripted guard observations, in order,
- the ordered operator actions (resume, stop, extra-round grants) and deadline expiries.

Because only `ts` and `run_id` are excluded, every other field must be reproducible: `seq` is
positional, and handoff file paths MUST be derived deterministically from the run's structure — for
example the producing node and an index within the entry — never from a timestamp, a random value,
or filesystem enumeration order. The order in which several handoffs are written within one entry
MUST likewise be deterministic.

Scripted inputs define the **order** in which results and deadline expiries are observed, so
conformance tests never depend on wall-clock races.

## 3. Events

`events.jsonl` is append-only, one JSON object per line, in emission order. There are exactly seven
event types. Every event carries: `type`, `run_id`, `seq` (1-based, strictly increasing, no gaps),
and `ts` (ISO-8601). `ts` and `run_id` are excluded from determinism comparison (§R15).

| Type              | Additional payload                                               |
| ----------------- | ---------------------------------------------------------------- |
| `run_started`     | `pipeline` (name), `task`                                        |
| `node_started`    | `node`, `round`                                                  |
| `handoff_written` | `node`, `round`, `path` (relative to the run folder)             |
| `node_finished`   | `node`, `round`, `outcome`                                       |
| `escalated`       | `node`, `round`, `reason`                                        |
| `resumed`         | `node`, `round`, and `extra_rounds` when the resume granted them |
| `run_finished`    | `status` (`done` or `stopped`)                                   |

**Ordering.** `run_started` is first and occurs exactly once. `run_finished` is last and occurs
exactly once in a terminal run; a paused run has none until it is stopped or reaches an end node.

`handoff_written` carries the **producing** node — the node whose turn generated the content, not
the node that will consume it. One event is emitted per file successfully written; a node entry that
writes several files emits several, in the order the files were written, and all of them precede the
prompt that references any of them (§R11).

**Permitted sequences per node entry.** The table gives the shapes an entry takes as it runs to a
conclusion. It is not a list of whole run histories: stop composes with any of them (below).

| Case                        | Sequence                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary completion         | `node_started` → any `handoff_written` → `node_finished`                                                                                                                                                                     |
| Escalation                  | `node_started` → any `handoff_written` → `escalated`                                                                                                                                                                         |
| Escalation then resume      | … → `escalated` → `resumed` → (any `handoff_written`) → one of `node_finished`, `escalated`                                                                                                                                  |
| Repeated escalation         | the previous row may repeat: each `resumed` reopens the same entry and is again terminated by `node_finished` or `escalated`                                                                                                 |
| End-node entry              | `node_started` → `run_finished` (`status: "done"`). **No `node_finished`**, because an `end` node has no ports and produces no outcome                                                                                       |
| Refused max-round entry     | `escalated` (`reason: "max_rounds"`) alone. **No `node_started`**, because no entry was accepted; its `round` is the stored round, not the refused candidate                                                                 |
| Refused entry, then granted | `escalated` (`max_rounds`) → `resumed` → `node_started` → … . The grant accepts the retained pending entry, so `node_started` appears here and not before; `resumed` and `node_started` both carry the newly accepted round  |
| Unrouted outcome            | `node_started` → any `handoff_written` → `node_finished` (with the outcome) → `escalated` (`reason: "unrouted"`). The outcome was produced and accepted; only routing failed, so `node_finished` **precedes** the escalation |
| Interrupted by stop         | `node_started` → any `handoff_written` → `run_finished` (`status: "stopped"`). The entry is left unterminated: **no** `node_finished` and **no** `escalated`                                                                 |

The "interrupted by stop" row is one instance of a general rule rather than a special case.

**Stop composes with any non-terminal prefix.** A stop accepted while the run is non-terminal
truncates whatever history exists and appends `run_finished` with `status: "stopped"`. It requires
no particular preceding event, and is valid while a turn is in flight, while the run is **paused**
after an `escalated`, after a `resumed`, between node entries, and before any node entry has begun.
All of the following are therefore valid, among others:

```
node_started → escalated → run_finished(stopped)
node_started → escalated → resumed → run_finished(stopped)
node_finished → run_finished(stopped)
run_started → run_finished(stopped)
```

The last of these is the case where stop arrives before the first prompt: R1's requirement that
`node_started` for the start node is the run's second event holds **unless the run reaches a
terminal state first**, in which case `run_finished` is the second event and no entry ever begins.

**Invariants** (these, not the table, are what conformance is judged against). Within one entry:
at most one `node_finished`; every `resumed` is preceded by an `escalated` for the same entry; an
`escalated` is preceded by `node_started` for that entry except for a refused max-round entry.
Across a run: `run_started` first and once; `run_finished` last and at most once, exactly once iff
the run is terminal; `seq` strictly increasing with no gaps; and no event of any kind after
`run_finished`. An entry ends with a terminator, with the run's `run_finished`, or not at all while
the run remains paused.

Every event except `run_started` and `run_finished` carries `node` and `round`.

## 4. Precedence

When several conditions could apply, the engine MUST resolve them in this order.

1. **Stop wins.** Once a stop request is accepted, the run is terminal. Results arriving afterwards
   MUST NOT resume routing or emit events.
2. **Guard before outcome.** For an active `read-only` turn, the guard is checked before an outcome
   is accepted and before any escalation for that turn. A detected violation takes precedence over
   an ordinary outcome, over `blocked`, and over `timeout`.
3. **Secondary conditions survive.** Accepting or resolving a `guard_violation` MUST NOT discard a
   still-applicable `blocked` or `timeout` condition; it is re-evaluated after the guard is resolved.
4. **Result before deadline wins.** A `blocked` or completed result observed at or before the
   deadline takes precedence over the timeout. Otherwise `timeout` is recorded, and a result arriving
   afterwards MUST NOT retroactively change that event.
5. **Parse, then route.** Verdicts are parsed only after completion is established and the guard has
   passed; routing happens only after a valid outcome exists.

## 5. Operator actions are not events

`resume` and `stop` are operator actions, not run-log events. Their _effects_ appear as `resumed`
and `run_finished`. Actions that are refused — a resume the engine cannot honour (§R12), or any
action on a terminal run — produce an explanation to the operator and **no** run-log event. Golden
scenarios therefore record operator actions separately from the expected event sequence.

## 6. Changes and clarifications from PLAN.md

No new outcome, escalation reason, or event type is introduced.

1. **R3 ordering made explicit** — candidate round, check, then accept. The plan did not say which
   came first. **[Decision]**
2. **R3 retains a pending entry** so an extra-rounds grant resumes that exact entry once. The plan
   did not describe what is resumed. **[Decision]**
3. **R4 requires turn-attributable output**, not merely a settled state. Corrects an assumption the
   plan's wording allows; `codex/short-false-settle` recorded exit 0 and `done` with no answer
   present (`docs/output-capture.md`).
4. **R5 adds a verdict-ownership requirement** and explicitly declines to mandate a row-offset
   mechanism. **[Decision]** / **[Unverified]**
5. **R7 requires a real process exit status**, because `pane run` reports only keystroke delivery
   (`docs/herdr-notes.md`).
6. **R12 extends to `timeout`** (observe, never resend) and declares `unrouted` non-resumable.
   The plan listed neither. **[Decision]**
7. **R13 finalizes promptly** and states that orchestration cannot stop side effects already in
   flight. The plan only said panes are not killed. **[Decision]**
8. **Precedence (§4) is new.** The plan defined no ordering between coincident conditions.
   **[Decision]**
9. **R6 keeps the guard mandatory** alongside CLI restrictions, and forbids granting write access to
   work around capture limits (`docs/agent-cli-notes.md`).

## 7. Research findings this specification depends on

From `docs/herdr-notes.md`, `docs/agent-cli-notes.md` and `docs/output-capture.md`:

1. `idle`/`done` and a successful CLI exit do **not** establish that the submitted prompt completed.
2. Pane occupancy reports only that a pane holds a recognised agent; a lifecycle counter counts
   lifecycle changes. Neither proves prompt delivery or completion.
3. A prompt timeout can occur **after** delivery. Never resubmit automatically because of a timeout.
4. `agent_prompt_stalled`, and a settled state with no answer, leave delivery **unconfirmed**;
   neither resending nor waiting is justified by the error alone.
5. A verdict must belong to the current turn; the last anchored match in shared scrollback is
   insufficient by itself.
6. `pane run` supplies no completion signal and no exit status; gate outcomes need real process
   results.
7. The read-only diff guard remains mandatory alongside CLI restrictions; OpenCode enforcement is
   unverified.
8. The observed read ceiling was 1000 lines and the earliest capture comparison was approximately
   +2 s. These are measurements in one configuration, **not** universal guarantees, and this
   specification states no numeric capture limit as a rule.
9. Capture limitations MUST NOT be solved by silently granting a read-only reviewer write access.

## 8. What this specification does not do

It does not describe the engine's implementation, the runtime adapter, the verdict parser, the
pipeline file schema (step 19), or agent profiles (step 22). Golden scenarios and their schemas
(steps 05b and 05c) express this contract as reference data; structural validation of those files
does not demonstrate that any engine obeys them.
