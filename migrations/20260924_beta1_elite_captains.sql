-- ============================================================================
-- CENTERINSIDER BETA 1.0 MIGRATION: Elite Batch Captain & Moderator Gate
-- Threshold: Exactly 25 verified active recruits (Google Auth + 3 votes cast)
-- Includes Admin Override boolean for manual moderator status assignment
-- ============================================================================

-- 1. Add 'is_batch_captain' flag (Defaults to FALSE)
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS is_batch_captain BOOLEAN DEFAULT FALSE;

-- 2. Add 'batch_captain_admin_override' flag for manual admin granting (Defaults to FALSE)
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS batch_captain_admin_override BOOLEAN DEFAULT FALSE;

-- 3. Create performance indexes for quick lookup
CREATE INDEX IF NOT EXISTS idx_users_is_batch_captain ON public.users(is_batch_captain);
CREATE INDEX IF NOT EXISTS idx_users_batch_captain_override ON public.users(batch_captain_admin_override);

-- 4. Automatically backfill existing accounts with 25+ verified recruits or admin override
UPDATE public.users
SET is_batch_captain = TRUE
WHERE (invites >= 25) OR (batch_captain_admin_override = TRUE);

-- 5. Trigger Function: Maintain is_batch_captain integrity automatically
CREATE OR REPLACE FUNCTION public.check_elite_batch_captain_status()
RETURNS TRIGGER AS $$
BEGIN
  -- An Elite Batch Captain requires either 25 active recruits OR an admin override
  IF NEW.invites >= 25 OR NEW.batch_captain_admin_override = TRUE THEN
    NEW.is_batch_captain := TRUE;
  ELSE
    -- Only revert if admin override is explicitly false and invites are below 25
    IF NEW.batch_captain_admin_override = FALSE AND (NEW.invites IS NULL OR NEW.invites < 25) THEN
      NEW.is_batch_captain := FALSE;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 6. Attach trigger to users table on insert or update of invites or override
DROP TRIGGER IF EXISTS trg_check_elite_batch_captain ON public.users;
CREATE TRIGGER trg_check_elite_batch_captain
BEFORE INSERT OR UPDATE OF invites, batch_captain_admin_override ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.check_elite_batch_captain_status();

-- ============================================================================
-- ADMIN OVERRIDE INSTRUCTIONS:
-- To manually grant Elite Batch Captain status to any student:
-- UPDATE public.users SET batch_captain_admin_override = TRUE WHERE handle = 'target_handle';
--
-- To revoke manual grant:
-- UPDATE public.users SET batch_captain_admin_override = FALSE WHERE handle = 'target_handle';
-- ============================================================================
