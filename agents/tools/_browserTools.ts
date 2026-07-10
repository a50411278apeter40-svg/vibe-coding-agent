// Playwright-powered web browser control tools for PIXAL2.0. Unlike the
// per-project Daytona sandbox tools, these drive a real headless Chromium
// browser that lives in this Next.js server process itself (not inside a
// project's sandbox) -- it is PIXAL2.0's own general web-browsing capability
// (research, reading live pages, filling forms, scraping), independent of
// whatever project is currently being built.
//
// Session persistence: one Chromium browser + one BrowserContext (cookies/
// storage shared) is kept alive per conversationId in `sessions`, so
// navigating, logging in, then clicking around across many separate tool
// calls (and even across separate chat turns) reuses the same logged-in
// session instead of starting from a blank browser every time. An idle
// browser is auto-closed after a grace period to free memory; any further
// tool call for that conversation just launches a fresh one transparently.
//
// Render.com deployment note: headless Chromium needs its OS shared
// libraries (libnspr4, libnss3, ...) present on the host, in addition to the
// Chromium binary itself. render.yaml's buildCommand includes
// `npx playwright install --with-deps chromium` for exactly this reason.
import type { GroqToolSpec, GroqToolExecResult } from './_groq-tools-shared';
import { stringifyToolResult } from '../utils/_text';

type PWBrowser = import('playwright').Browser;
type PWBrowserContext = import('playwright').BrowserContext;
type PWPage = import('playwright').Page;

type BrowserSession = {
  browser: PWBrowser;
  context: PWBrowserContext;
  pages: PWPage[];
  activeIndex: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, BrowserSession>();
const SESSION_IDLE_CLOSE_MS = 10 * 60 * 1000; // 10 minutes of inactivity

function touchSession(conversationId: string, session: BrowserSession) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeSession(conversationId);
  }, SESSION_IDLE_CLOSE_MS);
  if (typeof (session.idleTimer as any).unref === 'function') (session.idleTimer as any).unref();
}

export async function closeSession(conversationId: string): Promise<void> {
  const session = sessions.get(conversationId);
  if (!session) return;
  sessions.delete(conversationId);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await session.browser.close();
  } catch {
    // already closed / never fully launched -- nothing to do.
  }
}

async function getOrCreateSession(conversationId: string): Promise<BrowserSession> {
  const existing = sessions.get(conversationId);
  if (existing) {
    touchSession(conversationId, existing);
    return existing;
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PIXAL2.0-browser-agent',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  const session: BrowserSession = { browser, context, pages: [page], activeIndex: 0 };
  sessions.set(conversationId, session);
  touchSession(conversationId, session);
  return session;
}

function activePage(session: BrowserSession): PWPage {
  const page = session.pages[session.activeIndex];
  if (!page) throw new Error('No active browser tab. Call browser_navigate or browser_new_tab first.');
  return page;
}

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_get_text',
  'browser_get_html',
  'browser_screenshot',
  'browser_scroll',
  'browser_wait_for_selector',
  'browser_go_back',
  'browser_go_forward',
  'browser_reload',
  'browser_evaluate',
  'browser_get_cookies',
  'browser_hover',
  'browser_select_option',
  'browser_get_current_url',
  'browser_new_tab',
  'browser_switch_tab',
  'browser_list_tabs',
  'browser_close_tab',
  'browser_close_session',
] as const;

export const BROWSER_TOOLS: GroqToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Open a URL in PIXAL2.0\'s persistent browser session (real headless Chromium via Playwright). The session (cookies, login state, open tabs) is kept alive across tool calls and turns until browser_close_session is called or it goes idle.',
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
      name: 'browser_click',
      description: 'Click an element on the current page by CSS selector.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input/textarea element. If selector is omitted, types into whatever is currently focused.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          pressEnter: { type: 'boolean', description: 'Press Enter after typing (e.g. to submit a search box). Defaults to false.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Press a single keyboard key on the current page (e.g. "Enter", "Tab", "Escape", "ArrowDown").',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Get the visible text content of the page, or of a specific element if selector is given.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_html',
      description: 'Get the raw HTML of the page, or of a specific element if selector is given.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page. Returns a base64 PNG data URI.',
      parameters: {
        type: 'object',
        properties: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport. Defaults to false.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current page.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up'] },
          amount: { type: 'number', description: 'Pixels to scroll. Defaults to 800.' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for_selector',
      description: 'Wait until an element matching a CSS selector appears on the page.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Defaults to 10000.' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'browser_go_back', description: 'Navigate back in browser history.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'browser_go_forward', description: 'Navigate forward in browser history.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'browser_reload', description: 'Reload the current page.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Run a JavaScript expression in the page context and return its (JSON-serializable) result. Use for custom DOM queries not covered by other browser tools.',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', description: 'A JS expression, e.g. "document.querySelectorAll(\'a\').length".' } },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'browser_get_cookies', description: 'Get all cookies stored in the current browser session.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: 'Hover the mouse over an element by CSS selector (e.g. to reveal a dropdown menu).',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select_option',
      description: 'Select an option in a <select> dropdown by value.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, value: { type: 'string' } },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'browser_get_current_url', description: 'Get the URL and title of the current page.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'browser_new_tab',
      description: 'Open a new browser tab, optionally navigating it to a URL, and make it the active tab.',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_switch_tab',
      description: 'Switch the active tab by index (see browser_list_tabs for indices).',
      parameters: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'browser_list_tabs', description: 'List all open tabs (index, url, title).', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_tab',
      description: 'Close a browser tab by index. Defaults to the current active tab.',
      parameters: { type: 'object', properties: { index: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_session',
      description: 'Close PIXAL2.0\'s entire browser session (all tabs, cookies, login state) for this conversation. Use when you are completely done browsing.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export async function executeBrowserTool(name: string, args: any, conversationId: string): Promise<GroqToolExecResult> {
  try {
    if (name === 'browser_close_session') {
      await closeSession(conversationId);
      return { ok: true, text: stringifyToolResult({ closed: true }) };
    }

    const session = await getOrCreateSession(conversationId);

    switch (name) {
      case 'browser_navigate': {
        const url = String(args?.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Invalid url. Provide an absolute http:// or https:// URL.');
        const page = activePage(session);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { ok: true, text: stringifyToolResult({ url: page.url(), status: response?.status(), title: await page.title() }) };
      }

      case 'browser_click': {
        const selector = String(args?.selector || '');
        if (!selector) throw new Error('Missing selector.');
        await activePage(session).click(selector, { timeout: 10000 });
        return { ok: true, text: stringifyToolResult({ clicked: selector }) };
      }

      case 'browser_type': {
        const text = String(args?.text ?? '');
        const selector = typeof args?.selector === 'string' ? args.selector : undefined;
        const page = activePage(session);
        if (selector) await page.fill(selector, text, { timeout: 10000 });
        else await page.keyboard.type(text);
        if (args?.pressEnter === true) await page.keyboard.press('Enter');
        return { ok: true, text: stringifyToolResult({ typed: text, selector: selector || 'focused element' }) };
      }

      case 'browser_press_key': {
        const key = String(args?.key || '');
        if (!key) throw new Error('Missing key.');
        await activePage(session).keyboard.press(key);
        return { ok: true, text: stringifyToolResult({ pressed: key }) };
      }

      case 'browser_get_text': {
        const selector = typeof args?.selector === 'string' ? args.selector : undefined;
        const page = activePage(session);
        const text = selector ? await page.locator(selector).innerText({ timeout: 10000 }) : await page.innerText('body');
        return { ok: true, text: stringifyToolResult({ text: text.slice(0, 50000) }) };
      }

      case 'browser_get_html': {
        const selector = typeof args?.selector === 'string' ? args.selector : undefined;
        const page = activePage(session);
        const html = selector ? await page.locator(selector).innerHTML({ timeout: 10000 }) : await page.content();
        return { ok: true, text: stringifyToolResult({ html: html.slice(0, 100000) }) };
      }

      case 'browser_screenshot': {
        const fullPage = args?.fullPage === true;
        const buffer = await activePage(session).screenshot({ fullPage, type: 'png' });
        return { ok: true, text: stringifyToolResult({ dataUrl: `data:image/png;base64,${buffer.toString('base64')}` }) };
      }

      case 'browser_scroll': {
        const direction = args?.direction === 'up' ? 'up' : 'down';
        const amount = Number.isFinite(Number(args?.amount)) ? Number(args.amount) : 800;
        const page = activePage(session);
        await page.mouse.wheel(0, direction === 'down' ? amount : -amount);
        return { ok: true, text: stringifyToolResult({ scrolled: direction, amount }) };
      }

      case 'browser_wait_for_selector': {
        const selector = String(args?.selector || '');
        if (!selector) throw new Error('Missing selector.');
        const timeoutMs = Number.isFinite(Number(args?.timeoutMs)) ? Number(args.timeoutMs) : 10000;
        await activePage(session).waitForSelector(selector, { timeout: timeoutMs });
        return { ok: true, text: stringifyToolResult({ appeared: selector }) };
      }

      case 'browser_go_back': {
        await activePage(session).goBack({ timeout: 10000 });
        return { ok: true, text: stringifyToolResult({ url: activePage(session).url() }) };
      }

      case 'browser_go_forward': {
        await activePage(session).goForward({ timeout: 10000 });
        return { ok: true, text: stringifyToolResult({ url: activePage(session).url() }) };
      }

      case 'browser_reload': {
        await activePage(session).reload({ timeout: 15000 });
        return { ok: true, text: stringifyToolResult({ url: activePage(session).url() }) };
      }

      case 'browser_evaluate': {
        const script = String(args?.script || '');
        if (!script) throw new Error('Missing script.');
        const result = await activePage(session).evaluate((code) => {
          // eslint-disable-next-line no-eval
          return (0, eval)(code);
        }, script);
        return { ok: true, text: stringifyToolResult({ result }) };
      }

      case 'browser_get_cookies': {
        const cookies = await session.context.cookies();
        return { ok: true, text: stringifyToolResult({ cookies }) };
      }

      case 'browser_hover': {
        const selector = String(args?.selector || '');
        if (!selector) throw new Error('Missing selector.');
        await activePage(session).hover(selector, { timeout: 10000 });
        return { ok: true, text: stringifyToolResult({ hovered: selector }) };
      }

      case 'browser_select_option': {
        const selector = String(args?.selector || '');
        const value = String(args?.value ?? '');
        if (!selector) throw new Error('Missing selector.');
        await activePage(session).selectOption(selector, value, { timeout: 10000 });
        return { ok: true, text: stringifyToolResult({ selector, value }) };
      }

      case 'browser_get_current_url': {
        const page = activePage(session);
        return { ok: true, text: stringifyToolResult({ url: page.url(), title: await page.title() }) };
      }

      case 'browser_new_tab': {
        const url = typeof args?.url === 'string' ? args.url.trim() : '';
        const page = await session.context.newPage();
        session.pages.push(page);
        session.activeIndex = session.pages.length - 1;
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { ok: true, text: stringifyToolResult({ index: session.activeIndex, url: page.url() }) };
      }

      case 'browser_switch_tab': {
        const index = Number(args?.index);
        if (!Number.isInteger(index) || !session.pages[index]) throw new Error(`Invalid tab index: ${args?.index}`);
        session.activeIndex = index;
        return { ok: true, text: stringifyToolResult({ index, url: session.pages[index].url() }) };
      }

      case 'browser_list_tabs': {
        const tabs = await Promise.all(session.pages.map(async (page, index) => ({
          index,
          url: page.url(),
          title: await page.title().catch(() => ''),
          active: index === session.activeIndex,
        })));
        return { ok: true, text: stringifyToolResult({ tabs }) };
      }

      case 'browser_close_tab': {
        const index = Number.isFinite(Number(args?.index)) ? Number(args.index) : session.activeIndex;
        const page = session.pages[index];
        if (!page) throw new Error(`Invalid tab index: ${index}`);
        await page.close();
        session.pages.splice(index, 1);
        if (session.pages.length === 0) {
          const fresh = await session.context.newPage();
          session.pages.push(fresh);
        }
        session.activeIndex = Math.min(session.activeIndex, session.pages.length - 1);
        return { ok: true, text: stringifyToolResult({ closed: index, remainingTabs: session.pages.length }) };
      }

      default:
        return { ok: false, text: `Unknown browser tool: ${name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
}
