# dsh-session-rename

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
gives the agent one tool, `rename_session`, so it can name its own conversation
instead of relying only on automatic title generation.

Ask the agent to rename the conversation, or let it name the conversation once
the work becomes clear. The new title shows up in the sidebar immediately and
persists like a hand-typed one.

## What it actually does

`rename_session` takes a `title` and calls the harness `sessionTitle` service's
`rename` — the same entry point the GUI's own rename uses. The title is
normalized, appended to the session log as a `session/title` event with the
`user` source, and streamed to the browser.

## The one behavioral catch

A `user`-source title is **pinned**. Once the agent renames a session:

- any in-flight automatic title generation is superseded;
- later user messages schedule no automatic generation.

The agent can keep renaming, but the automatic titler will not take the name
back. Unpinning requires an explicit `sessionTitle.refresh`, which this plugin
deliberately does not expose — a model able to unpin its own title would hand
the name back to the generator without the user asking.

If you want automatic titles to keep working, do not install this plugin.

## Requirements

- A DSH deployment whose host composition mounts both `tools` and
  `session-title`. The stock `@deepseek-ai/dsh-base` bundle mounts both, so a
  default install already qualifies.
- Node.js >= 22.

## Install

Install straight from GitHub into the profile you run (`web`, `tui`, ...):

```sh
dsh plugin --profile web add github:h2ojie/dsh-session-rename#main --filter ./dsh-plugin
```

If that spec form gives your pnpm version trouble, clone and install from the
path instead — this is the reliable route:

```sh
git clone https://github.com/h2ojie/dsh-session-rename.git
dsh plugin --profile web add ./dsh-session-rename/dsh-plugin
```

`dsh plugin` forwards its arguments verbatim to pnpm inside the profile
directory, so any spec pnpm accepts works here.

Then **restart the profile**. Adding a plugin registers it as a profile bundle in
the profile's `package.json`, which is read only at boot — a running process will
not pick it up, and live patch reload does not cover new bundle layers.

## Verify

After the restart, ask the agent to rename the conversation. The sidebar title
should change immediately. A blank title is rejected with
`session title must contain visible characters`.

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

## Test

```sh
cd dsh-plugin && npm test
```

## License

MIT
