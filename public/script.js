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

    /**
     * Shows a custom message box instead of a standard browser alert.
     * @param {string} message The message to display.
     * @param {string} type The type of message ('error', 'warning', 'info').
     */
    function showMessageBox(message, type = 'error') {
        // Remove any existing message boxes first
        const existingBox = document.querySelector('.message-box');
        if (existingBox) {
            existingBox.remove();
        }

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
    }

    /**
     * Fetches the list of active symbols from the Deriv API and populates the asset dropdown.
     */
    function loadAssets() {
        // Provide immediate feedback to the user that assets are loading
        assetSelect.innerHTML = '<option value="">Loading assets...</option>';
        assetSelect.disabled = true;

        const derivSocket = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        derivSocket.onopen = function(e) {
            // Connection is open, now we can send our request for symbols
            derivSocket.send(JSON.stringify({
                active_symbols: "brief",
                product_type: "basic"
            }));
        };

        derivSocket.onmessage = function(msg) {
            try {
                const data = JSON.parse(msg.data);

                // It's good practice to check for errors sent by the API
                if (data.error) {
                    console.error('Deriv API error:', data.error.message);
                    showMessageBox(`Failed to load assets: ${data.error.message}`, 'error');
                    assetSelect.innerHTML = '<option value="">Error loading assets</option>';
                    derivSocket.close(); // Close connection on error
                    return;
                }

                // We are only interested in the message that contains our active symbols
                if (data.msg_type === 'active_symbols') {
                    const activeSymbols = data.active_symbols;
                    
                    // Filter for the markets we are interested in
                    const filteredSymbols = activeSymbols.filter(s =>
                        s.market === 'forex' || s.market === 'indices' || s.market === 'synthetic_index'
                    );

                    // Sort symbols alphabetically for better user experience
                    filteredSymbols.sort((a, b) => a.display_name.localeCompare(b.display_name));

                    if (filteredSymbols.length > 0) {
                        // Add a disabled, selected default option
                        assetSelect.innerHTML = '<option value="" disabled selected>Select an Asset</option>';
                        filteredSymbols.forEach(symbol => {
                            const option = document.createElement('option');
                            option.value = symbol.symbol;
                            option.textContent = symbol.display_name;
                            assetSelect.appendChild(option);
                        });
                    } else {
                        assetSelect.innerHTML = '<option value="">No assets found</option>';
                    }

                    assetSelect.disabled = false;
                    derivSocket.close(); // We have what we need, close the connection
                }
                // Other message types from the websocket are ignored
            } catch (error) {
                console.error("Failed to parse WebSocket message:", error);
                showMessageBox("An unexpected error occurred while loading assets.", 'error');
                assetSelect.innerHTML = '<option value="">Error processing data</option>';
                derivSocket.close();
            }
        };

        derivSocket.onerror = function(err) {
            console.error('WebSocket Error:', err);
            assetSelect.innerHTML = `<option value="">Failed to connect</option>`;
            showMessageBox('Failed to connect to Deriv for assets. Please check your internet connection and try again.', 'error');
            assetSelect.disabled = false;
        };
    }

    // Initial call to load assets when the page is ready
    loadAssets();

    // Handle "Analyze" button click - This logic remains the same
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

            // Display results
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
    
