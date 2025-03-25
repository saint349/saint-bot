const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const moment = require('moment');
const { exec } = require('child_process');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 4000;
const openai = new OpenAI({ apiKey: "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" });

let botInstance = null;
let reconnectTimeout = null;
let qrGenerated = false;
const autoReplies = {
    "hello": "Hey there! How can I assist you today?",
    "help": "Here are some commands: !help, !ask, !ping, !sticker, !download, !order, !status",
    "order": "Please provide your order details."
};

async function startBot() {
    if (botInstance) {
        console.log("⚠️ Bot is already running! Preventing duplicate instance.");
        return;
    }

    console.log("🚀 Starting bot...");

    if (!fs.existsSync('auth')) fs.mkdirSync('auth');

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const authFileExists = fs.existsSync('auth/creds.json');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: !authFileExists && !qrGenerated,
        defaultQueryTimeoutMs: 60000
    });

    botInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (connection === 'close') {
            botInstance = null;
            qrGenerated = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`❌ Disconnected! Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => startBot(), 10000);
            } else {
                console.log("🔴 Logged out! Delete 'auth' folder and restart the bot.");
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log("✅ Bot is connected successfully!");
            sock.sendPresenceUpdate('unavailable');
        }

        if (qr && !authFileExists && !qrGenerated) {
            console.log("📸 Scan the QR Code above to connect.");
            qrGenerated = true;
        }
    });

    sock.ev.on('presence.update', async ({ id }) => {
        await sock.sendPresenceUpdate('unavailable', id);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const sender = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (autoReplies[textMessage.toLowerCase()]) {
            await sock.sendMessage(sender, { text: autoReplies[textMessage.toLowerCase()] });
        }

        if (textMessage.startsWith('!ask')) {
            let question = textMessage.replace('!ask', '').trim();
            try {
                let response = await openai.chat.completions.create({
                    model: "gpt-4",
                    messages: [{ role: "user", content: question }]
                });
                await sock.sendMessage(sender, { text: response.choices[0].message.content });
            } catch (error) {
                console.error("❌ OpenAI Error:", error);
                await sock.sendMessage(sender, { text: "Error retrieving response. Try again later." });
            }
        }

        if (msg.message.viewOnceMessage) {
            msg.message = msg.message.viewOnceMessage.message;
            await sock.sendMessage(sender, { forward: msg }, { quoted: msg });
        }

        if (msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
            await sock.sendMessage(sender, { text: "⚠️ Someone deleted a message!" });
        }

        if (textMessage.startsWith('!status')) {
            await sock.sendMessage(sender, { text: "Auto-viewing all statuses..." });
            let statuses = await sock.fetchStatusUpdates();
            statuses.forEach(status => sock.viewStatus(status.id));
        }

        if (textMessage.startsWith('!order')) {
            await sock.sendMessage(sender, { text: "Please provide your order details." });
        }
    });
}

app.get('/restart', (req, res) => {
    console.log("🔄 Restarting bot...");
    process.exit(1);
});

app.get('/logout/:deviceId', (req, res) => {
    const deviceId = req.params.deviceId;
    const authFilePath = `auth/${deviceId}.json`;

    if (fs.existsSync(authFilePath)) {
        fs.unlinkSync(authFilePath);
        res.send(`✅ Device ${deviceId} logged out successfully`);
    } else {
        res.send(`⚠️ Device ${deviceId} not found`);
    }
});

app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));

startBot();
