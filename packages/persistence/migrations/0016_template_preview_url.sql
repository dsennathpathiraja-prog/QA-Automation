-- Optional notification/email template preview URL per environment (Phase 8 E2).
ALTER TABLE "environment" ADD COLUMN IF NOT EXISTS "template_preview_url" text;
