// 20 general-purpose utility tools for PIXAL2.0. Every one of these is a real,
// working implementation -- no API key required for any of them. Local ones
// (crypto/math/text) run with zero network dependency; the handful that do
// call out to the network (weather, dns, whois, website status/metadata)
// only ever hit long-standing free public endpoints that do not require an
// API key or account (open-meteo, DNS resolvers, raw WHOIS TCP, the target
// site itself). These are process-local (no sandbox needed), so they work
// even before ensure_project_scaffold / outside any project context.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve4, resolve6, resolveMx, resolveTxt, resolveCname, resolveNs } from 'node:dns/promises';
import { Socket } from 'node:net';
import type { GroqToolSpec, GroqToolExecResult } from './_groq-tools-shared';
import { stringifyToolResult } from '../utils/_text';

export const UTILITY_TOOL_NAMES = [
  'get_current_time',
  'calculate',
  'generate_uuid',
  'hash_text',
  'base64_convert',
  'url_convert',
  'format_json',
  'test_regex',
  'text_stats',
  'generate_qr_code',
  'convert_units',
  'generate_password',
  'generate_lorem_ipsum',
  'convert_color',
  'slugify_text',
  'dns_lookup',
  'whois_lookup',
  'check_website_status',
  'get_website_metadata',
  'get_weather',
] as const;

export const UTILITY_TOOLS: GroqToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current date/time, optionally in a specific IANA timezone (e.g. "Asia/Seoul", "America/New_York"). No API key needed.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone name. Defaults to UTC.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate an arithmetic expression safely (+, -, *, /, %, ^, parentheses, decimals). No variables or function calls.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'e.g. "(2 + 3) * 4 / 2 ^ 2".' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_uuid',
      description: 'Generate one or more random UUID v4 strings.',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number', description: 'How many to generate. Defaults to 1, max 50.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hash_text',
      description: 'Compute a cryptographic hash (md5, sha1, sha256, sha512) of a text string.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512'], description: 'Defaults to sha256.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'base64_convert',
      description: 'Encode text to base64 or decode base64 back to text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          mode: { type: 'string', enum: ['encode', 'decode'] },
        },
        required: ['text', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'url_convert',
      description: 'URL-encode or URL-decode a text string (encodeURIComponent / decodeURIComponent semantics).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          mode: { type: 'string', enum: ['encode', 'decode'] },
        },
        required: ['text', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'format_json',
      description: 'Validate and pretty-print a JSON string. Returns a clear parse error with position if invalid.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          indent: { type: 'number', description: 'Spaces of indentation. Defaults to 2.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'test_regex',
      description: 'Test a regular expression against a text string and return whether it matches plus all match details.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          flags: { type: 'string', description: 'e.g. "gi". Defaults to "g".' },
          text: { type: 'string' },
        },
        required: ['pattern', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_stats',
      description: 'Get character, word, line, and sentence counts plus estimated reading time for a text.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_qr_code',
      description: 'Generate a QR code for a piece of text/URL. Returns a base64 PNG data URI you can embed directly as <img src="..."> in generated HTML/JSX -- do not write it as a binary file.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          size: { type: 'number', description: 'Pixel width. Defaults to 300.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_units',
      description: 'Convert a numeric value between units of length, weight, volume, or temperature.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number' },
          from: { type: 'string', description: 'e.g. "km", "lb", "celsius", "gallon".' },
          to: { type: 'string' },
        },
        required: ['value', 'from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_password',
      description: 'Generate a cryptographically random password.',
      parameters: {
        type: 'object',
        properties: {
          length: { type: 'number', description: 'Defaults to 16.' },
          includeSymbols: { type: 'boolean', description: 'Defaults to true.' },
          includeNumbers: { type: 'boolean', description: 'Defaults to true.' },
          includeUppercase: { type: 'boolean', description: 'Defaults to true.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_lorem_ipsum',
      description: 'Generate placeholder lorem-ipsum-style paragraphs for mockups/design.',
      parameters: {
        type: 'object',
        properties: {
          paragraphs: { type: 'number', description: 'Defaults to 1.' },
          wordsPerParagraph: { type: 'number', description: 'Defaults to 40.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_color',
      description: 'Convert a color between hex, rgb(a), and hsl(a) formats.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'e.g. "#ff0000", "rgb(255,0,0)", "hsl(0,100%,50%)".' },
          to: { type: 'string', enum: ['hex', 'rgb', 'hsl'] },
        },
        required: ['value', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'slugify_text',
      description: 'Convert text into a URL-friendly slug (lowercase, hyphen-separated).',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dns_lookup',
      description: 'Resolve a hostname\'s DNS records (A, AAAA, MX, TXT, CNAME, or NS).',
      parameters: {
        type: 'object',
        properties: {
          hostname: { type: 'string' },
          recordType: { type: 'string', enum: ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS'], description: 'Defaults to A.' },
        },
        required: ['hostname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'whois_lookup',
      description: 'Look up WHOIS registration info for a domain via a raw WHOIS query (no API key/service needed).',
      parameters: {
        type: 'object',
        properties: { domain: { type: 'string' } },
        required: ['domain'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_website_status',
      description: 'Check whether a website/URL is reachable: HTTP status code, latency in ms, and whether it redirected.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_website_metadata',
      description: 'Fetch a URL and extract its <title>, meta description, and Open Graph tags.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city name or explicit latitude/longitude, via the free open-meteo.com API (no key needed).',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
        },
      },
    },
  },
];

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- calculate(): tiny safe recursive-descent arithmetic parser -----------
// Deliberately does not use eval()/Function() -- only digits, ., + - * / % ^,
// parentheses, and whitespace are accepted; anything else throws.
function safeCalculate(expression: string): number {
  const cleaned = expression.trim();
  if (!/^[0-9+\-*/%^().\s]+$/.test(cleaned)) {
    throw new Error('Expression contains unsupported characters. Only numbers and + - * / % ^ ( ) are allowed.');
  }
  let pos = 0;
  const peek = () => cleaned[pos];
  const skipWs = () => { while (peek() === ' ') pos += 1; };

  function parseExpr(): number {
    skipWs();
    let value = parseTerm();
    for (;;) {
      skipWs();
      const op = peek();
      if (op === '+' || op === '-') {
        pos += 1;
        const rhs = parseTerm();
        value = op === '+' ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }
  function parseTerm(): number {
    skipWs();
    let value = parsePow();
    for (;;) {
      skipWs();
      const op = peek();
      if (op === '*' || op === '/' || op === '%') {
        pos += 1;
        const rhs = parsePow();
        if (op === '*') value *= rhs;
        else if (op === '/') {
          if (rhs === 0) throw new Error('Division by zero.');
          value /= rhs;
        } else value %= rhs;
      } else break;
    }
    return value;
  }
  function parsePow(): number {
    skipWs();
    const base = parseUnary();
    skipWs();
    if (peek() === '^') {
      pos += 1;
      const exp = parsePow();
      return Math.pow(base, exp);
    }
    return base;
  }
  function parseUnary(): number {
    skipWs();
    if (peek() === '-') { pos += 1; return -parseUnary(); }
    if (peek() === '+') { pos += 1; return parseUnary(); }
    return parseAtom();
  }
  function parseAtom(): number {
    skipWs();
    if (peek() === '(') {
      pos += 1;
      const value = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error('Missing closing parenthesis.');
      pos += 1;
      return value;
    }
    const start = pos;
    while (pos < cleaned.length && /[0-9.]/.test(cleaned[pos])) pos += 1;
    if (pos === start) throw new Error(`Unexpected character at position ${pos}: "${cleaned[pos] || ''}"`);
    const numText = cleaned.slice(start, pos);
    const num = Number(numText);
    if (Number.isNaN(num)) throw new Error(`Invalid number: "${numText}"`);
    return num;
  }

  const result = parseExpr();
  skipWs();
  if (pos !== cleaned.length) throw new Error(`Unexpected trailing input at position ${pos}.`);
  return result;
}

const UNIT_TABLE: Record<string, Record<string, number>> = {
  length: { m: 1, meter: 1, meters: 1, km: 1000, cm: 0.01, mm: 0.001, mile: 1609.344, miles: 1609.344, mi: 1609.344, yard: 0.9144, yards: 0.9144, yd: 0.9144, foot: 0.3048, feet: 0.3048, ft: 0.3048, inch: 0.0254, inches: 0.0254, in: 0.0254 },
  weight: { kg: 1, g: 0.001, gram: 0.001, grams: 0.001, mg: 0.000001, lb: 0.45359237, lbs: 0.45359237, pound: 0.45359237, pounds: 0.45359237, oz: 0.028349523125, ounce: 0.028349523125, ounces: 0.028349523125, ton: 1000, tonne: 1000, tonnes: 1000, t: 1000 },
  volume: { l: 1, liter: 1, liters: 1, litre: 1, litres: 1, ml: 0.001, milliliter: 0.001, milliliters: 0.001, gallon: 3.785411784, gallons: 3.785411784, gal: 3.785411784, quart: 0.946352946, quarts: 0.946352946, cup: 0.2365882365, cups: 0.2365882365, floz: 0.0295735295625 },
};

function convertUnits(value: number, from: string, to: string): { result: number; category: string } {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  const tempAliases = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin']);
  if (tempAliases.has(f) || tempAliases.has(t)) {
    const toCelsius = (v: number, unit: string) => {
      if (unit.startsWith('c')) return v;
      if (unit.startsWith('f')) return (v - 32) * (5 / 9);
      if (unit.startsWith('k')) return v - 273.15;
      throw new Error(`Unknown temperature unit: ${unit}`);
    };
    const fromCelsius = (v: number, unit: string) => {
      if (unit.startsWith('c')) return v;
      if (unit.startsWith('f')) return v * (9 / 5) + 32;
      if (unit.startsWith('k')) return v + 273.15;
      throw new Error(`Unknown temperature unit: ${unit}`);
    };
    const celsius = toCelsius(value, f);
    return { result: fromCelsius(celsius, t), category: 'temperature' };
  }
  for (const [category, table] of Object.entries(UNIT_TABLE)) {
    if (f in table && t in table) {
      const meters = value * table[f];
      return { result: meters / table[t], category };
    }
  }
  throw new Error(`Unsupported or mismatched units: "${from}" -> "${to}".`);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

function parseColorToRgb(value: string): [number, number, number] {
  const v = value.trim();
  const hexMatch = v.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const rgbMatch = v.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbMatch) return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  const hslMatch = v.match(/hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i);
  if (hslMatch) return hslToRgb(Number(hslMatch[1]), Number(hslMatch[2]), Number(hslMatch[3]));
  throw new Error(`Could not parse color: "${value}". Use hex (#rrggbb), rgb(r,g,b), or hsl(h,s%,l%).`);
}

const LOREM_WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum').split(' ');

function generateLorem(paragraphs: number, wordsPerParagraph: number): string {
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p += 1) {
    const words: string[] = [];
    for (let w = 0; w < wordsPerParagraph; w += 1) {
      words.push(LOREM_WORDS[Math.floor(Math.random() * LOREM_WORDS.length)]);
    }
    let sentence = words.join(' ');
    sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
    out.push(sentence);
  }
  return out.join('\n\n');
}

function rawWhoisQuery(server: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let data = '';
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`WHOIS query to ${server} timed out.`)); });
    socket.once('error', (err) => reject(err));
    socket.connect(43, server, () => { socket.write(`${query}\r\n`); });
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('close', () => resolve(data));
  });
}

export async function executeUtilityTool(name: string, args: any): Promise<GroqToolExecResult> {
  try {
    switch (name) {
      case 'get_current_time': {
        const timezone = typeof args?.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : 'UTC';
        const now = new Date();
        const formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now);
        return { ok: true, text: stringifyToolResult({ iso: now.toISOString(), unixMs: now.getTime(), timezone, formatted }) };
      }

      case 'calculate': {
        const expression = String(args?.expression || '');
        if (!expression.trim()) throw new Error('Missing expression.');
        const result = safeCalculate(expression);
        return { ok: true, text: stringifyToolResult({ expression, result }) };
      }

      case 'generate_uuid': {
        const count = Math.min(Math.max(1, Number(args?.count) || 1), 50);
        const uuids = Array.from({ length: count }, () => randomUUID());
        return { ok: true, text: stringifyToolResult({ uuids }) };
      }

      case 'hash_text': {
        const text = String(args?.text ?? '');
        const algorithm = typeof args?.algorithm === 'string' ? args.algorithm : 'sha256';
        if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algorithm)) throw new Error('Unsupported algorithm.');
        const hash = createHash(algorithm).update(text, 'utf8').digest('hex');
        return { ok: true, text: stringifyToolResult({ algorithm, hash }) };
      }

      case 'base64_convert': {
        const text = String(args?.text ?? '');
        const mode = args?.mode === 'decode' ? 'decode' : 'encode';
        const result = mode === 'encode'
          ? Buffer.from(text, 'utf8').toString('base64')
          : Buffer.from(text, 'base64').toString('utf8');
        return { ok: true, text: stringifyToolResult({ mode, result }) };
      }

      case 'url_convert': {
        const text = String(args?.text ?? '');
        const mode = args?.mode === 'decode' ? 'decode' : 'encode';
        const result = mode === 'encode' ? encodeURIComponent(text) : decodeURIComponent(text);
        return { ok: true, text: stringifyToolResult({ mode, result }) };
      }

      case 'format_json': {
        const text = String(args?.text ?? '');
        const indent = Number.isFinite(Number(args?.indent)) ? Number(args.indent) : 2;
        try {
          const parsed = JSON.parse(text);
          return { ok: true, text: stringifyToolResult({ valid: true, formatted: JSON.stringify(parsed, null, indent) }) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: true, text: stringifyToolResult({ valid: false, error: message }) };
        }
      }

      case 'test_regex': {
        const pattern = String(args?.pattern || '');
        const flags = typeof args?.flags === 'string' ? args.flags : 'g';
        const text = String(args?.text ?? '');
        const re = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
        const matches = Array.from(text.matchAll(re)).map((m) => ({ match: m[0], index: m.index, groups: m.slice(1) }));
        return { ok: true, text: stringifyToolResult({ matches: matches.length > 0, count: matches.length, results: matches.slice(0, 200) }) };
      }

      case 'text_stats': {
        const text = String(args?.text ?? '');
        const chars = text.length;
        const charsNoSpaces = text.replace(/\s/g, '').length;
        const words = (text.trim().match(/\S+/g) || []).length;
        const lines = text.split('\n').length;
        const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length;
        const readingTimeMinutes = Math.max(1, Math.round(words / 200));
        return { ok: true, text: stringifyToolResult({ chars, charsNoSpaces, words, lines, sentences, readingTimeMinutes }) };
      }

      case 'generate_qr_code': {
        const text = String(args?.text || '');
        if (!text) throw new Error('Missing text.');
        const size = Number.isFinite(Number(args?.size)) ? Number(args.size) : 300;
        const QRCode = (await import('qrcode')).default;
        const dataUrl = await QRCode.toDataURL(text, { width: size, margin: 1 });
        return { ok: true, text: stringifyToolResult({ dataUrl, usage: 'Embed directly: <img src="THIS_DATA_URL" />' }) };
      }

      case 'convert_units': {
        const value = Number(args?.value);
        if (!Number.isFinite(value)) throw new Error('Missing/invalid value.');
        const from = String(args?.from || '');
        const to = String(args?.to || '');
        const { result, category } = convertUnits(value, from, to);
        return { ok: true, text: stringifyToolResult({ value, from, to, category, result }) };
      }

      case 'generate_password': {
        const length = Math.min(Math.max(4, Number(args?.length) || 16), 256);
        const includeSymbols = args?.includeSymbols !== false;
        const includeNumbers = args?.includeNumbers !== false;
        const includeUppercase = args?.includeUppercase !== false;
        let charset = 'abcdefghijklmnopqrstuvwxyz';
        if (includeUppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (includeNumbers) charset += '0123456789';
        if (includeSymbols) charset += '!@#$%^&*()-_=+[]{}';
        const bytes = randomBytes(length);
        let password = '';
        for (let i = 0; i < length; i += 1) password += charset[bytes[i] % charset.length];
        return { ok: true, text: stringifyToolResult({ password, length }) };
      }

      case 'generate_lorem_ipsum': {
        const paragraphs = Math.min(Math.max(1, Number(args?.paragraphs) || 1), 20);
        const wordsPerParagraph = Math.min(Math.max(5, Number(args?.wordsPerParagraph) || 40), 300);
        const text = generateLorem(paragraphs, wordsPerParagraph);
        return { ok: true, text: stringifyToolResult({ text }) };
      }

      case 'convert_color': {
        const value = String(args?.value || '');
        const to = String(args?.to || '');
        const [r, g, b] = parseColorToRgb(value);
        let result: string;
        if (to === 'hex') result = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
        else if (to === 'rgb') result = `rgb(${r}, ${g}, ${b})`;
        else if (to === 'hsl') { const [h, s, l] = rgbToHsl(r, g, b); result = `hsl(${h}, ${s}%, ${l}%)`; }
        else throw new Error('to must be one of hex, rgb, hsl.');
        return { ok: true, text: stringifyToolResult({ input: value, to, result }) };
      }

      case 'slugify_text': {
        const text = String(args?.text || '');
        const slug = text
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9\uAC00-\uD7A3]+/g, '-')
          .replace(/^-+|-+$/g, '');
        return { ok: true, text: stringifyToolResult({ slug }) };
      }

      case 'dns_lookup': {
        const hostname = String(args?.hostname || '').trim();
        if (!hostname) throw new Error('Missing hostname.');
        const recordType = typeof args?.recordType === 'string' ? args.recordType.toUpperCase() : 'A';
        let records: unknown;
        if (recordType === 'A') records = await resolve4(hostname);
        else if (recordType === 'AAAA') records = await resolve6(hostname);
        else if (recordType === 'MX') records = await resolveMx(hostname);
        else if (recordType === 'TXT') records = await resolveTxt(hostname);
        else if (recordType === 'CNAME') records = await resolveCname(hostname);
        else if (recordType === 'NS') records = await resolveNs(hostname);
        else throw new Error('Unsupported recordType.');
        return { ok: true, text: stringifyToolResult({ hostname, recordType, records }) };
      }

      case 'whois_lookup': {
        const domain = String(args?.domain || '').trim().toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('Invalid domain.');
        const ianaResult = await rawWhoisQuery('whois.iana.org', domain, 8000);
        const referMatch = ianaResult.match(/refer:\s*(\S+)/i);
        if (referMatch) {
          try {
            const detailed = await rawWhoisQuery(referMatch[1], domain, 8000);
            return { ok: true, text: stringifyToolResult({ domain, server: referMatch[1], whois: detailed.slice(0, 6000) }) };
          } catch {
            return { ok: true, text: stringifyToolResult({ domain, server: 'whois.iana.org', whois: ianaResult.slice(0, 6000) }) };
          }
        }
        return { ok: true, text: stringifyToolResult({ domain, server: 'whois.iana.org', whois: ianaResult.slice(0, 6000) }) };
      }

      case 'check_website_status': {
        const url = String(args?.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Invalid url.');
        const startedAt = Date.now();
        let response: Response;
        try {
          response = await fetchWithTimeout(url, 10000, { method: 'HEAD', redirect: 'follow' });
        } catch {
          response = await fetchWithTimeout(url, 10000, { method: 'GET', redirect: 'follow' });
        }
        const latencyMs = Date.now() - startedAt;
        return { ok: true, text: stringifyToolResult({ url, status: response.status, ok: response.ok, redirected: response.redirected, finalUrl: response.url, latencyMs }) };
      }

      case 'get_website_metadata': {
        const url = String(args?.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Invalid url.');
        const response = await fetchWithTimeout(url, 10000, { headers: { 'user-agent': 'PIXAL2.0-web-dev-agent/1.0' } });
        const html = (await response.text()).slice(0, 200000);
        const pick = (re: RegExp) => (html.match(re) || [])[1]?.trim();
        const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
        const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
        const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
        const ogImage = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
        return { ok: true, text: stringifyToolResult({ url, status: response.status, title, description, ogTitle, ogImage }) };
      }

      case 'get_weather': {
        let latitude = Number(args?.latitude);
        let longitude = Number(args?.longitude);
        let placeName: string | undefined;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          const city = String(args?.city || '').trim();
          if (!city) throw new Error('Provide either city, or latitude+longitude.');
          const geoRes = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, 10000);
          const geo = await geoRes.json();
          const first = geo?.results?.[0];
          if (!first) throw new Error(`Could not find location: "${city}".`);
          latitude = first.latitude;
          longitude = first.longitude;
          placeName = [first.name, first.admin1, first.country].filter(Boolean).join(', ');
        }
        const weatherRes = await fetchWithTimeout(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`,
          10000,
        );
        const weather = await weatherRes.json();
        return { ok: true, text: stringifyToolResult({ place: placeName, latitude, longitude, current: weather.current }) };
      }

      default:
        return { ok: false, text: `Unknown utility tool: ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
}
