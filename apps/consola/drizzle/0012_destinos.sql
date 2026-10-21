CREATE TABLE "destinos" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"tipo" text NOT NULL,
	"sensor" text,
	"descripcion" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sensores" ADD COLUMN "version_agente" text;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "destino" text;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "via" text DEFAULT 'contenedor' NOT NULL;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "ejecutor" text DEFAULT 'contenedor@1' NOT NULL;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "colocacion" text DEFAULT 'por-colocar' NOT NULL;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "colocacion_motivo" text;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "colocacion_cuando" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "comprobada" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "manual" jsonb;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "senal_trampa" text;--> statement-breakpoint
ALTER TABLE "destinos" ADD CONSTRAINT "destinos_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "destinos_sensor" ON "destinos" USING btree ("sensor") WHERE "destinos"."sensor" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "trampas" ADD CONSTRAINT "trampas_destino_destinos_id_fk" FOREIGN KEY ("destino") REFERENCES "public"."destinos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trampas" ADD CONSTRAINT "trampas_senal_trampa_trampas_id_fk" FOREIGN KEY ("senal_trampa") REFERENCES "public"."trampas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trampas_destino" ON "trampas" USING btree ("destino");--> statement-breakpoint
CREATE INDEX "trampas_senal_trampa" ON "trampas" USING btree ("senal_trampa") WHERE "trampas"."senal_trampa" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "trampas" ADD CONSTRAINT "trampas_colocacion" CHECK ("trampas"."colocacion" IN ('por-colocar','colocada','comprobada','degradada','retirando'));--> statement-breakpoint
-- Relleno (escrito a mano; docs/diseno/modulo-despliegue.md §9.1). La tabla es
-- nueva, así que el id de cada sensor está libre en destinos; después ningún
-- código supone que coinciden.
INSERT INTO "destinos" ("id", "nombre", "tipo", "sensor", "creado")
	SELECT "id", "nombre", 'maquina', "id", "creado" FROM "sensores";--> statement-breakpoint
UPDATE "trampas" t SET "destino" = d."id" FROM "destinos" d WHERE d."sensor" = t."sensor";--> statement-breakpoint
-- El primer evento real de cada trampa desde que se creó (un id de trampa se
-- puede reutilizar tras retirarla). Con una sola pasada sobre eventos: una
-- subconsulta por trampa recorrería todos sus eventos uno a uno, y la
-- migración tiene que acabar antes de que el actualizador deje de esperar.
UPDATE "trampas" t SET "comprobada" = p."primero"
	FROM (
		SELECT x."id", min(e."recibido") AS "primero"
		FROM "trampas" x
		JOIN "eventos" e ON e."trampa" = x."id" AND e."sensor" = x."sensor" AND e."recibido" >= x."creado"
		GROUP BY x."id"
	) p
	WHERE p."id" = t."id";--> statement-breakpoint
-- Lo que dice «donde» hoy: «en espera: …» la deja fuera el plan (el sensor
-- quitó su contenedor), «parada: …» la ha parado el sensor y «error…» no
-- funciona; «desplegando…» y «aplicando cambios…» aún no han llegado.
UPDATE "trampas" SET "colocacion" = CASE
		WHEN NOT "activo" OR "donde" LIKE 'en espera: %' THEN 'por-colocar'
		WHEN ("donde" LIKE 'error%' OR "donde" LIKE 'parada: %') AND "comprobada" IS NOT NULL THEN 'degradada'
		WHEN "donde" LIKE 'error%' OR "donde" LIKE 'parada: %' OR "donde" IN ('desplegando…', 'aplicando cambios…') THEN 'por-colocar'
		WHEN "comprobada" IS NOT NULL THEN 'comprobada'
		ELSE 'colocada' END,
	"colocacion_cuando" = now();
