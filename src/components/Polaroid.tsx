import { useState, type CSSProperties, type ReactNode } from 'react';
import { Candy67 } from './Candy67';
import { Modal } from './Modal';
import { tiltFor } from '../lib/format';

interface PolaroidProps {
  src?: string;
  alt?: string;
  caption?: string;
  /** Degrees; defaults to a stable tilt derived from `seed`. */
  tilt?: number;
  seed?: string;
  /** Illustrated content instead of a photo. */
  art?: ReactNode;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Off-white instant-photo frame with a slight tilt. */
export function Polaroid({ src, alt = '', caption, tilt, seed = '', art, onClick, size = 'md', className }: PolaroidProps) {
  const angle = tilt ?? tiltFor(seed || src || caption || 'x');
  const style = { '--tilt': `${angle}deg` } as CSSProperties;
  const inner = (
    <>
      <span className="polaroid-photo">{src ? <img src={src} alt={alt} loading="lazy" /> : art}</span>
      {caption && <span className="polaroid-caption">{caption}</span>}
    </>
  );
  const cls = ['polaroid', `polaroid-${size}`, onClick && 'polaroid-clickable', className].filter(Boolean).join(' ');
  if (onClick) {
    return (
      <button type="button" className={cls} style={style} onClick={onClick} aria-label={alt ? `View photo: ${alt}` : 'View photo'}>
        {inner}
      </button>
    );
  }
  return (
    <figure className={cls} style={style} aria-hidden={!src && !caption ? true : undefined}>
      {inner}
    </figure>
  );
}

/** Small festive illustrations used when there are no photos. */
export function PlaceholderArt({ kind }: { kind: 'tree' | 'present' | 'candy' | 'mug' }) {
  if (kind === 'candy') {
    return (
      <span className="art art-candy" aria-hidden="true">
        <Candy67 size={110} rotate={-8} bow />
      </span>
    );
  }
  return (
    <svg className={`art art-${kind}`} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      {kind === 'tree' && (
        <>
          <rect width="200" height="200" fill="#2e5d3a" />
          <circle cx="30" cy="30" r="3" fill="#fff3e0" />
          <circle cx="170" cy="50" r="2.5" fill="#fff3e0" />
          <circle cx="150" cy="20" r="2" fill="#fff3e0" />
          <polygon points="100,34 58,100 78,100 44,150 156,150 122,100 142,100" fill="#7fd18b" />
          <rect x="90" y="150" width="20" height="24" fill="#6b3a1e" />
          <polygon points="100,20 105,31 117,31 107,38 111,50 100,43 89,50 93,38 83,31 95,31" fill="#ffd36b" />
          <circle cx="84" cy="94" r="5" fill="#e02424" />
          <circle cx="118" cy="122" r="5" fill="#ffd36b" />
          <circle cx="88" cy="136" r="5" fill="#fff3e0" />
          <circle cx="108" cy="76" r="4.5" fill="#e02424" />
        </>
      )}
      {kind === 'present' && (
        <>
          <rect width="200" height="200" fill="#f3d9b1" />
          <rect x="40" y="88" width="120" height="86" rx="6" fill="#b31b1b" />
          <rect x="34" y="72" width="132" height="24" rx="5" fill="#c62828" />
          <rect x="92" y="72" width="16" height="102" fill="#ffd36b" />
          <ellipse cx="84" cy="64" rx="17" ry="10" fill="#ffd36b" transform="rotate(-18 84 64)" />
          <ellipse cx="116" cy="64" rx="17" ry="10" fill="#ffd36b" transform="rotate(18 116 64)" />
          <circle cx="100" cy="68" r="6" fill="#e6b84a" />
        </>
      )}
      {kind === 'mug' && (
        <>
          <rect width="200" height="200" fill="#e9c58f" />
          <rect x="55" y="80" width="76" height="86" rx="10" fill="#b31b1b" />
          <path d="M131 98 h14 a18 18 0 0 1 0 36 h-14" fill="none" stroke="#b31b1b" strokeWidth="10" />
          <ellipse cx="93" cy="82" rx="38" ry="8" fill="#6b3a1e" />
          <path
            d="M80 68 q-8 -14 0 -28 M96 68 q-8 -14 0 -28 M112 68 q-8 -14 0 -28"
            stroke="#fff3e0"
            strokeWidth="4"
            fill="none"
            strokeLinecap="round"
          />
          <rect x="55" y="116" width="76" height="9" fill="#fff3e0" />
        </>
      )}
    </svg>
  );
}

const PLACEHOLDER_SET: { kind: 'tree' | 'present' | 'candy' | 'mug'; caption: string }[] = [
  { kind: 'tree', caption: 'Tree night' },
  { kind: 'present', caption: 'Wrapping season' },
  { kind: 'candy', caption: '67!' },
  { kind: 'mug', caption: 'Cocoa o’clock' },
];

export function placeholderPolaroid(i: number) {
  return PLACEHOLDER_SET[i % PLACEHOLDER_SET.length];
}

/** Lightbox for one image. */
export function Lightbox({ src, alt, onClose }: { src: string | null; alt?: string; onClose: () => void }) {
  return (
    <Modal open={!!src} onClose={onClose} title={alt || 'Photo'} variant="lightbox">
      {src && <img className="lightbox-img" src={src} alt={alt || ''} />}
    </Modal>
  );
}

/** Hook-ish helper: state for a lightbox. */
export function useLightbox() {
  const [current, setCurrent] = useState<{ src: string; alt?: string } | null>(null);
  return {
    open: (src: string, alt?: string) => setCurrent({ src, alt }),
    element: <Lightbox src={current?.src ?? null} alt={current?.alt} onClose={() => setCurrent(null)} />,
  };
}
