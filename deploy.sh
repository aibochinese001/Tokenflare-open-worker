#!/usr/bin/env bash
# One-shot deploy for keypool-gateway. Run AFTER `npx wrangler login`.
#   ./deploy.sh
# Idempotent: reuses the D1 db if it already exists.
set -euo pipefail
cd "$(dirname "$0")"

DB_NAME="llm-gateway"
WR="npx wrangler"

echo "==> 0/5 verify auth"
$WR whoami >/dev/null

echo "==> 1/5 ensure D1 database '$DB_NAME'"
DB_ID="$($WR d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const m=a.find(x=>x.name==="'"$DB_NAME"'");process.stdout.write(m?m.uuid:"")}catch(e){process.stdout.write("")}})')"
if [ -z "$DB_ID" ]; then
  echo "    creating..."
  $WR d1 create "$DB_NAME" >/dev/null
  DB_ID="$($WR d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m=a.find(x=>x.name==="'"$DB_NAME"'");process.stdout.write(m?m.uuid:"")})')"
fi
echo "    database_id=$DB_ID"

echo "==> 2/5 write database_id into wrangler.toml"
# replace the placeholder OR an existing id
node -e '
const fs=require("fs");const f="wrangler.toml";let t=fs.readFileSync(f,"utf8");
t=t.replace(/database_id = "[^"]*"/,"database_id = \"'"$DB_ID"'\"");
fs.writeFileSync(f,t);'

echo "==> 3/5 apply schema to remote D1"
$WR d1 execute "$DB_NAME" --remote --file=./schema.sql -y >/dev/null
echo "    schema applied"

echo "==> 4/5 set ADMIN_TOKEN secret"
if [ -f .admin-token.txt ]; then
  tr -d '\n' < .admin-token.txt | $WR secret put ADMIN_TOKEN
else
  echo "    .admin-token.txt missing — run: npx wrangler secret put ADMIN_TOKEN"
fi

echo "==> 5/5 deploy"
$WR deploy

echo
echo "DONE. Open the printed *.workers.dev URL, paste the ADMIN_TOKEN, import your keys."
