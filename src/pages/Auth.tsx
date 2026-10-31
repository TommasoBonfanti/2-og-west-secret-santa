import { useState, type FormEvent } from 'react';
import { backend } from '../api';
import type { Participant, Session } from '../types';
import { Button, Card, Checkbox, Loading, TextField } from '../components/ui';
import { NewPasswordFields, newPasswordValid } from '../components/PasswordFields';
import { Candy67 } from '../components/Candy67';
import { useToast } from '../components/Toast';
import { WelcomeHero } from './Welcome';

const REMEMBER_HINT = "Keeps you unlocked on this device. Only tick it on your own phone or laptop.";

function BackLink({ onBack, label = 'Not you? Pick another name' }: { onBack: () => void; label?: string }) {
  return (
    <button type="button" className="link-button back-link" onClick={onBack}>
      ← {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Join (first access)
// ---------------------------------------------------------------------------

interface JoinProps {
  participant: Participant;
  onBack: () => void;
  onJoined: (session: Session, recoveryCode: string) => void;
}

export function JoinPage({ participant, onBack, onJoined }: JoinProps) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!newPasswordValid(password, confirm)) return;
    setBusy(true);
    try {
      const { session, recoveryCode } = await backend.claim(participant.id, password, remember);
      onJoined(session, recoveryCode);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <WelcomeHero>
        <Card className="welcome-card center">
          <Candy67 size={72} rotate={-6} bow className="card-topper wobble" />
          <h1 className="display">Wrapping your keys…</h1>
          <Loading label="Making your very own secret keys. This takes a few seconds — grab a cocoa." />
        </Card>
      </WelcomeHero>
    );
  }

  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <BackLink onBack={onBack} />
        <h1 className="display">Hi {participant.name}!</h1>
        <p className="lead">Pick a password to join. Nobody else ever sees it — not even the admin.</p>
        <form onSubmit={submit} className="stack" noValidate>
          <NewPasswordFields
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            showErrors={tried}
          />
          <Checkbox label="Remember this device" hint={REMEMBER_HINT} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <Button type="submit" block>
            Join the fun
          </Button>
        </form>
      </Card>
    </WelcomeHero>
  );
}

// ---------------------------------------------------------------------------
// Recovery code (shown once after joining)
// ---------------------------------------------------------------------------

export function RecoveryCodePage({ name, code, onContinue }: { name: string; code: string; onContinue: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Recovery code copied.');
    } catch {
      toast.error('Copying did not work here — please select the code and copy it by hand.');
    }
  };

  const download = () => {
    const text =
      `2 OG WEST Secret Santa 2026 — recovery code for ${name}\n\n` +
      `${code}\n\n` +
      `Keep this somewhere safe. It is the only way back in if you forget your password.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `secret-santa-recovery-${name.replace(/[^\p{L}\p{N}_-]+/gu, '-').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="narrow">
      <Card className="recovery-card">
        <h1 className="display">Your recovery code</h1>
        <p className="lead">
          If you ever forget your password, this code is the <strong>only</strong> way back in to see who you're gifting.
          Save it somewhere safe — a password manager, a note on your phone, or the downloaded file.
        </p>
        <p className="recovery-code" aria-label="Recovery code">
          {code}
        </p>
        <div className="button-row">
          <Button variant="secondary" onClick={copy}>
            Copy code
          </Button>
          <Button variant="secondary" onClick={download}>
            Download as .txt
          </Button>
        </div>
        <p className="muted small">We'll only show this once. Nobody else has a copy, not even the admin.</p>
        <Checkbox label="I saved my recovery code" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <Button block disabled={!saved} onClick={onContinue}>
          Continue
        </Button>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log in
// ---------------------------------------------------------------------------

interface LoginProps {
  participant: Participant;
  onBack: () => void;
  onForgot: () => void;
  onLoggedIn: (session: Session) => void;
}

export function LoginPage({ participant, onBack, onForgot, onLoggedIn }: LoginProps) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      onLoggedIn(await backend.login(participant.id, password, remember));
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <BackLink onBack={onBack} />
        <h1 className="display">Welcome back, {participant.name}</h1>
        <p className="lead">Pop in your password and warm up by the fire.</p>
        <form onSubmit={submit} className="stack">
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <Checkbox label="Remember this device" hint={REMEMBER_HINT} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <Button type="submit" busy={busy} disabled={!password} block>
            {busy ? 'Unlocking…' : 'Log in'}
          </Button>
        </form>
        <button type="button" className="link-button" onClick={onForgot}>
          Forgot password?
        </button>
      </Card>
    </WelcomeHero>
  );
}

// ---------------------------------------------------------------------------
// Recover (forgot password)
// ---------------------------------------------------------------------------

interface RecoverProps {
  participant: Participant;
  onBack: () => void;
  onRecovered: (session: Session) => void;
}

export function RecoverPage({ participant, onBack, onRecovered }: RecoverProps) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!code.trim() || !newPasswordValid(password, confirm)) return;
    setBusy(true);
    try {
      const session = await backend.recover(participant.id, code.trim(), password);
      toast.success('New password set. Welcome back!');
      onRecovered(session);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <BackLink onBack={onBack} label="Back to log in" />
        <h1 className="display">Forgot your password?</h1>
        <p className="lead">No worries, {participant.name}. Use the recovery code you saved when you joined.</p>
        <form onSubmit={submit} className="stack" noValidate>
          <TextField
            label="Recovery code"
            className="mono-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            error={tried && !code.trim() ? 'Please enter your recovery code.' : undefined}
          />
          <NewPasswordFields
            label="New password"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            showErrors={tried}
          />
          <Button type="submit" busy={busy} block>
            {busy ? 'Re-wrapping your keys…' : 'Set new password'}
          </Button>
        </form>
        <p className="muted small">
          Lost the code too? Ask the admin to reset your account. You'll start fresh, but if the names were already drawn,
          they'll have to be drawn again.
        </p>
      </Card>
    </WelcomeHero>
  );
}

// ---------------------------------------------------------------------------
// Unlock (session exists, key needs the password)
// ---------------------------------------------------------------------------

interface UnlockProps {
  name: string | null;
  onUnlocked: (session: Session) => void;
  onSwitch: () => void;
}

export function UnlockPage({ name, onUnlocked, onSwitch }: UnlockProps) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      onUnlocked(await backend.unlock(password, remember));
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <WelcomeHero>
      <Card className="welcome-card">
        <h1 className="display">{name ? `Welcome back, ${name}` : 'Welcome back'}</h1>
        <p className="lead">Your secrets are locked up tight. Enter your password to unlock them.</p>
        <form onSubmit={submit} className="stack">
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
          <Checkbox label="Remember this device" hint={REMEMBER_HINT} checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <Button type="submit" busy={busy} disabled={!password} block>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
        <button type="button" className="link-button" onClick={onSwitch}>
          Not you? Switch person
        </button>
      </Card>
    </WelcomeHero>
  );
}
