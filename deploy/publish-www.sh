#!/usr/bin/env bash
#
# Build the browser surfaces and publish them for Caddy to serve.
#
#   sudo bash /srv/rexell/deploy/publish-www.sh
#
# This is the deploy. There is no build service and no minute allowance: the
# host already has the repository and Node, and the output is a directory of
# static files that Caddy serves off disk.
#
# Safe to run any time. The API and the vault are untouched — they are
# separate processes, and this only replaces files under the web root.

set -euo pipefail

REPO="${REPO:-/srv/rexell}"
WWW="${WWW:-/srv/rexell-www}"
: "${PUBLIC_HOST:?PUBLIC_HOST must be set, e.g. rexell.duckdns.org}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

say() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

say "Updating the checkout"
before=$(sudo -u rexell git -C "$REPO" rev-parse HEAD)
sudo -u rexell git -C "$REPO" pull --ff-only
sudo -u rexell git -C "$REPO" log --oneline -1

cd "$REPO"

# Dependencies, only when the lockfile actually moved.
if ! sudo -u rexell git -C "$REPO" diff --quiet "$before" HEAD -- package-lock.json 2>/dev/null; then
  say "Lockfile changed — installing"
  sudo -u rexell npm ci --ignore-scripts
fi

# The API and the vault are compiled TypeScript, and this script used to skip
# them entirely — it published the web root and stopped. The result was a front
# end a day ahead of the API it was calling: recovery codes had shipped in the
# browser while the running server was still on the build from before the
# migration that stores them, and the only symptom was a field coming back
# undefined. Everything served from this host is now built and restarted
# together.
say "Compiling the services"
sudo -u rexell npm run build

say "Restarting the services"
# The vault first: the API answers enrolment with a 503 without it, and the
# order that is merely untidy on a laptop is a visible error to somebody
# mid-signup.
systemctl restart rexell-vault
sleep 2
systemctl restart rexell-api
sleep 3
systemctl is-active rexell-vault rexell-api | tr '\n' ' '; echo

say "Building the browser surfaces"
# The site surface carries the other three mounted under paths, so one build
# produces the whole browser-facing product.
cd "$REPO"
sudo -u rexell env REXELL_API="https://${PUBLIC_HOST}" node scripts/build-netlify.js site

say "Publishing to ${WWW}"
# Into a staging directory and then swapped, so a visitor mid-request never
# sees a half-written web root.
STAGE="${WWW}.new"
rm -rf "$STAGE"
cp -a "${REPO}/dist" "$STAGE"

# _headers and _redirects are instructions to a static host that is not
# running here; Caddy owns that job and reads its own config.
rm -f "$STAGE/_headers" "$STAGE/_redirects"

chown -R rexell:rexell "$STAGE"
chmod -R a+rX "$STAGE"

if [[ -d "$WWW" ]]; then
  rm -rf "${WWW}.old"
  mv "$WWW" "${WWW}.old"
fi
mv "$STAGE" "$WWW"
rm -rf "${WWW}.old"

say "Checking"
for path in / /join /app/ /console/ /gate/ /config.js /health; do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://${PUBLIC_HOST}${path}" || echo 000)
  printf '  %-12s %s\n' "$path" "$code"
done

echo ""
echo "  Published $(find "$WWW" -type f | wc -l) files to ${WWW}"
