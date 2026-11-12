// The auction house as players see it, for pusher-js and Laravel Echo.
//
// The house channel (auction-<house> by default) carries one event,
// auction-update, which your server publishes through @hibira-io/auction/server
// whenever a listing is created, bid on, extended, sold, left unsold or
// cancelled. Each event holds the whole listing with a version number, so a
// client keeps the newest copy of each listing and ignores stale ones.
//
// On every (re)subscription the house calls your load() function, which
// returns the server's snapshot (house.snapshot() on the server), so listings
// changed while the client was offline are caught up. Events that arrive
// while loading are kept: whichever copy has the higher version wins.
//
// Players never send bids over the socket. They call your own endpoint,
// which checks who they are and calls house.bid() on the server.

export const AUCTION_EVENT = 'auction-update';

const DEFAULTS = {
  keepClosed: 50,
  historyPerType: 20,
};

export class AuctionHouse {
  /**
   * Subscribe to a house channel and track it.
   * @param {import('pusher-js').default} pusher
   * @param {string} house house name, e.g. "main"
   * @param {object} options see constructor; load is required
   */
  static open(pusher, house, options = {}) {
    const channelName = options.channel ?? `auction-${house}`;
    const h = new AuctionHouse(pusher.subscribe(channelName), { ...options, house });
    h._unsubscribe = () => pusher.unsubscribe(channelName);
    return h;
  }

  /**
   * Track a pusher-js channel used as an auction house, e.g.
   * `new AuctionHouse(Echo.channel('auction-main').subscription, { load })`.
   * Create it right after subscribing so no event is missed.
   *
   * @param {object} channel pusher-js Channel (public or private)
   * @param {object} options
   * @param {function} options.load async () => snapshot from your server
   * @param {number} [options.keepClosed=50] closed listings kept for "recent sales"
   * @param {number} [options.historyPerType=20] sale prices kept per item type
   */
  constructor(channel, options = {}) {
    if (typeof options.load !== 'function') throw new Error('AuctionHouse: options.load is required');
    this.channel = channel;
    this.options = { ...DEFAULTS, ...options };
    this.house = options.house ?? channel.name?.replace(/^(private-)?auction-/, '') ?? null;
    this.ready = false;
    this.offset = 0;
    this._listings = new Map();
    this._closed = [];
    this._prices = new Map();
    this._handlers = new Map();
    this._loadSeq = 0;

    this._onUpdate = (data) => this._apply(data);
    this._onSubscribed = () => this.reload();
    this._onError = (err) => this._emit('error', err instanceof Error ? err : new Error(`AuctionHouse: subscription failed (${err?.status ?? err?.type ?? 'error'})`));
    channel.bind(AUCTION_EVENT, this._onUpdate);
    channel.bind('pusher:subscription_succeeded', this._onSubscribed);
    channel.bind('pusher:subscription_error', this._onError);
    if (channel.subscribed) this.reload();
  }

  /** Open listings, ending soonest first. */
  get listings() {
    return [...this._listings.values()].sort((a, b) => a.endsAt - b.endsAt || (a.id < b.id ? -1 : 1));
  }

  /** Recently closed listings (sold, unsold, cancelled), newest first. */
  get closed() {
    return [...this._closed];
  }

  /** One listing, open or recently closed. */
  get(id) {
    return this._listings.get(id) ?? this._closed.find((l) => l.id === id) ?? null;
  }

  /** The server's clock, estimated from the last event or load. */
  now() {
    return Date.now() + this.offset;
  }

  /** Milliseconds left on a listing (0 once ended). */
  timeLeft(listingOrId) {
    const l = typeof listingOrId === 'string' ? this.get(listingOrId) : listingOrId;
    if (!l || l.status !== 'open') return 0;
    return Math.max(0, l.endsAt - this.now());
  }

  /** Sale prices seen for an item type, oldest first: [{price, at, listingId}]. */
  prices(type) {
    return [...(this._prices.get(String(type)) ?? [])];
  }

  /** Load the snapshot again (done for you on every subscription). */
  async reload() {
    const seq = ++this._loadSeq;
    let snap;
    try {
      snap = await this.options.load();
    } catch (err) {
      if (seq === this._loadSeq) this._emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (seq !== this._loadSeq || !snap) return;
    if (Number.isFinite(snap.serverNow)) this.offset = snap.serverNow - Date.now();
    const all = new Map([...this._closed, ...this._listings.values()].map((l) => [l.id, l]));
    const listed = new Set();
    for (const l of [...(snap.listings ?? []), ...(snap.closed ?? [])]) {
      listed.add(l.id);
      const mine = all.get(l.id);
      if (!mine || mine.version < l.version) all.set(l.id, l);
    }
    // An open listing the snapshot does not mention arrived after it was
    // taken, unless its time is already up (closed and pruned on the server).
    const now = this.now();
    for (const [id, l] of all) if (!listed.has(id) && l.status === 'open' && l.endsAt <= now) all.delete(id);
    const values = [...all.values()];
    this._listings = new Map(values.filter((l) => l.status === 'open').map((l) => [l.id, l]));
    this._closed = values
      .filter((l) => l.status !== 'open')
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, this.options.keepClosed);
    for (const [type, list] of Object.entries(snap.prices ?? {})) {
      for (const p of list) this._addPrice(type, p);
    }
    for (const l of this._closed) this._notePrice(l);
    const first = !this.ready;
    this.ready = true;
    if (first) this._emit('ready', this._changeEvent(null, null));
    this._emit('change', this._changeEvent(null, null));
  }

  /** Stop listening (and unsubscribe when opened with AuctionHouse.open). */
  close() {
    this._loadSeq++;
    this.channel.unbind(AUCTION_EVENT, this._onUpdate);
    this.channel.unbind('pusher:subscription_succeeded', this._onSubscribed);
    this.channel.unbind('pusher:subscription_error', this._onError);
    this._unsubscribe?.();
    this._handlers.clear();
  }

  /**
   * Events: ready, change ({listings, closed, listing, kind}), update
   * ({kind, listing}) for each server event, and error.
   */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    for (const fn of [...(this._handlers.get(event) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        if (event !== 'error') this._emit('error', err);
      }
    }
  }

  _apply(data) {
    const l = data?.listing;
    if (!l || typeof l.id !== 'string' || !Number.isFinite(l.version)) return;
    if (Number.isFinite(data.serverNow)) this.offset = data.serverNow - Date.now();
    const known = this.get(l.id);
    if (known && known.version >= l.version) return;
    if (l.status === 'open') {
      this._listings.set(l.id, l);
    } else {
      this._listings.delete(l.id);
      this._closed = [l, ...this._closed.filter((c) => c.id !== l.id)].slice(0, this.options.keepClosed);
      this._notePrice(l);
    }
    this._emit('update', { kind: data.kind, listing: l });
    this._emit('change', this._changeEvent(l, data.kind));
  }

  _notePrice(l) {
    if (l.status !== 'sold' || l.item?.type == null) return;
    this._addPrice(l.item.type, { price: l.price, at: l.closedAt, listingId: l.id });
  }

  _addPrice(type, entry) {
    const key = String(type);
    const list = this._prices.get(key) ?? [];
    if (list.some((p) => p.listingId === entry.listingId)) return;
    list.push(entry);
    list.sort((a, b) => a.at - b.at);
    this._prices.set(key, list.slice(-this.options.historyPerType));
  }

  _changeEvent(listing, kind) {
    return { listings: this.listings, closed: this.closed, listing, kind };
  }
}

export default AuctionHouse;
