-- =============================================================================
-- Supabase PostgreSQL Database Schema
-- Scalping Trade Automation & Persistence Layer
-- =============================================================================

-- 1. App Settings Table
CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY DEFAULT 'main',
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 2. Account Balance State Table (Critical: Balance $91.00)
CREATE TABLE IF NOT EXISTS account_state (
  id TEXT PRIMARY KEY DEFAULT 'main',
  starting_balance NUMERIC(12, 2) NOT NULL DEFAULT 25.00,
  current_balance NUMERIC(12, 2) NOT NULL DEFAULT 91.00,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Trade Ledger Table
CREATE TABLE IF NOT EXISTS trade_ledger (
  id TEXT PRIMARY KEY,
  trade_number INTEGER,
  date TEXT,
  iso_time TEXT,
  asset TEXT DEFAULT 'XAU/USD',
  direction TEXT,
  entry NUMERIC(12, 2),
  sl NUMERIC(12, 2),
  sl_points NUMERIC(12, 2),
  tp1 NUMERIC(12, 2),
  tp1_points NUMERIC(12, 2),
  tp2 NUMERIC(12, 2),
  tp2_points NUMERIC(12, 2),
  rr TEXT,
  risk_percent NUMERIC(8, 2),
  risk_amount NUMERIC(12, 2),
  lot_size NUMERIC(8, 4) DEFAULT 0.01,
  confidence NUMERIC(8, 2),
  setup TEXT,
  result TEXT,
  is_active BOOLEAN DEFAULT FALSE,
  pl NUMERIC(12, 2) DEFAULT 0,
  realized_pnl NUMERIC(12, 2) DEFAULT 0,
  balance_after_trade NUMERIC(12, 2),
  exit_price NUMERIC(12, 2),
  exit_time TEXT,
  closed_at BIGINT,
  close_reason TEXT,
  source TEXT DEFAULT 'MANUAL',
  broker_deal_id TEXT,
  broker_order_id TEXT,
  theoretical_tp1_profit NUMERIC(12, 2),
  theoretical_tp2_profit NUMERIC(12, 2),
  notes TEXT,
  signal_id TEXT,
  setup_id TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_ledger_trade_number ON trade_ledger(trade_number DESC);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_result ON trade_ledger(result);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_is_active ON trade_ledger(is_active);
CREATE INDEX IF NOT EXISTS idx_trade_ledger_closed_at ON trade_ledger(closed_at DESC);

-- 4. Trade Outcomes Table (Telegram & Manual Resolutions)
CREATE TABLE IF NOT EXISTS trade_outcomes (
  signal_id TEXT PRIMARY KEY,
  trade_id TEXT,
  direction TEXT,
  order_type TEXT,
  entry NUMERIC(12, 2),
  stop_loss NUMERIC(12, 2),
  tp1 NUMERIC(12, 2),
  tp2 NUMERIC(12, 2),
  outcome TEXT,
  timestamp BIGINT,
  iso_time TEXT,
  chat_id TEXT,
  user_id TEXT,
  pl NUMERIC(12, 2),
  realized_pnl NUMERIC(12, 2),
  exit_price NUMERIC(12, 2),
  source TEXT,
  broker_deal_id TEXT,
  broker_order_id TEXT,
  closed_at BIGINT,
  close_reason TEXT,
  notes TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_outcomes_timestamp ON trade_outcomes(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_outcome ON trade_outcomes(outcome);

-- 5. Signals Table
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  timestamp BIGINT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp DESC);

-- 6. Scans Table
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  timestamp BIGINT,
  status TEXT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp DESC);

-- 7. Opportunities Table
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  last_updated_time BIGINT,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opportunities_last_updated ON opportunities(last_updated_time DESC);

-- 8. Telegram Bot Configuration
CREATE TABLE IF NOT EXISTS telegram_config (
  id TEXT PRIMARY KEY DEFAULT 'main',
  chat_id TEXT NOT NULL,
  registered_at TEXT,
  updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 9. Candidate Lifecycles
CREATE TABLE IF NOT EXISTS candidate_lifecycles (
  id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 10. POI Records
CREATE TABLE IF NOT EXISTS poi_records (
  id TEXT PRIMARY KEY,
  raw_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 11. Terminal Setups (Cooldown & Invalidation Dedup)
CREATE TABLE IF NOT EXISTS terminal_setups (
  id TEXT PRIMARY KEY,
  setup_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Seed Account State with exactly $91.00 current balance if not already present
INSERT INTO account_state (id, starting_balance, current_balance, updated_at)
VALUES ('main', 25.00, 91.00, NOW())
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Security, Permissions & Row-Level Security (RLS) Configuration
-- =============================================================================

-- Grant schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Grant table & sequence privileges
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- Ensure future created tables also inherit proper privileges
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- Enable RLS on all persistent tables
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_lifecycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE poi_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminal_setups ENABLE ROW LEVEL SECURITY;

-- Idempotent RLS Policies: Permit full backend read/write operations
-- Service Role bypasses RLS by default in PostgreSQL, but explicit policies ensure no denial.

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'app_settings',
    'account_state',
    'trade_ledger',
    'trade_outcomes',
    'signals',
    'scans',
    'opportunities',
    'telegram_config',
    'candidate_lifecycles',
    'poi_records',
    'terminal_setups'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Drop existing policy if present to allow idempotent re-execution
    EXECUTE format('DROP POLICY IF EXISTS "allow_full_access_%I" ON %I;', tbl, tbl);
    -- Create open read/write policy for backend service and authorized clients
    EXECUTE format('CREATE POLICY "allow_full_access_%I" ON %I FOR ALL USING (true) WITH CHECK (true);', tbl, tbl);
  END LOOP;
END $$;

