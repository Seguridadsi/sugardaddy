CREATE TABLE "notas_incidente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incidente" uuid NOT NULL,
	"texto" text NOT NULL,
	"quien" text NOT NULL,
	"via" text DEFAULT 'consola' NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "tipo" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "redes" jsonb;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "ultima_ip" text;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "anterior_hash" text;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "anterior_hasta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "rotado" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "rotado_por" text;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "propietario_oid" text;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "propietario_nombre" text;--> statement-breakpoint
ALTER TABLE "tokens_api" ADD COLUMN "propietario_correo" text;--> statement-breakpoint
ALTER TABLE "triaje" ADD COLUMN "via" text DEFAULT 'consola' NOT NULL;--> statement-breakpoint
ALTER TABLE "notas_incidente" ADD CONSTRAINT "notas_incidente_incidente_incidentes_motor_id_fk" FOREIGN KEY ("incidente") REFERENCES "public"."incidentes_motor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notas_incidente_incidente" ON "notas_incidente" USING btree ("incidente","creado");--> statement-breakpoint
CREATE INDEX "tokens_api_anterior" ON "tokens_api" USING btree ("anterior_hash");