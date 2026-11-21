'use strict';

const store = require('../db/connectorsStore');
const googleService = require('./googleService');

/**
 * Dynamically inspects the unified connectors store and returns the enabled AI tools
 * for the given userId.
 */
function getUserTools(userId) {
    const records = store.listConnectorsByUser(userId);
    const byProvider = new Map(records.map((r) => [r.provider, r]));

    const tools = [];
    const google = byProvider.get('google');
    if (google?.is_connected) {
        const scopes = google.scopes_or_meta?.scopes || [];
        const hasGmail = scopes.length === 0 || scopes.some((s) => s.includes('gmail'));
        const hasCal = scopes.length === 0 || scopes.some((s) => s.includes('calendar'));
        const hasDrive = scopes.length === 0 || scopes.some((s) => s.includes('drive'));

        if (hasGmail) {
            tools.push({
                id: 'gmail_read_summary',
                provider: 'google',
                label: 'Gmail Read & AI Summary',
                autoEnabled: Boolean(google.automation_rules?.gmailAutoReply)
            });
            tools.push({
                id: 'gmail_draft_reply',
                provider: 'google',
                label: `Gmail Auto-${google.automation_rules?.gmailReplyMode === 'send' ? 'Send' : 'Draft'}`,
                autoEnabled: Boolean(google.automation_rules?.gmailAutoReply)
            });
        }
        if (hasCal) {
            tools.push({
                id: 'calendar_schedule',
                provider: 'google',
                label: 'Google Calendar Check & Booking',
                autoEnabled: Boolean(google.automation_rules?.calendarAssist)
            });
        }
        if (hasDrive) {
            tools.push({
                id: 'drive_search',
                provider: 'google',
                label: 'Google Drive File Lookup',
                autoEnabled: true
            });
        }
    }

    const whatsapp = byProvider.get('whatsapp');
    if (whatsapp?.is_connected) {
        tools.push({
            id: 'whatsapp_auto_reply',
            provider: 'whatsapp',
            label: 'WhatsApp 24/7 AI Auto-Reply',
            autoEnabled: Boolean(whatsapp.automation_rules?.whatsappAutoReply)
        });
    }

    const telegram = byProvider.get('telegram');
    if (telegram?.is_connected) {
        tools.push({
            id: 'telegram_notify',
            provider: 'telegram',
            label: 'Telegram Bot Alert & Forward',
            autoEnabled: true
        });
    }

    const webhook = byProvider.get('webhook');
    if (webhook?.is_connected) {
        tools.push({
            id: 'custom_webhook',
            provider: 'webhook',
            label: 'Custom Automation Webhook',
            autoEnabled: true
        });
    }

    return tools;
}

async function callLLM(systemInstruction, userPrompt) {
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
                        { role: 'user', content: userPrompt }
                    ],
                    max_tokens: 360,
                    temperature: 0.5
                })
            });
            if (resp.ok) {
                const data = await resp.json();
                const content = data?.choices?.[0]?.message?.content?.trim();
                if (content) return content;
            }
        } catch (err) {
            console.error('[OpenRouter Error]', err.message);
        }
    }

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
                        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                        generationConfig: { maxOutputTokens: 360, temperature: 0.5 }
                    })
                }
            );
            if (resp.ok) {
                const data = await resp.json();
                const content = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (content) return content;
            }
        } catch (err) {
            console.error('[Gemini Error]', err.message);
        }
    }

    return null;
}

/**
 * Runs Smart Assistant or WhatsApp-to-Google combo automation using the user's connected tools.
 */
async function runUnifiedAssistant({ userId, message, channel = 'assistant', extraContext = '' }) {
    const tools = getUserTools(userId);
    const hasCal = tools.some((t) => t.id === 'calendar_schedule');
    const hasGmail = tools.some((t) => t.id === 'gmail_read_summary');
    const hasDrive = tools.some((t) => t.id === 'drive_search');

    const gatheredContext = [];
    const toolsUsed = [];
    const textLower = String(message || '').toLowerCase();

    if (
        hasCal &&
        /(meeting|schedule|calendar|free|time|busy|মিটিং|সময়|ক্যালেন্ডার|কখন|ফ্রি)/i.test(textLower)
    ) {
        try {
            const events = await googleService.listUpcomingEvents(userId, 5);
            toolsUsed.push('calendar_schedule');
            gatheredContext.push(
                events.length
                    ? `Upcoming Google Calendar Events:\n${events.map((e) => `- ${e.summary} (${e.start})`).join('\n')}`
                    : 'Upcoming Google Calendar Events: No upcoming meetings scheduled.'
            );
        } catch (err) {
            gatheredContext.push(`Calendar check note: ${err.message}`);
        }
    }

    if (
        hasGmail &&
        /(email|gmail|mail|inbox|ইমেইল|মেইল|ইনবক্স)/i.test(textLower)
    ) {
        try {
            const emails = await googleService.listRecentEmails(userId, 4);
            toolsUsed.push('gmail_read_summary');
            gatheredContext.push(
                emails.length
                    ? `Recent Gmail Inbox:\n${emails.map((m) => `- From: ${m.from} | Subject: ${m.subject} | Snippet: ${m.snippet}`).join('\n')}`
                    : 'Recent Gmail Inbox: No unread/recent inbox messages.'
            );
        } catch (err) {
            gatheredContext.push(`Gmail check note: ${err.message}`);
        }
    }

    if (
        hasDrive &&
        /(drive|file|doc|sheet|pdf|ফাইল|ড্রাইভ)/i.test(textLower)
    ) {
        try {
            const files = await googleService.searchDriveFiles(userId, '');
            toolsUsed.push('drive_search');
            gatheredContext.push(
                files.length
                    ? `Recent Google Drive Files:\n${files.map((f) => `- ${f.name} (${f.mimeType})`).join('\n')}`
                    : 'Google Drive: No matching files found.'
            );
        } catch (err) {
            gatheredContext.push(`Drive check note: ${err.message}`);
        }
    }

    const systemPrompt = [
        'You are TapPilot Unified AI Assistant.',
        `Enabled user tools: ${tools.map((t) => t.id).join(', ') || 'none'}.`,
        'Reply naturally in the user language (Bengali/Banglish/English). Be concise, accurate, and mention real tool findings when available.',
        extraContext,
        gatheredContext.join('\n\n')
    ]
        .filter(Boolean)
        .join('\n\n');

    const aiReply = await callLLM(systemPrompt, message);
    if (aiReply) {
        return { reply: aiReply, toolsUsed, contextSummary: gatheredContext };
    }

    if (gatheredContext.length > 0) {
        return {
            reply: `আপনার কানেক্ট থাকা টুল থেকে পাওয়া তথ্য:\n\n${gatheredContext.join('\n\n')}`,
            toolsUsed,
            contextSummary: gatheredContext
        };
    }

    return {
        reply:
            channel === 'whatsapp'
                ? 'আসসালামু আলাইকুম! আপনার মেসেজটি পেয়েছি, কিছুক্ষণের মধ্যেই উত্তর দিচ্ছি।'
                : `সক্রিয় টুলগুলো (${tools.map((t) => t.label).join(', ') || 'কোনোটি কানেক্ট নেই'}): লাইভ AI রিপ্লাইয়ের জন্য সার্ভারে GEMINI_API_KEY বা OPENROUTER_API_KEY সেট করুন।`,
        toolsUsed,
        contextSummary: gatheredContext
    };
}

module.exports = {
    getUserTools,
    callLLM,
    runUnifiedAssistant
};
