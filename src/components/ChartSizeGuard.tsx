import { Box, type BoxProps } from "@mantine/core";
import type React from "react";
import { memo, useEffect, useRef, useState } from "react";

type ChartSizeGuardProps = Omit<BoxProps, "children"> & {
  height: number;
  children: React.ReactNode;
};

export const ChartSizeGuard = memo(
  function ChartSizeGuard({ height, children, style, ...boxProps }: ChartSizeGuardProps) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const timeoutRef = useRef<number | null>(null);

    const updateDimensions = (nextWidth: number, nextHeight: number) => {
      setDimensions((prev) => {
        const width = Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : 0;
        const heightValue = Number.isFinite(nextHeight) && nextHeight > 0 ? nextHeight : 0;
        if (prev.width === width && prev.height === heightValue) return prev;
        return { width, height: heightValue };
      });
    };

    useEffect(() => {
      const rafId = requestAnimationFrame(() => {
        const element = elementRef.current;
        if (!element) {
          return;
        }

        const rect = element.getBoundingClientRect();
        updateDimensions(rect.width, rect.height);

        if (!resizeObserverRef.current) {
          resizeObserverRef.current = new ResizeObserver((entries) => {
            if (timeoutRef.current !== null) {
              clearTimeout(timeoutRef.current);
            }

            timeoutRef.current = window.setTimeout(() => {
              const entry = entries[0];
              if (entry && entry.target === element && elementRef.current === element) {
                const { width: newWidth, height: newHeight } = entry.contentRect;
                updateDimensions(newWidth, newHeight);
              }
              timeoutRef.current = null;
            }, 16);
          });

          resizeObserverRef.current.observe(element);
        }

        return () => {
          if (timeoutRef.current !== null) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          if (resizeObserverRef.current) {
            resizeObserverRef.current.disconnect();
            resizeObserverRef.current = null;
          }
        };
      });

      return () => {
        cancelAnimationFrame(rafId);
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        if (resizeObserverRef.current) {
          resizeObserverRef.current.disconnect();
          resizeObserverRef.current = null;
        }
      };
    }, [updateDimensions]); // Only run once on mount

    const isReady = dimensions.width > 0 && dimensions.height > 0;

    return (
      <Box
        ref={elementRef}
        {...boxProps}
        style={{
          width: "100%",
          height,
          minWidth: 0,
          minHeight: 0,
          ...(style ?? {}),
        }}
      >
        {isReady ? <Box style={{ width: "100%", height: "100%" }}>{children}</Box> : null}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function for memo
    // Only re-render if height or style actually changed
    // Don't compare children - we handle that internally with refs
    return prevProps.height === nextProps.height && JSON.stringify(prevProps.style) === JSON.stringify(nextProps.style);
  },
);
