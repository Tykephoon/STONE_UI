import styles from './Logo.module.css';

export interface LogoProps {
  /** Mark only, for the collapsed sidebar and small screens. */
  compact?: boolean;
  height?: number;
}

/**
 * Brand mark.
 *
 * Renders `public/logo.svg` through an `<img>` so swapping the brand is a
 * file replacement, not a code change. The wordmark beside it is the fallback
 * for the compact form and keeps the product name as real, selectable text.
 *
 * To rebrand: drop your own `public/logo.svg` (roughly 132×32) and
 * `public/favicon.svg` into place. Nothing here needs editing.
 */
export function Logo({ compact = false, height = 26 }: LogoProps): JSX.Element {
  return (
    <span className={styles.logo}>
      <img
        src={`${import.meta.env.BASE_URL}logo.svg`}
        alt="Stone"
        height={height}
        className={compact ? styles.markOnly : styles.full}
        // The mark is decorative once the wordmark is present in the SVG.
        draggable={false}
      />
    </span>
  );
}
