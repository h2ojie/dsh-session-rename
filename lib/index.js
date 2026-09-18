/**
 * Host half of the session self-rename plugin.
 *
 * Registers one model-facing tool, `rename_session`, so an agent can name its
 * own conversation instead of depending only on automatic title generation.
 *
 * The tool is a thin wrapper over the `sessionTitle` service's `rename`, which
 * is the same entry point the GUI's manual rename uses: it appends a
 * `session/title` event with the `user` source. That source PINS the title —
 * in-flight automatic generation is superseded and later user messages schedule
 * none. An explicit `sessionTitle.refresh` is the deliberate unpin, and this
 * plugin deliberately does not expose one: a model able to unpin its own title
 * would hand the name back to the generator without the user asking.
 *
 * Plane: HOST. The row registers into the host `tools` registry and publishes
 * no service, so it needs no isolate realm — the same shape the base
 * composition uses for its own tool rows. The registry is keyed by owning
 * agent, so one host instance serves every session, and the title service and
 * session store it reaches are host-plane singletons by design.
 *
 * This file imports NOTHING. An out-of-tree plugin installed with
 * `dsh plugin add` is linked from its own directory, so Node resolves its bare
 * imports from there rather than from the profile — importing the harness's own
 * `defineTool` would fail at boot. A hand-written definition is a plain object
 * of exactly the shape the registry accepts, at the cost of owning argument
 * validation here, which `defineTool` would otherwise generate.
 */

/** Stable Loader identity. */
export const name = 'dsh-session-rename'

/**
 * Both are hard dependencies: without them the tool could only fail at call
 * time, so the row waits for them instead of registering a broken tool.
 * @type {readonly string[]}
 */
export const inject = ['tools', 'sessionTitle']

/**
 * Upper bound on the raw argument accepted. The title service normalizes and
 * enforces its own rules; this only stops an absurd payload from reaching it.
 */
const MAX_TITLE_INPUT_LENGTH = 512

/** Model-visible parameter schema, in the raw JSON Schema shape the registry expects. */
const PARAMETERS = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The new session title. Must contain at least one visible character.',
    },
  },
  required: ['title'],
}

/**
 * A ticket directory name sitting inside a path: `<12-digit stamp>-<ticket id>-<subject>`.
 *
 * The lookbehind anchor is the whole point. The digits must START a path segment,
 * so an identical number sequence written in prose never matches. That matters
 * because the rename below is permanent: a `user`-source title pins the session
 * and automatic title generation never returns to it (see the module doc).
 */
const TICKET_SEGMENT = /(?<=[\\/])(\d{12})-(\d{4,6})-([^\r\n\\/]+)/u

/** Subject code points carried into the title. */
const DEFAULT_TITLE_CHARS = 20

/**
 * A title this plugin, or a model using its own `rename_session` call, could
 * have produced: `<ticket id>-<subject>`. Only consulted in `once: false` mode,
 * where shape is the sole signal separating a ticket name (ours to move when the
 * ticket changes) from a name a human typed (never moved).
 */
const TICKET_SHAPED = /^\d{1,6}-/

/** Canonical output schema for a successful rename. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    seq: { type: 'integer' },
  },
  required: ['title', 'seq'],
}

/**
 * Validate the one argument this tool takes. `defineTool` generates this from
 * the schema; a hand-written definition must do it explicitly, because the
 * registry passes model arguments through without checking them against
 * `parameters`.
 *
 * @param {unknown} args - frozen model arguments, however malformed.
 * @returns {string} the accepted raw title.
 */
function readTitleArgument(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('rename_session expects an object with a "title" string')
  }
  const { title } = /** @type {Record<string, unknown>} */ (args)
  if (typeof title !== 'string') {
    throw new Error('rename_session requires "title" to be a string')
  }
  if (title.length > MAX_TITLE_INPUT_LENGTH) {
    throw new Error(`rename_session accepts a title of at most ${MAX_TITLE_INPUT_LENGTH} characters`)
  }
  return title
}

/**
 * Read `titleChars` from the raw config. There is no schema: this package has
 * no `node_modules` of its own, so importing schemastery for one number would
 * fail to resolve. Cordis passes an unvalidated config straight through when a
 * plugin exports no `Config`, so the check is ordinary and total — every
 * rejected value falls back to the default rather than failing the boot.
 *
 * @param {unknown} config - whatever the loader handed us.
 * @returns {number} a positive safe integer.
 */
function readTitleChars(config) {
  const value = config === null || typeof config !== 'object'
    ? undefined
    : /** @type {Record<string, unknown>} */ (config).titleChars
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_TITLE_CHARS
}

/**
 * Whether automatic renaming is enabled. On by default; `autoRename: false`
 * restores the plugin's original tool-only behavior.
 *
 * @param {unknown} config - whatever the loader handed us.
 * @returns {boolean}
 */
function readAuto(config) {
  const value = config === null || typeof config !== 'object'
    ? undefined
    : /** @type {Record<string, unknown>} */ (config).autoRename
  return value !== false
}

/**
 * Whether to rename at most once per session. On by default: the first ticket
 * names the session, and every later ticket in that session leaves it alone.
 *
 * `once: false` restores follow-the-ticket renaming, where a later ticket
 * rewrites a title this plugin produced. That matches the AGENTS.md rule "a
 * session analyzing several tickets is named for the one it is analyzing now",
 * at the cost of moving a title the user may already have settled on.
 *
 * @param {unknown} config - whatever the loader handed us.
 * @returns {boolean}
 */
function readOnce(config) {
  const value = config === null || typeof config !== 'object'
    ? undefined
    : /** @type {Record<string, unknown>} */ (config).once
  return value !== false
}

/**
 * Extract one ticket identity from free text.
 *
 * @param {string} text - a human message's concatenated text blocks.
 * @returns {{ ticketId: string, subject: string } | undefined} the FIRST match —
 *   a message naming two tickets is settled by the one it names first, which is
 *   also the one the model was told to look at first.
 */
function ticketOf(text) {
  const match = TICKET_SEGMENT.exec(text)
  if (match === null) return undefined
  return { ticketId: match[2], subject: match[3] }
}

/**
 * Build the title for one ticket. The subject is trimmed and truncated by code
 * points, never by bytes: the title service applies its own UTF-8 budget and
 * never splits a character, so cutting here is purely about length.
 *
 * @param {{ ticketId: string, subject: string }} ticket - extracted identity.
 * @param {number} titleChars - subject code points to keep.
 * @returns {string} `<ticket id>-<subject>`, with no ellipsis on truncation.
 */
function titleFor(ticket, titleChars) {
  const subject = ticket.subject.trim()
  const kept = [...subject].slice(0, titleChars).join('').trimEnd()
  return `${ticket.ticketId}-${kept}`
}

/** Concatenate a message's text blocks the way the model would read them. */
function textOf(message) {
  return (message.content ?? [])
    .filter(block => block !== null && typeof block === 'object')
    .map(block => typeof block.text === 'string' ? block.text : '')
    .join('')
}

/**
 * Register `rename_session` and, when enabled, rename the session from the
 * ticket path a human names.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host services.
 * @param {unknown} [config] - unvalidated loader config.
 */
export function apply(ctx, config) {
  ctx.tools.register({
    name: 'rename_session',
    description: 'Rename the current session/conversation. '
      + 'The new title is normalized and pinned as a user-owned title, which supersedes any in-flight '
      + 'automatic title generation and stops later automatic renaming. '
      + 'Use a short, specific title that describes the work of this conversation.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: `Session renamed to: ${value.title}` }]
      },
    },
    async execute(args, exec) {
      // A tool call carries its agent in ordinary use; a nested or agentless
      // dispatch does not, and there is no session to rename then.
      if (exec.agent === undefined) throw new Error('rename_session requires an agent Session')
      const title = readTitleArgument(args)
      // Let SessionTitleInvalidError propagate: its message already tells the
      // model exactly what a valid title requires.
      const accepted = ctx.sessionTitle.rename(exec.agent.session, title)
      return { title: accepted.title, seq: accepted.eventSeq }
    },
  })

  if (!readAuto(config)) return
  const titleChars = readTitleChars(config)
  const once = readOnce(config)

  // Rename from the ticket path a human names.
  //
  // `agent/pre-step` is the right seam: `messages` is exactly the batch this
  // step just claimed, so the ticket text is read once, at the step that owns
  // it. Later steps in the same turn claim `next-step` instead and see none of
  // it, and a reopened session claims nothing until someone speaks — which is
  // why a manual rename can never be undone by simply reopening the session.
  //
  // The listener observes and delegates: it never rejects, never rewrites, and
  // never throws into the waterfall. A title is cosmetic; failing a step over
  // one would be strictly worse than leaving the title alone.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    try {
      autoRename(ctx, agent, messages, titleChars, once)
    } catch (error) {
      // Contain everything: a rename must never break the turn.
      ctx.logger?.warn?.(`dsh-session-rename: auto-rename failed: ${String(error)}`)
    }
    return decision
  })
}

/**
 * Rename one session from the first ticket path in the claimed messages.
 *
 * Stateless on purpose: the decision is derived from the CURRENT title on every
 * call, never from in-memory memory of what we wrote. Process restarts, session
 * resume, and a manual rename mid-session therefore all behave identically —
 * and, in `once` mode, a session that already carries a user title stays put
 * forever without this plugin having to remember anything.
 *
 * In `once` mode (the default) the rule is simply: **rename only if the session
 * has no user-owned title yet.** Anything already standing that came from a
 * human, the model's own `rename_session`, or this plugin on an earlier ticket
 * ends it. The first ticket wins and later tickets in the same session never
 * move the title.
 *
 * With `once: false`, a title this plugin produced is rewritten when the ticket
 * changes, so the session follows the ticket currently being analyzed. A
 * non-ticket-shaped user title is still left alone, since that is the one signal
 * distinguishing a name a human typed from one a ticket produced.
 *
 * Known tradeoff of `once: false`: a hand-typed title that happens to look like
 * `<digits>-<text>` is indistinguishable from a ticket name, and will be
 * overwritten when the ticket changes. Shape is the only signal available — the
 * log records no author identity for a `user` title. `once: true` is immune,
 * because it stops on ANY user title regardless of shape.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host services.
 * @param {{ session: unknown } | undefined} agent - owning agent.
 * @param {readonly { source?: { kind?: string }, content?: readonly unknown[] }[]} messages - claimed messages.
 * @param {number} titleChars - subject code points to keep.
 * @param {boolean} once - rename at most once per session.
 * @returns {void}
 */
function autoRename(ctx, agent, messages, titleChars, once) {
  const session = agent?.session
  if (session === undefined) return
  // Only a human message can name the ticket. Injected context — workspace
  // rules, skill bodies, runtime policy, plugin notices — is not a request, and
  // honoring it would let any plugin rename the session behind the user's back.
  let ticket
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    ticket = ticketOf(textOf(message))
    if (ticket !== undefined) break
  }
  if (ticket === undefined) return

  const candidate = titleFor(ticket, titleChars)
  if (candidate.length === 0) return

  const current = ctx.sessionTitle.get(session)
  if (current !== undefined && current.source.kind === 'user') {
    // Something — a human, the model via `rename_session`, or this plugin on an
    // earlier ticket — already owns this title.
    if (once) return
    // Follow-the-ticket mode: only a title this plugin or the model produced is
    // ours to move, and only when the ticket actually changed. Shape is the one
    // signal separating those from a name a human typed.
    if (!TICKET_SHAPED.test(current.title)) return
    if (current.title === candidate) return
    if (current.title.slice(0, current.title.indexOf('-')) === ticket.ticketId) return
  }
  ctx.sessionTitle.rename(session, candidate)
}
