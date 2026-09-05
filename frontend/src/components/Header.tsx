import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../App';
import { useGradeLabel, useTranslation } from '../i18n';
import LanguageSwitcher from './LanguageSwitcher';

export default function Header() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  const gradeLabel = useGradeLabel();

  const isStudent = user?.role === 'student';
  const isParent = user?.role === 'parent';
  const dashboardPath = isStudent ? '/dashboard' : '/parent';

  // Don't show on landing or login pages
  if (!user) return null;

  return (
    <header
      style={{
        padding: '0.75rem 0',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}
    >
      <div
        className="container"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        {/* Logo/Home */}
        <Link
          to={dashboardPath}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            textDecoration: 'none',
            color: 'var(--primary)',
            fontWeight: 700,
            fontSize: '1.25rem',
          }}
        >
          <span style={{ fontSize: '1.5rem' }}>📚</span>
          <span className="hide-mobile">Open Alpha</span>
        </Link>

        {/* Navigation Links */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isStudent && (
            <>
              <NavLink to="/dashboard" current={location.pathname === '/dashboard'}>
                <span style={{ fontSize: '1.1rem' }}>🏠</span>
                <span className="hide-mobile">{t('header.dashboard')}</span>
              </NavLink>
              <NavLink to="/settings" current={location.pathname === '/settings'}>
                <span style={{ fontSize: '1.1rem' }}>⚙️</span>
                <span className="hide-mobile">{t('header.settings')}</span>
              </NavLink>
            </>
          )}

          {isParent && (
            <>
              <NavLink to="/parent" current={location.pathname === '/parent'}>
                <span style={{ fontSize: '1.1rem' }}>🏠</span>
                <span className="hide-mobile">{t('header.dashboard')}</span>
              </NavLink>
              <NavLink to="/parent/coach" current={location.pathname === '/parent/coach'}>
                <span style={{ fontSize: '1.1rem' }}>💬</span>
                <span className="hide-mobile">{t('header.coach')}</span>
              </NavLink>
            </>
          )}

          {/* User info & logout */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              marginLeft: '0.5rem',
              paddingLeft: '0.75rem',
              borderLeft: '1px solid var(--border)',
            }}
          >
            <LanguageSwitcher compact />
            <span className="hide-mobile" style={{ fontSize: '0.875rem', color: 'var(--text-light)' }}>
              {user?.displayName || user?.email?.split('@')[0]}
              {isStudent && user?.gradeLevel !== null && ` · ${gradeLabel(user.gradeLevel)}`}
            </span>
            <button
              onClick={logout}
              style={{
                background: 'none',
                border: 'none',
                padding: '0.5rem',
                cursor: 'pointer',
                color: 'var(--text-light)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
                fontSize: '0.875rem',
              }}
              title={t('header.signOut')}
            >
              <span style={{ fontSize: '1.1rem' }}>🚪</span>
              <span className="hide-mobile">{t('header.signOut')}</span>
            </button>
          </div>
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        padding: '0.5rem 0.75rem',
        borderRadius: '0.5rem',
        textDecoration: 'none',
        fontSize: '0.875rem',
        fontWeight: 500,
        color: current ? 'var(--primary)' : 'var(--text)',
        background: current ? 'var(--primary-light, rgba(37, 99, 235, 0.1))' : 'transparent',
        transition: 'background 0.15s ease',
      }}
    >
      {children}
    </Link>
  );
}
