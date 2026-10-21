CREATE TABLE "ejecuciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evento" uuid NOT NULL,
	"regla" text NOT NULL,
	"respuesta" text NOT NULL,
	"modo" text NOT NULL,
	"objetivo" text NOT NULL,
	"estado" text NOT NULL,
	"motivo" text,
	"aprobacion" uuid,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "respuestas_config" (
	"modulo" text PRIMARY KEY NOT NULL,
	"parametros" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secretos_cifrados" text,
	"actualizado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ejecuciones" ADD CONSTRAINT "ejecuciones_evento_eventos_id_fk" FOREIGN KEY ("evento") REFERENCES "public"."eventos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ejecuciones" ADD CONSTRAINT "ejecuciones_regla_reglas_id_fk" FOREIGN KEY ("regla") REFERENCES "public"."reglas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ejecuciones" ADD CONSTRAINT "ejecuciones_aprobacion_aprobaciones_id_fk" FOREIGN KEY ("aprobacion") REFERENCES "public"."aprobaciones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ejecuciones_objetivo" ON "ejecuciones" USING btree ("objetivo","regla","cuando");