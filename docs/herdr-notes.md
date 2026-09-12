# herdr CLI notes (step 02 spike)

Observed behavior of the herdr commands Pipeline will drive. Everything here was run against a
live herdr server; every claim links to a fixture captured from that run.

|                 |                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| herdr version   | **0.9.0** (`herdr --version` → [`version/version.stdout`](../packages/runtime/test/fixtures/herdr/version/version.stdout)) |
| Server protocol | private 22, endpoint generation 1 (`herdr status`)                                                                         |
| Platform        | macOS 25.5.0 arm64, Tabby front end                                                                                        |
| Date captured   | 2026-09-11                                                                                                                 |
| Fixtures        | `packages/runtime/test/fixtures/herdr/`                                                                                    |

## How the fixtures were produced

Each case ran through a wrapper keeping the three channels separate —
`herdr "$@" > <case>.stdout 2> <case>.stderr; rc=$?` — writing `<case>.meta` with the exact command
line, exit status, elapsed time and session. Nothing was edited, normalised or truncated after
capture; empty files mean that channel produced nothing.

### Cleanup, and one accident

Experiments ran in disposable workspaces — `wA` on the default server, closed with
`herdr workspace close wA`, and the whole `pipeline_spike` session, stopped and deleted. After
both, `herdr tab list` matched the pre-experiment baseline exactly (the same nine tab IDs), and no
stray server process remained.

One mistake did reach a live workspace: probing syntax with a bare `herdr tab create` created tab
`w8:t2` in the operator's focused workspace. It was closed with `herdr tab close w8:t2` within the
same minute and `w8` returned to its single original tab. That is the reason for the warning under
"Discovering syntax"; no other pre-existing tab or pane was touched.

### Where each fixture came from

Every `.meta` records its provenance. Fixtures whose output could otherwise include unrelated
sessions (`agent list`, `pane get`, `pane current`, `tab create`) carry
`session: pipeline_spike (isolated headless server, no other agents)` — a throwaway server with
its own socket and workspaces. The rest were captured on the default server inside this
repository's own directory, and reference only `/Users/aantonyan/workspace/shshunj/pipeline` and
`/Users/aantonyan`. No fixture contains a workspace, path or terminal title from unrelated work;
the contaminated first-pass captures were **re-run** in the isolated session, not redacted.

```sh
herdr --session pipeline_spike server &          # own socket, starts empty
herdr --session pipeline_spike workspace create
herdr --session pipeline_spike server stop && herdr session delete pipeline_spike
```

## Output conventions — correcting the plan

`PLAN.md` records the decision "herdr CLI with JSON output". That is only partly right, and the
difference matters for the adapter.

**JSON on stdout, exit 0:** `tab create`, `pane split`, `pane current`, `pane get`,
`pane wait-output`, `agent start`, `agent prompt`, `agent wait`, `agent list`. The envelope is
always `{"id":"cli:<area>:<verb>","result":{...,"type":"<event>"}}`. There is no `--json` flag and
none is needed.

**Plain text on stdout, exit 0:** `pane read` and `agent read` return terminal text, _not_ JSON.
There is no flag that wraps them in JSON — `--raw` changes the text, not the container (below).

**Text by default, JSON only on request:** `agent explain` prints a short human summary and needs
an explicit `--json`. It is the only command in this set with a `--json` flag.

**No output at all:** `pane run` writes nothing on either channel and exits 0
([`pane-run/success.stdout`](../packages/runtime/test/fixtures/herdr/pane-run/success.stdout) is
0 bytes). Success must be confirmed by reading the pane.

### Exit codes

Three distinct classes, consistent across every command tested:

| Exit | Meaning                      | Channel    | Shape                                                           |
| ---- | ---------------------------- | ---------- | --------------------------------------------------------------- |
| `0`  | success                      | stdout     | JSON, text, or nothing                                          |
| `1`  | API/runtime error            | **stderr** | JSON: `{"error":{"code":"...","message":"..."},"id":"cli:..."}` |
| `2`  | usage or argument validation | **stderr** | plain text, one line, no JSON                                   |

Exit 2 is decided client-side before the socket call; exit 1 comes from the server. An adapter
must not try to JSON-parse stderr on exit 2. Observed error codes: `pane_not_found`,
`agent_pane_not_found`, `agent_not_found`, `agent_blocked`, `agent_not_ready`, `timeout`.

### Discovering syntax

Use `herdr <area> --help` (`herdr pane --help`, `herdr agent --help`) to list a group's
subcommands. Leaf subcommands have no `--help` of their own — it falls back to the global help.

A leaf command run with **no arguments** prints its `usage:` line and exits 2, which is tempting
as a discovery trick, **but do not use it**: commands whose arguments are all optional execute
instead of printing usage. `herdr tab create` takes no required argument, so running it bare
creates a real tab in whatever workspace is focused. That happened during this spike (see
Cleanup). Read the `usage:` strings reproduced below instead, or trigger one deliberately with an
invalid flag (`herdr tab create --nonexistent-flag`), which always errors without mutating.

## Commands

Every `usage:` string below is quoted from herdr 0.9.0 itself. Run experiments in a scratch
workspace (see above) so nothing touches live work.

### `tab create`

```
herdr tab create [--workspace ID] [--cwd PATH] [--label TEXT]
```

No required arguments — **calling it bare creates a tab in whatever workspace is focused**, which
is easy to do by accident. Returns `type:"tab_created"` with both the new `tab` and its
`root_pane` (so a create + split flow never needs a follow-up `pane list`). `--name` is rejected.

- Success: [`tab-create/success.*`](../packages/runtime/test/fixtures/herdr/tab-create/) — `herdr tab create --workspace wA` → exit 0.
- Unknown flag: [`tab-create/usage.*`](../packages/runtime/test/fixtures/herdr/tab-create/) → exit 2, `unknown option: --nonexistent-flag` on stderr.

### `pane split`

```
herdr pane split [<pane_id>|--pane ID|--current] --direction right|down
                 [--ratio FLOAT] [--cwd PATH] [--env KEY=VALUE]
                 [--right-click herdr|pane] [--focus] [--no-focus]
```

`--direction` is required. `--cwd` sets the new pane's working directory and `--env` injects
variables — both directly useful for launching an agent in a run's worktree. `--no-focus` keeps
the user's focus where it is. Returns `type:"pane_info"` with the new `pane_id`.

- Success: [`pane-split/success.*`](../packages/runtime/test/fixtures/herdr/pane-split/) → exit 0, created `wA:p3`.
- Bad direction: [`pane-split/error-bad-direction.*`](../packages/runtime/test/fixtures/herdr/pane-split/) → exit 2, `invalid split direction: sideways`.

### `pane run`

```
herdr pane run <pane_id> <command>
```

Types the command into the pane's shell and submits it. **Returns nothing and exits 0 without
waiting** — it reports that the keystrokes were delivered, not that the command ran or succeeded.
There is no exit status of the inner command anywhere in the API. To observe a result, pair it
with `pane wait-output` or `pane read`.

- Success: [`pane-run/success.*`](../packages/runtime/test/fixtures/herdr/pane-run/) → exit 0, stdout and stderr both 0 bytes.
- Bad pane: [`pane-run/error-bad-pane.*`](../packages/runtime/test/fixtures/herdr/pane-run/) → exit 1, `{"error":{"code":"pane_not_found",...}}`.

### `pane read`

```
herdr pane read <pane_id> [--source visible|recent|recent-unwrapped|detection]
                [--lines N] [--format text|ansi] [--ansi] [--raw]
```

Plain terminal text on stdout. `--raw` does **not** produce JSON — it preserves `\r\n` endings and
trailing spaces where the default strips CR and trims (155 B vs 158 B for one screen).
`--source detection` exposes the region the detector reads.

- Default: [`pane-read/visible.*`](../packages/runtime/test/fixtures/herdr/pane-read/) → exit 0, text.
- `--raw`: [`pane-read/raw-mode.*`](../packages/runtime/test/fixtures/herdr/pane-read/) → exit 0, still text.
- Bad pane: [`pane-read/error-bad-pane.*`](../packages/runtime/test/fixtures/herdr/pane-read/) → exit 1, JSON error.

### `pane wait-output`

```
herdr pane wait-output <pane_id> (--match TEXT | --regex PATTERN)
                       [--source visible|recent|recent-unwrapped] [--lines N]
                       [--timeout MS] [--raw]
```

Returns `type:"output_matched"` with `matched_line` **and** an embedded `read` object holding the
whole captured region, so a match needs no second `pane read`.

**Gotcha:** the shell echoes the command line, so a marker matches the moment the command is
_typed_, before it runs — the capture's `matched_line` is the echoed prompt line, not the output.
This bit twice during the spike, the second time racing a file that had not been written yet.
Match on something only the finished command can print.

- Match: [`pane-wait-output/success-match.*`](../packages/runtime/test/fixtures/herdr/pane-wait-output/) → exit 0.
- Timeout: [`pane-wait-output/timeout.*`](../packages/runtime/test/fixtures/herdr/pane-wait-output/) → exit 1 after 2033 ms for `--timeout 2000`, `{"error":{"code":"timeout","message":"timed out waiting for output match"}}`.

### `agent start`

```
herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
```

Starts an agent in an **existing** pane; it never creates or splits one. Startup timeout defaults
to 30 s. Returns `type:"agent_started"` with the agent object and the resolved `argv`. `--kind`
accepted for all of `claude codex opencode copilot droid cursor gemini qwen kimi`; the installable
set is wider (`herdr integration list`).

Returns only once herdr has detected the agent and considers it ready. If the agent stops at a
startup dialog it fails fast with `agent_not_ready` — but the name stays registered and usable for
`agent read` / `agent send-keys`, which is how the dialog gets answered.

`--timeout` is itself validated: it must be **greater than 3000 ms and at most 300000 ms**, so a
short timeout cannot be used to fail fast.

**A start timeout does not mean the agent failed to start.** With `--timeout 3001` against a
startup that takes ~3.9 s, the call failed at 3044 ms — but the agent came up anyway moments later.
Critically, **the name was never registered**: `agent explain spike_timeout` returns
`agent_not_found`, while `pane get <pane>` shows `"agent":"claude","agent_status":"idle"` and
`agent list` includes the pane with **no `name` field**. The agent is live but orphaned, reachable
only by pane ID.

**Retrying `agent start` on that pane is refused, not duplicated** — herdr first checks the target
is an available shell, returning exit 1 in 14 ms with
`{"error":{"code":"agent_pane_busy","message":"agent target pane w1:p2 is not an available shell"}}`.
A blind retry therefore cannot put two agents in one pane, but neither can it recover the name:
adopt the orphan by pane ID, or split a fresh pane.

After a start timeout, `pane get <pane>` tells you only whether the pane is **occupied by a
recognised agent**. `agent` present → an agent is there; address it by pane ID. `agent` **absent
does not mean nothing started** — it means herdr recognises no agent there, which equally covers a
process that launched but is unrecognised or has not yet painted a detectable screen. Distinguish
those with `pane read <pane>`, or by retrying `agent start` and reading `agent_pane_busy` as proof
that something occupies the shell.

- Success with pass-through args: [`agent-start/success-extra-args.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 0, `"argv":["claude","--verbose"]`.
- **Timeout:** [`agent-start/timeout.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 1 at 3044 ms for `--timeout 3001`, `{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}`.
- **State after that timeout:** [`agent-start/timeout-after-state.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → `pane get` 6 s later, `agent: claude`, `agent_status: idle`.
- **Orphan recovered by pane ID:** [`agent-start/timeout-recovery-by-pane-id.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → `agent explain <pane>` exit 0, `state: idle`.
- **Retry on the occupied pane refused:** [`agent-start/timeout-retry-busy.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 1, `agent_pane_busy`; no second agent launched.
- Blocked at startup: [`agent-start/blocked-during-startup.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 1 after 3695 ms, `agent_not_ready` (Claude Code's folder-trust prompt). Distinct from a timeout: the name **stays** registered, so `agent read` / `agent send-keys` work and can answer the dialog.
- Invalid timeout: [`agent-start/error-invalid-timeout.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 1, `invalid_agent_timeout` for `--timeout 500`.
- Bad kind: [`agent-start/error-invalid-kind.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 2, plain text.
- Missing pane: [`agent-start/error-pane-not-found.*`](../packages/runtime/test/fixtures/herdr/agent-start/) → exit 1, `agent_pane_not_found`.

### `agent prompt --wait`

```
herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]
```

Sends the text plus Enter as one submission. With `--wait` it returns when the agent first settles
into `idle`, `done` or `blocked`. **The observed settle state for a completed turn was `done`, not
`idle`** — Pipeline's R4 must treat both as settled, which it already does.

Refuses to send to an agent sitting at a dialog, before writing anything.

**A prompt timeout does not mean the prompt was not delivered.** `--wait --timeout 1000` against a
turn that needed longer failed at 1055 ms, but the text had already been submitted: immediately
afterwards the agent was `working`; waiting on the same turn then settled it to `idle`, and the
pane capture shows that prompt echoed back with its answer (the integers 1-40). **That captured
output — not the state change — is what establishes delivery and completion.** Re-sending on
timeout would submit the prompt twice. Treat a prompt timeout as "sent, not yet settled" and
resume with `agent wait`, never by re-prompting.

`pane get` cannot answer this one. Pane occupancy says an agent is present, not whether a prompt
reached it or whether its turn finished. Use the **agent** state instead: `agent wait <target>
--until idle --until done --until blocked` to see the turn settle, then `agent read` for the
result.

**Do not use `state_change_seq` as a delivery or turn signal.** It records lifecycle changes, not
prompt acknowledgements or turn IDs; an increase alone proves neither delivery nor completion.
Check the observed activity and captured output for the submitted prompt; if they do not establish
the outcome, leave it unconfirmed and avoid automatic resubmission. Counterexample — six reported
transitions on a pane that was **never prompted** still walked the counter from 1 to 6
([`agent-state-seq/no-prompt-seq-advances.*`](../packages/runtime/test/fixtures/herdr/agent-state-seq/)).

Note the timeout error is byte-identical to `agent wait`'s except for the `id` field
(`cli:agent:prompt` vs `cli:agent:wait`) — the `id`, not the message, tells them apart.

- Success: [`agent-prompt/success-wait.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → exit 0 after 2806 ms, `agent_status:"done"`.
- **Timeout:** [`agent-prompt/timeout.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → exit 1 at 1055 ms for `--timeout 1000`, `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}`.
- **State after that timeout:** [`agent-prompt/timeout-after-state.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → `agent_status: working` immediately after the timeout.
- **Same turn settled:** [`agent-prompt/timeout-turn-settled.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → `agent wait --until idle --until done --until blocked` exit 0, `idle`.
- **That turn's output:** [`agent-prompt/timeout-turn-output.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → the pane capture holds the timed-out prompt and its reply, the integers 1-40. This is the evidence of delivery; the three captures above are one continuous sequence on one agent.
- Blocked: [`agent-prompt/error-blocked.*`](../packages/runtime/test/fixtures/herdr/agent-prompt/) → exit 1, `{"error":{"code":"agent_blocked",...}}`.

### `agent wait --until`

```
herdr agent wait <target> [--until STATUS]... [--timeout MS]
```

Repeatable `--until`. Returns `type:"agent_info"`. Note `interactive_ready` on the agent object,
which `pane list` does not carry.

- Success: [`agent-wait/success-idle.*`](../packages/runtime/test/fixtures/herdr/agent-wait/) → exit 0.
- Timeout: [`agent-wait/timeout.*`](../packages/runtime/test/fixtures/herdr/agent-wait/) → exit 1 after 2088 ms, `{"error":{"code":"timeout","message":"timed out waiting for agent status"}}`.
- Invalid status: [`agent-wait/error-invalid-until.*`](../packages/runtime/test/fixtures/herdr/agent-wait/) → exit 2; the message enumerates the accepted values (`idle`, `working`, `blocked`, `done`, `unknown`).

### `agent read`

```
herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N]
                 [--format text|ansi] [--ansi]
```

Plain text, like `pane read`, but resolves an agent name and refuses panes with no agent. No
`--raw`.

- After a turn: [`agent-read/after-prompt.*`](../packages/runtime/test/fixtures/herdr/agent-read/) → exit 0, contains the prompt and the `⏺ PONG` reply.
- While blocked: [`agent-read/blocked.*`](../packages/runtime/test/fixtures/herdr/agent-read/) → exit 0, shows the trust dialog.

### `agent list`

```
herdr agent list
```

No arguments and **no filter** — always every agent on the server, across all workspaces. Entries
carry `pane_id`, `tab_id`, `workspace_id`, `agent`, `agent_status`, `revision`, `state_change_seq`
and the terminal titles; `name` appears only for agents named by a completed `agent start`. Panes
running something herdr does not recognise are omitted. `state_change_seq` is a monotonic
server-wide counter of **lifecycle transitions**: it tells a changed state from an unchanged one
between polls, and nothing about which prompt or turn caused the change (see `agent prompt`).

- [`agent-list/success.*`](../packages/runtime/test/fixtures/herdr/agent-list/) → exit 0.

### `agent explain`

```
herdr agent explain <target> [--json]
herdr agent explain --file PATH --agent LABEL [--json]
```

The detector's reasoning, and the most useful command for Pipeline's state work. `--json` returns
every evaluated rule (`id`, `priority`, `region`, candidate `state`, `matched`, and the `evidence`
regexes with a region preview), plus the winning `matched_rule`, `manifest_source` and
`manifest_version`. The `--file` form re-runs detection over a saved capture, making offline
regression tests possible without a live agent.

- Blocked, JSON: [`agent-explain/blocked-json.*`](../packages/runtime/test/fixtures/herdr/agent-explain/) → exit 0, matched `live_blocked_form` (priority 980, region `after_last_horizontal_rule`).
- Blocked, text: [`agent-explain/blocked-text.*`](../packages/runtime/test/fixtures/herdr/agent-explain/) → exit 0, 5-line summary.
- Idle: [`agent-explain/idle-json.*`](../packages/runtime/test/fixtures/herdr/agent-explain/) → exit 0.
- Unrecognised pane: [`agent-explain/unrecognized-cli.*`](../packages/runtime/test/fixtures/herdr/agent-explain/) → exit 1, `agent_not_found`: a pane running an unrecognised process has no agent identity to explain.

## Still to come (step 02b)

The five research questions (pane-ID targeting, `--until` values, passing agent flags, unrecognised
CLIs, in-pane detection) and the summary of where these findings contradict `PLAN.md` are held back
for step 02b, to keep this step inside the size limit. Their evidence is already captured: every
fixture they cite is present in `packages/runtime/test/fixtures/herdr/`, including
`pane-current/`, `pane-report-agent/`, `pane-get/known-agent-unknown.*` and
`agent-wait/*-unknown*`, which no section above references yet.

## Not covered here

Agent model flags and read-only enforcement are step 03; capturing real review output for the
verdict parser is step 04. `herdr api schema` / `herdr api snapshot` were noted but not explored.
