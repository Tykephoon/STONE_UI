import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Form';
import { useAuth } from '../../auth/AuthContext';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForm.module.css';

interface LocationState {
  from?: string;
}

export function LoginPage(): JSX.Element {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    // Fast local feedback. The backend validates authoritatively.
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setIsPending(true);
    try {
      await signIn(email.trim(), password);
      const destination = (location.state as LocationState | null)?.from ?? '/';
      navigate(destination, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors());
      } else {
        setError('Something went wrong. Please try again.');
      }
      // Clear only the password: retyping an email on every failed attempt is
      // needless friction, and the email was almost certainly not the mistake.
      setPassword('');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Access your telemetry and saved designs."
      footer={
        <>
          No account yet?{' '}
          <Link to="/register" className={styles.link}>
            Create one
          </Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        {error && (
          <div className={styles.alert} role="alert">
            <span className={styles.alertIcon} aria-hidden="true">
              <svg viewBox="0 0 20 20" width="16" height="16">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10 6v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="10" cy="14" r="0.9" fill="currentColor" />
              </svg>
            </span>
            {error}
          </div>
        )}

        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          error={fieldErrors.email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />

        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          error={fieldErrors.password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••••••"
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          isLoading={isPending}
          className={styles.submit}
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
