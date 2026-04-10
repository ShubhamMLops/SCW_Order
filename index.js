const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino   = require('pino');

const FIREBASE_URL  = process.env.FIREBASE_URL;
const GEMINI_KEY    = process.env.GEMINI_KEY;
const OLLAMA_URL    = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || 'tinyllama';
const DELIVERY_FEE  = 50;
const GST_RATE      = 0.05;

// ── Ollama AI — only for greetings & questions ───────────────────────────────
const chatHistory = {};

function addHistory(sender, role, content) {
    if (!chatHistory[sender]) chatHistory[sender] = [];
    chatHistory[sender].push({ role, content });
    if (chatHistory[sender].length > 6) chatHistory[sender].splice(0, 2);
}

async function askAI(sender, userMessage, menu) {
    // Keep menu context tiny — just names and prices
    const menuShort = menu.slice(0, 20).map(d =>
        d.portions ? `${d.name}(${d.portions.map(p=>p.name[0]+'₹'+p.price).join('/')})` : `${d.name}₹${d.price}`
    ).join(', ');

    const prompt =
        `You are ScwOrder food bot. Menu: ${menuShort}\n` +
        `Reply in 1-2 sentences. If ordering, say "just type the item name".\n` +
        `Customer: ${userMessage}\nBot:`;

    try {
        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                options: { temperature: 0.5, num_predict: 80 }
            }),
            signal: AbortSignal.timeout(8000) // 8s max
        });
        const data = await res.json();
        return data.response?.trim() || null;
    } catch (e) {
        console.log('AI timeout/error — using fallback');
        return null;
    }
}

// per-sender session
const sessions = {};

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function getMenu() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data)
            .map(k => ({ id: k, ...data[k], portions: data[k].portions || null }))
            .filter(d => !d.outOfStock); // exclude out-of-stock items
    } catch (e) { console.error('Menu fetch error:', e); return []; }
}

// ── Menu text builder ─────────────────────────────────────────────────────────

function buildMenuText(menu) {
    const grouped = {};
    menu.forEach(d => {
        const cat = (d.category || 'other').charAt(0).toUpperCase() + (d.category || 'other').slice(1);
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(d);
    });

    let txt = '*🍽 ScwOrder — Menu*\n' + '─'.repeat(30) + '\n\n';
    Object.entries(grouped).forEach(([cat, items]) => {
        txt += `*${cat.toUpperCase()}*\n`;
        items.forEach(d => {
            if (d.portions && d.portions.length) {
                const sizes = d.portions.map(p => `${p.name} ₹${p.price}`).join(' | ');
                txt += `  • *${d.name}*  ${sizes}\n`;
            } else {
                txt += `  • *${d.name}* — ₹${d.price || '—'}\n`;
            }
        });
        txt += '\n';
    });
    txt += '─'.repeat(30) + '\n';
    txt += 'Just type what you want!\n';
    txt += '_Example: cheese pizza small_\n';
    txt += '_Example: veg burger + steam veg momos_\n\n';
    txt += '_*Note:* 5% GST is applicable. Delivery charges will apply if the order value is below ₹375 or if the delivery location is beyond 3 km._';
    return txt;
}

// ── Order parser ──────────────────────────────────────────────────────────────
// Approach: tokenize user input, score each dish by how many of its name-words
// appear in the user's tokens. Pick highest score. Case-insensitive.

const SIZE_MAP = {
    's': 'Small', 'sm': 'Small', 'small': 'Small',
    'm': 'Medium', 'med': 'Medium', 'medium': 'Medium',
    'l': 'Large', 'lg': 'Large', 'large': 'Large'
};

function findBestMatch(query, menu) {
    const tokens = query.toLowerCase().split(/\s+/);

    let bestItem  = null;
    let bestScore = 0;

    for (const item of menu) {
        const nameTokens = item.name.toLowerCase().split(/\s+/);
        // Score = number of name words found in user tokens
        const score = nameTokens.filter(w => tokens.includes(w)).length;
        // Must match at least half the name words
        if (score > bestScore && score >= Math.ceil(nameTokens.length / 2)) {
            bestScore = score;
            bestItem  = item;
        }
    }

    if (!bestItem) return null;

    // Find size in tokens
    let foundPortion = null;
    if (bestItem.portions && bestItem.portions.length) {
        for (const t of tokens) {
            const sizeName = SIZE_MAP[t];
            if (sizeName) {
                foundPortion = bestItem.portions.find(
                    p => p.name.toLowerCase() === sizeName.toLowerCase()
                );
                if (foundPortion) break;
            }
            // Also match directly against portion names (e.g. "250ml")
            foundPortion = bestItem.portions.find(p => p.name.toLowerCase() === t);
            if (foundPortion) break;
        }
    }

    return {
        item: bestItem,
        portion: foundPortion,
        needsPortion: bestItem.portions && bestItem.portions.length && !foundPortion
    };
}

function parseOrder(input, menu) {
    // Split on + or "and"
    const parts = input.split(/\s*\+\s*|\s+and\s+/i).map(p => p.trim()).filter(Boolean);
    const resolved   = [];
    const unresolved = [];

    for (const part of parts) {
        const match = findBestMatch(part, menu);
        if (match) {
            resolved.push(match);
        } else {
            unresolved.push(part);
        }
    }
    return { resolved, unresolved };
}

// ── Bill calculator ───────────────────────────────────────────────────────────

function calcBill(cart) {
    const subtotal = cart.reduce((sum, e) => {
        const price = e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0);
        return sum + price;
    }, 0);
    const gst      = Math.round(subtotal * GST_RATE);
    const total    = subtotal + gst + DELIVERY_FEE;
    return { subtotal, gst, total };
}

function cartLines(cart) {
    return cart.map((e, i) => {
        const label = e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name;
        const price = e.portion ? e.portion.price : e.item.price;
        return `${i + 1}. ${label} — ₹${price}`;
    }).join('\n');
}

// ── Bot ───────────────────────────────────────────────────────────────────────

async function startBot() {
    if (!FIREBASE_URL) { console.log('ERROR: FIREBASE_URL missing!'); process.exit(1); }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['S', 'K', '1']
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', scale: 8, margin: 2 });
            const b64     = dataUrl.replace('data:image/png;base64,', '');
            console.log('\n==========================================');
            console.log('COPY lines between START/END, remove newlines,');
            console.log('paste at: https://base64.guru/converter/decode/image');
            console.log('==========================================');
            console.log('BASE64_START');
            (b64.match(/.{1,76}/g) || []).forEach(c => console.log(c));
            console.log('BASE64_END');
            console.log('==========================================\n');
        }
        if (connection === 'open')  console.log('ScwOrder AI IS ONLINE!');
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Poll every 5s for orders accepted/rejected by admin — send WhatsApp confirmation
    const sentMsgs = new Set();
    setInterval(async () => {
        try {
            const res    = await fetch(`${FIREBASE_URL}/orders.json`);
            const orders = await res.json();
            if (!orders) return;

            for (const [key, order] of Object.entries(orders)) {
                // Only process recent orders (last 24h) to avoid re-processing old ones
                const age = Date.now() - new Date(order.timestamp || 0).getTime();
                if (age > 24 * 60 * 60 * 1000) continue;

                // Build JID — waNumber is 10-digit, needs 91 prefix for India
                const rawNum = order.waNumber || order.phone || '';
                const digits = rawNum.replace(/[^0-9]/g, '');
                if (!digits || digits.length < 10) continue; // skip web orders with no valid WA number
                const fullNum = digits.startsWith('91') ? digits : '91' + digits;
                const waJid   = fullNum + '@s.whatsapp.net';

                // Accepted
                if (order.accepted === true && !order.acceptedMsgSent && !sentMsgs.has(key + '_acc')) {
                    sentMsgs.add(key + '_acc');
                    try {
                        await sock.sendMessage(waJid, {
                            text: '✅ *Your order has been accepted!*\n\nOur chef is preparing your order. We will contact you shortly for payment details.\n\nThank you for ordering from ScwOrder! 🙏'
                        });
                        await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ acceptedMsgSent: true })
                        });
                        console.log('Accepted msg sent to ' + waJid);
                    } catch (e) { console.log('Accept msg error:', e.message); }
                }
            }
        } catch (e) { console.log('Poll error:', e.message); }
    }, 5000);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender  = msg.key.remoteJid;
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '');
        const text    = rawText.toLowerCase().trim();
        const session = sessions[sender] || {};

        console.log(`[${sender.split('@')[0]}]: ${text}`);

        // ── Hard commands — always handled directly ───────────────────────────
        if (text === 'cancel') {
            delete sessions[sender];
            delete chatHistory[sender];
            await sock.sendMessage(sender, { text: '❌ Order cancelled. Type *menu* to start again.' });
            return;
        }
        if (text === 'empty' || text === 'clear' || text === 'new order') {
            delete sessions[sender];
            delete chatHistory[sender];
            await sock.sendMessage(sender, { text: '🗑️ Cart cleared! Tell me what you want to order.' });
            return;
        }
        if (/\bmenu\b/.test(text) || text === 'price' || text === 'list') {
            const menu = await getMenu();
            await sock.sendMessage(sender, { text: buildMenuText(menu) });
            addHistory(sender, 'user', rawText);
            addHistory(sender, 'assistant', '[menu sent]');
            return;
        }

        // ── AWAITING_DETAILS — collect name/phone/address ─────────────────────
        if (session.step === 'AWAITING_DETAILS') {
            const phoneMatch = rawText.match(/[6-9]\d{9}/);
            if (!phoneMatch) {
                await sock.sendMessage(sender, {
                    text: '⚠️ Please include your *10-digit phone number*.\n\nExample: _Ravi, 9876543210, 12 MG Road, Delhi_'
                });
                return;
            }
            const { cart } = session;
            const waNumber = sender.split('@')[0];
            const { subtotal, gst, total } = calcBill(cart);
            const orderItems = cart.map(e => ({
                id: e.item.id,
                name: e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name,
                price: e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0),
                img: (e.item.imageUrl && e.item.imageUrl.startsWith('http')) ? e.item.imageUrl : '',
                quantity: 1,
                portion: e.portion ? e.portion.name : null
            }));
            const order = {
                userId: 'whatsapp_' + waNumber, userEmail: 'whatsapp@ScwOrder.com',
                phone: phoneMatch[0], waNumber, address: rawText,
                location: { lat: 0, lng: 0 }, items: orderItems,
                subtotal: subtotal.toFixed(2), gst: gst.toFixed(2),
                deliveryFee: DELIVERY_FEE, total: total.toFixed(2),
                status: 'Placed', method: 'WhatsApp Order',
                timestamp: new Date().toISOString()
            };
            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(order)
                });
            } catch (e) { console.log('Firebase Error:', e); }

            delete sessions[sender];
            delete chatHistory[sender];
            await sock.sendMessage(sender, {
                text: `✅ *Order Placed!*\n\n*Items:*\n${cartLines(cart)}\n\nSubtotal: ₹${subtotal}\n\n` +
                      `📍 ${rawText}\n\n_Our chef will contact you shortly for payment. Final amount with QR code will be shared._\n\nThank you! 🙏`
            });
            return;
        }

        // ── AWAITING_PORTION — numbered size selection ────────────────────────
        if (session.step === 'AWAITING_PORTION') {
            const { pendingItem, cart } = session;
            const choice = parseInt(text);
            const portions = pendingItem.portions;
            if (isNaN(choice) || choice < 1 || choice > portions.length) {
                const opts = portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `Please reply with a number 1–${portions.length}:\n\n${opts}` });
                return;
            }
            const portion = portions[choice - 1];
            cart.push({ item: pendingItem, portion });
            const next = session.pendingItems?.shift();
            if (next) {
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: next, pendingItems: session.pendingItems, cart };
                const opts = next.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `✅ Added! Which size for *${next.name}*?\n\n${opts}` });
            } else {
                sessions[sender] = { step: 'AWAITING_DETAILS', cart };
                const { subtotal } = calcBill(cart);
                await sock.sendMessage(sender, {
                    text: `✅ Added!\n\n*Your Order:*\n${cartLines(cart)}\n\nSubtotal: ₹${subtotal}\n\n` +
                          `Please reply with your *Name, Phone Number & Address*.\n_Type *add* to add more | *cancel* to cancel_`
                });
            }
            return;
        }

        // ── Rule-based order matching (fast, reliable) ────────────────────────
        const menu = await getMenu();
        const { resolved, unresolved } = parseOrder(text, menu);

        if (resolved.length) {
            const existingCart = session.cart || [];
            const needsPortion = resolved.filter(e => e.needsPortion);
            const readyItems   = resolved.filter(e => !e.needsPortion);
            const cart         = [...existingCart, ...readyItems];
            const warnMsg      = unresolved.length ? `\n\n⚠️ Could not find: _${unresolved.join(', ')}_` : '';

            if (needsPortion.length) {
                const first = needsPortion.shift();
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: first.item, pendingItems: needsPortion.map(e => e.item), cart };
                const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `Which size for *${first.item.name}*?\n\n${opts}${warnMsg}` });
            } else {
                sessions[sender] = { step: 'AWAITING_DETAILS', cart };
                const { subtotal } = calcBill(cart);
                await sock.sendMessage(sender, {
                    text: `🛒 *Order Summary:*\n${cartLines(cart)}\n\nSubtotal: ₹${subtotal}\n\n` +
                          `_+5% GST applicable._\n\nPlease reply with your *Name, Phone Number & Address*\n` +
                          `_Type *add* to add more | *empty* to clear | *cancel* to cancel_${warnMsg}`
                });
            }
            return;
        }

        // ── AI fallback — only for questions/greetings (non-order messages) ───
        if (OLLAMA_URL && OLLAMA_MODEL) {
            const aiReply = await askAI(sender, rawText, menu);
            if (aiReply) {
                await sock.sendMessage(sender, { text: aiReply });
                return;
            }
        }

        // ── Final fallback ────────────────────────────────────────────────────
        await sock.sendMessage(sender, {
            text: `Type *menu* to see our full menu, then tell me what you want!\n_Example: cheese pizza small_\n_Example: veg burger + momos_`
        });
    });
}

startBot().catch(err => console.log('Error:', err));
