// server.js
// Backend Express server for the trading analysis application.

const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const ta = require('technicalindicators');

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
        case 'd': return value * 24 * 3600;
        default: return 60; // Default to 1 minute
    }
}

/**
 * Calculates a suite of technical indicators using the 'technicalindicators' library.
 * @param {Array<Object>} candles - Array of candle objects from the Deriv API.
 * @returns {Array<Object>} Candles with added technical indicator properties.
 */
function calculateTechnicalIndicators(candles) {
    const input = {
        open: candles.map(c => c.open),
        high: candles.map(c => c.high),
        low: candles.map(c => c.low),
        close: candles.map(c => c.close),
        volume: candles.map(c => c.volume),
        period: 0
    };

    const rsi = ta.rsi({ values: input.close, period: 14 });
    const macd = ta.macd({ values: input.close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const bollingerBands = ta.bollingerbands({ values: input.close, period: 20, stdDev: 2 });
    const ema50 = ta.ema({ values: input.close, period: 50 });
    const ema200 = ta.ema({ values: input.close, period: 200 });

    return candles.map((candle, index) => {
        const rsiIndex = index - 14;
        const macdIndex = index - 25;
        const bbIndex = index - 19;
        const ema50Index = index - 49;
        const ema200Index = index - 199;

        return {
            ...candle,
            rsi: rsiIndex >= 0 ? parseFloat(rsi[rsiIndex].toFixed(2)) : null,
            macd: macdIndex >= 0 ? {
                MACD: parseFloat(macd[macdIndex].MACD.toFixed(4)),
                signal: parseFloat(macd[macdIndex].signal.toFixed(4)),
                histogram: parseFloat(macd[macdIndex].histogram.toFixed(4))
            } : null,
            bollingerBands: bbIndex >= 0 ? {
                upper: parseFloat(bollingerBands[bbIndex].upper.toFixed(4)),
                middle: parseFloat(bollingerBands[bbIndex].middle.toFixed(4)),
                lower: parseFloat(bollingerBands[bbIndex].lower.toFixed(4))
            } : null,
            ema50: ema50Index >= 0 ? parseFloat(ema50[ema50Index].toFixed(4)) : null,
            ema200: ema200Index >= 0 ? parseFloat(ema200[ema200Index].toFixed(4)) : null,
        };
    });
}


/**
 * Deriv API communication via WebSocket to fetch historical candle data.
 * @param {string} asset - The financial asset to fetch data for (e.g., 'R_100').
 * @param {string} timeframe - The timeframe for the data (e.g., 'M1', 'H1').
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
                    const candlesWithIndicators = calculateTechnicalIndicators(data.candles);
                    resolve(candlesWithIndicators);
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
        const marketDataWithIndicators = await getMarketData(asset, timeframe);

        const prompt = `You are a world-class algorithmic trading strategist. Your objective is to generate a precise trade recommendation for a ${asset} trade on the ${timeframe} timeframe.

Analyze the provided historical candle data, which includes values for RSI, MACD, Bollinger Bands, and 50/200 period EMAs. Your analysis should:
1.  Identify the dominant trend using the EMAs.
2.  Assess momentum using the MACD and RSI. Note any divergences or overbought/oversold conditions.
3.  Evaluate volatility and potential breakout zones using the Bollinger Bands.
4.  Identify key support and resistance levels from the price action.

Based on this comprehensive analysis, determine an optimal trade setup. Return ONLY a JSON object with the following five keys: "entryPoint", "stopLoss", "takeProfit", "justification", and "confidenceScore".
- The "justification" should be a brief, one-sentence explanation of your reasoning.
- The "confidenceScore" should be an integer from 1 to 10, where 10 is the highest confidence.
- Do not include any other text, markdown formatting, or explanations.

Data (last 50 candles): ${JSON.stringify(marketDataWithIndicators.slice(-50))}`;

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
        console.log("Raw Gemini API response text:", responseText); // Log raw response for debugging

        // Use a regular expression to find the JSON object
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);

        let analysis;
        if (jsonMatch && jsonMatch[0]) {
            try {
                analysis = JSON.parse(jsonMatch[0]);
                res.json({ analysis, marketData: marketDataWithIndicators });
            } catch (e) {
                console.error("Failed to parse JSON from Gemini API response. Attempted string:", jsonMatch[0]);
                throw new Error('Could not parse the JSON analysis from the AI response.');
            }
        } else {
            console.error("No JSON object found in Gemini API response. Raw response:", responseText);
            throw new Error('No valid JSON object found in the AI response from Gemini.');
        }

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});// server.js
// Backend Express server for the trading analysis application.

const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fetch = require('node-fetch');
const ta = require('technicalindicators');

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
        case 'd': return value * 24 * 3600;
        default: return 60; // Default to 1 minute
    }
}

/**
 * Calculates a suite of technical indicators using the 'technicalindicators' library.
 * @param {Array<Object>} candles - Array of candle objects from the Deriv API.
 * @returns {Array<Object>} Candles with added technical indicator properties.
 */
function calculateTechnicalIndicators(candles) {
    const input = {
        open: candles.map(c => c.open),
        high: candles.map(c => c.high),
        low: candles.map(c => c.low),
        close: candles.map(c => c.close),
        volume: candles.map(c => c.volume),
        period: 0
    };

    const rsi = ta.rsi({ values: input.close, period: 14 });
    const macd = ta.macd({ values: input.close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const bollingerBands = ta.bollingerbands({ values: input.close, period: 20, stdDev: 2 });
    const ema50 = ta.ema({ values: input.close, period: 50 });
    const ema200 = ta.ema({ values: input.close, period: 200 });

    return candles.map((candle, index) => {
        const rsiIndex = index - 14;
        const macdIndex = index - 25;
        const bbIndex = index - 19;
        const ema50Index = index - 49;
        const ema200Index = index - 199;

        return {
            ...candle,
            rsi: rsiIndex >= 0 ? parseFloat(rsi[rsiIndex].toFixed(2)) : null,
            macd: macdIndex >= 0 ? {
                MACD: parseFloat(macd[macdIndex].MACD.toFixed(4)),
                signal: parseFloat(macd[macdIndex].signal.toFixed(4)),
                histogram: parseFloat(macd[macdIndex].histogram.toFixed(4))
            } : null,
            bollingerBands: bbIndex >= 0 ? {
                upper: parseFloat(bollingerBands[bbIndex].upper.toFixed(4)),
                middle: parseFloat(bollingerBands[bbIndex].middle.toFixed(4)),
                lower: parseFloat(bollingerBands[bbIndex].lower.toFixed(4))
            } : null,
            ema50: ema50Index >= 0 ? parseFloat(ema50[ema50Index].toFixed(4)) : null,
            ema200: ema200Index >= 0 ? parseFloat(ema200[ema200Index].toFixed(4)) : null,
        };
    });
}


/**
 * Deriv API communication via WebSocket to fetch historical candle data.
 * @param {string} asset - The financial asset to fetch data for (e.g., 'R_100').
 * @param {string} timeframe - The timeframe for the data (e.g., 'M1', 'H1').
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
                    const candlesWithIndicators = calculateTechnicalIndicators(data.candles);
                    resolve(candlesWithIndicators);
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
        const marketDataWithIndicators = await getMarketData(asset, timeframe);

        const prompt = `You are a world-class algorithmic trading strategist. Your objective is to generate a precise trade recommendation for a ${asset} trade on the ${timeframe} timeframe.

Analyze the provided historical candle data, which includes values for RSI, MACD, Bollinger Bands, and 50/200 period EMAs. Your analysis should:
1.  Identify the dominant trend using the EMAs.
2.  Assess momentum using the MACD and RSI. Note any divergences or overbought/oversold conditions.
3.  Evaluate volatility and potential breakout zones using the Bollinger Bands.
4.  Identify key support and resistance levels from the price action.

Based on this comprehensive analysis, determine an optimal trade setup. Return ONLY a JSON object with the following five keys: "entryPoint", "stopLoss", "takeProfit", "justification", and "confidenceScore".
- The "justification" should be a brief, one-sentence explanation of your reasoning.
- The "confidenceScore" should be an integer from 1 to 10, where 10 is the highest confidence.
- Do not include any other text, markdown formatting, or explanations.

Data (last 50 candles): ${JSON.stringify(marketDataWithIndicators.slice(-50))}`;

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
        console.log("Raw Gemini API response text:", responseText); // Log raw response for debugging

        // Use a regular expression to find the JSON object
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);

        let analysis;
        if (jsonMatch && jsonMatch[0]) {
            try {
                analysis = JSON.parse(jsonMatch[0]);
                res.json({ analysis, marketData: marketDataWithIndicators });
            } catch (e) {
                console.error("Failed to parse JSON from Gemini API response. Attempted string:", jsonMatch[0]);
                throw new Error('Could not parse the JSON analysis from the AI response.');
            }
        } else {
            console.error("No JSON object found in Gemini API response. Raw response:", responseText);
            throw new Error('No valid JSON object found in the AI response from Gemini.');
        }

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
