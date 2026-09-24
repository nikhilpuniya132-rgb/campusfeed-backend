-- ============================================================================
-- CAMPUSFEED BETA 1.0 MIGRATION: City-Based Sponsors & Non-Monetary Feed Drops
-- Compliant with RBI Virtual Economy Guidelines & Anti-Cheat Referral Engine
-- ============================================================================

-- 1. Add 'city' column with default 'Bathinda'
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS city TEXT DEFAULT 'Bathinda';

-- 2. Add 'feed_drops' integer column (Non-monetary virtual campus drops)
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS feed_drops INTEGER DEFAULT 0;

-- 3. Add 'referral_rewarded' boolean flag for anti-cheat verification
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT false;

-- 4. Backfill existing users: city from district if available
UPDATE public.users 
SET city = COALESCE(NULLIF(city, ''), NULLIF(district, ''), 'Bathinda')
WHERE city IS NULL OR city = '';

-- 5. Backfill Feed Drops: 50 Feed Drops for each existing verified invite
UPDATE public.users 
SET feed_drops = COALESCE(feed_drops, 0) + (COALESCE(invites, 0) * 50)
WHERE feed_drops IS NULL OR feed_drops = 0;

-- 6. Performance indexes for Leaderboards, City Sponsors & Anti-Cheat Queries
CREATE INDEX IF NOT EXISTS idx_users_city ON public.users(city);
CREATE INDEX IF NOT EXISTS idx_users_invites ON public.users(invites DESC);
CREATE INDEX IF NOT EXISTS idx_users_feed_drops ON public.users(feed_drops DESC);
CREATE INDEX IF NOT EXISTS idx_users_invite_code_used ON public.users(invite_code_used);
CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON public.votes(voter_id);
