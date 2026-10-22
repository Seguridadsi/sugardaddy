# Threat model: Sugardaddy Community

## What this project is

Sugardaddy is a **deception platform**. A customer installs a *node* (one Linux
host with Docker) inside their own network. The node runs fake services, called
**traps** (Spanish: *trampas*), that no legitimate user has any reason to touch.
Anyone who connects to a trap is treated as an intruder, and the console shows
what they did.

**The traps are built to be attacked.** Weak or default credentials, accepted
logins, old or fake banners and versions, open services (a Redis with no
password, an SSH that lets `root` in), fake files, fake shells, fake configs and
fake database dumps are all intentional. None of them is a vulnerability.

What matters is that the attacker stays **inside** the trap and that what they
send cannot hurt the platform that is watching them.

## Components, languages and where they are

| Component | Language | Path | How it runs on a node |
|---|---|---|---|
| Console: web UI, plus the APIs for sensors, the updater and firewalls | TypeScript, Svelte 5 / SvelteKit 2 (adapter-node), Drizzle ORM, Postgres 17 | `apps/consola/`: server code in `src/lib/server/`, routes in `src/routes/`, migrations in `drizzle/`, start-up scripts in `scripts/` | Container, non-root, read-only rootfs, behind Caddy on 443 |
| Shared packages | TypeScript | `paquetes/contrato` (JSON schemas for events and trap manifests, Ajv validation, event hash chain), `paquetes/entra` (OIDC with Microsoft Entra ID), `paquetes/canal` (Ed25519 signing for the optional central-server channel), `paquetes/estilo` (UI) | Bundled into the console |
| Sensor: runs the traps and ships their events | Go (standard library only) | `sensor/cmd/sensor`, `sensor/internal/` (`despliegue`, `docker`, `motor`, `red`, `seguidor`, `adaptador`, `evento`, `consola`, `confianza`, `plan`, `estado`, `requisitos`) | Container as root, **with the Docker socket** |
| Updater: applies signed releases | Go | `sensor/cmd/actualizador`, `sensor/internal/actualizador`, `sensor/internal/relevo` | Container as root, **with the Docker socket** and the node directory |
| Trap test bench (developer tool) | Go | `sensor/cmd/probartrampa` | Not deployed |
| Traps | Go and Python, see below | `modulos/trampas/<trap>/`: manifest `trampa.yaml`, image recipe `imagen/` | One container per trap |
| Node deployment | Shell, Docker Compose, Caddy | `despliegue/nodo/` (`compose.yml`, `instalar.sh`, `copia.sh`, `restaurar.sh`, `Caddyfile`) | Run by the customer as root |

The traps in this edition:

| Trap | Emulates | Code |
|---|---|---|
| `cowrie` | SSH / Telnet | Cowrie v3.1.2 (Python, upstream) with the Sugardaddy patch: `imagen/parche.py`, `imagen/sugardaddy.py` |
| `dns-ntp` | DNS, NTP, SSDP | DDoSPot v2.0.1 (Go, upstream) with `imagen/sugardaddy.patch` |
| `retencion-web` | HTTP tarpit | go-pot v1.1.2 (Go, upstream) with our files in `imagen/fuente/` |
| `smb`, `rdp` | SMB1/2; RDP (X.224, TLS, CredSSP) | glutton (Go, upstream), trimmed and patched, with our code in `modulos/comun/glutton/base/` |
| `impresora` | Network printer (PJL, IPP, web) | Own code, `imagen/fuente/` |
| `login-web` | Web login portal | Own code, `imagen/fuente/` |
| `redis` | Redis (RESP) | Own code, `imagen/fuente/` |
| `retencion-ssh` | SSH / banner tarpit | Own code, `imagen/fuente/` |

Each `imagen/preparar.sh` fetches the upstream at a pinned commit (or tarball
sha256), applies the patch and refuses to build if a check fails.

## Attackers we care about

1. **The intruder**: anyone on the network who connects to a trap. This is the
   main adversary and controls everything a trap receives. Assume they can
   eventually run code inside a trap's container. That container is the
   containment boundary, and it must hold.
2. **Someone on the LAN who reaches the console's HTTPS port without an
   account.**
3. **A console user with a low role**, such as `lector` (read-only), who wants
   more.
4. **Whoever sits on the path of the update channel**, or can feed the node a
   release.
5. **A compromised remote sensor**: it holds one sensor token and can send the
   console whatever it wants under that token.

## Trust boundaries: what is critical

### (a) Escape from a trap to the sensor, another trap or the host

The sensor starts each trap through the Docker API
(`sensor/internal/despliegue/despliegue.go`, `config()`). Every trap gets:

- `CapDrop: ALL` and `no-new-privileges`;
- a read-only rootfs (from the manifest);
- memory, CPU and pids limits, and `/tmp` as a `noexec` tmpfs;
- no Docker socket and no host namespaces.

The images run as non-root: our Go traps are `FROM scratch` binaries.

A trap's mounts are its own log directory (read-write), a few files the sensor
writes for it (read-only) and, for `cowrie` only, named volumes. **The sensor and the updater
hold the Docker socket**, so code execution in either of them means root on the
host.

Treat every trap as hostile. Anything it writes to its log directory, its
volumes or the network is attacker-controlled. The sensor follows and parses
those log files (`sensor/internal/seguidor`, `sensor/internal/adaptador`).

**Critical:** anything that lets a trap affect any of the following:

- the sensor process (for example through symlinks, FIFOs, special or huge
  files, or path tricks in its log directory);
- the host;
- the Docker daemon;
- another trap's files or network;
- the node's services.

### (b) A trap reaching out: egress, pivoting or acting as a relay

Traps live on bridge networks that the sensor creates with IP masquerading and
inter-container traffic disabled (`sensor/internal/docker/docker.go`,
`AsegurarRed`). They are never attached to the network of the console,
Postgres, the sensor or the updater (`despliegue/nodo/compose.yml`).

**The goal:** a trap answers whoever connects to it, and does nothing else. It
must not open connections to any of these:

- the Internet;
- the host's own services;
- the node's services;
- other traps;
- the rest of the LAN.

It must not be usable as a proxy, relay, reflector or amplifier.

**Critical:** any way to make a trap originate traffic beyond the connection it
is answering. Examples:

- Cowrie port forwarding (`direct-tcpip`), or its emulated `wget`, `curl` or
  `tftp` really fetching;
- Redis `REPLICAOF` / `SLAVEOF` really connecting;
- DNS recursion;
- NTP, DNS or SSDP responses larger than the request, sent to addresses outside
  the trap's configured internal networks;
- reaching the bridge gateway, the host or the LAN from inside a trap.

The optional "own IP" mode (macvlan on the LAN, `sensor/internal/red`,
`sensor/internal/despliegue/ip_propia.go`) gives traps a gateway that does not
exist. No trap in this edition uses it, but the same goal applies.

### (c) Attacker data poisoning the console: XSS, injection

The attacker controls almost every field of an event: user names, passwords,
commands, URLs, user agents, the raw log line (`crudo`) and the free-form
`detalle`. The path an event takes:

1. A trap's log file.
2. The sensor: `seguidor` follows the file and `adaptador` maps the fields
   (truncating them) using the manifest's field map.
3. `POST /api/sensor/eventos` (NDJSON) with the sensor's bearer token.
4. `validarEvento` checks it against the schema (`paquetes/contrato`).
5. Postgres (`eventos`, or `cuarentena` for invalid lines), through Drizzle.
6. The console pages (events, captured passwords, dashboard, map), and the
   plain-text blocklist served to firewalls (`GET /api/edl/negra`).

The console must render all of this as text. It never uses `{@html}`, and it
sets a strict CSP (`apps/consola/vite.config.ts`).

**Critical:**

- stored XSS or CSP bypass from event data;
- SQL injection;
- injection into what other systems consume (the EDL list must only ever
  contain IPs and CIDRs);
- forging, hiding or reordering events without breaking the per-trap hash
  chain (`paquetes/contrato`, `sensor/internal/evento`);
- an event from one sensor landing on a trap that belongs to another.

### (d) Console authentication (Microsoft Entra ID) and privilege escalation

**Login** (`paquetes/entra/src/index.ts`, `apps/consola/src/lib/server/auth/`):

- Login is OIDC authorization code with PKCE, state and nonce.
- The `id_token` is verified against the tenant's JWKS, issuer and audience.
- Access requires membership of the customer's group (`ENTRA_GRUPO_CLIENTE`)
  and an app role.
- Sessions are server-side in Postgres (cookie `sd_sesion`), with a 30 min idle
  and 8 h absolute limit.

**Roles:** `lector` < `operador` < `aprobador` < `admin-listas` < `admin`
(`apps/consola/src/lib/permisos.ts`). They are enforced in server load
functions and form actions.

**Vendor support access** (`ENTRA_GRUPO_SOPORTE`) works only while the customer
has opened it in Settings, and with the role the customer chose.

**Reachable without a session** (`apps/consola/src/hooks.server.ts`, `PUBLICO`),
each protected by its own secret:

- the sensor API (per-sensor bearer token, stored hashed);
- the updater API (`ACTUALIZADOR_TOKEN`);
- the firewall blocklist (`EDL_TOKEN`);
- the remote-sensor installer (a one-time code);
- the break-glass emergency login: WebAuthn keys, enrolled by an admin or with
  a one-time code that root generates on the host with
  `apps/consola/scripts/emergencia.mjs`;
- the health check;
- the node's public CA certificate.

**Critical:**

- any unauthenticated access to pages, data or actions;
- logging in with a token from another tenant or app, or as a user outside the
  customer's group;
- session forgery or fixation;
- bypassing the support gate;
- enrolling or using an emergency key without the one-time code or an admin
  session;
- using one token type where another is expected.

**High:** escalation between roles, and CSRF on any state-changing action.

**Not a finding:** `vite dev` with no Entra configuration logs everyone in as
`admin`. That is a development mode gated by `$app/environment`'s `dev`. Report
it only if a production build (`vite build`) can reach it.

### (e) The updater accepting unsigned or tampered releases

**What a release is:** a JSON document signed with SeguridadSI's Ed25519
publication key. The public key is pinned on the node as
`PUBLICACION_CLAVE_PUBLICA` in the node's `.env`, written by `instalar.sh`.

**Verification happens three times:**

1. The console verifies a release and refuses downgrades
   (`apps/consola/src/lib/server/canal.ts`).
2. The updater verifies it again (`sensor/internal/actualizador/release.go`)
   and requires every image to be pinned by `@sha256`.
3. A short-lived helper re-verifies it before it applies the signed
   `compose.yml`, `Caddyfile` and environment additions
   (`sensor/internal/actualizador/configuracion.go`).

**Critical:** anything that makes a node run an image, compose file,
Caddyfile, environment variable or command that the publication key did not
sign. That includes:

- a signature bypass;
- a difference between the bytes that are verified and the bytes that are
  applied;
- digest substitution;
- path traversal while writing config;
- replaying or downgrading to an older signed release.

### (f) Data leaving the customer's network

The Community edition promises that events, attacker IPs, captured credentials
and node secrets stay on the node.

**Expected outbound traffic by default:**

- Entra ID sign-in (token endpoint, JWKS);
- image pulls by digest (ghcr.io, Docker Hub);
- the admin's browser loading Google Fonts.

**The optional channel to a central management server**
(`apps/consola/src/lib/server/canal.ts`, `paquetes/canal`):

- It is **inactive until an admin registers the node**, either at install time
  (`PANEL_URL`, `PANEL_ALTA_CODIGO`) or from Settings.
- Once registered, it sends a heartbeat with counts and versions.
- It sends public attacker IPs only if the admin turns sharing on.

**Critical:**

- any path that sends event data, credentials, node secrets or details of the
  customer's network off the node without that opt-in, or more than the above
  after it;
- any way for an attacker, a trap or event data to make the console or the
  sensor issue requests to a destination of their choosing (SSRF).

### (g) Detecting that it is a honeypot

The traps try to look like real systems: per-instance identities, plausible
banners and errors. A **reliable, remote** way for an intruder to tell a trap
from the real thing is worth reporting, at **low** severity. Generic
"honeypots can be fingerprinted" remarks are not.

## How we rate severity

**Critical**

- code execution on the sensor, updater, console or host, from a trap, from the
  network or from event data;
- escaping a trap's container;
- trap egress, relay or pivoting;
- stored XSS or SQL injection from attacker data;
- bypassing console authentication;
- the updater applying unsigned or tampered content;
- data leaving the node without the opt-in.

**High**

- an authenticated user escalating privilege (for example `lector` or
  `operador` to `admin`, or support access beyond what the customer granted);
- real, non-emulated code execution inside a trap that does not yet cross the
  boundary;
- a trap reading or writing another trap's data or the sensor's files;
- forging or deleting events across sensors or traps, or tampering with the
  hash chain without detection;
- CSRF on state-changing actions;
- disclosing node secrets (tokens, Entra client secret, backup key) to anyone
  who is not an admin.

**Medium**

- DoS from the network that takes down the sensor, console, Postgres or other
  traps;
- attacker input growing disk or memory beyond the per-trap limits and quotas;
- open redirect;
- information disclosure to authenticated low-privilege roles.

**Low**

- reliable remote fingerprinting of a trap;
- hardening gaps with no exploit path;
- issues that need an admin session or root on the host.

## Out of scope

- **Weaknesses the traps simulate**, all of them intentional:
  - weak or default credentials (Cowrie's user database, `admin`/`admin` on
    `login-web`, Redis without a password, the RDP trap's seeded password, SMB
    accepting any login);
  - fake or outdated banners;
  - fake files, shells, configs and dumps;
  - capturing NTLM hashes;
  - tarpits holding connections open;
  - the RDP trap's per-instance self-signed certificate and its key, which is a
    fake identity and not a secret.
- **DoS against a trap itself**: a crash, a slowdown, or an out-of-memory error
  within its own limits. It is in scope only if it takes down the sensor, the
  console, Postgres, other traps or the host, or escapes the trap's resource
  limits.
- **How the customer configures the host**: Docker and kernel versions,
  firewall rules, who can reach the console's port, the Entra tenant and its
  app registration, and certificates they supply.
- **Upstream code** (Cowrie, DDoSPot, go-pot, glutton), except:
  - where our patches change it;
  - where its behaviour, as deployed here, leads to (a), (b), (c) or (f).
- **Development-only files**:
  - `despliegue/compose.dev.yml` and its fixed passwords;
  - the `vite dev` auto-admin;
  - `apps/consola/scripts/semilla.ts`;
  - test fixtures.
- **CVEs in base images or dependencies** with no reachable path in this code.
- **Features that are not in this repository.** Scripts sometimes mention
  helper tools that are not here; ignore those references.

## How to exercise it

The scan image is built by `.oss-scanner/Dockerfile`:

| Path | Contents |
|---|---|
| `/src` | The repository |
| `/src/apps/consola/build` | The built console |
| `/src/sensor/bin/` | `sensor`, `actualizador`, `probartrampa` |
| `/opt/sd-trampas/<trap>` | Each trap's source after its `preparar.sh`: upstream plus our patch, or our own code |
| `/opt/sd-trampas/bin/<trap>` | The Go trap binaries |
| `/opt/sd-trampas/cowrie-env` | Cowrie's virtualenv |

**Run every test suite** (works offline):

```sh
/src/.oss-scanner/run-tests.sh
```

The suites are:

- the vitest specs of the console and packages, including those that need
  Postgres (a local Postgres 17 is in the image);
- `go test` for the sensor and updater;
- each trap's own tests, the same ones its `imagen/Dockerfile` runs.

**Run the console:**

```sh
pg_ctlcluster 17 main start
cd /src/apps/consola
ORIGIN=http://localhost:3000 node --env-file=.env scripts/arrancar.mjs
```

`arrancar.mjs` migrates the database first. The connection details in
`apps/consola/.env` are test-only values that exist only in this image. With no
Entra variables, a production build lets nobody in. The specs show how to call
the server functions directly, for example `src/lib/server/recepcion.spec.ts`
for event ingestion.

**Run a trap:** `/opt/sd-trampas/bin/<trap>`, with the environment variables
from the `entorno` block of `modulos/trampas/<trap>/trampa.yaml`. It writes
JSON lines to the `registros` path given there.

**The sensor needs a Docker engine,** and the scan image has none. Its tests use
a fake engine (`sensor/internal/docker/motorfalso`). Reason about container
isolation from `sensor/internal/despliegue/despliegue.go` and
`sensor/internal/docker/docker.go`.

## What we would like in a report

- **The boundary it crosses**, (a) to (g) above.
- **The attacker's position**: intruder hitting a trap, unauthenticated LAN
  user, authenticated role, compromised trap, compromised remote sensor, or the
  update path.
- **A reproducer**, ideally a test in the package's own style:
  - Go `_test.go`;
  - vitest `.spec.ts`;
  - Python `unittest` for Cowrie (`imagen/pruebas/`).
- **A minimal patch.**
- **One report per root cause.** A bug in the shared glutton base affects both
  `smb` and `rdp`: report it once.

Reports in English or Spanish are both fine.
