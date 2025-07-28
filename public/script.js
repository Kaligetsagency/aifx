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
    const chartContainer = document.getElementById('chart-container'); // Get the chart container element

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
        messageBox.innerHTML = `<p>${message}</p><button class=\"message-box-close\">OK</button>`;
        document.body.appendChild(messageBox);
        messageBox.querySelector('.message-box-close').onclick = () => messageBox.remove();
    }

    // Function to fetch and populate assets
    async function fetchAndPopulateAssets() {
        try {
            // Using a public endpoint for Deriv available assets
            const response = await fetch('https://raw.githubusercontent.com/binary-com/asset-index/master/asset-index.json');
            const data = await response.json();
            const syntheticIndices = data.assets.filter(asset => asset.symbol.startsWith('R_'));

            assetSelect.innerHTML = '<option value="">Select Asset</option>'; // Default option

            syntheticIndices.forEach(asset => {
                const option = document.createElement('option');
                option.value = asset.symbol;
                option.textContent = asset.name;
                assetSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to fetch assets:', error);
            assetSelect.innerHTML = '<option value="">Failed to load assets</option>';
            showMessageBox('Failed to load assets. Please try refreshing the page.', 'error');
        }
    }

    // Call fetchAndPopulateAssets on page load
    fetchAndPopulateAssets();


    // Function to display chart data
    function displayChartData(marketData) {
        if (chart) {
            chart.remove(); // Remove existing chart if any
            chart = null;
        }

        // *** DEBUGGING LOG: Check if chartContainer is found ***
        console.log('chartContainer element:', chartContainer);
        if (!chartContainer) {
            console.error('Error: chart-container element not found in the DOM.');
            showMessageBox('Chart container not found. Cannot display chart.', 'error');
            return;
        }


        chart = LightweightCharts.createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: 400,
            layout: {
                backgroundColor: '#ffffff',
                textColor: '#333',
            },
            grid: {
                vertLines: { color: '#e0e0e0' },
                horzLines: { color: '#e0e0e0' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            priceScale: {
                borderColor: '#e0e0e0',
            },
            timeScale: {
                borderColor: '#e0e0e0',
                timeVisible: true,
                secondsVisible: false,
            },
        });

        // *** DEBUGGING LOG: Check the chart object after creation ***
        console.log('Chart object after creation:', chart);

        // *** CRITICAL CHECK: Ensure chart is a valid object before adding series ***
        if (!chart || typeof chart.addCandlestickSeries !== 'function') {
            console.error('Error: Lightweight Charts failed to create a valid chart instance.');
            showMessageBox('Failed to initialize chart. Please try again or check console for details.', 'error');
            return;
        }


        const candlestickSeries = chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
        });

        const formattedCandles = marketData.candles.map(c => ({
            time: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
        }));

        candlestickSeries.setData(formattedCandles);

        // Add SMA (50) overlay
        if (marketData.indicators.sma50 && marketData.indicators.sma50.length > 0) {
            const smaData = marketData.indicators.sma50.map((sma, index) => ({
                // Ensure time aligns with candle data
                time: formattedCandles[formattedCandles.length - marketData.indicators.sma50.length + index].time,
                value: sma,
            }));
            const smaSeries = chart.addLineSeries({ color: 'blue', lineWidth: 1 });
            smaSeries.setData(smaData);
        }

        // Add Bollinger Bands overlay
        if (marketData.indicators.bollingerBands && marketData.indicators.bollingerBands.length > 0) {
            const bbUpper = marketData.indicators.bollingerBands.map((bb, index) => ({
                time: formattedCandles[formattedCandles.length - marketData.indicators.bollingerBands.length + index].time,
                value: bb.upper,
            }));
            const bbMiddle = marketData.indicators.bollingerBands.map((bb, index) => ({
                time: formattedCandles[formattedCandles.length - marketData.indicators.bollingerBands.length + index].time,
                value: bb.middle,
            }));
            const bbLower = marketData.indicators.bollingerBands.map((bb, index) => ({
                time: formattedCandles[formattedCandles.length - marketData.indicators.bollingerBands.length + index].time,
                value: bb.lower,
            }));

            const bbUpperSeries = chart.addLineSeries({ color: 'purple', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });
            const bbMiddleSeries = chart.addLineSeries({ color: 'gray', lineWidth: 1 });
            const bbLowerSeries = chart.addLineSeries({ color: 'purple', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed });

            bbUpperSeries.setData(bbUpper);
            bbMiddleSeries.setData(bbMiddle);
            bbLowerSeries.setData(bbLower);
        }

        chart.timeScale().fitContent();
    }


    // Event listener for analysis button
    analyzeBtn.addEventListener('click', async () => {
        const selectedAsset = assetSelect.value;
        const selectedTimeframe = timeframeSelect.value;

        if (!selectedAsset || !selectedTimeframe) {
            showMessageBox('Please select both an asset and a timeframe.', 'warning');
            return;
        }

        // 1. Show loader, hide results and error
        resultsContainer.classList.remove('results-hidden');
        resultsContent.style.display = 'none';
        errorMessage.classList.add('error-hidden');
        loader.classList.remove('loader-hidden');

        try {
            // 2. Clear previous chart data if any
            if (chart) {
                chart.remove();
                chart = null;
            }
            chartContainer.innerHTML = ''; // Clear the container

            // 3. Make API request to backend
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
