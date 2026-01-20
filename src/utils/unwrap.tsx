import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { error } from "@tauri-apps/plugin-log";
import { isFailedToFetchError, isInNetworkCooldown, startNetworkCooldown } from "@/utils/networkCooldown";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

export function unwrap<T>(result: Result<T, string>): T {
  if (result.status === "ok") {
    return result.data;
  }
  // Avoid spamming notifications for transient network failures.
  // Also apply a 10-minute cooldown before trying again.
  if (isFailedToFetchError(result.error)) {
    startNetworkCooldown();
    error(result.error);
    throw new Error(result.error);
  }

  error(result.error);
  if (!isInNetworkCooldown()) {
    notifications.show({
      title: "Error",
      message: result.error,
      color: "red",
      icon: <IconX />,
    });
  }
  throw new Error(result.error);
}
