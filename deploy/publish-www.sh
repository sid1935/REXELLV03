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

# Run from a snapshot, because this script updates itself.
#
# bash reads a script as it executes rather than all at once, and the pull
# below replaces this very file partway through. Left alone, an edit that
# changes the line count means the shell resumes at a byte offset that now
# points into the middle of a different statement, and fails in whatever way
# the new bytes happen to parse — halfway through a deploy.
#
# Copying to a temp file and re-running from there costs nothing and removes
# the whole class. It also means a deploy runs the version of this script
# that was on disk when it started, which is the version somebody reviewed.
if [[ "${REXELL_DEPLOY_SNAPSHOT:-}" != "1" ]]; then
  snapshot=$(mktemp /tmp/rexell-deploy.XXXXXX.sh)
  cp "$0" "$snapshot"
  trap 'rm -f "$snapshot"' EXIT
  REXELL_DEPLOY_SNAPSHOT=1 bash "$snapshot" "$@"
  exit $?
fi

say "Updating the checkout"
before=$(sudo -u rexell git -C "$REPO" rev-parse HEAD)
sudo -u rexell git -C "$REPO" pull --ff-only
sudo -u rexell git -C "$REPO" log --oneline -1

cd "$REPO"

# Every time, not only when the lockfile moved.
#
# The build needs TypeScript and the prune below removes it again, so the tree
# this deploy inherits never has a compiler in it. Skipping the install because
# the lockfile happens to be unchanged would therefore fail at `npm run build`
# on every deploy after the first. About a minute, and the alternative is a
# production host carrying a Solidity compiler and a browser test framework.
say "Installing"
sudo -u rexell npm ci --ignore-scripts

# The API and the vault are compiled TypeScript, and this script used to skip
# them entirely — it published the web root and stopped. The result was a front
# end a day ahead of the API it was calling: recovery codes had shipped in the
# browser while the running server was still on the build from before the
# migration that stores them, and the only symptom was a field coming back
# undefined. Everything served from this host is now built and restarted
# together.
say "Compiling the services"
sudo -u rexell npm run build

# What is left behind matters as much as what runs.
#
# The monorepo's dev dependencies include Hardhat — a Solidity compiler and an
# EVM — and Playwright, which given the chance downloads a browser. None of it
# is reachable from `apps/api/dist` or `apps/vault/dist`; the services run
# plain node against compiled output and every runtime dependency is declared
# as one. So it is removed once the build no longer needs it, and the host is
# left holding what it actually serves.
say "Pruning development dependencies"
before_prune=$(du -sm "$REPO/node_modules" 2>/dev/null | cut -f1 || echo '?')
sudo -u rexell npm prune --omit=dev
after_prune=$(du -sm "$REPO/node_modules" 2>/dev/null | cut -f1 || echo '?')
echo "  node_modules ${before_prune}MB -> ${after_prune}MB"

say "Restarting the services"
# The vault first: the API answers enrolment with a 503 without it, and the
# order that is merely untidy on a laptop is a visible error to somebody
# mid-signup.
systemctl restart rexell-vault
sleep 2
systemctl restart rexell-api
sleep 3
systemctl is-active rexell-vault rexell-api | tr '\n' ' '; echo

# The gate on the prune above.
#
# Removing packages from under a running service is the one step here that can
# take the site down, and "it restarted" is not the same as "it works" — a
# missing module fails at the first import, and a service that exits straight
# away can still be reported active for a moment. So the API is asked, on
# loopback, before anything else proceeds; and if it cannot answer, the
# dependencies go back and the services restart on the tree that had them.
say "Checking the API answers"
api_ok=0
for i in $(seq 1 15); do
  if curl -sf -m 5 http://127.0.0.1:8080/health > /dev/null 2>&1; then
    api_ok=1
    echo "  healthy after ${i}s"
    break
  fi
  sleep 1
done

if [[ "$api_ok" -ne 1 ]]; then
  echo "" >&2
  echo "  The API did not answer after the prune. Restoring every dependency." >&2
  journalctl -u rexell-api -n 20 --no-pager -o cat >&2 || true
  sudo -u rexell npm ci --ignore-scripts
  sudo -u rexell npm run build
  systemctl restart rexell-vault
  sleep 2
  systemctl restart rexell-api
  sleep 3
  if curl -sf -m 5 http://127.0.0.1:8080/health > /dev/null 2>&1; then
    echo "  Restored. The web root was not touched, so nothing was published." >&2
  else
    echo "  STILL DOWN after restoring. This needs a person." >&2
  fi
  exit 1
fi

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
