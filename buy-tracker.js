import { chromium } from 'playwright';
import fs from 'fs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const BUY_LOCALITIES = {
    "Indiranagar": "W3sibGF0IjoxMi45Nzg0MDY2LCJsb24iOjc3LjY0MDgzMzksInBsYWNlSWQiOiJDaElKeFpPajJMMmtzanNScWhaVnN2SmtSZFkiLCJwbGFjZU5hbWUiOiJJbmRpcmFuYWdhciJ9XQ==",
    "JP_Nagar": "W3sibGF0IjoxMi45MTA3NTM4LCJsb24iOjc3LjU4NTU5NTgsInBsYWNlSWQiOiJDaElKYlhWeTAtbEtxenNScjNfOTBkWVd4Y0kiLCJwbGFjZU5hbWUiOiJKUCBOYWdhciJ9XQ==",
    "HSR_Layout": "W3sibGF0IjoxMi45MTIxMTgxLCJsb24iOjc3LjY0NDU1NDgsInBsYWNlSWQiOiJDaElKelc3Y3Y1RVVyanNSZWNqN09ZUnhNdkkiLCJwbGFjZU5hbWUiOiJIU1IgTGF5b3V0In1d",
    "Koramangala": "W3sibGF0IjoxMi45MzUxMzk2LCJsb24iOjc3LjYyNDQxNDMsInBsYWNlSWQiOiJDaElKSzBfTlpvU1lyanNSRzN2STM2b0szbXNVIiwicGxhY2VOYW1lIjoiS29yYW1hbmdhbGEifV0=",
    "Harlur": "W3sibGF0IjoxMi45MTA1MDA1LCJsb24iOjc3LjY2Mzg5ODQsInBsYWNlSWQiOiJDaElKeFBlU0FfMFVyanNSeF9LSU9VOFY0U0kiLCJwbGFjZU5hbWUiOiJIYXJsdXIifV0="
};

const CACHE_FILE = 'seen_purchases.json';

const RUN_MODE = process.env.RUN_MODE || "ALL"; 
const TARGET_LOCALITY = process.env.TARGET_LOCALITY || "HSR_Layout";
const MAX_PRICE = process.env.MAX_PRICE || "17000000"; 
const TARGET_BHK = process.env.TARGET_BHK || "3"; // Explicit BHK parameter

async function loadSeenPurchases() {
    if (!fs.existsSync(CACHE_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return []; }
}

async function saveSeenPurchases(list) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list, null, 2));
}

async function sendConsolidatedEmail(allNewListings, summaryTitle) {
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    let emailContent = `### ${summaryTitle} (3 BHK Only)\n\n`;
    emailContent += `The following new 3 BHK properties match your purchase filters:\n\n---\n\n`;

    allNewListings.forEach(p => {
        const displayPrice = p.price >= 10000000 ? `${(p.price / 10000000).toFixed(2)} Cr` : `${(p.price / 100000).toFixed(2)} Lacs`;
        emailContent += `🏢 **Property:** ${p.title}\n💰 **Price:** ₹${displayPrice}\n📍 **Locality:** ${p.locality}\n🔗 [View 3BHK on NoBroker](${p.link})\n\n---\n\n`;
    });

    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: `🚨 [3 BHK Property Alert] ${allNewListings.length} Matches Found`,
        text: emailContent
    });
}

async function runEngine() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const seenIds = await loadSeenPurchases();
    let aggregatedNewListings = [];
    let jobsQueue = [];

    if (RUN_MODE === "SINGLE") {
        console.log(`Manual mode triggered for: ${TARGET_LOCALITY} (3 BHK)`);
        if (!BUY_LOCALITIES[TARGET_LOCALITY]) throw new Error(`Locality '${TARGET_LOCALITY}' is unrecognized.`);
        jobsQueue.push([TARGET_LOCALITY, BUY_LOCALITIES[TARGET_LOCALITY]]);
    } else {
        console.log("Automated full-scale daily profile check initialized (3 BHK).");
        jobsQueue = Object.entries(BUY_LOCALITIES);
    }

    for (const [locationName, token] of jobsQueue) {
        console.log(`Scanning 3 BHK listings in ${locationName}...`);
        
        // Injected &bhk=3 directly into the query payload
        const url = `https://www.nobroker.in/property/sale/bangalore/multiple?searchParam=${token}&price=0,${MAX_PRICE}&bhk=${TARGET_BHK}&orderBy=lastUpdateDate,desc`;
        
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000); 

            const listings = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('article')).map(card => {
                    const rawUrl = card.querySelector('a')?.href || '';
                    const cleanUrl = rawUrl.split('?')[0];
                    const titleText = card.querySelector('h2')?.innerText?.trim() || '';

                    return {
                        id: cleanUrl,
                        title: titleText,
                        link: cleanUrl,
                        locality: card.querySelector('.heading-6')?.innerText?.trim() || '',
                        price: parseInt((card.querySelector('[itemprop="price"]')?.innerText || '0').replace(/[^0-9]/g, ''), 10)
                    };
                }).filter(p => p.id && p.title && /\b3\s*bhk\b/i.test(p.title)); // Regex check guarantees '3 BHK' appears in title
            });

            const uniqueMatches = listings.filter(p => !seenIds.includes(p.id));
            aggregatedNewListings.push(...uniqueMatches);
            console.log(`-> Identified ${uniqueMatches.length} brand-new 3 BHK entries inside ${locationName}.`);
        } catch (err) {
            console.error(`Skipping ${locationName} due to processing fault:`, err.message);
        }
    }

    await browser.close();

    if (aggregatedNewListings.length > 0) {
        const titleText = RUN_MODE === "SINGLE" 
            ? `NoBroker Manual Property Report [${TARGET_LOCALITY}]` 
            : `NoBroker Daily Real Estate Consolidated Purchase Report`;

        console.log(`Dispatching email updates for ${aggregatedNewListings.length} verified 3 BHK items...`);
        await sendConsolidatedEmail(aggregatedNewListings, titleText);
        
        const updatedCache = [...seenIds, ...aggregatedNewListings.map(p => p.id)];
        await saveSeenPurchases(updatedCache);
    } else {
        console.log('No brand-new 3 BHK matches found during this check window.');
    }
}

runEngine().catch(console.error);