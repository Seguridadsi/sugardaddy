-- «Probar» y la señal por otra trampa (docs/diseno/modulo-despliegue.md §9.2).
-- La consola anterior sigue igual con esto: no escribe eventos.prueba (false),
-- y su retirarTrampa borra las pruebas con la trampa (ON DELETE CASCADE).
CREATE TABLE "activaciones" (
	"evento" uuid NOT NULL,
	"trampa" text NOT NULL,
	"recibido" timestamp with time zone NOT NULL,
	CONSTRAINT "activaciones_evento_trampa_pk" PRIMARY KEY("evento","trampa")
);
--> statement-breakpoint
CREATE TABLE "pruebas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trampa" text NOT NULL,
	"nonce" text NOT NULL,
	"ip" text,
	"marca" jsonb,
	"desde" timestamp with time zone DEFAULT now() NOT NULL,
	"hasta" timestamp with time zone NOT NULL,
	"evento" uuid,
	"quien" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eventos" ADD COLUMN "prueba" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activaciones" ADD CONSTRAINT "activaciones_evento_eventos_id_fk" FOREIGN KEY ("evento") REFERENCES "public"."eventos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pruebas" ADD CONSTRAINT "pruebas_trampa_trampas_id_fk" FOREIGN KEY ("trampa") REFERENCES "public"."trampas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activaciones_trampa" ON "activaciones" USING btree ("trampa","recibido");--> statement-breakpoint
CREATE INDEX "pruebas_abiertas" ON "pruebas" USING btree ("trampa","hasta");
