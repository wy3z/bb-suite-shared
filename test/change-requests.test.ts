import { describe, expect, it } from "bun:test";
import { changeRequestRowSchema, type ChangeRequest, type ChangeRequestRow } from "../src/change-requests.ts";

function row(ci: ChangeRequest["ci"]): unknown {
  return {
    outcome: "available",
    changeRequest: {
      identity: {
        provider: "github",
        instance: "https://github.com",
        projectPath: "wy3z/bb-plugins",
        number: 1,
        url: "https://github.com/wy3z/bb-plugins/pull/1",
      },
      title: "Ship it",
      state: "open",
      ci,
      sourceBranch: "feature/x",
      targetBranch: "main",
      updatedAt: null,
      fetchedAt: "2026-11-08T00:00:00.000Z",
      connection: null,
    },
  };
}

function available(parsed: ChangeRequestRow): ChangeRequest {
  if (parsed.outcome !== "available") throw new Error(`expected an available row, got ${parsed.outcome}`);
  return parsed.changeRequest;
}

describe("change request CI facts", () => {
  it("leaves a CI fact without a reason exactly as it was", () => {
    const parsed = available(changeRequestRowSchema.parse(row({ state: "passed" })));
    expect(parsed.ci.state).toBe("passed");
    expect("reason" in parsed.ci).toBe(false);
  });

  it("carries an unverified reason beside an unknown CI state", () => {
    const parsed = available(changeRequestRowSchema.parse(row({ state: "unknown", reason: "forbidden" })));
    expect(parsed.ci.state).toBe("unknown");
    expect(parsed.ci.reason).toBe("forbidden");
  });

  it("drops a reason the contract doesn't know instead of failing the row", () => {
    const parsed = available(changeRequestRowSchema.parse(row({ state: "unknown", reason: "made-up" } as ChangeRequest["ci"])));
    expect(parsed.ci.state).toBe("unknown");
    expect(parsed.ci.reason).toBeUndefined();
  });
});
