import { createContext, useContext } from 'react';
import type { EventInfo, Participant, Session } from '../types';

export interface AppState {
  event: EventInfo;
  participants: Participant[];
  session: Session | null;
  /** Re-fetch event + participants. */
  refresh: () => Promise<void>;
  /** Log out and return to the welcome page. */
  logout: () => Promise<void>;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppContext.Provider>');
  return ctx;
}

/** Same as useApp, but asserts a logged-in session (only use on logged-in pages). */
export function useSessionApp(): AppState & { session: Session; me: Participant } {
  const app = useApp();
  if (!app.session) throw new Error('No session');
  const me = app.participants.find((p) => p.id === app.session!.participant.id) ?? app.session.participant;
  return { ...app, session: app.session, me };
}
