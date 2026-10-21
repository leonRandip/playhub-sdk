# Deploying

Any Linux server with Docker and a domain name works. A 1 GB VM is plenty for signaling: the hub
holds about 0.1 MB per connected player (measure your own with `pnpm hub-load`).

Two setups. They differ only in `.env`; the images and the compose file are the same.

|                 | **A. Signaling only + hosted relay**             | **B. Signaling + your own coturn**    |
| --------------- | ------------------------------------------------ | ------------------------------------- |
| Containers      | Caddy + hub                                      | Caddy + hub + coturn                  |
| `TURN_PROVIDER` | `cloudflare` (or `static`, or `none`)            | `coturn`                              |
| Open ports      | 80, 443 (and SSH for you)                        | + 3478 tcp/udp, 5349, UDP 49160-49200 |
| DNS A records   | `play.<domain>`                                  | `play.<domain>` and `turn.<domain>`   |
| Relay bandwidth | the provider's (Cloudflare: 1 000 GB/month free) | your server's egress                  |

Only the 10–20 % of player pairs that cannot connect directly use the relay. Moving from A to B is
an `.env` change: players pick up the new relay on their next connect, because the hub sends the ICE
servers in every welcome.

## Steps

1. **DNS:** an A record for `play.<domain>` → the server's public IP. If your DNS is on Cloudflare,
   use **DNS only** (grey cloud); the hub is not meant to sit behind their proxy.
2. **Firewall:** allow 80 and 443 (plus the TURN ports for setup B), and SSH from your own address.
3. **Stack:** copy this repo (or just `deploy/` and the source) to the server, then in `deploy/`:
   ```
   cp .env.example .env              # HUB_DOMAIN, TURN_PROVIDER and its settings
   cp games.example.json games.json  # your games and their allowed origins
   docker compose up -d --build      # setup B: docker compose --profile coturn up -d --build
   ```
   To run a prebuilt image instead of building on the server, set `HUB_IMAGE` in `.env`.
4. **Check:** `curl https://play.<domain>/healthz` → `{"ok":true,…}`; `docker compose ps` shows
   everything healthy; `docker compose logs hub` ends with `playhub hub up: … turn=<provider>`.

## Cloudflare relay (setup A)

Cloudflare dashboard → **Realtime → TURN → Create key**. It shows a **key id** and an **API token**
(once). Put them in `.env` as `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` and restart
the hub. The hub asks Cloudflare for credentials, caches one set and refreshes it at half its
lifetime (about two API calls a day), and falls back to STUN only if the API is unreachable, so a
Cloudflare outage never blocks joining a room.

## Your own coturn (setup B)

Set `TURN_PROVIDER=coturn`, `TURN_HOST=turn.<domain>`, `TURN_SECRET` (`openssl rand -hex 32`),
`EXTERNAL_IP` and `PRIVATE_IP`, then `docker compose --profile coturn up -d`. The hub signs
short-lived credentials with the shared secret; `turnserver.conf` refuses to relay into private
address ranges and caps per-user quotas.

## Verify the relay

From two devices on different networks (one on cellular) play a match. To force the relay in a
browser console: `new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })` should still
connect. For coturn, `docker compose logs coturn` shows the allocation; for Cloudflare, usage shows
in the dashboard under Realtime.

## Security posture

| Concern                   | What is in place                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exposure**              | The hub publishes no port; only Caddy, on the internal Docker network, reaches it. Setup A has no UDP listener at all. `/healthz` tells the public only `{"ok":true}`.                                                                                      |
| **Containers**            | Hub: distroless base (no shell or package manager), one bundled JS file, non-root (uid 65532), read-only filesystem, no Linux capabilities, `no-new-privileges`, PID and memory limits. Caddy: only the capability to bind 80/443. Images pinned by digest. |
| **Known vulnerabilities** | CI runs `pnpm audit` and Trivy on the image and on the Dockerfile/config on every push and weekly. Accepted findings live in `.trivyignore`, each with a reason and an expiry date. Dependabot proposes updates weekly.                                     |
| **Secrets**               | The only one is the TURN token or secret in `.env` (keep it mode 600, out of git). A Cloudflare TURN token can only mint relay credentials.                                                                                                                 |
| **Abuse of the lobby**    | Per-address and global connection caps, a per-socket message budget, a hello timeout, per-address room caps, a throttle on wrong room codes, size caps on settings and profiles. See [ARCHITECTURE.md](ARCHITECTURE.md).                                    |

## Keeping it up

- Every container has `restart: unless-stopped`; with Docker enabled at boot, a reboot brings
  everything back. Logs rotate (10 MB × 3 per container).
- Add an external uptime monitor on `https://play.<domain>/healthz`. Matches in progress are
  peer-to-peer and keep running even while the hub restarts.
- Back up `games.json` and `.env` (they are not in git). Edit `games.json` and
  `docker compose restart hub` to add a game or an allowed origin.
