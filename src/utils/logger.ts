/** biome-ignore-all lint/suspicious/noExplicitAny: For logging formatting */
import { error, warn } from "@tauri-apps/plugin-log";

function formatMessage(msg: any, ...optionalParams: any[]) {
  return [msg, ...optionalParams]
    .map((p) => {
      if (typeof p === "object") {
        return JSON.stringify(p);
      }
      return String(p);
    })
    .join(" ");
}

export const logger = {
  error: (msg: any, ...rest: any[]) => error(formatMessage(msg, ...rest)),
  warn: (msg: any, ...rest: any[]) => warn(formatMessage(msg, ...rest)),
};
