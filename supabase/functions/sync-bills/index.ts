import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------------------------------------------------------------------------
// Encryption utilities
// ---------------------------------------------------------------------------

async function getEncryptionKey(): Promise<CryptoKey> {
  const keyBase64 = Deno.env.get("ENCRYPTION_KEY")!;
  const keyBuffer = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function decryptPassword(
  encrypted: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const encBuf = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const ivBuf = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBuf },
    key,
    encBuf,
  );
  return new TextDecoder().decode(dec);
}

// ---------------------------------------------------------------------------
// Scraper result types
// ---------------------------------------------------------------------------

interface BillData {
  title: string;
  amount: number;
  due_date: string;
  reference_number?: string;
  bill_type?: string;
  period_start?: string;
  period_end?: string;
  issue_date?: string;
  payment_code?: string;
}

interface ScraperResult {
  success: boolean;
  bills: BillData[];
  error?: string;
  error_code?: string;
  debug?: unknown[];
  screenshot?: string;
}

// ---------------------------------------------------------------------------
// Browserless.io helpers
// ---------------------------------------------------------------------------

// Calls Browserless /function endpoint with stealth mode enabled.
// Credentials are passed through the `context` object (NOT string
// interpolation) so there is zero risk of JS injection.
// Compatible with Browserless v2 (export default, {data,type} response).
async function runBrowserless(
  code: string,
  context: Record<string, unknown>,
): Promise<ScraperResult> {
  const browserlessUrl = Deno.env.get("BROWSERLESS_URL")!;
  const browserlessToken = Deno.env.get("BROWSERLESS_TOKEN")!;
  const timeout = Number(Deno.env.get("SCRAPER_TIMEOUT_MS") || "120000");

  const url = new URL(`${browserlessUrl}/function`);
  url.searchParams.set("token", browserlessToken);
  // Browserless v2: stealth via launch param, timeout via query param
  url.searchParams.set("launch", JSON.stringify({ stealth: true }));
  url.searchParams.set("timeout", String(timeout));

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, context }),
    // Safety net: abort fetch if Browserless doesn't respect its own timeout
    signal: AbortSignal.timeout(timeout + 15000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Browserless HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const raw = await response.json();

  // Browserless v2 functions return { data, type } — unwrap if needed.
  // v1 returns the plain object directly.
  if (raw && typeof raw === "object" && "data" in raw && "type" in raw) {
    if (raw.data != null) return raw.data as ScraperResult;
  }
  // Direct response (v1) or already-unwrapped v2: validate shape
  if (raw && typeof raw.success === "boolean") {
    return raw as ScraperResult;
  }
  // Completely malformed response — throw so sync job records the failure
  throw new Error(
    `Browserless returned unexpected response: ${JSON.stringify(raw).slice(0, 200)}`,
  );
}

// ---------------------------------------------------------------------------
// Shared Puppeteer helpers injected into every scraper function.
// Available inside Browserless as `helpers.*`
// ---------------------------------------------------------------------------

const BROWSER_HELPERS = `
  // ---- shared helpers available in every scraper ----
  const helpers = {
    // Wait for any one of multiple selectors, return the first matched
    async waitAny(page, selectors, timeout = 15000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        for (const sel of selectors) {
          try {
            const el = await page.$(sel);
            if (el) return { el, selector: sel };
          } catch { /* invalid CSS selector, skip */ }
        }
        await new Promise(r => setTimeout(r, 300));
      }
      return null;
    },

    // Robust type: click the field first, clear it, then type slowly
    async safeType(page, selector, value, delay = 50) {
      await page.waitForSelector(selector, { visible: true, timeout: 10000 });
      await page.click(selector, { clickCount: 3 }); // select all existing text
      await page.type(selector, value, { delay });
    },

    // Wait for navigation OR a selector to appear (for SPAs that don't navigate)
    async waitNavOrSelector(page, selectors, timeout = 30000) {
      return Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout }).catch(() => null),
        ...selectors.map(s => page.waitForSelector(s, { timeout }).catch(() => null)),
      ]);
    },

    // Parse EUR amounts in Greek format:  "123,45 €"  or  "€ 1.234,56"
    parseAmount(text) {
      if (!text) return 0;
      const cleaned = text.replace(/[^0-9.,]/g, '');
      // Greek: 1.234,56  →  remove dots, comma→dot
      if (/\\d{1,3}(\\.\\d{3})*(,\\d{1,2})?$/.test(cleaned)) {
        return parseFloat(cleaned.replace(/\\./g, '').replace(',', '.')) || 0;
      }
      // English: 1,234.56  →  remove commas
      return parseFloat(cleaned.replace(/,/g, '')) || 0;
    },

    // Parse Greek dates (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD)
    parseDate(text) {
      if (!text) return null;
      const t = text.trim();
      // Greek month names
      const months = {
        'Ιαν':1,'Φεβ':2,'Μαρ':3,'Απρ':4,'Μαΐ':5,'Μάι':5,'Ιουν':6,'Ιούν':6,
        'Ιουλ':7,'Ιούλ':7,'Αυγ':8,'Αύγ':8,'Σεπ':9,'Οκτ':10,'Νοε':11,'Νοέ':11,'Δεκ':12,
        'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,
        'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12
      };
      // "15 Φεβ 2025" or "15 Feb 2025"
      const monthMatch = t.match(/(\\d{1,2})\\s+(\\S+)\\s+(\\d{4})/);
      if (monthMatch) {
        const m = months[monthMatch[2]];
        if (m) return monthMatch[3] + '-' + String(m).padStart(2,'0') + '-' + monthMatch[1].padStart(2,'0');
      }
      // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
      const dmy = t.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
      if (dmy) return dmy[3] + '-' + dmy[2].padStart(2,'0') + '-' + dmy[1].padStart(2,'0');
      // YYYY-MM-DD
      const ymd = t.match(/(\\d{4})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{1,2})/);
      if (ymd) return ymd[1] + '-' + ymd[2].padStart(2,'0') + '-' + ymd[3].padStart(2,'0');
      return null;
    },

    // Take a labelled screenshot and add to debug log
    async snap(page, debug, label) {
      try {
        const shot = await page.screenshot({ encoding: 'base64', fullPage: false });
        debug.push({ step: label, ts: Date.now(), hasScreenshot: true });
        return shot;
      } catch { debug.push({ step: label, ts: Date.now(), screenshotFailed: true }); return null; }
    },

    // Generate a deterministic reference from bill content (no Date.now())
    // Same bill always produces same hash → prevents duplicate inserts
    stableRef(provider, amount, dueDate, index) {
      const input = provider + '|' + (typeof amount === 'number' ? amount.toFixed(2) : String(amount)) + '|' + (dueDate || '') + '|' + index;
      let h = 0;
      for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
      return provider + '-' + Math.abs(h).toString(36).padStart(6, '0');
    },

    // Detect common error/alert messages on page
    async detectError(page) {
      const errorSels = [
        '.error', '.alert-danger', '.alert-error', '.login-error',
        '.error-message', '.field-error', '[role="alert"]',
        '.notification--error', '.MuiAlert-standardError'
      ];
      for (const sel of errorSels) {
        const el = await page.$(sel);
        if (el) {
          const text = await page.evaluate(e => e.textContent, el);
          if (text && text.trim().length > 0) return text.trim();
        }
      }
      return null;
    }
  };
`;

// ---------------------------------------------------------------------------
// DEH (PPC / ΔΕΗ) – mydei.dei.gr – Next.js SPA
// ---------------------------------------------------------------------------
// Verified URLs:
//   Login:       https://mydei.dei.gr/el/login/
//   Dashboard:   https://mydei.dei.gr/el/dashboard/
//   Supplies:    https://mydei.dei.gr/el/accounts/
//   Bills:       https://mydei.dei.gr/el/account/
//   Bill detail: https://mydei.dei.gr/el/account-details-page/
// Built with Next.js (React), forms are JS-rendered inside #__next.
// ---------------------------------------------------------------------------

function getDEHScraperCode(): string {
  return `
    ${BROWSER_HELPERS}

    export default async function({ page, context }) {
      const debug = [];
      let lastScreenshot = null;

      try {
        // -- viewport & headers for stealth --
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8' });

        // -- Navigate to login --
        debug.push({ step: 'navigate_login', url: 'https://mydei.dei.gr/el/login/' });
        await page.goto('https://mydei.dei.gr/el/login/', {
          waitUntil: 'networkidle2', timeout: 40000
        });
        // Next.js hydration: wait for the React root to contain the form
        await page.waitForSelector('#__next', { timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000)); // let React hydrate
        lastScreenshot = await helpers.snap(page, debug, 'login_page_loaded');

        // -- Find and fill login form --
        // myDEI login has email + password inputs. The Next.js app renders
        // them dynamically so we use broad selectors with fallbacks.
        const emailSelectors = [
          'input[type="email"]',
          'input[name="email"]',
          'input[autocomplete="email"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="Email" i]',
          'input[placeholder*="e-mail" i]',
          '#email',
          'input[name="username"]',
        ];
        const passwordSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[autocomplete="current-password"]',
          '#password',
        ];

        const emailField = await helpers.waitAny(page, emailSelectors, 10000);
        if (!emailField) {
          lastScreenshot = await helpers.snap(page, debug, 'email_field_not_found');
          throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate email input on DEH login page');
        }
        debug.push({ step: 'found_email_field', selector: emailField.selector });

        const pwdField = await helpers.waitAny(page, passwordSelectors, 5000);
        if (!pwdField) throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate password input');

        await helpers.safeType(page, emailField.selector, context.username, 30);
        await helpers.safeType(page, pwdField.selector, context.password, 30);
        lastScreenshot = await helpers.snap(page, debug, 'credentials_entered');

        // -- Submit login --
        debug.push({ step: 'submit_login' });
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'form button',
          'button:not([type="button"])',
        ];
        const submitBtn = await helpers.waitAny(page, submitSelectors, 5000);
        if (!submitBtn) throw new Error('LOGIN_FORM_NOT_FOUND: No submit button found');

        await Promise.all([
          helpers.waitNavOrSelector(page, [
            '[class*="dashboard"]', '[class*="account"]', '[class*="error"]',
            '.alert', '[role="alert"]'
          ], 30000),
          page.click(submitBtn.selector),
        ]);
        await new Promise(r => setTimeout(r, 3000)); // SPA transition settle

        // -- Check for login error --
        const loginErr = await helpers.detectError(page);
        if (loginErr) {
          lastScreenshot = await helpers.snap(page, debug, 'login_error');
          throw new Error('LOGIN_FAILED: ' + loginErr.substring(0, 200));
        }

        const currentUrl = page.url();
        debug.push({ step: 'post_login', url: currentUrl });
        lastScreenshot = await helpers.snap(page, debug, 'post_login');

        // If still on login page, login failed
        if (currentUrl.includes('/login')) {
          throw new Error('LOGIN_FAILED: Still on login page after submit');
        }

        // -- Navigate to bills --
        debug.push({ step: 'navigate_bills' });
        // Try the supplies/accounts page first, then the bill page
        await page.goto('https://mydei.dei.gr/el/accounts/', {
          waitUntil: 'networkidle2', timeout: 30000
        });
        await new Promise(r => setTimeout(r, 2000));
        lastScreenshot = await helpers.snap(page, debug, 'accounts_page');

        // -- Extract bills --
        debug.push({ step: 'extract_bills' });

        // Strategy: scan the page for any elements that look like bill cards,
        // table rows, or list items containing amounts and dates. We cast a
        // wide net because the exact DOM depends on myDEI's current deploy.
        const bills = await page.evaluate(() => {
          const results = [];
          const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };

          // Helper: recursively extract text content, cleaning whitespace
          const text = el => (el?.textContent || '').replace(/\\s+/g, ' ').trim();

          // ---- Strategy A: find card/row elements containing euro amounts ----
          const containers = document.querySelectorAll(
            '[class*="bill"], [class*="Bill"], [class*="invoice"], [class*="Invoice"], ' +
            '[class*="card"], [class*="Card"], [class*="account"], ' +
            'table tbody tr, [class*="row"], [class*="Row"], li'
          );

          for (const el of containers) {
            const raw = text(el);
            // Must contain a euro amount pattern
            const amountMatch = raw.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
            if (!amountMatch) continue;

            const amountStr = amountMatch[1] || amountMatch[2];
            const amount = parseFloat(amountStr.replace(/\\./g, '').replace(',', '.')) || 0;
            if (amount <= 0) continue;

            // Look for a date
            const dateMatch = raw.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
            const dueDate = dateMatch
              ? dateMatch[3] + '-' + dateMatch[2].padStart(2,'0') + '-' + dateMatch[1].padStart(2,'0')
              : null;

            // Look for a reference / account / bill number
            const refMatch = raw.match(/(?:αρ\\.?|no\\.?|#|ref|κωδ)\\s*[:.]?\\s*([A-Z0-9-]{4,})/i)
              || raw.match(/([A-Z0-9]{8,})/);

            results.push({
              title: 'Λογαριασμός Ρεύματος ΔΕΗ',
              amount,
              due_date: dueDate || '',
              reference_number: refMatch ? refMatch[1] : _ref('DEH', amount, dueDate, results.length),
              bill_type: 'electricity',
            });
          }

          // ---- Strategy B: if no cards found, try extracting from Next.js __NEXT_DATA__ ----
          if (results.length === 0) {
            try {
              const nextDataEl = document.querySelector('#__NEXT_DATA__');
              if (nextDataEl) {
                const data = JSON.parse(nextDataEl.textContent);
                const walk = (obj) => {
                  if (!obj || typeof obj !== 'object') return;
                  if (Array.isArray(obj)) { obj.forEach(walk); return; }
                  // Look for objects that look like bill data
                  if (obj.amount && (obj.dueDate || obj.due_date || obj.deadline)) {
                    results.push({
                      title: obj.title || obj.description || 'Λογαριασμός ΔΕΗ',
                      amount: parseFloat(String(obj.amount).replace(',','.')) || 0,
                      due_date: obj.dueDate || obj.due_date || obj.deadline || '',
                      reference_number: obj.referenceNumber || obj.reference || obj.id || _ref('DEH', parseFloat(String(obj.amount).replace(',','.')) || 0, obj.dueDate || obj.due_date || '', results.length),
                      bill_type: 'electricity',
                    });
                  }
                  Object.values(obj).forEach(walk);
                };
                walk(data?.props?.pageProps);
              }
            } catch {}
          }

          return results;
        });

        debug.push({ step: 'bills_extracted', count: bills.length });
        lastScreenshot = await helpers.snap(page, debug, 'extraction_done');

        // If accounts page had no bills, try the individual bill page
        if (bills.length === 0) {
          debug.push({ step: 'try_account_page' });
          await page.goto('https://mydei.dei.gr/el/account/', {
            waitUntil: 'networkidle2', timeout: 20000
          });
          await new Promise(r => setTimeout(r, 2000));
          lastScreenshot = await helpers.snap(page, debug, 'account_page');

          // Re-run extraction on this page
          const moreBills = await page.evaluate(() => {
            const results = [];
            const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
            const raw = document.body.innerText || '';
            const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);

            for (let i = 0; i < lines.length; i++) {
              const amountMatch = lines[i].match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (!amountMatch) continue;
              const amountStr = amountMatch[1] || amountMatch[2];
              const amount = parseFloat(amountStr.replace(/\\./g, '').replace(',', '.')) || 0;
              if (amount <= 0) continue;

              // Search nearby lines for dates
              let dueDate = '';
              for (let j = Math.max(0, i-3); j < Math.min(lines.length, i+4); j++) {
                const dm = lines[j].match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
                if (dm) {
                  dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0');
                  break;
                }
              }

              results.push({
                title: 'Λογαριασμός Ρεύματος ΔΕΗ',
                amount,
                due_date: dueDate,
                reference_number: _ref('DEH', amount, dueDate, results.length),
                bill_type: 'electricity',
              });
            }
            return results;
          });

          if (moreBills.length > 0) bills.push(...moreBills);
          debug.push({ step: 'account_page_bills', count: moreBills.length });
        }

        return { data: { success: true, bills, debug, screenshot: lastScreenshot }, type: 'application/json' };

      } catch (error) {
        debug.push({ step: 'error', message: error.message });
        if (!lastScreenshot) lastScreenshot = await helpers.snap(page, debug, 'error_state');
        const code = error.message.startsWith('LOGIN_FAILED') ? 'LOGIN_FAILED'
          : error.message.startsWith('LOGIN_FORM_NOT_FOUND') ? 'SCRAPER_BROKEN'
          : 'SCRAPER_ERROR';
        return { data: { success: false, bills: [], error: error.message, error_code: code, debug, screenshot: lastScreenshot }, type: 'application/json' };
      }
    }
  `;
}

async function scrapeDEH(username: string, password: string): Promise<ScraperResult> {
  return runBrowserless(getDEHScraperCode(), { username, password });
}

// ---------------------------------------------------------------------------
// EYDAP (ΕΥΔΑΠ) – eydap.gr – ASP.NET MVC
// ---------------------------------------------------------------------------
// Login URLs (try in order):
//   1. https://www.eydap.gr/userLogin/         (current portal)
//   2. https://www.eydap.gr/MyAccount/LogIn    (legacy path)
// Bills URLs (try in order):
//   1. https://www.eydap.gr/MyAccount/MyCurrentAccountAM/
//   2. https://www.eydap.gr/en/myaccount/currentbilldetails
// ASP.NET forms use standard <input name="..."> fields.
// Login fields: customerCode / waterMeterNo + password
// ---------------------------------------------------------------------------

function getEYDAPScraperCode(): string {
  return `
    ${BROWSER_HELPERS}

    export default async function({ page, context }) {
      const debug = [];
      let lastScreenshot = null;

      try {
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8' });

        // -- Navigate to login (try current URL first, then legacy) --
        debug.push({ step: 'navigate_login' });
        const loginUrls = [
          'https://www.eydap.gr/userLogin/',
          'https://www.eydap.gr/MyAccount/LogIn',
        ];
        let loginLoaded = false;
        for (const loginUrl of loginUrls) {
          try {
            await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            loginLoaded = true;
            debug.push({ step: 'login_url_loaded', url: loginUrl });
            break;
          } catch (navErr) {
            debug.push({ step: 'login_url_failed', url: loginUrl, error: navErr.message });
          }
        }
        if (!loginLoaded) throw new Error('SCRAPER_BROKEN: Could not load any EYDAP login page');
        await new Promise(r => setTimeout(r, 1500));
        lastScreenshot = await helpers.snap(page, debug, 'login_page_loaded');

        // -- Find login form fields --
        // EYDAP login typically uses a customer/water meter number + password
        const userSelectors = [
          'input[name="customerCode"]',
          'input[name="CustomerCode"]',
          '#customerCode', '#CustomerCode',
          'input[name="username"]',
          'input[name="Username"]',
          'input[name="waterMeterNo"]',
          'input[type="text"]:not([name="password"])',
          'input[placeholder*="κωδικ" i]',
          'input[placeholder*="αριθμ" i]',
          'input[placeholder*="μητρ" i]',
          'input[placeholder*="code" i]',
          'input[placeholder*="number" i]',
        ];
        const pwdSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[name="Password"]',
          '#password', '#Password',
        ];

        const userField = await helpers.waitAny(page, userSelectors, 10000);
        if (!userField) {
          lastScreenshot = await helpers.snap(page, debug, 'user_field_not_found');
          throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate username/customer code field');
        }
        debug.push({ step: 'found_user_field', selector: userField.selector });

        const pwdField = await helpers.waitAny(page, pwdSelectors, 5000);
        if (!pwdField) throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate password field');

        await helpers.safeType(page, userField.selector, context.username, 40);
        await helpers.safeType(page, pwdField.selector, context.password, 40);
        lastScreenshot = await helpers.snap(page, debug, 'credentials_entered');

        // -- Submit --
        debug.push({ step: 'submit_login' });
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          '.login-btn',
          'button.btn-primary',
          'a.btn-primary',
          '#loginBtn',
          'button[aria-label="Είσοδος"]',
          'button[aria-label="Login"]',
        ];
        let submitBtn = await helpers.waitAny(page, submitSelectors, 5000);
        // Fallback: find button by visible text (Puppeteer-compatible, no :has-text)
        if (!submitBtn) {
          const btnHandle = await page.evaluateHandle(() => {
            const btns = [...document.querySelectorAll('button, input[type="submit"], a.btn')];
            return btns.find(b => /Είσοδος|Login|Σύνδεση/i.test(b.textContent || b.value || '')) || null;
          });
          const asElement = btnHandle.asElement();
          if (asElement) {
            debug.push({ step: 'submit_via_text_match' });
            await Promise.all([
              helpers.waitNavOrSelector(page, ['[class*="account"]', '[class*="bill"]', '.error', '[role="alert"]'], 30000),
              asElement.click(),
            ]);
            submitBtn = true; // flag that we already clicked
          }
        }
        if (submitBtn && submitBtn.selector) {
          await Promise.all([
            helpers.waitNavOrSelector(page, ['[class*="account"]', '[class*="bill"]', '.error', '[role="alert"]'], 30000),
            page.click(submitBtn.selector),
          ]);
        } else if (!submitBtn) {
          // Final fallback: press Enter
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 2000));

        // -- Check login result --
        const loginErr = await helpers.detectError(page);
        if (loginErr) {
          lastScreenshot = await helpers.snap(page, debug, 'login_error');
          throw new Error('LOGIN_FAILED: ' + loginErr.substring(0, 200));
        }
        debug.push({ step: 'post_login', url: page.url() });
        lastScreenshot = await helpers.snap(page, debug, 'post_login');

        if (page.url().includes('/LogIn') || page.url().includes('/login')) {
          throw new Error('LOGIN_FAILED: Still on login page after submit');
        }

        // -- Navigate to current account / bills (try multiple paths) --
        debug.push({ step: 'navigate_bills' });
        const billsUrls = [
          'https://www.eydap.gr/MyAccount/MyCurrentAccountAM/',
          'https://www.eydap.gr/en/myaccount/currentbilldetails',
        ];
        for (const billsUrl of billsUrls) {
          try {
            await page.goto(billsUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            debug.push({ step: 'bills_url_loaded', url: billsUrl });
            break;
          } catch { debug.push({ step: 'bills_url_failed', url: billsUrl }); }
        }
        await new Promise(r => setTimeout(r, 2000));
        lastScreenshot = await helpers.snap(page, debug, 'bills_page');

        // -- Extract bills --
        debug.push({ step: 'extract_bills' });
        const bills = await page.evaluate(() => {
          const results = [];
          const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };

          // Strategy A: table rows (EYDAP typically shows bills in a table)
          const tables = document.querySelectorAll('table');
          for (const table of tables) {
            const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td'));
              if (cells.length < 2) continue;

              const rawTexts = cells.map(c => (c.textContent || '').trim());
              const fullText = rawTexts.join(' ');

              // Find amount (look for euro pattern)
              let amount = 0;
              for (const t of rawTexts) {
                const m = t.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
                if (m) {
                  const val = parseFloat(m[1].replace(/\\./g, '').replace(',', '.'));
                  if (val > amount) amount = val;
                }
              }
              if (amount <= 0) continue;

              // Find date
              let dueDate = '';
              for (const t of rawTexts) {
                const dm = t.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
                if (dm) {
                  dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0');
                  break;
                }
              }

              // First cell often has reference
              const ref = rawTexts[0].match(/[A-Z0-9-]{4,}/)?.[0] || '';

              results.push({
                title: 'Λογαριασμός Ύδρευσης ΕΥΔΑΠ',
                amount,
                due_date: dueDate,
                reference_number: ref || _ref('EYDAP', amount, dueDate, results.length),
                bill_type: 'water',
              });
            }
          }

          // Strategy B: non-table card layout
          if (results.length === 0) {
            const containers = document.querySelectorAll(
              '[class*="bill"], [class*="Bill"], [class*="invoice"], ' +
              '[class*="payment"], [class*="Payment"], .card, .panel'
            );
            for (const el of containers) {
              const raw = (el.textContent || '').replace(/\\s+/g, ' ').trim();
              const amtMatch = raw.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (!amtMatch) continue;
              const amtStr = amtMatch[1] || amtMatch[2];
              const amount = parseFloat(amtStr.replace(/\\./g, '').replace(',', '.')) || 0;
              if (amount <= 0) continue;

              const dateMatch = raw.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
              const dueDate = dateMatch
                ? dateMatch[3] + '-' + dateMatch[2].padStart(2,'0') + '-' + dateMatch[1].padStart(2,'0')
                : '';

              results.push({
                title: 'Λογαριασμός Ύδρευσης ΕΥΔΑΠ',
                amount,
                due_date: dueDate,
                reference_number: _ref('EYDAP', amount, dueDate, results.length),
                bill_type: 'water',
              });
            }
          }

          return results;
        });

        debug.push({ step: 'bills_extracted', count: bills.length });
        lastScreenshot = await helpers.snap(page, debug, 'extraction_done');

        return { data: { success: true, bills, debug, screenshot: lastScreenshot }, type: 'application/json' };

      } catch (error) {
        debug.push({ step: 'error', message: error.message });
        if (!lastScreenshot) lastScreenshot = await helpers.snap(page, debug, 'error_state');
        const code = error.message.startsWith('LOGIN_FAILED') ? 'LOGIN_FAILED'
          : error.message.startsWith('LOGIN_FORM_NOT_FOUND') ? 'SCRAPER_BROKEN'
          : 'SCRAPER_ERROR';
        return { data: { success: false, bills: [], error: error.message, error_code: code, debug, screenshot: lastScreenshot }, type: 'application/json' };
      }
    }
  `;
}

async function scrapeEYDAP(username: string, password: string): Promise<ScraperResult> {
  return runBrowserless(getEYDAPScraperCode(), { username, password });
}

// ---------------------------------------------------------------------------
// COSMOTE – account.cosmote.gr → my.cosmote.gr – SPA
// ---------------------------------------------------------------------------
// Verified URLs:
//   Login:     https://account.cosmote.gr/user-login
//   After auth redirects to my.cosmote.gr
//   eBill:     Now integrated into My COSMOTE (old ebill.cosmote.gr deprecated)
//   Bill list: https://my.cosmote.gr/  (SPA route, bills section)
// Two-step login: enter email/phone → password on second screen.
// ---------------------------------------------------------------------------

function getCOSMOTEScraperCode(): string {
  return `
    ${BROWSER_HELPERS}

    export default async function({ page, context }) {
      const debug = [];
      let lastScreenshot = null;

      try {
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8' });

        // -- Navigate to login --
        debug.push({ step: 'navigate_login' });
        await page.goto('https://account.cosmote.gr/user-login', {
          waitUntil: 'networkidle2', timeout: 40000
        });
        await new Promise(r => setTimeout(r, 2000));
        lastScreenshot = await helpers.snap(page, debug, 'login_page_loaded');

        // -- COSMOTE uses two-step login: username first, then password --

        // Step 1: Enter username (email or phone)
        const userSelectors = [
          'input[name="username"]',
          'input[name="email"]',
          '#username', '#email',
          'input[type="email"]',
          'input[type="tel"]',
          'input[autocomplete="username"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="τηλέφωνο" i]',
          'input[placeholder*="phone" i]',
          'input[placeholder*="κινητό" i]',
        ];

        const userField = await helpers.waitAny(page, userSelectors, 10000);
        if (!userField) {
          lastScreenshot = await helpers.snap(page, debug, 'user_field_not_found');
          throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate username field on COSMOTE');
        }
        debug.push({ step: 'found_user_field', selector: userField.selector });
        await helpers.safeType(page, userField.selector, context.username, 30);

        // Look for a "Next" or "Continue" button (two-step flow)
        const nextSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button.next',
          'button.continue',
          'button[class*="next" i]',
          'button[class*="continue" i]',
          'button[class*="submit" i]',
          'button:not([type="button"])',
        ];
        const nextBtn = await helpers.waitAny(page, nextSelectors, 5000);
        if (nextBtn) {
          debug.push({ step: 'click_next' });
          await page.click(nextBtn.selector);
          await new Promise(r => setTimeout(r, 3000));
          lastScreenshot = await helpers.snap(page, debug, 'after_username_step');
        }

        // Step 2: Enter password
        const pwdSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          '#password',
          'input[autocomplete="current-password"]',
        ];
        const pwdField = await helpers.waitAny(page, pwdSelectors, 10000);
        if (!pwdField) {
          // Maybe single-step login, check if already past login
          if (!page.url().includes('login') && !page.url().includes('account.cosmote')) {
            debug.push({ step: 'single_step_login_detected' });
          } else {
            lastScreenshot = await helpers.snap(page, debug, 'pwd_field_not_found');
            throw new Error('LOGIN_FORM_NOT_FOUND: Could not locate password field');
          }
        } else {
          await helpers.safeType(page, pwdField.selector, context.password, 30);
          lastScreenshot = await helpers.snap(page, debug, 'password_entered');

          // Submit
          debug.push({ step: 'submit_login' });
          const submitBtn = await helpers.waitAny(page, nextSelectors, 5000);
          if (submitBtn) {
            await Promise.all([
              helpers.waitNavOrSelector(page, [
                '[class*="dashboard"]', '[class*="bill"]', '[class*="account"]',
                '.error', '[role="alert"]'
              ], 30000),
              page.click(submitBtn.selector),
            ]);
          } else {
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          }
          await new Promise(r => setTimeout(r, 3000));
        }

        // -- Check login result --
        const loginErr = await helpers.detectError(page);
        if (loginErr) {
          lastScreenshot = await helpers.snap(page, debug, 'login_error');
          throw new Error('LOGIN_FAILED: ' + loginErr.substring(0, 200));
        }
        debug.push({ step: 'post_login', url: page.url() });
        lastScreenshot = await helpers.snap(page, debug, 'post_login');

        if (page.url().includes('/user-login') || page.url().includes('/login')) {
          throw new Error('LOGIN_FAILED: Still on login page after submit');
        }

        // -- Navigate to billing --
        debug.push({ step: 'navigate_bills' });
        // After login we should be on my.cosmote.gr. Try to navigate to billing.
        // The old JSP path is deprecated; the SPA handles it through routes.
        const billUrls = [
          'https://my.cosmote.gr/selfcare/jsp/billing.jsp',
          'https://my.cosmote.gr/selfcare/jsp/bill-analysis.jsp',
          'https://my.cosmote.gr/',
        ];

        let navigatedToBills = false;
        for (const billUrl of billUrls) {
          try {
            await page.goto(billUrl, { waitUntil: 'networkidle2', timeout: 20000 });
            await new Promise(r => setTimeout(r, 2000));
            navigatedToBills = true;
            debug.push({ step: 'navigated_to', url: billUrl });
            break;
          } catch { continue; }
        }

        if (!navigatedToBills) {
          debug.push({ step: 'bill_nav_fallback', url: page.url() });
        }
        lastScreenshot = await helpers.snap(page, debug, 'bills_page');

        // -- Extract bills --
        debug.push({ step: 'extract_bills' });
        const bills = await page.evaluate(() => {
          const results = [];
          const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
          const bodyText = document.body.innerText || '';

          // Strategy A: structured elements
          const containers = document.querySelectorAll(
            '[class*="bill"], [class*="Bill"], [class*="invoice"], [class*="Invoice"], ' +
            '[class*="payment"], [class*="Payment"], [class*="charge"], ' +
            'table tbody tr, .card, [class*="card"]'
          );

          for (const el of containers) {
            const raw = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            const amtMatch = raw.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
            if (!amtMatch) continue;

            const amtStr = amtMatch[1] || amtMatch[2];
            const amount = parseFloat(amtStr.replace(/\\./g, '').replace(',', '.')) || 0;
            if (amount <= 0) continue;

            const dateMatch = raw.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
            const dueDate = dateMatch
              ? dateMatch[3] + '-' + dateMatch[2].padStart(2,'0') + '-' + dateMatch[1].padStart(2,'0')
              : '';

            // Determine type
            const lc = raw.toLowerCase();
            const isInternet = lc.includes('internet') || lc.includes('fiber') || lc.includes('ftth');
            const billType = isInternet ? 'internet' : 'mobile';

            const refMatch = raw.match(/([A-Z0-9]{8,})/);

            results.push({
              title: isInternet ? 'Λογαριασμός Internet COSMOTE' : 'Λογαριασμός Κινητής COSMOTE',
              amount,
              due_date: dueDate,
              reference_number: refMatch ? refMatch[1] : _ref('COS', amount, dueDate, results.length),
              bill_type: billType,
            });
          }

          // Strategy B: text scan for amounts if no structured elements found
          if (results.length === 0) {
            const lines = bodyText.split('\\n').map(l => l.trim()).filter(Boolean);
            for (let i = 0; i < lines.length; i++) {
              const amtMatch = lines[i].match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (!amtMatch) continue;
              const amtStr = amtMatch[1] || amtMatch[2];
              const amount = parseFloat(amtStr.replace(/\\./g, '').replace(',', '.')) || 0;
              if (amount <= 0 || amount > 10000) continue; // sanity check

              let dueDate = '';
              for (let j = Math.max(0,i-3); j < Math.min(lines.length,i+4); j++) {
                const dm = lines[j].match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
                if (dm) { dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0'); break; }
              }

              results.push({
                title: 'Λογαριασμός COSMOTE',
                amount,
                due_date: dueDate,
                reference_number: _ref('COS', amount, dueDate, results.length),
                bill_type: 'telecom',
              });
            }
          }

          return results;
        });

        debug.push({ step: 'bills_extracted', count: bills.length });
        lastScreenshot = await helpers.snap(page, debug, 'extraction_done');

        return { data: { success: true, bills, debug, screenshot: lastScreenshot }, type: 'application/json' };

      } catch (error) {
        debug.push({ step: 'error', message: error.message });
        if (!lastScreenshot) lastScreenshot = await helpers.snap(page, debug, 'error_state');
        const code = error.message.startsWith('LOGIN_FAILED') ? 'LOGIN_FAILED'
          : error.message.startsWith('LOGIN_FORM_NOT_FOUND') ? 'SCRAPER_BROKEN'
          : 'SCRAPER_ERROR';
        return { data: { success: false, bills: [], error: error.message, error_code: code, debug, screenshot: lastScreenshot }, type: 'application/json' };
      }
    }
  `;
}

async function scrapeCOSMOTE(username: string, password: string): Promise<ScraperResult> {
  return runBrowserless(getCOSMOTEScraperCode(), { username, password });
}

// ---------------------------------------------------------------------------
// AADE (ΑΑΔΕ) – TaxisNet / GSIS – login.jsp + debt info
// ---------------------------------------------------------------------------
// GSIS Login URLs (try in order):
//   1. https://www1.gsis.gr/gsisapps/soasgsisws/login.jsp   (classic JSP)
//   2. https://oauth2.gsis.gr/                                (new OAuth2 endpoint since Sep 2024)
//   3. https://login.gsis.gr/                                 (alternate)
// Debt info:
//   - https://www1.gsis.gr/taxisnet/info/protected/displayDebtInfo.htm
//   - https://www1.aade.gr/aadeapps3/myaade/
// Login form uses standard JSP form POST with username (AFM) + password.
// May trigger 2FA / OTP redirect.
// ---------------------------------------------------------------------------

function getAADEScraperCode(): string {
  return `
    ${BROWSER_HELPERS}

    export default async function({ page, context }) {
      const debug = [];
      let lastScreenshot = null;

      try {
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8' });

        // -- Navigate to GSIS TaxisNet login (try multiple endpoints) --
        debug.push({ step: 'navigate_login' });
        const gsisLoginUrls = [
          'https://www1.gsis.gr/gsisapps/soasgsisws/login.jsp',
          'https://oauth2.gsis.gr/',
          'https://login.gsis.gr/',
        ];
        let gsisLoaded = false;
        for (const gsisUrl of gsisLoginUrls) {
          try {
            await page.goto(gsisUrl, { waitUntil: 'networkidle2', timeout: 25000 });
            gsisLoaded = true;
            debug.push({ step: 'gsis_url_loaded', url: gsisUrl, redirectedTo: page.url() });
            break;
          } catch (navErr) {
            debug.push({ step: 'gsis_url_failed', url: gsisUrl, error: navErr.message });
          }
        }
        if (!gsisLoaded) throw new Error('SCRAPER_BROKEN: Could not load any GSIS login page');
        await new Promise(r => setTimeout(r, 1500));
        lastScreenshot = await helpers.snap(page, debug, 'gsis_login_loaded');

        // -- Fill TaxisNet login form --
        // GSIS login.jsp uses a standard HTML form. The AFM field is typically
        // named "userId" and password is "password".
        const userSelectors = [
          'input[name="userId"]',
          'input[name="username"]',
          'input[name="afm"]',
          '#userId', '#username',
          'input[type="text"]',
        ];
        const pwdSelectors = [
          'input[name="password"]',
          'input[type="password"]',
          '#password',
        ];

        const userField = await helpers.waitAny(page, userSelectors, 10000);
        if (!userField) {
          lastScreenshot = await helpers.snap(page, debug, 'gsis_user_field_not_found');
          throw new Error('LOGIN_FORM_NOT_FOUND: Could not find TaxisNet AFM field');
        }
        debug.push({ step: 'found_user_field', selector: userField.selector });

        const pwdField = await helpers.waitAny(page, pwdSelectors, 5000);
        if (!pwdField) throw new Error('LOGIN_FORM_NOT_FOUND: Could not find TaxisNet password field');

        await helpers.safeType(page, userField.selector, context.username, 50);
        await helpers.safeType(page, pwdField.selector, context.password, 50);
        lastScreenshot = await helpers.snap(page, debug, 'gsis_credentials_entered');

        // -- Submit --
        debug.push({ step: 'submit_login' });
        const submitSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          'input[value*="Είσοδος"]',
          'input[value*="Login"]',
          'input[name="btn_login"]',
          '.login-btn',
        ];
        const submitBtn = await helpers.waitAny(page, submitSelectors, 5000);
        if (submitBtn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(submitBtn.selector),
          ]);
        } else {
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 3000));
        lastScreenshot = await helpers.snap(page, debug, 'post_login');

        const currentUrl = page.url();
        debug.push({ step: 'post_login_url', url: currentUrl });

        // -- Detect 2FA / OTP prompt --
        const pageText = await page.evaluate(() => document.body.innerText || '');
        const needs2FA = pageText.includes('OTP') ||
          pageText.includes('μίας χρήσης') ||
          pageText.includes('κωδικό επιβεβαίωσης') ||
          pageText.includes('one-time') ||
          pageText.includes('authenticator') ||
          currentUrl.includes('otp') ||
          currentUrl.includes('2fa') ||
          currentUrl.includes('mfa');

        if (needs2FA) {
          lastScreenshot = await helpers.snap(page, debug, '2fa_detected');
          throw new Error('2FA_REQUIRED: TaxisNet OTP/2FA verification required. Please use manual entry or provide OTP.');
        }

        // -- Check login errors --
        const loginErr = await helpers.detectError(page);
        if (loginErr) {
          throw new Error('LOGIN_FAILED: ' + loginErr.substring(0, 200));
        }

        // Still on login page?
        if (currentUrl.includes('login.jsp') || currentUrl.includes('login.htm') ||
            currentUrl.includes('oauth2.gsis.gr') || currentUrl.includes('login.gsis.gr')) {
          const bodyText = await page.evaluate(() => document.body.innerText || '');
          const errMsg = bodyText.includes('Λάθος') || bodyText.includes('error') || bodyText.includes('λανθασμέν')
            ? 'Invalid credentials' : 'Login did not redirect';
          throw new Error('LOGIN_FAILED: ' + errMsg);
        }

        // -- Navigate to debt info (Πληροφορίες Οφειλών) --
        debug.push({ step: 'navigate_debt_info' });
        try {
          await page.goto('https://www1.gsis.gr/taxisnet/info/protected/displayDebtInfo.htm', {
            waitUntil: 'networkidle2', timeout: 30000
          });
        } catch {
          // Fallback: try myAADE
          await page.goto('https://www1.aade.gr/aadeapps3/myaade/', {
            waitUntil: 'networkidle2', timeout: 30000
          });
        }
        await new Promise(r => setTimeout(r, 2000));
        lastScreenshot = await helpers.snap(page, debug, 'debt_info_page');

        // -- Extract debt/tax obligations --
        debug.push({ step: 'extract_bills' });
        const bills = await page.evaluate(() => {
          const results = [];
          const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };

          // TaxisNet debt info uses HTML tables with installment lines.
          // Known selectors from taxisnet_cp userscript: #installLine, #amnt1, #amnt3
          // Also look for "Ταυτότητα Οφειλής" (Debt Identity)

          // Strategy A: specific TaxisNet selectors
          const debtRows = document.querySelectorAll(
            '#installLine, tr[id*="install"], tr[id*="debt"], ' +
            'table tr'
          );

          for (const row of debtRows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 2) continue;

            const rawTexts = cells.map(c => (c.textContent || '').trim());
            const fullText = rawTexts.join(' ');

            // Must contain a number that looks like money
            let amount = 0;
            for (const t of rawTexts) {
              const m = t.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (m) {
                const val = parseFloat(m[1].replace(/\\./g, '').replace(',', '.'));
                if (val > amount) amount = val;
              }
            }
            if (amount <= 0) continue;

            // Find date
            let dueDate = '';
            for (const t of rawTexts) {
              const dm = t.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
              if (dm) {
                dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0');
                break;
              }
            }

            // Find debt identity / reference
            const refMatch = fullText.match(/(?:Ταυτότητα|ταυτότητα|ID|Αρ\\.?)\\s*[:.]?\\s*([A-Z0-9-]{4,})/i)
              || fullText.match(/([0-9]{10,})/);

            // Determine type from context
            let billType = 'tax';
            const lc = fullText.toLowerCase();
            if (lc.includes('φπα') || lc.includes('vat')) billType = 'vat';
            else if (lc.includes('εισόδημα') || lc.includes('income')) billType = 'income_tax';
            else if (lc.includes('ενφια') || lc.includes('enfia')) billType = 'property_tax';

            results.push({
              title: 'Φορολογική Οφειλή ΑΑΔΕ',
              amount,
              due_date: dueDate,
              reference_number: refMatch ? refMatch[1] : _ref('AADE', amount, dueDate, results.length),
              bill_type: billType,
            });
          }

          // Strategy B: look for amnt1, amnt3 fields (TaxisNet specific)
          // These may be <input> (.value) or <span>/<td> (.textContent)
          if (results.length === 0) {
            try {
              const amnt1 = document.querySelector('#amnt1');
              const amnt3 = document.querySelector('#amnt3');
              if (amnt1 || amnt3) {
                const el = amnt1 || amnt3;
                const rawVal = el.value || el.textContent || el.innerText || '0';
                const amt = parseFloat(rawVal.replace(/\\./g, '').replace(',', '.'));
                if (amt > 0) {
                  results.push({
                    title: 'Φορολογική Οφειλή ΑΑΔΕ',
                    amount: amt,
                    due_date: '',
                    reference_number: _ref('AADE', amt, '', results.length),
                    bill_type: 'tax',
                  });
                }
              }
            } catch (stratBErr) {
              // Log but don't crash — Strategy C will try next
            }
          }

          // Strategy C: broad text scan
          if (results.length === 0) {
            const allText = document.body.innerText || '';
            const lines = allText.split('\\n').filter(l => l.trim());
            for (let i = 0; i < lines.length; i++) {
              const m = lines[i].match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (!m) continue;
              const amtStr = m[1] || m[2];
              const amount = parseFloat(amtStr.replace(/\\./g, '').replace(',', '.'));
              if (amount <= 0 || amount > 1000000) continue;

              let dueDate = '';
              for (let j = Math.max(0,i-3); j < Math.min(lines.length,i+4); j++) {
                const dm = lines[j].match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
                if (dm) { dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0'); break; }
              }

              results.push({
                title: 'Οφειλή ΑΑΔΕ',
                amount,
                due_date: dueDate,
                reference_number: _ref('AADE', amount, dueDate, results.length),
                bill_type: 'tax',
              });
            }
          }

          return results;
        });

        debug.push({ step: 'bills_extracted', count: bills.length });
        lastScreenshot = await helpers.snap(page, debug, 'extraction_done');

        return { data: { success: true, bills, debug, screenshot: lastScreenshot }, type: 'application/json' };

      } catch (error) {
        debug.push({ step: 'error', message: error.message });
        if (!lastScreenshot) lastScreenshot = await helpers.snap(page, debug, 'error_state');
        const code = error.message.startsWith('2FA_REQUIRED') ? '2FA_REQUIRED'
          : error.message.startsWith('LOGIN_FAILED') ? 'LOGIN_FAILED'
          : error.message.startsWith('LOGIN_FORM_NOT_FOUND') ? 'SCRAPER_BROKEN'
          : 'SCRAPER_ERROR';
        return { data: { success: false, bills: [], error: error.message, error_code: code, debug, screenshot: lastScreenshot }, type: 'application/json' };
      }
    }
  `;
}

async function scrapeAADE(username: string, password: string): Promise<ScraperResult> {
  return runBrowserless(getAADEScraperCode(), { username, password });
}

// ---------------------------------------------------------------------------
// EFKA (e-ΕΦΚΑ) – TaxisNet SSO → efka portal
// ---------------------------------------------------------------------------
// Login URLs (try in order for fastest GSIS redirect):
//   1. https://apps.e-efka.gov.gr/eAccess/gsis/login.xhtml  (direct GSIS redirect)
//   2. https://apps.e-efka.gov.gr/eAccess/login.xhtml        (manual SSO button)
// After GSIS auth, redirects back to EFKA portal.
// Contribution pages:
//   - https://apps.e-efka.gov.gr/eAccess/personalAccount.xhtml
//   - https://apps.e-efka.gov.gr/eAccess/contributions.xhtml
// ---------------------------------------------------------------------------

function getEFKAScraperCode(): string {
  return `
    ${BROWSER_HELPERS}

    export default async function({ page, context }) {
      const debug = [];
      let lastScreenshot = null;

      try {
        await page.setViewport({ width: 1366, height: 768 });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8' });

        // -- Navigate to EFKA → GSIS SSO --
        // Try the direct GSIS redirect path first (auto-redirects to TaxisNet)
        // then fall back to the manual login page with SSO button.
        debug.push({ step: 'navigate_efka' });
        const efkaLoginUrls = [
          'https://apps.e-efka.gov.gr/eAccess/gsis/login.xhtml',
          'https://apps.e-efka.gov.gr/eAccess/login.xhtml',
        ];
        for (const efkaUrl of efkaLoginUrls) {
          try {
            await page.goto(efkaUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            debug.push({ step: 'efka_url_loaded', url: efkaUrl, redirectedTo: page.url() });
            break;
          } catch (navErr) {
            debug.push({ step: 'efka_url_failed', url: efkaUrl, error: navErr.message });
          }
        }
        await new Promise(r => setTimeout(r, 2000));
        lastScreenshot = await helpers.snap(page, debug, 'efka_login_loaded');

        // -- Check if we auto-redirected to GSIS, or need to click SSO button --
        const currentUrl = page.url();
        debug.push({ step: 'initial_url', url: currentUrl });

        const isOnGSIS = currentUrl.includes('gsis.gr') || currentUrl.includes('oauth2.gsis');

        if (!isOnGSIS) {
          // Look for TaxisNet login button on EFKA page
          const taxisnetBtnSelectors = [
            'a[href*="gsis"]',
            'a[href*="taxisnet"]',
            'input[value*="TaxisNet"]',
            '.taxisnet-btn',
            'a[class*="taxis"]',
            'button[class*="taxis"]',
          ];
          let taxisBtn = await helpers.waitAny(page, taxisnetBtnSelectors, 10000);

          // Fallback: find TaxisNet button by visible text (Puppeteer-compatible)
          if (!taxisBtn) {
            const btnHandle = await page.evaluateHandle(() => {
              const els = [...document.querySelectorAll('a, button, input[type="submit"]')];
              return els.find(e => /TaxisNet|Taxisnet|taxisnet|TAXISNET|GSIS|gsis/i.test(e.textContent || e.value || '')) || null;
            });
            const asElement = btnHandle ? btnHandle.asElement() : null;
            if (asElement) {
              debug.push({ step: 'click_taxisnet_sso', method: 'text_match' });
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                asElement.click(),
              ]);
              await new Promise(r => setTimeout(r, 2000));
              taxisBtn = true; // flag that we already clicked
            }
          }

          if (taxisBtn && taxisBtn.selector) {
            debug.push({ step: 'click_taxisnet_sso', selector: taxisBtn.selector });
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
              page.click(taxisBtn.selector),
            ]);
            await new Promise(r => setTimeout(r, 2000));
          } else if (!taxisBtn) {
            // Last resort: navigate directly to GSIS
            debug.push({ step: 'no_taxisnet_button_found', trying: 'direct_gsis' });
            await page.goto('https://www1.gsis.gr/gsisapps/soasgsisws/login.jsp', {
              waitUntil: 'networkidle2', timeout: 30000
            });
          }
        }

        lastScreenshot = await helpers.snap(page, debug, 'gsis_page');
        debug.push({ step: 'on_gsis_page', url: page.url() });

        // -- Fill GSIS TaxisNet login form --
        const userSelectors = [
          'input[name="userId"]',
          'input[name="username"]',
          'input[name="afm"]',
          '#userId', '#username',
          'input[type="text"]',
        ];
        const pwdSelectors = [
          'input[name="password"]',
          'input[type="password"]',
          '#password',
        ];

        const userField = await helpers.waitAny(page, userSelectors, 10000);
        if (!userField) {
          lastScreenshot = await helpers.snap(page, debug, 'gsis_user_not_found');
          throw new Error('LOGIN_FORM_NOT_FOUND: Could not find TaxisNet AFM field for EFKA SSO');
        }

        const pwdField = await helpers.waitAny(page, pwdSelectors, 5000);
        if (!pwdField) throw new Error('LOGIN_FORM_NOT_FOUND: Could not find TaxisNet password field');

        await helpers.safeType(page, userField.selector, context.username, 50);
        await helpers.safeType(page, pwdField.selector, context.password, 50);
        lastScreenshot = await helpers.snap(page, debug, 'gsis_credentials_entered');

        // Submit
        debug.push({ step: 'submit_gsis_login' });
        const submitSelectors = [
          'input[type="submit"]',
          'button[type="submit"]',
          'input[value*="Είσοδος"]',
          'input[value*="Login"]',
        ];
        const submitBtn = await helpers.waitAny(page, submitSelectors, 5000);
        if (submitBtn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.click(submitBtn.selector),
          ]);
        } else {
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }
        await new Promise(r => setTimeout(r, 3000));

        // -- Detect 2FA --
        const pageText = await page.evaluate(() => document.body.innerText || '');
        if (pageText.includes('OTP') || pageText.includes('μίας χρήσης') ||
            pageText.includes('κωδικό επιβεβαίωσης') || page.url().includes('otp')) {
          lastScreenshot = await helpers.snap(page, debug, '2fa_detected');
          throw new Error('2FA_REQUIRED: TaxisNet OTP required for EFKA access');
        }

        // -- Check login --
        const loginErr = await helpers.detectError(page);
        if (loginErr) throw new Error('LOGIN_FAILED: ' + loginErr.substring(0, 200));

        if (page.url().includes('login.jsp') || page.url().includes('login.xhtml') ||
            page.url().includes('oauth2.gsis.gr') || page.url().includes('login.gsis.gr')) {
          throw new Error('LOGIN_FAILED: Did not redirect after GSIS login');
        }

        debug.push({ step: 'post_gsis_login', url: page.url() });
        lastScreenshot = await helpers.snap(page, debug, 'post_gsis_login');

        // -- Wait for redirect back to EFKA --
        // After GSIS auth, should redirect to EFKA portal
        if (!page.url().includes('efka.gov.gr') && !page.url().includes('e-efka')) {
          debug.push({ step: 'wait_efka_redirect' });
          try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
          } catch {
            // Try navigating manually
            await page.goto('https://apps.e-efka.gov.gr/eAccess/', {
              waitUntil: 'networkidle2', timeout: 20000
            });
          }
          await new Promise(r => setTimeout(r, 2000));
        }

        debug.push({ step: 'on_efka_portal', url: page.url() });
        lastScreenshot = await helpers.snap(page, debug, 'efka_portal');

        // -- Navigate to contributions page --
        // Try known EFKA paths for individual contribution account
        const efkaUrls = [
          'https://apps.e-efka.gov.gr/eAccess/personalAccount.xhtml',
          'https://apps.e-efka.gov.gr/eAccess/contributions.xhtml',
          'https://apps.e-efka.gov.gr/eAccess/',
        ];
        for (const url of efkaUrls) {
          try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, 1500));
            debug.push({ step: 'tried_url', url });
            break;
          } catch { continue; }
        }
        lastScreenshot = await helpers.snap(page, debug, 'contributions_page');

        // -- Extract contribution bills --
        debug.push({ step: 'extract_bills' });
        const bills = await page.evaluate(() => {
          const results = [];
          const _ref = (p, amt, d, i) => { const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };

          // EFKA portal (JSF) uses standard HTML tables and forms
          const tables = document.querySelectorAll('table');
          for (const table of tables) {
            const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
            for (const row of rows) {
              const cells = Array.from(row.querySelectorAll('td'));
              if (cells.length < 2) continue;

              const rawTexts = cells.map(c => (c.textContent || '').trim());
              const fullText = rawTexts.join(' ');

              let amount = 0;
              for (const t of rawTexts) {
                const m = t.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
                if (m) {
                  const val = parseFloat(m[1].replace(/\\./g, '').replace(',', '.'));
                  if (val > amount) amount = val;
                }
              }
              if (amount <= 0) continue;

              let dueDate = '';
              for (const t of rawTexts) {
                const dm = t.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
                if (dm) { dueDate = dm[3] + '-' + dm[2].padStart(2,'0') + '-' + dm[1].padStart(2,'0'); break; }
              }

              const lc = fullText.toLowerCase();
              let billType = 'social_security';
              if (lc.includes('υγεία') || lc.includes('health')) billType = 'health_insurance';
              else if (lc.includes('σύνταξη') || lc.includes('pension')) billType = 'pension';

              results.push({
                title: 'Εισφορά e-ΕΦΚΑ',
                amount,
                due_date: dueDate,
                reference_number: rawTexts[0]?.match(/[A-Z0-9-]{4,}/)?.[0] || _ref('EFKA', amount, dueDate, results.length),
                bill_type: billType,
              });
            }
          }

          // Fallback: card/panel elements
          if (results.length === 0) {
            const panels = document.querySelectorAll(
              '[class*="panel"], [class*="card"], [class*="contribution"], ' +
              '[class*="debt"], [class*="payment"], .ui-datatable tbody tr'
            );
            for (const el of panels) {
              const raw = (el.textContent || '').replace(/\\s+/g, ' ').trim();
              const amtMatch = raw.match(/(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})\\s*€|€\\s*(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})/);
              if (!amtMatch) continue;
              const amtStr = amtMatch[1] || amtMatch[2];
              const amount = parseFloat(amtStr.replace(/\\./g, '').replace(',', '.')) || 0;
              if (amount <= 0) continue;

              const dateMatch = raw.match(/(\\d{1,2})[\\/-\\.](\\d{1,2})[\\/-\\.](\\d{4})/);
              const dueDate = dateMatch
                ? dateMatch[3] + '-' + dateMatch[2].padStart(2,'0') + '-' + dateMatch[1].padStart(2,'0')
                : '';

              results.push({
                title: 'Εισφορά e-ΕΦΚΑ',
                amount,
                due_date: dueDate,
                reference_number: _ref('EFKA', amount, dueDate, results.length),
                bill_type: 'social_security',
              });
            }
          }

          return results;
        });

        debug.push({ step: 'bills_extracted', count: bills.length });
        lastScreenshot = await helpers.snap(page, debug, 'extraction_done');

        return { data: { success: true, bills, debug, screenshot: lastScreenshot }, type: 'application/json' };

      } catch (error) {
        debug.push({ step: 'error', message: error.message });
        if (!lastScreenshot) lastScreenshot = await helpers.snap(page, debug, 'error_state');
        const code = error.message.startsWith('2FA_REQUIRED') ? '2FA_REQUIRED'
          : error.message.startsWith('LOGIN_FAILED') ? 'LOGIN_FAILED'
          : error.message.startsWith('LOGIN_FORM_NOT_FOUND') ? 'SCRAPER_BROKEN'
          : 'SCRAPER_ERROR';
        return { data: { success: false, bills: [], error: error.message, error_code: code, debug, screenshot: lastScreenshot }, type: 'application/json' };
      }
    }
  `;
}

async function scrapeEFKA(username: string, password: string): Promise<ScraperResult> {
  return runBrowserless(getEFKAScraperCode(), { username, password });
}

// ---------------------------------------------------------------------------
// Greek date parser (server-side, for processing results)
// ---------------------------------------------------------------------------

function parseGreekDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString().split("T")[0];

  const s = dateStr.trim();

  // Greek month name map
  const MONTHS: Record<string, number> = {
    "Ιαν": 1, "Φεβ": 2, "Μαρ": 3, "Απρ": 4, "Μαΐ": 5, "Μάι": 5,
    "Ιουν": 6, "Ιούν": 6, "Ιουλ": 7, "Ιούλ": 7, "Αυγ": 8, "Αύγ": 8,
    "Σεπ": 9, "Οκτ": 10, "Νοε": 11, "Νοέ": 11, "Δεκ": 12,
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
  };

  // "15 Φεβ 2025" or "15 Feb 2025"
  const monthNameMatch = s.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (monthNameMatch) {
    const m = MONTHS[monthNameMatch[2]];
    if (m) {
      return `${monthNameMatch[3]}-${String(m).padStart(2, "0")}-${monthNameMatch[1].padStart(2, "0")}`;
    }
  }

  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const dmy = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }

  // YYYY-MM-DD (already ISO)
  const ymd = s.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`;
  }

  // Fallback
  const parsed = new Date(s);
  return isNaN(parsed.getTime())
    ? new Date().toISOString().split("T")[0]
    : parsed.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Main Edge Function handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let body: { provider_account_id: string };
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body", error_code: "BAD_REQUEST" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
      );
    }
    const { provider_account_id } = body;

    // Load provider account with provider details
    const { data: account, error: accountError } = await supabase
      .from("provider_accounts")
      .select("*, providers(*)")
      .eq("id", provider_account_id)
      .single();

    if (accountError || !account) {
      throw new Error("Provider account not found");
    }

    // Mark as syncing
    await supabase
      .from("provider_accounts")
      .update({ status: "syncing", updated_at: new Date().toISOString() })
      .eq("id", provider_account_id);

    // Create sync job record
    const { data: syncJob, error: syncJobError } = await supabase
      .from("sync_jobs")
      .insert({
        provider_account_id,
        user_id: account.user_id,
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (syncJobError) {
      console.error("Failed to create sync job:", syncJobError.message);
    }

    // Decrypt credentials
    const encryptionKey = await getEncryptionKey();
    const password = await decryptPassword(
      account.encrypted_password,
      account.encryption_iv,
      encryptionKey,
    );

    // Dispatch to correct scraper
    let result: ScraperResult;
    switch (account.provider_id) {
      case "DEH":
        result = await scrapeDEH(account.username, password);
        break;
      case "EYDAP":
        result = await scrapeEYDAP(account.username, password);
        break;
      case "COSMOTE":
        result = await scrapeCOSMOTE(account.username, password);
        break;
      case "AADE":
        result = await scrapeAADE(account.username, password);
        break;
      case "EFKA":
        result = await scrapeEFKA(account.username, password);
        break;
      default:
        result = {
          success: false,
          bills: [],
          error: "Unknown provider",
          error_code: "PROVIDER_NOT_FOUND",
        };
    }

    // Persist scraped bills
    let billsNew = 0;
    let billsUpdated = 0;

    if (result.success && result.bills.length > 0) {
      for (const bill of result.bills) {
        const parsedDueDate = parseGreekDate(bill.due_date);

        const { data: existingBill } = await supabase
          .from("bills")
          .select("id")
          .eq("user_id", account.user_id)
          .eq("provider_id", account.provider_id)
          .eq("reference_number", bill.reference_number)
          .maybeSingle();

        if (existingBill) {
          await supabase
            .from("bills")
            .update({
              amount: bill.amount,
              due_date: parsedDueDate,
              issue_date: bill.issue_date ? parseGreekDate(bill.issue_date) : undefined,
              payment_code: bill.payment_code || undefined,
              scraped_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingBill.id);
          billsUpdated++;
        } else {
          await supabase.from("bills").insert({
            user_id: account.user_id,
            provider_account_id,
            provider_id: account.provider_id,
            title: bill.title,
            amount: bill.amount,
            due_date: parsedDueDate,
            issue_date: bill.issue_date ? parseGreekDate(bill.issue_date) : null,
            reference_number: bill.reference_number,
            bill_type: bill.bill_type,
            payment_code: bill.payment_code || null,
            period_start: bill.period_start ? parseGreekDate(bill.period_start) : null,
            period_end: bill.period_end ? parseGreekDate(bill.period_end) : null,
            source: "scraped",
            scraped_at: new Date().toISOString(),
          });
          billsNew++;
        }
      }
    }

    // Store screenshot in Supabase Storage if available
    let screenshotUrl: string | null = null;
    if (result.screenshot) {
      try {
        const screenshotBytes = Uint8Array.from(
          atob(result.screenshot),
          (c) => c.charCodeAt(0),
        );
        const path = `sync-screenshots/${account.user_id}/${account.provider_id}/${Date.now()}.png`;
        const { data: uploadData } = await supabase.storage
          .from("evidence")
          .upload(path, screenshotBytes, { contentType: "image/png", upsert: true });
        if (uploadData) {
          // Bucket is private — store the path; frontend uses signed URLs to access
          screenshotUrl = path;
        }
      } catch {
        // Non-critical, continue
      }
    }

    // Finalize sync job
    if (syncJob) {
      const finalStatus = result.success ? "completed" : "failed";

      await supabase
        .from("sync_jobs")
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - new Date(syncJob.created_at).getTime(),
          bills_found: result.bills.length,
          bills_new: billsNew,
          bills_updated: billsUpdated,
          error_code: result.error_code,
          error_message: result.error,
          debug_log: result.debug,
          screenshot_url: screenshotUrl,
        })
        .eq("id", syncJob.id);
    }

    // Update provider account status
    const accountStatus = result.success
      ? "connected"
      : result.error_code === "2FA_REQUIRED"
        ? "needs_otp"
        : "error";

    await supabase
      .from("provider_accounts")
      .update({
        status: accountStatus,
        status_message: result.error || null,
        last_sync_at: new Date().toISOString(),
        last_sync_success: result.success,
        last_sync_bills_found: result.bills.length,
        next_sync_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        sync_count: account.sync_count + 1,
        error_count: result.success ? 0 : account.error_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", provider_account_id);

    return new Response(
      JSON.stringify({
        success: result.success,
        bills_found: result.bills.length,
        bills_new: billsNew,
        bills_updated: billsUpdated,
        error: result.error,
        error_code: result.error_code,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      },
    );
  } catch (error) {
    console.error("Sync error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
        error_code: "INTERNAL_ERROR",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});
