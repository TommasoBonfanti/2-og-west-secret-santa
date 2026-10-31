import { useState, type FormEvent, type ReactNode } from 'react';
import { backend } from '../api';
import { MAX_NAME_LENGTH, type Participant } from '../types';
import { Button, Card, TextField } from '../components/ui';
import { Candy67 } from '../components/Candy67';
import { Polaroid, PlaceholderArt } from '../components/Polaroid';
import { useToast } from '../components/Toast';
import { welcomePhotos } from '../welcomePhotos';

/** Card flanked by two tilted polaroids (stacked below on phones). */
export function WelcomeHero({ children }: { children: ReactNode }) {
  const left = welcomePhotos[0];
  const right = welcomePhotos[1];
  return (
    <div className="hero">
      <div className="hero-side hero-left">
        {left ? (
          <Polaroid src={left} alt="The flat" tilt={-5} size="md" />
        ) : (
          <Polaroid art={<PlaceholderArt kind="tree" />} caption="Tree night" tilt={-5} />
        )}
      </div>
      <div className="hero-main">{children}</div>
      <div className="hero-side hero-right">
        {right ? (
          <Polaroid src={right} alt="The flat" tilt={4} size="md" />
        ) : (
          <Polaroid art={<PlaceholderArt kind="present" />} caption="Wrapping season" tilt={5} />
        )}
      </div>
    </div>
  );
}

export function SetupPage({ onDone }: { onDone: (adminName: string) => Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await backend.bootstrap(name.trim());
      await onDone(name.trim());
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <Candy67 size={84} rotate={-6} bow className="card-topper" />
        <h1 className="display">Set up your Secret Santa</h1>
        <p className="lead">Welcome home — come sit by the fire. You're the first one here, so you'll be the admin.</p>
        <form onSubmit={submit} className="stack">
          <TextField
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="given-name"
            required
            hint="Use the name your flatmates know you by. You can add everyone else afterwards."
          />
          <Button type="submit" busy={busy} disabled={!name.trim()} block>
            Set it up
          </Button>
        </form>
      </Card>
    </WelcomeHero>
  );
}

interface WelcomeProps {
  eventName: string;
  participants: Participant[];
  onPick: (p: Participant) => void;
}

export function WelcomePage({ eventName, participants, onPick }: WelcomeProps) {
  const joined = participants.filter((p) => p.claimed).length;
  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <h1 className="display">{eventName}</h1>
        <p className="lead">Welcome home — come sit by the fire. Find your name to get started.</p>
        <p className="joined-count">
          <strong>{joined}</strong> of <strong>{participants.length}</strong> have joined
        </p>
        {participants.length === 0 ? (
          <p className="muted">No names yet. Ask the admin to add everyone.</p>
        ) : (
          <ul className="name-grid" aria-label="Pick your name">
            {participants.map((p) => (
              <li key={p.id}>
                <button type="button" className={`name-card ${p.claimed ? 'is-claimed' : ''}`} onClick={() => onPick(p)}>
                  <span className="name-card-name">{p.name}</span>
                  <span className="name-card-action">
                    {p.claimed ? (
                      <>
                        <span aria-hidden="true">✓ </span>Log in
                      </>
                    ) : (
                      'Join'
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </WelcomeHero>
  );
}
