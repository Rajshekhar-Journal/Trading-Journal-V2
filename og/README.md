# Order Gateway — Phase 1 (broker link, read only)

The Order Gateway is the only part of the Auto Trade Engine that talks to Zerodha. It runs on the
always-on machine at home. In Phase 1 it can **log in and read**; it has no code that places,
modifies or cancels an order or a GTT.

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
