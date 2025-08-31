import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import pkgqr from 'qrcode-terminal';
const qrcode = pkgqr;
import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ---- ENV & DB -----------------------------------------
const clientMongo = new MongoClient(process.env.MONGO_URI);
const walletRegisterUrl = process.env.WALLET_REGISTER_URL || 'https://metamask.io/download';
let db;

async function connectDB() {
    try {
        await clientMongo.connect();
        db = clientMongo.db("coperacha");
        console.log("✅ Conectado a MongoDB");
    } catch (err) {
        console.error("❌ Error conectando a MongoDB:", err);
    }
}
await connectDB();

async function findClient(celular) {
    try {
        const usersCollection = db.collection("users");
        const user = await usersCollection.findOne({ celular });
        return user;
    } catch (error) {
        console.error("❌ Error buscando usuario por celular:", error);
        return null;
    }
}

// ---- TIMEOUT POR INACTIVIDAD ---------------------------
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
            console.error(`❌ Error al enviar mensaje de timeout a ${number}:`, err);
        }
    }, 5 * 60 * 1000); // 5 min
}

// ---- VALIDACIONES -------------------------------------
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
function isValidEmail(value) {
    return EMAIL_REGEX.test(String(value).trim());
}
function isValidWallet(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

// ---- WHATSAPP CLIENT ----------------------------------
const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', qr => {
    console.log('Escanea este QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Cliente conectado y listo!');
});

// ---- ESTADOS & SESIONES --------------------------------
const userStates = {};
const tempUserData = {};

const STATES = {
    NONE: 'NONE',                         // Sin flujo activo
    // Registro
    ASK_REGISTRATION: 'ASK_REGISTRATION', // ¿Deseas registrarte? (sí/no)
    AWAITING_NAME: 'AWAITING_NAME',       // Esperando nombre completo
    AWAITING_EMAIL: 'AWAITING_EMAIL',     // Esperando correo
    CONFIRM_EMAIL: 'CONFIRM_EMAIL',       // Confirmación correo (sí/no)
    // Wallet
    ASK_WALLET_OPTION: 'ASK_WALLET_OPTION',           // 1=ingresar dirección, 2=recibir link
    AWAITING_WALLET_EXISTING: 'AWAITING_WALLET_EXISTING', // Esperando dirección pegada por el usuario
    CONFIRM_WALLET: 'CONFIRM_WALLET',                 // Confirmación de la dirección (sí/no)
    // Menú
    REGISTERED: 'REGISTERED',             // Usuario guardado (informativo)
    AWAITING_OPTION: 'AWAITING_OPTION',   // Esperando opción de menú (1/2/3)
    MENU_SENT: 'MENU_SENT'                // Menú enviado
};

// ---- HANDLER PRINCIPAL --------------------------------

client.on('message', async message => {
    const number = message.from.split('@')[0];          
    const textRaw = message.body.trim();
    const text = textRaw.toLowerCase();

    // Comando global de salida
    if (['adios', 'adiós'].includes(text)) {
        userStates[number] = STATES.NONE;
        delete tempUserData[number];
        if (userTimeouts[number]) { clearTimeout(userTimeouts[number]); delete userTimeouts[number]; }
        await message.reply('👋 ¡Has salido de la conversación! Si deseas volver, solo envía cualquier mensaje.');
        return;
    }

    startUserTimeout(number, client); // reinicia timeout en cada mensaje válido

    if (!userStates[number]) userStates[number] = STATES.NONE;
    const currentState = userStates[number];

    // Consultar si ya existe en BD
    const user = await findClient(number);

    // 1) Usuario NO registrado: iniciar flujo de registro
    if (!user && currentState === STATES.NONE) {
        await message.reply('🔐 No estás registrado en el sistema.');
        await message.reply('¿Deseas registrarte? (sí / no)\nRecuerda: puedes escribir "adiós" en cualquier momento para salir.');
        userStates[number] = STATES.ASK_REGISTRATION;
        return;
    }

    // 2) Preguntar si desea registrarse
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

    // 3) Nombre
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

    // 4) Correo + confirmación
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

    // 5) Wallet: opción
    if (currentState === STATES.ASK_WALLET_OPTION) {
        if (text === '1') {
            await message.reply('Por favor, escribe tu dirección de billetera (debe comenzar con "0x" y tener 42 caracteres).\n(Puedes escribir "adiós" para salir)');
            userStates[number] = STATES.AWAITING_WALLET_EXISTING;
            return;
        }
        if (text === '2') {
            await message.reply(
                `🔗 Para registrarte y crear tu billetera, visita este enlace:\n👉 ${walletRegisterUrl}\n\n` +
                'Cuando la tengas lista, por favor envía aquí tu dirección pública (la que empieza con "0x...").'
            );
            userStates[number] = STATES.AWAITING_WALLET_EXISTING;
            return;
        }
        await message.reply('Por favor responde con "1" o "2".');
        return;
    }

    // 6) Wallet: validación de dirección
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

    // 7) Confirmación final de wallet -> Guardar en BD + menú
    if (currentState === STATES.CONFIRM_WALLET) {
        if (text === 'sí' || text === 'si') {
            const newUser = {
                celular: number,
                nombre: tempUserData[number].nombre,
                correo: tempUserData[number].correo,
                wallet: tempUserData[number].wallet,
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
                '2. Revisar aportaciones\n' +
                '3. Revisar votos\n' +
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

    // 8) Usuario ya registrado -> menú
    if (user && currentState === STATES.NONE) {
        await message.reply(`¡Hola de nuevo, ${user.nombre || 'usuario'}!`);
        await message.reply(
            '¿Qué puedo hacer por ti hoy?\n' +
            '1. Revisar Saldo\n' +
            '2. Revisar aportaciones\n' +
            '3. Revisar votos\n' +
            'Escribe "adiós" en cualquier momento para salir.'
        );
        userStates[number] = STATES.AWAITING_OPTION;
        return;
    }

    // 9) Menú principal
    if (userStates[number] === STATES.AWAITING_OPTION) {
        switch (text) {
            case '1':
                await message.reply('Tu saldo actual es: $XXX');
                break;
            case '2':
                await message.reply('Has aportado: XX veces');
                break;
            case '3':
                await message.reply('Tienes XX votos.');
                break;
            default:
                await message.reply('❗ Opción no válida. Responde con 1, 2 o 3. También puedes escribir "adiós" para salir.');
                break;
        }
        return;
    }

    // 10) Comando "registrar" en cualquier momento
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

export async function startWhatsAppBot() {
  client.initialize();
  return client; 
}
