export type EventStatus = 'open' | 'drawn';

export interface EventInfo {
  name: string;
  budgetAmount: number;
  currency: string;
  /** ISO date (YYYY-MM-DD) of the gift exchange, if set. */
  exchangeDate: string | null;
  status: EventStatus;
  drawnAt: string | null;
  /** False on a fresh deployment with no participants yet (show setup). */
  bootstrapped: boolean;
}

export interface Participant {
  id: string;
  name: string;
  isAdmin: boolean;
  /** True once the person has set their password. */
  claimed: boolean;
}

export interface Session {
  participant: Participant;
}

export interface Preferences {
  /** Participant I don't want to gift. */
  noGiveTo: string | null;
  /** Participant I don't want to receive a gift from. */
  noReceiveFrom: string | null;
}

export interface WishlistImage {
  mime: string;
  dataB64: string;
}

export interface Wishlist {
  text: string;
  links: string[];
  images: WishlistImage[];
  updatedAt?: string;
}

export interface Assignment {
  receiverId: string;
  receiverName: string;
  /** Null if the receiver hasn't written a wishlist yet. */
  wishlist: Wishlist | null;
}

export interface GroupPhoto {
  id: string;
  url: string;
}

export type EventPatch = Partial<Pick<EventInfo, 'name' | 'budgetAmount' | 'currency' | 'exchangeDate'>>;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_WISHLIST_IMAGES = 4;
export const MAX_NAME_LENGTH = 40;
