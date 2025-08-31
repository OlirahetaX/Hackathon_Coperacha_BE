import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { ethers } from "ethers";
import cors from "cors";
import { startWhatsAppBot } from './WhatsappBot.js';


dotenv.config();

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// MongoDB connection
const clientMongo = new MongoClient(process.env.MONGO_URI, {
  tls: true,
  tlsInsecure: false,
  minPoolSize: 1,
  maxPoolSize: 10,
});
let db;
const PORT = process.env.PORT || 5000;

async function connectDB() {
  try {
    await clientMongo.connect();
    db = clientMongo.db("coperacha");
    console.log("Connected to MongoDB (native driver)");
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    // índices útiles
    await db.collection("users").createIndex({ correo: 1 }, { unique: true }).catch(() => { });
    await db.collection("users").createIndex({ celular: 1 }, { unique: true }).catch(() => { });
    await db.collection("users").createIndex({ billetera: 1 }, { unique: true }).catch(() => { });
    await db.collection("config").createIndex({ _id: 1 }, { unique: true }).catch(() => { });
  } catch (err) {
    console.error("MongoDB connection error:", err);
  }
}
connectDB();

function normalizeAddress(a) {
  return String(a || '').toLowerCase();
}


(async () => {
  try {
    const client = await startWhatsAppBot();
    console.log("🤖 Bot de WhatsApp iniciado desde otro proyecto");
  } catch (err) {
    console.error("❌ Error al iniciar el bot:", err);
  }
})();

// Conectar a Arbitrum Sepolia via QuickNode
const url = `https://white-young-road.arbitrum-sepolia.quiknode.pro/${process.env.QUICK_NODE_API}`;
const customHttpProvider = new ethers.JsonRpcProvider(url);

const addressContract = process.env.CONTRACT_ADDRESS;
const signer = new ethers.Wallet(process.env.Private_Key, customHttpProvider);

// ABIs
const MonederoABI = [
  "function create(address[] _miembros, address _creador, string _nombre, string _descripcion) returns (address)",
  "function getAllWallets() view returns (address[])",
  "event WalletCreated(address indexed owner, address walletAddress)",
];

const BilleteraABI = [
  "function crearPropuesta(address _destinatario, address _miembro, uint256 _monto, string _descripcion, bool _esGasto)",
  "function verPropuesta(uint256 _idPropuesta) view returns (address destinatario, uint256 monto, string descripcion, uint256 fechaLimite, uint256 confirmaciones, uint8 tipo, uint8 estado)",
  "function confirmarPropuesta(uint256 _idPropuesta, address _miembro)",
  "function totalPropuestas() view returns (uint256)",
  "function saldoWallet() view returns (uint256)"
];

const contract = new ethers.Contract(addressContract, MonederoABI, signer);

// Inicializar WhatsApp client (opcional)
const client = new Client({ authStrategy: new LocalAuth() });
// client.initialize().catch(()=>{});

// =======================
// Helpers de conversión
// =======================
async function getEthToHnlRate() {
  try {
    const cfg = await db.collection("config").findOne({ _id: "fx" });
    if (cfg && typeof cfg.ethToHnl === "number" && cfg.ethToHnl > 0) {
      return cfg.ethToHnl;
    }
  } catch { }
  // fallback "enduro": puedes ajustar por .env
  const fallback = Number(process.env.ETH_TO_HNL) || 80000; // 1 ETH ≈ 80,000 HNL (ejemplo)
  return fallback;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
const convert = {
  // entradas: number | string | bigint
  weiToEth: (wei) => Number(ethers.formatEther(wei.toString())),
  ethToWei: (eth) => ethers.parseEther(String(eth)),
  async weiToHnl(wei) {
    const rate = await getEthToHnlRate();
    return round2(Number(ethers.formatEther(wei.toString())) * rate);
  },
  async ethToHnl(eth) {
    const rate = await getEthToHnlRate();
    return round2(Number(eth) * rate);
  },
  async hnlToEth(hnl) {
    const rate = await getEthToHnlRate();
    return Number(hnl) / rate;
  },
  async hnlToWei(hnl) {
    const eth = await convert.hnlToEth(hnl);
    return ethers.parseEther(String(eth));
  },
};

// fecha “hace X”
function timeAgoFromTsSec(tsSec) {
  const now = Date.now();
  const diffMs = now - tsSec * 1000;
  const s = Math.floor(diffMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `hace ${d} día${d > 1 ? 's' : ''}`;
  if (h > 0) return `hace ${h} hora${h > 1 ? 's' : ''}`;
  if (m > 0) return `hace ${m} minuto${m > 1 ? 's' : ''}`;
  return `hace ${s} segundo${s !== 1 ? 's' : ''}`;
}

// =======================
// Rutas
// =======================

app.get("/", (req, res) => res.send("Hola desde backend"));

/*
    USUARIO
*/

// Crear usuario
app.post("/createUser", async (req, res) => {
  try {
    const { correo, nombre, celular, billetera } = req.body;

    billetera = normalizeAddress(billetera);

    if (!correo || !nombre || !celular || !billetera) {
      return res
        .status(400)
        .json({ message: "Todos los campos son requeridos." });
    }

    const usersCollection = db.collection("users");

    // Validaciones únicas
    const [userExistEmail, userExistPhone, userExistWallet] = await Promise.all([
      usersCollection.findOne({ correo }),
      usersCollection.findOne({ celular }),
      usersCollection.findOne({ billetera }),
    ]);

    if (userExistEmail) return res.status(400).json({ message: "El correo ya existe." });
    if (userExistPhone) return res.status(400).json({ message: "El celular ya existe." });
    if (userExistWallet) return res.status(400).json({ message: "La billetera ya existe." });

    const result = await usersCollection.insertOne({
      correo,
      nombre,
      celular,
      billetera,
      wallets: [], // por si no la agregas al crear wallet comunitaria
      createdAt: new Date(),
    });

    res.status(201).json({
      message: "Usuario creado exitosamente.",
      userId: result.insertedId,
    });
  } catch (error) {
    console.error("❌ Error creando usuario:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

// Listar todos los usuarios
app.get("/users", async (req, res) => {
  try {
    const users = await db.collection("users").find({}).toArray();
    res.status(200).json(users);
  } catch (error) {
    console.error("❌ Error obteniendo usuarios:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

// Buscar usuario por correo
app.get("/users/email/:correo", async (req, res) => {
  try {
    const user = await db.collection("users").findOne({ correo: req.params.correo });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado." });
    res.status(200).json(user);
  } catch (error) {
    console.error("❌ Error buscando usuario por correo:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

// Buscar usuario por celular
app.get("/users/phone/:celular", async (req, res) => {
  try {
    const user = await db.collection("users").findOne({ celular: req.params.celular });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado." });
    res.status(200).json(user);
  } catch (error) {
    console.error("❌ Error buscando usuario por celular:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

app.get("/users/wallet/:billetera", async (req, res) => {
  try {
    const bLower = normalizeAddress(req.params.billetera);
    const user = await db.collection("users").findOne({ billetera: bLower });
    if (!user) return res.status(404).json({ message: "Usuario no encontrado." });
    res.status(200).json(user);
  } catch (error) {
    console.error("❌ Error buscando usuario por billetera:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

/*
    WALLET COMUNITARIA
*/

// Crear Wallet Comunitaria
app.post("/createWallet", async (req, res) => {
  try {
    const { miembros, creador, nombre, descripcion } = req.body;
    if (!Array.isArray(miembros) || miembros.length === 0 || !creador) {
      return res
        .status(400)
        .json({ error: "Debe enviar un array de miembros y un creador" });
    }

    const tx = await contract.create(miembros, creador, nombre || "", descripcion || "");
    const receipt = await tx.wait();

    const event = receipt.logs
      .map((log) => {
        try { return contract.interface.parseLog(log); } catch { return null; }
      })
      .find((e) => e && e.name === "WalletCreated");

    const walletAddress =creador;

if (walletAddress) {
      await db.collection("users").updateMany(
        { billetera: { $in: miembros } },
        { $addToSet: { wallets: walletAddress } }
      );
    }

    res.json({
      message: "Wallet creada con éxito",
      txHash: receipt.transactionHash,
      walletAddress,
    });
  } catch (error) {
    console.error("❌ Error en /createWallet:", error);
    res.status(500).json({
      error: error.reason || error.shortMessage || error.message || "Error desconocido",
    });
  }
});

// obtener todas las wallets comunitarias
app.get("/wallets", async (req, res) => {
  try {
    const wallets = await contract.getAllWallets();
    res.json({ wallets });
  } catch (error) {
    console.error("Error en /wallets:", error);
    res.status(500).json({ error: "Error al obtener wallets" });
  }
});

// Obtener usuarios que pertenecen a una wallet
app.get("/wallets/:walletAddress/users", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const users = await db.collection("users").find({ wallets: walletAddress }).toArray();
    if (users.length === 0) return res.status(404).json({ message: "No se encontraron usuarios para esta wallet" });
    res.status(200).json({ users });
  } catch (error) {
    console.error("❌ Error obteniendo usuarios por wallet:", error);
    res.status(500).json({ message: "Error en el servidor" });
  }
});

/*
    PROPUESTA DE GASTOS / MIEMBROS
*/

// Crear propuesta de GASTO
app.post("/proponerGasto", async (req, res) => {
  try {
    const { walletAddress, destinatario, descripcion, miembro, monto, unidad } = req.body;
    if (!walletAddress || !destinatario || !descripcion || !miembro || monto == null) {
      return res.status(400).json({ message: "Faltan campos requeridos: walletAddress, destinatario, descripcion, miembro, monto" });
    }

    const walletContract = new ethers.Contract(walletAddress, BilleteraABI, signer);

    // convertir a wei según unidad
    let montoWei;
    const u = (unidad || "eth").toLowerCase(); // 'wei' | 'eth' | 'hnl'
    if (u === "wei") montoWei = BigInt(monto);
    else if (u === "hnl") montoWei = await convert.hnlToWei(monto);
    else montoWei = ethers.parseEther(String(monto)); // eth por defecto

    const tx = await walletContract.crearPropuesta(destinatario, miembro, montoWei, descripcion, true);
    const receipt = await tx.wait();

    res.status(201).json({
      message: "Propuesta de gasto creada",
      txHash: receipt.transactionHash,
    });
  } catch (error) {
    console.error("❌ Error en /proponerGasto:", error);
    res.status(500).json({ error: error.reason || error.message });
  }
});

// Crear propuesta de NUEVO MIEMBRO
app.post("/proponerMiembro", async (req, res) => {
  try {
    const { walletAddress, nuevoMiembro, descripcion, miembro } = req.body;
    if (!walletAddress || !nuevoMiembro || !descripcion || !miembro) {
      return res.status(400).json({ message: "walletAddress, nuevoMiembro, descripcion y miembro son requeridos." });
    }
    const walletContract = new ethers.Contract(walletAddress, BilleteraABI, signer);
    // monto=0, _esGasto=false
    const tx = await walletContract.crearPropuesta(nuevoMiembro, miembro, 0, descripcion, false);
    const receipt = await tx.wait();

    res.status(201).json({
      message: "Propuesta para nuevo miembro creada exitosamente",
      txHash: receipt.transactionHash,
    });
  } catch (error) {
    console.error("❌ Error en /proponerMiembro:", error);
    res.status(500).json({
      error: error.reason || error.shortMessage || error.message || "Error desconocido",
    });
  }
});

// CONFIRMAR PROPUESTA (VOTAR)
app.post("/wallets/:walletAddress/votar", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const { idPropuesta, miembro } = req.body;

    if (!walletAddress || idPropuesta === undefined || !miembro) {
      return res.status(400).json({ message: "Se requiere walletAddress, idPropuesta y miembro." });
    }

    const walletContract = new ethers.Contract(walletAddress, BilleteraABI, signer);
    const tx = await walletContract.confirmarPropuesta(idPropuesta, miembro);
    const receipt = await tx.wait();

    res.status(200).json({
      message: "Propuesta confirmada exitosamente",
      txHash: receipt.transactionHash,
    });
  } catch (error) {
    console.error("❌ Error en /wallets/:walletAddress/votar:", error);
    if (String(error.message || "").includes("La propuesta ha expirado")) {
      return res.status(400).json({ message: "La propuesta ha expirado." });
    }
    res.status(500).json({
      error: error.reason || error.shortMessage || error.message || "Error desconocido",
    });
  }
});

// validar que el usuario esta registrado (FIX: usar billetera)
app.get("/walletRegistrada", async (req, res) => {
  try {
    //const { wallet } = req.query;
    const wallet = normalizeAddress(req.query.wallet);
    if (!wallet) {
      return res.status(400).json({ message: "⚠️ Se requiere 'wallet' en query params." });
    }
    const usuario = await db.collection("users").findOne({ billetera: wallet });
    res.status(200).json({ registrada: !!usuario });
  } catch (error) {
    console.error("❌ Error verificando wallet:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

app.get("/Saldos", async (req, res) => {
  try {
    //const { wallet } = req.query;
    const wallet = normalizeAddress(req.query.wallet);
    if (!wallet) {
      return res.status(400).json({ message: "⚠️ Se requiere 'wallet' en query params." });
    }

    const usersCollection = db.collection("users");
    const usuario = await usersCollection.findOne({ billetera: wallet });

    let totalComunitarioWei = 0n;
    if (usuario) {
      const walletsComunitarias = usuario.wallets || [];
      const BilleteraSaldoABI = ["function saldoWallet() view returns (uint256)"];

      for (const w of walletsComunitarias) {
        try {
          const walletContract = new ethers.Contract(w, BilleteraSaldoABI, customHttpProvider);
          const balance = await walletContract.saldoWallet();
          totalComunitarioWei += BigInt(balance);
        } catch (err) {
          console.error(`⚠️ Error consultando wallet comunitaria ${w}:`, err);
        }
      }
    }

    const balanceUserWei = await customHttpProvider.getBalance(wallet);

    res.status(200).json({
      balanceWalletETH: ethers.formatEther(balanceUserWei),
      balanceWalletHNL: await convert.weiToHnl(balanceUserWei),
      totalComunitarioETH: ethers.formatEther(totalComunitarioWei),
      totalComunitarioHNL: await convert.weiToHnl(totalComunitarioWei),
    });
  } catch (error) {
    console.error("❌ Error en /Saldos:", error);
    res.status(500).json({ message: "Error en el servidor." });
  }
});

/* =========================
   NUEVOS ENDPOINTS PEDIDOS
   ========================= */

// 1) Últimas N transacciones de una wallet PERSONAL (por defecto 6)
app.get("/wallets/personal/:address/txs", async (req, res) => {
  try {
    const { address } = req.params;
    const limit = Math.max(1, Math.min(Number(req.query.limit || 6), 50));

    // QuickNode RPC: qn_getTransactionsByAddress
    let txResp;
    try {
      txResp = await customHttpProvider.send("qn_getTransactionsByAddress", [{
        address,
        page: 1,
        perPage: limit,
        sort: "desc",
      }]);
    } catch (e) {
      return res.status(501).json({
        message: "El nodo actual no soporta qn_getTransactionsByAddress. Activa el método en QuickNode o usa un indexador.",
        details: e.message || String(e),
      });
    }

    const txs = txResp?.transactions || txResp?.data || [];
    // Enriquecer con timestamps y conversiones
    const enriched = [];
    for (const t of txs) {
      const blockNumber = t.blockNumber || t.block || t?.transaction?.blockNumber;
      let ts = Date.now() / 1000;
      if (blockNumber) {
        const blk = await customHttpProvider.getBlock(BigInt(blockNumber));
        if (blk && blk.timestamp) ts = Number(blk.timestamp);
      }
      const from = (t.from || t.fromAddress || "").toLowerCase();
      const to = (t.to || t.toAddress || "").toLowerCase();
      const valueWei = BigInt(t.value || t.valueWei || 0);
      const type = to === address.toLowerCase() ? "ingreso" : "salida";
      const valueEth = Number(ethers.formatEther(valueWei));
      enriched.push({
        hash: t.hash || t.transactionHash,
        age: timeAgoFromTsSec(ts),
        timestamp: new Date(ts * 1000).toISOString(),
        tipo: type,
        from,
        to,
        montoWei: valueWei.toString(),
        montoETH: valueEth,
        montoHNL: await convert.ethToHnl(valueEth),
      });
    }

    res.json({ count: enriched.length, txs: enriched });
  } catch (error) {
    console.error("❌ Error en /wallets/personal/:address/txs:", error);
    res.status(500).json({ message: "Error obteniendo transacciones." });
  }
});

// 2) ¿Cuánto ha aportado cada persona a una wallet COMUNITARIA?
app.get("/wallets/:walletAddress/aportes", async (req, res) => {
  try {
    const { walletAddress } = req.params;

    // QuickNode RPC: qn_getTransfersByAddress (entradas "native")
    let resp;
    try {
      resp = await customHttpProvider.send("qn_getTransfersByAddress", [{
        address: walletAddress,
        page: 1,
        perPage: 100,            // ajustar si necesitas más
        direction: "incoming",   // solo ingresos a la wallet
        contract: "native"       // solo ETH nativo
      }]);
    } catch (e) {
      return res.status(501).json({
        message: "El nodo actual no soporta qn_getTransfersByAddress. Activa el método en QuickNode o usa un indexador.",
        details: e.message || String(e),
      });
    }

    const transfers = resp?.transfers || resp?.data || [];
    const map = new Map(); // from -> BigInt total

    for (const tr of transfers) {
      const from = (tr.from || tr.fromAddress || "").toLowerCase();
      const valueWei = BigInt(tr.value || tr.valueWei || 0);
      map.set(from, (map.get(from) || 0n) + valueWei);
    }

    const aportes = [];
    for (const [addr, totalWei] of map.entries()) {
      const totalEth = Number(ethers.formatEther(totalWei));
      aportes.push({
        address: addr,
        totalWei: totalWei.toString(),
        totalETH: totalEth,
        totalHNL: await convert.ethToHnl(totalEth),
      });
    }

    // ordenar por mayor aporte
    aportes.sort((a, b) => Number(b.totalWei) - Number(a.totalWei));

    res.json({ walletAddress, aportes });
  } catch (error) {
    console.error("❌ Error en /wallets/:walletAddress/aportes:", error);
    res.status(500).json({ message: "Error obteniendo aportes." });
  }
});

// 3) Historial de propuestas + últimas 5 transacciones de una wallet COMUNITARIA
app.get("/wallets/:walletAddress/propuestas-historial", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const walletContract = new ethers.Contract(walletAddress, BilleteraABI, customHttpProvider);

    const total = Number(await walletContract.totalPropuestas());
    const propuestas = [];
    for (let i = 0; i < total; i++) {
      const p = await walletContract.verPropuesta(i);
      const tipo = Number(p[5]);   // 0 = Gasto, 1 = Miembro (asumido)
      const estado = Number(p[6]); // 0 Pendiente, 1 Ejecutada, 2 Expirada (asumido)
      const montoWei = BigInt(p[1]);
      const montoETH = Number(ethers.formatEther(montoWei));
      propuestas.push({
        id: i,
        destinatario: p[0],
        montoWei: montoWei.toString(),
        montoETH,
        montoHNL: await convert.ethToHnl(montoETH),
        descripcion: p[2],
        fechaLimite: new Date(Number(p[3]) * 1000).toISOString(),
        confirmaciones: Number(p[4]),
        tipo,
        estado,
      });
    }

    // Últimas 5 transacciones del address comunitario
    let txResp;
    try {
      txResp = await customHttpProvider.send("qn_getTransactionsByAddress", [{
        address: walletAddress,
        page: 1,
        perPage: 5,
        sort: "desc",
      }]);
    } catch (e) {
      txResp = { transactions: [] };
    }
    const txs = txResp?.transactions || txResp?.data || [];

    const ultimasTx = [];
    for (const t of txs) {
      const blockNumber = t.blockNumber || t.block;
      let ts = Date.now() / 1000;
      if (blockNumber) {
        const blk = await customHttpProvider.getBlock(BigInt(blockNumber));
        if (blk?.timestamp) ts = Number(blk.timestamp);
      }
      const valueWei = BigInt(t.value || 0);
      const valueETH = Number(ethers.formatEther(valueWei));
      const toLower = (t.to || "").toLowerCase();
      const tipoTx = toLower === walletAddress.toLowerCase() ? "ingreso" : "salida";
      ultimasTx.push({
        hash: t.hash,
        age: timeAgoFromTsSec(ts),
        timestamp: new Date(ts * 1000).toISOString(),
        tipo: tipoTx,
        from: (t.from || "").toLowerCase(),
        to: toLower,
        montoWei: valueWei.toString(),
        montoETH: valueETH,
        montoHNL: await convert.ethToHnl(valueETH),
      });
    }

    res.json({ totalPropuestas: total, propuestas, ultimasTx });
  } catch (error) {
    console.error("❌ Error en /wallets/:walletAddress/propuestas-historial:", error);
    res.status(500).json({ message: "Error obteniendo historial." });
  }
});

// 4) Endpoint recomendado: dashboard resumido para una wallet COMUNITARIA
app.get("/wallets/:walletAddress/dashboard", async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const walletContract = new ethers.Contract(walletAddress, BilleteraABI, customHttpProvider);

    // saldo
    let saldoWei = 0n;
    try { saldoWei = BigInt(await walletContract.saldoWallet()); } catch { }

    // miembros desde Mongo (quienes tengan esa wallet en su arreglo)
    const miembros = await db.collection("users")
      .find({ wallets: walletAddress })
      .project({ nombre: 1, billetera: 1, correo: 1, celular: 1 })
      .toArray();

    // propuestas (contadores rápidos)
    let total = 0;
    try { total = Number(await walletContract.totalPropuestas()); } catch { }
    let pendientes = 0, ejecutadas = 0, expiradas = 0;
    for (let i = 0; i < total; i++) {
      try {
        const p = await walletContract.verPropuesta(i);
        const estado = Number(p[6]); // asumido: 0/1/2
        if (estado === 0) pendientes++;
        else if (estado === 1) ejecutadas++;
        else expiradas++;
      } catch { }
    }

    // top aportes (llamar endpoint interno)
    let aportes = [];
    try {
      const inner = await customHttpProvider.send("qn_getTransfersByAddress", [{
        address: walletAddress, page: 1, perPage: 50, direction: "incoming", contract: "native"
      }]);
      const transfers = inner?.transfers || inner?.data || [];
      const map = new Map();
      for (const tr of transfers) {
        const from = (tr.from || tr.fromAddress || "").toLowerCase();
        const valueWei = BigInt(tr.value || tr.valueWei || 0);
        map.set(from, (map.get(from) || 0n) + valueWei);
      }
      for (const [addr, totalWei] of map.entries()) {
        const totalETH = Number(ethers.formatEther(totalWei));
        aportes.push({
          address: addr,
          totalWei: totalWei.toString(),
          totalETH,
          totalHNL: await convert.ethToHnl(totalETH),
        });
      }
      aportes.sort((a, b) => Number(b.totalWei) - Number(a.totalWei));
      aportes = aportes.slice(0, 5);
    } catch { }

    // últimas 5 tx
    let ultimasTx = [];
    try {
      const txResp = await customHttpProvider.send("qn_getTransactionsByAddress", [{
        address: walletAddress, page: 1, perPage: 5, sort: "desc"
      }]);
      const txs = txResp?.transactions || txResp?.data || [];
      for (const t of txs) {
        const blockNumber = t.blockNumber || t.block;
        let ts = Date.now() / 1000;
        if (blockNumber) {
          const blk = await customHttpProvider.getBlock(BigInt(blockNumber));
          if (blk?.timestamp) ts = Number(blk.timestamp);
        }
        const valueWei = BigInt(t.value || 0);
        const valueETH = Number(ethers.formatEther(valueWei));
        const toLower = (t.to || "").toLowerCase();
        const tipoTx = toLower === walletAddress.toLowerCase() ? "ingreso" : "salida";
        ultimasTx.push({
          hash: t.hash,
          age: timeAgoFromTsSec(ts),
          timestamp: new Date(ts * 1000).toISOString(),
          tipo: tipoTx,
          from: (t.from || "").toLowerCase(),
          to: toLower,
          montoWei: valueWei.toString(),
          montoETH: valueETH,
          montoHNL: await convert.ethToHnl(valueETH),
        });
      }
    } catch { }

    res.json({
      walletAddress,
      saldo: {
        wei: saldoWei.toString(),
        eth: Number(ethers.formatEther(saldoWei)),
        hnl: await convert.weiToHnl(saldoWei),
      },
      miembros,
      propuestas: { total, pendientes, ejecutadas, expiradas },
      topAportes: aportes,
      ultimasTx
    });
  } catch (error) {
    console.error("❌ Error en /wallets/:walletAddress/dashboard:", error);
    res.status(500).json({ message: "Error en dashboard." });
  }
});

/* =========================
   CONFIG: tasa ETH→HNL (enduro)
   ========================= */

// GET tasa actual
app.get("/config/exchange-rate", async (req, res) => {
  try {
    const rate = await getEthToHnlRate();
    res.json({ ethToHnl: rate });
  } catch (e) {
    res.status(500).json({ message: "Error leyendo tasa." });
  }
});

// SET tasa (body: { ethToHnl: number })
app.post("/config/exchange-rate", async (req, res) => {
  try {
    const { ethToHnl } = req.body;
    if (typeof ethToHnl !== "number" || ethToHnl <= 0) {
      return res.status(400).json({ message: "ethToHnl debe ser número > 0" });
    }
    await db.collection("config").updateOne(
      { _id: "fx" },
      { $set: { ethToHnl } },
      { upsert: true }
    );
    res.json({ message: "Tasa actualizada", ethToHnl });
  } catch (e) {
    res.status(500).json({ message: "Error actualizando tasa." });
  }
});
