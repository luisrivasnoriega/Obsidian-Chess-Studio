import { atomWithStorage } from "jotai/utils";
import type { GoMode } from "@/bindings";

export type ReportSettings = {
  novelty: boolean;
  reversed: boolean;
  humanStrategic: boolean;
  goMode: Exclude<GoMode, { t: "Infinite" }>;
  engine: string;
};

export const reportSettingsAtom = atomWithStorage<ReportSettings>("report-settings", {
  novelty: true,
  reversed: true,
  humanStrategic: false,
  goMode: { t: "Time", c: 500 },
  engine: "",
});
