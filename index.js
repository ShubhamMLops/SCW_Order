const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino   = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;

// Per-sender state: { step, cart: [], pendingItem }
const orderStates = {};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getMenu() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await res.json();
        if (!data) return [];
        return Object.keys(data).map(k => ({
            id: k, ...data[k],
            portions: data[k].portions || null
        }));
    } catch (e) { console.error('Menu fetch error:', e); return []; }
}

async function getMenuImageUrl() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/settings.json`);
        const data = await res.json();
        const url  = data?.menuImageUrl;
        return isValidUrl(url) ? url : null;
    } catch { return null; }
}

function isValidUrl(url) {
    return url && typeof url === 'string' && url.startsWith('http');
}

// Send with image only if URL is a real http link (not NA / empty / undefined)
async function send(sock, sender, text, imageUrl) {
    if (isValidUrl(imageUrl)) {
        await sock.sendMessage(sender, { image: { url: imageUrl }, caption: text });
    } else {
        await sock.sendMessage(sender, { text });
    }
}

// Match free-text like "cheese pizza small" → { item, portion }
function matchItem(input, menu) {
    const q = input.toLowerCase();
    // Sort by name length desc so "cheese pizza" matches before "pizza"
    const sorted = [...menu].sort((a, b) => b.name.length - a.name.length);
    for (const item of sorted) {
        if (!q.includes(item.name.toLowerCase())) continue;
        if (item.portions && item.portions.length) {
            for (const p of item.portions) {
                const aliases = [p.name.toLowerCase()];
                // common size aliases
                if (p.name.toLowerCase() === 'small')  aliases.push('s', 'sm');
                if (p.name.toLowerCase() === 'medium') aliases.push('m', 'med');
                if (p.name.toLowerCase() === 'large')  aliases.push('l', 'lg');
                if (aliases.some(a => q.includes(a))) return { item, portion: p };
            }
            return { item, portion: null }; // size not specified
        }
        return { item, portion: null };
    }
    return null;
}

function cartSummary(cart) {
    let lines = '';
    let subtotal = 0;
    cart.forEach((entry, i) => {
        const label = entry.portion ? entry.item.name + ' (' + entry.portion.name + ')' : entry.item.name;
        const price = entry.portion ? entry.portion.price : parseFloat(entry.item.price);
        subtotal += price;
        lines += (i + 1) + '. ' + label + ' - Rs.' + price + '\n';
    });
    const delivery = 50;
    const total    = subtotal + delivery;
    return { lines, subtotal, delivery, total };
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

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const raw    = (msg.message.conversation || msg.message.extendedTextMessage?.text || '');
        const text   = raw.toLowerCase().trim();
        const state  = orderStates[sender];

        console.log('Msg [' + sender.split('@')[0] + ']: ' + text);

        // ── CANCEL anytime ────────────────────────────────────────────────────
        if (text === 'cancel') {
            delete orderStates[sender];
            await sock.sendMessage(sender, { text: 'Order cancelled. Type *menu* to start again.' });
            return;
        }

        // ── MENU — always accessible ──────────────────────────────────────────
        if (text === 'menu' || text === 'price' || text === 'list' || text.includes('menu')) {
            const imgUrl = await getMenuImageUrl();
            const note = '\n\n_*Note:* GST is applicable on all orders. The final amount along with the QR code for payment will be shared with you after placing the order._';
            if (imgUrl) {
                await sock.sendMessage(sender, {
                    image: { url: imgUrl },
                    caption: '*ScwOrder Menu*\n\nJust tell me what you want!\nExample: _cheese pizza small_ or _veg burger_\n\nType *done* to checkout. Type *cancel* to cancel.' + note
                });
            } else {
                await sock.sendMessage(sender, {
                    text: '*ScwOrder*\n\nTell me what you want to order!\nExample: _cheese pizza small_ or _veg burger_\n\nType *done* when finished. Type *cancel* to cancel.' + note
                });
            }
            return;
        }

        // ── GREETINGS — always accessible ─────────────────────────────────────
        if (text.includes('hi') || text.includes('hello') || text.includes('hey')) {
            await sock.sendMessage(sender, {
                text: 'Welcome to ScwOrder!\n\nType *menu* to see our menu.\nThen just tell me what you want — e.g. _cheese pizza small_\n\nYou can add multiple items before checking out!'
            });
            return;
        }

        // ── WAITING FOR PORTION CHOICE ────────────────────────────────────────
        if (state?.step === 'WAITING_FOR_PORTION') {
            const { item, cart } = state;
            const portions = item.portions;
            const choice   = parseInt(text);
            if (isNaN(choice) || choice < 1 || choice > portions.length) {
                const opts = portions.map((p, i) => (i + 1) + '. ' + p.name + ' - Rs.' + p.price).join('\n');
                await sock.sendMessage(sender, { text: 'Please reply with a number:\n\n' + opts });
                return;
            }
            const portion = portions[choice - 1];
            cart.push({ item, portion });
            const { lines, subtotal, delivery, total } = cartSummary(cart);
            orderStates[sender] = { step: 'ADDING', cart };
            await sock.sendMessage(sender, {
                text: '*' + portion.name + ' ' + item.name + '* added!\n\n' +
                      '*Your cart:*\n' + lines +
                      '\nSubtotal: Rs.' + subtotal + '\nDelivery: Rs.' + delivery + '\n*Total: Rs.' + total + '*\n\n' +
                      'Add more items or type *done* to checkout.\nType *cancel* to cancel.'
            });
            return;
        }

        // ── WAITING FOR ADDRESS ───────────────────────────────────────────────
        if (state?.step === 'WAITING_FOR_ADDRESS') {
            const { cart } = state;
            const waNumber = sender.split('@')[0];
            const { lines, subtotal, delivery, total } = cartSummary(cart);

            const orderItems = cart.map(entry => ({
                id:       entry.item.id,
                name:     entry.portion ? entry.item.name + ' (' + entry.portion.name + ')' : entry.item.name,
                price:    entry.portion ? entry.portion.price : parseFloat(entry.item.price),
                img:      isValidUrl(entry.item.imageUrl) ? entry.item.imageUrl : '',
                quantity: 1,
                portion:  entry.portion ? entry.portion.name : null
            }));

            const order = {
                userId:    'whatsapp_' + waNumber,
                userEmail: 'whatsapp@ScwOrder.com',
                phone:     waNumber,
                address:   raw,
                location:  { lat: 0, lng: 0 },
                items:     orderItems,
                subtotal:  subtotal.toFixed(2),
                total:     total.toFixed(2),
                status:    'Placed',
                method:    'Cash on Delivery (WhatsApp)',
                timestamp: new Date().toISOString()
            };

            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(order)
                });
            } catch (e) { console.log('Firebase Error:', e); }

            delete orderStates[sender];
            await sock.sendMessage(sender, {
                text: '*Order Placed!*\n\n' + lines +
                      '\nSubtotal: Rs.' + subtotal + '\nDelivery: Rs.' + delivery + '\n*Total: Rs.' + total + '*\n\n' +
                      'Address: ' + raw + '\nStatus: Preparing\n\n' +
                      '-----------------------------------\n' +
                      '*Note:* Our chef will contact you shortly. Kindly provide your name, phone number, and address, as these details are mandatory for processing your order.\n\n' +
                      'GST is applicable on this order. The final amount along with the QR code for payment will be shared with you.\n' +
                      '-----------------------------------\n\n' +
                      'Thank you for ordering from ScwOrder!'
            });
            return;
        }

        // ── DONE — proceed to checkout ────────────────────────────────────────
        if (text === 'done' || text === 'checkout' || text === 'place order') {
            if (!state?.cart?.length) {
                await sock.sendMessage(sender, { text: 'Your cart is empty. Tell me what you want to order!' });
                return;
            }
            const { lines, subtotal, delivery, total } = cartSummary(state.cart);
            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', cart: state.cart };
            await sock.sendMessage(sender, {
                text: '*Order Summary:*\n\n' + lines +
                      '\nSubtotal: Rs.' + subtotal + '\nDelivery: Rs.' + delivery + '\n*Total: Rs.' + total + '*\n\n' +
                      '-----------------------------------\n' +
                      '*Note:* Our chef will contact you shortly. Kindly provide your name, phone number, and address, as these details are mandatory for processing your order.\n\n' +
                      'GST is applicable on this order, and the final amount along with the QR code for payment will be shared with you.\n' +
                      '-----------------------------------\n\n' +
                      'Please reply with your *Full Name, Phone Number & Delivery Address*.'
            });
            return;
        }

        // ── FREE-TEXT ORDER MATCHING ──────────────────────────────────────────
        const menu  = await getMenu();
        const match = matchItem(text, menu);

        if (match) {
            const { item, portion } = match;
            const cart = state?.cart || [];

            if (item.portions && item.portions.length && !portion) {
                // Size not specified — ask
                orderStates[sender] = { step: 'WAITING_FOR_PORTION', item, cart };
                const opts = item.portions.map((p, i) => (i + 1) + '. ' + p.name + ' - Rs.' + p.price).join('\n');
                await send(sock, sender,
                    '*' + item.name + '*\n\nWhich size?\n\n' + opts + '\n\nReply with the number.',
                    isValidUrl(item.imageUrl) ? item.imageUrl : null
                );
            } else {
                // Add to cart directly
                cart.push({ item, portion });
                const { lines, subtotal, delivery, total } = cartSummary(cart);
                orderStates[sender] = { step: 'ADDING', cart };
                const label = portion ? item.name + ' (' + portion.name + ')' : item.name;
                const price = portion ? portion.price : parseFloat(item.price);
                await send(sock, sender,
                    '*' + label + '* added! (Rs.' + price + ')\n\n' +
                    '*Your cart:*\n' + lines +
                    '\nSubtotal: Rs.' + subtotal + '\nDelivery: Rs.' + delivery + '\n*Total: Rs.' + total + '*\n\n' +
                    'Add more items or type *done* to checkout.\nType *cancel* to cancel.',
                    isValidUrl(item.imageUrl) ? item.imageUrl : null
                );
            }
            return;
        }

        // ── FALLBACK ──────────────────────────────────────────────────────────
        await sock.sendMessage(sender, {
            text: state?.cart?.length
                ? 'Could not find that item. Keep adding or type *done* to checkout.\nType *cancel* to cancel.'
                : 'Type *menu* to see our menu, then tell me what you want!'
        });
    });
}

startBot().catch(err => console.log('Error:', err));
