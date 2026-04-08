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

        // STEP 1: START ORDER
        if (text.startsWith('order ')) {
            const productRequested = text.replace('order ', '').trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: 'Sorry, we could not find *' + productRequested + '* in our menu.\n\nType *menu* to see all available items.' });
                return;
            }

            if (matchedItem.portions && matchedItem.portions.length) {
                orderStates[sender] = { step: 'WAITING_FOR_PORTION', item: matchedItem };
                const opts = matchedItem.portions.map((p, i) => '  *' + (i + 1) + '.* ' + p.name + ' - Rs.' + p.price).join('\n');
                const caption = '*' + matchedItem.name + '*\n\nChoose your size — reply with the number:\n\n' + opts;
                if (matchedItem.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: matchedItem.imageUrl }, caption });
                } else {
                    await sock.sendMessage(sender, { text: caption });
                }
            } else {
                orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };
                const caption = '*Order Started!*\n\nYou selected: *' + matchedItem.name + '* - Rs.' + matchedItem.price + '\n\nPlease reply with your *Full Name, Phone Number, and Delivery Address*.';
                if (matchedItem.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: matchedItem.imageUrl }, caption });
                } else {
                    await sock.sendMessage(sender, { text: caption });
                }
            }
        }
        else if (text === 'order') {
            await sock.sendMessage(sender, { text: "How to order:\nType 'order' followed by the dish name.\nExample: *order pizza*" });
        }
        else if (text.includes('menu') || text.includes('price') || text.includes('list') || text.includes('food')) {
            const currentMenu = await getMenuFromApp();
            if (currentMenu.length === 0) {
                await sock.sendMessage(sender, { text: 'Menu is currently empty. Please check back soon!' });
                return;
            }

            const grouped = {};
            currentMenu.forEach(item => {
                const cat = (item.category || 'Other').charAt(0).toUpperCase() + item.category.slice(1);
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(item);
            });

            const catEmojis = { Pizza:'pizza', Burger:'burger', Coffee:'coffee', Sweet:'sweet', Chinese:'chinese', Biryani:'biryani', Momo:'momo', Sandwich:'sandwich', Fries:'fries', Beverage:'drink', Shake:'shake', Other:'food' };

            let menuMessage = '*ScwOrder - Live Menu*\n' + '-'.repeat(28) + '\n\n';
            Object.entries(grouped).forEach(([cat, items]) => {
                menuMessage += '*' + cat.toUpperCase() + '*\n';
                items.forEach(item => {
                    if (item.portions && item.portions.length) {
                        const sizes = item.portions.map(p => p.name + ' Rs.' + p.price).join(' | ');
                        menuMessage += '  - *' + item.name + '*\n    ' + sizes + '\n';
                    } else {
                        menuMessage += '  - *' + item.name + '* - Rs.' + item.price + '\n';
                    }
                });
                menuMessage += '\n';
            });
            menuMessage += '-'.repeat(28) + '\nReply *order [dish name]* to order\nExample: order pizza';
            await sock.sendMessage(sender, { text: menuMessage });
        }
        else if (text.includes('hi') || text.includes('hello') || text.includes('hey')) {
            await sock.sendMessage(sender, { text: 'Welcome to ScwOrder!\n\nType *menu* to see our food, or *order [dish]* to order instantly!' });
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
