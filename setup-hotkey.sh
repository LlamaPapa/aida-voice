#!/bin/bash
# Setup Option+Space global hotkey for voice-pipeline daemon
# This creates a Hammerspoon binding or a macOS shortcut

PORT="${1:-7890}"

echo ""
echo "  Voice Pipeline — Hotkey Setup (Option+Space)"
echo "  ─────────────────────────────────────────────"
echo ""

# ── Option 1: Hammerspoon (recommended) ──
if command -v hs &>/dev/null || [ -d "$HOME/.hammerspoon" ]; then
  echo "  Hammerspoon detected! Adding hotkey binding..."

  mkdir -p "$HOME/.hammerspoon"

  # Add to init.lua if not already present
  if ! grep -q "voice-pipeline" "$HOME/.hammerspoon/init.lua" 2>/dev/null; then
    cat >> "$HOME/.hammerspoon/init.lua" << HSLUA

-- voice-pipeline: Option+Space to toggle recording
hs.hotkey.bind({"alt"}, "space", function()
  hs.http.asyncPost("http://localhost:${PORT}/api/toggle", "", {}, function(status, body)
    if status == 200 then
      local data = hs.json.decode(body)
      if data.status == "recording" then
        hs.alert.show("Recording...", 1)
      else
        hs.alert.show("Processing...", 1)
      end
    end
  end)
end)
HSLUA
    echo "  Added to ~/.hammerspoon/init.lua"
    echo "  Reload Hammerspoon to activate."
  else
    echo "  Hotkey already configured in Hammerspoon."
  fi

else
  echo "  Option 1: Install Hammerspoon (recommended)"
  echo "    brew install --cask hammerspoon"
  echo "    Then re-run: bash setup-hotkey.sh"
  echo ""
  echo "  Option 2: Manual shortcut"
  echo "    Create an Automator Quick Action that runs:"
  echo "    curl -s -X POST http://localhost:${PORT}/api/toggle"
  echo "    Then bind it to Option+Space in:"
  echo "    System Settings → Keyboard → Keyboard Shortcuts → Services"
fi

echo ""
echo "  Make sure the daemon is running: voice daemon"
echo ""
