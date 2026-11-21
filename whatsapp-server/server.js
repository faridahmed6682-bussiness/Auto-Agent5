'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_SECRET = (process.env.BRIDGE_SECRET || '').trim();
const SESSIONS_ROOT = path.resolve(__dirname, 'sessions');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Active sockets & runtime state keyed by sanitized userId
const sessions = new Map();
// User-specific AI configs synced from TapPilot Android app
const userConfigs = new Map();
// Recent message ID deduplication cache (prevents duplicate replies on socket reconnect)
const processedMessages = new Map();

function sanitizeUserId(raw) {
    const clean = String(raw || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(clean)) return null;
    return clean;
}

function getSessionDir(userId) {
    const resolved = path.resolve(SESSIONS_ROOT, userId);
    if (!resolved.startsWith(SESSIONS_ROOT + path.sep)) {
        throw new Error('Invalid session path.');
    }
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
}

function cleanDigitsPhone(raw) {
    return String(raw || '').replace(/\D/g, '');
}

function verifyBridgeSecret(req, res, next) {
    if (!BRIDGE_SECRET) return next();
    const incoming = String(req.header('X-Bridge-Secret') || '').trim();
    const a = Buffer.from(incoming, 'utf8');
    const b = Buffer.from(BRIDGE_SECRET, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Unauthorized: invalid X-Bridge-Secret header.' });
    }
    return next();
}

function getOrDefaultConfig(userId) {
    if (!userConfigs.has(userId)) {
        userConfigs.set(userId, {
            autoReplyEnabled: true,
            systemPrompt:
                'তুমি একজন ভদ্র ও সহায়ক AI সহকারী। কাস্টমার বা বন্ধুর সাথে প্রাসঙ্গিক, সংক্ষিপ্ত ও স্বাভাবিক বাংলা/Banglish-এ কথা বলো।',
            contacts: [],
            totalRepliesSent: 0,
            recentReplies: []
        });
    }
    return userConfigs.get(userId);
}

function wasRecentlyProcessed(messageId) {
    const now = Date.now();
    for (const [key, ts] of processedMessages.entries()) {
        if (now - ts > 5 * 60 * 1000) processedMessages.delete(key);
    }
    if (!messageId) return false;
    if (processedMessages.has(messageId)) return true;
    processedMessages.set(messageId, now);
    return false;
}

function extractIncomingText(msg) {
    const content = msg?.message;
    if (!content) return '';
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.buttonsResponseMessage?.selectedDisplayText ||
        content.listResponseMessage?.title ||
        ''
    ).trim();
}

/**
 * Modular AI Agent hook:
 * Automatically uses OPENROUTER_API_KEY or GEMINI_API_KEY from environment variables if present,
 * enriches context with TapPilot's synced Relationship Contacts, or uses a polite fallback.
 */
async function runAIAgent({ userId, sender, pushName, text }) {
    const cfg = getOrDefaultConfig(userId);
    const senderDigits = sender.split('@')[0] || '';
    const displayName = (pushName || senderDigits || 'Friend').trim();

    // Match Relationship Contact synced from TapPilot Android app
    const matchedContact = (cfg.contacts || []).find((c) => {
        const contactName = String(c.name || '').trim().toLowerCase();
        if (!contactName) return false;
        return (
            displayName.toLowerCase().includes(contactName) ||
            senderDigits.includes(contactName)
        );
    });

    const relationshipHint = matchedContact
        ? `\nMatched Contact: ${matchedContact.name} | Relationship: ${matchedContact.relationship} | Custom Note: ${matchedContact.styleNote || 'Normal friendly tone'}`
        : '';

    const systemInstruction = `${cfg.systemPrompt}${relationshipHint}`;

    // Option 1: OpenRouter AI (set OPENROUTER_API_KEY env var)
    const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
    if (openRouterKey) {
        try {
            const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${openRouterKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
                    messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: `Sender (${displayName}): ${text}` }
                    ],
                    max_tokens: 240,
                    temperature: 0.6
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                const aiText = data?.choices?.[0]?.message?.content?.trim();
                if (aiText) return aiText;
            }
        } catch (err) {
            console.error('[OpenRouter AI Error]', err.message);
        }
    }

    // Option 2: Google Gemini API (set GEMINI_API_KEY env var)
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (geminiKey) {
        try {
            const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        contents: [{ role: 'user', parts: [{ text: `Sender (${displayName}): ${text}` }] }],
                        generationConfig: { maxOutputTokens: 240, temperature: 0.6 }
                    })
                }
            );
            if (resp.ok) {
                const data = await resp.json();
                const aiText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (aiText) return aiText;
            }
        } catch (err) {
            console.error('[Gemini AI Error]', err.message);
        }
    }

    // Safe default polite reply if no cloud LLM key is configured yet on the server
    if (matchedContact) {
        return `হ্যালো ${matchedContact.name}! আপনার মেসেজটি পেয়েছি। একটু পর বিস্তারিত জানাচ্ছি।`;
    }
    return `আসসালামু আলাইকুম ${displayName}! আপনার মেসেজটি পেয়েছি। এখন একটু ব্যস্ত আছি, কিছুক্ষণের মধ্যেই উত্তর দিচ্ছি।`;
}

async function createBaileysSession(userId, phoneNumberDigits = '') {
    const existing = sessions.get(userId);
    if (existing?.sock && existing.status === 'connected') {
        return existing;
    }

    // Close previous stale socket safely if re-initializing
    if (existing?.sock) {
        try {
            existing.sock.end(undefined);
        } catch (_) {}
    }

    const sessionDir = getSessionDir(userId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sessionRecord = {
        userId,
        sock: null,
        status: 'pairing',
        phoneNumber: phoneNumberDigits || existing?.phoneNumber || '',
        pairingCode: '',
        reconnectTimer: null
    };
    sessions.set(userId, sessionRecord);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true
    });
    sessionRecord.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            sessionRecord.status = 'connected';
            sessionRecord.pairingCode = '';
            const rawJid = sock.user?.id || '';
            const linkedDigits = rawJid.split(':')[0].split('@')[0];
            if (linkedDigits) sessionRecord.phoneNumber = linkedDigits;
            console.log(`[WhatsApp][${userId}] Connected ✅ (${sessionRecord.phoneNumber})`);
        } else if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log(`[WhatsApp][${userId}] Connection closed (code=${statusCode}, loggedOut=${loggedOut})`);

            if (loggedOut) {
                sessionRecord.status = 'disconnected';
                sessionRecord.pairingCode = '';
                fs.rmSync(sessionDir, { recursive: true, force: true });
                sessions.delete(userId);
            } else {
                sessionRecord.status = state.creds.registered ? 'disconnected' : 'pairing';
                clearTimeout(sessionRecord.reconnectTimer);
                sessionRecord.reconnectTimer = setTimeout(() => {
                    createBaileysSession(userId, sessionRecord.phoneNumber).catch((err) =>
                        console.error(`[WhatsApp][${userId}] Reconnect failed:`, err.message)
                    );
                }, 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const cfg = getOrDefaultConfig(userId);
        if (!cfg.autoReplyEnabled) return;

        for (const msg of messages) {
            try {
                if (!msg?.message) continue;
                if (msg.key?.fromMe) continue;
                const sender = msg.key?.remoteJid || '';
                if (!sender || sender === 'status@broadcast' || sender.endsWith('@g.us')) continue;
                if (wasRecentlyProcessed(msg.key?.id)) continue;

                const text = extractIncomingText(msg);
                if (!text) continue;

                const reply = await runAIAgent({
                    userId,
                    sender,
                    pushName: msg.pushName || '',
                    text
                });
                if (!reply) continue;

                await sock.sendMessage(sender, { text: reply }, { quoted: msg });
                cfg.totalRepliesSent += 1;
                cfg.recentReplies = [
                    `${msg.pushName || sender.split('@')[0]}: ${reply.slice(0, 70)}`,
                    ...cfg.recentReplies
                ].slice(0, 15);
            } catch (err) {
                console.error(`[WhatsApp][${userId}] Auto-reply error:`, err.message);
            }
        }
    });

    // Request 8-digit pairing code if not yet registered
    if (!state.creds.registered && phoneNumberDigits) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (typeof sock.requestPairingCode === 'function') {
            const code = await sock.requestPairingCode(phoneNumberDigits);
            sessionRecord.pairingCode = code;
            sessionRecord.status = 'pairing';
        }
    } else if (state.creds.registered) {
        sessionRecord.status = 'connected';
    }

    return sessionRecord;
}

// POST /api/whatsapp/pair
app.post('/api/whatsapp/pair', verifyBridgeSecret, async (req, res) => {
    try {
        const userId = sanitizeUserId(req.body?.userId || 'tappilot_main');
        if (!userId) {
            return res.status(400).json({ error: 'Invalid userId (use letters, digits, _ or -).' });
        }
        const cleanNumber = cleanDigitsPhone(req.body?.phoneNumber);
        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            return res.status(400).json({ error: 'Valid phoneNumber with country code is required (e.g. 88017XXXXXXXX).' });
        }

        const record = await createBaileysSession(userId, cleanNumber);
        return res.json({
            userId,
            status: record.status,
            pairingCode: record.pairingCode || '',
            message:
                record.status === 'connected'
                    ? 'WhatsApp is already connected.'
                    : 'Pairing code ready. Enter it in WhatsApp > Linked Devices.'
        });
    } catch (err) {
        console.error('[POST /api/whatsapp/pair]', err);
        return res.status(500).json({ error: err.message || 'Failed to generate pairing code.' });
    }
});

// GET /api/whatsapp/status/:userId
app.get('/api/whatsapp/status/:userId', verifyBridgeSecret, (req, res) => {
    const userId = sanitizeUserId(req.params.userId);
    if (!userId) {
        return res.status(400).json({ error: 'Invalid userId.' });
    }
    const record = sessions.get(userId);
    const cfg = getOrDefaultConfig(userId);
    return res.json({
        userId,
        status: record?.status || 'disconnected',
        phoneNumber: record?.phoneNumber || '',
        autoReplyEnabled: cfg.autoReplyEnabled,
        totalRepliesSent: cfg.totalRepliesSent,
        recentReplies: cfg.recentReplies
    });
});

// POST /api/whatsapp/config (synced from TapPilot Android app)
app.post('/api/whatsapp/config', verifyBridgeSecret, (req, res) => {
    const userId = sanitizeUserId(req.body?.userId || 'tappilot_main');
    if (!userId) {
        return res.status(400).json({ error: 'Invalid userId.' });
    }
    const cfg = getOrDefaultConfig(userId);
    if (typeof req.body?.autoReplyEnabled === 'boolean') {
        cfg.autoReplyEnabled = req.body.autoReplyEnabled;
    }
    if (typeof req.body?.systemPrompt === 'string' && req.body.systemPrompt.trim()) {
        cfg.systemPrompt = req.body.systemPrompt.trim().slice(0, 1500);
    }
    if (Array.isArray(req.body?.contacts)) {
        cfg.contacts = req.body.contacts.slice(0, 100).map((c) => ({
            name: String(c?.name || '').slice(0, 80),
            relationship: String(c?.relationship || '').slice(0, 60),
            styleNote: String(c?.styleNote || '').slice(0, 240)
        }));
    }
    return res.json({ ok: true, userId, autoReplyEnabled: cfg.autoReplyEnabled });
});

// POST /api/whatsapp/disconnect
app.post('/api/whatsapp/disconnect', verifyBridgeSecret, async (req, res) => {
    const userId = sanitizeUserId(req.body?.userId || 'tappilot_main');
    if (!userId) {
        return res.status(400).json({ error: 'Invalid userId.' });
    }
    const record = sessions.get(userId);
    if (record) {
        clearTimeout(record.reconnectTimer);
        try {
            await record.sock?.logout();
        } catch (_) {}
        try {
            record.sock?.end(undefined);
        } catch (_) {}
        sessions.delete(userId);
    }
    const sessionDir = getSessionDir(userId);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    return res.json({ ok: true, status: 'disconnected' });
});

app.listen(PORT, () => {
    console.log(`TapPilot WhatsApp Baileys Server listening on port ${PORT}`);
    if (!BRIDGE_SECRET) {
        console.log('Tip: Set BRIDGE_SECRET env var in production to protect /api/whatsapp/* routes.');
    }
});
