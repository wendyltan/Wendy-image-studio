import {
  Children,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Picture } from './types';

export function qaLabel(qa: Picture['qa']) {
  if (qa.status === 'deferred')
    return { className: 'deferred', text: '待检查/未校对' };
  if (qa.pass === true) return { className: 'good', text: '已校对' };
  return { className: '', text: '待修订' };
}

export function QaBadge({ qa }: { qa: Picture['qa'] }) {
  const state = qaLabel(qa);
  return <span className={'qa-label ' + state.className}>{state.text}</span>;
}

function finitePixel(
  value: string | null | undefined,
  fallback: number,
  positive = false,
) {
  const parsed = Number.parseFloat(value || '');
  return Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0)
    ? parsed
    : fallback;
}

export function MeasuredMasonryGrid({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [spans, setSpans] = useState<number[]>([]);
  const items = Children.toArray(children);
  const itemCount = items.length;
  const itemSignature = items
    .map((item, index) =>
      isValidElement(item) ? String(item.key ?? index) : String(index),
    )
    .join('|');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || itemCount === 0) {
      setSpans((previous) => (previous.length ? [] : previous));
      return;
    }
    let disposed = false;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      if (disposed) return;
      const styles = window.getComputedStyle(container);
      const rowSize = finitePixel(
        styles.getPropertyValue('--masonry-row-size'),
        8,
        true,
      );
      const rowGap = finitePixel(styles.rowGap, 18);
      const cards = Array.from(container.children).slice(0, itemCount);
      const next = cards.map((item) => {
        const height = item?.getBoundingClientRect().height || 0;
        const safeHeight = Number.isFinite(height) && height > 0 ? height : 0;
        const span = Math.max(
          1,
          Math.ceil((safeHeight + rowGap) / (rowSize + rowGap)),
        );
        return Number.isFinite(span) ? span : 1;
      });
      setSpans((previous) =>
        previous.length === next.length &&
        previous.every((span, index) => span === next[index])
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (disposed || frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    Array.from(container.children)
      .slice(0, itemCount)
      .forEach((item) => observer?.observe(item));
    observer?.observe(container);
    const images = Array.from(container.querySelectorAll('img'));
    images.forEach((image) => image.addEventListener('load', schedule));
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      images.forEach((image) => image.removeEventListener('load', schedule));
      window.removeEventListener('resize', schedule);
    };
  }, [itemCount, itemSignature]);

  const ready = itemCount === 0 || spans.length === itemCount;
  return (
    <div
      ref={containerRef}
      className={`${className} masonry-grid${ready ? ' masonry-ready' : ''}`}
    >
      {items.map((item, index) => {
        if (!isValidElement(item)) return item;
        const element = item as ReactElement<{ style?: CSSProperties }>;
        return cloneElement(element, {
          style: {
            ...element.props.style,
            '--masonry-row-span': String(spans[index] || 1),
          } as CSSProperties,
        });
      })}
    </div>
  );
}
