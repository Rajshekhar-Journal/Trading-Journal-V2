# Order Gateway — broker link and stop-GTT placement

The Order Gateway is the only part of the Auto Trade Engine that talks to Zerodha. It runs on the
always-on machine at home. It can **log in and read**, and — only when you switch it on — **place or
modify a stop-loss GTT** that you approved in the journal. It has no code that places a buy or sell
order, cancels an order or deletes a GTT.

What it does now:

- Keeps the Kite API key and secret, encrypted, on this machine only.
- Does the daily Kite login (redirect, or paste the returned address).
- Every minute reads orders, holdings, positions, funds and GTTs and stores them in the journal database.
- Compares the journal's open positions with the broker and records the differences (reconcile report).
- Writes a heartbeat so the journal can show Online / Offline, login status and whether the static IP matches.

Nothing is hardcoded. Static IP, API details, client ID and the journal link are all entered on the
gateway page and can be changed later without touching code.

## First-time setup

1. In Supabase → SQL Editor, run `supabase/migrations/009_order_execution.sql`.
2. On the home machine, in the project folder: `npm run og`
3. Open `http://127.0.0.1:8787` **on that machine** and choose the gateway password (12+ characters).
4. Sign in, then fill in:
   - **Kite Connect API details** — API key, API secret, your Zerodha client ID.
   - **Journal account** — Supabase URL and anon key (both are in `js/config.js`), journal email and password.
     The password is used once to link the account and is not stored.
   - **Network** — leave *Static IP* blank until you have one. Order sending stays off while it is blank.
5. In the Kite developer console, set the app's redirect URL to the one shown on the gateway page
   (`http://<address>:8787/kite/callback`).
6. Click **Log in to Kite**. After login the status tiles turn green and the first sync runs.
7. In the journal: Settings → **Auto Trade – Broker Link** shows the same status and the reconcile report.

## Every trading day

Open the gateway page and click **Log in to Kite** (the token lapses at 06:00 IST). Until you do,
the journal shows "Login required" and nothing is read from the broker.

## Remote login (optional)

By default the page listens on `127.0.0.1` only. To log in from another device:

1. Put the home machine and your phone/laptop on one private VPN (Tailscale or WireGuard).
2. Gateway page → Network → add the machine's VPN (or home-network) address to *Addresses this page
   listens on*, and its VPN name to *Extra host names*. Restart the gateway.
3. Do **not** forward this port on your router and do not use `0.0.0.0` (the page refuses it).

The page uses plain HTTP. On the VPN the traffic is already encrypted; on a shared home network
prefer the VPN address.

## Stop-GTT placement (Phase 3, Confirm mode)

The lifecycle engine decides the stop; the gateway only carries it out.

1. Run `supabase/migrations/011_stop_gtt_confirm.sql`.
2. Enter the static IP on the gateway page (Network). Placement cannot be switched on until it matches.
3. Gateway page → **Stop-GTT placement** → tick *Allow stop-GTT placement*.
4. Journal → Settings → Auto Trade – Broker Link → Mode → **Confirm**.
5. A stop GTT is proposed when the engine raises a stop alert, or when you press *Propose stop GTT*
   on a position that is not PROTECTED. It appears under **Waiting for your approval**.
6. **Approve** → within about 10 seconds the gateway re-reads the journal and the broker, re-checks
   quantity, stop level and price, then places a new GTT or modifies the existing one, and verifies
   it in the broker's GTT list. The result (done / failed with the reason) shows in the same page.

What the gateway refuses at the moment of sending: a quantity different from the journal position,
more shares than the broker holds, a stop that is not a stop level of that position, a stop at or
above the current price, more than one sell GTT on the stock, lowering an existing stop, an approval
older than 5 minutes. After a timeout it does not send again; it checks the broker's GTT list first.

Switching placement off, a blank or changed static IP, or a missing Kite login stops all sending at once.

## Exits (Phase 4a, Confirm mode)

Optional and separate from stop-GTT placement. The engine decides the exit; you approve it; the gateway sells.

1. Gateway page → **Sending to Zerodha** → tick *Allow exits (market sell)*.
2. Journal → Settings → Auto Trade – Broker Link → tick *Also ask me to approve partial and full exits* (mode Confirm).
3. When the engine raises a partial or full exit, it appears under **Waiting for your approval**, in red.
4. **Approve** → the gateway re-checks the position, then:
   - partial exit: lowers the stop GTT to the remaining quantity first, then sends one market sell;
   - full exit: sends one market sell, and deletes the stop GTT once the sell is completely filled.
5. The sell uses Zerodha's automatic market protection. If it is not filled within 20 seconds the gateway
   cancels it, waits for the broker to confirm the cancel, and reports *failed* with what was filled.
   It does not try again by itself — the next alert produces a new proposal.

It refuses to sell when: the journal position changed, the broker holds fewer shares than the order,
another sell order is already live on the stock (including one created by a triggered GTT), more than
one sell GTT exists, or it is outside 09:16–15:25 IST. It never sells more than the intent quantity,
so shares you hold outside the journal are not touched.

## Journal booking (Phase 4b)

Run `supabase/migrations/012_fill_booking_emergency.sql`. After that, every sell the gateway completes
is written into the existing trade record within seconds: a partial exit, or the final exit when the
whole open quantity was sold, with the real fill price, charges from your Settings, Action Source
"… (Auto)" and the Zerodha order id. It is written once, in one database transaction.

It is **not** booked (and the page says why) when the journal trade is already closed, when the fill is
larger than the journal shows open, or when no journal trade is linked. Fills of the stop GTT itself are
not booked yet — record those by hand; the reconcile report shows them until you do.

## Emergency Exit (Phase 4c)

Gateway page → **Sending to Zerodha** → *Emergency Exit*: Off / Confirm / Auto. It needs exits switched on.

It watches every open journal position the broker still holds, every 10 seconds, for three cases:

| Case | Meaning |
|---|---|
| GTT order unfilled | the stop GTT triggered, but its sell order is still open after 10 s (gap below the limit) |
| GTT order rejected | the stop GTT triggered, but its sell order was rejected or cancelled unfilled |
| GTT not triggered | the price is below the stop, yet the GTT is still active after 60 s |

For each case it raises an alert on the Alert Dashboard and an **EMERGENCY EXIT** entry under
*Waiting for your approval*. In **Auto** the first two run at once; "GTT not triggered" always waits for you.

When it runs: (not-triggered case: delete the GTT and confirm) → cancel every open sell on the stock and
wait for Zerodha to confirm → read the quantity actually held → market sell with automatic protection →
if not filled in 20 s: cancel, confirm, sell again with 5%, then 10%. It never has two sells open, never
sells more than is held, and after the last step it reports how many shares are still held.
If a cancel is not confirmed it stops and sends nothing more.

The alert is also sent to Telegram by the backend runner, normally within a minute (market hours).

## Where things are kept

| File (in `og/data/`, ignored by git) | Content |
|---|---|
| `secrets.enc` | API key, API secret, day's access token, journal refresh token, password hash — AES-256-GCM |
| `master.key` | Random key that opens `secrets.enc`. Anyone with both files can read the secrets: keep this machine's disk and backups private. |
| `config.json` | Non-secret settings (port, addresses, expected static IP, client ID, URLs) |

The journal database receives status only: no key, no token and not the IP address itself.

To move the gateway to another machine, enter the details again there rather than copying `og/data`.
To reset a forgotten gateway password, stop the gateway and delete `og/data/secrets.enc` (you will
re-enter the API details).

## Safety properties (covered by `tests/og-gateway.test.js`)

- The Kite adapter exposes read methods only; after login every call to Kite is a GET.
- A Kite login for any account other than the configured client ID is refused.
- Pages need the gateway password; 5 wrong attempts lock sign-in for 15 minutes.
- First-time password setup works only from the gateway machine itself.
- Forms carry a CSRF token; requests with an unknown Host header are refused.
- No secret appears in any page, in `/status.json`, in the database or in `config.json`.
