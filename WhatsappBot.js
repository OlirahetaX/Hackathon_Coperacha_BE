// WhatsappBot.js
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import pkgqr from 'qrcode-terminal';
const qrcode = pkgqr;
import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

// import fetch from 'node-fetch'; // <-- descomenta si tu Node es < 18

dotenv.config();

/* =========================
   ENV / DB
   ========================= */
const MONGO_URI = process.env.MONGO_URI;
const WALLET_REGISTER_URL = process.env.WALLET_REGISTER_URL || 'https://metamask.io/download';
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

const clientMongo = new MongoClient(MONGO_URI);
let db;

async function connectDB() {
    if (db) return db;
    await clientMongo.connect();
    db = clientMongo.db("coperacha");
    console.log("✅ [Bot] Conectado a MongoDB");
    return db;
}

async function findClient(celular) {
    try {
        const usersCollection = db.collection("users");
        const user = await usersCollection.findOne({ celular });
        return user;
    } catch (error) {
        console.error("❌ [Bot] Error buscando usuario por celular:", error);
        return null;
    }
}

/* =========================
   TIMEOUT / HELPERS
   ========================= */
const userTimeouts = {};
function startUserTimeout(number, client) {
    if (userTimeouts[number]) clearTimeout(userTimeouts[number]);
    userTimeouts[number] = setTimeout(async () => {
        userStates[number] = STATES.NONE;
        delete tempUserData[number];
        delete userTimeouts[number];
        try {
            await client.sendMessage(
                `${number}@c.us`,
                '⏳ Tu sesión ha expirado por inactividad. Si deseas volver a empezar, solo escribe cualquier mensaje.'
            );
        } catch (err) {
            console.error(`❌ [Bot] Error al enviar mensaje de timeout a ${number}:`, err);
        }
    }, 5 * 60 * 1000); // 5 min
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
function isValidEmail(value) {
    return EMAIL_REGEX.test(String(value).trim());
}
function isValidWallet(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(address).trim());
}
function parseAddresses(raw) {
    // separa por coma, espacio o salto de línea; filtra vacíos; unique; valida
    const parts = String(raw)
        .split(/[\s,;\n\r]+/g)
        .map(s => s.trim())
        .filter(Boolean);
    const unique = [...new Set(parts.map(p => p.toLowerCase()))];
    const invalid = unique.filter(a => !isValidWallet(a));
    return { list: unique, invalid };
}
const fmt = (n) => {
    const num = typeof n === 'string' ? Number(n) : n;
    return isFinite(num) ? num.toLocaleString('es-HN', { maximumFractionDigits: 6 }) : String(n);
};

/* =========================
   ESTADOS / SESIÓN
   ========================= */
const userStates = {};
const tempUserData = {};

export const STATES = {
    NONE: 'NONE',

    // Registro
    ASK_REGISTRATION: 'ASK_REGISTRATION',
    AWAITING_NAME: 'AWAITING_NAME',
    AWAITING_EMAIL: 'AWAITING_EMAIL',
    CONFIRM_EMAIL: 'CONFIRM_EMAIL',

    // Wallet (registro personal)
    ASK_WALLET_OPTION: 'ASK_WALLET_OPTION',
    AWAITING_WALLET_EXISTING: 'AWAITING_WALLET_EXISTING',
    CONFIRM_WALLET: 'CONFIRM_WALLET',

    // Menú principal
    REGISTERED: 'REGISTERED',
    AWAITING_OPTION: 'AWAITING_OPTION',
    MENU_SENT: 'MENU_SENT',

    // Comunitarias - navegación
    SELECT_COMMUNITY_WALLET: 'SELECT_COMMUNITY_WALLET',
    COMMUNITY_MENU: 'COMMUNITY_MENU',

    // Comunitarias - creación
    CREATE_COMMUNITY_NAME: 'CREATE_COMMUNITY_NAME',
    CREATE_COMMUNITY_DESC: 'CREATE_COMMUNITY_DESC',
    CREATE_COMMUNITY_MEMBERS: 'CREATE_COMMUNITY_MEMBERS',
    CREATE_COMMUNITY_CONFIRM: 'CREATE_COMMUNITY_CONFIRM',
};

/* =========================
   CLIENT WHATSAPP
   ========================= */
export async function startWhatsAppBot() {
    await connectDB();

    const client = new Client({ authStrategy: new LocalAuth() });

    client.on('qr', qr => {
        console.log('Escanea este QR con tu WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ [Bot] Cliente conectado y listo!');
    });

    client.on('message', async message => {
        const number = message.from.split('@')[0];
        const textRaw = (message.body ?? '').trim();
        const text = textRaw.toLowerCase();
        if (!tempUserData[number]) tempUserData[number] = {};

        // Salir
        if (['adios', 'adiós'].includes(text)) {
            userStates[number] = STATES.NONE;
            delete tempUserData[number];
            if (userTimeouts[number]) { clearTimeout(userTimeouts[number]); delete userTimeouts[number]; }
            await message.reply('👋 ¡Has salido de la conversación! Si deseas volver, solo envía cualquier mensaje.');
            return;
        }

        startUserTimeout(number, client);
        if (!userStates[number]) userStates[number] = STATES.NONE;
        const currentState = userStates[number];

        // BD
        const user = await findClient(number);

        /* ========== Inicio flujo si NO registrado ========== */
        if (!user && currentState === STATES.NONE) {
            await message.reply('🔐 No estás registrado en el sistema.');
            await message.reply('¿Deseas registrarte? (sí / no)\nRecuerda: puedes escribir "adiós" en cualquier momento para salir.');
            userStates[number] = STATES.ASK_REGISTRATION;
            return;
        }

        /* ========== Registro: ¿desea registrarse? ========== */
        if (currentState === STATES.ASK_REGISTRATION) {
            if (text === 'sí' || text === 'si') {
                await message.reply('Perfecto, comencemos. ¿Cuál es tu nombre completo?\n(Puedes escribir "adiós" para salir)');
                userStates[number] = STATES.AWAITING_NAME;
                tempUserData[number] = {};
            } else if (text === 'no') {
                await message.reply('Entendido. Si deseas registrarte más tarde, escribe "registrar".');
                userStates[number] = STATES.NONE;
            } else {
                await message.reply('Por favor responde con "sí" o "no".');
            }
            return;
        }

        /* ========== Registro: nombre ========== */
        if (currentState === STATES.AWAITING_NAME) {
            const nombre = textRaw.trim();
            if (!nombre) {
                await message.reply('Por favor envía un nombre válido.');
                return;
            }
            tempUserData[number].nombre = nombre;
            await message.reply('Gracias. Ahora, por favor proporciona tu correo electrónico.\n(Puedes escribir "adiós" para salir)');
            userStates[number] = STATES.AWAITING_EMAIL;
            return;
        }

        /* ========== Registro: email + confirmación ========== */
        if (currentState === STATES.AWAITING_EMAIL) {
            const rawEmail = textRaw.trim();
            if (!isValidEmail(rawEmail)) {
                await message.reply('❗ Correo inválido. Ejemplo válido: usuario@dominio.com\nIntenta de nuevo.\n(Puedes escribir "adiós" para salir)');
                return;
            }
            tempUserData[number].correo = rawEmail.toLowerCase();
            await message.reply(
                `📧 Recibí: *${tempUserData[number].correo}*\n¿Confirmas que este es tu correo? (sí / no)\n(Puedes escribir "adiós" para salir)`
            );
            userStates[number] = STATES.CONFIRM_EMAIL;
            return;
        }

        if (currentState === STATES.CONFIRM_EMAIL) {
            if (text === 'sí' || text === 'si') {
                await message.reply(
                    '¿Deseas ingresar la dirección de tu billetera ahora o registrarte en un servicio externo?\n\n' +
                    '1. Ingresar mi dirección de billetera\n' +
                    '2. Registrarme y obtener una billetera (te enviaré un link)\n\n' +
                    'Responde con "1" o "2".\n(Puedes escribir "adiós" para salir)'
                );
                userStates[number] = STATES.ASK_WALLET_OPTION;
            } else if (text === 'no') {
                await message.reply('De acuerdo. Envía nuevamente tu correo electrónico.\n(Puedes escribir "adiós" para salir)');
                userStates[number] = STATES.AWAITING_EMAIL;
            } else {
                await message.reply('Por favor responde "sí" o "no".');
            }
            return;
        }

        /* ========== Wallet (registro personal): opción ========== */
        if (currentState === STATES.ASK_WALLET_OPTION) {
            if (text === '1') {
                await message.reply('Por favor, escribe tu dirección de billetera (debe comenzar con "0x" y tener 42 caracteres).\n(Puedes escribir "adiós" para salir)');
                userStates[number] = STATES.AWAITING_WALLET_EXISTING;
                return;
            }
            if (text === '2') {
                await message.reply(
                    `🔗 Para registrarte y crear tu billetera, visita este enlace:\n👉 ${WALLET_REGISTER_URL}\n\n` +
                    'Cuando la tengas lista, por favor envía aquí tu dirección pública (la que empieza con "0x...").'
                );
                userStates[number] = STATES.AWAITING_WALLET_EXISTING;
                return;
            }
            await message.reply('Por favor responde con "1" o "2".');
            return;
        }

        /* ========== Wallet (registro personal): validar dirección ========== */
        if (currentState === STATES.AWAITING_WALLET_EXISTING) {
            const walletAddress = textRaw.trim();
            if (!isValidWallet(walletAddress)) {
                await message.reply('❗ Dirección inválida. Debe comenzar con "0x" y tener 42 caracteres. Inténtalo de nuevo.');
                return;
            }
            tempUserData[number].wallet = walletAddress;
            await message.reply(`📬 Recibí la dirección:\n${walletAddress}\n¿Confirmas que es correcta? (sí / no)`);
            userStates[number] = STATES.CONFIRM_WALLET;
            return;
        }

        /* ========== Wallet (registro personal): confirmación final -> guardar + menú ========== */
        if (currentState === STATES.CONFIRM_WALLET) {
            if (text === 'sí' || text === 'si') {
                // ✅ Normaliza a minúsculas
                const billeteraNorm = String(tempUserData[number].wallet);

                const newUser = {
                    celular: number,
                    nombre: tempUserData[number].nombre,
                    correo: tempUserData[number].correo,
                    billetera: billeteraNorm,
                    wallets: [], // opcional pero útil
                    createdAt: new Date()
                };

                const usersCollection = db.collection("users");
                await usersCollection.insertOne(newUser);

                await message.reply(`🎉 ¡Registro completado, ${newUser.nombre}!`);
                delete tempUserData[number];
                userStates[number] = STATES.AWAITING_OPTION;

                await message.reply(
                    '¿Qué puedo hacer por ti hoy?\n' +
                    '1. Revisar Saldo\n' +
                    '2. Crear wallet comunitaria\n' +
                    '3. Wallets comunitarias (ver)\n' +
                    'Escribe "adiós" en cualquier momento para salir.'
                );
                return;
            }
            if (text === 'no') {
                await message.reply('De acuerdo. Envía nuevamente tu dirección de billetera o elige una nueva opción.\n1. Ingresar dirección\n2. Registrarme con link');
                userStates[number] = STATES.ASK_WALLET_OPTION;
                return;
            }
            await message.reply('Por favor responde "sí" o "no".');
            return;
        }

        /* ========== Usuario YA registrado: menú directo ========== */
        if (user && currentState === STATES.NONE) {
            await message.reply(`¡Hola de nuevo, ${user.nombre || 'usuario'}!`);
            await message.reply(
                '¿Qué puedo hacer por ti hoy?\n' +
                '1. Revisar Saldo\n' +
                '2. Crear wallet comunitaria\n' +
                '3. Wallets comunitarias (ver)\n' +
                'Escribe "adiós" en cualquier momento para salir.'
            );
            userStates[number] = STATES.AWAITING_OPTION;
            return;
        }

        /* ========== Menú principal ========== */
        if (userStates[number] === STATES.AWAITING_OPTION) {
            switch (text) {
                /* ---- 1) Saldo personal + comunitario ---- */
                case '1': {
                    try {
                        const userDoc = await findClient(number);
                        const billetera = userDoc?.billetera || userDoc?.wallet;
                        if (!billetera) {
                            await message.reply(
                                '⚠️ No encuentro tu billetera registrada.\n' +
                                'Escribe "registrar" para registrarte.'
                            );
                            break;
                        }

                        const url = `${API_BASE_URL}/Saldos?wallet=${encodeURIComponent(billetera)}`;
                        const res = await fetch(url);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const data = await res.json();

                        await message.reply(
                            `📊 *Saldos para:* ${billetera}\n\n` +
                            `👤 *Tu wallet*\n` +
                            `• ETH: ${fmt(data.balanceWalletETH)}\n` +
                            `• HNL: ${fmt(data.balanceWalletHNL)}\n\n` +
                            `👥 *Total comunitario (tus wallets compartidas)*\n` +
                            `• ETH: ${fmt(data.totalComunitarioETH)}\n` +
                            `• HNL: ${fmt(data.totalComunitarioHNL)}\n\n` +
                            `Escribe:\n` +
                            `• "2" para crear wallet comunitaria\n` +
                            `• "3" para ver tus comunitarias\n` +
                            `• "adiós" para salir`
                        );
                    } catch (err) {
                        console.error('❌ [Bot] Error consultando saldo:', err);
                        await message.reply('❌ No pude obtener tu saldo en este momento. Intenta de nuevo más tarde.');
                    }
                    break;
                }

                /* ---- 2) Crear wallet comunitaria (flujo guiado) ---- */
                case '2': {

                    const userDoc = await findClient(number);
                    const creador = (userDoc?.billetera || userDoc?.wallet || '');
                    if (!creador) {
                        await message.reply('⚠️ Necesitas tener una billetera personal registrada para ser el creador. Escribe "registrar" para completar tu registro.');
                        break;
                    }

                    // ✅ Asegura el objeto de sesión y crea el subobjeto
                    if (!tempUserData[number]) tempUserData[number] = {};
                    tempUserData[number].createCommunity = { creador };

                    await message.reply('🧩 Vamos a crear tu wallet comunitaria.\n\n1/3) Escribe el *nombre* de la wallet (ej: "Coperacha Amigos").');
                    userStates[number] = STATES.CREATE_COMMUNITY_NAME;
                    break;
                }


                /* ---- 3) Ver/Navegar comunitarias existentes ---- */
                case '3': {
                    const userDoc = await findClient(number);
                    const list = userDoc?.wallets || [];
                    if (!list.length) {
                        await message.reply('Aún no perteneces a una wallet comunitaria.');
                        break;
                    }

                    tempUserData[number] = tempUserData[number] || {};
                    tempUserData[number].comunitarias = list;

                    const menu = list.map((w, idx) => `${idx + 1}. ${w}`).join('\n');
                    await message.reply(
                        `Estas son tus wallets comunitarias:\n${menu}\n\n` +
                        `Envía el número de la wallet que quieres consultar.`
                    );
                    userStates[number] = STATES.SELECT_COMMUNITY_WALLET;
                    break;
                }

                default:
                    await message.reply('❗ Opción no válida. Responde con 1, 2 o 3. También puedes escribir "adiós" para salir.');
                    break;
            }
            return;
        }

        /* ========== Flujo: CREAR wallet comunitaria ========== */

        // 1/3 Nombre
        if (userStates[number] === STATES.CREATE_COMMUNITY_NAME) {
            if (!tempUserData[number]) tempUserData[number] = {};
            if (!tempUserData[number].createCommunity) tempUserData[number].createCommunity = {};

            const nombre = textRaw.trim();
            if (!nombre) {
                await message.reply('Por favor envía un nombre válido.');
                return;
            }
            tempUserData[number].createCommunity = tempUserData[number].createCommunity || {};
            tempUserData[number].createCommunity.nombre = nombre;
            await message.reply('2/3) Escribe una *descripción* (breve). Si no deseas agregarla, escribe "skip".');
            userStates[number] = STATES.CREATE_COMMUNITY_DESC;
            return;
        }

        // 2/3 Descripción (opcional)
        if (userStates[number] === STATES.CREATE_COMMUNITY_DESC) {
            if (!tempUserData[number]) tempUserData[number] = {};
            if (!tempUserData[number].createCommunity) tempUserData[number].createCommunity = {};


            const desc = (text === 'skip') ? '' : textRaw;
            tempUserData[number].createCommunity.descripcion = desc;

            await message.reply(
                '3/3) Pega las *direcciones de los miembros* (0x...) separadas por *coma*, *espacio* o *nueva línea*.\n' +
                'Ejemplo:\n0xabc..., 0xdef..., 0x123...\n\n' +
                '(Puedes incluirte a ti mismo si quieres)'
            );
            userStates[number] = STATES.CREATE_COMMUNITY_MEMBERS;
            return;
        }

        // 3/3 Miembros
        if (userStates[number] === STATES.CREATE_COMMUNITY_MEMBERS) {
            if (!tempUserData[number]) tempUserData[number] = {};
            if (!tempUserData[number].createCommunity) tempUserData[number].createCommunity = {};

            const { list, invalid } = parseAddresses(textRaw);
            const creador = (tempUserData[number].createCommunity.creador || '');
            const set = new Set(list);        // 'list' ya viene en minúsculas por parseAddresses
            
            if (creador) set.add(creador);
            const finalMembers = [...set];

            // guarda finalMembers en la sesión
            tempUserData[number].createCommunity.miembros = finalMembers;
            if (!list.length) {
                await message.reply('❗ No detecté direcciones válidas. Vuelve a enviarlas por favor.');
                return;
            }
            if (invalid.length) {
                await message.reply(`⚠️ Estas direcciones no son válidas:\n${invalid.join('\n')}\n\nEnvía nuevamente la lista completa, corrigiendo las inválidas.`);
                return;
            }

            const resumen =
                `Nombre: ${tempUserData[number].createCommunity.nombre}\n` +
                `Descripción: ${tempUserData[number].createCommunity.descripcion || '—'}\n` +
                `Creador: ${tempUserData[number].createCommunity.creador}\n` +
                `Miembros (${finalMembers.length}):\n- ${finalMembers.join('\n- ')}`;
            await message.reply(
                `✅ Revisa la configuración:\n\n${resumen}\n\n` +
                `¿Confirmas la creación? (sí / no)`
            );
            userStates[number] = STATES.CREATE_COMMUNITY_CONFIRM;
            return;
        }

        // Confirmar -> POST /createWallet
        if (userStates[number] === STATES.CREATE_COMMUNITY_CONFIRM) {
            if (text === 'sí' || text === 'si') {
                try {
                    const payload = {
                        miembros: tempUserData[number].createCommunity.miembros,
                        creador: tempUserData[number].createCommunity.creador,
                        nombre: tempUserData[number].createCommunity.nombre,
                        descripcion: tempUserData[number].createCommunity.descripcion || ''
                    };
                    const res = await fetch(`${API_BASE_URL}/createWallet`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    if (!res.ok) {
                        const errData = await res.json().catch(() => ({}));
                        throw new Error(errData?.error || errData?.message || `HTTP ${res.status}`);
                    }
                    const data = await res.json();

                    await message.reply(
                        `🎉 *Wallet comunitaria creada con éxito*\n` +
                        `• Address: ${data.walletAddress || '—'}\n` +
                        `• Tx: ${data.txHash || '—'}\n\n` +
                        `Los miembros que enviaste quedarán asociados en Mongo.\n` +
                        `Escribe "3" para ver tus comunitarias o "1" para ver saldo.`
                    );
                } catch (e) {
                    console.error('❌ [Bot] error creando wallet comunitaria:', e);
                    await message.reply(`❌ No se pudo crear la wallet comunitaria.\nDetalle: ${e.message || e}`);
                } finally {
                    // limpiar y volver a menú
                    delete tempUserData[number]?.createCommunity;
                    userStates[number] = STATES.AWAITING_OPTION;
                }
                return;
            }

            if (text === 'no') {
                delete tempUserData[number]?.createCommunity;
                await message.reply('Creación cancelada. Volviendo al menú.\n1 Saldo • 2 Crear comunitaria • 3 Ver comunitarias');
                userStates[number] = STATES.AWAITING_OPTION;
                return;
            }

            await message.reply('Responde "sí" para crear o "no" para cancelar.');
            return;
        }

        /* ========== Navegación: seleccionar wallet comunitaria y submenú ========== */

        if (userStates[number] === STATES.SELECT_COMMUNITY_WALLET) {
            const idx = Number(text);
            const list = tempUserData[number]?.comunitarias || [];
            if (!idx || idx < 1 || idx > list.length) {
                await message.reply('Selecciona un número válido de la lista.');
                return;
            }
            const selected = list[idx - 1];
            tempUserData[number].selectedCommunity = selected;

            await message.reply(
                `Has seleccionado:\n${selected}\n\n` +
                `Opciones:\n` +
                `a) Dashboard resumido\n` +
                `b) Aportes por persona\n` +
                `c) Propuestas + últimas tx\n\n` +
                `Escribe a, b o c.`
            );
            userStates[number] = STATES.COMMUNITY_MENU;
            return;
        }

        if (userStates[number] === STATES.COMMUNITY_MENU) {
            const w = tempUserData[number]?.selectedCommunity;
            if (!w) {
                await message.reply('No encontré la wallet seleccionada. Envía 3 para listar de nuevo.');
                userStates[number] = STATES.AWAITING_OPTION;
                return;
            }

            if (text === 'a') {
                // Dashboard
                try {
                    const res = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(w)}/dashboard`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const d = await res.json();

                    const saldo = d?.saldo || {};
                    const miembros = d?.miembros || [];
                    const props = d?.propuestas || {};

                    await message.reply(
                        `📊 *Dashboard* (${w})\n\n` +
                        `💰 Saldo: ${fmt(saldo.eth)} ETH (${fmt(saldo.hnl)} HNL)\n` +
                        `👥 Miembros: ${miembros.length}\n` +
                        `🗳️ Propuestas: total ${props.total || 0} • pend ${props.pendientes || 0} • ejec ${props.ejecutadas || 0} • exp ${props.expiradas || 0}\n\n` +
                        `b) Ver aportes • c) Ver propuestas • "menu" para volver`
                    );
                } catch (e) {
                    console.error('❌ [Bot] dashboard error:', e);
                    await message.reply('❌ No pude obtener el dashboard ahora.');
                }
                return;
            }

            if (text === 'b') {
                // Aportes por persona
                try {
                    const res = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(w)}/aportes`);
                    if (res.status === 501) {
                        await message.reply('⚠️ Esta función no está habilitada en el nodo. Contacta al admin para activarla en QuickNode.');
                        return;
                    }
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const d = await res.json();
                    const arr = d?.aportes || [];
                    if (!arr.length) {
                        await message.reply('No hay aportes registrados aún.');
                        return;
                    }
                    const lines = arr.slice(0, 10).map((a, i) =>
                        `#${i + 1} ${a.address.slice(0, 10)}… • ${fmt(a.totalETH)} ETH (${fmt(a.totalHNL)} HNL)`
                    ).join('\n');
                    await message.reply(`🏅 *Top aportes* (${w})\n\n${lines}\n\nc) Ver propuestas • "menu" volver`);
                } catch (e) {
                    console.error('❌ [Bot] aportes error:', e);
                    await message.reply('❌ No pude obtener los aportes ahora.');
                }
                return;
            }

            if (text === 'c') {
                // Propuestas + tx
                try {
                    const res = await fetch(`${API_BASE_URL}/wallets/${encodeURIComponent(w)}/propuestas-historial`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const d = await res.json();

                    const props = d?.propuestas || [];
                    const txs = d?.ultimasTx || [];

                    const propsTxt = props.slice(0, 5).map(p =>
                        `#${p.id} • ${p.tipo === 0 ? 'GASTO' : 'MIEMBRO'} • ${fmt(p.montoETH)} ETH • conf ${p.confirmaciones} • ${p.estado === 0 ? 'Pendiente' : p.estado === 1 ? 'Ejecutada' : 'Expirada'}`
                    ).join('\n') || '—';

                    const txTxt = txs.map(t =>
                        `${t.tipo.toUpperCase()} • ${fmt(t.montoETH)} ETH • ${t.age} • ${t.hash.slice(0, 10)}…`
                    ).join('\n') || '—';

                    await message.reply(
                        `📑 *Propuestas* (${w})\n${propsTxt}\n\n` +
                        `🔁 *Últimas tx*\n${txTxt}\n\n` +
                        `"menu" para volver`
                    );
                } catch (e) {
                    console.error('❌ [Bot] historial error:', e);
                    await message.reply('❌ No pude obtener el historial ahora.');
                }
                return;
            }

            if (text === 'menu') {
                userStates[number] = STATES.AWAITING_OPTION;
                await message.reply('Regresando al menú principal:\n1 Saldo • 2 Crear wallet comunitaria • 3 Ver comunitarias • "adiós" salir');
                return;
            }

            await message.reply('Elige a, b o c. O escribe "menu" para volver.');
            return;
        }

        /* ========== Comando "registrar" global ========== */
        if (text === 'registrar') {
            if (user) {
                await message.reply('Ya estás registrado. Usa el menú con "1", "2" o "3".');
            } else {
                await message.reply('¿Deseas registrarte? (sí / no)');
                userStates[number] = STATES.ASK_REGISTRATION;
            }
            return;
        }
    });

    client.initialize();
    return client;
}
