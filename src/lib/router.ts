import { useEffect, useState } from 'react';

/** Tiny hash router: #/, #/admin, #/settings, #/wishlist. */
export type Route = 'home' | 'admin' | 'settings' | 'wishlist';

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split(/[?#]/)[0].replace(/\/$/, '');
  if (path === 'admin' || path === 'settings' || path === 'wishlist') return path;
  return 'home';
}

export function hrefFor(route: Route): string {
  return route === 'home' ? '#/' : `#/${route}`;
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
