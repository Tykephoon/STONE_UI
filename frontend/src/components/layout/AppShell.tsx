/**
 * Application chrome: sidebar navigation, top bar, and content region.
 *
 * On narrow viewports the sidebar becomes an overlay drawer. It closes on
 * navigation and on Escape, and the trigger returns focus to itself, so the
 * pattern works from a keyboard as well as a touchscreen.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { config } from '../../config';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { ChipIcon, CubeIcon, DownloadIcon, GaugeIcon, ListIcon, MenuIcon } from './Icons';
import { Logo } from './Logo';
import styles from './AppShell.module.css';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Matches nested paths, e.g. /readings/:id under /readings. */
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <GaugeIcon />, end: true },
  { to: '/readings', label: 'Readings', icon: <ListIcon /> },
  { to: '/devices', label: 'Devices', icon: <ChipIcon /> },
  { to: '/import', label: 'Import', icon: <DownloadIcon /> },
  { to: '/studio', label: 'Studio', icon: <CubeIcon /> },
];

export function AppShell(): JSX.Element {
  const location = useLocation();
  const isNarrow = useMediaQuery('(max-width: 900px)');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      {isNarrow && drawerOpen && (
        <div
          className={styles.scrim}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={[styles.sidebar, isNarrow ? styles.drawer : '', drawerOpen ? styles.drawerOpen : '']
          .filter(Boolean)
          .join(' ')}
        // Hidden from assistive tech when the drawer is closed, so its links
        // are not reachable by Tab from behind the scrim.
        aria-hidden={isNarrow && !drawerOpen}
      >
        <div className={styles.brand}>
          <Logo />
        </div>

        <nav className={styles.nav} aria-label="Main">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [styles.navLink, isActive ? styles.navLinkActive : ''].filter(Boolean).join(' ')
              }
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <p className={styles.envLabel}>
            {config.environmentLabel ? `${config.environmentLabel} · ` : ''}v{config.version}
          </p>
        </div>
      </aside>

      <div className={styles.main}>
        {isNarrow && (
          <header className={styles.topbar}>
            <button
              ref={triggerRef}
              type="button"
              className={styles.menuButton}
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
            >
              <MenuIcon />
            </button>
            <Logo compact height={22} />
          </header>
        )}

        <main className={styles.content} id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
