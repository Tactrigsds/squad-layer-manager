#!/bin/bash
set -e # Exit on error
set -u # Exit on undefined variable

# Run by the deploy job in docker-ci.yml. Joins the runner to the tailnet with an ephemeral
# OAuth-minted key, then runs ~/deploy.sh on the deploy host over ssh.

echo "=== Starting Deployment ==="

# Verify required secrets are present
if [ -z "${TAILSCALE_OAUTH_CLIENT_ID:-}" ]; then
    echo "❌ Error: TAILSCALE_OAUTH_CLIENT_ID secret not set"
    exit 1
fi

if [ -z "${TAILSCALE_OAUTH_CLIENT_SECRET:-}" ]; then
    echo "❌ Error: TAILSCALE_OAUTH_CLIENT_SECRET secret not set"
    exit 1
fi

if [ -z "${DEPLOY_TAILSCALE_HOST:-}" ]; then
    echo "❌ Error: DEPLOY_TAILSCALE_HOST secret not set (e.g., 'my-server' or 'my-server.tail1234.ts.net')"
    exit 1
fi

if [ -z "${DEPLOY_USERNAME:-}" ]; then
    echo "❌ Error: DEPLOY_USERNAME secret not set"
    exit 1
fi

if [ -z "${DEPLOY_SSH_KEY:-}" ]; then
    echo "❌ Error: DEPLOY_SSH_KEY secret not set"
    exit 1
fi

# Set port with default fallback
DEPLOY_PORT="${DEPLOY_PORT:-22}"

# Optional: Tailscale tags for ACL control
TAILSCALE_TAGS="${TAILSCALE_TAGS:-tag:slm-ci}"

echo "📡 Setting up Tailscale connection with OAuth..."

# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Ensure jq is installed for JSON parsing
if ! command -v jq &> /dev/null; then
    echo "📦 Installing jq..."
    sudo apt-get update -qq && sudo apt-get install -y -qq jq
fi

# Get OAuth access token
echo "🔐 Obtaining OAuth access token..."
OAUTH_RESPONSE=$(curl -s -f -X POST "https://api.tailscale.com/api/v2/oauth/token" \
    -u "${TAILSCALE_OAUTH_CLIENT_ID}:${TAILSCALE_OAUTH_CLIENT_SECRET}" \
    -d "grant_type=client_credentials" \
    -d "scope=devices:write" 2>&1) || {
    echo "❌ Error: Failed to obtain OAuth access token"
    echo "Response: $OAUTH_RESPONSE"
    exit 1
}

ACCESS_TOKEN=$(echo "$OAUTH_RESPONSE" | jq -r '.access_token // empty')

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" == "null" ]; then
    echo "❌ Error: Failed to parse access token from response"
    echo "Response: $OAUTH_RESPONSE"
    exit 1
fi

echo "✅ OAuth access token obtained"

# Create an ephemeral auth key using the OAuth token
echo "🔑 Creating ephemeral auth key..."
AUTH_KEY_RESPONSE=$(curl -s -f -X POST "https://api.tailscale.com/api/v2/tailnet/-/keys" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
        \"capabilities\": {
            \"devices\": {
                \"create\": {
                    \"reusable\": false,
                    \"ephemeral\": true,
                    \"preauthorized\": true,
                    \"tags\": [\"${TAILSCALE_TAGS}\"]
                }
            }
        },
        \"expirySeconds\": 3600
    }" 2>&1) || {
    echo "❌ Error: Failed to create auth key"
    echo "Response: $AUTH_KEY_RESPONSE"
    exit 1
}

AUTH_KEY=$(echo "$AUTH_KEY_RESPONSE" | jq -r '.key // empty')

if [ -z "$AUTH_KEY" ] || [ "$AUTH_KEY" == "null" ]; then
    echo "❌ Error: Failed to parse auth key from response"
    echo "Response: $AUTH_KEY_RESPONSE"
    exit 1
fi

echo "✅ Ephemeral auth key created"

# Start Tailscale with the generated auth key
echo "🔌 Connecting to Tailscale..."
sudo tailscale up --authkey="${AUTH_KEY}" >/dev/null 2>&1

# Wait for Tailscale to be ready
echo "⏳ Waiting for Tailscale to connect..."
for i in {1..30}; do
    if sudo tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null 2>&1; then
        echo "✅ Tailscale connected successfully"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Error: Tailscale failed to connect after 30 seconds"
        sudo tailscale status >/dev/null 2>&1
        exit 1
    fi
    sleep 1
done

# Create temporary file for SSH key
SSH_KEY_FILE=$(mktemp)
chmod 600 "$SSH_KEY_FILE"

# Cleanup function
cleanup() {
    rm -f "$SSH_KEY_FILE"
    echo "🧹 Cleaning up Tailscale connection..."
    sudo tailscale down || true
}
trap cleanup EXIT

# Write SSH key to temp file
echo "$DEPLOY_SSH_KEY" > "$SSH_KEY_FILE"

# SSH options for deployment via Tailscale
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"

# Execute deployment script on remote server via Tailscale
echo "🚀 Connecting to $DEPLOY_USERNAME@$DEPLOY_TAILSCALE_HOST:$DEPLOY_PORT"
echo "🚀 Executing deployment script..."

ssh $SSH_OPTS -i "$SSH_KEY_FILE" -p "$DEPLOY_PORT" "$DEPLOY_USERNAME@$DEPLOY_TAILSCALE_HOST" '~/deploy.sh'

echo "✅ Deployment completed successfully"
