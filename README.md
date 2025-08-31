# 📖 Proyecto Coperacha – Backend + Bot de WhatsApp

Este proyecto combina:

* **Backend en Node.js/Express** con conexión a MongoDB.
* **Integración con contratos inteligentes en Arbitrum Sepolia** (vía `ethers.js`).
* **Bot de WhatsApp** usando [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) para interactuar con usuarios.
* API REST con endpoints para usuarios, wallets comunitarias y propuestas.

---

## 🚀 Requisitos previos

* **Node.js** v16 o superior.
* **MongoDB** (local o remoto).
* Una cuenta en **QuickNode** (o cualquier proveedor RPC compatible).
* Una billetera con fondos en **Arbitrum Sepolia** (para gas en contratos).

---

## 📦 Instalación

```bash
git clone <URL_DEL_REPO>
cd coperacha-backend
npm init -y
npm install express cors mongodb dotenv whatsapp-web.js qrcode-terminal ethers
```

---

## ⚙️ Variables de entorno

Crea un archivo `.env` en la raíz del proyecto con el siguiente contenido:

```env
# Mongo
MONGO_URI=mongodb://localhost:27017

# Servidor
PORT=5000

# QuickNode / Arbitrum Sepolia
QUICK_NODE_API=tu_api_key
CONTRACT_ADDRESS=0xTuContratoPrincipal
Private_Key=0xTuClavePrivada # (cuenta del creador, ¡mantener seguro!)

# Conversión ETH→HNL (fallback si no está en MongoDB.config)
ETH_TO_HNL=80000

# WhatsApp
WALLET_REGISTER_URL=https://metamask.io/download
```

---

## ▶️ Ejecución

```bash
node index.js
```

La primera vez, verás un **QR** en la consola.
Escanéalo con WhatsApp (cuenta que administrará el bot).

---

## 🤖 Bot de WhatsApp

El bot gestiona el **registro de usuarios** vía chat:

1. El usuario envía un mensaje → el bot detecta si está registrado.
2. Flujo de registro: nombre → correo → confirmación → wallet (ingresar o link externo).
3. Se guarda en MongoDB (`users`).
4. Menú principal:

   * `1` Ver saldo
   * `2` Ver aportaciones
   * `3` Ver votos

### Comandos especiales

* `adiós` → salir y limpiar sesión.
* `registrar` → iniciar registro manualmente.

### Timeout

Si el usuario no responde en **5 minutos**, se cierra la sesión automáticamente.

---

## 🗄️ Estructura de MongoDB

Colección **users**:

```json
{
  "correo": "user@mail.com",
  "nombre": "Nombre Apellido",
  "celular": "504XXXXXXXX",
  "billetera": "0x...",
  "wallets": ["0xWalletComunitaria1", "0xWalletComunitaria2"],
  "createdAt": "2025-01-01T12:00:00.000Z"
}
```

Colección **config**:

```json
{
  "_id": "fx",
  "ethToHnl": 80000
}
```

---

## 🌐 API REST – Endpoints principales

### 👤 Usuarios

* `POST /createUser` → crear usuario.
* `GET /users` → listar usuarios.
* `GET /users/email/:correo` → buscar por correo.
* `GET /users/phone/:celular` → buscar por celular.
* `GET /users/wallet/:billetera` → buscar por billetera.

### 💰 Wallet Comunitaria

* `POST /createWallet` → crear wallet comunitaria en contrato.
* `GET /wallets` → listar todas.
* `GET /wallets/:walletAddress/users` → usuarios en una wallet.

### 📑 Propuestas

* `POST /proponerGasto` → crear propuesta de gasto.
* `POST /proponerMiembro` → propuesta para nuevo miembro.
* `POST /wallets/:walletAddress/votar` → votar una propuesta.

### 📊 Información

* `GET /Saldos?wallet=0x...` → saldos (personal y comunitarios).
* `GET /wallets/personal/:address/txs` → últimas transacciones de wallet personal.
* `GET /wallets/:walletAddress/aportes` → aportes por usuario.
* `GET /wallets/:walletAddress/propuestas-historial` → historial completo.
* `GET /wallets/:walletAddress/dashboard` → resumen de dashboard.

### ⚙️ Configuración

* `GET /config/exchange-rate` → obtener tasa ETH→HNL.
* `POST /config/exchange-rate` → actualizar tasa manual.

---

## 🛠️ Conversión ETH ↔ HNL

El helper `convert` permite:

* `weiToEth`, `ethToWei`
* `weiToHnl`, `ethToHnl`, `hnlToEth`, `hnlToWei`

Fuente de la tasa:

1. Lee de `config.ethToHnl` en MongoDB.
2. Si no existe, usa fallback `.env:ETH_TO_HNL`.

---

## 📌 Notas importantes

* La clave privada en `.env` debe mantenerse **segura**. Nunca subir a GitHub.
* `whatsapp-web.js` guarda sesión en carpeta `.wwebjs_auth` (puedes borrarla para resetear login).
* Algunos endpoints (`qn_getTransactionsByAddress`, `qn_getTransfersByAddress`) requieren que tu nodo QuickNode los tenga habilitados.
