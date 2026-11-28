# Install Rackpath

Rackpath is one container with its data in one SQLite file. Anything that runs
Docker can run it: a small Linux VM, a NAS, a Proxmox container.

## What you need

- A Linux server with **Docker** and **Docker Compose v2** (the
  `docker compose` command). Install them from
  <https://docs.docker.com/engine/install/>.
- About 200 MB of disk for the image, plus room for your data (usually a
  few megabytes, more with floor plan images).
- A free port for Rackpath (8080 by default), or ports 80 and 443 if you
  choose the built-in HTTPS.

## Option 1: the install script (recommended)

On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
```

The script:

1. creates a `rackpath/` folder with `docker-compose.yml` and `.env`;
2. writes a new **encryption key** into `.env` (it encrypts the passwords
   and API keys Rackpath stores for integrations and SNMP);
3. asks **how people will reach Rackpath** (see [HTTPS](#choosing-https));
4. checks that the ports are free and suggests others if they aren't;
5. starts Rackpath and prints the **first password** for the `admin` user.

You can run it again at any time: it keeps your `.env` and key and lets you
change your answers.

> **Back up `.env`.** Without the encryption key, stored integration and
> SNMP credentials can't be read; you'd have to enter them again.

## Option 2: from a clone of the repository

Use this if you want to build from the code or follow the latest changes:

```bash
git clone https://github.com/Stevy2191/Rackpath.git
cd Rackpath
sudo ./update.sh
```

The first run writes `.env` with a new key, builds the image and starts it.
Add `--image` to use the published image instead of building (much quicker
on a small server). Set the port and other settings in `.env`, then run
`sudo ./update.sh --no-pull` to apply them.

## Option 3: by hand

```bash
mkdir rackpath && cd rackpath
curl -fsSLO https://raw.githubusercontent.com/Stevy2191/Rackpath/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/.env.example -o .env
sed -i "s/^RACKPATH_ENCRYPTION_KEY=.*/RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
docker compose up -d
docker compose logs rackpath | grep password
```

## Choosing HTTPS

The install script asks which of these you want:

| Choice | When to use it | What happens |
|---|---|---|
| **Caddy, self-signed** | You don't have a reverse proxy | A Caddy container serves HTTPS on 443 (80 redirects). Rackpath itself only listens on `127.0.0.1`. Browsers warn until you trust Caddy's certificate authority (below). |
| **Your own proxy** | You run Nginx Proxy Manager, Traefik or similar | Point the proxy at `http://<server>:<port>` and give it your certificate. Let only the proxy reach that port (firewall rule). |
| **Plain HTTP** | Testing only | Passwords travel unencrypted. |

### Trusting Caddy's certificate

To stop browser warnings with the Caddy option, copy Caddy's root
certificate off the server:

```bash
cd rackpath
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt rackpath-ca.crt
```

Install `rackpath-ca.crt` as a **trusted root certificate** on the computers
that use Rackpath: by hand, or for a whole domain through Group Policy
(*Computer Configuration → Policies → Windows Settings → Security Settings →
Public Key Policies → Trusted Root Certification Authorities*).

### Behind your own proxy

- In the proxy, forward to `http://<server>:<RACKPATH_PORT>` and turn on
  websockets if offered (not required today, harmless).
- The script sets `RACKPATH_TRUST_PROXY=true`, `RACKPATH_COOKIE_SECURE=true`
  and `RACKPATH_PUBLIC_URL` to the HTTPS address you gave.
- Make sure only the proxy can reach Rackpath's port, because Rackpath
  trusts the client address the proxy sends.

## Settings

Settings live in `.env` next to `docker-compose.yml`. After changing one, run
`docker compose up -d` (or `sudo ./update.sh --no-pull` in a clone).

| Setting | Default | What it does |
|---|---|---|
| `RACKPATH_ENCRYPTION_KEY` | required | 64 hex characters. Encrypts stored credentials. Back it up. |
| `RACKPATH_PORT` | `8080` | The port on the server |
| `RACKPATH_BIND_ADDRESS` | `0.0.0.0` | Which address the port is published on (`127.0.0.1` with Caddy) |
| `RACKPATH_HTTPS_MODE` | `http` | `caddy`, `proxy` or `http` |
| `RACKPATH_HOSTNAME` | | Caddy: the name or IP the certificate is for |
| `RACKPATH_PUBLIC_URL` | | The address people use; used in invitation links and report QR codes |
| `RACKPATH_COOKIE_SECURE` | `false` | `true` when reached over HTTPS |
| `RACKPATH_TRUST_PROXY` | `false` | `true` behind a reverse proxy |
| `RACKPATH_AUDIT_RETENTION_DAYS` | forever | Delete change history older than this many days |

## First sign-in

1. Open Rackpath in a browser (the address the script printed).
2. Sign in as **admin** with the first password from the install output. If
   you lost it: `docker compose logs rackpath | grep password`.
3. Choose your own password (at least 10 characters).

Next: [First steps](first-steps.md).

## Network discovery and the container

Rackpath's optional [network discovery](discovery.md) sends ping from the
container. `docker-compose.yml` already includes the one setting it needs:

```yaml
    sysctls:
      net.ipv4.ping_group_range: "0 2147483647"
```

It lets the container's non-root user open ping sockets, inside the
container only. No extra capabilities are added. If you run Rackpath with
`docker run`, add `--sysctl net.ipv4.ping_group_range="0 2147483647"`.
