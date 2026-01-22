import { Box, type BoxProps } from "@mantine/core";
import type React from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

type ChartSizeGuardProps = Omit<BoxProps, "children"> & {
  height: number;
  children: React.ReactNode;
};

export const ChartSizeGuard = memo(
  function ChartSizeGuard({ height, children, style, ...boxProps }: ChartSizeGuardProps) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const isSettingRef = useRef(false);
    const hasRenderedRef = useRef(false);
    const timeoutRef = useRef<number | null>(null);

    // Store dimensions in ref to avoid dependency issues
    const dimensionsRef = useRef(dimensions);
    useEffect(() => {
      dimensionsRef.current = dimensions;
    }, [dimensions]);

    // Set up ResizeObserver in an effect that runs when element is available
    // Use a small delay to ensure element is mounted
    useEffect(() => {
      // Use requestAnimationFrame to ensure element is in DOM
      const rafId = requestAnimationFrame(() => {
        const element = elementRef.current;
        if (!element) {
          return;
        }

        // Measure initial size
        const rect = element.getBoundingClientRect();
        const initialWidth = rect.width;
        const initialHeight = rect.height;
        const current = dimensionsRef.current;

        // Only update if size actually changed AND we haven't rendered children yet
        // Once children are rendered, we don't need to update dimensions anymore
        // This prevents unnecessary re-renders that cause the assignRef loop
        if ((initialWidth !== current.width || initialHeight !== current.height) && !hasRenderedRef.current) {
          // Update dimensionsRef immediately to prevent ResizeObserver from firing
          dimensionsRef.current = { width: initialWidth, height: initialHeight };
          isSettingRef.current = true;
          // Use setTimeout with a small delay to batch the state update
          setTimeout(() => {
            setDimensions({ width: initialWidth, height: initialHeight });
            // Reset flag after state update has been queued
            setTimeout(() => {
              isSettingRef.current = false;
            }, 0);
          }, 0);
        } else if (initialWidth !== current.width || initialHeight !== current.height) {
          // Size changed but children already rendered - just update the ref, don't trigger state update
          dimensionsRef.current = { width: initialWidth, height: initialHeight };
        }

        // Set up ResizeObserver with debouncing
        if (!resizeObserverRef.current) {
          resizeObserverRef.current = new ResizeObserver((entries) => {
            if (isSettingRef.current) {
              return; // Prevent updates during our own state updates
            }

            // Debounce resize observations
            if (timeoutRef.current !== null) {
              clearTimeout(timeoutRef.current);
            }

            timeoutRef.current = window.setTimeout(() => {
              const entry = entries[0];
              if (entry && entry.target === element && elementRef.current === element) {
                const { width: newWidth, height: newHeight } = entry.contentRect;
                const current = dimensionsRef.current;
                // Only update if size actually changed AND we haven't rendered children yet
                // Once children are rendered, we don't need to update dimensions anymore
                // This prevents unnecessary re-renders that cause the assignRef loop
                if ((newWidth !== current.width || newHeight !== current.height) && !hasRenderedRef.current) {
                  // Update dimensionsRef immediately to prevent ResizeObserver from firing again
                  dimensionsRef.current = { width: newWidth, height: newHeight };
                  isSettingRef.current = true;
                  // Use setTimeout with a small delay to batch the state update
                  setTimeout(() => {
                    setDimensions({ width: newWidth, height: newHeight });
                    // Reset flag after state update has been queued
                    setTimeout(() => {
                      isSettingRef.current = false;
                    }, 0);
                  }, 0);
                } else if (newWidth !== current.width || newHeight !== current.height) {
                  // Size changed but children already rendered - just update the ref, don't trigger state update
                  dimensionsRef.current = { width: newWidth, height: newHeight };
                }
              }
              timeoutRef.current = null;
            }, 16); // ~1 frame at 60fps
          });

          resizeObserverRef.current.observe(element);
        }

        // Cleanup function
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
    }, []); // Only run once on mount

    const isReady = dimensions.width > 0 && dimensions.height > 0;

    // Track if we've rendered children at least once
    useEffect(() => {
      if (isReady && !hasRenderedRef.current) {
        hasRenderedRef.current = true;
      }
    }, [isReady]);

    // Once we've rendered children, always render them (but hidden if not ready)
    // This prevents mount/unmount cycles that can cause layout shifts and re-measurements
    const shouldRenderChildren = hasRenderedRef.current || isReady;

    // Store children in a ref to prevent remounts when ChartSizeGuard re-renders
    const childrenRef = useRef(children);
    if (childrenRef.current !== children) {
      childrenRef.current = children;
    }

    // Memoize the children wrapper to prevent unnecessary re-renders of AreaChart
    // Only re-create when visibility actually changes, not when dimensions change
    const childrenWrapper = useMemo(() => {
      if (!shouldRenderChildren) return null;
      return (
        <Box style={{ visibility: isReady ? "visible" : "hidden", width: "100%", height: "100%" }}>
          {childrenRef.current}
        </Box>
      );
    }, [shouldRenderChildren, isReady]); // Don't include children in deps - use ref instead

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
        {childrenWrapper}
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
