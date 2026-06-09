-- =============================================================================
-- AI Orchestrator — Phase 7.1 patch file full content (Postgres / Supabase).
-- Additive + manual. The worker applies this (redacted) content into the
-- sandbox workspace before running tests.
-- =============================================================================

alter table public.ai_patch_files
  add column if not exists new_content_redacted text;
