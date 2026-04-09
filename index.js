const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino   = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;
const DELIVERY_FEE = 50;
const GST_RATE     = 0.05;

// per-sender session
const sessions = {};

// ── Firebase helpers ──────────────────────────────────────────────────────────

async function getMenu() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data).map(k => ({ id: k, ...data[k], portions: data[k].portions || null }));
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
// Parses "cheese pizza small + veg burger + steam veg momos" into cart items
// Returns { resolved: [{item, portion}], unresolved: [string] }

function parseOrder(input, menu) {
    // Split on + or "and"
    const parts = input.split(/\s*\+\s*|\s+and\s+/i).map(p => p.trim()).filter(Boolean);
    const resolved   = [];
    const unresolved = [];

    const sizeAliases = {
        small: ['small','s','sm'], medium: ['medium','m','med'], large: ['large','l','lg']
    };

    for (const part of parts) {
        const q = part.toLowerCase();
        // Sort dishes by name length desc so longer names match first
        const sorted = [...menu].sort((a, b) => b.name.length - a.name.length);
        let matched = false;

        for (const item of sorted) {
            if (!q.includes(item.name.toLowerCase())) continue;

            if (item.portions && item.portions.length) {
                let foundPortion = null;
                for (const p of item.portions) {
                    const pName = p.name.toLowerCase();
                    const aliases = sizeAliases[pName] || [pName];
                    if (aliases.some(a => {
                        // match as whole word
                        const re = new RegExp('\\b' + a + '\\b');
                        return re.test(q);
                    })) {
                        foundPortion = p;
                        break;
                    }
                }
                resolved.push({ item, portion: foundPortion, needsPortion: !foundPortion });
            } else {
                resolved.push({ item, portion: null, needsPortion: false });
            }
            matched = true;
            break;
        }
        if (!matched) unresolved.push(part);
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

    // Poll every 5s for orders accepted by admin — send WhatsApp confirmation
    const sentAcceptMsg = new Set();
    setInterval(async () => {
        try {
            const res    = await fetch(`${FIREBASE_URL}/orders.json`);
            const orders = await res.json();
            if (!orders) return;
            for (const [key, order] of Object.entries(orders)) {
                if (order.accepted === true && !order.acceptedMsgSent && !sentAcceptMsg.has(key)) {
                    sentAcceptMsg.add(key);
                    const waJid = (order.waNumber || order.phone) + '@s.whatsapp.net';
                    try {
                        await sock.sendMessage(waJid, {
                            text: '✅ *Your order has been accepted!*\n\nOur chef is preparing your order. We will contact you shortly for payment details.\n\nThank you for ordering from ScwOrder! 🙏'
                        });
                        await fetch(`${FIREBASE_URL}/orders/${key}.json`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ acceptedMsgSent: true })
                        });
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

        // ── CANCEL ────────────────────────────────────────────────────────────
        if (text === 'cancel') {
            delete sessions[sender];
            await sock.sendMessage(sender, { text: '❌ Order cancelled. Type *menu* to start again.' });
            return;
        }

        // ── MENU ──────────────────────────────────────────────────────────────
        if (/\bmenu\b/.test(text) || text === 'price' || text === 'list') {
            const menu = await getMenu();
            if (!menu.length) {
                await sock.sendMessage(sender, { text: 'Menu is currently empty. Please check back soon!' });
                return;
            }
            await sock.sendMessage(sender, { text: buildMenuText(menu) });
            return;
        }

        // ── GREETINGS ─────────────────────────────────────────────────────────
        if (/^(hi|hello|hey|hii|helo|namaste)$/i.test(text)) {
            await sock.sendMessage(sender, {
                text: '👋 *Welcome to ScwOrder!*\n\nType *menu* to see our full menu.\n\nThen just tell me what you want!\n_Example: cheese pizza small_\n_Example: veg burger + steam veg momos_'
            });
            return;
        }

        // ── WAITING FOR PORTION on a specific pending item ────────────────────
        if (session.step === 'AWAITING_PORTION') {
            const { pendingItem, cart } = session;
            const choice = parseInt(text);
            const portions = pendingItem.portions;

            if (isNaN(choice) || choice < 1 || choice > portions.length) {
                const opts = portions.map((p, i) => `  ${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `Please reply with a number 1–${portions.length}:\n\n${opts}` });
                return;
            }

            const portion = portions[choice - 1];
            cart.push({ item: pendingItem, portion });

            // Check if there are more items needing portions
            const nextPending = session.pendingItems?.shift();
            if (nextPending) {
                sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: nextPending, pendingItems: session.pendingItems, cart };
                const opts = nextPending.portions.map((p, i) => `  ${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `✅ Added!\n\nNow, which size for *${nextPending.name}*?\n\n${opts}` });
            } else {
                // All portions resolved — ask for details
                sessions[sender] = { step: 'AWAITING_DETAILS', cart };
                const { subtotal, gst, total } = calcBill(cart);
                await sock.sendMessage(sender, {
                    text: `✅ *${portion.name} ${pendingItem.name}* added!\n\n` +
                          `*Your Order:*\n${cartLines(cart)}\n\n` +
                          `Subtotal: ₹${subtotal}\n\n` +
                          `Please reply with your:\n*Name, Phone Number & Delivery Address*`
                });
            }
            return;
        }

        // ── WAITING FOR CUSTOMER DETAILS ──────────────────────────────────────
        if (session.step === 'AWAITING_DETAILS') {
            const { cart } = session;
            const waNumber = sender.split('@')[0];
            const { subtotal, gst, total } = calcBill(cart);

            const orderItems = cart.map(e => ({
                id:       e.item.id,
                name:     e.portion ? `${e.item.name} (${e.portion.name})` : e.item.name,
                price:    e.portion ? parseFloat(e.portion.price) : parseFloat(e.item.price || 0),
                img:      (e.item.imageUrl && e.item.imageUrl.startsWith('http')) ? e.item.imageUrl : '',
                quantity: 1,
                portion:  e.portion ? e.portion.name : null
            }));

            // Parse name, phone, address from the reply
            // Accept any free text — store as address, extract phone if present
            const phoneMatch = rawText.match(/(\+?91[\s-]?)?[6-9]\d{9}/);
            const phone      = phoneMatch ? phoneMatch[0].replace(/\s|-/g, '') : waNumber;

            const order = {
                userId:    'whatsapp_' + waNumber,
                userEmail: 'whatsapp@ScwOrder.com',
                phone,
                waNumber,
                address:   rawText,
                location:  { lat: 0, lng: 0 },
                items:     orderItems,
                subtotal:  subtotal.toFixed(2),
                gst:       gst.toFixed(2),
                deliveryFee: DELIVERY_FEE,
                total:     total.toFixed(2),
                status:    'Placed',
                method:    'WhatsApp Order',
                timestamp: new Date().toISOString()
            };

            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(order)
                });
            } catch (e) { console.log('Firebase Error:', e); }

            delete sessions[sender];
            await sock.sendMessage(sender, {
                text: `✅ *Order Placed!*\n\n` +
                      `*Items:*\n${cartLines(cart)}\n\n` +
                      `Subtotal: ₹${subtotal}\n\n` +
                       `📍 Address: ${rawText}\n\n` +
                       `_Our chef will contact you shortly for payment. Final amount with QR code will be shared with you._\n\n` +
                      `Thank you for ordering from ScwOrder! 🙏`
            });
            return;
        }

        // ── FREE-TEXT ORDER MATCHING ──────────────────────────────────────────
        const menu  = await getMenu();
        const { resolved, unresolved } = parseOrder(text, menu);

        if (!resolved.length) {
            await sock.sendMessage(sender, {
                text: `Type *menu* to see our full menu, then tell me what you want!\n_Example: cheese pizza small_\n_Example: veg burger + momos_`
            });
            return;
        }

        // Warn about unrecognised items
        let warnMsg = '';
        if (unresolved.length) {
            warnMsg = `\n\n⚠️ Could not find: _${unresolved.join(', ')}_\nPlease check the menu and try again.`;
        }

        // Separate items that need portion selection
        const needsPortion = resolved.filter(e => e.needsPortion);
        const readyItems   = resolved.filter(e => !e.needsPortion);

        const cart = [...(session.cart || []), ...readyItems];

        if (needsPortion.length) {
            const first = needsPortion.shift();
            sessions[sender] = { step: 'AWAITING_PORTION', pendingItem: first.item, pendingItems: needsPortion.map(e => e.item), cart };
            const opts = first.item.portions.map((p, i) => `  ${i + 1}. ${p.name} — ₹${p.price}`).join('\n');
            await sock.sendMessage(sender, {
                text: `Which size for *${first.item.name}*?\n\n${opts}${warnMsg}`
            });
        } else {
            // All items ready — show cart and ask for details
            sessions[sender] = { step: 'AWAITING_DETAILS', cart };
            const { subtotal, gst, total } = calcBill(cart);
            await sock.sendMessage(sender, {
                text: `🛒 *Order Summary:*\n${cartLines(cart)}\n\n` +
                      `Subtotal: ₹${subtotal}\n\n` +
                      `_+5% GST applicable. Our chef will contact you for payment._\n\n` +
                      `Delivery charges will apply if the order value is below ₹375 or if the delivery location is beyond 3 km.\n\n` +
                      `Please reply with your:\n*Name, Phone Number & Delivery Address*${warnMsg}`
            });
        }
    });
}

startBot().catch(err => console.log('Error:', err));
