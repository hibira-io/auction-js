import type { Listing, PricePoint, Snapshot, UpdateKind } from './index.js';

export type { Listing, PricePoint, Snapshot, UpdateKind };

export declare const AUCTION_EVENT: 'auction-update';

export type AuctionErrorCode =
  | 'not_found'
  | 'closed'
  | 'too_low'
  | 'own_listing'
  | 'no_buyout'
  | 'has_bids'
  | 'forbidden'
  | 'invalid'
  | 'busy'
  | 'refused';

export declare class AuctionError extends Error {
  constructor(code: AuctionErrorCode, message: string, status?: number);
  readonly code: AuctionErrorCode;
  /** An HTTP status to answer with. */
  readonly status: number;
}

/** A listing as stored on the server. */
export interface StoredListing extends Listing {
  originalEndsAt: number;
  settled: boolean;
}

/** Where listings live. put() must be a compare-and-set on version. */
export interface AuctionStore {
  get(house: string, id: string): Promise<StoredListing | null>;
  all(house: string): Promise<StoredListing[]>;
  put(listing: StoredListing, expectedVersion: number): Promise<boolean>;
  addPrice(house: string, type: string, entry: PricePoint, max: number): Promise<void>;
  prices(house: string, type: string): Promise<PricePoint[]>;
}

export declare class MemoryStore implements AuctionStore {
  constructor(options?: { keepClosed?: number; now?: () => number });
  get(house: string, id: string): Promise<StoredListing | null>;
  all(house: string): Promise<StoredListing[]>;
  put(listing: StoredListing, expectedVersion: number): Promise<boolean>;
  addPrice(house: string, type: string, entry: PricePoint, max: number): Promise<void>;
  prices(house: string, type: string): Promise<PricePoint[]>;
}

/** The part of the `pusher` Node client the house uses. */
export interface PusherLike {
  trigger(channel: string, event: string, data: any): Promise<any>;
}

export interface AuctionHouseServerOptions {
  pusher: PusherLike;
  name?: string;
  channel?: string;
  store?: AuctionStore;
  increment?: (price: number) => number;
  duration?: number;
  minDuration?: number;
  maxDuration?: number;
  extendWithin?: number;
  extendBy?: number;
  maxEndsAfter?: number;
  history?: number;
  maxItemBytes?: number;
  retries?: number;
  reserve?: (args: { listing: StoredListing; userId: string; amount: number }) => Promise<void> | void;
  release?: (args: { listing: StoredListing; userId: string; amount: number; reason: 'outbid' | 'conflict' }) => Promise<void> | void;
  settle?: (args: { listing: StoredListing }) => Promise<void> | void;
  onError?: (err: unknown, context: Record<string, any>) => void;
  now?: () => number;
}

export declare class AuctionHouseServer {
  constructor(options: AuctionHouseServerOptions);
  readonly name: string;
  readonly channel: string;
  readonly store: AuctionStore;
  list(req: {
    sellerId: string | number;
    seller?: Record<string, any>;
    item: Record<string, any>;
    startPrice: number;
    buyout?: number | null;
    duration?: number;
  }): Promise<StoredListing>;
  bid(req: { listingId: string; bidderId: string | number; bidder?: Record<string, any>; amount: number }): Promise<StoredListing>;
  buyout(req: { listingId: string; buyerId: string | number; buyer?: Record<string, any> }): Promise<StoredListing>;
  cancel(req: { listingId: string; sellerId: string | number }): Promise<StoredListing>;
  settleDue(): Promise<StoredListing[]>;
  start(options?: { every?: number }): () => void;
  snapshot(): Promise<Snapshot & { house: string; serverNow: number; closed: Listing[]; prices: Record<string, PricePoint[]> }>;
  get(listingId: string): Promise<StoredListing | null>;
  history(type: string): Promise<PricePoint[]>;
}

export declare function createAuctionHouse(options: AuctionHouseServerOptions): AuctionHouseServer;
export declare function defaultIncrement(price: number): number;
export declare function publicListing(listing: StoredListing): Listing;
