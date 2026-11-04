CREATE TABLE "enlaces_usados" (
	"huella" text PRIMARY KEY NOT NULL,
	"incidente" uuid NOT NULL,
	"accion" text NOT NULL,
	"quien" text NOT NULL,
	"usado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "atendido" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "atendido_por" text;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "atendido_como" text;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "escalado" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "escalados" integer DEFAULT 0 NOT NULL;