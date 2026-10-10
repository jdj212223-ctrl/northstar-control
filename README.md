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
- An Activity Monitor view that ranks visible applications by OS-reported
  process CPU and memory, with executable names/paths but no command arguments.
  CPU metrics include integrated CPU and SoC CPU work where the OS reports it.
- Windows power plans, Linux `power-profiles-daemon` profiles, and a Linux
  battery charge threshold when the device exposes a writable sysfs control.
- GitHub account sign-in through OAuth Device Flow. GitHub identity is separate
  from permission to control the local computer.

Controls and readings the host cannot provide are shown as unavailable; the app
does not simulate sensor values or silently elevate privileges. On Apple
Silicon, fan profiles can use the optional signed `smctl` helper on supported
models; MacBook charge limits are exposed only when the helper reports charging
control support. Linux charge thresholds are available when writable sysfs
controls exist. Fan controls on Windows and Linux, USB power switching, and
overclocking are not enabled because they require validated hardware-specific
drivers and safety limits. GPU load and battery health are unavailable until
reliable platform APIs are supported.

GPU utilization (including integrated/SoC graphics), per-application power
attribution, and system-wide per-application FPS are not reported unless a
supported driver or platform API exposes them. The Activity Monitor leaves
those readings unavailable rather than estimating them.

On Apple Silicon macOS, optional fan profiles and MacBook charge limits can use
the independently signed and notarized `smctl` helper. Download the Apple
Silicon archive from the [smctl releases](https://github.com/leaperone/smctl/releases),
install the `smctl` and `smctld` binaries together in a directory on `PATH`, then
authorize its LaunchDaemon from Terminal:

```sh
sudo smctl daemon install
```

The Homebrew formula builds from source and requires the full Xcode app.
Installing the signed prebuilt release avoids that build requirement.

Northstar detects the helper and asks for confirmation before changing fan or
charging behavior. The helper supports only hardware it reports as capable;
desktop Macs have no battery charge-limit control. Northstar does not bundle
the helper or run privileged installers. USB port power control is not
available through this integration. Windows and Linux fan/USB helper controls
remain unavailable unless the operating system and hardware expose a validated
control interface. Northstar offers only automatic and quiet fan profiles;
full-speed mode is deliberately excluded. Fan RPM is labeled as an Apple SMC
report and shown as approximate telemetry, not an independently verified
tachometer measurement. On the M4 Mac mini, smctl's hardware notes report a
1,000–4,900 RPM fan range; Northstar identifies readings within 2 RPM of that
reported minimum as running at the minimum.

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
npm run package:flatpak:arm64
```

Linux x86_64 builds produce AppImage, DEB, RPM, and Flatpak bundle files.
ARM64 Linux builds produce a separate Flatpak bundle and must be built on an
ARM64 Linux host. To install a release Flatpak, first set up Flatpak and Flathub
for your distribution, then use the bundle matching your device architecture:

```sh
flatpak install --user ./Northstar.Control-1.2.9-x86_64.flatpak
# On ARM64 Linux:
flatpak install --user ./Northstar.Control-1.2.9-aarch64.flatpak
flatpak run org.northstar.control
```

The downloadable Flatpak bundles are not Flathub listings and will not receive
automatic updates. Windows builds produce an NSIS installer. Release builds use
GitHub Actions on native operating-system runners and publish installers for
all supported platforms when a `v*` tag is pushed.

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

### Run the backend in Docker

The repository includes a production Dockerfile for the login and device API.
Build it from the repository root:

```sh
docker build -t northstar-control-api .
```

Run a single instance with a persistent Docker volume. Replace the Client ID
with the public ID from the GitHub OAuth App; do not use a client secret.

```sh
docker volume create northstar-control-data
docker run --detach --name northstar-control-api --restart unless-stopped \
  --publish 8787:8787 \
  --env GITHUB_CLIENT_ID=your_public_client_id \
  --env NORTHSTAR_ALLOWED_ORIGINS=https://jdj212223-ctrl.github.io \
  --mount source=northstar-control-data,target=/data \
  northstar-control-api
```

Put the container behind an HTTPS reverse proxy that supports WebSocket
upgrades, then set its HTTPS origin in the dashboard's Account & settings.
Keep the container on one instance: sessions, pending login flows, and live
WebSocket connections are held in memory. The container health check uses
`/health`; the mounted `/data` volume retains device records across restarts.

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

## Plans and billing

The hosted service has Free, Plus (€2), Pro (€5), Max (€9) and Professional (€19) monthly plans, billed through Stripe Checkout. Monitoring and the activity monitor stay free; paid plans unlock remote battery and power-profile commands; Professional also unlocks a remote terminal, which the computer must approve on-device for each 10-minute session. To enable billing on your own server set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and point a Stripe webhook at `/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`.
