# N8N AUTOMATION PROMPT — FAB Bill Scraping System

> **Copy everything below this line and paste it into Claude, ChatGPT, or any AI assistant to build your n8n workflows.**

---

## PROMPT START

You are building n8n automation workflows for FAB (Fintrack Assist Bills) — a system that scrapes bills from 5 Greek government/utility portals, stores them in Supabase, and sends email notifications before due dates.

Build me complete, production-ready n8n workflow JSON files. I need **4 workflows**:

1. **`sync-single-provider`** — Scrapes bills for ONE provider account via Browserless.io
2. **`trigger-daily-sync`** — Cron-triggered orchestrator that loops all accounts and fires sync-single-provider for each
3. **`send-notifications`** — Cron-triggered email sender for bills due in 3 days (d3) and due today (d0)
4. **`add-provider-account`** — Webhook endpoint for the frontend to connect a new provider account

---

## ARCHITECTURE

```
┌──────────────┐     Cron 6AM UTC      ┌─────────────────────┐
│              │ ─────────────────────▶ │ trigger-daily-sync  │
│              │                        │  (loops accounts)   │
│              │                        └────────┬────────────┘
│              │                                 │ HTTP POST per account
│              │                                 ▼
│   n8n        │                        ┌─────────────────────┐         ┌──────────────┐
│   Server     │                        │ sync-single-provider│────────▶│ Browserless  │
│              │                        │  (scraper engine)   │  POST   │ .io (stealth)│
│              │                        └────────┬────────────┘         └──────┬───────┘
│              │                                 │                             │ Scrapes
│              │                                 │ Supabase                     ▼
│              │    Cron 8:30/9:30 UTC  ┌────────┴────────────┐    ┌───────────────────┐
│              │ ─────────────────────▶ │ send-notifications   │    │  Greek Portals    │
│              │                        │  (email via Resend)  │    │  AADE, EFKA, DEH  │
│              │                        └─────────────────────┘    │  EYDAP, COSMOTE   │
│              │    Webhook             ┌─────────────────────┐    └───────────────────┘
│              │ ◀───────────────────── │ add-provider-account│
│              │                        │  (encrypt & store)  │
└──────────────┘                        └─────────────────────┘
                                                 │
                                                 ▼
                                        ┌──────────────┐       ┌──────────────┐
                                        │  Supabase    │       │   Resend     │
                                        │  Postgres    │       │   (email)    │
                                        └──────────────┘       └──────────────┘
```

---

## N8N NODES TO USE

| Task | Node Type | Details |
|------|-----------|---------|
| Scraping | **HTTP Request** node | POST to Browserless `/function` endpoint |
| Database reads/writes | **Supabase** node (built-in) | Operations: Get Row, Get All Rows, Create Row, Update Row |
| Email sending | **HTTP Request** node | POST to Resend API `https://api.resend.com/emails` |
| Credential decryption | **Code** node (JavaScript) | AES-256-GCM decrypt using Node.js `crypto` module |
| Data transformation | **Code** node | Parse scraper response, format bills |
| Conditional logic | **IF** node | Check if bills exist, if login succeeded, etc. |
| Looping | **Loop Over Items** / **SplitInBatches** | Process multiple accounts/bills |
| Scheduling | **Schedule Trigger** (Cron) | Daily triggers at specific times |
| Webhook | **Webhook** node | Frontend-facing endpoint for add-provider-account |
| Error handling | **Error Trigger** + **IF** | Catch failures, update sync_job status |
| Wait/delay | **Wait** node | 500ms–1s between Browserless calls (rate limiting) |
| Supabase auth | **HTTP Request** node | For Edge Function calls or direct REST API |

### Credentials to configure in n8n:

| Credential Name | Type | Values |
|----------------|------|--------|
| `Supabase` | Built-in Supabase credential | Host: `https://YOUR_PROJECT_REF.supabase.co`, Service Role Key |
| `BrowserlessApi` | Header Auth or Generic | Token (passed as query param, not header) |
| `ResendApi` | Header Auth | Bearer token: `RESEND_API_KEY` |
| `EncryptionKey` | n8n environment variable | `$env.ENCRYPTION_KEY` — 32-byte base64 AES key |

### n8n environment variables needed (set in `.env` or n8n Settings → Variables):

```
ENCRYPTION_KEY=<32-byte-base64-key>
BROWSERLESS_URL=https://production-sfo.browserless.io
BROWSERLESS_TOKEN=<your-token>
RESEND_API_KEY=<your-resend-key>
RESEND_FROM_EMAIL=FAB <notifications@fab.gr>
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

---

## DATABASE SCHEMA (Supabase Postgres)

### Table: `providers` (static, 5 rows — pre-seeded)

```sql
id TEXT PRIMARY KEY,          -- 'AADE', 'EFKA', 'DEH', 'EYDAP', 'COSMOTE'
name TEXT,                    -- English name
name_el TEXT,                 -- Greek name (ΑΑΔΕ, e-ΕΦΚΑ, ΔΕΗ, ΕΥΔΑΠ, COSMOTE)
category TEXT,                -- 'tax', 'insurance', 'electricity', 'water', 'telecom'
icon TEXT,                    -- emoji
color TEXT,                   -- hex
login_url TEXT,
portal_url TEXT,
auth_method TEXT,             -- 'taxisnet', 'email_password', 'account_number', 'phone_password'
requires_2fa BOOLEAN,
is_active BOOLEAN,
scraper_status TEXT           -- 'active', 'maintenance', 'broken'
```

### Table: `provider_accounts` (user's linked accounts)

```sql
id UUID PRIMARY KEY,
user_id UUID REFERENCES auth.users(id),
provider_id TEXT REFERENCES providers(id),
username TEXT,                          -- plaintext username/AFM/email
encrypted_password TEXT,                -- base64 AES-256-GCM ciphertext
encryption_iv TEXT,                     -- base64 12-byte IV
username_masked TEXT,                   -- e.g. "123****89"
status TEXT,                            -- 'pending','connected','syncing','error','needs_otp','locked','disconnected'
status_message TEXT,
last_sync_at TIMESTAMPTZ,
last_sync_success BOOLEAN,
last_sync_bills_found INTEGER,
next_sync_at TIMESTAMPTZ,
sync_count INTEGER DEFAULT 0,
error_count INTEGER DEFAULT 0,
session_cookies JSONB,
UNIQUE(user_id, provider_id)
```

### Table: `bills` (scraped invoices)

```sql
id UUID PRIMARY KEY,
user_id UUID,
provider_account_id UUID,
provider_id TEXT,
title TEXT,                             -- Greek title like "Λογαριασμός Ρεύματος ΔΕΗ"
description TEXT,
bill_type TEXT,                         -- 'electricity','water','tax','vat','income_tax','property_tax','social_security','pension','health_insurance','mobile','internet'
amount DECIMAL(12,2),                   -- EUR
currency TEXT DEFAULT 'EUR',
due_date DATE,
issue_date DATE,
period_start DATE,
period_end DATE,
status TEXT DEFAULT 'pending',          -- 'pending','paid','overdue','partial','cancelled'
paid_at TIMESTAMPTZ,
reference_number TEXT,                  -- unique per user+provider (for dedup)
barcode TEXT,
payment_code TEXT,
source TEXT DEFAULT 'scraped',
scraped_at TIMESTAMPTZ,
screenshot_url TEXT,
raw_data JSONB,
notified_d3 BOOLEAN DEFAULT FALSE,
notified_d0 BOOLEAN DEFAULT FALSE,
UNIQUE(user_id, provider_id, reference_number)
```

### Table: `sync_jobs` (scraping job history)

```sql
id UUID PRIMARY KEY,
provider_account_id UUID,
user_id UUID,
status TEXT DEFAULT 'pending',          -- 'pending','running','completed','failed','cancelled'
job_type TEXT DEFAULT 'scheduled',      -- 'scheduled','manual','retry','initial'
started_at TIMESTAMPTZ,
completed_at TIMESTAMPTZ,
duration_ms INTEGER,
bills_found INTEGER DEFAULT 0,
bills_new INTEGER DEFAULT 0,
bills_updated INTEGER DEFAULT 0,
error_code TEXT,                        -- 'LOGIN_FAILED','2FA_REQUIRED','SCRAPER_BROKEN','SCRAPER_ERROR'
error_message TEXT,
retry_count INTEGER DEFAULT 0,
max_retries INTEGER DEFAULT 3,
next_retry_at TIMESTAMPTZ,
debug_log JSONB DEFAULT '[]',
screenshot_url TEXT
```

### Table: `notifications`

```sql
id UUID PRIMARY KEY,
user_id UUID,
bill_id UUID,
type TEXT,              -- 'bill_due_d3','bill_due_d0','bill_overdue','sync_failed','sync_success'
channel TEXT,           -- 'email','push','sms','in_app'
title TEXT,
body TEXT,
status TEXT,            -- 'pending','sent','delivered','failed','read'
sent_at TIMESTAMPTZ,
scheduled_for TIMESTAMPTZ
```

---

## WORKFLOW 1: `sync-single-provider`

### Trigger
Called via **Webhook** (POST) with body:
```json
{ "provider_account_id": "uuid-here" }
```

### Step-by-step flow:

1. **Webhook** receives `provider_account_id`
2. **Supabase Get Row**: Fetch `provider_accounts` row by id. JOIN provider info.
3. **IF** node: Check if account exists and `status != 'disconnected'`
4. **Supabase Update**: Set `provider_accounts.status = 'syncing'`
5. **Supabase Create Row**: Insert `sync_jobs` row with `status = 'running'`, `started_at = NOW()`
6. **Code node**: Decrypt password using AES-256-GCM (details below)
7. **Code node**: Build the Browserless scraper code string based on `provider_id` (AADE, EFKA, DEH, EYDAP, or COSMOTE)
8. **HTTP Request**: POST to Browserless `/function` endpoint with the scraper code + credentials in context
9. **Code node**: Parse Browserless response (handle v1 vs v2 format)
10. **IF** node: Check `response.success`
11. On **success**:
    - **Loop Over Items**: For each scraped bill:
      - **Supabase Get Row**: Check if bill exists (match `user_id + provider_id + reference_number`)
      - **IF** exists → **Supabase Update** (update amount/due_date if changed)
      - **IF** not exists → **Supabase Create Row** (insert new bill)
    - **Supabase Update** sync_jobs: `status='completed'`, `bills_found`, `bills_new`, `duration_ms`
    - **Supabase Update** provider_accounts: `status='connected'`, `last_sync_at=NOW()`, `next_sync_at=NOW()+24h`, `error_count=0`
12. On **failure**:
    - **Supabase Update** sync_jobs: `status='failed'`, `error_code`, `error_message`
    - **Supabase Update** provider_accounts: `status` based on error_code (`needs_otp` if 2FA, else `error`), increment `error_count`
13. **Respond to Webhook**: Return JSON result

---

## CREDENTIAL DECRYPTION (Code Node)

```javascript
// n8n Code node — decrypt AES-256-GCM password
const crypto = require('crypto');

const encryptionKeyBase64 = $env.ENCRYPTION_KEY;
const keyBuffer = Buffer.from(encryptionKeyBase64, 'base64'); // 32 bytes

const encrypted = $input.first().json.encrypted_password;  // base64
const iv = $input.first().json.encryption_iv;              // base64

const encBuf = Buffer.from(encrypted, 'base64');
const ivBuf = Buffer.from(iv, 'base64');

// AES-256-GCM: last 16 bytes of ciphertext are the auth tag
const authTag = encBuf.slice(-16);
const ciphertext = encBuf.slice(0, -16);

const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, ivBuf);
decipher.setAuthTag(authTag);

let decrypted = decipher.update(ciphertext, undefined, 'utf8');
decrypted += decipher.final('utf8');

return [{ json: { ...$input.first().json, decrypted_password: decrypted } }];
```

**IMPORTANT**: The Web Crypto API (used by the Supabase Edge Function that encrypted the password) packs the ciphertext + auth tag together. In Node.js `crypto`, you must split them: ciphertext = `data.slice(0, -16)`, authTag = `data.slice(-16)`.

---

## CREDENTIAL ENCRYPTION (for add-provider-account workflow)

```javascript
const crypto = require('crypto');

const keyBuffer = Buffer.from($env.ENCRYPTION_KEY, 'base64');
const iv = crypto.randomBytes(12); // 12-byte IV for GCM
const password = $input.first().json.password;

const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
let encrypted = cipher.update(password, 'utf8');
encrypted = Buffer.concat([encrypted, cipher.final(), cipher.getAuthTag()]); // ciphertext + authTag

return [{
  json: {
    encrypted_password: encrypted.toString('base64'),
    encryption_iv: iv.toString('base64')
  }
}];
```

---

## BROWSERLESS INTEGRATION (HTTP Request Node)

### Configuration:

| Setting | Value |
|---------|-------|
| Method | POST |
| URL | `{{ $env.BROWSERLESS_URL }}/function?token={{ $env.BROWSERLESS_TOKEN }}&launch={"stealth":true}&timeout=120000` |
| Headers | `Content-Type: application/json` |
| Body Type | JSON |
| Body | `{ "code": "<scraper_code_string>", "context": { "username": "<decrypted>", "password": "<decrypted>" } }` |
| Timeout | 135000 (135s, safety margin above Browserless timeout) |

### Response parsing (Code node after HTTP Request):

```javascript
const response = $input.first().json;
let result;

// Browserless v2 wraps response
if (response.data && response.type) {
  result = response.data;
} else if (typeof response.success === 'boolean') {
  result = response; // v1 format
} else {
  result = { success: false, bills: [], error: 'Unexpected Browserless response format' };
}

return [{ json: result }];
```

---

## THE 5 PROVIDER SCRAPERS

Each scraper is a JavaScript function string sent to Browserless `/function`. The function receives `({ page, context })` where `page` is a Puppeteer Page and `context` has `{ username, password }`.

### Shared Helper Functions (inject at the top of EVERY scraper code string)

```javascript
// === HELPER FUNCTIONS (paste at top of every scraper) ===

async function waitAny(page, selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return { el, selector: sel };
      } catch (e) { /* invalid selector, skip */ }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function safeType(page, selector, value, delay = 50) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector, { clickCount: 3 }); // select all existing text
  await page.type(selector, value, { delay });
}

async function waitNavOrSelector(page, selectors, timeout = 30000) {
  return Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout }).catch(() => null),
    ...selectors.map(s => page.waitForSelector(s, { timeout }).catch(() => null))
  ]);
}

function parseAmount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/[€\s]/g, '').trim();
  // Greek format: 1.234,56
  if (/\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }
  // English format: 1,234.56
  return parseFloat(cleaned.replace(/,/g, ''));
}

function parseDate(text) {
  if (!text) return '';
  const months = {
    'Ιαν':1,'Φεβ':2,'Μαρ':3,'Απρ':4,'Μαϊ':5,'Μάι':5,'Ιουν':6,'Ιούν':6,
    'Ιουλ':7,'Ιούλ':7,'Αυγ':8,'Αύγ':8,'Σεπ':9,'Οκτ':10,'Νοε':11,'Νοέ':11,'Δεκ':12,
    'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,
    'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12
  };
  // DD/MM/YYYY or DD-MM-YYYY
  let m = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // DD MonthName YYYY
  m = text.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (m && months[m[2]]) return `${m[3]}-${String(months[m[2]]).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // ISO: YYYY-MM-DD
  m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return '';
}

function stableRef(provider, amount, dueDate, index) {
  const input = provider + '|' + (typeof amount === 'number' ? amount.toFixed(2) : String(amount)) + '|' + (dueDate || 'unknown') + '|' + index;
  let h = 0;
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return provider + '-' + Math.abs(h).toString(36).padStart(6, '0');
}

async function detectError(page) {
  const errorSelectors = ['.error', '.alert-danger', '.alert-error', '.login-error',
    '.error-message', '.field-error', '[role="alert"]', '.notification--error', '.MuiAlert-standardError'];
  for (const sel of errorSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = await page.evaluate(e => e.textContent, el);
        if (text && text.trim().length > 0) return text.trim();
      }
    } catch (e) { /* skip */ }
  }
  return null;
}

async function snap(page, debug, label) {
  try {
    const screenshot = await page.screenshot({ encoding: 'base64' });
    debug.push({ label, timestamp: new Date().toISOString(), screenshot });
    return screenshot;
  } catch (e) { return null; }
}

// === END HELPERS ===
```

**CRITICAL**: The helper functions above (`parseAmount`, `parseDate`, `stableRef`) work in the Browserless Node.js scope BUT NOT inside `page.evaluate()` callbacks. Inside `page.evaluate()`, define a compact inline version:

```javascript
// Use this inside EVERY page.evaluate() that needs reference generation:
const _ref = (p, amt, d, i) => {
  const s = p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i;
  let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0;
  return p+'-'+Math.abs(h).toString(36).padStart(6,'0');
};
```

---

### SCRAPER 1: AADE (Tax Authority — TaxisNet/GSIS Login)

```javascript
// Browserless function for AADE
module.exports = async ({ page, context }) => {
  const debug = [];

  // --- LOGIN via TaxisNet/GSIS ---
  const loginUrls = [
    'https://www1.gsis.gr/gsisapps/soasgsisws/login.jsp',
    'https://oauth2.gsis.gr/',
    'https://login.gsis.gr/'
  ];

  let loginLoaded = false;
  for (const url of loginUrls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 40000 });
      loginLoaded = true;
      break;
    } catch (e) { continue; }
  }
  if (!loginLoaded) return { success: false, bills: [], error: 'Cannot reach GSIS login', error_code: 'SCRAPER_BROKEN', debug };

  // Find and fill login form
  const userSelectors = ['input[name="userId"]', 'input[type="text"]', 'input[name="username"]', '#userId'];
  const userField = await waitAny(page, userSelectors);
  if (!userField) return { success: false, bills: [], error: 'Login form not found', error_code: 'SCRAPER_BROKEN', debug };

  await safeType(page, userField.selector, context.username, 50);
  await safeType(page, 'input[type="password"]', context.password, 50);

  // Submit
  const submitBtn = await waitAny(page, ['input[type="submit"]', 'button[type="submit"]']);
  if (submitBtn) await page.click(submitBtn.selector);
  else await page.keyboard.press('Enter');

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await snap(page, debug, 'post-login');

  // Check for 2FA
  const pageText = await page.evaluate(() => document.body.innerText);
  if (/OTP|μίας χρήσης|κωδικό επιβεβαίωσης/i.test(pageText) || /otp|2fa|mfa/i.test(page.url())) {
    return { success: false, bills: [], error: '2FA required', error_code: '2FA_REQUIRED', debug };
  }

  // Check login errors
  const loginErr = await detectError(page);
  if (loginErr) return { success: false, bills: [], error: loginErr, error_code: 'LOGIN_FAILED', debug };

  const currentUrl = page.url();
  if (/login\.jsp|login\.htm|oauth2\.gsis|login\.gsis/i.test(currentUrl)) {
    return { success: false, bills: [], error: 'Still on login page', error_code: 'LOGIN_FAILED', debug };
  }

  // --- NAVIGATE TO DEBT INFO ---
  const debtUrls = [
    'https://www1.gsis.gr/taxisnet/info/protected/displayDebtInfo.htm',
    'https://www1.aade.gr/aadeapps3/myaade/'
  ];
  for (const url of debtUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); break; }
    catch (e) { continue; }
  }
  await snap(page, debug, 'debt-page');

  // --- EXTRACT BILLS ---
  const bills = await page.evaluate(() => {
    const _ref = (p, amt, d, i) => { const s=p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
    const results = [];

    // Strategy A: Table rows
    const rows = document.querySelectorAll('#installLine, tr[id*="install"], tr[id*="debt"], table tr');
    rows.forEach((row, idx) => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      const text = cells.join(' ');
      const amountMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
      const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
      const refMatch = text.match(/(?:Ταυτότητα|ID|Αρ\.?)\s*[:.]?\s*([A-Z0-9-]{4,})/i) || text.match(/([0-9]{10,})/);
      if (amountMatch) {
        const raw = amountMatch[1];
        const amount = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
        const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
        if (amount > 0 && amount < 1000000) {
          results.push({
            title: 'Φορολογική Οφειλή ΑΑΔΕ',
            amount,
            due_date: dueDate,
            reference_number: refMatch ? refMatch[1] : _ref('AADE', amount, dueDate, idx),
            bill_type: /φπα|vat/i.test(text) ? 'vat' : /εισόδημα|income/i.test(text) ? 'income_tax' : /ενφια|enfia/i.test(text) ? 'property_tax' : 'tax'
          });
        }
      }
    });

    // Strategy B: #amnt1 / #amnt3 elements (TaxisNet specific)
    if (results.length === 0) {
      ['#amnt1', '#amnt3'].forEach((sel, idx) => {
        const el = document.querySelector(sel);
        if (el) {
          const raw = el.value || el.textContent || el.innerText || '';
          const amount = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
          if (amount > 0) {
            results.push({
              title: 'Φορολογική Οφειλή ΑΑΔΕ',
              amount,
              due_date: '',
              reference_number: _ref('AADE', amount, '', idx),
              bill_type: 'tax'
            });
          }
        }
      });
    }

    // Strategy C: Full text scan
    if (results.length === 0) {
      const lines = document.body.innerText.split('\n');
      lines.forEach((line, idx) => {
        const amtMatch = line.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          if (amount > 0 && amount < 1000000) {
            let dueDate = '';
            for (let j = Math.max(0, idx-3); j <= Math.min(lines.length-1, idx+4); j++) {
              const dm = lines[j].match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
              if (dm) { dueDate = `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`; break; }
            }
            results.push({ title: 'Φορολογική Οφειλή ΑΑΔΕ', amount, due_date: dueDate, reference_number: _ref('AADE', amount, dueDate, idx), bill_type: 'tax' });
          }
        }
      });
    }

    return results;
  });

  await snap(page, debug, 'extraction-done');
  return { success: true, bills, debug };
};
```

---

### SCRAPER 2: EFKA (Social Security — TaxisNet/GSIS via EFKA Portal)

```javascript
module.exports = async ({ page, context }) => {
  const debug = [];

  // --- LOGIN via EFKA → GSIS redirect ---
  const efkaLoginUrls = [
    'https://apps.e-efka.gov.gr/eAccess/gsis/login.xhtml',  // auto-redirect to GSIS
    'https://apps.e-efka.gov.gr/eAccess/login.xhtml'        // manual SSO button
  ];

  let onGsis = false;
  for (const url of efkaLoginUrls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      if (/gsis\.gr|oauth2\.gsis/i.test(page.url())) { onGsis = true; break; }
      // Try clicking TaxisNet SSO button
      const ssoBtn = await waitAny(page, ['a[href*="gsis"]', 'a[href*="taxisnet"]', 'input[value*="TaxisNet"]']);
      if (ssoBtn) { await page.click(ssoBtn.selector); await page.waitForNavigation({ timeout: 15000 }).catch(()=>{}); onGsis = true; break; }
      // Text-based button search
      const btn = await page.evaluateHandle(() => {
        const els = [...document.querySelectorAll('a, button, input[type="submit"]')];
        return els.find(e => /TaxisNet|Taxisnet|GSIS/i.test(e.textContent || e.value || ''));
      });
      if (btn && btn.asElement()) { await btn.asElement().click(); await page.waitForNavigation({ timeout: 15000 }).catch(()=>{}); onGsis = true; break; }
    } catch (e) { continue; }
  }

  if (!onGsis) {
    // Last resort: go directly to GSIS
    await page.goto('https://www1.gsis.gr/gsisapps/soasgsisws/login.jsp', { waitUntil: 'networkidle2', timeout: 30000 });
  }

  // Fill TaxisNet form (same as AADE)
  const userField = await waitAny(page, ['input[name="userId"]', 'input[type="text"]', 'input[name="username"]']);
  if (!userField) return { success: false, bills: [], error: 'GSIS login form not found', error_code: 'SCRAPER_BROKEN', debug };

  await safeType(page, userField.selector, context.username, 50);
  await safeType(page, 'input[type="password"]', context.password, 50);

  const submitBtn = await waitAny(page, ['input[type="submit"]', 'button[type="submit"]']);
  if (submitBtn) await page.click(submitBtn.selector);
  else await page.keyboard.press('Enter');

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // 2FA check
  const pageText = await page.evaluate(() => document.body.innerText);
  if (/OTP|μίας χρήσης|κωδικό επιβεβαίωσης/i.test(pageText)) {
    return { success: false, bills: [], error: '2FA required', error_code: '2FA_REQUIRED', debug };
  }

  // Wait for redirect back to EFKA
  await new Promise(r => setTimeout(r, 3000));
  if (!/efka\.gov\.gr|e-efka/i.test(page.url())) {
    await page.goto('https://apps.e-efka.gov.gr/eAccess/', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
  }

  // --- NAVIGATE TO CONTRIBUTIONS ---
  const contribUrls = [
    'https://apps.e-efka.gov.gr/eAccess/personalAccount.xhtml',
    'https://apps.e-efka.gov.gr/eAccess/contributions.xhtml',
    'https://apps.e-efka.gov.gr/eAccess/'
  ];
  for (const url of contribUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }); break; }
    catch (e) { continue; }
  }
  await snap(page, debug, 'contributions-page');

  // --- EXTRACT BILLS ---
  const bills = await page.evaluate(() => {
    const _ref = (p, amt, d, i) => { const s=p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
    const results = [];

    // Strategy A: Table rows
    document.querySelectorAll('table').forEach(table => {
      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      rows.forEach((row, idx) => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
        const text = cells.join(' ');
        const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        const refMatch = cells[0] ? cells[0].match(/[A-Z0-9-]{4,}/) : null;
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
          if (amount > 0) {
            results.push({
              title: 'Εισφορά e-ΕΦΚΑ', amount, due_date: dueDate,
              reference_number: refMatch ? refMatch[0] : _ref('EFKA', amount, dueDate, idx),
              bill_type: /υγεία|health/i.test(text) ? 'health_insurance' : /σύνταξη|pension/i.test(text) ? 'pension' : 'social_security'
            });
          }
        }
      });
    });

    // Strategy B: Card/panel elements
    if (results.length === 0) {
      document.querySelectorAll('[class*="panel"], [class*="card"], [class*="contribution"], .ui-datatable tbody tr').forEach((el, idx) => {
        const text = el.textContent || '';
        const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
          if (amount > 0) results.push({ title: 'Εισφορά e-ΕΦΚΑ', amount, due_date: dueDate, reference_number: _ref('EFKA', amount, dueDate, idx), bill_type: 'social_security' });
        }
      });
    }

    return results;
  });

  return { success: true, bills, debug };
};
```

---

### SCRAPER 3: DEH (Electricity — Next.js SPA)

```javascript
module.exports = async ({ page, context }) => {
  const debug = [];

  await page.goto('https://mydei.dei.gr/el/login/', { waitUntil: 'networkidle2', timeout: 40000 });
  await page.waitForSelector('#__next', { timeout: 10000 }); // Next.js root
  await new Promise(r => setTimeout(r, 2000)); // React hydration

  // Find email field
  const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]', 'input[placeholder*="email" i]', '#email', 'input[name="username"]'];
  const emailField = await waitAny(page, emailSelectors);
  if (!emailField) return { success: false, bills: [], error: 'Email field not found', error_code: 'SCRAPER_BROKEN', debug };

  await safeType(page, emailField.selector, context.username, 30);
  await safeType(page, 'input[type="password"]', context.password, 30);

  const submitBtn = await waitAny(page, ['button[type="submit"]', 'input[type="submit"]', 'form button']);
  if (submitBtn) await page.click(submitBtn.selector);

  await waitNavOrSelector(page, ['.dashboard', '.account', '.error', '[role="alert"]']);
  await new Promise(r => setTimeout(r, 3000)); // SPA transition

  const loginErr = await detectError(page);
  if (loginErr) return { success: false, bills: [], error: loginErr, error_code: 'LOGIN_FAILED', debug };
  if (/\/login/i.test(page.url())) return { success: false, bills: [], error: 'Still on login page', error_code: 'LOGIN_FAILED', debug };

  await snap(page, debug, 'post-login');

  // Navigate to bills
  const billUrls = ['https://mydei.dei.gr/el/accounts/', 'https://mydei.dei.gr/el/account/'];
  for (const url of billUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }); break; }
    catch (e) { continue; }
  }
  await new Promise(r => setTimeout(r, 2000));

  const bills = await page.evaluate(() => {
    const _ref = (p, amt, d, i) => { const s=p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
    const results = [];

    // Strategy A: DOM elements
    document.querySelectorAll('[class*="bill"], [class*="invoice"], [class*="card"], table tbody tr, li').forEach((el, idx) => {
      const text = el.textContent || '';
      const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€|€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
      if (amtMatch) {
        const raw = amtMatch[1] || amtMatch[2];
        const amount = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
        const refMatch = text.match(/(?:αρ\.|no\.|#|ref|κωδ)\s*[:.]?\s*([A-Z0-9-]{4,})/i) || text.match(/([A-Z0-9]{8,})/);
        if (amount > 0 && amount < 100000) {
          results.push({ title: 'Λογαριασμός Ρεύματος ΔΕΗ', amount, due_date: dueDate,
            reference_number: refMatch ? refMatch[1] : _ref('DEH', amount, dueDate, idx), bill_type: 'electricity' });
        }
      }
    });

    // Strategy B: Next.js __NEXT_DATA__
    if (results.length === 0) {
      try {
        const nextData = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
        function walk(obj, depth = 0) {
          if (depth > 10 || !obj || typeof obj !== 'object') return;
          if (obj.amount !== undefined && (obj.dueDate || obj.due_date || obj.deadline)) {
            results.push({
              title: 'Λογαριασμός Ρεύματος ΔΕΗ',
              amount: parseFloat(obj.amount) || 0,
              due_date: obj.dueDate || obj.due_date || obj.deadline || '',
              reference_number: obj.referenceNumber || obj.reference || obj.id || _ref('DEH', parseFloat(obj.amount)||0, obj.dueDate||'', results.length),
              bill_type: 'electricity'
            });
          }
          Object.values(obj).forEach(v => { if (typeof v === 'object') walk(v, depth+1); });
        }
        walk(nextData);
      } catch (e) {}
    }

    return results;
  });

  return { success: true, bills, debug };
};
```

---

### SCRAPER 4: EYDAP (Water Utility — ASP.NET MVC)

```javascript
module.exports = async ({ page, context }) => {
  const debug = [];

  // Login
  const loginUrls = ['https://www.eydap.gr/userLogin/', 'https://www.eydap.gr/MyAccount/LogIn'];
  let loginLoaded = false;
  for (const url of loginUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); loginLoaded = true; break; }
    catch (e) { continue; }
  }
  if (!loginLoaded) return { success: false, bills: [], error: 'Cannot reach EYDAP login', error_code: 'SCRAPER_BROKEN', debug };
  await new Promise(r => setTimeout(r, 1500));

  const userSelectors = ['input[name="customerCode"]', 'input[name="CustomerCode"]', '#customerCode',
    'input[name="username"]', 'input[name="waterMeterNo"]', 'input[type="text"]:not([name="password"])',
    'input[placeholder*="κωδικ" i]', 'input[placeholder*="αριθμ" i]', 'input[placeholder*="code" i]'];
  const userField = await waitAny(page, userSelectors);
  if (!userField) return { success: false, bills: [], error: 'Login form not found', error_code: 'SCRAPER_BROKEN', debug };

  await safeType(page, userField.selector, context.username, 40);
  await safeType(page, 'input[type="password"]', context.password, 40);

  // Submit button
  let submitBtn = await waitAny(page, ['button[type="submit"]', 'input[type="submit"]', '.login-btn', 'button.btn-primary']);
  if (!submitBtn) {
    // Find by visible text
    const btnHandle = await page.evaluateHandle(() => {
      const els = [...document.querySelectorAll('button, input[type="submit"], a')];
      return els.find(e => /Είσοδος|Login|Σύνδεση/i.test(e.textContent || e.value || ''));
    });
    if (btnHandle && btnHandle.asElement()) await btnHandle.asElement().click();
    else await page.keyboard.press('Enter');
  } else {
    await page.click(submitBtn.selector);
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  const loginErr = await detectError(page);
  if (loginErr) return { success: false, bills: [], error: loginErr, error_code: 'LOGIN_FAILED', debug };
  if (/\/LogIn|\/login/i.test(page.url())) return { success: false, bills: [], error: 'Still on login page', error_code: 'LOGIN_FAILED', debug };

  // Navigate to bills
  const billUrls = ['https://www.eydap.gr/MyAccount/MyCurrentAccountAM/', 'https://www.eydap.gr/en/myaccount/currentbilldetails'];
  for (const url of billUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }); break; }
    catch (e) { continue; }
  }
  await snap(page, debug, 'bills-page');

  const bills = await page.evaluate(() => {
    const _ref = (p, amt, d, i) => { const s=p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
    const results = [];

    // Strategy A: Table rows
    document.querySelectorAll('table').forEach(table => {
      const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
      rows.forEach((row, idx) => {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
        const text = cells.join(' ');
        const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        const refMatch = cells[0] ? cells[0].match(/[A-Z0-9-]{4,}/) : null;
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
          if (amount > 0) results.push({ title: 'Λογαριασμός Ύδρευσης ΕΥΔΑΠ', amount, due_date: dueDate,
            reference_number: refMatch ? refMatch[0] : _ref('EYDAP', amount, dueDate, idx), bill_type: 'water' });
        }
      });
    });

    // Strategy B: Card layout
    if (results.length === 0) {
      document.querySelectorAll('[class*="bill"], [class*="invoice"], [class*="payment"], .card, .panel').forEach((el, idx) => {
        const text = el.textContent || '';
        const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
          if (amount > 0) results.push({ title: 'Λογαριασμός Ύδρευσης ΕΥΔΑΠ', amount, due_date: dueDate, reference_number: _ref('EYDAP', amount, dueDate, idx), bill_type: 'water' });
        }
      });
    }

    return results;
  });

  return { success: true, bills, debug };
};
```

---

### SCRAPER 5: COSMOTE (Telecom — Two-Step Login SPA)

```javascript
module.exports = async ({ page, context }) => {
  const debug = [];

  await page.goto('https://account.cosmote.gr/user-login', { waitUntil: 'networkidle2', timeout: 40000 });
  await new Promise(r => setTimeout(r, 2000));

  // Step 1: Enter username (email or phone)
  const userSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]',
    'input[placeholder*="email" i]', 'input[placeholder*="τηλέφωνο" i]', 'input[placeholder*="κινητό" i]'];
  const userField = await waitAny(page, userSelectors);
  if (!userField) return { success: false, bills: [], error: 'Username field not found', error_code: 'SCRAPER_BROKEN', debug };

  await safeType(page, userField.selector, context.username, 30);

  // Click Next/Continue
  const nextBtn = await waitAny(page, ['button[type="submit"]', 'button.next', 'button.continue']);
  if (nextBtn) await page.click(nextBtn.selector);
  await new Promise(r => setTimeout(r, 3000)); // Wait for step 2

  // Step 2: Enter password
  const pwField = await waitAny(page, ['input[type="password"]', 'input[name="password"]', '#password'], 10000);
  if (pwField) {
    await safeType(page, pwField.selector, context.password, 30);
    const submitBtn = await waitAny(page, ['button[type="submit"]', 'button.next', 'button.continue']);
    if (submitBtn) await page.click(submitBtn.selector);
    await waitNavOrSelector(page, ['.dashboard', '.account', '.error', '[role="alert"]']);
    await new Promise(r => setTimeout(r, 3000));
  }
  // If no password field found and we're not on login page anymore, single-step login succeeded

  const loginErr = await detectError(page);
  if (loginErr) return { success: false, bills: [], error: loginErr, error_code: 'LOGIN_FAILED', debug };
  if (/\/user-login|\/login/i.test(page.url())) return { success: false, bills: [], error: 'Still on login page', error_code: 'LOGIN_FAILED', debug };

  await snap(page, debug, 'post-login');

  // Navigate to billing
  const billUrls = ['https://my.cosmote.gr/selfcare/jsp/billing.jsp', 'https://my.cosmote.gr/selfcare/jsp/bill-analysis.jsp', 'https://my.cosmote.gr/'];
  for (const url of billUrls) {
    try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }); break; }
    catch (e) { continue; }
  }
  await new Promise(r => setTimeout(r, 2000));
  await snap(page, debug, 'billing-page');

  const bills = await page.evaluate(() => {
    const _ref = (p, amt, d, i) => { const s=p+'|'+(amt||0).toFixed(2)+'|'+(d||'')+'|'+i; let h=0; for(let c=0;c<s.length;c++) h=((h<<5)-h+s.charCodeAt(c))|0; return p+'-'+Math.abs(h).toString(36).padStart(6,'0'); };
    const results = [];

    // Strategy A: Structured elements
    document.querySelectorAll('[class*="bill"], [class*="invoice"], [class*="payment"], [class*="charge"], table tbody tr, .card').forEach((el, idx) => {
      const text = el.textContent || '';
      const amtMatch = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
      if (amtMatch) {
        const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
        const dateMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
        const dueDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : '';
        const refMatch = text.match(/([A-Z0-9]{8,})/);
        const billType = /internet|fiber|ftth/i.test(text) ? 'internet' : 'mobile';
        if (amount > 0 && amount < 10000) {
          results.push({
            title: billType === 'internet' ? 'Λογαριασμός Internet COSMOTE' : 'Λογαριασμός Κινητής COSMOTE',
            amount, due_date: dueDate,
            reference_number: refMatch ? refMatch[1] : _ref('COSMOTE', amount, dueDate, idx),
            bill_type: billType
          });
        }
      }
    });

    // Strategy B: Text line scan
    if (results.length === 0) {
      const lines = document.body.innerText.split('\n');
      lines.forEach((line, idx) => {
        const amtMatch = line.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        if (amtMatch) {
          const amount = parseFloat(amtMatch[1].replace(/\./g, '').replace(',', '.'));
          if (amount > 0 && amount < 10000) {
            let dueDate = '';
            for (let j = Math.max(0, idx-3); j <= Math.min(lines.length-1, idx+4); j++) {
              const dm = lines[j].match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
              if (dm) { dueDate = `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`; break; }
            }
            results.push({ title: 'Λογαριασμός COSMOTE', amount, due_date: dueDate, reference_number: _ref('COSMOTE', amount, dueDate, idx), bill_type: 'mobile' });
          }
        }
      });
    }

    return results;
  });

  return { success: true, bills, debug };
};
```

---

## WORKFLOW 2: `trigger-daily-sync`

### Schedule: Cron `0 6 * * *` (6:00 AM UTC = 8–9 AM Athens)

### Flow:

1. **Schedule Trigger** (Cron): fires daily at 6 AM UTC
2. **Supabase Get All Rows**: from `provider_accounts` WHERE `status = 'connected'` AND `next_sync_at <= NOW()`
3. **Loop Over Items** (SplitInBatches, batch size 1):
   - For each account:
     - **HTTP Request**: POST to `sync-single-provider` webhook URL with `{ "provider_account_id": item.id }`
     - **Wait** node: 1 second (Browserless rate limiting)
4. **Code node**: Aggregate results (count success/fail)
5. Optional: **IF** any failures → send alert email via Resend

### Important:
- Use SplitInBatches with batch size 1 to process sequentially
- The Wait node between batches prevents Browserless rate limiting
- Each sync-single-provider call runs independently — if one fails, others continue
- n8n has no function timeout like Supabase Edge Functions (150s), so sequential processing works fine here

---

## WORKFLOW 3: `send-notifications`

### Schedule: TWO Cron triggers
- `30 8 * * *` (8:30 AM UTC) → type = "d0" (due today)
- `30 9 * * *` (9:30 AM UTC) → type = "d3" (due in 3 days)

### Flow:

1. **Schedule Trigger** (Cron)
2. **Code node**: Calculate `targetDate`:
   - If d3: `new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]`
   - If d0: `new Date().toISOString().split('T')[0]`
3. **Supabase Get All Rows**: from `bills` WHERE:
   - `status = 'pending'`
   - `due_date = targetDate`
   - `notified_d3 = false` (for d3) or `notified_d0 = false` (for d0)
4. For each bill, need profile + provider data:
   - **Supabase Get Row**: from `profiles` WHERE `id = bill.user_id` (get email, full_name, notification_preferences)
   - **Supabase Get Row**: from `providers` WHERE `id = bill.provider_id` (get name_el, icon)
5. **IF** node: Check `profile.notification_preferences.email === true`
6. **Code node**: Build HTML email template (Greek language — see template below)
7. **HTTP Request**: POST to `https://api.resend.com/emails`:
   ```json
   {
     "from": "FAB <notifications@fab.gr>",
     "to": ["user@email.com"],
     "subject": "⏰ Υπενθύμιση: Λογαριασμός ΔΕΗ λήγει σε 3 ημέρες",
     "html": "<full HTML template>"
   }
   ```
   Headers: `Authorization: Bearer {{ $env.RESEND_API_KEY }}`
8. On success:
   - **Supabase Update**: Set `bills.notified_d3 = true` (or `notified_d0 = true`)
   - **Supabase Create Row**: Insert into `notifications` table

### Email subject lines:
- d3: `⏰ Υπενθύμιση: Λογαριασμός ${provider.name_el} λήγει σε 3 ημέρες`
- d0: `🔔 Σήμερα λήγει ο λογαριασμός ${provider.name_el}`

### HTML Email Template (Greek):
Use the same template structure from the existing `send-notifications` Edge Function. The template includes:
- Gradient header (indigo → green) with FAB branding
- Greeting with user's name
- Bill card showing: provider icon + name, title, amount (€XX.XX), due date in Greek format, reference number
- CTA button linking to `https://fab.gr/dashboard`
- Footer with notification settings link

---

## WORKFLOW 4: `add-provider-account`

### Trigger: **Webhook** (POST) — called by frontend

### Expected request body:
```json
{
  "provider_id": "DEH",
  "username": "user@email.com",
  "password": "mysecretpass",
  "user_id": "uuid-from-jwt"
}
```

Note: In production, extract `user_id` from the Supabase JWT in the Authorization header instead of trusting the request body.

### Flow:

1. **Webhook** receives request
2. **IF** node: Validate required fields exist
3. **Supabase Get Row**: Check if `provider_accounts` row exists for this `user_id + provider_id` (use filter, expect 0 or 1)
4. **Code node**: Encrypt password with AES-256-GCM (code shown above)
5. **Code node**: Mask username for display:
   - AFM (9 digits): `123****89`
   - Email: `us****@email.com`
   - Phone: `694****12`
6. **IF** account exists → **Supabase Update** (reconnect with new credentials)
   **IF** new → **Supabase Create Row** in `provider_accounts`
7. **HTTP Request**: POST to `sync-single-provider` webhook to test credentials immediately
8. **Respond to Webhook**: Return `{ success: true, masked_username: "123****89" }`

### Username masking logic (Code node):

```javascript
const username = $input.first().json.username;
let masked;

if (/^\d{9}$/.test(username)) {
  // AFM (Greek tax number)
  masked = username.slice(0, 3) + '****' + username.slice(-2);
} else if (username.includes('@')) {
  // Email
  const [local, domain] = username.split('@');
  masked = local.slice(0, 2) + '****@' + domain;
} else if (/^\d{10,}$/.test(username)) {
  // Phone
  masked = username.slice(0, 3) + '****' + username.slice(-2);
} else {
  masked = username.slice(0, 2) + '****' + username.slice(-2);
}

return [{ json: { ...$input.first().json, username_masked: masked } }];
```

---

## CRITICAL IMPLEMENTATION NOTES

1. **Browserless token goes in the URL query param**, not in headers: `?token=YOUR_TOKEN`

2. **Stealth mode** is activated via URL query param: `&launch={"stealth":true}`

3. **Scraper code is sent as a string** in the `code` field of the Browserless request body. It must be `module.exports = async ({ page, context }) => { ... }` format.

4. **Credentials are passed via `context` object** (never string-interpolated into the code). This prevents JS injection.

5. **`page.evaluate()` runs in browser context** — it cannot access Node.js variables or helper functions. The `_ref()` function must be defined inside each `page.evaluate()` callback.

6. **Greek number format**: `1.234,56` → dots are thousands, comma is decimal. Use: `parseFloat(text.replace(/\./g, '').replace(',', '.'))`

7. **Greek date format**: `DD/MM/YYYY` → month and day are swapped vs US format. Parse carefully.

8. **Bill deduplication**: The `UNIQUE(user_id, provider_id, reference_number)` constraint prevents duplicates. The `stableRef()` hash ensures the same bill always gets the same reference, even without an explicit reference number from the portal.

9. **n8n advantage over Supabase Edge Functions**: No 150-second timeout. The `trigger-daily-sync` workflow can process all accounts sequentially without time pressure.

10. **Error handling**: Every scraper can return these error codes:
    - `LOGIN_FAILED` → bad credentials
    - `2FA_REQUIRED` → portal wants OTP
    - `SCRAPER_BROKEN` → portal changed, selectors don't match
    - `SCRAPER_ERROR` → unexpected runtime error

11. **AADE and EFKA both use TaxisNet/GSIS** for authentication. Same login form, different portals afterward.

12. **Supabase node credentials**: Use the **Service Role Key** (not anon key) so that RLS is bypassed for backend operations. The Service Role Key should be stored as an n8n credential, never in workflow JSON.

---

## DELIVERABLES

Generate complete n8n workflow JSON files for each of the 4 workflows listed above. Each JSON file should:
- Have a descriptive workflow name
- Use proper n8n JSON structure with `nodes`, `connections`, `settings`
- Include Sticky Note nodes documenting each section
- Use n8n expressions (`{{ }}`) for dynamic values
- Reference credentials by name (not hardcoded)
- Include error handling paths (Error Trigger → update sync_job status)
- Be ready to import into n8n via "Import from File"

## PROMPT END
