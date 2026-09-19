/**
 * Route guard.
 *
 * This is navigation convenience, not access control. Bypassing it renders an
 * empty shell: every endpoint behind it independently authenticates the caller
 * and scopes its queries, so there is nothing here to protect.
 */
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingPanel } from '../components/ui/Feedback';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return <LoadingPanel label="Restoring your session" />;
  }

  if (status === 'anonymous') {
    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

/** Keeps a signed-in user off the login and registration screens. */
export function RedirectIfAuthenticated({ children }: { children: JSX.Element }): JSX.Element {
  const { status } = useAuth();

  if (status === 'checking') {
    return <LoadingPanel label="Checking your session" />;
  }

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  return children;
}
