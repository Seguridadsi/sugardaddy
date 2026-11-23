CREATE TABLE "colocaciones" (
	"id" text PRIMARY KEY NOT NULL,
	"trampa" text,
	"trampa_nombre" text NOT NULL,
	"modulo" text NOT NULL,
	"destino" text,
	"destino_nombre" text,
	"baliza" text,
	"via" text NOT NULL,
	"ejecutor" text NOT NULL,
	"ubicacion" text NOT NULL,
	"referencia" jsonb,
	"plantilla_version" text,
	"sha256" text,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"motivo" text,
	"sembrada" timestamp with time zone,
	"vista" timestamp with time zone,
	"sustituye" text,
	"retirada" timestamp with time zone,
	"retirada_por" text,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "colocaciones_estado" CHECK ("colocaciones"."estado" IN ('pendiente','colocada','retirando','retirada','sustituida','perdida'))
);
--> statement-breakpoint
ALTER TABLE "destinos" ADD COLUMN "conexion" jsonb;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "caduca" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "rotar_dias" integer;--> statement-breakpoint
ALTER TABLE "colocaciones" ADD CONSTRAINT "colocaciones_trampa_trampas_id_fk" FOREIGN KEY ("trampa") REFERENCES "public"."trampas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colocaciones" ADD CONSTRAINT "colocaciones_destino_destinos_id_fk" FOREIGN KEY ("destino") REFERENCES "public"."destinos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "colocaciones_trampa" ON "colocaciones" USING btree ("trampa");--> statement-breakpoint
CREATE INDEX "colocaciones_destino" ON "colocaciones" USING btree ("destino");--> statement-breakpoint
ALTER TABLE "trampas" ADD CONSTRAINT "trampas_rotar_dias" CHECK ("trampas"."rotar_dias" IS NULL OR "trampas"."rotar_dias" BETWEEN 1 AND 3650);--> statement-breakpoint
-- Las colocaciones de antes del inventario (D7): una por cada trampa sembrada (todo lo que no es
-- de contenedor), con la ruta que se dio al ponerla y el nombre del fichero si lo hay, el sha256 de
-- su documento y su estado de hoy. La versión de la plantilla no se sabía: queda nula («de antes»).
INSERT INTO "colocaciones" ("id", "trampa", "trampa_nombre", "modulo", "destino", "destino_nombre", "baliza", "via", "ejecutor", "ubicacion", "sha256", "estado", "sembrada", "creado")
SELECT
	'col-' || substr(md5(t."id" || clock_timestamp()::text || random()::text), 1, 16),
	t."id", t."nombre", t."modulo", t."destino", d."nombre", b."token", t."via", t."ejecutor",
	CASE
		WHEN NULLIF(t."parametros"->>'ruta', '') IS NULL THEN '(not recorded)'
		WHEN b."nombre" IS NULL OR right(t."parametros"->>'ruta', length(b."nombre")) = b."nombre" THEN t."parametros"->>'ruta'
		WHEN strpos(t."parametros"->>'ruta', E'\\') > 0 THEN rtrim(t."parametros"->>'ruta', E'\\') || E'\\' || b."nombre"
		ELSE rtrim(t."parametros"->>'ruta', '/') || '/' || b."nombre"
	END,
	b."sha256",
	CASE t."colocacion"
		WHEN 'por-colocar' THEN 'pendiente'
		WHEN 'retirando' THEN 'retirando'
		ELSE 'colocada'
	END,
	CASE WHEN t."colocacion" IN ('colocada', 'comprobada', 'degradada', 'retirando') THEN COALESCE(t."colocacion_cuando", t."creado") END,
	t."creado"
FROM "trampas" t
LEFT JOIN "balizas" b ON b."trampa" = t."id"
LEFT JOIN "destinos" d ON d."id" = t."destino"
WHERE t."tipo" <> 'contenedor';
