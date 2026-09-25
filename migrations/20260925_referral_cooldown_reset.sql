-- ============================================================================
-- CENTERINSIDER MIGRATION: SECURE REFERRAL LOOP & BACKEND TIMER UNLOCK
-- 
-- Logic: When User B joins / authenticates with referred_by = 'User_A_Code',
-- automatically reset User A's cooldown_until / cooldown_expires_at timestamp
-- and session_vote_count to 0 to allow immediate voting without delay.
-- ============================================================================

-- 1. Ensure required referral & cooldown tracking columns exist
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS referred_by TEXT;

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS invite_code_used TEXT;

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ;

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS cooldown_expires_at TIMESTAMPTZ;

ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS session_vote_count INTEGER DEFAULT 0;

-- 2. Indexes for fast referral code resolution
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON public.users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_invite_code ON public.users(invite_code);
CREATE INDEX IF NOT EXISTS idx_users_handle ON public.users(handle);
CREATE INDEX IF NOT EXISTS idx_users_cooldown_until ON public.users(cooldown_until);

-- 3. Trigger Function: Reset Referrer Cooldown and Award Bonus on Authenticated Referral
CREATE OR REPLACE FUNCTION public.reset_referrer_cooldown_on_referral()
RETURNS TRIGGER AS $$
DECLARE
  v_ref_code TEXT;
  v_referrer_id UUID;
BEGIN
  -- Extract referral code from referred_by or invite_code_used
  v_ref_code := COALESCE(NEW.referred_by, NEW.invite_code_used);
  
  -- Clean prefix if present
  IF v_ref_code IS NOT NULL THEN
    v_ref_code := LTRIM(TRIM(v_ref_code), '@');
  END IF;

  -- Exit if no referral code provided
  IF v_ref_code IS NULL OR v_ref_code = '' THEN
    RETURN NEW;
  END IF;

  -- Find referrer by invite_code, handle, or my_invite_code (excluding self-referrals)
  SELECT id INTO v_referrer_id
  FROM public.users
  WHERE (
    invite_code ILIKE v_ref_code
    OR handle ILIKE v_ref_code
    OR my_invite_code ILIKE v_ref_code
  )
  AND id != NEW.id
  LIMIT 1;

  -- If referrer is found, immediately clear their cooldown and reset session votes
  IF v_referrer_id IS NOT NULL THEN
    UPDATE public.users
    SET 
      cooldown_until = NULL,
      cooldown_expires_at = NULL,
      session_vote_count = 0,
      invites = COALESCE(invites, 0) + 1,
      feed_drops = COALESCE(feed_drops, 0) + 50
    WHERE id = v_referrer_id;

    -- Insert inbox notification for Referrer
    BEGIN
      INSERT INTO public.inbox (user_id, recipient_id, sender_id, sender_name, text, created_at)
      VALUES (
        v_referrer_id,
        v_referrer_id,
        NEW.id,
        COALESCE(NEW.handle, 'A friend'),
        '⚡ Friend joined with your invite! Cooldown cleared & voting unlocked!',
        NOW()
      );
    EXCEPTION WHEN OTHERS THEN
      -- Silently ignore if inbox table has differing constraints
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach trigger to users table on INSERT or UPDATE of referral code
DROP TRIGGER IF EXISTS trg_reset_referrer_cooldown ON public.users;
CREATE TRIGGER trg_reset_referrer_cooldown
AFTER INSERT OR UPDATE OF referred_by, invite_code_used ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.reset_referrer_cooldown_on_referral();
