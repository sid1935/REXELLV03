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
sudo -u rexell git -C "$REPO" pull --ff-only
sudo -u rexell git -C "$REPO" log --oneline -1

say "Building"
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
