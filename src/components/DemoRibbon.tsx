import { useEffect, useRef, useState } from 'react';
import { DEMO_PASSWORD, demoSeed, demoWipe } from '../api/demoBackend';
import { Button } from './ui';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { useApp } from './AppContext';

/** Small "Demo mode" badge with a few preview tools. Only rendered when backend.mode === 'demo'. */
export function DemoRibbon() {
  const app = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [seeding, setSeeding] = useState<{ done: number; total: number; name: string } | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const seed = async () => {
    setSeeding({ done: 0, total: 0, name: '' });
    try {
      await demoSeed((done, total, name) => setSeeding({ done, total, name }));
      await app.refresh();
      toast.success(`Flatmates added. Their demo password is "${DEMO_PASSWORD}".`);
    } catch (e) {
      toast.error(e);
    } finally {
      setSeeding(null);
    }
  };

  const switchPerson = async () => {
    setOpen(false);
    await app.logout();
  };

  const wipe = async () => {
    await demoWipe();
    window.location.hash = '#/';
    window.location.reload();
  };

  return (
    <div className="demo-ribbon">
      <button
        ref={btnRef}
        type="button"
        className="demo-badge"
        aria-expanded={open}
        aria-controls="demo-tools"
        onClick={() => setOpen((v) => !v)}
      >
        Demo mode
      </button>
      {open && (
        <div id="demo-tools" ref={popRef} className="demo-pop" role="region" aria-label="Demo tools">
          <p className="demo-pop-title">Demo tools</p>
          <p className="demo-pop-note">
            Everything lives in this browser only. Seeded flatmates use the password <code>{DEMO_PASSWORD}</code>.
          </p>
          {seeding ? (
            <div className="demo-progress" role="status" aria-live="polite">
              <progress max={Math.max(1, seeding.total)} value={seeding.done} />
              <span>
                {seeding.total ? `Making keys for ${seeding.name}… ${seeding.done}/${seeding.total}` : 'Adding flatmates…'}
              </span>
            </div>
          ) : (
            <Button small block onClick={seed} disabled={!app.event.bootstrapped}>
              Seed flatmates
            </Button>
          )}
          <Button small block variant="secondary" onClick={switchPerson} disabled={!app.session || !!seeding}>
            Switch person (log out)
          </Button>
          <Button small block variant="danger" onClick={() => setConfirmWipe(true)} disabled={!!seeding}>
            Wipe demo data
          </Button>
        </div>
      )}
      <Modal
        open={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        title="Wipe all demo data?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmWipe(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={wipe}>
              Wipe everything
            </Button>
          </>
        }
      >
        <p>This removes every demo person, wish, wishlist and photo from this browser and starts fresh.</p>
      </Modal>
    </div>
  );
}
