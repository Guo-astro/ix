// Copyright 2026 Ix Infrastructure Inc.

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { renderEdgeResultsLlm, sliceEdgeResults, sliceRanked } from "../format.js";
import { nextPageCommand } from "../paging.js";
import { renderInventoryLlm } from "../commands/inventory.js";
import { scanWindow, textResultPriority } from "../commands/text.js";

function node(name: string, path?: string) {
  return { id: `${name}-0000-0000-0000-000000000000`, name, kind: "function", ...(path ? { provenance: { source_uri: path } } : {}) };
}

describe("sliceRanked", () => {
  it("reports the count before the cut, not after it", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`caller${i}`, "src/a.ts"));
    const slice = sliceRanked(all, 50);
    expect(slice.shown).toBe(50);
    expect(slice.total).toBe(212);
    expect(slice.truncated).toBe(true);
  });

  it("is not truncated when everything fits", () => {
    const slice = sliceRanked([node("a", "src/a.ts")], 50);
    expect(slice).toMatchObject({ shown: 1, total: 1, truncated: false });
  });

  it("keeps the source order among rows that rank equally", () => {
    const all = [node("b", "src/b.ts"), node("a", "src/a.ts")];
    expect(sliceRanked(all, 10, () => 0).rows.map((n) => n.name)).toEqual(["b", "a"]);
  });

  it("does not mutate the caller's array", () => {
    const all = [node("b", "src/b.ts"), node("a")];
    const copy = [...all];
    sliceRanked(all, 10, (n) => (n.provenance ? 0 : 1));
    expect(all).toEqual(copy);
  });
});

describe("sliceEdgeResults", () => {
  it("keeps followable rows over dangling ones when the cut bites", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method" },
      { id: "cccccccc-3333-0000-0000-000000000000", name: "verify", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const rows = sliceEdgeResults(all, 2).rows.map((n) => n.name);
    expect(rows).toEqual(["verify", "handleLogin"]);
  });

  it("still reports the rows it dropped", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const header = renderEdgeResultsLlm(sliceEdgeResults(all, 1), "callers", "verify_token", "graph")[0];
    expect(header).toBe("callers target=verify_token shown=1 total=2 resolved=1");
  });

  it("names the flag that would show the rest", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`c${i}`, "src/a.ts"));
    const lines = renderEdgeResultsLlm(sliceEdgeResults(all, 50), "callers", "verify_token", "graph");
    expect(lines[1]).toBe(
      'diagnostic code=results_truncated next_offset=50 message="212 callers; showing 50. next: --offset 50"',
    );
  });
});

describe("paging with --offset", () => {
  const mixed = () => [
    ...Array.from({ length: 70 }, (_, i) => node(`p${i}`, "src/a.ts")),
    ...Array.from({ length: 70 }, (_, i) => node(`n${i}`)),
    ...Array.from({ length: 72 }, (_, i) => ({ id: `${i.toString(16).padStart(8, "0")}-1111-0000-0000-000000000000`, name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" })),
  ];

  it("pages concatenate to the full ranked list with no overlap or gap", () => {
    const all = mixed();
    const full = sliceEdgeResults(all, Infinity).rows;
    const got: any[] = [];
    let offset = 0;
    for (;;) {
      const s = sliceEdgeResults(all, 50, offset);
      got.push(...s.rows);
      if (s.nextOffset === undefined) break;
      offset = s.nextOffset;
    }
    expect(got).toEqual(full);
    expect(new Set(got.map((n) => n.id)).size).toBe(212);
  });

  it("a middle page names the next offset", () => {
    const s = sliceEdgeResults(mixed(), 50, 50);
    expect(s).toMatchObject({ offset: 50, shown: 50, total: 212, truncated: true, nextOffset: 100 });
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines[0]).toBe("callers target=t offset=50 shown=50 total=212 resolved=50");
    expect(lines[1]).toContain("next_offset=100");
    expect(lines[1]).toContain("showing 51-100. next: --offset 100");
  });

  it("uses the caller's next command when given", () => {
    const s = { ...sliceEdgeResults(mixed(), 50), next: "ix callers t --offset 50" };
    expect(renderEdgeResultsLlm(s, "callers", "t", "graph")[1]).toContain("next: ix callers t --offset 50");
  });

  it("the last page has no hint", () => {
    const s = sliceEdgeResults(mixed(), 50, 200);
    expect(s).toMatchObject({ shown: 12, truncated: false });
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.includes("results_truncated"))).toBe(false);
  });

  it("past the end says so instead of no_edges", () => {
    const s = sliceEdgeResults(mixed(), 50, 300);
    expect(s).toMatchObject({ rows: [], total: 212, truncated: false });
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.startsWith("diagnostic code=offset_past_end"))).toBe(true);
    expect(lines.some((l) => l.includes("no_edges"))).toBe(false);
  });

  it("--limit 0 gives no next offset and does not claim past-the-end", () => {
    const s = sliceEdgeResults(mixed().slice(0, 5), 0);
    expect(s).toMatchObject({ rows: [], shown: 0, total: 5, truncated: true });
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines[1]).toBe('diagnostic code=results_truncated message="5 callers; showing 0. Raise --limit to see them."');
    expect(lines.some((l) => l.includes("offset_past_end") || l.includes("no_edges"))).toBe(false);
  });

  it("an offset with --limit 0 is not past the end while rows remain", () => {
    const s = sliceEdgeResults(mixed(), 0, 50);
    expect(s.nextOffset).toBeUndefined();
    const lines = renderEdgeResultsLlm(s, "callers", "t", "graph");
    expect(lines.some((l) => l.includes("offset_past_end"))).toBe(false);
  });

  it("leaves the header and rows alone without an offset", () => {
    const lines = renderEdgeResultsLlm(sliceEdgeResults([node("a", "src/a.ts")], 50), "callers", "t", "graph");
    expect(lines[0]).toBe("callers target=t shown=1 total=1 resolved=1");
    expect(lines).toHaveLength(2);
  });
});

describe("nextPageCommand", () => {
  function parsed(argv: string[]): Command {
    const cmd = new Command("callers")
      .argument("<symbol>")
      .option("--limit <n>", "", "50")
      .option("--kind <kind>")
      .option("--offset <n>", "", "0")
      .exitOverride();
    cmd.parse(argv, { from: "user" });
    return cmd;
  }

  it("keeps only typed options and drops --offset", () => {
    const cmd = parsed(["--kind", "method", "--offset", "50", "x"]);
    expect(nextPageCommand(cmd, ["x"], 100)).toBe("ix callers --kind method --offset 100 x");
  });

  it("quotes a symbol with a space and guards a leading dash", () => {
    const cmd = parsed(["a b"]);
    expect(nextPageCommand(cmd, ["a b"], 50)).toBe("ix callers --offset 50 'a b'");
    expect(nextPageCommand(cmd, ["-x"], 50)).toBe("ix callers --offset 50 -- -x");
  });
});

describe("renderInventoryLlm", () => {
  it("says shown, and marks a full window rather than inventing a total", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes, true).slice(0, 2)).toEqual([
      "inventory kind=class shown=1 truncated=true",
      'diagnostic code=results_truncated message="More than 1 class entities exist. Raise --limit, or narrow with --path."',
    ]);
  });

  it("says nothing about truncation when the window was not full", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes)[0]).toBe("inventory kind=class shown=1");
  });
});

describe("text result ranking", () => {
  it("scans past the limit so ranking has something to rank", () => {
    expect(scanWindow(20)).toBe(100);
    expect(scanWindow(1)).toBe(5);
    expect(scanWindow(400)).toBe(500);
  });

  it("puts code above tests, and tests above prose", () => {
    expect(textResultPriority("ix-cli/src/cli/format.ts")).toBe(0);
    expect(textResultPriority("ix-cli/src/cli/__tests__/format.test.ts")).toBe(1);
    expect(textResultPriority("ix-cli/test/fixtures/a.ts")).toBe(1);
    expect(textResultPriority("README.md")).toBe(2);
    expect(textResultPriority("docs/api/README.md")).toBe(2);
    expect(textResultPriority("package-lock.json")).toBe(2);
  });

  it("reorders the answer before the limit cuts it", () => {
    const rows = [
      { path: "README.md", line_start: 1, line_end: 1, snippet: "a", engine: "ripgrep", score: 1 },
      { path: "docs/guide.md", line_start: 2, line_end: 2, snippet: "b", engine: "ripgrep", score: 1 },
      { path: "src/a.ts", line_start: 3, line_end: 3, snippet: "c", engine: "ripgrep", score: 1 },
    ];
    const slice = sliceRanked(rows, 1, (r) => textResultPriority(r.path));
    expect(slice.rows.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(slice.total).toBe(3);
  });
});
