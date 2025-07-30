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
        volume: candles.map(c => c.volume || 0), // Use 0 for volume if not present
    };

    const sma20 = ta.sma({ period: 20, values: input.close });
    const rsi14 = ta.rsi({ period: 14, values: input.close });
    const macd = ta.macd({ values: input.close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const bollingerBands = ta.bollingerbands({ period: 20, stdDev: 2, values: input.close });

    // Align indicator arrays with the candle array, as they have different starting points.
    return candles.map((candle, index) => {
        const smaIndex = index - 19;
        const rsiIndex = index - 14;
        const macdIndex = index - 25; // Based on the slow period of 26
        const bbIndex = index - 19;

        return {
            ...candle,
            sma20: smaIndex >= 0 ? parseFloat(sma20[smaIndex].toFixed(4)) : null,
            rsi: rsiIndex >= 0 ? parseFloat(rsi14[rsiIndex].toFixed(2)) : null,
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

Analyze the provided historical candle data, which includes values for a 20-period SMA, 14-period RSI, MACD, and Bollinger Bands. Your analysis should:
1.  Identify the dominant trend and key support/resistance levels.
2.  Assess momentum using MACD and RSI, noting any divergences or overbought/oversold conditions.
3.  Evaluate volatility and price action relative to the Bollinger Bands and SMA.
4.  Detect any significant candlestick or chart patterns.

Based on this comprehensive analysis, determine an optimal trade setup. Return ONLY a JSON object with the following five keys: "entryPoint", "stopLoss", "takeProfit", "justification", and "confidenceScore".
- The "justification" should be a brief, one-sentence explanation of your reasoning.
- The "confidenceScore" should be an integer from 1 to 10, where 10 is the highest confidence.
- The take-profit should target a minimum 1.5:1 reward-to-risk ratio.
- Do not include any other text, markdown formatting, or explanations.

Data (last 200 candles): ${JSON.stringify(marketDataWithIndicators.slice(-200))}`;

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

        if (!aiResult.candidates || !aiResult.candidates[0] || !aiResult.candidates[0].content || !aiResult.candidates[0].content.parts[0] || !aiResult.candidates[0].content.parts[0].text) {
             if (aiResult.promptFeedback && aiResult.promptFeedback.blockReason) {
                 throw new Error(`AI request was blocked. Reason: ${aiResult.promptFeedback.blockReason}`);
             }
            throw new Error('Invalid response structure from Gemini API.');
        }

        const responseText = aiResult.candidates[0].content.parts[0].text;
        
        // Robustly find and extract the JSON object from the AI's response.
        let jsonString = '';
        const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```|(\{[\s\S]*\})/);

        if (jsonMatch) {
            // Prioritize content from the markdown block, otherwise use the broader match.
            jsonString = jsonMatch[1] || jsonMatch[2];
        }

        if (!jsonString) {
            console.error("Could not find JSON object in response:", responseText);
            throw new Error('Could not find a valid JSON object in the AI response.');
        }

        try {
            const analysis = JSON.parse(jsonString);
            // Return both the analysis and the market data for the client-side chart.
            res.json({ analysis, marketData: marketDataWithIndicators });
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
