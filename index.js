// index.js
// Discord Draft Store Bot (discord.js v14 + Postgres)
// Safe generic store template
// Includes:
// - shop
// - verification system
// - stock control
// - discount codes
// - order handling
// - catalog management
// - moderation panel

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");

const { Pool } = require("pg");

/* ----------------------------- ENV / CONFIG ----------------------------- */

const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const GUILD_ID = process.env.GUILD_ID;
const MENU_CHANNEL_ID = process.env.MENU_CHANNEL_ID;
const ORDERS_CATEGORY_ID = process.env.ORDERS_CATEGORY_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;

const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const VERIFICATION_LOG_CHANNEL_ID = process.env.VERIFICATION_LOG_CHANNEL_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;
const STAFF_ONLY_CHANNEL_ID = process.env.STAFF_ONLY_CHANNEL_ID;

const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME || "YOUR COMPANY LTD";
const BANK_SORT_CODE = process.env.BANK_SORT_CODE || "00-00-00";
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER || "00000000";
const BANK_BANK_NAME = process.env.BANK_BANK_NAME || "YOUR BANK";
const BANK_IBAN = process.env.BANK_IBAN || "";
const BANK_SWIFT = process.env.BANK_SWIFT || "";

const STORE_NAME = process.env.STORE_NAME || "Draft Store";
const DEFAULT_SIZE = "Standard";
const DEFAULT_COLOR = "Standard";

const WELCOME_CODE = process.env.WELCOME_CODE || "WELCOME10";
const WELCOME_DISCOUNT_PERCENT = Number(process.env.WELCOME_DISCOUNT_PERCENT || 10);

const SHIPPING_UK_PENCE = Number(process.env.SHIPPING_UK_PENCE || 1000);
const SHIPPING_EU_PENCE = Number(process.env.SHIPPING_EU_PENCE || 3500);
const SHIPPING_USA_PENCE = Number(process.env.SHIPPING_USA_PENCE || 4500);

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

requireEnv("DISCORD_TOKEN or BOT_TOKEN", TOKEN);
requireEnv("CLIENT_ID", CLIENT_ID);
requireEnv("DATABASE_URL", DATABASE_URL);
requireEnv("GUILD_ID", GUILD_ID);
requireEnv("MENU_CHANNEL_ID", MENU_CHANNEL_ID);
requireEnv("ORDERS_CATEGORY_ID", ORDERS_CATEGORY_ID);
requireEnv("STAFF_ROLE_ID", STAFF_ROLE_ID);
requireEnv("VERIFY_CHANNEL_ID", VERIFY_CHANNEL_ID);
requireEnv("VERIFICATION_LOG_CHANNEL_ID", VERIFICATION_LOG_CHANNEL_ID);
requireEnv("VERIFIED_ROLE_ID", VERIFIED_ROLE_ID);
requireEnv("STAFF_ONLY_CHANNEL_ID", STAFF_ONLY_CHANNEL_ID);

/* ------------------------------- DATABASE ------------------------------- */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

/* ------------------------------ SEED DATA ------------------------------- */

const SAFE_SEED_CATALOG = {
  "Featured Items": [
    { sku: "DRF001", name: "Branded Hoodie", price_pence: 3999, stock_qty: 10 },
    { sku: "DRF002", name: "Logo T Shirt", price_pence: 2499, stock_qty: 20 },
    { sku: "DRF003", name: "Starter Bundle", price_pence: 5499, stock_qty: 8 },
  ],
  Accessories: [
    { sku: "ACC001", name: "Sticker Pack", price_pence: 499, stock_qty: 50 },
    { sku: "ACC002", name: "Keyring", price_pence: 799, stock_qty: 30 },
    { sku: "ACC003", name: "Tote Bag", price_pence: 1299, stock_qty: 20 },
  ],
  "Digital Products": [
    { sku: "DIG001", name: "Members Guide PDF", price_pence: 999, stock_qty: 9999 },
    { sku: "DIG002", name: "Template Pack", price_pence: 1499, stock_qty: 9999 },
  ],
};

const SUBMIT_LOCKS = new Map();
const SUBMIT_LOCK_MS = 15000;

const CART_UI_MESSAGES = new Map();
const SHOP_SESSION_CHANNELS = new Map();
const SHOP_SESSION_TIMEOUTS = new Map();
const SHOP_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

/* ------------------------------- HELPERS -------------------------------- */

function money(pence) {
  return `£${(Number(pence || 0) / 100).toFixed(2)}`;
}

function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function isStaffChannel(interaction) {
  return interaction.channelId === STAFF_ONLY_CHANNEL_ID;
}

function safeChannelName(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

function normalizeDiscountCode(code) {
  return String(code || "").trim().toUpperCase();
}

function calculateDiscountedTotals(subtotal, shipping, discountPercent) {
  const safePercent = Math.max(0, Math.min(100, Number(discountPercent || 0)));
  const discountAmount = Math.round(Number(subtotal || 0) * (safePercent / 100));
  const total = Number(subtotal || 0) - discountAmount + Number(shipping || 0);

  return {
    discountPercent: safePercent,
    discountAmount,
    total,
  };
}

function isSubmitLocked(userId) {
  const expiresAt = SUBMIT_LOCKS.get(userId);
  return expiresAt && expiresAt > Date.now();
}

function setSubmitLock(userId) {
  SUBMIT_LOCKS.set(userId, Date.now() + SUBMIT_LOCK_MS);
}

function clearSubmitLock(userId) {
  SUBMIT_LOCKS.delete(userId);
}

function getShippingPenceForCountry(countryRaw) {
  const c = String(countryRaw || "").trim().toLowerCase();
  if (!c) return SHIPPING_EU_PENCE;

  const isUK =
    c.includes("uk") ||
    c.includes("united kingdom") ||
    c.includes("great britain") ||
    c === "gb" ||
    c.includes("england") ||
    c.includes("scotland") ||
    c.includes("wales") ||
    c.includes("northern ireland");

  if (isUK) return SHIPPING_UK_PENCE;

  const isUSA =
    c.includes("usa") ||
    c === "us" ||
    c.includes("united states") ||
    c.includes("america");

  if (isUSA) return SHIPPING_USA_PENCE;

  return SHIPPING_EU_PENCE;
}

function truncate100(str) {
  return String(str || "").slice(0, 100);
}

function parsePriceToPence(input) {
  const cleaned = String(input || "").trim().replace(/£/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function bankDetailsText(orderId) {
  const ref = `ORDER-${orderId}`;
  const extras = [
    BANK_IBAN ? `IBAN: ${BANK_IBAN}` : null,
    BANK_SWIFT ? `SWIFT/BIC: ${BANK_SWIFT}` : null,
  ].filter(Boolean);

  return (
    `**Bank:** ${BANK_BANK_NAME}\n` +
    `**Account Name:** ${BANK_ACCOUNT_NAME}\n` +
    `**Sort Code:** ${BANK_SORT_CODE}\n` +
    `**Account Number:** ${BANK_ACCOUNT_NUMBER}\n` +
    (extras.length ? `${extras.join("\n")}\n` : "") +
    `\n**Reference:** \`${ref}\``
  );
}

function staffActionRow(...buttons) {
  return new ActionRowBuilder().addComponents(...buttons);
}

function shopItemDescription(item) {
  if (item.stock_qty <= 0) return truncate100(`${money(item.price_pence)} • Out of stock`);
  return truncate100(`${money(item.price_pence)} • Stock ${item.stock_qty}`);
}

function staffStandardEmbed(title, lines = []) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setColor(0x2b2d31);
}

function staffHomeNavRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("staff_nav_orders")
      .setLabel("Orders")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("staff_nav_catalog")
      .setLabel("Catalog")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("staff_nav_discounts")
      .setLabel("Discounts")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("staff_nav_moderation")
      .setLabel("Moderation")
      .setStyle(ButtonStyle.Danger)
  );
}

function staffBackHomeRow(backId, backLabel = "Back") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(backId)
      .setLabel(backLabel)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("staff_panel_home")
      .setLabel("Home")
      .setStyle(ButtonStyle.Secondary)
  );
}

function shopCategoryColor() {
  return ButtonStyle.Success;
}

function orderCategoryColor() {
  return ButtonStyle.Primary;
}

function discountCategoryColor() {
  return ButtonStyle.Secondary;
}

function moderationCategoryColor() {
  return ButtonStyle.Danger;
}

/* ------------------------- MODERATION HELPERS -------------------------- */

function hasModPermission(member, permission) {
  return member?.permissions?.has(permission);
}

function memberSearchMatches(member, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return false;

  const username = String(member.user?.username || "").toLowerCase();
  const displayName = String(member.displayName || "").toLowerCase();
  const globalName = String(member.user?.globalName || "").toLowerCase();
  const userId = String(member.id || "");

  return (
    username.includes(needle) ||
    displayName.includes(needle) ||
    globalName.includes(needle) ||
    userId.includes(needle)
  );
}

async function searchGuildMembers(guild, search, options = {}) {
  const {
    verifiedOnly = false,
    excludeVerified = false,
  } = options;

  await guild.members.fetch();

  return guild.members.cache
    .filter((member) => {
      if (!member || member.user?.bot) return false;

      const isVerified = member.roles.cache.has(VERIFIED_ROLE_ID);

      if (verifiedOnly && !isVerified) return false;
      if (excludeVerified && isVerified) return false;

      return memberSearchMatches(member, search);
    })
    .first(25);
}

function memberSelectOptions(members) {
  return members.map((member) => ({
    label: truncate100(member.displayName || member.user.username),
    description: truncate100(`@${member.user.username} • ${member.id}`),
    value: member.id,
  }));
}

async function ensureTargetMember(guild, userId) {
  return guild.members.fetch(userId).catch(() => null);
}

function canActOnTarget(staffMember, targetMember) {
  if (!staffMember || !targetMember) {
    return { ok: false, reason: "Could not resolve that member." };
  }

  if (staffMember.id === targetMember.id) {
    return { ok: false, reason: "You cannot perform this action on yourself." };
  }

  const me = staffMember.guild.members.me;
  if (!me) {
    return { ok: false, reason: "Bot member not found." };
  }

  if (targetMember.id === me.id) {
    return { ok: false, reason: "You cannot moderate the bot." };
  }

  if (staffMember.id !== staffMember.guild.ownerId) {
    if (targetMember.roles.highest.position >= staffMember.roles.highest.position) {
      return { ok: false, reason: "You cannot act on a member with an equal or higher role." };
    }
  }

  if (targetMember.roles.highest.position >= me.roles.highest.position) {
    return { ok: false, reason: "My role is not high enough to act on that member." };
  }

  return { ok: true };
}

function timeoutMsFromMinutes(minutes) {
  const mins = Number(minutes || 0);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  return mins * 60 * 1000;
}

/* ------------------------------- INIT DB -------------------------------- */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_profiles (
      user_id TEXT PRIMARY KEY REFERENCES user_profiles(user_id) ON DELETE CASCADE,
      full_address TEXT,
      country TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      category_id BIGSERIAL PRIMARY KEY,
      category_name TEXT NOT NULL UNIQUE,
      sort_order INT NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      product_id BIGSERIAL PRIMARY KEY,
      category_id BIGINT NOT NULL REFERENCES categories(category_id) ON DELETE CASCADE,
      sku TEXT NOT NULL UNIQUE,
      product_name TEXT NOT NULL,
      price_pence INT NOT NULL CHECK (price_pence >= 0),
      default_stock_qty INT NOT NULL DEFAULT 0 CHECK (default_stock_qty >= 0),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      sku TEXT PRIMARY KEY,
      stock_qty INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS carts (
      cart_id BIGSERIAL PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      discount_code TEXT,
      discount_percent INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id BIGSERIAL PRIMARY KEY,
      cart_id BIGINT NOT NULL REFERENCES carts(cart_id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      size TEXT NOT NULL,
      color TEXT NOT NULL,
      qty INT NOT NULL CHECK (qty > 0),
      price_pence INT NOT NULL CHECK (price_pence >= 0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      full_address TEXT,
      country TEXT,
      subtotal_pence INT NOT NULL,
      shipping_pence INT NOT NULL,
      total_pence INT NOT NULL,
      discount_code TEXT,
      discount_percent INT NOT NULL DEFAULT 0,
      discount_amount_pence INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      receipt_channel_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      size TEXT NOT NULL,
      color TEXT NOT NULL,
      qty INT NOT NULL CHECK (qty > 0),
      price_pence INT NOT NULL CHECK (price_pence >= 0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_codes (
      code TEXT PRIMARY KEY,
      discount_percent INT NOT NULL CHECK (discount_percent >= 0 AND discount_percent <= 100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      one_use_per_user BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discount_code_uses (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      order_id BIGINT,
      used_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (code, user_id)
    );
  `);

  await pool.query(
    `
    INSERT INTO discount_codes (code, discount_percent, is_active, one_use_per_user, created_at, updated_at)
    VALUES ($1, $2, TRUE, TRUE, NOW(), NOW())
    ON CONFLICT (code) DO NOTHING
    `,
    [normalizeDiscountCode(WELCOME_CODE), WELCOME_DISCOUNT_PERCENT]
  );

  const categoryCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM categories`);
  const categoryCount = Number(categoryCountRes.rows[0]?.count || 0);

  if (categoryCount === 0) {
    let sort = 1;

    for (const [categoryName, items] of Object.entries(SAFE_SEED_CATALOG)) {
      const catRes = await pool.query(
        `
        INSERT INTO categories (category_name, sort_order, is_active, created_at, updated_at)
        VALUES ($1, $2, TRUE, NOW(), NOW())
        RETURNING category_id
        `,
        [categoryName, sort]
      );

      const categoryId = catRes.rows[0].category_id;
      sort += 1;

      for (const item of items) {
        await pool.query(
          `
          INSERT INTO products (category_id, sku, product_name, price_pence, default_stock_qty, is_active, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
          `,
          [categoryId, item.sku, item.name, item.price_pence, item.stock_qty]
        );

        await pool.query(
          `
          INSERT INTO stock_items (sku, stock_qty, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (sku) DO NOTHING
          `,
          [item.sku, item.stock_qty]
        );
      }
    }
  } else {
    const missingStockRes = await pool.query(`
      SELECT p.sku, p.default_stock_qty
      FROM products p
      LEFT JOIN stock_items s ON s.sku = p.sku
      WHERE s.sku IS NULL
    `);

    for (const row of missingStockRes.rows) {
      await pool.query(
        `
        INSERT INTO stock_items (sku, stock_qty, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (sku) DO NOTHING
        `,
        [row.sku, row.default_stock_qty]
      );
    }
  }
}

/* --------------------------- CATEGORY / PRODUCT -------------------------- */

async function getCategories() {
  const res = await pool.query(`
    SELECT category_id, category_name
    FROM categories
    WHERE is_active = TRUE
    ORDER BY sort_order ASC, category_name ASC
  `);
  return res.rows;
}

async function getCategoryById(categoryId) {
  const res = await pool.query(
    `
    SELECT category_id, category_name
    FROM categories
    WHERE category_id = $1
    `,
    [categoryId]
  );
  return res.rows[0] || null;
}

async function createCategory(categoryName) {
  const clean = String(categoryName || "").trim();
  if (!clean) throw new Error("Category name is required.");

  const maxRes = await pool.query(`SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM categories`);
  const nextSort = Number(maxRes.rows[0]?.max_sort || 0) + 1;

  const res = await pool.query(
    `
    INSERT INTO categories (category_name, sort_order, is_active, created_at, updated_at)
    VALUES ($1, $2, TRUE, NOW(), NOW())
    RETURNING category_id, category_name
    `,
    [clean, nextSort]
  );

  return res.rows[0];
}

async function renameCategory(categoryId, newName) {
  const clean = String(newName || "").trim();
  if (!clean) throw new Error("New category name is required.");

  const res = await pool.query(
    `
    UPDATE categories
    SET category_name = $2,
        updated_at = NOW()
    WHERE category_id = $1
    RETURNING category_id, category_name
    `,
    [categoryId, clean]
  );

  return res.rows[0] || null;
}

async function deleteCategory(categoryId) {
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1`,
    [categoryId]
  );

  const count = Number(countRes.rows[0]?.count || 0);
  if (count > 0) {
    throw new Error("That category still contains products. Move or delete the products first.");
  }

  const res = await pool.query(
    `
    DELETE FROM categories
    WHERE category_id = $1
    RETURNING category_id, category_name
    `,
    [categoryId]
  );

  return res.rows[0] || null;
}

async function getProductsByCategoryId(categoryId) {
  const res = await pool.query(
    `
    SELECT
      p.product_id,
      p.category_id,
      p.sku,
      p.product_name,
      p.price_pence,
      p.default_stock_qty,
      COALESCE(s.stock_qty, 0) AS stock_qty
    FROM products p
    LEFT JOIN stock_items s ON s.sku = p.sku
    WHERE p.category_id = $1 AND p.is_active = TRUE
    ORDER BY p.product_name ASC
    `,
    [categoryId]
  );

  return res.rows;
}

async function getProductBySku(sku) {
  const res = await pool.query(
    `
    SELECT
      p.product_id,
      p.category_id,
      p.sku,
      p.product_name,
      p.price_pence,
      p.default_stock_qty,
      COALESCE(s.stock_qty, 0) AS stock_qty,
      c.category_name
    FROM products p
    LEFT JOIN stock_items s ON s.sku = p.sku
    JOIN categories c ON c.category_id = p.category_id
    WHERE p.sku = $1
    `,
    [sku]
  );

  return res.rows[0] || null;
}

async function createProduct({ categoryId, sku, productName, pricePence, stockQty }) {
  const cleanSku = String(sku || "").trim().toUpperCase();
  const cleanName = String(productName || "").trim();

  if (!categoryId) throw new Error("Category is required.");
  if (!cleanSku) throw new Error("SKU is required.");
  if (!cleanName) throw new Error("Product name is required.");
  if (!Number.isFinite(pricePence) || pricePence < 0) throw new Error("Valid price is required.");
  if (!Number.isFinite(stockQty) || stockQty < 0) throw new Error("Valid stock quantity is required.");

  const res = await pool.query(
    `
    INSERT INTO products (
      category_id, sku, product_name, price_pence, default_stock_qty, is_active, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, TRUE, NOW(), NOW())
    RETURNING product_id, sku, product_name
    `,
    [categoryId, cleanSku, cleanName, pricePence, stockQty]
  );

  await pool.query(
    `
    INSERT INTO stock_items (sku, stock_qty, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (sku) DO UPDATE
    SET stock_qty = EXCLUDED.stock_qty,
        updated_at = NOW()
    `,
    [cleanSku, stockQty]
  );

  return res.rows[0];
}

async function renameProduct(sku, newName) {
  const clean = String(newName || "").trim();
  if (!clean) throw new Error("New product name is required.");

  const res = await pool.query(
    `
    UPDATE products
    SET product_name = $2,
        updated_at = NOW()
    WHERE sku = $1
    RETURNING sku, product_name
    `,
    [sku, clean]
  );

  return res.rows[0] || null;
}

async function updateProductPrice(sku, pricePence) {
  if (!Number.isFinite(pricePence) || pricePence < 0) {
    throw new Error("Valid price is required.");
  }

  const res = await pool.query(
    `
    UPDATE products
    SET price_pence = $2,
        updated_at = NOW()
    WHERE sku = $1
    RETURNING sku, product_name, price_pence
    `,
    [sku, pricePence]
  );

  return res.rows[0] || null;
}

async function updateProductStock(sku, stockQty) {
  if (!Number.isFinite(stockQty) || stockQty < 0) {
    throw new Error("Valid stock quantity is required.");
  }

  await pool.query(
    `
    UPDATE stock_items
    SET stock_qty = $2,
        updated_at = NOW()
    WHERE sku = $1
    `,
    [sku, stockQty]
  );

  const res = await pool.query(
    `
    SELECT p.sku, p.product_name, COALESCE(s.stock_qty, 0) AS stock_qty
    FROM products p
    LEFT JOIN stock_items s ON s.sku = p.sku
    WHERE p.sku = $1
    `,
    [sku]
  );

  return res.rows[0] || null;
}

async function moveProductToCategory(sku, categoryId) {
  const res = await pool.query(
    `
    UPDATE products
    SET category_id = $2,
        updated_at = NOW()
    WHERE sku = $1
    RETURNING sku, product_name, category_id
    `,
    [sku, categoryId]
  );

  return res.rows[0] || null;
}

async function deleteProduct(sku) {
  await pool.query(`DELETE FROM stock_items WHERE sku = $1`, [sku]);

  const res = await pool.query(
    `
    DELETE FROM products
    WHERE sku = $1
    RETURNING sku, product_name
    `,
    [sku]
  );

  return res.rows[0] || null;
}

async function restockAllToDefault() {
  const productsRes = await pool.query(`
    SELECT sku, default_stock_qty
    FROM products
    WHERE is_active = TRUE
  `);

  for (const row of productsRes.rows) {
    await pool.query(
      `
      INSERT INTO stock_items (sku, stock_qty, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (sku) DO UPDATE
      SET stock_qty = EXCLUDED.stock_qty,
          updated_at = NOW()
      `,
      [row.sku, row.default_stock_qty]
    );
  }
}

/* -------------------------- DISCOUNT CODE HELPERS ------------------------ */

async function createDiscountCodeRecord(code, discountPercent) {
  const normalized = normalizeDiscountCode(code);
  const percent = Math.max(0, Math.min(100, Number(discountPercent || 0)));

  await pool.query(
    `
    INSERT INTO discount_codes (code, discount_percent, is_active, one_use_per_user, created_at, updated_at)
    VALUES ($1, $2, TRUE, TRUE, NOW(), NOW())
    ON CONFLICT (code) DO UPDATE
    SET discount_percent = EXCLUDED.discount_percent,
        is_active = TRUE,
        updated_at = NOW()
    `,
    [normalized, percent]
  );
}

async function getDiscountCodeRecord(code) {
  const normalized = normalizeDiscountCode(code);
  if (!normalized) return null;

  const res = await pool.query(
    `
    SELECT code, discount_percent, is_active, one_use_per_user
    FROM discount_codes
    WHERE code = $1
    `,
    [normalized]
  );

  return res.rows[0] || null;
}

async function setDiscountCodeActiveState(code, isActive) {
  const normalized = normalizeDiscountCode(code);

  const res = await pool.query(
    `
    UPDATE discount_codes
    SET is_active = $2,
        updated_at = NOW()
    WHERE code = $1
    RETURNING code, discount_percent, is_active, one_use_per_user
    `,
    [normalized, isActive]
  );

  return res.rows[0] || null;
}

async function hasUserUsedDiscountCode(userId, code) {
  const normalized = normalizeDiscountCode(code);

  const res = await pool.query(
    `
    SELECT 1
    FROM discount_code_uses
    WHERE user_id = $1 AND code = $2
    LIMIT 1
    `,
    [userId, normalized]
  );

  return res.rows.length > 0;
}

async function recordDiscountCodeUse(userId, code, orderId) {
  const normalized = normalizeDiscountCode(code);

  await pool.query(
    `
    INSERT INTO discount_code_uses (code, user_id, order_id, used_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (code, user_id) DO NOTHING
    `,
    [normalized, userId, orderId]
  );
}

async function hasUserPlacedOrderBefore(userId) {
  const res = await pool.query(`SELECT 1 FROM orders WHERE user_id=$1 LIMIT 1`, [userId]);
  return res.rows.length > 0;
}

async function validateDiscountCodeForUser(userId, code) {
  const normalized = normalizeDiscountCode(code);
  if (!normalized) {
    return { valid: false, reason: "Please enter a code." };
  }

  const record = await getDiscountCodeRecord(normalized);
  if (!record) {
    return { valid: false, reason: "That discount code is invalid." };
  }

  if (!record.is_active) {
    return { valid: false, reason: "That discount code is currently inactive." };
  }

  const isWelcome = normalized === normalizeDiscountCode(WELCOME_CODE);
  if (isWelcome) {
    const hasOrderedBefore = await hasUserPlacedOrderBefore(userId);
    if (hasOrderedBefore) {
      return { valid: false, reason: "This code is only valid on your first order." };
    }
  }

  if (record.one_use_per_user) {
    const alreadyUsed = await hasUserUsedDiscountCode(userId, normalized);
    if (alreadyUsed) {
      return { valid: false, reason: "You have already used that discount code." };
    }
  }

  return {
    valid: true,
    code: normalized,
    discount_percent: Number(record.discount_percent || 0),
    is_active: !!record.is_active,
    one_use_per_user: !!record.one_use_per_user,
  };
}

/* ------------------------------- CART HELPERS ---------------------------- */

async function getStockForSku(sku) {
  const res = await pool.query(`SELECT stock_qty FROM stock_items WHERE sku=$1`, [sku]);
  if (!res.rows.length) return 0;
  return Number(res.rows[0].stock_qty || 0);
}

async function getCartQtyForSku(userId, sku) {
  const res = await pool.query(
    `
    SELECT COALESCE(SUM(ci.qty), 0) AS qty
    FROM carts c
    JOIN cart_items ci ON ci.cart_id = c.cart_id
    WHERE c.user_id = $1 AND c.status='open' AND ci.sku = $2
    `,
    [userId, sku]
  );
  return Number(res.rows[0]?.qty || 0);
}

async function upsertProfile(userId, fullName, email, phone, shipping) {
  await pool.query(
    `
    INSERT INTO user_profiles (user_id, full_name, email, phone, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        updated_at = NOW()
    `,
    [userId, fullName, email, phone]
  );

  await pool.query(
    `
    INSERT INTO shipping_profiles (user_id, full_address, country, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET full_address = EXCLUDED.full_address,
        country = EXCLUDED.country,
        updated_at = NOW()
    `,
    [userId, shipping.full_address, shipping.country]
  );
}

async function getUserShippingProfile(userId) {
  const res = await pool.query(
    `
    SELECT up.full_name, up.email, up.phone, sp.full_address, sp.country
    FROM user_profiles up
    JOIN shipping_profiles sp ON sp.user_id = up.user_id
    WHERE up.user_id = $1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

async function getOrCreateCart(userId) {
  const existing = await pool.query(`SELECT cart_id FROM carts WHERE user_id=$1 AND status='open'`, [userId]);
  if (existing.rows.length) return existing.rows[0].cart_id;

  const created = await pool.query(
    `
    INSERT INTO carts (user_id, status, discount_code, discount_percent, updated_at)
    VALUES ($1, 'open', NULL, 0, NOW())
    RETURNING cart_id
    `,
    [userId]
  );

  return created.rows[0].cart_id;
}

async function addCartItem(userId, item) {
  const stockQty = await getStockForSku(item.sku);
  const existingCartQty = await getCartQtyForSku(userId, item.sku);

  if (existingCartQty + item.qty > stockQty) {
    throw new Error(`Only ${stockQty} in stock for ${item.name}.`);
  }

  const cartId = await getOrCreateCart(userId);

  await pool.query(
    `
    INSERT INTO cart_items (cart_id, sku, name, size, color, qty, price_pence)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [cartId, item.sku, item.name, item.size, item.color, item.qty, item.price_pence]
  );
}

async function clearCart(userId) {
  const cart = await pool.query(`SELECT cart_id FROM carts WHERE user_id=$1 AND status='open'`, [userId]);
  if (!cart.rows.length) return;

  const cartId = cart.rows[0].cart_id;
  await pool.query(`DELETE FROM cart_items WHERE cart_id=$1`, [cartId]);
  await pool.query(`DELETE FROM carts WHERE cart_id=$1`, [cartId]);
}

async function getCartSummary(userId) {
  const cart = await pool.query(`SELECT cart_id FROM carts WHERE user_id=$1 AND status='open'`, [userId]);
  if (!cart.rows.length) return { items: [], subtotal_pence: 0 };

  const cartId = cart.rows[0].cart_id;
  const itemsRes = await pool.query(
    `
    SELECT sku, name, size, color, qty, price_pence
    FROM cart_items
    WHERE cart_id=$1
    ORDER BY id ASC
    `,
    [cartId]
  );

  const items = itemsRes.rows;
  const subtotal_pence = items.reduce((sum, it) => sum + it.qty * it.price_pence, 0);
  return { items, subtotal_pence };
}

async function getCartDiscount(userId) {
  const res = await pool.query(
    `SELECT discount_code, discount_percent FROM carts WHERE user_id=$1 AND status='open'`,
    [userId]
  );

  if (!res.rows.length) {
    return { discount_code: null, discount_percent: 0 };
  }

  return {
    discount_code: res.rows[0].discount_code || null,
    discount_percent: Number(res.rows[0].discount_percent || 0),
  };
}

async function setCartDiscount(userId, code, percent) {
  const cartId = await getOrCreateCart(userId);

  await pool.query(
    `
    UPDATE carts
    SET discount_code=$1,
        discount_percent=$2,
        updated_at=NOW()
    WHERE cart_id=$3
    `,
    [normalizeDiscountCode(code), percent, cartId]
  );
}

async function clearCartDiscount(userId) {
  await pool.query(
    `
    UPDATE carts
    SET discount_code=NULL,
        discount_percent=0,
        updated_at=NOW()
    WHERE user_id=$1 AND status='open'
    `,
    [userId]
  );
}

async function hasUserPendingOrder(userId) {
  const res = await pool.query(
    `
    SELECT 1
    FROM orders
    WHERE user_id = $1
      AND status IN ('pending', 'paid', 'dispatched')
    LIMIT 1
    `,
    [userId]
  );

  return res.rows.length > 0;
}

async function buildCartMessage(userId, heading = "✅ **Added to basket.**") {
  const cart = await getCartSummary(userId);
  const profile = await getUserShippingProfile(userId);
  const shippingPence = getShippingPenceForCountry(profile?.country);

  const discount = await getCartDiscount(userId);
  const totals = calculateDiscountedTotals(
    cart.subtotal_pence,
    shippingPence,
    discount.discount_percent
  );

  const basketLines = [];
  for (const it of cart.items) {
    const stockQty = await getStockForSku(it.sku);
    basketLines.push(
      `• **${it.name}** (${it.size}, ${it.color}) × ${it.qty} — ${money(it.qty * it.price_pence)} _[Stock: ${stockQty}]_`
    );
  }

  let content =
    `${heading}\n\n` +
    `**Your basket**\n` +
    `${basketLines.join("\n") || "_No items_"}\n\n` +
    `**Subtotal:** ${money(cart.subtotal_pence)}\n`;

  if (totals.discountAmount > 0) {
    content += `**Discount (${discount.discount_code}):** -${money(totals.discountAmount)}\n`;
  }

  content +=
    `**Shipping:** ${money(shippingPence)}\n` +
    `**Total:** ${money(totals.total)}`;

  return content;
}

/* ------------------------------- RECEIPTS ------------------------------- */

async function createReceiptChannel(guild, user, orderId) {
  const category = await guild.channels.fetch(ORDERS_CATEGORY_ID).catch(() => null);

  const name = safeChannelName(`order-${user.username}-${orderId}`);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category?.id || null,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
      { id: STAFF_ROLE_ID, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
      { id: guild.members.me.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageChannels"] },
    ],
  });

  return channel;
}

function receiptEmbed(orderId, items, subtotal, discountAmount, discountCode, shipping, total, shippingProfile, status = "pending") {
  const lines = items.map(
    (it) => `• **${it.name}** (${it.size}, ${it.color}) × ${it.qty} — ${money(it.qty * it.price_pence)}`
  );

  const fields = [
    { name: "Status", value: status, inline: true },
    { name: "Subtotal", value: money(subtotal), inline: true },
  ];

  if (discountAmount > 0) {
    fields.push({
      name: "Discount",
      value: `${discountCode || "Code"} (-${money(discountAmount)})`,
      inline: true,
    });
  }

  fields.push(
    { name: "Shipping", value: money(shipping), inline: true },
    { name: "Total", value: money(total), inline: true },
    {
      name: "Shipping to",
      value:
        `${shippingProfile.full_name}\n` +
        `${shippingProfile.email}\n` +
        `${shippingProfile.phone}\n` +
        `${shippingProfile.full_address}\n` +
        `${shippingProfile.country}`,
    },
    {
      name: "Payment — Bank Transfer",
      value:
        `Please pay the **Total** via bank transfer using the details below.\n` +
        `Once paid, a staff member will confirm and mark the order as paid.\n\n` +
        bankDetailsText(orderId),
    },
    { name: "Dispatch", value: "Cut-off: **15:30 (Mon–Fri Dispatch)**" }
  );

  return new EmbedBuilder()
    .setTitle(`${STORE_NAME} — Receipt (Order #${orderId})`)
    .setDescription(lines.join("\n") || "_No items_")
    .addFields(fields)
    .setFooter({ text: "Thank you for your order." });
}

function staffReceiptControls(orderId, status = "pending") {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_mark_paid:${orderId}`)
        .setLabel("Mark Paid")
        .setStyle(ButtonStyle.Success)
        .setDisabled(
          status === "paid" ||
          status === "dispatched" ||
          status === "cancelled" ||
          status === "completed"
        ),
      new ButtonBuilder()
        .setCustomId(`staff_mark_dispatched:${orderId}`)
        .setLabel("Mark Dispatched")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(
          status === "dispatched" ||
          status === "cancelled" ||
          status === "completed"
        ),
      new ButtonBuilder()
        .setCustomId(`staff_complete_order:${orderId}`)
        .setLabel("Complete")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(
          status === "cancelled" ||
          status === "completed" ||
          status !== "dispatched"
        )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_cancel_order:${orderId}`)
        .setLabel("Cancel Order")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(
          status === "dispatched" ||
          status === "cancelled" ||
          status === "completed"
        )
    ),
  ];
}

/* ------------------------------ UI BUILDERS ------------------------------ */

async function categorySelectComponents() {
  const categories = await getCategories();

  const safeOptions = categories
    .slice(0, 25)
    .map((cat) => ({
      label: truncate100(cat.category_name),
      value: String(cat.category_id),
    }));

  if (!safeOptions.length) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("shop_close_session")
          .setLabel("Close Shop")
          .setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("select_category")
        .setPlaceholder("Choose a category…")
        .addOptions(safeOptions)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("shop_view_cart")
        .setLabel("View Basket")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shop_close_session")
        .setLabel("Close Shop")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

async function itemSelectComponents(categoryId) {
  const category = await getCategoryById(categoryId);
  const items = (await getProductsByCategoryId(categoryId)).slice(0, 25);

  const options = items.map((it) => ({
    label: truncate100(it.product_name),
    value: truncate100(it.sku),
    description: shopItemDescription(it),
  }));

  if (!options.length) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("browse_categories")
          .setLabel("Back to Categories")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("shop_close_session")
          .setLabel("Close Shop")
          .setStyle(ButtonStyle.Danger)
      ),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`select_item:${categoryId}`)
        .setPlaceholder(`Choose an item in ${truncate100(category?.category_name || "category")}…`)
        .addOptions(options)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("browse_categories")
        .setLabel("Back to Categories")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shop_view_cart")
        .setLabel("View Basket")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shop_close_session")
        .setLabel("Close Shop")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

async function qtyButtonsComponents(categoryId, sku) {
  const stockQty = await getStockForSku(sku);
  const maxQuickQty = Math.min(stockQty, 5);
  const quickButtons = [];

  for (let n = 1; n <= maxQuickQty; n += 1) {
    quickButtons.push(
      new ButtonBuilder()
        .setCustomId(`add_qty:${categoryId}:${sku}:${n}`)
        .setLabel(String(n))
        .setStyle(ButtonStyle.Secondary)
    );
  }

  const rows = [];

  if (quickButtons.length) {
    rows.push(new ActionRowBuilder().addComponents(...quickButtons));
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`add_qty_other:${categoryId}:${sku}`)
        .setLabel("Other…")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(stockQty <= 0),
      new ButtonBuilder()
        .setCustomId(`back_to_items:${categoryId}`)
        .setLabel("Back to Items")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("browse_categories")
        .setLabel("Back to Categories")
        .setStyle(ButtonStyle.Secondary)
    )
  );

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("shop_view_cart")
        .setLabel("View Basket")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("shop_close_session")
        .setLabel("Close Shop")
        .setStyle(ButtonStyle.Danger)
    )
  );

  return rows;
}

function cartActionsComponents(disableSubmit = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("browse_categories")
        .setLabel("Browse Categories")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("cart_discount")
        .setLabel("Apply Discount Code")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("cart_submit")
        .setLabel("Submit Order")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disableSubmit),
      new ButtonBuilder()
        .setCustomId("cart_clear")
        .setLabel("Clear Cart")
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function menuMessageComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_menu")
        .setLabel("Click to see our menu")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function verifyPanelComponents() {
  const embed = new EmbedBuilder()
    .setTitle("Server Verification")
    .setDescription(
      [
        "To access the full server, click the button below and complete the form.",
        "",
        "All fields are required:",
        "• Full name",
        "• How you heard about us",
        "• Referral / who sent you",
        "• Email address",
        "• Phone number",
      ].join("\n")
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_open_modal")
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success)
  );

  return { embed, row };
}

function verifyApproveComponents(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify_approve:${userId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function staffHomePanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Staff Control Panel", [
        "**Orders**",
        "Look up customer orders and manage them quickly.",
        "",
        "**Catalog**",
        "Products, categories and stock all in one place.",
        "",
        "**Discounts**",
        "Create and toggle discount codes.",
        "",
        "**Moderation**",
        "Verification, timeout, kick and ban tools.",
        "",
        "This panel now stays in one message.",
        "Use the buttons below to move between sections.",
      ]),
    ],
    components: [staffHomeNavRow()],
  };
}

function staffOrdersPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Orders", [
        "Order tools are grouped here.",
        "",
        "Use this section to look up existing orders.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_open_orderlookup_modal")
          .setLabel("Lookup Order")
          .setStyle(orderCategoryColor())
      ),
      staffBackHomeRow("staff_panel_home", "Back"),
    ],
  };
}

function staffCatalogPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Catalog", [
        "Catalog tools are grouped into products, categories and stock.",
        "",
        "Choose a section below.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_nav_products")
          .setLabel("Products")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_nav_categories")
          .setLabel("Categories")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_nav_stock")
          .setLabel("Stock")
          .setStyle(shopCategoryColor())
      ),
      staffBackHomeRow("staff_panel_home", "Back"),
    ],
  };
}

function staffProductsPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Catalog • Products", [
        "All product actions are grouped here.",
        "",
        "Green is used for this category.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_open_add_product_flow")
          .setLabel("Add Product")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_open_edit_product_flow")
          .setLabel("Edit Product")
          .setStyle(shopCategoryColor())
      ),
      staffBackHomeRow("staff_nav_catalog", "Back to Catalog"),
    ],
  };
}

function staffCategoriesPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Catalog • Categories", [
        "All category actions are grouped here.",
        "",
        "Green is used for this category and red is kept only for delete.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_open_add_category_modal")
          .setLabel("Add Category")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_open_rename_category_flow")
          .setLabel("Rename Category")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_open_delete_category_flow")
          .setLabel("Delete Category")
          .setStyle(ButtonStyle.Danger)
      ),
      staffBackHomeRow("staff_nav_catalog", "Back to Catalog"),
    ],
  };
}

function staffStockPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Catalog • Stock", [
        "All stock actions are grouped here.",
        "",
        "Use Adjust Stock for one product or Restock All for a full reset.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_open_stock_flow")
          .setLabel("Adjust Stock")
          .setStyle(shopCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_restock_all_confirm")
          .setLabel("Restock All")
          .setStyle(ButtonStyle.Danger)
      ),
      staffBackHomeRow("staff_nav_catalog", "Back to Catalog"),
    ],
  };
}

function staffDiscountsPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Discounts", [
        "All discount actions are grouped here.",
        "",
        "Grey is used for this category.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_open_create_discount_modal")
          .setLabel("Create Discount")
          .setStyle(discountCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_open_toggle_discount_modal")
          .setLabel("Toggle Discount")
          .setStyle(discountCategoryColor())
      ),
      staffBackHomeRow("staff_panel_home", "Back"),
    ],
  };
}

function moderationPanelComponents() {
  return {
    embeds: [
      staffStandardEmbed("Moderation", [
        "All moderation tools are grouped here.",
        "",
        "Red is used for this category.",
      ]),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_mod_add_verified")
          .setLabel("Add Verified")
          .setStyle(moderationCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_mod_remove_verified")
          .setLabel("Remove Verified")
          .setStyle(moderationCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_mod_timeout")
          .setLabel("Timeout")
          .setStyle(moderationCategoryColor())
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_mod_untimeout")
          .setLabel("Remove Timeout")
          .setStyle(moderationCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_mod_kick")
          .setLabel("Kick")
          .setStyle(moderationCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_mod_ban")
          .setLabel("Ban")
          .setStyle(moderationCategoryColor()),
        new ButtonBuilder()
          .setCustomId("staff_mod_unban")
          .setLabel("Unban")
          .setStyle(moderationCategoryColor())
      ),
      staffBackHomeRow("staff_panel_home", "Back"),
    ],
  };
}

/* ------------------------------- STAFF UI -------------------------------- */

async function staffCategorySelect(customId, placeholder = "Choose a category…", backId = "staff_panel_home", backLabel = "Back") {
  const categories = await getCategories();

  if (!categories.length) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_noop")
          .setLabel("No categories available")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      ),
      staffBackHomeRow(backId, backLabel),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(
          categories.slice(0, 25).map((cat) => ({
            label: truncate100(cat.category_name),
            value: String(cat.category_id),
          }))
        )
    ),
    staffBackHomeRow(backId, backLabel),
  ];
}

async function staffProductSelectByCategory(customId, categoryId, placeholder = "Choose a product…", backId = "staff_panel_home", backLabel = "Back") {
  const products = await getProductsByCategoryId(categoryId);

  if (!products.length) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_noop")
          .setLabel("No products in this category")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      ),
      staffBackHomeRow(backId, backLabel),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .addOptions(
          products.slice(0, 25).map((p) => ({
            label: truncate100(p.product_name),
            description: truncate100(`${money(p.price_pence)} • SKU ${p.sku}`),
            value: truncate100(p.sku),
          }))
        )
    ),
    staffBackHomeRow(backId, backLabel),
  ];
}

function staffEditProductActionComponents(categoryId, sku) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_open_rename_product_modal:${sku}`)
        .setLabel("Rename")
        .setStyle(shopCategoryColor()),
      new ButtonBuilder()
        .setCustomId(`staff_open_price_modal:${sku}`)
        .setLabel("Change Price")
        .setStyle(shopCategoryColor()),
      new ButtonBuilder()
        .setCustomId(`staff_open_stock_modal_direct:${sku}`)
        .setLabel("Change Stock")
        .setStyle(shopCategoryColor())
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`staff_open_move_product_flow:${sku}`)
        .setLabel("Move Product")
        .setStyle(shopCategoryColor()),
      new ButtonBuilder()
        .setCustomId(`staff_delete_product_confirm:${sku}`)
        .setLabel("Delete Product")
        .setStyle(ButtonStyle.Danger)
    ),
    staffBackHomeRow(`staff_back_edit_products:${categoryId}`, "Back to Products"),
  ];
}

/* --------------------------- STAFF PANEL UI --------------------------- */

function staffMainPanel() {
  return {
    content:
      `**Staff Control Panel**\n\n` +
      `Select a section:`,

    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_nav_orders").setLabel("Orders").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("staff_nav_products").setLabel("Products").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("staff_nav_categories").setLabel("Categories").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_nav_stock").setLabel("Stock").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("staff_nav_discounts").setLabel("Discounts").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("staff_nav_moderation").setLabel("Moderation").setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

/* --------------------------- SUB PANELS --------------------------- */

function staffProductsPanel() {
  return {
    content: `**Products Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_add_product").setLabel("Add Product").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("staff_edit_product").setLabel("Edit Product").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("staff_move_product").setLabel("Move Product").setStyle(ButtonStyle.Success)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_delete_product").setLabel("Delete Product").setStyle(ButtonStyle.Danger)
      ),
      navRow("staff_panel_home")
    ],
  };
}

function staffCategoriesPanel() {
  return {
    content: `**Categories Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_add_category").setLabel("Add Category").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("staff_rename_category").setLabel("Rename Category").setStyle(ButtonStyle.Primary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_delete_category").setLabel("Delete Category").setStyle(ButtonStyle.Danger)
      ),
      navRow("staff_panel_home")
    ],
  };
}

function staffStockPanel() {
  return {
    content: `**Stock Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_adjust_stock").setLabel("Adjust Stock").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("staff_restock_all").setLabel("Restock All").setStyle(ButtonStyle.Success)
      ),
      navRow("staff_panel_home")
    ],
  };
}

function staffDiscountPanel() {
  return {
    content: `**Discount Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_create_discount").setLabel("Create Discount").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("staff_toggle_discount").setLabel("Toggle Discount").setStyle(ButtonStyle.Primary)
      ),
      navRow("staff_panel_home")
    ],
  };
}

function staffOrdersPanel() {
  return {
    content: `**Orders Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_lookup_order").setLabel("Lookup Order").setStyle(ButtonStyle.Secondary)
      ),
      navRow("staff_panel_home")
    ],
  };
}

function staffModerationPanel() {
  return {
    content: `**Moderation Panel**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_add_verified").setLabel("Add Verified").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("staff_remove_verified").setLabel("Remove Verified").setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_timeout").setLabel("Timeout").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("staff_untimeout").setLabel("Remove Timeout").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("staff_kick").setLabel("Kick").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("staff_ban").setLabel("Ban").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("staff_unban").setLabel("Unban").setStyle(ButtonStyle.Secondary)
      ),
      navRow("staff_panel_home")
    ],
  };
}

/* --------------------------- NAVIGATION ROW --------------------------- */

function navRow(homeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(homeId)
      .setLabel("Back to Main Panel")
      .setStyle(ButtonStyle.Secondary)
  );
}

/* --------------------------- BUTTON HANDLER --------------------------- */

if (interaction.isButton()) {
  const { customId } = interaction;

  /* -------- MAIN NAV -------- */

  if (customId === "staff_panel_home") {
    return interaction.update(staffMainPanel());
  }

  if (customId === "staff_nav_products") {
    return interaction.update(staffProductsPanel());
  }

  if (customId === "staff_nav_categories") {
    return interaction.update(staffCategoriesPanel());
  }

  if (customId === "staff_nav_stock") {
    return interaction.update(staffStockPanel());
  }

  if (customId === "staff_nav_discounts") {
    return interaction.update(staffDiscountPanel());
  }

  if (customId === "staff_nav_orders") {
    return interaction.update(staffOrdersPanel());
  }

  if (customId === "staff_nav_moderation") {
    return interaction.update(staffModerationPanel());
  }

  /* -------- EXISTING ACTION HOOKS -------- */
  // KEEP your existing logic below
}

/* --------------------------- SETUP STAFF PANEL --------------------------- */

if (interaction.commandName === "setupstaffpanel") {
  await interaction.deferReply({ flags: 64 });
  deferred = true;

  const staffChannel = await client.channels.fetch(STAFF_ONLY_CHANNEL_ID).catch(() => null);
  if (!staffChannel) {
    return interaction.editReply("❌ Could not find the staff-only channel. Check STAFF_ONLY_CHANNEL_ID.");
  }

  await staffChannel.send(staffMainPanel());

  return interaction.editReply(`✅ Staff panel posted in <#${STAFF_ONLY_CHANNEL_ID}>.`);
}

/* --------------------------- STAFF BUTTON ACTIONS --------------------------- */
/* put these inside your interaction.isButton() block, BELOW the nav buttons from part 2 */

if (customId === "staff_add_product") {
  return interaction.update({
    content: "Choose the category you want to add a product to:",
    components: await staffCategorySelect(
      "staff_add_product_select_category",
      "Choose a category…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_edit_product") {
  return interaction.update({
    content: "Choose the category containing the product you want to edit:",
    components: await staffCategorySelect(
      "staff_edit_product_select_category",
      "Choose a category…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_move_product") {
  return interaction.update({
    content: "Choose the category containing the product you want to move:",
    components: await staffCategorySelect(
      "staff_move_product_pick_category",
      "Choose a category…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_delete_product") {
  return interaction.update({
    content: "Choose the category containing the product you want to delete:",
    components: await staffCategorySelect(
      "staff_delete_product_pick_category",
      "Choose a category…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_add_category") {
  return interaction.showModal(staffAddCategoryModal());
}

if (customId === "staff_rename_category") {
  return interaction.update({
    content: "Choose the category you want to rename:",
    components: await staffCategorySelect(
      "staff_rename_category_select",
      "Choose a category…",
      "staff_nav_categories",
      "Back to Categories"
    ),
  });
}

if (customId === "staff_delete_category") {
  return interaction.update({
    content: "Choose the category you want to delete:",
    components: await staffCategorySelect(
      "staff_delete_category_select",
      "Choose a category…",
      "staff_nav_categories",
      "Back to Categories"
    ),
  });
}

if (customId === "staff_adjust_stock") {
  return interaction.update({
    content: "Choose a category:",
    components: await staffCategorySelect(
      "staff_stock_select_category",
      "Choose a category…",
      "staff_nav_stock",
      "Back to Stock"
    ),
  });
}

if (customId === "staff_restock_all") {
  return interaction.update({
    content: "Are you sure you want to restock all items back to their default values?",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("staff_restock_all_execute")
          .setLabel("Yes, restock all")
          .setStyle(ButtonStyle.Danger)
      ),
      navRow("staff_nav_stock"),
    ],
  });
}

if (customId === "staff_create_discount") {
  return interaction.showModal(staffCreateDiscountModal());
}

if (customId === "staff_toggle_discount") {
  return interaction.showModal(staffToggleDiscountModal());
}

if (customId === "staff_lookup_order") {
  return interaction.showModal(staffOrderLookupModal());
}

if (customId === "staff_add_verified") {
  return interaction.showModal(
    staffMemberSearchModal("add_verified", "Add Verified Role")
  );
}

if (customId === "staff_remove_verified") {
  return interaction.showModal(
    staffMemberSearchModal("remove_verified", "Remove Verified Role")
  );
}

if (customId === "staff_timeout") {
  return interaction.showModal(
    staffMemberSearchModal("timeout", "Find Member To Timeout")
  );
}

if (customId === "staff_untimeout") {
  return interaction.showModal(
    staffMemberSearchModal("untimeout", "Find Member To Remove Timeout")
  );
}

if (customId === "staff_kick") {
  return interaction.showModal(
    staffMemberSearchModal("kick", "Find Member To Kick")
  );
}

if (customId === "staff_ban") {
  return interaction.showModal(
    staffMemberSearchModal("ban", "Find Member To Ban")
  );
}

if (customId === "staff_unban") {
  return interaction.showModal(staffUnbanModal());
}

if (customId === "staff_restock_all_execute") {
  await restockAllToDefault();

  return interaction.update({
    content: "✅ All stock reset to default values.",
    components: staffStockPanel().components,
  });
}

/* --------------------------- STAFF SELECT MENUS --------------------------- */
/* put these inside your interaction.isStringSelectMenu() block */

if (customId === "staff_stock_select_category") {
  const categoryId = interaction.values[0];

  return interaction.update({
    content: "Choose the product you want to update stock for:",
    components: await staffProductSelectByCategory(
      "staff_stock_select_product",
      categoryId,
      "Choose a product…",
      "staff_nav_stock",
      "Back to Stock"
    ),
  });
}

if (customId === "staff_stock_select_product") {
  const sku = interaction.values[0];
  const product = await getProductBySku(sku);
  if (!product) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.showModal(staffStockQtyModal(sku, product.product_name));
}

if (customId === "staff_add_product_select_category") {
  const categoryId = interaction.values[0];
  const category = await getCategoryById(categoryId);
  if (!category) return interaction.reply({ content: "Category not found.", flags: 64 });

  return interaction.showModal(staffAddProductModal(categoryId, category.category_name));
}

if (customId === "staff_edit_product_select_category") {
  const categoryId = interaction.values[0];

  return interaction.update({
    content: "Choose a product:",
    components: await staffProductSelectByCategory(
      "staff_edit_product_select_product",
      categoryId,
      "Choose a product…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_edit_product_select_product") {
  const sku = interaction.values[0];
  const product = await getProductBySku(sku);
  if (!product) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.update({
    content:
      `**${product.product_name}**\n` +
      `SKU: ${product.sku}\n` +
      `Category: ${product.category_name}\n` +
      `Price: ${money(product.price_pence)}\n` +
      `Stock: ${product.stock_qty}`,
    components: staffEditProductActionComponents(product.category_id, sku),
  });
}

if (customId === "staff_move_product_pick_category") {
  const categoryId = interaction.values[0];

  return interaction.update({
    content: "Choose the product you want to move:",
    components: await staffProductSelectByCategory(
      "staff_move_product_select_product",
      categoryId,
      "Choose a product…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_move_product_select_product") {
  const sku = interaction.values[0];
  const product = await getProductBySku(sku);
  if (!product) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.update({
    content: `Choose the new category for **${product.product_name}** (${sku}):`,
    components: await staffCategorySelect(
      `staff_move_product_select_category:${sku}`,
      "Choose a new category…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId.startsWith("staff_move_product_select_category:")) {
  const [, sku] = customId.split(":");
  const categoryId = interaction.values[0];
  const category = await getCategoryById(categoryId);
  const moved = await moveProductToCategory(sku, categoryId);

  if (!moved) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.update({
    content: `✅ Product moved to **${category?.category_name || "new category"}**`,
    components: staffProductsPanel().components,
  });
}

if (customId === "staff_delete_product_pick_category") {
  const categoryId = interaction.values[0];

  return interaction.update({
    content: "Choose the product you want to delete:",
    components: await staffProductSelectByCategory(
      "staff_delete_product_select_product",
      categoryId,
      "Choose a product…",
      "staff_nav_products",
      "Back to Products"
    ),
  });
}

if (customId === "staff_delete_product_select_product") {
  const sku = interaction.values[0];
  const deleted = await deleteProduct(sku);
  if (!deleted) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.update({
    content: `✅ Deleted product **${deleted.product_name}** (${deleted.sku})`,
    components: staffProductsPanel().components,
  });
}

if (customId === "staff_rename_category_select") {
  const categoryId = interaction.values[0];
  const category = await getCategoryById(categoryId);
  if (!category) return interaction.reply({ content: "Category not found.", flags: 64 });

  return interaction.showModal(staffRenameCategoryModal(categoryId, category.category_name));
}

if (customId === "staff_delete_category_select") {
  const categoryId = interaction.values[0];
  const category = await getCategoryById(categoryId);
  if (!category) return interaction.reply({ content: "Category not found.", flags: 64 });

  const deleted = await deleteCategory(categoryId);
  if (!deleted) return interaction.reply({ content: "Category not found.", flags: 64 });

  return interaction.update({
    content: `✅ Deleted category **${deleted.category_name}**`,
    components: staffCategoriesPanel().components,
  });
}

if (customId.startsWith("staff_member_search_select:")) {
  const [, action] = customId.split(":");
  const targetUserId = interaction.values[0];
  const targetMember = await ensureTargetMember(interaction.guild, targetUserId);

  if (!targetMember) {
    return interaction.update({
      content: "Could not find that member.",
      components: staffModerationPanel().components,
    });
  }

  const check = canActOnTarget(interaction.member, targetMember);
  if (!check.ok) {
    return interaction.update({
      content: check.reason,
      components: staffModerationPanel().components,
    });
  }

  if (action === "add_verified") {
    if (targetMember.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.update({
        content: "That member already has the verified role.",
        components: staffModerationPanel().components,
      });
    }

    await targetMember.roles.add(VERIFIED_ROLE_ID, `Added by ${interaction.user.tag}`);

    return interaction.update({
      content: `✅ Added verified role to <@${targetMember.id}>`,
      components: staffModerationPanel().components,
    });
  }

  if (action === "remove_verified") {
    if (!targetMember.roles.cache.has(VERIFIED_ROLE_ID)) {
      return interaction.update({
        content: "That member does not currently have the verified role.",
        components: staffModerationPanel().components,
      });
    }

    await targetMember.roles.remove(VERIFIED_ROLE_ID, `Removed by ${interaction.user.tag}`);

    return interaction.update({
      content: `✅ Removed verified role from <@${targetMember.id}>`,
      components: staffModerationPanel().components,
    });
  }

  if (action === "timeout") {
    return interaction.showModal(
      staffTimeoutModal(
        targetMember.id,
        targetMember.displayName || targetMember.user.username
      )
    );
  }

  if (action === "untimeout") {
    if (!targetMember.isCommunicationDisabled()) {
      return interaction.update({
        content: "That member is not currently timed out.",
        components: staffModerationPanel().components,
      });
    }

    await targetMember.timeout(null, `Timeout removed by ${interaction.user.tag}`);

    return interaction.update({
      content: `✅ Removed timeout from <@${targetMember.id}>`,
      components: staffModerationPanel().components,
    });
  }

  if (action === "kick") {
    await targetMember.kick(`Kicked by ${interaction.user.tag}`);

    return interaction.update({
      content: `✅ Kicked <@${targetMember.id}>`,
      components: staffModerationPanel().components,
    });
  }

  if (action === "ban") {
    return interaction.showModal(
      staffBanModal(
        targetMember.id,
        targetMember.displayName || targetMember.user.username
      )
    );
  }
}

/* --------------------------- STAFF MODAL RETURNS --------------------------- */
/* keep these inside your interaction.isModalSubmit() block */

if (customId === "staff_add_category_modal") {
  const categoryName = interaction.fields.getTextInputValue("category_name")?.trim();
  if (!categoryName) return interaction.reply({ content: "Category name is required.", flags: 64 });

  const created = await createCategory(categoryName);

  return interaction.reply({
    content: `✅ Category created: **${created.category_name}**`,
    flags: 64,
  });
}

if (customId.startsWith("staff_rename_category_modal:")) {
  const [, categoryId] = customId.split(":");
  const newName = interaction.fields.getTextInputValue("new_category_name")?.trim();

  const updated = await renameCategory(categoryId, newName);
  if (!updated) return interaction.reply({ content: "Category not found.", flags: 64 });

  return interaction.reply({
    content: `✅ Category renamed to **${updated.category_name}**`,
    flags: 64,
  });
}

if (customId.startsWith("staff_add_product_modal:")) {
  const [, categoryId] = customId.split(":");
  const sku = interaction.fields.getTextInputValue("sku")?.trim();
  const productName = interaction.fields.getTextInputValue("product_name")?.trim();
  const priceGbp = interaction.fields.getTextInputValue("price_gbp")?.trim();
  const stockQtyRaw = interaction.fields.getTextInputValue("stock_qty")?.trim();

  const pricePence = parsePriceToPence(priceGbp);
  const stockQty = parseInt(stockQtyRaw, 10);

  if (!sku || !productName) {
    return interaction.reply({ content: "SKU and product name are required.", flags: 64 });
  }

  if (pricePence === null) {
    return interaction.reply({ content: "Enter a valid GBP price.", flags: 64 });
  }

  if (!Number.isFinite(stockQty) || stockQty < 0) {
    return interaction.reply({ content: "Enter a valid stock quantity.", flags: 64 });
  }

  const created = await createProduct({
    categoryId,
    sku,
    productName,
    pricePence,
    stockQty,
  });

  return interaction.reply({
    content: `✅ Product created: **${created.product_name}** (${created.sku})`,
    flags: 64,
  });
}

if (customId.startsWith("staff_rename_product_modal:")) {
  const [, sku] = customId.split(":");
  const newName = interaction.fields.getTextInputValue("new_product_name")?.trim();

  const updated = await renameProduct(sku, newName);
  if (!updated) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.reply({
    content: `✅ Product renamed to **${updated.product_name}**`,
    flags: 64,
  });
}

if (customId.startsWith("staff_edit_price_modal:")) {
  const [, sku] = customId.split(":");
  const priceGbp = interaction.fields.getTextInputValue("price_gbp")?.trim();
  const pricePence = parsePriceToPence(priceGbp);

  if (pricePence === null) {
    return interaction.reply({ content: "Enter a valid GBP price.", flags: 64 });
  }

  const updated = await updateProductPrice(sku, pricePence);
  if (!updated) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.reply({
    content: `✅ Price updated for **${updated.product_name}** → ${money(updated.price_pence)}`,
    flags: 64,
  });
}

if (customId.startsWith("staff_stock_qty_modal:")) {
  const [, sku] = customId.split(":");
  const qtyRaw = interaction.fields.getTextInputValue("stock_qty")?.trim();
  const qty = parseInt(qtyRaw, 10);

  if (!Number.isFinite(qty) || qty < 0) {
    return interaction.reply({ content: "Enter a valid stock quantity of 0 or more.", flags: 64 });
  }

  const updated = await updateProductStock(sku, qty);
  if (!updated) return interaction.reply({ content: "Product not found.", flags: 64 });

  return interaction.reply({
    content: `✅ Stock updated for **${updated.product_name}** (${updated.sku}) → ${updated.stock_qty}`,
    flags: 64,
  });
}

if (customId === "staff_orderlookup_modal") {
  const orderIdRaw = interaction.fields.getTextInputValue("lookup_order_id")?.trim();
  const orderId = parseInt(orderIdRaw, 10);

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return interaction.reply({ content: "Enter a valid order ID.", flags: 64 });
  }

  const orderRes = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [orderId]);
  if (!orderRes.rows.length) {
    return interaction.reply({ content: "Order not found.", flags: 64 });
  }

  const order = orderRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT name, qty, price_pence FROM order_items WHERE order_id=$1 ORDER BY id ASC`,
    [orderId]
  );

  const itemLines = itemsRes.rows.map(
    (it) => `• ${it.name} × ${it.qty} — ${money(it.qty * it.price_pence)}`
  );

  const embed = new EmbedBuilder()
    .setTitle(`Order #${orderId}`)
    .addFields(
      { name: "Status", value: order.status || "unknown", inline: true },
      { name: "Total", value: money(order.total_pence || 0), inline: true },
      { name: "User ID", value: order.user_id || "unknown", inline: true },
      { name: "Receipt Channel", value: order.receipt_channel_id ? `<#${order.receipt_channel_id}>` : "None" },
      { name: "Items", value: itemLines.join("\n") || "_No items_" }
    )
    .setTimestamp(new Date(order.created_at));

  return interaction.reply({
    embeds: [embed],
    flags: 64,
  });
}

if (customId === "staff_create_discount_modal") {
  const codeRaw = interaction.fields.getTextInputValue("discount_code")?.trim();
  const percentRaw = interaction.fields.getTextInputValue("discount_percent")?.trim();

  const code = normalizeDiscountCode(codeRaw);
  const percent = parseInt(percentRaw, 10);

  if (!code) {
    return interaction.reply({ content: "Enter a valid code.", flags: 64 });
  }

  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return interaction.reply({ content: "Enter a valid percent from 0 to 100.", flags: 64 });
  }

  await createDiscountCodeRecord(code, percent);

  return interaction.reply({
    content: `✅ Discount code **${code}** created or updated at ${percent}% and set active.`,
    flags: 64,
  });
}

if (customId === "staff_toggle_discount_modal") {
  const codeRaw = interaction.fields.getTextInputValue("discount_code")?.trim();
  const stateRaw = interaction.fields.getTextInputValue("discount_active")?.trim().toLowerCase();

  const code = normalizeDiscountCode(codeRaw);

  if (!code) {
    return interaction.reply({ content: "Enter a valid code.", flags: 64 });
  }

  let active;
  if (stateRaw === "active") active = true;
  else if (stateRaw === "inactive") active = false;
  else {
    return interaction.reply({ content: "Type either active or inactive.", flags: 64 });
  }

  const updated = await setDiscountCodeActiveState(code, active);
  if (!updated) {
    return interaction.reply({ content: "That discount code was not found.", flags: 64 });
  }

  return interaction.reply({
    content: `✅ Discount code **${updated.code}** is now **${updated.is_active ? "active" : "inactive"}**.`,
    flags: 64,
  });
}

if (customId.startsWith("staff_member_search_modal:")) {
  const [, action] = customId.split(":");
  const search = interaction.fields.getTextInputValue("member_search")?.trim();

  if (!search) {
    return interaction.reply({ content: "Enter a search term.", flags: 64 });
  }

  let options = {};
  if (action === "add_verified") options.excludeVerified = true;
  if (action === "remove_verified") options.verifiedOnly = true;

  const matches = await searchGuildMembers(interaction.guild, search, options);

  if (!matches.length) {
    return interaction.reply({
      content: "No matching members found.",
      flags: 64,
    });
  }

  return interaction.reply({
    content: "Choose a member:",
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`staff_member_search_select:${action}`)
          .setPlaceholder("Select a member…")
          .addOptions(memberSelectOptions(matches))
      )
    ],
    flags: 64,
  });
}

if (customId.startsWith("staff_timeout_modal:")) {
  const [, userId] = customId.split(":");
  const targetMember = await ensureTargetMember(interaction.guild, userId);

  if (!targetMember) {
    return interaction.reply({ content: "Could not find that member.", flags: 64 });
  }

  const check = canActOnTarget(interaction.member, targetMember);
  if (!check.ok) {
    return interaction.reply({ content: check.reason, flags: 64 });
  }

  const minutesRaw = interaction.fields.getTextInputValue("timeout_minutes")?.trim();
  const reasonRaw = interaction.fields.getTextInputValue("timeout_reason")?.trim();
  const timeoutMs = timeoutMsFromMinutes(minutesRaw);

  if (!timeoutMs) {
    return interaction.reply({ content: "Enter a valid number of minutes.", flags: 64 });
  }

  const maxTimeoutMs = 28 * 24 * 60 * 60 * 1000;
  if (timeoutMs > maxTimeoutMs) {
    return interaction.reply({ content: "Timeout cannot exceed 28 days.", flags: 64 });
  }

  await targetMember.timeout(
    timeoutMs,
    reasonRaw || `Timed out by ${interaction.user.tag}`
  );

  return interaction.reply({
    content: `✅ Timed out <@${targetMember.id}> for ${minutesRaw} minute(s).`,
    flags: 64,
  });
}

if (customId.startsWith("staff_ban_modal:")) {
  const [, userId] = customId.split(":");
  const targetMember = await ensureTargetMember(interaction.guild, userId);

  if (!targetMember) {
    return interaction.reply({ content: "Could not find that member.", flags: 64 });
  }

  const check = canActOnTarget(interaction.member, targetMember);
  if (!check.ok) {
    return interaction.reply({ content: check.reason, flags: 64 });
  }

  const reasonRaw = interaction.fields.getTextInputValue("ban_reason")?.trim();

  await targetMember.ban({
    reason: reasonRaw || `Banned by ${interaction.user.tag}`,
  });

  return interaction.reply({
    content: `✅ Banned <@${targetMember.id}>`,
    flags: 64,
  });
}

if (customId === "staff_unban_modal") {
  const userId = interaction.fields.getTextInputValue("unban_user_id")?.trim();
  const reasonRaw = interaction.fields.getTextInputValue("unban_reason")?.trim();

  if (!/^\d{16,20}$/.test(userId || "")) {
    return interaction.reply({ content: "Enter a valid user ID.", flags: 64 });
  }

  const banRecord = await interaction.guild.bans.fetch(userId).catch(() => null);
  if (!banRecord) {
    return interaction.reply({ content: "That user is not currently banned.", flags: 64 });
  }

  await interaction.guild.members.unban(
    userId,
    reasonRaw || `Unbanned by ${interaction.user.tag}`
  );

  return interaction.reply({
    content: `✅ Unbanned user ID \`${userId}\``,
    flags: 64,
  });
}
