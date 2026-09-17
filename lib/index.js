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
 * Register `rename_session` for every agent that resolves this registry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host services.
 */
export function apply(ctx) {
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
}
