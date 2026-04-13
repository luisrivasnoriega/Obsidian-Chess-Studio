import { beforeEach, describe, expect, test, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { consultOrionPlan } from "@/utils/orionPlan";

describe("consultOrionPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("invokes Tauri command with request payload", async () => {
    invokeMock.mockResolvedValue({
      plan: '{"overview":"Test"}',
      raw: '{"ok":true}',
    });

    const request = {
      apiKey: "secret-key",
      orientation: "white" as const,
      contextJson: '{"fen":"startpos"}',
      model: "gpt-4.1",
    };

    const result = await consultOrionPlan(request);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("consult_orion_plan", { request });
    expect(result.plan).toContain("overview");
  });
});
