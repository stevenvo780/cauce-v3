/** Curated pixelarticons (MIT) offered to agents: every name fits `px:<name>` in 16 characters. */
export interface PixelIconCategory {
  id: string;
  label: string;
  names: readonly string[];
}

export const PIXEL_ICON_CATEGORIES: readonly PixelIconCategory[] = [
  {
    id: 'personajes', label: 'Personajes',
    names: [
      'robot', 'robot-face', 'android', 'android-solid', 'alien', 'skull', 'human', 'human-arms-up',
      'avatar-circle', 'avatar-square', 'user', 'users', 'dog', 'fish', 'snail', 'snake', 't-rex', 'smile',
      'laugh', 'meh', 'frown', 'angry', 'annoyed', 'sunglasses', 'crown', 'sword', 'wand', 'potion', 'castle',
      'party-popper',
    ],
  },
  {
    id: 'codigo', label: 'Código',
    names: [
      'code', 'terminal', 'bug', 'debug', 'braces', 'brackets', 'binary', 'cpu', 'gpu', 'database', 'server',
      'cloud-server', 'git-branch', 'git-commit', 'git-merge', 'github', 'docker', 'npm', 'pnpm', 'react',
      'deno', 'circuit-board', 'memory-stick', 'algorithm', 'keyboard', 'laptop', 'computer', 'monitor',
      'webcam', 'usb', 'wifi', 'plug', 'tools', 'tool-case', 'gear', 'settings-cog', 'sliders', 'ai-scan',
      'ai-view', 'ai-voice', 'ai-settings-2', 'linux', 'test-tube', 'pc-case', 'modem', 'app-windows',
      'script',
    ],
  },
  {
    id: 'objetos', label: 'Objetos',
    names: [
      'heart', 'coffee', 'mug', 'tea', 'book-open', 'library', 'notebook', 'music', 'drum', 'gamepad',
      'joystick', 'headphone', 'mic', 'camera', 'video', 'tv', 'radio', 'key', 'lock', 'unlock', 'lightbulb',
      'bell', 'flag', 'trophy', 'gift', 'cake', 'bomb', 'balloon', 'hourglass', 'clock', 'alarm-clock',
      'calendar', 'map', 'compass', 'backpack', 'briefcase', 'suitcase', 'shopping-cart', 'wallet', 'coins',
      'banknote', 'diamond-gem', 'shield', 'anchor', 'helicopter', 'ship', 'car', 'bus', 'truck', 'scissors',
      'pencil', 'brush', 'pipette', 'eraser', 'scale', 'calculator', 'clipboard', 'mail', 'send', 'megaphone',
      'siren', 'thermometer', 'printer', 'projector', 'power', 'battery-full',
    ],
  },
  {
    id: 'naturaleza', label: 'Naturaleza',
    names: [
      'leaf', 'tree', 'tree-pine', 'sun', 'moon', 'cloud', 'cloud-moon', 'cloud-sun', 'snowflake', 'fire',
      'waves', 'wind', 'earth', 'globe', 'feather', 'tent', 'apple',
    ],
  },
  {
    id: 'simbolos', label: 'Símbolos',
    names: [
      'zap', 'target', 'goal', 'infinity', 'sparkles', 'sparkle', 'circle', 'square', 'check', 'check-double',
      'plus', 'minus', 'x', 'cancel', 'circle-info', 'percent', 'pi', 'ampersand', 'at-sign', 'hash', 'pound',
      'eye', 'thumbs-up', 'thumbs-down', 'hand', 'pointer', 'search', 'zoom-in', 'filter', 'loader',
      'refresh', 'shuffle', 'repeat', 'play', 'pause', 'stop', 'forward', 'arrow-up', 'arrow-right',
      'bookmark', 'label', 'section', 'shapes', 'blocks', 'grid-3x3', 'circle-pile', 'signal', 'spinner',
    ],
  },
];

export const PIXEL_ICON_NAMES: readonly string[] = PIXEL_ICON_CATEGORIES.flatMap((category) => category.names);
