# Running nostrwolfe-bridge durably

Templates for keeping the bridge running across crashes and reboots. Edit the
paths, then install.

## macOS (launchd)

1. Edit `com.nostrwolfe.bridge.plist`: replace `/ABSOLUTE/PATH/TO` with the
   absolute path to your checkout (and the absolute path to `node` — find it
   with `which node`).
2. Install:
   ```bash
   cp com.nostrwolfe.bridge.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nostrwolfe.bridge.plist
   ```
3. Manage:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nostrwolfe.bridge   # restart (after an .env or code change)
   launchctl print     gui/$(id -u)/com.nostrwolfe.bridge      # status
   launchctl bootout   gui/$(id -u)/com.nostrwolfe.bridge      # stop + uninstall
   ```
   Logs go to `logs/bridge.log` in the working directory.

## Linux (systemd, user service)

1. Edit `nostrwolfe-bridge.service`: replace `/ABSOLUTE/PATH/TO` and the `node`
   path.
2. Install:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp nostrwolfe-bridge.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now nostrwolfe-bridge
   ```
3. Manage:
   ```bash
   systemctl --user restart nostrwolfe-bridge
   systemctl --user status  nostrwolfe-bridge
   journalctl --user -u nostrwolfe-bridge -f
   ```
   (For a service that runs without you logged in, `loginctl enable-linger $USER`.)

Both templates run `node dist/index.js` with the working directory set to your
checkout, so `.env` and `bridge-state.json` resolve there. Build first
(`npm run build`).
