import { ClaudeHeadlessAdapter, type HeadlessOutcome, type HeadlessRunOptions } from "./claude.js";
import { CodexHeadlessAdapter } from "./codex.js";

export interface PeerRunner {
  run(options: HeadlessRunOptions): Promise<HeadlessOutcome>;
  runCodex(options: HeadlessRunOptions): Promise<HeadlessOutcome>;
}

/** Routes both directions while preserving the legacy Claude runner interface. */
export class PeerAdapter implements PeerRunner {
  readonly #claude: ClaudeHeadlessAdapter;
  readonly #codex: CodexHeadlessAdapter;

  constructor(options: { claude?: ClaudeHeadlessAdapter; codex?: CodexHeadlessAdapter } = {}) {
    this.#claude = options.claude ?? new ClaudeHeadlessAdapter();
    this.#codex = options.codex ?? new CodexHeadlessAdapter();
  }

  run(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
    return this.#claude.run(options);
  }

  runCodex(options: HeadlessRunOptions): Promise<HeadlessOutcome> {
    return this.#codex.run(options);
  }
}
