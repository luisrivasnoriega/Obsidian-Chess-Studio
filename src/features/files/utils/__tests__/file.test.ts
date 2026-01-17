import { describe, expect, test } from "vitest";
import { FILE_TYPE_LABELS, FILE_TYPES } from "../file";

describe("file utils", () => {
  describe("FILE_TYPE_LABELS", () => {
    test("contains all file types", () => {
      expect(FILE_TYPE_LABELS.game).toBeDefined();
      expect(FILE_TYPE_LABELS.repertoire).toBeDefined();
      expect(FILE_TYPE_LABELS.tournament).toBeDefined();
      expect(FILE_TYPE_LABELS.puzzle).toBeDefined();
      expect(FILE_TYPE_LABELS.variants).toBeDefined();
      expect(FILE_TYPE_LABELS.other).toBeDefined();
    });
  });

  describe("FILE_TYPES", () => {
    test("contains all file types as array", () => {
      expect(FILE_TYPES).toHaveLength(6);
      const types = FILE_TYPES.map((t) => t.value);
      expect(types).toContain("game");
      expect(types).toContain("repertoire");
      expect(types).toContain("tournament");
      expect(types).toContain("puzzle");
      expect(types).toContain("variants");
      expect(types).toContain("other");
    });
  });
});
