#!/usr/bin/env bash
#
# Bring up ReXell on a fresh Ubuntu 22.04 or 24.04 host.
#
#   sudo bash bootstrap.sh <repo-url> <api-hostname>
#
# e.g.
#   sudo bash bootstrap.sh https://github.com/you/rexell.git api-you.duckdns.org
#
# Installs Node and Caddy, creates the service user, builds, generates the
# secrets, installs the five units, and starts everything behind TLS.
#
# Safe to run twice: every step checks before it acts, and it will not
# overwrite an environment file that already exists — that file holds
# VAULT_MASTER_KEY, and regenerating it makes every enrolled template
# unreadable.
#
# NOTE: this script has not been run end to end on a real host. Each command
# in it is standard and the pieces have been exercised individually, but treat
# the first run as something to watch rather than walk away from.

set -euo pipefail

REPO="${1:-}"
API_HOST="${2:-}"

if [[ -z "$REPO" || -z "$API_HOST" ]]; then
  echo "usage: sudo bash bootstrap.sh <repo-url> <api-hostname>" >&2
  echo "e.g.   sudo bash bootstrap.sh https://github.com/you/rexell.git api-you.duckdns.org" >&2
  exit 2
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

say() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

# ─── packages ───────────────────────────────────────────────────────────────
say "Installing Node 24, Caddy and git"
apt-get update -qq

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

apt-get install -y git
echo "node $(node -v), caddy $(caddy version | head -1)"

# ─── the firewall Oracle images ship ────────────────────────────────────────
# Oracle's Ubuntu images carry iptables rules that drop 80 and 443 regardless
# of what the cloud console says. Opening the console's security list is not
# enough on its own, and this is where most first attempts stall.
say "Opening ports 80 and 443 on the host firewall"
for port in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save >/dev/null
else
  apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  netfilter-persistent save >/dev/null 2>&1 || true
fi
echo "80 and 443 accepted (the cloud console security list must allow them too)"

# ─── user and directories ───────────────────────────────────────────────────
say "Creating the rexell service user"
id -u rexell >/dev/null 2>&1 || useradd --system --home /srv/rexell --shell /usr/sbin/nologin rexell
mkdir -p /srv/rexell /var/lib/rexell /etc/rexell /var/backups/rexell
chown rexell:rexell /srv/rexell /var/lib/rexell /var/backups/rexell

# ─── code ───────────────────────────────────────────────────────────────────
say "Fetching and building"
if [[ -d /srv/rexell/.git ]]; then
  sudo -u rexell git -C /srv/rexell pull --ff-only
else
  # The directory exists and is owned by rexell, so clone into it rather than
  # over it.
  sudo -u rexell git clone "$REPO" /srv/rexell
fi

cd /srv/rexell
sudo -u rexell npm ci
sudo -u rexell npm run build

# ─── secrets ────────────────────────────────────────────────────────────────
ENV_FILE=/etc/rexell/rexell.env

if [[ -f "$ENV_FILE" ]]; then
  say "Keeping the existing $ENV_FILE"
  echo "Not regenerating: VAULT_MASTER_KEY cannot be rotated without making"
  echo "every enrolled template unreadable."
else
  say "Generating secrets into $ENV_FILE"
  {
    node scripts/gen-secrets.js
    echo ""
    echo "PUBLIC_API_HOST=${API_HOST}"
    echo "REXELL_API=https://${API_HOST}"
    echo ""
    echo "# Set these if you also serve the surfaces from this host rather"
    echo "# than from Netlify, then add their blocks to /etc/caddy/Caddyfile."
    echo "# PUBLIC_FAN_HOST=tickets.example.com"
    echo "# PUBLIC_CONSOLE_HOST=organizers.example.com"
    echo "# PUBLIC_SCANNER_HOST=gate.example.com"
  } > "$ENV_FILE"
  chown root:rexell "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# ─── services ───────────────────────────────────────────────────────────────
say "Installing the systemd units"
cp deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rexell-vault rexell-api
echo "vault and api enabled (the three surfaces are on Netlify by default)"

# ─── TLS ────────────────────────────────────────────────────────────────────
say "Configuring Caddy for ${API_HOST}"
# Only the API block: the surfaces live on Netlify unless you add their hosts.
cat > /etc/caddy/Caddyfile <<CADDY
${API_HOST} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}
	reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl restart caddy

# ─── backups ────────────────────────────────────────────────────────────────
say "Installing the daily backup job"
cat > /etc/cron.daily/rexell-backup <<'SH'
#!/bin/sh
cd /srv/rexell && \
REXELL_DB=/var/lib/rexell/rexell.sqlite \
VAULT_DB=/var/lib/rexell/vault.sqlite \
/usr/bin/node scripts/backup.js /var/backups/rexell
SH
chmod +x /etc/cron.daily/rexell-backup

# ─── report ─────────────────────────────────────────────────────────────────
say "Done. Checking."
sleep 4
systemctl --no-pager --lines=0 status rexell-vault rexell-api 2>&1 | grep -E "^●|Active:" || true

echo ""
if curl -fsS --max-time 10 "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
  echo "  API is answering locally."
else
  echo "  API is NOT answering. Look at:  journalctl -u rexell-api -n 40 --no-pager"
fi

echo ""
echo "  Public check (needs DNS pointing here, and may take a minute for the certificate):"
echo "    curl https://${API_HOST}/health"
echo ""
echo "  Your organizer invite token — the Netlify console needs it:"
grep '^SIGNUP_INVITE_TOKEN=' "$ENV_FILE" | sed 's/^SIGNUP_INVITE_TOKEN=/    /'
echo ""
echo "  Then set on each Netlify site:  REXELL_API=https://${API_HOST}"
echo ""
