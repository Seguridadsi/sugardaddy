ALTER TABLE "reglas" ADD COLUMN "entornos" jsonb;--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "entorno" text;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "entorno" text;