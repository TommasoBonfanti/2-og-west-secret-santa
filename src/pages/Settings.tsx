import { useState, type FormEvent } from 'react';
import { backend } from '../api';
import { useSessionApp } from '../components/AppContext';
import { Button, Card, TextField } from '../components/ui';
import { NewPasswordFields, newPasswordValid } from '../components/PasswordFields';
import { PageTitle } from '../components/Layout';
import { useToast } from '../components/Toast';

export function SettingsPage() {
  const { me, logout } = useSessionApp();
  const toast = useToast();
  const [oldPw, setOldPw] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!oldPw || !newPasswordValid(password, confirm)) return;
    setBusy(true);
    try {
      await backend.changePassword(oldPw, password);
      toast.success('Password changed. Your recovery code still works.');
      setOldPw('');
      setPassword('');
      setConfirm('');
      setTried(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <PageTitle>Settings</PageTitle>
      <Card>
        <h2 className="card-title">Change password</h2>
        <form onSubmit={change} className="stack" noValidate>
          {/* Hidden username helps password managers file the new password correctly. */}
          <input type="text" autoComplete="username" value={me.name} readOnly hidden />
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            required
            error={tried && !oldPw ? 'Please enter your current password.' : undefined}
          />
          <NewPasswordFields
            label="New password"
            password={password}
            confirm={confirm}
            onPassword={setPassword}
            onConfirm={setConfirm}
            showErrors={tried}
          />
          <Button type="submit" busy={busy}>
            {busy ? 'Re-wrapping your keys…' : 'Change password'}
          </Button>
        </form>
      </Card>
      <Card>
        <h2 className="card-title">Log out</h2>
        <p>Logging out also forgets this device if you ticked "Remember this device".</p>
        <Button
          variant="secondary"
          busy={leaving}
          onClick={async () => {
            setLeaving(true);
            await logout();
          }}
        >
          Log out
        </Button>
      </Card>
    </div>
  );
}
