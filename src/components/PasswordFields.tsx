import { useState } from 'react';
import { MIN_PASSWORD_LENGTH } from '../types';
import { passwordStrength } from '../lib/format';
import { TextField } from './ui';

interface Props {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  label?: string;
  /** Show errors (after a submit attempt). */
  showErrors?: boolean;
}

/** New password + confirmation with a strength hint. */
export function NewPasswordFields({ password, confirm, onPassword, onConfirm, label = 'Choose a password', showErrors }: Props) {
  const [show, setShow] = useState(false);
  const strength = passwordStrength(password, MIN_PASSWORD_LENGTH);
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <TextField
        label={label}
        type={show ? 'text' : 'password'}
        autoComplete="new-password"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
        hint={
          <>
            <span className={`strength strength-${strength.score}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{password ? strength.label : `At least ${MIN_PASSWORD_LENGTH} characters. Tip: four random words, like "candle sled pickle tuba".`}</span>
          </>
        }
        error={showErrors && password.length < MIN_PASSWORD_LENGTH ? `Please use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
      />
      <TextField
        label="Type it again"
        type={show ? 'text' : 'password'}
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => onConfirm(e.target.value)}
        required
        error={mismatch && (showErrors || confirm.length >= password.length) ? "The two passwords don't match yet." : undefined}
      />
      <button type="button" className="link-button show-pw" onClick={() => setShow((v) => !v)} aria-pressed={show}>
        {show ? 'Hide passwords' : 'Show passwords'}
      </button>
    </>
  );
}

export function newPasswordValid(password: string, confirm: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password === confirm;
}
