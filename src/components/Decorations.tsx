import { useMemo, type CSSProperties } from 'react';
import { Candy67 } from './Candy67';

// ---------------------------------------------------------------------------
// Fairy lights across the top of the page
// ---------------------------------------------------------------------------

const VB_W = 2400;
const VB_H = 120;
const SWAG = 240; // width of one sagging curve
const SAG = 34;
const CORD_Y = 10;
const BULB_COLORS = ['#ffd36b', '#fff3e0', '#7fd18b'];
/** Swags (0-based) where a candy-cane 67 hangs instead of the first bulb. Swag 5 is visible on phones. */
const ORNAMENT_SWAGS = new Set([3, 5]);

function quad(t: number, x0: number) {
  // Quadratic Bezier from (x0, CORD_Y) via (x0 + SWAG/2, CORD_Y + 2*SAG) to (x0 + SWAG, CORD_Y)
  const p0 = { x: x0, y: CORD_Y };
  const p1 = { x: x0 + SWAG / 2, y: CORD_Y + SAG * 2 };
  const p2 = { x: x0 + SWAG, y: CORD_Y };
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

export function FairyLights() {
  const { path, bulbs, ornaments } = useMemo(() => {
    const swags = VB_W / SWAG;
    let d = `M0 ${CORD_Y}`;
    const bulbs: { x: number; y: number; color: string; delay: number; i: number }[] = [];
    const ornaments: { x: number; y: number; rotate: number }[] = [];
    let n = 0;
    for (let s = 0; s < swags; s++) {
      const x0 = s * SWAG;
      d += ` Q${x0 + SWAG / 2} ${CORD_Y + SAG * 2} ${x0 + SWAG} ${CORD_Y}`;
      const ts = [0.17, 0.39, 0.61, 0.83];
      ts.forEach((t, k) => {
        const p = quad(t, x0);
        if (ORNAMENT_SWAGS.has(s) && k === 0) {
          ornaments.push({ x: p.x, y: p.y, rotate: s === 3 ? -6 : 7 });
        } else {
          bulbs.push({ x: p.x, y: p.y, color: BULB_COLORS[n % 3], delay: ((n * 0.37) % 2.6) + (n % 2) * 0.4, i: n });
          n++;
        }
      });
    }
    return { path: d, bulbs, ornaments };
  }, []);

  return (
    <div className="fairy-lights" aria-hidden="true">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMin slice" focusable="false">
        <path d={path} fill="none" stroke="#3d1a0a" strokeWidth="3" strokeLinecap="round" />
        {bulbs.map((b) => (
          <g key={b.i} transform={`translate(${b.x} ${b.y}) rotate(${(b.i % 3) * 6 - 6})`}>
            <rect x="-4" y="-1" width="8" height="8" rx="1.5" fill="#3d1a0a" />
            <ellipse
              className="bulb"
              cx="0"
              cy="16"
              rx="7"
              ry="10"
              fill={b.color}
              style={{ animationDelay: `${b.delay}s`, color: b.color } as CSSProperties}
            />
            <ellipse cx="-2.5" cy="12" rx="2" ry="3.2" fill="#ffffff" opacity="0.55" />
          </g>
        ))}
        {ornaments.map((o, i) => (
          <g key={i} transform={`translate(${o.x} ${o.y})`}>
            <g className="hanging-67" style={{ animationDelay: `${i * -1.7}s` }}>
              <g transform={`rotate(${o.rotate})`}>
                <line x1="0" y1="0" x2="0" y2="14" stroke="#3d1a0a" strokeWidth="2" />
                <Candy67 size={44} x={-22} y={12} />
              </g>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snowfall (CSS only, ~40 flakes)
// ---------------------------------------------------------------------------

export function Snow() {
  const flakes = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => {
        const r = (k: number) => {
          const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
          return v - Math.floor(v);
        };
        return {
          left: `${(r(1) * 100).toFixed(2)}%`,
          size: 3 + r(2) * 5,
          duration: 14 + r(3) * 14,
          delay: -r(4) * 28,
          drift: (r(5) * 2 - 1) * 40,
          opacity: 0.5 + r(6) * 0.45,
        };
      }),
    [],
  );
  return (
    <div className="snow" aria-hidden="true">
      {flakes.map((f, i) => (
        <span
          key={i}
          className="flake"
          style={
            {
              left: f.left,
              width: f.size,
              height: f.size,
              opacity: f.opacity,
              animationDuration: `${f.duration}s`,
              animationDelay: `${f.delay}s`,
              '--drift': `${f.drift}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparse 67s scattered in the background
// ---------------------------------------------------------------------------

interface Scatter {
  pos: CSSProperties;
  size: number;
  rotate: number;
  bow?: boolean;
  thread?: boolean;
  /** Hidden on narrow screens (would sit behind content). */
  wideOnly?: boolean;
}

const SCATTER: Scatter[] = [
  { pos: { top: '16%', left: '2.5%' }, size: 40, rotate: -18, thread: true, wideOnly: true },
  { pos: { top: '34%', right: '3%' }, size: 34, rotate: 14, bow: true, wideOnly: true },
  { pos: { top: '58%', left: '4%' }, size: 28, rotate: 22, wideOnly: true },
  { pos: { top: '76%', right: '5%' }, size: 44, rotate: -12, bow: true, wideOnly: true },
  { pos: { top: '90%', left: '12%' }, size: 26, rotate: 9 },
  { pos: { top: '46%', right: '9%' }, size: 24, rotate: -24, wideOnly: true },
  { pos: { top: '24%', right: '14%' }, size: 30, rotate: 6, thread: true, wideOnly: true },
  { pos: { top: '68%', left: '13%' }, size: 32, rotate: -7, wideOnly: true },
  { pos: { bottom: '3%', right: '18%' }, size: 36, rotate: 18 },
];

export function Background67s() {
  return (
    <div className="bg-67s" aria-hidden="true">
      {SCATTER.map((s, i) => (
        <span key={i} className={['bg-67', s.wideOnly && 'wide-only'].filter(Boolean).join(' ')} style={s.pos}>
          <Candy67 size={s.size} rotate={s.rotate} bow={s.bow} thread={s.thread} />
        </span>
      ))}
    </div>
  );
}
