const OSC8_OPEN = '\x1b]8;;';
const OSC8_CLOSE = '\x07';

export function supportsOsc8Hyperlinks(): boolean {
  if (process.stdout && !process.stdout.isTTY) {
    return false;
  }

  if (process.env.OPENCODE_HEADLESS) {
    return false;
  }

  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? '';
  if (termProgram === 'iterm.app' || termProgram === 'wezterm' || termProgram === 'ghostty') {
    return true;
  }

  if (process.env.KITTY_WINDOW_ID) {
    return true;
  }

  const vteVersion = parseInt(process.env.VTE_VERSION ?? '0', 10);
  if (vteVersion >= 5000) {
    return true;
  }

  const colorTerm = process.env.COLORTERM?.toLowerCase() ?? '';
  if (colorTerm === 'truecolor' || colorTerm === '24bit') {
    const term = process.env.TERM?.toLowerCase() ?? '';
    if (term.startsWith('xterm') || term.startsWith('alacritty') || term === 'termion') {
      return true;
    }
  }

  return false;
}

export function formatHyperlink(url: string, text?: string): string {
  if (!supportsOsc8Hyperlinks()) {
    if (text) {
      return text === url ? text : `${text} (${url})`;
    }
    return url;
  }
  const displayText = text ?? url;
  return `${OSC8_OPEN}${url}${OSC8_CLOSE}${displayText}${OSC8_OPEN}${OSC8_CLOSE}`;
}

export function stripOsc8(text: string): string {
  return text.replace(/\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}
