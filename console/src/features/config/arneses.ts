/**
 * Map of how each harness interacts with its configuration files and declared role.
 */

export interface ArnesReal {
  /** The same identifier as `HarnessKind` in services/gateway/src/console/agent-documents/catalog.ts:4, plus `hermes`. */
  id: string;
  label: string;
  /** Where it reads its directive, with the exact path. Empty string = reads none. */
  directiva: string;
  /** Why that path is the way it is, in one sentence. This is what prevents someone from "fixing" it by hand. */
  detalle: string;
  /**
   * Always `false`, and that is why it is a literal and not a bare boolean: today NO harness
   * document is written from "Settings and enrollments", not even those the gateway declares
   * editable — those are edited from the bot drawer, with facts measured inside the container.
   */
  editableDesdeAjustes: false;
  /** Where it IS touched. A "you cannot do that here" without a destination leaves the operator stranded. */
  dondeSeToca: string;
}

/**
 * The closed set. `hermes` is here even though it has no document, on purpose: half the fleet used it,
 * and its owner needs to read "this bot does not read any instructions file" instead of not finding it.
 */
export const ARNESES_REALES: readonly ArnesReal[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    directiva: '<HOME>/.claude/CLAUDE.md',
    detalle: 'If the process carries `CLAUDE_CONFIG_DIR`, the file moves with it — and that setting '
      + 'also drags the MCP `.claude.json` along, not just the manual.',
    editableDesdeAjustes: false,
    dondeSeToca: 'From the bot drawer in "The fleet now", and only when the pty-agent measured the '
      + "process's environment inside the container.",
  },
  {
    id: 'codex',
    label: 'Codex',
    directiva: '<HOME>/.codex/AGENTS.md',
    detalle: 'If the process carries `CODEX_HOME`, the directive is the one in THAT folder. There '
      + 'are aliases with both, of the same size, and the one in `~/.codex` is what a naive resolver '
      + 'would open.',
    editableDesdeAjustes: false,
    dondeSeToca: 'From the bot drawer in "The fleet now", with the process environment measured. Its '
      + '`config.toml` stays read-only: a malformed TOML prevents the bot from starting.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    directiva: '<HOME>/.openclaw/openclaw.json → field `agents`',
    detalle: 'It is not an instructions file: it is a field in its configuration JSON, the same '
      + 'document that carries `auth` and `secrets`. Serving it whole would be a leak, so it has to '
      + 'be projected field by field, and that is not done yet.',
    editableDesdeAjustes: false,
    dondeSeToca: 'Today through no screen: neither here nor in the bot drawer. It is edited by hand '
      + 'inside the container until the field-by-field projection exists.',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    directiva: '',
    detalle: 'The gateway does not resolve any for it: it falls back to the `default` of '
      + '`resolveAgentDocuments` and returns an empty list (services/gateway/src/console/agent-documents/catalog.ts:317). The only '
      + 'thing it receives ahead of its contract is the declared role.',
    editableDesdeAjustes: false,
    dondeSeToca: 'No document to touch. Its identity is given with the declared role, and that is '
      + 'written in the bot\'s "Profile" tab in "The fleet now".',
  },
];

/**
 * The closing of the panel: where the declared role is really written, and why this works for all
 * four harnesses alike: it is not read from any of the bot's files, Cauce prepends it in the envelope.
 */
export const DONDE_SE_ESCRIBE_EL_ROL_DECLARADO =
  'The declared role does not come from this screen either: `agents.role_brief` is a read-only '
  + 'projection and the generic editor refuses to mutate it. It is drafted in the bot\'s "Profile" '
  + 'tab in "The fleet now", on top of `agent_profiles.role_summary`, and from there it reaches all '
  + 'four harnesses alike because it does not live in any of the bot\'s files: the server reads it '
  + 'on delivery (`selfRoleFromProfile`, packages/store/src/repository/agents.ts:215), it travels in '
  + 'the envelope as `self_role`, and the adapter prepends it to the contract. That is why a bot '
  + 'without its own directive —hermes— still receives an identity.';
