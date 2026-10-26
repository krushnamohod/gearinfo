#!/bin/bash
# GearInfo launcher for macOS.
# Double-click this file in Finder (or run ./start.command in Terminal).
# It sets up everything on first run, then starts the app and opens your browser.
# Written for the bash 3.2 that ships with macOS.

set -e
cd "$(dirname "$0")"

say()  { printf '\033[1;33m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$1"; echo; read -r -p "Press Enter to close..." _; exit 1; }

# 1. Find Python 3.10 or newer (Homebrew / python.org versions first, then the system one).
PYTHON=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  fail "Python 3.10+ is required. Install it from https://www.python.org/downloads/ or with 'brew install python', then run this again."
fi
say "Using $($PYTHON --version)"

# 2. Create the virtual environment. Recreate it if it is broken or was copied
#    from another machine (e.g. a Linux .venv), since those don't run on a Mac.
if [ -d .venv ] && ! .venv/bin/python -c 'import sys' >/dev/null 2>&1; then
  say "Existing .venv doesn't work on this machine - recreating it"
  rm -rf .venv
fi
if [ ! -d .venv ]; then
  say "Creating virtual environment"
  "$PYTHON" -m venv .venv || fail "Couldn't create the virtual environment."
fi

# 3. Install dependencies, only when requirements.txt changed since the last install.
REQ_HASH=$(shasum -a 256 requirements.txt 2>/dev/null || sha256sum requirements.txt)
REQ_HASH=${REQ_HASH%% *}
if [ "$(cat .venv/.requirements-hash 2>/dev/null)" != "$REQ_HASH" ]; then
  say "Installing dependencies (first run takes a minute)"
  .venv/bin/python -m pip install --quiet --upgrade pip
  .venv/bin/python -m pip install --quiet -r requirements.txt || fail "Dependency installation failed."
  echo "$REQ_HASH" > .venv/.requirements-hash
fi

# 4. Make sure a Gemini API key is configured.
if ! grep -qE '^GEMINI_API_KEY=.+' .env 2>/dev/null; then
  echo
  echo "A Gemini API key is needed. Get one at https://aistudio.google.com/apikey"
  read -r -s -p "Paste your Gemini API key (input hidden): " KEY
  echo
  [ -n "$KEY" ] || fail "No key entered."
  (umask 077; echo "GEMINI_API_KEY=$KEY" >> .env)
  say "Saved key to .env"
fi

# 5. Pick a free port, starting at 8000.
PORT=8000
while ! .venv/bin/python -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1', $PORT))" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
URL="http://127.0.0.1:$PORT"

# 6. Open the browser once the server answers.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$URL"; then
      if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 || true; fi
      exit 0
    fi
    sleep 0.5
  done
) &

say "GearInfo running at $URL - press Ctrl+C (or close this window) to stop"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
