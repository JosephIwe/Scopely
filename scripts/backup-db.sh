#!/usr/bin/env bash
# Manual logical backup of the production database (docs/OPERATIONS.md, "Backups").
#
# Run it on YOUR OWN machine, from a folder linked to the Railway project (`railway link`), before
# every migration and at least weekly during validation. It needs the Railway CLI (logged in, with
# an SSH key registered), openssl and sha256sum or shasum. Nothing is installed or changed on Railway.
#
# What happens:
#   1. Inside the Postgres service, pg_dump writes a custom-format (compressed) dump to that
#      container's /tmp, pg_restore --list checks it is a readable archive, its sha256 is printed,
#      and it is streamed back as base64 and deleted from the container.
#   2. Here, the stream is decoded, its sha256 compared with the one computed in Railway, and the
#      dump encrypted with a passphrase you type (AES-256, PBKDF2). The plain dump is then deleted.
#
# It never prints the database URL, a password or any row. The connection uses the PG* variables
# that already exist inside the Postgres service; DATABASE_URL is not read or changed.
#
# Usage: scripts/backup-db.sh [output-folder]       (default ./scopely-backups)
# Env:   SCOPELY_PG_SERVICE   Railway service name of the database (default Postgres)
#        SCOPELY_BACKUP_PASSFILE  read the passphrase from this file instead of prompting
#        SCOPELY_BACKUP_REMOTE    test hook: the command that runs the remote side (default
#                                 `railway ssh --service <service> --`)
set -euo pipefail
umask 077

out_dir="${1:-./scopely-backups}"
service="${SCOPELY_PG_SERVICE:-Postgres}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out_dir"
plain="$out_dir/.scopely-$stamp.dump.partial"
enc="$out_dir/scopely-$stamp.dump.enc"
trap 'rm -f "$plain" "$plain.b64" "$plain.err"' EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
b64decode() { if base64 -d </dev/null >/dev/null 2>&1; then base64 -d; else base64 -D; fi; }

remote='set -e; f=$(mktemp /tmp/scopely-XXXXXX.dump); trap "rm -f $f" EXIT; pg_dump --format=custom --compress=6 "$PGDATABASE" > "$f"; pg_restore --list "$f" > /dev/null; echo "remote-sha256 $(sha256sum "$f" | cut -d" " -f1) entries $(pg_restore --list "$f" | grep -vc "^;") pg_dump $(pg_dump --version | grep -o "[0-9][0-9.]*" | head -1)" >&2; base64 "$f"'

echo "Dumping from Railway service '$service' (nothing is changed there)..."
rc=0
if [ -n "${SCOPELY_BACKUP_REMOTE:-}" ]; then
  $SCOPELY_BACKUP_REMOTE "$remote" > "$plain.b64" 2> "$plain.err" || rc=$?
else
  railway ssh --service "$service" -- "$remote" > "$plain.b64" 2> "$plain.err" || rc=$?
fi

summary="$(grep -o 'remote-sha256 .*' "$plain.err" | tail -1 || true)"
if [ "$rc" -ne 0 ] || [ -z "$summary" ]; then
  echo "The remote dump did not complete. Its error output (no data) follows:" >&2
  grep -v -i 'password\|postgres://\|postgresql://' "$plain.err" >&2 || true
  exit 1
fi
remote_sha="$(echo "$summary" | awk '{print $2}')"

tr -d '\r' < "$plain.b64" | b64decode > "$plain"
local_sha="$(sha256 "$plain")"
if [ "$local_sha" != "$remote_sha" ]; then
  echo "Checksum mismatch: the dump was damaged in transfer. Nothing was kept; run it again." >&2
  exit 1
fi
echo "Transfer verified: $summary"

if [ -n "${SCOPELY_BACKUP_PASSFILE:-}" ]; then pass=(-pass "file:$SCOPELY_BACKUP_PASSFILE"); else pass=(); echo "Choose a passphrase (store it in your password manager; without it the backup cannot be restored):"; fi
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$plain" -out "$enc" ${pass[@]+"${pass[@]}"}
printf '%s  %s\n' "$local_sha" "$(basename "$enc" .enc) (sha256 of the decrypted dump)" > "$enc.sha256"
rm -f "$plain"

echo "Backup written: $enc"
echo "Checksum file:  $enc.sha256"
echo "Copy BOTH to a second place you control that is not Railway (an encrypted drive or a private cloud folder)."
