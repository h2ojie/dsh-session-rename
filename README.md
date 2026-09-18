# dsh-session-rename

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
names a session after the ticket it is analyzing, and gives the agent one tool,
`rename_session`, so it can name its own conversation instead of relying only on
automatic title generation.

**Two halves:**

- **Automatic** (on by default): when a human message contains a ticket
  directory path, the session is renamed to `<ticket id>-<subject>` immediately.
- **Manual** (`rename_session`): the agent can name the conversation itself once
  the work becomes clear.

Either way the new title shows up in the sidebar immediately and persists like a
hand-typed one.

## Automatic renaming

A ticket path is a directory segment shaped `<12-digit stamp>-<ticket id>-<subject>`:

```
\\10.40.73.81\data2\学习机BUG\202609181431-59758-【T90 Lite】【自动关机 重启】门店来电表示顾客的机器会出现自动\system-exceptions-...
Y:\学习机BUG\202609171111-59474-【T20Pro】【自动关机】网点表示不固定关机 多次 最近一次是13号\tombstones
```

These become:

```
59758-【T90 Lite】【自动关机 重启】门
59474-【T20Pro】【自动关机】网点表示不固
```

### When it fires

Only a **human** message can name the ticket, and only at the step that claims
it. Concretely:

| Situation | Renamed? |
|---|---|
| The message you send that contains the path | ✅ |
| Later steps of that same reply | ❌ — already claimed, not re-read |
| Reopening an old session without speaking | ❌ — nothing is claimed |
| Injected context (workspace rules, skill bodies, plugin notices) | ❌ — not a human message |
| **Any later ticket in the same session** | ❌ — **once per session** (see below) |
| A bare `202609181431-59758-…` written in prose with no path separator | ❌ — not a path |

### Once per session (default)

The first ticket names the session, and **nothing moves it afterward** — not a
later ticket, not a restart, not a resumed session. Once the session carries a
user-owned title, the plugin stops for good. That title may be yours, the
model's own `rename_session` output, or this plugin's from an earlier ticket; all
three end it.

This is deliberately in tension with the AGENTS.md rule "a session analyzing
several tickets is named for the one it is analyzing now". Set `once: false` for
that behavior: a title **this plugin produced** is then rewritten when the ticket
changes, so the session follows the current ticket. A title that is not
ticket-shaped is still left alone in both modes, since shape is the only signal
separating a name you typed from one a ticket produced.

The decision is recomputed from the current title on every call, never from
in-memory memory of what we wrote, so restarts and session resume behave
identically to a live session — the title itself is the memory.

Automatic fallback and LLM-generated titles are always taken over — that is the
point of the plugin.

### Known rough edge: the cut is literal

The subject is cut at **20 code points** (configurable via `titleChars`), with no
ellipsis. Because `【T90 Lite】` alone consumes 10 of them, real titles land
mid-word, as shown above. The cut is cosmetic and permanent for that ticket, but
you can always rename by hand, and `rename_session` still works.

### Configuration

Written in your profile's `cordis.patch.yml` (a patch targets the row by id and
replaces its whole config):

```yaml
- id: dsh-session-rename
  config:
    autoRename: true    # default: true. false → tool-only, as before 1.1.0
    once: true          # default: true. false → follow the current ticket
    titleChars: 20      # default: 20. subject code points kept
```

Unknown or invalid values fall back to the defaults rather than failing the boot.

## What `rename_session` actually does

`rename_session` takes a `title` and calls the harness `sessionTitle` service's
`rename` — the same entry point the GUI's own rename uses. The title is
normalized, appended to the session log as a `session/title` event with the
`user` source, and streamed to the browser.

## The one behavioral catch

A `user`-source title is **pinned** — this applies to both halves. Once a session
has one, whether from the automatic path or `rename_session`:

- any in-flight automatic title generation is superseded;
- later user messages schedule no automatic generation.

Unpinning requires an explicit `sessionTitle.refresh`, which this plugin
deliberately does not expose — a model able to unpin its own title would hand the
name back to the generator without the user asking.

**If you want automatic titles to keep working, do not install this plugin**, or
set `autoRename: false` to keep only the tool.

## Requirements

- A DSH deployment whose host composition mounts both `tools` and
  `session-title`. The stock `@deepseek-ai/dsh-base` bundle mounts both, so a
  default install already qualifies.
- Node.js >= 22.

## Install

Install straight from GitHub into the profile you run (`web`, `tui`, ...):

```sh
dsh plugin --profile web add github:h2ojie/dsh-session-rename
```

Or from a local clone:

```sh
git clone https://github.com/h2ojie/dsh-session-rename.git
dsh plugin --profile web add ./dsh-session-rename
```

`dsh plugin` forwards its arguments verbatim to pnpm inside the profile
directory, so any spec pnpm accepts works here.

If the install warns `declares no dsh.bundle — installed as a plain dependency`,
the plugin was **not** activated: that means pnpm resolved something other than
this package root. Check the spec and reinstall.

Then **restart the profile**. Adding a plugin registers it as a profile bundle in
the profile's `package.json`, which is read only at boot — a running process will
not pick it up, and live patch reload does not cover new bundle layers.

## Verify

Restart the profile first: the plugin mounts at boot, and live patch reload does
not cover new bundle layers.

Then send a message containing a ticket path. The sidebar title should become
`<ticket id>-<subject>` on that first reply. Send a **second, different** ticket
path: the title must not change — that is the once-per-session guarantee. Renaming
the session by hand also ends it for good.

For the tool half: ask the agent to rename the conversation. A blank title is
rejected with `session title must contain visible characters`.

## Uninstall

```sh
dsh plugin --profile web remove dsh-session-rename
```

Restart the profile afterward. Removing the plugin does not rename anything
back: titles it already set are session-log events and stay as they are, and a
pinned session stays pinned.

## Design notes

**Host plane.** The row registers into the host `tools` registry and publishes no
service, so it needs no isolate realm — the same shape the base composition uses
for its own tool rows. The registry is keyed by owning agent, so one host
instance serves every session, and every agent preset gets the tool without
having to copy a preset.

**No imports.** `lib/index.js` imports nothing at all. `dsh plugin add` links a
plugin from its own directory, so Node resolves its bare imports from there
rather than from the profile — importing the harness's own `defineTool` fails at
boot with `ERR_MODULE_NOT_FOUND`. The tool definition is therefore hand-written
in the raw shape the registry accepts, which also keeps this package decoupled
from harness versions. The cost is that argument validation is owned here rather
than generated; `test/apply.test.mjs` covers it.

**Name collision.** The tools registry rejects duplicate names outright, and a
duplicate makes the offending row fail to mount. If something else in your setup
already registers `rename_session` — including a temporary dynamic Cordis plugin
— remove it before installing this one.

**Why `agent/pre-step`, and why it is stateless.** That seam receives exactly the
batch the step just claimed, so the ticket text is read once, at the step that
owns it. The decision is then derived from the *current* title on every call
rather than from in-memory memory of what we wrote, so process restarts, session
resume, and a mid-session manual rename all behave identically. The listener
observes and delegates: it never rejects, never rewrites, and swallows every
error — a title is cosmetic, and failing a step over one would be strictly worse
than leaving the title alone.

**Why no config schema.** The package has no `node_modules` of its own, so
importing schemastery for two settings would fail to resolve. Cordis passes an
unvalidated config straight through when a plugin exports no `Config`, so the
values are checked by hand and rejected values fall back to defaults.

## Test

```sh
npm test
```

## License

MIT
