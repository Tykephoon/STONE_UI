/**
 * Loading, empty, and error states.
 *
 * Every data view in the app has all three. A list that renders nothing when it
 * is empty and nothing when it failed is indistinguishable from a list that is
 * still loading, and users read that as "broken".
 */
import type { ReactNode } from 'react';
import { DataError } from '../../data/store';
import { Button } from './Button';
import styles from './Feedback.module.css';

export function Spinner({ size = 16, label }: { size?: number; label?: string }): JSX.Element {
  return (
    <span
      className={styles.spinner}
      style={{ width: size, height: size }}
      role="status"
      aria-label={label ?? 'Loading'}
    />
  );
}

/** Shimmering placeholder sized like the content it stands in for. */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = 'var(--radius-sm)',
  className,
}: {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={[styles.skeleton, className ?? ''].filter(Boolean).join(' ')}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }): JSX.Element {
  return (
    <div className={styles.skeletonText}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          // A ragged last line reads as text rather than as a block.
          width={index === lines - 1 ? '62%' : '100%'}
          height={13}
        />
      ))}
    </div>
  );
}

export function LoadingPanel({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className={styles.centered} role="status">
      <Spinner size={22} />
      <p className={styles.centeredText}>{label}…</p>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  compact,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={[styles.empty, compact ? styles.emptyCompact : ''].filter(Boolean).join(' ')}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      <h3 className={styles.emptyTitle}>{title}</h3>
      {description && <p className={styles.emptyDescription}>{description}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

/**
 * Error presentation.
 *
 * The message shown is the one the API chose to expose. Status codes, stack
 * traces, and internal identifiers are never surfaced — the backend does not
 * send them, and this component would not render them if it did.
 */
export function ErrorState({
  error,
  onRetry,
  compact,
}: {
  error: DataError | Error | null;
  onRetry?: () => void;
  compact?: boolean;
}): JSX.Element {
  const message =
    error instanceof DataError
      ? error.message
      : 'Something went wrong. Please try again.';

  return (
    <div
      className={[styles.error, compact ? styles.errorCompact : ''].filter(Boolean).join(' ')}
      role="alert"
    >
      <span className={styles.errorIcon} aria-hidden="true">
        <svg viewBox="0 0 20 20" width="18" height="18">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 6v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="14" r="0.9" fill="currentColor" />
        </svg>
      </span>
      <div className={styles.errorBody}>
        <p className={styles.errorMessage}>{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warning' | 'serious' | 'critical';

export function Badge({
  children,
  tone = 'neutral',
  icon,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
}): JSX.Element {
  return (
    <span className={[styles.badge, styles[tone]].join(' ')}>
      {icon && <span className={styles.badgeIcon}>{icon}</span>}
      {children}
    </span>
  );
}

/**
 * A status dot.
 *
 * Always rendered beside a text label by its callers — status is never
 * communicated by colour alone.
 */
export function StatusDot({
  tone,
  pulse,
}: {
  tone: Exclude<BadgeTone, 'neutral' | 'accent'> | 'neutral';
  pulse?: boolean;
}): JSX.Element {
  return (
    <span
      className={[styles.dot, styles[`dot_${tone}`], pulse ? styles.dotPulse : '']
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    />
  );
}
