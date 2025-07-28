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
        analyzeBtn.disabled = true; // Disable analyze button until assets loaded

        return new Promise((resolve, reject) => {
            const derivSocket = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            derivSocket.onopen = () => {
                console.log('Deriv WebSocket opened for asset loading.');
                derivSocket.send(JSON.stringify({ active_symbols: "brief", product_type: "basic" }));
            };

            derivSocket.onmessage = (msg) => {
                const data = JSON.parse(msg.data);
                if (data.error) {
                    console.error('Deriv API error for assets:', data.error);
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
                            analyzeBtn.disabled = false; // Enable analyze button
                            console.log(`Loaded ${symbols.length} assets.`);
                            resolve();
                        } else {
                            assetSelect.innerHTML = '<option value="">No relevant assets found</option>';
                            showMessageBox('No relevant trading assets found from the API. Check filters.', 'warning');
                            reject(new Error('No relevant assets found'));
                        }
                    } else {
                        assetSelect.innerHTML = '<option value="">No assets received</option>';
                        showMessageBox('No asset data received from the API. Response was empty.', 'warning');
                        reject(new Error('No assets data received'));
                    }
                    derivSocket.close();
                }
            };

            derivSocket.onerror = (event) => {
                console.error('Deriv WebSocket error during asset loading:', event);
                showMessageBox('Failed to connect to Deriv WebSocket for assets. Check your network or API status.', 'error');
                assetSelect.innerHTML = '<option value="">Network error</option>';
                reject(new Error('WebSocket connection error'));
                derivSocket.close();
            };

            derivSocket.onclose = () => {
                console.log('Deriv WebSocket closed for asset loading.');
            };

            // Set a timeout to reject if no message is received within a certain time
            const timeoutId = setTimeout(() => {
                if (assetSelect.disabled) { // If still disabled, means no assets loaded
                    console.warn('Asset loading timed out.');
                    showMessageBox('Asset loading timed out. Please refresh and try again.', 'error');
                    assetSelect.innerHTML = '<option value="">Loading timed out</option>';
                    reject(new Error('Asset loading timed out'));
                    derivSocket.close();
                }
            }, 15000); // Increased timeout to 15 seconds

            // Clear timeout if message received successfully
            derivSocket.onmessage = (msg) => {
                clearTimeout(timeoutId);
                const data = JSON.parse(msg.data);
                // ... (rest of onmessage logic as above)
                if (data.msg_type === 'active_symbols') {
                    // This block executes if active_symbols message is received
                    clearTimeout(timeoutId); // Ensure timeout is cleared on success
                    // ... (rest of symbol processing logic)
                }
            };
        });
    }

    // Call loadAssets on DOMContentLoaded
    loadAssets().catch(err => console.error("Initial asset load failed:", err));


    // 2. Function to initialize and update the chart
    function displayChartData(marketData) {
        console.log('Attempting to display chart data...');
        if (!marketData || !marketData.candles || marketData.candles.length === 0) {
            chartContainer.innerHTML = 'Not enough data to display chart.';
            console.warn('No market data or candles to display chart.');
            return;
        }

        // Clear previous chart if it exists
        if (chart) {
            console.log('Removing existing chart.');
            chart.remove();
            chart = null;
        }
        chartContainer.innerHTML = ''; // Clear any error messages or old content

        // Explicitly check if LightweightCharts is available
        if (typeof LightweightCharts === 'undefined' || !LightweightCharts.createChart) {
            const chartLibErrorMsg = 'LightweightCharts library not loaded or accessible. Please check network and script tag.';
            console.error(chartLibErrorMsg);
            chartContainer.innerHTML = chartLibErrorMsg;
            showMessageBox(chartLibErrorMsg, 'error');
            return;
        }

        // Ensure chart container has dimensions before creating the chart
        const containerWidth = chartContainer.clientWidth;
        const containerHeight = chartContainer.clientHeight;

        if (containerWidth === 0 || containerHeight === 0) {
            console.warn(`Chart container has no dimensions (Width: ${containerWidth}, Height: ${containerHeight}). Retrying chart creation in 500ms.`);
            chartContainer.innerHTML = 'Chart container not ready. Attempting retry...';
            // Retry chart creation after a short delay if dimensions are not ready
            setTimeout(() => displayChartData(marketData), 500);
            return;
        }

        try {
            console.log(`Creating chart with dimensions: ${containerWidth}x${containerHeight}`);
            chart = LightweightCharts.createChart(chartContainer, {
                width: containerWidth,
                height: containerHeight,
                layout: { backgroundColor: '#ffffff', textColor: '#333' },
                grid: { vertLines: { color: '#f0f0f0' }, horzLines: { color: '#f0f0f0' } },
                crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
                rightPriceScale: { borderColor: '#cccccc' },
                timeScale: { borderColor: '#cccccc' },
            });

            // Double check if chart was successfully created and is an object
            if (!chart || typeof chart.addCandlestickSeries !== 'function') {
                const chartCreationError = 'Failed to create LightweightCharts instance. Chart object is invalid.';
                console.error(chartCreationError);
                chartContainer.innerHTML = chartCreationError;
                showMessageBox(chartCreationError, 'error');
                return;
            }

            console.log('Chart instance created successfully. Adding candlestick series...');
            const candleSeries = chart.addCandlestickSeries({
                upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
                wickUpColor: '#26a69a', wickDownColor: '#ef5350'
            });
            candleSeries.setData(marketData.candles);
            console.log(`Added ${marketData.candles.length} candles.`);

            // Add SMA Line
            if (marketData.indicators.sma50 && marketData.indicators.sma50.length > 0) {
                console.log('Adding SMA 50 line.');
                const smaLine = chart.addLineSeries({ color: 'rgba(5, 122, 255, 0.8)', lineWidth: 2 });
                const smaData = marketData.candles
                    .map((candle, index) => ({
                        time: candle.time,
                        value: marketData.indicators.sma50[index]
                    }))
                    .filter(d => typeof d.value === 'number'); // Filter out non-numeric values
                smaLine.setData(smaData);
                console.log(`Added ${smaData.length} SMA points.`);
            }

            // Add Bollinger Bands
            if (marketData.indicators.bollingerBands && marketData.indicators.bollingerBands.length > 0) {
                console.log('Adding Bollinger Bands.');
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
                console.log(`Added ${bbData.length} Bollinger Band points.`);
            }

            chart.timeScale().fitContent();
            console.log('Chart display completed.');
        } catch (e) {
            console.error('Error during chart rendering:', e);
            chartContainer.innerHTML = `Error rendering chart: ${e.message}`;
            showMessageBox(`Error rendering chart: ${e.message}`, 'error');
        }
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
        console.log(`Analyzing asset: ${selectedAsset}, timeframe: ${selectedTimeframe}`);

        try {
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset: selectedAsset, timeframe: selectedTimeframe })
            });
            const result = await response.json();
            if (!response.ok) {
                const errorMsg = result.error || `HTTP error! Status: ${response.status}`;
                console.error('API analysis response error:', errorMsg);
                throw new Error(errorMsg);
            }

            // 4. Display results and chart
            const analysis = result.analysis;
            entryPointEl.textContent = analysis.entryPoint ? parseFloat(analysis.entryPoint).toFixed(4) : 'N/A';
            stopLossEl.textContent = analysis.stopLoss ? parseFloat(analysis.stopLoss).toFixed(4) : 'N/A';
            takeProfitEl.textContent = analysis.takeProfit ? parseFloat(analysis.takeProfit).toFixed(4) : 'N/A';
            rationaleEl.textContent = analysis.rationale || 'No rationale provided.';

            console.log('Analysis results received, displaying chart data...');
            displayChartData(result.marketData);

            loader.classList.add('loader-hidden');
            resultsContent.style.display = 'block';
            console.log('Analysis and chart display process completed.');

        } catch (error) {
            console.error('Analysis request failed:', error);
            errorMessage.textContent = `Analysis failed: ${error.message}`;
            errorMessage.classList.remove('error-hidden');
            loader.classList.add('loader-hidden');
            showMessageBox(`Analysis failed: ${error.message}`, 'error');
        }
    });

    // Resize chart with window
    window.addEventListener('resize', () => {
        if (chart) {
            const newWidth = chartContainer.clientWidth;
            if (newWidth > 0) {
                chart.applyOptions({ width: newWidth });
                console.log(`Chart resized to width: ${newWidth}`);
            }
        }
    });
});
