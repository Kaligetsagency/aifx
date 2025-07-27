// server.js
// Backend Express server for the trading analysis application.

const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fetch = require('node-fetch');

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());
// Serve static files from the 'public' directory
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
        case 'd': return value * 24 * 3600; // Added for '1D'
        default: return 60; // Default to 1 minute
    }
}

/**
 * Calculates Simple Moving Average (SMA) for a given period.
 * This is a basic implementation. For production, consider a dedicated TA library.
 * @param {Array<Object>} candles - Array of candle objects with a 'close' property.
 * @param {number} period - The period for the SMA calculation.
 * @returns {Array<Object>} Candles with an added 'sma' property.
 */
function calculateSMA(candles, period) {
    return candles.map((candle, index, arr) => {
        if (index >= period - 1) {
            const sum = arr.slice(index - period + 1, index + 1).reduce((acc, c) => acc + c.close, 0);
            return { ...candle, sma: parseFloat((sum / period).toFixed(4)) }; // Format to 4 decimal places
        }
        return { ...candle, sma: null };
    });
}

/**
 * Deriv API communication via WebSocket to fetch historical candle data.
 * Increased count for more historical data.
 * @param {string} asset - The financial asset to fetch data for (e.g., 'R_100').
 * @param {string} timeframe - The timeframe for the data (e.g., 'M1', 'H1').
 * @returns {Promise<any>} A promise that resolves with the fetched candles data.
 */
function getMarketData(asset, timeframe) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        ws.onopen = () => {
            // Request more historical data for better analysis
            ws.send(JSON.stringify({
                "ticks_history": asset,
                "end": "latest",
                "count": 5000, // Increased from 500 to 5000 for more data
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
                    // Add technical indicators here before resolving
                    const candlesWithSMA = calculateSMA(data.candles, 20); // Example: 20-period SMA
                    resolve(candlesWithSMA);
                } else {
                    reject(new Error(`No candle data returned for asset ${asset} and timeframe.`));
                }
                ws.close();
            }
        };

        ws.onclose = () => {};
        ws.onerror = (err) => {
            reject(new Error('WebSocket error: ' + err.message));
        };
    });
}

// API endpoint to analyze market data
app.post('/api/analyze', async (req, res) => {
    const { asset, timeframe } = req.body;

    if (!asset || !timeframe) {
        return res.status(400).json({ error: 'Asset and timeframe are required.' });
    }

    try {
        // Get market data with calculated indicators
        const marketDataWithIndicators = await getMarketData(asset, timeframe);

        // Construct a more sophisticated prompt for the AI
        const prompt = `You are a world-class algorithmic trading strategist with expertise in multi-timeframe technical analysis, pattern recognition, and risk management. Your objective is to generate highly precise and profitable trade recommendations for a ${asset} trade on the ${timeframe} timeframe, considering the provided historical candle data, including the Simple Moving Average (SMA), and recent volume action.

Analyze the data by first identifying dominant trends (short-term, medium-term), then key support/resistance levels. Subsequently, assess indicator confluence (e.g., how price interacts with SMA), and finally, detect any significant candlestick or chart patterns.

Based on this detailed analysis, determine an optimal trade setup. Return ONLY a JSON object with the following three keys, ensuring the proposed stop-loss provides a clear invalidation point and the take-profit targets a minimum 1.5:1 reward-to-risk ratio. Do not include any other text, markdown formatting, or explanations.

Data: ${JSON.stringify(marketDataWithIndicators)}`;

        const apiKey = process.env.GEMINI_API_KEY;
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

        const aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!aiResponse.ok) {
            const errorBody = await aiResponse.text();
            throw new Error(`Gemini API request failed with status ${aiResponse.status}: ${errorBody}`);
        }

        const aiResult = await aiResponse.json();

        if (!aiResult.candidates || !aiResult.candidates[0] || !aiResult.candidates[0].content || !aiResult.candidates[0].content.parts || !aiResult.candidates[0].content.parts[0] || !aiResult.candidates[0].content.parts[0].text) {
            throw new Error('Invalid response structure from Gemini API.');
        }

        const responseText = aiResult.candidates[0].content.parts[0].text;

        // Robust JSON parsing to handle imperfect AI responses.
        // This logic finds the first '{' and the last '}' in the response text,
        // extracts the content between them, and then parses it.
        const jsonStartIndex = responseText.indexOf('{');
        const jsonEndIndex = responseText.lastIndexOf('}');

        if (jsonStartIndex === -1 || jsonEndIndex === -1) {
            console.error("Could not find JSON object in response:", responseText);
            throw new Error('Could not find a valid JSON object in the AI response.');
        }

        const jsonString = responseText.substring(jsonStartIndex, jsonEndIndex + 1);

        try {
            const analysis = JSON.parse(jsonString);
            res.json(analysis);
        } catch (e) {
            console.error("Final attempt to parse JSON failed. String was:", jsonString);
            throw new Error('Could not parse the JSON analysis from the AI response.');
        }

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
