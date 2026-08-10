#!/usr/bin/env bash
# scripts/setup-ci.sh
#
# One-time CI setup: discovers existing Cloudflare resources from your account (using your
# already-authenticated wrangler) and sets all required GitHub Actions secrets.
#
# Prerequisites:
#   - wrangler authenticated:  pnpm exec wrangler whoami
#   - gh CLI authenticated:    gh auth status
#
# Usage:
#   bash scripts/setup-ci.sh \
#     --account-id  <your-CF-account-id>  \
#     --api-token   <CF-api-token>        \
#     --public-base-url https://your-os-url.workers.dev
#
# The API token needs: Workers Scripts:Edit, Workers KV Storage:Edit,
#                      Workers R2 Storage:Edit, Workers AI:Read
#
# After this script runs, push any commit to main and the deploy workflow fires.

set -euo pipefail
REPO="boisejosh/cloudflare-os"

usage() {
  echo "Usage: $0 --account-id <id> --api-token <token> --public-base-url <url>"
  exit 1
}

CF_ACCOUNT_ID=""
CF_API_TOKEN=""
PUBLIC_BASE_URL=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --account-id)     CF_ACCOUNT_ID="$2";    shift 2 ;;
    --api-token)      CF_API_TOKEN="$2";     shift 2 ;;
    --public-base-url) PUBLIC_BASE_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$CF_ACCOUNT_ID"  ]] && usage
[[ -z "$CF_API_TOKEN"   ]] && usage
[[ -z "$PUBLIC_BASE_URL" ]] && usage

PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"  # strip trailing slash

echo "=== Cloudflare OS — CI Setup ==="
echo "Account ID:      $CF_ACCOUNT_ID"
echo "Public Base URL: $PUBLIC_BASE_URL"
echo ""

# ---------------------------------------------------------------------------
# 1. Ensure KV namespaces exist and get their IDs
# ---------------------------------------------------------------------------
echo "--- KV namespaces ---"

get_or_create_kv() {
  local title="$1"
  # List existing namespaces, find by title.
  local existing
  existing=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
    pnpm exec wrangler kv namespace list --json 2>/dev/null \
    | grep -o "\"title\":\"${title}\"[^}]*\"id\":\"[^\"]*\"" \
    | grep -o '"id":"[^"]*"' \
    | head -1 \
    | sed 's/"id":"//;s/"//' || true)

  # Try alternate field order
  if [[ -z "$existing" ]]; then
    existing=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
      pnpm exec wrangler kv namespace list --json 2>/dev/null | \
      node -e "
        const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const ns=d.find(n=>n.title==='${title}');
        process.stdout.write(ns?ns.id:'');
      " || true)
  fi

  if [[ -n "$existing" ]]; then
    echo "  ✓ $title already exists: $existing"
    echo "$existing"
  else
    echo "  + Creating KV namespace: $title"
    local new_id
    new_id=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
      pnpm exec wrangler kv namespace create "$title" --json 2>/dev/null | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(d.id||d.result?.id||'');")
    echo "  ✓ Created: $new_id"
    echo "$new_id"
  fi
}

# KV namespace names must be globally unique per account — prefix with "gadgets-" by convention.
KV_BLUEPRINTS_ID=$(get_or_create_kv "gadgets-blueprint-metadata" | tail -1)
KV_AVATARS_ID=$(get_or_create_kv "gadgets-avatars" | tail -1)

echo ""
echo "  KV_BLUEPRINTS_ID=$KV_BLUEPRINTS_ID"
echo "  KV_AVATARS_ID=$KV_AVATARS_ID"
[[ -z "$KV_BLUEPRINTS_ID" ]] && echo "ERROR: could not get/create BLUEPRINTS KV namespace" && exit 1
[[ -z "$KV_AVATARS_ID"    ]] && echo "ERROR: could not get/create AVATARS KV namespace"    && exit 1

# ---------------------------------------------------------------------------
# 2. Ensure R2 bucket exists
# ---------------------------------------------------------------------------
echo ""
echo "--- R2 bucket ---"
R2_BUCKET_NAME="gadgets-blueprint-content"

bucket_exists=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
  pnpm exec wrangler r2 bucket list --json 2>/dev/null | \
  node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(d.some(b=>b.name==='${R2_BUCKET_NAME}')?'yes':'no');
  " || echo "no")

if [[ "$bucket_exists" == "yes" ]]; then
  echo "  ✓ R2 bucket already exists: $R2_BUCKET_NAME"
else
  echo "  + Creating R2 bucket: $R2_BUCKET_NAME"
  CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
    pnpm exec wrangler r2 bucket create "$R2_BUCKET_NAME"
  echo "  ✓ Created: $R2_BUCKET_NAME"
fi

# ---------------------------------------------------------------------------
# 3. Set GitHub Actions secrets
# ---------------------------------------------------------------------------
echo ""
echo "--- GitHub Actions secrets → $REPO ---"

set_secret() {
  local name="$1"
  local value="$2"
  echo "  ↑ $name"
  echo -n "$value" | gh secret set "$name" --repo "$REPO"
}

set_secret "CF_ACCOUNT_ID"          "$CF_ACCOUNT_ID"
set_secret "CF_API_TOKEN"           "$CF_API_TOKEN"
set_secret "PUBLIC_BASE_URL"        "$PUBLIC_BASE_URL"
set_secret "KV_BLUEPRINTS_ID"      "$KV_BLUEPRINTS_ID"
set_secret "KV_AVATARS_ID"         "$KV_AVATARS_ID"
set_secret "R2_BLUEPRINT_CONTENT"  "$R2_BUCKET_NAME"

echo ""
echo "✅ Setup complete. Secrets set:"
gh secret list --repo "$REPO"

echo ""
echo "To deploy now: gh workflow run deploy.yml --repo $REPO"
echo "Or: push any commit to main and the deploy workflow fires automatically."
