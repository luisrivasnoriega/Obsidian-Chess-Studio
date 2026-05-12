import { Text } from "@mantine/core";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { getOpening } from "@/utils/chess";
import { TreeStateContext } from "./TreeStateContext";

function OpeningName({ compact = false }: { compact?: boolean } = {}) {
  const [openingName, setOpeningName] = useState("");
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("OpeningName must be used within a TreeStateProvider");
  }
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const { t } = useTranslation();

  useEffect(() => {
    getOpening(root, position).then((v) => {
      // If we found an opening, update it
      if (v && v !== "") {
        setOpeningName(v);
      }
      // If no opening found, keep the last one we found (don't clear it)
      // This ensures the opening label persists even when moving to positions
      // that don't have a named opening in the database
    });
  }, [root, position]);

  return (
    <Text truncate={compact ? "end" : undefined} style={{ minWidth: 0, userSelect: "text" }} fz="sm" h="1.5rem">
      {openingName === "Empty Board"
        ? t("chess.opening.emptyBoard")
        : openingName === "Starting Position"
          ? t("chess.opening.startingPosition")
          : openingName}
    </Text>
  );
}

export default OpeningName;
