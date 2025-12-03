#!/usr/bin/with-contenv bashio
echo "Starting Westlaw Proxy..."

# Get configuration from add-on options
export WESTLAW_API_KEY=$(bashio::config 'westlaw_api_key')
export ALLOWED_ORIGINS=$(bashio::config 'allowed_origins')

# Start the proxy
node westlaw-proxy.js
