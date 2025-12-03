#!/usr/bin/with-contenv bashio
echo "Starting Westlaw Proxy..."

# Environment variables are automatically set by Home Assistant from config.yaml
# WESTLAW_API_KEY and ALLOWED_ORIGINS are available via the environment key in config.yaml

# Start the proxy
node westlaw-proxy.js
