import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuctionHouse, MemoryStore, AuctionError, AUCTION_EVENT, defaultIncrement } from '../server.js';

function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const published = [];
  const calls = [];
  const pusher = {
    async trigger(channel, event, data) {
      published.push({ channel, event, data });
    },
  };
  const house = createAuctionHouse({
    pusher,
    now: () => clock.t,
    reserve: async (a) => calls.push(['reserve', a.userId, a.amount]),
    release: async (a) => calls.push(['release', a.userId, a.amount, a.reason]),
    settle: async ({ listing }) => calls.push(['settle', listing.id, listing.status, listing.bidderId, listing.price]),
    onError: () => {},
    ...opts,
  });
  return { house, clock, published, calls };
}

const item = { type: 'sword', name: 'Sword of Dawn' };

test('list publishes the listing on auction-<house>', async () => {
  const { house, published } = setup();
  const l = await house.list({ sellerId: 's', seller: { name: 'Sam' }, item, startPrice: 100, duration: 60_000 });
  assert.equal(l.status, 'open');
  assert.equal(l.minBid, 100);
  assert.equal(l.endsAt, 1_060_000);
  assert.equal(published.length, 1);
  assert.equal(published[0].channel, 'auction-main');
  assert.equal(published[0].event, AUCTION_EVENT);
  assert.equal(published[0].data.kind, 'listed');
  assert.equal(published[0].data.listing.settled, undefined);
  assert.equal(published[0].data.listing.originalEndsAt, undefined);
});

test('list validates its input', async () => {
  const { house } = setup();
  await assert.rejects(house.list({ sellerId: 's', item, startPrice: 0 }), /startPrice/);
  await assert.rejects(house.list({ sellerId: 's', item, startPrice: 1.5 }), /startPrice/);
  await assert.rejects(house.list({ sellerId: 's', item, startPrice: 10, buyout: 5 }), /buyout/);
  await assert.rejects(house.list({ sellerId: 's', item, startPrice: 10, duration: 5 }), /duration/);
  await assert.rejects(house.list({ sellerId: 's', item: { blob: 'x'.repeat(3000) }, startPrice: 10 }), /bytes/);
  await assert.rejects(house.list({ item, startPrice: 10 }), /sellerId/);
});

test('bids must beat the minimum, and outbid coins are released', async () => {
  const { house, calls } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 100, duration: 600_000 });
  await assert.rejects(house.bid({ listingId: l.id, bidderId: 'a', amount: 99 }), (e) => e instanceof AuctionError && e.code === 'too_low');
  const b1 = await house.bid({ listingId: l.id, bidderId: 'a', bidder: { name: 'Ann' }, amount: 100 });
  assert.equal(b1.price, 100);
  assert.equal(b1.minBid, 105);
  assert.equal(b1.bidder.name, 'Ann');
  await assert.rejects(house.bid({ listingId: l.id, bidderId: 'b', amount: 104 }), /lowest bid is 105/);
  await assert.rejects(house.bid({ listingId: l.id, bidderId: 'a', amount: 200 }), /already the highest/);
  const b2 = await house.bid({ listingId: l.id, bidderId: 'b', amount: 105 });
  assert.equal(b2.bids, 2);
  assert.deepEqual(calls, [
    ['reserve', 'a', 100],
    ['reserve', 'b', 105],
    ['release', 'a', 100, 'outbid'],
  ]);
});

test('sellers cannot bid on their own listing', async () => {
  const { house } = setup();
  const l = await house.list({ sellerId: 7, item, startPrice: 10 });
  await assert.rejects(house.bid({ listingId: l.id, bidderId: '7', amount: 10 }), (e) => e.code === 'own_listing' && e.status === 403);
});

test('a refused reserve refuses the bid and saves nothing', async () => {
  const { house } = setup({
    reserve: async () => {
      throw new Error('not enough gold');
    },
  });
  const l = await house.list({ sellerId: 's', item, startPrice: 10 });
  await assert.rejects(house.bid({ listingId: l.id, bidderId: 'a', amount: 10 }), (e) => e.code === 'refused' && /not enough gold/.test(e.message));
  assert.equal((await house.get(l.id)).bids, 0);
});

test('a bid in the last seconds extends the auction, up to maxEndsAfter', async () => {
  const { house, clock, published } = setup({ extendWithin: 30_000, extendBy: 30_000, maxEndsAfter: 40_000 });
  const l = await house.list({ sellerId: 's', item, startPrice: 10, duration: 60_000 });
  clock.t += 50_000;
  const b = await house.bid({ listingId: l.id, bidderId: 'a', amount: 10 });
  assert.equal(b.endsAt, clock.t + 30_000);
  assert.equal(published.at(-1).data.kind, 'extended');
  clock.t = b.endsAt - 1000;
  const b2 = await house.bid({ listingId: l.id, bidderId: 'b', amount: 20 });
  assert.equal(b2.endsAt, l.endsAt + 40_000);
});

test('buyout sells at once and settles', async () => {
  const { house, calls, published } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 10, buyout: 500 });
  await house.bid({ listingId: l.id, bidderId: 'a', amount: 50 });
  const sold = await house.buyout({ listingId: l.id, buyerId: 'b' });
  assert.equal(sold.status, 'sold');
  assert.equal(sold.soldBy, 'buyout');
  assert.equal(sold.price, 500);
  assert.equal(sold.settled, true);
  assert.deepEqual(calls.slice(1), [
    ['reserve', 'b', 500],
    ['release', 'a', 50, 'outbid'],
    ['settle', l.id, 'sold', 'b', 500],
  ]);
  assert.equal(published.at(-1).data.kind, 'sold');
  await assert.rejects(house.bid({ listingId: l.id, bidderId: 'c', amount: 600 }), (e) => e.code === 'closed');
  assert.deepEqual((await house.history('sword')).map((p) => p.price), [500]);
});

test('a bid at or above the buyout price buys out', async () => {
  const { house } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 10, buyout: 100 });
  const sold = await house.bid({ listingId: l.id, bidderId: 'a', amount: 150 });
  assert.equal(sold.status, 'sold');
  assert.equal(sold.price, 100);
});

test('buyout needs a buyout price', async () => {
  const { house } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 10 });
  await assert.rejects(house.buyout({ listingId: l.id, buyerId: 'a' }), (e) => e.code === 'no_buyout');
});

test('cancel: seller only, and only without bids', async () => {
  const { house, published } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 10 });
  await assert.rejects(house.cancel({ listingId: l.id, sellerId: 'x' }), (e) => e.code === 'forbidden');
  const c = await house.cancel({ listingId: l.id, sellerId: 's' });
  assert.equal(c.status, 'cancelled');
  assert.equal(published.at(-1).data.kind, 'cancelled');
  const l2 = await house.list({ sellerId: 's', item, startPrice: 10 });
  await house.bid({ listingId: l2.id, bidderId: 'a', amount: 10 });
  await assert.rejects(house.cancel({ listingId: l2.id, sellerId: 's' }), (e) => e.code === 'has_bids');
});

test('settleDue closes ended auctions as sold or unsold', async () => {
  const { house, clock, calls, published } = setup();
  const a = await house.list({ sellerId: 's', item, startPrice: 10, duration: 60_000 });
  const b = await house.list({ sellerId: 's', item: { type: 'shield' }, startPrice: 10, duration: 60_000 });
  const c = await house.list({ sellerId: 's', item, startPrice: 10, duration: 120_000 });
  await house.bid({ listingId: a.id, bidderId: 'x', amount: 42 });
  clock.t += 60_000;
  const settled = await house.settleDue();
  assert.deepEqual(settled.map((l) => [l.id, l.status]).sort(), [[a.id, 'sold'], [b.id, 'unsold']].sort());
  assert.ok(calls.some((c) => c[0] === 'settle' && c[1] === a.id && c[3] === 'x' && c[4] === 42));
  assert.ok(published.some((p) => p.data.kind === 'unsold' && p.data.listing.id === b.id));
  assert.equal((await house.get(c.id)).status, 'open');
  assert.deepEqual(await house.settleDue(), []);
});

test('a failed settle is retried by the next settleDue', async () => {
  let fail = true;
  const errors = [];
  const { house, clock } = setup({
    settle: async () => {
      if (fail) throw new Error('db down');
    },
    onError: (err, ctx) => errors.push(ctx.step),
  });
  const l = await house.list({ sellerId: 's', item, startPrice: 10, duration: 60_000 });
  await house.bid({ listingId: l.id, bidderId: 'x', amount: 10 });
  clock.t += 60_000;
  assert.deepEqual(await house.settleDue(), []);
  assert.deepEqual(errors, ['settle']);
  assert.equal((await house.get(l.id)).settled, false);
  fail = false;
  const done = await house.settleDue();
  assert.equal(done.length, 1);
  assert.equal((await house.get(l.id)).settled, true);
});

test('concurrent bids are serialized: exactly one wins each price', async () => {
  const { house } = setup();
  const l = await house.list({ sellerId: 's', item, startPrice: 100 });
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((id) => house.bid({ listingId: l.id, bidderId: id, amount: 100 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'too_low'));
});

test('a compare-and-set conflict releases the reserve and retries', async () => {
  const store = new MemoryStore();
  const put = store.put.bind(store);
  let conflicts = 1;
  store.put = async (listing, v) => {
    if (listing.bids > 0 && conflicts-- > 0) return false;
    return put(listing, v);
  };
  const { house, calls } = setup({ store });
  const l = await house.list({ sellerId: 's', item, startPrice: 10 });
  const b = await house.bid({ listingId: l.id, bidderId: 'a', amount: 10 });
  assert.equal(b.price, 10);
  assert.deepEqual(calls, [
    ['reserve', 'a', 10],
    ['release', 'a', 10, 'conflict'],
    ['reserve', 'a', 10],
  ]);
});

test('a failed publish does not fail the bid', async () => {
  const errors = [];
  const { house } = setup({
    pusher: {
      trigger: async () => {
        throw new Error('network');
      },
    },
    onError: (err, ctx) => errors.push(ctx.step),
  });
  const l = await house.list({ sellerId: 's', item, startPrice: 10 });
  assert.equal(l.status, 'open');
  assert.deepEqual(errors, ['publish']);
});

test('snapshot lists open listings ending soonest first, closed ones and prices', async () => {
  const { house, clock } = setup();
  const late = await house.list({ sellerId: 's', item, startPrice: 10, duration: 120_000 });
  const soon = await house.list({ sellerId: 's', item, startPrice: 10, duration: 60_000, buyout: 30 });
  await house.buyout({ listingId: soon.id, buyerId: 'b' });
  const s = await house.snapshot();
  assert.equal(s.serverNow, clock.t);
  assert.deepEqual(s.listings.map((l) => l.id), [late.id]);
  assert.deepEqual(s.closed.map((l) => l.id), [soon.id]);
  assert.equal(s.closed[0].settled, undefined);
  assert.deepEqual(s.prices.sword.map((p) => p.price), [30]);
});

test('MemoryStore drops settled listings after keepClosed', async () => {
  const clock = { t: 0 };
  const store = new MemoryStore({ keepClosed: 1000, now: () => clock.t });
  const { house } = setup({ store, now: () => clock.t });
  const l = await house.list({ sellerId: 's', item, startPrice: 10, buyout: 10 });
  await house.buyout({ listingId: l.id, buyerId: 'b' });
  assert.equal((await store.all('main')).length, 1);
  clock.t += 1001;
  assert.equal((await store.all('main')).length, 0);
});

test('unknown listings are not_found', async () => {
  const { house } = setup();
  await assert.rejects(house.bid({ listingId: 'nope', bidderId: 'a', amount: 1 }), (e) => e.code === 'not_found' && e.status === 404);
});

test('defaultIncrement is 5%, at least 1', () => {
  assert.equal(defaultIncrement(10), 1);
  assert.equal(defaultIncrement(100), 5);
  assert.equal(defaultIncrement(1001), 51);
});

test('house names are checked and set the channel', () => {
  assert.throws(() => createAuctionHouse({ pusher: { trigger() {} }, name: 'a b' }));
  assert.equal(createAuctionHouse({ pusher: { trigger() {} }, name: 'eu' }).channel, 'auction-eu');
  assert.equal(createAuctionHouse({ pusher: { trigger() {} }, channel: 'private-auction-x' }).channel, 'private-auction-x');
});
