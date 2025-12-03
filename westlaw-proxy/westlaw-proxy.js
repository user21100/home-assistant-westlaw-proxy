const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = 3000;

// Security: API Key Authentication
const API_KEY = process.env.WESTLAW_API_KEY || 'CHANGE_THIS_TO_SECURE_KEY';
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

// Rate limiting storage (in production, use Redis)
const rateLimitStore = new Map();

// Security middleware: API Key authentication
function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
        return res.status(401).json({ 
            error: 'Authentication required',
            message: 'Provide API key via X-API-Key header or api_key query parameter'
        });
    }
    
    if (apiKey !== API_KEY) {
        return res.status(403).json({ 
            error: 'Invalid API key',
            message: 'The provided API key is incorrect'
        });
    }
    
    next();
}

// Rate limiting middleware
function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimitStore.has(ip)) {
        rateLimitStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return next();
    }
    
    const limit = rateLimitStore.get(ip);
    
    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + RATE_LIMIT_WINDOW;
        return next();
    }
    
    if (limit.count >= RATE_LIMIT_MAX) {
        return res.status(429).json({ 
            error: 'Rate limit exceeded',
            message: `Maximum ${RATE_LIMIT_MAX} requests per minute. Try again later.`
        });
    }
    
    limit.count++;
    next();
}

// Security: Restricted CORS (only allow specific origins)
// Allow production domains and localhost for development
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? 
    process.env.ALLOWED_ORIGINS.split(',') : 
    [
        'https://platforms.cc', 
        'https://westlaw.platforms.cc',
        'http://localhost:8000',
        'http://localhost:8080',
        'http://127.0.0.1:8000',
        'http://127.0.0.1:8080',
        'null' // Allow file:// protocol for local development (less secure but needed for testing)
    ];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Handle null origin (file:// protocol) - allow it for development
    if (origin === null || origin === 'null') {
        res.header('Access-Control-Allow-Origin', 'null');
    } else if (ALLOWED_ORIGINS.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    // Include all necessary headers for authentication
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, CF-Access-Client-Id, CF-Access-Client-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Security: Request logging
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} from ${ip}`);
    next();
});

// Health check (no auth required, but rate limited)
app.get('/health', rateLimit, (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        service: 'westlaw-proxy',
        authenticated: false // Health check doesn't require auth
    });
});

// All other endpoints require authentication
app.use(authenticateApiKey);
app.use(rateLimit);

// Original endpoints with security
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Missing query parameter "q"' });
    }

    console.log(`[Proxy] Authenticated search for: "${query}"`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.goto('https://govt.westlaw.com/nyofficial/Search/Template/CaseCourts', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        await page.waitForSelector('#caseName', { timeout: 5000 });
        await page.type('#caseName', query);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('input.co_formBtnGreen')
        ]);

        await new Promise(r => setTimeout(r, 3000));

        const results = await page.evaluate(() => {
            const items = [];
            const resultElements = document.querySelectorAll('ol#results li');

            if (resultElements.length > 0) {
                resultElements.forEach((el, index) => {
                    if (index >= 5) return;
                    const titleEl = el.querySelector('a.resultLink');
                    const descriptionEl = el.querySelector('.co_resultsListDescription');

                    items.push({
                        title: titleEl ? titleEl.innerText.trim() : 'Unknown Title',
                        url: titleEl ? titleEl.href : null,
                        citation: descriptionEl ? descriptionEl.innerText.trim() : '',
                        summary: descriptionEl ? descriptionEl.innerText.trim() : ''
                    });
                });
            } else {
                const noResults = document.querySelector('#co_searchNoResultsMessage');
                if (noResults) return [];
            }

            return items;
        });

        console.log(`[Proxy] Found ${results.length} results.`);
        res.json({ results });

    } catch (error) {
        console.error('[Proxy] Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.get('/search-citation', async (req, res) => {
    const { vol, reporter, page: pageNum } = req.query;
    if (!vol || !reporter || !pageNum) {
        return res.status(400).json({ error: 'Missing parameters: vol, reporter, page' });
    }

    console.log(`[Proxy] Authenticated citation search: ${vol} ${reporter} ${pageNum}`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.goto('https://govt.westlaw.com/nyofficial/Search/Template/Citation', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await page.waitForSelector('#T1', { timeout: 10000 });
        await page.type('#T1', vol);
        await page.select('#S1', reporter);
        await page.type('#T2', pageNum);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('input.co_formBtnGreen')
        ]);

        await new Promise(r => setTimeout(r, 3000));

        const url = page.url();
        if (url.includes('/Document/')) {
            console.log('[Proxy] Direct hit on document!');
            const title = await page.title();
            res.json({ results: [{ title, url, citation: `${vol} ${reporter} ${pageNum}`, summary: 'Direct Citation Match' }] });
        } else {
            const results = await page.evaluate(() => {
                const items = [];
                const resultElements = document.querySelectorAll('ol#results li');
                if (resultElements.length > 0) {
                    resultElements.forEach((el, index) => {
                        if (index >= 5) return;
                        const titleEl = el.querySelector('a.resultLink');
                        const descriptionEl = el.querySelector('.co_resultsListDescription');
                        items.push({
                            title: titleEl ? titleEl.innerText.trim() : 'Unknown Title',
                            url: titleEl ? titleEl.href : null,
                            citation: descriptionEl ? descriptionEl.innerText.trim() : '',
                            summary: descriptionEl ? descriptionEl.innerText.trim() : ''
                        });
                    });
                }
                return items;
            });
            res.json({ results });
        }

    } catch (error) {
        console.error('[Proxy] Citation Search Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.get('/read', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    console.log(`[Proxy] Authenticated read: ${url}`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        });

        await page.waitForSelector('#co_docContentBody', { timeout: 15000 }).catch(() => console.log('Content selector timeout'));

        const content = await page.evaluate(() => {
            const docBody = document.querySelector('#co_docContentBody') || document.querySelector('.co_documentFrame') || document.body;
            return {
                title: document.title,
                text: docBody.innerText,
                html: docBody.innerHTML
            };
        });

        res.json(content);

    } catch (error) {
        console.error('[Proxy] Read Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.listen(port, () => {
    console.log(`Westlaw Proxy listening at http://localhost:${port}`);
    console.log(`[Security] API Key authentication enabled`);
    console.log(`[Security] Rate limiting: ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW/1000}s per IP`);
    console.log(`[Security] CORS restricted to: ${ALLOWED_ORIGINS.join(', ')}`);
});
