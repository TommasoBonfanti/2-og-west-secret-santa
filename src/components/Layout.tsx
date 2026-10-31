import type { ReactNode } from 'react';
import { Candy67 } from './Candy67';
import { hrefFor, type Route } from '../lib/router';
import type { Participant } from '../types';

interface HeaderProps {
  title: string;
  me: Participant | null;
  route: Route;
  showWishlist: boolean;
  snowOn: boolean;
  snowAllowed: boolean;
  onToggleSnow: () => void;
}

export function Header({ title, me, route, showWishlist, snowOn, snowAllowed, onToggleSnow }: HeaderProps) {
  const links: { route: Route; label: string; show: boolean }[] = [
    { route: 'home', label: 'Home', show: true },
    { route: 'wishlist', label: 'Wishlist', show: showWishlist },
    { route: 'admin', label: 'Admin', show: !!me?.isAdmin },
    { route: 'settings', label: 'Settings', show: true },
  ];
  return (
    <header className="site-header">
      <div className="header-row">
        <a href={hrefFor('home')} className="brand">
          <Candy67 className="brand-67" size={56} rotate={-8} />
          <span className="brand-title">{title}</span>
        </a>
        {snowAllowed && (
          <button
            type="button"
            className="snow-toggle"
            aria-pressed={snowOn}
            onClick={onToggleSnow}
            title={snowOn ? 'Turn snow off' : 'Turn snow on'}
          >
            <span aria-hidden="true">❄</span>
            <span className="visually-hidden">Snowfall</span>
            <span className="snow-toggle-state" aria-hidden="true">
              {snowOn ? 'on' : 'off'}
            </span>
          </button>
        )}
      </div>
      {me && (
        <div className="header-row header-nav-row">
          <span className="whoami">
            Hi, <strong>{me.name}</strong>
          </span>
          <nav aria-label="Main">
            <ul className="nav">
              {links
                .filter((l) => l.show)
                .map((l) => (
                  <li key={l.route}>
                    <a href={hrefFor(l.route)} aria-current={route === l.route ? 'page' : undefined}>
                      {l.label}
                    </a>
                  </li>
                ))}
            </ul>
          </nav>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <svg className="footer-bauble" viewBox="0 0 60 70" width="34" height="40" aria-hidden="true" focusable="false">
        <line x1="30" y1="0" x2="30" y2="10" stroke="#3d1a0a" strokeWidth="2" />
        <rect x="24" y="8" width="12" height="7" rx="2" fill="#ffd36b" />
        <circle cx="30" cy="40" r="25" fill="#b31b1b" stroke="#ffd36b" strokeWidth="2" />
        <ellipse cx="21" cy="30" rx="5" ry="8" fill="#fff" opacity="0.25" />
        <Candy67 size={36} x={12} y={28} />
      </svg>
      <p>Made with love for 2 OG WEST · 2026</p>
    </footer>
  );
}

/** Page section heading on the red background. */
export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="page-title">
      <h1>{children}</h1>
      {sub && <p className="page-sub">{sub}</p>}
    </div>
  );
}
