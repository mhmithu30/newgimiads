require("dotenv").config();

const axios = require("axios");
const { chromium } = require("playwright");
const ProxyChain = require("proxy-chain");

const URL = process.env.TARGET_URL;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL_MIN = Number(process.env.CHECK_INTERVAL_MIN || 30);
const seen = new Set();

async function tg(msg) {
  await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: msg.slice(0, 3900),
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function extractOffers(data) {
  const offers = [];

  function walk(x) {
    if (!x) return;

    if (Array.isArray(x)) return x.forEach(walk);

    if (typeof x === "object") {
      const title =
        x.title || x.name || x.offer_name || x.offerName || x.campaign_name || x.campaignName;

      const points =
        x.points || x.reward || x.payout || x.amount || x.coins || x.virtual_currency_amount;

      if (title) {
        offers.push({
          title: String(title),
          points: points ? String(points) : "Unknown"
        });
      }

      Object.values(x).forEach(walk);
    }
  }

  walk(data);
  return offers;
}

async function getOffers() {
  const proxyUrl =
    `socks5://${encodeURIComponent(process.env.PROXY_USER)}:` +
    `${encodeURIComponent(process.env.PROXY_PASS)}@` +
    `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

  const localProxy = await ProxyChain.anonymizeProxy(proxyUrl);

  const browser = await chromium.launch({
    headless: true,
    proxy: { server: localProxy },
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage({
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36"
  });

  const apiUrls = new Set();
  let offers = [];

  page.on("response", async (res) => {
    const resUrl = res.url();

    if (resUrl.includes("api") || resUrl.includes("offer") || resUrl.includes("campaign")) {
      apiUrls.add(resUrl);

      try {
        const type = res.headers()["content-type"] || "";
        if (type.includes("json")) {
          const json = await res.json();
          offers.push(...extractOffers(json));
        }
      } catch {}
    }
  });

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(20000);

    const ipText = await page.evaluate(async () => {
      try {
        const r = await fetch("https://ipinfo.io/json");
        const j = await r.json();
        return `${j.ip || "unknown"} | ${j.country || "unknown"} | ${j.org || "unknown"}`;
      } catch {
        return "IP check failed";
      }
    });

    await browser.close();
    await ProxyChain.closeAnonymizedProxy(localProxy, true);

    offers = [...new Map(offers.map(o => [o.title.toLowerCase(), o])).values()];

    return { offers, ipText, apiUrls: [...apiUrls] };
  } catch (err) {
    await browser.close();
    await ProxyChain.closeAnonymizedProxy(localProxy, true);
    throw err;
  }
}

async function checkNewOffers() {
  try {
    const { offers, ipText, apiUrls } = await getOffers();

    if (!offers.length) {
      await tg(
        `❌ <b>No offers found</b>\n\n` +
        `📡 ${ipText}\n\n` +
        `Detected API URLs:\n${apiUrls.slice(0, 10).join("\n") || "No API found"}`
      );
      return;
    }

    for (const offer of offers) {
      const id = `${offer.title}-${offer.points}`.toLowerCase();

      if (!seen.has(id)) {
        seen.add(id);

        await tg(
          `🚀 <b>NEW OFFER FOUND</b>\n` +
          `━━━━━━━━━━━━━━\n\n` +
          `🌐 <b>Website:</b> GemiWall\n` +
          `🎯 <b>Offer:</b> ${offer.title}\n` +
          `📦 <b>Network:</b> GemiAds\n` +
          `💰 <b>Reward:</b> ${offer.points} coins\n` +
          `👤 <b>User:</b> mrpoint8\n` +
          `🇺🇸 <b>Country:</b> USA\n\n` +
          `📡 <b>IP:</b> ${ipText}`
        );
      }
    }
  } catch (err) {
    await tg(`❌ <b>Bot/IP Error</b>\n${err.message}`);
  }
}

async function run() {
  console.log("Bot started");
  await checkNewOffers();
  setInterval(checkNewOffers, INTERVAL_MIN * 60 * 1000);
}

run();
