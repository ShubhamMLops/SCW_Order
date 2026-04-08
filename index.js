const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const http = require('http');
const pino = require('pino');

let qrServer = null;
let latestQRHtml = '<p style="font-family:sans-serif;color:#888">Waiting for QR code…</p>';

// Tiny HTTP server — serves the latest QR as a webpage
function startQRServer() {
    if (qrServer) return;
    qrServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="refresh" content="10">
            <title>ScwOrder — Scan QR</title>
            <style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0a0603;font-family:sans-serif;color:#fef3c7;}
            h2{margin-bottom:16px;}img{border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);}
            p{margin-top:14px;color:#78716c;font-size:0.9em;}</style>
        </head><body>
            <h2>📱 Scan with WhatsApp</h2>
            ${latestQRHtml}
            <p>Page auto-refreshes every 10 seconds</p>
        </body></html>`);
    });
    qrServer.listen(3000, () => {
        console.log('\n🌐 QR Server running on port 3000');
        console.log('   If using GitHub Actions, add a tunnel step to expose port 3000');
        console.log('   Or copy the data URL printed below and paste it in your browser\n');
    });
}

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Function to fetch the dynamic menu from your App's Firebase
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
            portions: data[key].portions || null  // ← include portions
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return [];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser:["S", "K", "1"] 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            QRCode.toDataURL(qr, { scale: 8, margin: 2, color: { dark: '#000000', light: '#ffffff' } }, (err, dataUrl) => {
                if (err) { console.error('QR error:', err); return; }

                // Update the served webpage
                latestQRHtml = `<img src="${dataUrl}" width="300" height="300" alt="WhatsApp QR">`;
                startQRServer();

                // Also print the data URL to logs — paste it in browser address bar to view
                console.log('\n══════════════════════════════════════════');
                console.log('📱 SCAN QR — two options:');
                console.log('   1. Open  http://localhost:3000  in browser (or tunnel URL)');
                console.log('   2. Copy the data URL below → paste in browser address bar');
                console.log('──────────────────────────────────────────');
                console.log(dataUrl);
                console.log('══════════════════════════════════════════\n');
            });
        }

        if (connection === 'open') console.log('✅ ScwOrder AI IS ONLINE!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return; // Loop Protection

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log(`📩 Query: ${text}`);

        // --- 🛒 STEP 2b: WAITING FOR PORTION SELECTION ---
        if (orderStates[sender]?.step === 'WAITING_FOR_PORTION') {
            const item = orderStates[sender].item;
            const portions = item.portions;
            const choice = parseInt(text.trim());

            if (isNaN(choice) || choice < 1 || choice > portions.length) {
                const opts = portions.map((p, i) => `  *${i + 1}.* ${p.name} — ₹${p.price}`).join('\n');
                await sock.sendMessage(sender, { text: `⚠️ Please reply with a number between 1 and ${portions.length}.\n\n${opts}` });
                return;
            }

            const selectedPortion = portions[choice - 1];
            orderStates[sender] = {
                step: 'WAITING_FOR_ADDRESS',
                item: { ...item, selectedPortion }
            };

            await sock.sendMessage(sender, {
                text: `✅ *${selectedPortion.name}* selected (₹${selectedPortion.price})\n\nNow please reply with your *Full Name, Phone Number, and Delivery Address*.`
            });
            return;
        }

        // --- 🛒 STEP 3: FINISH ORDER & SEND TO ADMIN PANEL ---
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text;
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            // Use portion price if a portion was selected, otherwise base price
            const portion = item.selectedPortion || null;
            const itemPrice = portion ? portion.price : parseFloat(item.price);
            const itemLabel = portion ? `${item.name} (${portion.name})` : item.name;

            const ScwOrderOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@ScwOrder.com",
                phone: customerWaNumber,
                address: customerDetails,
                location: { lat: 0, lng: 0 },
                items: [{
                    id: item.id,
                    name: itemLabel,
                    price: itemPrice,
                    img: item.imageUrl || "",
                    quantity: 1,
                    portion: portion ? portion.name : null
                }],
                total: (itemPrice + 50).toFixed(2),
                status: "Placed",
                method: "Cash on Delivery (WhatsApp)",
                timestamp: new Date().toISOString()
            };

            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(ScwOrderOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, {
                text: `✅ *Order Placed Successfully!*\n\n` +
                      `🍽 *Item:* ${itemLabel}\n` +
                      `💰 *Total:* ₹${ScwOrderOrder.total} (incl. ₹50 delivery)\n` +
                      `📍 *Address:* ${customerDetails}\n` +
                      `📦 *Status:* Preparing\n\n` +
                      `We'll deliver to your address soon. Thank you! 🙏`
            });
            delete orderStates[sender];
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW ---
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Sorry, we couldn't find *${productRequested}* in our menu.\n\nType *menu* to see all available items.` });
                return;
            }

            // If dish has portions, ask user to pick one first
            if (matchedItem.portions && matchedItem.portions.length) {
                orderStates[sender] = { step: 'WAITING_FOR_PORTION', item: matchedItem };

                const opts = matchedItem.portions.map((p, i) => `  *${i + 1}.* ${p.name} — ₹${p.price}`).join('\n');
                const captionText =
                    `🛒 *${matchedItem.name}*\n\n` +
                    `This item comes in multiple sizes. Please reply with the *number* of your choice:\n\n` +
                    `${opts}`;

                if (matchedItem.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: matchedItem.imageUrl }, caption: captionText });
                } else {
                    await sock.sendMessage(sender, { text: captionText });
                }
            } else {
                // No portions — go straight to address
                orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };

                const captionText =
                    `🛒 *Order Started!*\n\n` +
                    `You selected: *${matchedItem.name}* — ₹${matchedItem.price}\n\n` +
                    `Please reply with your *Full Name, Phone Number, and Delivery Address*.`;

                if (matchedItem.imageUrl) {
                    await sock.sendMessage(sender, { image: { url: matchedItem.imageUrl }, caption: captionText });
                } else {
                    await sock.sendMessage(sender, { text: captionText });
                }
            }
        }
        else if (text === "order") { 
            await sock.sendMessage(sender, { text: "🛒 *How to order:* \nPlease type 'order' followed by the dish name. \nExample: *order pizza*" });
        }
        
        // --- DYNAMIC MENU FEATURE ---
        else if (text.includes("menu") || text.includes("price") || text.includes("list") || text.includes("food")) {
            const currentMenu = await getMenuFromApp();
            
            if (currentMenu.length === 0) {
                await sock.sendMessage(sender, { text: "Our menu is currently empty or updating. Please check back soon!" });
                return;
            }

            // Group by category
            const grouped = {};
            currentMenu.forEach(item => {
                const cat = (item.category || 'Other').charAt(0).toUpperCase() + item.category.slice(1);
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(item);
            });

            const catEmojis = {
                Pizza: '🍕', Burger: '🍔', Coffee: '☕', Sweet: '🍨',
                Chinese: '🥡', Biryani: '🍛', Momo: '🥟', Sandwich: '🥪',
                Fries: '🍟', Beverage: '🥤', Shake: '🥛', Other: '🍽'
            };

            let menuMessage = `� *ScwOrder — Live Menu*\n${'─'.repeat(28)}\n\n`;

            Object.entries(grouped).forEach(([cat, items]) => {
                const emoji = catEmojis[cat] || '🍽';
                menuMessage += `${emoji} *${cat.toUpperCase()}*\n`;
                items.forEach(item => {
                    if (item.portions && item.portions.length) {
                        const sizes = item.portions.map(p => `${p.name} ₹${p.price}`).join(' | ');
                        menuMessage += `  • *${item.name}*\n    ${sizes}\n`;
                    } else {
                        menuMessage += `  • *${item.name}* — ₹${item.price}\n`;
                    }
                });
                menuMessage += '\n';
            });

            menuMessage += `${'─'.repeat(28)}\n_Reply *order [dish name]* to order_\n_Example: order pizza_`;
            
            await sock.sendMessage(sender, { text: menuMessage });
        }

        // --- GREETINGS ---
        else if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
            await sock.sendMessage(sender, { text: "👋 *Welcome to ScwOrder!* \n\nI am your AI Assistant. Type *menu* to see our delicious food, or type *order [dish]* to buy instantly!" });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Contact ScwOrder:* \n\n- *Email:* support@ScwOrder.com" });
        }
        else {
            await sock.sendMessage(sender, { text: "🤔 I didn't quite catch that.\n\nType *menu* to see our food list, or *order [food]* to place an order!" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
