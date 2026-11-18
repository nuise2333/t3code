/* Token saver packs, sent with a message when they change and as a reminder.
 * Caveman Full is caveman-micro (MIT, kuba-guzik/caveman-micro), distilled from Caveman
 * (Apache-2.0, JuliusBrussee/caveman); Lite, Ultra and the exceptions follow Caveman's rules.
 * Savings figures are the projects' published benchmarks or estimates. */
import type { TokenSaverLevel, TokenSaverPack, TokenSaverSettings } from "@t3tools/contracts";

export interface TokenSaverPackInfo {
  readonly id: TokenSaverPack;
  readonly title: string;
  readonly summary: string;
  readonly saves: string;
  /** Runs only where the named command is installed. */
  readonly needs?: "rtk";
}

export const TOKEN_SAVER_PACKS: ReadonlyArray<TokenSaverPackInfo> = [
  {
    id: "caveman",
    title: "Caveman",
    summary: "Terse replies: answer first, no filler, every technical fact kept.",
    saves: "15–65% of replies",
  },
  {
    id: "lean-code",
    title: "Lean code",
    summary:
      "Least code that works: reuse what exists, no speculative extras, diffs not whole files.",
    saves: "~20–40% of code output (est.)",
  },
  {
    id: "quiet-tools",
    title: "Quiet tools",
    summary: "Targeted searches, line ranges, quiet flags, no re-reading files.",
    saves: "~20–50% of tool input (est.)",
  },
  {
    id: "rtk",
    title: "RTK compression",
    summary: "Runs commands through rtk, which compresses their output before the agent reads it.",
    saves: "60–90% of command output",
    needs: "rtk",
  },
];

export const TOKEN_SAVER_LEVELS: ReadonlyArray<{
  readonly id: TokenSaverLevel;
  readonly label: string;
  readonly hint: string;
}> = [
  { id: "lite", label: "Lite", hint: "Brief, normal grammar" },
  { id: "full", label: "Full", hint: "Caveman voice" },
  { id: "ultra", label: "Ultra", hint: "Telegraphic" },
];

const CAVEMAN: Record<TokenSaverLevel, string> = {
  lite: "Answer first. No greeting, preamble, recap, or offers of further help. Short sentences in normal grammar. Keep every technical detail, path, number and error exact.",
  full: [
    "Respond like smart caveman. Cut all filler, keep technical substance.",
    "- Drop articles (a, an, the), filler (just, really, basically, actually).",
    "- Drop pleasantries (sure, certainly, happy to).",
    "- No hedging. Fragments fine. Short synonyms.",
    "- Technical terms stay exact. Code blocks unchanged.",
    "- Pattern: [thing] [action] [reason]. [next step].",
  ].join("\n"),
  ultra: [
    "Telegraphic. Answer first, then reason, then next step. Drop articles, connectives and pleasantries.",
    "- One point per line; lists over prose. Code, diffs and commands over explanation.",
    "- No text between routine tool calls; one line per phase, one result line at the end.",
    "- Never drop not/never/no/only. Code, paths, numbers and errors stay verbatim.",
  ].join("\n"),
};

const EXCEPTIONS =
  "Use plain full sentences for security warnings, irreversible actions, ordered steps, questions to the user, and anything written to files, commits, PRs or docs.";

const GUIDANCE: Record<Exclude<TokenSaverPack, "caveman">, string> = {
  "lean-code":
    "Write the least code that fully solves the task. Reuse existing helpers, the standard library and platform features before adding code or dependencies. No speculative abstractions, options or unrequested features. No new comments or docs unless asked. In chat, show changed lines with minimal context, not whole files.",
  "quiet-tools":
    "Keep tool output small. Search with targeted patterns (rg -n pattern path, rg -l) instead of listing or dumping trees. Read only the line ranges you need; do not re-read a file you already read unless it changed. Use quiet flags (git --no-pager, -q, --silent) and cap long output with head or tail. Run the tests closest to the change before the full suite.",
  rtk: "rtk is installed and compresses command output. Prefix shell commands with rtk: rtk git status, rtk git diff, rtk git log, rtk ls, rtk read <file>, rtk grep <pattern>, rtk find, and test runners such as rtk npm test or rtk cargo test. If rtk rejects a command, run it plainly.",
};

/** Guidance is restated this many messages after it was last sent, so long threads keep it. */
export const TOKEN_SAVER_REMIND_EVERY = 8;

/** The packs that can run here, in the panel's order. */
export function activeTokenSaverPacks(
  packs: ReadonlyArray<TokenSaverPack>,
  available: { readonly rtk: boolean },
): ReadonlyArray<TokenSaverPack> {
  return TOKEN_SAVER_PACKS.map((pack) => pack.id).filter(
    (id) => packs.includes(id) && (id !== "rtk" || available.rtk),
  );
}

/** The guidance for a saver, or an explicit switch-off when no pack runs. */
export function tokenSaverGuidance(
  saver: TokenSaverSettings,
  available: { readonly rtk: boolean },
): string {
  const active = activeTokenSaverPacks(saver.packs, available);
  if (active.length === 0) {
    return '<t3_code_token_saver state="off">Token saver is off. Answer in your normal style again.</t3_code_token_saver>';
  }
  const lines = active.map((id) => (id === "caveman" ? CAVEMAN[saver.level] : GUIDANCE[id]));
  if (active.includes("caveman")) lines.push(EXCEPTIONS);
  return [
    "<t3_code_token_saver>",
    "Response style for this whole thread until changed; the reader pays per token:",
    lines.join("\n\n"),
    "</t3_code_token_saver>",
  ].join("\n");
}

/** Rough combined share of tokens saved, for the panel: savings compound, they don't add. */
export function tokenSaverEstimate(
  saver: TokenSaverSettings,
  available: { readonly rtk: boolean },
): number {
  const share: Record<TokenSaverPack, number> = {
    caveman: saver.level === "lite" ? 0.12 : saver.level === "full" ? 0.25 : 0.35,
    "lean-code": 0.12,
    "quiet-tools": 0.15,
    rtk: 0.2,
  };
  const kept = activeTokenSaverPacks(saver.packs, available).reduce(
    (left, id) => left * (1 - share[id]),
    1,
  );
  return Math.round((1 - kept) * 100);
}

/**
 * Whether a turn carries the guidance: the first turn after it changed, then every
 * TOKEN_SAVER_REMIND_EVERY turns while packs are on. An off switch is said once.
 */
export function tokenSaverDue(input: {
  /** Turns of this thread that started after the saver last changed, not counting this one. */
  readonly turnsSinceChange: number;
  readonly anyActive: boolean;
}): boolean {
  if (input.turnsSinceChange === 0) return true;
  return input.anyActive && input.turnsSinceChange % TOKEN_SAVER_REMIND_EVERY === 0;
}
