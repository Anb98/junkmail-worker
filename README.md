# junkmail-worker

Disposable inboxes on your own domain, in the spirit of Yopmail: mail sent to
`anything@yourdomain.dev` lands in a [Mailpit](https://mailpit.axllent.org/)
instance on your home network.

```
Sender ──► Cloudflare Email Routing (catch-all) ──► Email Worker
                                                        │ SMTP over Workers VPC
                                                        ▼
               Mailpit ◄── TCP ── cloudflared ◄── Cloudflare Tunnel
               (home network)
```

The Worker does not change the message. It opens a TCP connection to Mailpit
through your Cloudflare Tunnel (Workers VPC) and delivers the raw message as a
minimal SMTP client (`EHLO`, `MAIL FROM`, `RCPT TO`, `DATA`), normalizing line
endings to CRLF and dot-stuffing lines that start with `.`. The tunnel is opened
from your home, so no router port needs to be opened.

## Prerequisites

- A Cloudflare account (the Free plan is enough).
- A domain whose DNS is managed by Cloudflare.
- Email Routing enabled on that domain.
- `cloudflared` running in your home network as a Cloudflare Tunnel, version
  2025.7.0 or later, using the QUIC protocol (`auto` or `quic`), with outbound
  UDP 7844 allowed.
- Mailpit running in your home network, with its SMTP port (default `1025`)
  reachable from the machine running `cloudflared`. For example:

  ```sh
  docker run -d --name mailpit --restart unless-stopped \
    -p 1025:1025 -p 8025:8025 axllent/mailpit
  ```

- Node.js 20 or later.

## Values to replace

| File | Value | Replace with |
| --- | --- | --- |
| `wrangler.toml` | `YOUR-TUNNEL-ID` | The ID of your Cloudflare Tunnel (Zero Trust → Networks → Tunnels). |
| `wrangler.toml` | `MAILPIT-HOST:1025` | Mailpit's SMTP address as seen from the `cloudflared` machine, e.g. `192.168.1.10:1025`. |
| `.env` | `YOUR-API-TOKEN` | A Cloudflare API token (see below). Copy `.env.example` to `.env`; `.env` is gitignored, never commit it. |

Optional: change `name = "junkmail"` in `wrangler.toml` to rename the Worker.

### MAILPIT_ADDR

`MAILPIT_ADDR` is a plain Worker variable defined under `[vars]` in
`wrangler.toml`. Wrangler uploads it with the Worker, and the code reads it as
`env.MAILPIT_ADDR` when a message arrives:

```js
const socket = await env.HOME.connect(env.MAILPIT_ADDR);
```

`env.HOME` is the Workers VPC binding (the `[[vpc_networks]]` block), so the
connection does not go to the internet: Cloudflare sends it through your tunnel
and `cloudflared` opens it from inside your home network. That is why the
address must be the one **`cloudflared` uses to reach Mailpit**, not a public
address. Pick the case that matches your setup:

| Setup | `MAILPIT_ADDR` |
| --- | --- |
| Mailpit on another machine in your LAN | That machine's LAN IP, e.g. `192.168.1.10:1025` |
| Mailpit and `cloudflared` on the same host, `cloudflared` not in Docker | `127.0.0.1:1025` |
| Both in Docker on the same Docker network | The Mailpit service/container name, e.g. `mailpit:1025` (*) |

(*) Cloudflare documents that `connect()` accepts "any hostname or IP address
reachable through the bound Cloudflare Tunnel", but this project was only
tested with a LAN IP. If a hostname does not work, use an IP address.

To check it, run from the `cloudflared` machine (or container)
`nc <host> 1025`: you should see a `220` greeting from Mailpit.

### API token

Create a token from the **Edit Cloudflare Workers** template and add the
account permission **Connectivity Directory: Admin**. Without it, binding the
tunnel fails with error `10196`.

## Setup

```sh
git clone <this-repo> junkmail-worker
cd junkmail-worker
npm install
cp .env.example .env        # then put your real token in .env
# edit wrangler.toml: tunnel_id and MAILPIT_ADDR
npm test
npm run deploy
```

Finally, in the Cloudflare dashboard go to your domain → **Email** →
**Email Routing** → **Routing rules**, set the **Catch-all address** action to
**Send to a Worker**, pick `junkmail`, and enable it. The catch-all only covers
the apex domain (`*@yourdomain.dev`), not subdomains.

Send a message from any external account to `anything@yourdomain.dev` and open
the Mailpit UI (`http://<mailpit-host>:8025`).

## Tests

`npm test` runs the encoder and SMTP error-handling tests. The end-to-end test
needs a local Mailpit on `127.0.0.1` (SMTP `1025`, API `8025`) and is skipped
when it is not reachable.

## Limitations

- If your home network or the tunnel is down, the message is lost: there is no
  queue or fallback. Fine for junk mail, not for real mail.
- SMTP between the Worker and Mailpit is plaintext; it only travels inside the
  tunnel.
- Workers VPC is in beta; its API and pricing may change.
- Mailpit's UI has no authentication by default. Keep it on your local network
  or put it behind authentication.
