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

// Setup Google Gemini API
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// *** IMPORTANT FIX: Using 'gemini-2.5-flash' for broader compatibility ***
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });


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
 * @param {Array<Object>} candles - Array of OHLC candles.
 * @returns {Object} Object containing calculated indicators.
 */
function calculateIndicators(candles) {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Ensure enough data for indicators
    if (closes.length < 50) { // SMA(50) needs at least 50 data points
        return { sma50: [], bollingerBands: [] };
    }

    const sma50 = SMA.calculate({ period: 50, values: closes });

    // Bollinger Bands calculation needs adjusted input if closes.length is small
    let bollingerBands = [];
    if (closes.length >= 20) { // Bollinger Bands typically use a 20-period SMA
        bollingerBands = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    }

    return { sma50, bollingerBands };
}

/**
 * Fetches historical candle data from the Deriv API.
 * @param {string} symbol - Trading asset symbol (e.g., 'R_100').
 * @param {number} timeframeSeconds - Granularity of candles in seconds.
 * @param {number} count - Number of candles to retrieve.
 * @returns {Promise<Array<Object>>} Array of candle data.
 */
async function getCandleData(symbol, timeframeSeconds, count) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        ws.onopen = () => {
            ws.send(JSON.stringify({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: count,
                end: 'latest',
                start: 1,
                style: 'candles',
                granularity: timeframeSeconds
            }));
        };

        ws.onmessage = (msg) => {
            const data = JSON.parse(msg.data);
            if (data.error) {
                reject(new Error(data.error.message));
            } else if (data.msg_type === 'candles') {
                const candles = data.candles.map(c => ({
                    epoch: parseInt(c.epoch), // Ensure time is a number
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close)
                })).sort((a, b) => a.epoch - b.epoch); // Ensure chronological order
                resolve(candles);
            }
            ws.close();
        };

        ws.onerror = (err) => {
            reject(new Error(`WebSocket error fetching candle data: ${err.message}`));
        };

        ws.onclose = () => {
            console.log('Deriv WebSocket for candles closed.');
        };
    });
}


// API endpoint for analysis
app.post('/api/analyze', async (req, res) => {
    const { asset, timeframe } = req.body;
    const timeframeSeconds = getTimeframeInSeconds(timeframe);
    const candleCount = 200; // Request enough candles for indicators (e.g., SMA 50 needs at least 50 candles)

    if (!asset || !timeframe) {
        return res.status(400).json({ error: 'Asset and timeframe are required.' });
    }

    try {
        // 1. Fetch historical data
        const candles = await getCandleData(asset, timeframeSeconds, candleCount);
        if (candles.length === 0) {
            return res.status(404).json({ error: 'No candle data found for the selected asset and timeframe.' });
        }

        // 2. Calculate technical indicators
        const indicators = calculateIndicators(candles);

        // 3. Prepare data for AI model
        const latestCandle = candles[candles.length - 1];
        const last50Closes = candles.slice(-50).map(c => c.close); // Last 50 closes for context
        const prompt = `Given the following market data for ${asset} on a ${timeframe} timeframe:
        Latest candle: Open=${latestCandle.open}, High=${latestCandle.high}, Low=${latestCandle.low}, Close=${latestCandle.close}.
        Last 50 closing prices: ${last50Closes.join(', ')}.
        SMA(50): ${indicators.sma50 ? indicators.sma50[indicators.sma50.length - 1] : 'N/A'}.
        Bollinger Bands (last values): Upper=${indicators.bollingerBands && indicators.bollingerBands.length > 0 ? indicators.bollingerBands[indicators.bollingerBands.length - 1].upper : 'N/A'}, Middle=${indicators.bollingerBands && indicators.bollingerBands.length > 0 ? indicators.bollingerBands[indicators.bollingerBands.length - 1].middle : 'N/A'}, Lower=${indicators.bollingerBands && indicators.bollingerBands.length > 0 ? indicators.bollingerBands[indicators.bollingerBands.length - 1].lower : 'N/A'}.

        Based on this data, provide a concise trading analysis for the next immediate period.
        Suggest a potential entry point, stop loss, and take profit level.
        Also, provide a brief rationale for the suggestion.
        Format your response as a JSON object with the following structure:
        {
            "entryPoint": "number",
            "stopLoss": "number",
            "takeProfit": "number",
            "rationale": "string"
        }`;

        // 4. Call Gemini AI
        const aiResult = await model.generateContent(prompt);

        // *** DEBUGGING LOGS ***
        console.log('Full AI Result:', JSON.stringify(aiResult, null, 2));


        // Validate AI response structure
        if (!aiResult || !aiResult.candidates || aiResult.candidates.length === 0 || !aiResult.candidates[0].content || !aiResult.candidates[0].content.parts || aiResult.candidates[0].content.parts.length === 0 || !aiResult.candidates[0].content.parts[0].text) {
             throw new Error('Invalid or empty response structure from Gemini API. Check console for full AI result.');
        }

        const responseText = aiResult.candidates[0].content.parts[0].text;

        // *** DEBUGGING LOGS ***
        console.log('Extracted Response Text from AI:', responseText);


        // Extract JSON string from AI response, robustly handling potential markdown
        const jsonStartIndex = responseText.indexOf('{');
        const jsonEndIndex = responseText.lastIndexOf('}');

        if (jsonStartIndex === -1 || jsonEndIndex === -1) {
            throw new Error('Could not find a valid JSON object in the AI response text. Check console for AI text.');
        }

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
        // This block catches any error from the 'try' block and sends a structured JSON error.
        console.error('Analysis error:', error.stack);
        res.status(500).json({ error: error.message || 'An unknown error occurred during analysis.' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
