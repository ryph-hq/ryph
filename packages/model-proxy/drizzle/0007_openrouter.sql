CREATE TABLE "openrouter_models" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"context_length" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"vision" boolean NOT NULL,
	"reasoning" boolean NOT NULL,
	"tools" boolean NOT NULL,
	"price" jsonb,
	"listed" boolean DEFAULT true NOT NULL,
	"missed_syncs" integer DEFAULT 0 NOT NULL,
	"seen_at" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openrouter_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"synced_at" text,
	"attempted_at" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "proxy_usage" ADD COLUMN "cost_usd" double precision;