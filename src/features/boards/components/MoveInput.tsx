import { Input } from "@mantine/core";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/TreeStateContext";
import { parseKeyboardMove } from "@/utils/chess";

export default function MoveInput({ currentFen }: { currentFen: string }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("MoveInput must be used within a TreeStateProvider");
  }

  const makeMove = useStore(store, (s) => s.makeMove);
  const [move, setMove] = useState("");
  const [error, setError] = useState("");

  return (
    <Input
      placeholder={t("board.moveInput.enterMove")}
      size="sm"
      onChange={(e) => {
        setMove(e.currentTarget.value);
        setError("");
      }}
      error={error}
      value={move}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const m = move.trim();
          if (m.length > 0) {
            const parsed = parseKeyboardMove(m, currentFen);
            if (parsed) {
              makeMove({ payload: parsed });
              setMove("");
            } else {
              setError(t("board.moveInput.invalidMove"));
            }
          }
        }
      }}
    />
  );
}
