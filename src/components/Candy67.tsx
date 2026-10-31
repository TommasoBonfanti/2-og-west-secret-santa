import { useId, type CSSProperties } from 'react';

interface Candy67Props {
  /** Rendered width in px (height follows the aspect ratio). */
  size?: number;
  /** Rotation in degrees. */
  rotate?: number;
  /** Tiny red bow on top. */
  bow?: boolean;
  /** Hanging thread above (like an ornament). */
  thread?: boolean;
  /** Accessible label. Without it the graphic is decorative (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** Position when nested inside another <svg>. */
  x?: number;
  y?: number;
}

const W = 120;
const TEXT_H = 84;
const TOP_PAD_THREAD = 46;
const TOP_PAD_BOW = 26;

/** The candy-cane striped "67". */
export function Candy67({ size = 56, rotate = 0, bow, thread, title, className, style, x, y }: Candy67Props) {
  const rawId = useId();
  const pid = 'c67' + rawId.replace(/[^a-zA-Z0-9]/g, '');
  const top = thread ? TOP_PAD_THREAD : bow ? TOP_PAD_BOW : 0;
  const vbH = TEXT_H + top;
  const height = (size * vbH) / W;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 ${-top} ${W} ${vbH}`}
      width={size}
      height={height}
      x={x}
      y={y}
      className={className}
      style={{ ...style, ...(rotate ? { transform: `rotate(${rotate}deg)` } : null), overflow: 'visible' }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <pattern id={pid} width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="16" height="16" fill="#ffffff" />
          <rect width="8" height="16" fill="#e02424" />
        </pattern>
      </defs>
      {thread && <line x1="60" y1={-top} x2="60" y2="8" stroke="#3d1a0a" strokeWidth="2.5" />}
      {(bow || thread) && (
        <g transform="translate(60 4)">
          <path d="M0 0 C-14 -14 -24 -4 -18 4 C-14 9 -6 5 0 0Z" fill="#b31b1b" stroke="#5c0d0d" strokeWidth="2" />
          <path d="M0 0 C14 -14 24 -4 18 4 C14 9 6 5 0 0Z" fill="#b31b1b" stroke="#5c0d0d" strokeWidth="2" />
          <path d="M-2 1 L-8 14 M2 1 L8 14" stroke="#b31b1b" strokeWidth="4" strokeLinecap="round" />
          <circle r="4" fill="#ffd36b" stroke="#5c0d0d" strokeWidth="1.5" />
        </g>
      )}
      <text
        x="60"
        y="76"
        textAnchor="middle"
        fontFamily="'Fredoka', 'Nunito', system-ui, sans-serif"
        fontWeight="600"
        fontSize="80"
        fill={`url(#${pid})`}
        stroke="#5c0d0d"
        strokeWidth="6"
        strokeLinejoin="round"
        paintOrder="stroke"
      >
        67
      </text>
    </svg>
  );
}
