const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {};

async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl,
            category: data[key].category || 'Other',
            description: data[key].description || '',
            portions: data[key].portions || null
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return [];
    }
}

// Fetch menu image URL saved by admin in Settings
async function getMenuImageUrl() {
    try {
        const res  = await fetch(`${FIREBASE_URL}/settings.json`);
        const data = await res.json();
        return data?.menuImageUrl || null;
    } catch { return null; }
}

// Match free-text like "cheese pizza small" against dishes+portions
function matchOrder(input, menu) {
    const q = input.toLowerCase();

    for (const item of menu) {
        if (!q.includes(item.name.toLowerCase())) continue;

        // If dish has portions, try to match a portion name
        if (item.portions && item.portions.length) {
            for (const p of item.portions) {
                if (q.includes(p.name.toLowerCase())) {
                    return { item, portion: p };
                }
            }
            // Dish matched but no portion specified — return dish so we can ask
            return { item, portion: null };
        }

        return { item, portion: null };
    }
    return null;
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["S", "K", "1"]
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'H', scale: 8, margin: 2 });
            const b64 = dataUrl.replace('data:image/png;base64,', '');
            console.log('\n==========================================');
            console.log('COPY all lines between START and END');
            console.log('then paste at: https://base64.guru/converter/decode/image');
            console.log('==========================================');
            console.log('BASE64_START');
            // Split into 76-char chunks so logs dont truncate
            const chunks = b64.match(/.{1,76}/g) || [];
            chunks.forEach(chunk => console.log(chunk));
            console.log('BASE64_END');
            console.log('==========================================\n');
        }

        if (connection === 'open') console.log('ScwOrder AI IS ONLINE!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                pairingCodeRequested = false;
                startBot();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log('Query: ' + text);

        // STEP: WAITING FOR PORTION SELECTION
        if (orderStates[sender]?.step === 'WAITING_FOR_PORTION') {
            const item = orderStates[sender].item;
            const portions = item.portions;
            const choice = parseInt(text.trim());

            if (isNaN(choice) || choice < 1 || choice > portions.length) {
                const opts = portions.map((p, i) => '  *' + (i + 1) + '.* ' + p.name + ' - Rs.' + p.price).join('\n');
                await sock.sendMessage(sender, { text: 'Please reply with a number between 1 and ' + portions.length + '.\n\n' + opts });
                return;
            }

            const selectedPortion = portions[choice - 1];
            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: { ...item, selectedPortion } };
            await sock.sendMessage(sender, {
                text: '*' + selectedPortion.name + '* selected (Rs.' + selectedPortion.price + ')\n\nNow please reply with your *Full Name, Phone Number, and Delivery Address*.'
            });
            return;
        }

        // STEP: WAITING FOR ADDRESS
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text;
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];
            const portion   = item.selectedPortion || null;
            const itemPrice = portion ? portion.price : parseFloat(item.price);
            const itemLabel = portion ? item.name + ' (' + portion.name + ')' : item.name;

            const order = {
                userId: 'whatsapp_' + customerWaNumber,
                userEmail: 'whatsapp@ScwOrder.com',
                phone: customerWaNumber,
                address: customerDetails,
                location: { lat: 0, lng: 0 },
                items: [{ id: item.id, name: itemLabel, price: itemPrice, img: item.imageUrl || '', quantity: 1, portion: portion ? portion.name : null }],
                total: (itemPrice + 50).toFixed(2),
                status: 'Placed',
                method: 'Cash on Delivery (WhatsApp)',
                timestamp: new Date().toISOString()
            };

            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(order)
                });
            } catch (e) { console.log('Firebase Error: ' + e); }

            await sock.sendMessage(sender, {
                text: '*Order Placed!*\n\nItem: ' + itemLabel + '\nTotal: Rs.' + order.total + ' (incl. Rs.50 delivery)\nAddress: ' + customerDetails + '\nStatus: Preparing\n\nThank you!'
            });
            delete orderStates[sender];
            return;
        }

        // ORDER — free text e.g. "cheese pizza small" or "order veg burger"
        else if (text.startsWith('order ') || text === 'order') {
            if (text === 'order') {
                await sock.sendMessage(sender, { text: 'Just tell me what you want!\nExample: _cheese pizza small_ or _veg burger_\n\nType *menu* to see our menu.' });
                return;
            }
            const query = text.replace(/^order\s+/i, '').trim();
            const currentMenu = await getMenuFromApp();
            const match = matchOrder(query, currentMenu);

            if (!match) {
                await sock.sendMessage(sender, { text: 'Sorry, could not find that item.\n\nType *menu* to see our full menu, then tell me what you want.' });
                return;
            }

            const { item, portion } = match;

            if (item.portions && item.portions.length && !portion) {
                // Dish found but size not specified — ask
                orderStates[sender] = { step: 'WAITING_FOR_PORTION', item };
                const opts = item.portions.map((p, i) => '  *' + (i + 1) + '.* ' + p.name + ' - Rs.' + p.price).join('\n');
                const caption = '*' + item.name + '*\n\nWhich size would you like?\n\n' + opts + '\n\nReply with the number.';
                if (item.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: item.imageUrl }, caption });
                } else {
                    await sock.sendMessage(sender, { text: caption });
                }
            } else {
                // Portion already matched or no portions — go to address
                const selectedPortion = portion || null;
                orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: { ...item, selectedPortion } };
                const price   = selectedPortion ? selectedPortion.price : item.price;
                const label   = selectedPortion ? item.name + ' (' + selectedPortion.name + ')' : item.name;
                const caption = '*Order Started!*\n\n' + label + ' - Rs.' + price + '\nDelivery: Rs.50\n*Total: Rs.' + (parseFloat(price) + 50).toFixed(0) + '*\n\nPlease reply with your *Full Name, Phone Number, and Delivery Address*.';
                if (item.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: item.imageUrl }, caption });
                } else {
                    await sock.sendMessage(sender, { text: caption });
                }
            }
        }
        else if (text.includes('menu') || text.includes('price') || text.includes('list') || text.includes('food')) {
            const menuImageUrl = await getMenuImageUrl();
            if (menuImageUrl) {
                await sock.sendMessage(sender, {
                    image: { url: menuImageUrl },
                    caption: '*ScwOrder Menu*\n\nTo order, just type what you want!\nExample: _cheese pizza small_ or _veg burger_'
                });
            } else {
                await sock.sendMessage(sender, {
                    text: 'Menu image not set yet. Please contact us or type *order [dish name]* to place an order.'
                });
            }
        }
        else if (text.includes('hi') || text.includes('hello') || text.includes('hey')) {
            await sock.sendMessage(sender, { text: 'Welcome to ScwOrder!\n\nType *menu* to see our menu image, then just tell me what you want!\nExample: _cheese pizza small_ or _veg burger_' });
        }
        else if (text.includes('contact') || text.includes('call')) {
            await sock.sendMessage(sender, { text: 'Contact ScwOrder:\nEmail: support@ScwOrder.com' });
        }
        else {
            await sock.sendMessage(sender, { text: "Type *menu* to see our food list, or *order [food]* to place an order!" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
