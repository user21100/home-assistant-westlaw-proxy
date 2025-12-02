const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = 3000;

// Middleware to allow CORS (since bench.html runs on file:// or different port)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Health check endpoint - returns immediately without doing any work
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'westlaw-proxy' });
});

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Missing query parameter "q"' });
    }

    console.log(`[Proxy] Searching for: "${query}"`);
    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true, // Set to false for debugging
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // 1. Navigate to Search Template
        console.log('[Proxy] Navigating to Westlaw...');
        await page.goto('https://govt.westlaw.com/nyofficial/Search/Template/CaseCourts', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // 2. Input Query
        console.log('[Proxy] Inputting query...');
        // Wait for the input field
        await page.waitForSelector('#caseName', { timeout: 5000 });
        await page.type('#caseName', query);

        // 3. Submit Search
        console.log('[Proxy] Submitting search...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('input.co_formBtnGreen')
        ]);

        // Wait a bit for results to render (if AJAX/Hybrid)
        await new Promise(r => setTimeout(r, 3000));

        // 4. Extract Results
        console.log('[Proxy] Extracting results...');
        // Wait for results container (generic selector, adjust if needed)
        // Westlaw results usually have a specific structure. 
        // We'll try to grab the first few results.

        // Check if we are on a results page or if it went straight to a document (unlikely for broad search)
        const results = await page.evaluate(() => {
            const items = [];
            // Select result rows - this selector might need tuning based on actual DOM
            // Common Westlaw selector patterns: .co_searchResult, #cobalt_search_results
            // Let's try a broad strategy: look for links with class 'co_searchResultHeader' or similar

            // Attempt 2: Correct Selectors based on debug
            const resultElements = document.querySelectorAll('ol#results li');

            if (resultElements.length > 0) {
                resultElements.forEach((el, index) => {
                    if (index >= 5) return; // Limit to 5
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
                // Fallback: Check if there's a "No results" message
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

    console.log(`[Proxy] Searching Citation: ${vol} ${reporter} ${pageNum}`);
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

        // Wait for form
        await page.waitForSelector('#T1', { timeout: 10000 });

        // Fill Form
        await page.type('#T1', vol);

        // Select Reporter (Exact match required)
        // The values usually have periods, e.g., "N.Y.2d."
        // We'll try to select by value.
        await page.select('#S1', reporter);

        await page.type('#T2', pageNum);

        // Submit
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('input.co_formBtnGreen')
        ]);

        // Wait for results/redirect
        await new Promise(r => setTimeout(r, 3000));

        // Check for results or direct document load
        // If it goes to a document, the URL will contain '/Document/'
        const url = page.url();
        if (url.includes('/Document/')) {
            console.log('[Proxy] Direct hit on document!');
            const title = await page.title();
            res.json({ results: [{ title, url, citation: `${vol} ${reporter} ${pageNum}`, summary: 'Direct Citation Match' }] });
        } else {
            // List of results
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

    console.log(`[Proxy] Reading: ${url}`);
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

        // Wait for content
        // Westlaw documents usually reside in #co_docContent or .co_documentFrame
        await page.waitForSelector('#co_docContentBody', { timeout: 15000 }).catch(() => console.log('Content selector timeout'));

        const content = await page.evaluate(() => {
            // Try to get the main document text
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
});
