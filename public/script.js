// public/script.js
// Client-side logic for the trading analysis UI.

document.addEventListener('DOMContentLoaded', () => {
    const assetSelect = document.getElementById('asset-select');
    const timeframeSelect = document.getElementById('timeframe-select');
    const analyzeBtn = document.getElementById('analyze-btn');
    const resultsContainer = document.getElementById('results-container');
    const loader = document.getElementById('loader');
    const resultsContent = document.getElementById('results-content');
    const errorMessage = document.getElementById('error-message');
    const chartContainer = document.getElementById('chart-container');

    const entryPointEl = document.getElementById('entry-point');
    const stopLossEl = document.getElementById('stop-loss');
    const takeProfitEl = document.getElementById('take-profit');
    const rationaleEl = document.getElementById('rationale');

    let chart = null; // To hold the chart instance

    // Function to show a custom message box
    function showMessageBox(message, type = 'error') {
        // Remove existing message boxes first
        document.querySelectorAll('.message-box').forEach(box => box.remove());

        const messageBox = document.createElement('div');
        messageBox.className = `message-box ${type}`;
        messageBox.innerHTML = `<p>${message}</p><button class="message-box-close">OK</button>`;
        document.body.appendChild(messageBox);
        messageBox.querySelector('.message-box-close').addEventListener('click', () => messageBox.remove());
    }

    // 1. Populate asset dropdown
    // Encapsulate asset loading in a dedicated function for better control
    async function loadAssets() {
        assetSelect.innerHTML = '<option value="">Loading assets...</option>'; // Show loading state
        assetSelect.disabled = true; // Disable until loaded

        return new Promise((resolve, reject) => {
            const derivSocket = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            derivSocket.onopen = () => {
                derivSocket.send(JSON.stringify({ active_symbols: "brief", product_type: "basic" }));
            };

            derivSocket.onmessage = (msg) => {
                const data = JSON.parse(msg.data);
                if (data.error) {
                    showMessageBox(`Failed to load assets: ${data.error.message}`, 'error');
                    assetSelect.innerHTML = '<option value="">Error loading assets</option>';
                    reject(new Error(data.error.message));
                    derivSocket.close();
                    return;
                }
                if (data.msg_type === 'active_symbols') { // Check for explicit message type
                    if (data.active_symbols && data.active_symbols.length > 0) {
                        const symbols = data.active_symbols.filter(s =>
                            s.market === 'forex' || s.market === 'indices' || s.market === 'synthetic_index'
                        ).sort((a, b) => a.display_name.localeCompare(b.display_name));

                        assetSelect.innerHTML = ''; // Clear loading message
                        if (symbols.length > 0) {
                            symbols.forEach(symbol => {
                                const option = document.createElement('option');
                                option.value = symbol.symbol;
                                option.textContent = symbol.display_name;
                                assetSelect.appendChild(option);
                            });
                            assetSelect.disabled = false; // Enable dropdown
                            resolve();
                        } else {
                            assetSelect.innerHTML = '<option value="">No relevant assets found</option>';
                            showMessageBox('No relevant trading assets found from the API.', 'warning');
                            reject(new Error('No relevant assets found'));
                        }
                    } else {
                        assetSelect.innerHTML = '<option value="">No assets received</option>';
                        showMessageBox('No assets data received from the API.', 'warning');
                        reject(new Error('No assets data received'));
                    }
                    derivSocket.close();
                }
            };

            derivSocket.onerror = (event) => {
                console.error('Deriv WebSocket error:', event);
                showMessageBox('Failed to connect to Deriv WebSocket for assets. Check your network.', 'error');
                assetSelect.innerHTML = '<option value="">Network error</option>';
                reject(new Error('WebSocket connection error'));
                derivSocket.close();
            };

            derivSocket.onclose = () => {
                console.log('Deriv WebSocket closed.');
            };

            // Set a timeout to reject if no message is received within a certain time
            setTimeout(() => {
                if (assetSelect.disabled) { // If still disabled, means no assets loaded
                    showMessageBox('Asset loading timed out. Please refresh and try again.', 'error');
                    assetSelect.innerHTML = '<option value="">Loading timed out</option>';
                    reject(new Error('Asset loading timed out'));
                    derivSocket.close();
                }
            }, 10000); // 10 seconds timeout
        });
    }

    // Call loadAssets on DOMContentLoaded
    loadAssets().catch(err => console.error("Error during initial asset load:", err));


    // 2. Function to initialize and update the chart
    function displayChartData(marketData) {
        if (!marketData || !marketData.candles || marketData.candles.length === 0) {
            chartContainer.innerHTML = 'Not enough data to display chart.';
            return;
        }

        // Clear previous chart if it exists
        if (chart) {
            chart.remove();
            chart = null;
        }
        chartContainer.innerHTML = ''; // Clear any error messages

        // Ensure chart container has dimensions before creating the chart
        const containerWidth = chartContainer.clientWidth;
        const containerHeight = chartContainer.clientHeight;

        if (containerWidth === 0 || containerHeight === 0) {
            console.warn('Chart container has no dimensions. Cannot create chart.');
            chartContainer.innerHTML = 'Chart container not ready. Please try again.';
            return;
        }

        chart = LightweightCharts.createChart(chartContainer, {
            width: containerWidth,
            height: containerHeight,
            layout: { backgroundColor: '#ffffff', textColor: '#333' },
            grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: '#cccccc' },
            timeScale: { borderColor: '#cccccc' },
        });

        // Check if chart was successfully created
        if (!chart) {
            console.error('Failed to create LightweightCharts instance.');
            chartContainer.innerHTML = 'Failed to initialize chart. Please refresh.';
            return;
        }

        const candleSeries = chart.addCandlestickSeries({
            upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
            wickUpColor: '#26a69a', wickDownColor: '#ef5350'
        });
        candleSeries.setData(marketData.candles);

        // Add SMA Line
        if (marketData.indicators.sma50 && marketData.indicators.sma50.length > 0) {
            const smaLine = chart.addLineSeries({ color: 'rgba(5, 122, 255, 0.8)', lineWidth: 2 });
            const smaData = marketData.candles
                .map((candle, index) => ({
                    time: candle.time,
                    value: marketData.indicators.sma50[index]
                }))
                .filter(d => typeof d.value === 'number'); // Filter out non-numeric values
            smaLine.setData(smaData);
        }

        // Add Bollinger Bands
        if (marketData.indicators.bollingerBands && marketData.indicators.bollingerBands.length > 0) {
            const bbUpper = chart.addLineSeries({ color: 'rgba(204, 102, 0, 0.5)', lineWidth: 1 });
            const bbMiddle = chart.addLineSeries({ color: 'rgba(204, 102, 0, 0.5)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted });
            const bbLower = chart.addLineSeries({ color: 'rgba(204, 102, 0, 0.5)', lineWidth: 1 });

            const bbData = marketData.candles
                .map((candle, index) => ({
                    time: candle.time,
                    ...marketData.indicators.bollingerBands[index]
                }))
                .filter(d => typeof d.upper === 'number' && typeof d.middle === 'number' && typeof d.lower === 'number');

            bbUpper.setData(bbData.map(d => ({ time: d.time, value: d.upper })));
            bbMiddle.setData(bbData.map(d => ({ time: d.time, value: d.middle })));
            bbLower.setData(bbData.map(d => ({ time: d.time, value: d.lower })));
        }

        chart.timeScale().fitContent();
    }


    // 3. Handle "Analyze" button click
    analyzeBtn.addEventListener('click', async () => {
        const selectedAsset = assetSelect.value;
        const selectedTimeframe = timeframeSelect.value;
        if (!selectedAsset) {
            showMessageBox('Please select an asset before analyzing.', 'warning');
            return;
        }

        resultsContainer.classList.remove('results-hidden');
        resultsContent.style.display = 'none';
        loader.classList.remove('loader-hidden');
        errorMessage.classList.add('error-hidden');
        errorMessage.textContent = '';
        chartContainer.innerHTML = ''; // Clear previous chart message/content

        try {
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset: selectedAsset, timeframe: selectedTimeframe })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || `HTTP error! Status: ${response.status}`);

            // 4. Display results and chart
            const analysis = result.analysis;
            entryPointEl.textContent = analysis.entryPoint ? parseFloat(analysis.entryPoint).toFixed(4) : 'N/A';
            stopLossEl.textContent = analysis.stopLoss ? parseFloat(analysis.stopLoss).toFixed(4) : 'N/A';
            takeProfitEl.textContent = analysis.takeProfit ? parseFloat(analysis.takeProfit).toFixed(4) : 'N/A';
            rationaleEl.textContent = analysis.rationale || 'No rationale provided.';

            displayChartData(result.marketData);

            loader.classList.add('loader-hidden');
            resultsContent.style.display = 'block';

        } catch (error) {
            console.error('Analysis request failed:', error);
            errorMessage.textContent = `Analysis failed: ${error.message}`;
            errorMessage.classList.remove('error-hidden');
            loader.classList.add('loader-hidden');
        }
    });

    // Resize chart with window
    window.addEventListener('resize', () => {
        if (chart) {
            chart.applyOptions({ width: chartContainer.clientWidth });
        }
    });
});
