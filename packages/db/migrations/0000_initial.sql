-- The whole schema, in one migration.
--
-- Aeolus was squashed to a single initial migration for its first public
-- release: there was no installed base to migrate from, and twenty-nine
-- create-then-alter steps against the same tables is a slower first boot and
-- a longer thing to read. Every later change gets its own numbered migration,
-- generated with `pnpm --filter @aeolus/db exec drizzle-kit generate`.
--
-- The migrator takes a Postgres advisory lock, so the api, the websocket
-- process and the worker can all run this at boot and only one of them will.

CREATE TABLE "ai_global_spend" (
	"day_utc" date PRIMARY KEY NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_quota" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"per_hour" integer DEFAULT 30 NOT NULL,
	"per_day" integer DEFAULT 200 NOT NULL,
	"tokens_per_day" integer DEFAULT 50000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_quota_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd_cents" integer NOT NULL,
	"instruction" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text DEFAULT 'read' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_by_email" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_scope_check" CHECK ("api_tokens"."scope" in ('read','write'))
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "app_settings_singleton_check" CHECK ("app_settings"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "compile_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"engine" text NOT NULL,
	"rev" bigint NOT NULL,
	"status" text NOT NULL,
	"pdf_key" text,
	"synctex_key" text,
	"error" text,
	"warnings" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compile_results_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "compile_results_engine_check" CHECK ("compile_results"."engine" in ('latex','typst')),
	CONSTRAINT "compile_results_status_check" CHECK ("compile_results"."status" in ('queued','running','success','failed'))
);
--> statement-breakpoint
CREATE TABLE "doc_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"yjs_doc_id" uuid NOT NULL,
	"label" text NOT NULL,
	"snapshot_key" text NOT NULL,
	"created_by" uuid,
	"project_checkpoint_id" uuid,
	"kind" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_checkpoints_kind_check" CHECK ("doc_checkpoints"."kind" in ('user','auto_open'))
);
--> statement-breakpoint
CREATE TABLE "doc_collaborators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_collaborators_doc_user_unique" UNIQUE("doc_id","user_id"),
	CONSTRAINT "doc_collaborators_role_check" CHECK ("doc_collaborators"."role" in ('viewer','editor'))
);
--> statement-breakpoint
CREATE TABLE "doc_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"yjs_doc_id" uuid,
	"storage_key" text,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_files_doc_id_path_unique" UNIQUE("doc_id","path"),
	CONSTRAINT "doc_files_yjs_doc_id_unique" UNIQUE("yjs_doc_id"),
	CONSTRAINT "doc_files_kind_check" CHECK ("doc_files"."kind" in ('text','blob','folder')),
	CONSTRAINT "doc_files_kind_payload_check" CHECK (("doc_files"."kind" = 'text' AND "doc_files"."yjs_doc_id" IS NOT NULL AND "doc_files"."storage_key" IS NULL)
          OR
          ("doc_files"."kind" = 'blob' AND "doc_files"."storage_key" IS NOT NULL AND "doc_files"."yjs_doc_id" IS NULL)
          OR
          ("doc_files"."kind" = 'folder' AND "doc_files"."yjs_doc_id" IS NULL AND "doc_files"."storage_key" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "doc_project_checkpoint_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_checkpoint_id" uuid NOT NULL,
	"path" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text,
	"mime_type" text,
	"size_bytes" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_project_checkpoint_blobs_project_path_unique" UNIQUE("project_checkpoint_id","path")
);
--> statement-breakpoint
CREATE TABLE "doc_project_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"yjs_doc_id" uuid NOT NULL,
	"snapshot_seq" bigint NOT NULL,
	"snapshot_key" text NOT NULL,
	"bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_snapshots_yjs_doc_id_unique" UNIQUE("yjs_doc_id")
);
--> statement-breakpoint
CREATE TABLE "doc_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"yjs_doc_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_updates_yjs_doc_id_seq_unique" UNIQUE("yjs_doc_id","seq")
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"engine" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"is_template_doc" boolean DEFAULT false NOT NULL,
	"forked_from_template" uuid,
	"deleted_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_engine_check" CHECK ("docs"."engine" in ('latex','typst'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"disable_rotation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"engine" text NOT NULL,
	"thumbnail_key" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"yjs_doc_id" uuid NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_yjs_doc_id_unique" UNIQUE("yjs_doc_id"),
	CONSTRAINT "templates_engine_check" CHECK ("templates"."engine" in ('latex','typst'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"passphrase_hash" text,
	"passphrase_set_at" timestamp with time zone,
	"must_set_passphrase" boolean DEFAULT false NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"is_admin" boolean DEFAULT false NOT NULL,
	"anthropic_consent_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ws_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ws_tickets_ticket_hash_unique" UNIQUE("ticket_hash")
);
--> statement-breakpoint
ALTER TABLE "ai_quota" ADD CONSTRAINT "ai_quota_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_results" ADD CONSTRAINT "compile_results_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_checkpoints" ADD CONSTRAINT "doc_checkpoints_yjs_doc_id_doc_files_yjs_doc_id_fk" FOREIGN KEY ("yjs_doc_id") REFERENCES "public"."doc_files"("yjs_doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_checkpoints" ADD CONSTRAINT "doc_checkpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_checkpoints" ADD CONSTRAINT "doc_checkpoints_project_checkpoint_id_doc_project_checkpoints_id_fk" FOREIGN KEY ("project_checkpoint_id") REFERENCES "public"."doc_project_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_collaborators" ADD CONSTRAINT "doc_collaborators_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_collaborators" ADD CONSTRAINT "doc_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_files" ADD CONSTRAINT "doc_files_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_files" ADD CONSTRAINT "doc_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_project_checkpoint_blobs" ADD CONSTRAINT "doc_project_checkpoint_blobs_project_checkpoint_id_doc_project_checkpoints_id_fk" FOREIGN KEY ("project_checkpoint_id") REFERENCES "public"."doc_project_checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_project_checkpoint_blobs" ADD CONSTRAINT "doc_project_checkpoint_blobs_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_project_checkpoints" ADD CONSTRAINT "doc_project_checkpoints_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_project_checkpoints" ADD CONSTRAINT "doc_project_checkpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_yjs_doc_id_doc_files_yjs_doc_id_fk" FOREIGN KEY ("yjs_doc_id") REFERENCES "public"."doc_files"("yjs_doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_yjs_doc_id_doc_files_yjs_doc_id_fk" FOREIGN KEY ("yjs_doc_id") REFERENCES "public"."doc_files"("yjs_doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_forked_from_template_templates_id_fk" FOREIGN KEY ("forked_from_template") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_yjs_doc_id_docs_id_fk" FOREIGN KEY ("yjs_doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_requests_user_created_at_idx" ON "ai_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "api_tokens_created_at_idx" ON "api_tokens" USING btree ("created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "api_tokens_created_by_idx" ON "api_tokens" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events" USING btree ("actor_id","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "audit_events_action_occurred_at_idx" ON "audit_events" USING btree ("action","occurred_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "compile_results_status_created_at_idx" ON "compile_results" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "compile_results_doc_id_idx" ON "compile_results" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "compile_results_doc_id_created_at_idx" ON "compile_results" USING btree ("doc_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "doc_checkpoints_yjs_doc_id_created_at_idx" ON "doc_checkpoints" USING btree ("yjs_doc_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "doc_checkpoints_project_checkpoint_id_idx" ON "doc_checkpoints" USING btree ("project_checkpoint_id");--> statement-breakpoint
CREATE INDEX "doc_checkpoints_kind_created_at_idx" ON "doc_checkpoints" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "doc_collaborators_user_id_idx" ON "doc_collaborators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "doc_files_doc_id_idx" ON "doc_files" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "doc_project_checkpoint_blobs_storage_key_idx" ON "doc_project_checkpoint_blobs" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "doc_project_checkpoints_doc_id_created_at_idx" ON "doc_project_checkpoints" USING btree ("doc_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "docs_archived_at_idx" ON "docs" USING btree ("archived_at") WHERE "docs"."archived_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_last_seen_at_idx" ON "sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "ws_tickets_expires_at_idx" ON "ws_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ws_tickets_user_doc_idx" ON "ws_tickets" USING btree ("user_id","doc_id");