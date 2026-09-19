import type { ReactNode } from 'react';
import { Logo } from '../../components/layout/Logo';
import styles from './AuthLayout.module.css';

export interface AuthLayoutProps {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps): JSX.Element {
  return (
    <div className={styles.page}>
      {/* Decorative field behind the card; hidden from assistive tech. */}
      <div className={styles.glow} aria-hidden="true" />

      <main className={styles.panel}>
        <div className={styles.brand}>
          <Logo height={28} />
        </div>

        <header className={styles.header}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </header>

        {children}

        <footer className={styles.footer}>{footer}</footer>
      </main>
    </div>
  );
}
