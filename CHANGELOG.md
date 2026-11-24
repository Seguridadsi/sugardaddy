# Changelog

What changes in each signed version of Sugardaddy Community, newest first. Each entry is the note
signed with that version (the oldest ones translated from Spanish). To check the signature of the
latest version yourself, run `despliegue/nodo/verificar-version.sh`.

Fixes go into the latest version only (see [SECURITY.md](SECURITY.md)): keep the updater on, or
update by hand as described in [docs/INSTALL.md](docs/INSTALL.md#update).

## 0.33.5 — 2026-11-24

New Health tab under Sensors: CPU, memory and disk of each sensor's machine over 24 hours or 7
days, the state and restarts of each honeypot, and each sensor's outgoing queue and clock. Events
from a repeated test no longer count as an attack, and Cowrie keeps what attackers download.

## 0.33.2 — 2026-11-24

Recognises ten more AI attack agents (Cybermes, FORANG, ycode, cyber-harness, T3MP3ST, Pensar
Apex, LuaN1aoAgent, AIRecon, Incalmo and virga) and more ARTEX infrastructure from published
reports. Events from the same session as a "Test" now count as part of the test.

## 0.33.1 — 2026-11-23

Go 1.27.4, faster beacon relay quarantine and an updated MSSQL decoy.

## 0.33.0 — 2026-11-23

Registration now uses a short code sent by email, entered in the console. No link to the central
panel.

## 0.32.2 — 2026-11-19

Attack-agent panels: registered Community nodes now flag events from IPs that host known
attack-agent panels (ARTEX). Fixes node indicators being dropped, and refreshes the decoy images
(Cowrie sd11, login-web, smb).

## 0.32.1 — 2026-11-18

Nodes update themselves again.

## 0.31.1 — 2026-11-16

Signed licence end date, two-factor sign-in, full export, off-machine backups, strict host
firewall and hardened isolation.

## 0.30.1 — 2026-11-15

Hardening: signing keys in an HSM, isolated decoys, outbound proxy support, tamper-evident audit
log and security audit fixes.

## 0.29.2 — 2026-11-12

Community nodes now also update their compose file and their own updater.

## 0.29.1 — 2026-11-12

Who is attacking: SSH client fingerprints, typing rhythm on the SSH honeypot, and an AGENTS.md
lure. Verified installer groundwork.

## 0.28.1 — 2026-11-12

Setup wizard, tabbed pages, shared search, per-honeypot noise, AI-agent marking in events and a
more convincing Cowrie.

## 0.25.1 — 2026-11-10

Signed decoy catalog and per-use signing keys.

## 0.24.3 — 2026-11-09

Security update: account recovery, local sign-in and sessions are hardened, the updater refuses
older releases, and decoys keep their TLS keys and stop listening on localhost unless this machine
is registered. Cowrie moves to 3.1.2-sd5.

## 0.24.1 — 2026-11-08

The deployment map now shows only what is running: sensors with a heartbeat and deployed decoys.
Cowrie notices are in English.

## 0.24.0 — 2026-11-08

Per-user time zone, crawler hits set aside without an incident, per-sensor switch to record the
node's own machine, decoy events in English, and high-confidence alerts.

## 0.23.0 — 2026-11-06

The product is now in English. New side menu with Sign out, Dashboard cards, a Get started
checklist and a single top notice.

## 0.22.4 — 2026-11-06

New deployment map by site: each site in its own box, with its name, its IP and its decoys inside.
With many decoys, each type gets its own sector. Clicking an element opens its details.

## 0.22.3 — 2026-11-06

New Map page: how your decoy network is laid out, as a graph, with each network, its sensors and
their private IPs, and the decoys with their service and port. Clicking an element opens its
details. It can also be shown as a list.

## 0.22.0 — 2026-11-05

Community now ships Cowrie with no registration. The free email registration enables SMB, RDP,
Redis, web login, DNS/NTP, printer and the two tarpits, with new images, and automatic updates. If
you already had one of those decoys running, it stops until you register under Settings; its
events are kept.

## 0.21.19 — 2026-11-04

Known sources: IP allowlist, silences and per-IP triage in one place. The paid edition is renamed
Sugardaddy Cloud.

## 0.21.7 — 2026-11-02

Collapsible dashboard: every section and every map can be hidden and shown.

## 0.21.6 — 2026-11-02

Fix: 0.21.4 did not start. Brings the emergency code at install time, sign-in with your company's
Microsoft Entra ID from Settings, the map of Spain and "Installed" in the catalog.

## 0.21.4 — 2026-11-02

Emergency code at install time; sign-in with your company's Microsoft Entra ID from Settings; map
of Spain on the dashboard; "Installed" in the catalog. (Withdrawn: it did not start; use 0.21.6 or
later.)

## 0.21.3 — 2026-11-02

Recover your password with a code sent by email; every local user needs an email address.

## 0.17.4 — 2026-10-29

Decoys can now be deployed (free decoys are authorized without a panel); my account and a preview
of alerts and response.

## 0.17.3 — 2026-10-28

Sensors: sources and network/VLAN; DNS/NTP decoy fix.
