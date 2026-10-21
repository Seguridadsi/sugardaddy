CREATE TABLE "ajustes" (
	"clave" text PRIMARY KEY NOT NULL,
	"valor" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aprobaciones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"regla" text NOT NULL,
	"respuesta" text NOT NULL,
	"objetivo" text NOT NULL,
	"evento" uuid NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"decidido_por" text,
	"decidido_en" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL,
	"quien" text NOT NULL,
	"accion" text NOT NULL,
	"detalle" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"linea" text NOT NULL,
	"hash" text NOT NULL,
	"cuando" timestamp with time zone NOT NULL,
	"senuelo" text NOT NULL,
	"modulo" text NOT NULL,
	"tipo" text NOT NULL,
	"accion" text NOT NULL,
	"severidad" text NOT NULL,
	"ip" text,
	"usuario" text,
	"conexion_establecida" boolean NOT NULL,
	"recibido" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"valor" text NOT NULL,
	"clase" text NOT NULL,
	"lista" text NOT NULL,
	"ambito" text NOT NULL,
	"motivo" text NOT NULL,
	"caduca" timestamp with time zone,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reglas" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"severidad_minima" text NOT NULL,
	"senuelos" jsonb,
	"respuestas" jsonb NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensores" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"segmento" text NOT NULL,
	"clave_hash" text NOT NULL,
	"ultimo_hash" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	"ultimo_latido" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "senuelos" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"modulo" text NOT NULL,
	"tipo" text NOT NULL,
	"sensor" text NOT NULL,
	"donde" text NOT NULL,
	"parametros" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aprobaciones" ADD CONSTRAINT "aprobaciones_regla_reglas_id_fk" FOREIGN KEY ("regla") REFERENCES "public"."reglas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aprobaciones" ADD CONSTRAINT "aprobaciones_evento_eventos_id_fk" FOREIGN KEY ("evento") REFERENCES "public"."eventos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos" ADD CONSTRAINT "eventos_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "senuelos" ADD CONSTRAINT "senuelos_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eventos_hash" ON "eventos" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "eventos_cuando" ON "eventos" USING btree ("cuando");--> statement-breakpoint
CREATE INDEX "eventos_senuelo" ON "eventos" USING btree ("senuelo");--> statement-breakpoint
CREATE INDEX "eventos_ip" ON "eventos" USING btree ("ip");--> statement-breakpoint
CREATE UNIQUE INDEX "listas_unica" ON "listas" USING btree ("valor","lista","ambito");