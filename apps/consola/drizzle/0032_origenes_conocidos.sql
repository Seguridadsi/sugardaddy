CREATE TABLE "origenes_conocidos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"patron" text NOT NULL,
	"horario" jsonb,
	"caduca" timestamp with time zone,
	"activo" boolean DEFAULT true NOT NULL,
	"nota" text,
	"procedencia" text DEFAULT 'manual' NOT NULL,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "origenes_conocidos_activo" ON "origenes_conocidos" USING btree ("activo");