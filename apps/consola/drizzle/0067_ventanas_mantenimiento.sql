CREATE TABLE "ventanas_mantenimiento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"alcance" text NOT NULL,
	"objetivos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"desde" timestamp with time zone NOT NULL,
	"hasta" timestamp with time zone NOT NULL,
	"nota" text,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"cerrada_por" text,
	"avisado_inicio" timestamp with time zone,
	"callado" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resumen" jsonb,
	"terminado" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ventanas_mantenimiento_hasta" ON "ventanas_mantenimiento" USING btree ("hasta");