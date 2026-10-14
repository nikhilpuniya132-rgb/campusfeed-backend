-- ============================================================================
-- CENTERINSIDER MIGRATION: SECURE USER DELETION RPC
-- Allows authenticated users to permanently delete their auth.users identity
-- and thoroughly wipe all public profile, vote, and interaction records.
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

  -- 1. Clean up public records associated with the user across all tables
  DELETE FROM public.handshakes WHERE sender_id::text = current_user_id::text OR receiver_id::text = current_user_id::text;
  DELETE FROM public.votes WHERE voter_id::text = current_user_id::text OR receiver_id::text = current_user_id::text;
  DELETE FROM public.inbox WHERE user_id::text = current_user_id::text OR recipient_id::text = current_user_id::text;
  DELETE FROM public.custom_polls WHERE created_by::text = current_user_id::text;
  DELETE FROM public.profiles WHERE id::text = current_user_id::text;
  DELETE FROM public.users WHERE id::text = current_user_id::text OR google_id::text = current_user_id::text;

  -- 2. Delete user from auth.users to ensure Google OAuth doesn't log into a ghost account
  DELETE FROM auth.users WHERE id = current_user_id;
END;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.delete_user() TO authenticated;
