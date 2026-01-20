import { beforeAll, describe, expect, test, vi } from "vitest";
import { FileTypeSelector } from "../../components/FileTypeSelector";
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

describe("FileTypeSelector", () => {
  const mockOnChange = vi.fn();

  test("renders without crashing", () => {
    render(<FileTypeSelector value="game" onChange={mockOnChange} />);
    expect(document.body).toBeTruthy();
  });
});
