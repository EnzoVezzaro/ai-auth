// Step recorder: every check is named, timed and printed as
// PASS / FAIL / KNOWN-BUG / PENDING / NETWORK, then summarized and written to
// test-results/e2e-report.json.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./helpers.mjs";

/** An SDK defect the step documents. Keeps the assertion; fails the run. */
export class KnownBug extends Error {
  constructor(observed, expected) {
    super(`observed: ${observed}; expected: ${expected}`);
    this.observed = observed;
    this.expected = expected;
  }
}

/** The network, not the product, prevented the check (ICE/relay failure). */
export class NetworkFailure extends Error {}

export class Pending extends Error {}

export function createReport() {
  const rows = [];
  const started = Date.now();
  const print = (row) =>
    console.log(
      `[${row.status}] ${String(row.step).padStart(2, " ")}. ${row.name} (${row.durationMs} ms)${row.note ? `\n        ${row.note}` : ""}`,
    );
  return {
    rows,
    /** Runs one named check. `evidence` is mutated by the step for the report. */
    async step(step, name, fn) {
      const evidence = {};
      const t0 = Date.now();
      let status = "PASS";
      let note = "";
      try {
        await fn(evidence);
      } catch (error) {
        if (error instanceof Pending) {
          status = "PENDING";
          note = error.message;
        } else if (error instanceof KnownBug) {
          status = "KNOWN-BUG";
          note = error.message;
          evidence.observed = error.observed;
          evidence.expected = error.expected;
        } else if (error instanceof NetworkFailure) {
          status = "NETWORK";
          note = error.message;
        } else {
          status = "FAIL";
          note = String(error?.stack ?? error)
            .split("\n")
            .slice(0, 6)
            .join("\n        ");
        }
      }
      const row = {
        step,
        name,
        status,
        durationMs: Date.now() - t0,
        note,
        evidence,
      };
      rows.push(row);
      print(row);
      return row;
    },
    summary() {
      const ordered = [...rows].sort((a, b) => a.step - b.step);
      const lines = ["", "Step | Status    | ms     | Check"];
      for (const row of ordered)
        lines.push(
          `${String(row.step).padStart(4)} | ${row.status.padEnd(9)} | ${String(row.durationMs).padStart(6)} | ${row.name}`,
        );
      const count = (status) => rows.filter((r) => r.status === status).length;
      lines.push(
        "",
        `PASS ${count("PASS")}  FAIL ${count("FAIL")}  KNOWN-BUG ${count("KNOWN-BUG")}  NETWORK ${count("NETWORK")}  PENDING ${count("PENDING")}`,
      );
      return lines.join("\n");
    },
    passed: () => rows.every((row) => row.status === "PASS"),
    async write(extra = {}) {
      const dir = resolve(root, "test-results");
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "e2e-report.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            ...extra,
            steps: [...rows].sort((a, b) => a.step - b.step),
          },
          null,
          2,
        ),
      );
    },
  };
}
