import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Removes the default padding, for cards whose body is a table or a canvas. */
  flush?: boolean;
  interactive?: boolean;
}

export function Card({ children, flush, interactive, className, ...rest }: CardProps): JSX.Element {
  const classes = [
    styles.card,
    flush ? styles.flush : '',
    interactive ? styles.interactive : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Renders as an h2 by default; pass 3 inside a section that already has one. */
  level?: 2 | 3;
}

export function CardHeader({ title, subtitle, actions, level = 2 }: CardHeaderProps): JSX.Element {
  const Heading = level === 2 ? 'h2' : 'h3';

  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <Heading className={styles.title}>{title}</Heading>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={[styles.body, className ?? ''].filter(Boolean).join(' ')}>{children}</div>;
}

export function CardFooter({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.footer}>{children}</div>;
}
