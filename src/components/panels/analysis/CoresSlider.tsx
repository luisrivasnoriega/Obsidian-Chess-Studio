import { SegmentedControl, Slider, useMantineTheme } from "@mantine/core";

export default function CoresSlider(props: { value: number; setValue: (v: number) => void; color?: string }) {
  const theme = useMantineTheme();
  // `hardwareConcurrency` is the only browser/WebView API we have here; it reports logical processors.
  const maxThreads = Math.max(1, Math.floor(navigator.hardwareConcurrency || 4));
  const value = Math.min(maxThreads, Math.max(1, Math.floor(props.value || 1)));

  // If the machine has a small number of logical processors, show all discrete values as buttons.
  // For larger counts, fall back to a slider (buttons become unreadable / overflow).
  if (maxThreads <= 16) {
    const values = Array.from({ length: maxThreads }, (_, i) => i + 1);
    return (
      <SegmentedControl
        size="xs"
        color={props.color || theme.primaryColor}
        value={value.toString()}
        onChange={(v) => props.setValue(Number.parseInt(v, 10))}
        data={values.map((v) => v.toString())}
      />
    );
  }

  return (
    <Slider
      min={1}
      max={maxThreads}
      step={1}
      value={value}
      color={props.color || theme.primaryColor}
      label={(v) => v.toString()}
      onChange={(v) => props.setValue(v)}
      marks={[
        { value: 1, label: "1" },
        { value: Math.ceil(maxThreads / 2), label: `${Math.ceil(maxThreads / 2)}` },
        { value: maxThreads, label: `${maxThreads}` },
      ]}
    />
  );
}
