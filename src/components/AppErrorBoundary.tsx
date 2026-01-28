import { Button, Code, Group, Paper, ScrollArea, Stack, Text, Title } from "@mantine/core";
import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "@/i18n";

type AppErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
};

export default class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<AppErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(_error: Error, errorInfo: ErrorInfo) {
    this.setState({ componentStack: errorInfo.componentStack ?? null }, () => {
      const details = this.buildDetails();
      // Expose for debugging even when the Vite overlay replaces the UI.
      // biome-ignore lint/suspicious/noExplicitAny: attach debug data to window for easier copy/paste.
      (window as any).__ocsLastErrorDetails = details;
      // biome-ignore lint/suspicious/noConsole: this is for debugging a crash screen.
      console.error(details);
    });
  }

  private buildDetails(): string {
    const { error, componentStack } = this.state;
    const lines: string[] = [];
    lines.push(`Message: ${error?.message ?? "Unknown error"}`);
    if (error?.stack) {
      lines.push("", "Stack:", error.stack);
    }
    if (componentStack) {
      lines.push("", "Component stack:", componentStack.trim());
    }
    return lines.join("\n");
  }

  private copyDetails = async () => {
    const details = this.buildDetails();
    try {
      await navigator.clipboard.writeText(details);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 1500);
    } catch {
      // Ignore clipboard failures (e.g. permissions); user can still select/copy manually.
    }
  };

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    const title = i18n.t("errors.runtimeErrorTitle");
    const description = i18n.t("errors.runtimeErrorDescription");
    const detailsLabel = i18n.t("errors.errorDetails");
    const copyLabel = copied ? i18n.t("errors.copied") : i18n.t("errors.copyErrorDetails");

    const details = this.buildDetails();

    return (
      <Stack h="100%" justify="center" align="center" px="md" py="xl">
        <Paper withBorder shadow="sm" p="lg" style={{ width: "min(900px, 100%)" }}>
          <Stack gap="sm">
            <Title order={3}>{title}</Title>
            <Text c="dimmed">{description}</Text>
            <Group justify="space-between" align="center">
              <Text fw={600}>{detailsLabel}</Text>
              <Button size="xs" variant="default" onClick={this.copyDetails}>
                {copyLabel}
              </Button>
            </Group>
            <ScrollArea h={260} type="auto">
              <Code block>{details}</Code>
            </ScrollArea>
          </Stack>
        </Paper>
      </Stack>
    );
  }
}
