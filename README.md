# Sugardaddy Community

**Deception and honeypot platform.** Sugardaddy places services on your network
that look real (an SSH server, a printer, a database) but are decoys. Nobody at
your company has a reason to touch them: whoever does is an intruder, and you know
it the moment it happens, with a **zero false-positive rate**.

The **Community** edition is free. You install it yourself, on your own network, and **everything
stays in-house**: events, IPs and what the attacker tries never leave your node.
The console, the sensor, the updater and the SSH decoy (Cowrie) are open source
and require no registration. With your confirmed email you enable, at no cost, more decoys
(closed-source) and automatic updates.

## Get started

- **Install in your environment:** [docs/INSTALL.md](docs/INSTALL.md)
- **Operate and maintain (deploy decoys, update, backups):**
  [docs/OPERATIONS.md](docs/OPERATIONS.md)

In short: an always-on **Linux machine with Docker** and its own IP on your network;
the installer brings your console up, you sign in with your Microsoft Entra
ID account, deploy decoys and see the events in the web UI.

## What a node is

- **Console:** the web UI where you manage your decoys and see what is happening.
- **Sensor:** where the decoys run, isolated and with no internet access.
- **Updater:** keeps the node up to date with signed versions.
- **Decoy without registration:** SSH (Cowrie), with its code in this repository.
- **Decoys with free registration:** SMB, RDP, Redis, web login, DNS/NTP, network
  printer and tarpits for SSH and web. These are closed-source images: their manifest
  is here, not their code.

## What is included and what is not

**Community without registration (open source):** the console, the sensor, the updater,
the SSH decoy and viewing events in your console's web UI.

**Community with registration (free):** additionally, the registration decoys and
automatic updates. You enable them under **Settings → Free registration**: you enter your
email, confirm it, receive an activation code and paste it there. The license
lasts a year and the node renews it itself. The newsletter box is separate and optional.

**In Sugardaddy Cloud (not included here):** alerts to your email, Teams, Slack, webhook or SIEM
(syslog CEF/LEEF, Microsoft Sentinel); the advanced decoys (databases,
domain controller, VPN, healthcare, industrial, AI, bait files…); the
central panel to manage several nodes; and the ready-to-import virtual machine. Your console's catalog
shows them all, tagged; they turn on with
Cloud, with no reinstalling. [Talk to SeguridadSI](https://www.seguridadsi.com).

## Your data, inside your company

Each decoy runs in its own compartment **with no internet access**. What the
intruder does is stored **on your node** and goes no further. Without registration, Sugardaddy Community
sends nothing to SeguridadSI. If you register, SeguridadSI receives your email and the node's name
and version, and the node occasionally asks to renew its license;
never events, IPs or anything that happens on your decoys.

## Security and contributions

- **Found a vulnerability?** Tell us privately, as described in
  [SECURITY.md](SECURITY.md). Never in a public issue.
- **Bugs and ideas:** open an issue. For now we do not accept code from
  outside; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The code in this repository is released under **AGPL-3.0** (see [LICENSE](LICENSE)). The
images of the registration decoys are closed-source and are not covered by that license. The
name "Sugardaddy", the logo and the bee are trademarks of SeguridadSI and are not covered either.

Sugardaddy is a product of [SeguridadSI](https://www.seguridadsi.com).
