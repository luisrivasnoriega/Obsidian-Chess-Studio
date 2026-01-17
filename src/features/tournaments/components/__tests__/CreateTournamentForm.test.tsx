import { beforeAll, describe, expect, test, vi } from "vitest";
import { CreateTournamentForm } from "../../components/CreateTournamentForm";
import { render } from "./test-utils";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

describe("CreateTournamentForm", () => {
  test("renders without crashing", () => {
    render(<CreateTournamentForm lichessToken={null} accountName={null} />);
    expect(document.body).toBeTruthy();
  });
});
