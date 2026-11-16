-- Revisión de accesos y registro del soporte (plan de fortificación §4.4 y §4.6):
-- quién ha entrado y cuándo (con su desactivación por inactividad), las revisiones
-- trimestrales confirmadas y cada petición de una sesión de soporte de SeguridadSI.
-- Solo añade tablas: la consola anterior sigue funcionando con esta base. Las
-- cuentas se rellenan con los usuarios locales y con las sesiones que quedan
-- (las de la última semana), sin el soporte ni la emergencia.
CREATE TABLE "revisiones_acceso" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL,
	"quien" text NOT NULL,
	"usuarios" jsonb NOT NULL,
	"nota" text
);
--> statement-breakpoint
CREATE TABLE "soporte_registro" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL,
	"sesion" text,
	"quien" text NOT NULL,
	"metodo" text NOT NULL,
	"ruta" text NOT NULL,
	"accion" text,
	"estado" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios_acceso" (
	"oid" text PRIMARY KEY NOT NULL,
	"correo" text NOT NULL,
	"nombre" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visto" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_entrada" timestamp with time zone,
	"desactivada" timestamp with time zone,
	"desactivada_por" text,
	"motivo" text,
	"reactivada" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "soporte_registro_cuando" ON "soporte_registro" USING btree ("cuando");
--> statement-breakpoint
INSERT INTO "usuarios_acceso" ("oid", "correo", "nombre", "roles", "visto", "ultima_entrada")
SELECT 'local:' || "id", "correo", "nombre", "roles", "creado", "ultimo_acceso" FROM "usuarios_locales"
ON CONFLICT ("oid") DO NOTHING;
--> statement-breakpoint
INSERT INTO "usuarios_acceso" ("oid", "correo", "nombre", "roles", "visto", "ultima_entrada")
SELECT DISTINCT ON ("oid") "oid", "correo", "nombre", "roles", "creado", "creado" FROM "sesiones"
WHERE NOT "soporte" AND "oid" NOT LIKE 'emergencia:%'
ORDER BY "oid", "creado" DESC
ON CONFLICT ("oid") DO UPDATE SET "ultima_entrada" = GREATEST("usuarios_acceso"."ultima_entrada", EXCLUDED."ultima_entrada");
