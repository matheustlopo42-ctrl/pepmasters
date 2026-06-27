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

// ── RATE LIMITING ──
const rateLimitMap = new Map();
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const data = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - data.start > windowMs) { data.count = 1; data.start = now; }
    else { data.count++; }
    rateLimitMap.set(key, data);
    if (data.count > maxReqs) {
      return res.status(429).json({ erro: 'Too many requests. Please wait.' });
    }
    next();
  };
}
setInterval(() => rateLimitMap.clear(), 3600000);

// ── JOB DIÁRIO — avisos de expiração e expirar planos vencidos ────────────
async function jobDiario() {
  try {
    // 1. Expirar planos vencidos (exceto bronze)
    const expirados = await pool.query(`
      UPDATE pep_membros SET status='expirado'
      WHERE status='ativo' AND plano != 'bronze'
        AND membro_ate < NOW()
      RETURNING id, usuario_id, plano
    `);
    for (const m of expirados.rows) {
      const u = await pool.query(`SELECT email, nome, lang FROM pep_usuarios WHERE id=$1`, [m.usuario_id]);
      if (!u.rows.length) continue;
      const { email, nome, lang } = u.rows[0];
      const l = lang || 'pt';
      const tmpl = emailTemplates.expirado[l] || emailTemplates.expirado['pt'];
      const { sub, body } = tmpl(nome.split(' ')[0], m.plano, BASE_URL);
      await enviarEmail(email, sub, wrapEmail(body)).catch(() => {});
    }

    // 2. Avisar membros que vencem em 7 dias (só pagos)
    const avencer = await pool.query(`
      SELECT m.id, m.plano, m.membro_ate, u.email, u.nome, COALESCE(u.lang,'pt') as lang
      FROM pep_membros m
      JOIN pep_usuarios u ON u.id = m.usuario_id
      WHERE m.status = 'ativo'
        AND m.plano != 'bronze'
        AND m.membro_ate::date = (NOW() + INTERVAL '7 days')::date
    `);

    for (const m of avencer.rows) {
      const lang = m.lang || 'pt';
      const venceEm = new Date(m.membro_ate).toLocaleDateString(lang === 'pt' ? 'pt-BR' : lang === 'de' ? 'de-DE' : lang === 'fr' ? 'fr-FR' : 'en-US');
      const nivelNomes = {
        pt: { prata:'Prata 🥈', ouro:'Ouro 🥇', diamante:'Diamante 💎' },
        en: { prata:'Silver 🥈', ouro:'Gold 🥇', diamante:'Diamond 💎' },
        es: { prata:'Plata 🥈', ouro:'Oro 🥇', diamante:'Diamante 💎' },
        de: { prata:'Silber 🥈', ouro:'Gold 🥇', diamante:'Diamant 💎' },
        fr: { prata:'Argent 🥈', ouro:'Or 🥇', diamante:'Diamant 💎' }
      };
      const nomePlano = (nivelNomes[lang] || nivelNomes['pt'])[m.plano] || m.plano;
      const tmpl = emailTemplates.aviso7dias[lang] || emailTemplates.aviso7dias['pt'];
      const { sub, body } = tmpl(m.nome.split(' ')[0], nomePlano, venceEm, BASE_URL);
      await enviarEmail(m.email, sub, wrapEmail(body)).catch(() => {});
    }

    if (expirados.rows.length + avencer.rows.length > 0) {
      console.log(`[Job diário] ${expirados.rows.length} expirados, ${avencer.rows.length} avisos enviados`);
    }
  } catch (e) {
    console.error('[Job diário]', e.message);
  }
}

// Job diário iniciado após servidor estar pronto (ver app.listen)

// ── ENV ──────────────────────────────────────
const DATABASE_URL        = process.env.DATABASE_URL;
const JWT_SECRET          = process.env.JWT_SECRET          || 'pep_jwt_secret_2025';
const ADMIN_PASSWORD      = process.env.ADMIN_PASSWORD      || '159357456258';
const PIXGO_API_KEY       = process.env.PIXGO_API_KEY       || '';
const PIXGO_WEBHOOK_SECRET= process.env.PIXGO_WEBHOOK_SECRET|| '';
const RESEND_API_KEY      = process.env.RESEND_API_KEY      || '';
const BASE_URL            = process.env.BASE_URL            || 'https://pepmasters.onrender.com';
const EMAIL_DESTINO       = process.env.EMAIL_DESTINO       || '';   // preencher no Render
const NOWPAYMENTS_API_KEY  = process.env.NOWPAYMENTS_API_KEY  || '';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const EMAIL_USER          = process.env.EMAIL_USER          || 'matheustlopo42@gmail.com';
const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_BASE_URL      = 'https://api-m.paypal.com';
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

// Evitar crash do servidor em caso de erro de conexão do pool
pool.on('error', (err) => {
  console.error('[DB Pool] Erro:', err.message);
});

// ── MIDDLEWARES ───────────────────────────────
app.use(express.json());
// Forçar HTTPS em produção
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Servir arquivos JS da raiz (i18n, etc)
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
app.get('/i18n-init.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n-init.js')));
app.get('/sitemap.xml', (req, res) => res.sendFile(path.join(__dirname, 'sitemap.xml')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'robots.txt')));

// ── INIT TABELAS ─────────────────────────────
// Calcula valores de split PIX com pequenas variações para evitar bloqueio bancário
// por múltiplos PIX de valor idêntico no mesmo dia
function calcularSplitPix(total, numQrs) {
  if (numQrs <= 1) return [parseFloat(total.toFixed(2))];
  const base = Math.floor((total / numQrs) * 100) / 100;
  const valores = [];
  let soma = 0;
  for (let i = 0; i < numQrs - 1; i++) {
    const v = parseFloat((base + (i + 1) * 0.03).toFixed(2)); // +0.03, +0.06... a partir da 1ª parte
    valores.push(v);
    soma += v;
  }
  const ultimo = parseFloat((total - soma).toFixed(2));
  valores.push(ultimo);
  return valores;
}

async function initDB() {
  const client = await pool.connect();
  try {

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
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS reset_exp BIGINT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_usuarios ADD COLUMN IF NOT EXISTS lang TEXT DEFAULT 'pt'`).catch(()=>{});

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
      'produto_id TEXT', 'produto_nome TEXT', 'preco_unitario NUMERIC(10,2)',
      'desconto NUMERIC(10,2) DEFAULT 0', 'total NUMERIC(10,2)',
      'pagamento TEXT', 'cupom TEXT', 'status TEXT DEFAULT \'pix_pending\'',
      'pixgo_id TEXT', 'codigo_rastreio TEXT',
      'crypto_valor NUMERIC(18,6) DEFAULT 0', 'crypto_token TEXT'
    ];
    for (const col of pedidosCols) {
      const colName = col.split(' ')[0];
      await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    }
    // Converter produto_id de INT para TEXT (códigos de produto agora são alfanuméricos, ex: 'TB10', 'CGL5')
    await client.query(`ALTER TABLE pep_pedidos ALTER COLUMN produto_id TYPE TEXT USING produto_id::TEXT`).catch(() => {});

    // Cupons — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_cupons (
        id        SERIAL PRIMARY KEY,
        codigo    TEXT UNIQUE NOT NULL,
        ativo     BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS desconto_pix INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS desconto_cartao INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_cupons ADD COLUMN IF NOT EXISTS usos_max INT DEFAULT 0`).catch(()=>{});

    // Estoque — garantir colunas necessárias
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_estoque (
        id        SERIAL PRIMARY KEY,
        produto_id VARCHAR(100),
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS nome TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS preco NUMERIC(10,2)`).catch(()=>{});
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS preco_original NUMERIC(10,2)`).catch(()=>{});
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS descricao TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS estoque INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_estoque ADD COLUMN IF NOT EXISTS alerta_minimo INT DEFAULT 3`).catch(()=>{});

    // ── MEMBROS ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_membros (
        id            SERIAL PRIMARY KEY,
        usuario_id    INT NOT NULL REFERENCES pep_usuarios(id),
        plano         TEXT DEFAULT 'bronze',
        status        TEXT DEFAULT 'pendente',
        membro_ate    TIMESTAMPTZ,
        codigo_ref    TEXT UNIQUE,
        nivel         TEXT DEFAULT 'bronze',
        vendas_total  NUMERIC(10,2) DEFAULT 0,
        credito       NUMERIC(10,2) DEFAULT 0,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS mensalidade NUMERIC(10,2) DEFAULT 0`);
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS pagamento TEXT DEFAULT 'cripto'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_pagamentos_membros (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        valor       NUMERIC(10,2),
        pagamento   TEXT,
        status      TEXT DEFAULT 'pendente',
        crypto_valor NUMERIC(18,6) DEFAULT 0,
        crypto_token TEXT,
        referencia  TEXT,
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_vendas_afiliado (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        pedido_id   INT,
        valor       NUMERIC(10,2),
        comissao    NUMERIC(10,2),
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Coluna ref_code em pedidos para rastrear afiliado
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS ref_code TEXT`).catch(() => {});
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS pix_partes_pagas INT DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS retirada_paraguai BOOLEAN DEFAULT FALSE`).catch(() => {});

    // ── PEPMASTERS CLUB ──────────────────────────────────

    // Fornecedores
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_fornecedores (
        id            SERIAL PRIMARY KEY,
        usuario_id    INT REFERENCES pep_usuarios(id),
        nome_loja     TEXT NOT NULL,
        descricao     TEXT,
        nivel         TEXT DEFAULT 'bronze',
        status        TEXT DEFAULT 'pendente',
        taxa_pct      NUMERIC(5,2) DEFAULT 5.00,
        mensalidade   NUMERIC(10,2) DEFAULT 0,
        mensalidade_status TEXT DEFAULT 'pendente',
        mensalidade_vence  TIMESTAMPTZ,
        total_vendas  NUMERIC(12,2) DEFAULT 0,
        pedidos_ok    INT DEFAULT 0,
        disputas      INT DEFAULT 0,
        saldo         NUMERIC(12,2) DEFAULT 0,
        logo_url      TEXT,
        whatsapp      TEXT,
        instagram     TEXT,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    // Produtos do Club
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_produtos (
        id            SERIAL PRIMARY KEY,
        fornecedor_id INT NOT NULL REFERENCES club_fornecedores(id),
        nome          TEXT NOT NULL,
        descricao     TEXT,
        categoria     TEXT,
        preco         NUMERIC(10,2) NOT NULL,
        estoque       INT DEFAULT 0,
        imagem_url    TEXT,
        status        TEXT DEFAULT 'pendente',
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    // Pedidos do Club (com custódia)
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_pedidos (
        id              SERIAL PRIMARY KEY,
        usuario_id      INT REFERENCES pep_usuarios(id),
        fornecedor_id   INT NOT NULL REFERENCES club_fornecedores(id),
        produto_id      INT NOT NULL REFERENCES club_produtos(id),
        nome_cliente    TEXT,
        email_cliente   TEXT,
        telefone_cliente TEXT,
        endereco        TEXT,
        produto_nome    TEXT,
        quantidade      INT DEFAULT 1,
        preco_unit      NUMERIC(10,2),
        total           NUMERIC(10,2),
        taxa            NUMERIC(10,2),
        valor_fornecedor NUMERIC(10,2),
        pagamento       TEXT DEFAULT 'pix',
        status          TEXT DEFAULT 'aguardando_pagamento',
        pixgo_id        TEXT,
        qrcode_url      TEXT,
        copia_cola      TEXT,
        crypto_token    TEXT,
        nowpay_id       TEXT,
        nowpay_address  TEXT,
        nowpay_amount   NUMERIC(18,6),
        codigo_rastreio TEXT,
        enviado_em      TIMESTAMPTZ,
        liberado_em     TIMESTAMPTZ,
        criado_em       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    // Disputas
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_disputas (
        id            SERIAL PRIMARY KEY,
        pedido_id     INT NOT NULL REFERENCES club_pedidos(id),
        usuario_id    INT REFERENCES pep_usuarios(id),
        motivo        TEXT,
        descricao     TEXT,
        status        TEXT DEFAULT 'aberta',
        resolucao     TEXT,
        resolvido_por TEXT,
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        resolvido_em  TIMESTAMPTZ
      )
    `).catch(()=>{});

    // Saldo/extrato dos clientes (estorno vira crédito)
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_saldo_clientes (
        id            SERIAL PRIMARY KEY,
        usuario_id    INT NOT NULL REFERENCES pep_usuarios(id),
        tipo          TEXT,
        valor         NUMERIC(10,2),
        descricao     TEXT,
        pedido_id     INT,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});

    // Saques de fornecedores
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_saques (
        id            SERIAL PRIMARY KEY,
        fornecedor_id INT NOT NULL REFERENCES club_fornecedores(id),
        valor         NUMERIC(10,2),
        metodo        TEXT,
        destino       TEXT,
        status        TEXT DEFAULT 'pendente',
        criado_em     TIMESTAMPTZ DEFAULT NOW(),
        processado_em TIMESTAMPTZ
      )
    `).catch(()=>{});

    // Avaliações
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_avaliacoes (
        id            SERIAL PRIMARY KEY,
        pedido_id     INT NOT NULL REFERENCES club_pedidos(id),
        fornecedor_id INT NOT NULL REFERENCES club_fornecedores(id),
        usuario_id    INT REFERENCES pep_usuarios(id),
        nota          INT NOT NULL CHECK (nota >= 1 AND nota <= 5),
        comentario    TEXT,
        resposta      TEXT,
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await client.query(`ALTER TABLE club_pedidos ADD COLUMN IF NOT EXISTS avaliado BOOLEAN DEFAULT FALSE`).catch(()=>{});
    await client.query(`ALTER TABLE club_fornecedores ADD COLUMN IF NOT EXISTS nota_media NUMERIC(3,2) DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE club_fornecedores ADD COLUMN IF NOT EXISTS total_avaliacoes INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS observacao TEXT`).catch(()=>{});

    // Chat do Club
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_chats (
        id            SERIAL PRIMARY KEY,
        fornecedor_id INT NOT NULL REFERENCES club_fornecedores(id),
        usuario_id    INT REFERENCES pep_usuarios(id),
        pedido_id     INT REFERENCES club_pedidos(id),
        assunto       TEXT,
        status        TEXT DEFAULT 'aberto',
        ultima_msg_em TIMESTAMPTZ DEFAULT NOW(),
        criado_em     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await client.query(`
      CREATE TABLE IF NOT EXISTS club_mensagens (
        id             SERIAL PRIMARY KEY,
        chat_id        INT NOT NULL REFERENCES club_chats(id),
        remetente      TEXT NOT NULL,
        remetente_id   INT,
        remetente_nome TEXT,
        texto          TEXT NOT NULL,
        lida           BOOLEAN DEFAULT FALSE,
        criado_em      TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS quantidade INT DEFAULT 1`).catch(()=>{});
    await client.query(`ALTER TABLE pep_pedidos ADD COLUMN IF NOT EXISTS endereco TEXT`).catch(()=>{});



    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_forum_likes (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        topico_id   INT REFERENCES pep_forum_topicos(id) ON DELETE CASCADE,
        resposta_id INT REFERENCES pep_forum_respostas(id) ON DELETE CASCADE,
        criado_em   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(membro_id, topico_id),
        UNIQUE(membro_id, resposta_id)
      )
    `).catch(()=>{});

    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_forum_favoritos (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        topico_id   INT NOT NULL REFERENCES pep_forum_topicos(id) ON DELETE CASCADE,
        criado_em   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(membro_id, topico_id)
      )
    `).catch(()=>{});

    // ── BADGES & CONQUISTAS ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_badges (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        tipo        TEXT NOT NULL,
        criado_em   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(membro_id, tipo)
      )
    `);

    // ── NOTIFICAÇÕES ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_notificacoes (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        tipo        TEXT NOT NULL,
        mensagem    TEXT NOT NULL,
        link        TEXT,
        lida        BOOLEAN DEFAULT FALSE,
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── PERFIL PÚBLICO ────────────────────────────
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS bio TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS instagram TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS whatsapp TEXT`).catch(()=>{});
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS perfil_publico BOOLEAN DEFAULT FALSE`).catch(()=>{});
    await client.query(`ALTER TABLE pep_membros ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE`).catch(()=>{});

    // ── FÓRUM ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_forum_topicos (
        id          SERIAL PRIMARY KEY,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        titulo      TEXT NOT NULL,
        conteudo    TEXT NOT NULL,
        categoria   TEXT DEFAULT 'geral',
        views       INT DEFAULT 0,
        fixado      BOOLEAN DEFAULT FALSE,
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_forum_respostas (
        id          SERIAL PRIMARY KEY,
        topico_id   INT NOT NULL REFERENCES pep_forum_topicos(id) ON DELETE CASCADE,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        conteudo    TEXT NOT NULL,
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pep_forum_denuncias (
        id          SERIAL PRIMARY KEY,
        topico_id   INT REFERENCES pep_forum_topicos(id) ON DELETE CASCADE,
        resposta_id INT REFERENCES pep_forum_respostas(id) ON DELETE CASCADE,
        membro_id   INT NOT NULL REFERENCES pep_membros(id),
        motivo      TEXT,
        status      TEXT DEFAULT 'pendente',
        criado_em   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await client.query(`ALTER TABLE pep_forum_respostas ADD COLUMN IF NOT EXISTS denuncias INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_forum_topicos ADD COLUMN IF NOT EXISTS likes INT DEFAULT 0`).catch(()=>{});
    await client.query(`ALTER TABLE pep_forum_respostas ADD COLUMN IF NOT EXISTS likes INT DEFAULT 0`).catch(()=>{});

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

    // Seed produtos se estoque vazio
    const { rows } = await client.query('SELECT COUNT(*) FROM pep_estoque');
    if (parseInt(rows[0].count) === 0) {
      const produtos = [
        { id:'1',  nome:'BPC-157',          preco:150.00, descricao:'Recuperacao muscular e articular acelerada.',         estoque:10 },
        { id:'2',  nome:'TB-500',            preco:180.00, descricao:'Regeneracao tecidual e anti-inflamatorio.',            estoque:10 },
        { id:'3',  nome:'HGH Frag 176-191', preco:160.00, descricao:'Queima de gordura sem efeitos do GH completo.',        estoque:10 },
        { id:'4',  nome:'Ipamorelin',        preco:140.00, descricao:'Estimulante seletivo do hormonio do crescimento.',     estoque:10 },
        { id:'5',  nome:'Sermorelin',        preco:170.00, descricao:'Anti-aging, sono e estimulo natural do GH.',           estoque:0  },
        { id:'6',  nome:'CJC-1295',          preco:180.00, descricao:'Estimulante de GH de longa duracao para massa.',       estoque:10 },
        { id:'7',  nome:'IGF-1 LR3',         preco:220.00, descricao:'Fator de crescimento insulinico para hipertrofia.',    estoque:10 },
        { id:'8',  nome:'IGF-1 DES',         preco:200.00, descricao:'Variante do IGF-1 com acao local nos musculos.',       estoque:10 },
        { id:'9',  nome:'ACE-031',           preco:250.00, descricao:'Inibidor da miostatina. Potencializa massa e forca.',  estoque:10 },
        { id:'10', nome:'Semax',             preco:160.00, descricao:'Neuropeptideo para foco, memoria e funcao cerebral.',  estoque:10 },
        { id:'11', nome:'Selank',            preco:150.00, descricao:'Ansiolitico natural com efeito nootropico.',           estoque:10 },
        { id:'12', nome:'Kisspeptin',        preco:190.00, descricao:'Estimula producao de LH e testosterona.',              estoque:10 },
        { id:'13', nome:'SS-31',             preco:210.00, descricao:'Acao antioxidante mitocondrial e cardioprotetora.',    estoque:10 },
        { id:'14', nome:'SLU-PP-32',         preco:230.00, descricao:'Simula efeitos metabolicos do exercicio.',             estoque:10 },
        { id:'15', nome:'AHK-CU',            preco:140.00, descricao:'Peptideo de cobre para cabelo, pele e cabelos.',       estoque:10 },
        { id:'16', nome:'VIP',               preco:200.00, descricao:'Potente anti-inflamatorio e vasoativo intestinal.',    estoque:10 },
      ];
      for (const p of produtos) {
        await client.query(
          'INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [p.id, p.nome, p.preco, p.descricao, p.estoque]
        );
      }
      console.log('[DB] Produtos inseridos no estoque.');
    }
  } catch (err) {
    console.error('[DB] Erro no init:', err.message);
    throw err;
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


// ── EMAIL TEMPLATES MULTILÍNGUE ──────────────────────────────────────────
const emailTemplates = {
  boasVindas: {
    pt: (nome, base) => ({ sub: '🎉 Bem-vindo ao PEPMASTERS!', body: `<h2 style="color:#FFB300">Olá, ${nome}! 👋</h2><p>Sua conta foi criada com sucesso.</p><ul><li>Explorar nosso catálogo</li><li>Ativar acesso Members gratuito</li><li>Ganhar comissões</li></ul><a href="${base}" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Acessar a loja →</a>` }),
    en: (nome, base) => ({ sub: '🎉 Welcome to PEPMASTERS!', body: `<h2 style="color:#FFB300">Hello, ${nome}! 👋</h2><p>Your account was created successfully.</p><ul><li>Explore our catalog</li><li>Activate free Members access</li><li>Earn commissions</li></ul><a href="${base}" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Visit the store →</a>` }),
    es: (nome, base) => ({ sub: '🎉 ¡Bienvenido a PEPMASTERS!', body: `<h2 style="color:#FFB300">¡Hola, ${nome}! 👋</h2><p>Tu cuenta fue creada con éxito.</p><ul><li>Explorar nuestro catálogo</li><li>Activar acceso Members gratuito</li><li>Ganar comisiones</li></ul><a href="${base}" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Visitar la tienda →</a>` }),
    de: (nome, base) => ({ sub: '🎉 Willkommen bei PEPMASTERS!', body: `<h2 style="color:#FFB300">Hallo, ${nome}! 👋</h2><p>Ihr Konto wurde erfolgreich erstellt.</p><ul><li>Katalog erkunden</li><li>Kostenlosen Members-Zugang aktivieren</li><li>Provisionen verdienen</li></ul><a href="${base}" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Shop besuchen →</a>` }),
    fr: (nome, base) => ({ sub: '🎉 Bienvenue sur PEPMASTERS!', body: `<h2 style="color:#FFB300">Bonjour, ${nome}! 👋</h2><p>Votre compte a été créé avec succès.</p><ul><li>Explorer notre catalogue</li><li>Activer l'accès Members gratuit</li><li>Gagner des commissions</li></ul><a href="${base}" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Visiter la boutique →</a>` }),
  },
  planoAtivo: {
    pt: (nome, plano, vence, comissao, desconto, link, base) => ({ sub: `✅ Plano ${plano} ativado — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Plano ${plano} ativado!</h2><p>Olá, ${nome}!</p><p>Ativo até <strong>${vence}</strong>.</p><ul><li>${comissao} de comissão por venda</li><li>${desconto} de desconto na loja</li></ul><p>Link de afiliado: <strong>${link}</strong></p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Acessar painel →</a>` }),
    en: (nome, plano, vence, comissao, desconto, link, base) => ({ sub: `✅ Plan ${plano} activated — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Plan ${plano} activated!</h2><p>Hello, ${nome}!</p><p>Active until <strong>${vence}</strong>.</p><ul><li>${comissao} commission per sale</li><li>${desconto} store discount</li></ul><p>Affiliate link: <strong>${link}</strong></p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Access panel →</a>` }),
    es: (nome, plano, vence, comissao, desconto, link, base) => ({ sub: `✅ Plan ${plano} activado — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Plan ${plano} activado!</h2><p>Hola, ${nome}!</p><p>Activo hasta <strong>${vence}</strong>.</p><ul><li>${comissao} de comisión por venta</li><li>${desconto} de descuento en tienda</li></ul><p>Enlace de afiliado: <strong>${link}</strong></p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Acceder al panel →</a>` }),
    de: (nome, plano, vence, comissao, desconto, link, base) => ({ sub: `✅ Plan ${plano} aktiviert — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Plan ${plano} aktiviert!</h2><p>Hallo, ${nome}!</p><p>Aktiv bis <strong>${vence}</strong>.</p><ul><li>${comissao} Provision pro Verkauf</li><li>${desconto} Rabatt im Shop</li></ul><p>Affiliate-Link: <strong>${link}</strong></p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Panel öffnen →</a>` }),
    fr: (nome, plano, vence, comissao, desconto, link, base) => ({ sub: `✅ Plan ${plano} activé — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Plan ${plano} activé!</h2><p>Bonjour, ${nome}!</p><p>Actif jusqu'au <strong>${vence}</strong>.</p><ul><li>${comissao} de commission par vente</li><li>${desconto} de remise en boutique</li></ul><p>Lien d'affiliation: <strong>${link}</strong></p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Accéder au panneau →</a>` }),
  },
  aviso7dias: {
    pt: (nome, plano, vence, base) => ({ sub: `⏳ Seu plano ${plano} vence em 7 dias`, body: `<h2 style="color:#FFB300">⏳ Seu plano vence em 7 dias</h2><p>Olá, ${nome}!</p><p>Seu plano <strong>${plano}</strong> vence em <strong>${vence}</strong>.</p><p>💡 Ao renovar antes do vencimento, os novos 30 dias são somados ao tempo restante!</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renovar agora →</a>` }),
    en: (nome, plano, vence, base) => ({ sub: `⏳ Your ${plano} plan expires in 7 days`, body: `<h2 style="color:#FFB300">⏳ Your plan expires in 7 days</h2><p>Hello, ${nome}!</p><p>Your <strong>${plano}</strong> plan expires on <strong>${vence}</strong>.</p><p>💡 Renewing before expiration adds 30 days to your remaining time!</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renew now →</a>` }),
    es: (nome, plano, vence, base) => ({ sub: `⏳ Tu plan ${plano} vence en 7 días`, body: `<h2 style="color:#FFB300">⏳ Tu plan vence en 7 días</h2><p>Hola, ${nome}!</p><p>Tu plan <strong>${plano}</strong> vence el <strong>${vence}</strong>.</p><p>💡 ¡Al renovar antes del vencimiento, los 30 días se suman al tiempo restante!</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renovar ahora →</a>` }),
    de: (nome, plano, vence, base) => ({ sub: `⏳ Ihr ${plano}-Plan läuft in 7 Tagen ab`, body: `<h2 style="color:#FFB300">⏳ Ihr Plan läuft in 7 Tagen ab</h2><p>Hallo, ${nome}!</p><p>Ihr <strong>${plano}</strong>-Plan läuft am <strong>${vence}</strong> ab.</p><p>💡 Bei Verlängerung vor Ablauf werden 30 Tage zur verbleibenden Zeit addiert!</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Jetzt verlängern →</a>` }),
    fr: (nome, plano, vence, base) => ({ sub: `⏳ Votre plan ${plano} expire dans 7 jours`, body: `<h2 style="color:#FFB300">⏳ Votre plan expire dans 7 jours</h2><p>Bonjour, ${nome}!</p><p>Votre plan <strong>${plano}</strong> expire le <strong>${vence}</strong>.</p><p>💡 En renouvelant avant l'expiration, 30 jours s'ajoutent au temps restant!</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renouveler maintenant →</a>` }),
  },

  pedidoConfirmado: {
    pt: (nome, id, produto, total, base) => ({ sub: `✅ Pedido #${id} confirmado — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Pedido confirmado!</h2><p>Olá, ${nome}!</p><p>Seu pedido <strong>#${id}</strong> de <strong>${produto}</strong> foi confirmado.</p><p style="font-size:1.2rem;color:#FFB300;font-weight:bold">Total: R$ ${total}</p><p>Você receberá o código de rastreio assim que o pedido for enviado.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver meus pedidos →</a>` }),
    en: (nome, id, produto, total, base) => ({ sub: `✅ Order #${id} confirmed — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Order confirmed!</h2><p>Hello, ${nome}!</p><p>Your order <strong>#${id}</strong> for <strong>${produto}</strong> has been confirmed.</p><p style="font-size:1.2rem;color:#FFB300;font-weight:bold">Total: R$ ${total}</p><p>You will receive the tracking code once your order is shipped.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">View my orders →</a>` }),
    es: (nome, id, produto, total, base) => ({ sub: `✅ Pedido #${id} confirmado — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ ¡Pedido confirmado!</h2><p>Hola, ${nome}!</p><p>Tu pedido <strong>#${id}</strong> de <strong>${produto}</strong> ha sido confirmado.</p><p style="font-size:1.2rem;color:#FFB300;font-weight:bold">Total: R$ ${total}</p><p>Recibirás el código de seguimiento una vez que se envíe tu pedido.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver mis pedidos →</a>` }),
    de: (nome, id, produto, total, base) => ({ sub: `✅ Bestellung #${id} bestätigt — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Bestellung bestätigt!</h2><p>Hallo, ${nome}!</p><p>Ihre Bestellung <strong>#${id}</strong> für <strong>${produto}</strong> wurde bestätigt.</p><p style="font-size:1.2rem;color:#FFB300;font-weight:bold">Gesamt: R$ ${total}</p><p>Sie erhalten den Tracking-Code, sobald Ihre Bestellung versendet wird.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Bestellungen ansehen →</a>` }),
    fr: (nome, id, produto, total, base) => ({ sub: `✅ Commande #${id} confirmée — PEPMASTERS`, body: `<h2 style="color:#FFB300">✅ Commande confirmée!</h2><p>Bonjour, ${nome}!</p><p>Votre commande <strong>#${id}</strong> pour <strong>${produto}</strong> a été confirmée.</p><p style="font-size:1.2rem;color:#FFB300;font-weight:bold">Total: R$ ${total}</p><p>Vous recevrez le code de suivi une fois votre commande expédiée.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Voir mes commandes →</a>` }),
  },
  pedidoEnviado: {
    pt: (nome, produto, rastreio, base) => ({ sub: `📦 Pedido enviado — PEPMASTERS`, body: `<h2 style="color:#FFB300">📦 Seu pedido foi enviado!</h2><p>Olá, ${nome}!</p><p>Seu pedido de <strong>${produto}</strong> foi enviado.</p>${rastreio?`<p>Código de rastreio: <strong style="color:#FFB300">${rastreio}</strong></p><p><a href="https://rastreamento.correios.com.br/app/index.php?objetos=${rastreio}">Rastrear pedido →</a></p>`:''}<a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver meus pedidos →</a>` }),
    en: (nome, produto, rastreio, base) => ({ sub: `📦 Order shipped — PEPMASTERS`, body: `<h2 style="color:#FFB300">📦 Your order has been shipped!</h2><p>Hello, ${nome}!</p><p>Your order of <strong>${produto}</strong> has been shipped.</p>${rastreio?`<p>Tracking code: <strong style="color:#FFB300">${rastreio}</strong></p>`:''}<a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">View my orders →</a>` }),
    es: (nome, produto, rastreio, base) => ({ sub: `📦 Pedido enviado — PEPMASTERS`, body: `<h2 style="color:#FFB300">📦 ¡Tu pedido ha sido enviado!</h2><p>Hola, ${nome}!</p><p>Tu pedido de <strong>${produto}</strong> ha sido enviado.</p>${rastreio?`<p>Código de seguimiento: <strong style="color:#FFB300">${rastreio}</strong></p>`:''}<a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver mis pedidos →</a>` }),
    de: (nome, produto, rastreio, base) => ({ sub: `📦 Bestellung versandt — PEPMASTERS`, body: `<h2 style="color:#FFB300">📦 Ihre Bestellung wurde versandt!</h2><p>Hallo, ${nome}!</p><p>Ihre Bestellung von <strong>${produto}</strong> wurde versandt.</p>${rastreio?`<p>Tracking-Code: <strong style="color:#FFB300">${rastreio}</strong></p>`:''}<a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Bestellungen ansehen →</a>` }),
    fr: (nome, produto, rastreio, base) => ({ sub: `📦 Commande expédiée — PEPMASTERS`, body: `<h2 style="color:#FFB300">📦 Votre commande a été expédiée!</h2><p>Bonjour, ${nome}!</p><p>Votre commande de <strong>${produto}</strong> a été expédiée.</p>${rastreio?`<p>Code de suivi: <strong style="color:#FFB300">${rastreio}</strong></p>`:''}<a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Voir mes commandes →</a>` }),
  },
  pedidoEntregue: {
    pt: (nome, produto, base) => ({ sub: `🎉 Pedido entregue — PEPMASTERS`, body: `<h2 style="color:#FFB300">🎉 Pedido entregue!</h2><p>Olá, ${nome}!</p><p>Seu pedido de <strong>${produto}</strong> foi entregue! Esperamos que goste.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver meus pedidos →</a>` }),
    en: (nome, produto, base) => ({ sub: `🎉 Order delivered — PEPMASTERS`, body: `<h2 style="color:#FFB300">🎉 Order delivered!</h2><p>Hello, ${nome}!</p><p>Your order of <strong>${produto}</strong> has been delivered! We hope you enjoy it.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">View my orders →</a>` }),
    es: (nome, produto, base) => ({ sub: `🎉 Pedido entregado — PEPMASTERS`, body: `<h2 style="color:#FFB300">🎉 ¡Pedido entregado!</h2><p>Hola, ${nome}!</p><p>Tu pedido de <strong>${produto}</strong> ha sido entregado. ¡Esperamos que lo disfrutes!</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Ver mis pedidos →</a>` }),
    de: (nome, produto, base) => ({ sub: `🎉 Bestellung geliefert — PEPMASTERS`, body: `<h2 style="color:#FFB300">🎉 Bestellung geliefert!</h2><p>Hallo, ${nome}!</p><p>Ihre Bestellung von <strong>${produto}</strong> wurde geliefert! Wir hoffen, es gefällt Ihnen.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Bestellungen ansehen →</a>` }),
    fr: (nome, produto, base) => ({ sub: `🎉 Commande livrée — PEPMASTERS`, body: `<h2 style="color:#FFB300">🎉 Commande livrée!</h2><p>Bonjour, ${nome}!</p><p>Votre commande de <strong>${produto}</strong> a été livrée ! Nous espérons que vous l'apprécierez.</p><a href="${base}/meus-pedidos.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Voir mes commandes →</a>` }),
  },
  expirado: {
    pt: (nome, plano, base) => ({ sub: '⚠️ Seu plano PEPMASTERS expirou', body: `<h2 style="color:#ef4444">⚠️ Seu plano expirou</h2><p>Olá, ${nome}!</p><p>Seu plano <strong>${plano}</strong> expirou. Renove para continuar com seus benefícios.</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renovar plano →</a>` }),
    en: (nome, plano, base) => ({ sub: '⚠️ Your PEPMASTERS plan has expired', body: `<h2 style="color:#ef4444">⚠️ Your plan has expired</h2><p>Hello, ${nome}!</p><p>Your <strong>${plano}</strong> plan has expired. Renew to keep your benefits.</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renew plan →</a>` }),
    es: (nome, plano, base) => ({ sub: '⚠️ Tu plan PEPMASTERS ha expirado', body: `<h2 style="color:#ef4444">⚠️ Tu plan ha expirado</h2><p>Hola, ${nome}!</p><p>Tu plan <strong>${plano}</strong> ha expirado. Renueva para mantener tus beneficios.</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renovar plan →</a>` }),
    de: (nome, plano, base) => ({ sub: '⚠️ Ihr PEPMASTERS-Plan ist abgelaufen', body: `<h2 style="color:#ef4444">⚠️ Ihr Plan ist abgelaufen</h2><p>Hallo, ${nome}!</p><p>Ihr <strong>${plano}</strong>-Plan ist abgelaufen. Verlängern Sie, um Ihre Vorteile zu behalten.</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Plan verlängern →</a>` }),
    fr: (nome, plano, base) => ({ sub: '⚠️ Votre plan PEPMASTERS a expiré', body: `<h2 style="color:#ef4444">⚠️ Votre plan a expiré</h2><p>Bonjour, ${nome}!</p><p>Votre plan <strong>${plano}</strong> a expiré. Renouvelez pour conserver vos avantages.</p><a href="${base}/members.html" style="padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px">Renouveler le plan →</a>` }),
  }
};

function wrapEmail(body) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#1C0A00;color:#fff;border-radius:12px">
    <div style="text-align:center;margin-bottom:20px"><strong style="font-size:1.4rem;background:linear-gradient(135deg,#E8220A,#FF6B00,#FFB300);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">PEPMASTERS</strong></div>
    ${body}
    <hr style="border-color:rgba(255,255,255,.1);margin:24px 0"/>
    <p style="font-size:.78rem;color:rgba(255,255,255,.3);text-align:center">PEPMASTERS — Performance através da ciência.</p>
  </div>`;
}

async function getUserLang(usuario_id) {
  try {
    const r = await pool.query(`SELECT lang FROM pep_usuarios WHERE id=$1`, [usuario_id]);
    return (r.rows[0]?.lang) || 'pt';
  } catch { return 'pt'; }
}

// ── EMAIL (Resend) ────────────────────────────
async function enviarEmail(para, assunto, html) {
  if (!para || !RESEND_API_KEY) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'PEPMASTERS <noreply@pepmasters.io>',
        to: [para],
        subject: assunto,
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log('[Email] Enviado para ' + para);
    else console.error('[Email] Erro Resend:', JSON.stringify(d));
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
      'SELECT produto_id AS id, nome, preco, preco_original, descricao, estoque FROM pep_estoque WHERE nome IS NOT NULL ORDER BY produto_id'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

// POST /api/cadastro
app.post('/api/cadastro', rateLimit(5, 60000), async (req, res) => {
  const { nome, email, cpf, telefone, senha, lang } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ erro: 'Campos obrigatórios ausentes.' });
  try {
    const existe = await pool.query('SELECT id FROM pep_usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length) return res.status(400).json({ erro: 'Email já cadastrado.' });

    const userLang = lang || 'pt';
    const hash = await bcrypt.hash(senha, 10);
    const { rows } = await pool.query(
      'INSERT INTO pep_usuarios (nome,email,cpf,telefone,senha_hash,lang) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,nome,email',
      [nome, email.toLowerCase(), cpf || null, telefone || null, hash, userLang]
    );
    const u = rows[0];

    // Email de boas-vindas multilíngue
    try {
      const tmpl = emailTemplates.boasVindas[userLang] || emailTemplates.boasVindas['pt'];
      const { sub, body } = tmpl(u.nome.split(' ')[0], BASE_URL);
      enviarEmail(u.email, sub, wrapEmail(body)).catch(() => {});
    } catch (e) {
      console.error('[Cadastro] Erro ao enviar email boas-vindas:', e.message);
    }

    res.json({ token: gerarToken(u.id), nome: u.nome, email: u.email });
  } catch (err) {
    console.error('[Cadastro] Erro:', err.message);
    res.status(500).json({ erro: 'Erro ao cadastrar: ' + err.message });
  }
});

// POST /api/login
app.post('/api/login', rateLimit(10, 60000), async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  try {
    const { rows } = await pool.query('SELECT * FROM pep_usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    const u = rows[0];
    const ok = await bcrypt.compare(senha, u.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    res.json({ token: gerarToken(u.id), nome: u.nome, email: u.email, lang: u.lang || 'pt' });
  } catch {
    res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

// POST /api/esqueci-senha
app.post('/api/esqueci-senha', rateLimit(3, 60000), async (req, res) => {
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
app.post('/api/pedido', rateLimit(10, 60000), async (req, res) => {
  const {
    nome, email, cpf, telefone,
    endereco, carrinho, pagamento, cupom, total: totalFront,
    crypto_valor, crypto_token,
    token: userToken,
    ref_code,
    retirada_paraguai
  } = req.body;

  if (!nome || !email || !pagamento || !carrinho || !carrinho.length) {
    return res.status(400).json({ erro: 'Dados incompletos.' });
  }

  // Validações de caixa/família (segurança — espelha validação do frontend)
  const totalAmpolasPedido = carrinho.reduce((s, i) => s + parseInt(i.quantidade), 0);
  if (totalAmpolasPedido % 10 !== 0) {
    return res.status(400).json({ erro: 'O total de ampolas deve ser múltiplo de 10 (1 caixa).' });
  }
  if (totalAmpolasPedido > 50) {
    return res.status(400).json({ erro: 'Máximo 50 ampolas (5 caixas) por pedido.' });
  }
  const caixasPedidoSrv = Math.max(1, Math.ceil(totalAmpolasPedido / 10));
  const maxProdutosSrv = caixasPedidoSrv * 5;
  if (carrinho.length > maxProdutosSrv) {
    return res.status(400).json({ erro: 'Máximo ' + maxProdutosSrv + ' produtos diferentes para ' + caixasPedidoSrv + ' caixa(s) (5 produtos por caixa).' });
  }
  for (const item of carrinho) {
    const q = parseInt(item.quantidade);
    if (q < 2) return res.status(400).json({ erro: 'Quantidade mínima de ' + item.nome + ' é 2 unidades.' });
  }
  const FAMILIAS_SRV = {
    retatrutide:['RT30','RT40','RT60'], tirzepatide:['TR30','TR40','TR50','TR60'],
    ss31:['2S10','2S50'], tesamorelin:['TSM10','TSM20'], motsc:['MS20','MS40'],
    epithalon:['ET10','ET50'], bpc157:['BPC10','BPC20'], selank:['SK10','SK30'],
    pinealon:['PIN10','PIN20'], cjcnodac:['CND5','CND10'], cjcdac:['CD5','CD10'],
    sermorelin:['Serm5','Serm10'], adipotide:['AP5','AP10'], semax:['SX5','SX10'],
    ghkcu:['CU50','CU100'], glutathione:['GTT600','GTT1500'], nad:['NJ500','NJ1000'],
    thymosinA:['TA5','TA10'], cagrilintide:['CGL5','CGL10'], aminomq:['20AM','50AM'],
    snap8:['NP8-10','NP8-100'],
  };
  const MAPA_FAM_SRV = {};
  Object.entries(FAMILIAS_SRV).forEach(([fam, codigos]) => { codigos.forEach(c => { MAPA_FAM_SRV[c] = fam; }); });
  const familiaTotaisSrv = {};
  for (const item of carrinho) {
    const fam = MAPA_FAM_SRV[String(item.id)];
    if (!fam) continue;
    familiaTotaisSrv[fam] = (familiaTotaisSrv[fam] || 0) + parseInt(item.quantidade);
  }
  for (const fam in familiaTotaisSrv) {
    if (familiaTotaisSrv[fam] > 10) {
      return res.status(400).json({ erro: 'Máximo 10 ampolas combinando concentrações da família ' + fam + '.' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // descobrir usuario_id se logado (antes do cálculo de desconto)
    let usuarioId = null;
    if (userToken) {
      try { usuarioId = jwt.verify(userToken, JWT_SECRET).id; } catch {}
    }

    // calcular subtotal a partir do carrinho
    const subtotal = carrinho.reduce((s, i) => s + parseFloat(i.preco) * parseInt(i.quantidade), 0);

    // calcular desconto de nível Members
    const descontoPorNivel = { bronze: 5, prata: 10, ouro: 12, diamante: 15 };
    let descontoMembro = 0;
    let nivelMembro = null;
    if (usuarioId || userToken) {
      try {
        const uid = usuarioId || (userToken ? jwt.verify(userToken, JWT_SECRET).id : null);
        if (uid) {
          const membroR = await client.query(`SELECT plano FROM pep_membros WHERE usuario_id=$1 AND status='ativo'`, [uid]);
          if (membroR.rows.length) {
            nivelMembro = membroR.rows[0].plano;
            const pctMembro = descontoPorNivel[nivelMembro] || 0;
            descontoMembro = subtotal * (pctMembro / 100);
          }
        }
      } catch {}
    }
    const subtotalComMembro = subtotal - descontoMembro;

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
        desconto  = subtotalComMembro * (pct / 100);
        cupomId   = c.id;
        if (!(c.usos_max > 0 && c.usos >= c.usos_max)) {
          await client.query('UPDATE pep_cupons SET usos=usos+1 WHERE id=$1', [c.id]);
        }
      }
    }

    const totalProdutos = subtotalComMembro - desconto;

    // Frete real: R$50 por vial (mesmo padrão da calculadora), não sofre desconto
    // Opcional: cliente pode optar por retirar pessoalmente no Paraguai (sem frete)
    const FRETE_POR_VIAL = 50;
    const totalVialsPedido = carrinho.reduce((s, i) => s + parseInt(i.quantidade), 0);
    const freteTotal = retirada_paraguai ? 0 : totalVialsPedido * FRETE_POR_VIAL;

    const total = totalProdutos + freteTotal;

    // montar nomes dos produtos para exibição
    const produto_nome = carrinho.map(i => i.nome + (i.quantidade > 1 ? ' x' + i.quantidade : '')).join(', ');
    const produto_id   = carrinho[0].id;

    // criar pedido
    const statusInicial = (pagamento === 'pix' || pagamento === 'cripto') ? 'pix_pending' : 'pago';
    const pagamentoLabel = pagamento === 'whatsapp' ? 'WhatsApp' : pagamento.toUpperCase();
    const { rows: pedRows } = await client.query(
      `INSERT INTO pep_pedidos
         (usuario_id,nome,email,cpf,telefone,cep,rua,numero,bairro,cidade,complemento,
          produto_id,produto_nome,preco_unitario,desconto,total,pagamento,cupom,status,
          crypto_valor,crypto_token,ref_code,retirada_paraguai)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        usuarioId, nome, email.toLowerCase(), cpf || null, telefone || null,
        endereco?.cep || null, endereco?.rua || null, endereco?.numero || null,
        endereco?.bairro || null, endereco?.cidade || null, endereco?.complemento || null,
        produto_id, produto_nome, subtotal.toFixed(2), (desconto + descontoMembro).toFixed(2), total.toFixed(2),
        pagamento, cupomId ? cupom.toUpperCase() : null, statusInicial,
        crypto_valor || null, crypto_token || null, ref_code || null, !!retirada_paraguai
      ]
    );
    const pedidoId = pedRows[0].id;

    // Registrar venda de afiliado se vier com ref_code
    if (ref_code) {
      registrarVendaAfiliado(ref_code, pedidoId, total).catch(() => {});
    }

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
    let numQrsPix      = 1;

    if (pagamento === 'pix' && PIXGO_API_KEY) {
      if (total > 6000) {
        return res.status(400).json({ erro: 'PIX disponível apenas para valores até R$ 6.000. Use Cripto para valores maiores.' });
      }

      numQrsPix = Math.ceil(total / 2000);
      const splitValores = calcularSplitPix(total, numQrsPix);
      const pixAmount = splitValores[0];

      try {
        const externalId = 'pep-' + pedidoId + (numQrsPix > 1 ? '-1' : '');
        const pixPayload = JSON.stringify({
          amount:      pixAmount,
          description: 'PEPMASTERS #' + pedidoId + (numQrsPix > 1 ? ' (1/' + numQrsPix + ')' : ''),
          external_id: externalId,
          webhook_url: BASE_URL + '/webhook/pixgo'
        });
        const pixRes = await fetch('https://pixgo.org/api/v1/payment/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': PIXGO_API_KEY },
          body: pixPayload
        });
        const pixData = await pixRes.json();
        console.log('[PixGo] Resposta:', JSON.stringify(pixData));
        if (pixData.success && pixData.data) {
          qrcode_url     = pixData.data.qr_image_url || null;
          pix_copia_cola = pixData.data.qr_code      || null;
          if ((pixData.data.payment_id || pixData.data.id)) {
            // pixgo_id format: "id1:pending:numQrs" para split, ou "id1" para simples
            const pixgoId = numQrsPix > 1
              ? (pixData.data.payment_id || pixData.data.id) + ':pending:' + numQrsPix
              : (pixData.data.payment_id || pixData.data.id);
            await pool.query('UPDATE pep_pedidos SET pixgo_id=$1 WHERE id=$2', [pixgoId, pedidoId]);
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
      const isTron = crypto_token === 'TRON';
      const rede = isTron ? 'Tron TRC-20' : 'Polygon (MATIC)';
      const carteira = isTron ? 'TSgzRZDGQVWxn29u4fUgaipGKRSv31HxCB' : '0xDA95bb300C7be3E3347d449b14b834Dc3098deAD';
      const explorer = isTron
        ? 'https://tronscan.org/#/address/TSgzRZDGQVWxn29u4fUgaipGKRSv31HxCB'
        : 'https://polygonscan.com/address/0xDA95bb300C7be3E3347d449b14b834Dc3098deAD';
      const cryptoInfo = (pagamento === 'cripto' && crypto_valor)
        ? `<br><br>💰 <b>Cripto esperado:</b> ${crypto_valor} ${isTron ? 'USDT' : (crypto_token || 'USDT')}<br>` +
          `🌐 <b>Rede:</b> ${rede}<br>` +
          `👛 <b>Carteira:</b> <code>${carteira}</code><br>` +
          `🔍 <a href="${explorer}" style="color:#FFB300">Verificar no explorer →</a>`
        : '';
      enviarEmail(EMAIL_DESTINO,
        (isTron ? '🔶 [TRON] ' : '🔷 [POLYGON] ') + 'Novo pedido #' + pedidoId + ' — PEPMASTERS',
        '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#1C0A00;color:#fff;border-radius:12px">' +
        '<h2 style="color:#FFB300">Novo pedido #' + pedidoId + '</h2>' +
        '<b>Cliente:</b> ' + nome + '<br>' +
        '<b>Email:</b> ' + email + '<br>' +
        '<b>Itens:</b> ' + itensTexto + '<br>' +
        '<b>Total:</b> R$ ' + total.toFixed(2).replace('.',',') + '<br>' +
        '<b>Pagamento:</b> ' + pagamento.toUpperCase() +
        cryptoInfo +
        '</div>'
      );
    }

    // email confirmação para o cliente
    const itensHtml = carrinho.map(i => '<li>' + i.nome + ' × ' + i.quantidade + ' — R$ ' + (i.preco * i.quantidade).toFixed(2).replace('.',',') + '</li>').join('');

    let nowpay_address = null;
    let nowpay_amount = null;
    let nowpay_currency = null;

    if (pagamento === 'cripto') {
      // Criar pagamento NOWPayments automaticamente

      if (NOWPAYMENTS_API_KEY) {
        try {
          // Mapear token do frontend para moeda NOWPayments
          const moedaMap = { 'USDTPOLYGON':'usdtmatic', 'USDCPOLYGON':'usdcmatic', 'USDTTRX':'usdttrc20', 'USDT':'usdtmatic', 'USDC':'usdcmatic', 'TRON':'usdttrc20' };
          const moeda = moedaMap[crypto_token] || 'usdtmatic';
          // Converter BRL para USD
          let totalUsd = total;
          try {
            const cambioRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
            const cambioData = await cambioRes.json();
            const brlRate = cambioData.rates?.BRL || 5.5;
            totalUsd = (total / brlRate).toFixed(2);
          } catch { totalUsd = (total / 5.5).toFixed(2); }

          const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
            method: 'POST',
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              price_amount: totalUsd,
              price_currency: 'usd',
              pay_currency: moeda,
              order_id: String(pedidoId),
              order_description: 'Pedido PEPMASTERS #' + pedidoId,
              ipn_callback_url: BASE_URL + '/api/webhook/nowpayments',
            })
          });
          const npData = await npRes.json();
          if (npData.pay_address) {
            nowpay_address = npData.pay_address;
            nowpay_amount = npData.pay_amount;
            nowpay_currency = npData.pay_currency;
            // Salvar dados do pagamento
            await pool.query(`UPDATE pep_pedidos SET crypto_valor=$1, crypto_token=$2 WHERE id=$3`, [npData.pay_amount, npData.payment_id, pedidoId]);
            console.log('[NOWPayments] Pagamento criado para pedido #' + pedidoId + ': ' + npData.pay_amount + ' ' + npData.pay_currency);
          }
        } catch (e) { console.error('[NOWPayments] Erro ao criar pagamento:', e.message, e.stack?.split('\n')[1]); }
      }
      enviarEmail(email, '⏳ Aguardando confirmação — Pedido #' + pedidoId + ' PEPMASTERS',
        '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
        '<h2 style="color:#e8220a">Olá, ' + nome.split(' ')[0] + '! Seu pedido foi recebido.</h2>' +
        '<p>Seu pedido <b>#' + pedidoId + '</b> está sendo processado.</p>' +
        '<ul>' + itensHtml + '</ul>' +
        '<p><b>Total: R$ ' + total.toFixed(2).replace('.',',') + '</b></p>' +
        (crypto_valor ? '<p>💰 <b>Valor em cripto: ' + crypto_valor + ' ' + (crypto_token || 'USDT') + '</b></p>' : '') +
        '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:16px;margin:20px 0">' +
        '<h3 style="margin:0 0 8px;color:#856404">⏳ Por que meu pedido está aguardando confirmação?</h3>' +
        '<p style="margin:0;color:#856404">Pagamentos em criptomoeda requerem verificação manual na blockchain. ' +
        'Isso é uma característica técnica da tecnologia cripto — não reflete qualquer falha da PEPMASTERS. ' +
        'Nossa equipe verifica e confirma todos os pagamentos em até <b>24 horas úteis</b>.</p>' +
        '</div>' +
        '<p>Assim que confirmarmos seu pagamento, você receberá um email de confirmação.</p>' +
        '<p>Qualquer dúvida, entre em contato via <a href="https://wa.me/5512991217552">WhatsApp</a>.</p>' +
        '<p>Acompanhe seu pedido: <a href="' + BASE_URL + '/meus-pedidos.html">Meus Pedidos</a></p>' +
        '</div>'
      );
    } else {
      enviarEmail(email, 'Pedido #' + pedidoId + ' recebido — PEPMASTERS',
        '<h2>Obrigado, ' + nome.split(' ')[0] + '!</h2>' +
        '<p>Seu pedido <b>#' + pedidoId + '</b> foi recebido!</p>' +
        '<ul>' + itensHtml + '</ul>' +
        '<p><b>Total: R$ ' + total.toFixed(2).replace('.',',') + '</b></p>' +
        '<p>Acompanhe em: <a href="' + BASE_URL + '/meus-pedidos.html">Meus Pedidos</a></p>'
      );
    }

    // Timeout automático para cripto — cancela após 48h se não confirmado
    if (pagamento === 'cripto') {
      setTimeout(async () => {
        try {
          const { rows } = await pool.query('SELECT status FROM pep_pedidos WHERE id=$1', [pedidoId]);
          if (rows[0] && rows[0].status === 'pix_pending') {
            await pool.query("UPDATE pep_pedidos SET status='cancelado' WHERE id=$1", [pedidoId]);
            enviarEmail(email, '❌ Pedido #' + pedidoId + ' cancelado — PEPMASTERS',
              '<div style="font-family:sans-serif;max-width:600px;margin:0 auto">' +
              '<h2 style="color:#e8220a">Pedido #' + pedidoId + ' cancelado</h2>' +
              '<p>Olá, ' + nome.split(' ')[0] + '!</p>' +
              '<p>Infelizmente seu pedido foi cancelado automaticamente pois não identificamos a confirmação do pagamento em cripto dentro de <b>48 horas</b>.</p>' +
              '<div style="background:#f8d7da;border:1px solid #f5c6cb;border-radius:8px;padding:16px;margin:20px 0">' +
              '<p style="margin:0;color:#721c24">Se você já realizou o pagamento, entre em contato conosco via ' +
              '<a href="https://wa.me/5512991217552">WhatsApp</a> com o comprovante da transação e resolveremos imediatamente.</p>' +
              '</div>' +
              '<p>Sentimos muito pelo inconveniente. Você pode fazer um novo pedido a qualquer momento em <a href="' + BASE_URL + '">pepmasters.io</a></p>' +
              '</div>'
            );
            console.log('[Cripto] Pedido #' + pedidoId + ' cancelado por timeout de 48h');
          }
        } catch(e) { console.error('[Cripto Timeout]', e.message); }
      }, 48 * 60 * 60 * 1000); // 48 horas
    }

    res.json({ pedido_id: pedidoId, qrcode_url, pix_copia_cola, nowpay_address, nowpay_amount, nowpay_currency, desconto_membro: descontoMembro.toFixed(2), nivel_membro: nivelMembro, total_pix: total.toFixed(2), num_qrs: numQrsPix, valor_pix1: pagamento === 'pix' && numQrsPix > 1 ? calcularSplitPix(total, numQrsPix)[0].toFixed(2) : null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Pedido] Erro:', err.message);
    res.status(500).json({ erro: 'Erro ao criar pedido.' });
  } finally {
    client.release();
  }
});

// GET /api/pedido/:id/pix-next — gera o próximo QR code PIX para split
app.get('/api/pedido/:id/pix-next', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, total, pixgo_id FROM pep_pedidos WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = rows[0];

    const parts    = (p.pixgo_id || '').split(':');
    // numQrs: pega o maior número entre 1 e 3 encontrado nas partes (ignora 'undefined'/'pending'/hashes)
    let numQrs = 1;
    parts.forEach(x => {
      const n = parseInt(x);
      if (!isNaN(n) && n >= 1 && n <= 3) numQrs = Math.max(numQrs, n);
    });
    const paidSoFar = parts.filter(x => x && x !== 'undefined' && x !== 'pending' && x !== String(numQrs) && x.length > 5).length;
    const nextPart  = paidSoFar + 1;

    if (nextPart > numQrs) return res.status(400).json({ erro: 'Todos os QRs já foram gerados.' });

    const pixAmount = calcularSplitPix(parseFloat(p.total), numQrs)[nextPart - 1];

    const pixPayload = JSON.stringify({
      amount:      pixAmount,
      description: 'PEPMASTERS #' + p.id + ' (' + (nextPart) + '/' + numQrs + ')',
      external_id: 'pep-' + p.id + '-' + nextPart,
      webhook_url: BASE_URL + '/webhook/pixgo'
    });
    const pixRes = await fetch('https://pixgo.org/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': PIXGO_API_KEY },
      body: pixPayload
    });
    const pixData = await pixRes.json();
    if (pixData.success && pixData.data) {
      // Adicionar novo ID ao pixgo_id
      const newPixgoId = parts[0] + ':' + (pixData.data.payment_id || pixData.data.id) + ':pending:' + numQrs;
      await pool.query('UPDATE pep_pedidos SET pixgo_id=$1 WHERE id=$2', [newPixgoId, p.id]);
      return res.json({
        qrcode_url:     pixData.data.qr_image_url,
        pix_copia_cola: pixData.data.qr_code,
        parte:          nextPart,
        total_partes:   numQrs,
        valor_parte:    pixAmount.toFixed(2)
      });
    }
    res.status(500).json({ erro: 'Erro ao gerar próximo PIX: ' + (pixData.message || '') });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/pedido/:id/status
app.get('/api/pedido/:id/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,status,produto_nome,pagamento,total,codigo_rastreio,criado_em,pix_partes_pagas FROM pep_pedidos WHERE id=$1',
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
  const validos = ['pago','pix_pending','enviado','entregue','cancelado','pagamento_parcial','sem_pagamento_frete'];
  if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido.' });
  try {
    const { rows } = await pool.query(
      'UPDATE pep_pedidos SET status=$1 WHERE id=$2 RETURNING email,nome,produto_nome,status',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = rows[0];

    // Buscar lang do usuário
    const uLang = await pool.query(`SELECT u.lang FROM pep_usuarios u JOIN pep_pedidos ped ON ped.email=u.email WHERE ped.id=$1`, [req.params.id]).catch(()=>({rows:[]}));
    const lang = uLang.rows[0]?.lang || 'pt';

    // Email de confirmação quando admin marca como pago
    if (status === 'pago') {
      const pedDados = await pool.query(`SELECT total, produto_nome FROM pep_pedidos WHERE id=$1`, [req.params.id]);
      const total = pedDados.rows[0]?.total || '0';
      const tmpl = emailTemplates.pedidoConfirmado[lang] || emailTemplates.pedidoConfirmado['pt'];
      const { sub, body } = tmpl(p.nome.split(' ')[0], req.params.id, p.produto_nome, parseFloat(total).toFixed(2).replace('.',','), BASE_URL);
      enviarEmail(p.email, sub, wrapEmail(body)).catch(()=>{});
    }
    // Email quando enviado ou entregue
    if (status === 'enviado') {
      const tmpl = emailTemplates.pedidoEnviado[lang] || emailTemplates.pedidoEnviado['pt'];
      const { sub, body } = tmpl(p.nome.split(' ')[0], p.produto_nome, null, BASE_URL);
      enviarEmail(p.email, sub, wrapEmail(body)).catch(()=>{});
    }
    if (status === 'entregue') {
      const tmpl = emailTemplates.pedidoEntregue[lang] || emailTemplates.pedidoEntregue['pt'];
      const { sub, body } = tmpl(p.nome.split(' ')[0], p.produto_nome, BASE_URL);
      enviarEmail(p.email, sub, wrapEmail(body)).catch(()=>{});
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
      const uLangR = await pool.query(`SELECT u.lang FROM pep_usuarios u JOIN pep_pedidos ped ON ped.email=u.email WHERE ped.id=$1`, [req.params.id]).catch(()=>({rows:[]}));
      const langR = uLangR.rows[0]?.lang || 'pt';
      const tmplR = emailTemplates.pedidoEnviado[langR] || emailTemplates.pedidoEnviado['pt'];
      const { sub, body } = tmplR(p.nome.split(' ')[0], p.produto_nome, codigo_rastreio, BASE_URL);
      enviarEmail(p.email, sub, wrapEmail(body)).catch(()=>{});
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

// POST /api/admin/seed-produtos — insere produtos faltantes
app.post('/api/admin/seed-produtos', adminMiddleware, async (req, res) => {
  const produtos = [
    { id:'1',  nome:'BPC-157',          preco:150.00, descricao:'Recuperacao muscular e articular acelerada.',         estoque:10 },
    { id:'2',  nome:'TB-500',            preco:180.00, descricao:'Regeneracao tecidual e anti-inflamatorio.',            estoque:10 },
    { id:'3',  nome:'HGH Frag 176-191', preco:160.00, descricao:'Queima de gordura sem efeitos do GH completo.',        estoque:10 },
    { id:'4',  nome:'Ipamorelin',        preco:140.00, descricao:'Estimulante seletivo do hormonio do crescimento.',     estoque:10 },
    { id:'5',  nome:'Sermorelin',        preco:170.00, descricao:'Anti-aging, sono e estimulo natural do GH.',           estoque:0  },
    { id:'6',  nome:'CJC-1295',          preco:180.00, descricao:'Estimulante de GH de longa duracao para massa.',       estoque:10 },
    { id:'7',  nome:'IGF-1 LR3',         preco:220.00, descricao:'Fator de crescimento insulinico para hipertrofia.',    estoque:10 },
    { id:'8',  nome:'IGF-1 DES',         preco:200.00, descricao:'Variante do IGF-1 com acao local nos musculos.',       estoque:10 },
    { id:'9',  nome:'ACE-031',           preco:250.00, descricao:'Inibidor da miostatina. Potencializa massa e forca.',  estoque:10 },
    { id:'10', nome:'Semax',             preco:160.00, descricao:'Neuropeptideo para foco, memoria e funcao cerebral.',  estoque:10 },
    { id:'11', nome:'Selank',            preco:150.00, descricao:'Ansiolitico natural com efeito nootropico.',           estoque:10 },
    { id:'12', nome:'Kisspeptin',        preco:190.00, descricao:'Estimula producao de LH e testosterona.',              estoque:10 },
    { id:'13', nome:'SS-31',             preco:210.00, descricao:'Acao antioxidante mitocondrial e cardioprotetora.',    estoque:10 },
    { id:'14', nome:'SLU-PP-32',         preco:230.00, descricao:'Simula efeitos metabolicos do exercicio.',             estoque:10 },
    { id:'15', nome:'AHK-CU',            preco:140.00, descricao:'Peptideo de cobre para cabelo, pele e cabelos.',       estoque:10 },
    { id:'16', nome:'VIP',               preco:200.00, descricao:'Potente anti-inflamatorio e vasoativo intestinal.',    estoque:10 },
  ];
  try {
    let inseridos = 0;
    for (const p of produtos) {
      const r = await pool.query(
        'INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
        [p.id, p.nome, p.preco, p.descricao, p.estoque]
      );
      if (r.rows.length) inseridos++;
    }
    res.json({ ok: true, inseridos });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// DELETE /api/admin/estoque/:id
app.delete('/api/admin/estoque/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM pep_estoque WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/admin/seed-produtos-v2 — SUBSTITUI TODOS os produtos pelo novo catálogo (69 peptídeos)
// ATENÇÃO: deleta todo o conteúdo atual de pep_estoque antes de inserir o novo catálogo.
app.post('/api/admin/seed-produtos-v2', adminMiddleware, async (req, res) => {
  const produtos = [
    { id:'RT30', nome:'Retatrutide 30mg', preco:288.9, descricao:'Agonista triplo GLP-1/GIP/Glucagon. Perda de peso de até 24–28% (fase 2/3, Eli Lilly). Indicado para obesidade, diabetes tipo 2 e síndrome metabólica.', estoque:20 },
    { id:'RT40', nome:'Retatrutide 40mg', preco:345.6, descricao:'Agonista triplo GLP-1/GIP/Glucagon — dose intermediária. Maior magnitude de perda de peso entre incretinomiméticos modernos.', estoque:20 },
    { id:'RT60', nome:'Retatrutide 60mg', preco:394.2, descricao:'Agonista triplo GLP-1/GIP/Glucagon — dose alta. Resultados fase 3: perda de até 28,3% em 80 semanas.', estoque:20 },
    { id:'TR30', nome:'Tirzepatide 30mg', preco:224.1, descricao:'Agonista dual GLP-1/GIP aprovado FDA (Mounjaro/Zepbound). Perda de 15–22% do peso. Diabetes tipo 2 e obesidade.', estoque:20 },
    { id:'TR40', nome:'Tirzepatide 40mg', preco:250.0, descricao:'Agonista dual GLP-1/GIP — dose intermediária. Superior ao semaglutide em comparativos diretos.', estoque:20 },
    { id:'TR50', nome:'Tirzepatide 50mg', preco:264.6, descricao:'Agonista dual GLP-1/GIP — dose alta. Reduz apetite e melhora sensibilidade insulínica.', estoque:20 },
    { id:'TR60', nome:'Tirzepatide 60mg', preco:307.8, descricao:'Agonista dual GLP-1/GIP — dose máxima de manutenção. Protocolos para obesidade grave.', estoque:20 },
    { id:'2S10', nome:'SS-31 10mg', preco:162.0, descricao:'Peptídeo mitocondrial (Szeto-Schiller). Reduz estresse oxidativo mitocondrial. Longevidade e neuroproteção.', estoque:20 },
    { id:'2S50', nome:'SS-31 50mg', preco:345.6, descricao:'SS-31 dose alta. Proteção mitocondrial intensa em patologias isquêmicas e envelhecimento.', estoque:20 },
    { id:'TB10', nome:'TB500 10mg', preco:199.8, descricao:'Thymosin Beta-4. Promove angiogênese e migração celular. Recuperação de lesões musculares e tendíneas.', estoque:20 },
    { id:'TSM10', nome:'Tesamorelin 10mg', preco:226.8, descricao:'Análogo do GHRH. Aprovado FDA para lipodistrofia. Reduz gordura visceral e melhora perfil lipídico.', estoque:20 },
    { id:'TSM20', nome:'Tesamorelin 20mg', preco:340.2, descricao:'Tesamorelin dose alta. Protocolos intensivos de redução de gordura visceral.', estoque:20 },
    { id:'MS20', nome:'MOTS-C 20mg', preco:216.0, descricao:'Peptídeo mitocondrial. Ativa AMPK, melhora captação de glicose. Longevidade e performance esportiva.', estoque:20 },
    { id:'MS40', nome:'MOTS-C 40mg', preco:270.0, descricao:'MOTS-C dose alta. Potencializa eficiência mitocondrial. Atletas de alto rendimento.', estoque:20 },
    { id:'NJ500', nome:'NAD+ 500mg', preco:162.0, descricao:'Cofator do metabolismo celular. Ativa sirtuínas. Longevidade, fadiga crônica e recuperação metabólica.', estoque:20 },
    { id:'NJ1000', nome:'NAD+ 1000mg', preco:183.6, descricao:'NAD+ dose alta. Doenças neurodegenerativas e recuperação pós-viral.', estoque:20 },
    { id:'GLOW70', nome:'GLOW70', preco:286.2, descricao:'Stack: BPC-157 + GHK-CU + TB500. Recuperação e rejuvenescimento sinérgico.', estoque:20 },
    { id:'KLOW80', nome:'KLOW80', preco:324.0, descricao:'GLOW70 + KPV anti-inflamatório. Para lesões inflamadas e recuperação pós-cirúrgica.', estoque:20 },
    { id:'MT1', nome:'Melatonin I 10mg', preco:151.2, descricao:'Hormônio pineal. Antioxidante e imunomodulador. Insônia e distúrbios circadianos.', estoque:20 },
    { id:'MT2', nome:'Melatonin II 10mg', preco:151.2, descricao:'Melatonina formulação alternativa. Regulação do sono e ritmo circadiano.', estoque:20 },
    { id:'PT141', nome:'PT-141 10mg', preco:151.2, descricao:'Agonista MC3R/MC4R. Aprovado FDA para disfunção sexual hipoativa feminina.', estoque:20 },
    { id:'DS10', nome:'DSIP 10mg', preco:151.2, descricao:'Delta Sleep-Inducing Peptide. Melhora o sono delta. Insônia crônica.', estoque:20 },
    { id:'SK10', nome:'Selank 10mg', preco:159.3, descricao:'Análogo da tuftosina. Ansiolítico e nootrópico. Modula GABA e BDNF.', estoque:20 },
    { id:'SK30', nome:'Selank 30mg', preco:189.0, descricao:'Selank dose alta para ansiedade severa e neuroproteção intensiva.', estoque:20 },
    { id:'ET10', nome:'Epithalon 10mg', preco:145.8, descricao:'Tetrapeptídeo pineal. Ativa telomerase. Antienvelhecimento e imunomodulação.', estoque:20 },
    { id:'ET50', nome:'Epithalon 50mg', preco:237.6, descricao:'Epithalon dose alta. Protocolo intensivo de longevidade.', estoque:20 },
    { id:'BPC10', nome:'BPC-157 10mg', preco:162.0, descricao:'Body Protective Compound. Promove angiogênese e cicatrização GI.', estoque:20 },
    { id:'BPC20', nome:'BPC-157 20mg', preco:189.0, descricao:'BPC-157 dose alta para lesões extensas. Atletas de alta performance.', estoque:20 },
    { id:'BB10', nome:'BPC+TB 10mg', preco:189.0, descricao:'Combinação clássica BPC-157 + TB500. Padrão para lesões musculoesqueléticas.', estoque:20 },
    { id:'BB20', nome:'BPC+TB 20mg', preco:264.6, descricao:'BPC+TB dose alta. Lesões extensas e recuperação pós-cirúrgica ortopédica.', estoque:20 },
    { id:'XS20', nome:'Semax+Selank 20mg', preco:178.2, descricao:'Stack nootrópico: Semax + Selank. Cognição com controle de ansiedade.', estoque:20 },
    { id:'AP5', nome:'Adipotide 5mg', preco:216.0, descricao:'Peptídeo pró-apoptótico para vasos adiposos. Uso experimental para obesidade grave.', estoque:20 },
    { id:'AP10', nome:'Adipotide 10mg', preco:270.0, descricao:'Adipotide dose alta. Apoptose vascular do tecido adiposo.', estoque:20 },
    { id:'SX5', nome:'Semax 5mg', preco:135.0, descricao:'Análogo do ACTH(4-10). Melhora cognitiva e neuroproteção pós-AVC.', estoque:20 },
    { id:'KP10', nome:'KPV 10mg', preco:145.8, descricao:'Tripeptídeo anti-inflamatório. Inibe NF-κB. Crohn, colite e dermatite.', estoque:20 },
    { id:'ADA10', nome:'Adamax 10mg', preco:226.8, descricao:'Peptídeo nootrópico neuroprotetor e adaptogênico.', estoque:20 },
    { id:'PIN10', nome:'Pinealon 10mg', preco:137.7, descricao:'Tripeptídeo citomedino pineal. Neuroprotetor e antienvelhecimento cerebral.', estoque:20 },
    { id:'PIN20', nome:'Pinealon 20mg', preco:157.1, descricao:'Pinealon dose alta. Alzheimer, Parkinson e demência vascular.', estoque:20 },
    { id:'SX10', nome:'Semax 10mg', preco:162.0, descricao:'Semax dose alta. Neurogênese e plasticidade sináptica.', estoque:20 },
    { id:'CND5', nome:'CJC-1295 no DAC 5mg', preco:162.0, descricao:'Análogo GHRH, meia-vida curta. Combinado com Ipamorelin.', estoque:20 },
    { id:'CND10', nome:'CJC-1295 no DAC 10mg', preco:243.0, descricao:'CJC-1295 sem DAC, dose alta. Múltiplas aplicações diárias.', estoque:20 },
    { id:'CP10', nome:'CJC+IPA 10mg', preco:189.0, descricao:'Padrão-ouro de secretagogos de GH: CJC-1295 + Ipamorelin.', estoque:20 },
    { id:'CD5', nome:'CJC-1295 com DAC 5mg', preco:243.0, descricao:'CJC-1295 com DAC. Dose semanal. Elevação sustentada de GH e IGF-1.', estoque:20 },
    { id:'CD10', nome:'CJC-1295 com DAC 10mg', preco:378.0, descricao:'CJC-1295 com DAC, dose alta. Deficiência severa de GH e sarcopenia.', estoque:20 },
    { id:'Serm5', nome:'Sermorelin 5mg', preco:137.7, descricao:'Análogo do GHRH. Secretagogo fisiológico de GH. Anti-aging e sono profundo.', estoque:20 },
    { id:'Serm10', nome:'Sermorelin 10mg', preco:179.0, descricao:'Sermorelin dose alta. Estímulo intensivo ao GH endógeno.', estoque:20 },
    { id:'10AD', nome:'AOD9604 10mg', preco:226.8, descricao:'Fragmento C-terminal do GH. Ação lipolítica sem efeitos proliferativos.', estoque:20 },
    { id:'IP10', nome:'Ipamorelin 10mg', preco:156.6, descricao:'GHRP seletivo. Estimula GH sem elevar cortisol. Anti-aging e massa magra.', estoque:20 },
    { id:'CU50', nome:'GHK-CU 50mg', preco:113.4, descricao:'Complexo cobre-tripeptídeo. Estimula colágeno e elastina. Antienvelhecimento cutâneo.', estoque:20 },
    { id:'CU100', nome:'GHK-CU 100mg', preco:124.2, descricao:'GHK-CU dose alta. Rejuvenescimento cutâneo sistêmico e alopecia avançada.', estoque:20 },
    { id:'KS10', nome:'KissPeptin-10 10mg', preco:178.2, descricao:'Regulador do eixo reprodutivo. Hipogonadismo e fertilidade.', estoque:20 },
    { id:'TY10', nome:'Thymalin 10mg', preco:147.4, descricao:'Polipeptídeo tímico. Estimula diferenciação de linfócitos T.', estoque:20 },
    { id:'TA5', nome:'Thymosin Alpha-1 5mg', preco:162.0, descricao:'Imunomodulador tímico. Aprovado em +35 países para hepatite B/C crônica.', estoque:20 },
    { id:'TA10', nome:'Thymosin Alpha-1 10mg', preco:226.8, descricao:'Thymosin Alpha-1 dose alta. Hepatite crônica e imunodeficiência severa.', estoque:20 },
    { id:'GTT1500', nome:'Glutathione 1500mg', preco:153.9, descricao:'Antioxidante mestre. Clareamento de pele e detoxificação hepática.', estoque:20 },
    { id:'GTT600', nome:'Glutathione 600mg', preco:127.9, descricao:'Glutationa dose padrão. Manutenção antioxidante e suporte hepático.', estoque:20 },
    { id:'XT100', nome:'Botulinum toxin 100iu', preco:143.3, descricao:'Toxina botulínica tipo A. Rugas de expressão e hiperidrose.', estoque:20 },
    { id:'20AM', nome:'5-amino-1mq 20mg', preco:156.6, descricao:'Inibidor seletivo da NNMT. Aumenta NAD+. Obesidade e resistência insulínica.', estoque:20 },
    { id:'50AM', nome:'5-amino-1mq 50mg', preco:178.2, descricao:'5-amino-1mq dose alta. Obesidade metabólica severa.', estoque:20 },
    { id:'G75', nome:'HMG 75 IU', preco:125.5, descricao:'Human Menopausal Gonadotropin. Foliculogênese e espermatogênese.', estoque:20 },
    { id:'E3K', nome:'EPO 3000 IU', preco:127.9, descricao:'Eritropoietina recombinante. Estimula eritropoiese. Anemia de doença crônica.', estoque:20 },
    { id:'CBL60', nome:'Cerebrolysin 60mg', preco:131.2, descricao:'Hidrolisado neurotrófico. Alzheimer, AVC isquêmico e reabilitação neurológica.', estoque:20 },
    { id:'CGL5', nome:'Cagrilintide 5mg', preco:189.0, descricao:'Análogo de longa ação da amilina. Reduz apetite. Combinado com semaglutide.', estoque:20 },
    { id:'CGL10', nome:'Cagrilintide 10mg', preco:270.0, descricao:'Cagrilintide dose alta. Obesidade severa combinada com GLP-1.', estoque:20 },
    { id:'NP8-10', nome:'Snap-8 10mg', preco:125.5, descricao:'Octapeptídeo análogo ao Argireline. Alternativa à toxina botulínica.', estoque:20 },
    { id:'NP8-100', nome:'Snap-8 100mg', preco:239.7, descricao:'Snap-8 dose alta para mesoterapia facial intensiva.', estoque:20 },
    { id:'CS10', nome:'CagriSema 10mg', preco:186.3, descricao:'GLP-1 agonista + análogo de amilina. Perda de ~22% em estudos clínicos.', estoque:20 },
    { id:'RC10', nome:'Retatrutide+Cagrili 10mg', preco:226.8, descricao:'Stack experimental: agonista triplo + análogo de amilina. 4 vias metabólicas.', estoque:20 },
    { id:'KP5', nome:'KPV 5mg', preco:118.8, descricao:'KPV dose conservadora. Manutenção anti-inflamatória.', estoque:20 }
  ];
  try {
    await pool.query('DELETE FROM pep_estoque');
    let inseridos = 0;
    for (const p of produtos) {
      const r = await pool.query(
        'INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
        [p.id, p.nome, p.preco, p.descricao, p.estoque]
      );
      if (r.rows.length) inseridos++;
    }
    res.json({ ok: true, inseridos, total: produtos.length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
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
  const { estoque, alerta_minimo, preco, preco_original } = req.body;
  try {
    let query = 'UPDATE pep_estoque SET estoque=$1, alerta_minimo=$2';
    let params = [estoque, alerta_minimo, req.params.id];
    if (preco !== undefined) { query += ', preco=$4'; params.push(preco); }
    if (preco_original !== undefined) { query += ', preco_original=$' + (params.length + 1); params.push(preco_original); }
    query += ' WHERE id=$3::int';
    await pool.query(query, params);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: 'Erro ao atualizar estoque.' });
  }
});

// ─────────────────────────────────────────────
//  WEBHOOK PIXGO
// ─────────────────────────────────────────────
// ── PAYPAL ──
async function getPayPalToken() {
  const creds = Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_CLIENT_SECRET).toString('base64');
  const r = await fetch(PAYPAL_BASE_URL + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  return d.access_token;
}

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const token = await getPayPalToken();
    const r = await fetch(PAYPAL_BASE_URL + '/v2/checkout/orders', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: currency || 'USD', value: String(amount) } }]
      })
    });
    const d = await r.json();
    if (d.id) res.json({ orderID: d.id });
    else res.status(400).json({ erro: 'Erro ao criar ordem PayPal' });
  } catch (err) {
    console.error('[PayPal] create-order:', err.message);
    res.status(500).json({ erro: 'Erro interno PayPal' });
  }
});

app.post('/api/paypal/capture-order', async (req, res) => {
  const client = await pool.connect();
  try {
    const { orderID, carrinho, nome, email, cupom } = req.body;
    const token = await getPayPalToken();
    const r = await fetch(PAYPAL_BASE_URL + '/v2/checkout/orders/' + orderID + '/capture', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
    const d = await r.json();
    if (d.status !== 'COMPLETED') return res.status(400).json({ erro: 'Payment not completed' });

    const prods = await client.query('SELECT id, preco FROM pep_estoque');
    let total = 0;
    const itens = [];
    for (const item of (carrinho || [])) {
      const p = prods.rows.find(x => String(x.id) === String(item.id));
      if (p) { total += parseFloat(p.preco) * item.quantidade; itens.push(item.nome + (item.quantidade > 1 ? ' x' + item.quantidade : '')); }
    }

    const result = await client.query(
      "INSERT INTO pep_pedidos (usuario_email, produto, total, pagamento, cupom, status) VALUES ($1,$2,$3,$4,$5,'pago') RETURNING id",
      [email, itens.join(', '), total, 'paypal', cupom || null]
    );
    res.json({ pedidoId: result.rows[0].id });
  } catch (err) {
    console.error('[PayPal] capture-order:', err.message);
    res.status(500).json({ erro: 'Erro ao registrar pedido' });
  } finally { client.release(); }
});

app.post('/webhook/pixgo', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('[PixGo Webhook] Recebido. Headers:', JSON.stringify(req.headers).substring(0, 200));
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
  console.log('[PixGo Webhook] Body:', rawBody.toString().substring(0, 300));

  // Verificar assinatura: HMAC-SHA256 sobre "timestamp.body"
  if (PIXGO_WEBHOOK_SECRET && rawBody.length > 0) {
    const sig       = req.headers['x-webhook-signature'] || '';
    const timestamp = req.headers['x-webhook-timestamp'] || '';
    const signedPayload = timestamp + '.' + rawBody.toString();
    const hmac = crypto.createHmac('sha256', PIXGO_WEBHOOK_SECRET).update(signedPayload).digest('hex');
    console.log('[PixGo Webhook] Sig recebida:', sig.substring(0, 20), '| Esperada:', hmac.substring(0, 20));
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

  if (evento.event === 'payment.completed' || evento.event === 'charge.paid' || evento.status === 'paid' || evento.status === 'completed') {
    const dataObj    = evento.data || evento;
    const externalId = dataObj.externalId || dataObj.external_id || evento.externalId || evento.external_id || '';
    const match      = externalId.match(/pep-(\d+)(-(\d+))?/);
    console.log('[Webhook PixGo] externalId:', externalId, '| match:', match ? match[0] : 'none');
    if (match) {
      const pedidoId = parseInt(match[1]);
      const parte    = match[3] ? parseInt(match[3]) : null;
      try {
        const { rows: pedRows } = await pool.query('SELECT * FROM pep_pedidos WHERE id=$1', [pedidoId]);
        if (!pedRows.length) return res.status(200).send('OK');
        const pedido = pedRows[0];

        const parts  = (pedido.pixgo_id || '').split(':');
        const numQrs = parseInt(parts.find(x => !isNaN(x) && parseInt(x) <= 3 && parseInt(x) >= 1) || 1);
        const isSplit = numQrs > 1;

        if (isSplit && parte && parte < numQrs) {
          // Parte intermediária paga — marcar como pix_parcial e registrar contador
          await pool.query(
            "UPDATE pep_pedidos SET status='pix_parcial', pix_partes_pagas=GREATEST(COALESCE(pix_partes_pagas,0),$2) WHERE id=$1",
            [pedidoId, parte]
          );
          console.log('[Webhook] Pedido #' + pedidoId + ' — parte ' + parte + '/' + numQrs + ' PIX confirmada (pix_parcial).');
        } else {
          // Última parte ou PIX simples — marcar como pago
          const { rows } = await pool.query(
            "UPDATE pep_pedidos SET status='pago' WHERE id=$1 AND status IN ('pix_pending','pix_parcial') RETURNING nome,email,produto_nome",
            [pedidoId]
          );
          if (rows.length) {
            const p = rows[0];
            console.log('[Webhook] Pedido #' + pedidoId + ' marcado como PAGO (parte ' + (parte||1) + '/' + numQrs + ').');
            enviarWhatsApp('PIX CONFIRMADO! Pedido #' + pedidoId + ' - ' + p.nome + ' - ' + p.produto_nome);
            let lang = 'pt';
            try {
              const ur = await pool.query('SELECT lang FROM pep_usuarios WHERE email=$1', [p.email]);
              if (ur.rows.length && ur.rows[0].lang) lang = ur.rows[0].lang;
            } catch {}
            const emailHtml = await gerarEmailPedido('pedidoConfirmado', p, pedidoId, lang);
            enviarEmail(p.email, 'Pagamento confirmado — PEPMASTERS', emailHtml).catch(()=>{});
            enviarEmail(EMAIL_DESTINO, '[PEPMASTERS] Pedido #' + pedidoId + ' PAGO via PIX', emailHtml).catch(()=>{});
          }
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
      'produto_id TEXT','produto_nome TEXT','preco_unitario NUMERIC(10,2)',
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
        "INSERT INTO pep_estoque (produto_id,nome,preco,descricao,estoque,alerta_minimo) VALUES ($1,$2,$3,$4,$5,3) ON CONFLICT DO NOTHING",
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

// ── CRIPTO: verificar status do pagamento NOWPayments ──────
app.get('/api/pedido/:id/crypto-status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, status, crypto_token FROM pep_pedidos WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const pedido = rows[0];
    if (pedido.status === 'pago') return res.json({ pago: true, status: 'pago' });
    res.json({ pago: false, status: pedido.status });
  } catch (err) {
    res.json({ pago: false, status: 'pix_pending' });
  }
});

// ─────────────────────────────────────────────
//  RANKING, BADGES, NOTIFICAÇÕES, EXTRATO, PERFIL
// ─────────────────────────────────────────────

// Definição de badges
const BADGES_DEF = {
  'primeira_venda':    { nome: 'First Sale',       icone: '🎯', desc: 'Made the first sale' },
  'vendas_10':         { nome: '10 Sales',          icone: '🔥', desc: 'Reached 10 sales' },
  'vendas_50':         { nome: '50 Sales',          icone: '💪', desc: 'Reached 50 sales' },
  'vendas_100':        { nome: '100 Sales',         icone: '🏆', desc: 'Reached 100 sales' },
  'nivel_prata':       { nome: 'Silver',            icone: '🥈', desc: 'Reached Silver level' },
  'nivel_ouro':        { nome: 'Gold',              icone: '🥇', desc: 'Reached Gold level' },
  'nivel_diamante':    { nome: 'Diamond',           icone: '💎', desc: 'Reached Diamond level' },
  'forum_100':         { nome: 'Community',         icone: '💬', desc: '100 forum posts' },
  'volume_1000':       { nome: 'R$ 1K',             icone: '💰', desc: 'R$ 1.000 in sales volume' },
  'volume_10000':      { nome: 'R$ 10K',            icone: '🚀', desc: 'R$ 10.000 in sales volume' },
};

// Verificar e atribuir badges automaticamente
async function verificarBadges(membro_id) {
  try {
    const m = await pool.query(`
      SELECT m.nivel, m.vendas_total,
             COUNT(DISTINCT va.id) as total_vendas,
             COUNT(DISTINCT fr.id) as total_posts
      FROM pep_membros m
      LEFT JOIN pep_vendas_afiliado va ON va.membro_id = m.id
      LEFT JOIN pep_forum_respostas fr ON fr.membro_id = m.id
      WHERE m.id = $1
      GROUP BY m.id
    `, [membro_id]);
    if (!m.rows.length) return;
    const { nivel, vendas_total, total_vendas, total_posts } = m.rows[0];

    const checks = [];
    if (parseInt(total_vendas) >= 1)   checks.push('primeira_venda');
    if (parseInt(total_vendas) >= 10)  checks.push('vendas_10');
    if (parseInt(total_vendas) >= 50)  checks.push('vendas_50');
    if (parseInt(total_vendas) >= 100) checks.push('vendas_100');
    if (['prata','ouro','diamante'].includes(nivel)) checks.push('nivel_prata');
    if (['ouro','diamante'].includes(nivel))         checks.push('nivel_ouro');
    if (nivel === 'diamante')                        checks.push('nivel_diamante');
    if (parseInt(total_posts) >= 100)  checks.push('forum_100');
    if (parseFloat(vendas_total) >= 1000)  checks.push('volume_1000');
    if (parseFloat(vendas_total) >= 10000) checks.push('volume_10000');

    for (const tipo of checks) {
      const exists = await pool.query(`SELECT id FROM pep_badges WHERE membro_id=$1 AND tipo=$2`, [membro_id, tipo]);
      if (!exists.rows.length) {
        await pool.query(`INSERT INTO pep_badges (membro_id, tipo) VALUES ($1,$2)`, [membro_id, tipo]);
        const b = BADGES_DEF[tipo];
        await criarNotificacao(membro_id, 'badge', `${b.icone} Badge desbloqueado: ${b.nome}!`, '/members.html');
      }
    }
  } catch (e) { console.error('[Badges]', e.message); }
}

// Criar notificação
async function criarNotificacao(membro_id, tipo, mensagem, link) {
  try {
    await pool.query(`INSERT INTO pep_notificacoes (membro_id, tipo, mensagem, link) VALUES ($1,$2,$3,$4)`, [membro_id, tipo, mensagem, link]);
  } catch (e) { console.error('[Notif]', e.message); }
}

// Salvar idioma preferido do usuário
app.put('/api/usuarios/lang', authMiddleware, async (req, res) => {
  const { lang } = req.body;
  if (!['pt','en','es','de','fr'].includes(lang)) return res.status(400).json({ erro: 'Idioma inválido.' });
  try {
    await pool.query(`UPDATE pep_usuarios SET lang=$1 WHERE id=$2`, [lang, req.usuario.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET notificações
app.get('/api/membros/notificacoes', membroMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM pep_notificacoes WHERE membro_id=$1 ORDER BY criado_em DESC LIMIT 20`, [req.membro.id]);
    const naoLidas = r.rows.filter(n => !n.lida).length;
    res.json({ notificacoes: r.rows, nao_lidas: naoLidas });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Marcar notificações como lidas
app.put('/api/membros/notificacoes/ler', membroMiddleware, async (req, res) => {
  try {
    await pool.query(`UPDATE pep_notificacoes SET lida=TRUE WHERE membro_id=$1`, [req.membro.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Ranking mensal
app.get('/api/membros/ranking', membroMiddleware, async (req, res) => {
  try {
    const { mes, ano } = req.query;
    const agora = new Date();
    const mesNum = mes ? parseInt(mes) - 1 : agora.getMonth();
    const anoNum = ano ? parseInt(ano) : agora.getFullYear();
    const inicio = new Date(anoNum, mesNum, 1);
    const fim = new Date(anoNum, mesNum + 1, 1);
    const r = await pool.query(`
      SELECT m.id, m.nivel, m.codigo_ref, u.nome,
             COALESCE(SUM(va.valor),0) as volume_mes,
             COALESCE(SUM(va.comissao),0) as comissao_mes,
             COUNT(va.id) as vendas_mes
      FROM pep_membros m
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN pep_vendas_afiliado va ON va.membro_id = m.id AND va.criado_em >= $1 AND va.criado_em < $2
      WHERE m.status = 'ativo'
      GROUP BY m.id, u.nome
      ORDER BY volume_mes DESC
      LIMIT 20
    `, [inicio, fim]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Extrato de comissões
app.get('/api/membros/extrato', membroMiddleware, async (req, res) => {
  try {
    const vendas = await pool.query(`
      SELECT va.*, p.produto_nome, p.criado_em as pedido_data
      FROM pep_vendas_afiliado va
      LEFT JOIN pep_pedidos p ON p.id = va.pedido_id
      WHERE va.membro_id = $1
      ORDER BY va.criado_em DESC
      LIMIT 50
    `, [req.membro.id]);

    const pagamentos = await pool.query(`
      SELECT * FROM pep_pagamentos_membros WHERE membro_id=$1 ORDER BY criado_em DESC LIMIT 12
    `, [req.membro.id]);

    const totais = await pool.query(`
      SELECT COALESCE(SUM(comissao),0) as total_comissao,
             COALESCE(SUM(valor),0) as total_volume
      FROM pep_vendas_afiliado WHERE membro_id=$1
    `, [req.membro.id]);

    res.json({
      vendas: vendas.rows,
      pagamentos: pagamentos.rows,
      total_comissao: parseFloat(totais.rows[0].total_comissao),
      total_volume: parseFloat(totais.rows[0].total_volume)
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Links por produto específico
app.get('/api/membros/links', membroMiddleware, async (req, res) => {
  try {
    const produtos = await pool.query(`SELECT id, produto_id, nome FROM pep_estoque WHERE estoque > 0 ORDER BY nome`);
    const links = produtos.rows.map(p => ({
      produto_id: p.produto_id,
      nome: p.nome,
      link: `${BASE_URL}/produto.html?id=${p.produto_id}&ref=${req.membro.codigo_ref || ''}`
    }));
    res.json(links);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Badges do membro
app.get('/api/membros/badges', membroMiddleware, async (req, res) => {
  try {
    await verificarBadges(req.membro.id);
    const r = await pool.query(`SELECT tipo, criado_em FROM pep_badges WHERE membro_id=$1 ORDER BY criado_em DESC`, [req.membro.id]);
    const badges = r.rows.map(b => ({ ...b, ...BADGES_DEF[b.tipo] }));
    res.json(badges);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Perfil público — ver
app.get('/api/membros/perfil/:slug', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.nivel, m.vendas_total, m.codigo_ref, m.bio, m.instagram, m.whatsapp, m.slug,
             u.nome,
             COUNT(DISTINCT va.id) as total_vendas,
             (SELECT COUNT(*) FROM pep_badges WHERE membro_id=m.id) as total_badges
      FROM pep_membros m
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN pep_vendas_afiliado va ON va.membro_id = m.id
      WHERE m.slug=$1 AND m.perfil_publico=TRUE AND m.status='ativo'
      GROUP BY m.id, u.nome
    `, [req.params.slug]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Perfil não encontrado.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Atualizar perfil público
app.put('/api/membros/perfil', membroMiddleware, async (req, res) => {
  const { bio, instagram, whatsapp, perfil_publico, slug } = req.body;
  try {
    if (slug) {
      const slugLimpo = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      const existing = await pool.query(`SELECT id FROM pep_membros WHERE slug=$1 AND id!=$2`, [slugLimpo, req.membro.id]);
      if (existing.rows.length) return res.status(400).json({ erro: 'Slug já em uso.' });
      await pool.query(`UPDATE pep_membros SET bio=$1, instagram=$2, whatsapp=$3, perfil_publico=$4, slug=$5 WHERE id=$6`,
        [bio||null, instagram||null, whatsapp||null, perfil_publico||false, slugLimpo, req.membro.id]);
    } else {
      await pool.query(`UPDATE pep_membros SET bio=$1, instagram=$2, whatsapp=$3, perfil_publico=$4 WHERE id=$5`,
        [bio||null, instagram||null, whatsapp||null, perfil_publico||false, req.membro.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Chamar verificarBadges ao registrar venda


// Middleware que verifica se é membro ativo
async function membroMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    const m = await pool.query(
      `SELECT id, nivel FROM pep_membros WHERE usuario_id=$1 AND status='ativo' AND membro_ate > NOW()`,
      [user.id]
    );
    if (!m.rows.length) return res.status(403).json({ erro: 'Acesso restrito a membros ativos.' });
    req.usuario = user;
    req.membro = m.rows[0];
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido.' });
  }
}

// Listar tópicos
app.get('/api/forum/topicos', membroMiddleware, async (req, res) => {
  const { categoria } = req.query;
  try {
    let q = `
      SELECT t.*, u.nome as autor_nome, m.nivel as autor_nivel,
             COUNT(r.id) as total_respostas,
             MAX(r.criado_em) as ultima_resposta
      FROM pep_forum_topicos t
      JOIN pep_membros m ON m.id = t.membro_id
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN pep_forum_respostas r ON r.topico_id = t.id
    `;
    const params = [];
    if (categoria && categoria !== 'todos') {
      q += ` WHERE t.categoria = $1`;
      params.push(categoria);
    }
    q += ` GROUP BY t.id, u.nome, m.nivel ORDER BY t.fixado DESC, COALESCE(MAX(r.criado_em), t.criado_em) DESC`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Criar tópico
app.post('/api/forum/topicos', membroMiddleware, async (req, res) => {
  const { titulo, conteudo, categoria } = req.body;
  if (!titulo?.trim() || !conteudo?.trim()) return res.status(400).json({ erro: 'Título e conteúdo são obrigatórios.' });
  try {
    const r = await pool.query(
      `INSERT INTO pep_forum_topicos (membro_id, titulo, conteudo, categoria) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.membro.id, titulo.trim(), conteudo.trim(), categoria || 'geral']
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Ver tópico + respostas
app.get('/api/forum/topicos/:id', membroMiddleware, async (req, res) => {
  try {
    // Incrementar views
    await pool.query(`UPDATE pep_forum_topicos SET views=views+1 WHERE id=$1`, [req.params.id]);
    const t = await pool.query(`
      SELECT t.*, u.nome as autor_nome, m.nivel as autor_nivel
      FROM pep_forum_topicos t
      JOIN pep_membros m ON m.id = t.membro_id
      JOIN pep_usuarios u ON u.id = m.usuario_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ erro: 'Tópico não encontrado.' });

    const r = await pool.query(`
      SELECT r.*, u.nome as autor_nome, m.nivel as autor_nivel
      FROM pep_forum_respostas r
      JOIN pep_membros m ON m.id = r.membro_id
      JOIN pep_usuarios u ON u.id = m.usuario_id
      WHERE r.topico_id = $1
      ORDER BY r.criado_em ASC
    `, [req.params.id]);

    res.json({ topico: t.rows[0], respostas: r.rows });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Responder tópico
app.post('/api/forum/topicos/:id/responder', membroMiddleware, async (req, res) => {
  const { conteudo } = req.body;
  if (!conteudo?.trim()) return res.status(400).json({ erro: 'Conteúdo obrigatório.' });
  try {
    await pool.query(
      `INSERT INTO pep_forum_respostas (topico_id, membro_id, conteudo) VALUES ($1,$2,$3)`,
      [req.params.id, req.membro.id, conteudo.trim()]
    );

    // Notificar autor do tópico por email (se não for ele mesmo respondendo)
    try {
      const t = await pool.query(
        `SELECT t.titulo, t.membro_id, u.email, u.nome
         FROM pep_forum_topicos t
         JOIN pep_membros m ON m.id = t.membro_id
         JOIN pep_usuarios u ON u.id = m.usuario_id
         WHERE t.id = $1`,
        [req.params.id]
      );
      if (t.rows.length && t.rows[0].membro_id !== req.membro.id) {
        const { email, nome, titulo } = t.rows[0];
        // Buscar nome do respondente
        const resp = await pool.query(
          `SELECT u.nome FROM pep_usuarios u WHERE u.id = $1`,
          [req.usuario.id]
        );
        const nomeResp = resp.rows[0]?.nome || 'Um membro';
        await enviarEmail(email, `💬 Nova resposta no seu tópico — PEPMASTERS Members`, `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#1C0A00;color:#fff;border-radius:12px">
            <h2 style="color:#FFB300;font-family:sans-serif">Nova resposta no seu tópico</h2>
            <p>Olá, <strong>${nome}</strong>!</p>
            <p><strong>${nomeResp}</strong> respondeu ao seu tópico:</p>
            <div style="background:rgba(255,255,255,.05);border-left:4px solid #FFB300;padding:12px 16px;border-radius:8px;margin:16px 0">
              <strong style="color:#FFB300">${titulo}</strong>
            </div>
            <a href="${BASE_URL}/members-forum.html" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;margin-top:8px">Ver resposta</a>
            <hr style="border-color:rgba(255,255,255,.1);margin:20px 0"/>
            <p style="font-size:.8rem;color:rgba(255,255,255,.4)">PEPMASTERS Members — Performance através da ciência.</p>
          </div>
        `);
      }
    } catch (emailErr) {
      console.error('[Forum] Erro ao enviar email:', emailErr.message);
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Deletar tópico (próprio ou admin)
app.delete('/api/forum/topicos/:id', membroMiddleware, async (req, res) => {
  try {
    const t = await pool.query(`SELECT membro_id FROM pep_forum_topicos WHERE id=$1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ erro: 'Não encontrado.' });
    if (t.rows[0].membro_id !== req.membro.id) return res.status(403).json({ erro: 'Sem permissão.' });
    await pool.query(`DELETE FROM pep_forum_topicos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─────────────────────────────────────────────
//  MEMBROS
// ─────────────────────────────────────────────

// Níveis por volume de vendas
function calcularNivel(vendas) {
  if (vendas >= 5000) return 'diamante';
  if (vendas >= 2000) return 'ouro';
  if (vendas >= 500)  return 'prata';
  return 'bronze';
}

// Percentual de comissão por nível
function comissaoPorNivel(nivel) {
  const tabela = { bronze: 0.05, prata: 0.08, ouro: 0.12, diamante: 0.15 };
  return tabela[nivel] || 0.05;
}

// Rastrear clique em link de afiliado (redireciona para index)
app.get('/ref/:codigo', async (req, res) => {
  const { codigo } = req.params;
  try {
    await pool.query(`UPDATE pep_membros SET vendas_total = vendas_total WHERE codigo_ref = $1`, [codigo]);
    res.cookie('pep_ref', codigo, { maxAge: 7 * 24 * 3600 * 1000, httpOnly: false });
  } catch {}
  res.redirect('/');
});

// Assinar plano de membros
app.post('/api/membros/assinar', authMiddleware, async (req, res) => {
  const { pagamento, valor, plano, crypto_token } = req.body;
  const usuario_id = req.usuario.id;
  try {
    const isGratis = !valor || parseFloat(valor) === 0;

    // Verificar se já é membro
    const existing = await pool.query(`SELECT id, status, membro_ate, plano, mensalidade FROM pep_membros WHERE usuario_id = $1`, [usuario_id]);

    // Gerar código de afiliado único
    const codigo_ref = 'PEP' + Math.random().toString(36).substring(2, 8).toUpperCase();

    let membro_id;
    if (existing.rows.length > 0) {
      membro_id = existing.rows[0].id;
      const membroAtual = existing.rows[0];
      const planoAtual = membroAtual.plano;
      const ativo = membroAtual.status === 'ativo' && membroAtual.membro_ate && new Date(membroAtual.membro_ate) > new Date();
      const novoPlano = plano || (isGratis ? 'bronze' : planoAtual);

      if (isGratis) {
        // Bronze: gratuito e sem validade — só ativa se não estiver ativo
        if (!ativo) {
          const ate = new Date();
          ate.setFullYear(ate.getFullYear() + 99); // sem validade prática
          await pool.query(`UPDATE pep_membros SET status='ativo', membro_ate=$1, plano='bronze', mensalidade=0 WHERE id=$2`, [ate, membro_id]);
          // Email de ativação do plano Bronze
          const uData = await pool.query(`SELECT u.nome, u.email, m.codigo_ref FROM pep_membros m JOIN pep_usuarios u ON u.id=m.usuario_id WHERE m.id=$1`, [membro_id]);
          if (uData.rows.length) {
            const { nome, email: uEmail, codigo_ref } = uData.rows[0];
            enviarEmail(uEmail, '✅ Plano Bronze ativado — PEPMASTERS Members', `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#1C0A00;color:#fff;border-radius:12px">
                <h2 style="color:#cd7f32">🥉 Plano Bronze Ativado!</h2>
                <p>Olá, <strong>${nome.split(' ')[0]}</strong>!</p>
                <p style="color:rgba(255,255,255,.8);line-height:1.7">Seu acesso Members Bronze foi ativado com sucesso. Agora você tem acesso a:</p>
                <ul style="color:rgba(255,255,255,.7);line-height:2;padding-left:20px">
                  <li>5% de comissão por venda indicada</li>
                  <li>Conteúdo exclusivo e protocolos</li>
                  <li>Fórum de distribuidores</li>
                  <li>Desconto de 10% na loja</li>
                </ul>
                <p style="color:rgba(255,255,255,.7)">Seu link de afiliado: <strong style="color:#FFB300">${BASE_URL}/ref/${codigo_ref}</strong></p>
                <div style="text-align:center;margin-top:20px">
                  <a href="${BASE_URL}/members.html" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#cd7f32,#FFB300);color:#000;font-weight:700;text-decoration:none;border-radius:10px">Acessar painel Members →</a>
                </div>
                <hr style="border-color:rgba(255,255,255,.1);margin:24px 0"/>
                <p style="font-size:.78rem;color:rgba(255,255,255,.3);text-align:center">PEPMASTERS — Performance através da ciência.</p>
              </div>
            `).catch(() => {});
          }
        }
      } else {
        // Plano pago
        const isBronzeAtual = planoAtual === 'bronze';
        if (planoAtual !== novoPlano && !isBronzeAtual) {
          // Mudança entre planos pagos: novo plano começa quando atual vencer
          await pool.query(`UPDATE pep_membros SET mensalidade=$1, pagamento=$2, plano=$3 WHERE id=$4`, [valor, pagamento, novoPlano, membro_id]);
        } else {
          // Bronze → pago (começa imediato) ou mesmo plano (só atualiza valor)
          await pool.query(`UPDATE pep_membros SET mensalidade=$1, pagamento=$2, plano=$3 WHERE id=$4`, [valor, pagamento, novoPlano, membro_id]);
        }
        // Cancelar pagamentos pendentes anteriores (evitar duplicatas no admin)
        await pool.query(`UPDATE pep_pagamentos_membros SET status='cancelado' WHERE membro_id=$1 AND status='pendente'`, [membro_id]);
      }
    } else {
      const res2 = await pool.query(
        `INSERT INTO pep_membros (usuario_id, mensalidade, pagamento, codigo_ref, status, plano) VALUES ($1,$2,$3,$4,'pendente',$5) RETURNING id`,
        [usuario_id, valor || 0, pagamento, codigo_ref, plano || 'bronze']
      );
      membro_id = res2.rows[0].id;

      if (isGratis) {
        const ate = new Date();
        ate.setFullYear(ate.getFullYear() + 10);
        await pool.query(`UPDATE pep_membros SET status='ativo', membro_ate=$1 WHERE id=$2`, [ate, membro_id]);
      }
    }

    // Registrar pagamento
    const pag = await pool.query(
      `INSERT INTO pep_pagamentos_membros (membro_id, valor, pagamento, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [membro_id, valor || 0, pagamento, isGratis ? 'pago' : 'pendente']
    );

    // Se for cripto, criar pagamento NOWPayments
    let cryptoValor = 0;
    let nowpay_address_mbr = null;
    let nowpay_amount_mbr = null;
    let nowpay_currency_mbr = null;

    if (pagamento === 'cripto' && valor) {
      if (NOWPAYMENTS_API_KEY) {
        try {
          // Converter BRL para USD
          let valorUsd = valor;
          try {
            const cambioRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
            const cambioData = await cambioRes.json();
            const brlRate = cambioData.rates?.BRL || 5.5;
            valorUsd = (valor / brlRate).toFixed(2);
          } catch { valorUsd = (valor / 5.5).toFixed(2); }

          const moedaMap = { 'USDTPOLYGON':'usdtmatic', 'USDCPOLYGON':'usdcmatic', 'USDTTRX':'usdttrc20', 'TRON':'usdttrc20' };
          const moedaMbr = moedaMap[crypto_token] || 'usdtmatic';

          const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
            method: 'POST',
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              price_amount: valorUsd,
              price_currency: 'usd',
              pay_currency: moedaMbr,
              order_id: 'mbr-' + membro_id + '-' + pag.rows[0].id,
              order_description: 'Assinatura PEPMASTERS Members ' + (plano||'pago'),
              ipn_callback_url: BASE_URL + '/api/webhook/nowpayments-members',
            })
          });
          const npData = await npRes.json();
          if (npData.pay_address) {
            nowpay_address_mbr = npData.pay_address;
            nowpay_amount_mbr = npData.pay_amount;
            nowpay_currency_mbr = npData.pay_currency;
            cryptoValor = npData.pay_amount;
            await pool.query(`UPDATE pep_pagamentos_membros SET crypto_valor=$1 WHERE id=$2`, [cryptoValor, pag.rows[0].id]);
            console.log('[NOWPayments Members] Pagamento criado:', npData.pay_amount, npData.pay_currency);
          }
        } catch (e) { console.error('[NOWPayments Members]', e.message); }
      } else {
        // Fallback manual com CoinGecko
        try {
          const cotacao = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl');
          const cj = await cotacao.json();
          const rate = cj?.tether?.brl || 5.5;
          cryptoValor = parseFloat((valor / rate).toFixed(6));
          await pool.query(`UPDATE pep_pagamentos_membros SET crypto_valor=$1 WHERE id=$2`, [cryptoValor, pag.rows[0].id]);
        } catch {}
      }
    }

    // Notificar admin de nova assinatura paga
    if (!isGratis && EMAIL_DESTINO) {
      const uDados = await pool.query(`SELECT nome, email FROM pep_usuarios WHERE id=$1`, [usuario_id]);
      const uNome = uDados.rows[0]?.nome || '—';
      const uEmail = uDados.rows[0]?.email || '—';
      const isTronMbr = pagamento === 'cripto' && cryptoValor > 0;
      const carteiraMbr = 'TSgzRZDGQVWxn29u4fUgaipGKRSv31HxCB';
      enviarEmail(EMAIL_DESTINO,
        '🆕 Nova assinatura Members — ' + (plano || 'pago') + ' — PEPMASTERS',
        '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#1C0A00;color:#fff;border-radius:12px">' +
        '<h2 style="color:#FFB300">🆕 Nova assinatura Members</h2>' +
        '<b>Cliente:</b> ' + uNome + '<br>' +
        '<b>Email:</b> ' + uEmail + '<br>' +
        '<b>Plano:</b> ' + (plano || '—') + '<br>' +
        '<b>Valor:</b> R$ ' + parseFloat(valor||0).toFixed(2).replace('.',',') + '<br>' +
        '<b>Pagamento:</b> ' + pagamento.toUpperCase() +
        (isTronMbr ? '<br><br>💰 <b>Cripto esperado:</b> ' + cryptoValor + ' USDT<br>🌐 <b>Rede:</b> Tron TRC-20<br>👛 <b>Carteira:</b> <code>' + carteiraMbr + '</code><br>🔍 <a href="https://tronscan.org/#/address/' + carteiraMbr + '" style="color:#FFB300">Verificar no Tronscan →</a>' : '') +
        '</div>'
      ).catch(()=>{});
    }

    res.json({ ok: true, membro_id, pagamento_id: pag.rows[0].id, crypto_valor: cryptoValor, isGratis, nowpay_address: nowpay_address_mbr, nowpay_amount: nowpay_amount_mbr, nowpay_currency: nowpay_currency_mbr });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Confirmar pagamento (admin)
app.post('/api/membros/confirmar', adminMiddleware, async (req, res) => {
  const { pagamento_id, membro_id } = req.body;
  try {
    // Buscar situação atual do membro
    const m = await pool.query(`SELECT membro_ate, status, plano FROM pep_membros WHERE id=$1`, [membro_id]);
    if (!m.rows.length) return res.status(404).json({ erro: 'Membro não encontrado.' });

    const { membro_ate, status, plano } = m.rows[0];
    const agora = new Date();
    let novaData;

    // Bronze não tem validade real — pago começa do zero
    const isBronze = plano === 'bronze';
    if (!isBronze && status === 'ativo' && membro_ate && new Date(membro_ate) > agora) {
      // Plano pago ainda ativo: soma +30 dias ao vencimento atual
      novaData = new Date(membro_ate);
      novaData.setDate(novaData.getDate() + 30);
    } else {
      // Bronze, expirado ou pendente: começa do hoje
      novaData = new Date();
      novaData.setDate(novaData.getDate() + 30);
    }

    await pool.query(`UPDATE pep_membros SET status='ativo', membro_ate=$1 WHERE id=$2`, [novaData, membro_id]);
    await pool.query(`UPDATE pep_pagamentos_membros SET status='pago' WHERE id=$1`, [pagamento_id]);

    // Buscar dados do membro para email
    const mDados = await pool.query(
      `SELECT u.email, u.nome, m.codigo_ref, m.plano, COALESCE(u.lang,'pt') as lang FROM pep_membros m JOIN pep_usuarios u ON u.id=m.usuario_id WHERE m.id=$1`,
      [membro_id]
    );
    if (mDados.rows.length > 0) {
      const { email, nome, codigo_ref, plano: planoAtivado, lang } = mDados.rows[0];
      const nivelNomes = {
        pt:{bronze:'Bronze 🥉',prata:'Prata 🥈',ouro:'Ouro 🥇',diamante:'Diamante 💎'},
        en:{bronze:'Bronze 🥉',prata:'Silver 🥈',ouro:'Gold 🥇',diamante:'Diamond 💎'},
        es:{bronze:'Bronze 🥉',prata:'Plata 🥈',ouro:'Oro 🥇',diamante:'Diamante 💎'},
        de:{bronze:'Bronze 🥉',prata:'Silber 🥈',ouro:'Gold 🥇',diamante:'Diamant 💎'},
        fr:{bronze:'Bronze 🥉',prata:'Argent 🥈',ouro:'Or 🥇',diamante:'Diamant 💎'}
      };
      const comissoes = { bronze:'5%', prata:'8%', ouro:'12%', diamante:'15%' };
      const descontos = { bronze:'10%', prata:'15%', ouro:'20%', diamante:'25%' };
      const nomePlano = (nivelNomes[lang]||nivelNomes['pt'])[planoAtivado] || planoAtivado;
      const venceEm = novaData.toLocaleDateString(lang==='pt'?'pt-BR':lang==='de'?'de-DE':lang==='fr'?'fr-FR':'en-US');
      const tmpl = emailTemplates.planoAtivo[lang] || emailTemplates.planoAtivo['pt'];
      const { sub, body } = tmpl(nome.split(' ')[0], nomePlano, venceEm, comissoes[planoAtivado]||'5%', descontos[planoAtivado]||'10%', `${BASE_URL}/ref/${codigo_ref}`, BASE_URL);
      await enviarEmail(email, sub, wrapEmail(body));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Painel do membro
app.get('/api/membros/painel', authMiddleware, async (req, res) => {
  const usuario_id = req.usuario.id;
  try {
    const m = await pool.query(
      `SELECT m.*, u.nome, u.email FROM pep_membros m JOIN pep_usuarios u ON u.id=m.usuario_id WHERE m.usuario_id=$1`,
      [usuario_id]
    );
    if (!m.rows.length) return res.status(404).json({ erro: 'Não é membro.' });

    const membro = m.rows[0];

    // Vendas do afiliado
    const vendas = await pool.query(
      `SELECT COUNT(*) as total_vendas, COALESCE(SUM(valor),0) as volume, COALESCE(SUM(comissao),0) as comissao_total
       FROM pep_vendas_afiliado WHERE membro_id=$1`,
      [membro.id]
    );

    // Histórico de pagamentos
    const pagamentos = await pool.query(
      `SELECT * FROM pep_pagamentos_membros WHERE membro_id=$1 ORDER BY criado_em DESC LIMIT 5`,
      [membro.id]
    );

    const v = vendas.rows[0];
    const nivel = calcularNivel(parseFloat(v.volume));

    // Atualizar nível se mudou
    if (nivel !== membro.nivel) {
      await pool.query(`UPDATE pep_membros SET nivel=$1, vendas_total=$2 WHERE id=$3`, [nivel, v.volume, membro.id]);
    }

    // Abatimento na mensalidade baseado em comissão
    const abatimento = Math.min(parseFloat(v.comissao_total || 0), parseFloat(membro.mensalidade || 0));
    const mensalidade_devida = Math.max(0, parseFloat(membro.mensalidade || 0) - abatimento);

    res.json({
      nome: membro.nome,
      email: membro.email,
      status: membro.status,
      nivel,
      membro_ate: membro.membro_ate,
      codigo_ref: membro.codigo_ref,
      link_afiliado: BASE_URL + '/ref/' + membro.codigo_ref,
      total_vendas: parseInt(v.total_vendas),
      volume_vendas: parseFloat(v.volume),
      comissao_total: parseFloat(v.comissao_total),
      mensalidade: parseFloat(membro.mensalidade || 0),
      abatimento,
      mensalidade_devida,
      pagamentos: pagamentos.rows
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Admin — extrato de um membro específico
app.get('/api/admin/membro/:id/extrato', adminMiddleware, async (req, res) => {
  try {
    const vendas = await pool.query(`
      SELECT va.*, p.produto_nome
      FROM pep_vendas_afiliado va
      LEFT JOIN pep_pedidos p ON p.id = va.pedido_id
      WHERE va.membro_id = $1
      ORDER BY va.criado_em DESC LIMIT 100
    `, [req.params.id]);
    const totais = await pool.query(`
      SELECT COALESCE(SUM(comissao),0) as total_comissao, COALESCE(SUM(valor),0) as total_volume
      FROM pep_vendas_afiliado WHERE membro_id=$1
    `, [req.params.id]);
    res.json({ vendas: vendas.rows, total_comissao: parseFloat(totais.rows[0].total_comissao), total_volume: parseFloat(totais.rows[0].total_volume) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Rota de teste — email pedido confirmado (admin only)
app.post('/api/admin/testar-pedido-confirmado', adminMiddleware, async (req, res) => {
  try {
    const { email_teste } = req.body;
    if (!email_teste) return res.status(400).json({ erro: 'email_teste obrigatório.' });
    const u = await pool.query(`SELECT nome, COALESCE(lang,'pt') as lang FROM pep_usuarios WHERE email=$1`, [email_teste]);
    if (!u.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const { nome, lang } = u.rows[0];
    const tmpl = emailTemplates.pedidoConfirmado[lang] || emailTemplates.pedidoConfirmado['pt'];
    const { sub, body } = tmpl(nome.split(' ')[0], '999', 'BPC-157 5mg', '289,90', BASE_URL);
    await enviarEmail(email_teste, sub, wrapEmail(body));
    res.json({ ok: true, msg: 'Email de pedido confirmado enviado em ' + lang });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Rota de teste — email boas-vindas (admin only)
app.post('/api/admin/testar-boas-vindas', adminMiddleware, async (req, res) => {
  try {
    const { email_teste } = req.body;
    if (!email_teste) return res.status(400).json({ erro: 'email_teste obrigatório.' });
    const u = await pool.query(`SELECT nome, email FROM pep_usuarios WHERE email=$1`, [email_teste]);
    if (!u.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const { nome, email } = u.rows[0];
    await enviarEmail(email, '🎉 Bem-vindo ao PEPMASTERS!', `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#1C0A00;color:#fff;border-radius:12px">
        <div style="text-align:center;margin-bottom:24px">
          <h1 style="font-family:sans-serif;font-weight:900;font-size:2rem;background:linear-gradient(135deg,#E8220A,#FF6B00,#FFB300);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin:0">PEPMASTERS</h1>
          <p style="color:rgba(255,255,255,.5);font-size:.85rem;margin:4px 0 0">High Performance Peptides</p>
        </div>
        <h2 style="color:#FFB300;font-size:1.4rem;margin-bottom:8px">Olá, ${nome.split(' ')[0]}! 👋</h2>
        <p style="color:rgba(255,255,255,.8);line-height:1.7;margin-bottom:16px">Sua conta foi criada com sucesso. Bem-vindo à PEPMASTERS — peptídeos bioativos com qualidade e transparência para atletas e entusiastas de performance.</p>
        <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,179,0,.2);border-radius:10px;padding:16px;margin-bottom:20px">
          <ul style="color:rgba(255,255,255,.7);font-size:.88rem;line-height:2;margin:0;padding-left:20px">
            <li>Explorar nosso catálogo de peptídeos</li>
            <li>Ativar seu acesso Members gratuito (Bronze)</li>
            <li>Ganhar comissões indicando amigos</li>
          </ul>
        </div>
        <div style="text-align:center">
          <a href="${BASE_URL}" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;font-weight:700;text-decoration:none;border-radius:10px;font-size:1rem">Acessar a loja →</a>
        </div>
        <hr style="border-color:rgba(255,255,255,.1);margin:24px 0"/>
        <p style="font-size:.78rem;color:rgba(255,255,255,.3);text-align:center">PEPMASTERS — Performance através da ciência.</p>
      </div>
    `);
    res.json({ ok: true, msg: 'Email de boas-vindas enviado para ' + email });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Rota de teste — email plano expirado (admin only)
app.post('/api/admin/testar-plano-expirado', adminMiddleware, async (req, res) => {
  try {
    const { email_teste } = req.body;
    if (!email_teste) return res.status(400).json({ erro: 'email_teste obrigatório.' });
    const u = await pool.query(`SELECT id FROM pep_usuarios WHERE email=$1`, [email_teste]);
    if (!u.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    // Colocar membro_ate no passado e plano prata para simular expiração
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    await pool.query(`UPDATE pep_membros SET membro_ate=$1, plano='prata', status='ativo' WHERE usuario_id=$2`, [ontem, u.rows[0].id]);
    // Rodar job para processar a expiração
    await jobDiario();
    res.json({ ok: true, msg: 'Plano expirado simulado. Verifique o email.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/admin/testar-plano-ativo', adminMiddleware, async (req, res) => {
  try {
    const { email_teste } = req.body;
    if (!email_teste) return res.status(400).json({ erro: 'email_teste obrigatório.' });
    const u = await pool.query(`SELECT id FROM pep_usuarios WHERE email=$1`, [email_teste]);
    if (!u.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    // Buscar ou criar membro
    let membro = await pool.query(`SELECT id FROM pep_membros WHERE usuario_id=$1`, [u.rows[0].id]);
    if (!membro.rows.length) return res.status(404).json({ erro: 'Membro não encontrado. Ative o Bronze primeiro.' });
    // Simular confirmação de plano Prata
    const ate = new Date(); ate.setDate(ate.getDate() + 30);
    await pool.query(`UPDATE pep_membros SET status='ativo', membro_ate=$1, plano='prata' WHERE id=$2`, [ate, membro.rows[0].id]);
    // Disparar email de plano ativo com idioma do usuário
    const mDados = await pool.query(
      `SELECT u.email, u.nome, m.codigo_ref, m.plano, COALESCE(u.lang,'pt') as lang FROM pep_membros m JOIN pep_usuarios u ON u.id=m.usuario_id WHERE m.id=$1`,
      [membro.rows[0].id]
    );
    const { email, nome, codigo_ref, plano: planoAtivado, lang } = mDados.rows[0];
    const nivelNomes = {
      pt:{bronze:'Bronze 🥉',prata:'Prata 🥈',ouro:'Ouro 🥇',diamante:'Diamante 💎'},
      en:{bronze:'Bronze 🥉',prata:'Silver 🥈',ouro:'Gold 🥇',diamante:'Diamond 💎'},
      es:{bronze:'Bronze 🥉',prata:'Plata 🥈',ouro:'Oro 🥇',diamante:'Diamante 💎'},
      de:{bronze:'Bronze 🥉',prata:'Silber 🥈',ouro:'Gold 🥇',diamante:'Diamant 💎'},
      fr:{bronze:'Bronze 🥉',prata:'Argent 🥈',ouro:'Or 🥇',diamante:'Diamant 💎'}
    };
    const comissoes = { bronze:'5%', prata:'8%', ouro:'12%', diamante:'15%' };
    const descontos = { bronze:'10%', prata:'15%', ouro:'20%', diamante:'25%' };
    const nomePlano = (nivelNomes[lang]||nivelNomes['pt'])[planoAtivado] || planoAtivado;
    const venceEm = ate.toLocaleDateString(lang==='pt'?'pt-BR':lang==='de'?'de-DE':lang==='fr'?'fr-FR':'en-US');
    const tmpl = emailTemplates.planoAtivo[lang] || emailTemplates.planoAtivo['pt'];
    const { sub, body } = tmpl(nome.split(' ')[0], nomePlano, venceEm, comissoes[planoAtivado]||'5%', descontos[planoAtivado]||'10%', `${BASE_URL}/ref/${codigo_ref}`, BASE_URL);
    await enviarEmail(email, sub, wrapEmail(body));
    res.json({ ok: true, msg: 'Email de plano ativo enviado para ' + email + ' em ' + lang });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Uso do banco de dados
app.get('/api/admin/db-uso', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        pg_size_pretty(pg_database_size(current_database())) as tamanho,
        pg_database_size(current_database()) as bytes,
        (SELECT COUNT(*) FROM pep_pedidos) as total_pedidos,
        (SELECT COUNT(*) FROM pep_usuarios) as total_usuarios,
        (SELECT COUNT(*) FROM pep_membros) as total_membros,
        (SELECT COUNT(*) FROM pep_forum_topicos) as total_topicos,
        (SELECT COUNT(*) FROM pep_forum_respostas) as total_respostas
    `);
    const bytes = parseInt(r.rows[0].bytes);
    const limite = 1073741824; // 1GB
    const pct = Math.round((bytes / limite) * 100);
    res.json({ ...r.rows[0], pct, limite_gb: '1GB', usado: r.rows[0].tamanho });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/admin/relatorio/pedidos — endpoint para Power BI
app.get('/api/admin/relatorio/pedidos', async (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.ADMIN_RELATORIO_TOKEN) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }
  try {
    // Pedidos com itens expandidos
    const r = await pool.query(`
      SELECT
        p.id            AS pedido_id,
        p.nome          AS cliente,
        p.email,
        p.cpf,
        p.telefone,
        COALESCE(p.endereco, CONCAT_WS(', ',
          NULLIF(p.rua,''), NULLIF(p.numero,''),
          NULLIF(p.complemento,''), NULLIF(p.cidade,''),
          NULLIF(p.cep,''))) AS endereco,
        i.codigo        AS produto_codigo,
        i.nome          AS produto_nome,
        i.quantidade,
        i.preco_unit,
        i.subtotal      AS subtotal_produto,
        COALESCE(p.aduana, 0)  AS aduana,
        p.total         AS total_pedido,
        p.pagamento,
        p.status,
        p.cupom,
        p.codigo_rastreio AS rastreio,
        p.criado_em     AS data
      FROM pep_pedidos p
      JOIN pep_pedido_itens i ON i.pedido_id = p.id
      ORDER BY p.criado_em DESC
    `);

    // Pedidos sem itens (pedidos antigos)
    const sem_itens = await pool.query(`
      SELECT
        p.id            AS pedido_id,
        p.nome          AS cliente,
        p.email,
        p.cpf,
        p.telefone,
        COALESCE(p.endereco, CONCAT_WS(', ',
          NULLIF(p.rua,''), NULLIF(p.numero,''),
          NULLIF(p.complemento,''), NULLIF(p.cidade,''),
          NULLIF(p.cep,''))) AS endereco,
        NULL            AS produto_codigo,
        p.produto_nome,
        NULL            AS quantidade,
        NULL            AS preco_unit,
        NULL            AS subtotal_produto,
        COALESCE(p.aduana, 0)  AS aduana,
        p.total         AS total_pedido,
        p.pagamento,
        p.status,
        p.cupom,
        p.codigo_rastreio AS rastreio,
        p.criado_em     AS data
      FROM pep_pedidos p
      WHERE NOT EXISTS (SELECT 1 FROM pep_pedido_itens i WHERE i.pedido_id = p.id)
      ORDER BY p.criado_em DESC
    `);

    const todos = [...r.rows, ...sem_itens.rows];
    res.json(todos);
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /api/admin/pedido-manual
app.post('/api/admin/pedido-manual', adminMiddleware, async (req, res) => {
  const { nome, email, telefone, cpf, endereco, produto_nome, itens, total, aduana, observacao, usuario_id } = req.body;
  if (!nome || !total || !produto_nome) return res.status(400).json({ erro: 'Nome, produto e total são obrigatórios.' });
  const valorTotal = parseFloat(total);
  if (isNaN(valorTotal) || valorTotal <= 0) return res.status(400).json({ erro: 'Valor inválido.' });
  if (valorTotal > 6000) return res.status(400).json({ erro: 'Valor máximo é R$ 6.000.' });
  const numQrs = Math.ceil(valorTotal / 2000);
  function splitValores(total, n) {
    if (n <= 1) return [parseFloat(total.toFixed(2))];
    const base = Math.floor((total / n) * 100) / 100;
    const vals = []; let soma = 0;
    for (let i = 0; i < n - 1; i++) { const v = parseFloat((base + (i+1)*0.03).toFixed(2)); vals.push(v); soma += v; }
    vals.push(parseFloat((total - soma).toFixed(2)));
    return vals;
  }
  const parcelas = splitValores(valorTotal, numQrs);
  try {
    const pedRow = await pool.query(
      `INSERT INTO pep_pedidos (nome, email, telefone, cpf, endereco, produto_nome, produto_id, quantidade, total, aduana, pagamento, status, observacao, usuario_id, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',1,$7,$8,'pix','pix_pending',$9,$10,NOW()) RETURNING id`,
      [nome, email||null, telefone||null, cpf||null, endereco||null, produto_nome, valorTotal, parseFloat(aduana||0), observacao||null, usuario_id||null]
    );
    const pedidoId = pedRow.rows[0].id;
    // Salvar itens
    if (itens && itens.length) {
      for (const item of itens) {
        await pool.query(
          `INSERT INTO pep_pedido_itens (pedido_id, codigo, nome, quantidade, preco_unit, subtotal) VALUES ($1,$2,$3,$4,$5,$6)`,
          [pedidoId, item.codigo||null, item.nome, item.quantidade, parseFloat(item.preco||0).toFixed(2), (parseFloat(item.preco||0)*item.quantidade).toFixed(2)]
        ).catch(()=>{});
      }
    }
    const qrs = [];
    let pixgoIds = [];
    if (PIXGO_API_KEY) {
      for (let i = 0; i < numQrs; i++) {
        const valor = parcelas[i];
        const extId = `pep-${pedidoId}-adm-${i+1}`;
        try {
          const pr = await fetch('https://pixgo.org/api/v1/payment/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': PIXGO_API_KEY },
            body: JSON.stringify({ amount: valor, description: `PEPMASTERS #${pedidoId}${numQrs>1?` (${i+1}/${numQrs})`:''}`, external_id: extId, webhook_url: BASE_URL + '/webhook/pixgo' })
          });
          const pd = await pr.json();
          if (pd.success && pd.data) {
            qrs.push({ parte: i+1, valor, qrcode_url: pd.data.qr_image_url||null, copia_cola: pd.data.qr_code||null });
            pixgoIds.push(pd.data.payment_id||pd.data.id||extId);
          } else { qrs.push({ parte: i+1, valor, erro: pd.message||'Erro PixGo' }); }
        } catch(e) { qrs.push({ parte: i+1, valor, erro: e.message }); }
      }
      if (pixgoIds.length) await pool.query('UPDATE pep_pedidos SET pixgo_id=$1 WHERE id=$2', [pixgoIds.join(','), pedidoId]);
    } else {
      for (let i = 0; i < numQrs; i++) qrs.push({ parte: i+1, valor: parcelas[i], qrcode_url: null, copia_cola: null, erro: 'PIXGO_API_KEY não configurado' });
    }
    enviarWhatsApp(`📋 Pedido manual #${pedidoId} — ${nome} — ${produto_nome} — R$ ${valorTotal.toFixed(2).replace('.',',')} — ${numQrs} QR(s)`);
    res.json({
      ok: true, pedido_id: pedidoId, total: valorTotal, num_qrs: numQrs, qrs,
      whatsapp_link: telefone ? `https://wa.me/${telefone.replace(/\D/g,'')}?text=${encodeURIComponent(`Olá ${nome.split(' ')[0]}! Pedido PEPMASTERS #${pedidoId}.\n*Produto:* ${produto_nome}\n*Total: R$ ${valorTotal.toFixed(2).replace('.',',')}*\n${numQrs>1?`\n⚠️ Dividido em ${numQrs} PIX:\n${parcelas.map((v,i)=>`• PIX ${i+1}: R$ ${v.toFixed(2).replace('.',',')}`).join('\n')}\n\nPague *todos* para confirmar! ✅`:'\nEscaneie o QR code para confirmar! ✅'}`)}` : null
    });
  } catch(err) {
    console.error('[pedido-manual]', err.message);
    res.status(500).json({ erro: 'Erro: ' + err.message });
  }
});

// GET /api/admin/buscar-usuario
app.get('/api/admin/buscar-usuario', adminMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT id, nome, email, cpf, telefone FROM pep_usuarios WHERE nome ILIKE $1 OR email ILIKE $1 OR cpf ILIKE $1 LIMIT 10`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch { res.json([]); }
});

// GET /api/admin/pedido/:id/itens
app.get('/api/admin/pedido/:id/itens', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM pep_pedido_itens WHERE pedido_id=$1 ORDER BY id', [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/admin/pedido/:id/editar
app.put('/api/admin/pedido/:id/editar', adminMiddleware, async (req, res) => {
  const { nome, email, telefone, endereco, produto_nome, observacao } = req.body;
  try {
    await pool.query(
      `UPDATE pep_pedidos SET
        nome        = COALESCE(NULLIF($1,''), nome),
        email       = COALESCE(NULLIF($2,''), email),
        telefone    = COALESCE(NULLIF($3,''), telefone),
        endereco    = COALESCE(NULLIF($4,''), endereco),
        produto_nome= COALESCE(NULLIF($5,''), produto_nome),
        observacao  = COALESCE(NULLIF($6,''), observacao)
       WHERE id=$7`,
      [nome||'', email||'', telefone||'', endereco||'', produto_nome||'', observacao||'', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Deletar pedidos (admin)
app.delete('/api/admin/pedidos', adminMiddleware, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ erro: 'Informe os IDs.' });
  try {
    await pool.query(`DELETE FROM pep_pedidos WHERE id = ANY($1::int[])`, [ids]);
    res.json({ ok: true, deletados: ids.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Regenerar endereço NOWPayments para pedido existente
app.put('/api/pedido/:id/cripto-token', authMiddleware, async (req, res) => {
  const { crypto_token } = req.body;
  try {
    const pedido = await pool.query(`SELECT * FROM pep_pedidos WHERE id=$1 AND usuario_id=$2`, [req.params.id, req.usuario.id]);
    if (!pedido.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = pedido.rows[0];
    const moedaMap = { 'USDTPOLYGON':'usdtmatic', 'USDCPOLYGON':'usdcmatic', 'USDTTRX':'usdttrc20' };
    const moeda = moedaMap[crypto_token] || 'usdtmatic';
    let valorUsd = p.total;
    try {
      const cambio = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const cambioData = await cambio.json();
      valorUsd = (p.total / (cambioData.rates?.BRL || 5.5)).toFixed(2);
    } catch { valorUsd = (p.total / 5.5).toFixed(2); }
    const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: valorUsd, price_currency: 'usd', pay_currency: moeda,
        order_id: String(req.params.id),
        order_description: 'Pedido PEPMASTERS #' + req.params.id,
        ipn_callback_url: BASE_URL + '/api/webhook/nowpayments',
      })
    });
    const npData = await npRes.json();
    if (!npData.pay_address) return res.status(400).json({ erro: npData.message || 'Erro NOWPayments.' });
    await pool.query(`UPDATE pep_pedidos SET crypto_token=$1 WHERE id=$2`, [npData.payment_id, req.params.id]);
    res.json({ nowpay_address: npData.pay_address, nowpay_amount: npData.pay_amount, nowpay_currency: npData.pay_currency });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Dashboard admin
app.get('/api/admin/dashboard', adminMiddleware, async (req, res) => {
  try {
    const receita = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', criado_em),'YYYY-MM') as mes,
             COALESCE(SUM(total),0) as receita
      FROM pep_pedidos WHERE status IN ('pago','confirmado','enviado','entregue')
        AND criado_em >= NOW() - INTERVAL '12 months'
      GROUP BY mes ORDER BY mes
    `);
    const receitaMembros = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', criado_em),'YYYY-MM') as mes,
             COALESCE(SUM(valor),0) as receita
      FROM pep_pagamentos_membros WHERE status='pago'
        AND criado_em >= NOW() - INTERVAL '12 months'
      GROUP BY mes ORDER BY mes
    `);
    const novosMembros = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', criado_em),'YYYY-MM') as mes,
             COUNT(*) as total
      FROM pep_membros WHERE criado_em >= NOW() - INTERVAL '12 months'
      GROUP BY mes ORDER BY mes
    `);
    const volumeAfiliados = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', criado_em),'YYYY-MM') as mes,
             COALESCE(SUM(valor),0) as volume,
             COALESCE(SUM(comissao),0) as comissao
      FROM pep_vendas_afiliado WHERE criado_em >= NOW() - INTERVAL '12 months'
      GROUP BY mes ORDER BY mes
    `);
    const totais = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM pep_usuarios) as total_usuarios,
        (SELECT COUNT(*) FROM pep_membros WHERE status='ativo') as membros_ativos,
        (SELECT COUNT(*) FROM pep_pedidos WHERE status IN ('pago','confirmado','enviado','entregue')) as pedidos_pagos,
        (SELECT COALESCE(SUM(total),0) FROM pep_pedidos WHERE status IN ('pago','confirmado','enviado','entregue')) as receita_total,
        (SELECT COUNT(*) FROM pep_pedidos WHERE status='pendente') as pedidos_pendentes,
        (SELECT COUNT(*) FROM pep_membros WHERE status='pendente') as membros_pendentes
    `);
    const topAfiliados = await pool.query(`
      SELECT u.nome, m.nivel, m.codigo_ref,
             COALESCE(SUM(va.valor),0) as volume, COUNT(va.id) as vendas
      FROM pep_membros m
      JOIN pep_usuarios u ON u.id=m.usuario_id
      LEFT JOIN pep_vendas_afiliado va ON va.membro_id=m.id AND va.criado_em>=DATE_TRUNC('month',NOW())
      WHERE m.status='ativo'
      GROUP BY m.id,u.nome ORDER BY volume DESC LIMIT 5
    `);
    res.json({ receita: receita.rows, receita_membros: receitaMembros.rows, novos_membros: novosMembros.rows, volume_afiliados: volumeAfiliados.rows, totais: totais.rows[0], top_afiliados: topAfiliados.rows });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Listar membros pendentes (admin)
app.get('/api/membros/admin', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT m.*, u.nome, u.email, u.telefone,
             pm.id as pag_id, pm.valor as pag_valor, pm.pagamento as pag_tipo, pm.status as pag_status, pm.criado_em as pag_criado
      FROM pep_membros m
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN LATERAL (
        SELECT id, valor, pagamento, status, criado_em
        FROM pep_pagamentos_membros
        WHERE membro_id = m.id AND status = 'pendente'
        ORDER BY criado_em DESC LIMIT 1
      ) pm ON TRUE
      ORDER BY m.criado_em DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Curtir tópico ou resposta
app.post('/api/forum/like', membroMiddleware, async (req, res) => {
  const { topico_id, resposta_id } = req.body;
  try {
    if (topico_id) {
      const exists = await pool.query(`SELECT id FROM pep_forum_likes WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, topico_id]);
      if (exists.rows.length) {
        await pool.query(`DELETE FROM pep_forum_likes WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, topico_id]);
        await pool.query(`UPDATE pep_forum_topicos SET likes=GREATEST(0,likes-1) WHERE id=$1`, [topico_id]);
        return res.json({ ok: true, liked: false });
      }
      await pool.query(`INSERT INTO pep_forum_likes (membro_id, topico_id) VALUES ($1,$2)`, [req.membro.id, topico_id]);
      await pool.query(`UPDATE pep_forum_topicos SET likes=likes+1 WHERE id=$1`, [topico_id]);
      return res.json({ ok: true, liked: true });
    }
    if (resposta_id) {
      const exists = await pool.query(`SELECT id FROM pep_forum_likes WHERE membro_id=$1 AND resposta_id=$2`, [req.membro.id, resposta_id]);
      if (exists.rows.length) {
        await pool.query(`DELETE FROM pep_forum_likes WHERE membro_id=$1 AND resposta_id=$2`, [req.membro.id, resposta_id]);
        await pool.query(`UPDATE pep_forum_respostas SET likes=GREATEST(0,likes-1) WHERE id=$1`, [resposta_id]);
        return res.json({ ok: true, liked: false });
      }
      await pool.query(`INSERT INTO pep_forum_likes (membro_id, resposta_id) VALUES ($1,$2)`, [req.membro.id, resposta_id]);
      await pool.query(`UPDATE pep_forum_respostas SET likes=likes+1 WHERE id=$1`, [resposta_id]);
      return res.json({ ok: true, liked: true });
    }
    res.status(400).json({ erro: 'Informe topico_id ou resposta_id.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Favoritar / desfavoritar tópico
app.post('/api/forum/favoritar', membroMiddleware, async (req, res) => {
  const { topico_id } = req.body;
  if (!topico_id) return res.status(400).json({ erro: 'topico_id obrigatório.' });
  try {
    const exists = await pool.query(`SELECT id FROM pep_forum_favoritos WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, topico_id]);
    if (exists.rows.length) {
      await pool.query(`DELETE FROM pep_forum_favoritos WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, topico_id]);
      return res.json({ ok: true, favoritado: false });
    }
    await pool.query(`INSERT INTO pep_forum_favoritos (membro_id, topico_id) VALUES ($1,$2)`, [req.membro.id, topico_id]);
    res.json({ ok: true, favoritado: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Listar favoritos do membro
app.get('/api/forum/favoritos', membroMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.*, u.nome as autor_nome, m.nivel as autor_nivel,
             COUNT(resp.id) as total_respostas
      FROM pep_forum_favoritos f
      JOIN pep_forum_topicos t ON t.id = f.topico_id
      JOIN pep_membros m ON m.id = t.membro_id
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN pep_forum_respostas resp ON resp.topico_id = t.id
      WHERE f.membro_id = $1
      GROUP BY t.id, u.nome, m.nivel
      ORDER BY f.criado_em DESC
    `, [req.membro.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Verificar curtidas e favoritos do membro em um tópico
app.get('/api/forum/topicos/:id/meu-status', membroMiddleware, async (req, res) => {
  try {
    const like = await pool.query(`SELECT id FROM pep_forum_likes WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, req.params.id]);
    const fav = await pool.query(`SELECT id FROM pep_forum_favoritos WHERE membro_id=$1 AND topico_id=$2`, [req.membro.id, req.params.id]);
    // Likes nas respostas
    const respLikes = await pool.query(`
      SELECT fl.resposta_id FROM pep_forum_likes fl
      JOIN pep_forum_respostas fr ON fr.id = fl.resposta_id
      WHERE fl.membro_id=$1 AND fr.topico_id=$2
    `, [req.membro.id, req.params.id]);
    res.json({
      liked_topico: like.rows.length > 0,
      favoritado: fav.rows.length > 0,
      liked_respostas: respLikes.rows.map(r => r.resposta_id)
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Denunciar tópico ou resposta
app.post('/api/forum/denunciar', membroMiddleware, async (req, res) => {
  const { topico_id, resposta_id, motivo } = req.body;
  if (!topico_id && !resposta_id) return res.status(400).json({ erro: 'Informe o tópico ou resposta.' });
  try {
    // Verificar se já denunciou
    const existing = await pool.query(
      `SELECT id FROM pep_forum_denuncias WHERE membro_id=$1 AND (topico_id=$2 OR resposta_id=$3)`,
      [req.membro.id, topico_id || null, resposta_id || null]
    );
    if (existing.rows.length) return res.status(400).json({ erro: 'Você já denunciou este conteúdo.' });

    await pool.query(
      `INSERT INTO pep_forum_denuncias (topico_id, resposta_id, membro_id, motivo) VALUES ($1,$2,$3,$4)`,
      [topico_id || null, resposta_id || null, req.membro.id, motivo || null]
    );
    if (resposta_id) {
      await pool.query(`UPDATE pep_forum_respostas SET denuncias=denuncias+1 WHERE id=$1`, [resposta_id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — listar denúncias
app.get('/api/admin/forum/denuncias', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.*, 
             u.nome as denunciante,
             t.titulo as topico_titulo,
             resp.conteudo as resposta_conteudo,
             ua.nome as autor_nome
      FROM pep_forum_denuncias d
      JOIN pep_membros md ON md.id = d.membro_id
      JOIN pep_usuarios u ON u.id = md.usuario_id
      LEFT JOIN pep_forum_topicos t ON t.id = d.topico_id
      LEFT JOIN pep_forum_respostas resp ON resp.id = d.resposta_id
      LEFT JOIN pep_membros ma ON ma.id = resp.membro_id
      LEFT JOIN pep_usuarios ua ON ua.id = ma.usuario_id
      WHERE d.status = 'pendente'
      ORDER BY d.criado_em DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — resolver denúncia
app.put('/api/admin/forum/denuncias/:id', adminMiddleware, async (req, res) => {
  const { acao } = req.body; // 'ignorar' ou 'deletar'
  try {
    const d = await pool.query(`SELECT * FROM pep_forum_denuncias WHERE id=$1`, [req.params.id]);
    if (!d.rows.length) return res.status(404).json({ erro: 'Não encontrado.' });
    const denuncia = d.rows[0];

    if (acao === 'deletar') {
      if (denuncia.resposta_id) {
        await pool.query(`DELETE FROM pep_forum_respostas WHERE id=$1`, [denuncia.resposta_id]);
      } else if (denuncia.topico_id) {
        await pool.query(`DELETE FROM pep_forum_topicos WHERE id=$1`, [denuncia.topico_id]);
      }
    }
    // Marcar todas denúncias do mesmo conteúdo como resolvidas
    await pool.query(
      `UPDATE pep_forum_denuncias SET status='resolvido' WHERE (topico_id=$1 OR resposta_id=$2)`,
      [denuncia.topico_id || null, denuncia.resposta_id || null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — listar tópicos do fórum
app.get('/api/admin/forum', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.*, u.nome as autor_nome, m.nivel as autor_nivel,
             COUNT(r.id) as total_respostas
      FROM pep_forum_topicos t
      JOIN pep_membros m ON m.id = t.membro_id
      JOIN pep_usuarios u ON u.id = m.usuario_id
      LEFT JOIN pep_forum_respostas r ON r.topico_id = t.id
      GROUP BY t.id, u.nome, m.nivel
      ORDER BY t.fixado DESC, t.criado_em DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — fixar/desafixar tópico
app.put('/api/admin/forum/:id/fixar', adminMiddleware, async (req, res) => {
  try {
    const t = await pool.query(`SELECT fixado FROM pep_forum_topicos WHERE id=$1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ erro: 'Não encontrado.' });
    const novoStatus = !t.rows[0].fixado;
    await pool.query(`UPDATE pep_forum_topicos SET fixado=$1 WHERE id=$2`, [novoStatus, req.params.id]);
    res.json({ ok: true, fixado: novoStatus });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — deletar tópico
app.delete('/api/admin/forum/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pep_forum_topicos WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Admin — deletar resposta
app.delete('/api/admin/forum/resposta/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pep_forum_respostas WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Bloquear membro (admin)
app.put('/api/admin/membro/:id/bloquear', adminMiddleware, async (req, res) => {
  try {
    await pool.query(`UPDATE pep_membros SET status='expirado', membro_ate=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Registrar venda via afiliado (chamado internamente ao criar pedido)
async function registrarVendaAfiliado(ref_code, pedido_id, valor) {
  try {
    if (!ref_code) return;
    const m = await pool.query(`SELECT id, nivel FROM pep_membros WHERE codigo_ref=$1 AND status='ativo'`, [ref_code]);
    if (!m.rows.length) return;
    const membro = m.rows[0];
    const comissao = parseFloat((valor * comissaoPorNivel(membro.nivel)).toFixed(2));
    await pool.query(
      `INSERT INTO pep_vendas_afiliado (membro_id, pedido_id, valor, comissao) VALUES ($1,$2,$3,$4)`,
      [membro.id, pedido_id, valor, comissao]
    );
    // Atualizar volume total e crédito
    await pool.query(
      `UPDATE pep_membros SET vendas_total=vendas_total+$1, credito=credito+$2 WHERE id=$3`,
      [valor, comissao, membro.id]
    );
    // Verificar badges e criar notificação de nova venda
    verificarBadges(membro.id).catch(() => {});
    criarNotificacao(membro.id, 'venda', `💰 Nova venda: R$ ${parseFloat(valor).toFixed(2)} — comissão R$ ${comissao.toFixed(2)}`, '/members.html').catch(() => {});
  } catch (e) {
    console.error('[Afiliado] Erro:', e.message);
  }
}

// Página pública do distribuidor
app.get('/distribuidor/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'distribuidor.html'));
});


// ─────────────────────────────────────────────
//  NOWPAYMENTS — CRIPTO AUTOMÁTICO
// ─────────────────────────────────────────────

// Criar pagamento NOWPayments
app.post('/api/nowpayments/criar', authMiddleware, async (req, res) => {
  const { pedido_id, valor_brl, moeda } = req.body;
  // moeda: USDTPOLYGON, USDCPOLYGON, USDTTRX
  if (!NOWPAYMENTS_API_KEY) return res.status(500).json({ erro: 'NOWPayments não configurado.' });
  try {
    const r = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: valor_brl,
        price_currency: 'brl',
        pay_currency: moeda || 'usdtmatic',
        order_id: String(pedido_id),
        order_description: 'Pedido PEPMASTERS #' + pedido_id,
        ipn_callback_url: BASE_URL + '/api/webhook/nowpayments',
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ erro: data.message || 'Erro NOWPayments.' });
    // Salvar payment_id no pedido
    await pool.query(`UPDATE pep_pedidos SET crypto_token=$1 WHERE id=$2`, [data.payment_id, pedido_id]);
    res.json({
      payment_id: data.payment_id,
      pay_address: data.pay_address,
      pay_amount: data.pay_amount,
      pay_currency: data.pay_currency,
      status: data.payment_status
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Webhook NOWPayments UNIFICADO — detecta se é pedido ou assinatura
app.post('/api/webhook/nowpayments', async (req, res) => {
  const { order_id } = req.body;
  // Se order_id começa com "mbr-" é assinatura, senão é pedido
  if (order_id && order_id.startsWith('mbr-')) {
    return webhookNowpaymentsMembers(req, res);
  }
  return webhookNowpaymentsPedidos(req, res);
});

// Ordena chaves recursivamente para verificação de assinatura NOWPayments
function sortObjectKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortObjectKeys(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

async function webhookNowpaymentsPedidos(req, res) {
  try {
    // Verificar assinatura IPN
    if (NOWPAYMENTS_IPN_SECRET) {
      const crypto = require('crypto');
      const sig = req.headers['x-nowpayments-sig'];
      const payload = JSON.stringify(sortObjectKeys(req.body));
      const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(payload).digest('hex');
      if (sig !== expected) {
        console.error('[NOWPayments] Assinatura inválida');
        return res.status(400).json({ erro: 'Assinatura inválida.' });
      }
    }

    const { order_id, payment_status, pay_amount, pay_currency, actually_paid } = req.body;
    console.log('[NOWPayments] Webhook:', payment_status, 'pedido:', order_id, 'pago:', actually_paid, '/', pay_amount);

    if (payment_status === 'partially_paid') {
      // Notificar admin para verificar manualmente se o total recebido é suficiente
      if (EMAIL_DESTINO) {
        enviarEmail(EMAIL_DESTINO,
          '⚠️ Pagamento parcial — Pedido #' + order_id + ' — PEPMASTERS',
          '<div style="font-family:sans-serif;padding:20px;background:#1C0A00;color:#fff;border-radius:12px">' +
          '<h2 style="color:#eab308">⚠️ Pagamento parcial recebido</h2>' +
          '<b>Pedido:</b> #' + order_id + '<br>' +
          '<b>Esperado:</b> ' + pay_amount + ' ' + pay_currency + '<br>' +
          '<b>Recebido:</b> ' + actually_paid + ' ' + pay_currency + '<br>' +
          '<p>Verifique manualmente no NOWPayments se o total acumulado é suficiente e confirme o pedido no admin.</p>' +
          '</div>'
        ).catch(()=>{});
      }
    }

    if (payment_status === 'finished' || payment_status === 'confirmed') {
      const pedido = await pool.query(`SELECT * FROM pep_pedidos WHERE id=$1`, [order_id]);
      if (!pedido.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
      const p = pedido.rows[0];

      if (p.status === 'pago') return res.json({ ok: true, msg: 'Já confirmado.' });

      // Confirmar pedido
      await pool.query(`UPDATE pep_pedidos SET status='pago', crypto_valor=$1 WHERE id=$2`, [actually_paid || pay_amount, order_id]);

      // Processar comissão de afiliado
      if (p.ref_code) {
        const membro = await pool.query(`SELECT * FROM pep_membros WHERE codigo_ref=$1 AND status='ativo'`, [p.ref_code]);
        if (membro.rows.length) {
          const comissoes = { bronze:0.05, prata:0.08, ouro:0.12, diamante:0.15 };
          const taxa = comissoes[membro.rows[0].nivel] || 0.05;
          const comissao = parseFloat(p.total || 0) * taxa;
          await pool.query(`INSERT INTO pep_vendas_afiliado (membro_id, pedido_id, valor, comissao) VALUES ($1,$2,$3,$4)`, [membro.rows[0].id, p.id, p.total, comissao]);
          await pool.query(`UPDATE pep_membros SET vendas_total=vendas_total+$1, credito=credito+$2 WHERE id=$3`, [p.total, comissao, membro.rows[0].id]);
          verificarBadges(membro.rows[0].id).catch(()=>{});
        }
      }

      // Baixar estoque
      if (p.produto_id && p.quantidade) {
        await pool.query(`UPDATE pep_estoque SET estoque=estoque-$1 WHERE produto_id=$2`, [p.quantidade, p.produto_id]);
      }

      // Email para o cliente
      const uLang = await pool.query(`SELECT u.lang FROM pep_usuarios u WHERE u.email=$1`, [p.email]).catch(()=>({rows:[]}));
      const lang = uLang.rows[0]?.lang || 'pt';
      const tmpl = emailTemplates.pedidoConfirmado[lang] || emailTemplates.pedidoConfirmado['pt'];
      const { sub, body } = tmpl(p.nome?.split(' ')[0] || 'Cliente', order_id, p.produto_nome, parseFloat(p.total||0).toFixed(2).replace('.',','), BASE_URL);
      enviarEmail(p.email, sub, wrapEmail(body)).catch(()=>{});

      // Email para admin
      if (EMAIL_DESTINO) {
        enviarEmail(EMAIL_DESTINO,
          '✅ Pagamento confirmado automaticamente #' + order_id + ' — PEPMASTERS',
          '<div style="font-family:sans-serif;padding:20px;background:#1C0A00;color:#fff;border-radius:12px">' +
          '<h2 style="color:#22c55e">✅ Pagamento confirmado!</h2>' +
          '<b>Pedido:</b> #' + order_id + '<br>' +
          '<b>Cliente:</b> ' + (p.nome||'—') + '<br>' +
          '<b>Valor:</b> R$ ' + parseFloat(p.total||0).toFixed(2).replace('.',',') + '<br>' +
          '<b>Pago:</b> ' + (actually_paid || pay_amount) + ' ' + pay_currency + '<br>' +
          '</div>'
        ).catch(()=>{});
      }

      console.log('[NOWPayments] Pedido #' + order_id + ' confirmado automaticamente');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[NOWPayments webhook]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

async function webhookNowpaymentsMembers(req, res) {
  try {
    if (NOWPAYMENTS_IPN_SECRET) {
      const crypto = require('crypto');
      const sig = req.headers['x-nowpayments-sig'];
      const payload = JSON.stringify(sortObjectKeys(req.body));
      const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(payload).digest('hex');
      if (sig !== expected) return res.status(400).json({ erro: 'Assinatura inválida.' });
    }

    const { order_id, payment_status, actually_paid, pay_amount, pay_currency } = req.body;
    console.log('[NOWPayments Members] Webhook:', payment_status, 'order:', order_id);

    if (payment_status === 'finished' || payment_status === 'confirmed') {
      // order_id formato: mbr-{membro_id}-{pagamento_id}
      const parts = order_id.split('-');
      const membro_id = parseInt(parts[1]);
      const pagamento_id = parseInt(parts[2]);

      if (!membro_id || !pagamento_id) return res.status(400).json({ erro: 'order_id inválido.' });

      const m = await pool.query(`SELECT membro_ate, status, plano FROM pep_membros WHERE id=$1`, [membro_id]);
      if (!m.rows.length) return res.status(404).json({ erro: 'Membro não encontrado.' });

      const { membro_ate, status, plano } = m.rows[0];
      const agora = new Date();
      let novaData;
      const isBronze = plano === 'bronze';
      if (!isBronze && status === 'ativo' && membro_ate && new Date(membro_ate) > agora) {
        novaData = new Date(membro_ate);
        novaData.setDate(novaData.getDate() + 30);
      } else {
        novaData = new Date();
        novaData.setDate(novaData.getDate() + 30);
      }

      await pool.query(`UPDATE pep_membros SET status='ativo', membro_ate=$1 WHERE id=$2`, [novaData, membro_id]);
      await pool.query(`UPDATE pep_pagamentos_membros SET status='pago', crypto_valor=$1 WHERE id=$2`, [actually_paid || pay_amount, pagamento_id]);

      // Email para o membro
      const mDados = await pool.query(
        `SELECT u.email, u.nome, m.codigo_ref, m.plano, COALESCE(u.lang,'pt') as lang FROM pep_membros m JOIN pep_usuarios u ON u.id=m.usuario_id WHERE m.id=$1`,
        [membro_id]
      );
      if (mDados.rows.length) {
        const { email, nome, codigo_ref, plano: planoAtivado, lang } = mDados.rows[0];
        const nivelNomes = {
          pt:{bronze:'Bronze 🥉',prata:'Prata 🥈',ouro:'Ouro 🥇',diamante:'Diamante 💎'},
          en:{bronze:'Bronze 🥉',prata:'Silver 🥈',ouro:'Gold 🥇',diamante:'Diamond 💎'},
          es:{bronze:'Bronze 🥉',prata:'Plata 🥈',ouro:'Oro 🥇',diamante:'Diamante 💎'},
          de:{bronze:'Bronze 🥉',prata:'Silber 🥈',ouro:'Gold 🥇',diamante:'Diamant 💎'},
          fr:{bronze:'Bronze 🥉',prata:'Argent 🥈',ouro:'Or 🥇',diamante:'Diamant 💎'}
        };
        const comissoes = { bronze:'5%', prata:'8%', ouro:'12%', diamante:'15%' };
        const descontos = { bronze:'10%', prata:'15%', ouro:'20%', diamante:'25%' };
        const nomePlano = (nivelNomes[lang]||nivelNomes['pt'])[planoAtivado] || planoAtivado;
        const venceEm = novaData.toLocaleDateString(lang==='pt'?'pt-BR':lang==='de'?'de-DE':lang==='fr'?'fr-FR':'en-US');
        const tmpl = emailTemplates.planoAtivo[lang] || emailTemplates.planoAtivo['pt'];
        const { sub, body } = tmpl(nome.split(' ')[0], nomePlano, venceEm, comissoes[planoAtivado]||'5%', descontos[planoAtivado]||'10%', `${BASE_URL}/ref/${codigo_ref}`, BASE_URL);
        enviarEmail(email, sub, wrapEmail(body)).catch(()=>{});

        // Email para admin
        if (EMAIL_DESTINO) {
          enviarEmail(EMAIL_DESTINO,
            '✅ Assinatura Members confirmada — ' + nomePlano + ' — PEPMASTERS',
            '<div style="font-family:sans-serif;padding:20px;background:#1C0A00;color:#fff;border-radius:12px">' +
            '<h2 style="color:#22c55e">✅ Assinatura confirmada automaticamente!</h2>' +
            '<b>Membro:</b> ' + nome + '<br><b>Plano:</b> ' + nomePlano + '<br>' +
            '<b>Pago:</b> ' + (actually_paid || pay_amount) + ' ' + pay_currency + '<br>' +
            '<b>Ativo até:</b> ' + venceEm + '</div>'
          ).catch(()=>{});
        }
      }

      console.log('[NOWPayments Members] Membro #' + membro_id + ' plano ativado automaticamente');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[NOWPayments Members webhook]', err.message);
    res.status(500).json({ erro: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
//  PEPMASTERS CLUB — Endpoints
// ═══════════════════════════════════════════════════════════

const CLUB_TAXA = 5; // % padrão
const CLUB_LIBERACAO_DIAS = 5; // dias para liberar automaticamente após envio

// Middleware de fornecedor autenticado
async function clubFornecedorMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    const r = await pool.query('SELECT f.* FROM club_fornecedores f WHERE f.usuario_id=$1 AND f.status=$2', [decoded.id, 'ativo']);
    if (!r.rows.length) return res.status(403).json({ erro: 'Fornecedor não ativo.' });
    req.fornecedor = r.rows[0];
    req.usuario = decoded;
    next();
  } catch { res.status(401).json({ erro: 'Token inválido.' }); }
}

// Middleware de cliente autenticado (JWT normal)
function clubClienteMiddleware(req, res, next) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch { res.status(401).json({ erro: 'Token inválido.' }); }
}

// ── MARKETPLACE PÚBLICO ───────────────────────────────────

// GET /api/club/produtos — listar produtos aprovados
app.get('/api/club/produtos', async (req, res) => {
  try {
    const { categoria, busca, fornecedor_id } = req.query;
    let q = `
      SELECT p.*, f.nome_loja, f.nivel as fornecedor_nivel, f.logo_url as fornecedor_logo
      FROM club_produtos p
      JOIN club_fornecedores f ON f.id = p.fornecedor_id
      WHERE p.status='aprovado' AND f.status='ativo' AND p.estoque > 0
    `;
    const params = [];
    if (categoria) { params.push(categoria); q += ` AND p.categoria=$${params.length}`; }
    if (busca)     { params.push('%'+busca+'%'); q += ` AND p.nome ILIKE $${params.length}`; }
    if (fornecedor_id) { params.push(fornecedor_id); q += ` AND p.fornecedor_id=$${params.length}`; }
    q += ' ORDER BY f.nivel DESC, p.criado_em DESC LIMIT 100';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/fornecedores — listar fornecedores ativos
app.get('/api/club/fornecedores', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.id, f.nome_loja, f.descricao, f.nivel, f.logo_url, f.whatsapp, f.instagram,
             f.total_vendas, f.pedidos_ok, f.disputas,
             COUNT(p.id) as total_produtos
      FROM club_fornecedores f
      LEFT JOIN club_produtos p ON p.fornecedor_id=f.id AND p.status='aprovado'
      WHERE f.status='ativo'
      GROUP BY f.id ORDER BY f.nivel DESC, f.pedidos_ok DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/produto/:id
app.get('/api/club/produto/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, f.nome_loja, f.nivel as fornecedor_nivel, f.logo_url as fornecedor_logo,
             f.whatsapp as fornecedor_wpp, f.pedidos_ok, f.disputas
      FROM club_produtos p
      JOIN club_fornecedores f ON f.id = p.fornecedor_id
      WHERE p.id=$1 AND p.status='aprovado' AND f.status='ativo'
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Produto não encontrado.' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── CADASTRO DE FORNECEDOR ────────────────────────────────

// POST /api/club/fornecedor/cadastro
app.post('/api/club/fornecedor/cadastro', rateLimit(5, 60000), async (req, res) => {
  const { nome_loja, descricao, whatsapp, instagram, email, senha, nome } = req.body;
  if (!nome_loja || !email || !senha || !nome) return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios.' });
  try {
    // Criar ou encontrar usuário
    let usuario;
    const existente = await pool.query('SELECT id FROM pep_usuarios WHERE email=$1', [email]);
    if (existente.rows.length) {
      usuario = existente.rows[0];
    } else {
      const hash = await bcrypt.hash(senha, 10);
      const nr = await pool.query(
        'INSERT INTO pep_usuarios (nome,email,senha_hash) VALUES ($1,$2,$3) RETURNING id',
        [nome, email, hash]
      );
      usuario = nr.rows[0];
    }
    // Verificar se já tem fornecedor
    const jaForn = await pool.query('SELECT id,status FROM club_fornecedores WHERE usuario_id=$1', [usuario.id]);
    if (jaForn.rows.length) return res.status(400).json({ erro: 'Já existe um cadastro para este email. Status: ' + jaForn.rows[0].status });

    await pool.query(
      `INSERT INTO club_fornecedores (usuario_id,nome_loja,descricao,whatsapp,instagram,status)
       VALUES ($1,$2,$3,$4,$5,'pendente')`,
      [usuario.id, nome_loja, descricao||null, whatsapp||null, instagram||null]
    );
    // Notificar admin
    enviarWhatsApp(`🆕 Novo fornecedor Club: ${nome_loja} (${email}). Aguardando aprovação.`);
    res.json({ ok: true, msg: 'Cadastro enviado! Aguarde aprovação.' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/club/fornecedor/login
app.post('/api/club/fornecedor/login', rateLimit(10, 60000), async (req, res) => {
  const { email, senha } = req.body;
  try {
    const r = await pool.query('SELECT * FROM pep_usuarios WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    const u = r.rows[0];
    const ok = await bcrypt.compare(senha, u.senha_hash || '');
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    const forn = await pool.query('SELECT * FROM club_fornecedores WHERE usuario_id=$1', [u.id]);
    if (!forn.rows.length) return res.status(403).json({ erro: 'Nenhum cadastro de fornecedor encontrado.' });
    const f = forn.rows[0];
    const token = jwt.sign({ id: u.id, email: u.email, nome: u.nome }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, nome: u.nome, fornecedor: f });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── PAINEL DO FORNECEDOR ──────────────────────────────────

// GET /api/club/fornecedor/perfil
app.get('/api/club/fornecedor/perfil', clubFornecedorMiddleware, async (req, res) => {
  res.json(req.fornecedor);
});

// PUT /api/club/fornecedor/perfil
app.put('/api/club/fornecedor/perfil', clubFornecedorMiddleware, async (req, res) => {
  const { descricao, whatsapp, instagram } = req.body;
  try {
    await pool.query(
      'UPDATE club_fornecedores SET descricao=$1, whatsapp=$2, instagram=$3 WHERE id=$4',
      [descricao||null, whatsapp||null, instagram||null, req.fornecedor.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/fornecedor/dashboard
app.get('/api/club/fornecedor/dashboard', clubFornecedorMiddleware, async (req, res) => {
  try {
    const fid = req.fornecedor.id;
    const [pedidos, produtos, saldo] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) as total, SUM(total) as valor FROM club_pedidos WHERE fornecedor_id=$1 GROUP BY status`, [fid]),
      pool.query(`SELECT COUNT(*) as total FROM club_produtos WHERE fornecedor_id=$1 AND status='aprovado'`, [fid]),
      pool.query(`SELECT saldo FROM club_fornecedores WHERE id=$1`, [fid]),
    ]);
    res.json({
      fornecedor: req.fornecedor,
      pedidos_por_status: pedidos.rows,
      total_produtos: parseInt(produtos.rows[0]?.total || 0),
      saldo: parseFloat(saldo.rows[0]?.saldo || 0),
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── PRODUTOS DO FORNECEDOR ────────────────────────────────

// GET /api/club/fornecedor/produtos
app.get('/api/club/fornecedor/produtos', clubFornecedorMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM club_produtos WHERE fornecedor_id=$1 ORDER BY criado_em DESC', [req.fornecedor.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/club/fornecedor/produto
app.post('/api/club/fornecedor/produto', clubFornecedorMiddleware, async (req, res) => {
  const { nome, descricao, categoria, preco, estoque, imagem_url } = req.body;
  if (!nome || !preco) return res.status(400).json({ erro: 'Nome e preço são obrigatórios.' });
  try {
    const r = await pool.query(
      `INSERT INTO club_produtos (fornecedor_id,nome,descricao,categoria,preco,estoque,imagem_url,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente') RETURNING id`,
      [req.fornecedor.id, nome, descricao||null, categoria||null, preco, estoque||0, imagem_url||null]
    );
    enviarWhatsApp(`📦 Novo produto Club aguardando aprovação: "${nome}" — ${req.fornecedor.nome_loja}`);
    res.json({ ok: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/club/fornecedor/produto/:id
app.put('/api/club/fornecedor/produto/:id', clubFornecedorMiddleware, async (req, res) => {
  const { nome, descricao, categoria, preco, estoque, imagem_url } = req.body;
  try {
    await pool.query(
      `UPDATE club_produtos SET nome=$1,descricao=$2,categoria=$3,preco=$4,estoque=$5,imagem_url=$6,status='pendente'
       WHERE id=$7 AND fornecedor_id=$8`,
      [nome, descricao||null, categoria||null, preco, estoque||0, imagem_url||null, req.params.id, req.fornecedor.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /api/club/fornecedor/produto/:id
app.delete('/api/club/fornecedor/produto/:id', clubFornecedorMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM club_produtos WHERE id=$1 AND fornecedor_id=$2', [req.params.id, req.fornecedor.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── PEDIDOS DO FORNECEDOR ─────────────────────────────────

// GET /api/club/fornecedor/pedidos
app.get('/api/club/fornecedor/pedidos', clubFornecedorMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM club_pedidos WHERE fornecedor_id=$1 ORDER BY criado_em DESC LIMIT 100`,
      [req.fornecedor.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/club/fornecedor/pedido/:id/enviar — marcar como enviado
app.put('/api/club/fornecedor/pedido/:id/enviar', clubFornecedorMiddleware, async (req, res) => {
  const { codigo_rastreio } = req.body;
  try {
    const r = await pool.query(
      `UPDATE club_pedidos SET status='enviado', enviado_em=NOW(), codigo_rastreio=$1
       WHERE id=$2 AND fornecedor_id=$3 AND status='pago' RETURNING *`,
      [codigo_rastreio||null, req.params.id, req.fornecedor.id]
    );
    if (!r.rows.length) return res.status(400).json({ erro: 'Pedido não encontrado ou já enviado.' });
    const p = r.rows[0];
    await notificarPedidoClubEnviado(p);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/fornecedor/saldo
app.get('/api/club/fornecedor/saldo', clubFornecedorMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT saldo FROM club_fornecedores WHERE id=$1', [req.fornecedor.id]);
    res.json({ saldo: parseFloat(r.rows[0]?.saldo || 0) });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /api/club/fornecedor/saque
app.post('/api/club/fornecedor/saque', clubFornecedorMiddleware, async (req, res) => {
  const { valor, metodo, destino } = req.body;
  if (!valor || !metodo || !destino) return res.status(400).json({ erro: 'Informe valor, método e destino.' });
  try {
    const saldoR = await pool.query('SELECT saldo FROM club_fornecedores WHERE id=$1', [req.fornecedor.id]);
    const saldo = parseFloat(saldoR.rows[0]?.saldo || 0);
    if (parseFloat(valor) > saldo) return res.status(400).json({ erro: 'Saldo insuficiente.' });
    await pool.query('UPDATE club_fornecedores SET saldo=saldo-$1 WHERE id=$2', [valor, req.fornecedor.id]);
    await pool.query(
      'INSERT INTO club_saques (fornecedor_id,valor,metodo,destino,status) VALUES ($1,$2,$3,$4,$5)',
      [req.fornecedor.id, valor, metodo, destino, 'pendente']
    );
    enviarWhatsApp(`💸 Saque Club solicitado: R$ ${parseFloat(valor).toFixed(2)} — ${req.fornecedor.nome_loja} — ${metodo}: ${destino}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── COMPRA DO CLIENTE ─────────────────────────────────────

// POST /api/club/pedido — cliente cria pedido
app.post('/api/club/pedido', rateLimit(10, 60000), async (req, res) => {
  const { produto_id, quantidade, nome_cliente, email_cliente, telefone_cliente, endereco, pagamento, crypto_token } = req.body;
  if (!produto_id || !nome_cliente) return res.status(400).json({ erro: 'Dados incompletos.' });
  try {
    // Buscar produto
    const prodR = await pool.query(
      `SELECT p.*, f.id as fid, f.nome_loja, f.taxa_pct FROM club_produtos p
       JOIN club_fornecedores f ON f.id=p.fornecedor_id
       WHERE p.id=$1 AND p.status='aprovado' AND f.status='ativo'`, [produto_id]
    );
    if (!prodR.rows.length) return res.status(404).json({ erro: 'Produto não disponível.' });
    const prod = prodR.rows[0];
    const qtd = parseInt(quantidade) || 1;
    if (prod.estoque < qtd) return res.status(400).json({ erro: 'Estoque insuficiente.' });

    const total    = parseFloat((prod.preco * qtd).toFixed(2));
    const taxa     = parseFloat((total * prod.taxa_pct / 100).toFixed(2));
    const valForn  = parseFloat((total - taxa).toFixed(2));

    // Criar pedido
    const pedR = await pool.query(
      `INSERT INTO club_pedidos
         (fornecedor_id,produto_id,nome_cliente,email_cliente,telefone_cliente,endereco,
          produto_nome,quantidade,preco_unit,total,taxa,valor_fornecedor,pagamento,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'aguardando_pagamento') RETURNING id`,
      [prod.fid, produto_id, nome_cliente, email_cliente||null, telefone_cliente||null, endereco||null,
       prod.nome, qtd, prod.preco, total, taxa, valForn, pagamento||'pix']
    );
    const pedidoId = pedR.rows[0].id;

    // Reduzir estoque provisoriamente
    await pool.query('UPDATE club_produtos SET estoque=estoque-$1 WHERE id=$2', [qtd, produto_id]);

    let qrcode_url = null, copia_cola = null, nowpay_address = null, nowpay_amount = null, nowpay_currency = null;

    // PIX via PixGo
    if ((pagamento === 'pix' || !pagamento) && PIXGO_API_KEY) {
      try {
        const pixRes = await fetch('https://pixgo.org/api/v1/payment/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': PIXGO_API_KEY },
          body: JSON.stringify({
            amount: total,
            description: `PEPMASTERS Club #${pedidoId} — ${prod.nome}`,
            external_id: `club-${pedidoId}`,
            webhook_url: BASE_URL + '/webhook/club/pixgo'
          })
        });
        const pixData = await pixRes.json();
        if (pixData.success && pixData.data) {
          qrcode_url = pixData.data.qr_image_url || null;
          copia_cola = pixData.data.qr_code || null;
          const pixgoId = pixData.data.payment_id || pixData.data.id;
          await pool.query('UPDATE club_pedidos SET pixgo_id=$1, qrcode_url=$2, copia_cola=$3 WHERE id=$4',
            [pixgoId, qrcode_url, copia_cola, pedidoId]);
        }
      } catch(e) { console.error('[Club PIX]', e.message); }
    }

    // Cripto via NowPayments
    if (pagamento === 'cripto' && NOWPAYMENTS_API_KEY) {
      try {
        const moedaMap = { 'USDTTRX':'usdttrc20','USDCPOLYGON':'usdcmatic','USDTETH':'usdterc20','USDCETH':'usdcerc20','USDCSOLANA':'usdcsol' };
        const moeda = moedaMap[crypto_token] || 'usdttrc20';
        let totalUsd = total;
        try {
          const cambio = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
          const cj = await cambio.json();
          totalUsd = (total / (cj.rates?.BRL || 5.5)).toFixed(2);
        } catch {}
        const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
          method: 'POST',
          headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ price_amount: totalUsd, price_currency: 'usd', pay_currency: moeda,
            order_id: 'club-'+pedidoId, order_description: 'Club #'+pedidoId,
            ipn_callback_url: BASE_URL + '/webhook/club/nowpayments' })
        });
        const npData = await npRes.json();
        if (npData.pay_address) {
          nowpay_address = npData.pay_address;
          nowpay_amount  = npData.pay_amount;
          nowpay_currency = npData.pay_currency;
          await pool.query('UPDATE club_pedidos SET nowpay_id=$1,nowpay_address=$2,nowpay_amount=$3,crypto_token=$4 WHERE id=$5',
            [npData.payment_id, npData.pay_address, npData.pay_amount, crypto_token, pedidoId]);
        }
      } catch(e) { console.error('[Club Cripto]', e.message); }
    }

    enviarWhatsApp(`🛒 Novo pedido Club #${pedidoId} — ${prod.nome} — ${nome_cliente} — R$ ${total.toFixed(2).replace('.',',')}`);
    res.json({ ok: true, pedido_id: pedidoId, total, taxa, valor_fornecedor: valForn, qrcode_url, copia_cola, nowpay_address, nowpay_amount, nowpay_currency });
  } catch(e) { console.error('[Club pedido]', e.message); res.status(500).json({ erro: e.message }); }
});

// GET /api/club/pedido/:id/status
app.get('/api/club/pedido/:id/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM club_pedidos WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/meus-pedidos — pedidos do cliente logado
app.get('/api/club/meus-pedidos', clubClienteMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, f.nome_loja FROM club_pedidos p
       JOIN club_fornecedores f ON f.id=p.fornecedor_id
       WHERE p.usuario_id=$1 ORDER BY p.criado_em DESC`,
      [req.usuario.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/club/saldo — saldo do cliente
app.get('/api/club/saldo', clubClienteMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COALESCE(SUM(CASE WHEN tipo=\'credito\' THEN valor WHEN tipo=\'debito\' THEN -valor ELSE 0 END),0) as saldo FROM club_saldo_clientes WHERE usuario_id=$1',
      [req.usuario.id]
    );
    const hist = await pool.query('SELECT * FROM club_saldo_clientes WHERE usuario_id=$1 ORDER BY criado_em DESC LIMIT 20', [req.usuario.id]);
    res.json({ saldo: parseFloat(r.rows[0].saldo), historico: hist.rows });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── DISPUTAS ──────────────────────────────────────────────

// POST /api/club/disputa
app.post('/api/club/disputa', clubClienteMiddleware, async (req, res) => {
  const { pedido_id, motivo, descricao } = req.body;
  if (!pedido_id || !motivo) return res.status(400).json({ erro: 'Informe o pedido e o motivo.' });
  try {
    const pedR = await pool.query('SELECT * FROM club_pedidos WHERE id=$1', [pedido_id]);
    if (!pedR.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = pedR.rows[0];
    if (!['pago','enviado'].includes(p.status)) return res.status(400).json({ erro: 'Disputa só pode ser aberta para pedidos pagos ou enviados.' });

    await pool.query('UPDATE club_pedidos SET status=\'em_disputa\' WHERE id=$1', [pedido_id]);
    await pool.query(
      'INSERT INTO club_disputas (pedido_id,usuario_id,motivo,descricao,status) VALUES ($1,$2,$3,$4,\'aberta\')',
      [pedido_id, req.usuario.id, motivo, descricao||null]
    );
    enviarWhatsApp(`⚠️ Disputa Club aberta! Pedido #${pedido_id} — ${motivo} — Cliente: ${p.nome_cliente}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── WEBHOOKS DO CLUB ──────────────────────────────────────

// Webhook PIX Club
app.post('/webhook/club/pixgo', async (req, res) => {
  try {
    const { external_id, status, amount } = req.body;
    if (!external_id?.startsWith('club-')) return res.json({ ok: true });
    const pedidoId = parseInt(external_id.replace('club-', ''));
    if (status === 'paid' || status === 'completed') {
      const upd = await pool.query(`UPDATE club_pedidos SET status='pago' WHERE id=$1 AND status='aguardando_pagamento' RETURNING *`, [pedidoId]);
      if (upd.rows.length) await notificarPedidoClubPago(upd.rows[0]);
    }
    res.json({ ok: true });
  } catch(e) { console.error('[Club Webhook PIX]', e.message); res.json({ ok: true }); }
});

// Webhook NowPayments Club
app.post('/webhook/club/nowpayments', async (req, res) => {
  try {
    const data = req.body;
    const orderId = data.order_id || '';
    if (!orderId.startsWith('club-')) return res.json({ ok: true });
    const pedidoId = parseInt(orderId.replace('club-', ''));
    if (['finished','confirmed'].includes(data.payment_status)) {
      await pool.query('UPDATE club_pedidos SET status=\'pago\' WHERE id=$1 AND status=\'aguardando_pagamento\'', [pedidoId]);
      enviarWhatsApp(`✅ Club Cripto confirmado! Pedido #${pedidoId}`);
    }
    res.json({ ok: true });
  } catch(e) { console.error('[Club Webhook Cripto]', e.message); res.json({ ok: true }); }
});

// ── LIBERAÇÃO AUTOMÁTICA (job) ────────────────────────────
async function jobLiberacaoClub() {
  try {
    const prazo = new Date(Date.now() - CLUB_LIBERACAO_DIAS * 24 * 60 * 60 * 1000);
    const pedidos = await pool.query(
      `SELECT * FROM club_pedidos WHERE status='enviado' AND enviado_em < $1`, [prazo]
    );
    for (const p of pedidos.rows) {
      await pool.query(`UPDATE club_pedidos SET status='concluido', liberado_em=NOW() WHERE id=$1`, [p.id]);
      await pool.query(`UPDATE club_fornecedores SET saldo=saldo+$1, total_vendas=total_vendas+$2, pedidos_ok=pedidos_ok+1 WHERE id=$3`,
        [p.valor_fornecedor, p.total, p.fornecedor_id]);
      console.log(`[Club] Pedido #${p.id} liberado automaticamente — R$ ${p.valor_fornecedor}`);
    }
    if (pedidos.rows.length) enviarWhatsApp(`💰 Club: ${pedidos.rows.length} pedido(s) liberado(s) automaticamente.`);
  } catch(e) { console.error('[Club job liberação]', e.message); }
}

// ── ADMIN DO CLUB ─────────────────────────────────────────

// GET /api/admin/club/fornecedores
app.get('/api/admin/club/fornecedores', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.*, u.email, u.nome as usuario_nome,
             COUNT(p.id) as total_produtos,
             (SELECT COUNT(*) FROM club_pedidos cp WHERE cp.fornecedor_id=f.id) as total_pedidos
      FROM club_fornecedores f
      JOIN pep_usuarios u ON u.id=f.usuario_id
      LEFT JOIN club_produtos p ON p.fornecedor_id=f.id
      GROUP BY f.id, u.email, u.nome ORDER BY f.criado_em DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/admin/club/fornecedor/:id — aprovar/rejeitar/atualizar nível
app.put('/api/admin/club/fornecedor/:id', adminMiddleware, async (req, res) => {
  const { status, nivel, taxa_pct, mensalidade } = req.body;
  try {
    await pool.query(
      `UPDATE club_fornecedores SET
        status=COALESCE($1,status), nivel=COALESCE($2,nivel),
        taxa_pct=COALESCE($3,taxa_pct), mensalidade=COALESCE($4,mensalidade)
       WHERE id=$5`,
      [status||null, nivel||null, taxa_pct||null, mensalidade||null, req.params.id]
    );
    // Notificar fornecedor se aprovado
    if (status === 'ativo') {
      const f = await pool.query('SELECT f.*, u.email, u.nome FROM club_fornecedores f JOIN pep_usuarios u ON u.id=f.usuario_id WHERE f.id=$1', [req.params.id]);
      if (f.rows.length) {
        enviarEmail(f.rows[0].email, '✅ Cadastro aprovado — PEPMASTERS Club',
          `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#FFB300">✅ Bem-vindo ao PEPMASTERS Club!</h2>
            <p>Olá, ${f.rows[0].nome.split(' ')[0]}!</p>
            <p>Seu cadastro como fornecedor foi aprovado. Acesse o painel para cadastrar seus produtos:</p>
            <a href="${BASE_URL}/club/fornecedor-painel.html" style="padding:12px 28px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px;display:inline-block;margin-top:12px">Acessar Painel →</a>
          </div>`
        ).catch(()=>{});
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/admin/club/produtos — aprovar produtos
app.get('/api/admin/club/produtos', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, f.nome_loja FROM club_produtos p
      JOIN club_fornecedores f ON f.id=p.fornecedor_id
      ORDER BY p.criado_em DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/admin/club/produto/:id
app.put('/api/admin/club/produto/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query('UPDATE club_produtos SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/admin/club/pedidos
app.get('/api/admin/club/pedidos', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, f.nome_loja FROM club_pedidos p
      JOIN club_fornecedores f ON f.id=p.fornecedor_id
      ORDER BY p.criado_em DESC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/admin/club/disputas
app.get('/api/admin/club/disputas', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.*, p.produto_nome, p.total, p.valor_fornecedor, p.nome_cliente, f.nome_loja
      FROM club_disputas d
      JOIN club_pedidos p ON p.id=d.pedido_id
      JOIN club_fornecedores f ON f.id=p.fornecedor_id
      WHERE d.status='aberta' ORDER BY d.criado_em DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/admin/club/disputa/:id — resolver disputa
app.put('/api/admin/club/disputa/:id', adminMiddleware, async (req, res) => {
  const { resolucao, favoravel_cliente } = req.body; // favoravel_cliente: true = estorna, false = libera fornecedor
  try {
    const d = (await pool.query('SELECT * FROM club_disputas WHERE id=$1', [req.params.id])).rows[0];
    if (!d) return res.status(404).json({ erro: 'Disputa não encontrada.' });
    const p = (await pool.query('SELECT * FROM club_pedidos WHERE id=$1', [d.pedido_id])).rows[0];

    if (favoravel_cliente) {
      // Estornar — creditar saldo do cliente
      await pool.query('UPDATE club_pedidos SET status=\'estornado\' WHERE id=$1', [p.id]);
      if (p.usuario_id) {
        await pool.query(
          'INSERT INTO club_saldo_clientes (usuario_id,tipo,valor,descricao,pedido_id) VALUES ($1,\'credito\',$2,$3,$4)',
          [p.usuario_id, p.total, `Estorno pedido #${p.id}`, p.id]
        );
      }
      // Devolver estoque
      await pool.query('UPDATE club_produtos SET estoque=estoque+$1 WHERE id=$2', [p.quantidade, p.produto_id]);
    } else {
      // Liberar para fornecedor
      await pool.query('UPDATE club_pedidos SET status=\'concluido\', liberado_em=NOW() WHERE id=$1', [p.id]);
      await pool.query('UPDATE club_fornecedores SET saldo=saldo+$1, total_vendas=total_vendas+$2, pedidos_ok=pedidos_ok+1 WHERE id=$3',
        [p.valor_fornecedor, p.total, p.fornecedor_id]);
    }

    await pool.query(
      'UPDATE club_disputas SET status=\'resolvida\', resolucao=$1, resolvido_por=\'admin\', resolvido_em=NOW() WHERE id=$2',
      [resolucao||null, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// GET /api/admin/club/saques
app.get('/api/admin/club/saques', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, f.nome_loja FROM club_saques s
      JOIN club_fornecedores f ON f.id=s.fornecedor_id
      WHERE s.status='pendente' ORDER BY s.criado_em DESC`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PUT /api/admin/club/saque/:id
app.put('/api/admin/club/saque/:id', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query('UPDATE club_saques SET status=$1, processado_em=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});


// ── ENDPOINT PÚBLICO: fornecedor por ID ──────────────────
app.get('/api/club/fornecedor/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.id, f.nome_loja, f.descricao, f.nivel, f.logo_url, f.whatsapp, f.instagram,
             f.total_vendas, f.pedidos_ok, f.disputas, f.nota_media, f.total_avaliacoes,
             COUNT(p.id) as total_produtos
      FROM club_fornecedores f
      LEFT JOIN club_produtos p ON p.fornecedor_id=f.id AND p.status='aprovado'
      WHERE f.id=$1 AND f.status='ativo'
      GROUP BY f.id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── NOTIFICAÇÕES CLUB ─────────────────────────────────────
async function notificarPedidoClubPago(pedido) {
  try {
    enviarWhatsApp(`✅ Club PIX confirmado! Pedido #${pedido.id} — ${pedido.produto_nome} — ${pedido.nome_cliente} — R$ ${parseFloat(pedido.total).toFixed(2).replace('.',',')}`);
    if (pedido.email_cliente) {
      enviarEmail(pedido.email_cliente, `✅ Pagamento confirmado — Club #${pedido.id}`,
        `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#FFB300">✅ Pagamento confirmado!</h2>
          <p>Olá, <strong>${(pedido.nome_cliente||'cliente').split(' ')[0]}</strong>!</p>
          <p>Pedido <strong>#${pedido.id}</strong> — ${pedido.produto_nome}<br>Total: R$ ${parseFloat(pedido.total).toFixed(2).replace('.',',')}</p>
          <p>O fornecedor foi notificado e enviará em breve.</p>
        </div>`).catch(()=>{});
    }
    const fornR = await pool.query(`SELECT f.*, u.email FROM club_fornecedores f JOIN pep_usuarios u ON u.id=f.usuario_id WHERE f.id=$1`, [pedido.fornecedor_id]);
    if (fornR.rows.length) {
      enviarEmail(fornR.rows[0].email, `🛒 Novo pedido Club #${pedido.id}`,
        `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#FFB300">🛒 Novo pedido!</h2>
          <p><strong>Pedido:</strong> #${pedido.id}<br><strong>Produto:</strong> ${pedido.produto_nome}<br>
          <strong>Cliente:</strong> ${pedido.nome_cliente}<br><strong>Endereço:</strong> ${pedido.endereco||'—'}<br>
          <strong>Repasse:</strong> R$ ${parseFloat(pedido.valor_fornecedor||0).toFixed(2).replace('.',',')}</p>
          <a href="${BASE_URL}/club-fornecedor-painel.html" style="padding:11px 24px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px;display:inline-block;font-weight:700">Acessar Painel →</a>
        </div>`).catch(()=>{});
    }
  } catch(e) { console.error('[Club notif pago]', e.message); }
}

async function notificarPedidoClubEnviado(pedido) {
  try {
    enviarWhatsApp(`📦 Club enviado! Pedido #${pedido.id} — ${pedido.nome_cliente}${pedido.codigo_rastreio?' — '+pedido.codigo_rastreio:''}`);
    if (pedido.email_cliente) {
      enviarEmail(pedido.email_cliente, `📦 Pedido Club #${pedido.id} enviado!`,
        `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#FFB300">📦 Pedido enviado!</h2>
          <p>Olá, <strong>${(pedido.nome_cliente||'cliente').split(' ')[0]}</strong>!</p>
          <p>Pedido <strong>#${pedido.id}</strong> — ${pedido.produto_nome} foi enviado.</p>
          ${pedido.codigo_rastreio?`<p>Rastreio: <strong>${pedido.codigo_rastreio}</strong></p>`:''}
          <p>⏳ Pagamento liberado em 5 dias sem disputa.</p>
          <p>Após receber, avalie em <a href="${BASE_URL}/club-meus-pedidos.html">Meus Pedidos</a>. ⭐</p>
        </div>`).catch(()=>{});
    }
  } catch(e) { console.error('[Club notif enviado]', e.message); }
}

// ── AVALIAÇÕES ────────────────────────────────────────────
app.post('/api/club/avaliacao', clubClienteMiddleware, async (req, res) => {
  const { pedido_id, nota, comentario } = req.body;
  if (!pedido_id || !nota || nota<1 || nota>5) return res.status(400).json({ erro: 'Dados inválidos.' });
  try {
    const pedR = await pool.query(`SELECT * FROM club_pedidos WHERE id=$1 AND usuario_id=$2`, [pedido_id, req.usuario.id]);
    if (!pedR.rows.length) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const p = pedR.rows[0];
    if (!['enviado','concluido'].includes(p.status)) return res.status(400).json({ erro: 'Só é possível avaliar pedidos enviados ou concluídos.' });
    if (p.avaliado) return res.status(400).json({ erro: 'Pedido já avaliado.' });
    await pool.query(`INSERT INTO club_avaliacoes (pedido_id,fornecedor_id,usuario_id,nota,comentario) VALUES ($1,$2,$3,$4,$5)`,
      [pedido_id, p.fornecedor_id, req.usuario.id, nota, comentario||null]);
    await pool.query(`UPDATE club_pedidos SET avaliado=TRUE WHERE id=$1`, [pedido_id]);
    const mediaR = await pool.query(`SELECT AVG(nota)::NUMERIC(3,2) as media, COUNT(*) as total FROM club_avaliacoes WHERE fornecedor_id=$1`, [p.fornecedor_id]);
    await pool.query(`UPDATE club_fornecedores SET nota_media=$1, total_avaliacoes=$2 WHERE id=$3`, [mediaR.rows[0].media, mediaR.rows[0].total, p.fornecedor_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/club/avaliacoes/:fornecedor_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.nota, a.comentario, a.criado_em, a.resposta, u.nome as cliente_nome
       FROM club_avaliacoes a LEFT JOIN pep_usuarios u ON u.id=a.usuario_id
       WHERE a.fornecedor_id=$1 ORDER BY a.criado_em DESC LIMIT 50`, [req.params.fornecedor_id]);
    const mediaR = await pool.query(`SELECT AVG(nota)::NUMERIC(3,2) as media, COUNT(*) as total FROM club_avaliacoes WHERE fornecedor_id=$1`, [req.params.fornecedor_id]);
    res.json({ avaliacoes: r.rows, media: mediaR.rows[0].media||0, total: mediaR.rows[0].total||0 });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/club/fornecedor/avaliacoes', clubFornecedorMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.*, u.nome as cliente_nome, p.produto_nome
       FROM club_avaliacoes a LEFT JOIN pep_usuarios u ON u.id=a.usuario_id LEFT JOIN club_pedidos p ON p.id=a.pedido_id
       WHERE a.fornecedor_id=$1 ORDER BY a.criado_em DESC`, [req.fornecedor.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/club/fornecedor/avaliacao/:id/responder', clubFornecedorMiddleware, async (req, res) => {
  const { resposta } = req.body;
  if (!resposta) return res.status(400).json({ erro: 'Informe a resposta.' });
  try {
    await pool.query(`UPDATE club_avaliacoes SET resposta=$1 WHERE id=$2 AND fornecedor_id=$3`, [resposta, req.params.id, req.fornecedor.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── CHAT DO CLUB ──────────────────────────────────────────
app.post('/api/club/chat', clubClienteMiddleware, async (req, res) => {
  const { fornecedor_id, pedido_id, assunto } = req.body;
  if (!fornecedor_id) return res.status(400).json({ erro: 'fornecedor_id obrigatório.' });
  try {
    const exist = await pool.query(
      `SELECT id FROM club_chats WHERE usuario_id=$1 AND fornecedor_id=$2 ${pedido_id?'AND pedido_id=$3':'AND pedido_id IS NULL'} AND status='aberto' LIMIT 1`,
      pedido_id ? [req.usuario.id, fornecedor_id, pedido_id] : [req.usuario.id, fornecedor_id]
    );
    if (exist.rows.length) return res.json({ chat_id: exist.rows[0].id, existente: true });
    const r = await pool.query(
      `INSERT INTO club_chats (fornecedor_id, usuario_id, pedido_id, assunto) VALUES ($1,$2,$3,$4) RETURNING id`,
      [fornecedor_id, req.usuario.id, pedido_id||null, assunto||null]
    );
    res.json({ chat_id: r.rows[0].id, existente: false });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/club/chat/fornecedor', clubFornecedorMiddleware, async (req, res) => {
  const { usuario_id, pedido_id, assunto } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatório.' });
  try {
    const exist = await pool.query(
      `SELECT id FROM club_chats WHERE usuario_id=$1 AND fornecedor_id=$2 ${pedido_id?'AND pedido_id=$3':'AND pedido_id IS NULL'} AND status='aberto' LIMIT 1`,
      pedido_id ? [usuario_id, req.fornecedor.id, pedido_id] : [usuario_id, req.fornecedor.id]
    );
    if (exist.rows.length) return res.json({ chat_id: exist.rows[0].id, existente: true });
    const r = await pool.query(
      `INSERT INTO club_chats (fornecedor_id, usuario_id, pedido_id, assunto) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.fornecedor.id, usuario_id, pedido_id||null, assunto||null]
    );
    res.json({ chat_id: r.rows[0].id, existente: false });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/club/chats', clubClienteMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, f.nome_loja,
        (SELECT COUNT(*) FROM club_mensagens m WHERE m.chat_id=c.id AND m.lida=FALSE AND m.remetente='fornecedor') as nao_lidas,
        (SELECT texto FROM club_mensagens m WHERE m.chat_id=c.id ORDER BY m.criado_em DESC LIMIT 1) as ultima_msg
      FROM club_chats c JOIN club_fornecedores f ON f.id=c.fornecedor_id
      WHERE c.usuario_id=$1 ORDER BY c.ultima_msg_em DESC`, [req.usuario.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/club/fornecedor/chats', clubFornecedorMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, u.nome as cliente_nome, u.email as cliente_email,
        (SELECT COUNT(*) FROM club_mensagens m WHERE m.chat_id=c.id AND m.lida=FALSE AND m.remetente='cliente') as nao_lidas,
        (SELECT texto FROM club_mensagens m WHERE m.chat_id=c.id ORDER BY m.criado_em DESC LIMIT 1) as ultima_msg
      FROM club_chats c JOIN pep_usuarios u ON u.id=c.usuario_id
      WHERE c.fornecedor_id=$1 ORDER BY c.ultima_msg_em DESC`, [req.fornecedor.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/club/chat/:id/mensagens', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM club_mensagens WHERE chat_id=$1 ORDER BY criado_em ASC`, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/club/chat/:id/mensagem', clubClienteMiddleware, async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ erro: 'Mensagem vazia.' });
  try {
    const chat = await pool.query('SELECT * FROM club_chats WHERE id=$1 AND usuario_id=$2', [req.params.id, req.usuario.id]);
    if (!chat.rows.length) return res.status(403).json({ erro: 'Chat não encontrado.' });
    const c = chat.rows[0];
    await pool.query(`INSERT INTO club_mensagens (chat_id,remetente,remetente_id,remetente_nome,texto) VALUES ($1,'cliente',$2,$3,$4)`,
      [req.params.id, req.usuario.id, req.usuario.nome, texto.trim()]);
    await pool.query(`UPDATE club_chats SET ultima_msg_em=NOW() WHERE id=$1`, [req.params.id]);
    const fornR = await pool.query(`SELECT f.*, u.email FROM club_fornecedores f JOIN pep_usuarios u ON u.id=f.usuario_id WHERE f.id=$1`, [c.fornecedor_id]);
    if (fornR.rows.length) {
      enviarEmail(fornR.rows[0].email, `💬 Nova mensagem — ${req.usuario.nome}`,
        `<div style="font-family:sans-serif;padding:24px"><h2 style="color:#FFB300">💬 Nova mensagem</h2>
        <p><strong>${req.usuario.nome}</strong> enviou:</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:14px;margin:12px 0">"${texto.trim()}"</div>
        <a href="${BASE_URL}/club-fornecedor-painel.html" style="padding:11px 24px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px;display:inline-block;font-weight:700">Ver conversa →</a>
        </div>`).catch(()=>{});
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/club/chat/:id/mensagem/fornecedor', clubFornecedorMiddleware, async (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ erro: 'Mensagem vazia.' });
  try {
    const chat = await pool.query('SELECT * FROM club_chats WHERE id=$1 AND fornecedor_id=$2', [req.params.id, req.fornecedor.id]);
    if (!chat.rows.length) return res.status(403).json({ erro: 'Chat não encontrado.' });
    const c = chat.rows[0];
    await pool.query(`INSERT INTO club_mensagens (chat_id,remetente,remetente_id,remetente_nome,texto) VALUES ($1,'fornecedor',$2,$3,$4)`,
      [req.params.id, req.fornecedor.id, req.fornecedor.nome_loja, texto.trim()]);
    await pool.query(`UPDATE club_chats SET ultima_msg_em=NOW() WHERE id=$1`, [req.params.id]);
    if (c.usuario_id) {
      const uR = await pool.query('SELECT email, nome FROM pep_usuarios WHERE id=$1', [c.usuario_id]);
      if (uR.rows.length) {
        enviarEmail(uR.rows[0].email, `💬 Nova mensagem de ${req.fornecedor.nome_loja}`,
          `<div style="font-family:sans-serif;padding:24px"><h2 style="color:#FFB300">💬 Nova mensagem</h2>
          <p><strong>${req.fornecedor.nome_loja}</strong> enviou:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:14px;margin:12px 0">"${texto.trim()}"</div>
          <a href="${BASE_URL}/club-meus-pedidos.html" style="padding:11px 24px;background:linear-gradient(135deg,#E8220A,#FF6B00);color:#fff;text-decoration:none;border-radius:10px;display:inline-block;font-weight:700">Ver conversa →</a>
          </div>`).catch(()=>{});
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/club/chat/:id/lida', async (req, res) => {
  const { remetente } = req.body;
  try {
    await pool.query(`UPDATE club_mensagens SET lida=TRUE WHERE chat_id=$1 AND remetente=$2`, [req.params.id, remetente]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/club/chats', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, f.nome_loja, u.nome as cliente_nome, u.email as cliente_email,
        (SELECT COUNT(*) FROM club_mensagens m WHERE m.chat_id=c.id) as total_msgs
      FROM club_chats c JOIN club_fornecedores f ON f.id=c.fornecedor_id
      LEFT JOIN pep_usuarios u ON u.id=c.usuario_id
      ORDER BY c.ultima_msg_em DESC LIMIT 200`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
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
// Subir servidor imediatamente, inicializar banco em seguida
app.listen(PORT, () => {
  console.log('[PEPMASTERS] Servidor rodando na porta ' + PORT);

  async function tentarInitDB(tentativa) {
    try {
      await initDB();
      console.log('[PEPMASTERS] Banco inicializado com sucesso.');
      setTimeout(jobDiario, 5000);
      setInterval(jobDiario, 24 * 60 * 60 * 1000);
      // Job de liberação do Club — roda a cada hora
      setInterval(jobLiberacaoClub, 60 * 60 * 1000);
      setTimeout(jobLiberacaoClub, 10000);
    } catch (err) {
      console.error('[PEPMASTERS] Falha ao inicializar banco (tentativa ' + tentativa + '):', err.message);
      if (tentativa < 5) {
        setTimeout(() => tentarInitDB(tentativa + 1), 10000);
      } else {
        console.error('[PEPMASTERS] Banco não disponível após 5 tentativas. Continuando sem init.');
      }
    }
  }

  tentarInitDB(1);
});
