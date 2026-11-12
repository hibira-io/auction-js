/** The listing as clients see it. `item`, `seller` and `bidder` are whatever your server put there. */
export interface Listing<Item = Record<string, any>, Info = Record<string, any>> {
  id: string;
  house: string;
  sellerId: string;
  seller: Info;
  item: Item;
  startPrice: number;
  buyout: number | null;
  /** The highest bid, or the sale price once sold. */
  price: number | null;
  bidderId: string | null;
  bidder: Info | null;
  bids: number;
  /** The lowest bid the server accepts next. */
  minBid: number;
  createdAt: number;
  endsAt: number;
  status: 'open' | 'sold' | 'unsold' | 'cancelled';
  soldBy?: 'bid' | 'buyout';
  closedAt: number | null;
  version: number;
}

export type UpdateKind = 'listed' | 'bid' | 'extended' | 'sold' | 'unsold' | 'cancelled';

export interface PricePoint {
  price: number;
  at: number;
  listingId: string;
}

/** What load() returns: the server's house.snapshot(). */
export interface Snapshot {
  house?: string;
  serverNow?: number;
  listings: Listing[];
  closed?: Listing[];
  prices?: Record<string, PricePoint[]>;
}

export interface ChangeEvent {
  listings: Listing[];
  closed: Listing[];
  /** The listing that changed, or null after a (re)load. */
  listing: Listing | null;
  kind: UpdateKind | null;
}

export interface AuctionHouseOptions {
  load: () => Promise<Snapshot | null> | Snapshot | null;
  /** Channel name for AuctionHouse.open (default "auction-<house>"). */
  channel?: string;
  keepClosed?: number;
  historyPerType?: number;
}

export interface AuctionHouseEvents {
  ready: ChangeEvent;
  change: ChangeEvent;
  update: { kind: UpdateKind; listing: Listing };
  error: Error;
}

export declare const AUCTION_EVENT: 'auction-update';

export declare class AuctionHouse {
  static open(pusher: any, house: string, options: AuctionHouseOptions): AuctionHouse;
  constructor(channel: any, options: AuctionHouseOptions & { house?: string });
  readonly house: string | null;
  readonly ready: boolean;
  /** Server clock minus this device's clock, in ms. */
  readonly offset: number;
  /** Open listings, ending soonest first. */
  readonly listings: Listing[];
  /** Recently closed listings, newest first. */
  readonly closed: Listing[];
  get(id: string): Listing | null;
  now(): number;
  timeLeft(listingOrId: Listing | string): number;
  prices(type: string): PricePoint[];
  reload(): Promise<void>;
  close(): void;
  on<E extends keyof AuctionHouseEvents>(event: E, fn: (payload: AuctionHouseEvents[E]) => void): () => void;
  off<E extends keyof AuctionHouseEvents>(event: E, fn: (payload: AuctionHouseEvents[E]) => void): void;
}

export default AuctionHouse;
