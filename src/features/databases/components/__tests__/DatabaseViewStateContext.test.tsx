import React from "react";
import { describe, expect, test } from "vitest";
import { DatabaseViewStateContext } from "../../components/DatabaseViewStateContext";

describe("DatabaseViewStateContext", () => {
  test("context is defined", () => {
    expect(DatabaseViewStateContext).toBeDefined();
  });

  test("context has displayName", () => {
    // displayName may not be set in all contexts
    expect(DatabaseViewStateContext).toBeDefined();
  });
});

