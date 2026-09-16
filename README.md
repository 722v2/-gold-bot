# Gold AI Challenges & Scalping Assistant

Real-time XAU/USD algorithmic scalping assistant with institutional liquidity analysis, AI confluence verification, risk controls, and Supabase PostgreSQL persistence.

---

## Supabase PostgreSQL Data Migration

Follow these steps to migrate historical trades, signals, scans, and account state (`$91.00` balance) to your Supabase PostgreSQL instance using GitHub Actions:

### 1. Execute SQL Schema in Supabase
Before running the data migration, initialize your Supabase tables:
1. Go to your **Supabase Dashboard** -> **SQL Editor**.
2. Paste the contents of `supabase/schema.sql` and click **Run**.
3. Confirm all 11 tables (`app_settings`, `account_state`, `trade_ledger`, `trade_outcomes`, `signals`, `scans`, `opportunities`, `telegram_config`, `candidate_lifecycles`, `poi_records`, `terminal_setups`) are created.

### 2. Configure GitHub Actions Secrets
In your GitHub repository:
1. Navigate to **Settings** -> **Secrets and variables** -> **Actions**.
2. Click **New repository secret** and add:
   - `SUPABASE_URL`: Your Supabase Project URL (e.g. `https://your-project-id.supabase.co`)
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase **service_role** secret key (from **Supabase Dashboard** -> **Project Settings** -> **API** -> `service_role secret`)

### 3. Run the Migration Workflow
1. Go to the **Actions** tab in your GitHub repository.
2. Select **One-Time Supabase Migration** in the left sidebar.
3. Click **Run workflow** (leave the input as `MIGRATE` or confirm) and click the green **Run workflow** button.
4. Wait for the job to complete green.

### 4. Verify Migration Success in Supabase
Open your **Supabase Dashboard** -> **Table Editor**:
- `account_state`: Contains `id = 'main'`, `current_balance = 91.00`, `starting_balance = 25.00`.
- `trade_ledger`: Contains historical closed and open trades.
- `trade_outcomes`: Contains trade outcome history.
- `signals` & `scans`: Populated with historical scanner data.
- `app_settings`: Contains your app settings configuration.
