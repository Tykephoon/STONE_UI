import { useCallback, useState } from 'react';
import { Button } from './Button';
import styles from './CopyField.module.css';

export interface CopyFieldProps {
  value: string;
  label?: string;
  /** Renders the value obscured until revealed. Used for freshly minted keys. */
  sensitive?: boolean;
}

/**
 * A read-only value with a copy button.
 *
 * Used for device keys and share links — values shown exactly once that the
 * user must be able to capture reliably.
 */
export function CopyField({ value, label, sensitive = false }: CopyFieldProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!sensitive);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied by permissions policy or an insecure
      // context. Revealing the value lets the user select it by hand.
      setRevealed(true);
    }
  }, [value]);

  return (
    <div className={styles.wrapper}>
      {label && <span className={styles.label}>{label}</span>}
      <div className={styles.row}>
        <code className={styles.value}>
          {revealed ? value : '•'.repeat(Math.min(48, value.length))}
        </code>
        <div className={styles.actions}>
          {sensitive && (
            <Button size="sm" variant="ghost" onClick={() => setRevealed((shown) => !shown)}>
              {revealed ? 'Hide' : 'Reveal'}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
    </div>
  );
}
