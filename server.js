// server.js
// Backend Express server for the trading analysis application.

const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const finnhub = require('finnhub');
const { SMA, RSI, MACD, BollingerBands } = require('technicalindicators');

// Load environment variables
dotenv.config();
const app = express();
const port = 3000;

// Setup Finnhub API
const api_key = finnhub.ApiClient.instance.authentications['api_key'];
api_key.apiKey = process.env.FINNHUB_API_KEY;
const finnhubClient = new finnhub.DefaultApi();

// Middleware
app.use(express.json());
app.use(express.static('public'));

/**
 * Converts human-readable timeframe to seconds for the Deriv API.
 * @param {string} timeframe - The timeframe string (e.g., '1m', '5m', '1H').
 * @returns {number} The timeframe in seconds.
 */
function getTimeframeInSeconds(timeframe) {
    const unit = timeframe.slice(-1).toLowerCase();
    const value = parseInt(timeframe.slice(0, -1));
    switch (unit) {
        case 'm': return value * 60;
        case 'h': return value * 3600;
        case 'd': return value * 24 * 3600;
        default: return 60;
    }
}

/**
 * Calculates a suite of technical indicators for the candle data.
 * @param {Array<Object>} candles - Array of candle objects.
 * @returns {Object} An object containing candles and calculated indicators.
 */
function calculateIndicators(candles) {
    const closePrices = candles.map(c => c.close);
    const highPrices = candles.map(c => c.high);
    const lowPrices = candles.map(c => c.low);

    const sma50 = SMA.calculate({ period: 50, values: closePrices });
    const rsi = RSI.calculate({ period: 14, values: closePrices });
    const macd = MACD.calculate({
        values: closePrices,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });
    const bollingerBands = BollingerBands.calculate({ period: 20, stdDev: 2, values: closePrices });

    return {
        sma50,
        rsi,
        macd,
        bollingerBands
    };
}


/**
 * Fetches historical candle data from Deriv API.
 * @param {string} asset - The financial asset to fetch data for.
 * @param {string} timeframe - The timeframe for the data.
 * @returns {Promise<any>} A promise that resolves with the fetched candles data.
 */
function getMarketData(asset, timeframe) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
        ws.onopen = () => {
            ws.send(JSON.stringify({
                "ticks_history": asset,
                "end": "latest",
                "count": 500,
                "style": "candles",
                "granularity": getTimeframeInSeconds(timeframe)
            }));
        };
        ws.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.error) {
                reject(new Error(data.error.message));
                ws.close();
            } else if (data.msg_type === 'candles') {
                if (data.candles && data.candles.length > 0) {
                    resolve(data.candles);
                } else {
                    reject(new Error(`No candle data returned for ${asset}.`));
                }
                ws.close();
            }
        };
        ws.onerror = (err) => reject(new Error('WebSocket error: ' + err.message));
    });
}

/**
 * Fetches upcoming high-impact economic events from Finnhub.
 * @returns {Promise<Array<Object>>} A promise that resolves with a list of events.
 */
function getEconomicEvents() {
    return new Promise((resolve, reject) => {
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        finnhubClient.economicCalendar({ '_from': today, 'to': tomorrow }, (error, data, response) => {
            if (error) {
                console.error("Finnhub API Error:", error);
                // Resolve with empty array instead of rejecting to allow main analysis to continue
                resolve([]);
            } else {
                // Filter for high-impact events for major economies
                const majorEconomies = ['US', 'EU', 'GB', 'JP', 'CN', 'DE'];
                const highImpactEvents = data.economicCalendar.filter(e =>
                    e.impact === 'high' && majorEconomies.includes(e.country)
                ).map(e => ({ event: e.event, country: e.country, time: e.time })); // Keep it concise
                resolve(highImpactEvents);
            }
        });
    });
}


// API endpoint to analyze market data
app.post('/api/analyze', async (req, res) => {
    const { asset, timeframe } = req.body;
    if (!asset || !timeframe) {
        return res.status(400).json({ error: 'Asset and timeframe are required.' });
    }

    try {
        const candles = await getMarketData(asset, timeframe);
        const indicators = calculateIndicators(candles);
        const upcomingEvents = await getEconomicEvents();

        const recentCandles = candles.slice(-50).map(c => ({ o: c.open, h: c.high, l: c.low, c: c.close, t: c.epoch }));
        const recentIndicators = {
            sma50: indicators.sma50.slice(-50),
            rsi: indicators.rsi.slice(-50),
            macd: indicators.macd.slice(-50),
            bollingerBands: indicators.bollingerBands.slice(-50)
        };

        const prompt = `You are an expert trading strategist AI. Your task is to generate a precise trade recommendation for ${asset} on the ${timeframe} timeframe based on the provided market data.

**Market Data:**
1.  **Recent Candles:** ${JSON.stringify(recentCandles)}
2.  **Technical Indicators:**
    * **50-period SMA:** ${JSON.stringify(recentIndicators.sma50)}
    * **14-period RSI:** ${JSON.stringify(recentIndicators.rsi)}
    * **MACD (12,26,9):** ${JSON.stringify(recentIndicators.macd)}
    * **Bollinger Bands (20,2):** ${JSON.stringify(recentIndicators.bollingerBands)}
3.  **Upcoming High-Impact Events (Next 24h):** ${JSON.stringify(upcomingEvents)}

**Analysis & Instructions:**
1.  **Trend:** Identify the primary trend using the 50-SMA.
2.  **Momentum:** Evaluate RSI for overbought/oversold conditions and MACD for crossovers.
3.  **Volatility:** Analyze price action relative to the Bollinger Bands (e.g., breakouts, squeezes).
4.  **Risk:** Assess if upcoming economic events pose a significant risk to the trade.
5.  **Synthesize:** Based on the confluence of these factors, determine an optimal trade setup.

**Output Format:**
Return ONLY a single, minified JSON object with no markdown. The JSON object must have these four keys: "entryPoint", "stopLoss", "takeProfit", and "rationale". The rationale must be a concise, one-sentence explanation for the trade.`;

        const apiKey = process.env.GEMINI_API_KEY;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

        const aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        if (!aiResponse.ok) {
            throw new Error(`Gemini API request failed with status ${aiResponse.status}`);
        }

        const aiResult = await aiResponse.json();
        const responseText = aiResult.candidates[0].content.parts[0].text;

        const jsonStartIndex = responseText.indexOf('{');
        const jsonEndIndex = responseText.lastIndexOf('}');
        const jsonString = responseText.substring(jsonStartIndex, jsonEndIndex + 1);

        const analysis = JSON.parse(jsonString);

        // Send back both the AI analysis and the data needed for charting
        res.json({
            analysis,
            marketData: {
                candles: candles.map(c => ({ time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close })),
                indicators: {
                    sma50: indicators.sma50,
                    bollingerBands: indicators.bollingerBands
                }
            }
        });

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
