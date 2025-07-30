// public/script.js
// Client-side logic for the trading analysis UI.

document.addEventListener('DOMContentLoaded', () => { //
    const assetSelect = document.getElementById('asset-select'); //
    const timeframeSelect = document.getElementById('timeframe-select'); //
    const analyzeBtn = document.getElementById('analyze-btn'); //
    const resultsContainer = document.getElementById('results-container'); //
    const loader = document.getElementById('loader'); //
    const resultsContent = document.getElementById('results-content'); //
    const errorMessage = document.getElementById('error-message'); //

    const entryPointEl = document.getElementById('entry-point'); //
    const stopLossEl = document.getElementById('stop-loss'); //
    const takeProfitEl = document.getElementById('take-profit'); //
    // New Elements
    const confidenceScoreEl = document.getElementById('confidence-score');
    const justificationEl = document.getElementById('justification');
    const chartContainer = document.getElementById('chart-container');

    const derivSocket = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'); //

    let chart = null; // Variable to hold the chart instance
    let candleSeries = null; // Variable for the main candle series

    // Function to initialize or update the chart
    function setupChart() {
        if (chart) {
            chart.remove();
        }
        chart = LightweightCharts.createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: 350,
            layout: {
                background: { color: '#ffffff' },
                textColor: '#333',
            },
            grid: {
                vertLines: { color: '#e1e1e1' },
                horzLines: { color: '#e1e1e1' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            timeScale: {
                borderColor: '#cccccc',
            },
        });
        candleSeries = chart.addCandlestickSeries({
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderDownColor: '#ef5350',
            borderUpColor: '#26a69a',
            wickDownColor: '#ef5350',
            wickUpColor: '#26a69a',
        });
    }

    // Function to draw a horizontal line on the chart
    function drawPriceLine(price, color, title) {
        return candleSeries.createPriceLine({
            price: price,
            color: color,
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: title,
        });
    }


    // 1. Populate asset dropdown on page load
    derivSocket.onopen = function(e) { //
        derivSocket.send(JSON.stringify({ //
            active_symbols: "brief", //
            product_type: "basic" //
        }));
    };

    derivSocket.onmessage = function(msg) { //
        const data = JSON.parse(msg.data); //

        if (data.error) { //
            console.error('Deriv API error:', data.error.message); //
            return;
        }

        if (data.active_symbols) { //
            const activeSymbols = data.active_symbols; //
            assetSelect.innerHTML = ''; // Clear loading message

            const filteredSymbols = activeSymbols.filter(s => //
                s.market === 'forex' || s.market === 'indices' || s.market === 'synthetic_index' //
            );

            filteredSymbols.sort((a, b) => a.display_name.localeCompare(b.display_name)); //

            filteredSymbols.forEach(symbol => { //
                const option = document.createElement('option'); //
                option.value = symbol.symbol; //
                option.textContent = symbol.display_name; //
                assetSelect.appendChild(option); //
            });
            derivSocket.close(); //
        }
    };

    derivSocket.onerror = function(err) { //
        console.error('WebSocket Error:', err); //
        assetSelect.innerHTML = `<option value="">Failed to connect</option>`; //
    };

    // 2. Handle "Analyze" button click
    analyzeBtn.addEventListener('click', async () => { //
        const selectedAsset = assetSelect.value; //
        const selectedTimeframe = timeframeSelect.value; //

        if (!selectedAsset) { //
            alert('Please select an asset before analyzing.'); //
            return; //
        }

        resultsContainer.classList.remove('results-hidden'); //
        resultsContent.style.display = 'none'; //
        loader.classList.remove('loader-hidden'); //
        errorMessage.classList.add('error-hidden'); //
        errorMessage.textContent = ''; //
        chartContainer.style.display = 'none';

        try {
            const response = await fetch('/api/analyze', { //
                method: 'POST', //
                headers: { //
                    'Content-Type': 'application/json' //
                },
                body: JSON.stringify({ //
                    asset: selectedAsset, //
                    timeframe: selectedTimeframe //
                })
            });

            const result = await response.json(); //

            if (!response.ok) { //
                throw new Error(result.error || `HTTP error! Status: ${response.status}`); //
            }

            const { analysis, marketData } = result;

            // 3. Display results
            entryPointEl.textContent = analysis.entryPoint ? parseFloat(analysis.entryPoint).toFixed(4) : 'N/A'; //
            stopLossEl.textContent = analysis.stopLoss ? parseFloat(analysis.stopLoss).toFixed(4) : 'N/A'; //
            takeProfitEl.textContent = analysis.takeProfit ? parseFloat(analysis.takeProfit).toFixed(4) : 'N/A'; //
            confidenceScoreEl.textContent = `${analysis.confidenceScore || 'N/A'} / 10`;
            justificationEl.textContent = analysis.justification || 'N/A';


            // 4. Setup and display chart
            chartContainer.style.display = 'block';
            setupChart();
            const chartData = marketData.map(d => ({
                time: d.epoch,
                open: d.open,
                high: d.high,
                low: d.low,
                close: d.close
            }));
            candleSeries.setData(chartData);

            // Draw trade levels on chart
            if (analysis.entryPoint) drawPriceLine(analysis.entryPoint, '#1E88E5', 'Entry');
            if (analysis.stopLoss) drawPriceLine(analysis.stopLoss, '#d32f2f', 'Stop Loss');
            if (analysis.takeProfit) drawPriceLine(analysis.takeProfit, '#388E3C', 'Take Profit');

            chart.timeScale().fitContent();


            loader.classList.add('loader-hidden'); //
            resultsContent.style.display = 'block'; //

        } catch (error) { //
            console.error('Analysis request failed:', error); //
            errorMessage.textContent = `Analysis failed: ${error.message}`; //
            errorMessage.classList.remove('error-hidden'); //
            loader.classList.add('loader-hidden'); //
        }
    });
});
