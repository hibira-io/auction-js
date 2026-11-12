// The auction house's authority, for Node backends that use the `pusher`
// package (any object with a trigger(channel, event, data) method works).
//
// Every rule that decides who wins runs here, never in the browser or the
// game client: the minimum bid, who may bid, when an auction ends, the last
// seconds' extension and the settlement. Players send bids to your own
// endpoint, which calls house.bid(); the house saves the new state and
// publishes it once on the house channel, and every open client updates.
//
// Your game keeps owning the items and the coins. The house asks you, through
// three callbacks, to:
//
//   - reserve(): hold a bidder's coins (throw to refuse the bid);
//   - release(): give back coins held for a bid that was outbid or failed;
//   - settle(): move the item and the coins once an auction has closed.
//
// State lives in a store. MemoryStore keeps it in this process, which is
// enough for one server; with several servers, implement the same four
// methods on your database (put() must be a compare-and-set on version).

export const AUCTION_EVENT = 'auction-update';

export class AuctionError extends Error {
  /**
   * @param {string} code not_found | closed | too_low | own_listing | no_buyout | has_bids | forbidden | invalid | busy | refused
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuctionError';
    this.code = code;
    this.status = status;
  }
}

/** Keeps listings in this process. Closed, settled listings are dropped after keepClosed ms. */
export class MemoryStore {
  constructor({ keepClosed = 10 * 60_000, now = () => Date.now() } = {}) {
    this.keepClosed = keepClosed;
    this.now = now;
    this._houses = new Map();
    this._prices = new Map();
  }

  _house(house) {
    if (!this._houses.has(house)) this._houses.set(house, new Map());
    return this._houses.get(house);
  }

  async get(house, id) {
    const l = this._house(house).get(id);
    return l ? structuredClone(l) : null;
  }

  async all(house) {
    this._prune(house);
    return [...this._house(house).values()].map((l) => structuredClone(l));
  }

  /** Saves listing when the stored version is expectedVersion (0: must not exist yet). */
  async put(listing, expectedVersion) {
    const map = this._house(listing.house);
    const current = map.get(listing.id);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    map.set(listing.id, structuredClone(listing));
    return true;
  }

  async addPrice(house, type, entry, max) {
    const key = `${house}\u0000${type}`;
    const list = this._prices.get(key) ?? [];
    list.push(entry);
    this._prices.set(key, list.slice(-max));
  }

  async prices(house, type) {
    return [...(this._prices.get(`${house}\u0000${type}`) ?? [])];
  }

  _prune(house) {
    const map = this._house(house);
    const cutoff = this.now() - this.keepClosed;
    for (const [id, l] of map) {
      if (l.status !== 'open' && l.settled && (l.closedAt ?? 0) < cutoff) map.delete(id);
    }
  }
}

const DEFAULTS = {
  duration: 60 * 60_000,
  minDuration: 10_000,
  maxDuration: 7 * 24 * 60 * 60_000,
  extendWithin: 30_000,
  extendBy: 30_000,
  maxEndsAfter: 60 * 60_000,
  history: 20,
  maxItemBytes: 2000,
  retries: 5,
};

/** Default minimum raise: 5% of the current price, at least 1. */
export function defaultIncrement(price) {
  return Math.max(1, Math.ceil(price * 0.05));
}

/**
 * Create the authority for one auction house.
 *
 * @param {object} options
 * @param {object} options.pusher a `pusher` (Node) instance
 * @param {string} [options.name="main"] house name
 * @param {string} [options.channel] channel to publish on (default "auction-<name>")
 * @param {object} [options.store] MemoryStore or your own
 * @param {function} [options.increment] (price) => smallest raise
 * @param {number} [options.duration] default auction length in ms
 * @param {number} [options.minDuration] shortest allowed auction
 * @param {number} [options.maxDuration] longest allowed auction
 * @param {number} [options.extendWithin] a bid this close to the end extends it
 * @param {number} [options.extendBy] the end moves to at least now + extendBy
 * @param {number} [options.maxEndsAfter] extensions never go past the original end + this
 * @param {number} [options.history] sale prices kept per item type
 * @param {function} [options.reserve] async ({listing, userId, amount}) hold coins; throw to refuse
 * @param {function} [options.release] async ({listing, userId, amount, reason}) give coins back
 * @param {function} [options.settle] async ({listing}) move item and coins; must be idempotent by listing.id
 * @param {function} [options.onError] (err, context) for publish and settle failures
 * @param {function} [options.now] clock, ms since epoch
 */
export function createAuctionHouse(options) {
  return new AuctionHouseServer(options);
}

export class AuctionHouseServer {
  constructor(options = {}) {
    if (!options.pusher) throw new Error('createAuctionHouse: pusher is required');
    const o = { ...DEFAULTS, ...options };
    this.pusher = o.pusher;
    this.name = o.name ?? 'main';
    if (!/^[A-Za-z0-9_\-=@,.;]+$/.test(this.name)) throw new Error(`createAuctionHouse: invalid name "${this.name}"`);
    this.channel = o.channel ?? `auction-${this.name}`;
    this.store = o.store ?? new MemoryStore({ now: o.now });
    this.increment = o.increment ?? defaultIncrement;
    this.options = o;
    this.now = o.now ?? (() => Date.now());
    this._locks = new Map();
    this._seq = 0;
  }

  /**
   * Put an item up for auction.
   * @param {object} req
   * @param {string|number} req.sellerId
   * @param {object} [req.seller] public info shown with the listing (name...)
   * @param {object} req.item what is sold; item.type groups sale prices (e.g. "sword-of-dawn")
   * @param {number} req.startPrice lowest first bid
   * @param {number} [req.buyout] price that ends the auction at once
   * @param {number} [req.duration] ms
   */
  async list({ sellerId, seller = {}, item, startPrice, buyout = null, duration }) {
    const o = this.options;
    if (sellerId == null || sellerId === '') throw new AuctionError('invalid', 'sellerId is required');
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AuctionError('invalid', 'item must be an object');
    if (JSON.stringify({ item, seller }).length > o.maxItemBytes) {
      throw new AuctionError('invalid', `item and seller must be under ${o.maxItemBytes} bytes of JSON`);
    }
    if (!isAmount(startPrice) || startPrice < 1) throw new AuctionError('invalid', 'startPrice must be a whole number of at least 1');
    if (buyout != null && (!isAmount(buyout) || buyout < startPrice)) {
      throw new AuctionError('invalid', 'buyout must be a whole number not below startPrice');
    }
    const length = duration ?? o.duration;
    if (!Number.isFinite(length) || length < o.minDuration || length > o.maxDuration) {
      throw new AuctionError('invalid', `duration must be between ${o.minDuration} and ${o.maxDuration} ms`);
    }
    const now = this.now();
    const listing = {
      id: this._id(now),
      house: this.name,
      sellerId: String(sellerId),
      seller,
      item,
      startPrice,
      buyout,
      price: null,
      bidderId: null,
      bidder: null,
      bids: 0,
      minBid: startPrice,
      createdAt: now,
      endsAt: now + length,
      originalEndsAt: now + length,
      status: 'open',
      closedAt: null,
      settled: false,
      version: 1,
    };
    if (!(await this.store.put(listing, 0))) throw new AuctionError('busy', 'listing id collision, try again', 409);
    await this._publish('listed', listing);
    return listing;
  }

  /**
   * Bid on a listing. Resolves with the updated listing.
   * @param {object} req
   * @param {string} req.listingId
   * @param {string|number} req.bidderId
   * @param {object} [req.bidder] public info shown as the high bidder (name...)
   * @param {number} req.amount
   */
  async bid({ listingId, bidderId, bidder = {}, amount }) {
    if (bidderId == null || bidderId === '') throw new AuctionError('invalid', 'bidderId is required');
    if (!isAmount(amount)) throw new AuctionError('invalid', 'amount must be a whole number');
    return this._change(listingId, async (l, now) => {
      this._mustBeOpen(l, now);
      if (l.sellerId === String(bidderId)) throw new AuctionError('own_listing', 'you cannot bid on your own listing', 403);
      if (l.bidderId === String(bidderId)) throw new AuctionError('invalid', 'you are already the highest bidder', 409);
      if (amount < l.minBid) throw new AuctionError('too_low', `the lowest bid is ${l.minBid}`, 409);
      if (l.buyout != null && amount >= l.buyout) {
        return this._sell(l, now, String(bidderId), bidder, l.buyout, 'bid');
      }
      const previous = l.bidderId ? { userId: l.bidderId, amount: l.price } : null;
      const next = {
        ...l,
        price: amount,
        bidderId: String(bidderId),
        bidder,
        bids: l.bids + 1,
        minBid: amount + Math.max(1, Math.ceil(this.increment(amount))),
        version: l.version + 1,
      };
      const o = this.options;
      if (next.endsAt - now <= o.extendWithin) {
        next.endsAt = Math.min(Math.max(next.endsAt, now + o.extendBy), l.originalEndsAt + o.maxEndsAfter);
      }
      return {
        next,
        kind: next.endsAt !== l.endsAt ? 'extended' : 'bid',
        reserve: { userId: next.bidderId, amount },
        releaseAfter: previous ? { ...previous, reason: 'outbid' } : null,
      };
    });
  }

  /** Buy a listing at its buyout price. */
  async buyout({ listingId, buyerId, buyer = {} }) {
    if (buyerId == null || buyerId === '') throw new AuctionError('invalid', 'buyerId is required');
    return this._change(listingId, async (l, now) => {
      this._mustBeOpen(l, now);
      if (l.buyout == null) throw new AuctionError('no_buyout', 'this listing has no buyout price', 409);
      if (l.sellerId === String(buyerId)) throw new AuctionError('own_listing', 'you cannot buy your own listing', 403);
      return this._sell(l, now, String(buyerId), buyer, l.buyout, 'buyout');
    });
  }

  /** Withdraw a listing that has no bids yet. Only its seller may. */
  async cancel({ listingId, sellerId }) {
    return this._change(listingId, async (l, now) => {
      this._mustBeOpen(l, now);
      if (l.sellerId !== String(sellerId)) throw new AuctionError('forbidden', 'only the seller can cancel', 403);
      if (l.bids > 0) throw new AuctionError('has_bids', 'a listing with bids cannot be cancelled', 409);
      return { next: { ...l, status: 'cancelled', closedAt: now, version: l.version + 1 }, kind: 'cancelled' };
    });
  }

  /**
   * Close every auction whose time is up and settle every closed one not yet
   * settled. Call it on a timer (see start()) or from a cron job.
   * @returns {Promise<object[]>} listings settled in this call
   */
  async settleDue() {
    const now = this.now();
    const all = await this.store.all(this.name);
    const settled = [];
    const tried = new Set();
    for (const l of all) {
      if (l.status === 'open' && l.endsAt <= now) {
        let closedHere = false;
        const done = await this._change(l.id, async (cur, t) => {
          closedHere = cur.status === 'open' && cur.endsAt <= t;
          if (!closedHere) return null;
          const sold = cur.bidderId != null;
          return { next: { ...cur, status: sold ? 'sold' : 'unsold', closedAt: t, version: cur.version + 1 }, kind: sold ? 'sold' : 'unsold' };
        }).catch((err) => this._error(err, { listingId: l.id, step: 'close' }));
        if (closedHere) tried.add(l.id);
        if (closedHere && done?.settled) settled.push(done);
      }
    }
    for (const l of await this.store.all(this.name)) {
      if (l.status === 'open' || l.settled || tried.has(l.id)) continue;
      const done = await this._settle(l);
      if (done) settled.push(done);
    }
    return settled;
  }

  /** Run settleDue() every `every` ms. Returns a function that stops it. */
  start({ every = 1000 } = {}) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await this.settleDue();
      } catch (err) {
        this._error(err, { step: 'settleDue' });
      } finally {
        running = false;
      }
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** What a client loads on open: open listings, recently closed ones, sale prices of their item types and the server clock. */
  async snapshot() {
    const all = await this.store.all(this.name);
    const types = [...new Set(all.map((l) => l.item?.type).filter((t) => t != null).map(String))];
    const prices = {};
    for (const t of types) {
      const list = await this.store.prices(this.name, t);
      if (list.length) prices[t] = list;
    }
    return {
      house: this.name,
      serverNow: this.now(),
      listings: all.filter((l) => l.status === 'open').sort(byEnd).map(publicListing),
      closed: all.filter((l) => l.status !== 'open').sort((a, b) => b.closedAt - a.closedAt).map(publicListing),
      prices,
    };
  }

  async get(listingId) {
    return this.store.get(this.name, String(listingId));
  }

  /** Recent sale prices of one item type, oldest first: [{price, at, listingId}]. */
  async history(type) {
    return this.store.prices(this.name, String(type));
  }

  _mustBeOpen(l, now) {
    if (l.status !== 'open' || l.endsAt <= now) throw new AuctionError('closed', 'this auction has ended', 409);
  }

  _sell(l, now, userId, info, price, how) {
    return {
      next: {
        ...l,
        price,
        bidderId: userId,
        bidder: info,
        bids: l.bids + 1,
        status: 'sold',
        soldBy: how,
        closedAt: now,
        version: l.version + 1,
      },
      kind: 'sold',
      reserve: { userId, amount: price },
      releaseAfter: l.bidderId ? { userId: l.bidderId, amount: l.price, reason: 'outbid' } : null,
    };
  }

  // Runs one change on one listing: serialized in this process, and saved
  // with a compare-and-set so several servers sharing a store cannot both win.
  async _change(listingId, fn) {
    const id = String(listingId ?? '');
    return this._lock(id, async () => {
      for (let attempt = 0; attempt < this.options.retries; attempt++) {
        const l = await this.store.get(this.name, id);
        if (!l) throw new AuctionError('not_found', 'no such listing', 404);
        const now = this.now();
        const plan = await fn(l, now);
        if (!plan) return l;
        if (plan.reserve) await this._reserve(plan.next, plan.reserve);
        if (await this.store.put(plan.next, l.version)) {
          if (plan.releaseAfter) await this._release(plan.next, plan.releaseAfter);
          await this._publish(plan.kind, plan.next);
          if (plan.next.status !== 'open' && !plan.next.settled) {
            await this._settle(plan.next);
            return (await this.store.get(this.name, id)) ?? plan.next;
          }
          return plan.next;
        }
        if (plan.reserve) await this._release(plan.next, { ...plan.reserve, reason: 'conflict' });
      }
      throw new AuctionError('busy', 'too many bids at once, try again', 409);
    });
  }

  async _reserve(listing, { userId, amount }) {
    if (!this.options.reserve) return;
    try {
      await this.options.reserve({ listing, userId, amount });
    } catch (err) {
      if (err instanceof AuctionError) throw err;
      throw new AuctionError('refused', err?.message || 'bid refused', 402);
    }
  }

  async _release(listing, { userId, amount, reason }) {
    if (!this.options.release) return;
    try {
      await this.options.release({ listing, userId, amount, reason });
    } catch (err) {
      this._error(err, { listingId: listing.id, step: 'release', userId, amount });
    }
  }

  async _settle(listing) {
    try {
      if (this.options.settle) await this.options.settle({ listing });
    } catch (err) {
      this._error(err, { listingId: listing.id, step: 'settle' });
      return null;
    }
    if (listing.status === 'sold' && listing.item?.type != null) {
      await this.store.addPrice(this.name, String(listing.item.type), { price: listing.price, at: listing.closedAt, listingId: listing.id }, this.options.history);
    }
    for (let attempt = 0; attempt < this.options.retries; attempt++) {
      const cur = await this.store.get(this.name, listing.id);
      if (!cur || cur.settled) return cur;
      const next = { ...cur, settled: true };
      if (await this.store.put(next, cur.version)) return next;
    }
    return null;
  }

  async _publish(kind, listing) {
    const data = { kind, listing: publicListing(listing), serverNow: this.now() };
    try {
      await this.pusher.trigger(this.channel, AUCTION_EVENT, data);
    } catch (err) {
      this._error(err, { listingId: listing.id, step: 'publish' });
    }
  }

  _error(err, context) {
    if (this.options.onError) this.options.onError(err, context);
    else console.error('[auction]', context, err);
  }

  _lock(key, fn) {
    const prev = this._locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this._locks.set(key, tail);
    tail.then(() => {
      if (this._locks.get(key) === tail) this._locks.delete(key);
    });
    return run;
  }

  _id(now) {
    this._seq = (this._seq + 1) % 1296;
    const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
    return `${now.toString(36)}${this._seq.toString(36).padStart(2, '0')}${rand}`;
  }
}

/** The listing as clients see it (settled and originalEndsAt stay on the server). */
export function publicListing(l) {
  const { settled, originalEndsAt, ...rest } = l;
  return rest;
}

function isAmount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

function byEnd(a, b) {
  return a.endsAt - b.endsAt || (a.id < b.id ? -1 : 1);
}
