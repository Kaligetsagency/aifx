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

    const entryPointEl = document.getElementById('entry-point');
    const stopLossEl = document.getElementById('stop-loss');
    const takeProfitEl = document.getElementById('take-profit');

    const derivSocket = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    // Function to show a custom message box instead of alert()
    function showMessageBox(message, type = 'error') {
        const messageBox = document.createElement('div');
        messageBox.className = `message-box ${type}`;
        messageBox.innerHTML = `
            <p>${message}</p>
            <button class="message-box-close">OK</button>
        `;
        document.body.appendChild(messageBox);

        messageBox.querySelector('.message-box-close').addEventListener('click', () => {
            messageBox.remove();
        });

        // Automatically remove after a few seconds for non-critical messages
        if (type !== 'error') {
            setTimeout(() => {
                messageBox.remove();
            }, 3000);
        }
    }

    // 1. Populate asset dropdown on page load
    derivSocket.onopen = function(e) {
        derivSocket.send(JSON.stringify({
            active_symbols: "brief",
            product_type: "basic"
        }));
    };

    derivSocket.onmessage = function(msg) {
        const data = JSON.parse(msg.data);

        if (data.error) {
            console.error('Deriv API error:', data.error.message);
            assetSelect.innerHTML = `<option value="">Error loading assets</option>`;
            showMessageBox(`Failed to load assets: ${data.error.message}`, 'error');
            return;
        }

        if (data.active_symbols) {
            const activeSymbols = data.active_symbols;
            assetSelect.innerHTML = ''; // Clear loading message

            // Filter for forex and indices for this example, you can expand this
            const filteredSymbols = activeSymbols.filter(s =>
                s.market === 'forex' || s.market === 'indices' || s.market === 'synthetic_index' // Added synthetic indices
            );

            // Sort symbols alphabetically by display name
            filteredSymbols.sort((a, b) => a.display_name.localeCompare(b.display_name));


            filteredSymbols.forEach(symbol => {
                const option = document.createElement('option');
                option.value = symbol.symbol;
                option.textContent = symbol.display_name;
                assetSelect.appendChild(option);
            });
            derivSocket.close(); // Close connection after getting symbols
        }
    };

    derivSocket.onerror = function(err) {
        console.error('WebSocket Error:', err);
        assetSelect.innerHTML = `<option value="">Failed to connect</option>`;
        showMessageBox('Failed to connect to Deriv WebSocket for assets.', 'error');
    };

    // 2. Handle "Analyze" button click
    analyzeBtn.addEventListener('click', async () => {
        const selectedAsset = assetSelect.value;
        const selectedTimeframe = timeframeSelect.value;

        if (!selectedAsset) {
            showMessageBox('Please select an asset before analyzing.', 'warning');
            return;
        }

        // Show loader and hide previous results/errors
        resultsContainer.classList.remove('results-hidden');
        resultsContent.style.display = 'none';
        loader.classList.remove('loader-hidden');
        errorMessage.classList.add('error-hidden');
        errorMessage.textContent = '';


        try {
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    asset: selectedAsset,
                    timeframe: selectedTimeframe
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || `HTTP error! Status: ${response.status}`);
            }

            // 3. Display results
            entryPointEl.textContent = result.entryPoint ? parseFloat(result.entryPoint).toFixed(4) : 'N/A';
            stopLossEl.textContent = result.stopLoss ? parseFloat(result.stopLoss).toFixed(4) : 'N/A';
            takeProfitEl.textContent = result.takeProfit ? parseFloat(result.takeProfit).toFixed(4) : 'N/A';

            // Hide loader and show content
            loader.classList.add('loader-hidden');
            resultsContent.style.display = 'block';

        } catch (error) {
            console.error('Analysis request failed:', error);
            // Display error message
            errorMessage.textContent = `Analysis failed: ${error.message}`;
            errorMessage.classList.remove('error-hidden');
            loader.classList.add('loader-hidden');
        }
    });
});
