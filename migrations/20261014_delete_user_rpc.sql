-- ============================================================================
-- CENTERINSIDER MIGRATION: SECURE USER DELETION RPC
-- Allows authenticated users to permanently delete their auth.users identity
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_user()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  current_user_id uuid;
BEGIN
  -- Obtain caller's authenticated user ID
  current_user_id := auth.uid();
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 1. Clean up public records associated with the user (if not already cascaded)
  DELETE FROM public.votes WHERE voter_id::text = current_user_id::text OR receiver_id::text = current_user_id::text;
  DELETE FROM public.users WHERE id::text = current_user_id::text;

  -- 2. Delete user from auth.users to ensure Google OAuth doesn't log into a ghost account
  DELETE FROM auth.users WHERE id = current_user_id;
END;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.delete_user() TO authenticated;
