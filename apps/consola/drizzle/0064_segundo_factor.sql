-- Segundo factor de los usuarios locales (plan de fortificación §4.1, DORA B-10):
-- passkeys y apps de autenticación (TOTP), con sus códigos de recuperación, y con
-- qué factor se abrió cada sesión. Solo añade tablas y una columna nula: la
-- consola anterior sigue funcionando con esta base (y no pide segundo factor).
CREATE TABLE "codigos_recuperacion_mfa" (
	"usuario_id" text NOT NULL,
	"hash" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codigos_recuperacion_mfa_usuario_id_hash_pk" PRIMARY KEY("usuario_id","hash")
);
--> statement-breakpoint
CREATE TABLE "factores_usuario" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"tipo" text NOT NULL,
	"nombre" text NOT NULL,
	"clave_publica" text,
	"contador" integer DEFAULT 0 NOT NULL,
	"transportes" jsonb,
	"secreto" text,
	"ultimo_paso" integer DEFAULT 0 NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso" timestamp with time zone,
	CONSTRAINT "factores_usuario_tipo" CHECK ("factores_usuario"."tipo" in ('passkey', 'totp'))
);
--> statement-breakpoint
ALTER TABLE "sesiones" ADD COLUMN "factor" text;--> statement-breakpoint
ALTER TABLE "codigos_recuperacion_mfa" ADD CONSTRAINT "codigos_recuperacion_mfa_usuario_id_usuarios_locales_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios_locales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factores_usuario" ADD CONSTRAINT "factores_usuario_usuario_id_usuarios_locales_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios_locales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factores_usuario_usuario" ON "factores_usuario" USING btree ("usuario_id");