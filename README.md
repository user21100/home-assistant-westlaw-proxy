# Westlaw Proxy Add-on for Home Assistant

A Puppeteer-based proxy to access Westlaw, packaged as a Home Assistant Add-on.

## Installation

1.  Navigate to **Settings** > **Add-ons** > **Add-on Store** in Home Assistant.
2.  Click the **three dots** (top right) > **Repositories**.
3.  Add this repository URL: `https://github.com/user21100/home-assistant-westlaw-proxy`
4.  Click **Add**.
5.  Find "Westlaw Proxy" in the store and click **Install**.
6.  Start the add-on.

## Configuration

The add-on exposes the proxy on port **3000**.

## Usage

- **Health Check**: `http://homeassistant.local:3000/health`
- **Search**: `http://homeassistant.local:3000/search?q=query`
