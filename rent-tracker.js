import { chromium } from 'playwright';
import fs from 'fs';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();             

// Centralized Rental Localities
const RENTAL_LOCALITIES = {
    "HSR_Layout": "W3sibGF0IjoxMi45MTIxMTgxLCJsb24iOjc3LjY0NDU1NDgsInBsYWNlSWQiOiJDaElKelc3Y3Y1RVVyanNSZWNqN09ZUnhNdkkiLCJwbGFjZU5hbWUiOiJIU1IgTGF5b3V0In1d",
    "Indiranagar": "W3sibGF0IjoxMi45Nzg0MDY2LCJsb24iOjc3LjY0MDgzMzksInBsYWNlSWQiOiJDaElKeFpPajJMMmtzanNScWhaVnN2SmtSZFkiLCJwbGFjZU5hbWUiOiJJbmRpcmFuYWdhciJ9XQ==",
    "Koramangala": "W3sibGF0IjoxMi45MzUxMzk2LCJsb24iOjc3LjYyNDQxNDMsInBsYWNlSWQiOiJDaElKSzBfTlpvU1lyanNSM3ZJM29Kazdtc1UiLCJwbGFjZU5hbWUiOiJLb3JhbWFuZ2FsYSJ9XQ=="
};

const CACHE_FILE = 'seen_rentals.json';
const targetLocality = process.env.TARGET_LOCALITY || "HSR_Layout";
const maxPrice = process.env.MAX_PRICE || "40000";

async function loadSeenRentals() {
    if (!fs.existsSync(CACHE_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return []; }
}

async function saveSeenRentals(list) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(list, null, 2));
}

async function sendEmailAlert(newListings) {
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    let emailContent = `Professional Update: New rental options have been listed in ${targetLocality}.\n\n`;
    newListings.forEach(p => {
        emailContent += `Property: ${p.title}\nRent: ₹${p.price.toLocaleString('en-IN')}/month\nLocation: ${p.locality}\nLink: ${p.link}\n\n---\n`;
    });

    await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: `[New Rental Alert] ${newListings.length} New Properties Found in ${targetLocality}`,
        text: emailContent
    });
}

async function scrapeRentals() {
    const token = RENTAL_LOCALITIES[targetLocality];
    if (!token) throw new Error(`Locality token key '${targetLocality}' is not configured.`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const url = `https://www.nobroker.in/property/rent/bangalore/multiple?searchParam=${token}&price=0,${maxPrice}&orderBy=lastUpdateDate,desc`;
    console.log(`Scanning rental properties in ${targetLocality} up to ₹${maxPrice}...`);

    // Switches execution to wait only for structural elements, then forces an explicit render pause
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000); // Gives the React client-side setup 5 seconds to inject the property cards

    const listings = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('article')).map(card => {
            const rawUrl = card.querySelector('a')?.href || '';
            const cleanUrl = rawUrl.split('?')[0]; // Strips any ?searchParam junk off the end

            return {
                id: cleanUrl, // <-- OUR NEW TRUE UNIQUE ID
                title: card.querySelector('h2')?.innerText?.trim() || '',
                link: cleanUrl,
                locality: card.querySelector('.heading-6')?.innerText?.trim() || '',
                price: parseInt((card.querySelector('[itemprop="price"]')?.innerText || '0').replace(/[^0-9]/g, ''), 10)
            };
        }).filter(p => p.id && p.title);
    });

    await browser.close();

    const seenIds = await loadSeenRentals();
    const newListings = listings.filter(p => !seenIds.includes(p.id));

    if (newListings.length > 0) {
        console.log(`Found ${newListings.length} NEW rental matches. Dispatching notification email...`);
        await sendEmailAlert(newListings);
        const updatedCache = [...seenIds, ...newListings.map(p => p.id)];
        await saveSeenRentals(updatedCache);
    } else {
        console.log('No new rental listings found in this cycle.');
    }
}

scrapeRentals().catch(console.error);