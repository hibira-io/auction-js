// End to end against a running Hibira (or any Pusher-compatible) server:
// the server helper publishes, real pusher-js clients follow along.
// Skipped unless AUCTION_E2E_KEY is set, e.g. against pusher-server's
// `make run`:
//
//   AUCTION_E2E_APP_ID=local-app AUCTION_E2E_KEY=local-key \
//   AUCTION_E2E_SECRET=local-secret-0123456789 npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import PusherClient from 'pusher-js';
import PusherServer from 'pusher';
import { AuctionHouse } from '../../index.js';
import { createAuctionHouse } from '../../server.js';

const env = process.env;
const skip = !env.AUCTION_E2E_KEY && 'set AUCTION_E2E_KEY to run';
const host = env.AUCTION_E2E_HOST ?? '127.0.0.1';
const port = Number(env.AUCTION_E2E_PORT ?? 8080);
const tls = env.AUCTION_E2E_TLS === '1';

function client() {
  return new PusherClient(env.AUCTION_E2E_KEY, {
    cluster: 'mt1',
    wsHost: host,
    wsPort: port,
    wssPort: port,
    forceTLS: tls,
    enabledTransports: ['ws'],
  });
}

function waitFor(house, pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    if (pred(house)) return resolve();
    const timer = setTimeout(() => reject(new Error('timed out ' + pred.toString())), ms);
    const off = house.on('change', () => {
      if (pred(house)) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

test('two players watch a bid war and the sale', { skip, timeout: 30_000 }, async () => {
  const pusher = new PusherServer({ appId: env.AUCTION_E2E_APP_ID, key: env.AUCTION_E2E_KEY, secret: env.AUCTION_E2E_SECRET, host, port: String(port), useTLS: tls });
  const name = `e2e${Date.now().toString(36)}`;
  const gold = { ann: 100, bo: 100, sam: 0 };
  const server = createAuctionHouse({
    pusher,
    name,
    minDuration: 1000,
    extendWithin: 500,
    extendBy: 500,
    reserve: async ({ userId, amount }) => {
      if (gold[userId] < amount) throw new Error('not enough gold');
      gold[userId] -= amount;
    },
    release: async ({ userId, amount }) => {
      gold[userId] += amount;
    },
    settle: async ({ listing }) => {
      if (listing.status === 'sold') gold[listing.sellerId] += listing.price;
    },
  });

  const a = client();
  const b = client();
  const load = () => server.snapshot();
  const ha = AuctionHouse.open(a, name, { load });
  const hb = AuctionHouse.open(b, name, { load });
  try {
    await Promise.all([waitFor(ha, (h) => h.ready), waitFor(hb, (h) => h.ready)]);

    const l = await server.list({ sellerId: 'sam', item: { type: 'sword', name: 'Sword' }, startPrice: 10, duration: 1500 });
    await waitFor(hb, (h) => h.get(l.id));

    await server.bid({ listingId: l.id, bidderId: 'ann', amount: 10 });
    await server.bid({ listingId: l.id, bidderId: 'bo', amount: 20 });
    await assert.rejects(server.bid({ listingId: l.id, bidderId: 'ann', amount: 500 }), /not enough gold/);
    await waitFor(ha, (h) => h.get(l.id)?.price === 20);
    assert.equal(ha.get(l.id).bidderId, 'bo');
    assert.deepEqual(gold, { ann: 100, bo: 80, sam: 0 });

    await new Promise((r) => setTimeout(r, 1600));
    await server.settleDue();
    await Promise.all([waitFor(ha, (h) => h.get(l.id)?.status === 'sold'), waitFor(hb, (h) => h.closed.some((c) => c.id === l.id))]);
    assert.deepEqual(gold, { ann: 100, bo: 80, sam: 20 });
    assert.deepEqual(hb.prices('sword').map((p) => p.price), [20]);
  } finally {
    ha.close();
    hb.close();
    a.disconnect();
    b.disconnect();
  }
});
