import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Form';
import { useAuth } from '../../auth/AuthContext';
import { AuthLayout } from './AuthLayout';
import styles from './AuthForm.module.css';

const MIN_PASSWORD_LENGTH = 12;

/**
 * A length- and variety-based strength hint.
 *
 * Advisory only — it gates nothing. The server's single rule is a 12-character
 * minimum, and composition requirements mostly push people toward predictable
 * substitutions rather than genuinely stronger passwords.
 */
function scorePassword(password: string): { level: 0 | 1 | 2 | 3; label: string } {
  if (password.length === 0) return { level: 0, label: '' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { level: 1, label: `At least ${MIN_PASSWORD_LENGTH} characters needed` };
  }

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;

  if (password.length >= 20 || variety >= 3) return { level: 3, label: 'Strong' };
  return { level: 2, label: 'Reasonable' };
}

export function RegisterPage(): JSX.Element {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, setIsPending] = useState(false);

  const strength = useMemo(() => scorePassword(password), [password]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const localErrors: Record<string, string> = {};
    if (!email.trim()) localErrors.email = 'Enter an email address.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      localErrors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password !== confirm) localErrors.confirm = 'The passwords do not match.';

    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setIsPending(true);
    try {
      await signUp({
        email: email.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      navigate('/', { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        setFieldErrors(cause.fieldErrors());
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Register a device, stream telemetry, and build stones."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className={styles.link}>
            Sign in
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
          label="Name"
          name="name"
          autoComplete="name"
          value={displayName}
          error={fieldErrors.display_name}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Optional"
        />

        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          error={fieldErrors.email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />

        <div>
          <TextField
            label="Password"
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            error={fieldErrors.password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          />
          {password.length > 0 && (
            <div className={styles.strength} style={{ marginTop: 'var(--space-2)' }}>
              <div className={styles.strengthTrack}>
                {[1, 2, 3].map((segment) => (
                  <span
                    key={segment}
                    className={[
                      styles.strengthSegment,
                      strength.level >= segment
                        ? strength.level === 1
                          ? styles.strengthWeak
                          : strength.level === 2
                            ? styles.strengthFair
                            : styles.strengthStrong
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  />
                ))}
              </div>
              <span className={styles.strengthLabel}>{strength.label}</span>
            </div>
          )}
        </div>

        <TextField
          label="Confirm password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          value={confirm}
          error={fieldErrors.confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="Repeat your password"
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          isLoading={isPending}
          className={styles.submit}
        >
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
