import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Logo } from '../../components/layout/Logo';
import styles from './NotFoundPage.module.css';

export function NotFoundPage(): JSX.Element {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Logo height={26} />
        <p className={styles.code}>404</p>
        <h1 className={styles.title}>That page does not exist</h1>
        <p className={styles.body}>
          The link may be out of date, or the record may have been removed.
        </p>
        <Link to="/">
          <Button variant="primary">Back to the dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
