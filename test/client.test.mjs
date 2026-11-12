import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuctionHouse, AUCTION_EVENT } from '../index.js';

function fakeChannel(name = 'auction-main') {
  const handlers = new Map();
  return {
    name,
    subscribed: false,
    bind(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
    },
    unbind(ev, fn) {
      handlers.get(ev)?.delete(fn);
    },
    emit(ev, data) {
      for (const fn of handlers.get(ev) ?? []) fn(data);
    },
    handlers,
  };
}

function fakePusher() {
  const channels = new Map();
  return {
    channels,
    unsubscribed: [],
    subscribe(name) {
      const ch = fakeChannel(name);
      channels.set(name, ch);
      return ch;
    },
    unsubscribe(name) {
      this.unsubscribed.push(name);
    },
  };
}

const L = (id, version, extra = {}) => ({ id, version, status: 'open', endsAt: Date.now() + 60_000, price: null, item: { type: 'sword' }, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('open subscribes to auction-<house> and loads on subscription', async () => {
  const p = fakePusher();
  let loads = 0;
  const h = AuctionHouse.open(p, 'main', {
    load: async () => {
      loads++;
      return { serverNow: Date.now(), listings: [L('a', 1), L('b', 1, { endsAt: Date.now() + 1000 })], closed: [] };
    },
  });
  const ch = p.channels.get('auction-main');
  assert.ok(ch);
  let ready = 0;
  h.on('ready', () => ready++);
  ch.emit('pusher:subscription_succeeded');
  await tick();
  assert.equal(loads, 1);
  assert.equal(ready, 1);
  assert.deepEqual(h.listings.map((l) => l.id), ['b', 'a']);
  h.close();
  assert.deepEqual(p.unsubscribed, ['auction-main']);
});

test('load is required', () => {
  assert.throws(() => new AuctionHouse(fakeChannel(), {}), /load/);
});

test('events update listings and stale versions are ignored', async () => {
  const ch = fakeChannel();
  ch.subscribed = true;
  const h = new AuctionHouse(ch, { load: async () => ({ listings: [L('a', 1)], closed: [] }) });
  await tick();
  const updates = [];
  h.on('update', (u) => updates.push(u.kind));
  ch.emit(AUCTION_EVENT, { kind: 'bid', listing: L('a', 3, { price: 50 }), serverNow: Date.now() });
  ch.emit(AUCTION_EVENT, { kind: 'bid', listing: L('a', 2, { price: 40 }), serverNow: Date.now() });
  assert.equal(h.get('a').price, 50);
  assert.deepEqual(updates, ['bid']);
  ch.emit(AUCTION_EVENT, { kind: 'sold', listing: L('a', 4, { status: 'sold', price: 60, closedAt: Date.now() }) });
  assert.equal(h.listings.length, 0);
  assert.equal(h.closed[0].id, 'a');
  assert.deepEqual(h.prices('sword').map((p) => p.price), [60]);
});

test('events that arrive while loading are kept when newer', async () => {
  const ch = fakeChannel();
  let resolve;
  const h = new AuctionHouse(ch, { load: () => new Promise((r) => (resolve = r)) });
  ch.emit('pusher:subscription_succeeded');
  ch.emit(AUCTION_EVENT, { kind: 'bid', listing: L('a', 5, { price: 90 }) });
  ch.emit(AUCTION_EVENT, { kind: 'listed', listing: L('new', 1) });
  resolve({ serverNow: Date.now(), listings: [L('a', 4, { price: 80 }), L('b', 1)], closed: [] });
  await tick();
  assert.equal(h.get('a').price, 90);
  assert.deepEqual(h.listings.map((l) => l.id).sort(), ['a', 'b', 'new']);
});

test('a reload drops open listings the server has closed and pruned', async () => {
  const ch = fakeChannel();
  let snap = { listings: [L('a', 1, { endsAt: Date.now() - 1 })], closed: [] };
  const h = new AuctionHouse(ch, { load: async () => snap });
  ch.emit('pusher:subscription_succeeded');
  await tick();
  snap = { serverNow: Date.now(), listings: [], closed: [] };
  ch.emit('pusher:subscription_succeeded');
  await tick();
  assert.equal(h.listings.length, 0);
});

test('the server clock offset drives timeLeft', async () => {
  const ch = fakeChannel();
  ch.subscribed = true;
  const now = Date.now();
  const h = new AuctionHouse(ch, { load: async () => ({ serverNow: now + 10_000, listings: [L('a', 1, { endsAt: now + 15_000 })], closed: [] }) });
  await tick();
  const left = h.timeLeft('a');
  assert.ok(left > 4000 && left <= 5000, `left ${left}`);
  assert.equal(h.timeLeft('nope'), 0);
});

test('snapshot prices are merged without duplicates', async () => {
  const ch = fakeChannel();
  ch.subscribed = true;
  const h = new AuctionHouse(ch, {
    load: async () => ({
      listings: [],
      closed: [L('s1', 3, { status: 'sold', price: 20, closedAt: 2 })],
      prices: { sword: [{ price: 10, at: 1, listingId: 's0' }, { price: 20, at: 2, listingId: 's1' }] },
    }),
  });
  await tick();
  assert.deepEqual(h.prices('sword').map((p) => p.price), [10, 20]);
});

test('load errors and handler errors are reported, not thrown', async () => {
  const ch = fakeChannel();
  const h = new AuctionHouse(ch, {
    load: async () => {
      throw new Error('500');
    },
  });
  const errors = [];
  h.on('error', (e) => errors.push(e.message));
  ch.emit('pusher:subscription_succeeded');
  await tick();
  assert.deepEqual(errors, ['500']);
  h.on('update', () => {
    throw new Error('boom');
  });
  ch.emit(AUCTION_EVENT, { kind: 'listed', listing: L('x', 1) });
  assert.deepEqual(errors, ['500', 'boom']);
});

test('malformed events are ignored', () => {
  const ch = fakeChannel();
  const h = new AuctionHouse(ch, { load: async () => null });
  ch.emit(AUCTION_EVENT, null);
  ch.emit(AUCTION_EVENT, { listing: { id: 1 } });
  assert.equal(h.listings.length, 0);
});
