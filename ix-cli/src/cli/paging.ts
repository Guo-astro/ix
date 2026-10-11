// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";

/** Help text for `--offset`, shared so the flag reads the same on every command. */
export const OFFSET_FLAG = "Skip the first N results (use the next: hint to page)";

/**
 * `--offset` as a number. The root option validator already rejects a typed
 * value that is not a non-negative integer, so this only supplies the default.
 */
export function parseOffset(raw?: string): number {
  const n = parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

function shellQuote(word: string): string {
  if (SAFE_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line that prints the next page: the same command, the same
 * positionals, the options the caller typed, and `--offset nextOffset`.
 */
export function nextPageCommand(cmd: Command, positionals: string[], nextOffset: number): string {
  const parts = ["ix", cmd.name()];
  for (const option of cmd.options) {
    const name = option.attributeName();
    if (option.long === "--offset") continue;
    if (cmd.getOptionValueSource(name) !== "cli") continue;
    const value = cmd.opts()[name];
    if (value === undefined || value === null || value === false) continue;
    if (value === true || !option.long) {
      if (option.long) parts.push(option.long);
      continue;
    }
    parts.push(option.long, shellQuote(String(value)));
  }
  parts.push("--offset", String(nextOffset));
  if (positionals.some((p) => p.startsWith("-"))) parts.push("--");
  for (const p of positionals) parts.push(shellQuote(p));
  return parts.join(" ");
}
