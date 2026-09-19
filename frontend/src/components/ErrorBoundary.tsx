/**
 * Top-level error boundary.
 *
 * Catches render-time exceptions so a single broken component shows a recovery
 * card instead of a blank page. The caught error is logged to the console for a
 * developer and never rendered: a React error message can contain prop values,
 * which here would mean telemetry content or an email address on screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/Button';
import styles from './ErrorBoundary.module.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className={styles.wrapper} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>Something went wrong</h1>
          <p className={styles.body}>
            The page hit an unexpected error and stopped rendering. Reloading usually clears it.
          </p>
          <div className={styles.actions}>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
