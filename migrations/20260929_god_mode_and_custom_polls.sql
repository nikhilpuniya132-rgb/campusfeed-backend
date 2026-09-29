-- ============================================================================
-- CENTERINSIDER MIGRATION: GOD MODE AUTO-UPGRADE & CUSTOM POLLS AI MODERATION
-- ============================================================================

-- 1. Add is_god_mode column to users and profiles tables
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS is_god_mode BOOLEAN DEFAULT FALSE;

DO $$ 
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_god_mode BOOLEAN DEFAULT FALSE;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS referred_by TEXT;
  END IF;
END $$;

-- 2. Create custom_polls table
-- Columns: id, question, created_by (references profiles/users), created_at, status
CREATE TABLE IF NOT EXISTS public.custom_polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  created_by UUID REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT CHECK (status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending'
);

-- Indexes for fast lookup & monthly rate limit checking
CREATE INDEX IF NOT EXISTS idx_custom_polls_created_by ON public.custom_polls(created_by);
CREATE INDEX IF NOT EXISTS idx_custom_polls_created_at ON public.custom_polls(created_at);
CREATE INDEX IF NOT EXISTS idx_custom_polls_status ON public.custom_polls(status);
CREATE INDEX IF NOT EXISTS idx_users_is_god_mode ON public.users(is_god_mode);

-- Enable Row Level Security (RLS)
ALTER TABLE public.custom_polls ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Public can view approved custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can insert their own custom polls" ON public.custom_polls;
DROP POLICY IF EXISTS "Users can view their own custom polls" ON public.custom_polls;

-- Policy: Everyone can view approved polls
CREATE POLICY "Public can view approved custom polls"
ON public.custom_polls FOR SELECT
TO anon, authenticated
USING (status = 'approved');

-- Policy: Users can view their own submitted custom polls (regardless of status)
CREATE POLICY "Users can view their own custom polls"
ON public.custom_polls FOR SELECT
TO authenticated
USING (auth.uid() = created_by);

-- Policy: Users can insert their own custom polls
CREATE POLICY "Users can insert their own custom polls"
ON public.custom_polls FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = created_by);


-- 3. God Mode Auto-Upgrade (25 Invites) Database Trigger Function
-- Logic: When a referred user signs up (referred_by is set), count total user profiles
-- that share this specific referred_by ID. If count >= 25, automatically update
-- the referring user's profile to set is_god_mode = TRUE.
CREATE OR REPLACE FUNCTION public.check_god_mode_auto_upgrade()
RETURNS TRIGGER AS $$
DECLARE
  v_ref TEXT;
  v_count INTEGER;
  v_referrer_id UUID;
BEGIN
  -- Extract referral code/id
  v_ref := COALESCE(NEW.referred_by, NEW.invite_code_used);
  IF v_ref IS NULL OR TRIM(v_ref) = '' THEN
    RETURN NEW;
  END IF;

  v_ref := LTRIM(TRIM(v_ref), '@');

  -- Count total profiles sharing this referred_by ID or code
  SELECT COUNT(*) INTO v_count
  FROM public.users
  WHERE (
    referred_by = v_ref 
    OR referred_by ILIKE v_ref
    OR invite_code_used = v_ref
    OR invite_code_used ILIKE v_ref
  );

  -- Also check if referrer can be located by id, handle, or invite_code
  SELECT id INTO v_referrer_id
  FROM public.users
  WHERE (
    id::text = v_ref
    OR handle ILIKE v_ref
    OR invite_code ILIKE v_ref
    OR my_invite_code ILIKE v_ref
  )
  LIMIT 1;

  -- If count reaches 25 or more, automatically upgrade referring user's profile
  IF v_count >= 25 AND v_referrer_id IS NOT NULL THEN
    UPDATE public.users
    SET 
      is_god_mode = TRUE,
      is_pro = TRUE,
      is_batch_captain = TRUE
    WHERE id = v_referrer_id;

    -- Also update profiles table if present
    BEGIN
      IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles') THEN
        UPDATE public.profiles
        SET is_god_mode = TRUE
        WHERE id = v_referrer_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Silently proceed if profiles table is not used
    END;

    -- Insert inbox notification for Referrer
    BEGIN
      INSERT INTO public.inbox (user_id, recipient_id, sender_id, sender_name, text, created_at)
      VALUES (
        v_referrer_id,
        v_referrer_id,
        NEW.id,
        'CenterInsider VIP',
        '👑 GOD MODE UNLOCKED: You invited 25+ friends! You now have permanent God Mode and AI Custom Poll creation privileges!',
        NOW()
      );
    EXCEPTION WHEN OTHERS THEN
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach trigger to users table
DROP TRIGGER IF EXISTS trg_check_god_mode_auto_upgrade ON public.users;
CREATE TRIGGER trg_check_god_mode_auto_upgrade
AFTER INSERT OR UPDATE OF referred_by, invite_code_used ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.check_god_mode_auto_upgrade();
