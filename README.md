# @hibira-io/auction

[![npm](https://img.shields.io/npm/v/@hibira-io/auction)](https://www.npmjs.com/package/@hibira-io/auction)
[![ci](https://github.com/hibira-io/auction-js/actions/workflows/ci.yml/badge.svg)](https://github.com/hibira-io/auction-js/actions/workflows/ci.yml)

A realtime auction house for games on [Hibira](https://hibira.io), for
[pusher-js](https://github.com/pusher/pusher-js) and Laravel Echo: listings
that appear and disappear in every open client, live bids, countdowns that
agree with the server's clock, a last-seconds extension against sniping,
buyout, and the price history of each item type.

Your server is the authority. Players send bids to your own endpoint; the
server helper checks them, saves the new state and publishes it once on the
house channel, and every client updates. Your game keeps owning the items and
the coins: the house calls you back to hold a bidder's coins, give them back
when someone outbids them, and move the item and the coins when an auction
closes. Nothing is decided in the browser or the game client.

Good fits: auction houses, trading posts and player markets in MMOs, idle and
survival games, collectible card games, and live auctions in any app where
the "coins" are your own. It is not a payment system: it moves no real money.

[中文摘要](#中文摘要)

## Install

```sh
npm install @hibira-io/auction pusher-js   # browser
npm install @hibira-io/auction pusher      # server
```

## Server

```js
import Pusher from 'pusher';
import { createAuctionHouse, AuctionError } from '@hibira-io/auction/server';

const pusher = new Pusher({
  appId: process.env.HIBIRA_APP_ID,
  key: process.env.HIBIRA_APP_KEY,
  secret: process.env.HIBIRA_APP_SECRET,
  host: 'ws.hibira.io',
  useTLS: true,
});

const house = createAuctionHouse({
  pusher,
  name: 'main', // publishes on "auction-main"

  // Hold the bidder's coins. Throw to refuse the bid.
  reserve: async ({ userId, amount }) => {
    if (!(await wallet.hold(userId, amount))) throw new Error('not enough gold');
  },
  // Give coins back: the bidder was outbid, or a save conflict needs a retry.
  release: async ({ userId, amount }) => wallet.unhold(userId, amount),
  // Move the item and the coins. Called once per closed listing until it
  // succeeds, so make it idempotent by listing.id.
  settle: async ({ listing }) => {
    if (listing.status === 'sold') {
      await game.transfer({ listingId: listing.id, item: listing.item, from: listing.sellerId, to: listing.bidderId, price: listing.price });
    } else {
      await game.returnItem(listing.sellerId, listing.item); // unsold or cancelled
    }
  },
});

house.start(); // closes and settles ended auctions once a second
```

Then four endpoints in your backend, each taking the player from your own
session, never from the request body:

```js
app.get('/auction', async (req, res) => res.json(await house.snapshot()));

app.post('/auction/list', handle((req) =>
  house.list({ sellerId: req.user.id, seller: { name: req.user.name }, item: takeItem(req), startPrice: req.body.startPrice, buyout: req.body.buyout, duration: 3600_000 })));

app.post('/auction/:id/bid', handle((req) =>
  house.bid({ listingId: req.params.id, bidderId: req.user.id, bidder: { name: req.user.name }, amount: req.body.amount })));

app.post('/auction/:id/buyout', handle((req) => house.buyout({ listingId: req.params.id, buyerId: req.user.id, buyer: { name: req.user.name } })));

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      if (err instanceof AuctionError) res.status(err.status).json({ error: err.code, message: err.message });
      else throw err;
    }
  };
}
```

`takeItem()` stands for your own code that removes the item from the seller's
inventory and returns what to show, e.g. `{ type: 'sword-of-dawn', name: 'Sword of Dawn', icon: '…' }`.
`item.type` groups sale prices for the price history.

### Rules

| Option | Default | |
|---|---|---|
| `increment(price)` | 5%, at least 1 | the smallest raise over the current bid; the listing's `minBid` is the next lowest bid |
| `duration` | 1 hour | default length; `minDuration` 10 s, `maxDuration` 7 days |
| `extendWithin` / `extendBy` | 30 s / 30 s | a bid in the last 30 s moves the end to at least 30 s from now |
| `maxEndsAfter` | 1 hour | extensions never go past the original end plus this |
| `history` | 20 | sale prices kept per item type |
| `maxItemBytes` | 2000 | JSON size of `item` plus `seller` |

Amounts are whole numbers (coins, gems). Sellers cannot bid on their own
listings, the high bidder cannot raise their own bid, and a listing with bids
cannot be cancelled. A bid at or above the buyout price buys the item at the
buyout price.

`AuctionError.code` is one of `not_found`, `closed`, `too_low`,
`own_listing`, `no_buyout`, `has_bids`, `forbidden`, `invalid`, `busy`
or `refused` (your `reserve` threw), and `status` is an HTTP status to answer
with.

### Several servers

`MemoryStore` keeps listings in the process, which is right for one server.
With several, pass a `store` with the same five methods on your database
(see `AuctionStore` in `server.d.ts`): `put(listing, expectedVersion)` must
save only when the stored version still equals `expectedVersion`, e.g.
`UPDATE … WHERE id = ? AND version = ?`. The house retries on a conflict and
releases the reserve it made for the losing attempt. Run `start()` (or call
`settleDue()` from a cron job) on as many servers as you like: closing and
settling go through the same compare-and-set.

## Client

```js
import Pusher from 'pusher-js';
import { AuctionHouse } from '@hibira-io/auction';

const pusher = new Pusher(APP_KEY, { cluster: 'hkg', wsHost: 'ws.hibira.io', forceTLS: true, enabledTransports: ['ws', 'wss'] });

const house = AuctionHouse.open(pusher, 'main', {
  load: () => fetch('/auction').then((r) => r.json()),
});

house.on('change', ({ listings, closed }) => render(listings, closed));
house.on('update', ({ kind, listing }) => {
  if (kind === 'bid' && listing.bidderId !== me && wasMine(listing)) toast('You were outbid');
});

// Countdowns follow the server's clock, not the player's.
setInterval(() => {
  for (const l of house.listings) showTimeLeft(l.id, house.timeLeft(l));
}, 250);

// Bids go to your server, which checks them.
async function bid(listing) {
  const res = await fetch(`/auction/${listing.id}/bid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: listing.minBid }) });
  if (!res.ok) showError((await res.json()).message);
}
```

`house.listings` are the open listings ending soonest first, `house.closed`
the recent sales and closed listings, `house.get(id)` one listing and
`house.prices(type)` the recent sale prices of an item type, for a price
chart. On every subscription, including after a reconnect, the house calls
`load()` again, so nothing changed while offline is missed.

With Laravel Echo: `new AuctionHouse(Echo.channel('auction-main').subscription, { load })`.

For a private house (members only), name the channel `private-auction-<name>`
on both sides (`channel` option) and authorize it in your auth endpoint.

## Events on the wire

One event, `auction-update`, on `auction-<name>`, published by the server:

```json
{ "kind": "bid", "serverNow": 1762934400000, "listing": { "id": "…", "version": 3, "status": "open", "price": 120, "minBid": 126, "bidderId": "u42", "endsAt": 1762938000000, "…": "…" } }
```

`kind` is `listed`, `bid`, `extended`, `sold`, `unsold` or `cancelled`.
Each listing carries a `version`; keep the copy with the highest one. Any
Pusher client can follow the house this way, including the Android, iOS and
Unity SDKs.

## Limits and billing

Each change publishes one message on the house channel, however many players
watch it; deliveries count towards the plan's monthly deliveries
([pricing](https://hibira.io/pricing)). A listing is a few hundred bytes, well
under the event size limit. For thousands of listings, split the house by
category or server region (`name: 'weapons'`, `name: 'eu'`) so each client
loads and follows only the part it shows.

## 中文摘要

`@hibira-io/auction` 是建立在 Hibira 即時通道上的遊戲拍賣場套件。上架、出價、成交、倒數計時會即時同步到所有玩家，最後幾秒出價會自動延長，支援一口價和各道具的成交價走勢。

判斷誰得標的規則全部在你的伺服器上執行（`@hibira-io/auction/server`）：玩家把出價送到你自己的 API，伺服器驗證後儲存並在頻道上發布一次，所有客戶端一起更新。道具和遊戲幣仍然由你的遊戲管理：套件透過 `reserve`（凍結出價者的幣）、`release`（被超過時退回）、`settle`（結標後轉移道具和幣）三個回呼通知你。套件不處理真錢交易。

單台伺服器用內建的 `MemoryStore`；多台伺服器時把 `store` 換成你的資料庫，`put()` 需要以 `version` 做比較後寫入。

## Development

```sh
npm test         # unit tests
npm run test:e2e # against a running server, see test/e2e/
```

## License

MIT
