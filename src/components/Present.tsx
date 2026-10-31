import { useMemo, useState, type CSSProperties } from 'react';
import { Candy67 } from './Candy67';
import { usePrefersReducedMotion } from '../lib/motion';

const CONFETTI_COLORS = ['#ffd36b', '#fff3e0', '#7fd18b', '#e02424', '#ffffff'];

/** Wrapped present with a 67 gift tag. Click to unwrap; calls onOpened when the animation ends. */
export function Present({ onOpened }: { onOpened: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [opening, setOpening] = useState(false);

  const confetti = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => {
        const angle = (i / 36) * Math.PI * 2 + (i % 3) * 0.2;
        const dist = 90 + ((i * 37) % 80);
        return {
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist * 0.8 - 70,
          rot: (i * 47) % 360,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          delay: (i % 6) * 0.03,
          round: i % 4 === 0,
        };
      }),
    [],
  );

  const open = () => {
    if (opening) return;
    setOpening(true);
    window.setTimeout(onOpened, reduced ? 50 : 1500);
  };

  return (
    <div className="present-stage">
      <button
        type="button"
        className={`present ${opening ? 'is-opening' : ''}`}
        onClick={open}
        aria-label="Tap to unwrap your Secret Santa"
        disabled={opening}
      >
        <span className="present-lid" aria-hidden="true">
          <span className="present-bow">
            <span className="bow-loop bow-left" />
            <span className="bow-loop bow-right" />
            <span className="bow-knot" />
          </span>
        </span>
        <span className="present-box" aria-hidden="true">
          <span className="present-ribbon-v" />
          <span className="present-ribbon-h" />
        </span>
        <span className="present-tag" aria-hidden="true">
          <span className="present-tag-string" />
          <span className="present-tag-card">
            <Candy67 size={34} rotate={-10} />
          </span>
        </span>
        {opening && (
          <span className="confetti" aria-hidden="true">
            {confetti.map((c, i) => (
              <span
                key={i}
                className={`confetto ${c.round ? 'round' : ''}`}
                style={
                  {
                    '--dx': `${c.dx}px`,
                    '--dy': `${c.dy}px`,
                    '--rot': `${c.rot}deg`,
                    background: c.color,
                    animationDelay: `${0.25 + c.delay}s`,
                  } as CSSProperties
                }
              />
            ))}
          </span>
        )}
      </button>
      <p className="present-hint" aria-hidden="true">
        {opening ? 'Ooh…' : 'Tap to unwrap'}
      </p>
    </div>
  );
}
