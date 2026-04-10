const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino   = require('pino');

// Force stdout flush so QR appears immediately in GitHub Actions logs
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
const fs     = require('fs');
const path   = require('path');

const FIREBASE_URL  = process.env.FIREBASE_URL;
const DELIVERY_FEE  = 50;
const GST_RATE      = 0.05;
const FREE_DELIVERY = 375;
const SESSION_DIR   = 'session_data';

const sessions = {};

// ── Firebase session persistence ──────────────────────────────────────────────

async function saveSessionToFirebase() {
    if (!FIREBASE_URL) return;
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const payload = {};
        for (const file of fs.readdirSync(SESSION_DIR)) {
            const fullPath = path.join(SESSION_DIR, file);
            if (fs.statSync(fullPath).isFile())
                payload[file.replace(/\./g, '__DOT__')] = fs.readFileSync(fullPath, 'utf8');
        }
        await fetch(`${FIREBASE_URL}/wa_session.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        console.log('[Session] Saved ✓');
    } catch (e) { console.error('[Session] Save error:', e.message); }
}

async function restoreSessionFromFirebase() {
    if (!FIREBASE_URL) return;
    try {
        const res  = await fetch(`${FIREBASE_URL}/wa_session.json`);
        const data = await res.json();
        if (!data || typeof data !== 'object') { console.log('[Session] Fresh start.'); return; }
        if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
        for (const [key, value] of Object.entries(data))
            fs.writeFileSync(path.join(SESSION_DIR, key.replace(/__DOT__/g, '.')), value, 'utf8');
        console.log('[Session] Restored ✓');
    } catch (e) { console.error('[Session] Restore error:', e.message); }
}

// ── Firebase menu ─────────────────────────────────────────────────────────────

async function getMenu() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data)
            .map(k => ({ id: k, ...data[k], portions: data[k].portions || null }))
            .filter(d => !d.outOfStock);
    } catch (e) { console.error('[Menu] Fetch error:', e); return []; }
}

// ── Menu text ─────────────────────────────────────────────────────────────────

function buildMenuText(menu) {
    const grouped = {};
    menu.forEach(d => {
        const cat = (d.category || 'Other').charAt(0).toUpperCase() + (d.category || 'other').slice(1);
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(d);
    });

    let txt = '*🍽️ ScwOrder — Menu*\n' + '─'.repeat(28) + '\n\n';
    Object.entries(grouped).forEach(([cat, items]) => {
        txt += `*${cat.toUpperCase()}*\n`;
        items.forEach(d => {
            if (d.portions?.length) {
                const sizes = d.portions.map(p => `${p.name} ₹${p.price}`).join(' | ');
                txt += `  • *${d.name}* — ${sizes}\n`;
            } else {
                txt += `  • *${d.name}* — ₹${d.price || '—'}\n`;
            }
        });
        txt += '\n';
    });
    txt += '─'.repeat(28) + '\n';
    txt += '📝 *How to order:*\n';
    txt += 'Just type what you want!\n';
    txt += '_cheese pizza small_\n';
    txt += '_veg burger + momos_\n';
    txt += '_2 veg burger + cold coffee_\n\n';
    txt += '📌 *Commands:*\n';
    txt += '*cart* — view your cart\n';
    txt += '*add* — add more items\n';
    txt += '*empty* — clear cart\n';
    txt += '*cancel* — cancel order\n\n';
    txt += '_Free delivery on orders above ₹375. 5% GST applicable._';
    return txt;
}

// ── Fuzzy matcher (Levenshtein for typo tolerance) ────────────────────────────

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

function wordScore(queryTokens, nameTokens) {
    let score = 0;
    for (const nt of nameTokens) {
        if (queryTokens.includes(nt)) { score += 2; continue; }
        if (nt.length >= 4 && Math.min(...queryTokens.map(qt => levenshtein(qt, nt))) <= 2) score += 1;
    }
    return score;
}

const SIZE_MAP = {
    's': 'Small', 'sm': 'Small', 'small': 'Small',
    'm': 'Medium', 'med': 'Medium', 'medium': 'Medium',
    'l': 'Large',  'lg': 'Large',  'large':  'Large',
    'half': 'Half', 'full': 'Full',
    '250ml': '250ml', '500ml': '500ml', '1l': '1L', '1ltr': '1L'
};

function findBestMatch(query, menu) {
    const tokens  = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    let bestItem  = null;
    let bestScore = 0;

    for (const item of menu) {
        const nameTokens = item.name.toLowerCase().split(/\s+/);
        const score      = wordScore(tokens, nameTokens);
        if (score > bestScore && score >= Math.ceil(nameTokens.length / 2)) {
            bestScore = score;
            bestItem  = item;
        }
    }
    if (!bestItem) return null;

    let foundPortion = null;
    if (bestItem.portions?.length) {
        for (const t of tokens) {
            const sizeName = SIZE_MAP[t];
            if (sizeName) {
                foundPortion = bestItem.portions.find(p => p.name.toLowerCase() === sizeName.toLowerCase());
                if (foundPortion) break;
            }
            foundPortion = bestItem.portions.find(p => p.name.toLowerCase() === t);
            if (foundPortion) break;
        }
    }

    return {
        item: bestItem,
        portion: foundPortion,
        needsPortion: !!(bestItem.portions?.length && !foundPortion)
    };
}

// ── Quantity parser ("2 burgers", "double momos", "3x pizza") ─────────────────

const WORD_NUMS = { one:1, two:2, three:3, four:4, five:5, double:2, triple:3 };

function parseQuantityAndQuery(part) {
    const numMatch = part.match(/^(\d+)[x\s]+(.+)/i);
    if (numMatch) return { qty: parseInt(numMatch[1]), query: numMatch[2].trim() };
    for (const [word, num] of Object.entries(WORD_NUMS)) {
        const m = part.match(new RegExp(`^${word}\\s+(.+)`, 'i'));
        if (m) return { qty: num, query: m[1].trim() };
    }
    return { qty: 1, query: part.trim() };
}

function parseOrder(input, menu) {
    const parts    = input.split(/\s*\+\s*|\s+and\s+/i).map(p => p.trim()).filter(Boolean);
    const resolved = [], unresolved = [];
    for (const part of parts) {
        const { qty, query } = parseQuantityAndQuery(part);
        const match = findBestMatch(query, menu);
        if (match) for (let i = 0; i < qty; i++) resolved.push({ ...match });
        else unresolved.push(part);
    }
    return { resolved, unresolved };
}

// ── "Did you mean?" suggestions ───────────────────────────────────────────────

function getSuggestions(input, menu, limit = 3) {
    const tokens = input.toLowerCase().split(/\s+/);
    return menu
        .map(item => ({ item, score: wordScore(tokens, item.name.toLowerCase().split(/\s+/)) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.item.name);
}

// ── Bill helpers ──────────────────────────────────────────────────────────────

function calcBill(cart) {
    const subtotal = cart.reduce((s, e) =>
        s + (e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0)), 0);
    const gst      = Math.round(subtotal * GST_RATE);
    const delivery = subtotal >= FREE_DELIVERY ? 0 : DELIVERY_FEE;
    return { subtotal, gst, delivery, total: subtotal + gst + delivery };
}

function cartLines(cart) {
    const grouped = [];
    for (const e of cart) {
        const label = e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name;
        const price = e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0);
        const last  = grouped[grouped.length - 1];
        if (last && last.label === label) { last.qty++; last.price += price; }
        else grouped.push({ label, qty: 1, price });
    }
    return grouped.map((g, i) =>
        `${i + 1}. ${g.label}${g.qty > 1 ? ` ×${g.qty}` : ''} — ₹${g.price}`
    ).join('\n');
}

function billBlock(cart) {
    const { subtotal } = calcBill(cart);
    return `\n\n💰 *Bill:*\n` +
        `Subtotal : ₹${subtotal}\n\n` +
        `_Note: 5% GST applicable. Delivery charges will apply if order value is below ₹375 or delivery location is beyond 3 km._`;
}

// ── Bot ───────────────────────────────────────────────────────────────────────

async function startBot() {
    if (!FIREBASE_URL) { console.error('ERROR: FIREBASE_URL missing!'); process.exit(1); }

    await restoreSessionFromFirebase();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['ScwOrder', 'Chrome', '1.0']
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            const b64 = (await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', scale: 8, margin: 2 }))
                .replace('data:image/png;base64,', '');
            process.stdout.write('\n════════════════════════════════════\n');
            process.stdout.write('QR CODE — copy lines between START/END\n');
            process.stdout.write('Remove newlines, paste at:\n');
            process.stdout.write('https://base64.guru/converter/decode/image\n');
            process.stdout.write('════════════════════════════════════\n');
            process.stdout.write('BASE64_START\n');
            (b64.match(/.{1,76}/g) || []).forEach(l => process.stdout.write(l + '\n'));
            process.stdout.write('BASE64_END\n');
            process.stdout.write('════════════════════════════════════\n\n');
        }
        if (connection === 'open') {
            console.log('✅ ScwOrder Bot ONLINE');
            await saveSessionToFirebase();
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) startBot();
            else console.log('[Connection] Logged out. Re-scan QR.');
        }
    });

    sock.ev.on('creds.update', async () => { saveCreds(); await saveSessionToFirebase(); });

    // ── Order status poller ───────────────────────────────────────────────────
    const sentMsgs = new Set();
    setInterval(async () => {
        try {
            const orders = await (await fetch(`${FIREBASE_URL}/orders.json`)).json();
            if (!orders) return;
            for (const [key, order] of Object.entries(orders)) {
                if (Date.now() - new Date(order.timestamp || 0).getTime() > 86400000) continue;
                const digits = (order.waNumber || order.phone || '').replace(/\D/g, '');
                if (!digits || digits.length < 10) continue;
                const jid = (digits.startsWith('91') ? digits : '91' + digits) + '@s.whatsapp.net';

                if (order.accepted === true && !order.acceptedMsgSent && !sentMsgs.has(key + '_acc')) {
                    sentMsgs.add(key + '_acc');
                    await sock.sendMessage(jid, {
                        text: '✅ *Order Accepted!*\n\nYour food is being prepared 👨‍🍳\nWe\'ll share payment details shortly. Thank you! 🙏'
                    }).catch(() => {});
                    await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ acceptedMsgSent: true })
                    });
                }
                if (order.accepted === false && !order.rejectedMsgSent && !sentMsgs.has(key + '_rej')) {
                    sentMsgs.add(key + '_rej');
                    await sock.sendMessage(jid, {
                        text: '❌ *Sorry, we couldn\'t accept your order right now.*\n\nPlease try again later or type *menu* to reorder.'
                    }).catch(() => {});
                    await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rejectedMsgSent: true })
                    });
                }
            }
        } catch (e) { console.log('[Poll] Error:', e.message); }
    }, 5000);

    // ── Message handler ───────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) return;

        const sender  = msg.key.remoteJid;
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        if (!rawText) return;

        const text    = rawText.toLowerCase().trim();
        const session = sessions[sender] || {};
        const send    = t => sock.sendMessage(sender, { text: t });

        console.log(`[${sender.split('@')[0]}] ${rawText}`);

        // ── Global commands ───────────────────────────────────────────────────
        if (text === 'cancel') {
            delete sessions[sender];
            return send('❌ Order cancelled. Type *menu* to start fresh.');
        }
        if (text === 'empty' || text === 'clear') {
            delete sessions[sender];
            return send('🗑️ Cart cleared! What would you like to order?');
        }
        if (/^(menu|price|prices|list|items)$/.test(text)) {
            const menu = await getMenu();
            return send(buildMenuText(menu));
        }
        if (/^(cart|my cart|bag|order)$/.test(text)) {
            if (!session.cart?.length)
                return send('🛒 Your cart is empty.\n\nType *menu* or just tell me what you want!');
            return send(`🛒 *Your Cart:*\n${cartLines(session.cart)}${billBlock(session.cart)}\n\n_Type *add* to add more | *empty* to clear | *cancel* to cancel_`);
        }
        if ((text === 'add' || text === 'add more') && session.cart?.length) {
            sessions[sender] = { ...session, step: null };
            return send('➕ What else would you like to add?');
        }

        // ── AWAITING_DETAILS ──────────────────────────────────────────────────
        if (session.step === 'AWAITING_DETAILS') {
            const phoneMatch = rawText.match(/[6-9]\d{9}/);
            if (!phoneMatch)
                return send('⚠️ Please include your *10-digit mobile number*.\n\n_Example:_\nRavi, *9876543210*, 12 MG Road, Delhi');

            const { cart } = session;
            const waNumber = sender.split('@')[0];
            const { subtotal } = calcBill(cart);
            const orderItems = cart.map(e => ({
                id: e.item.id,
                name: e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name,
                price: e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0),
                img: e.item.imageUrl?.startsWith('http') ? e.item.imageUrl : '',
                quantity: 1,
                portion: e.portion?.name || null
            }));
            await fetch(`${FIREBASE_URL}/orders.json`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: 'whatsapp_' + waNumber, userEmail: 'whatsapp@scworder.com',
                    phone: phoneMatch[0], waNumber, address: rawText,
                    location: { lat: 0, lng: 0 }, items: orderItems,
                    subtotal: subtotal.toFixed(2),
                    status: 'Placed', method: 'WhatsApp',
                    timestamp: new Date().toISOString()
                })
            }).catch(e => console.log('[Order] Firebase error:', e.message));

            delete sessions[sender];
            return send(
                `✅ *Order Placed!*\n\n` +
                `*Items:*\n${cartLines(cart)}` +
                `${billBlock(cart)}\n\n` +
                `📍 *Address:* ${rawText}\n\n` +
                `_Our team will contact you shortly for payment. Thank you! 🙏_`
            );
        }

        // ── AWAITING_PORTION ──────────────────────────────────────────────────
        if (session.step === 'AWAITING_PORTION') {
            const { pendingItem, cart, pendingItems } = session;
            const portions = pendingItem.portions;
            const choice   = parseInt(text);
            let portion    = null;

            if (!isNaN(choice) && choice >= 1 && choice <= portions.length) {
                portion = portions[choice - 1];
            } else {
                portion = portions.find(p =>
                    p.name.toLowerCase() === text ||
                    SIZE_MAP[text]?.toLowerCase() === p.name.toLowerCase()
                );
            }
            if (!portion) {
                const opts = portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`Choose a size for *${pendingItem.name}*:\n\n${opts}\n\n_Reply with number or size name (e.g. small)_`);
            }

            cart.push({ item: pendingItem, portion });
            const next = pendingItems?.shift();
            if (next) {
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: next, pendingItems, cart };
                const opts = next.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`✅ Added! Which size for *${next.name}*?\n\n${opts}`);
            }
            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            return send(
                `✅ Added!\n\n*Your Order:*\n${cartLines(cart)}${billBlock(cart)}\n\n` +
                `Please share your *Name, Phone & Address* to confirm.\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more | *cart* to review | *cancel* to cancel_`
            );
        }

        // ── Greetings ─────────────────────────────────────────────────────────
        if (/^(hi|hello|hey|hii|helo|namaste|hola|start|hy|hlo)$/i.test(text))
            return send(
                `👋 *Welcome to ScwOrder!*\n\n` +
                `🍕 Pizzas | 🍔 Burgers | 🥟 Momos | ☕ Beverages & more!\n\n` +
                `Type *menu* to see everything.\n` +
                `Or just tell me what you want:\n` +
                `_cheese pizza small_\n_2 veg burger + cold coffee_`
            );

        // ── Common queries ────────────────────────────────────────────────────
        if (/\b(thanks|thank you|ty|shukriya|dhanyawad|thx)\b/i.test(text))
            return send('😊 You\'re welcome! Come back anytime. 🙏');

        if (/\b(time|hours|open|close|timing|kab tak|kab se)\b/i.test(text))
            return send('🕐 We\'re open daily! Type *menu* to place your order.');

        if (/\b(contact|call|support|help|issue|problem|complaint)\b/i.test(text))
            return send('📞 For support, our team will assist you directly.\n\nFor orders — just type what you want or type *menu*!');

        if (/\b(location|where|kahan|delivery area|deliver)\b/i.test(text))
            return send('📍 We deliver to nearby areas!\n\n✅ Free delivery on orders above ₹375\n📦 ₹50 delivery fee otherwise\n\nType *menu* to order!');

        if (/\b(veg|vegetarian|no meat|pure veg)\b/i.test(text) && !/order/i.test(text)) {
            const menu = await getMenu();
            const vegItems = menu.filter(d => d.isVeg || d.category?.toLowerCase().includes('veg')).slice(0, 6);
            if (vegItems.length)
                return send(`🥦 *Veg Options:*\n${vegItems.map(d => `• ${d.name}`).join('\n')}\n\n...and more! Type *menu* for full list.`);
            return send('🥦 We have great veg options! Type *menu* to see all items.');
        }

        if (/\b(non.?veg|chicken|egg|meat|mutton)\b/i.test(text) && !/order/i.test(text)) {
            const menu = await getMenu();
            const nvItems = menu.filter(d => d.isVeg === false || d.category?.toLowerCase().includes('non')).slice(0, 6);
            if (nvItems.length)
                return send(`🍗 *Non-Veg Options:*\n${nvItems.map(d => `• ${d.name}`).join('\n')}\n\nType *menu* for full list!`);
            return send('🍗 Type *menu* to see all non-veg items!');
        }

        if (/\b(cheap|cheapest|budget|affordable|less|under|below|low price)\b/i.test(text)) {
            const menu  = await getMenu();
            const cheap = menu.filter(d => !d.portions && d.price)
                .sort((a, b) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 5);
            if (cheap.length)
                return send(`💰 *Budget-Friendly Picks:*\n${cheap.map(d => `• ${d.name} — ₹${d.price}`).join('\n')}\n\nType *menu* for more!`);
            return send('💰 Items start from ₹20! Type *menu* to see all prices.');
        }

        if (/\b(best|popular|recommend|special|favourite|favorite|top|trending)\b/i.test(text))
            return send(
                '⭐ *Most Popular:*\n' +
                '• Cheese Pizza — Small ₹89\n' +
                '• Veg Burger — ₹59\n' +
                '• Steam Veg Momos — ₹79\n' +
                '• Cold Coffee — ₹109\n\n' +
                'Type *menu* for the full list or just order directly!'
            );

        if (/\b(offer|discount|coupon|deal|free|promo)\b/i.test(text))
            return send('🎁 *Current Offer:*\n✅ Free delivery on orders above ₹375!\n\nType *menu* to start ordering.');

        if (/\b(payment|pay|upi|cash|cod|online|paytm|gpay|phonepe)\b/i.test(text))
            return send('💳 *Payment Options:*\n✅ UPI (GPay, PhonePe, Paytm)\n✅ Cash on Delivery\n\nPayment details shared after order confirmation.');

        if (/\b(how long|delivery time|kitna time|wait|eta|time lagega)\b/i.test(text))
            return send('⏱️ Estimated delivery: *30–45 minutes*\n\nType *menu* to place your order!');

        // ── Rule-based order matching ─────────────────────────────────────────
        const menu = await getMenu();
        const { resolved, unresolved } = parseOrder(text, menu);

        if (resolved.length) {
            const existingCart = session.cart || [];
            const needsPortion = resolved.filter(e => e.needsPortion);
            const readyItems   = resolved.filter(e => !e.needsPortion).map(e => ({ item: e.item, portion: e.portion }));
            const cart         = [...existingCart, ...readyItems];
            const warnMsg      = unresolved.length ? `\n\n⚠️ _Couldn't find:_ ${unresolved.join(', ')}` : '';

            if (needsPortion.length) {
                const first = needsPortion.shift();
                sessions[sender] = {
                    step: 'AWAITING_PORTION',
                    pendingItem: first.item,
                    pendingItems: needsPortion.map(e => e.item),
                    cart
                };
                const opts = first.item.portions.map((p, i) => `${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                return send(`Which size for *${first.item.name}*?\n\n${opts}${warnMsg}`);
            }

            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            return send(
                `🛒 *Order Summary:*\n${cartLines(cart)}` +
                `${billBlock(cart)}\n\n` +
                `Please share your *Name, Phone & Address*\n` +
                `_Example: Ravi, 9876543210, 12 MG Road, Delhi_\n\n` +
                `_Type *add* to add more | *empty* to clear | *cancel* to cancel_${warnMsg}`
            );
        }

        // ── Smart "Did you mean?" ─────────────────────────────────────────────
        const suggestions = getSuggestions(text, menu, 3);
        if (suggestions.length)
            return send(
                `🤔 Couldn't find "*${rawText}*"\n\n` +
                `*Did you mean:*\n${suggestions.map(s => `• ${s}`).join('\n')}\n\n` +
                `Type *menu* to browse everything!`
            );

        // ── Final fallback ────────────────────────────────────────────────────
        return send(
            `Hmm, I didn't get that! 😅\n\n` +
            `Type *menu* to browse, or just tell me what you want:\n` +
            `_cheese pizza small_\n_2 veg burger + cold coffee_`
        );
    });
}

startBot().catch(err => console.error('[Fatal]', err));
