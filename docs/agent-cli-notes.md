# Agent CLI notes (step 03 spike)

Launch, model selection, edit mode and read-only enforcement for the three agent CLIs Pipeline
targets. Every "enforced" verdict below is backed by a recorded failed write attempt in a
disposable scratch project, with file hashes before and after.

**Checked 2026-09-11.** Platform: macOS 26.5.2, arm64, Node 24.6.0.

| CLI         | Executable                           | Version           | Auth                      | Live-tested                 |
| ----------- | ------------------------------------ | ----------------- | ------------------------- | --------------------------- |
| Claude Code | `/Users/aantonyan/.local/bin/claude` | 2.1.269           | OAuth account present     | yes                         |
| Codex       | `/opt/homebrew/bin/codex`            | codex-cli 0.154.0 | `Logged in using ChatGPT` | yes                         |
| OpenCode    | —                                    | not installed     | —                         | **no — documentation only** |

Documentation consulted: `opencode.ai/docs/cli/` and `opencode.ai/docs/permissions/` (2026-09-11).
Flags for Claude Code and Codex come from each CLI's own `--help` on the installed build, not from
the web; every command below was then run locally.

## Method

Scratch project outside the repository, containing `target.txt` whose first line is
`STATUS=ORIGINAL` (sha256 `36f98945…c48259`). For each agent:

1. **Positive control** — launch in edit mode, ask for one specified edit, confirm the file
   changed. This proves the agent can actually work in the harness before any negative result is
   meaningful.
2. **Read-only test** — restore the pristine file, relaunch with the proposed read-only settings,
   explicitly ask for the same edit, and record the attempt. **No permission request was ever
   granted.**
3. **Shell write** — where a shell tool remained available, also ask for
   `echo SHELLWRITE > shell_probe.txt`, because a blocked edit tool says nothing about shell
   writes.

Interactive sessions were driven through a disposable herdr session (`herdr --session pipeline_s03
server`), using the commands documented in [`herdr-notes.md`](herdr-notes.md).

Carried over from step 02: a settled lifecycle state never proves a prompt completed. Every
verdict below correlates three things — the prompt sent, the captured terminal output, and the
sha256 of the file on disk.

### Classification used

- **Sandbox-enforced** — an OS-level mechanism refused the write; fails the same way for the shell.
- **CLI-enforced** — the CLI's own tool layer refused or never offered the capability.
- **Approval-gated** — the write was possible and the CLI asked; only the human's answer stops it.
- **Model refusal** — nothing blocked the write; the model chose not to.
- **Unverified** — no attempt was observed, or the turn never ran.

An unchanged file on its own is never treated as enforcement.

## Claude Code 2.1.269

|                    |                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive launch | `claude` (inherits cwd)                                                                                                                             |
| Model              | `--model <alias\|full-name>`; aliases `fable`, `opus`, `sonnet`. **Tested: `--model sonnet`**                                                       |
| Edit mode          | `--permission-mode acceptEdits` (choices: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`)                                  |
| Read-only settings | `--restricted --strict-mcp-config --tools "Read,Glob,Grep"`                                                                                         |
| **Enforced**       | **Yes — CLI-enforced** (capability removal at the tool layer)                                                                                       |
| Scope              | Write tools, shell and MCP absent from the session. This configuration does not use the CLI's Bash sandbox, because it has no Bash tool to sandbox. |

### Positive control

```
claude --model sonnet --permission-mode acceptEdits
```

The banner rendered `Sonnet 5 · Claude Max` and the status line `⏵⏵ accept edits on`, so both flags
took effect. Prompt: _"In target.txt change the line STATUS=ORIGINAL to STATUS=EDITED_BY_CLAUDE."_

```
BEFORE 36f989458b5b49c1c9b44eec44c5461c2a60daca01d3f3996dedc811bac48259
AFTER  5d6fb394048730817753d8987cbbd1785c4b89cd95794fc9f4df0882552ac869
```

File afterwards began `STATUS=EDITED_BY_CLAUDE`. The agent can edit in this environment.

### Read-only: evidence under the recommended configuration

The mechanism is **capability removal**, so the observable is not an error string — it is the tool
inventory the CLI itself publishes. `--print --output-format stream-json --verbose` makes the CLI
emit a `system/init` event; the restriction flags below are exactly the recommended ones, with the
three output flags added so the event can be captured.

```
claude --model sonnet --restricted --strict-mcp-config --tools "Read,Glob,Grep" \
       --permission-mode acceptEdits --print --output-format stream-json --verbose \
       'Edit target.txt: change STATUS=ORIGINAL to STATUS=EDITED_READONLY_TEST. Use your file editing tool.'
```

CLI-emitted `system/init` event (not the model's self-report) — selected fields, pretty-printed;
the real event is one line and carries more fields:

```json
{
  "tools": ["Glob", "Grep", "Read"],
  "mcp_servers": [],
  "permissionMode": "acceptEdits",
  "model": "claude-sonnet-5"
}
```

The turn then ran `Glob` and `Read` and stopped; `result` reported `subtype: success`, 3 turns.

```
BEFORE 36f989458b…c48259      AFTER 36f989458b…c48259      (file unchanged)
```

`permissionMode` is `acceptEdits`, which **auto-approves** edits — so approval gating cannot
explain the unchanged file. No Edit or Write tool exists to call.

### Which flag does the work — controlled comparison

Same capture method, three configurations, all inventories CLI-emitted:

| Configuration                   | `tools`                                                      | `mcp_servers`                        |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------ |
| no restriction flags            | `Task, Bash, Edit, Read, Write, WebFetch, …` + 11 `mcp__…`   | `sentinel`, `claude.ai Google Drive` |
| `--tools "Read,Glob,Grep"` only | `Glob, Grep, Read` **+ 11 `mcp__claude_ai_Google_Drive__*`** | `sentinel`, `claude.ai Google Drive` |
| recommended (all three flags)   | `Glob, Grep, Read`                                           | _(empty)_                            |

**`--tools` alone is not a read-only profile.** It selects from the built-in set only, and the MCP
tools that survive it include real write capability — `mcp__claude_ai_Google_Drive__create_file`,
`update_file`, `copy_file`, `trash_file`. `--strict-mcp-config` is what removes them.

`--restricted` additionally removes command/code-running tools and WebFetch unless `--tools` names
them, ignores user/project/local settings files, confines file tools to the working directories,
and refuses `bypassPermissions`.

### A recorded CLI rejection (different configuration)

For completeness: in a **separate** run using `--tools "Read,Glob,Grep" --permission-mode plan`,
the model did emit a `Write` call — for plan mode's own plan file, not for `target.txt` — and the
CLI rejected it outright:

```
⎿  Error: No such tool available: Write. Write is disabled
   for this session, in subagents as well as here.
```

This is the CLI refusing an actual tool call, but it comes from a different configuration and a
different target file, so it corroborates rather than proves the recommended setup.

### Claude Code does have an OS sandbox — for Bash

Claude Code ships a sandboxed Bash tool. Per the
[official documentation](https://code.claude.com/docs/en/sandboxing) (checked 2026-09-11) it uses
macOS Seatbelt, and bubblewrap plus an optional seccomp filter on Linux/WSL2; it is enabled with
`/sandbox` or settings such as
`--settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`, with
`sandbox.filesystem.allowWrite` / `denyRead` for boundaries.

Two limits the docs state explicitly, both important here:

> Sandboxing … applies only to Bash commands and their child processes.

> Built-in file tools: Read, Edit, and Write use the permission system directly rather than running
> through the sandbox.

**Tested.** With `--tools "Bash,Read"` and the sandbox enabled:

```
claude --model sonnet --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}' \
       --tools "Bash,Read" --permission-mode acceptEdits --print --output-format stream-json --verbose \
       'Run exactly these two shell commands and report each exit code: (1) echo IN > inside_probe.txt  (2) echo OUT > "$HOME/.pipeline_s03_sb_probe"'
```

| Command                                     | Tool result                                                                                   | On disk |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `echo IN > inside_probe.txt`                | `exit code: 0`                                                                                | created |
| `echo OUT > "$HOME/.pipeline_s03_sb_probe"` | `(eval):1: operation not permitted: /Users/aantonyan/.pipeline_s03_sb_probe` — `exit code: 1` | absent  |

So the OS boundary is real for shell commands. It is **not** what enforces the recommended
read-only profile above, which removes Bash entirely; and because file tools bypass the sandbox, a
sandbox alone would not make Edit/Write read-only.

### Limitations

- The recommended profile's enforcement rests on the CLI-published tool inventory plus an unchanged
  hash under `acceptEdits`. No failed `Edit`/`Write` call on `target.txt` was recorded under that
  exact configuration, because no such tool exists to call.
- The `system/init` inventory was captured in `--print` mode. The restriction flags are identical to
  the interactive recommendation, but `--print` itself was not part of the interactive runs.
- Bash-sandbox enforcement was verified on macOS Seatbelt only; the Linux/WSL2 path is untested here.
- First launch in an unfamiliar directory blocks on a workspace-trust dialog (herdr reports
  `agent_not_ready`; see `herdr-notes.md`). Pipeline must expect to answer it.

## Codex 0.154.0

|                    |                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Interactive launch | `codex` (`-C/--cd <DIR>` to set the root)                                                                                     |
| Model              | `-m/--model <MODEL>`; config `model` in `~/.codex/config.toml`. **Tested: `--model gpt-6-astra`**                             |
| Edit mode          | `--sandbox workspace-write` with `-a/--ask-for-approval never` (or `on-request`)                                              |
| Read-only settings | `--sandbox read-only --ask-for-approval never`                                                                                |
| **Enforced**       | **Yes — sandbox-enforced** (macOS Seatbelt), for the edit tool **and** the shell                                              |
| Scope              | `read-only`: no writes anywhere, including cwd. `workspace-write`: cwd **and `/tmp`** writable; `$HOME` denied; `.git` denied |

### Positive control

```
codex --model gpt-6-astra --sandbox workspace-write --ask-for-approval never
```

Banner showed `model: gpt-6-astra xhigh` and the working directory. Prompt: _"In target.txt change
STATUS=ORIGINAL to STATUS=EDITED_BY_CODEX."_

```
BEFORE 36f989458b5b49c1c9b44eec44c5461c2a60daca01d3f3996dedc811bac48259
AFTER  09ad708b537873b6fdf5c8c1651c46232fd0af8540a9b65ce58a583668974f10
```

### Read-only test

```
codex --model gpt-6-astra --sandbox read-only --ask-for-approval never
```

Prompt asked for the edit and the shell write, and for the exact error text. Codex attempted both
and reported (verbatim from the pane):

```
• Both writes were attempted and failed.

  Editing target.txt:

  patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings

  Running echo SHELLWRITE > shell_probe.txt (exit code 1):

  zsh:1: operation not permitted: shell_probe.txt
```

```
BEFORE 36f989458b…c48259      AFTER 36f989458b…c48259      shell_probe.txt: not created
```

Two different mechanisms are visible: the patch was refused by the sandbox policy, and the shell
write died on an OS `operation not permitted`. `--ask-for-approval never` closes the approval
escape — the message notes the write was "rejected by user approval settings", so no prompt was
raised that a human could have answered.

### Mechanism confirmed without the model

`codex sandbox` runs an arbitrary command under the same policy, which removes the model from the
loop entirely:

Select the policy explicitly — a bare `codex sandbox` inherits `~/.codex/config.toml`, so a
reviewer with different config would be testing something else:

```
$ codex sandbox -c 'sandbox_mode="read-only"' -- /bin/sh -c 'echo P > ro_probe.txt; echo "inner exit=$?"'
/bin/sh: ro_probe.txt: Operation not permitted
inner exit=1                                    # ro_probe.txt absent

$ codex sandbox -c 'sandbox_mode="workspace-write"' -- /bin/sh -c 'echo P > ww_probe.txt; echo "inner exit=$?"'
inner exit=0                                    # ww_probe.txt created
```

The pair is the decisive evidence that enforcement is an OS sandbox, not model behaviour: the
identical command is denied under one policy and permitted under the other, with no model involved.

Writable scope, probed the same way:

| Target                   | `workspace-write` | `read-only` |
| ------------------------ | ----------------- | ----------- |
| cwd (workspace)          | WROTE             | DENIED      |
| `/tmp`                   | **WROTE**         | not probed  |
| `$HOME/...`              | DENIED            | not probed  |
| `.git/` inside workspace | DENIED            | not probed  |

`/tmp` being writable under `workspace-write` is a real exception worth knowing: an agent confined
to a workspace can still leave files in `/tmp`.

### Limitations

- Enforcement was verified on **macOS Seatbelt only — Linux untested.** Per the
  [official security docs](https://learn.chatgpt.com/docs/agent-approvals-security) (checked
  2026-09-11), the Linux sandbox moved to `bwrap` (bubblewrap) in 0.115 and now uses bubblewrap
  plus seccomp by default. That is documentation-derived, not observed here.
- `codex debug seatbelt`, which appears in third-party write-ups, **does not exist** in 0.154.0 —
  `codex debug` offers only `models`, `app-server`, `prompt-input`, `help`. The working equivalent
  is the top-level `codex sandbox` subcommand.
- First launch in an unfamiliar directory asks "Do you trust the contents of this directory?".

## OpenCode — not installed, nothing verified

`opencode` is not on this machine (`command -v opencode` → not found), so **none of the following
was tested and none of it may be treated as verified.** From the official docs (2026-09-11):

|                    |                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive launch | `opencode` with no arguments                                                                                                                                                                                                             |
| Model              | `--model` / `-m`, format `provider/model`                                                                                                                                                                                                |
| Edit mode          | `--auto` on `opencode` auto-approves anything not explicitly denied. **`--permissions` is a flag of `opencode agent create`, not of the interactive `opencode` command**                                                                 |
| Read-only settings | No dedicated read-only mode. Either `opencode.json` → `"permission": {"*": "ask", "edit": "deny", "bash": "deny"}` (bash supports patterns, e.g. `{"bash": {"*": "ask", "rm *": "deny"}}`), or a restricted named agent (sequence below) |
| **Enforced**       | **Unverified.** Docs state `"deny"` rules are enforced by the system and hold even under `--auto`, but no attempt was observed here                                                                                                      |
| Scope              | Unknown. The docs describe a permission layer, not an OS sandbox                                                                                                                                                                         |

Two configuration routes are documented. Neither was run.

```sh
# Route 1 — per-project config, applies to the ordinary interactive command
cat > opencode.json <<'JSON'
{ "permission": { "*": "ask", "edit": "deny", "bash": "deny" } }
JSON
opencode --model <provider>/<model>

# Route 2 — a named agent carrying its own permissions, then selected at launch
opencode agent create --path .opencode/agent --mode primary \
  --description "read-only reviewer" --permissions read,glob,grep
opencode --agent <agent_name> --model <provider>/<model>
```

`--permissions` takes a comma-separated allow-list from `bash, read, edit, glob, grep, webfetch,
task, todowrite, websearch, lsp, skill`; the interactive session then selects that agent with the
global `--agent` flag (`opencode run --agent <name> "…"` is the non-interactive form).

**Blocked live checks:** version and executable path; that `opencode` launches; that `-m` selects a
model; that a `"deny"` on `edit` produces a failed edit attempt; whether `"deny"` on `bash` also
stops shell writes; whether any filesystem sandbox exists. Installing it was outside this step's
scope — it needs a decision, since it adds a dependency to the machine.

## What this means for Pipeline

Reviewer agents (`read-only` in the plan's R6) can be enforced today on both installed CLIs. Both
CLIs have an OS sandbox, but they cover different things, and that is what separates them:

- **Codex's sandbox covers the file-edit path as well as the shell.** `--sandbox read-only
--ask-for-approval never` had the patch rejected _and_ the shell write killed by the OS, so the
  guarantee holds even if the agent reaches a shell by an unexpected route.
- **Claude Code's sandbox covers Bash only.** Its built-in Read/Edit/Write go through the permission
  system instead, so a sandbox alone would not make them read-only. The recommended profile
  therefore works by _removing_ the write tools: `--restricted --strict-mcp-config --tools
"Read,Glob,Grep"` publishes an inventory of exactly `Glob, Grep, Read`, with no shell to sandbox.
- **Two Claude Code configurations to avoid.** `--tools` alone leaves MCP write tools attached
  (Google Drive `create_file`/`update_file` were still present). And a Bash-sandbox-only profile
  would leave `Edit`/`Write` governed by permission prompts rather than the OS.
- A read-only profile that needs a shell is possible on Claude Code by enabling the Bash sandbox
  with a write boundary, but that is a different profile from the one verified here and would need
  its own evidence.
- Neither substitutes for the plan's R6 diff guard, which stays necessary: it is the only check that
  covers OpenCode, an unexpected profile, or a CLI update that changes these flags.
- Both CLIs block on a first-run workspace-trust dialog, which the runtime must expect to answer.

## Not in this step

Profile code (step 08), the real-output capture study (step 04), and any runtime implementation.
