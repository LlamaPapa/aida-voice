import { execSync } from 'node:child_process';

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboardy = await import('clipboardy');
    await clipboardy.default.write(text);
    return true;
  } catch {
    // Fallback to platform-specific commands
    return fallbackCopy(text);
  }
}

function fallbackCopy(text: string): boolean {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else if (platform === 'linux') {
      // Try xclip first, then xsel
      try {
        execSync('xclip -selection clipboard', { input: text });
      } catch {
        execSync('xsel --clipboard --input', { input: text });
      }
    } else if (platform === 'win32') {
      execSync('clip', { input: text });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function autoPaste(): Promise<boolean> {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      // AppleScript: simulate Cmd+V
      execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
      return true;
    } else if (platform === 'linux') {
      // xdotool: simulate Ctrl+V
      execSync('xdotool key ctrl+v');
      return true;
    } else if (platform === 'win32') {
      // PowerShell: simulate Ctrl+V
      execSync('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
