'use strict';

// ─────────────────────────────────────────────
//  PEPMASTERS — server.js
//  Node.js + Express + PostgreSQL (Render)
//  Pagamento: PixGo  |  Email: Resend  |  WhatsApp: WA_APIKEY
// ─────────────────────────────────────────────

const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const crypto       = require('crypto');
const path         = require('path');
const fetch        = require('node-fetch');
const nodemailer   = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────
const DATABASE_URL        = process.env.DATABASE_URL;
const JWT_SECRET          = process.env.JWT_SECRET          || 'pep_jwt_secret_2025';
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      || '159357456258';
const PIXGO_API_KEY       = process.env.PIXGO_API_KEY       || '';
const PIXGO_WEBHOOK_SECRET= process.env.PIXGO_WEBHOOK_SECRET|| '';
const RESEND_API_KEY      = process.env.RESEND_API_KEY      || '';
const BASE_URL            = process.env.BASE_URL            || 'https://pepmasters.onrender.com';
const EMAIL_DESTINO       = process.env.EMAIL_DESTINO       || '';   // preencher no Render
const EMAIL_USER          = process.env.EMAIL_USER          || 'matheustlopo42@gmail.com';
const EMAIL_PASS          = process.env.EMAIL_PASS          || 'pplezzjcvzyakzdc';
const CRYPTO_WALLET       = process.env.CRYPTO_WALLET       || '0xDA95bb300C7be3E3347d449b14b834Dc3098deAD';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || '';  // opcional, aumenta rate limit
const WA_PHONE            = process.env.WA_PHONE            || '';   // preencher no Render
const WA_APIKEY           = process.env.WA_APIKEY           || '';   // preencher no Render

// ── BANCO ─────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── MIDDLEWARES ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Servir arquivos JS da raiz (i18n, etc)
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
app.get('/i18n-init.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n-init.js')));

// ── INIT TABELAS ─────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Usuários — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_usuarios (
        id         SERIAL PRIMARY KEY,
        nome       TEXT NOT NULL,
        email      TEXT UNIQUE NOT NULL,
        senha_hash TEXT,
        criado_em  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS cpf TEXT`);
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS telefone TEXT`);
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS senha_hash TEXT`);
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT`);
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_exp BIGINT`);

    // Pedidos — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_pedidos (
        id        SERIAL PRIMARY KEY,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const pedidosCols = [
      'usuario_id INT', 'nome TEXT', 'email TEXT', 'cpf TEXT', 'telefone TEXT',
      'cep TEXT', 'rua TEXT', 'numero TEXT', 'bairro TEXT', 'cidade TEXT', 'complemento TEXT',
      'produto_id INT', 'produto_nome TEXT', 'preco_unitario NUMERIC(10,2)',
      'desconto NUMERIC(10,2) DEFAULT 0', 'total NUMERIC(10,2)',
      'pagamento TEXT', 'cupom TEXT', 'status TEXT DEFAULT \'pix_pending\'',
      'pixgo_id TEXT', 'codigo_rastreio TEXT',
      'crypto_valor NUMERIC(18,6) DEFAULT 0', 'crypto_token TEXT'
    ];
    for (const col of pedidosCols) {
      const colName = col.split(' ')[0];
      await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }

    // Cupons — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_cupons (
        id        SERIAL PRIMARY KEY,
        codigo    TEXT UNIQUE NOT NULL,
        ativo     BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS desconto_pix INT DEFAULT 0`);
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS desconto_cartao INT DEFAULT 0`);
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos INT DEFAULT 0`);
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos_max INT DEFAULT 0`);

    // Estoque — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_estoque (
        id        SERIAL PRIMARY KEY,
        produto_id VARCHAR(100),
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS nome TEXT`);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS preco NUMERIC(10,2)`);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS descricao TEXT`);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS estoque INT DEFAULT 0`);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS alerta_minimo INT DEFAULT 3`);

    // Lista de espera
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_lista_espera (
        id         SERIAL PRIMARY KEY,
        nome       TEXT,
        email      TEXT NOT NULL,
        produto    TEXT NOT NULL,
        criado_em  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');

    // Seed produtos se estoque vazio
    const { rows } = await client.query('SELECT COUNT(*) FROM pep_estoque');
    if (parseInt(rows[0].count) === 0) {
      const produtos = [
        { id:1, nome:'BPC-157',          preco:150.00, descricao:'Recuperacao muscular e articular acelerada.', estoque:10 },
        { id:2, nome:'TB-500',           preco:180.00, descricao:'Regeneracao tecidual e anti-inflamatorio.',  estoque:10 },
        { id:3, nome:'HGH Frag 176-191', preco:160.00, descricao:'Queima de gordura sem efeitos do GH completo.', estoque:10 },
        { id:4, nome:'Ipamorelin',       preco:140.00, descricao:'Estimulante seletivo do hormonio do crescimento.', estoque:10 },
        { id:5, nome:'Sermorelin',       preco:170.00, descricao:'Anti-aging, sono e estimulo natural do GH.', estoque:0  },
      ];
      for (const p of produtos) {
        await client.query(
          'INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (produto_id,variacao) DO UPDATE SET nome=EXCLUDED.nome,preco=EXCLUDED.preco,descricao=EXCLUDED.descricao',
          [String(p.id), p.nome, p.preco, p.descricao, p.estoque]
        );
      }
      console.log('[DB] Produtos inseridos no estoque.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Erro no init:', err.message);
  } finally {
    client.release();
  }
}

// ── AUTH HELPERS ─────────────────────────────
function gerarToken(id) {
  return jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido.' });
  }
}

function adminMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString();
    const [, senha] = decoded.split(':');
    if (senha !== ADMIN_PASSWORD) return res.status(401).json({ erro: 'Senha incorreta.' });
    next();
  } catch {
    res.status(401).json({ erro: 'Não autorizado.' });
  }
}

// ── EMAIL (Gmail SMTP via Nodemailer) ────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

async function enviarEmail(para, assunto, html) {
  if (!para) return;
  try {
    await transporter.sendMail({
      from: 'PEPMASTERS <' + EMAIL_USER + '>',
      to: para,
      subject: assunto,
      html
    });
    console.log('[Email] Enviado para ' + para);
  } catch (err) {
    console.error('[Email] Erro:', err.message);
  }
}

// ── WHATSAPP ──────────────────────────────────
async function enviarWhatsApp(mensagem) {
  if (!WA_PHONE || !WA_APIKEY) return;
  try {
    await fetch('https://api.callmebot.com/whatsapp.php?phone=' + WA_PHONE + '&text=' + encodeURIComponent(mensagem) + '&apikey=' + WA_APIKEY);
  } catch (err) {
    console.error('[WhatsApp] Erro:', err.message);
  }
}

// ─────────────────────────────────────────────
//  ROTAS PÚBLICAS
// ─────────────────────────────────────────────

// GET /api/produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT produto_id AS id, nome, preco, descricao, estoque FROM pep_estoque WHERE nome IS NOT NULL ORDER BY produto_id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

// POST /api/cadastro
app.post('/api/cadastro', async (req, res) => {
  const { nome, email, cpf, telefone, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  try {
    const existe = await pool.query('SELECT id FROM pep_usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length) return res.status(400).json({ erro: 'Email já cadastrado.' });

    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await pool.query(
      'INSERT INTO pep_usuarios (nome,email,cpf,telefone,senha,senha_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,nome,email',
      [nome, email.toLowerCase(), cpf || null, telefone || null, hash, hash]
    );
    const u = rows[0];
    res.json({ token: gerarToken(u.id), nome: u.nome, email: u.email });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  try {
    const { rows } = await pool.query('SELECT * FROM pep_usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    const u = rows[0];
    const ok = await bcrypt.compare(senha, u.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    res.json({ token: gerarToken(u.id), nome: u.nome, email: u.email });
  } catch {
    res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

// POST /api/esqueci-senha
app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'Informe o email.' });
  try {
    const { rows } = await pool.query('SELECT id,nome FROM pep_usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.json({ ok: true }); // não revelar se existe
    const u     = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const exp   = Date.now() + 3600000; // 1h
    await pool.query('UPDATE pep_usuarios SET reset_token=$1, reset_exp=$2 WHERE id=$3', [token, exp, u.id]);
    const link = BASE_URL + '/redefinir-senha.html?token=' + token;
    await enviarEmail(
      email,
      'Redefinição de senha — PEPMASTERS',
      '<p>Olá, ' + u.nome + '!</p><p>Clique no link abaixo para redefinir sua senha (válido por 1 hora):</p><p><a href="' + link + '">' + link + '</a></p>'
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao processar solicitação.' });
  }
});

// POST /api/redefinir-senha
app.post('/api/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ erro: 'Dados incompletos.' });
  try {
    const { rows } = await pool.query('SELECT id,reset_exp FROM pep_usuarios WHERE reset_token=$1', [token]);
    if (!rows.length) return res.status(400).json({ erro: 'Token inválido.' });
    const u = rows[0];
    if (Date.now() > u.reset_exp) return res.status(400).json({ erro: 'Token expirado.' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE pep_usuarios SET senha_hash=$1, reset_token=NULL, reset_exp=NULL WHERE id=$2', [hash, u.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao redefinir senha.' });
  }
});

// GET /api/cupom/:codigo
app.get('/api/cupom/:codigo', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,codigo,desconto_pix,desconto_cartao,usos,usos_max,ativo FROM pep_cupons WHERE codigo=$1',
      [req.params.codigo.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Cupom não encontrado.' });
    const c = rows[0];
    if (!c.ativo) return res.status(400).json({ erro: 'Cupom inativo.' });
    if (c.usos_max > 0 && c.usos >= c.usos_max) return res.status(400).json({ erro: 'Cupom esgotado.' });
    res.json(c);
  } catch {
    res.status(500).json({ erro: 'Erro ao verificar cupom.' });
  }
});

// POST /api/pedido
app.post('/api/pedido', async (req, res) => {
  const {
    nome, email, cpf, telefone,
    endereco, carrinho, pagamento, cupom, total: totalFront,
    crypto_valor, crypto_token,
    token: userToken
  } = req.body;

  if (!nome || !email || !pagamento || !carrinho || !carrinho.length) {
    return res.status(400).json({ erro: 'Dados incompletos.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // calcular subtotal a partir do carrinho
    const subtotal = carrinho.reduce((s, i) => s + parseFloat(i.preco) * parseInt(i.quantidade), 0);

    // calcular desconto de cupom
    let desconto = 0;
    let cupomId  = null;
    if (cupom) {
      const { rows: cupRows } = await client.query(
        'SELECT id,desconto_pix,desconto_cartao,usos,usos_max,ativo FROM pep_cupons WHERE codigo=$1',
        [cupom.toUpperCase()]
      );
      if (cupRows.length && cupRows[0].ativo) {
        const c   = cupRows[0];
        const pct = pagamento === 'pix' ? c.desconto_pix : c.desconto_cartao;
        desconto  = subtotal * (pct / 100);
        cupomId   = c.id;
        if (!(c.usos_max > 0 && c.usos >= c.usos_max)) {
          await client.query('UPDATE pep_cupons SET usos=usos+1 WHERE id=$1', [c.id]);
        }
      }
    }

    const total = subtotal - desconto;

    // montar nomes dos produtos para exibição
    const produto_nome = carrinho.map(i => i.nome + (i.quantidade > 1 ? ' x' + i.quantidade : '')).join(', ');
    const produto_id   = carrinho[0].id;

    // descobrir usuario_id se logado
    let usuarioId = null;
    if (userToken) {
      try { usuarioId = jwt.verify(userToken, JWT_SECRET).id; } catch {}
    }

    // criar pedido
    const statusInicial = (pagamento === 'pix' || pagamento === 'cripto') ? 'pix_pending' : 'pago';
    const { rows: pedRows } = await client.query(
      `INSERT INTO pep_pedidos
         (usuario_id,nome,email,cpf,telefone,cep,rua,numero,bairro,cidade,complemento,
          produto_id,produto_nome,preco_unitario,desconto,total,pagamento,cupom,status,
          crypto_valor,crypto_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        usuarioId, nome, email.toLowerCase(), cpf || null, telefone || null,
        endereco?.cep || null, endereco?.rua || null, endereco?.numero || null,
        endereco?.bairro || null, endereco?.cidade || null, endereco?.complemento || null,
        produto_id, produto_nome, subtotal.toFixed(2), desconto.toFixed(2), total.toFixed(2),
        pagamento, cupomId ? cupom.toUpperCase() : null, statusInicial,
        crypto_valor || null, crypto_token || null
      ]
    );
    const pedidoId = pedRows[0].id;

    // baixar estoque de cada item do carrinho
    for (const item of carrinho) {
      await client.query(
        'UPDATE pep_estoque SET estoque=estoque-$1 WHERE produto_id=$2::text',
        [parseInt(item.quantidade), String(item.id)]
      );
    }

    await client.query('COMMIT');

    // ── PIX: criar cobrança no PixGo ──
    let qrcode_url     = null;
    let pix_copia_cola = null;

    if (pagamento === 'pix' && PIXGO_API_KEY) {
      try {
        const externalId = 'pep-' + pedidoId;
        const pixPayload = JSON.stringify({
          amount:      total,
          description: 'PEPMASTERS #' + pedidoId,
          external_id: externalId,
          webhook_url: BASE_URL + '/webhook/pixgo'
        });
        const pixRes = await fetch('https://pixgo.org/api/v1/payment/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': PIXGO_API_KEY
          },
          body: pixPayload
        });
        const pixData = await pixRes.json();
        console.log('[PixGo] Resposta:', JSON.stringify(pixData));
        if (pixData.success && pixData.data) {
          qrcode_url     = pixData.data.qr_image_url || null;
          pix_copia_cola = pixData.data.qr_code      || null;
          if (pixData.data.id) {
            await pool.query('UPDATE pep_pedidos SET pixgo_id=$1 WHERE id=$2', [pixData.data.id, pedidoId]);
          }
        } else {
          console.error('[PixGo] Erro:', pixData.message || pixData.error || JSON.stringify(pixData));
        }
      } catch (err) {
        console.error('[PixGo] Erro ao criar cobrança:', err.message);
      }
    }

    // ── Notificações ──
    const itensTexto = carrinho.map(i => i.nome + ' x' + i.quantidade).join(', ');
    enviarWhatsApp('Novo pedido PEPMASTERS #' + pedidoId + '\nCliente: ' + nome + '\nItens: ' + itensTexto + '\nTotal: R$ ' + total.toFixed(2).replace('.',',') + '\nPag: ' + pagamento.toUpperCase());

    if (EMAIL_DESTINO) {
      enviarEmail(EMAIL_DESTINO, 'Novo pedido #' + pedidoId + ' — PEPMASTERS',
        '<b>Pedido #' + pedidoId + '</b><br>Cliente: ' + nome + '<br>Email: ' + email +
        '<br>Itens: ' + itensTexto + '<br>Total: R$ ' + total.toFixed(2).replace('.',',') + '<br>Pagamento: ' + pagamento
      );
    }

    // email confirmação para o cliente
    const itensHtml = carrinho.map(i => '<li>' + i.nome + ' × ' + i.quantidade + ' — R$ ' + (i.preco * i.quantidade).toFixed(2).replace('.',',') + '</li>').join('');
    enviarEmail(email, 'Pedido #' + pedidoId + ' recebido — PEPMASTERS',
      '<h2>Obrigado, ' + nome.split(' ')[0] + '!</h2>' +
      '<p>Seu pedido <b>#' + pedidoId + '</b> foi recebido!</p>' +
      '<ul>' + itensHtml + '</ul>' +
      '<p><b>Total: R$ ' + total.toFixed(2).replace('.',',') + '</b></p>' +
      '<p>Acompanhe em: <a href="' + BASE_URL + '/meus-pedidos.html">Meus Pedidos</a></p>'
    );

    res.json({ pedido_id: pedidoId, qrcode_url, pix_copia_cola });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Pedido] Erro:', err.message);
    res.status(500).json({ erro: 'Erro ao criar pedido.' });
  } finally {
    client.release();
  }
});

// GET /api/pedido/:id/status
app.get('/api/pedido/:id/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,status,produto_nome,pagamento,codigo_rastreio,criado_em FROM pep_pedidos WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ erro: 'Erro ao buscar status.' });
  }
});

// GET /api/meus-pedidos
app.get('/api/meus-pedidos', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,produto_nome,total,pagamento,status,codigo_rastreio,criado_em FROM pep_pedidos WHERE usuario_id=$1 ORDER BY criado_em DESC',
      [req.usuario.id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ erro: 'Erro ao buscar pedidos.' });
  }
});

// GET /api/rastrear?codigo=XX
app.get('/api/rastrear', async (req, res) => {
  const { codigo } = req.query;
  if (!codigo) return res.status(400).json({ erro: 'Informe o código.' });
  try {
    // aceita ID numérico (#42) ou código de rastreio
    const idNumerico = parseInt(codigo.replace('#',''));
    let rows;
    if (!isNaN(idNumerico) && idNumerico > 0) {
      ({ rows } = await pool.query(
        'SELECT id,produto_nome,status,codigo_rastreio,criado_em FROM pep_pedidos WHERE id=$1',
        [idNumerico]
      ));
    } else {
      ({ rows } = await pool.query(
        'SELECT id,produto_nome,status,codigo_rastreio,criado_em FROM pep_pedidos WHERE codigo_rastreio=$1',
        [codigo]
      ));
    }
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ erro: 'Erro ao rastrear.' });
  }
});

// GET /api/lista-espera  POST
app.post('/api/lista-espera', async (req, res) => {
  const { nome, email, produto } = req.body;
  if (!email || !produto) return res.status(400).json({ erro: 'Dados incompletos.' });
  try {
    await pool.query(
      'INSERT INTO pep_lista_espera (nome,email,produto) VALUES ($1,$2,$3)',
      [nome || null, email.toLowerCase(), produto]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao registrar.' });
  }
});

// ── PERFIL ────────────────────────────────────
app.get('/api/perfil', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,nome,email,cpf,telefone FROM pep_usuarios WHERE id=$1',
      [req.usuario.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ erro: 'Erro.' });
  }
});

app.put('/api/perfil', authMiddleware, async (req, res) => {
  const { nome, cpf, telefone } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  try {
    await pool.query(
      'UPDATE pep_usuarios SET nome=$1,cpf=$2,telefone=$3 WHERE id=$4',
      [nome, cpf || null, telefone || null, req.usuario.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao atualizar.' });
  }
});

app.put('/api/perfil/senha', authMiddleware, async (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!senhaAtual || !novaSenha) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  try {
    const { rows } = await pool.query('SELECT senha_hash FROM pep_usuarios WHERE id=$1', [req.usuario.id]);
    const ok = await bcrypt.compare(senhaAtual, rows[0].senha_hash);
    if (!ok) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await pool.query('UPDATE pep_usuarios SET senha_hash=$1 WHERE id=$2', [hash, req.usuario.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao alterar senha.' });
  }
});

// ─────────────────────────────────────────────
//  ROTAS ADMIN
// ─────────────────────────────────────────────

// GET /api/admin/verificar
app.get('/api/admin/verificar', adminMiddleware, (req, res) => {
  res.json({ ok: true });
});

// GET /api/admin/pedidos
app.get('/api/admin/pedidos', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM pep_pedidos ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch {
    res.status(500).json({ erro: 'Erro ao buscar pedidos.' });
  }
});

// PUT /api/admin/pedido/:id/status
app.put('/api/admin/pedido/:id/status', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  const validos = ['pago','pix_pending','enviado','entregue','cancelado'];
  if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  try {
    const { rows } = await pool.query(
      'UPDATE pep_pedidos SET status=$1 WHERE id=$2 RETURNING email,nome,produto_nome,status',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = rows[0];

    // notificar cliente por email se enviado ou entregue
    if (status === 'enviado' || status === 'entregue') {
      const msg = status === 'enviado'
        ? 'Seu pedido de <b>' + p.produto_nome + '</b> foi enviado! Em breve você receberá o código de rastreio.'
        : 'Seu pedido de <b>' + p.produto_nome + '</b> foi entregue! Esperamos que goste. 🎉';
      enviarEmail(p.email, 'Atualização do pedido — PEPMASTERS', '<p>Olá, ' + p.nome.split(' ')[0] + '!</p><p>' + msg + '</p>');
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao atualizar status.' });
  }
});

// PUT /api/admin/pedido/:id/rastreio
app.put('/api/admin/pedido/:id/rastreio', adminMiddleware, async (req, res) => {
  const { codigo_rastreio } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE pep_pedidos SET codigo_rastreio=$1 WHERE id=$2 RETURNING email,nome,produto_nome',
      [codigo_rastreio, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = rows[0];

    if (codigo_rastreio) {
      enviarEmail(p.email,
        'Código de rastreio — PEPMASTERS',
        '<p>Olá, ' + p.nome.split(' ')[0] + '!</p><p>Seu pedido de <b>' + p.produto_nome + '</b> foi enviado!</p>' +
        '<p>Código de rastreio: <b>' + codigo_rastreio + '</b></p>' +
        '<p>Rastreie em: <a href="https://rastreamento.correios.com.br/app/index.php?objetos=' + codigo_rastreio + '">Correios</a></p>'
      );
    }

    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao salvar rastreio.' });
  }
});

// GET /api/admin/cupons
app.get('/api/admin/cupons', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pep_cupons ORDER BY criado_em DESC');
    res.json(rows);
  } catch {
    res.status(500).json({ erro: 'Erro.' });
  }
});

// POST /api/admin/cupons
app.post('/api/admin/cupons', adminMiddleware, async (req, res) => {
  const { codigo, desconto_pix, desconto_cartao, usos_max } = req.body;
  if (!codigo) return res.status(400).json({ erro: 'Código obrigatório.' });
  try {
    await pool.query(
      'INSERT INTO pep_cupons (codigo,desconto_pix,desconto_cartao,usos_max) VALUES ($1,$2,$3,$4)',
      [codigo.toUpperCase(), desconto_pix || 0, desconto_cartao || 0, usos_max || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'Código já existe.' });
    res.status(500).json({ erro: 'Erro ao criar cupom.' });
  }
});

// PUT /api/admin/cupons/:id
app.put('/api/admin/cupons/:id', adminMiddleware, async (req, res) => {
  const { ativo } = req.body;
  try {
    await pool.query('UPDATE pep_cupons SET ativo=$1 WHERE id=$2', [ativo, req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro.' });
  }
});

// GET /api/admin/estoque
app.get('/api/admin/estoque', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pep_estoque ORDER BY produto_id');
    res.json(rows);
  } catch {
    res.status(500).json({ erro: 'Erro.' });
  }
});

// PUT /api/admin/estoque/:id
app.put('/api/admin/estoque/:id', adminMiddleware, async (req, res) => {
  const { estoque, alerta_minimo } = req.body;
  try {
    await pool.query(
      'UPDATE pep_estoque SET estoque=$1,alerta_minimo=$2 WHERE produto_id=$3::text',
      [estoque, alerta_minimo, req.params.id]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao atualizar estoque.' });
  }
});

// ─────────────────────────────────────────────
//  WEBHOOK PIXGO
// ─────────────────────────────────────────────
app.post('/webhook/pixgo', express.raw({ type: '*/*' }), async (req, res) => {
  // Obter body como string/buffer
  let rawBody;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body;
  } else if (typeof req.body === 'string') {
    rawBody = Buffer.from(req.body);
  } else if (req.body && typeof req.body === 'object') {
    rawBody = Buffer.from(JSON.stringify(req.body));
  } else {
    rawBody = Buffer.from('');
  }

  // Verificar assinatura
  if (PIXGO_WEBHOOK_SECRET && rawBody.length > 0) {
    const sig  = req.headers['x-pixgo-signature'] || req.headers['x-signature'] || '';
    const hmac = crypto.createHmac('sha256', PIXGO_WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (sig && sig !== hmac) {
      console.warn('[Webhook] Assinatura inválida.');
      return res.status(400).send('Invalid signature');
    }
  }

  let evento;
  try {
    evento = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  console.log('[Webhook PixGo] Evento recebido:', JSON.stringify(evento));

  if (evento.event === 'charge.paid' || evento.status === 'paid') {
    const externalId = evento.externalId || evento.external_id || '';
    const match      = externalId.match(/pep-(\d+)/);
    if (match) {
      const pedidoId = parseInt(match[1]);
      try {
        const { rows } = await pool.query(
          'UPDATE pep_pedidos SET status=$1 WHERE id=$2 AND status=$3 RETURNING nome,email,produto_nome',
          ['pago', pedidoId, 'pix_pending']
        );
        if (rows.length) {
          const p = rows[0];
          console.log('[Webhook] Pedido #' + pedidoId + ' marcado como PAGO.');
          enviarWhatsApp('PIX CONFIRMADO! Pedido #' + pedidoId + ' - ' + p.nome + ' - ' + p.produto_nome);
          enviarEmail(p.email, 'Pagamento confirmado — PEPMASTERS',
            '<h2>Pagamento confirmado! ✅</h2><p>Olá, ' + p.nome.split(' ')[0] + '! Seu pagamento PIX do pedido <b>#' + pedidoId + '</b> foi confirmado.</p>' +
            '<p>Produto: <b>' + p.produto_nome + '</b></p><p>Em breve enviaremos o código de rastreio.</p>'
          );
        }
      } catch (err) {
        console.error('[Webhook] Erro ao atualizar pedido:', err.message);
      }
    }
  }

  res.status(200).send('OK');
});


// ─────────────────────────────────────────────
//  SEED TEMPORARIO — acessar 1x e remover depois
//  URL: https://pepmasters.onrender.com/api/seed-pep-159357
// ─────────────────────────────────────────────
app.get('/api/seed-pep-159357', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS cpf TEXT');
    await client.query('ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS telefone TEXT');
    await client.query('ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS senha_hash TEXT');
    await client.query('ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT');
    await client.query('ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_exp BIGINT');
    await client.query("UPDATE pep_usuarios SET senha_hash = senha WHERE senha_hash IS NULL AND senha IS NOT NULL");
    const pedCols = [
      'usuario_id INT','nome TEXT','email TEXT','cpf TEXT','telefone TEXT',
      'cep TEXT','rua TEXT','numero TEXT','bairro TEXT','cidade TEXT','complemento TEXT',
      'produto_id INT','produto_nome TEXT','preco_unitario NUMERIC(10,2)',
      'desconto NUMERIC(10,2) DEFAULT 0','total NUMERIC(10,2)',
      'pagamento TEXT','cupom TEXT','pixgo_id TEXT','codigo_rastreio TEXT',
      'crypto_valor NUMERIC(18,6) DEFAULT 0','crypto_token TEXT'
    ];
    for (const col of pedCols) {
      await client.query('ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS ' + col).catch(() => {});
    }
    await client.query("ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pix_pending'").catch(() => {});
    await client.query('ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos INT DEFAULT 0').catch(() => {});
    await client.query('ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos_max INT DEFAULT 0').catch(() => {});
    await client.query('ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS nome TEXT').catch(() => {});
    await client.query('ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS preco NUMERIC(10,2)').catch(() => {});
    await client.query('ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS descricao TEXT').catch(() => {});
    await client.query('ALTER TABLE pep_estoque RENAME COLUMN quantidade TO estoque').catch(() => {});
    await client.query('ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS estoque INT DEFAULT 0').catch(() => {});
    const produtos = [
      ['1','BPC-157',150,'Recuperacao muscular e articular acelerada.',10],
      ['2','TB-500',180,'Regeneracao tecidual profunda e anti-inflamatorio.',10],
      ['3','HGH Frag 176-191',160,'Fragmento do GH para queima de gordura localizada.',10],
      ['4','Ipamorelin',140,'Estimulante seletivo do GH sem efeitos colaterais.',10],
      ['5','Sermorelin',170,'Anti-aging, melhora do sono e estimulo do GH.',0],
      ['6','CJC-1295',180,'Estimulante de GH de longa duracao para massa.',10],
      ['7','IGF-1 LR3',220,'Fator de crescimento insulinico para hipertrofia.',10],
      ['8','IGF-1 DES',200,'Variante do IGF-1 com acao local nos musculos.',10],
      ['9','ACE-031',250,'Inibidor da miostatina. Potencializa massa e forca.',10],
      ['10','Semax',160,'Neuropeptideo para foco, memoria e funcao cerebral.',10],
      ['11','Selank',150,'Ansiolitico natural com efeito nootropico.',10],
      ['12','Kisspeptin',190,'Estimula producao de LH e testosterona.',10],
      ['13','SS-31',210,'Acao antioxidante mitocondrial e cardioprotetora.',10],
      ['14','SLU-PP-32',230,'Simula efeitos metabolicos do exercicio.',10],
      ['15','AHK-CU',140,'Peptideo de cobre para cabelo, pele e cabelos.',10],
      ['16','VIP',200,'Potente anti-inflamatorio e vasoativo intestinal.',10],
    ];
    for (const [pid,nome,preco,desc,estoque] of produtos) {
      await client.query(
        "INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque,alerta_minimo) VALUES ($1,$2,$3,$4,$5,3) ON CONFLICT (produto_id,variacao) DO UPDATE SET nome=EXCLUDED.nome,preco=EXCLUDED.preco,descricao=EXCLUDED.descricao",
        [pid,nome,preco,desc,estoque]
      );
    }
    res.json({ ok: true, msg: '16 produtos inseridos! Remova esta rota do server.js em seguida.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  } finally {
    client.release();
  }
});


// GET /api/admin/usuarios
app.get('/api/admin/usuarios', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,nome,email,cpf,telefone,criado_em FROM pep_usuarios ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar usuários.' }); }
});

// DELETE /api/admin/usuarios/:id
app.delete('/api/admin/usuarios/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM pep_usuarios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao deletar usuário.' }); }
});

// POST /api/admin/usuarios/:id/reset-senha
app.post('/api/admin/usuarios/:id/reset-senha', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT nome,email FROM pep_usuarios WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const u     = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const exp   = Date.now() + 3600000;
    await pool.query('UPDATE pep_usuarios SET reset_token=$1, reset_exp=$2 WHERE id=$3', [token, exp, req.params.id]);
    const link = BASE_URL + '/redefinir-senha.html?token=' + token;
    await enviarEmail(u.email,
      'Redefinição de senha — PEPMASTERS',
      '<p>Olá, ' + u.nome + '!</p><p>Um administrador solicitou a redefinição da sua senha.</p><p><a href="' + link + '">Clique aqui para redefinir</a> (válido por 1 hora)</p>'
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});


// ── CRIPTO: cotação BRL → USD ──────────────────
app.get('/api/crypto/cotacao', async (req, res) => {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl');
    const d = await r.json();
    const brlPerUsdt = d.tether?.brl || 5.5;
    res.json({ brl_per_usdt: brlPerUsdt, usdt_per_brl: 1 / brlPerUsdt });
  } catch {
    res.json({ brl_per_usdt: 5.5, usdt_per_brl: 0.1818 });
  }
});

// ── CRIPTO: verificar pagamento na Polygon ──────
app.get('/api/pedido/:id/crypto-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, status, total, crypto_valor, crypto_token, criado_em FROM pep_pedidos WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const pedido = rows[0];

    // Se já pago, retorna
    if (pedido.status === 'pago') return res.json({ pago: true, status: 'pago' });

    // Verificar transações recentes na carteira via Polygonscan
    const wallet   = CRYPTO_WALLET.toLowerCase();
    const apiKey   = POLYGONSCAN_API_KEY ? '&apikey=' + POLYGONSCAN_API_KEY : '';
    const valorEsperado = parseFloat(pedido.crypto_valor || 0);
    const token    = pedido.crypto_token || 'USDT';
    const pedidoTs = Math.floor(new Date(pedido.criado_em).getTime() / 1000);

    // Endereços dos contratos na Polygon
    const contratos = {
      USDT: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
      USDC: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
    };
    const contrato = contratos[token] || contratos.USDT;

    const url = 'https://api.polygonscan.com/api?module=account&action=tokentx' +
      '&contractaddress=' + contrato +
      '&address=' + wallet +
      '&startblock=0&endblock=99999999&sort=desc&page=1&offset=20' + apiKey;

    const r    = await fetch(url);
    const data = await r.json();

    if (data.status === '1' && data.result) {
      for (const tx of data.result) {
        const txTs    = parseInt(tx.timeStamp);
        const txValor = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal));
        const txTo    = tx.to.toLowerCase();

        // Verificar: destino correto, após criação do pedido, valor correto (±2% tolerância)
        if (txTo === wallet && txTs >= pedidoTs - 300) {
          const diff = Math.abs(txValor - valorEsperado) / valorEsperado;
          if (diff <= 0.02) {
            // Marcar pedido como pago
            await pool.query(
              "UPDATE pep_pedidos SET status='pago', pixgo_id=$1 WHERE id=$2 AND status!='pago'",
              ['crypto:' + tx.hash, req.params.id]
            );
            enviarWhatsApp('CRIPTO CONFIRMADO! Pedido #' + req.params.id + ' — ' + txValor + ' ' + token);
            return res.json({ pago: true, status: 'pago', tx: tx.hash });
          }
        }
      }
    }

    res.json({ pago: false, status: pedido.status });
  } catch (err) {
    console.error('[Crypto] Erro ao verificar:', err.message);
    res.json({ pago: false, status: 'pix_pending' });
  }
});

// ─────────────────────────────────────────────
//  404 FALLBACK (SPA)
// ─────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ erro: 'Rota não encontrada.' });
  }
  res.sendFile(path.join(__dirname, 'public', '404.html'));
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('[PEPMASTERS] Servidor rodando na porta ' + PORT);
  });
}).catch(err => {
  console.error('[PEPMASTERS] Falha ao iniciar:', err.message);
  process.exit(1);
});
