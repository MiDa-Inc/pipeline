# Real agent output capture (step 04 spike)

What `herdr agent read` actually captures from completed Claude Code and Codex reviews: timing,
lifecycle states, verdict visibility and truncation. Inputs for step 08's verdict parser and step
12's runtime read window.

**Captured 2026-09-11.** macOS 26.5.2 arm64. herdr 0.9.0, Claude Code 2.1.269, codex-cli 0.154.0.
All runs used an isolated headless herdr session (`pipeline_s04`), one disposable scratch project
per sample, panes 120×40 (shell 119×40).

Fixtures: `packages/core/test/fixtures/agent-output/<agent>/<sample>/`. Each directory holds
`read.stdout` / `read.stderr` (primary capture), `read-later.*` (a second read 5 s on),
`prompt.stdout` / `prompt.stderr` (what `agent prompt` returned), `prompt.txt`, `input.diff` and
`meta.json`. Raw captures are byte-for-byte as herdr wrote them; `meta.json` holds everything
derived.

## Sample matrix

Twelve fixtures: five review categories per agent, plus one negative case each that the runs
produced on their own.

| Sample                       | Agent  | Settled   | Prompt→return | Verdict   | Notes                               |
| ---------------------------- | ------ | --------- | ------------- | --------- | ----------------------------------- |
| `claude/short`               | Claude | `done`    | 3.2 s         | approve   | brief review                        |
| `claude/revise`              | Claude | `done`    | 3.3 s         | revise    | off-by-one found                    |
| `claude/approve`             | Claude | `done`    | 8.1 s         | approve   | correct backoff accepted            |
| `claude/long`                | Claude | `done`    | 119.1 s       | revise    | long review (see length note)       |
| `claude/blocked`             | Claude | `blocked` | 9.6 s         | _missing_ | Bash permission dialog              |
| `claude/long-prompt-stalled` | Claude | —         | 5.4 s         | _missing_ | negative: stall reported, no answer |
| `codex/short`                | Codex  | `done`    | 17.0 s        | approve   | brief review                        |
| `codex/revise`               | Codex  | `done`    | 30.0 s        | revise    | off-by-one found                    |
| `codex/approve`              | Codex  | `done`    | 53.5 s        | approve   | correct backoff accepted            |
| `codex/long`                 | Codex  | `done`    | 739.3 s       | revise    | long review (see length note)       |
| `codex/blocked`              | Codex  | `blocked` | 31.7 s        | _missing_ | write-escalation dialog             |
| `codex/short-false-settle`   | Codex  | `done`    | 1.1 s         | _missing_ | negative: settled, no answer        |

**Long-review length.** Two different things can be counted, from two different sources, and the
document keeps them apart.

_Native answer lines_ — the agent's own text, read from each CLI's JSONL transcript (not from
herdr), joining the final assistant answer's text items and counting with `str.splitlines()` and
`bool(line.strip())`:

|             | lines   | non-blank |
| ----------- | ------- | --------- |
| Claude long | **330** | **286**   |
| Codex long  | **930** | **760**   |

These are the agent-authored figures, and both clear the 200-line requirement. The extracted answers
are preserved as `native-answer.txt` in each long fixture, with the transcript path, JSONL line
number, extraction rule and sha256 in `native-answer.json`. The counts and hashes reproduce the step
04 review audit's independently.

_Rendered rows_ — rows of terminal output between the echoed prompt and the verdict in a herdr
capture. These are larger, because they include herdr's rendered tool and status rows and reflect
terminal wrapping rather than the agent's own line breaks: **391 rows / 343 non-blank** for Claude
(from `recent-unwrapped`) and **983 / 792** for Codex (from `recent`; no unwrapped capture of the
Codex long turn was collected, so its rows are wrapped at the 120-column pane width).

Rendered rows are what a read window has to hold; native lines are what the agent wrote. They are
not comparable, and neither is a filter over the other.

Review material: five small git diffs with known verdicts — a defensive guard added (approve), a
pagination helper with an off-by-one and a wrong slice bound (revise), retry with exponential
backoff (approve), and a 64-line `server.js` change carrying ten planted defects (off-by-one,
`eval`, plaintext password compare, predictable session token, `==` comparisons, unchecked
`findIndex`, undefined dereference, exclusive range bounds) for the long reviews. Each diff is
copied into its fixture as `input.diff`, and the exact prompt as `prompt.txt`.

Ordinary reviews used step 03's verified read-only configuration:
`claude --model sonnet --restricted --strict-mcp-config --tools "Read,Glob,Grep" --permission-mode acceptEdits`
and `codex --model gpt-6-astra --sandbox read-only --ask-for-approval never`. Codex inherits
`model_reasoning_effort = "xhigh"` from `~/.codex/config.toml`, which explains its slower times.

## Timing and observed states

Lifecycle state was polled with `herdr agent get` every **0.5 s** while the prompt was in flight.
**These are samples, not a complete event history** — any transition shorter than the interval is
invisible to them, and `meta.json` records that on every fixture.

Every successful review ended in `working → done` and settled within ~0.4 s of `agent prompt --wait`
returning. The _starting_ state differed: nine samples were first observed `idle`, but
`codex/approve`, `codex/long` and `codex/revise` were first observed **`done`**. Each of those three
was sent to an agent that had already been prompted once in the same pane, and `done` was the state
herdr reported before this prompt was submitted; what produced it was not determined.
Both blocked samples showed `idle → working → blocked`. No sample settled on `idle` after a real
turn here, but step 03 recorded `idle` as a possible settle state, so the runtime must accept
`idle`, `done` and `blocked`, and must not treat a leading `idle` as a precondition.

Time to first observed settled state: 3.2–119.4 s for Claude, 1.6–739.5 s for Codex. A 200-line
Codex review took **12 minutes**, which sets a realistic floor for step 12's `turn_timeout`.

### A settled state does not tell you which prompt completed

`codex/short-false-settle` is the counter-example, and it arrived by accident: `agent prompt --wait`
returned **exit 0** with `agent_status: done` after 1.1 s, and the 0.5 s poller recorded a clean
`idle → working → done` — while the capture contains no answer of any kind and the input box still
shows its placeholder.

That is enough to establish the narrow claim: **a successful exit code and a settled state did not
establish that this prompt completed.** It is not enough to explain _why_, and the `working → done`
transitions remain unexplained. Whether the text reached the agent is **unconfirmed**.

Three anomalies occurred across these runs:

| Symptom                                                       | What the evidence shows                                                                      | What it does not show                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| exit 1, `agent_prompt_stalled` (`claude/long-prompt-stalled`) | herdr observed no working/blocked state within 5000 ms; status stayed `idle`; no turn output | whether the prompt arrived. The error reports **absence of observed activity after submission**, not rejection of input |
| exit 0, `done`, no answer (`codex/short-false-settle`)        | exit code and state both looked successful with no answer present                            | whether the prompt arrived, or what drove the state changes                                                             |
| exit 1, `timeout` (step 02)                                   | the prompt **was** delivered and the turn was still running                                  | —                                                                                                                       |

**Do not derive a resend rule from these fixtures.** An empty capture is consistent both with "never
delivered" and with "delivered, then discarded without starting a turn", and nothing here
distinguishes them. Step 12 should treat delivery as unconfirmed on these errors, inspect the pane
and the agent state, and resend only on evidence independent of the error itself that no turn ran
and none is running. Only the step 02 `timeout` case has a settled rule, and it is "wait".

### Prompt size correlates with these failures; cause is untested

The Claude stall involved a 2178-character, 70-line prompt containing a fenced diff. With prompts of
that same shape, three of six first attempts against Codex returned a settled state with no answer
in the capture. Rewriting them as single-line prompts (218–500 characters) that tell the agent to
read a file was followed by answers appearing in every subsequent attempt — which is also the shape
the plan's R11 requires, so the constraint and the design agree.

**Size is the observed correlate, not a demonstrated cause.** No size sweep, and no test of
multi-line versus single-line at equal length, was run; content shape, line count and paste
behaviour are all uncontrolled here.

## Truncation

`herdr agent read --source recent --lines N` drops the **oldest** lines and keeps the tail.

**Claude long review** (406 lines total in scrollback):

| `--lines` | returned | beginning kept | finding 1 | verdict |
| --------- | -------- | -------------- | --------- | ------- |
| 100       | 100      | no             | no        | **yes** |
| 200       | 200      | no             | no        | **yes** |
| 400       | 400      | no             | yes       | **yes** |
| 800       | 406      | yes            | yes       | yes     |
| 1600      | 406      | yes            | yes       | yes     |

800 and 1600 return identical content, so 406 lines is the whole turn.

**Codex long review** (~993 lines): 100→100, 400→400, 800→800, 1600→1000, 3000→1000, 5000→1000.
The captures at 1600, 3000 and 5000 are byte-identical, so **`agent read` returns at most 1000
lines regardless of `--lines`.** This turn occupied about 993 lines and only just fits; a longer
review would lose its opening irrecoverably. Its primary fixture was taken at `--lines 400` and so
begins mid-review — `read-max.stdout` alongside it is the complete 1000-line capture, and
`meta.json` says so.

**Sources**, measured on the Claude long turn at `--lines 800`: `visible` 39 lines (the viewport
only), `recent` 406, `recent-unwrapped` 405. `visible` still contained the verdict, because the
verdict is the last thing written — but it contained almost none of the review.

`recent-unwrapped` is **not** lossy here: diffing it against `recent` shows six differing lines, and
they are the wrapped two-row shell launch command being joined into one, plus one trailing-space
difference. The whole review and the verdict survive in both. The earlier claim that only `recent`
carries a whole review was wrong.

These sweeps are preserved next to the fixtures, each `.stdout` beside the command that produced it,
in `claude/long/truncation/` and `codex/long/truncation/` with a `README.json` per directory.

### Rendering lag — what was actually measured

The harness sleeps ~2 s after `agent prompt --wait` returns (finishing its poll loop) before the
first read, then ~5 s more before the second. Measured across the twelve fixtures the first read
lands **2.002–2.016 s** after the prompt returned, and the second **5.018–5.034 s** after the first.
Each fixture records both intervals.

So the comparison is between **+2 s and +7 s**, not between "immediate" and "later". Over that
window, character counts differ in three fixtures and byte counts in four, but **the review content
is identical in all twelve**; the differences are entirely in the TUI footer (`paste again to expand` versus
`accept edits on`).

**No capture was taken at settle**, so nothing here establishes whether a read issued immediately is
complete. A runtime that reads with no delay is untested by this spike; the safe reading of the
evidence is that a ~2 s wait suffices, not that zero does.

### Recommended capture settings

`herdr agent read <target> --source recent --lines 1000`.

`recent` and `recent-unwrapped` both carried the whole Claude review; `visible` is bounded by the
viewport and is unusable for this purpose. `recent` is recommended because it preserves rendered
rows one-for-one, which keeps line numbering stable against the pane; `recent-unwrapped` is an
acceptable alternative that joins wrapped rows. 1000 is both the largest useful `--lines` value and
the observed hard ceiling, so asking for more has no effect.

**The source comparison was run only on the Claude long review.** The Codex session was torn down
before `visible` / `recent-unwrapped` were captured for its long turn, so the source recommendation
rests on one agent; only the window sweep was completed for Codex.

**Limits of this sample.** Two long reviews, one per agent, at 406 and ~993 lines, on one terminal
geometry (120×40). Both sat under or at the 1000-line ceiling; nothing here establishes behaviour
for a review substantially longer than that, except that it cannot be fully retrieved. The ceiling
was not varied by pane size or scrollback configuration.

## Verdict visibility

The prompt instructs the agent to end with one line, `VERDICT: APPROVE` or `VERDICT: REVISE`.
Two parsing strategies were measured against all twelve fixtures:

| Strategy                                                                 | Result                                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| anchored `^\s*VERDICT:\s*(APPROVE\|REVISE)\s*$`, take the **last** match | correct in **12/12**                                                          |
| loose substring `VERDICT:\s*(APPROVE\|REVISE)`                           | 0–5 matches per fixture (observed: 0, 2, 3, 5); wrong on both blocked samples |

The loose form fails because the echoed prompt contains the instruction text
`either "VERDICT: APPROVE" or "VERDICT: REVISE"` on one line. On the two blocked fixtures, where the
agent never answered, a loose parser finds two matches and would report a verdict that was never
given; the anchored form finds none, which is the correct `missing_verdict` outcome.

Claude Code sometimes collapses a long pasted prompt to `paste again to expand`, removing the echo
from the capture entirely — so a parser must not depend on the echo being present _or_ absent.

## Consequences for the parser and runtime

1. **Step 08 should anchor the verdict regex to a whole line and take the last match.** Anchoring
   defeats the echoed instruction, and "last" defeats an earlier turn's verdict sitting higher in
   scrollback. This is the plan's R5 rule and it holds on all twelve fixtures — but **"last match"
   alone does not establish ownership.** Every fixture here is a single-turn pane. If a turn
   produces no verdict and an earlier turn's verdict is still in the window, the last match belongs
   to the wrong turn and would be read as this turn's answer. The parser needs a turn boundary — a
   marker, a scrollback offset taken before the prompt, or a per-turn capture — not just the last
   line. No fixture here exercises that case.
2. **A blocked agent has no verdict.** Both blocked fixtures contain zero anchored verdict lines,
   which is R4's `blocked` escalation, not R5's `missing_verdict`. The runtime must check the
   lifecycle state before parsing, or it will mis-classify.
3. **Step 12 must verify completion from output, not from status.** Exit 0 and a settled state were
   both observed on a prompt that produced no answer. Correlate the captured output with the prompt
   actually sent.
4. **Never auto-resend on timeout; treat the other two anomalies as delivery-unconfirmed.** Only the
   step 02 `timeout` case has a settled rule ("wait"). For `agent_prompt_stalled` and for a settled
   state with no answer, this spike cannot say whether the prompt arrived, so neither resending nor
   waiting is justified by the error alone — inspect the pane and agent state first.
5. **Send short prompts and put material in files** (R11 already requires this).
6. **`turn_timeout` must tolerate ~12 minutes** for a long review at Codex's xhigh effort.
7. **Reviews longer than ~1000 lines cannot be fully captured** through `agent read`. If complete
   review text is ever required, the agent must be asked to write it to a file.

## Limitations

- Five review categories per agent, one run each; no repetition, so timings are single
  measurements, not distributions.
- Lifecycle states are 0.5 s samples; short transitions are not represented.
- One model per agent (`sonnet`, `gpt-6-astra`) and one terminal geometry.
- The 1000-line ceiling was observed, not traced to its cause in herdr.
- **No capture was taken at settle.** The earliest read is +2 s, so immediate-read completeness is
  untested.
- **The source comparison covers Claude only.** For Codex, only the window sweep was completed.
- **The two prompt anomalies were not diagnosed.** Delivery is unconfirmed in both, and the
  `working → done` transitions in `codex/short-false-settle` are unexplained. Prompt size is a
  correlate, not a tested cause.
- **Every pane held a single turn.** Nothing here tests verdict ownership when an earlier turn's
  verdict is still inside the read window.
- Character counts and byte counts differ for this output (box-drawing and symbols are multi-byte);
  fixture metadata records both, and an earlier revision mislabelled characters as bytes.
- OpenCode was not exercised at all, as this step required.
