-- Salidas: avisos y SIEM (docs/diseno/avisos-y-siem.md). Solo tablas nuevas y
-- sin claves hacia las de antes: la consola anterior (el actualizador vuelve a
-- ella sin restaurar la base de datos) no las ve y sigue igual.
CREATE TABLE "avisos_salud" (
	"clave" text PRIMARY KEY NOT NULL,
	"codigo" text NOT NULL,
	"desde" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salidas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tipo" text NOT NULL,
	"nombre" text NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"configuracion" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secretos_cifrados" text,
	"secretos_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reglas" jsonb NOT NULL,
	"agrupacion" jsonb DEFAULT '{"modo":"inmediato"}'::jsonb NOT NULL,
	"tope" integer DEFAULT 10000 NOT NULL,
	"ultimo_envio" timestamp with time zone,
	"enviados" bigint DEFAULT 0 NOT NULL,
	"ultimo_error" text,
	"ultimo_error_cuando" timestamp with time zone,
	"fallos_seguidos" integer DEFAULT 0 NOT NULL,
	"siguiente_intento" timestamp with time zone,
	"trabajando_hasta" timestamp with time zone,
	"en_vuelo" bigint,
	"descartados" jsonb,
	"ultimo_descarte" jsonb,
	"ultima_prueba" jsonb,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"actualizado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salidas_cola" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"salida" uuid NOT NULL,
	"evento" uuid,
	"aviso" jsonb,
	"severidad" text NOT NULL,
	"rango" smallint NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salidas_cola_contenido" CHECK (("salidas_cola"."evento" IS NULL) <> ("salidas_cola"."aviso" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "salidas_cola" ADD CONSTRAINT "salidas_cola_salida_salidas_id_fk" FOREIGN KEY ("salida") REFERENCES "public"."salidas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "salidas_cola_orden" ON "salidas_cola" USING btree ("salida","id");--> statement-breakpoint
CREATE INDEX "salidas_cola_recorte" ON "salidas_cola" USING btree ("salida","rango","id");--> statement-breakpoint
CREATE UNIQUE INDEX "salidas_cola_evento" ON "salidas_cola" USING btree ("salida","evento") WHERE "salidas_cola"."evento" IS NOT NULL;