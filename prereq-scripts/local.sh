#!/usr/bin/env bash
# One-command local dev bootstrap: `npm run local`
#
# Brings up MongoDB in Docker, initializes the Mongo replica set
# (one-time, required for transactional flows: online-orders, wallets,
# users, addresses, consents, ratings, pos_orders), makes sure a .env
# exists, starts the Firebase Auth + Storage emulators when .env points at
# one, opens a public tunnel when Xendit is switched on (so invoice webhooks
# can reach localhost), and starts the dev server.
#
# Media storage is NOT a container: local uploads go to the Firebase Storage
# Emulator (started with Auth by ../scripts/emulator.sh), so local dev runs
# the same provider that ships. The old Docker MinIO container is gone.
#
# Everything it starts is stopped again on Ctrl+C, so this is the only
# command you need for local dev.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Read one var out of .env without sourcing the file — .env holds secrets and
# unquoted values, neither of which should ever be executed as shell.
# An absent key is normal, so the failing grep must not trip `set -e`.
env_get() {
  { grep -E "^$1=" .env 2>/dev/null || true; } |
    tail -1 | cut -d= -f2- | tr -d '"'"'"' \t\r'
}

TUNNEL_PID=""
EMULATOR_PID=""
CLEANED=""
cleanup() {
  # Ctrl+C fires the INT trap and then the EXIT trap, so without this guard
  # every shutdown message prints twice.
  [[ -n "$CLEANED" ]] && return
  CLEANED="yes"

  if [[ -n "$TUNNEL_PID" ]]; then
    echo ""
    echo "Stopping tunnel (pid $TUNNEL_PID)..."
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ -n "$EMULATOR_PID" ]]; then
    echo ""
    echo "Stopping Firebase emulators (pid $EMULATOR_PID)..."
    # SIGTERM, then wait: the emulator writes --export-on-exit on a clean
    # shutdown, so returning before it finishes would lose both the test
    # accounts and every uploaded file.
    kill "$EMULATOR_PID" 2>/dev/null || true
    wait "$EMULATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "  -> Fill in FIREBASE_WEB_API_KEY and RESEND_API_KEY (ask a teammate or check the team password manager)."
fi

echo "Starting MongoDB..."
docker compose up -d

echo "Waiting for MongoDB..."
until docker exec lalaba-mongo mongosh --quiet --eval "db.runCommand('ping').ok" >/dev/null 2>&1; do
  sleep 1
done

RS_OK="$(docker exec lalaba-mongo mongosh --quiet --eval "try { rs.status().ok } catch(e) { 0 }")"
if [[ "$RS_OK" != "1" ]]; then
  echo "Initializing MongoDB replica set (one-time)..."
  docker exec lalaba-mongo mongosh --quiet --eval "rs.initiate()" >/dev/null
fi

if [[ ! -f firebase-adminsdk.json ]]; then
  echo "⚠️  firebase-adminsdk.json not found at repo root — ask a teammate for it before you'll be able to log in."
fi

# --- Firebase Auth + Storage emulators -------------------------------------
# When .env points auth at an emulator, the server starts happily whether or
# not one is listening — the failure only shows up later as every token verify
# rejecting. So bring it up here rather than leaving it to a second terminal.
# The emulator itself is configured by the workspace's scripts/emulator.sh
# (fixed project id, auth + storage, account/file import/export); this only
# launches and waits. Storage rides along on the same process, which is why
# there is no separate wait for :9199 — and why media uploads work locally
# without any container.
AUTH_EMULATOR_HOST="$(env_get FIREBASE_AUTH_EMULATOR_HOST)"

if [[ -n "$AUTH_EMULATOR_HOST" ]]; then
  EMULATOR_PORT="${AUTH_EMULATOR_HOST##*:}"
  EMULATOR_SCRIPT="$ROOT_DIR/../scripts/emulator.sh"

  if lsof -tiTCP:"$EMULATOR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    # Already running — someone's separate terminal owns it, so leave it alone
    # (killing it on our exit would take down a session we didn't start).
    echo "Firebase emulators already running on :${EMULATOR_PORT}."
  elif [[ ! -f "$EMULATOR_SCRIPT" ]]; then
    echo ""
    echo "⚠️  .env expects an auth emulator at ${AUTH_EMULATOR_HOST}, but"
    echo "   ${EMULATOR_SCRIPT} is missing — run this repo from inside the"
    echo "   Lalaba workspace, or set FIREBASE_AUTH_EMULATOR_HOST= to use real Firebase."
    echo "   Until then every login will fail with an auth error."
    echo ""
  elif ! command -v firebase >/dev/null 2>&1; then
    echo ""
    echo "⚠️  .env expects an auth emulator but the Firebase CLI is not installed,"
    echo "   so every login and media upload will fail."
    echo "   Fix: npm i -g firebase-tools   (or set FIREBASE_AUTH_EMULATOR_HOST= )"
    echo ""
  else
    EMULATOR_LOG="$(mktemp -t lalaba-emulator)"
    echo "Starting Firebase Auth + Storage emulators (auth on :${EMULATOR_PORT})..."
    bash "$EMULATOR_SCRIPT" >"$EMULATOR_LOG" 2>&1 &
    EMULATOR_PID=$!

    EMULATOR_UP=""
    for _ in $(seq 1 60); do
      if lsof -tiTCP:"$EMULATOR_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        EMULATOR_UP="yes"
        break
      fi
      # Bail out early rather than waiting the full 60s if it died (a stale
      # java process holding the port is the usual cause).
      kill -0 "$EMULATOR_PID" 2>/dev/null || break
      sleep 1
    done

    if [[ -n "$EMULATOR_UP" ]]; then
      echo "✅ Auth + Storage emulators ready — UI: http://127.0.0.1:4000"
    else
      EMULATOR_PID=""
      echo ""
      echo "⚠️  Emulators failed to start — see $EMULATOR_LOG"
      echo "   Logins and media uploads will fail until they are up."
      echo ""
    fi
  fi
fi

# --- Xendit webhook tunnel -------------------------------------------------
# Mirrors the gateway binding in wallets.module.ts: the real gateway is used
# when XENDIT_ONLINE=on, or when it is unset and a secret key is present. Only
# then does Xendit need a public URL to POST invoice callbacks back to.
PORT="$(env_get PORT)"
PORT="${PORT:-3001}"
XENDIT_ONLINE="$(env_get XENDIT_ONLINE | tr '[:upper:]' '[:lower:]')"
XENDIT_KEY="$(env_get XENDIT_SECRET_KEY)"

if [[ "$XENDIT_ONLINE" == "on" ]] ||
  { [[ "$XENDIT_ONLINE" != "off" ]] && [[ -n "$XENDIT_KEY" ]]; }; then
  # A stable named tunnel (or any fixed public hostname) makes the throwaway
  # quick tunnel unnecessary — the dashboard URL never changes, so just remind
  # the operator what it is instead of starting anything.
  WEBHOOK_BASE="$(env_get XENDIT_WEBHOOK_BASE_URL)"

  if [[ -n "$WEBHOOK_BASE" ]]; then
    echo ""
    echo "🔗 Xendit webhook URL (fixed, already registered):"
    echo "   ${WEBHOOK_BASE%/}/webhooks/xendit"
    echo ""
  elif ! command -v cloudflared >/dev/null 2>&1; then
    echo ""
    echo "⚠️  Xendit is ON but cloudflared is not installed, so invoice webhooks"
    echo "   cannot reach localhost — top-ups will sit at PENDING forever."
    echo "   Fix: brew install cloudflared   (or set XENDIT_ONLINE=off)"
    echo ""
  else
    TUNNEL_LOG="$(mktemp -t lalaba-tunnel)"
    echo "Starting cloudflared tunnel to localhost:${PORT}..."
    cloudflared tunnel --url "http://localhost:${PORT}" >"$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!

    TUNNEL_URL=""
    for _ in $(seq 1 30); do
      # cloudflared prints the assigned hostname once the edge connection is up.
      TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
      [[ -n "$TUNNEL_URL" ]] && break
      # Bail out early rather than waiting the full 30s if cloudflared died.
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 1
    done

    echo ""
    if [[ -n "$TUNNEL_URL" ]]; then
      echo "🔗 Xendit webhook URL — paste into Xendit dashboard"
      echo "   → Settings → Webhooks → 'Invoices paid':"
      echo ""
      echo "   ${TUNNEL_URL}/webhooks/xendit"
      echo ""
      echo "   ⚠️  This URL is regenerated every restart. Until it is updated in"
      echo "      the dashboard, top-ups stay PENDING with no visible error."
    else
      TUNNEL_PID=""
      echo "⚠️  Tunnel failed to start — see $TUNNEL_LOG"
      echo "   Top-ups will stay PENDING until webhooks can reach localhost."
    fi
    echo ""
  fi
fi

echo "Starting backend..."
# Not `exec` — the shell must outlive the server so the EXIT trap can stop the
# tunnel instead of leaving an orphaned cloudflared behind.
npm run start:dev
