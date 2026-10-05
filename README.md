# Northstar Control

Northstar Control is an open-source desktop app for monitoring a computer and
using hardware and power controls exposed by its operating system.

## Web dashboard

The static account and computer dashboard is hosted on GitHub Pages:
<https://jdj212223-ctrl.github.io/northstar-control/>.
The source is in [`docs/`](./docs/), and the Pages workflow deploys it after
changes to that folder reach `main`.

This is a static website, not a remote-control service. It does not sign users
in, list or remove computers, collect telemetry, or send hardware commands.
Its display preferences stay in the current browser. A real remote management
service would need to be designed and deployed separately before pairing,
account-level device removal, or off-device control can work.

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

Install Node.js 22.12 or later, then run:

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

1. In GitHub Developer Settings, create an OAuth App.
2. Set the **Homepage URL** to
   `https://github.com/jdj212223-ctrl/northstar-control`.
3. GitHub requires an **Authorization callback URL**. This app uses Device
   Flow and does not redirect to a callback; enter the same repository URL in
   that required field.
4. Enable **Device Flow**. Turn off **Expire user access tokens** for now;
   refresh-token renewal is not implemented.
5. Copy the OAuth App's public Client ID into Northstar Control's Settings,
   choose **Sign in with GitHub**, and authorize the one-time code at
   `https://github.com/login/device`.

Northstar Control requests only the `read:user` permission. The Client ID is
public configuration; do not put a client secret in the desktop app. The
access token is stored with Electron's OS-backed secure storage and removed
when you sign out. On Linux, sign-in is disabled unless Electron can use a
Secret Service or KWallet backend; the weaker `basic_text` fallback is
rejected.

GitHub confirms which account is signed in. It does not authorize Northstar
Control to administer your computer or bypass macOS, Windows, or Linux
permissions. Hardware access still requires separate local OS authorization.

## Remote access

The desktop app currently reads telemetry and applies supported settings on
the computer where it is running. The web dashboard does not have a remote
connection to it. GitHub Pages cannot run the private API, device relay, or
authentication service required for secure remote access; publishing a web
page alone cannot make remote fan, clock, battery, or power controls work.

Any future remote-control feature needs an authenticated enrollment flow,
encrypted device connections, revocation, explicit local approval, and
hardware-specific safety validation. Do not expose a computer's control
service directly to the public internet or put account credentials in the
static site.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for project guidelines. This project is
licensed under the [MIT License](./LICENSE).
