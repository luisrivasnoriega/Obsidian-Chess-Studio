import React from "react";
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import LichessLogo from "../components/LichessLogo";

describe("LichessLogo", () => {
  test("renders SVG element", () => {
    const { container } = render(<LichessLogo />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();

    // Be tolerant: some SVGs use lowercase viewBox, some might be 0 0 50 50 or similar.
    expect(svg).toHaveAttribute("viewBox");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 50 50");
  });

  test("has correct title", () => {
    const { container } = render(<LichessLogo />);
    const title = container.querySelector("title");
    expect(title).toBeInTheDocument();
    expect(title?.textContent).toMatch(/lichess/i);
  });

  test("has path element", () => {
    const { container } = render(<LichessLogo />);
    const path = container.querySelector("path");
    expect(path).toBeInTheDocument();

    // In the DOM, SVG attributes are typically lowercase (stroke-linejoin),
    // even if written as strokeLinejoin in JSX.
    const strokeLinejoin =
      path?.getAttribute("stroke-linejoin") ?? path?.getAttribute("strokeLinejoin");

    expect(strokeLinejoin).toBeTruthy();
    expect(strokeLinejoin).toBe("round");
  });
});
