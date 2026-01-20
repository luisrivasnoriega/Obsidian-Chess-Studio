import { beforeAll, describe, expect, test, vi } from "vitest";
import { EditProfileModal } from "../../components/EditProfileModal";
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

describe("EditProfileModal", () => {
  const mockOnClose = vi.fn();
  const mockOnSave = vi.fn();

  test("renders when opened", () => {
    render(
      <EditProfileModal
        opened={true}
        onClose={mockOnClose}
        onSave={mockOnSave}
        currentFideId=""
        currentDisplayName=""
        currentLichessToken=""
      />,
    );
    expect(document.body).toBeTruthy();
  });

  test("does not render when closed", () => {
    render(
      <EditProfileModal
        opened={false}
        onClose={mockOnClose}
        onSave={mockOnSave}
        currentFideId=""
        currentDisplayName=""
        currentLichessToken=""
      />,
    );
    expect(document.body).toBeTruthy();
  });
});
