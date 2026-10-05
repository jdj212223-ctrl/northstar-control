# Northstar Control

Northstar Control is an open-source desktop app for monitoring a computer and
using hardware and power controls exposed by its operating system.

## Web dashboard

The account and computer dashboard is hosted on GitHub Pages:
<https://jdj212223-ctrl.github.io/northstar-control/>.
The source is in [`docs/`](./docs/), and the Pages workflow deploys it after
changes to that folder reach `main`.

The site communicates with the separately hosted Northstar remote service
documented below. Set its HTTPS URL in the website's Account & settings. Without
that service configured and running, account sign-in and device management
remain unavailable.

## What it supports

- macOS, Windows, and Linux host monitoring for available CPU, memory, battery,
  thermal, fan-sensor, and connected-device information.
- Windows power plans, Linux `power-profiles-daemon` profiles, and a Linux
  battery charge threshold when the device exposes a writable sysfs control.
- GitHub account sign-in through OAuth Device Flow. GitHub identity is separate
  from permission to control the local computer.

Controls and readings the host cannot provide are shown as unavailable; the app
does not simulate sensor values or silently elevate privileges. Fan-speed
changes, USB power switching, and overclocking are not enabled because they
require hardware-specific drivers and safety limits. GPU load and battery
health are unavailable until reliable platform APIs are supported.

On macOS, fan and battery control would require a separately signed and
notarized privileged helper installed through Apple's authorization flow. No
helper or signing identity is included, so the app does not present a fake
permission prompt. macOS power modes remain managed by macOS.

## Run locally

Install Node.js 22.13 or later, then run:

```sh
npm install
npm start
```

Run the automated tests and syntax checks:

```sh
npm test
npm run check
```

Build a platform package on the corresponding build host:

```sh
npm run package:mac
npm run package:windows
npm run package:linux
```

Linux battery thresholds require the current user to already have permission to
write the kernel-exposed threshold. Linux temperature and fan-speed readings
come from exposed kernel sensors. Windows power profiles depend on the plan
being installed. macOS packages are unsigned unless a valid Developer ID and
notarization credentials are configured; Windows distribution also needs a
publisher signing certificate.

## GitHub sign-in setup

1. In GitHub Developer Settings, create an OAuth App and set its **Homepage
   URL** to `https://jdj212223-ctrl.github.io/northstar-control/`.
2. Enable **Device Flow**. The required Authorization callback URL is not used
   by Northstar's Device Flow sign-in.
3. Copy the public Client ID into Northstar Control's desktop Settings and set
   it as `GITHUB_CLIENT_ID` on the remote service. Web sign-in is requested by
   the backend; the website never receives a GitHub access token.
4. Sign in and authorize the one-time code at
   `https://github.com/login/device`.

Northstar Control requests only the `read:user` permission. The Client ID is
public configuration; do not put a client secret in the desktop app or
website. The desktop app stores its identity token with Electron's OS-backed
secure storage and removes it when you sign out. If token expiration is enabled
in the OAuth App, desktop sign-in may need to be repeated when a token expires.
The remote website service uses GitHub's token only to fetch the profile, then
discards it. On Linux, sign-in is disabled unless Electron can use a Secret
Service or KWallet backend; the weaker `basic_text` fallback is rejected.

GitHub confirms which account is signed in. It does not authorize Northstar
Control to administer your computer or bypass macOS, Windows, or Linux
permissions. Hardware access still requires separate local OS authorization.

## Remote service

GitHub Pages serves static files and cannot run a private API or device relay.
Northstar's backend runs as a separate Node.js service. Use Node.js 22.13 or
later; `node:sqlite` stores device records and `ws` maintains outbound device
connections.

1. Enable **Device Flow** in the GitHub OAuth App used for Northstar. Device
   Flow does not use a client secret or an authorization callback.
2. Start the service with the public OAuth App Client ID and the exact website
   origin allowed to make API requests:

   ```sh
   GITHUB_CLIENT_ID=your_public_client_id \
   NORTHSTAR_ALLOWED_ORIGINS=https://jdj212223-ctrl.github.io \
   NORTHSTAR_DB_PATH=./server-data/northstar.sqlite \
   npm run serve
   ```

   The service listens on port `8787` by default; set `PORT` if the host
   requires a different port. Keep the SQLite directory on persistent storage
   and out of source control.
3. Put the service behind HTTPS and a TLS-terminating reverse proxy before
   exposing it publicly. Configure the website's **Remote service** URL to the
   HTTPS service origin. The static site stores that URL only in browser
   preferences. If the proxy forwards `X-Forwarded-For`, set
   `NORTHSTAR_TRUST_PROXY=1` only when the backend can be reached exclusively
   through that trusted proxy.
4. Sign in on the site, generate a one-time pairing code, then enter the
   service URL and code in Northstar Control's Settings on the target computer.
   The pairing code expires after five minutes and is single-use.

The server holds only an in-memory website session and GitHub identity; GitHub
access tokens are used to read the profile and then discarded. Website sessions
expire on service restart. Device tokens are stored encrypted with the desktop
OS secure-storage API. The service stores token hashes, device status, and the
latest telemetry in SQLite. Restrict `NORTHSTAR_ALLOWED_ORIGINS` to your actual
website origin; never use `*` with credentialed sessions.

Run one service instance for now: website sessions, pairing codes, and live
WebSocket connections are held in process memory. The reverse proxy must pass
WebSocket upgrade requests through to that instance.

Device connections are outbound WebSockets from each desktop app to the
service; no inbound port on the computer is opened. The website can request
only OS power profiles and a charge threshold when the device reports support.
Every request prompts for approval on the computer. Fan-speed changes, USB
power switching, and overclocking remain unavailable. Removing a computer from
the website revokes its device token and clears the paired token from the app
the next time it connects.

The backend does not make an untrusted network safe by itself. Keep it patched,
use HTTPS, back up the database securely, and do not expose the local desktop
control service directly to the public internet. Hosting and operating a public
service remains the operator's responsibility.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for project guidelines. This project is
licensed under the [MIT License](./LICENSE).
