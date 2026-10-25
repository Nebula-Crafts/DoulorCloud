-- 0168_starcoin.sql（2026-10-25 模拟人生 · 星币体系）
--
-- 星币 = 游戏筹码，100% 积分储备支撑：
--   · 兑入 N 积分 → 铸 N×starRate 星币（积分从流通中封存，reason=star_in）
--   · 兑出 M 星币 → 烧 M 星币，解封 M/starRate 积分（reason=star_out）
--   · 不变量：全站积分总量 + (Σ未兑出星币 ÷ starRate) = 常数
--
-- 每游戏独立钱包（game_slug 是主键的一部分）：
--   跨游戏不流通，价值只能经积分中枢（兑出→兑入）流转。
--
-- 本迁移同时重置旧游戏数据（站长确认）：行情/持仓/流水/池账/K线清零，
-- 星币钱包从零开始；旧双模货币（points/test）退役。

-- 1) 每游戏星币钱包
CREATE TABLE IF NOT EXISTS game_wallets (
  game_slug  TEXT    NOT NULL,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (game_slug, user_id)
);
CREATE INDEX IF NOT EXISTS idx_game_wallets_user ON game_wallets(user_id);

-- 2) 旧测试币表退役
DROP TABLE IF EXISTS game_test_balances;

-- 3) 旧双模货币设置退役
DELETE FROM app_settings WHERE key IN ('game_currency', 'game_test_grant');

-- 4) 游戏数据重置（守恒等式的旧账本一并清零，新体系从零起算）
DELETE FROM game_positions;
DELETE FROM game_trades;
DELETE FROM game_pool_ledger;
DELETE FROM game_candles;
DELETE FROM game_market;
