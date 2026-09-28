-- ============================================================================
-- CENTERINSIDER SECURITY MIGRATION: ENFORCE STRICT VOTER ANONYMITY (RLS)
-- Prevents Chrome DevTools / Network inspection leaks of voter identities
-- ============================================================================

-- 1. Enable Row Level Security on 'votes' table
ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing overly-permissive policies on votes if any exist
DROP POLICY IF EXISTS "Allow all users to read votes" ON public.votes;
DROP POLICY IF EXISTS "Allow anon read votes" ON public.votes;
DROP POLICY IF EXISTS "Public votes are viewable by everyone" ON public.votes;
DROP POLICY IF EXISTS "Votes viewable by receiver if God Mode" ON public.votes;
DROP POLICY IF EXISTS "Allow vote insertion" ON public.votes;
DROP POLICY IF EXISTS "Allow authenticated or anon to cast votes" ON public.votes;
DROP POLICY IF EXISTS "Only God Mode receivers can read votes directly" ON public.votes;

-- 3. Policy: Allow casting votes (INSERT)
-- Authenticated users or client applications can cast votes
CREATE POLICY "Allow authenticated or anon to cast votes"
ON public.votes
FOR INSERT
WITH CHECK (true);

-- 4. Policy: Strict SELECT access on 'votes' table
-- A user can ONLY query votes where they are the recipient (receiver_id)
-- AND their account has active, verified God Mode (is_pro = true).
-- Standard users are completely blocked from reading the raw 'votes' table directly.
CREATE POLICY "Only God Mode receivers can read votes directly"
ON public.votes
FOR SELECT
USING (
  (
    auth.uid() = receiver_id 
    OR auth.uid()::text = receiver_id::text
  )
  AND EXISTS (
    SELECT 1 FROM public.users u
    WHERE (u.id = auth.uid() OR u.id::text = auth.uid()::text)
      AND u.is_pro = true
  )
);

-- 5. Enable Row Level Security on 'inbox' notifications table
ALTER TABLE IF EXISTS public.inbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can only read their own inbox" ON public.inbox;
CREATE POLICY "Users can only read their own inbox"
ON public.inbox
FOR SELECT
USING (
  auth.uid() = user_id 
  OR auth.uid() = recipient_id
  OR auth.uid()::text = user_id::text
  OR auth.uid()::text = recipient_id::text
);

-- 6. Performance indexes for recipient and privacy queries
CREATE INDEX IF NOT EXISTS idx_votes_receiver_id ON public.votes(receiver_id);
CREATE INDEX IF NOT EXISTS idx_votes_created_at ON public.votes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_is_pro ON public.users(is_pro);
