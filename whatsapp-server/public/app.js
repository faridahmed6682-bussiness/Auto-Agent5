'use strict';

const pairForm = document.getElementById('pairForm');
const userIdInput = document.getElementById('userIdInput');
const phoneInput = document.getElementById('phoneInput');
const pairBtn = document.getElementById('pairBtn');
const feedbackText = document.getElementById('feedbackText');
const statusBadge = document.getElementById('statusBadge');
const codeSection = document.getElementById('codeSection');
const pairingCodeValue = document.getElementById('pairingCodeValue');
const copyBtn = document.getElementById('copyBtn');
const connectedBox = document.getElementById('connectedBox');
const connectedDetail = document.getElementById('connectedDetail');
const disconnectBtn = document.getElementById('disconnectBtn');

let pollTimer = null;

function setFeedback(msg) {
    if (!msg) {
        feedbackText.hidden = true;
        feedbackText.textContent = '';
        return;
    }
    feedbackText.textContent = msg;
    feedbackText.hidden = false;
}

function updateStatusUI(status, data = {}) {
    statusBadge.classList.remove('badge-connected', 'badge-pairing', 'badge-disconnected');
    if (status === 'connected') {
        statusBadge.textContent = 'Connected ✅';
        statusBadge.classList.add('badge-connected');
        codeSection.hidden = true;
        connectedBox.hidden = false;
        const phone = data.phoneNumber || 'WhatsApp Linked';
        const replies = Number(data.totalRepliesSent || 0);
        connectedDetail.textContent = `Number: ${phone} • AI Replies Sent: ${replies}`;
        stopPolling();
    } else if (status === 'pairing') {
        statusBadge.textContent = 'Pairing...';
        statusBadge.classList.add('badge-pairing');
        connectedBox.hidden = true;
    } else {
        statusBadge.textContent = 'Disconnected';
        statusBadge.classList.add('badge-disconnected');
        connectedBox.hidden = true;
    }
}

async function pollStatusOnce() {
    const userId = userIdInput.value.trim();
    if (!userId) return;
    try {
        const resp = await fetch(`/api/whatsapp/status/${encodeURIComponent(userId)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        updateStatusUI(data.status, data);
    } catch (_) {
        // Ignore transient poll errors
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollStatusOnce, 2500);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

pairForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('');
    const userId = userIdInput.value.trim() || 'tappilot_main';
    const phoneNumber = phoneInput.value.replace(/\D/g, '');
    if (phoneNumber.length < 10) {
        setFeedback('Enter a valid WhatsApp number with country code (e.g. 88017XXXXXXXX).');
        return;
    }

    pairBtn.disabled = true;
    pairBtn.textContent = 'Generating Pairing Code...';
    try {
        const resp = await fetch('/api/whatsapp/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, phoneNumber })
        });
        const data = await resp.json();
        if (!resp.ok) {
            setFeedback(data.error || 'Failed to get pairing code.');
            return;
        }

        updateStatusUI(data.status, data);
        if (data.pairingCode) {
            pairingCodeValue.textContent = data.pairingCode;
            codeSection.hidden = false;
            startPolling();
        } else if (data.status === 'pairing') {
            startPolling();
        }
    } catch (err) {
        setFeedback(err.message || 'Network error while connecting to backend.');
    } finally {
        pairBtn.disabled = false;
        pairBtn.textContent = 'Connect WhatsApp / Get Pairing Code';
    }
});

copyBtn.addEventListener('click', async () => {
    const code = pairingCodeValue.textContent.trim();
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
            copyBtn.textContent = 'Copy Code';
        }, 2000);
    } catch (_) {
        setFeedback('Could not copy automatically — please select and copy the code.');
    }
});

disconnectBtn.addEventListener('click', async () => {
    const userId = userIdInput.value.trim() || 'tappilot_main';
    try {
        await fetch('/api/whatsapp/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId })
        });
        updateStatusUI('disconnected');
        setFeedback('WhatsApp disconnected cleanly.');
    } catch (err) {
        setFeedback(err.message || 'Disconnect failed.');
    }
});

pollStatusOnce();
