import { type RefObject, useEffect, useRef, useState } from 'react';

/**
 * Track a container's width so an SVG chart can be laid out in real pixels.
 *
 * `viewBox` scaling alone would stretch the text and stroke widths along with
 * the plot, so charts are drawn at their true size and re-measured on resize.
 */
export function useChartSize<T extends HTMLElement>(
  fallbackWidth = 640,
): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallbackWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = Math.round(entry.contentRect.width);
      // Sub-pixel jitter during a CSS transition would otherwise re-render the
      // chart on every animation frame.
      setWidth((current) => (Math.abs(current - next) > 1 ? next : current));
    });

    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width) || fallbackWidth);

    return () => observer.disconnect();
  }, [fallbackWidth]);

  return [ref, width];
}
