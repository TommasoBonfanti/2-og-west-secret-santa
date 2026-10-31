import type { Wishlist } from '../types';
import { isHttpUrl } from '../lib/format';
import { safeImageSrc } from '../lib/image';
import { Polaroid, useLightbox } from './Polaroid';

function prettyLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname : '';
    const s = u.hostname.replace(/^www\./, '') + path;
    return s.length > 48 ? s.slice(0, 46) + '…' : s;
  } catch {
    return url;
  }
}

/** Read-only view of someone's wishlist (content comes from another person: render defensively). */
export function WishlistView({ wishlist, name }: { wishlist: Wishlist; name: string }) {
  const lightbox = useLightbox();
  const links = wishlist.links.filter(isHttpUrl);
  const images = wishlist.images
    .map((img) => safeImageSrc(img.mime, img.dataB64))
    .filter((s): s is string => !!s);
  const empty = !wishlist.text.trim() && links.length === 0 && images.length === 0;

  if (empty) return <p className="muted">{name}'s wishlist is still empty — check back later.</p>;

  return (
    <div className="wishlist-view">
      {wishlist.text.trim() && <p className="wishlist-text">{wishlist.text}</p>}
      {links.length > 0 && (
        <ul className="wishlist-links">
          {links.map((l, i) => (
            <li key={i}>
              <a href={l} target="_blank" rel="noopener noreferrer">
                {prettyLink(l)}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <p className="muted small">
          Tip: {name} chose these links, and only you can see them — a tracking link could hint who opened it.
          Copying the shop name and searching for it yourself stays fully anonymous.
        </p>
      )}
      {images.length > 0 && (
        <div className="wishlist-images">
          {images.map((src, i) => (
            <Polaroid
              key={i}
              src={src}
              alt={`Wishlist picture ${i + 1}`}
              seed={`${name}-${i}`}
              size="sm"
              onClick={() => lightbox.open(src, `Wishlist picture ${i + 1}`)}
            />
          ))}
        </div>
      )}
      {wishlist.updatedAt && (
        <p className="muted small">Last updated {new Date(wishlist.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</p>
      )}
      {lightbox.element}
    </div>
  );
}
