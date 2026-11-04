CREATE TABLE "incidentes_motor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origen" text NOT NULL,
	"estado" text DEFAULT 'abierto' NOT NULL,
	"motivo" text NOT NULL,
	"severidad" text NOT NULL,
	"puntos" integer DEFAULT 0 NOT NULL,
	"eventos" integer DEFAULT 0 NOT NULL,
	"trampas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primero" timestamp with time zone NOT NULL,
	"ultimo" timestamp with time zone NOT NULL,
	"actividad" timestamp with time zone DEFAULT now() NOT NULL,
	"abierto" timestamp with time zone DEFAULT now() NOT NULL,
	"cerrado" timestamp with time zone,
	"avisado" timestamp with time zone,
	"pendientes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "puntos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incidentes_motor_abierto" ON "incidentes_motor" USING btree ("origen") WHERE "incidentes_motor"."estado" = 'abierto';--> statement-breakpoint
CREATE INDEX "incidentes_motor_estado" ON "incidentes_motor" USING btree ("estado","actividad");--> statement-breakpoint
CREATE INDEX "incidentes_motor_abierto_en" ON "incidentes_motor" USING btree ("abierto");