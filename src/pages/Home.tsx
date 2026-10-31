import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { backend } from '../api';
import type { Assignment, EventInfo, GroupPhoto, Participant, Preferences } from '../types';
import { useSessionApp } from '../components/AppContext';
import { Button, Card, Chip, Field, Loading } from '../components/ui';
import { Candy67 } from '../components/Candy67';
import { Present } from '../components/Present';
import { PhotoHero, PhotoWall, splitPhotos } from '../components/Photos';
import { useLightbox } from '../components/Polaroid';
import { WishlistView } from '../components/WishlistView';
import { useToast } from '../components/Toast';
import { countdownText, formatDate, formatMoney } from '../lib/format';
import { getPref, setPref } from '../lib/storage';
import { hrefFor } from '../lib/router';

export function EventChips({ event }: { event: EventInfo }) {
  return (
    <div className="chip-row">
      <Chip tone="red">Budget {formatMoney(event.budgetAmount, event.currency)}</Chip>
      {event.exchangeDate && (
        <Chip tone="gold">
          Gift exchange {formatDate(event.exchangeDate)} · {countdownText(event.exchangeDate)}
        </Chip>
      )}
    </div>
  );
}

export function HomePage() {
  const { event, me, participants } = useSessionApp();
  const toast = useToast();
  const lightbox = useLightbox();
  const [photos, setPhotos] = useState<GroupPhoto[] | null>(null);

  useEffect(() => {
    let alive = true;
    backend
      .listGroupPhotos()
      .then((p) => alive && setPhotos(p))
      .catch((e) => {
        if (alive) setPhotos([]);
        toast.error(e);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  const { flanks, wall } = splitPhotos(photos ?? []);
  const drawn = event.status === 'drawn';

  return (
    <div className="page home">
      <PhotoHero flanks={flanks} onOpen={(src) => lightbox.open(src, 'Flat photo')}>
        {drawn ? <Reveal event={event} me={me} /> : <EventCard event={event} me={me} />}
      </PhotoHero>

      {drawn ? (
        <>
          <Card className="mini-card">
            <h2 className="card-title">Your wishlist</h2>
            <p>Help your Secret Santa out: add a few ideas, links or pictures. Only your Secret Santa can read this.</p>
            <a className="btn btn-secondary" href={hrefFor('wishlist')}>
              <span>Write my wishlist</span>
            </a>
          </Card>
        </>
      ) : (
        <div className="two-col">
          <JoinedCard participants={participants} />
          <PreferencesCard me={me} participants={participants} />
        </div>
      )}

      {photos === null ? <Loading label="Hanging the photos…" /> : <PhotoWall photos={wall} total={photos.length} isAdmin={me.isAdmin} />}
      {lightbox.element}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Before the draw
// ---------------------------------------------------------------------------

function EventCard({ event, me }: { event: EventInfo; me: Participant }) {
  return (
    <Card className="event-card">
      <Candy67 size={70} rotate={-8} bow className="card-topper" />
      <h1 className="display">{event.name}</h1>
      <p className="lead">
        Welcome home, {me.name} — come sit by the fire. Once everyone has joined, the admin will draw the names and
        you'll find out who you're gifting right here.
      </p>
      <EventChips event={event} />
      {me.isAdmin && (
        <p className="note center admin-note">
          You're the admin: add flatmates and draw the names in the <a href={hrefFor('admin')}>admin panel</a>.
        </p>
      )}
    </Card>
  );
}

function JoinedCard({ participants }: { participants: Participant[] }) {
  const joined = participants.filter((p) => p.claimed).length;
  return (
    <Card>
      <h2 className="card-title">Who's by the fire</h2>
      <p className="muted">
        {joined} of {participants.length} have joined
        {joined === participants.length ? ' — everyone is here!' : ''}
      </p>
      <ul className="joined-list">
        {participants.map((p) => (
          <li key={p.id} className={p.claimed ? 'is-joined' : ''}>
            <span className="joined-mark" aria-hidden="true">
              {p.claimed ? '✓' : '·'}
            </span>
            <span>{p.name}</span>
            <span className="visually-hidden">{p.claimed ? ' (joined)' : ' (not joined yet)'}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PreferencesCard({ me, participants }: { me: Participant; participants: Participant[] }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [draft, setDraft] = useState<Preferences>({ noGiveTo: null, noReceiveFrom: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    backend
      .getMyPreferences()
      .then((p) => {
        if (!alive) return;
        setPrefs(p);
        setDraft(p);
      })
      .catch((e) => toast.error(e));
    return () => {
      alive = false;
    };
  }, [toast]);

  const others = useMemo(() => participants.filter((p) => p.id !== me.id), [participants, me.id]);
  const dirty = prefs !== null && (prefs.noGiveTo !== draft.noGiveTo || prefs.noReceiveFrom !== draft.noReceiveFrom);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await backend.setMyPreferences(draft);
      setPrefs(draft);
      toast.success('Wishes saved. Only the draw will see them.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const select = (key: keyof Preferences, label: string) => (
    <Field label={label}>
      {({ id, describedBy }) => (
        <select
          id={id}
          className="input"
          aria-describedby={describedBy}
          value={draft[key] ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value || null }))}
        >
          <option value="">No preference</option>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <Card>
      <h2 className="card-title">Your wishes for the draw</h2>
      {prefs === null ? (
        <Loading label="Fetching your wishes…" />
      ) : (
        <form onSubmit={save} className="stack">
          {select('noGiveTo', 'I’d rather not gift…')}
          {select('noReceiveFrom', 'I’d rather not receive from…')}
          <p className="note">
            <span aria-hidden="true">🔒 </span>Only the draw sees this — nobody else, not even the admin.
          </p>
          <Button type="submit" busy={busy} disabled={!dirty}>
            Save my wishes
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// After the draw
// ---------------------------------------------------------------------------

function Reveal({ event, me }: { event: EventInfo; me: Participant }) {
  const toast = useToast();
  const flagKey = `unwrapped:${me.id}:${event.drawnAt ?? ''}`;
  const [assignment, setAssignment] = useState<Assignment | null | undefined>(undefined);
  const [unwrapped, setUnwrapped] = useState(() => getPref(flagKey) === '1');

  const load = useCallback(async () => {
    try {
      setAssignment(await backend.getMyAssignment());
    } catch (e) {
      toast.error(e);
      setAssignment(null);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (assignment === undefined) {
    return (
      <Card className="reveal-card center">
        <Loading label="Opening your sealed envelope…" />
      </Card>
    );
  }

  if (assignment === null) {
    return (
      <Card className="reveal-card center">
        <h1 className="display">The names are drawn!</h1>
        <p className="lead">
          We couldn't find your assignment. If your account was reset after the draw, ask the admin to redo the draw.
        </p>
        <Button variant="secondary" onClick={load}>
          Try again
        </Button>
      </Card>
    );
  }

  if (!unwrapped) {
    return (
      <Card className="reveal-card center present-card">
        <h1 className="display">Something's under the tree for you</h1>
        <Present
          onOpened={() => {
            setPref(flagKey, '1');
            setUnwrapped(true);
          }}
        />
      </Card>
    );
  }

  return (
    <Card className="reveal-card">
      <div className="gift-tag" aria-hidden="true">
        <span className="gift-tag-hole">
          <Candy67 size={30} rotate={-12} />
        </span>
      </div>
      <p className="reveal-kicker">Ho ho ho, you're gifting</p>
      <h1 className="reveal-name">{assignment.receiverName}</h1>
      <EventChips event={event} />
      <div className="reveal-wishlist">
        <h2 className="card-title">{assignment.receiverName}'s wishlist</h2>
        {assignment.wishlist ? (
          <WishlistView wishlist={assignment.wishlist} name={assignment.receiverName} />
        ) : (
          <p className="muted">{assignment.receiverName} hasn't written a wishlist yet — check back later.</p>
        )}
      </div>
      <p className="muted small">Shh! Keep it secret. Nobody else can see this — not even the admin.</p>
      <button
        type="button"
        className="link-button small"
        onClick={() => {
          setPref(flagKey, null);
          setUnwrapped(false);
        }}
      >
        Replay unwrap
      </button>
    </Card>
  );
}
