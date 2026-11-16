#!/bin/bash
# Runs the app in the background on this Mac: it starts when you log in, restarts
# if it crashes, and keeps the Mac from going to sleep while it runs, since a
# sleeping Mac can't write or publish posts. If APP_URL in .env is an ngrok
# address, the ngrok tunnel runs the same way, so others can reach the app.
#
#   scripts/mac-service.sh install     start it now and at every login
#   scripts/mac-service.sh uninstall   stop it and remove it
#   scripts/mac-service.sh restart     pick up changes to .env or the code
#   scripts/mac-service.sh status      is it running?
#   scripts/mac-service.sh logs        show recent output
set -euo pipefail

LABEL="local.linkedin-autoposter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/linkedin-autoposter.log"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
TUNNEL_LABEL="local.linkedin-autoposter-tunnel"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"

# Stops a service and waits until it's gone, since launchctl does this in the background.
stop_service() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0
    sleep 1
  done
}

env_value() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

case "${1:-}" in
  install)
    NODE="$(command -v node)"
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>--env-file-if-exists=.env</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    stop_service "$LABEL"
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. The app now runs in the background. Log: $LOG"

    APP_URL="$(env_value APP_URL)"
    if [[ "$APP_URL" == https://*.ngrok* ]]; then
      NGROK="$(command -v ngrok || true)"
      if [[ -z "$NGROK" ]]; then
        echo "APP_URL is an ngrok address, but ngrok isn't installed. Run: brew install ngrok"
        exit 1
      fi
      PORT="$(env_value PORT)"
      cat > "$TUNNEL_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NGROK</string>
    <string>http</string>
    <string>${PORT:-3000}</string>
    <string>--url=$APP_URL</string>
    <string>--log=stdout</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/linkedin-autoposter-tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/linkedin-autoposter-tunnel.log</string>
</dict>
</plist>
PLIST
      stop_service "$TUNNEL_LABEL"
      launchctl bootstrap "$DOMAIN" "$TUNNEL_PLIST"
      echo "The ngrok tunnel runs in the background too: $APP_URL"
    fi
    ;;
  uninstall)
    stop_service "$LABEL"
    stop_service "$TUNNEL_LABEL"
    rm -f "$PLIST" "$TUNNEL_PLIST"
    echo "Removed. The app no longer runs in the background."
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  status)
    echo "App:"
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "^\s+(state|pid) =" || echo "  not installed"
    echo "Tunnel:"
    launchctl print "$DOMAIN/$TUNNEL_LABEL" 2>/dev/null | grep -E "^\s+(state|pid) =" || echo "  not installed"
    ;;
  logs)
    tail -n 50 "$LOG"
    ;;
  *)
    echo "Usage: $0 install|uninstall|restart|status|logs"
    exit 1
    ;;
esac
