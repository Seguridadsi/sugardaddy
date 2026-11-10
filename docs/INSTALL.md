# Install Sugardaddy Community in your environment

This guide takes you from zero to a working Sugardaddy on your network: a **node**
with your console, its sensor and the updater. From the console you deploy decoys
(fake services that look real) and, when someone touches one, you see it right
there. Everything happens on your machine; **no event is sent to SeguridadSI**.

> Sugardaddy Community is free. It includes, as open source and with no registration, the console, the
> sensor, the updater and the SSH decoy. With your confirmed email you enable more decoys,
> closed-source, and automatic updates. Alerts to your email,
> Teams, Slack or SIEM, the advanced decoys, the fleet panel and the ready-made
> virtual machine are part of Sugardaddy Cloud (see [what is included](#what-is-included-and-what-is-not)).

## 1. What you need

- **A Linux machine** (for example Ubuntu Server 22.04 or later), physical or
  a virtual machine of your own, **always on**.
- **Docker** and **Docker Compose** installed (`docker --version`,
  `docker compose version`). The commands below use `sudo`; if you'd rather not
  type it every time, add your user to the docker group once
  (`sudo usermod -aG docker $USER`) and sign in again.
- **Its own IP on your endpoints' network** (not behind NAT): the attacker has
  to be able to reach the decoys, and you want to see their real IP.
- **Outbound HTTPS access to the internet** (to download images and
  updates).
- A way to **sign in to the console**. You choose between two (step 3):
  **local** (username and password on the node itself; you need no Microsoft account or
  anything in the cloud) or **federated** with your **Microsoft Entra ID** (your
  company account, with your MFA). Community ships with **local sign-in enabled** by default.

> **Important about the network.** Don't install the node with Docker Desktop, WSL or
> OrbStack if you can avoid it: they hide the attacker's source IP and the
> decoys will show up as "degraded". A Linux VM with regular Docker shows the
> source correctly.

## 2. Get Sugardaddy Community

Clone the repository on the Linux machine:

```bash
git clone https://github.com/Seguridadsi/sugardaddy.git
cd sugardaddy
```

The node's images (console, sensor and updater) are **built from
source** with a single command in step 4: you don't depend on any registry. The
images for the basic decoys are public and the node downloads them when it uses them.

## 3. Choose how to sign in to the console

Two modes. The **FIDO2 key emergency sign-in** remains available in both,
in case you get locked out.

### Option A — Local sign-in (the simplest, the default)

Username and password stored on the node itself. **You don't have to do anything in
Microsoft or register any application.** During installation (step 4), the console
creates a first administrator and shows you its one-time password; you change it
on first sign-in and, from the console, you add everyone else (**Settings → Local users**).

In Community it is enabled by default. In other editions it is turned on by setting
`LOGIN_LOCAL=1` in the node's environment.

### Option B — Federated with your Microsoft Entra ID

People sign in with your company's Microsoft account (with your MFA and your
groups). Register an application in your Entra tenant:

1. In the Azure portal → **Microsoft Entra ID → App registrations →
   New registration**.
2. Name: `Sugardaddy`. Account type: your organization only.
3. **Redirect URI** (web): `https://<your-console-url>/auth/callback`.
4. Note the **Application (client) ID** and the **Directory (tenant)
   ID**.
5. Under **Certificates & secrets → New client secret**, create one and copy
   its **value** (it is shown only once).
6. Control **who signs in and with what role**: create a **security group** (e.g.
   `Sugardaddy-Access`) with whoever should sign in, and define the **application
   roles** (reader, operator, approver, admin…) by assigning them under
   _Enterprise applications → Sugardaddy → Users and groups_. The console does not
   let in anyone who is not in the group and has a role.

Keep the tenant, the client ID, the secret and the group ID: the installer asks for them.
You can have both modes at once (local + federated); the sign-in screen
shows whatever you have configured.

## 4. Install the node

First, **build the node's images** (console, sensor and updater)
from source. This command leaves them ready and writes the `imagenes.env` that the
installer needs (it takes a while the first time):

```bash
sudo despliegue/nodo/construir-imagenes-local.sh
```

Then run the installer from the repository folder, with the folder where the node
will live, an identifier, your company name and the
**address you will use to reach the console** (the 4th argument).

That address is the key: you will sign in through it. The simplest is to use **the
machine's IP** (that way you connect by IP, without touching DNS or the `hosts` file):

```bash
sudo despliegue/nodo/instalar.sh /opt/sugardaddy nodo-01 "Your Company" 203.0.113.10
```

If you have a **DNS name** that points to the machine, use it instead
(`manage.yourcompany.com`). You can change the address later by running
the installer again with another one (it keeps your data; with the node's own CA it
creates a new root, which you need to install again on your machines).

The installer:

- generates the **node secrets** once (it stores them in
  `/opt/sugardaddy/.env`; if the file already exists, it keeps it);
- starts the console, the sensor, the updater and Postgres with Docker Compose;
- sets up **HTTPS**. By default it creates the node's **own CA**, whose root only
  works for the console's address, and leaves that root at
  `/opt/sugardaddy/ca-raiz.crt` so you can install it on the machines
  you sign in to the console from. If you prefer your own certificate, put the
  files at `/opt/sugardaddy/certs/certificado.pem` and `.../clave.pem` and run
  the installer with `TLS_MODO=ficheros`.

When it finishes, it prints the console URL and tells you it is up and running.

### Your first sign-in

- **Local sign-in** (the default in Community): on first startup the console
  creates the `admin` administrator and writes its **one-time password** to its
  log. To see it:

  ```bash
  sudo sh -c 'docker logs "$(docker ps -qf name=consola)" 2>&1 | grep -A3 "FIRST CONSOLE ADMINISTRATOR"'
  ```

  Write it down (it is not shown again) and change it on first sign-in.

- **Federated with Entra**: put the tenant, the client ID, the secret and the ID of the
  group where the installer tells you to (environment variables or the node's
  environment file), and restart. If you don't want local sign-in at the same time, leave
  `LOGIN_LOCAL` empty. With neither mode, the console starts but you can only
  sign in with the emergency key.

## 5. Sign in to the console and deploy your first decoy

1. Open in the browser the address you set during installation: `https://<IP>/` (or
   `https://<your-name>/`). With the node's own CA, the browser warns that
   the certificate isn't trusted: **accept it** to continue (or install
   `/opt/sugardaddy/ca-raiz.crt` on your machine so it doesn't warn). Sign in with your
   local user (or with your Entra account, depending on the mode you chose).
2. Go to **Decoys** (or **Targets** → create decoy).
3. Pick a decoy, for example **SSH (Cowrie)**, and the **port** the attacker will
   see it on (the suggested one is usually fine; avoid ports already in use), then
   save it.
4. After a few seconds it shows **Deployed**, and **Verified** once its
   first event arrives.

## 6. Check that it works

From **another machine on your network** (not from the node's own machine, which distorts
the source IP), attack the decoy. For the Cowrie SSH decoy:

```bash
ssh -p <port> root@<node-ip>
```

Try any password. Then, in the console, under **Events**, the entry should
appear: the IP you attacked from, the decoy, and what you did. If it
shows up, Sugardaddy works end to end.

## Update

New versions are published on GitHub. In this edition they **don't install themselves**:
you keep up to date yourself, from your clone of the repository.

```bash
git pull
sudo despliegue/nodo/construir-imagenes-local.sh
sudo despliegue/nodo/instalar.sh /opt/sugardaddy <id> "<your company>" <address>
```

Reinstalling **keeps your secrets and your data**; it only swaps the images for
those of the new version. The version only moves forward: the installer won't let
you install an older one.

## Reinstall or start from scratch

Running the installer again on an already-installed node **updates** it and
keeps its secrets and its data (`/opt/sugardaddy/.env`). Reinstalling the same
build, or a newer one, just works; the installer only stops you if you try to
put an **older** version over a newer one.

If you installed an earlier version of the edition and the installer complains that the
node "already has a newer version", delete the node's version record once
and install again (it doesn't touch your data):

```bash
sudo rm /opt/sugardaddy/versiones.env
```

If you want to **start from scratch** (this deletes the node, its containers and ALL its
data, with no way back):

```bash
cd /opt/sugardaddy && sudo docker compose -p sugardaddy down -v
sudo docker ps -aq --filter name=sd-local- | xargs -r sudo docker rm -f
sudo rm -rf /opt/sugardaddy
```

Then install again as in step 4.

## What is included and what is not

**Included without registration (open source):** the console, the sensor, the updater, the
SSH decoy and viewing events in your console's web UI.

**With your free registration:** additionally, SMB, RDP, Redis, web login, DNS/NTP, printer,
SSH tarpit and web tarpit, plus automatic updates. These are closed-source decoys:
they are not in the repository and don't start without a signed license. You enable them
under **Settings → Free registration**: you enter your email, open the link you receive,
get an activation code and paste it there. The license lasts a year and the node renews it itself.
If it stops renewing, those decoys stop and the console tells you how to fix it; the SSH
decoy and the rest of the node carry on as before.

**In Sugardaddy Cloud (not in this edition):** alerts to your email, Teams, Slack,
webhook or SIEM (syslog CEF/LEEF, Microsoft Sentinel); the advanced decoys
(databases, domain controller, VPN, healthcare, industrial, AI, bait
files…); the central panel to manage several nodes; and the ready-made
virtual machine. In the Community edition you see events in the web UI; with Cloud, they
also reach you wherever you work. [Talk to SeguridadSI](https://www.seguridadsi.com).

## Build the images yourself

Everything is **reproducible** from the repository's source, without depending on any
registry or any SeguridadSI infrastructure. The node's three images
are built by `despliegue/nodo/construir-imagenes-local.sh` (that is step 4). The SSH
decoy is also built from its source (`modulos/trampas/cowrie/imagen/`). The
registration decoys are closed-source images: they are downloaded from ghcr.io.

## If something fails

- The installer tells you **which step** failed; reread the message and run
  the same line again.
- A decoy that doesn't start: check its status under **Decoys**; the console explains
  the reason (port in use, image that won't download…).
- A decoy "degraded" because "the attacker's IP is not visible": the container
  engine hides the source (Docker Desktop, WSL, OrbStack). Use a Linux
  VM with regular Docker.

## Protect your secrets

The node secrets live in `/opt/sugardaddy/.env`. Make **backups**
(see [OPERATIONS.md](OPERATIONS.md)) and keep the key outside the
machine: without it, a backup cannot be restored.
