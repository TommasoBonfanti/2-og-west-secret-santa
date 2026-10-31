import type { ReactNode } from 'react';
import type { GroupPhoto } from '../types';
import { hrefFor } from '../lib/router';
import { Card } from './ui';
import { Polaroid, PlaceholderArt, placeholderPolaroid, useLightbox } from './Polaroid';

/** Splits photos into two flanking ones and up to 8 for the wall (no duplicates). */
export function splitPhotos(photos: GroupPhoto[]) {
  return { flanks: photos.slice(0, 2), wall: photos.slice(2, 10) };
}

interface HeroProps {
  flanks: GroupPhoto[];
  children: ReactNode;
  onOpen: (src: string) => void;
}

/** Main card flanked by two polaroids (wide screens) or followed by them (phones). */
export function PhotoHero({ flanks, children, onOpen }: HeroProps) {
  const side = (i: 0 | 1) => {
    const p = flanks[i];
    const tilt = i === 0 ? -5 : 5;
    if (p) return <Polaroid src={p.url} alt="Flat photo" tilt={tilt} onClick={() => onOpen(p.url)} />;
    const ph = placeholderPolaroid(i === 0 ? 0 : 3);
    return <Polaroid art={<PlaceholderArt kind={ph.kind} />} caption={ph.caption} tilt={tilt} />;
  };
  return (
    <div className="hero">
      <div className="hero-side hero-left">{side(0)}</div>
      <div className="hero-main">{children}</div>
      <div className="hero-side hero-right">{side(1)}</div>
    </div>
  );
}

interface WallProps {
  photos: GroupPhoto[];
  /** Total number of photos that exist (incl. those used as flanks). */
  total: number;
  isAdmin: boolean;
}

export function PhotoWall({ photos, total, isAdmin }: WallProps) {
  const lightbox = useLightbox();

  if (total === 0) {
    return (
      <section className="photo-wall-section" aria-labelledby="wall-title">
        <h2 id="wall-title" className="section-title">
          The photo wall
        </h2>
        {isAdmin && (
          <Card className="wall-prompt">
            <p>
              No group photos yet. Add a few cozy flat pictures in the <a href={hrefFor('admin')}>admin panel</a> and
              they'll hang right here.
            </p>
          </Card>
        )}
        <div className="photo-wall" aria-hidden="true">
          {[1, 2, 0, 3].map((k, i) => {
            const ph = placeholderPolaroid(k);
            return <Polaroid key={i} art={<PlaceholderArt kind={ph.kind} />} caption={ph.caption} seed={`ph${i}`} size="sm" />;
          })}
        </div>
      </section>
    );
  }

  if (photos.length === 0) return null;

  return (
    <section className="photo-wall-section" aria-labelledby="wall-title">
      <h2 id="wall-title" className="section-title">
        The photo wall
      </h2>
      <div className="photo-wall">
        {photos.map((p, i) => (
          <Polaroid key={p.id} src={p.url} alt={`Flat photo ${i + 1}`} seed={p.id} size="sm" onClick={() => lightbox.open(p.url, `Flat photo ${i + 1}`)} />
        ))}
      </div>
      {lightbox.element}
    </section>
  );
}
