import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { backend } from './api';
import type { EventInfo, Participant, Session } from './types';
import { AppContext, type AppState } from './components/AppContext';
import { Header, Footer } from './components/Layout';
import { Background67s, FairyLights, Snow } from './components/Decorations';
import { DemoRibbon } from './components/DemoRibbon';
import { Button, Card, Loading } from './components/ui';
import { useToast } from './components/Toast';
import { SetupPage, WelcomePage } from './pages/Welcome';
import { JoinPage, LoginPage, RecoverPage, RecoveryCodePage, UnlockPage } from './pages/Auth';
import { HomePage } from './pages/Home';
import { WishlistPage } from './pages/WishlistPage';
import { AdminPage } from './pages/Admin';
import { SettingsPage } from './pages/Settings';
import { errorMessage } from './lib/format';
import { navigate, useRoute } from './lib/router';
import { usePrefersReducedMotion } from './lib/motion';
import { getLastUser, getPref, setLastUser, setPref } from './lib/storage';

/** Logged-out screens. */
type Flow =
  | { kind: 'pick' }
  | { kind: 'join'; p: Participant }
  | { kind: 'login'; p: Participant }
  | { kind: 'recover'; p: Participant };

type Auth = Session | 'locked' | null;

export default function App() {
  const toast = useToast();
  const route = useRoute();
  const reducedMotion = usePrefersReducedMotion();
  const [snowPref, setSnowPref] = useState(() => getPref('snow') !== 'off');

  const [event, setEvent] = useState<EventInfo | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [auth, setAuth] = useState<Auth>(null);
  const [flow, setFlow] = useState<Flow>({ kind: 'pick' });
  const [pendingRecovery, setPendingRecovery] = useState<{ name: string; code: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [ev, ps] = await Promise.all([backend.getEvent(), backend.listParticipants()]);
    setEvent(ev);
    setParticipants(ps);
  }, []);

  const boot = useCallback(async () => {
    setLoadError(null);
    try {
      const [, restored] = await Promise.all([refresh(), backend.restoreSession()]);
      if (restored && restored !== 'locked') {
        setLastUser({ id: restored.participant.id, name: restored.participant.name });
      }
      setAuth(restored);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [refresh]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const onSession = useCallback(
    (s: Session) => {
      setAuth(s);
      setLastUser({ id: s.participant.id, name: s.participant.name });
      setFlow({ kind: 'pick' });
      refresh().catch((e) => toast.error(e));
    },
    [refresh, toast],
  );

  const logout = useCallback(async () => {
    try {
      await backend.logout();
    } catch (e) {
      toast.error(e);
    }
    setAuth(null);
    setPendingRecovery(null);
    setFlow({ kind: 'pick' });
    navigate('home');
    refresh().catch((e) => toast.error(e));
  }, [refresh, toast]);

  const session = auth && auth !== 'locked' ? auth : null;
  const me = session ? participants.find((p) => p.id === session.participant.id) ?? session.participant : null;

  const ctx = useMemo<AppState | null>(
    () => (event ? { event, participants, session, refresh, logout } : null),
    [event, participants, session, refresh, logout],
  );

  const snowAllowed = !reducedMotion;
  const snowOn = snowAllowed && snowPref;
  const toggleSnow = () => {
    setSnowPref((v) => {
      setPref('snow', v ? 'off' : 'on');
      return !v;
    });
  };

  let content: ReactNode;
  if (loadError) {
    content = (
      <div className="narrow">
        <Card className="center">
          <h1 className="display">The fire went out</h1>
          <p className="lead">{loadError}</p>
          <Button onClick={() => void boot()}>Try again</Button>
        </Card>
      </div>
    );
  } else if (!event) {
    content = <Loading label="Lighting the fire…" />;
  } else if (!event.bootstrapped) {
    content = (
      <SetupPage
        onDone={async (adminName) => {
          await refresh();
          const ps = await backend.listParticipants();
          const admin = ps.find((p) => p.name.toLowerCase() === adminName.toLowerCase()) ?? ps[0];
          if (admin) setFlow({ kind: 'join', p: admin });
        }}
      />
    );
  } else if (session && pendingRecovery) {
    content = <RecoveryCodePage name={pendingRecovery.name} code={pendingRecovery.code} onContinue={() => setPendingRecovery(null)} />;
  } else if (session) {
    content =
      route === 'admin' ? (
        <AdminPage />
      ) : route === 'settings' ? (
        <SettingsPage />
      ) : route === 'wishlist' ? (
        <WishlistPage />
      ) : (
        <HomePage />
      );
  } else if (auth === 'locked') {
    content = <UnlockPage name={getLastUser()?.name ?? null} onUnlocked={onSession} onSwitch={() => void logout()} />;
  } else if (flow.kind === 'join') {
    content = (
      <JoinPage
        participant={flow.p}
        onBack={() => setFlow({ kind: 'pick' })}
        onJoined={(s, code) => {
          setPendingRecovery({ name: s.participant.name, code });
          onSession(s);
        }}
      />
    );
  } else if (flow.kind === 'login') {
    content = (
      <LoginPage
        participant={flow.p}
        onBack={() => setFlow({ kind: 'pick' })}
        onForgot={() => setFlow({ kind: 'recover', p: flow.p })}
        onLoggedIn={onSession}
      />
    );
  } else if (flow.kind === 'recover') {
    content = <RecoverPage participant={flow.p} onBack={() => setFlow({ kind: 'login', p: flow.p })} onRecovered={onSession} />;
  } else {
    content = (
      <WelcomePage
        eventName={event.name}
        participants={participants}
        onPick={(p) => setFlow(p.claimed ? { kind: 'login', p } : { kind: 'join', p })}
      />
    );
  }

  const shell = (
    <div className="app">
      <FairyLights />
      <Background67s />
      {snowOn && <Snow />}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header
        title={event?.name || '2 OG WEST Secret Santa 2026'}
        me={session && !pendingRecovery ? me : null}
        route={route}
        showWishlist={event?.status === 'drawn'}
        snowOn={snowOn}
        snowAllowed={snowAllowed}
        onToggleSnow={toggleSnow}
      />
      <main id="main" className="main" tabIndex={-1}>
        {content}
      </main>
      <Footer />
    </div>
  );

  return ctx ? (
    <AppContext.Provider value={ctx}>
      {shell}
      {backend.mode === 'demo' && <DemoRibbon />}
    </AppContext.Provider>
  ) : (
    shell
  );
}
