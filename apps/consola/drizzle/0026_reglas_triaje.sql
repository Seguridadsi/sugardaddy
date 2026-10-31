CREATE TABLE "reglas_triaje" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criterio" text NOT NULL,
	"valor" text NOT NULL,
	"estado" text NOT NULL,
	"nota" text,
	"activa" boolean DEFAULT true NOT NULL,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reglas_triaje_activa" ON "reglas_triaje" USING btree ("activa");