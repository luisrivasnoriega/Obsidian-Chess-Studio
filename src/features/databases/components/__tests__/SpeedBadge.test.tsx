import React from "react";
import { describe, expect, test } from "vitest";
import { render, screen } from "./test-utils";
import SpeedBadge from "../../components/SpeedBadge";
import type { Speed } from "@/utils/db";

describe("SpeedBadge", () => {
  test("renders UltraBullet badge", () => {
    render(<SpeedBadge speed="UltraBullet" />);
    expect(screen.getByText("UltraBullet")).toBeInTheDocument();
  });

  test("renders Bullet badge", () => {
    render(<SpeedBadge speed="Bullet" />);
    expect(screen.getByText("Bullet")).toBeInTheDocument();
  });

  test("renders Blitz badge", () => {
    render(<SpeedBadge speed="Blitz" />);
    expect(screen.getByText("Blitz")).toBeInTheDocument();
  });

  test("renders Rapid badge", () => {
    render(<SpeedBadge speed="Rapid" />);
    expect(screen.getByText("Rapid")).toBeInTheDocument();
  });

  test("renders Classical badge", () => {
    render(<SpeedBadge speed="Classical" />);
    expect(screen.getByText("Classical")).toBeInTheDocument();
  });

  test("renders Correspondence badge", () => {
    render(<SpeedBadge speed="Correspondence" />);
    expect(screen.getByText("Correspondence")).toBeInTheDocument();
  });

  test("renders Unknown badge", () => {
    render(<SpeedBadge speed="Unknown" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

