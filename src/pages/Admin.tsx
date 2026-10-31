import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { backend } from '../api';
import { MAX_NAME_LENGTH, type GroupPhoto, type Participant } from '../types';
import { useSessionApp } from '../components/AppContext';
import { Button, Card, Chip, Loading, TextField } from '../components/ui';
import { Modal } from '../components/Modal';
import { PageTitle } from '../components/Layout';
import { Candy67 } from '../components/Candy67';
import { useToast } from '../components/Toast';
import { resizeImage } from '../lib/image';
import { formatDate } from '../lib/format';
import { hrefFor } from '../lib/router';
import { MIN_PARTICIPANTS } from '@shared/draw.ts';

export function AdminPage() {
  const { me } = useSessionApp();
  if (!me.isAdmin) {
    return (
      <div className="page narrow">
        <PageTitle>Admin</PageTitle>
        <Card>
          <p>This corner of the flat is for the admin only.</p>
          <a className="btn btn-secondary" href={hrefFor('home')}>
            <span>Back home</span>
          </a>
        </Card>
      </div>
    );
  }
  return (
    <div className="page admin">
      <PageTitle sub="You run the show — but even you can't peek at who gifts whom.">Admin</PageTitle>
      <DrawSection />
      <div className="two-col">
        <EventSettings />
        <PhotosSection />
      </div>
      <ParticipantsSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event settings
// ---------------------------------------------------------------------------

function EventSettings() {
  const { event, refresh } = useSessionApp();
  const toast = useToast();
  const [name, setName] = useState(event.name);
  const [budget, setBudget] = useState(String(event.budgetAmount));
  const [currency, setCurrency] = useState(event.currency || 'CHF');
  const [date, setDate] = useState(event.exchangeDate ?? '');
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const amount = Number(budget.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('The budget must be a positive number.');
      return;
    }
    setBusy(true);
    try {
      await backend.updateEvent({
        name: name.trim(),
        budgetAmount: amount,
        currency: currency.trim().toUpperCase() || 'CHF',
        exchangeDate: date || null,
      });
      await refresh();
      toast.success('Event details saved.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="card-title">Event details</h2>
      <form onSubmit={save} className="stack">
        <TextField label="Event name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        <div className="row-2">
          <TextField
            label="Budget"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
          <TextField label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} />
        </div>
        <TextField
          label="Gift exchange date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          hint="Optional. Everyone sees a countdown."
        />
        <Button type="submit" busy={busy}>
          Save details
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

function ParticipantsSection() {
  const { event, participants, me, refresh } = useSessionApp();
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [resetTarget, setResetTarget] = useState<Participant | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Participant | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const open = event.status === 'open';

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await backend.addParticipant(newName.trim());
      await refresh();
      toast.success(`${newName.trim()} added to the list.`);
      setNewName('');
    } catch (err) {
      toast.error(err);
    } finally {
      setAdding(false);
    }
  };

  const doRemove = async () => {
    if (!removeTarget) return;
    const p = removeTarget;
    setRemoveTarget(null);
    setBusyId(p.id);
    try {
      await backend.removeParticipant(p.id);
      await refresh();
      toast.success(`${p.name} removed.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const doReset = async () => {
    if (!resetTarget) return;
    const p = resetTarget;
    setResetTarget(null);
    setBusyId(p.id);
    try {
      const { needsRedraw } = await backend.resetParticipant(p.id);
      await refresh();
      toast.success(
        needsRedraw
          ? `${p.name}'s account was reset. Because the names were already drawn, reset the draw and draw again once they've rejoined.`
          : `${p.name}'s account was reset. They can join again with a new password.`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  };

  const joined = participants.filter((p) => p.claimed).length;

  return (
    <Card>
      <h2 className="card-title">Flatmates</h2>
      <p className="muted">
        {participants.length} on the list · {joined} joined
        {!open && ' · The list is locked while the names are drawn.'}
      </p>
      <ul className="admin-people">
        {participants.map((p) => (
          <ParticipantRow
            key={p.id}
            p={p}
            isMe={p.id === me.id}
            canEdit={open}
            busy={busyId === p.id}
            onRemove={() => setRemoveTarget(p)}
            onReset={() => setResetTarget(p)}
          />
        ))}
      </ul>
      {open && (
        <form onSubmit={add} className="inline-form">
          <TextField
            label="Add a flatmate"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Name"
          />
          <Button type="submit" busy={adding} disabled={!newName.trim()}>
            Add
          </Button>
        </form>
      )}

      <Modal
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? ''}?`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
              Keep them
            </Button>
            <Button variant="danger" onClick={doRemove}>
              Remove
            </Button>
          </>
        }
      >
        <p>They haven't joined yet, so nothing else is lost. You can add them again later.</p>
      </Modal>

      <Modal
        open={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title={`Reset ${resetTarget?.name ?? ''}'s account?`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doReset}>
              Reset account
            </Button>
          </>
        }
      >
        <p>Use this only if they forgot their password <strong>and</strong> lost their recovery code.</p>
        <ul className="consequences">
          <li>Their password, keys and draw wishes are deleted. They'll join again from scratch.</li>
          {event.status === 'drawn' ? (
            <li>
              <strong>The names are already drawn.</strong> Their sealed assignment can't be opened anymore, so you'll need
              to reset the draw and draw again — everyone gets a new person and wishlists are wiped.
            </li>
          ) : (
            <li>The names haven't been drawn yet, so nobody else is affected.</li>
          )}
        </ul>
      </Modal>
    </Card>
  );
}

interface RowProps {
  p: Participant;
  isMe: boolean;
  canEdit: boolean;
  busy: boolean;
  onRemove: () => void;
  onReset: () => void;
}

function ParticipantRow({ p, isMe, canEdit, busy, onRemove, onReset }: RowProps) {
  const { refresh } = useSessionApp();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === p.name) {
      setEditing(false);
      setName(p.name);
      return;
    }
    setSaving(true);
    try {
      await backend.renameParticipant(p.id, name.trim());
      await refresh();
      setEditing(false);
      toast.success('Name updated.');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="admin-person">
      {editing ? (
        <form className="rename-form" onSubmit={save}>
          <label className="visually-hidden" htmlFor={`rename-${p.id}`}>
            New name for {p.name}
          </label>
          <input
            ref={inputRef}
            id={`rename-${p.id}`}
            className="input"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                setName(p.name);
              }
            }}
          />
          <Button type="submit" small busy={saving}>
            Save
          </Button>
          <Button
            small
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setName(p.name);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <div className="admin-person-name">
            <span>{p.name}</span>
            {p.isAdmin && <Chip tone="gold">Admin</Chip>}
            {p.claimed ? <Chip tone="green">Joined</Chip> : <Chip>Not joined yet</Chip>}
          </div>
          <div className="admin-person-actions">
            {canEdit && (
              <Button small variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
                Rename
              </Button>
            )}
            {canEdit && !p.claimed && !p.isAdmin && (
              <Button small variant="ghost" onClick={onRemove} busy={busy}>
                Remove
              </Button>
            )}
            {p.claimed && !isMe && (
              <Button small variant="ghost" onClick={onReset} busy={busy}>
                Reset account
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Group photos
// ---------------------------------------------------------------------------

function PhotosSection() {
  const toast = useToast();
  const [photos, setPhotos] = useState<GroupPhoto[] | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setPhotos(await backend.listGroupPhotos());
    } catch (e) {
      toast.error(e);
      setPhotos([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setUploading({ done: 0, total: files.length });
    let ok = 0;
    for (const [i, f] of files.entries()) {
      try {
        const r = await resizeImage(f, { maxSide: 1600, maxBytes: 400_000 });
        await backend.uploadGroupPhoto(r.blob);
        ok++;
      } catch (err) {
        toast.error(err);
      }
      setUploading({ done: i + 1, total: files.length });
    }
    setUploading(null);
    if (ok) toast.success(ok === 1 ? 'Photo added to the wall.' : `${ok} photos added to the wall.`);
    await load();
  };

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await backend.deleteGroupPhoto(id);
      await load();
    } catch (err) {
      toast.error(err);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Card>
      <h2 className="card-title">Group photos</h2>
      <p className="muted small">Shown on everyone's home page after they log in. Resized to 1600 px before upload.</p>
      {photos === null ? (
        <Loading label="Fetching photos…" />
      ) : photos.length === 0 ? (
        <p className="muted">No photos yet — add a few cozy flat memories!</p>
      ) : (
        <ul className="admin-photos">
          {photos.map((p, i) => (
            <li key={p.id}>
              <img src={p.url} alt={`Group photo ${i + 1}`} loading="lazy" />
              <Button small variant="ghost" onClick={() => remove(p.id)} busy={deleting === p.id} aria-label={`Delete group photo ${i + 1}`}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="visually-hidden"
        onChange={onFiles}
        tabIndex={-1}
        aria-hidden="true"
      />
      <Button variant="secondary" onClick={() => fileRef.current?.click()} busy={!!uploading}>
        {uploading ? `Uploading ${uploading.done}/${uploading.total}…` : 'Upload photos'}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

function DrawSection() {
  const { event, participants, refresh } = useSessionApp();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const [resetting, setResetting] = useState(false);

  const waiting = participants.filter((p) => !p.claimed);
  const reasons: string[] = [];
  if (participants.length < MIN_PARTICIPANTS) {
    reasons.push(`You need at least ${MIN_PARTICIPANTS} people (currently ${participants.length}).`);
  }
  if (waiting.length) {
    reasons.push(
      waiting.length === 1
        ? `Waiting for ${waiting[0].name} to join.`
        : `Waiting for ${waiting.length} people to join: ${waiting.map((p) => p.name).join(', ')}.`,
    );
  }
  const canDraw = event.status === 'open' && reasons.length === 0;

  const draw = async () => {
    setConfirming(false);
    setDrawing(true);
    try {
      await backend.draw();
      await refresh();
      setSuccess(true);
    } catch (err) {
      toast.error(err);
    } finally {
      setDrawing(false);
    }
  };

  const resetDraw = async () => {
    setResetting(true);
    try {
      await backend.resetDraw();
      await refresh();
      setResetOpen(false);
      setResetText('');
      toast.success('The draw was reset. Everyone is back by the fire, waiting for a new draw.');
    } catch (err) {
      toast.error(err);
    } finally {
      setResetting(false);
    }
  };

  if (event.status === 'drawn') {
    return (
      <>
        <Card className="draw-card is-drawn">
          <Candy67 size={64} rotate={8} bow className="card-topper" />
          <h2 className="display small-display">The names are drawn!</h2>
          <p className="lead">
            {event.drawnAt ? `Drawn on ${formatDate(event.drawnAt.slice(0, 10))}. ` : ''}
            Everyone can now see who they're gifting on their home page. The results are sealed — there's nothing to show
            here, not even to you.
          </p>
        </Card>
        <Card className="danger-zone">
          <h2 className="card-title">Danger zone</h2>
          <p>
            Resetting the draw throws away every assignment <strong>and every wishlist</strong>, and opens wishes again.
            Only do this if something went wrong (for example, someone had to reset their account).
          </p>
          <Button variant="danger" onClick={() => setResetOpen(true)}>
            Reset draw
          </Button>
        </Card>
        <Modal
          open={resetOpen}
          onClose={() => {
            setResetOpen(false);
            setResetText('');
          }}
          title="Reset the draw?"
          actions={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setResetOpen(false);
                  setResetText('');
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={resetText !== 'RESET'} busy={resetting} onClick={resetDraw}>
                Reset draw
              </Button>
            </>
          }
        >
          <p>All assignments and wishlists will be deleted for everyone. This can't be undone.</p>
          <TextField
            label={
              <>
                Type <code>RESET</code> to confirm
              </>
            }
            value={resetText}
            onChange={(e) => setResetText(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            data-autofocus
          />
        </Modal>
        <SuccessModal open={success} onClose={() => setSuccess(false)} />
      </>
    );
  }

  return (
    <Card className="draw-card">
      <h2 className="display small-display">Draw names</h2>
      {canDraw ? (
        <p className="lead">Everyone is by the fire. When you're ready, draw the names — it only takes a moment.</p>
      ) : (
        <ul className="draw-reasons">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <Button className="draw-button" onClick={() => setConfirming(true)} disabled={!canDraw} busy={drawing}>
        {drawing ? 'Shaking the hat…' : 'Draw names'}
      </Button>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Ready to draw?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
            <Button onClick={draw}>Draw names</Button>
          </>
        }
      >
        <p>
          The draw respects everyone's wishes, never pairs two people as each other's Santa, and seals each result so only
          the giver can open it. After the draw, the flatmate list and wishes are locked.
        </p>
      </Modal>
    </Card>
  );
}

function SuccessModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ho ho ho — the names are drawn!"
      actions={
        <Button onClick={onClose} data-autofocus>
          Wonderful
        </Button>
      }
    >
      <div className="center">
        <Candy67 size={96} rotate={-6} bow className="wobble" />
        <p>Every result is sealed. Tell everyone to open the site and unwrap their present!</p>
        <p>
          <a href={hrefFor('home')} onClick={onClose}>
            Unwrap yours on the home page
          </a>
        </p>
      </div>
    </Modal>
  );
}
