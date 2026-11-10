# Operating Sugardaddy Community: deploying decoys, updating and maintaining

Once the node is installed ([INSTALL.md](INSTALL.md)), this guide covers
day-to-day work: where to put the decoys, how to test them, how to keep the node up to date
and how to make backups. Every command is run from the node's folder
(`/opt/sugardaddy` by default), on the Linux machine.

## 1. Deploy decoys on your network

A decoy can live in two places:

### a) On the node itself (the usual case)

Most decoys are **containerized services** that run on the node's
sensor, each on its own port. From the console, under **Decoys**:

1. Pick the decoy and the **port** the attacker will see it on.
2. Save it. Within seconds it changes to **Deployed**.

For an attacker to find them, the node should have a **believable IP
inside the segment** you want to monitor (just one more among your servers). If you
have several VLANs, give the node a leg in each one, or run one node per site.

### b) Bait on real systems (step by step)

Besides the decoys on the node, you can plant **bait** on real systems
so the intruder finds it while looking around:

- On a **file server**: shares or documents that no legitimate user
  opens.
- On an internal **website** or in **Azure**: decoy entries, links or credentials
  that only someone snooping would follow.

Do it **step by step**: start with one decoy on the node, verify it, and expand
from there. Each bait you place must have no legitimate use: that way, any
touch is a signal.

> The bait files that **alert when opened** (Word, Excel, PDF) are a
> Sugardaddy Cloud feature; in the Community edition you use the service
> decoys.

## 2. Test a decoy

From **another machine on your network** (not from the node's machine, which distorts the IP):

- **SSH (Cowrie):** `ssh -p <port> root@<node-ip>` and try a password.
- **Redis** (with your registration): `redis-cli -h <node-ip> -p <port> CONFIG SET dir /tmp`
- **Web login** (with your registration): open `https://<node-ip>:<port>/` in the browser.

In the console, **Events** must show what you did, with the source IP
and the action. Decoys almost never raise false alarms: nobody at your company uses them,
so **every alert deserves a look**.

## 3. HTTPS: install the CA on your machines

If you used the **node's own CA** during installation, browsers will warn about an
untrusted certificate until you install its root. It is at
`/opt/sugardaddy/ca-raiz.crt`; the console serves it at `/ca-raiz.crt` and shows it,
with its fingerprint, under **Settings → Console certificate**.
Install it as a **trusted root certification authority** on the machines you
sign in to the console from. On Windows you can deploy it to many computers with Group
Policy: Computer Configuration → Policies → Windows Settings → Security Settings →
Public Key Policies → Trusted Root Certification Authorities → Import.
If you prefer to avoid that, install the node with your own
certificate (`TLS_MODO=ficheros`, see [INSTALL.md](INSTALL.md)).

The node's root **only works for the console's address**, and only for websites: it
cannot sign certificates for any other website, nor software or email. If someone took
over the node, which sits next to the decoys and is meant to attract attackers, the root
would only let them pretend to be the console itself. Because of that, if you change the
console's address by running the installer again, the node creates a new root, and you
need to install that one instead.

**Nodes installed before the node's own CA** use a root with no such limit, whose key
lives on the node. The console tells administrators so, and **Settings → Console
certificate** offers the new root with the steps to install it. Nothing changes until you
confirm there that it is on the computers: then the node switches within a minute or two
and destroys the old root's key, on the machine and in its backups. Remote sensors are
given the new root before the switch, so they keep reporting. Once it is done, remove the
old root from the computers (the console shows its name and fingerprint), and delete any
backups you had copied off the machine before the switch.

## 4. Keep the node up to date

The **updater** keeps the node on the latest signed version: it checks whether
there is a new version, pulls the images (always by digest) and applies it; if
something fails at startup, it **rolls back** to the previous version. You don't have to
do anything day to day.

To see which version you are on and the state of the services:

```bash
cd /opt/sugardaddy
docker compose --env-file .env --env-file versiones.env ps
cat versiones.env        # the applied version
```

Versions are **signed**: the node applies nothing that isn't signed with
Sugardaddy's publishing key, so a tampered image doesn't get in.

### How long events are kept

The console deletes events older than a set period on its own, every hour: by default, **1 year**. You are responsible for that data, so set the period your privacy policy requires under **Settings → How long events are kept** (between 30 days and 10 years).

The console's audit log (who signs in and what they do) is kept for a year, or for the events period if that is longer.

Deleted data cannot be recovered. If you need to keep something longer (for example, for a criminal complaint), make a backup first. The first time, deletions wait 30 days, so you have time to change the period.

## 5. Backups

Make regular backups. From the node's folder:

```bash
cd /opt/sugardaddy
./copia.sh
```

It saves the database, the secrets (`.env`), the versions and the HTTPS CA
to `copias/sugardaddy-<date>.tar.enc`, **encrypted** with `clave-copias`.

> **Keep `clave-copias` OUTSIDE the machine.** Without it, the backup cannot be
> restored. If you lose the machine and the key, you lose the node.

Automate it with cron (one backup every night, keeping the last 14):

```cron
15 3 * * * cd /opt/sugardaddy && ./copia.sh
```

### Restore

On a new machine, with the backup and its `clave-copias`:

```bash
cd /opt/sugardaddy
./restaurar.sh copias/sugardaddy-<date>.tar.enc
```

It leaves the node as it was: decoys, events and secrets.

## 6. Move to Cloud or upgrade

Your catalog shows the Community decoys and marks those enabled with your free
registration, under **Settings → Free registration**. When you want alerts to
your email/Teams/Slack/SIEM, advanced decoys, several sites from one panel or
support, [talk to SeguridadSI](https://www.seguridadsi.com): what you purchase is
enabled and turns on in your console, with no reinstalling.

## 7. Common problems

- **A decoy won't start:** check **Decoys**; the console gives the reason
  (port in use, image that couldn't be pulled, outdated sensor…).
- **"The attacker's IP is not visible" / degraded decoy:** the container engine
  hides the source (Docker Desktop, WSL, OrbStack). Use a Linux VM with regular
  Docker.
- **No events arrive when you attack:** did you attack from **another** machine? From the
  node's own, the IP shows up as internal. Also check that the decoy's port is open
  in your network's firewall up to the node.
- **The console won't let you sign in:** check the Entra configuration (tenant, client
  ID, secret and the redirect URI `.../auth/callback`).
