import type {
  Assignment,
  EventInfo,
  EventPatch,
  GroupPhoto,
  Participant,
  Preferences,
  Session,
  Wishlist,
} from '../types';

/**
 * Everything the UI needs. Implementations: supabaseBackend (real) and
 * demoBackend (in-browser preview). Methods throw `BackendError` with a
 * user-facing message on failure.
 *
 * The backend keeps the unlocked RSA private key in memory; it never
 * leaves the implementation.
 */
export interface Backend {
  readonly mode: 'supabase' | 'demo';

  // Public (no login)
  getEvent(): Promise<EventInfo>;
  listParticipants(): Promise<Participant[]>;
  /** Fresh deployment only: creates the admin participant. */
  bootstrap(adminName: string): Promise<void>;

  // Auth
  /** First access: set password. Returns the recovery code to show ONCE. */
  claim(participantId: string, password: string, remember: boolean): Promise<{ session: Session; recoveryCode: string }>;
  login(participantId: string, password: string, remember: boolean): Promise<Session>;
  /**
   * Restores a session after reload. Returns:
   * - a Session if logged in and the key is unlocked (remembered device),
   * - 'locked' if logged in but the password is needed to unlock the key,
   * - null if not logged in.
   */
  restoreSession(): Promise<Session | 'locked' | null>;
  /** Unlock after 'locked' (re-enter password). */
  unlock(password: string, remember: boolean): Promise<Session>;
  logout(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;
  /** Forgot password: set a new one with the recovery code, then logs in. */
  recover(participantId: string, recoveryCode: string, newPassword: string): Promise<Session>;

  // Logged in
  getMyPreferences(): Promise<Preferences>;
  setMyPreferences(prefs: Preferences): Promise<void>;
  /** Null before the draw. */
  getMyAssignment(): Promise<Assignment | null>;
  /** My own wishlist (null if not written yet or before the draw). */
  getMyWishlist(): Promise<Wishlist | null>;
  /** Only after the draw. */
  saveMyWishlist(wishlist: Wishlist): Promise<void>;
  listGroupPhotos(): Promise<GroupPhoto[]>;

  // Admin only
  updateEvent(patch: EventPatch): Promise<void>;
  addParticipant(name: string): Promise<void>;
  renameParticipant(id: string, name: string): Promise<void>;
  /** Only unclaimed participants, only before the draw. */
  removeParticipant(id: string): Promise<void>;
  /** Clears a person's account so they can set a new password. */
  resetParticipant(id: string): Promise<{ needsRedraw: boolean }>;
  draw(): Promise<void>;
  /** Wipes assignments and wishlists, back to 'open'. */
  resetDraw(): Promise<void>;
  uploadGroupPhoto(file: Blob): Promise<void>;
  deleteGroupPhoto(id: string): Promise<void>;
}

export class BackendError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'BackendError';
  }
}
